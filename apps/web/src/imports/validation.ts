import { getImportContract, type ImportContract } from "./contracts";
import { suggestMappings, validateMapping } from "./mapping";
import {
  inferDateOrder,
  parseImportDateValue,
  type DateOrder,
} from "./dateParser";
import type { BrowserParsedTable } from "./parser";
import { scalarText } from "./scalar";
import statusKeywordRulesJson from "../../../../data/schemas/status_keyword_rules.json";
import type {
  DataType,
  FieldResolution,
  QualityIssue,
  QualityReport,
  SensitiveRisk,
  StatusNormalization,
} from "../types/imports";

const dateFields = new Set([
  "created_at",
  "promised_delivery_time",
  "actual_delivery_time",
  "event_time",
]);
const numberFields = new Set([
  "ordered_quantity",
  "delivered_quantity",
  "quantity",
]);
const integerFields = new Set(["sequence_number"]);
const MAX_CELL_CHARS = 32_767;

const statusSynonyms: Record<DataType, Record<string, string>> = {
  orders: {
    交易关闭: "cancelled",
    已下单: "created",
    已取消: "cancelled",
    已发货: "shipped",
    已完成: "delivered",
    已审核: "confirmed",
    已确认: "confirmed",
    已签收: "delivered",
    已退回: "returned",
    妥投: "delivered",
    履约中: "processing",
    订单已创建: "created",
    处理中: "processing",
    退货完成: "returned",
  },
  warehouse_events: {
    仓内取消: "warehouse_cancelled",
    仓库接单: "order_received",
    开始复核: "quality_check_started",
    开始打包: "packing_started",
    开始拣货: "picking_started",
    已出库: "shipped_from_warehouse",
    待出库: "ready_to_ship",
    待揽收: "ready_to_ship",
    打包中: "packing_started",
    打包完成: "packing_completed",
    拣货中: "picking_started",
    拣货完成: "picking_completed",
    复核中: "quality_check_started",
    复核失败: "quality_check_failed",
    复核完成: "quality_check_completed",
    订单已下发: "order_received",
    质检不通过: "quality_check_failed",
    质检通过: "quality_check_completed",
    配货完成: "picking_completed",
  },
  tracking_events: {
    到达中转场: "arrived_at_hub",
    到达分拨中心: "arrived_at_hub",
    到达目的城市: "arrived_at_destination_city",
    发往下一站: "departed_hub",
    始发地已发出: "origin_departed",
    已揽件: "carrier_picked_up",
    已签收: "delivered",
    已退回: "returned",
    快件已揽收: "carrier_picked_up",
    正在派件: "out_for_delivery",
    派送中: "out_for_delivery",
    派送失败: "delivery_failed",
    物流异常: "exception",
    离开分拨中心: "departed_hub",
    运输中: "in_transit",
    运输异常: "exception",
    运单已创建: "shipment_created",
    退回中: "return_initiated",
    退回完成: "returned",
    在途: "in_transit",
    妥投: "delivered",
    未妥投: "delivery_failed",
  },
};

interface StatusValue {
  mappingConfidence: number;
  mappingSource: string;
  normalized: string;
  raw: string;
}

interface StatusKeywordRule {
  confidence: number;
  keywords: string[];
  target: string;
}

const statusKeywordRules = statusKeywordRulesJson as Record<
  string,
  StatusKeywordRule[]
>;

export interface ValidationArtifacts {
  normalizedRows: Record<string, unknown>[];
  report: QualityReport;
}

class ValueError extends Error {
  readonly code: string;
  readonly suggestion: string;

  constructor(code: string, message: string, suggestion: string) {
    super(message);
    this.code = code;
    this.suggestion = suggestion;
  }
}

function normalizeLookup(value: unknown): string {
  return scalarText(value)
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("zh-CN")
    .replace(/\s+/g, " ");
}

function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "string" && !value.trim())
  );
}

function parseNumber(value: unknown, integer: boolean): number {
  if (typeof value === "boolean") {
    throw new ValueError(
      "UNPARSEABLE_NUMBER",
      "布尔值不能作为数量。",
      "改为明确数字。",
    );
  }
  const text =
    typeof value === "number"
      ? String(value)
      : scalarText(value).normalize("NFKC").trim();
  const thousands = /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/;
  if (text.includes(",") && !thousands.test(text)) {
    throw new ValueError(
      "AMBIGUOUS_NUMBER_FORMAT",
      "数字中的逗号无法确定是千分位还是小数分隔符。",
      "使用小数点，并只按 1,234.56 形式使用千分位。",
    );
  }
  const parsed = Number(text.replaceAll(",", ""));
  if (!Number.isFinite(parsed)) {
    throw new ValueError(
      "UNPARSEABLE_NUMBER",
      "无法解析为有限数字。",
      "改为有限十进制数字，不要附带单位文字。",
    );
  }
  if (integer && !Number.isInteger(parsed)) {
    throw new ValueError(
      "UNPARSEABLE_INTEGER",
      "该字段必须是整数。",
      "去除小数或修正映射。",
    );
  }
  return parsed;
}

export function parseImportDate(
  value: unknown,
  timeZone: string | null,
  fileOrder: DateOrder | null = null,
): string {
  return parseImportDateValue(value, timeZone, fileOrder).iso;
}

function normalizeStatus(
  dataType: DataType,
  rawValue: unknown,
  projectMappings: Record<string, string>,
  contract: ImportContract,
  auxiliaryEvidence: Record<string, unknown> = {},
): StatusValue {
  const raw = String(rawValue);
  const lookup = normalizeLookup(raw);
  const project = Object.entries(projectMappings).find(
    ([source]) => normalizeLookup(source) === lookup,
  );
  if (project) {
    return {
      mappingConfidence: 1,
      mappingSource: "project_user",
      normalized: project[1],
      raw,
    };
  }
  const builtin = Object.entries(statusSynonyms[dataType]).find(
    ([source]) => normalizeLookup(source) === lookup,
  );
  if (builtin) {
    return {
      mappingConfidence: 0.98,
      mappingSource: "builtin_exact",
      normalized: builtin[1],
      raw,
    };
  }
  if (contract.statusCodes.has(lookup)) {
    return {
      mappingConfidence: 1,
      mappingSource: "standard_code",
      normalized: lookup,
      raw,
    };
  }
  const evidence = [
    { source: "raw_status", value: raw },
    ...Object.entries(auxiliaryEvidence).map(([source, value]) => ({
      source,
      value: scalarText(value),
    })),
  ];
  for (const item of evidence) {
    const evidenceLookup = normalizeLookup(item.value);
    if (!evidenceLookup) continue;
    const rule = (statusKeywordRules[dataType] ?? []).find((candidate) =>
      candidate.keywords.some((keyword) =>
        evidenceLookup.includes(normalizeLookup(keyword)),
      ),
    );
    if (rule && contract.statusCodes.has(rule.target)) {
      return {
        mappingConfidence: rule.confidence,
        mappingSource:
          item.source === "raw_status"
            ? "builtin_keyword_raw"
            : `auxiliary_keyword:${item.source}`,
        normalized: rule.target,
        raw,
      };
    }
  }
  return {
    mappingConfidence: 0,
    mappingSource: "unmapped",
    normalized: "unmapped",
    raw,
  };
}

const noExceptionValues = new Set(["", "0", "n", "正常", "无", "-", "常规"]);
const knownExceptionCodes = new Set([
  "WEATHER_DELAY",
  "CALL_FAIL",
  "ADDR_UNCLEAR",
  "CANCELLED",
  "RETURNING",
  "RETURN_DONE",
]);

function normalizeExceptionCode(value: unknown): {
  code: string | null;
  warning: boolean;
} {
  const raw = scalarText(value).normalize("NFKC").trim();
  const lookup = raw.toLocaleLowerCase("zh-CN");
  if (noExceptionValues.has(lookup)) return { code: null, warning: false };
  if (lookup === "1") return { code: "GENERIC_EXCEPTION", warning: true };
  const code = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!code) return { code: "GENERIC_EXCEPTION", warning: true };
  return { code, warning: !knownExceptionCodes.has(code) };
}

function generatedTrackingEventId(
  record: Record<string, unknown>,
  rowNumber: number,
): string | null {
  const required = [
    record.order_id,
    record.shipment_id,
    record.event_time,
    record.raw_status,
    record.carrier_id,
  ].map((value) => scalarText(value).trim());
  if (required.some((value) => !value)) return null;
  const canonical = [
    ...required,
    scalarText(record.sequence_number).trim(),
    String(rowNumber),
  ].join("\u001f");
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(canonical)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return `TRE-GEN-${String(rowNumber).padStart(6, "0")}-${hash
    .toString(16)
    .padStart(8, "0")
    .toUpperCase()}`;
}

function mask(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = scalarText(value);
  return text.length <= 4 ? "***" : `${text.slice(0, 2)}***${text.slice(-2)}`;
}

export function validateBrowserImport(
  dataType: DataType,
  table: BrowserParsedTable,
  mapping: Record<string, string | null>,
  ignoredSourceColumns: string[],
  defaultTimezone: string | null,
  projectMappings: Record<string, string>,
  sensitiveRisks: SensitiveRisk[],
  requestedDateOrder: DateOrder | null = null,
): ValidationArtifacts {
  const contract = getImportContract(dataType);
  const issues: QualityIssue[] = [];
  const sensitiveColumns = new Set(
    sensitiveRisks.map((risk) => risk.source_column),
  );
  const addIssue = (
    issue: Omit<QualityIssue, "issue_id"> & { raw_value?: string | null },
  ) => {
    issues.push({
      ...issue,
      issue_id: `${issue.code}:${issue.row_number ?? 0}:${issue.target_field ?? issue.source_column ?? "-"}:${issues.length + 1}`,
      raw_value:
        issue.source_column && sensitiveColumns.has(issue.source_column)
          ? mask(issue.raw_value)
          : (issue.raw_value?.slice(0, 200) ?? null),
    });
  };

  const ignoredSources = new Set(ignoredSourceColumns);
  const activeMappings = Object.entries(mapping).filter(
    (entry): entry is [string, string] =>
      entry[1] !== null && !ignoredSources.has(entry[0]),
  );
  const mappedTargets = new Set(activeMappings.map(([, target]) => target));
  const requiredTargets = new Set(
    contract.fields
      .filter((field) => field.required)
      .map((field) => field.field),
  );
  if (dataType === "tracking_events")
    requiredTargets.delete("tracking_event_id");
  requiredTargets.delete(contract.normalizedStatusField);
  if (
    mappedTargets.has(contract.rawStatusField) ||
    mappedTargets.has(contract.normalizedStatusField)
  ) {
    requiredTargets.delete(contract.rawStatusField);
    requiredTargets.delete(contract.normalizedStatusField);
  }
  const missingRequiredTargets = [...requiredTargets].filter(
    (field) => !mappedTargets.has(field),
  );
  const mappingSuggestions = suggestMappings(
    table.headers,
    contract,
    table.rows,
  );
  const auxiliarySources = Object.fromEntries(
    mappingSuggestions.flatMap((suggestion) =>
      suggestion.auxiliary_purpose &&
      !ignoredSources.has(suggestion.source_column)
        ? [[suggestion.auxiliary_purpose, suggestion.source_column]]
        : [],
    ),
  );
  const inferredAuxiliaryColumns = Object.values(auxiliarySources);
  const mappedDateSources = activeMappings
    .filter(([, target]) => dateFields.has(target))
    .map(([source]) => source);
  const dateOrderInference = inferDateOrder(
    table.rows.flatMap((row) =>
      mappedDateSources.map((source) => row.values[source]),
    ),
  );
  const effectiveDateOrder = requestedDateOrder ?? dateOrderInference.order;
  const dateOrderBlocked =
    requestedDateOrder === null && dateOrderInference.ambiguous;
  if (dateOrderBlocked) {
    addIssue({
      code: "DATE_ORDER_REQUIRED",
      message: "该文件存在日期顺序歧义，需要一次性确认整份文件的日期规则。",
      raw_value: null,
      severity: "error",
      cause:
        dateOrderInference.evidence.join("；") ||
        "部分斜杠日期的日和月都不大于 12。",
      impact: "在确认前，系统不会按浏览器区域设置猜测事件时间。",
      suggestion: "选择“日/月/年”或“月/日/年”后重新校验；无需逐行处理。",
      target_field: "event_time",
    });
  }
  const candidateSource = (target: string): string | null => {
    const candidate = mappingSuggestions
      .flatMap((suggestion) =>
        suggestion.candidates
          .filter((item) => item.field === target)
          .map((item) => ({
            confidence: item.confidence,
            source: suggestion.source_column,
          })),
      )
      .filter(
        (item) =>
          !ignoredSources.has(item.source) && mapping[item.source] == null,
      )
      .sort((left, right) => right.confidence - left.confidence)[0];
    return candidate?.confidence >= 0.55 ? candidate.source : null;
  };

  missingRequiredTargets.forEach((field) => {
    const definition = contract.fields.find((item) => item.field === field);
    const recommendedSource = candidateSource(field);
    addIssue({
      code: "MISSING_REQUIRED_MAPPING",
      message: `没有识别到“${definition?.label ?? field}”（${field}）。`,
      raw_value: null,
      severity: "error",
      cause: `当前映射中没有源列可形成标准字段 ${field}。`,
      impact: "缺少该字段会使记录无法通过数据契约，相关分析不能可靠执行。",
      suggestion: recommendedSource
        ? `系统检测到“${recommendedSource}”可能符合该含义；请返回字段映射并确认。`
        : `请返回字段映射，选择记录“${definition?.label ?? field}”的源列。`,
      action_label: recommendedSource ? `使用“${recommendedSource}”` : null,
      recommended_source_column: recommendedSource,
      target_field: field,
    });
  });

  validateMapping(
    mapping,
    table.headers,
    contract,
    ignoredSourceColumns,
    inferredAuxiliaryColumns,
  )
    .filter((message) => !message.startsWith("缺少必填目标字段："))
    .forEach((message) =>
      addIssue({
        code: "INVALID_FIELD_MAPPING",
        message,
        raw_value: null,
        severity: "error",
        suggestion: "返回字段映射步骤，确保必填字段完整且目标字段不重复。",
        cause: "字段处理状态与当前数据契约不一致。",
        impact: "系统无法确定应写入标准数据集的字段，导入会被阻止。",
      }),
    );
  table.issues.forEach((issue) =>
    addIssue({
      code: issue.code,
      message: issue.message,
      raw_value: issue.rawValue ?? null,
      row_number: issue.rowNumber ?? null,
      severity: issue.severity,
      sheet: table.sheetName,
      source_column: issue.sourceColumn ?? null,
      suggestion: issue.suggestion,
    }),
  );

  Object.entries(projectMappings).forEach(([raw, target]) => {
    if (!raw.trim() || !contract.statusCodes.has(target)) {
      addIssue({
        code: "INVALID_PROJECT_STATUS_MAPPING",
        message: "项目级状态映射包含无效目标。",
        raw_value: null,
        severity: "error",
        suggestion: "从当前数据类型的标准状态列表选择目标状态。",
      });
    }
  });

  const targetToSource = new Map(
    Object.entries(mapping)
      .filter(
        (entry): entry is [string, string] =>
          entry[1] !== null && !ignoredSources.has(entry[0]),
      )
      .map(([source, target]) => [target, source]),
  );
  const deriveTrackingEventId =
    dataType === "tracking_events" && !targetToSource.has("tracking_event_id");
  if (deriveTrackingEventId) {
    addIssue({
      code: "GENERATED_TRACKING_EVENT_ID",
      message:
        "源文件没有可信的轨迹事件唯一标识，系统将按语义字段与源行号生成稳定 ID。",
      raw_value: null,
      severity: "info",
      suggestion: "如源系统提供真实且唯一的事件 ID，可返回映射步骤人工选择。",
      target_field: "tracking_event_id",
    });
  }
  const nullCounts: Record<string, number> = {};
  const candidates: Array<{
    record: Record<string, unknown>;
    rowNumber: number;
    status: StatusValue | null;
  }> = [];

  table.rows.forEach((sourceRow) => {
    const record: Record<string, unknown> = {};
    let status: StatusValue | null = null;
    contract.fields.forEach((definition) => {
      const source = targetToSource.get(definition.field);
      const value = source ? sourceRow.values[source] : null;
      if (isEmpty(value)) {
        nullCounts[definition.field] = (nullCounts[definition.field] ?? 0) + 1;
        if (
          definition.required &&
          source !== undefined &&
          !(
            deriveTrackingEventId && definition.field === "tracking_event_id"
          ) &&
          definition.field !== contract.rawStatusField &&
          definition.field !== contract.normalizedStatusField
        ) {
          addIssue({
            code: "REQUIRED_VALUE_MISSING",
            message: `第 ${sourceRow.row_number} 行的“${source}”为空，无法形成“${definition.label}”。`,
            raw_value: null,
            row_number: sourceRow.row_number,
            severity: "error",
            sheet: table.sheetName,
            source_column: source ?? null,
            suggestion: `请在源文件“${source}”列补充该行原值，或确认该列是否映射错了。系统不会代填业务事实。`,
            cause: `该源列已映射到 ${definition.field}，但这一行没有值。`,
            impact:
              "该行无法进入标准分析数据集；系统不会把空值当作成功或正常。",
            target_field: definition.field,
          });
        }
        return;
      }
      if (typeof value === "string" && value.length > MAX_CELL_CHARS) {
        addIssue({
          code: "LONG_TEXT_VALUE",
          message: "文本长度超过 32,767 字符安全上限。",
          raw_value: value,
          row_number: sourceRow.row_number,
          severity: "error",
          sheet: table.sheetName,
          source_column: source ?? null,
          suggestion: "缩短文本，但不要改变业务含义。",
          target_field: definition.field,
        });
        return;
      }
      try {
        if (dateFields.has(definition.field)) {
          if (dateOrderBlocked) return;
          const parsedDate = parseImportDateValue(
            value,
            defaultTimezone,
            effectiveDateOrder,
          );
          record[definition.field] = parsedDate.iso;
          if (parsedDate.precision === "date") {
            addIssue({
              code: "DATE_ONLY_PRECISION",
              message: "该值只有日期精度，已保留为日期，不会静默补成午夜。",
              raw_value: scalarText(value),
              row_number: sourceRow.row_number,
              severity: "warning",
              sheet: table.sheetName,
              source_column: source ?? null,
              suggestion:
                "需要小时级分析时，请补充真实发生时间；否则仅用于日期级统计。",
              target_field: definition.field,
            });
          }
        } else if (numberFields.has(definition.field))
          record[definition.field] = parseNumber(value, false);
        else if (integerFields.has(definition.field))
          record[definition.field] = parseNumber(value, true);
        else if (definition.field === "exception_code") {
          const normalized = normalizeExceptionCode(value);
          record[definition.field] = normalized.code;
          if (normalized.warning) {
            addIssue({
              code: "GENERIC_OR_UNKNOWN_EXCEPTION",
              message:
                "异常标记缺少可验证的具体语义，已透明保留为通用或规范化代码。",
              raw_value: scalarText(value),
              row_number: sourceRow.row_number,
              severity: "warning",
              sheet: table.sheetName,
              source_column: source ?? null,
              suggestion: "核对源系统异常字典；系统不会编造具体异常原因。",
              target_field: definition.field,
            });
          }
        } else
          record[definition.field] = scalarText(value).normalize("NFKC").trim();
      } catch (error) {
        const valueError = error as ValueError;
        addIssue({
          code: valueError.code ?? "UNPARSEABLE_VALUE",
          message: valueError.message,
          raw_value: scalarText(value),
          row_number: sourceRow.row_number,
          severity: "error",
          sheet: table.sheetName,
          source_column: source ?? null,
          suggestion: valueError.suggestion ?? "修正原值或字段映射。",
          target_field: definition.field,
        });
      }
    });

    const rawSource =
      targetToSource.get(contract.rawStatusField) ??
      targetToSource.get(contract.normalizedStatusField);
    const rawValue = rawSource ? sourceRow.values[rawSource] : null;
    if (isEmpty(rawValue) && rawSource !== undefined) {
      addIssue({
        code: "REQUIRED_STATUS_MISSING",
        message: `第 ${sourceRow.row_number} 行的“${rawSource}”为空，无法识别物流状态。`,
        raw_value: null,
        row_number: sourceRow.row_number,
        severity: "error",
        sheet: table.sheetName,
        source_column: rawSource ?? null,
        suggestion: `请在源文件“${rawSource}”列补充该行真实状态；若列含义不正确，请返回映射步骤重新选择。`,
        cause: "状态源列已完成映射，但当前行没有原始状态值。",
        impact: "系统无法生成物流节点和状态分析；该行不会被猜测为正常状态。",
        target_field: contract.rawStatusField,
      });
    } else if (!isEmpty(rawValue)) {
      status = normalizeStatus(
        dataType,
        rawValue,
        projectMappings,
        contract,
        Object.fromEntries(
          Object.entries(auxiliarySources).map(([purpose, source]) => [
            purpose,
            sourceRow.values[source],
          ]),
        ),
      );
      record[contract.rawStatusField] = status.raw;
      record[contract.normalizedStatusField] = status.normalized;
      if (status.normalized === "unmapped") {
        addIssue({
          code: "UNKNOWN_STATUS",
          message: "原始状态无法可靠映射，已保留并标记为 unmapped。",
          raw_value: status.raw,
          row_number: sourceRow.row_number,
          severity: "warning",
          sheet: table.sheetName,
          source_column: rawSource ?? null,
          suggestion: "人工选择标准状态并重新校验。",
          target_field: contract.normalizedStatusField,
        });
      }
    }

    if (deriveTrackingEventId) {
      const generated = generatedTrackingEventId(record, sourceRow.row_number);
      if (generated) record.tracking_event_id = generated;
    }

    Object.entries(contract.schema.properties).forEach(
      ([field, definition]) => {
        const value = record[field];
        if (value === undefined || value === null) return;
        const minimumLength =
          typeof definition.minLength === "number"
            ? definition.minLength
            : null;
        const maximumLength =
          typeof definition.maxLength === "number"
            ? definition.maxLength
            : null;
        if (
          typeof value === "string" &&
          ((minimumLength !== null && value.length < minimumLength) ||
            (maximumLength !== null && value.length > maximumLength))
        ) {
          addIssue({
            code: "SCHEMA_VALIDATION_ERROR",
            message: `${field} 的文本长度不符合数据 Schema。`,
            raw_value: value,
            row_number: sourceRow.row_number,
            severity: "error",
            sheet: table.sheetName,
            source_column: targetToSource.get(field) ?? null,
            suggestion: "按数据字典检查字段含义和长度；系统不会截断原值。",
            target_field: field,
          });
        }
      },
    );

    const quantityRules: Array<[string, (value: number) => boolean]> = [
      ["ordered_quantity", (value) => value <= 0],
      ["delivered_quantity", (value) => value < 0],
      ["quantity", (value) => value < 0],
    ];
    quantityRules.forEach(([field, invalid]) => {
      const value = record[field];
      if (typeof value === "number" && invalid(value)) {
        addIssue({
          code: "NEGATIVE_OR_INVALID_QUANTITY",
          message: "数量不符合业务约束。",
          raw_value: scalarText(value),
          row_number: sourceRow.row_number,
          severity: "error",
          sheet: table.sheetName,
          source_column: targetToSource.get(field) ?? null,
          suggestion: "订购数量必须大于 0；交付和事件数量必须大于等于 0。",
          target_field: field,
        });
      }
    });
    if (dataType === "warehouse_events") {
      const hasQuantity = record.quantity !== undefined;
      const hasUnit = record.quantity_unit !== undefined;
      if (hasQuantity !== hasUnit) {
        addIssue({
          code: "SCHEMA_VALIDATION_ERROR",
          message: "仓库事件的 quantity 与 quantity_unit 必须同时提供。",
          raw_value: null,
          row_number: sourceRow.row_number,
          severity: "error",
          sheet: table.sheetName,
          suggestion: "补全数量及单位，或同时留空。",
        });
      }
    }
    if (dataType === "orders" && typeof record.created_at === "string") {
      const created = Date.parse(record.created_at);
      ["promised_delivery_time", "actual_delivery_time"].forEach((field) => {
        const value = record[field];
        if (typeof value === "string" && Date.parse(value) < created) {
          addIssue({
            code: "TIME_ORDER_CONFLICT",
            message: "业务时间早于订单创建时间。",
            raw_value: value,
            row_number: sourceRow.row_number,
            severity: "error",
            sheet: table.sheetName,
            source_column: targetToSource.get(field) ?? null,
            suggestion: "修正时间、时区或字段映射。",
            target_field: field,
          });
        }
      });
    }
    candidates.push({ record, rowNumber: sourceRow.row_number, status });
  });

  const primaryGroups = new Map<string, typeof candidates>();
  candidates.forEach((candidate) => {
    const primary = candidate.record[contract.primaryField];
    if (primary === undefined) return;
    const key = scalarText(primary);
    primaryGroups.set(key, [...(primaryGroups.get(key) ?? []), candidate]);
  });
  const excludedExact = new Set<number>();
  const duplicateConflicts = new Set<number>();
  let duplicateKeys = 0;
  primaryGroups.forEach((rows, key) => {
    if (rows.length < 2) return;
    duplicateKeys += 1;
    const reference = JSON.stringify(rows[0]?.record ?? {});
    const exact = rows.every((row) => JSON.stringify(row.record) === reference);
    if (exact) {
      rows.slice(1).forEach((row) => {
        excludedExact.add(row.rowNumber);
        addIssue({
          code: "EXACT_DUPLICATE_ROW",
          message: "该主键记录与前一行完全相同，确认时只保留第一行。",
          raw_value: key,
          row_number: row.rowNumber,
          severity: "warning",
          sheet: table.sheetName,
          suggestion: "可删除重复行以提高数据清晰度。",
          target_field: contract.primaryField,
        });
      });
    } else {
      rows.forEach((row) => {
        duplicateConflicts.add(row.rowNumber);
        addIssue({
          code: "DUPLICATE_KEY_CONFLICT",
          message: "同一主键存在字段冲突，不能静默覆盖。",
          raw_value: key,
          row_number: row.rowNumber,
          severity: "error",
          sheet: table.sheetName,
          suggestion: "合并或修正冲突记录后重新导入。",
          target_field: contract.primaryField,
        });
      });
    }
  });

  if (dataType !== "orders") {
    const previousByGroup = new Map<string, number>();
    candidates.forEach((candidate) => {
      const group = `${scalarText(candidate.record.order_id)}::${scalarText(candidate.record.shipment_id)}`;
      const eventTime =
        typeof candidate.record.event_time === "string"
          ? Date.parse(candidate.record.event_time)
          : Number.NaN;
      const previous = previousByGroup.get(group);
      if (
        Number.isFinite(eventTime) &&
        previous !== undefined &&
        eventTime < previous
      ) {
        addIssue({
          code: "TIME_ORDER_CONFLICT",
          message: "事件时间早于同一流程中前一导入行。",
          raw_value: String(candidate.record.event_time),
          row_number: candidate.rowNumber,
          severity: "warning",
          sheet: table.sheetName,
          suggestion: "确认源序号、时区和事件排序；系统不会自动改写。",
          target_field: "event_time",
        });
      }
      if (Number.isFinite(eventTime)) previousByGroup.set(group, eventTime);
    });
  }

  const errorRows = new Set(
    issues
      .filter(
        (issue) =>
          issue.severity === "error" &&
          issue.row_number !== null &&
          issue.row_number !== undefined,
      )
      .map((issue) => issue.row_number as number),
  );
  const warningRows = new Set(
    issues
      .filter(
        (issue) =>
          issue.severity === "warning" &&
          issue.row_number !== null &&
          issue.row_number !== undefined,
      )
      .map((issue) => issue.row_number as number),
  );
  const normalizedRows = candidates
    .filter(
      (candidate) =>
        !errorRows.has(candidate.rowNumber) &&
        !excludedExact.has(candidate.rowNumber) &&
        !duplicateConflicts.has(candidate.rowNumber),
    )
    .map((candidate) => candidate.record);
  const statusCounts = new Map<string, StatusNormalization>();
  candidates.forEach(({ status }) => {
    if (!status) return;
    const key = `${status.raw}\u0000${status.normalized}\u0000${status.mappingSource}`;
    const current = statusCounts.get(key);
    statusCounts.set(key, {
      mapping_confidence: status.mappingConfidence,
      mapping_source: status.mappingSource,
      normalized_status: status.normalized,
      occurrences: (current?.occurrences ?? 0) + 1,
      raw_status: status.raw,
    });
  });
  const codeCount = (code: string) =>
    issues.filter((issue) => issue.code === code).length;
  const globalError = issues.some(
    (issue) =>
      issue.severity === "error" &&
      (issue.row_number === null || issue.row_number === undefined),
  );
  const report: QualityReport = {
    can_confirm:
      normalizedRows.length > 0 &&
      errorRows.size === 0 &&
      duplicateConflicts.size === 0 &&
      !globalError,
    duplicate_keys: duplicateKeys,
    error_rows: new Set([...errorRows, ...duplicateConflicts]).size,
    exact_duplicate_rows: excludedExact.size,
    ignored_source_columns: [...ignoredSources].sort(),
    unresolved_source_columns: table.headers
      .filter(
        (source) =>
          !ignoredSources.has(source) &&
          !inferredAuxiliaryColumns.includes(source) &&
          mapping[source] == null,
      )
      .sort(),
    field_resolutions: [
      ...table.headers.map((source): FieldResolution => ({
        reason: ignoredSources.has(source)
          ? "用户已明确排除该源字段，后续标准数据与分析不会包含它。"
          : inferredAuxiliaryColumns.includes(source)
            ? "系统将该列作为状态、签收或异常识别的辅助证据，不直接写入标准字段。"
            : mapping[source] == null
              ? "系统尚未确定该源字段的业务含义。"
              : `该源字段写入标准字段 ${mapping[source]}。`,
        source_column: source,
        status: ignoredSources.has(source)
          ? "ignored"
          : inferredAuxiliaryColumns.includes(source)
            ? "inferred"
            : mapping[source] == null
              ? "unresolved"
              : "mapped",
        target_field: mapping[source] ?? null,
      })),
      ...(deriveTrackingEventId
        ? [
            {
              reason:
                "依据订单、运单、事件时间、原始状态、承运商和源行号生成稳定可复现 ID。",
              source_column: null,
              status: "generated" as const,
              target_field: "tracking_event_id",
            },
          ]
        : []),
      ...(targetToSource.has(contract.rawStatusField) &&
      !targetToSource.has(contract.normalizedStatusField)
        ? [
            {
              reason:
                "由保留的原始状态通过确定性状态词典生成；未知值保持 unmapped。",
              source_column:
                targetToSource.get(contract.rawStatusField) ?? null,
              status: "inferred" as const,
              target_field: contract.normalizedStatusField,
            },
          ]
        : []),
      ...missingRequiredTargets.map((field): FieldResolution => ({
        reason: "标准 Schema 必填字段尚无可靠来源，不能被忽略绕过。",
        source_column: candidateSource(field),
        status: "blocking",
        target_field: field,
      })),
    ],
    invalid_times:
      codeCount("INVALID_TIME") +
      codeCount("TIMEZONE_REQUIRED") +
      codeCount("INVALID_TIMEZONE") +
      codeCount("AMBIGUOUS_LOCAL_TIME") +
      codeCount("NONEXISTENT_LOCAL_TIME"),
    issues,
    long_text_values: codeCount("LONG_TEXT_VALUE"),
    negative_quantities: codeCount("NEGATIVE_OR_INVALID_QUANTITY"),
    null_counts: Object.fromEntries(Object.entries(nullCounts).sort()),
    sensitive_risks: sensitiveRisks,
    status_normalizations: [...statusCounts.values()].sort(
      (left, right) =>
        right.occurrences - left.occurrences ||
        left.raw_status.localeCompare(right.raw_status),
    ),
    time_order_conflicts: codeCount("TIME_ORDER_CONFLICT"),
    total_rows: table.rows.length,
    unknown_statuses: codeCount("UNKNOWN_STATUS"),
    unparseable_values:
      codeCount("UNPARSEABLE_NUMBER") +
      codeCount("AMBIGUOUS_NUMBER_FORMAT") +
      codeCount("UNPARSEABLE_INTEGER") +
      codeCount("FORMULA_CELL_IGNORED") +
      codeCount("EXCEL_ERROR_CELL"),
    valid_rows: normalizedRows.length,
    warning_rows: warningRows.size,
  };
  return { normalizedRows, report };
}

export function validationStatusLabel(canConfirm: boolean): string {
  return canConfirm ? "可确认导入" : "校验失败";
}
