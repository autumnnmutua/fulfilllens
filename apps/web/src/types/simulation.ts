import type { DatasetSelection } from "./metrics";

export type WarehouseNodeCode =
  "order_to_pick" | "picking" | "pick_to_qc" | "quality_check" | "packing";
export type ReductionMethod = "fixed_hours" | "percentage";
export type SensitivityParameter =
  | "warehouse_improvement_value"
  | "pickup_reduction_hours"
  | "promise_extension_hours";

export interface WarehouseImprovement {
  node_code: WarehouseNodeCode;
  method: ReductionMethod;
  value: number;
  warehouse_ids: string[];
}

export interface PickupImprovement {
  reduction_hours: number;
  carrier_ids: string[];
}

export interface CarrierMixAdjustment {
  method: "empirical_resample";
  weights: Record<string, number>;
  random_seed: number;
}

export interface PromiseStrategy {
  extension_hours: number;
}

export interface ScenarioParameters {
  warehouse_improvements: WarehouseImprovement[];
  pickup_improvement: PickupImprovement | null;
  carrier_mix: CarrierMixAdjustment | null;
  promise_strategy: PromiseStrategy | null;
}

export interface ScenarioRecord {
  scenario_id: string;
  name: string;
  datasets: DatasetSelection;
  timezone: string;
  parameters: ScenarioParameters;
  created_at: string;
  updated_at: string;
  definition_version: string;
}

export interface ParameterCatalogItem {
  code: string;
  display_name: string;
  business_meaning: string;
  unit: "hour" | "percentage" | "weight";
  minimum: number;
  maximum: number;
  default: number;
  impact_path: string;
  model_assumption: string;
}

export interface ParameterCatalog {
  parameters: ParameterCatalogItem[];
  supported_warehouse_nodes: Record<WarehouseNodeCode, string>;
  definition_version: string;
  estimate_label: string;
}

export interface MetricSnapshot {
  code: string;
  display_name: string;
  value: number | null;
  unit: "order" | "ratio" | "hour";
  numerator: number | null;
  denominator: number | null;
  coverage: number | null;
  warnings: string[];
}

export interface CarrierDistributionItem {
  carrier_id: string;
  order_count: number;
  share: number;
}

export interface BaselineResponse {
  datasets: DatasetSelection;
  timezone: string;
  input_fingerprint: string;
  calculated_at: string;
  metrics: MetricSnapshot[];
  carrier_distribution: CarrierDistributionItem[];
  order_count: number;
  warnings: string[];
  metrics_definition_version: string;
  definition_version: string;
  estimate_label: string;
}

export interface MetricComparison {
  code: string;
  display_name: string;
  unit: "order" | "ratio" | "hour";
  baseline_value: number | null;
  scenario_value: number | null;
  absolute_change: number | null;
  relative_change: number | null;
  baseline_numerator: number | null;
  baseline_denominator: number | null;
  scenario_numerator: number | null;
  scenario_denominator: number | null;
  baseline_coverage: number | null;
  scenario_coverage: number | null;
  warnings: string[];
}

export interface AdjustmentDetail {
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

export interface SimulationResponse {
  scenario_id: string | null;
  scenario_name: string;
  datasets: DatasetSelection;
  timezone: string;
  input_fingerprint: string;
  scenario_fingerprint: string;
  calculated_at: string;
  parameters: ScenarioParameters;
  comparisons: MetricComparison[];
  affected_order_count: number;
  total_adjustments: number;
  adjustments: AdjustmentDetail[];
  adjustments_truncated: boolean;
  adjusted_nodes: string[];
  skipped_counts: Record<string, number>;
  assumptions: string[];
  warnings: string[];
  random_seed: number | null;
  reproducible: boolean;
  metrics_definition_version: string;
  definition_version: string;
  assumptions_version: string;
  estimate_label: string;
}

export interface SensitivityPoint {
  parameter_value: number;
  otif: number | null;
  fulfillment_mean_hours: number | null;
  fulfillment_p50_hours: number | null;
  fulfillment_p90_hours: number | null;
  anomaly_rate: number | null;
  affected_order_count: number;
  warnings: string[];
}

export interface SensitivityResponse {
  parameter: SensitivityParameter;
  unit: "hour" | "percentage";
  points: SensitivityPoint[];
  input_fingerprint: string;
  warnings: string[];
  definition_version: string;
  estimate_label: string;
}
