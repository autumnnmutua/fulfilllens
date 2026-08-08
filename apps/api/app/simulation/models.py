from __future__ import annotations

import math
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.metrics.models import DatasetSelection

SIMULATION_DEFINITION_VERSION = "simulation-v1.0.0"
ASSUMPTIONS_VERSION = "simulation-assumptions-v1.0.0"
DEFAULT_RANDOM_SEED = 20260729
ESTIMATE_LABEL = "基于历史数据和简化假设的情景估算，不代表真实预测或保证。"

WarehouseNodeCode = Literal[
    "order_to_pick",
    "picking",
    "pick_to_qc",
    "quality_check",
    "packing",
]
ReductionMethod = Literal["fixed_hours", "percentage"]


class WarehouseImprovement(BaseModel):
    node_code: WarehouseNodeCode
    method: ReductionMethod = "fixed_hours"
    value: float = Field(default=0, ge=0)
    warehouse_ids: list[str] = Field(default_factory=list, max_length=50)

    @model_validator(mode="after")
    def validate_method_range(self) -> WarehouseImprovement:
        maximum = 72 if self.method == "fixed_hours" else 100
        if self.value > maximum:
            unit = "小时" if self.method == "fixed_hours" else "%"
            raise ValueError(f"仓内改善不得超过 {maximum}{unit}")
        return self


class PickupImprovement(BaseModel):
    reduction_hours: float = Field(default=0, ge=0, le=168)
    carrier_ids: list[str] = Field(default_factory=list, max_length=50)


class CarrierMixAdjustment(BaseModel):
    method: Literal["empirical_resample"] = "empirical_resample"
    weights: dict[str, float] = Field(default_factory=dict)
    random_seed: int = Field(default=DEFAULT_RANDOM_SEED, ge=0, le=2_147_483_647)

    @field_validator("weights")
    @classmethod
    def validate_weights(cls, weights: dict[str, float]) -> dict[str, float]:
        if not weights:
            raise ValueError("承运商结构调整至少需要一个权重")
        for carrier, weight in weights.items():
            if not carrier.strip():
                raise ValueError("承运商代码不得为空")
            if not math.isfinite(weight) or not 0 <= weight <= 100:
                raise ValueError("承运商权重必须在 0–100% 之间")
        if not math.isclose(sum(weights.values()), 100, abs_tol=1e-6):
            raise ValueError("承运商权重之和必须等于 100%")
        return weights


class PromiseStrategy(BaseModel):
    extension_hours: float = Field(default=0, ge=0, le=168)


class ScenarioParameters(BaseModel):
    warehouse_improvements: list[WarehouseImprovement] = Field(
        default_factory=list,
        max_length=5,
    )
    pickup_improvement: PickupImprovement | None = None
    carrier_mix: CarrierMixAdjustment | None = None
    promise_strategy: PromiseStrategy | None = None


class ScenarioCreate(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    datasets: DatasetSelection
    timezone: str = Field(default="Asia/Shanghai", min_length=1, max_length=64)
    parameters: ScenarioParameters = Field(default_factory=ScenarioParameters)

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("方案名称不得为空")
        return value.strip()


class ScenarioUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=64)
    parameters: ScenarioParameters | None = None

    @field_validator("name")
    @classmethod
    def strip_optional_name(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("方案名称不得为空")
        return value.strip() if value is not None else None


class ScenarioCopyRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("方案名称不得为空")
        return value.strip()


class ScenarioRecord(BaseModel):
    scenario_id: str
    name: str
    datasets: DatasetSelection
    timezone: str
    parameters: ScenarioParameters
    created_at: datetime
    updated_at: datetime
    definition_version: str = SIMULATION_DEFINITION_VERSION


class ParameterCatalogItem(BaseModel):
    code: str
    display_name: str
    business_meaning: str
    unit: Literal["hour", "percentage", "weight"]
    minimum: float
    maximum: float
    default: float
    impact_path: str
    model_assumption: str


class ParameterCatalogResponse(BaseModel):
    parameters: list[ParameterCatalogItem]
    supported_warehouse_nodes: dict[str, str]
    definition_version: str = SIMULATION_DEFINITION_VERSION
    estimate_label: str = ESTIMATE_LABEL


class SimulationRequest(BaseModel):
    datasets: DatasetSelection
    timezone: str = Field(default="Asia/Shanghai", min_length=1, max_length=64)
    scenario_id: str | None = None
    scenario_name: str = Field(default="临时方案", min_length=1, max_length=64)
    parameters: ScenarioParameters | None = None
    adjustment_detail_limit: int = Field(default=200, ge=1, le=1000)

    @model_validator(mode="after")
    def require_source(self) -> SimulationRequest:
        if self.scenario_id is None and self.parameters is None:
            raise ValueError("scenario_id 与 parameters 至少提供一个")
        if self.scenario_id is not None and self.parameters is not None:
            raise ValueError("scenario_id 与 parameters 不得同时提供")
        return self


class BaselineRequest(BaseModel):
    datasets: DatasetSelection
    timezone: str = Field(default="Asia/Shanghai", min_length=1, max_length=64)


class MetricSnapshot(BaseModel):
    code: str
    display_name: str
    value: float | int | None
    unit: Literal["order", "ratio", "hour"]
    numerator: float | int | None
    denominator: int | None
    coverage: float | None
    warnings: list[str]


class CarrierDistributionItem(BaseModel):
    carrier_id: str
    order_count: int
    share: float


class BaselineResponse(BaseModel):
    datasets: DatasetSelection
    timezone: str
    input_fingerprint: str
    calculated_at: datetime
    metrics: list[MetricSnapshot]
    carrier_distribution: list[CarrierDistributionItem]
    order_count: int
    warnings: list[str]
    metrics_definition_version: str
    definition_version: str = SIMULATION_DEFINITION_VERSION
    estimate_label: str = ESTIMATE_LABEL


class MetricComparison(BaseModel):
    code: str
    display_name: str
    unit: Literal["order", "ratio", "hour"]
    baseline_value: float | int | None
    scenario_value: float | int | None
    absolute_change: float | int | None
    relative_change: float | None
    baseline_numerator: float | int | None
    baseline_denominator: int | None
    scenario_numerator: float | int | None
    scenario_denominator: int | None
    baseline_coverage: float | None
    scenario_coverage: float | None
    warnings: list[str]


class AdjustmentDetail(BaseModel):
    transform_type: Literal[
        "warehouse_improvement",
        "pickup_improvement",
        "carrier_mix_resample",
        "promise_strategy",
    ]
    order_id: str
    source_order_id: str
    field_name: str
    node_code: str | None = None
    before_value: str | float | None
    after_value: str | float | None
    delta_hours: float | None = None
    explanation: str


class SimulationResponse(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "scenario_id": None,
                "scenario_name": "减少揽收等待",
                "estimate_label": ESTIMATE_LABEL,
                "affected_order_count": 12,
                "reproducible": True,
            }
        }
    )

    scenario_id: str | None
    scenario_name: str
    datasets: DatasetSelection
    timezone: str
    input_fingerprint: str
    scenario_fingerprint: str
    calculated_at: datetime
    parameters: ScenarioParameters
    comparisons: list[MetricComparison]
    affected_order_count: int
    total_adjustments: int
    adjustments: list[AdjustmentDetail]
    adjustments_truncated: bool
    adjusted_nodes: list[str]
    skipped_counts: dict[str, int]
    assumptions: list[str]
    warnings: list[str]
    random_seed: int | None
    reproducible: bool = True
    metrics_definition_version: str
    definition_version: str = SIMULATION_DEFINITION_VERSION
    assumptions_version: str = ASSUMPTIONS_VERSION
    estimate_label: str = ESTIMATE_LABEL


SensitivityParameter = Literal[
    "warehouse_improvement_value",
    "pickup_reduction_hours",
    "promise_extension_hours",
]


class SensitivityRequest(BaseModel):
    datasets: DatasetSelection
    timezone: str = Field(default="Asia/Shanghai", min_length=1, max_length=64)
    parameters: ScenarioParameters
    parameter: SensitivityParameter
    values: list[float] = Field(min_length=3, max_length=11)
    warehouse_improvement_index: int = Field(default=0, ge=0, le=4)

    @field_validator("values")
    @classmethod
    def validate_values(cls, values: list[float]) -> list[float]:
        if any(not math.isfinite(value) or value < 0 for value in values):
            raise ValueError("敏感性取值必须是非负有限数")
        if len(set(values)) != len(values):
            raise ValueError("敏感性取值不得重复")
        return values


class SensitivityPoint(BaseModel):
    parameter_value: float
    otif: float | None
    fulfillment_mean_hours: float | None
    fulfillment_p50_hours: float | None
    fulfillment_p90_hours: float | None
    anomaly_rate: float | None
    affected_order_count: int
    warnings: list[str]


class SensitivityResponse(BaseModel):
    parameter: SensitivityParameter
    unit: Literal["hour", "percentage"]
    points: list[SensitivityPoint]
    input_fingerprint: str
    warnings: list[str]
    definition_version: str = SIMULATION_DEFINITION_VERSION
    estimate_label: str = ESTIMATE_LABEL
