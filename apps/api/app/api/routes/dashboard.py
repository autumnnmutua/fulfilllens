from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response

from app.core.config import Settings, get_settings
from app.dashboard.models import (
    BreakdownDimension,
    BreakdownSort,
    DashboardFilters,
    DashboardOrderPage,
    DashboardOverviewResponse,
    OrderSort,
    SortDirection,
)
from app.dashboard.service import DashboardService
from app.metrics.models import DatasetSelection

router = APIRouter(prefix="/api/dashboard", tags=["分析总览"])


def get_dashboard_service(
    settings: Annotated[Settings, Depends(get_settings)],
) -> DashboardService:
    return DashboardService(settings)


def dataset_selection(
    orders_dataset_id: Annotated[
        str,
        Query(min_length=36, max_length=36, description="已确认订单数据集 UUID。"),
    ],
    warehouse_events_dataset_id: Annotated[
        str | None,
        Query(min_length=36, max_length=36),
    ] = None,
    tracking_events_dataset_id: Annotated[
        str | None,
        Query(min_length=36, max_length=36),
    ] = None,
) -> DatasetSelection:
    return DatasetSelection(
        orders_dataset_id=orders_dataset_id,
        warehouse_events_dataset_id=warehouse_events_dataset_id,
        tracking_events_dataset_id=tracking_events_dataset_id,
    )


def dashboard_filters(
    start_date: date | None = None,
    end_date: date | None = None,
    warehouse: Annotated[list[str] | None, Query(min_length=1, max_length=128)] = None,
    carrier: Annotated[list[str] | None, Query(min_length=1, max_length=128)] = None,
    region: Annotated[list[str] | None, Query(min_length=1, max_length=128)] = None,
    status: Annotated[list[str] | None, Query(min_length=1, max_length=64)] = None,
    anomaly_type: Annotated[
        list[str] | None,
        Query(min_length=1, max_length=64),
    ] = None,
    timezone: Annotated[str, Query(min_length=1, max_length=64)] = "Asia/Shanghai",
) -> DashboardFilters:
    return DashboardFilters(
        start_date=start_date,
        end_date=end_date,
        warehouses=warehouse or [],
        carriers=carrier or [],
        regions=region or [],
        statuses=status or [],
        anomaly_types=anomaly_type or [],
        timezone=timezone,
    )


Selection = Annotated[DatasetSelection, Depends(dataset_selection)]
Filters = Annotated[DashboardFilters, Depends(dashboard_filters)]
Service = Annotated[DashboardService, Depends(get_dashboard_service)]


@router.get(
    "/overview",
    response_model=DashboardOverviewResponse,
    summary="读取筛选一致的分析总览",
    description="指标、趋势、分布、节点和维度对比使用同一订单筛选集合。",
)
def dashboard_overview(
    selection: Selection,
    filters: Filters,
    service: Service,
    grain: Annotated[str, Query(pattern="^(date|week)$")] = "date",
    dimension: BreakdownDimension = "carrier_id",
    breakdown_sort_by: BreakdownSort = "anomaly_order_rate",
    breakdown_sort_direction: SortDirection = "desc",
) -> DashboardOverviewResponse:
    return service.overview(
        selection,
        filters=filters,
        grain=grain,
        dimension=dimension,
        breakdown_sort_by=breakdown_sort_by,
        breakdown_sort_direction=breakdown_sort_direction,
    )


@router.get(
    "/orders",
    response_model=DashboardOrderPage,
    summary="分页读取筛选后的订单明细",
)
def dashboard_orders(
    selection: Selection,
    filters: Filters,
    service: Service,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
    sort_by: OrderSort = "created_at",
    sort_direction: SortDirection = "desc",
) -> DashboardOrderPage:
    return service.orders(
        selection,
        filters=filters,
        page=page,
        page_size=page_size,
        sort_by=sort_by,
        sort_direction=sort_direction,
    )


@router.get(
    "/orders.csv",
    summary="导出筛选后的安全订单明细 CSV",
)
def dashboard_orders_csv(
    selection: Selection,
    filters: Filters,
    service: Service,
    sort_by: OrderSort = "created_at",
    sort_direction: SortDirection = "desc",
) -> Response:
    return Response(
        content=service.orders_csv(
            selection,
            filters=filters,
            sort_by=sort_by,
            sort_direction=sort_direction,
        ),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": 'attachment; filename="fulfilllens-orders.csv"',
            "X-Content-Type-Options": "nosniff",
        },
    )
