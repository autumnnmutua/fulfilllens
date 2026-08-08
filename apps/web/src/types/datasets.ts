export type DatasetDataType = "orders" | "warehouse_events" | "tracking_events";

export interface DatasetSummary {
  dataset_id: string;
  data_type: DatasetDataType;
  row_count: number;
  created_at: string;
  source_kind: "user_import" | "synthetic_case";
}

export interface DatasetListResponse {
  datasets: DatasetSummary[];
  total: number;
}

export interface DatasetDeleteResponse {
  dataset_id: string;
  data_type: DatasetDataType;
  rows_deleted: number;
  scenarios_deleted: number;
  report_jobs_deleted: number;
  import_artifacts_deleted: boolean;
  message: string;
}
