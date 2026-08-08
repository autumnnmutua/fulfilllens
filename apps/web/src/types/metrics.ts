export interface DatasetSelection {
  orders_dataset_id: string;
  warehouse_events_dataset_id?: string | null;
  tracking_events_dataset_id?: string | null;
}

export interface MetricResult {
  code: string;
  display_name: string;
  value: number | null;
  unit: "order" | "ratio" | "hour";
  numerator: number | null;
  denominator: number | null;
  coverage: number | null;
  eligible_count: number;
  computable_count: number;
  pending_count: number;
  not_computable_count: number;
  definition_version: string;
  warnings: string[];
}

export interface DataWarning {
  code: string;
  message: string;
  order_id?: string | null;
  event_id?: string | null;
  interval_code?: string | null;
}

export interface MetricsSummary {
  datasets: DatasetSelection;
  metrics: MetricResult[];
  warnings: DataWarning[];
  definition_version: string;
  taxonomy_version: string;
  rule_set_version: string;
}

export interface MetricGroup {
  key: string;
  label: string;
  metrics: MetricResult[];
  order_count: number;
  warnings: string[];
}

export interface TrendResponse {
  datasets: DatasetSelection;
  grain: "date" | "week";
  timezone: string;
  groups: MetricGroup[];
  definition_version: string;
}

export interface BreakdownResponse {
  datasets: DatasetSelection;
  dimension:
    "warehouse_id" | "carrier_id" | "destination_region" | "sales_channel";
  groups: MetricGroup[];
  definition_version: string;
}

export interface DistributionBin {
  lower_bound: number;
  upper_bound: number;
  count: number;
  includes_upper_bound: boolean;
}

export interface DistributionResponse {
  datasets: DatasetSelection;
  metric_code: string;
  unit: "hour";
  sample_size: number;
  minimum: number | null;
  maximum: number | null;
  mean: number | null;
  median: number | null;
  p90: number | null;
  quantile_method: string;
  bins: DistributionBin[];
  warnings: string[];
  definition_version: string;
}

export type DecisionStatus =
  "true" | "false" | "not_computable" | "pending" | "excluded";

export interface Decision {
  status: DecisionStatus;
  value: boolean | null;
  reason: string;
}

export interface NodeDuration {
  interval_code: string;
  display_name: string;
  duration_hours: number;
  start_time: string;
  end_time: string;
  shipment_id?: string | null;
  location_code?: string | null;
}

export interface OrderMetricDetail {
  order_id: string;
  order_status: string;
  created_at: string | null;
  promised_delivery_time: string | null;
  actual_delivery_time: string | null;
  ordered_quantity: number | null;
  delivered_quantity: number | null;
  quantity_unit: string | null;
  warehouse_id: string;
  carrier_id: string;
  destination_region: string;
  sales_channel: string;
  ot: Decision;
  in_full: Decision;
  otif: Decision;
  fulfillment_duration_hours: number | null;
  anomaly: boolean;
  anomaly_reasons: string[];
  node_durations: NodeDuration[];
  warnings: DataWarning[];
  definition_version: string;
  rule_set_version: string;
}
