import {
  dataTypeLabels,
  getImportContract,
  supportedDataTypes,
  type ImportContract,
} from "./contracts";
import type {
  DataTypeCandidate,
  FieldEvidence,
  FieldCandidate,
  FieldSuggestion,
  PreviewRow,
  SensitiveRisk,
} from "../types/imports";
import { scalarText } from "./scalar";
import { isDateLike } from "./dateParser";

interface ScoredField {
  confidence: number;
  evidence: FieldEvidence[];
  field: string;
  method: FieldSuggestion["method"];
}

const HIGH_CONFIDENCE = 0.9;
const MEDIUM_CONFIDENCE = 0.65;
const CRITICAL_CANDIDATE_CONFIDENCE = 0.35;

interface ColumnProfile {
  carrierRatio: number;
  dateRatio: number;
  exceptionRatio: number;
  idRatio: number;
  integerRatio: number;
  locationRatio: number;
  nonEmptyCount: number;
  numericRatio: number;
  statusRatio: number;
  uniqueCount: number;
  uniqueRatio: number;
}

const STATUS_VALUE_PATTERN =
  /(揽收|揽件|运输|在途|中转|分拨|到达|离开|发出|派送|派件|签收|妥投|退件|退回|取消|延迟|异常|拣货|复核|打包|出库|入库|shipment|parcel|pickup|picked\s*up|linehaul|transit|arrived|departed|deliver|pod|return|cancel|outbound|pre[- ]?advice)/i;
const CARRIER_VALUE_PATTERN =
  /(承运商|顺丰|中通|圆通|申通|韵达|邮政|EMS|京东|德邦|安能|极兔|DHL|FedEx|UPS|carrier|courier|logistics|express)/i;
const LOCATION_VALUE_PATTERN =
  /(网点|场站|站点|作业点|末端站|分拨|中转|中心|仓|配送站|hub|station|center|depot|warehouse|site|node)/i;
const EXCEPTION_VALUE_PATTERN =
  /(^1$|delay|fail|cancel|return|weather|address|异常|延迟|失败|取消|退件|退回|暴雨|地址)/i;
const ID_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{2,127}$/;

const semanticHeaderPatterns: Partial<Record<string, RegExp[]>> = {
  order_id: [
    /(订单|业务|商务|交易).*(编号|号码|标识|键|关联|参考|码|id|no|key|code)/i,
    /(sales\s*order|trade|business).*(id|no|key|code|reference)/i,
  ],
  shipment_id: [
    /(运单|运货|货运|快递单|物流单|包裹|跟单).*(编号|号码|标识|凭据|参考|码|id|no|key)/i,
    /(waybill|shipment|tracking|package).*(id|no|number|reference|key)/i,
  ],
  tracking_event_id: [
    /(轨迹|物流|扫描|事件|记录|行).*(编号|标识|键|id|key)/i,
    /^(row|event|scan|tracking).*(id|key|no)$/i,
  ],
  event_id: [/(仓库|作业|事件|记录).*(编号|标识|键|id|key)/i],
  event_time: [
    /(发生|事件|节点|轨迹|扫描|操作|作业).*(时间|时刻|日期)/i,
    /(时间|时刻).*(文本|原串|原样)/i,
    /(event|occur|node|scan|operation|tracking).*(time|date|timestamp)/i,
  ],
  raw_status: [
    /(物流|轨迹|运输|操作|扫描|节点|作业).*(状态|结果|短语|描述|动态)/i,
    /(状态|结果|短语).*(原始|文本|描述)?/i,
    /(tracking|carrier|event|scan).*(status|message|description|result)/i,
  ],
  carrier_id: [
    /承运(?:单位|商|公司|伙伴|服务商|编号|标识|码|id)?|(?:快递|物流)(?:公司|伙伴|合作方|服务商|承运商|供应商)/i,
    /(carrier|courier|logistics).*(company|partner|provider|id|code)?/i,
  ],
  location_code: [
    /(场站|网点|站点|节点|作业地点|操作地点|扫描地点|位置)/i,
    /(location|station|site|node|hub|depot)/i,
  ],
  exception_code: [
    /(异常|风险).*(代码|标注|标记|侧写|类型|原因)?/i,
    /(exception|risk).*(code|flag|type|profile)?/i,
  ],
  sequence_number: [
    /(事件|轨迹|扫描|导出|源|行).*(序号|顺序|行号|line|sequence)/i,
    /^(export|source|row).*(line|sequence|number|no)$/i,
  ],
};

function ratio(
  values: string[],
  predicate: (value: string) => boolean,
): number {
  return values.length === 0
    ? 0
    : values.filter((value) => predicate(value)).length / values.length;
}

function profileColumn(
  sourceColumn: string,
  rows: PreviewRow[],
): ColumnProfile {
  const values = rows
    .map((row) => scalarText(row.values[sourceColumn]).normalize("NFKC").trim())
    .filter(Boolean);
  const uniqueCount = new Set(values).size;
  return {
    carrierRatio: ratio(values, (value) => CARRIER_VALUE_PATTERN.test(value)),
    dateRatio: ratio(values, isDateLike),
    exceptionRatio: ratio(values, (value) =>
      EXCEPTION_VALUE_PATTERN.test(value),
    ),
    idRatio: ratio(values, (value) => ID_VALUE_PATTERN.test(value)),
    integerRatio: ratio(values, (value) => /^\d+$/.test(value)),
    locationRatio: ratio(values, (value) => LOCATION_VALUE_PATTERN.test(value)),
    nonEmptyCount: values.length,
    numericRatio: ratio(values, (value) =>
      Number.isFinite(Number(value.replaceAll(",", ""))),
    ),
    statusRatio: ratio(values, (value) => STATUS_VALUE_PATTERN.test(value)),
    uniqueCount,
    uniqueRatio: values.length === 0 ? 0 : uniqueCount / values.length,
  };
}

function evidence(
  code: FieldEvidence["code"],
  label: string,
  strength: FieldEvidence["strength"],
): FieldEvidence {
  return { code, label, strength };
}

function semanticHeaderScore(sourceColumn: string, field: string): number {
  const normalized = sourceColumn.normalize("NFKC").trim();
  return (semanticHeaderPatterns[field] ?? []).some((pattern) =>
    pattern.test(normalized),
  )
    ? 0.84
    : 0;
}

function profileAdjustment(
  field: string,
  profile: ColumnProfile,
  headerScore: number,
): { score: number; evidence: FieldEvidence[] } {
  const items: FieldEvidence[] = [];
  let score = headerScore;
  const promote = (
    candidate: number,
    label: string,
    strength: FieldEvidence["strength"] = "high",
  ) => {
    score = Math.max(score, candidate);
    items.push(evidence("value_profile", label, strength));
  };
  if (field === "event_time" && profile.dateRatio >= 0.8)
    promote(
      headerScore > 0 ? 0.97 : profile.uniqueRatio >= 0.6 ? 0.91 : 0.62,
      `日期解析成功率 ${Math.round(profile.dateRatio * 100)}%`,
    );
  if (field === "raw_status" && profile.statusRatio >= 0.55)
    promote(
      headerScore > 0 ? 0.96 : 0.9,
      `物流状态特征覆盖 ${Math.round(profile.statusRatio * 100)}%`,
    );
  if (field === "carrier_id" && headerScore > 0 && profile.uniqueCount >= 2)
    promote(0.95, `低基数承运主体：${profile.uniqueCount} 个不同值`);
  if (
    field === "location_code" &&
    headerScore > 0 &&
    profile.locationRatio >= 0.25
  )
    promote(
      0.95,
      `网点/节点文本覆盖 ${Math.round(profile.locationRatio * 100)}%`,
    );
  if (field === "exception_code" && headerScore > 0)
    promote(
      profile.exceptionRatio >= 0.1 ? 0.94 : 0.9,
      "异常或风险语义与值模式一致",
    );
  if (
    (field === "shipment_id" || field === "order_id") &&
    headerScore > 0 &&
    profile.idRatio >= 0.8 &&
    profile.uniqueRatio < 0.9
  ) {
    promote(0.96, `同一标识对应多行事件（${profile.uniqueCount} 个不同值）`);
    items.push(evidence("relationship", "重复规律符合一单多事件", "high"));
  }
  if (
    (field === "tracking_event_id" || field === "event_id") &&
    headerScore > 0 &&
    profile.uniqueRatio === 1 &&
    profile.nonEmptyCount > 0
  ) {
    promote(0.97, "非空且文件内唯一，可作为事件标识");
    items.push(evidence("cardinality", "唯一值比例 100%", "high"));
  }
  if (
    (field === "tracking_event_id" || field === "event_id") &&
    profile.nonEmptyCount > 1 &&
    profile.uniqueRatio < 1
  ) {
    score = Math.min(score, 0.4);
    items.push(
      evidence("cardinality", "存在重复值，不能作为事件唯一标识", "high"),
    );
  }
  if (
    field === "sequence_number" &&
    headerScore > 0 &&
    profile.integerRatio >= 0.9 &&
    profile.uniqueRatio >= 0.9
  ) {
    promote(0.95, "整数且接近逐行唯一，符合源序号");
  }
  return { evidence: items, score };
}

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
  const profile = profileColumn(sourceColumn, rows);
  return contract.fields
    .map((definition): ScoredField => {
      if (sourceColumn === definition.field) {
        return {
          confidence: 1,
          evidence: [evidence("header", "与内部字段代码完全一致", "high")],
          field: definition.field,
          method: "Exact",
        };
      }
      const normalizedField = normalizeFieldName(definition.field);
      if (sourceVariants.includes(normalizedField)) {
        return {
          confidence: 0.98,
          evidence: [evidence("header", "规范化后与内部字段一致", "high")],
          field: definition.field,
          method: "Normalized",
        };
      }
      const aliases = [definition.label, ...definition.aliases].flatMap(
        normalizeFieldVariants,
      );
      if (aliases.some((alias) => sourceVariants.includes(alias))) {
        return {
          confidence: 0.96,
          evidence: [evidence("alias", "命中可维护的业务别名", "high")],
          field: definition.field,
          method: "Alias",
        };
      }
      const bestSimilarity = Math.max(
        ...sourceVariants.flatMap((source) => [
          similarity(source, normalizedField),
          ...aliases.map((alias) => similarity(source, alias)),
        ]),
      );
      const headerScore = semanticHeaderScore(sourceColumn, definition.field);
      const profiled = profileAdjustment(
        definition.field,
        profile,
        headerScore,
      );
      let score = Math.max(bestSimilarity * 0.74, profiled.score);
      const scoreEvidence = [...profiled.evidence];
      if (headerScore > 0) {
        scoreEvidence.unshift(
          evidence("header", "字段名包含匹配的通用业务语义", "medium"),
        );
      }
      if (
        profile.numericRatio >= 0.9 &&
        definition.value_type.includes("number")
      ) {
        score = Math.max(score, headerScore > 0 ? 0.91 : 0.62);
        scoreEvidence.push(evidence("value_profile", "数值类型匹配", "medium"));
      }
      if (
        definition.field === "event_time" &&
        /(预计|承诺|promise|expected|sla)/i.test(sourceColumn.normalize("NFKC"))
      ) {
        score = Math.min(score, 0.45);
        scoreEvidence.push(
          evidence("schema_prior", "承诺/预计日期不是物流事件发生时间", "high"),
        );
      }
      return {
        confidence: Number(Math.max(0, Math.min(0.94, score)).toFixed(4)),
        evidence: scoreEvidence.length
          ? scoreEvidence
          : [evidence("header", "仅有低强度文本相似度", "low")],
        field: definition.field,
        method: headerScore > 0 ? "Semantic" : "Similarity",
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
    const auxiliaryPurpose = detectAuxiliaryPurpose(sourceColumn, contract);
    const safeToPreselect =
      top.confidence >= MEDIUM_CONFIDENCE &&
      top.confidence - second >= 0.06 &&
      !(auxiliaryPurpose && top.confidence < HIGH_CONFIDENCE);
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
      auxiliary_purpose: auxiliaryPurpose,
      auto_applied: safeToPreselect && top.confidence >= HIGH_CONFIDENCE,
      candidates,
      confidence: top.confidence,
      confidence_level:
        top.confidence >= HIGH_CONFIDENCE
          ? "high"
          : top.confidence >= MEDIUM_CONFIDENCE
            ? "medium"
            : "low",
      method: top.method,
      requires_confirmation:
        safeToPreselect && top.confidence < HIGH_CONFIDENCE,
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
  /(订单|运单|物流|轨迹|事件|时间|时刻|日期|状态|扫描|承运|快递|节点|网点|场站|位置|区域|城市|异常|序号|签收|老码|代码|编号|标识|参考|order|shipment|tracking|event|time|date|status|scan|carrier|courier|location|region|exception|sequence|reference|\bid\b|\bno\b)/i;
const NON_ANALYSIS_HEADER_PATTERN =
  /(客户?备注|内部备注|营销|推广|标签|批次|班次|设备|采集来源|接入入口|采集终端|计费重|称重|计价|流向简述|路径摘要|收件偏好|店铺来源|销售员|debug|(?:预计|承诺).*(送达|交付|日期|时间))/i;

function auxiliaryHeaders(contract: ImportContract): Set<string> {
  return new Set(
    Object.values(contract.auxiliaryAliases)
      .flat()
      .flatMap(normalizeFieldVariants),
  );
}

const auxiliaryHeaderPatterns: Array<[string, RegExp]> = [
  [
    "legacy_status_code",
    /(历史|旧|老|源).*(状态|枚举|代码|码)|legacy.*(status|enum|code)/i,
  ],
  [
    "delivery_confirmation",
    /(签收|妥投|pod|delivery).*(回传|标记|确认|echo|flag)?/i,
  ],
  [
    "exception_indicator",
    /(风险|异常).*(标注|标记|侧写|indicator|flag|profile)/i,
  ],
];

export function detectAuxiliaryPurpose(
  sourceColumn: string,
  contract: ImportContract,
): string | null {
  const variants = normalizeFieldVariants(sourceColumn);
  for (const [purpose, aliases] of Object.entries(contract.auxiliaryAliases)) {
    const normalized = new Set(aliases.flatMap(normalizeFieldVariants));
    if (variants.some((variant) => normalized.has(variant))) return purpose;
  }
  return (
    auxiliaryHeaderPatterns.find(([, pattern]) =>
      pattern.test(sourceColumn.normalize("NFKC")),
    )?.[0] ?? null
  );
}

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
  const auxiliary = auxiliaryHeaders(contract);
  const mappedConfidence = new Map<string, number>();
  for (const suggestion of suggestions) {
    const target = mapping[suggestion.source_column];
    if (target == null || ignored.has(suggestion.source_column)) continue;
    mappedConfidence.set(
      target,
      Math.max(mappedConfidence.get(target) ?? 0, suggestion.confidence),
    );
  }
  return suggestions
    .filter((suggestion) => {
      const source = suggestion.source_column;
      if (ignored.has(source) || mapping[source] != null) return false;
      if (suggestion.auxiliary_purpose) return false;
      if (
        normalizeFieldVariants(source).some((variant) => auxiliary.has(variant))
      ) {
        return false;
      }
      const meaningfulCandidates = suggestion.candidates.filter(
        (candidate) => candidate.confidence >= MEDIUM_CONFIDENCE,
      );
      if (
        meaningfulCandidates.length > 0 &&
        meaningfulCandidates.every(
          (candidate) =>
            (mappedConfidence.get(candidate.field) ?? 0) >=
            candidate.confidence,
        )
      ) {
        // A stronger source already supplies every plausible meaning for this
        // column. Treat the duplicate semantic column as optional instead of
        // forcing a beginner to confirm it field by field.
        return true;
      }
      if (NON_ANALYSIS_HEADER_PATTERN.test(source.normalize("NFKC"))) {
        return !suggestion.candidates.some(
          (candidate) =>
            critical.has(candidate.field) && candidate.confidence >= 0.75,
        );
      }
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

/** Medium-confidence mappings can be accepted once as a group. */
export function findRecommendedMappingSources(
  suggestions: FieldSuggestion[],
  mapping: Record<string, string | null>,
  ignoredSourceColumns: string[],
): string[] {
  const ignored = new Set(ignoredSourceColumns);
  return suggestions
    .filter(
      (suggestion) =>
        !ignored.has(suggestion.source_column) &&
        mapping[suggestion.source_column] != null &&
        suggestion.requires_confirmation === true &&
        suggestion.confidence >= MEDIUM_CONFIDENCE,
    )
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
      const profiles = sourceColumns.map((column) =>
        profileColumn(column, rows),
      );
      const eventShape =
        profiles.some((profile) => profile.dateRatio >= 0.8) &&
        profiles.some((profile) => profile.statusRatio >= 0.45) &&
        profiles.some(
          (profile) =>
            profile.idRatio >= 0.7 &&
            profile.uniqueCount >= 2 &&
            profile.uniqueRatio < 0.8,
        );
      const shapeAdjustment =
        eventShape && dataType === "tracking_events"
          ? 0.12
          : eventShape && dataType === "orders"
            ? -0.12
            : 0;
      const missing = [...required].filter((field) => !matched.has(field));
      if (!statusMatched) missing.push(contract.rawStatusField);
      return {
        confidence: Number(
          Math.max(
            0,
            Math.min(
              1,
              coverage * 0.75 + breadth * 0.15 + 0.1 + shapeAdjustment,
            ),
          ).toFixed(4),
        ),
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
  inferredSourceColumns: string[] = [],
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
  const inferred = new Set(inferredSourceColumns);
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
    (source) =>
      !ignored.has(source) && !inferred.has(source) && mapping[source] == null,
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
