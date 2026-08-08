from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field

from app.metrics.models import DatasetSelection

CASE_GENERATOR_VERSION = "case-generator-v1.0.0"
CASE_CONTRACT_VERSION = "teaching-cases-v1.0.0"


class CaseId(StrEnum):
    NORMAL_OPERATIONS = "normal_operations"
    PROMOTION_SURGE = "promotion_surge"
    CARRIER_DISRUPTION = "carrier_disruption"


class MetricRange(BaseModel):
    minimum: float
    maximum: float
    unit: str


class ExpectedFinding(BaseModel):
    rule_id: str
    description: str
    required: bool = True


class CaseFile(BaseModel):
    name: Literal[
        "orders.csv",
        "warehouse_events.csv",
        "tracking_events.csv",
        "case.xlsx",
        "metadata.json",
    ]
    media_type: str
    size_bytes: int = Field(ge=0)


class CaseMetadata(BaseModel):
    case_id: CaseId
    display_name: str
    business_background: str
    generator_version: str
    seed: int
    timezone: Literal["Asia/Shanghai"] = "Asia/Shanghai"
    order_count: int = Field(gt=0)
    date_range: dict[str, str]
    row_counts: dict[str, int]
    injected_anomalies: list[str]
    expected_findings: list[ExpectedFinding]
    expected_metric_ranges: dict[str, MetricRange]
    learning_objectives: list[str]
    privacy_statement: str
    content_fingerprint: str
    files: list[CaseFile] = Field(default_factory=list)


class CaseCatalogResponse(BaseModel):
    cases: list[CaseMetadata]
    generator_version: str = CASE_GENERATOR_VERSION
    privacy_statement: str


class CaseLoadResponse(BaseModel):
    case: CaseMetadata
    datasets: DatasetSelection
    replaced_current_context: Literal[True] = True
    prior_datasets_retained: Literal[True] = True
    message: str
