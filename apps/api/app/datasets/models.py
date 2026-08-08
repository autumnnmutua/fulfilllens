from datetime import datetime

from pydantic import BaseModel, Field

from app.schemas.imports import DataType


class DatasetSummary(BaseModel):
    dataset_id: str
    data_type: DataType
    row_count: int = Field(ge=0)
    created_at: datetime
    source_kind: str


class DatasetListResponse(BaseModel):
    datasets: list[DatasetSummary]
    total: int = Field(ge=0)


class DatasetDeleteResponse(BaseModel):
    dataset_id: str
    data_type: DataType
    rows_deleted: int = Field(ge=0)
    scenarios_deleted: int = Field(ge=0)
    report_jobs_deleted: int = Field(ge=0)
    import_artifacts_deleted: bool
    message: str
