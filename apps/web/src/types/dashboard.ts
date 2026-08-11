import type {
  DataWarning,
  DatasetSelection,
  DistributionResponse,
  MetricGroup,
  MetricResult,
  OrderMetricDetail,
  TrendResponse,
} from "./metrics";

export type BreakdownDimension =
  "warehouse_id" | "carrier_id" | "destination_region";
export type BreakdownSort =
  | "order_count"
  | "otif_rate"
  | "fulfillment_duration_p90_hours"
  | "anomaly_order_rate";
export type OrderSort =
  | "order_id"
  | "created_at"
  | "promised_delivery_time"
  | "actual_delivery_time"
  | "order_status"
  | "fulfillment_duration_hours"
  | "otif"
  | "anomaly";
export type SortDirection = "asc" | "desc";
export type TrendGrain = "date" | "week";

export interface DashboardFilters {
  start_date: string | null;
  end_date: string | null;
  warehouses: string[];
  carriers: string[];
  regions: string[];
  statuses: string[];
  anomaly_types: string[];
  timezone: string;
}

export interface FilterOption {
  value: string;
  label: string;
  count: number;
}

export interface DashboardFilterOptions {
  minimum_date: string | null;
  maximum_date: string | null;
  warehouses: FilterOption[];
  carriers: FilterOption[];
  regions: FilterOption[];
  statuses: FilterOption[];
  anomaly_types: FilterOption[];
}

export interface DashboardContext {
  dataset_label: string;
  datasets: DatasetSelection;
  time_range_start: string | null;
  time_range_end: string | null;
  order_count: number;
  valid_order_count: number;
  unfiltered_order_count: number;
  data_coverage: number | null;
  last_analyzed_at: string;
  warning_count: number;
  /** Source-to-analysis reconciliation. Null means the source cannot prove the count. */
  raw_row_count?: number | null;
  valid_row_count?: number | null;
  event_count?: number | null;
  unique_shipment_count?: number | null;
  unique_order_count?: number | null;
  analyzed_entity_count?: number | null;
  unfiltered_analyzed_entity_count?: number | null;
  analysis_entity_label?: "订单" | "运单" | "业务实体";
  analysis_fingerprint?: string;
  analysis_source?:
    "user_import" | "compatibility_sample" | "teaching_data" | "server_dataset";
  capabilities?: AnalysisCapability[];
  linkage?: DatasetLinkage | null;
}

export interface AnalysisCapability {
  available: boolean;
  code: string;
  label: string;
  reason: string;
}

export interface DatasetLinkage {
  linked_order_count: number;
  linkage_rate: number | null;
  orphan_event_count: number;
  unlinked_order_count: number;
}

export interface NodeDurationSummary {
  interval_code: string;
  display_name: string;
  mean_hours: number | null;
  median_hours: number | null;
  p90_hours: number | null;
  sample_size: number;
  eligible_count: number;
  coverage: number | null;
  is_bottleneck: boolean;
  warnings: string[];
}

export interface DashboardBreakdown {
  dimension: BreakdownDimension;
  sort_by: BreakdownSort;
  sort_direction: SortDirection;
  groups: MetricGroup[];
}

export interface DashboardOverview {
  context: DashboardContext;
  active_filters: DashboardFilters;
  filter_options: DashboardFilterOptions;
  metrics: MetricResult[];
  trend: TrendResponse;
  distribution: DistributionResponse;
  distribution_coverage: number | null;
  nodes: NodeDurationSummary[];
  breakdown: DashboardBreakdown;
  warnings: DataWarning[];
  warnings_truncated: boolean;
  definition_version: string;
  rule_set_version: string;
}

export interface DashboardOrderItem extends OrderMetricDetail {
  anomaly_types: string[];
}

export interface DashboardOrderPage {
  datasets: DatasetSelection;
  active_filters: DashboardFilters;
  items: DashboardOrderItem[];
  total: number;
  page: number;
  page_size: number;
  page_count: number;
  sort_by: OrderSort;
  sort_direction: SortDirection;
  definition_version: string;
}

export interface DashboardViewOptions {
  grain: TrendGrain;
  dimension: BreakdownDimension;
  breakdownSortBy: BreakdownSort;
  breakdownSortDirection: SortDirection;
}

export interface DashboardOrderOptions {
  page: number;
  pageSize: number;
  sortBy: OrderSort;
  sortDirection: SortDirection;
}
