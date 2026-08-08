import type {
  BreakdownDimension,
  DashboardFilters,
  TrendGrain,
} from "./dashboard";
import type { DatasetSelection } from "./metrics";
import type { ScenarioParameters } from "./simulation";

export type ReportSectionCode =
  | "executive_summary"
  | "data_quality"
  | "metrics_overview"
  | "trend"
  | "node_duration"
  | "dimension_breakdown"
  | "diagnostics"
  | "order_samples"
  | "simulation"
  | "methods_limits";
export type ReportFormat = "markdown" | "html" | "csv";
export type ReportReadingMode = "standard" | "guided";
export type CsvExportKind =
  | "anomaly_orders"
  | "data_quality_errors"
  | "status_mapping"
  | "metric_detail"
  | "simulation_comparison";
export type ReportJobStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled";

export interface ReportSimulationSelection {
  scenario_id: string | null;
  scenario_name: string;
  parameters: ScenarioParameters | null;
}

export interface ReportRequest {
  datasets: DatasetSelection;
  dataset_name: string;
  filters: DashboardFilters;
  trend_grain: TrendGrain;
  breakdown_dimension: BreakdownDimension;
  sections: ReportSectionCode[];
  order_sample_limit: number;
  include_order_identifiers: boolean;
  sensitive_export_confirmed: boolean;
  reading_mode: ReportReadingMode;
  simulation: ReportSimulationSelection | null;
}

export interface ReportHeader {
  title: string;
  dataset_name: string;
  time_range_start: string | null;
  time_range_end: string | null;
  order_count: number;
  valid_order_count: number;
  data_coverage: number | null;
  generated_at: string;
  timezone: string;
  metrics_definition_version: string;
  diagnostic_rule_version: string;
  simulation_version: string;
  report_version: string;
  renderer_version: string;
  synthetic_data: boolean;
}

export interface ReportSection {
  code: ReportSectionCode;
  title: string;
  narrative: string[];
  data: Record<string, unknown>;
  warnings: string[];
}

export interface ReportDocument {
  header: ReportHeader;
  filters: DashboardFilters;
  executive_summary: string[];
  sections: ReportSection[];
  warnings: string[];
  source_notes: string[];
  chart_map: Array<Record<string, string>>;
  identifier_policy: string;
  reading_mode: ReportReadingMode;
  reading_guide: Array<{
    term: string;
    meaning: string;
    direction: string;
    caution: string;
    requires_context: boolean;
  }>;
  contract_version: string;
}

export interface ReportCapabilities {
  supported_formats: ReportFormat[];
  csv_export_kinds: CsvExportKind[];
  pdf_available: boolean;
  pdf_reason: string;
  max_export_bytes: number;
  contract_version: string;
}

export interface ReportJob {
  job_id: string;
  status: ReportJobStatus;
  progress: number;
  message: string;
  format: ReportFormat;
  csv_kind: CsvExportKind | null;
  created_at: string;
  updated_at: string;
  file_name: string | null;
  media_type: string | null;
  size_bytes: number | null;
  error_code: string | null;
  download_ready: boolean;
}
