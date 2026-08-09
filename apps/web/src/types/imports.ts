export type DataType = "orders" | "warehouse_events" | "tracking_events";

export type ImportStatus =
  | "pending_upload"
  | "parsing"
  | "awaiting_encoding"
  | "awaiting_sheet"
  | "awaiting_mapping"
  | "validation_failed"
  | "ready_to_confirm"
  | "analyzable"
  | "cancelled";

export interface SheetInfo {
  name: string;
  state: string;
}

export interface ImportTask {
  task_id: string;
  data_type: DataType;
  status: ImportStatus;
  status_label: string;
  file_name: string;
  file_format: "csv" | "xlsx";
  file_size_bytes?: number | null;
  encoding?: string | null;
  encoding_required: boolean;
  encoding_options: string[];
  sheets: SheetInfo[];
  selected_sheet?: string | null;
  sheet_count?: number | null;
  processing_location?: "browser" | "server" | null;
  default_timezone?: string | null;
  message: string;
  can_reconfigure: boolean;
}

export interface FieldDefinition {
  field: string;
  label: string;
  required: boolean;
  value_type: string;
  aliases: string[];
}

export interface FieldCandidate {
  field: string;
  label: string;
  confidence: number;
  method: string;
}

export interface FieldSuggestion {
  source_column: string;
  suggested_field?: string | null;
  confidence: number;
  method: string;
  requires_confirmation?: boolean;
  candidates: FieldCandidate[];
}

export interface DataTypeCandidate {
  data_type: DataType;
  display_name: string;
  confidence: number;
  matched_fields: string[];
  missing_required_fields: string[];
}

export interface SensitiveRisk {
  source_column: string;
  categories: string[];
  detection_basis: string;
  non_empty_count: number;
  message: string;
}

export interface PreviewRow {
  row_number: number;
  values: Record<string, unknown>;
}

export interface ParseResponse {
  task: ImportTask;
  fields: FieldDefinition[];
  source_columns: string[];
  preview_rows: PreviewRow[];
  total_rows: number;
  suggestions: FieldSuggestion[];
  sensitive_risks: SensitiveRisk[];
  warnings: string[];
  detected_data_type: DataType;
  detection_confidence: number;
  data_type_candidates: DataTypeCandidate[];
  unmapped_source_columns: string[];
  conversion_notes: string[];
}

export interface CompatibilitySample {
  sample_id: string;
  display_name: string;
  file_name: string;
  file_format: "csv" | "xlsx";
  default_data_type: DataType;
  default_sheet?: string | null;
  sheet_names: string[];
  row_counts: Record<string, number>;
  purpose: string;
  conversion_features: string[];
  sha256: string;
  privacy_statement: string;
}

export interface CompatibilitySampleCatalog {
  samples: CompatibilitySample[];
  privacy_statement: string;
}

export interface QualityIssue {
  issue_id: string;
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  sheet?: string | null;
  row_number?: number | null;
  source_column?: string | null;
  target_field?: string | null;
  raw_value?: string | null;
  suggestion: string;
}

export interface StatusNormalization {
  raw_status: string;
  normalized_status: string;
  mapping_source: string;
  mapping_confidence: number;
  occurrences: number;
}

export interface QualityReport {
  total_rows: number;
  valid_rows: number;
  error_rows: number;
  warning_rows: number;
  null_counts: Record<string, number>;
  duplicate_keys: number;
  invalid_times: number;
  time_order_conflicts: number;
  negative_quantities: number;
  unknown_statuses: number;
  long_text_values: number;
  unparseable_values: number;
  exact_duplicate_rows: number;
  ignored_source_columns: string[];
  unresolved_source_columns: string[];
  sensitive_risks: SensitiveRisk[];
  status_normalizations: StatusNormalization[];
  issues: QualityIssue[];
  can_confirm: boolean;
}

export interface ValidationResponse {
  task: ImportTask;
  report: QualityReport;
  normalized_preview: Record<string, unknown>[];
}

export interface ConfirmResponse {
  task: ImportTask;
  dataset_id: string;
  imported_rows: number;
  message: string;
}
