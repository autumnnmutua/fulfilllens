from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.core.config import Settings, get_settings
from app.metrics.models import (
    BreakdownResponse,
    DatasetSelection,
    DistributionResponse,
    MetricsSummaryResponse,
    OrderMetricDetail,
    TrendResponse,
)
from app.metrics.service import MetricsService

router = APIRouter(prefix="/api/metrics", tags=["履约指标"])

DatasetId = Annotated[
    str,
    Query(
        min_length=36,
        max_length=36,
        description="已确认订单数据集的 UUID。",
        examples=["11111111-1111-4111-8111-111111111111"],
    ),
]
OptionalDatasetId = Annotated[
    str | None,
    Query(
        min_length=36,
        max_length=36,
        description="可选事件数据集 UUID；省略时相关节点指标无样本。",
    ),
]


def get_metrics_service(
    settings: Annotated[Settings, Depends(get_settings)],
) -> MetricsService:
    return MetricsService(settings)


def dataset_selection(
    orders_dataset_id: DatasetId,
    warehouse_events_dataset_id: OptionalDatasetId = None,
    tracking_events_dataset_id: OptionalDatasetId = None,
) -> DatasetSelection:
    return DatasetSelection(
        orders_dataset_id=orders_dataset_id,
        warehouse_events_dataset_id=warehouse_events_dataset_id,
        tracking_events_dataset_id=tracking_events_dataset_id,
    )


Selection = Annotated[DatasetSelection, Depends(dataset_selection)]
Service = Annotated[MetricsService, Depends(get_metrics_service)]


@router.get(
    "/summary",
    response_model=MetricsSummaryResponse,
    summary="计算总体履约指标",
    description="所有成功率在订单粒度计算，并返回分子、分母、覆盖率、版本和警告。",
)
def metrics_summary(
    selection: Selection,
    service: Service,
) -> MetricsSummaryResponse:
    return service.summary(selection)


@router.get(
    "/trend",
    response_model=TrendResponse,
    summary="按日期或周重新计算指标",
)
def metrics_trend(
    selection: Selection,
    service: Service,
    grain: Annotated[str, Query(pattern="^(date|week)$")] = "date",
    timezone_name: Annotated[
        str,
        Query(alias="timezone", min_length=1, max_length=64),
    ] = "Asia/Shanghai",
) -> TrendResponse:
    return service.trend(
        selection,
        grain=grain,
        timezone_name=timezone_name,
    )


@router.get(
    "/distribution",
    response_model=DistributionResponse,
    summary="读取履约或节点时长分布",
)
def metrics_distribution(
    selection: Selection,
    service: Service,
    metric_code: Annotated[
        str,
        Query(
            description=("`fulfillment_duration_hours` 或 `node_duration_<interval_code>_hours`。")
        ),
    ] = "fulfillment_duration_hours",
    bin_count: Annotated[int, Query(ge=1, le=50)] = 10,
) -> DistributionResponse:
    return service.distribution(
        selection,
        metric_code=metric_code,
        bin_count=bin_count,
    )


@router.get(
    "/breakdown",
    response_model=BreakdownResponse,
    summary="按业务维度重新计算指标",
)
def metrics_breakdown(
    selection: Selection,
    service: Service,
    dimension: Annotated[
        str,
        Query(pattern=("^(warehouse_id|carrier_id|destination_region|sales_channel)$")),
    ] = "warehouse_id",
) -> BreakdownResponse:
    return service.breakdown(selection, dimension=dimension)


@router.get(
    "/orders/{order_id}",
    response_model=OrderMetricDetail,
    summary="读取订单级判定和证据",
)
def metrics_order_detail(
    order_id: str,
    selection: Selection,
    service: Service,
) -> OrderMetricDetail:
    return service.order_detail(selection, order_id=order_id)
