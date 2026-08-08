from typing import Literal

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    service: str
    version: str


class ContractVersions(BaseModel):
    data: str
    metrics: str
    status: str
    diagnostics: str
    simulation: str
    cases: str
    reports: str


class VersionResponse(BaseModel):
    app_name: str
    app_version: str
    api_version: str
    environment: str
    contract_versions: ContractVersions


class ErrorDetail(BaseModel):
    field: str | None = None
    message: str
    type: str | None = None


class ErrorBody(BaseModel):
    code: str
    message: str
    request_id: str
    details: list[ErrorDetail] = Field(default_factory=list)


class ErrorResponse(BaseModel):
    error: ErrorBody
