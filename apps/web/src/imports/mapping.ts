import {
  dataTypeLabels,
  getImportContract,
  supportedDataTypes,
  type ImportContract,
} from "./contracts";
import type {
  DataTypeCandidate,
  FieldCandidate,
  FieldSuggestion,
  PreviewRow,
  SensitiveRisk,
} from "../types/imports";
import { scalarText } from "./scalar";

interface ScoredField {
  confidence: number;
  field: string;
  method: FieldSuggestion["method"];
}

const MEDIUM_CONFIDENCE = 0.55;
const CRITICAL_CANDIDATE_CONFIDENCE = 0.35;

function normalizeFieldVariants(value: string): string[] {
  const normalized = value.normalize("NFKC").trim();
  const withoutParenthetical = normalized
    .replace(/[（(][^()（）]*[）)]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [
    ...new Set([normalized, withoutParenthetical].map(normalizeFieldName)),
  ].filter(Boolean);
}

export function normalizeFieldName(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s_\-./\\()[\]{}:：]+/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function levenshtein(left: string, right: string): number {
  if (!left) return right.length;
  if (!right) return left.length;
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + cost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}

function similarity(left: string, right: string): number {
  const maximum = Math.max(left.length, right.length);
  return maximum === 0 ? 1 : 1 - levenshtein(left, right) / maximum;
}

function scoreColumn(
  sourceColumn: string,
  contract: ImportContract,
  rows: PreviewRow[] = [],
): ScoredField[] {
  const sourceVariants = normalizeFieldVariants(sourceColumn);
  const nonEmptyValues = rows
    .map((row) => scalarText(row.values[sourceColumn]).trim())
    .filter(Boolean);
  const uniqueRatio =
    nonEmptyValues.length === 0
      ? 0
      : new Set(nonEmptyValues).size / nonEmptyValues.length;
  const numericRatio =
    nonEmptyValues.length === 0
      ? 0
      : nonEmptyValues.filter((value) =>
          Number.isFinite(Number(value.replaceAll(",", ""))),
        ).length / nonEmptyValues.length;
  const dateRatio =
    nonEmptyValues.length === 0
      ? 0
      : nonEmptyValues.filter((value) =>
          /^(?:\d{4}[./年-]\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{4}|[A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{4})/.test(
            value,
          ),
        ).length / nonEmptyValues.length;
  return contract.fields
    .map((definition): ScoredField => {
      if (sourceColumn === definition.field) {
        return { confidence: 1, field: definition.field, method: "Exact" };
      }
      const normalizedField = normalizeFieldName(definition.field);
      if (sourceVariants.includes(normalizedField)) {
        return {
          confidence: 0.98,
          field: definition.field,
          method: "Normalized",
        };
      }
      const aliases = [definition.label, ...definition.aliases].flatMap(
        normalizeFieldVariants,
      );
      if (aliases.some((alias) => sourceVariants.includes(alias))) {
        return { confidence: 0.95, field: definition.field, method: "Alias" };
      }
      const bestSimilarity = Math.max(
        ...sourceVariants.flatMap((source) => [
          similarity(source, normalizedField),
          ...aliases.map((alias) => similarity(source, alias)),
        ]),
      );
      let profileAdjustment = 0;
      if (dateRatio >= 0.8 && definition.value_type === "string") {
        if (
          definition.field.endsWith("_time") ||
          definition.field === "created_at"
        ) {
          profileAdjustment += 0.04;
        }
      }
      if (numericRatio >= 0.9 && definition.value_type.includes("number")) {
        profileAdjustment += 0.03;
      }
      if (
        definition.field === "tracking_event_id" &&
        nonEmptyValues.length > 1 &&
        uniqueRatio < 1
      ) {
        profileAdjustment -= 0.25;
      }
      return {
        confidence: Number(
          Math.max(
            0,
            Math.min(0.94, bestSimilarity * 0.88 + profileAdjustment),
          ).toFixed(4),
        ),
        field: definition.field,
        method: "Similarity",
      };
    })
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        left.field.localeCompare(right.field),
    );
}

export function suggestMappings(
  sourceColumns: string[],
  contract: ImportContract,
  rows: PreviewRow[] = [],
): FieldSuggestion[] {
  const suggestions = sourceColumns.map((sourceColumn) => {
    const scores = scoreColumn(sourceColumn, contract, rows);
    const top = scores[0] ?? {
      confidence: 0,
      field: "",
      method: "Similarity" as const,
    };
    const second = scores[1]?.confidence ?? 0;
    const safeToPreselect =
      top.confidence >= 0.86 &&
      (top.method !== "Similarity" || top.confidence - second >= 0.08);
    const candidates: FieldCandidate[] = scores
      .filter((candidate) => candidate.confidence >= 0.35)
      .slice(0, 3)
      .map((candidate) => ({
        ...candidate,
        label:
          contract.fields.find((field) => field.field === candidate.field)
            ?.label ?? candidate.field,
      }));
    return {
      candidates,
      confidence: top.confidence,
      method: top.method,
      requires_confirmation:
        top.method === "Similarity" || top.confidence < 0.92,
      source_column: sourceColumn,
      suggested_field: safeToPreselect ? top.field : null,
    } satisfies FieldSuggestion;
  });

  const winners = new Map<string, FieldSuggestion>();
  suggestions.forEach((suggestion) => {
    if (!suggestion.suggested_field) return;
    const current = winners.get(suggestion.suggested_field);
    if (!current || suggestion.confidence > current.confidence) {
      winners.set(suggestion.suggested_field, suggestion);
    }
  });
  suggestions.forEach((suggestion) => {
    if (
      suggestion.suggested_field &&
      winners.get(suggestion.suggested_field) !== suggestion
    ) {
      suggestion.suggested_field = null;
      suggestion.requires_confirmation = true;
    }
  });
  return suggestions;
}

function criticalFields(contract: ImportContract): Set<string> {
  return new Set([
    ...contract.fields
      .filter((field) => field.required)
      .map((field) => field.field),
    "order_id",
    "shipment_id",
    "tracking_event_id",
    "event_id",
    "event_time",
    "raw_status",
    "event_code",
    "carrier_id",
    "location_code",
    "region_code",
    "exception_code",
    "sequence_number",
  ]);
}

const CRITICAL_HEADER_PATTERN =
  /(订单|运单|物流|轨迹|事件|时间|时刻|日期|状态|扫描|承运|快递|节点|网点|场站|位置|区域|城市|异常|序号|流水|批次|签收|老码|代码|编号|标识|参考|order|shipment|tracking|event|time|date|status|scan|carrier|courier|location|region|exception|sequence|batch|reference|\bid\b|\bno\b)/i;

/**
 * Returns only unresolved columns that have no plausible analytical or
 * auxiliary meaning. This deliberately errs on the side of asking the user.
 */
export function findSafelyIgnorableColumns(
  suggestions: FieldSuggestion[],
  mapping: Record<string, string | null>,
  ignoredSourceColumns: string[],
  contract: ImportContract,
): string[] {
  const ignored = new Set(ignoredSourceColumns);
  const critical = criticalFields(contract);
  return suggestions
    .filter((suggestion) => {
      const source = suggestion.source_column;
      if (ignored.has(source) || mapping[source] != null) return false;
      if (CRITICAL_HEADER_PATTERN.test(source.normalize("NFKC"))) return false;
      if (
        suggestion.candidates.some(
          (candidate) => candidate.confidence >= MEDIUM_CONFIDENCE,
        )
      ) {
        return false;
      }
      return !suggestion.candidates.some(
        (candidate) =>
          critical.has(candidate.field) &&
          candidate.confidence >= CRITICAL_CANDIDATE_CONFIDENCE,
      );
    })
    .map((suggestion) => suggestion.source_column);
}

export function detectDataTypes(
  sourceColumns: string[],
  rows: PreviewRow[] = [],
): DataTypeCandidate[] {
  return supportedDataTypes
    .map((dataType) => {
      const contract = getImportContract(dataType);
      const suggestions = suggestMappings(sourceColumns, contract, rows);
      const matched = new Set(
        suggestions
          .map((suggestion) => suggestion.suggested_field)
          .filter((field): field is string => field !== null),
      );
      const required = new Set(
        contract.fields
          .filter((field) => field.required)
          .map((field) => field.field),
      );
      if (contract.dataType === "tracking_events") {
        required.delete("tracking_event_id");
      }
      const statusMatched =
        matched.has(contract.rawStatusField) ||
        matched.has(contract.normalizedStatusField);
      required.delete(contract.rawStatusField);
      required.delete(contract.normalizedStatusField);
      const requiredGroups = required.size + 1;
      const matchedRequired =
        [...required].filter((field) => matched.has(field)).length +
        Number(statusMatched);
      const coverage = matchedRequired / Math.max(1, requiredGroups);
      const breadth = Math.min(1, matched.size / Math.max(1, requiredGroups));
      const missing = [...required].filter((field) => !matched.has(field));
      if (!statusMatched) missing.push(contract.rawStatusField);
      return {
        confidence: Number((coverage * 0.8 + breadth * 0.2).toFixed(4)),
        data_type: dataType,
        display_name: dataTypeLabels[dataType],
        matched_fields: [...matched].sort(),
        missing_required_fields: missing.sort(),
      } satisfies DataTypeCandidate;
    })
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        left.data_type.localeCompare(right.data_type),
    );
}

const sensitivePatterns: Array<[RegExp, string]> = [
  [/(姓名|收件人|联系人|name|consignee)/i, "姓名"],
  [/(手机|电话|手机号|mobile|phone|tel)/i, "手机号或电话"],
  [/(详细地址|收货地址|address)/i, "详细地址"],
  [/(身份证|证件号|idcard|identity)/i, "身份证件"],
];

export function detectSensitiveRisks(
  sourceColumns: string[],
  rows: PreviewRow[],
): SensitiveRisk[] {
  return sourceColumns.flatMap((sourceColumn) => {
    const categories = sensitivePatterns
      .filter(([pattern]) => pattern.test(sourceColumn))
      .map(([, category]) => category);
    if (categories.length === 0) return [];
    const nonEmptyCount = rows.filter((row) => {
      const value = row.values[sourceColumn];
      return scalarText(value).trim() !== "";
    }).length;
    return [
      {
        categories,
        detection_basis: "字段名风险词匹配",
        message: "该字段可能包含个人信息；预览和错误明细不会输出完整原值。",
        non_empty_count: nonEmptyCount,
        source_column: sourceColumn,
      },
    ];
  });
}

export function validateMapping(
  mapping: Record<string, string | null>,
  sourceColumns: string[],
  contract: ImportContract,
  ignoredSourceColumns: string[] = [],
): string[] {
  const errors: string[] = [];
  const sourceSet = new Set(sourceColumns);
  const unknownSources = Object.keys(mapping).filter(
    (source) => !sourceSet.has(source),
  );
  if (unknownSources.length > 0) {
    errors.push(`映射包含未知源列：${unknownSources.sort().join(", ")}`);
  }
  const ignored = new Set(ignoredSourceColumns);
  const unknownIgnored = [...ignored].filter(
    (source) => !sourceSet.has(source),
  );
  if (unknownIgnored.length > 0) {
    errors.push(`忽略列表包含未知源列：${unknownIgnored.sort().join(", ")}`);
  }
  const ignoredMapped = [...ignored].filter(
    (source) => mapping[source] != null,
  );
  if (ignoredMapped.length > 0) {
    errors.push(`源字段不能同时映射和忽略：${ignoredMapped.sort().join(", ")}`);
  }
  const unresolved = sourceColumns.filter(
    (source) => !ignored.has(source) && mapping[source] == null,
  );
  if (unresolved.length > 0) {
    errors.push(`存在未处理源字段：${unresolved.sort().join(", ")}`);
  }
  const targets = Object.entries(mapping)
    .filter(([source]) => !ignored.has(source))
    .map(([, target]) => target)
    .filter((target): target is string => target !== null);
  const allowed = new Set(contract.fields.map((field) => field.field));
  const unknownTargets = [...new Set(targets)].filter(
    (target) => !allowed.has(target),
  );
  if (unknownTargets.length > 0) {
    errors.push(`映射包含未知目标字段：${unknownTargets.sort().join(", ")}`);
  }
  const duplicates = [...new Set(targets)].filter(
    (target) => targets.filter((value) => value === target).length > 1,
  );
  if (duplicates.length > 0) {
    errors.push(`目标字段不能重复映射：${duplicates.sort().join(", ")}`);
  }
  const mapped = new Set(targets);
  const required = new Set(
    contract.fields
      .filter((field) => field.required)
      .map((field) => field.field),
  );
  if (contract.dataType === "tracking_events") {
    required.delete("tracking_event_id");
  }
  if (
    mapped.has(contract.rawStatusField) ||
    mapped.has(contract.normalizedStatusField)
  ) {
    required.delete(contract.rawStatusField);
    required.delete(contract.normalizedStatusField);
  }
  const missing = [...required].filter((field) => !mapped.has(field));
  if (missing.length > 0) {
    errors.push(`缺少必填目标字段：${missing.sort().join(", ")}`);
  }
  return errors;
}
