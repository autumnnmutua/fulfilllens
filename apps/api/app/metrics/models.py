from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

DEFINITION_VERSION = "metrics-v1.1.0"
RULE_SET_VERSION = "metric-baseline-rules-v1.0.0"
TAXONOMY_VERSION = "status-v1.0-draft"

DecisionStatus = Literal[
    "true",
    "false",
    "not_computable",
    "pending",
    "excluded",
]


class MetricResult(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "code": "otif_rate",
                "display_name": "按时足量交付率",
                "value": 0.75,
                "unit": "ratio",
                "numerator": 3,
                "denominator": 4,
                "coverage": 0.8,
                "eligible_count": 5,
                "computable_count": 4,
                "pending_count": 1,
                "not_computable_count": 1,
                "definition_version": DEFINITION_VERSION,
                "warnings": ["样本量小于 30，结果仅用于核查。"],
            }
        }
    )

    code: str
    display_name: str
    value: float | int | None
    unit: Literal["order", "ratio", "hour"]
    numerator: float | int | None
    denominator: int | None
    coverage: float | None
    eligible_count: int
    computable_count: int
    pending_count: int = 0
    not_computable_count: int = 0
    definition_version: str = DEFINITION_VERSION
    warnings: list[str] = Field(default_factory=list)

    @field_validator("value", "numerator", "coverage")
    @classmethod
    def reject_non_finite(cls, value: float | int | None) -> float | int | None:
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError("指标响应不得包含 NaN 或 Infinity")
        return value


class DataWarning(BaseModel):
    code: str
    message: str
    order_id: str | None = None
    event_id: str | None = None
    interval_code: str | None = None


class Decision(BaseModel):
    status: DecisionStatus
    value: bool | None = None
    reason: str


class NodeDuration(BaseModel):
    interval_code: str
    display_name: str
    duration_hours: float
    start_time: str
    end_time: str
    shipment_id: str | None = None
    location_code: str | None = None


class OrderMetricDetail(BaseModel):
    order_id: str
    order_status: str
    created_at: str | None
    promised_delivery_time: str | None
    actual_delivery_time: str | None
    ordered_quantity: float | int | None
    delivered_quantity: float | int | None
    quantity_unit: str | None
    warehouse_id: str
    carrier_id: str
    destination_region: str
    sales_channel: str
    ot: Decision
    in_full: Decision
    otif: Decision
    fulfillment_duration_hours: float | None
    anomaly: bool
    anomaly_reasons: list[str]
    node_durations: list[NodeDuration]
    warnings: list[DataWarning]
    definition_version: str = DEFINITION_VERSION
    rule_set_version: str = RULE_SET_VERSION


class DatasetSelection(BaseModel):
    orders_dataset_id: str
    warehouse_events_dataset_id: str | None = None
    tracking_events_dataset_id: str | None = None


class MetricsSummaryResponse(BaseModel):
    datasets: DatasetSelection
    metrics: list[MetricResult]
    warnings: list[DataWarning]
    definition_version: str = DEFINITION_VERSION
    taxonomy_version: str = TAXONOMY_VERSION
    rule_set_version: str = RULE_SET_VERSION


class MetricGroup(BaseModel):
    key: str
    label: str
    metrics: list[MetricResult]
    order_count: int
    warnings: list[str] = Field(default_factory=list)


class TrendResponse(BaseModel):
    datasets: DatasetSelection
    grain: Literal["date", "week"]
    timezone: str
    groups: list[MetricGroup]
    definition_version: str = DEFINITION_VERSION


class BreakdownResponse(BaseModel):
    datasets: DatasetSelection
    dimension: Literal[
        "warehouse_id",
        "carrier_id",
        "destination_region",
        "sales_channel",
    ]
    groups: list[MetricGroup]
    definition_version: str = DEFINITION_VERSION


class DistributionBin(BaseModel):
    lower_bound: float
    upper_bound: float
    count: int
    includes_upper_bound: bool = False


class DistributionResponse(BaseModel):
    datasets: DatasetSelection
    metric_code: str
    unit: Literal["hour"]
    sample_size: int
    minimum: float | None
    maximum: float | None
    mean: float | None
    median: float | None
    p90: float | None
    quantile_method: str = "Hyndman-Fan Type 7 / linear"
    bins: list[DistributionBin]
    warnings: list[str]
    definition_version: str = DEFINITION_VERSION
