import { browserLocalAnalyticsService } from "./browserLocalAnalyticsService";
import type {
  DiagnosticAnalysis,
  DiagnosticCategory,
  DiagnosticOrderDetail,
  DiagnosticOrderFilters,
  DiagnosticOrderPage,
  DiagnosticRequest,
  DiagnosticResult,
  DiagnosticSeverity,
} from "../types/diagnostics";

const RULE_VERSION = "browser-diagnostics-v1.1.1";
const SEVERITY_ORDER: Record<DiagnosticSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function result(
  input: Pick<
    DiagnosticResult,
    | "rule_id"
    | "title"
    | "category"
    | "severity"
    | "factual_observation"
    | "rule_judgement"
    | "possible_causes"
    | "evidence"
    | "affected_order_count"
    | "affected_order_sample"
    | "coverage"
    | "confidence_warning"
    | "recommended_checks"
    | "sample_size"
    | "priority"
  >,
): DiagnosticResult {
  return {
    ...input,
    rule_version: RULE_VERSION,
    merged_rule_ids: [],
    dimension_type: null,
    dimension_value: null,
  };
}

async function analyze(
  request: DiagnosticRequest,
): Promise<DiagnosticAnalysis> {
  const data = await browserLocalAnalyticsService.load(request.datasets);
  const results: DiagnosticResult[] = [];
  const orderCount = data.details.length;
  const entityLabel = data.orderDatasetPresent ? "订单" : "运单";
  const unmapped = data.events.filter(
    (event) => event.event_code === "unmapped",
  );
  if (unmapped.length > 0) {
    const affected = [
      ...new Set(
        unmapped.map((event) => event.analysis_entity_id).filter(Boolean),
      ),
    ];
    results.push(
      result({
        rule_id: "DQ-STATUS-UNMAPPED",
        title: "存在未映射物流状态",
        category: "data_quality",
        severity: "medium",
        factual_observation: `${unmapped.length} 条事件的原始状态未能可靠映射，影响 ${affected.length} 个${entityLabel}。`,
        rule_judgement: "状态覆盖不足会降低节点耗时和流程变体分析的完整性。",
        possible_causes: ["可能是源系统自定义状态，需核对状态字典。"],
        evidence: unmapped
          .slice(0, request.max_evidence_per_result)
          .map((event) => ({
            order_id: event.analysis_entity_id || null,
            event_id: event.event_id,
            shipment_id: event.shipment_id || null,
            node_code: event.event_code,
            start_time: event.event_time || null,
            end_time: null,
            observed_value: null,
            threshold_value: null,
            baseline_value: null,
            unit: null,
            dimension_type: null,
            dimension_value: null,
            comparison: `原始状态“${event.raw_status}”保留为 unmapped。`,
          })),
        affected_order_count: affected.length,
        affected_order_sample: affected.slice(
          0,
          request.max_evidence_per_result,
        ),
        coverage: data.events.length
          ? 1 - unmapped.length / data.events.length
          : null,
        confidence_warning: [],
        recommended_checks: [
          "在导入质量报告中核对原始状态，并新增项目级确定性映射。",
        ],
        sample_size: data.events.length,
        priority: 620,
      }),
    );
  }

  const exceptionEvents = data.events.filter(
    (event) =>
      Boolean(event.exception_code) ||
      ["exception", "delivery_failed", "return_initiated", "returned"].includes(
        event.event_code,
      ),
  );
  if (exceptionEvents.length > 0) {
    const affected = [
      ...new Set(
        exceptionEvents
          .map((event) => event.analysis_entity_id)
          .filter(Boolean),
      ),
    ];
    results.push(
      result({
        rule_id: "TRACKING-EXCEPTION-SIGNAL",
        title: "物流轨迹出现异常或退件信号",
        category: "data_quality",
        severity:
          affected.length / Math.max(orderCount, 1) >= 0.15 ? "high" : "medium",
        factual_observation: `${exceptionEvents.length} 条事件带有异常、失败或退件信号，影响 ${affected.length} / ${orderCount} 个${entityLabel}。`,
        rule_judgement:
          "这些事件需要订单级核查；信号本身不等于已确认责任或根因。",
        possible_causes: [
          "可能与地址、天气、联系失败或退件流程有关，具体原因需核对源异常码。",
        ],
        evidence: exceptionEvents
          .slice(0, request.max_evidence_per_result)
          .map((event) => ({
            order_id: event.analysis_entity_id || null,
            event_id: event.event_id,
            shipment_id: event.shipment_id || null,
            node_code: event.event_code,
            start_time: event.event_time || null,
            end_time: null,
            observed_value: null,
            threshold_value: null,
            baseline_value: null,
            unit: null,
            dimension_type: null,
            dimension_value: null,
            comparison: `异常信号：${event.exception_code || event.event_code}`,
          })),
        affected_order_count: affected.length,
        affected_order_sample: affected.slice(
          0,
          request.max_evidence_per_result,
        ),
        coverage: orderCount ? affected.length / orderCount : null,
        confidence_warning: [
          "本地规则仅使用标准化事件和异常码，不推断未记录的经营原因。",
        ],
        recommended_checks: [
          "按异常码、承运商和节点下钻受影响订单，核对原始轨迹。",
        ],
        sample_size: data.events.length,
        priority: 760,
      }),
    );
  }

  const affectedOrders = new Set(
    results.flatMap((item) => item.affected_order_sample),
  );
  const severitySummary = (["critical", "high", "medium", "low"] as const).map(
    (severity) => ({
      severity,
      finding_count: results.filter((item) => item.severity === severity)
        .length,
      affected_order_count: new Set(
        results
          .filter((item) => item.severity === severity)
          .flatMap((item) => item.affected_order_sample),
      ).size,
    }),
  );
  const categories = new Map<
    DiagnosticCategory,
    { count: number; orders: Set<string> }
  >();
  results.forEach((item) => {
    const current = categories.get(item.category) ?? {
      count: 0,
      orders: new Set(),
    };
    current.count += 1;
    item.affected_order_sample.forEach((order) => current.orders.add(order));
    categories.set(item.category, current);
  });
  let cumulative = 0;
  const totalAffected = [...categories.values()].reduce(
    (sum, item) => sum + item.orders.size,
    0,
  );
  const pareto = [...categories.entries()]
    .sort((left, right) => right[1].orders.size - left[1].orders.size)
    .map(([category, item]) => {
      cumulative += item.orders.size;
      return {
        category,
        display_name: category === "data_quality" ? "事件数据异常" : category,
        finding_count: item.count,
        affected_order_count: item.orders.size,
        cumulative_share: totalAffected ? cumulative / totalAffected : 0,
      };
    });
  return {
    context: {
      analysis_fingerprint: data.analysisFingerprint,
      analysis_source: data.analysisSource,
      datasets: request.datasets,
      analyzed_at: new Date().toISOString(),
      order_count: orderCount,
      valid_order_count: orderCount,
      affected_order_count: affectedOrders.size,
      finding_count: results.length,
      enabled_rule_count: 2,
      triggered_rule_count: results.length,
      data_coverage: data.events.length ? 1 : null,
      warning_count: results.reduce(
        (sum, item) => sum + item.confidence_warning.length,
        0,
      ),
      timezone: request.timezone,
    },
    results: results.sort((left, right) => right.priority - left.priority),
    severity_summary: severitySummary,
    pareto,
    bottleneck_nodes: [],
    process_variants: [],
    dimension_insights: [],
    analysis_warnings: data.orderDatasetPresent
      ? []
      : [
          "当前只有事件数据；诊断限于事件状态、异常信号和数据质量，不生成订单 SLA 根因。",
        ],
    rule_set_version: RULE_VERSION,
  };
}

export const browserLocalDiagnosticsService = {
  analyze,

  async orders(
    request: DiagnosticRequest,
    filters: DiagnosticOrderFilters,
  ): Promise<DiagnosticOrderPage> {
    const [analysis, data] = await Promise.all([
      analyze(request),
      browserLocalAnalyticsService.load(request.datasets),
    ]);
    const byOrder = new Map<string, DiagnosticResult[]>();
    analysis.results.forEach((finding) => {
      finding.affected_order_sample.forEach((orderId) => {
        byOrder.set(orderId, [...(byOrder.get(orderId) ?? []), finding]);
      });
    });
    let items = data.details.flatMap((detail) => {
      const findings = byOrder.get(detail.order_id) ?? [];
      if (findings.length === 0) return [];
      const highest =
        [...findings].sort(
          (left, right) =>
            SEVERITY_ORDER[right.severity] - SEVERITY_ORDER[left.severity],
        )[0]?.severity ?? "low";
      return [
        {
          order_id: detail.order_id,
          order_status: detail.order_status,
          warehouse_id: detail.warehouse_id,
          carrier_id: detail.carrier_id,
          destination_region: detail.destination_region,
          highest_severity: highest,
          categories: [...new Set(findings.map((item) => item.category))],
          rule_ids: [...new Set(findings.map((item) => item.rule_id))],
          finding_count: findings.length,
        },
      ];
    });
    if (filters.severity)
      items = items.filter(
        (item) => item.highest_severity === filters.severity,
      );
    if (filters.category)
      items = items.filter((item) =>
        item.categories.includes(filters.category!),
      );
    if (filters.ruleId)
      items = items.filter((item) => item.rule_ids.includes(filters.ruleId!));
    const start = (filters.page - 1) * filters.pageSize;
    return {
      datasets: request.datasets,
      items: items.slice(start, start + filters.pageSize),
      total: items.length,
      page: filters.page,
      page_size: filters.pageSize,
      page_count: Math.ceil(items.length / filters.pageSize),
      rule_set_version: RULE_VERSION,
    };
  },

  async orderDetail(
    request: DiagnosticRequest,
    orderId: string,
  ): Promise<DiagnosticOrderDetail> {
    const [analysis, data] = await Promise.all([
      analyze(request),
      browserLocalAnalyticsService.load(request.datasets),
    ]);
    const metricDetail = data.details.find((item) => item.order_id === orderId);
    if (!metricDetail) throw new Error("当前浏览器本地数据中找不到该订单。 ");
    return {
      metric_detail: metricDetail,
      findings: analysis.results.filter((item) =>
        item.affected_order_sample.includes(orderId),
      ),
      timeline: data.events
        .filter((event) => event.analysis_entity_id === orderId)
        .sort((left, right) => left.event_time.localeCompare(right.event_time))
        .map((event) => ({
          source: event.source,
          event_id: event.event_id,
          event_time: event.event_time,
          event_code: event.event_code,
          raw_status: event.raw_status,
          shipment_id: event.shipment_id || null,
          location_code: event.location_code || null,
        })),
      rule_set_version: RULE_VERSION,
    };
  },
};
