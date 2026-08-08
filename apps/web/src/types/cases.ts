import type { DatasetSelection } from "./metrics";

export type CaseId =
  "normal_operations" | "promotion_surge" | "carrier_disruption";

export interface CaseMetricRange {
  minimum: number;
  maximum: number;
  unit: string;
}

export interface ExpectedFinding {
  rule_id: string;
  description: string;
  required: boolean;
}

export interface CaseFile {
  name:
    | "orders.csv"
    | "warehouse_events.csv"
    | "tracking_events.csv"
    | "case.xlsx"
    | "metadata.json";
  media_type: string;
  size_bytes: number;
}

export interface CaseMetadata {
  case_id: CaseId;
  display_name: string;
  business_background: string;
  generator_version: string;
  seed: number;
  timezone: "Asia/Shanghai";
  order_count: number;
  date_range: Record<string, string>;
  row_counts: Record<string, number>;
  injected_anomalies: string[];
  expected_findings: ExpectedFinding[];
  expected_metric_ranges: Record<string, CaseMetricRange>;
  learning_objectives: string[];
  privacy_statement: string;
  content_fingerprint: string;
  files: CaseFile[];
}

export interface CaseCatalogResponse {
  cases: CaseMetadata[];
  generator_version: string;
  privacy_statement: string;
}

export interface CaseLoadResponse {
  case: CaseMetadata;
  datasets: DatasetSelection;
  replaced_current_context: true;
  prior_datasets_retained: true;
  message: string;
}
