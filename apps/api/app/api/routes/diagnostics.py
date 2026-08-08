from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query

from app.core.config import Settings, get_settings
from app.diagnostics.models import (
    DiagnosticAnalysisResponse,
    DiagnosticCategory,
    DiagnosticOrderDetail,
    DiagnosticOrderPage,
    DiagnosticRequest,
    DiagnosticRuleSet,
    Severity,
)
from app.diagnostics.service import DiagnosticsService

router = APIRouter(prefix="/api/diagnostics", tags=["流程瓶颈与异常诊断"])


def get_diagnostics_service(
    settings: Annotated[Settings, Depends(get_settings)],
) -> DiagnosticsService:
    return DiagnosticsService(settings)


Service = Annotated[DiagnosticsService, Depends(get_diagnostics_service)]


@router.get(
    "/rules",
    response_model=DiagnosticRuleSet,
    summary="读取默认诊断规则与可调整参数",
)
def diagnostic_rules(service: Service) -> DiagnosticRuleSet:
    return service.rules()


@router.post(
    "/analyze",
    response_model=DiagnosticAnalysisResponse,
    summary="执行可解释诊断",
    description=("所有结果由版本化透明规则生成，事实、规则判断、可能原因和建议核查分层返回。"),
)
def analyze_diagnostics(
    request: DiagnosticRequest,
    service: Service,
) -> DiagnosticAnalysisResponse:
    return service.analysis(request)


@router.post(
    "/orders/search",
    response_model=DiagnosticOrderPage,
    summary="分页读取受影响订单",
)
def diagnostic_orders(
    request: DiagnosticRequest,
    service: Service,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
    severity: Severity | None = None,
    category: DiagnosticCategory | None = None,
    rule_id: Annotated[str | None, Query(min_length=1, max_length=64)] = None,
) -> DiagnosticOrderPage:
    return service.orders(
        request,
        page=page,
        page_size=page_size,
        severity=severity,
        category=category,
        rule_id=rule_id,
    )


@router.post(
    "/orders/{order_id}",
    response_model=DiagnosticOrderDetail,
    summary="读取诊断订单的完整证据时间线",
)
def diagnostic_order_detail(
    request: DiagnosticRequest,
    service: Service,
    order_id: Annotated[str, Path(min_length=1, max_length=128)],
) -> DiagnosticOrderDetail:
    return service.order_detail(request, order_id=order_id)
