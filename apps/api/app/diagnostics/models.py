from __future__ import annotations

import math
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.metrics.models import DatasetSelection, OrderMetricDetail

DIAGNOSTIC_RULE_SET_VERSION = "diagnostics-v1.0.0"

DiagnosticCategory = Literal[
    "warehouse_delay",
    "pickup_delay",
    "linehaul_long_tail",
    "last_mile_backlog",
    "carrier_relative",
    "warehouse_congestion",
    "time_concentration",
    "data_quality",
]
Severity = Literal["critical", "high", "medium", "low"]
DimensionType = Literal["warehouse", "carrier", "region", "date", "time_bucket", "node"]


class RuleParameter(BaseModel):
    display_name: str
    value: float
    minimum: float
    maximum: float
    unit: Literal["hour", "ratio", "order", "day"]

    @field_validator("value", "minimum", "maximum")
    @classmethod
    def finite(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("规则参数必须为有限数值")
        return value


class DiagnosticRule(BaseModel):
    rule_id: str
    rule_version: str
    title: str
    category: DiagnosticCategory
    description: str
    severity: Severity
    priority: int = Field(ge=0, le=1000)
    enabled: bool
    parameters: dict[str, RuleParameter]


class DiagnosticRuleSet(BaseModel):
    rule_set_version: str
    rules: list[DiagnosticRule]


class RuleOverride(BaseModel):
    enabled: bool | None = None
    parameters: dict[str, float] = Field(default_factory=dict)

    @field_validator("parameters")
    @classmethod
    def finite_parameters(cls, parameters: dict[str, float]) -> dict[str, float]:
        if any(not math.isfinite(value) for value in parameters.values()):
            raise ValueError("规则覆盖参数必须为有限数值")
        return parameters


class DiagnosticRequest(BaseModel):
    datasets: DatasetSelection
    timezone: str = Field(default="Asia/Shanghai", min_length=1, max_length=64)
    rule_overrides: dict[str, RuleOverride] = Field(default_factory=dict)
    max_evidence_per_result: int = Field(default=20, ge=1, le=100)


class DiagnosticEvidence(BaseModel):
    order_id: str | None = None
    event_id: str | None = None
    shipment_id: str | None = None
    node_code: str | None = None
    start_time: str | None = None
    end_time: str | None = None
    observed_value: float | None = None
    threshold_value: float | None = None
    baseline_value: float | None = None
    unit: str | None = None
    dimension_type: DimensionType | None = None
    dimension_value: str | None = None
    comparison: str

    @field_validator("observed_value", "threshold_value", "baseline_value")
    @classmethod
    def reject_non_finite(cls, value: float | None) -> float | None:
        if value is not None and not math.isfinite(value):
            raise ValueError("诊断证据不得包含 NaN 或 Infinity")
        return value


class DiagnosticResult(BaseModel):
    rule_id: str
    rule_version: str
    merged_rule_ids: list[str] = Field(default_factory=list)
    title: str
    category: DiagnosticCategory
    severity: Severity
    factual_observation: str
    rule_judgement: str
    possible_causes: list[str]
    evidence: list[DiagnosticEvidence]
    affected_order_count: int = Field(ge=0)
    affected_order_sample: list[str] = Field(default_factory=list)
    coverage: float | None
    confidence_warning: list[str]
    recommended_checks: list[str]
    sample_size: int = Field(ge=0)
    dimension_type: DimensionType | None = None
    dimension_value: str | None = None
    priority: int = Field(ge=0)

    @field_validator("coverage")
    @classmethod
    def valid_coverage(cls, value: float | None) -> float | None:
        if value is not None and (not math.isfinite(value) or not 0 <= value <= 1):
            raise ValueError("覆盖率必须在 0 到 1 之间")
        return value


class SeveritySummary(BaseModel):
    severity: Severity
    finding_count: int
    affected_order_count: int


class ParetoItem(BaseModel):
    category: DiagnosticCategory
    display_name: str
    finding_count: int
    affected_order_count: int
    cumulative_share: float


class BottleneckNode(BaseModel):
    node_code: str
    display_name: str
    mean_hours: float | None
    p90_hours: float | None
    threshold_hours: float | None
    sample_size: int
    affected_order_count: int
    coverage: float | None
    is_bottleneck: bool


class ProcessVariant(BaseModel):
    variant_id: str
    sequence: list[str]
    order_count: int
    share: float
    affected_order_count: int


class DimensionInsight(BaseModel):
    dimension_type: DimensionType
    dimension_value: str
    finding_count: int
    affected_order_count: int
    highest_severity: Severity
    categories: list[DiagnosticCategory]


class DiagnosticContext(BaseModel):
    datasets: DatasetSelection
    analyzed_at: datetime
    order_count: int
    valid_order_count: int
    affected_order_count: int
    finding_count: int
    enabled_rule_count: int
    triggered_rule_count: int
    data_coverage: float | None
    warning_count: int
    timezone: str


class DiagnosticAnalysisResponse(BaseModel):
    context: DiagnosticContext
    results: list[DiagnosticResult]
    severity_summary: list[SeveritySummary]
    pareto: list[ParetoItem]
    bottleneck_nodes: list[BottleneckNode]
    process_variants: list[ProcessVariant]
    dimension_insights: list[DimensionInsight]
    analysis_warnings: list[str]
    rule_set_version: str = DIAGNOSTIC_RULE_SET_VERSION


class DiagnosticOrderItem(BaseModel):
    order_id: str
    order_status: str
    warehouse_id: str
    carrier_id: str
    destination_region: str
    highest_severity: Severity
    categories: list[DiagnosticCategory]
    rule_ids: list[str]
    finding_count: int


class DiagnosticOrderPage(BaseModel):
    datasets: DatasetSelection
    items: list[DiagnosticOrderItem]
    total: int
    page: int
    page_size: int
    page_count: int
    rule_set_version: str = DIAGNOSTIC_RULE_SET_VERSION


class TimelineEvent(BaseModel):
    source: Literal["warehouse", "tracking"]
    event_id: str
    event_time: str
    event_code: str
    raw_status: str
    shipment_id: str | None = None
    location_code: str | None = None


class DiagnosticOrderDetail(BaseModel):
    metric_detail: OrderMetricDetail
    findings: list[DiagnosticResult]
    timeline: list[TimelineEvent]
    rule_set_version: str = DIAGNOSTIC_RULE_SET_VERSION
