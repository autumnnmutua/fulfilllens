from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.dashboard.models import BreakdownDimension, DashboardFilters
from app.metrics.models import DatasetSelection
from app.recommendations.models import RecommendationBundle
from app.simulation.models import ScenarioParameters

REPORT_CONTRACT_VERSION = "report-v1.0.0"
REPORT_RENDERER_VERSION = "report-renderer-v1.0.0"

ReportSectionCode = Literal[
    "executive_summary",
    "data_quality",
    "metrics_overview",
    "trend",
    "node_duration",
    "dimension_breakdown",
    "diagnostics",
    "recommendations",
    "order_samples",
    "simulation",
    "methods_limits",
]
ReportFormat = Literal["markdown", "html", "csv"]
ReportReadingMode = Literal["standard", "guided"]
CsvExportKind = Literal[
    "anomaly_orders",
    "data_quality_errors",
    "status_mapping",
    "metric_detail",
    "simulation_comparison",
]
ReportJobStatus = Literal[
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
]

DEFAULT_REPORT_SECTIONS: list[ReportSectionCode] = [
    "executive_summary",
    "data_quality",
    "metrics_overview",
    "trend",
    "node_duration",
    "dimension_breakdown",
    "diagnostics",
    "recommendations",
    "order_samples",
    "simulation",
    "methods_limits",
]


class ReportSimulationSelection(BaseModel):
    scenario_id: str | None = Field(default=None, min_length=36, max_length=36)
    scenario_name: str = Field(default="报告情景方案", min_length=1, max_length=64)
    parameters: ScenarioParameters | None = None

    @model_validator(mode="after")
    def exactly_one_source(self) -> ReportSimulationSelection:
        if (self.scenario_id is None) == (self.parameters is None):
            raise ValueError("模拟章节必须且只能选择已保存方案或提供临时参数")
        return self


class ReportRequest(BaseModel):
    datasets: DatasetSelection
    dataset_name: str = Field(default="当前履约数据集", min_length=1, max_length=80)
    filters: DashboardFilters = Field(default_factory=DashboardFilters)
    trend_grain: Literal["date", "week"] = "date"
    breakdown_dimension: BreakdownDimension = "carrier_id"
    sections: list[ReportSectionCode] = Field(
        default_factory=lambda: DEFAULT_REPORT_SECTIONS.copy(),
        min_length=1,
        max_length=len(DEFAULT_REPORT_SECTIONS),
    )
    order_sample_limit: int = Field(default=20, ge=1, le=100)
    include_order_identifiers: bool = False
    sensitive_export_confirmed: bool = False
    reading_mode: ReportReadingMode = "standard"
    simulation: ReportSimulationSelection | None = None

    @field_validator("dataset_name")
    @classmethod
    def clean_dataset_name(cls, value: str) -> str:
        cleaned = " ".join(value.split())
        if not cleaned:
            raise ValueError("数据集名称不得为空")
        return cleaned

    @field_validator("sections")
    @classmethod
    def unique_sections(cls, values: list[ReportSectionCode]) -> list[ReportSectionCode]:
        if len(values) != len(set(values)):
            raise ValueError("报告章节不得重复")
        return values

    @model_validator(mode="after")
    def require_sensitive_confirmation(self) -> ReportRequest:
        if self.include_order_identifiers and not self.sensitive_export_confirmed:
            raise ValueError("包含订单标识前必须完成二次确认")
        return self


class ReportHeader(BaseModel):
    title: str
    dataset_name: str
    time_range_start: str | None
    time_range_end: str | None
    order_count: int
    valid_order_count: int
    data_coverage: float | None
    generated_at: datetime
    timezone: str
    metrics_definition_version: str
    diagnostic_rule_version: str
    simulation_version: str
    report_version: str = REPORT_CONTRACT_VERSION
    renderer_version: str = REPORT_RENDERER_VERSION
    synthetic_data: bool = False


class ReportSection(BaseModel):
    code: ReportSectionCode
    title: str
    narrative: list[str] = Field(default_factory=list)
    data: dict[str, Any] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)


class ReportReadingGuideItem(BaseModel):
    term: str
    meaning: str
    direction: str
    caution: str
    requires_context: bool = False


class ReportDocument(BaseModel):
    header: ReportHeader
    filters: DashboardFilters
    executive_summary: list[str]
    recommendations: RecommendationBundle
    sections: list[ReportSection]
    warnings: list[str]
    source_notes: list[str]
    chart_map: list[dict[str, str]]
    identifier_policy: str
    reading_mode: ReportReadingMode
    reading_guide: list[ReportReadingGuideItem] = Field(default_factory=list)
    contract_version: str = REPORT_CONTRACT_VERSION


class ReportCapabilities(BaseModel):
    supported_formats: list[ReportFormat]
    csv_export_kinds: list[CsvExportKind]
    pdf_available: bool
    pdf_reason: str
    max_export_bytes: int
    contract_version: str = REPORT_CONTRACT_VERSION


class ReportExportRequest(BaseModel):
    report: ReportRequest
    format: ReportFormat
    csv_kind: CsvExportKind | None = None

    @model_validator(mode="after")
    def validate_format(self) -> ReportExportRequest:
        if self.format == "csv" and self.csv_kind is None:
            raise ValueError("CSV 导出必须指定数据类型")
        if self.format != "csv" and self.csv_kind is not None:
            raise ValueError("只有 CSV 导出可以指定 csv_kind")
        return self


class ReportJob(BaseModel):
    job_id: str
    status: ReportJobStatus
    progress: int = Field(ge=0, le=100)
    message: str
    format: ReportFormat
    csv_kind: CsvExportKind | None
    created_at: datetime
    updated_at: datetime
    file_name: str | None = None
    media_type: str | None = None
    size_bytes: int | None = None
    error_code: str | None = None
    download_ready: bool = False
