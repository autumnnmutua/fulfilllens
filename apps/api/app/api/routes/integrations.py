import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends, Header

from app.core.config import Settings, get_settings
from app.core.errors import AppError
from app.integrations.cloudflare_workers_ai import CloudflareWorkersAIClient
from app.schemas.integrations import WorkersAIProbeResponse, WorkersAIStatusResponse

router = APIRouter(prefix="/api/integrations/workers-ai", tags=["可选外部连接"])


@router.get(
    "/status",
    response_model=WorkersAIStatusResponse,
    summary="查看 Workers AI 脱敏配置状态",
)
def workers_ai_status(
    settings: Annotated[Settings, Depends(get_settings)],
) -> WorkersAIStatusResponse:
    configured = (
        settings.cloudflare_account_id is not None and settings.cloudflare_api_token is not None
    )
    return WorkersAIStatusResponse(
        enabled=settings.workers_ai_enabled,
        configured=configured,
        model=settings.workers_ai_model,
    )


@router.post(
    "/probe",
    response_model=WorkersAIProbeResponse,
    summary="显式执行 Workers AI 合成连接探针",
    description=(
        "只发送仓库固定的无个人信息短句；不会读取或发送订单、仓库事件和物流轨迹。"
        "调用方必须显式提供确认请求头。"
    ),
)
async def workers_ai_probe(
    settings: Annotated[Settings, Depends(get_settings)],
    external_call_confirmation: Annotated[
        str | None,
        Header(alias="X-FulfillLens-External-Call"),
    ] = None,
) -> WorkersAIProbeResponse:
    if external_call_confirmation != "confirm":
        raise AppError(
            code="EXTERNAL_CALL_CONFIRMATION_REQUIRED",
            message="执行外部连接探针前必须显式确认。",
            status_code=403,
        )
    client = CloudflareWorkersAIClient(settings)
    return await asyncio.to_thread(client.probe)
