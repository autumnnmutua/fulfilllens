from __future__ import annotations

import csv
import io
import math
from collections import Counter
from datetime import UTC, date, datetime
from typing import Any, cast
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.core.config import Settings
from app.core.errors import AppError
from app.dashboard.models import (
    BreakdownDimension,
    BreakdownSort,
    DashboardBreakdown,
    DashboardContext,
    DashboardFilterOptions,
    DashboardFilters,
    DashboardOrderItem,
    DashboardOrderPage,
    DashboardOverviewResponse,
    FilterOption,
    NodeDurationSummary,
    OrderSort,
    SortDirection,
)
from app.imports.security import escape_csv_formula
from app.metrics.engine import (
    NODE_LABELS,
    EngineOutput,
    breakdown,
    build_metrics,
    distribution,
    parse_time,
    subset_output,
    trend,
)
from app.metrics.models import (
    DEFINITION_VERSION,
    RULE_SET_VERSION,
    DatasetSelection,
    MetricGroup,
    MetricResult,
    OrderMetricDetail,
)
from app.metrics.service import MetricsService

STATUS_LABELS = {
    "created": "已创建",
    "confirmed": "已确认",
    "processing": "处理中",
    "shipped": "已发货",
    "delivered": "已交付",
    "cancelled": "已取消",
    "returned": "已退回",
    "unmapped": "未映射",
}
ANOMALY_LABELS = {
    "returned_order": "退回订单",
    "partial_delivery": "部分交付",
    "warehouse_quality_failure": "仓库质检失败",
    "tracking_exception": "物流异常事件",
}
MAX_DASHBOARD_WARNINGS = 100


def metric_by_code(metrics: list[MetricResult], code: str) -> MetricResult | None:
    return next((metric for metric in metrics if metric.code == code), None)


def anomaly_types(detail: OrderMetricDetail) -> list[str]:
    result: list[str] = []
    for reason in detail.anomaly_reasons:
        if "returned" in reason:
            result.append("returned_order")
        if "部分交付" in reason:
            result.append("partial_delivery")
        if "quality_check_failed" in reason:
            result.append("warehouse_quality_failure")
        if "物流事件命中" in reason:
            result.append("tracking_exception")
    return list(dict.fromkeys(result))


def option_list(
    counter: Counter[str],
    *,
    labels: dict[str, str] | None = None,
) -> list[FilterOption]:
    return [
        FilterOption(
            value=value,
            label=(labels or {}).get(value, "未知" if value == "unknown" else value),
            count=count,
        )
        for value, count in sorted(counter.items(), key=lambda item: (-item[1], item[0]))
    ]


class DashboardService:
    def __init__(self, settings: Settings) -> None:
        self.metrics = MetricsService(settings)

    @staticmethod
    def _timezone(timezone_name: str) -> ZoneInfo:
        try:
            return ZoneInfo(timezone_name)
        except ZoneInfoNotFoundError as error:
            raise AppError(
                code="INVALID_DASHBOARD_FILTER",
                message="筛选时区不是有效的 IANA 时区。",
                status_code=422,
            ) from error

    def _filter_output(
        self,
        output: EngineOutput,
        filters: DashboardFilters,
    ) -> EngineOutput:
        if (
            filters.start_date is not None
            and filters.end_date is not None
            and filters.start_date > filters.end_date
        ):
            raise AppError(
                code="INVALID_DASHBOARD_FILTER",
                message="开始日期不能晚于结束日期。",
                status_code=422,
            )
        timezone = self._timezone(filters.timezone)
        order_ids: set[str] = set()
        for evaluation in output.evaluations:
            detail = evaluation.detail
            created = parse_time(detail.created_at)
            local_date = created.astimezone(timezone).date() if created is not None else None
            if filters.start_date is not None and (
                local_date is None or local_date < filters.start_date
            ):
                continue
            if filters.end_date is not None and (
                local_date is None or local_date > filters.end_date
            ):
                continue
            if filters.warehouses and detail.warehouse_id not in filters.warehouses:
                continue
            if filters.carriers and detail.carrier_id not in filters.carriers:
                continue
            if filters.regions and detail.destination_region not in filters.regions:
                continue
            if filters.statuses and detail.order_status not in filters.statuses:
                continue
            if filters.anomaly_types and not (
                set(filters.anomaly_types) & set(anomaly_types(detail))
            ):
                continue
            order_ids.add(detail.order_id)

        filters_are_active = any(
            (
                filters.start_date,
                filters.end_date,
                filters.warehouses,
                filters.carriers,
                filters.regions,
                filters.statuses,
                filters.anomaly_types,
            )
        )
        return subset_output(output, order_ids) if filters_are_active else output

    def filtered_order_ids(
        self,
        selection: DatasetSelection,
        *,
        filters: DashboardFilters,
    ) -> set[str]:
        output = self._filter_output(self.metrics.evaluate_selection(selection), filters)
        return {evaluation.detail.order_id for evaluation in output.evaluations}

    def _filter_options(
        self,
        output: EngineOutput,
        *,
        timezone_name: str,
    ) -> DashboardFilterOptions:
        timezone = self._timezone(timezone_name)
        dates: list[date] = []
        warehouses: Counter[str] = Counter()
        carriers: Counter[str] = Counter()
        regions: Counter[str] = Counter()
        statuses: Counter[str] = Counter()
        anomalies: Counter[str] = Counter()
        for evaluation in output.evaluations:
            detail = evaluation.detail
            created = parse_time(detail.created_at)
            if created is not None:
                dates.append(created.astimezone(timezone).date())
            warehouses[detail.warehouse_id] += 1
            carriers[detail.carrier_id] += 1
            regions[detail.destination_region] += 1
            statuses[detail.order_status] += 1
            anomalies.update(anomaly_types(detail))
        return DashboardFilterOptions(
            minimum_date=min(dates) if dates else None,
            maximum_date=max(dates) if dates else None,
            warehouses=option_list(warehouses),
            carriers=option_list(carriers),
            regions=option_list(regions),
            statuses=option_list(statuses, labels=STATUS_LABELS),
            anomaly_types=option_list(anomalies, labels=ANOMALY_LABELS),
        )

    def _time_range(
        self,
        output: EngineOutput,
        *,
        timezone_name: str,
    ) -> tuple[date | None, date | None]:
        timezone = self._timezone(timezone_name)
        dates = [
            parsed.astimezone(timezone).date()
            for evaluation in output.evaluations
            if (parsed := parse_time(evaluation.detail.created_at)) is not None
        ]
        return (min(dates), max(dates)) if dates else (None, None)

    @staticmethod
    def _nodes(metrics: list[MetricResult]) -> list[NodeDurationSummary]:
        nodes: list[NodeDurationSummary] = []
        for interval_code, display_name in NODE_LABELS.items():
            mean = metric_by_code(
                metrics,
                f"node_duration_{interval_code}_mean_hours",
            )
            median = metric_by_code(
                metrics,
                f"node_duration_{interval_code}_median_hours",
            )
            p90 = metric_by_code(
                metrics,
                f"node_duration_{interval_code}_p90_hours",
            )
            if mean is None or median is None or p90 is None:
                continue
            nodes.append(
                NodeDurationSummary(
                    interval_code=interval_code,
                    display_name=display_name,
                    mean_hours=cast(float | None, mean.value),
                    median_hours=cast(float | None, median.value),
                    p90_hours=cast(float | None, p90.value),
                    sample_size=p90.computable_count,
                    eligible_count=p90.eligible_count,
                    coverage=p90.coverage,
                    warnings=p90.warnings,
                )
            )
        comparable = [node for node in nodes if node.p90_hours is not None]
        if comparable:
            bottleneck = max(comparable, key=lambda node: cast(float, node.p90_hours))
            bottleneck.is_bottleneck = True
        return nodes

    @staticmethod
    def _sort_breakdown(
        groups: list[MetricGroup],
        *,
        sort_by: BreakdownSort,
        sort_direction: SortDirection,
    ) -> list[MetricGroup]:
        def value(group: MetricGroup) -> float | None:
            if sort_by == "order_count":
                return float(group.order_count)
            metric = metric_by_code(group.metrics, sort_by)
            if metric is None or metric.value is None:
                return None
            return float(metric.value)

        available = [group for group in groups if value(group) is not None]
        missing = [group for group in groups if value(group) is None]
        available.sort(
            key=lambda group: (cast(float, value(group)), group.label),
            reverse=sort_direction == "desc",
        )
        return [*available, *sorted(missing, key=lambda group: group.label)]

    def overview_with_order_ids(
        self,
        selection: DatasetSelection,
        *,
        filters: DashboardFilters,
        grain: str,
        dimension: BreakdownDimension,
        breakdown_sort_by: BreakdownSort,
        breakdown_sort_direction: SortDirection,
    ) -> tuple[DashboardOverviewResponse, set[str]]:
        if grain not in {"date", "week"}:
            raise AppError(
                code="INVALID_DASHBOARD_PARAMETER",
                message="趋势粒度仅支持 date 或 week。",
                status_code=422,
            )
        base_output = self.metrics.evaluate_selection(selection)
        output = self._filter_output(base_output, filters)
        metrics = build_metrics(output)
        time_start, time_end = self._time_range(output, timezone_name=filters.timezone)
        duration_metric = metric_by_code(metrics, "fulfillment_duration_mean_hours")
        coverage_metric = metric_by_code(metrics, "data_coverage_rate")
        valid_metric = metric_by_code(metrics, "valid_order_count")
        breakdown_response = breakdown(
            output,
            dimension=dimension,
            datasets=selection,
        )
        sorted_groups = self._sort_breakdown(
            breakdown_response.groups,
            sort_by=breakdown_sort_by,
            sort_direction=breakdown_sort_direction,
        )
        warnings = output.warnings[:MAX_DASHBOARD_WARNINGS]
        response = DashboardOverviewResponse(
            context=DashboardContext(
                dataset_label=f"订单数据集 {selection.orders_dataset_id[:8]}",
                datasets=selection,
                time_range_start=time_start,
                time_range_end=time_end,
                order_count=output.total_unique_orders,
                valid_order_count=int(valid_metric.value or 0) if valid_metric else 0,
                unfiltered_order_count=base_output.total_unique_orders,
                data_coverage=(
                    float(coverage_metric.value)
                    if coverage_metric is not None and coverage_metric.value is not None
                    else None
                ),
                last_analyzed_at=datetime.now(UTC),
                warning_count=len(output.warnings),
                unique_order_count=base_output.total_unique_orders,
                analyzed_entity_count=output.total_unique_orders,
                unfiltered_analyzed_entity_count=base_output.total_unique_orders,
                analysis_entity_label="订单",
            ),
            active_filters=filters,
            filter_options=self._filter_options(
                base_output,
                timezone_name=filters.timezone,
            ),
            metrics=metrics,
            trend=trend(
                output,
                grain=cast(Any, grain),
                timezone_name=filters.timezone,
                datasets=selection,
            ),
            distribution=distribution(
                output,
                metric_code="fulfillment_duration_hours",
                bin_count=10,
                datasets=selection,
            ),
            distribution_coverage=duration_metric.coverage if duration_metric else None,
            nodes=self._nodes(metrics),
            breakdown=DashboardBreakdown(
                dimension=dimension,
                sort_by=breakdown_sort_by,
                sort_direction=breakdown_sort_direction,
                groups=sorted_groups,
            ),
            warnings=warnings,
            warnings_truncated=len(output.warnings) > len(warnings),
            definition_version=DEFINITION_VERSION,
            rule_set_version=RULE_SET_VERSION,
        )
        return response, {evaluation.detail.order_id for evaluation in output.evaluations}

    def overview(
        self,
        selection: DatasetSelection,
        *,
        filters: DashboardFilters,
        grain: str,
        dimension: BreakdownDimension,
        breakdown_sort_by: BreakdownSort,
        breakdown_sort_direction: SortDirection,
    ) -> DashboardOverviewResponse:
        response, _ = self.overview_with_order_ids(
            selection,
            filters=filters,
            grain=grain,
            dimension=dimension,
            breakdown_sort_by=breakdown_sort_by,
            breakdown_sort_direction=breakdown_sort_direction,
        )
        return response

    @staticmethod
    def _sort_value(detail: OrderMetricDetail, sort_by: OrderSort) -> Any:
        if sort_by in {
            "created_at",
            "promised_delivery_time",
            "actual_delivery_time",
        }:
            parsed = parse_time(getattr(detail, sort_by))
            return parsed.timestamp() if parsed is not None else None
        if sort_by == "otif":
            ordering = {
                "false": 0,
                "not_computable": 1,
                "pending": 2,
                "excluded": 3,
                "true": 4,
            }
            return ordering[detail.otif.status]
        if sort_by == "anomaly":
            return int(detail.anomaly)
        return getattr(detail, sort_by)

    def _sorted_details(
        self,
        output: EngineOutput,
        *,
        sort_by: OrderSort,
        sort_direction: SortDirection,
    ) -> list[OrderMetricDetail]:
        details = [evaluation.detail for evaluation in output.evaluations]

        def key(detail: OrderMetricDetail) -> tuple[bool, Any, str]:
            value = self._sort_value(detail, sort_by)
            return (value is None, value, detail.order_id)

        non_missing = [
            detail for detail in details if self._sort_value(detail, sort_by) is not None
        ]
        missing = [detail for detail in details if self._sort_value(detail, sort_by) is None]
        non_missing.sort(key=key, reverse=sort_direction == "desc")
        missing.sort(key=lambda detail: detail.order_id)
        return [*non_missing, *missing]

    def orders(
        self,
        selection: DatasetSelection,
        *,
        filters: DashboardFilters,
        page: int,
        page_size: int,
        sort_by: OrderSort,
        sort_direction: SortDirection,
    ) -> DashboardOrderPage:
        output = self._filter_output(
            self.metrics.evaluate_selection(selection),
            filters,
        )
        details = self._sorted_details(
            output,
            sort_by=sort_by,
            sort_direction=sort_direction,
        )
        total = len(details)
        page_count = math.ceil(total / page_size) if total else 0
        start = (page - 1) * page_size
        items = [
            DashboardOrderItem(
                **detail.model_dump(),
                anomaly_types=anomaly_types(detail),
            )
            for detail in details[start : start + page_size]
        ]
        return DashboardOrderPage(
            datasets=selection,
            active_filters=filters,
            items=items,
            total=total,
            page=page,
            page_size=page_size,
            page_count=page_count,
            sort_by=sort_by,
            sort_direction=sort_direction,
            definition_version=DEFINITION_VERSION,
        )

    def orders_csv(
        self,
        selection: DatasetSelection,
        *,
        filters: DashboardFilters,
        sort_by: OrderSort,
        sort_direction: SortDirection,
    ) -> bytes:
        output = self._filter_output(
            self.metrics.evaluate_selection(selection),
            filters,
        )
        details = self._sorted_details(
            output,
            sort_by=sort_by,
            sort_direction=sort_direction,
        )
        buffer = io.StringIO(newline="")
        writer = csv.writer(buffer, lineterminator="\r\n")
        writer.writerow(
            [
                "订单编号",
                "订单状态",
                "下单时间",
                "承诺送达时间",
                "实际送达时间",
                "仓库",
                "承运商",
                "目的地区",
                "OT",
                "IF",
                "OTIF",
                "履约时长（小时）",
                "是否异常",
                "异常类型",
                "异常证据",
                "口径版本",
            ]
        )
        for detail in details:
            row = [
                detail.order_id,
                detail.order_status,
                detail.created_at,
                detail.promised_delivery_time,
                detail.actual_delivery_time,
                detail.warehouse_id,
                detail.carrier_id,
                detail.destination_region,
                detail.ot.status,
                detail.in_full.status,
                detail.otif.status,
                detail.fulfillment_duration_hours,
                "是" if detail.anomaly else "否",
                "；".join(anomaly_types(detail)),
                "；".join(detail.anomaly_reasons),
                detail.definition_version,
            ]
            writer.writerow([escape_csv_formula(value) for value in row])
        return ("\ufeff" + buffer.getvalue()).encode("utf-8")
