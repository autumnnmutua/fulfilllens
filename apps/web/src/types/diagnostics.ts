import type { DatasetSelection, OrderMetricDetail } from "./metrics";

export type DiagnosticCategory =
  | "warehouse_delay"
  | "pickup_delay"
  | "linehaul_long_tail"
  | "last_mile_backlog"
  | "carrier_relative"
  | "warehouse_congestion"
  | "time_concentration"
  | "data_quality";
export type DiagnosticSeverity = "critical" | "high" | "medium" | "low";
export type DiagnosticDimension =
  "warehouse" | "carrier" | "region" | "date" | "time_bucket" | "node";

export interface RuleParameter {
  display_name: string;
  value: number;
  minimum: number;
  maximum: number;
  unit: "hour" | "ratio" | "order" | "day";
}

export interface DiagnosticRule {
  rule_id: string;
  rule_version: string;
  title: string;
  category: DiagnosticCategory;
  description: string;
  severity: DiagnosticSeverity;
  priority: number;
  enabled: boolean;
  parameters: Record<string, RuleParameter>;
}

export interface DiagnosticRuleSet {
  rule_set_version: string;
  rules: DiagnosticRule[];
}

export interface RuleOverride {
  enabled?: boolean;
  parameters: Record<string, number>;
}

export interface DiagnosticRequest {
  datasets: DatasetSelection;
  timezone: string;
  rule_overrides: Record<string, RuleOverride>;
  max_evidence_per_result: number;
}

export interface DiagnosticEvidence {
  order_id: string | null;
  event_id: string | null;
  shipment_id: string | null;
  node_code: string | null;
  start_time: string | null;
  end_time: string | null;
  observed_value: number | null;
  threshold_value: number | null;
  baseline_value: number | null;
  unit: string | null;
  dimension_type: DiagnosticDimension | null;
  dimension_value: string | null;
  comparison: string;
}

export interface DiagnosticResult {
  rule_id: string;
  rule_version: string;
  merged_rule_ids: string[];
  title: string;
  category: DiagnosticCategory;
  severity: DiagnosticSeverity;
  factual_observation: string;
  rule_judgement: string;
  possible_causes: string[];
  evidence: DiagnosticEvidence[];
  affected_order_count: number;
  affected_order_sample: string[];
  coverage: number | null;
  confidence_warning: string[];
  recommended_checks: string[];
  sample_size: number;
  dimension_type: DiagnosticDimension | null;
  dimension_value: string | null;
  priority: number;
}

export interface DiagnosticContext {
  analysis_fingerprint?: string;
  analysis_source?: string;
  datasets: DatasetSelection;
  analyzed_at: string;
  order_count: number;
  valid_order_count: number;
  affected_order_count: number;
  finding_count: number;
  enabled_rule_count: number;
  triggered_rule_count: number;
  data_coverage: number | null;
  warning_count: number;
  timezone: string;
}

export interface SeveritySummary {
  severity: DiagnosticSeverity;
  finding_count: number;
  affected_order_count: number;
}

export interface ParetoItem {
  category: DiagnosticCategory;
  display_name: string;
  finding_count: number;
  affected_order_count: number;
  cumulative_share: number;
}

export interface BottleneckNode {
  node_code: string;
  display_name: string;
  mean_hours: number | null;
  p90_hours: number | null;
  threshold_hours: number | null;
  sample_size: number;
  affected_order_count: number;
  coverage: number | null;
  is_bottleneck: boolean;
}

export interface ProcessVariant {
  variant_id: string;
  sequence: string[];
  order_count: number;
  share: number;
  affected_order_count: number;
}

export interface DimensionInsight {
  dimension_type: DiagnosticDimension;
  dimension_value: string;
  finding_count: number;
  affected_order_count: number;
  highest_severity: DiagnosticSeverity;
  categories: DiagnosticCategory[];
}

export interface DiagnosticAnalysis {
  context: DiagnosticContext;
  results: DiagnosticResult[];
  severity_summary: SeveritySummary[];
  pareto: ParetoItem[];
  bottleneck_nodes: BottleneckNode[];
  process_variants: ProcessVariant[];
  dimension_insights: DimensionInsight[];
  analysis_warnings: string[];
  rule_set_version: string;
}

export interface DiagnosticOrderItem {
  order_id: string;
  order_status: string;
  warehouse_id: string;
  carrier_id: string;
  destination_region: string;
  highest_severity: DiagnosticSeverity;
  categories: DiagnosticCategory[];
  rule_ids: string[];
  finding_count: number;
}

export interface DiagnosticOrderPage {
  datasets: DatasetSelection;
  items: DiagnosticOrderItem[];
  total: number;
  page: number;
  page_size: number;
  page_count: number;
  rule_set_version: string;
}

export interface TimelineEvent {
  source: "warehouse" | "tracking";
  event_id: string;
  event_time: string;
  event_code: string;
  raw_status: string;
  shipment_id: string | null;
  location_code: string | null;
}

export interface DiagnosticOrderDetail {
  metric_detail: OrderMetricDetail;
  findings: DiagnosticResult[];
  timeline: TimelineEvent[];
  rule_set_version: string;
}

export interface DiagnosticOrderFilters {
  page: number;
  pageSize: number;
  severity: DiagnosticSeverity | null;
  category: DiagnosticCategory | null;
  ruleId: string | null;
}
