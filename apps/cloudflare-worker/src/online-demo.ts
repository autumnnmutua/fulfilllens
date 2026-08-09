const DEFINITION_VERSION = "online-demo-metrics-v1";
const RULE_SET_VERSION = "online-demo-rules-v1";
const ONLINE_DEMO_LABEL = "Cloudflare 在线合成履约演示";

export const ONLINE_DEMO_DATASETS = {
  orders: "online-demo-promotion-orders-v1",
  warehouseEvents: "online-demo-promotion-warehouse-events-v1",
  trackingEvents: "online-demo-promotion-tracking-events-v1",
} as const;

export interface OnlineDemoApiHelpers {
  json(payload: unknown, status?: number): Response;
  error(code: string, message: string, status: number): Response;
}

interface DatasetSelection {
  orders_dataset_id: string;
  warehouse_events_dataset_id: string | null;
  tracking_events_dataset_id: string | null;
}

interface NodeDuration {
  interval_code: string;
  display_name: string;
  duration_hours: number;
  start_time: string;
  end_time: string;
  shipment_id: string | null;
  location_code: string | null;
}

interface DemoOrder {
  order_id: string;
  created_at: string;
  promised_delivery_time: string;
  actual_delivery_time: string | null;
  ordered_quantity: number;
  delivered_quantity: number;
  quantity_unit: string;
  warehouse_id: string;
  carrier_id: string;
  destination_region: string;
  sales_channel: string;
  order_status: string;
  fulfillment_duration_hours: number | null;
  on_time: boolean | null;
  in_full: boolean;
  anomaly_reasons: string[];
  node_durations: NodeDuration[];
}

type CaseVariant = "normal" | "promotion" | "carrier";

interface ScenarioParameters {
  warehouse_improvements: Array<{
    node_code: string;
    method: string;
    value: number;
    warehouse_ids: string[];
  }>;
  pickup_improvement: {
    reduction_hours: number;
    carrier_ids: string[];
  } | null;
  carrier_mix: {
    method: string;
    weights: Record<string, number>;
    random_seed: number;
  } | null;
  promise_strategy: { extension_hours: number } | null;
}

interface StoredScenario {
  scenario_id: string;
  name: string;
  datasets: DatasetSelection;
  timezone: string;
  parameters: ScenarioParameters;
  created_at: string;
  updated_at: string;
}

interface ReportJobRecord {
  job_id: string;
  format: string;
  csv_kind: string | null;
  created_at: string;
  updated_at: string;
  content: string;
  media_type: string;
  file_name: string;
}

interface ScenarioAdjustment {
  transform_type:
    | "warehouse_improvement"
    | "pickup_improvement"
    | "carrier_mix_resample"
    | "promise_strategy";
  order_id: string;
  source_order_id: string;
  field_name: string;
  node_code: string | null;
  before_value: string | number | null;
  after_value: string | number | null;
  delta_hours: number | null;
  explanation: string;
}

const scenarioStore = new Map<string, StoredScenario>();
const reportJobStore = new Map<string, ReportJobRecord>();
const nodeDefinitions = [
  ["order_to_pick", "接单等待", 0.16],
  ["picking", "拣货", 0.24],
  ["pick_to_qc", "拣货至质检", 0.12],
  ["quality_check", "质检", 0.18],
  ["packing", "打包出库", 0.3],
] as const;
const warehouseValues = ["WH-SH", "WH-HZ", "WH-GZ"] as const;
const carrierValues = ["Carrier-A", "Carrier-B", "Carrier-C"] as const;
const regionValues = ["华东", "华南", "华北", "华中"] as const;
const appStart = Date.UTC(2026, 5, 1, 0, 0, 0);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function now(): string {
  return new Date().toISOString();
}

function isoAt(dayOffset: number, hourOffset: number): string {
  return new Date(
    appStart + (dayOffset * 24 + hourOffset) * 3_600_000,
  ).toISOString();
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 1) return sorted[0] ?? null;
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, quantile));
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex] ?? 0;
  const upper = sorted[upperIndex] ?? lower;
  return lower + (upper - lower) * (position - lowerIndex);
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function datasetSelection(url: URL, value?: unknown): DatasetSelection {
  const payload = asRecord(value);
  const nested = asRecord(payload?.datasets);
  const orders =
    stringValue(nested?.orders_dataset_id) ||
    url.searchParams.get("orders_dataset_id") ||
    ONLINE_DEMO_DATASETS.orders;
  const warehouse =
    stringValue(nested?.warehouse_events_dataset_id) ||
    url.searchParams.get("warehouse_events_dataset_id") ||
    ONLINE_DEMO_DATASETS.warehouseEvents;
  const tracking =
    stringValue(nested?.tracking_events_dataset_id) ||
    url.searchParams.get("tracking_events_dataset_id") ||
    ONLINE_DEMO_DATASETS.trackingEvents;
  return {
    orders_dataset_id: orders,
    warehouse_events_dataset_id: warehouse || null,
    tracking_events_dataset_id: tracking || null,
  };
}

function variantFor(selection: DatasetSelection): CaseVariant {
  const identifier = selection.orders_dataset_id.toLowerCase();
  if (identifier.includes("carrier")) return "carrier";
  if (identifier.includes("normal")) return "normal";
  return "promotion";
}

function buildNodeDurations(
  orderIndex: number,
  totalHours: number,
  createdAt: string,
): NodeDuration[] {
  const rawDurations = nodeDefinitions.map(
    ([, , share], index) =>
      totalHours * share * (0.94 + ((orderIndex + index * 3) % 5) * 0.03),
  );
  const rawTotal = rawDurations.reduce((total, value) => total + value, 0);
  let elapsed = 0;
  return nodeDefinitions.map(([code, label], index) => {
    const duration =
      index === nodeDefinitions.length - 1
        ? round(Math.max(0, totalHours - elapsed), 2)
        : round(((rawDurations[index] ?? 0) / rawTotal) * totalHours, 2);
    const start = shiftIso(createdAt, elapsed);
    elapsed += duration;
    return {
      interval_code: code,
      display_name: label,
      duration_hours: duration,
      start_time: start,
      end_time: shiftIso(createdAt, elapsed),
      shipment_id: `SHP-${String(orderIndex + 1).padStart(4, "0")}`,
      location_code: index < 5 ? "WH" : "TRANSIT",
    };
  });
}

function buildOrders(variant: CaseVariant): DemoOrder[] {
  const total = variant === "promotion" ? 96 : 72;
  const orders: DemoOrder[] = [];
  for (let index = 0; index < total; index += 1) {
    const day = index % 12;
    const warehouse =
      warehouseValues[index % warehouseValues.length] ?? "WH-SH";
    const carrier =
      carrierValues[(index + Math.floor(index / 8)) % carrierValues.length] ??
      "Carrier-A";
    const region =
      regionValues[(index * 3 + 1) % regionValues.length] ?? "华东";
    const promotionPenalty =
      variant === "promotion" && (day === 2 || day === 3 || day === 4) ? 22 : 0;
    const warehousePenalty =
      variant === "promotion" && warehouse === "WH-HZ" && day >= 2 && day <= 4
        ? 15
        : 0;
    const carrierPenalty =
      variant === "carrier" && carrier === "Carrier-C" ? 26 : 0;
    const longTailPenalty = index % 19 === 0 ? 22 : 0;
    const estimatedHours =
      42 +
      ((index * 11) % 21) +
      promotionPenalty +
      warehousePenalty +
      carrierPenalty +
      longTailPenalty;
    const pending = index % 23 === 0;
    const duration = pending
      ? null
      : round(estimatedHours + ((index % 5) - 2) * 0.6, 1);
    const promiseHours = variant === "normal" ? 76 : 70;
    const onTime = duration === null ? null : duration <= promiseHours;
    const inFull = index % 17 !== 0;
    const anomalyReasons: string[] = [];
    if (duration !== null && duration >= 82)
      anomalyReasons.push("fulfillment_long_tail");
    if (onTime === false) anomalyReasons.push("late_delivery");
    if (warehousePenalty > 0) anomalyReasons.push("warehouse_delay");
    if (carrierPenalty > 0) anomalyReasons.push("carrier_delay");
    const createdHour = 8 + ((index * 3) % 10);
    const created = isoAt(day, createdHour);
    orders.push({
      order_id: `${variant === "promotion" ? "PS" : variant === "carrier" ? "CD" : "NO"}-${String(index + 1).padStart(4, "0")}`,
      created_at: created,
      promised_delivery_time: isoAt(day, createdHour + promiseHours),
      actual_delivery_time:
        duration === null ? null : isoAt(day, createdHour + duration),
      ordered_quantity: 1 + (index % 4),
      delivered_quantity: inFull ? 1 + (index % 4) : Math.max(0, index % 4),
      quantity_unit: "件",
      warehouse_id: warehouse,
      carrier_id: carrier,
      destination_region: region,
      sales_channel: index % 2 === 0 ? "直营网店" : "平台店",
      order_status: pending ? "shipped" : "delivered",
      fulfillment_duration_hours: duration,
      on_time: onTime,
      in_full: inFull,
      anomaly_reasons: anomalyReasons,
      node_durations:
        duration === null ? [] : buildNodeDurations(index, duration, created),
    });
  }
  return orders;
}

function ordersFor(selection: DatasetSelection): DemoOrder[] {
  return buildOrders(variantFor(selection));
}

function decision(status: "true" | "false" | "pending", reason: string) {
  return {
    status,
    value: status === "pending" ? null : status === "true",
    reason,
  };
}

function orderDetail(order: DemoOrder) {
  const ot =
    order.on_time === null
      ? decision("pending", "订单尚未完成交付，暂不判断是否按时。")
      : decision(
          order.on_time ? "true" : "false",
          "按承诺送达时间与实际送达时间比较。 ",
        );
  const inFull = decision(
    order.in_full ? "true" : "false",
    "按已交付数量与订购数量比较。 ",
  );
  const otif =
    order.on_time === null
      ? decision("pending", "交付尚未完成，OTIF 等待实际送达时间。")
      : decision(
          order.on_time && order.in_full ? "true" : "false",
          "只有同时按时且足量交付才记为 OTIF。",
        );
  return {
    order_id: order.order_id,
    order_status: order.order_status,
    created_at: order.created_at,
    promised_delivery_time: order.promised_delivery_time,
    actual_delivery_time: order.actual_delivery_time,
    ordered_quantity: order.ordered_quantity,
    delivered_quantity: order.delivered_quantity,
    quantity_unit: order.quantity_unit,
    warehouse_id: order.warehouse_id,
    carrier_id: order.carrier_id,
    destination_region: order.destination_region,
    sales_channel: order.sales_channel,
    ot,
    in_full: inFull,
    otif,
    fulfillment_duration_hours: order.fulfillment_duration_hours,
    anomaly: order.anomaly_reasons.length > 0,
    anomaly_reasons: order.anomaly_reasons,
    node_durations: order.node_durations,
    warnings:
      order.actual_delivery_time === null
        ? [
            {
              code: "DELIVERY_PENDING",
              message: "该订单尚未完成交付，时效指标不会计入已完成订单分母。",
              order_id: order.order_id,
            },
          ]
        : [],
    definition_version: DEFINITION_VERSION,
    rule_set_version: RULE_SET_VERSION,
  };
}

function metricResult(
  code: string,
  displayName: string,
  unit: "order" | "ratio" | "hour",
  values: Array<boolean | null> | number[],
  orderCount: number,
) {
  if (unit === "ratio") {
    const decisions = values as Array<boolean | null>;
    const computable = decisions.filter(
      (value): value is boolean => value !== null,
    );
    const numerator = computable.filter(Boolean).length;
    const denominator = computable.length;
    const pending = decisions.filter((value) => value === null).length;
    return {
      code,
      display_name: displayName,
      value: denominator === 0 ? null : round(numerator / denominator, 4),
      unit,
      numerator,
      denominator,
      coverage: orderCount === 0 ? null : round(denominator / orderCount, 4),
      eligible_count: orderCount,
      computable_count: denominator,
      pending_count: pending,
      not_computable_count: 0,
      definition_version: DEFINITION_VERSION,
      warnings:
        pending > 0 ? ["存在尚未完成交付的订单，已从时效类分母排除。"] : [],
    };
  }
  const numeric = values as number[];
  const value = code.includes("median")
    ? percentile(numeric, 0.5)
    : code.includes("p90")
      ? percentile(numeric, 0.9)
      : mean(numeric);
  return {
    code,
    display_name: displayName,
    value: value === null ? null : round(value, 2),
    unit,
    numerator: null,
    denominator: null,
    coverage: orderCount === 0 ? null : round(numeric.length / orderCount, 4),
    eligible_count: orderCount,
    computable_count: numeric.length,
    pending_count: Math.max(0, orderCount - numeric.length),
    not_computable_count: 0,
    definition_version: DEFINITION_VERSION,
    warnings:
      numeric.length === 0 ? ["当前筛选条件下没有可计算的已完成订单。"] : [],
  };
}

function metricsFor(orders: DemoOrder[]) {
  const durations = orders
    .map((order) => order.fulfillment_duration_hours)
    .filter((value): value is number => value !== null);
  const otif = orders.map((order) =>
    order.on_time === null ? null : order.on_time && order.in_full,
  );
  return [
    metricResult(
      "ot_rate",
      "按时交付率",
      "ratio",
      orders.map((order) => order.on_time),
      orders.length,
    ),
    metricResult(
      "if_rate",
      "足量交付率",
      "ratio",
      orders.map((order) => order.in_full),
      orders.length,
    ),
    metricResult("otif_rate", "OTIF", "ratio", otif, orders.length),
    metricResult(
      "fulfillment_duration_mean_hours",
      "平均履约时长",
      "hour",
      durations,
      orders.length,
    ),
    metricResult(
      "fulfillment_duration_median_hours",
      "履约时长 P50",
      "hour",
      durations,
      orders.length,
    ),
    metricResult(
      "fulfillment_duration_p90_hours",
      "履约时长 P90",
      "hour",
      durations,
      orders.length,
    ),
    metricResult(
      "anomaly_order_rate",
      "异常订单率",
      "ratio",
      orders.map((order) => order.anomaly_reasons.length > 0),
      orders.length,
    ),
  ];
}

function metricByCode(
  metrics: Array<Record<string, unknown>>,
  code: string,
): number | null {
  const found = metrics.find((metric) => metric.code === code);
  return found && typeof found.value === "number" ? found.value : null;
}

function dashboardFilters(url: URL) {
  return {
    start_date: url.searchParams.get("start_date"),
    end_date: url.searchParams.get("end_date"),
    warehouses: url.searchParams.getAll("warehouse"),
    carriers: url.searchParams.getAll("carrier"),
    regions: url.searchParams.getAll("region"),
    statuses: url.searchParams.getAll("status"),
    anomaly_types: url.searchParams.getAll("anomaly_type"),
    timezone: url.searchParams.get("timezone") || "Asia/Shanghai",
  };
}

function includesOrEmpty(values: string[], candidate: string): boolean {
  return values.length === 0 || values.includes(candidate);
}

function filteredOrders(url: URL, orders: DemoOrder[]): DemoOrder[] {
  const filters = dashboardFilters(url);
  return orders.filter((order) => {
    const date = order.created_at.slice(0, 10);
    return (
      (!filters.start_date || date >= filters.start_date) &&
      (!filters.end_date || date <= filters.end_date) &&
      includesOrEmpty(filters.warehouses, order.warehouse_id) &&
      includesOrEmpty(filters.carriers, order.carrier_id) &&
      includesOrEmpty(filters.regions, order.destination_region) &&
      includesOrEmpty(filters.statuses, order.order_status) &&
      (filters.anomaly_types.length === 0 ||
        order.anomaly_reasons.some((reason) =>
          filters.anomaly_types.includes(reason),
        ))
    );
  });
}

function filterOptions(orders: DemoOrder[]) {
  const optionList = (values: string[]) =>
    Array.from(new Set(values))
      .sort()
      .map((value) => ({
        value,
        label: value,
        count: values.filter((candidate) => candidate === value).length,
      }));
  const dates = orders.map((order) => order.created_at.slice(0, 10)).sort();
  return {
    minimum_date: dates[0] ?? null,
    maximum_date: dates.at(-1) ?? null,
    warehouses: optionList(orders.map((order) => order.warehouse_id)),
    carriers: optionList(orders.map((order) => order.carrier_id)),
    regions: optionList(orders.map((order) => order.destination_region)),
    statuses: optionList(orders.map((order) => order.order_status)),
    anomaly_types: optionList(orders.flatMap((order) => order.anomaly_reasons)),
  };
}

function groupOrders(
  orders: DemoOrder[],
  keyFor: (order: DemoOrder) => string,
) {
  const groups = new Map<string, DemoOrder[]>();
  for (const order of orders) {
    const key = keyFor(order);
    const bucket = groups.get(key) ?? [];
    bucket.push(order);
    groups.set(key, bucket);
  }
  return Array.from(groups.entries()).map(([key, grouped]) => ({
    key,
    label: key,
    metrics: metricsFor(grouped),
    order_count: grouped.length,
    warnings: [],
  }));
}

function trendResponse(
  selection: DatasetSelection,
  orders: DemoOrder[],
  grain: string,
  timezone: string,
) {
  const keyFor = (order: DemoOrder) => {
    const date = order.created_at.slice(0, 10);
    if (grain !== "week") return date;
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const start = new Date(`${date}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - ((weekday + 6) % 7));
    return start.toISOString().slice(0, 10);
  };
  return {
    datasets: selection,
    grain: grain === "week" ? "week" : "date",
    timezone,
    groups: groupOrders(orders, keyFor).sort((left, right) =>
      left.key.localeCompare(right.key),
    ),
    definition_version: DEFINITION_VERSION,
  };
}

function breakdownResponse(
  selection: DatasetSelection,
  orders: DemoOrder[],
  dimension: string,
) {
  const normalizedDimension =
    dimension === "warehouse_id" ||
    dimension === "destination_region" ||
    dimension === "sales_channel"
      ? dimension
      : "carrier_id";
  return {
    datasets: selection,
    dimension: normalizedDimension,
    groups: groupOrders(orders, (order) =>
      normalizedDimension === "warehouse_id"
        ? order.warehouse_id
        : normalizedDimension === "destination_region"
          ? order.destination_region
          : normalizedDimension === "sales_channel"
            ? order.sales_channel
            : order.carrier_id,
    ),
    definition_version: DEFINITION_VERSION,
  };
}

function distributionResponse(
  selection: DatasetSelection,
  orders: DemoOrder[],
  metricCode: string,
  binCount: number,
) {
  const values = orders
    .map((order) => order.fulfillment_duration_hours)
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);
  const minimum = values[0] ?? null;
  const maximum = values.at(-1) ?? null;
  const bins = [] as Array<{
    lower_bound: number;
    upper_bound: number;
    count: number;
    includes_upper_bound: boolean;
  }>;
  if (minimum !== null && maximum !== null) {
    const width = Math.max(1, (maximum - minimum) / Math.max(1, binCount));
    for (let index = 0; index < binCount; index += 1) {
      const lower = minimum + width * index;
      const upper =
        index === binCount - 1 ? maximum : minimum + width * (index + 1);
      bins.push({
        lower_bound: round(lower, 2),
        upper_bound: round(upper, 2),
        count: values.filter((value) =>
          index === binCount - 1
            ? value >= lower && value <= upper
            : value >= lower && value < upper,
        ).length,
        includes_upper_bound: index === binCount - 1,
      });
    }
  }
  return {
    datasets: selection,
    metric_code: metricCode || "fulfillment_duration_hours",
    unit: "hour",
    sample_size: values.length,
    minimum,
    maximum,
    mean: mean(values),
    median: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    quantile_method: "nearest-rank",
    bins,
    warnings: values.length === 0 ? ["当前筛选条件没有可计算的履约时长。"] : [],
    definition_version: DEFINITION_VERSION,
  };
}

function nodeSummary(orders: DemoOrder[]) {
  return nodeDefinitions.map(([code, label]) => {
    const values = orders
      .flatMap((order) => order.node_durations)
      .filter((node) => node.interval_code === code)
      .map((node) => node.duration_hours);
    const p90 = percentile(values, 0.9);
    return {
      interval_code: code,
      display_name: label,
      mean_hours: mean(values),
      median_hours: percentile(values, 0.5),
      p90_hours: p90,
      sample_size: values.length,
      eligible_count: orders.length,
      coverage:
        orders.length === 0 ? null : round(values.length / orders.length, 4),
      is_bottleneck: p90 !== null && p90 >= 18,
      warnings: [],
    };
  });
}

function dashboardOverview(
  url: URL,
  selection: DatasetSelection,
  unfiltered: DemoOrder[],
  orders: DemoOrder[],
) {
  const filters = dashboardFilters(url);
  const grain = url.searchParams.get("grain") || "date";
  const dimension = url.searchParams.get("dimension") || "carrier_id";
  const sortBy =
    url.searchParams.get("breakdown_sort_by") || "anomaly_order_rate";
  const sortDirection =
    url.searchParams.get("breakdown_sort_direction") || "desc";
  const breakdown = breakdownResponse(selection, orders, dimension);
  const sortedBreakdown = [...breakdown.groups].sort((left, right) => {
    const leftValue =
      sortBy === "order_count"
        ? left.order_count
        : (metricByCode(left.metrics, sortBy) ?? -1);
    const rightValue =
      sortBy === "order_count"
        ? right.order_count
        : (metricByCode(right.metrics, sortBy) ?? -1);
    return sortDirection === "asc"
      ? leftValue - rightValue
      : rightValue - leftValue;
  });
  const durations = orders
    .map((order) => order.fulfillment_duration_hours)
    .filter((value): value is number => value !== null);
  return {
    context: {
      dataset_label: ONLINE_DEMO_LABEL,
      datasets: selection,
      time_range_start:
        orders.map((order) => order.created_at.slice(0, 10)).sort()[0] ?? null,
      time_range_end:
        orders
          .map((order) => order.created_at.slice(0, 10))
          .sort()
          .at(-1) ?? null,
      order_count: orders.length,
      valid_order_count: orders.length,
      unfiltered_order_count: unfiltered.length,
      data_coverage:
        unfiltered.length === 0
          ? null
          : round(orders.length / unfiltered.length, 4),
      last_analyzed_at: now(),
      warning_count: 0,
    },
    active_filters: filters,
    filter_options: filterOptions(unfiltered),
    metrics: metricsFor(orders),
    trend: trendResponse(selection, orders, grain, filters.timezone),
    distribution: distributionResponse(
      selection,
      orders,
      "fulfillment_duration_hours",
      8,
    ),
    distribution_coverage:
      orders.length === 0 ? null : round(durations.length / orders.length, 4),
    nodes: nodeSummary(orders),
    breakdown: {
      dimension: breakdown.dimension,
      sort_by: sortBy,
      sort_direction: sortDirection,
      groups: sortedBreakdown,
    },
    warnings: [],
    warnings_truncated: false,
    definition_version: DEFINITION_VERSION,
    rule_set_version: RULE_SET_VERSION,
  };
}

function sortOrders(
  orders: DemoOrder[],
  sortBy: string,
  direction: string,
): DemoOrder[] {
  return [...orders].sort((left, right) => {
    const leftDetail = orderDetail(left);
    const rightDetail = orderDetail(right);
    const valueFor = (order: typeof leftDetail) => {
      if (sortBy === "otif")
        return order.otif.value === true
          ? 1
          : order.otif.value === false
            ? 0
            : -1;
      if (sortBy === "anomaly") return order.anomaly ? 1 : 0;
      const value = order[sortBy as keyof typeof order];
      return typeof value === "number" || typeof value === "string"
        ? value
        : "";
    };
    const leftValue = valueFor(leftDetail);
    const rightValue = valueFor(rightDetail);
    const comparison =
      typeof leftValue === "number" && typeof rightValue === "number"
        ? leftValue - rightValue
        : String(leftValue).localeCompare(String(rightValue));
    return direction === "asc" ? comparison : -comparison;
  });
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function ordersCsvText(orders: DemoOrder[]): string {
  const rows = [
    [
      "order_id",
      "created_at",
      "warehouse_id",
      "carrier_id",
      "order_status",
      "fulfillment_duration_hours",
      "anomaly_types",
    ],
    ...orders.map((order) => [
      order.order_id,
      order.created_at,
      order.warehouse_id,
      order.carrier_id,
      order.order_status,
      order.fulfillment_duration_hours,
      order.anomaly_reasons.join("|"),
    ]),
  ];
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function ordersCsv(orders: DemoOrder[]): Response {
  return new Response(ordersCsvText(orders), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition":
        'attachment; filename="fulfilllens-online-demo-orders.csv"',
      "Content-Type": "text/csv; charset=utf-8",
    },
  });
}

function caseMetadata(caseId: string) {
  const variant: CaseVariant =
    caseId === "carrier_disruption"
      ? "carrier"
      : caseId === "normal_operations"
        ? "normal"
        : "promotion";
  const orders = buildOrders(variant);
  const content = {
    normal: {
      display_name: "案例 A：稳定运营",
      business_background:
        "合成订单在常规履约能力下分布，用于理解基线指标与覆盖率。",
      injected_anomalies: ["少量随机长尾订单"],
    },
    promotion: {
      display_name: "案例 B：促销爆单",
      business_background:
        "合成订单在促销峰值期间集中涌入，仓内处理能力未同步扩充。",
      injected_anomalies: ["峰值日仓内节点耗时上升", "部分订单超出承诺时限"],
    },
    carrier: {
      display_name: "案例 C：承运商扰动",
      business_background: "合成订单展示单一承运商长尾时效上升的诊断场景。",
      injected_anomalies: [
        "Carrier-C 的运输时效显著拉长",
        "晚到订单集中在该承运商",
      ],
    },
  }[variant];
  return {
    case_id: caseId,
    display_name: content.display_name,
    business_background: content.business_background,
    generator_version: "online-demo-generator-v1",
    seed:
      variant === "normal"
        ? 20260801
        : variant === "promotion"
          ? 20260802
          : 20260803,
    timezone: "Asia/Shanghai",
    order_count: orders.length,
    date_range: { start: "2026-06-01", end: "2026-06-12" },
    row_counts: {
      orders: orders.length,
      warehouse_events: orders.length * 5,
      tracking_events: orders.length * 4,
    },
    injected_anomalies: content.injected_anomalies,
    expected_findings:
      variant === "normal"
        ? []
        : [
            {
              rule_id: variant === "carrier" ? "FL-CR-001" : "FL-WH-001",
              description:
                variant === "carrier" ? "承运商相对长尾" : "仓内处理延误",
              required: true,
            },
          ],
    expected_metric_ranges: {},
    learning_objectives: [
      "复算 OTIF、P50 和 P90",
      "从证据定位待核查订单",
      "理解情景估算不是预测",
    ],
    privacy_statement:
      "本在线版本只使用程序生成的合成履约数据，不接收或保存真实订单与个人信息。",
    content_fingerprint: `online-demo-${variant}-v1`,
    files: [
      {
        name: "orders.csv",
        media_type: "text/csv; charset=utf-8",
        size_bytes: orders.length * 180,
      },
      {
        name: "warehouse_events.csv",
        media_type: "text/csv; charset=utf-8",
        size_bytes: orders.length * 320,
      },
      {
        name: "tracking_events.csv",
        media_type: "text/csv; charset=utf-8",
        size_bytes: orders.length * 260,
      },
      {
        name: "metadata.json",
        media_type: "application/json; charset=utf-8",
        size_bytes: 1800,
      },
    ],
  };
}

function selectionForCase(caseId: string): DatasetSelection {
  const prefix =
    caseId === "carrier_disruption"
      ? "carrier"
      : caseId === "normal_operations"
        ? "normal"
        : "promotion";
  return {
    orders_dataset_id: `online-demo-${prefix}-orders-v1`,
    warehouse_events_dataset_id: `online-demo-${prefix}-warehouse-events-v1`,
    tracking_events_dataset_id: `online-demo-${prefix}-tracking-events-v1`,
  };
}

function diagnosticRules() {
  return [
    {
      rule_id: "FL-WH-001",
      rule_version: RULE_SET_VERSION,
      title: "仓内处理延误",
      category: "warehouse_delay",
      description: "识别履约时长长尾和仓内节点 P90 上升的订单。",
      severity: "high",
      priority: 10,
      enabled: true,
      parameters: {
        duration_threshold_hours: {
          display_name: "履约时长阈值",
          value: 82,
          minimum: 24,
          maximum: 168,
          unit: "hour",
        },
      },
    },
    {
      rule_id: "FL-CR-001",
      rule_version: RULE_SET_VERSION,
      title: "承运商相对长尾",
      category: "carrier_relative",
      description: "比较承运商的按时率与履约时长，识别异常集中。",
      severity: "high",
      priority: 8,
      enabled: true,
      parameters: {},
    },
    {
      rule_id: "FL-OT-001",
      rule_version: RULE_SET_VERSION,
      title: "承诺时限超期",
      category: "last_mile_backlog",
      description: "识别实际交付晚于承诺时间的订单。",
      severity: "medium",
      priority: 6,
      enabled: true,
      parameters: {},
    },
  ];
}

function findingsFor(orders: DemoOrder[]) {
  const findings: Array<Record<string, unknown>> = [];
  const longTail = orders.filter((order) =>
    order.anomaly_reasons.includes("fulfillment_long_tail"),
  );
  if (longTail.length > 0) {
    findings.push({
      rule_id: "FL-WH-001",
      rule_version: RULE_SET_VERSION,
      merged_rule_ids: [],
      title: "仓内处理延误",
      category: "warehouse_delay",
      severity: "high",
      factual_observation: `${longTail.length} 个订单的履约时长达到在线演示长尾阈值。`,
      rule_judgement: "命中履约时长长尾规则，需要结合仓内事件进一步核查。",
      possible_causes: [
        "促销峰值期间的作业能力不足",
        "部分仓库节点等待时间上升",
      ],
      evidence: longTail.slice(0, 5).map((order) => ({
        order_id: order.order_id,
        event_id: null,
        shipment_id: `SHP-${order.order_id}`,
        node_code: "packing",
        start_time: order.created_at,
        end_time: order.actual_delivery_time,
        observed_value: order.fulfillment_duration_hours,
        threshold_value: 82,
        baseline_value: 62,
        unit: "hour",
        dimension_type: "warehouse",
        dimension_value: order.warehouse_id,
        comparison: "超过在线演示长尾阈值",
      })),
      affected_order_count: longTail.length,
      affected_order_sample: longTail
        .slice(0, 8)
        .map((order) => order.order_id),
      coverage:
        orders.length === 0 ? null : round(longTail.length / orders.length, 4),
      confidence_warning: ["该结果是规则触发，不代表已确认的根因。"],
      recommended_checks: [
        "核对促销峰值日期的仓内排班和波次",
        "查看拣货、质检、打包节点的原始事件",
      ],
      sample_size: orders.length,
      dimension_type: "warehouse",
      dimension_value: "多仓",
      priority: 10,
    });
  }
  const carrierOrders = orders.filter((order) =>
    order.anomaly_reasons.includes("carrier_delay"),
  );
  if (carrierOrders.length > 0) {
    findings.push({
      rule_id: "FL-CR-001",
      rule_version: RULE_SET_VERSION,
      merged_rule_ids: [],
      title: "承运商相对长尾",
      category: "carrier_relative",
      severity: "high",
      factual_observation: `${carrierOrders.length} 个长尾订单集中在 Carrier-C。`,
      rule_judgement: "命中承运商相对长尾规则，需要结合揽收和干线轨迹核查。",
      possible_causes: ["承运商网络波动", "区域干线拥堵"],
      evidence: carrierOrders.slice(0, 5).map((order) => ({
        order_id: order.order_id,
        event_id: null,
        shipment_id: null,
        node_code: "linehaul",
        start_time: order.created_at,
        end_time: order.actual_delivery_time,
        observed_value: order.fulfillment_duration_hours,
        threshold_value: 82,
        baseline_value: 61,
        unit: "hour",
        dimension_type: "carrier",
        dimension_value: "Carrier-C",
        comparison: "高于其他承运商的演示基线",
      })),
      affected_order_count: carrierOrders.length,
      affected_order_sample: carrierOrders
        .slice(0, 8)
        .map((order) => order.order_id),
      coverage:
        orders.length === 0
          ? null
          : round(carrierOrders.length / orders.length, 4),
      confidence_warning: ["需要原始物流轨迹确认，不能仅由规则结果推断因果。"],
      recommended_checks: [
        "核对 Carrier-C 的揽收和中转节点",
        "与承运商服务告警交叉验证",
      ],
      sample_size: orders.length,
      dimension_type: "carrier",
      dimension_value: "Carrier-C",
      priority: 8,
    });
  }
  const late = orders.filter((order) => order.on_time === false);
  if (late.length > 0) {
    findings.push({
      rule_id: "FL-OT-001",
      rule_version: RULE_SET_VERSION,
      merged_rule_ids: [],
      title: "承诺时限超期",
      category: "last_mile_backlog",
      severity: "medium",
      factual_observation: `${late.length} 个已完成订单晚于承诺送达时间。`,
      rule_judgement: "命中晚到规则，需按照仓库、承运商和目的地区域拆分核查。",
      possible_causes: ["仓内等待", "运输长尾", "末端派送积压"],
      evidence: late.slice(0, 5).map((order) => ({
        order_id: order.order_id,
        event_id: null,
        shipment_id: null,
        node_code: null,
        start_time: order.promised_delivery_time,
        end_time: order.actual_delivery_time,
        observed_value: order.fulfillment_duration_hours,
        threshold_value: 70,
        baseline_value: null,
        unit: "hour",
        dimension_type: "date",
        dimension_value: order.created_at.slice(0, 10),
        comparison: "实际送达晚于承诺时间",
      })),
      affected_order_count: late.length,
      affected_order_sample: late.slice(0, 8).map((order) => order.order_id),
      coverage:
        orders.length === 0 ? null : round(late.length / orders.length, 4),
      confidence_warning: [],
      recommended_checks: ["核对承诺时限口径", "复核订单时间线与时区"],
      sample_size: orders.length,
      dimension_type: "date",
      dimension_value: null,
      priority: 6,
    });
  }
  return findings;
}

function diagnosticAnalysis(
  selection: DatasetSelection,
  orders: DemoOrder[],
  timezone: string,
) {
  const results = findingsFor(orders);
  const severityOrder = ["critical", "high", "medium", "low"];
  return {
    context: {
      datasets: selection,
      analyzed_at: now(),
      order_count: orders.length,
      valid_order_count: orders.length,
      affected_order_count: new Set(
        results.flatMap((result) => result.affected_order_sample as string[]),
      ).size,
      finding_count: results.length,
      enabled_rule_count: diagnosticRules().length,
      triggered_rule_count: results.length,
      data_coverage: orders.length === 0 ? null : 1,
      warning_count: 0,
      timezone,
    },
    results,
    severity_summary: severityOrder
      .map((severity) => ({
        severity,
        finding_count: results.filter((result) => result.severity === severity)
          .length,
        affected_order_count: results
          .filter((result) => result.severity === severity)
          .reduce(
            (total, result) => total + numberValue(result.affected_order_count),
            0,
          ),
      }))
      .filter((item) => item.finding_count > 0),
    pareto: results.map((result, index) => ({
      category: result.category,
      display_name: result.title,
      finding_count: 1,
      affected_order_count: result.affected_order_count,
      cumulative_share: round((index + 1) / Math.max(1, results.length), 4),
    })),
    bottleneck_nodes: nodeSummary(orders).map((node) => ({
      node_code: node.interval_code,
      display_name: node.display_name,
      mean_hours: node.mean_hours,
      p90_hours: node.p90_hours,
      threshold_hours: 18,
      sample_size: node.sample_size,
      affected_order_count: node.is_bottleneck ? orders.length : 0,
      coverage: node.coverage,
      is_bottleneck: node.is_bottleneck,
    })),
    process_variants: [
      {
        variant_id: "online-demo-standard-flow",
        sequence: nodeDefinitions.map(([code]) => code),
        order_count: orders.length,
        share: orders.length === 0 ? 0 : 1,
        affected_order_count: orders.filter(
          (order) => order.anomaly_reasons.length > 0,
        ).length,
      },
    ],
    dimension_insights: results.map((result) => ({
      dimension_type: result.dimension_type,
      dimension_value: result.dimension_value ?? "全部",
      finding_count: 1,
      affected_order_count: result.affected_order_count,
      highest_severity: result.severity,
      categories: [result.category],
    })),
    analysis_warnings: [
      "在线演示只使用合成数据；规则触发应作为核查起点，而非根因结论。",
    ],
    rule_set_version: RULE_SET_VERSION,
  };
}

function defaultParameters(): ScenarioParameters {
  return {
    warehouse_improvements: [],
    pickup_improvement: null,
    carrier_mix: null,
    promise_strategy: null,
  };
}

function scenarioParameterError(value: unknown): string | null {
  const payload = asRecord(value);
  if (payload === null) return "方案参数必须是对象。";
  if (payload.warehouse_improvements !== undefined) {
    if (!Array.isArray(payload.warehouse_improvements)) {
      return "仓内改善参数必须是数组。";
    }
    for (const raw of payload.warehouse_improvements) {
      const item = asRecord(raw);
      const method = stringValue(item?.method, "fixed_hours");
      const candidate = item?.value;
      const maximum = method === "percentage" ? 100 : 72;
      if (
        item === null ||
        !nodeDefinitions.some(([code]) => code === item.node_code) ||
        (method !== "fixed_hours" && method !== "percentage") ||
        typeof candidate !== "number" ||
        !Number.isFinite(candidate) ||
        candidate < 0 ||
        candidate > maximum
      ) {
        return "仓内节点、改善方法或数值范围无效。";
      }
    }
  }
  const pickup = asRecord(payload.pickup_improvement);
  if (
    payload.pickup_improvement !== undefined &&
    payload.pickup_improvement !== null
  ) {
    const candidate = pickup?.reduction_hours;
    if (
      pickup === null ||
      typeof candidate !== "number" ||
      !Number.isFinite(candidate) ||
      candidate < 0 ||
      candidate > 24
    ) {
      return "揽收等待改善必须在 0 到 24 小时之间。";
    }
  }
  const carrierMix = asRecord(payload.carrier_mix);
  if (payload.carrier_mix !== undefined && payload.carrier_mix !== null) {
    const weights = asRecord(carrierMix?.weights);
    const values = Object.values(weights ?? {});
    if (
      carrierMix === null ||
      values.length === 0 ||
      values.some(
        (candidate) =>
          typeof candidate !== "number" ||
          !Number.isFinite(candidate) ||
          candidate < 0 ||
          candidate > 100,
      ) ||
      Math.abs(
        values.reduce<number>(
          (total, candidate) =>
            total + (typeof candidate === "number" ? candidate : 0),
          0,
        ) - 100,
      ) > 1e-6
    ) {
      return "承运商权重必须在 0 到 100 之间且总和等于 100%。";
    }
  }
  const promise = asRecord(payload.promise_strategy);
  if (
    payload.promise_strategy !== undefined &&
    payload.promise_strategy !== null
  ) {
    const candidate = promise?.extension_hours;
    if (
      promise === null ||
      typeof candidate !== "number" ||
      !Number.isFinite(candidate) ||
      candidate < 0 ||
      candidate > 24
    ) {
      return "承诺时限调整必须在 0 到 24 小时之间。";
    }
  }
  return null;
}

function scenarioParameters(value: unknown): ScenarioParameters {
  const payload = asRecord(value);
  const improvements = Array.isArray(payload?.warehouse_improvements)
    ? payload.warehouse_improvements
        .map(asRecord)
        .filter((item): item is Record<string, unknown> => item !== null)
        .slice(0, 5)
        .map((item) => ({
          node_code: stringValue(item.node_code, "packing"),
          method: stringValue(item.method, "fixed_hours"),
          value: Math.max(0, Math.min(72, numberValue(item.value))),
          warehouse_ids: Array.isArray(item.warehouse_ids)
            ? item.warehouse_ids
                .filter(
                  (candidate): candidate is string =>
                    typeof candidate === "string",
                )
                .slice(0, 10)
            : [],
        }))
    : [];
  const pickup = asRecord(payload?.pickup_improvement);
  const carrierMix = asRecord(payload?.carrier_mix);
  const promise = asRecord(payload?.promise_strategy);
  const weights = Object.fromEntries(
    Object.entries(asRecord(carrierMix?.weights) ?? {})
      .filter(
        ([, candidate]) =>
          typeof candidate === "number" && Number.isFinite(candidate),
      )
      .slice(0, 10),
  ) as Record<string, number>;
  return {
    warehouse_improvements: improvements,
    pickup_improvement:
      pickup === null
        ? null
        : {
            reduction_hours: Math.max(
              0,
              Math.min(24, numberValue(pickup.reduction_hours)),
            ),
            carrier_ids: Array.isArray(pickup.carrier_ids)
              ? pickup.carrier_ids
                  .filter(
                    (candidate): candidate is string =>
                      typeof candidate === "string",
                  )
                  .slice(0, 10)
              : [],
          },
    carrier_mix:
      carrierMix === null
        ? null
        : {
            method: "empirical_resample",
            weights,
            random_seed: Math.trunc(
              numberValue(carrierMix.random_seed, 20260802),
            ),
          },
    promise_strategy:
      promise === null
        ? null
        : {
            extension_hours: Math.max(
              0,
              Math.min(24, numberValue(promise.extension_hours)),
            ),
          },
  };
}

function encodePublicState(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodePublicState(value: string): Record<string, unknown> | null {
  try {
    const padded = `${value.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return asRecord(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

function scenarioIdFor(scenario: Omit<StoredScenario, "scenario_id">): string {
  return `online-demo-scenario-${encodePublicState(scenario)}`;
}

function scenarioFromId(scenarioId: string): StoredScenario | null {
  const prefix = "online-demo-scenario-";
  if (!scenarioId.startsWith(prefix)) return null;
  try {
    const payload = decodePublicState(scenarioId.slice(prefix.length));
    if (payload === null) return null;
    return {
      scenario_id: scenarioId,
      name: stringValue(payload.name, "在线方案").slice(0, 80),
      datasets: datasetSelection(new URL("https://online-demo.invalid"), {
        datasets: payload.datasets,
      }),
      timezone: stringValue(payload.timezone, "Asia/Shanghai"),
      parameters: scenarioParameters(payload.parameters),
      created_at: stringValue(payload.created_at, now()),
      updated_at: stringValue(payload.updated_at, now()),
    };
  } catch {
    return null;
  }
}

function scenarioRecord(scenario: StoredScenario) {
  return {
    ...scenario,
    definition_version: "online-demo-simulation-v1",
  };
}

function baselineResponse(
  selection: DatasetSelection,
  orders: DemoOrder[],
  timezone: string,
) {
  const metrics = metricsFor(orders);
  const carrierDistribution = carrierValues.map((carrier) => {
    const count = orders.filter((order) => order.carrier_id === carrier).length;
    return {
      carrier_id: carrier,
      order_count: count,
      share: orders.length === 0 ? 0 : round(count / orders.length, 4),
    };
  });
  return {
    datasets: selection,
    timezone,
    input_fingerprint: `online-demo-${selection.orders_dataset_id}`,
    calculated_at: now(),
    metrics: metrics.map((metric) => ({
      code: metric.code,
      display_name: metric.display_name,
      value: metric.value,
      unit: metric.unit,
      numerator: metric.numerator,
      denominator: metric.denominator,
      coverage: metric.coverage,
      warnings: metric.warnings,
    })),
    carrier_distribution: carrierDistribution,
    order_count: orders.length,
    warnings: ["结果基于公开合成案例，不应用于真实经营决策。"],
    metrics_definition_version: DEFINITION_VERSION,
    definition_version: "online-demo-simulation-v1",
    estimate_label: "基于合成数据和简化假设的在线情景估算，不代表预测或保证。",
  };
}

function shiftIso(value: string, hours: number): string {
  return new Date(Date.parse(value) + hours * 3_600_000).toISOString();
}

function rebuildNodeTimeline(
  nodes: NodeDuration[],
  createdAt: string,
): NodeDuration[] {
  let cursor = Date.parse(createdAt);
  return nodes.map((node) => {
    const start = new Date(cursor).toISOString();
    cursor += node.duration_hours * 3_600_000;
    return {
      ...node,
      start_time: start,
      end_time: new Date(cursor).toISOString(),
    };
  });
}

function refreshedOrder(
  order: DemoOrder,
  duration: number | null,
  promisedDeliveryTime: string,
  nodeDurations: NodeDuration[],
  retainedReasons: string[],
): DemoOrder {
  const actualDeliveryTime =
    duration === null ? null : shiftIso(order.created_at, duration);
  const onTime =
    actualDeliveryTime === null
      ? null
      : Date.parse(actualDeliveryTime) <= Date.parse(promisedDeliveryTime);
  const reasons = retainedReasons.filter(
    (reason) =>
      reason !== "fulfillment_long_tail" && reason !== "late_delivery",
  );
  if (duration !== null && duration >= 82)
    reasons.push("fulfillment_long_tail");
  if (onTime === false) reasons.push("late_delivery");
  return {
    ...order,
    promised_delivery_time: promisedDeliveryTime,
    actual_delivery_time: actualDeliveryTime,
    fulfillment_duration_hours: duration,
    on_time: onTime,
    anomaly_reasons: Array.from(new Set(reasons)),
    node_durations: rebuildNodeTimeline(nodeDurations, order.created_at),
  };
}

function deterministicFraction(seed: number, index: number): number {
  return ((Math.imul(index + 1, 2_654_435_761) + seed) >>> 0) / 4_294_967_296;
}

function applyCarrierMix(
  orders: DemoOrder[],
  parameters: ScenarioParameters,
  adjustments: ScenarioAdjustment[],
): DemoOrder[] {
  const mix = parameters.carrier_mix;
  if (mix === null) return orders.map((order) => ({ ...order }));
  const entries = Object.entries(mix.weights).filter(
    ([carrier, weight]) =>
      weight > 0 && orders.some((order) => order.carrier_id === carrier),
  );
  const totalWeight = entries.reduce((total, [, weight]) => total + weight, 0);
  if (entries.length === 0 || totalWeight <= 0) {
    return orders.map((order) => ({ ...order }));
  }
  const buckets = new Map(
    entries.map(([carrier]) => [
      carrier,
      orders.filter((order) => order.carrier_id === carrier),
    ]),
  );
  return orders.map((order, index) => {
    const target = deterministicFraction(mix.random_seed, index) * totalWeight;
    let cumulative = 0;
    let targetCarrier = entries.at(-1)?.[0] ?? order.carrier_id;
    for (const [carrier, weight] of entries) {
      cumulative += weight;
      if (target <= cumulative) {
        targetCarrier = carrier;
        break;
      }
    }
    const bucket = buckets.get(targetCarrier) ?? [order];
    const profile =
      bucket[(index + Math.abs(mix.random_seed)) % bucket.length] ?? order;
    const duration = profile.fulfillment_duration_hours;
    const transformed = refreshedOrder(
      { ...order, carrier_id: targetCarrier, in_full: profile.in_full },
      duration,
      order.promised_delivery_time,
      profile.node_durations.map((node) => ({ ...node })),
      profile.anomaly_reasons.filter((reason) => reason !== "warehouse_delay"),
    );
    if (
      targetCarrier !== order.carrier_id ||
      duration !== order.fulfillment_duration_hours ||
      profile.in_full !== order.in_full
    ) {
      adjustments.push({
        transform_type: "carrier_mix_resample",
        order_id: order.order_id,
        source_order_id: profile.order_id,
        field_name: "carrier_id",
        node_code: null,
        before_value: order.carrier_id,
        after_value: targetCarrier,
        delta_hours:
          duration === null || order.fulfillment_duration_hours === null
            ? null
            : round(duration - order.fulfillment_duration_hours, 2),
        explanation:
          "按目标权重从该承运商的合成历史订单中确定性重采样履约表现。",
      });
    }
    return transformed;
  });
}

function applyScenarioToOrders(
  orders: DemoOrder[],
  parameters: ScenarioParameters,
): { orders: DemoOrder[]; adjustments: ScenarioAdjustment[] } {
  const adjustments: ScenarioAdjustment[] = [];
  const mixedOrders = applyCarrierMix(orders, parameters, adjustments);
  const transformed = mixedOrders.map((order) => {
    let duration = order.fulfillment_duration_hours;
    const nodes = order.node_durations.map((node) => ({ ...node }));
    let reasons = [...order.anomaly_reasons];
    for (const improvement of parameters.warehouse_improvements) {
      if (
        duration === null ||
        (improvement.warehouse_ids.length > 0 &&
          !improvement.warehouse_ids.includes(order.warehouse_id))
      ) {
        continue;
      }
      const node = nodes.find(
        (candidate) => candidate.interval_code === improvement.node_code,
      );
      if (!node) continue;
      const reduction = Math.min(
        node.duration_hours,
        improvement.method === "percentage"
          ? (node.duration_hours * improvement.value) / 100
          : improvement.value,
      );
      if (reduction <= 0) continue;
      const before = node.duration_hours;
      node.duration_hours = round(before - reduction, 2);
      duration = round(Math.max(0, duration - reduction), 2);
      reasons = reasons.filter((reason) => reason !== "warehouse_delay");
      adjustments.push({
        transform_type: "warehouse_improvement",
        order_id: order.order_id,
        source_order_id: order.order_id,
        field_name: "duration_hours",
        node_code: improvement.node_code,
        before_value: before,
        after_value: node.duration_hours,
        delta_hours: round(-reduction, 2),
        explanation:
          "先减少指定仓内节点耗时，再从订单和节点层重新计算全部指标。",
      });
    }
    const pickup = parameters.pickup_improvement;
    if (
      duration !== null &&
      pickup !== null &&
      pickup.reduction_hours > 0 &&
      (pickup.carrier_ids.length === 0 ||
        pickup.carrier_ids.includes(order.carrier_id))
    ) {
      const reduction = Math.min(duration, pickup.reduction_hours);
      const before = duration;
      duration = round(duration - reduction, 2);
      adjustments.push({
        transform_type: "pickup_improvement",
        order_id: order.order_id,
        source_order_id: order.order_id,
        field_name: "fulfillment_duration_hours",
        node_code: "pickup_wait",
        before_value: before,
        after_value: duration,
        delta_hours: round(-reduction, 2),
        explanation:
          "按简化假设减少出库至揽收等待，并把节省时间传导到后续事件副本。",
      });
    }
    const extension = parameters.promise_strategy?.extension_hours ?? 0;
    const promised = shiftIso(order.promised_delivery_time, extension);
    if (extension > 0) {
      adjustments.push({
        transform_type: "promise_strategy",
        order_id: order.order_id,
        source_order_id: order.order_id,
        field_name: "promised_delivery_time",
        node_code: null,
        before_value: order.promised_delivery_time,
        after_value: promised,
        delta_hours: extension,
        explanation: "只调整服务承诺时间；放宽承诺不代表真实运营改善。",
      });
    }
    return refreshedOrder(order, duration, promised, nodes, reasons);
  });
  return { orders: transformed, adjustments };
}

function scenarioFingerprint(
  selection: DatasetSelection,
  scenario: StoredScenario,
): string {
  const source = `${selection.orders_dataset_id}:${JSON.stringify(scenario.parameters)}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `online-demo-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function simulationRun(
  selection: DatasetSelection,
  orders: DemoOrder[],
  scenario: StoredScenario,
) {
  const baseline = metricsFor(orders);
  const transformed = applyScenarioToOrders(orders, scenario.parameters);
  const scenarioMetrics = metricsFor(transformed.orders);
  const comparisons = baseline.map((metric) => {
    const scenarioMetric = scenarioMetrics.find(
      (candidate) => candidate.code === metric.code,
    );
    const baselineValue = metric.value;
    const scenarioValue = scenarioMetric?.value ?? null;
    const absoluteChange =
      scenarioValue === null || baselineValue === null
        ? null
        : round(scenarioValue - baselineValue, 4);
    return {
      code: metric.code,
      display_name: metric.display_name,
      unit: metric.unit,
      baseline_value: baselineValue,
      scenario_value: scenarioValue,
      absolute_change: absoluteChange,
      relative_change:
        absoluteChange === null || baselineValue === null || baselineValue === 0
          ? null
          : round(absoluteChange / baselineValue, 4),
      baseline_numerator: metric.numerator,
      baseline_denominator: metric.denominator,
      scenario_numerator: scenarioMetric?.numerator ?? null,
      scenario_denominator: scenarioMetric?.denominator ?? null,
      baseline_coverage: metric.coverage,
      scenario_coverage: scenarioMetric?.coverage ?? null,
      warnings: scenarioMetric?.warnings ?? [],
    };
  });
  const affectedOrders = new Set(
    transformed.adjustments.map((item) => item.order_id),
  );
  const detailLimit = 200;
  return {
    scenario_id: scenario.scenario_id || null,
    scenario_name: scenario.name,
    datasets: selection,
    timezone: scenario.timezone,
    input_fingerprint: `online-demo-${selection.orders_dataset_id}`,
    scenario_fingerprint: scenarioFingerprint(selection, scenario),
    calculated_at: now(),
    parameters: scenario.parameters,
    comparisons,
    affected_order_count: affectedOrders.size,
    total_adjustments: transformed.adjustments.length,
    adjustments: transformed.adjustments.slice(0, detailLimit),
    adjustments_truncated: transformed.adjustments.length > detailLimit,
    adjusted_nodes: scenario.parameters.warehouse_improvements.map(
      (item) => item.node_code,
    ),
    skipped_counts: {},
    assumptions: [
      "所有参数先作用于合成订单或节点副本，再重新调用同一在线指标函数。",
      "揽收节省时间按简化假设完整传导到实际交付时间。",
      "承运商结构调整使用固定随机种子对各承运商合成历史订单重采样。",
    ],
    warnings: [
      "在线演示中的自建方案不会写入长期数据库；请在当前页面内继续使用，刷新页面后需重新创建。",
    ],
    random_seed: scenario.parameters.carrier_mix?.random_seed ?? null,
    reproducible: true,
    metrics_definition_version: DEFINITION_VERSION,
    definition_version: "online-demo-simulation-v1",
    assumptions_version: "online-demo-assumptions-v1",
    estimate_label: "基于合成数据和简化假设的在线情景估算，不代表预测或保证。",
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function reportContext(value: unknown) {
  const request = asRecord(value) ?? {};
  const selection = datasetSelection(
    new URL("https://online-demo.invalid"),
    request,
  );
  const inputFilters = asRecord(request.filters) ?? {};
  const filters = {
    start_date: stringValue(inputFilters.start_date) || null,
    end_date: stringValue(inputFilters.end_date) || null,
    warehouses: stringList(inputFilters.warehouses),
    carriers: stringList(inputFilters.carriers),
    regions: stringList(inputFilters.regions),
    statuses: stringList(inputFilters.statuses),
    anomaly_types: stringList(inputFilters.anomaly_types),
    timezone: stringValue(inputFilters.timezone, "Asia/Shanghai"),
  };
  const orders = ordersFor(selection).filter((order) => {
    const date = order.created_at.slice(0, 10);
    return (
      (!filters.start_date || date >= filters.start_date) &&
      (!filters.end_date || date <= filters.end_date) &&
      includesOrEmpty(filters.warehouses, order.warehouse_id) &&
      includesOrEmpty(filters.carriers, order.carrier_id) &&
      includesOrEmpty(filters.regions, order.destination_region) &&
      includesOrEmpty(filters.statuses, order.order_status) &&
      (filters.anomaly_types.length === 0 ||
        order.anomaly_reasons.some((reason) =>
          filters.anomaly_types.includes(reason),
        ))
    );
  });
  return { request, selection, filters, orders };
}

function reportDocument(value: unknown) {
  const { request, selection, filters, orders } = reportContext(value);
  const reportSections = Array.isArray(request.sections)
    ? request.sections.filter(
        (item): item is string => typeof item === "string",
      )
    : ["executive_summary", "metrics_overview", "diagnostics"];
  const metrics = metricsFor(orders);
  const diagnostics = findingsFor(orders);
  const sections = reportSections.map((code) => {
    const content =
      code === "metrics_overview"
        ? { metrics }
        : code === "diagnostics"
          ? { results: diagnostics }
          : code === "trend"
            ? {
                groups: trendResponse(
                  selection,
                  orders,
                  stringValue(request.trend_grain, "date"),
                  filters.timezone,
                ).groups,
              }
            : code === "node_duration"
              ? { nodes: nodeSummary(orders) }
              : code === "dimension_breakdown"
                ? {
                    groups: breakdownResponse(
                      selection,
                      orders,
                      stringValue(request.breakdown_dimension, "carrier_id"),
                    ).groups,
                  }
                : code === "order_samples"
                  ? {
                      orders: orders
                        .slice(
                          0,
                          Math.min(
                            100,
                            Math.max(
                              1,
                              numberValue(request.order_sample_limit, 12),
                            ),
                          ),
                        )
                        .map((order) => ({
                          ...orderDetail(order),
                          anomaly_types: order.anomaly_reasons,
                        })),
                    }
                  : code === "data_quality"
                    ? {
                        order_count: orders.length,
                        valid_order_count: orders.length,
                        data_coverage: 1,
                        warning_count: 0,
                        warnings: [],
                      }
                    : code === "methods_limits"
                      ? {
                          items: [
                            "在线版只处理公开合成数据。",
                            "规则触发并不等于已确认根因。",
                            "情景模拟不代表预测。",
                          ],
                        }
                      : {};
    return {
      code,
      title:
        {
          executive_summary: "执行摘要",
          metrics_overview: "指标总览",
          diagnostics: "透明诊断",
          trend: "时效趋势",
          node_duration: "节点耗时",
          dimension_breakdown: "维度对比",
          order_samples: "订单样本",
          data_quality: "数据质量",
          methods_limits: "方法与限制",
          simulation: "情景模拟",
        }[code] ?? code,
      narrative: [
        "本节内容由同源 Cloudflare Worker 使用公开合成履约数据计算。",
      ],
      data: content,
      warnings: [],
    };
  });
  const dates = orders.map((order) => order.created_at.slice(0, 10)).sort();
  return {
    header: {
      title: ONLINE_DEMO_LABEL,
      dataset_name: stringValue(request.dataset_name, ONLINE_DEMO_LABEL),
      time_range_start: dates[0] ?? filters.start_date,
      time_range_end: dates.at(-1) ?? filters.end_date,
      order_count: orders.length,
      valid_order_count: orders.length,
      data_coverage: 1,
      generated_at: now(),
      timezone: filters.timezone,
      metrics_definition_version: DEFINITION_VERSION,
      diagnostic_rule_version: RULE_SET_VERSION,
      simulation_version: "online-demo-simulation-v1",
      report_version: "online-demo-report-v1",
      renderer_version: "worker-renderer-v1",
      synthetic_data: true,
    },
    filters,
    executive_summary: [
      `已加载 ${orders.length} 条公开合成履约订单。`,
      "在线分析、诊断与报告均不接收或保存真实订单数据。",
    ],
    sections,
    warnings: ["此报告为在线合成演示，不能作为真实业务决策依据。"],
    source_notes: ["数据源：Worker 内置的确定性合成案例。"],
    chart_map: [],
    identifier_policy: "在线报告仅显示合成订单标识。",
    reading_mode: stringValue(request.reading_mode, "guided"),
    reading_guide: [
      {
        term: "OTIF",
        meaning: "同时按时且足量交付的订单比例。",
        direction: "通常越高越好。",
        caution: "应结合样本、覆盖率与承诺口径理解。",
        requires_context: true,
      },
    ],
    contract_version: "online-demo-report-v1",
  };
}

function reportContent(
  document: ReturnType<typeof reportDocument>,
  format: string,
  orders: DemoOrder[],
): string {
  if (format === "html") {
    return `<!doctype html><meta charset="utf-8"><title>${ONLINE_DEMO_LABEL}</title><pre>${JSON.stringify(document, null, 2).replace(/</g, "&lt;")}</pre>`;
  }
  if (format === "csv") {
    return ordersCsvText(orders);
  }
  return `# ${ONLINE_DEMO_LABEL}\n\n${document.executive_summary.join("\n\n")}`;
}

function createReportJobRecord(
  jobId: string,
  format: string,
  csvKind: string | null,
  createdAt: string,
  document: ReturnType<typeof reportDocument>,
  orders: DemoOrder[],
): ReportJobRecord {
  const extension =
    format === "html" ? "html" : format === "csv" ? "csv" : "md";
  return {
    job_id: jobId,
    format,
    csv_kind: csvKind,
    created_at: createdAt,
    updated_at: createdAt,
    content: reportContent(document, format, orders),
    media_type:
      format === "html"
        ? "text/html; charset=utf-8"
        : format === "csv"
          ? "text/csv; charset=utf-8"
          : "text/markdown; charset=utf-8",
    file_name: `fulfilllens-online-demo-report.${extension}`,
  };
}

function reportJobIdFor(
  format: string,
  csvKind: string | null,
  createdAt: string,
  report: unknown,
): string {
  return `online-demo-report-${encodePublicState({
    format,
    csv_kind: csvKind,
    created_at: createdAt,
    report,
  })}`;
}

function statelessReportJob(jobId: string): ReportJobRecord | null {
  const prefix = "online-demo-report-";
  if (!jobId.startsWith(prefix)) return null;
  const payload = decodePublicState(jobId.slice(prefix.length));
  const format = stringValue(payload?.format);
  if (payload === null || !["markdown", "html", "csv"].includes(format)) {
    return null;
  }
  const report = payload.report;
  const context = reportContext(report);
  return createReportJobRecord(
    jobId,
    format,
    typeof payload.csv_kind === "string" ? payload.csv_kind : null,
    stringValue(payload.created_at, now()),
    reportDocument(report),
    context.orders,
  );
}

function reportJob(record: ReportJobRecord, status = "completed") {
  return {
    job_id: record.job_id,
    status,
    progress: status === "completed" ? 100 : 0,
    message: status === "completed" ? "在线演示报告已生成。" : "导出已取消。",
    format: record.format,
    csv_kind: record.csv_kind,
    created_at: record.created_at,
    updated_at: record.updated_at,
    file_name: status === "completed" ? record.file_name : null,
    media_type: status === "completed" ? record.media_type : null,
    size_bytes:
      status === "completed"
        ? new TextEncoder().encode(record.content).byteLength
        : null,
    error_code: null,
    download_ready: status === "completed",
  };
}

function importDataType(taskId: string): string {
  if (taskId.includes("warehouse")) return "warehouse_events";
  if (taskId.includes("tracking")) return "tracking_events";
  return "orders";
}

function importTask(dataType: string, status = "ready_to_confirm") {
  return {
    task_id: `online-demo-${dataType}`,
    data_type: dataType,
    status,
    status_label:
      status === "analyzable"
        ? "可分析"
        : status === "cancelled"
          ? "已取消"
          : "可确认导入",
    file_name: `online-demo-${dataType}.csv`,
    file_format: "csv",
    encoding: "utf-8",
    encoding_required: false,
    encoding_options: [],
    sheets: [],
    selected_sheet: null,
    default_timezone: "Asia/Shanghai",
    message: "在线版使用公开合成示例；不会上传或保存真实文件。",
    can_reconfigure: false,
  };
}

function importParseResponse(dataType: string) {
  const orders = buildOrders("promotion").slice(0, 8);
  const sourceColumns = [
    "order_id",
    "created_at",
    "promised_delivery_time",
    "actual_delivery_time",
    "warehouse_id",
    "carrier_id",
    "order_status",
  ];
  return {
    task: importTask(dataType),
    fields: sourceColumns.map((field, index) => ({
      field,
      label: field,
      required: index < 4,
      value_type: index === 0 ? "string" : "datetime",
      aliases: [field],
    })),
    source_columns: sourceColumns,
    preview_rows: orders.map((order, index) => ({
      row_number: index + 2,
      values: {
        order_id: order.order_id,
        created_at: order.created_at,
        promised_delivery_time: order.promised_delivery_time,
        actual_delivery_time: order.actual_delivery_time,
        warehouse_id: order.warehouse_id,
        carrier_id: order.carrier_id,
        order_status: order.order_status,
      },
    })),
    total_rows: buildOrders("promotion").length,
    suggestions: sourceColumns.map((column) => ({
      source_column: column,
      suggested_field: column,
      confidence: 1,
      method: "online-demo-fixed-schema",
      candidates: [
        { field: column, label: column, confidence: 1, method: "exact" },
      ],
    })),
    sensitive_risks: [],
    warnings: [
      "在线版仅开放合成示例导入；真实订单请使用本地或经授权的私有云部署。",
    ],
  };
}

async function requestPayload(
  request: Request,
): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json();
    return asRecord(value) ?? {};
  } catch {
    return {};
  }
}

function importTemplate(dataType: string): Response {
  const header =
    dataType === "warehouse_events"
      ? "event_id,order_id,event_time,event_code,location_code"
      : dataType === "tracking_events"
        ? "event_id,order_id,event_time,event_code,carrier_id"
        : "order_id,created_at,promised_delivery_time,actual_delivery_time,warehouse_id,carrier_id,order_status";
  return new Response(`${header}\n`, {
    headers: {
      "Content-Disposition": `attachment; filename="fulfilllens-${dataType}-template.csv"`,
      "Content-Type": "text/csv; charset=utf-8",
    },
  });
}

function caseFileResponse(
  caseId: string,
  fileName: string,
  helpers: OnlineDemoApiHelpers,
): Response {
  const metadata = caseMetadata(caseId);
  const selection = selectionForCase(caseId);
  const orders = ordersFor(selection);
  if (fileName === "metadata.json") {
    return new Response(JSON.stringify(metadata, null, 2), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
  if (fileName === "orders.csv") return ordersCsv(orders);
  if (
    fileName === "warehouse_events.csv" ||
    fileName === "tracking_events.csv"
  ) {
    const header = "event_id,order_id,event_time,event_code,location_code";
    const rows = orders.flatMap((order) =>
      order.node_durations.map((node, index) => [
        `${fileName.slice(0, 2).toUpperCase()}-${order.order_id}-${index + 1}`,
        order.order_id,
        node.end_time,
        node.interval_code,
        node.location_code ?? "",
      ]),
    );
    return new Response(
      [header, ...rows.map((row) => row.map(csvCell).join(","))].join("\n"),
      {
        headers: {
          "Content-Disposition": `attachment; filename="${fileName}"`,
          "Content-Type": "text/csv; charset=utf-8",
        },
      },
    );
  }
  return helpers.error(
    "CASE_FILE_NOT_FOUND",
    "该在线合成案例文件不存在。",
    404,
  );
}

function onlineDatasets() {
  const createdAt = "2026-06-01T00:00:00.000Z";
  return [
    {
      dataset_id: ONLINE_DEMO_DATASETS.orders,
      data_type: "orders",
      row_count: buildOrders("promotion").length,
      created_at: createdAt,
      source_kind: "synthetic_case",
    },
    {
      dataset_id: ONLINE_DEMO_DATASETS.warehouseEvents,
      data_type: "warehouse_events",
      row_count: buildOrders("promotion").length * 5,
      created_at: createdAt,
      source_kind: "synthetic_case",
    },
    {
      dataset_id: ONLINE_DEMO_DATASETS.trackingEvents,
      data_type: "tracking_events",
      row_count: buildOrders("promotion").length * 4,
      created_at: createdAt,
      source_kind: "synthetic_case",
    },
  ];
}

export async function handleOnlineDemoApi(
  request: Request,
  url: URL,
  helpers: OnlineDemoApiHelpers,
): Promise<Response | null> {
  const { pathname } = url;
  const method = request.method;
  if (method === "GET" && pathname === "/api/datasets") {
    const datasets = onlineDatasets();
    return helpers.json({ datasets, total: datasets.length });
  }
  if (method === "DELETE" && pathname.startsWith("/api/datasets/")) {
    return helpers.error(
      "ONLINE_DEMO_DATASET_READ_ONLY",
      "在线演示数据是只读合成样例，不能删除。",
      409,
    );
  }
  if (method === "GET" && pathname === "/api/cases") {
    const cases = [
      "normal_operations",
      "promotion_surge",
      "carrier_disruption",
    ].map(caseMetadata);
    return helpers.json({
      cases,
      generator_version: "online-demo-generator-v1",
      privacy_statement:
        "所有在线案例均为确定性合成数据，不包含真实个人或企业数据。",
    });
  }
  const caseLoad = pathname.match(
    /^\/api\/cases\/(normal_operations|promotion_surge|carrier_disruption)\/load$/,
  );
  if (method === "POST" && caseLoad) {
    const caseId = caseLoad[1] ?? "promotion_surge";
    return helpers.json(
      {
        case: caseMetadata(caseId),
        datasets: selectionForCase(caseId),
        replaced_current_context: true,
        prior_datasets_retained: true,
        message:
          "已加载在线合成案例；数据仅在浏览器与 Worker 的公开演示流程中使用。",
      },
      201,
    );
  }
  const caseFile = pathname.match(
    /^\/api\/cases\/(normal_operations|promotion_surge|carrier_disruption)\/files\/([^/]+)$/,
  );
  if (method === "GET" && caseFile) {
    return caseFileResponse(
      caseFile[1] ?? "promotion_surge",
      decodeURIComponent(caseFile[2] ?? ""),
      helpers,
    );
  }

  if (method === "GET" && pathname === "/api/metrics/summary") {
    const selection = datasetSelection(url);
    const orders = ordersFor(selection);
    return helpers.json({
      datasets: selection,
      metrics: metricsFor(orders),
      warnings: [],
      definition_version: DEFINITION_VERSION,
      taxonomy_version: "online-demo-taxonomy-v1",
      rule_set_version: RULE_SET_VERSION,
    });
  }
  if (method === "GET" && pathname === "/api/metrics/trend") {
    const selection = datasetSelection(url);
    return helpers.json(
      trendResponse(
        selection,
        ordersFor(selection),
        url.searchParams.get("grain") || "date",
        url.searchParams.get("timezone") || "Asia/Shanghai",
      ),
    );
  }
  if (method === "GET" && pathname === "/api/metrics/distribution") {
    const selection = datasetSelection(url);
    const count = Math.min(
      16,
      Math.max(
        1,
        Number.parseInt(url.searchParams.get("bin_count") || "8", 10) || 8,
      ),
    );
    return helpers.json(
      distributionResponse(
        selection,
        ordersFor(selection),
        url.searchParams.get("metric_code") || "fulfillment_duration_hours",
        count,
      ),
    );
  }
  if (method === "GET" && pathname === "/api/metrics/breakdown") {
    const selection = datasetSelection(url);
    return helpers.json(
      breakdownResponse(
        selection,
        ordersFor(selection),
        url.searchParams.get("dimension") || "carrier_id",
      ),
    );
  }
  const metricOrder = pathname.match(/^\/api\/metrics\/orders\/([^/]+)$/);
  if (method === "GET" && metricOrder) {
    const selection = datasetSelection(url);
    const order = ordersFor(selection).find(
      (candidate) =>
        candidate.order_id === decodeURIComponent(metricOrder[1] ?? ""),
    );
    return order
      ? helpers.json(orderDetail(order))
      : helpers.error("ORDER_NOT_FOUND", "当前在线合成案例中没有该订单。", 404);
  }

  if (method === "GET" && pathname === "/api/dashboard/overview") {
    const selection = datasetSelection(url);
    const unfiltered = ordersFor(selection);
    return helpers.json(
      dashboardOverview(
        url,
        selection,
        unfiltered,
        filteredOrders(url, unfiltered),
      ),
    );
  }
  if (method === "GET" && pathname === "/api/dashboard/orders") {
    const selection = datasetSelection(url);
    const all = sortOrders(
      filteredOrders(url, ordersFor(selection)),
      url.searchParams.get("sort_by") || "created_at",
      url.searchParams.get("sort_direction") || "desc",
    );
    const page = Math.max(
      1,
      Number.parseInt(url.searchParams.get("page") || "1", 10) || 1,
    );
    const pageSize = Math.min(
      100,
      Math.max(
        1,
        Number.parseInt(url.searchParams.get("page_size") || "20", 10) || 20,
      ),
    );
    const start = (page - 1) * pageSize;
    return helpers.json({
      datasets: selection,
      active_filters: dashboardFilters(url),
      items: all.slice(start, start + pageSize).map((order) => ({
        ...orderDetail(order),
        anomaly_types: order.anomaly_reasons,
      })),
      total: all.length,
      page,
      page_size: pageSize,
      page_count: Math.max(1, Math.ceil(all.length / pageSize)),
      sort_by: url.searchParams.get("sort_by") || "created_at",
      sort_direction: url.searchParams.get("sort_direction") || "desc",
      definition_version: DEFINITION_VERSION,
    });
  }
  if (method === "GET" && pathname === "/api/dashboard/orders.csv") {
    const selection = datasetSelection(url);
    return ordersCsv(
      sortOrders(
        filteredOrders(url, ordersFor(selection)),
        url.searchParams.get("sort_by") || "created_at",
        url.searchParams.get("sort_direction") || "desc",
      ),
    );
  }

  if (method === "GET" && pathname === "/api/diagnostics/rules") {
    return helpers.json({
      rule_set_version: RULE_SET_VERSION,
      rules: diagnosticRules(),
    });
  }
  if (method === "POST" && pathname === "/api/diagnostics/analyze") {
    const payload = await requestPayload(request);
    const selection = datasetSelection(url, payload);
    return helpers.json(
      diagnosticAnalysis(
        selection,
        ordersFor(selection),
        stringValue(payload.timezone, "Asia/Shanghai"),
      ),
    );
  }
  if (method === "POST" && pathname === "/api/diagnostics/orders/search") {
    const payload = await requestPayload(request);
    const selection = datasetSelection(url, payload);
    const all = ordersFor(selection)
      .filter((order) => order.anomaly_reasons.length > 0)
      .map((order) => {
        const orderFindings = findingsFor([order]);
        const severity = stringValue(orderFindings[0]?.severity, "low");
        return {
          order_id: order.order_id,
          order_status: order.order_status,
          warehouse_id: order.warehouse_id,
          carrier_id: order.carrier_id,
          destination_region: order.destination_region,
          highest_severity: severity,
          categories: orderFindings.map((finding) => finding.category),
          rule_ids: orderFindings.map((finding) => finding.rule_id),
          finding_count: orderFindings.length,
        };
      });
    const severity = url.searchParams.get("severity");
    const category = url.searchParams.get("category");
    const ruleId = url.searchParams.get("rule_id");
    const filtered = all.filter(
      (item) =>
        (!severity || item.highest_severity === severity) &&
        (!category || item.categories.includes(category)) &&
        (!ruleId || item.rule_ids.includes(ruleId)),
    );
    const page = Math.max(
      1,
      Number.parseInt(url.searchParams.get("page") || "1", 10) || 1,
    );
    const pageSize = Math.min(
      100,
      Math.max(
        1,
        Number.parseInt(url.searchParams.get("page_size") || "20", 10) || 20,
      ),
    );
    return helpers.json({
      datasets: selection,
      items: filtered.slice((page - 1) * pageSize, page * pageSize),
      total: filtered.length,
      page,
      page_size: pageSize,
      page_count: Math.max(1, Math.ceil(filtered.length / pageSize)),
      rule_set_version: RULE_SET_VERSION,
    });
  }
  const diagnosticOrder = pathname.match(
    /^\/api\/diagnostics\/orders\/([^/]+)$/,
  );
  if (method === "POST" && diagnosticOrder) {
    const payload = await requestPayload(request);
    const selection = datasetSelection(url, payload);
    const order = ordersFor(selection).find(
      (candidate) =>
        candidate.order_id === decodeURIComponent(diagnosticOrder[1] ?? ""),
    );
    if (!order)
      return helpers.error(
        "ORDER_NOT_FOUND",
        "当前在线合成案例中没有该订单。",
        404,
      );
    return helpers.json({
      metric_detail: orderDetail(order),
      findings: findingsFor([order]),
      timeline: order.node_durations.map((node, index) => ({
        source: index < 3 ? "warehouse" : "tracking",
        event_id: `EVT-${order.order_id}-${index + 1}`,
        event_time: node.end_time,
        event_code: node.interval_code,
        raw_status: node.display_name,
        shipment_id: node.shipment_id,
        location_code: node.location_code,
      })),
      rule_set_version: RULE_SET_VERSION,
    });
  }

  if (method === "GET" && pathname === "/api/simulations/parameters") {
    return helpers.json({
      parameters: [
        {
          code: "warehouse_improvement_value",
          display_name: "仓内节点改善",
          business_meaning: "降低指定仓内节点耗时",
          unit: "hour",
          minimum: 0,
          maximum: 24,
          default: 0,
          impact_path: "仓内节点→履约时长",
          model_assumption: "按简化固定小时数计入合成订单",
        },
        {
          code: "pickup_reduction_hours",
          display_name: "揽收等待改善",
          business_meaning: "减少揽收等待时间",
          unit: "hour",
          minimum: 0,
          maximum: 24,
          default: 0,
          impact_path: "揽收→履约时长",
          model_assumption: "按简化固定小时数计入合成订单",
        },
        {
          code: "promise_extension_hours",
          display_name: "承诺时限调整",
          business_meaning: "调整对外承诺时限",
          unit: "hour",
          minimum: 0,
          maximum: 24,
          default: 0,
          impact_path: "承诺→OT/OTIF",
          model_assumption: "不会改变实际作业耗时",
        },
      ],
      supported_warehouse_nodes: Object.fromEntries(
        nodeDefinitions.map(([code, label]) => [code, label]),
      ),
      definition_version: "online-demo-simulation-v1",
      estimate_label:
        "基于合成数据和简化假设的在线情景估算，不代表预测或保证。",
    });
  }
  if (method === "POST" && pathname === "/api/simulations/baseline") {
    const payload = await requestPayload(request);
    const selection = datasetSelection(url, payload);
    return helpers.json(
      baselineResponse(
        selection,
        ordersFor(selection),
        stringValue(payload.timezone, "Asia/Shanghai"),
      ),
    );
  }
  if (method === "GET" && pathname === "/api/simulations/scenarios") {
    const selection = datasetSelection(url);
    const builtIn: StoredScenario = {
      scenario_id: `online-demo-default-${variantFor(selection)}`,
      name: "在线演示：仓内处理改善",
      datasets: selection,
      timezone: "Asia/Shanghai",
      parameters: {
        ...defaultParameters(),
        warehouse_improvements: [
          {
            node_code: "packing",
            method: "fixed_hours",
            value: 4,
            warehouse_ids: [],
          },
        ],
      },
      created_at: "2026-06-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:00:00.000Z",
    };
    const stored = Array.from(scenarioStore.values()).filter(
      (scenario) =>
        scenario.datasets.orders_dataset_id === selection.orders_dataset_id,
    );
    return helpers.json([
      scenarioRecord(builtIn),
      ...stored.map(scenarioRecord),
    ]);
  }
  if (method === "POST" && pathname === "/api/simulations/scenarios") {
    const payload = await requestPayload(request);
    const parameterError = scenarioParameterError(payload.parameters ?? {});
    if (parameterError !== null) {
      return helpers.error("INVALID_SIMULATION_PARAMETER", parameterError, 422);
    }
    const selection = datasetSelection(url, payload);
    const timestamp = now();
    const scenarioDraft: Omit<StoredScenario, "scenario_id"> = {
      name: stringValue(payload.name, "未命名在线方案").slice(0, 80),
      datasets: selection,
      timezone: stringValue(payload.timezone, "Asia/Shanghai"),
      parameters: scenarioParameters(payload.parameters),
      created_at: timestamp,
      updated_at: timestamp,
    };
    const scenario: StoredScenario = {
      scenario_id: scenarioIdFor(scenarioDraft),
      ...scenarioDraft,
    };
    scenarioStore.set(scenario.scenario_id, scenario);
    return helpers.json(scenarioRecord(scenario), 201);
  }
  const scenarioAction = pathname.match(
    /^\/api\/simulations\/scenarios\/([^/]+)(?:\/(copy))?$/,
  );
  if (scenarioAction) {
    const scenarioId = decodeURIComponent(scenarioAction[1] ?? "");
    const action = scenarioAction[2];
    const selection = datasetSelection(url);
    const builtIn: StoredScenario = {
      scenario_id: scenarioId,
      name: "在线演示：仓内处理改善",
      datasets: selection,
      timezone: "Asia/Shanghai",
      parameters: {
        ...defaultParameters(),
        warehouse_improvements: [
          {
            node_code: "packing",
            method: "fixed_hours",
            value: 4,
            warehouse_ids: [],
          },
        ],
      },
      created_at: "2026-06-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:00:00.000Z",
    };
    const existing =
      scenarioStore.get(scenarioId) ?? scenarioFromId(scenarioId) ?? builtIn;
    if (method === "POST" && action === "copy") {
      const payload = await requestPayload(request);
      const timestamp = now();
      const copyDraft: Omit<StoredScenario, "scenario_id"> = {
        name: stringValue(payload.name, `${existing.name} 副本`).slice(0, 80),
        datasets: existing.datasets,
        timezone: existing.timezone,
        parameters: existing.parameters,
        created_at: timestamp,
        updated_at: timestamp,
      };
      const copy: StoredScenario = {
        scenario_id: scenarioIdFor(copyDraft),
        ...copyDraft,
      };
      scenarioStore.set(copy.scenario_id, copy);
      return helpers.json(scenarioRecord(copy), 201);
    }
    if (method === "PATCH" && !action) {
      const payload = await requestPayload(request);
      const parameterError =
        payload.parameters === undefined
          ? null
          : scenarioParameterError(payload.parameters);
      if (parameterError !== null) {
        return helpers.error(
          "INVALID_SIMULATION_PARAMETER",
          parameterError,
          422,
        );
      }
      const updatedDraft: Omit<StoredScenario, "scenario_id"> = {
        name: stringValue(payload.name, existing.name).slice(0, 80),
        datasets: existing.datasets,
        timezone: existing.timezone,
        parameters:
          payload.parameters === undefined
            ? existing.parameters
            : scenarioParameters(payload.parameters),
        created_at: existing.created_at,
        updated_at: now(),
      };
      const updated: StoredScenario = {
        scenario_id: scenarioIdFor(updatedDraft),
        ...updatedDraft,
      };
      scenarioStore.delete(scenarioId);
      scenarioStore.set(updated.scenario_id, updated);
      return helpers.json(scenarioRecord(updated));
    }
    if (method === "DELETE" && !action) {
      scenarioStore.delete(scenarioId);
      return new Response(null, { status: 204 });
    }
  }
  if (method === "POST" && pathname === "/api/simulations/run") {
    const payload = await requestPayload(request);
    const parameterError =
      payload.parameters === undefined
        ? null
        : scenarioParameterError(payload.parameters);
    if (parameterError !== null) {
      return helpers.error("INVALID_SIMULATION_PARAMETER", parameterError, 422);
    }
    const selection = datasetSelection(url, payload);
    const scenarioId = stringValue(payload.scenario_id);
    const inlineParameters = asRecord(payload.parameters);
    const scenario =
      inlineParameters !== null
        ? {
            scenario_id: "",
            name: stringValue(payload.scenario_name, "在线临时方案"),
            datasets: selection,
            timezone: stringValue(payload.timezone, "Asia/Shanghai"),
            parameters: scenarioParameters(inlineParameters),
            created_at: now(),
            updated_at: now(),
          }
        : (scenarioStore.get(scenarioId) ??
          scenarioFromId(scenarioId) ?? {
            scenario_id:
              scenarioId || `online-demo-default-${variantFor(selection)}`,
            name: "在线演示：仓内处理改善",
            datasets: selection,
            timezone: "Asia/Shanghai",
            parameters: {
              ...defaultParameters(),
              warehouse_improvements: [
                {
                  node_code: "packing",
                  method: "fixed_hours",
                  value: 4,
                  warehouse_ids: [],
                },
              ],
            },
            created_at: "2026-06-01T00:00:00.000Z",
            updated_at: "2026-06-01T00:00:00.000Z",
          });
    return helpers.json(
      simulationRun(selection, ordersFor(selection), scenario),
    );
  }
  if (method === "POST" && pathname === "/api/simulations/sensitivity") {
    const payload = await requestPayload(request);
    const selection = datasetSelection(url, payload);
    const sourceOrders = ordersFor(selection);
    const parameter = stringValue(
      payload.parameter,
      "warehouse_improvement_value",
    );
    const values = Array.isArray(payload.values)
      ? payload.values.map((value) => numberValue(value)).slice(0, 20)
      : [0, 2, 4, 6];
    if (values.some((value) => value < 0 || value > 24)) {
      return helpers.error(
        "INVALID_SIMULATION_PARAMETER",
        "在线敏感性参数必须在 0 到 24 小时之间。",
        422,
      );
    }
    return helpers.json({
      parameter,
      unit: "hour",
      points: values.map((value) => {
        const parameters = defaultParameters();
        if (parameter === "pickup_reduction_hours") {
          parameters.pickup_improvement = {
            reduction_hours: value,
            carrier_ids: [],
          };
        } else if (parameter === "promise_extension_hours") {
          parameters.promise_strategy = { extension_hours: value };
        } else {
          parameters.warehouse_improvements = [
            {
              node_code: "packing",
              method: "fixed_hours",
              value,
              warehouse_ids: [],
            },
          ];
        }
        const transformed = applyScenarioToOrders(sourceOrders, parameters);
        const metrics = metricsFor(transformed.orders);
        return {
          parameter_value: value,
          otif: metricByCode(metrics, "otif_rate"),
          fulfillment_mean_hours: metricByCode(
            metrics,
            "fulfillment_duration_mean_hours",
          ),
          fulfillment_p50_hours: metricByCode(
            metrics,
            "fulfillment_duration_median_hours",
          ),
          fulfillment_p90_hours: metricByCode(
            metrics,
            "fulfillment_duration_p90_hours",
          ),
          anomaly_rate: metricByCode(metrics, "anomaly_order_rate"),
          affected_order_count: new Set(
            transformed.adjustments.map((item) => item.order_id),
          ).size,
          warnings: [],
        };
      }),
      input_fingerprint: `online-demo-${selection.orders_dataset_id}`,
      warnings: ["敏感性结果仅反映合成案例中的方向性变化。"],
      definition_version: "online-demo-simulation-v1",
      estimate_label:
        "基于合成数据和简化假设的在线情景估算，不代表预测或保证。",
    });
  }

  if (method === "GET" && pathname === "/api/reports/capabilities") {
    return helpers.json({
      supported_formats: ["markdown", "html", "csv"],
      csv_export_kinds: [
        "anomaly_orders",
        "metric_detail",
        "simulation_comparison",
      ],
      pdf_available: false,
      pdf_reason: "在线演示不提供 PDF 渲染。",
      max_export_bytes: 2_000_000,
      contract_version: "online-demo-report-v1",
    });
  }
  if (method === "POST" && pathname === "/api/reports/preview") {
    return helpers.json(reportDocument(await requestPayload(request)));
  }
  if (method === "POST" && pathname === "/api/reports/jobs") {
    const payload = await requestPayload(request);
    const format = ["markdown", "html", "csv"].includes(
      stringValue(payload.format),
    )
      ? stringValue(payload.format)
      : "markdown";
    const document = reportDocument(payload.report);
    const context = reportContext(payload.report);
    const timestamp = now();
    const csvKind =
      typeof payload.csv_kind === "string" ? payload.csv_kind : null;
    const record = createReportJobRecord(
      reportJobIdFor(format, csvKind, timestamp, payload.report),
      format,
      csvKind,
      timestamp,
      document,
      context.orders,
    );
    reportJobStore.set(record.job_id, record);
    return helpers.json(reportJob(record), 201);
  }
  const reportJobMatch = pathname.match(
    /^\/api\/reports\/jobs\/([^/]+)(?:\/(download))?$/,
  );
  if (reportJobMatch) {
    const jobId = decodeURIComponent(reportJobMatch[1] ?? "");
    const action = reportJobMatch[2];
    const record = reportJobStore.get(jobId) ?? statelessReportJob(jobId);
    if (!record)
      return helpers.error(
        "REPORT_JOB_NOT_FOUND",
        "在线报告任务不存在或已过期。",
        404,
      );
    if (method === "GET" && action === "download") {
      return new Response(record.content, {
        headers: {
          "Content-Disposition": `attachment; filename="${record.file_name}"`,
          "Content-Type": record.media_type,
        },
      });
    }
    if (method === "GET" && !action) return helpers.json(reportJob(record));
    if (method === "DELETE" && !action) {
      reportJobStore.delete(jobId);
      return helpers.json(reportJob(record, "cancelled"));
    }
  }

  if (method === "POST" && pathname === "/api/imports/synthetic") {
    const payload = await requestPayload(request);
    const dataType = stringValue(payload.data_type, "orders");
    return helpers.json(importParseResponse(dataType), 201);
  }
  if (method === "POST" && pathname === "/api/imports/upload") {
    return helpers.error(
      "ONLINE_DEMO_UPLOAD_NOT_ENABLED",
      "为保护业务数据，当前在线版不接收真实文件；请加载合成案例或使用本地完整版本。",
      403,
    );
  }
  const importTemplateMatch = pathname.match(
    /^\/api\/imports\/templates\/(orders|warehouse_events|tracking_events)$/,
  );
  if (method === "GET" && importTemplateMatch)
    return importTemplate(importTemplateMatch[1] ?? "orders");
  const importAction = pathname.match(
    /^\/api\/imports\/([^/]+)(?:\/(parse|validation|confirm|errors\.csv))?$/,
  );
  if (importAction) {
    const taskId = decodeURIComponent(importAction[1] ?? "online-demo-orders");
    const action = importAction[2];
    const dataType = importDataType(taskId);
    if (method === "POST" && action === "parse")
      return helpers.json(importParseResponse(dataType));
    if (method === "PUT" && action === "validation") {
      return helpers.json({
        task: importTask(dataType),
        report: {
          total_rows: buildOrders("promotion").length,
          valid_rows: buildOrders("promotion").length,
          error_rows: 0,
          warning_rows: 0,
          null_counts: {},
          duplicate_keys: 0,
          invalid_times: 0,
          time_order_conflicts: 0,
          negative_quantities: 0,
          unknown_statuses: 0,
          long_text_values: 0,
          unparseable_values: 0,
          exact_duplicate_rows: 0,
          sensitive_risks: [],
          status_normalizations: [],
          issues: [],
          can_confirm: true,
        },
        normalized_preview: importParseResponse(dataType).preview_rows.map(
          (row) => row.values,
        ),
      });
    }
    if (method === "POST" && action === "confirm") {
      const selection = selectionForCase("promotion_surge");
      const datasetId =
        dataType === "warehouse_events"
          ? selection.warehouse_events_dataset_id
          : dataType === "tracking_events"
            ? selection.tracking_events_dataset_id
            : selection.orders_dataset_id;
      return helpers.json({
        task: importTask(dataType, "analyzable"),
        dataset_id: datasetId,
        imported_rows: buildOrders("promotion").length,
        message: "已切换到在线合成数据集。",
      });
    }
    if (method === "GET" && action === "errors.csv") {
      return new Response("issue_id,severity,message\n", {
        headers: { "Content-Type": "text/csv; charset=utf-8" },
      });
    }
    if (method === "DELETE" && !action)
      return helpers.json(importTask(dataType, "cancelled"));
  }
  return null;
}
