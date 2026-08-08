from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.metrics.models import (
    DatasetSelection,
    DataWarning,
    DistributionResponse,
    MetricGroup,
    MetricResult,
    OrderMetricDetail,
    TrendResponse,
)

BreakdownDimension = Literal[
    "warehouse_id",
    "carrier_id",
    "destination_region",
]
BreakdownSort = Literal[
    "order_count",
    "otif_rate",
    "fulfillment_duration_p90_hours",
    "anomaly_order_rate",
]
OrderSort = Literal[
    "order_id",
    "created_at",
    "promised_delivery_time",
    "actual_delivery_time",
    "order_status",
    "fulfillment_duration_hours",
    "otif",
    "anomaly",
]
SortDirection = Literal["asc", "desc"]


class DashboardFilters(BaseModel):
    start_date: date | None = None
    end_date: date | None = None
    warehouses: list[str] = Field(default_factory=list)
    carriers: list[str] = Field(default_factory=list)
    regions: list[str] = Field(default_factory=list)
    statuses: list[str] = Field(default_factory=list)
    anomaly_types: list[str] = Field(default_factory=list)
    timezone: str = "Asia/Shanghai"

    @field_validator(
        "warehouses",
        "carriers",
        "regions",
        "statuses",
        "anomaly_types",
    )
    @classmethod
    def normalize_multi_value(cls, values: list[str]) -> list[str]:
        normalized = list(dict.fromkeys(value.strip() for value in values if value.strip()))
        if len(normalized) > 50:
            raise ValueError("每类筛选最多允许 50 个值")
        return normalized


class FilterOption(BaseModel):
    value: str
    label: str
    count: int


class DashboardFilterOptions(BaseModel):
    minimum_date: date | None
    maximum_date: date | None
    warehouses: list[FilterOption]
    carriers: list[FilterOption]
    regions: list[FilterOption]
    statuses: list[FilterOption]
    anomaly_types: list[FilterOption]


class DashboardContext(BaseModel):
    dataset_label: str
    datasets: DatasetSelection
    time_range_start: date | None
    time_range_end: date | None
    order_count: int
    valid_order_count: int
    unfiltered_order_count: int
    data_coverage: float | None
    last_analyzed_at: datetime
    warning_count: int


class NodeDurationSummary(BaseModel):
    interval_code: str
    display_name: str
    mean_hours: float | None
    median_hours: float | None
    p90_hours: float | None
    sample_size: int
    eligible_count: int
    coverage: float | None
    is_bottleneck: bool = False
    warnings: list[str] = Field(default_factory=list)


class DashboardBreakdown(BaseModel):
    dimension: BreakdownDimension
    sort_by: BreakdownSort
    sort_direction: SortDirection
    groups: list[MetricGroup]


class DashboardOverviewResponse(BaseModel):
    context: DashboardContext
    active_filters: DashboardFilters
    filter_options: DashboardFilterOptions
    metrics: list[MetricResult]
    trend: TrendResponse
    distribution: DistributionResponse
    distribution_coverage: float | None
    nodes: list[NodeDurationSummary]
    breakdown: DashboardBreakdown
    warnings: list[DataWarning]
    warnings_truncated: bool
    definition_version: str
    rule_set_version: str


class DashboardOrderItem(OrderMetricDetail):
    anomaly_types: list[str] = Field(default_factory=list)


class DashboardOrderPage(BaseModel):
    datasets: DatasetSelection
    active_filters: DashboardFilters
    items: list[DashboardOrderItem]
    total: int
    page: int
    page_size: int
    page_count: int
    sort_by: OrderSort
    sort_direction: SortDirection
    definition_version: str
