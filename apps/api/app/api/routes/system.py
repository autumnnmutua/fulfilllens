from typing import Annotated

from fastapi import APIRouter, Depends

from app.cases.models import CASE_CONTRACT_VERSION
from app.core.config import Settings, get_settings
from app.diagnostics.models import DIAGNOSTIC_RULE_SET_VERSION
from app.metrics.models import DEFINITION_VERSION
from app.reports.models import REPORT_CONTRACT_VERSION
from app.schemas.system import (
    ContractVersions,
    HealthResponse,
    VersionResponse,
)
from app.simulation.models import SIMULATION_DEFINITION_VERSION

router = APIRouter(tags=["系统"])


@router.get(
    "/health",
    response_model=HealthResponse,
    summary="本地 API 健康检查",
)
async def health(
    settings: Annotated[Settings, Depends(get_settings)],
) -> HealthResponse:
    return HealthResponse(
        service="fulfilllens-api",
        version=settings.app_version,
    )


@router.get(
    "/api/version",
    response_model=VersionResponse,
    summary="应用与契约版本",
)
async def version(
    settings: Annotated[Settings, Depends(get_settings)],
) -> VersionResponse:
    return VersionResponse(
        app_name=settings.app_name,
        app_version=settings.app_version,
        api_version=settings.api_version,
        environment=settings.environment,
        contract_versions=ContractVersions(
            data="data-contract-v1.0-draft",
            metrics=DEFINITION_VERSION,
            status="status-v1.0-draft",
            diagnostics=DIAGNOSTIC_RULE_SET_VERSION,
            simulation=SIMULATION_DEFINITION_VERSION,
            cases=CASE_CONTRACT_VERSION,
            reports=REPORT_CONTRACT_VERSION,
        ),
    )
