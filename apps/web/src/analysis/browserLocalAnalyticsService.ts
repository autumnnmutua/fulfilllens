import {
  readBrowserDataset,
  type BrowserDataset,
} from "../imports/browserDatasetStore";
import { BROWSER_DERIVED_ORDERS_ID } from "./browserSelection";
import type {
  DashboardFilters,
  DashboardOrderOptions,
  DashboardOrderPage,
  DashboardOverview,
  DashboardViewOptions,
  NodeDurationSummary,
} from "../types/dashboard";
import type {
  DataWarning,
  DatasetSelection,
  Decision,
  MetricGroup,
  MetricResult,
  NodeDuration,
  OrderMetricDetail,
} from "../types/metrics";

export const BROWSER_METRICS_VERSION = "browser-metrics-v1.0.0";
const BROWSER_RULE_VERSION = "browser-analysis-rules-v1.0.0";

export interface EventRow {
  event_code: string;
  event_id: string;
  event_time: string;
  exception_code: string;
  location_code: string;
  order_id: string;
  raw_status: string;
  shipment_id: string;
  source: "tracking" | "warehouse";
}

export interface LocalAnalysisData {
  datasets: DatasetSelection;
  details: OrderMetricDetail[];
  events: EventRow[];
  sourceFiles: string[];
  qualityWarningCount: number;
  statusNormalizations: BrowserDataset["qualityReport"]["status_normalizations"];
  orderDatasetPresent: boolean;
}

function text(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean" &&
    typeof value !== "bigint"
  )
    return fallback;
  return String(value).trim() || fallback;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isoMillis(value: unknown): number | null {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function quantile(values: number[], probability: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const left = sorted[lower] ?? 0;
  const right = sorted[upper] ?? left;
  return left + (right - left) * (position - lower);
}

function average(values: number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function trackingSpanHours(detail: OrderMetricDetail): number | null {
  const values = detail.node_durations.map((item) => item.duration_hours);
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0);
}

function durationValues(
  details: OrderMetricDetail[],
  orderDatasetPresent: boolean,
): number[] {
  return details
    .map((item) =>
      orderDatasetPresent
        ? item.fulfillment_duration_hours
        : trackingSpanHours(item),
    )
    .filter((value): value is number => value !== null);
}

function analysisDate(detail: OrderMetricDetail): string | null {
  return detail.created_at ?? detail.node_durations[0]?.start_time ?? null;
}

function decision(
  value: boolean | null,
  reason: string,
  excluded = false,
): Decision {
  return excluded
    ? { reason, status: "excluded", value: null }
    : value === null
      ? { reason, status: "not_computable", value: null }
      : { reason, status: value ? "true" : "false", value };
}

function metric(
  code: string,
  displayName: string,
  unit: MetricResult["unit"],
  value: number | null,
  numerator: number | null,
  denominator: number | null,
  eligible: number,
  warnings: string[] = [],
): MetricResult {
  const computable = denominator ?? (value === null ? 0 : eligible);
  return {
    code,
    display_name: displayName,
    value,
    unit,
    numerator,
    denominator,
    coverage: eligible === 0 ? null : computable / eligible,
    eligible_count: eligible,
    computable_count: computable,
    pending_count: 0,
    not_computable_count: Math.max(0, eligible - computable),
    definition_version: BROWSER_METRICS_VERSION,
    warnings,
  };
}

async function optionalDataset(
  id: string | null | undefined,
): Promise<BrowserDataset | null> {
  if (!id?.startsWith("browser-local-") || id === BROWSER_DERIVED_ORDERS_ID)
    return null;
  return (await readBrowserDataset(id)) ?? null;
}

function eventRows(
  dataset: BrowserDataset | null,
  source: EventRow["source"],
): EventRow[] {
  if (!dataset) return [];
  return dataset.rows.map((row, index) => ({
    event_code: text(row.event_code, "unmapped"),
    event_id: text(
      row.tracking_event_id ?? row.event_id,
      `${dataset.datasetId}:${index + 1}`,
    ),
    event_time: text(row.event_time),
    exception_code: text(row.exception_code),
    location_code: text(row.location_code, "未知"),
    order_id: text(row.order_id),
    raw_status: text(row.raw_status),
    shipment_id: text(row.shipment_id),
    source,
  }));
}

function isExcludedStatus(status: string): boolean {
  return ["cancelled", "returned", "warehouse_cancelled"].includes(status);
}

function eventAnomaly(event: EventRow): string[] {
  const codes = new Set<string>();
  if (event.exception_code) codes.add(event.exception_code);
  if (
    ["exception", "delivery_failed", "return_initiated", "returned"].includes(
      event.event_code,
    )
  ) {
    codes.add(event.event_code);
  }
  if (event.event_code === "unmapped") codes.add("unmapped_status");
  return [...codes];
}

function nodeDurations(events: EventRow[]): NodeDuration[] {
  const result: NodeDuration[] = [];
  const byShipment = new Map<string, EventRow[]>();
  events.forEach((event) => {
    const key = event.shipment_id || event.order_id;
    if (!key) return;
    byShipment.set(key, [...(byShipment.get(key) ?? []), event]);
  });
  byShipment.forEach((items, shipmentId) => {
    const sorted = [...items].sort(
      (left, right) =>
        (isoMillis(left.event_time) ?? 0) - (isoMillis(right.event_time) ?? 0),
    );
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (!previous || !current) continue;
      const start = isoMillis(previous.event_time);
      const end = isoMillis(current.event_time);
      if (start === null || end === null || end < start) continue;
      result.push({
        interval_code: `${previous.event_code}_to_${current.event_code}`,
        display_name: `${previous.event_code} → ${current.event_code}`,
        duration_hours: (end - start) / 3_600_000,
        start_time: previous.event_time,
        end_time: current.event_time,
        shipment_id: shipmentId,
        location_code: current.location_code,
      });
    }
  });
  return result;
}

async function load(selection: DatasetSelection): Promise<LocalAnalysisData> {
  const [ordersDataset, warehouseDataset, trackingDataset] = await Promise.all([
    optionalDataset(selection.orders_dataset_id),
    optionalDataset(selection.warehouse_events_dataset_id),
    optionalDataset(selection.tracking_events_dataset_id),
  ]);
  const events = [
    ...eventRows(warehouseDataset, "warehouse"),
    ...eventRows(trackingDataset, "tracking"),
  ];
  const eventsByOrder = new Map<string, EventRow[]>();
  events.forEach((event) => {
    if (!event.order_id) return;
    eventsByOrder.set(event.order_id, [
      ...(eventsByOrder.get(event.order_id) ?? []),
      event,
    ]);
  });
  const orderRows = ordersDataset?.rows ?? [];
  const orderIds = new Set([
    ...orderRows.map((row) => text(row.order_id)).filter(Boolean),
    ...eventsByOrder.keys(),
  ]);
  const rowByOrder = new Map(
    orderRows
      .map((row) => [text(row.order_id), row] as const)
      .filter(([id]) => Boolean(id)),
  );
  const details = [...orderIds].sort().map((orderId): OrderMetricDetail => {
    const row = rowByOrder.get(orderId) ?? {};
    const orderEvents = [...(eventsByOrder.get(orderId) ?? [])].sort(
      (left, right) =>
        (isoMillis(left.event_time) ?? 0) - (isoMillis(right.event_time) ?? 0),
    );
    const latest = orderEvents.at(-1);
    const deliveredEvent = [...orderEvents]
      .reverse()
      .find((event) => event.event_code === "delivered");
    const orderStatus = text(row.order_status, latest?.event_code ?? "未知");
    const excluded = isExcludedStatus(orderStatus);
    const createdAt = text(row.created_at) || null;
    const promised = text(row.promised_delivery_time) || null;
    const actual =
      text(row.actual_delivery_time, deliveredEvent?.event_time ?? "") || null;
    const createdMs = isoMillis(createdAt);
    const promisedMs = isoMillis(promised);
    const actualMs = isoMillis(actual);
    const ordered = numberValue(row.ordered_quantity);
    const delivered = numberValue(row.delivered_quantity);
    const ot = decision(
      promisedMs !== null && actualMs !== null ? actualMs <= promisedMs : null,
      promisedMs === null || actualMs === null
        ? "缺少订单承诺送达时间或实际交付时间，OT 不可计算。"
        : "实际交付时间与承诺送达时间直接比较。",
      excluded,
    );
    const inFull = decision(
      ordered !== null && delivered !== null ? delivered >= ordered : null,
      ordered === null || delivered === null
        ? "缺少订购数量或实际交付数量，IF 不可计算。"
        : "实际交付数量与订购数量直接比较。",
      excluded,
    );
    const otif = decision(
      ot.value === null || inFull.value === null
        ? null
        : ot.value && inFull.value,
      ot.value === null || inFull.value === null
        ? "OT 与 IF 必须同时可计算，OTIF 才可计算。"
        : "OT 与 IF 同时为真时 OTIF 为真。",
      excluded,
    );
    const anomalies = new Set(orderEvents.flatMap(eventAnomaly));
    if (orderStatus === "cancelled" || orderStatus === "returned")
      anomalies.add(orderStatus);
    const warnings: DataWarning[] = [];
    if (!ordersDataset) {
      warnings.push({
        code: "ORDER_DATA_REQUIRED",
        message:
          "当前只有事件数据；OT、IF、OTIF 和订单履约总时长需要关联订单表。",
        order_id: orderId,
      });
    }
    return {
      order_id: orderId,
      order_status: orderStatus,
      created_at: createdAt,
      promised_delivery_time: promised,
      actual_delivery_time: actual,
      ordered_quantity: ordered,
      delivered_quantity: delivered,
      quantity_unit: text(row.quantity_unit) || null,
      warehouse_id: text(row.warehouse_id, "未知"),
      carrier_id: text(
        row.carrier_id,
        latest?.source === "tracking"
          ? text(
              (
                trackingDataset?.rows.find(
                  (item) => text(item.order_id) === orderId,
                ) ?? {}
              ).carrier_id,
              "未知",
            )
          : "未知",
      ),
      destination_region: text(row.destination_region, "未知"),
      sales_channel: text(row.sales_channel, "未知"),
      ot,
      in_full: inFull,
      otif,
      fulfillment_duration_hours:
        createdMs !== null && actualMs !== null && actualMs >= createdMs
          ? (actualMs - createdMs) / 3_600_000
          : null,
      anomaly: anomalies.size > 0,
      anomaly_reasons: [...anomalies].sort(),
      node_durations: nodeDurations(orderEvents),
      warnings,
      definition_version: BROWSER_METRICS_VERSION,
      rule_set_version: BROWSER_RULE_VERSION,
    };
  });
  const datasets = [ordersDataset, warehouseDataset, trackingDataset].filter(
    (item): item is BrowserDataset => item !== null,
  );
  return {
    datasets: selection,
    details,
    events,
    sourceFiles: datasets.map((item) => item.fileName),
    qualityWarningCount: datasets.reduce(
      (sum, item) => sum + item.qualityReport.issues.length,
      0,
    ),
    statusNormalizations: datasets.flatMap(
      (item) => item.qualityReport.status_normalizations,
    ),
    orderDatasetPresent: ordersDataset !== null,
  };
}

function metricsFor(
  details: OrderMetricDetail[],
  orderDatasetPresent: boolean,
): MetricResult[] {
  const eligible = details.filter(
    (item) => !isExcludedStatus(item.order_status),
  );
  const rate = (
    code: string,
    label: string,
    key: "ot" | "in_full" | "otif",
  ): MetricResult => {
    const values = eligible.filter((item) => item[key].value !== null);
    const successes = values.filter((item) => item[key].value === true).length;
    return metric(
      code,
      label,
      "ratio",
      values.length ? successes / values.length : null,
      values.length ? successes : null,
      values.length || null,
      eligible.length,
      values.length
        ? []
        : [
            key === "ot"
              ? "当前数据不足以计算 OT：需要订单承诺送达时间和实际交付时间。"
              : key === "in_full"
                ? "当前数据不足以计算 IF：需要订购数量和实际交付数量。"
                : "当前数据不足以计算 OTIF：OT 与 IF 必须同时可计算。",
          ],
    );
  };
  const durations = durationValues(eligible, orderDatasetPresent);
  const durationMetric = (code: string, label: string, value: number | null) =>
    metric(
      code,
      label,
      "hour",
      value,
      value,
      durations.length || null,
      eligible.length,
      durations.length
        ? orderDatasetPresent
          ? []
          : [
              "该时效按同一业务单/运单的首末物流事件计算，不等于订单创建至交付的完整履约时长。",
            ]
        : [
            orderDatasetPresent
              ? "订单履约总时长需要订单创建时间和实际交付时间。"
              : "至少需要同一业务单/运单的两个有效时间事件才能计算首末轨迹时效。",
          ],
    );
  const cancelled = details.filter(
    (item) => item.order_status === "cancelled",
  ).length;
  const returned = details.filter(
    (item) => item.order_status === "returned",
  ).length;
  const anomalies = details.filter((item) => item.anomaly).length;
  const completeOrders = orderDatasetPresent
    ? details.filter(
        (item) =>
          item.created_at &&
          item.promised_delivery_time &&
          item.actual_delivery_time &&
          item.ordered_quantity !== null &&
          item.delivered_quantity !== null,
      ).length
    : 0;
  return [
    metric(
      "total_order_count",
      "订单总数",
      "order",
      details.length,
      details.length,
      details.length,
      details.length,
    ),
    metric(
      "valid_order_count",
      "有效订单数",
      "order",
      details.length,
      details.length,
      details.length,
      details.length,
    ),
    rate("ot_rate", "按时交付率（OT）", "ot"),
    rate("if_rate", "足量交付率（IF）", "in_full"),
    rate("otif_rate", "按时足量交付率（OTIF）", "otif"),
    durationMetric(
      "fulfillment_duration_mean_hours",
      orderDatasetPresent ? "平均履约时长" : "平均首末轨迹时效",
      average(durations),
    ),
    durationMetric(
      "fulfillment_duration_median_hours",
      orderDatasetPresent ? "P50 履约时长" : "P50 首末轨迹时效",
      quantile(durations, 0.5),
    ),
    durationMetric(
      "fulfillment_duration_p90_hours",
      orderDatasetPresent ? "P90 履约时长" : "P90 首末轨迹时效",
      quantile(durations, 0.9),
    ),
    metric(
      "cancellation_rate",
      "取消率",
      "ratio",
      details.length ? cancelled / details.length : null,
      cancelled,
      details.length || null,
      details.length,
    ),
    metric(
      "return_rate",
      "退回率",
      "ratio",
      details.length ? returned / details.length : null,
      returned,
      details.length || null,
      details.length,
    ),
    metric(
      "anomaly_order_rate",
      "异常订单率",
      "ratio",
      details.length ? anomalies / details.length : null,
      anomalies,
      details.length || null,
      details.length,
    ),
    metric(
      "data_coverage_rate",
      "数据覆盖率",
      "ratio",
      details.length ? completeOrders / details.length : null,
      completeOrders,
      details.length || null,
      details.length,
    ),
  ];
}

function filterDetails(
  details: OrderMetricDetail[],
  filters: DashboardFilters,
): OrderMetricDetail[] {
  return details.filter((item) => {
    const date = analysisDate(item)?.slice(0, 10) ?? null;
    return (
      (!filters.start_date || (date !== null && date >= filters.start_date)) &&
      (!filters.end_date || (date !== null && date <= filters.end_date)) &&
      (filters.warehouses.length === 0 ||
        filters.warehouses.includes(item.warehouse_id)) &&
      (filters.carriers.length === 0 ||
        filters.carriers.includes(item.carrier_id)) &&
      (filters.regions.length === 0 ||
        filters.regions.includes(item.destination_region)) &&
      (filters.statuses.length === 0 ||
        filters.statuses.includes(item.order_status)) &&
      (filters.anomaly_types.length === 0 ||
        item.anomaly_reasons.some((reason) =>
          filters.anomaly_types.includes(reason),
        ))
    );
  });
}

function options(values: string[]) {
  const counts = new Map<string, number>();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "zh-CN"))
    .map(([value, count]) => ({ value, label: value, count }));
}

function nodeSummaries(details: OrderMetricDetail[]): NodeDurationSummary[] {
  const groups = new Map<string, NodeDuration[]>();
  details
    .flatMap((item) => item.node_durations)
    .forEach((item) => {
      groups.set(item.interval_code, [
        ...(groups.get(item.interval_code) ?? []),
        item,
      ]);
    });
  const summaries: NodeDurationSummary[] = [...groups.entries()].map(
    ([code, items]) => {
      const values = items.map((item) => item.duration_hours);
      return {
        interval_code: code,
        display_name: items[0]?.display_name ?? code,
        mean_hours: average(values),
        median_hours: quantile(values, 0.5),
        p90_hours: quantile(values, 0.9),
        sample_size: values.length,
        eligible_count: details.length,
        coverage: details.length
          ? new Set(items.map((item) => item.shipment_id)).size / details.length
          : null,
        is_bottleneck: false,
        warnings: values.length < 5 ? ["样本少于 5，仅用于核查。"] : [],
      };
    },
  );
  const maximum = Math.max(...summaries.map((item) => item.p90_hours ?? 0), 0);
  summaries.forEach((item) => {
    item.is_bottleneck = maximum > 0 && item.p90_hours === maximum;
  });
  return summaries.sort(
    (left, right) => (right.p90_hours ?? -1) - (left.p90_hours ?? -1),
  );
}

function groupedMetrics(
  details: OrderMetricDetail[],
  key: (detail: OrderMetricDetail) => string,
  orderDatasetPresent: boolean,
): MetricGroup[] {
  const groups = new Map<string, OrderMetricDetail[]>();
  details.forEach((detail) => {
    const groupKey = key(detail) || "未知";
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), detail]);
  });
  return [...groups.entries()].map(([groupKey, items]) => ({
    key: groupKey,
    label: groupKey,
    metrics: metricsFor(items, orderDatasetPresent),
    order_count: items.length,
    warnings: items.length < 5 ? ["样本少于 5，分组结果仅用于核查。"] : [],
  }));
}

export const browserLocalAnalyticsService = {
  async overview(
    selection: DatasetSelection,
    filters: DashboardFilters,
    view: DashboardViewOptions,
  ): Promise<DashboardOverview> {
    const data = await load(selection);
    const filtered = filterDetails(data.details, filters);
    const metrics = metricsFor(filtered, data.orderDatasetPresent);
    const dates = filtered
      .map((item) => analysisDate(item)?.slice(0, 10))
      .filter((value): value is string => Boolean(value))
      .sort();
    const dimensionKey = (detail: OrderMetricDetail) => detail[view.dimension];
    const breakdown = groupedMetrics(
      filtered,
      dimensionKey,
      data.orderDatasetPresent,
    );
    const sortMetric = (group: MetricGroup) =>
      view.breakdownSortBy === "order_count"
        ? group.order_count
        : (group.metrics.find((item) => item.code === view.breakdownSortBy)
            ?.value ?? -1);
    breakdown.sort((left, right) => {
      const delta = sortMetric(left) - sortMetric(right);
      return view.breakdownSortDirection === "asc" ? delta : -delta;
    });
    const durations = durationValues(filtered, data.orderDatasetPresent);
    const mean = average(durations);
    const median = quantile(durations, 0.5);
    const p90 = quantile(durations, 0.9);
    const trend = groupedMetrics(
      filtered,
      (detail) => analysisDate(detail)?.slice(0, 10) ?? "日期未知",
      data.orderDatasetPresent,
    );
    const coverageMetric = metrics.find(
      (item) => item.code === "data_coverage_rate",
    );
    const warnings: DataWarning[] = data.orderDatasetPresent
      ? []
      : [
          {
            code: "ORDER_DATA_REQUIRED",
            message:
              "当前只有事件表：首末轨迹时效、节点耗时、状态与异常可以分析；OT、IF、OTIF 仍保持不可计算。",
          },
        ];
    return {
      context: {
        dataset_label: `浏览器本地数据：${data.sourceFiles.join(" + ") || "已导入文件"}`,
        datasets: selection,
        time_range_start: dates[0] ?? null,
        time_range_end: dates.at(-1) ?? null,
        order_count: filtered.length,
        valid_order_count: filtered.length,
        unfiltered_order_count: data.details.length,
        data_coverage: coverageMetric?.value ?? null,
        last_analyzed_at: new Date().toISOString(),
        warning_count: data.qualityWarningCount + warnings.length,
      },
      active_filters: filters,
      filter_options: {
        minimum_date: dates[0] ?? null,
        maximum_date: dates.at(-1) ?? null,
        warehouses: options(data.details.map((item) => item.warehouse_id)),
        carriers: options(data.details.map((item) => item.carrier_id)),
        regions: options(data.details.map((item) => item.destination_region)),
        statuses: options(data.details.map((item) => item.order_status)),
        anomaly_types: options(
          data.details.flatMap((item) => item.anomaly_reasons),
        ),
      },
      metrics,
      trend: {
        datasets: selection,
        grain: view.grain,
        timezone: filters.timezone,
        groups: trend,
        definition_version: BROWSER_METRICS_VERSION,
      },
      distribution: {
        datasets: selection,
        metric_code: data.orderDatasetPresent
          ? "fulfillment_duration_hours"
          : "tracking_span_hours",
        unit: "hour",
        sample_size: durations.length,
        minimum: durations.length ? Math.min(...durations) : null,
        maximum: durations.length ? Math.max(...durations) : null,
        mean,
        median,
        p90,
        quantile_method: "Hyndman-Fan Type 7 / linear",
        bins: [],
        warnings: durations.length
          ? []
          : [
              data.orderDatasetPresent
                ? "当前数据不足以计算订单履约时长分布。"
                : "当前数据不足以计算首末轨迹时效分布。",
            ],
        definition_version: BROWSER_METRICS_VERSION,
      },
      distribution_coverage: coverageMetric?.value ?? null,
      nodes: nodeSummaries(filtered),
      breakdown: {
        dimension: view.dimension,
        sort_by: view.breakdownSortBy,
        sort_direction: view.breakdownSortDirection,
        groups: breakdown,
      },
      warnings,
      warnings_truncated: false,
      definition_version: BROWSER_METRICS_VERSION,
      rule_set_version: BROWSER_RULE_VERSION,
    };
  },

  async orders(
    selection: DatasetSelection,
    filters: DashboardFilters,
    optionsValue: DashboardOrderOptions,
  ): Promise<DashboardOrderPage> {
    const data = await load(selection);
    const filtered = filterDetails(data.details, filters);
    const direction = optionsValue.sortDirection === "asc" ? 1 : -1;
    filtered.sort((left, right) => {
      const leftValue =
        optionsValue.sortBy === "anomaly"
          ? Number(left.anomaly)
          : optionsValue.sortBy === "otif"
            ? left.otif.status
            : left[optionsValue.sortBy];
      const rightValue =
        optionsValue.sortBy === "anomaly"
          ? Number(right.anomaly)
          : optionsValue.sortBy === "otif"
            ? right.otif.status
            : right[optionsValue.sortBy];
      return (
        String(leftValue ?? "").localeCompare(
          String(rightValue ?? ""),
          "zh-CN",
          { numeric: true },
        ) * direction
      );
    });
    const start = (optionsValue.page - 1) * optionsValue.pageSize;
    return {
      datasets: selection,
      active_filters: filters,
      items: filtered
        .slice(start, start + optionsValue.pageSize)
        .map((item) => ({
          ...item,
          anomaly_types: item.anomaly_reasons,
        })),
      total: filtered.length,
      page: optionsValue.page,
      page_size: optionsValue.pageSize,
      page_count: Math.ceil(filtered.length / optionsValue.pageSize),
      sort_by: optionsValue.sortBy,
      sort_direction: optionsValue.sortDirection,
      definition_version: BROWSER_METRICS_VERSION,
    };
  },

  async orderDetail(
    selection: DatasetSelection,
    orderId: string,
  ): Promise<OrderMetricDetail> {
    const data = await load(selection);
    const detail = data.details.find((item) => item.order_id === orderId);
    if (!detail) throw new Error("当前浏览器本地数据中找不到该订单。 ");
    return detail;
  },

  async ordersCsv(
    selection: DatasetSelection,
    filters: DashboardFilters,
    optionsValue: Pick<DashboardOrderOptions, "sortBy" | "sortDirection">,
  ): Promise<string> {
    const page = await browserLocalAnalyticsService.orders(selection, filters, {
      ...optionsValue,
      page: 1,
      pageSize: Number.MAX_SAFE_INTEGER,
    });
    const headers = [
      "order_id",
      "order_status",
      "created_at",
      "promised_delivery_time",
      "actual_delivery_time",
      "carrier_id",
      "warehouse_id",
      "destination_region",
      "ot_status",
      "if_status",
      "otif_status",
      "fulfillment_duration_hours",
      "anomaly",
      "anomaly_types",
    ];
    const safeCell = (value: unknown): string => {
      let textValue = text(value);
      if (/^[=+\-@]/.test(textValue)) textValue = `'${textValue}`;
      return `"${textValue.replaceAll('"', '""')}"`;
    };
    const rows = page.items.map((item) =>
      [
        item.order_id,
        item.order_status,
        item.created_at,
        item.promised_delivery_time,
        item.actual_delivery_time,
        item.carrier_id,
        item.warehouse_id,
        item.destination_region,
        item.ot.status,
        item.in_full.status,
        item.otif.status,
        item.fulfillment_duration_hours,
        item.anomaly,
        item.anomaly_types.join("|"),
      ]
        .map(safeCell)
        .join(","),
    );
    return `\uFEFF${[headers.map(safeCell).join(","), ...rows].join("\r\n")}\r\n`;
  },

  load,
};
