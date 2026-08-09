from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


class DataType(StrEnum):
    ORDERS = "orders"
    WAREHOUSE_EVENTS = "warehouse_events"
    TRACKING_EVENTS = "tracking_events"


class FileFormat(StrEnum):
    CSV = "csv"
    XLSX = "xlsx"


class ImportStatus(StrEnum):
    PENDING_UPLOAD = "pending_upload"
    PARSING = "parsing"
    AWAITING_ENCODING = "awaiting_encoding"
    AWAITING_SHEET = "awaiting_sheet"
    AWAITING_MAPPING = "awaiting_mapping"
    VALIDATION_FAILED = "validation_failed"
    READY_TO_CONFIRM = "ready_to_confirm"
    ANALYZABLE = "analyzable"
    CANCELLED = "cancelled"


STATUS_LABELS: dict[ImportStatus, str] = {
    ImportStatus.PENDING_UPLOAD: "待上传",
    ImportStatus.PARSING: "解析中",
    ImportStatus.AWAITING_ENCODING: "待选择编码",
    ImportStatus.AWAITING_SHEET: "待选择工作表",
    ImportStatus.AWAITING_MAPPING: "待映射",
    ImportStatus.VALIDATION_FAILED: "校验失败",
    ImportStatus.READY_TO_CONFIRM: "待确认导入",
    ImportStatus.ANALYZABLE: "可分析",
    ImportStatus.CANCELLED: "已取消",
}


class IssueSeverity(StrEnum):
    ERROR = "error"
    WARNING = "warning"
    INFO = "info"


class SheetInfo(BaseModel):
    name: str
    state: str


class ImportTaskResponse(BaseModel):
    task_id: str
    data_type: DataType
    status: ImportStatus
    status_label: str
    file_name: str
    file_format: FileFormat
    created_at: datetime
    updated_at: datetime
    encoding: str | None = None
    encoding_required: bool = False
    encoding_options: list[str] = Field(default_factory=list)
    sheets: list[SheetInfo] = Field(default_factory=list)
    selected_sheet: str | None = None
    default_timezone: str | None = None
    message: str
    can_reconfigure: bool = True


class UploadResponse(BaseModel):
    task: ImportTaskResponse


class ParseRequest(BaseModel):
    encoding: str | None = None
    sheet_name: str | None = None


class FieldCandidate(BaseModel):
    field: str
    label: str
    confidence: float = Field(ge=0, le=1)
    method: str


class FieldSuggestion(BaseModel):
    source_column: str
    suggested_field: str | None = None
    confidence: float = Field(ge=0, le=1)
    method: str
    candidates: list[FieldCandidate] = Field(default_factory=list)


class DataTypeCandidate(BaseModel):
    data_type: DataType
    display_name: str
    confidence: float = Field(ge=0, le=1)
    matched_fields: list[str] = Field(default_factory=list)
    missing_required_fields: list[str] = Field(default_factory=list)


class FieldDefinition(BaseModel):
    field: str
    label: str
    required: bool
    value_type: str
    aliases: list[str]


class SensitiveRisk(BaseModel):
    source_column: str
    categories: list[str]
    detection_basis: str
    non_empty_count: int
    message: str


class PreviewRow(BaseModel):
    row_number: int
    values: dict[str, Any]


class ParseResponse(BaseModel):
    task: ImportTaskResponse
    fields: list[FieldDefinition]
    source_columns: list[str]
    preview_rows: list[PreviewRow]
    total_rows: int
    suggestions: list[FieldSuggestion]
    sensitive_risks: list[SensitiveRisk]
    warnings: list[str] = Field(default_factory=list)
    detected_data_type: DataType
    detection_confidence: float = Field(ge=0, le=1)
    data_type_candidates: list[DataTypeCandidate] = Field(default_factory=list)
    unmapped_source_columns: list[str] = Field(default_factory=list)
    conversion_notes: list[str] = Field(default_factory=list)


class ValidationRequest(BaseModel):
    mapping: dict[str, str | None]
    ignored_source_columns: list[str] = Field(default_factory=list)
    default_timezone: str | None = None
    project_status_mappings: dict[str, str] = Field(default_factory=dict)
    save_project_status_mappings: bool = True


class QualityIssue(BaseModel):
    issue_id: str
    severity: IssueSeverity
    code: str
    message: str
    sheet: str | None = None
    row_number: int | None = None
    source_column: str | None = None
    target_field: str | None = None
    raw_value: str | None = None
    suggestion: str


class StatusNormalizationSummary(BaseModel):
    raw_status: str
    normalized_status: str
    mapping_source: str
    mapping_confidence: float = Field(ge=0, le=1)
    occurrences: int


class QualityReport(BaseModel):
    total_rows: int
    valid_rows: int
    error_rows: int
    warning_rows: int
    null_counts: dict[str, int]
    duplicate_keys: int
    invalid_times: int
    time_order_conflicts: int
    negative_quantities: int
    unknown_statuses: int
    long_text_values: int
    unparseable_values: int
    exact_duplicate_rows: int
    ignored_source_columns: list[str] = Field(default_factory=list)
    unresolved_source_columns: list[str] = Field(default_factory=list)
    sensitive_risks: list[SensitiveRisk]
    status_normalizations: list[StatusNormalizationSummary]
    issues: list[QualityIssue]
    can_confirm: bool


class ValidationResponse(BaseModel):
    task: ImportTaskResponse
    report: QualityReport
    normalized_preview: list[dict[str, Any]]


class ConfirmResponse(BaseModel):
    task: ImportTaskResponse
    dataset_id: str
    imported_rows: int
    message: str


class SyntheticImportRequest(BaseModel):
    data_type: DataType


class CompatibilitySample(BaseModel):
    sample_id: str
    display_name: str
    file_name: str
    file_format: FileFormat
    default_data_type: DataType
    default_sheet: str | None = None
    sheet_names: list[str] = Field(default_factory=list)
    row_counts: dict[str, int]
    purpose: str
    conversion_features: list[str]
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    privacy_statement: str


class CompatibilitySampleCatalog(BaseModel):
    samples: list[CompatibilitySample]
    privacy_statement: str
