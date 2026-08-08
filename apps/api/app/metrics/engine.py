from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.metrics.models import (
    BreakdownResponse,
    DataWarning,
    Decision,
    DistributionBin,
    DistributionResponse,
    MetricGroup,
    MetricResult,
    NodeDuration,
    OrderMetricDetail,
    TrendResponse,
)

UNKNOWN_DIMENSION = "unknown"
COMPLETED_STATUSES = {"delivered", "returned"}
PENDING_STATUSES = {"created", "confirmed", "processing", "shipped", "unmapped"}
TRACKING_ANOMALY_CODES = {
    "delivery_failed",
    "exception",
    "return_initiated",
    "returned",
}
WAREHOUSE_ANOMALY_CODES = {"quality_check_failed"}
SMALL_SAMPLE_THRESHOLD = 30

NODE_LABELS = {
    "order_to_pick": "接单后等待拣货",
    "picking": "拣货处理",
    "pick_to_qc": "拣货后等待复核",
    "quality_check": "复核处理",
    "packing": "打包处理",
    "ready_to_pickup": "出库/揽收等待",
    "carrier_transit": "承运运输",
    "hub_dwell": "枢纽停留",
}
WAREHOUSE_INTERVALS = {
    "order_to_pick": ("order_received", "picking_started"),
    "picking": ("picking_started", "picking_completed"),
    "pick_to_qc": ("picking_completed", "quality_check_started"),
    "quality_check": ("quality_check_started", "quality_check_completed"),
    "packing": ("packing_started", "packing_completed"),
}


@dataclass(frozen=True)
class PreparedEvent:
    event_id: str
    order_id: str
    event_code: str
    event_time: datetime
    raw: dict[str, Any]
    source_index: int


@dataclass
class Evaluation:
    order: dict[str, Any]
    detail: OrderMetricDetail


@dataclass
class EngineOutput:
    evaluations: list[Evaluation]
    total_unique_orders: int
    invalid_order_count: int
    warnings: list[DataWarning]
    interval_eligible_orders: dict[str, set[str]] = field(default_factory=dict)


def parse_time(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(UTC)


def finite_number(value: object) -> float | int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def ratio(numerator: int, denominator: int) -> float | None:
    return numerator / denominator if denominator else None


def quantile_type7(values: Sequence[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * q
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] + fraction * (ordered[upper] - ordered[lower])


def average(values: Sequence[float]) -> float | None:
    return sum(values) / len(values) if values else None


def common_warnings(sample_size: int, coverage: float | None) -> list[str]:
    warnings: list[str] = []
    if sample_size == 0:
        warnings.append("无符合条件且可计算的样本。")
    elif sample_size < SMALL_SAMPLE_THRESHOLD:
        warnings.append("样本量小于 30，结果仅用于核查。")
    if coverage is not None and coverage < 0.8:
        warnings.append("数据覆盖率低于 80%，结论可能不稳定。")
    return warnings


def dimension_value(order: dict[str, Any], field_name: str) -> str:
    value = order.get(field_name)
    if value is None or not str(value).strip():
        return UNKNOWN_DIMENSION
    return str(value)


def prepare_orders(
    rows: Sequence[dict[str, Any]],
) -> tuple[list[dict[str, Any]], int, int, list[DataWarning]]:
    grouped: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    warnings: list[DataWarning] = []
    missing_ids = 0
    for row in rows:
        order_id = row.get("order_id")
        if order_id is None or not str(order_id).strip():
            missing_ids += 1
            warnings.append(
                DataWarning(
                    code="ORDER_ID_MISSING",
                    message="订单缺少 order_id，无法进入订单指标。",
                )
            )
            continue
        grouped[str(order_id)].append(row)

    prepared: list[dict[str, Any]] = []
    conflicts = 0
    for order_id, group in grouped.items():
        first = group[0]
        if all(row == first for row in group[1:]):
            prepared.append(first)
            if len(group) > 1:
                warnings.append(
                    DataWarning(
                        code="EXACT_DUPLICATE_ORDER",
                        message="完全重复订单只计算一次。",
                        order_id=order_id,
                    )
                )
            continue
        conflicts += 1
        warnings.append(
            DataWarning(
                code="DUPLICATE_ORDER_CONFLICT",
                message="同一订单号存在冲突记录，整单从指标中隔离。",
                order_id=order_id,
            )
        )
    return prepared, len(grouped) + missing_ids, conflicts + missing_ids, warnings


def prepare_events(
    rows: Sequence[dict[str, Any]],
    *,
    id_field: str,
    valid_order_ids: set[str],
    created_by_order: dict[str, datetime],
) -> tuple[list[PreparedEvent], list[DataWarning]]:
    id_groups: defaultdict[str, list[tuple[int, dict[str, Any]]]] = defaultdict(list)
    warnings: list[DataWarning] = []
    for index, row in enumerate(rows):
        event_id = row.get(id_field)
        if event_id is None or not str(event_id).strip():
            warnings.append(
                DataWarning(
                    code="EVENT_ID_MISSING",
                    message=f"事件缺少 {id_field}，已从节点计算隔离。",
                    order_id=str(row.get("order_id") or "") or None,
                )
            )
            continue
        id_groups[str(event_id)].append((index, row))

    deduplicated: list[tuple[int, dict[str, Any]]] = []
    for event_id, group in id_groups.items():
        first = group[0][1]
        if not all(row == first for _, row in group[1:]):
            warnings.append(
                DataWarning(
                    code="DUPLICATE_EVENT_CONFLICT",
                    message="同一事件主键存在冲突，相关记录已隔离。",
                    order_id=str(first.get("order_id") or "") or None,
                    event_id=event_id,
                )
            )
            continue
        deduplicated.append(group[0])
        if len(group) > 1:
            warnings.append(
                DataWarning(
                    code="EXACT_DUPLICATE_EVENT",
                    message="完全重复事件只保留一条。",
                    order_id=str(first.get("order_id") or "") or None,
                    event_id=event_id,
                )
            )

    previous_source_time: dict[tuple[str, str], datetime] = {}
    prepared: list[PreparedEvent] = []
    for source_index, row in sorted(deduplicated, key=lambda item: item[0]):
        event_id = str(row[id_field])
        order_id = str(row.get("order_id") or "")
        shipment_id = str(row.get("shipment_id") or "")
        event_time = parse_time(row.get("event_time"))
        if order_id not in valid_order_ids:
            warnings.append(
                DataWarning(
                    code="ORPHAN_EVENT",
                    message="事件无法关联有效订单，未进入订单指标。",
                    order_id=order_id or None,
                    event_id=event_id,
                )
            )
            continue
        if event_time is None:
            warnings.append(
                DataWarning(
                    code="INVALID_EVENT_TIME",
                    message="事件时间非法或缺少时区，未进入节点计算。",
                    order_id=order_id,
                    event_id=event_id,
                )
            )
            continue
        created_at = created_by_order.get(order_id)
        if created_at is not None and event_time < created_at:
            warnings.append(
                DataWarning(
                    code="EVENT_BEFORE_ORDER_CREATED",
                    message="事件早于订单创建时间，未进入节点计算。",
                    order_id=order_id,
                    event_id=event_id,
                )
            )
            continue
        group_key = (order_id, shipment_id)
        previous = previous_source_time.get(group_key)
        if previous is not None and event_time < previous:
            warnings.append(
                DataWarning(
                    code="SOURCE_EVENT_OUT_OF_ORDER",
                    message="源文件事件顺序倒置；计算前已按 UTC 时间稳定排序。",
                    order_id=order_id,
                    event_id=event_id,
                )
            )
        previous_source_time[group_key] = event_time
        prepared.append(
            PreparedEvent(
                event_id=event_id,
                order_id=order_id,
                event_code=str(row.get("event_code") or "unmapped"),
                event_time=event_time,
                raw=row,
                source_index=source_index,
            )
        )

    scan_groups: defaultdict[tuple[str, str, datetime, str, str], list[PreparedEvent]] = (
        defaultdict(list)
    )
    for event in prepared:
        scan_groups[
            (
                event.order_id,
                event.event_code,
                event.event_time,
                str(event.raw.get("shipment_id") or ""),
                str(event.raw.get("location_code") or ""),
            )
        ].append(event)
    for duplicate_scan in scan_groups.values():
        if len(duplicate_scan) > 1:
            warnings.append(
                DataWarning(
                    code="POSSIBLE_DUPLICATE_SCAN",
                    message="不同事件主键具有相同节点、时间和上下文，记录保留但需核查。",
                    order_id=duplicate_scan[0].order_id,
                    event_id=duplicate_scan[0].event_id,
                )
            )
    prepared.sort(
        key=lambda item: (
            item.order_id,
            item.event_time,
            finite_number(item.raw.get("sequence_number")) or 0,
            item.source_index,
            item.event_id,
        )
    )
    return prepared, warnings


def first_interval(
    events: Sequence[PreparedEvent],
    *,
    interval_code: str,
    start_code: str,
    end_code: str,
    shipment_id: str | None = None,
    location_code: str | None = None,
) -> tuple[NodeDuration | None, bool, list[DataWarning]]:
    relevant = [event for event in events if event.event_code in {start_code, end_code}]
    if not relevant:
        return None, False, []
    warnings: list[DataWarning] = []
    starts = [event for event in relevant if event.event_code == start_code]
    ends = [event for event in relevant if event.event_code == end_code]
    order_id = relevant[0].order_id
    if not starts or not ends:
        warnings.append(
            DataWarning(
                code="NODE_BOUNDARY_MISSING",
                message=f"{NODE_LABELS[interval_code]}缺少开始或结束事件。",
                order_id=order_id,
                interval_code=interval_code,
            )
        )
        return None, True, warnings
    if ends[0].event_time < starts[0].event_time:
        warnings.append(
            DataWarning(
                code="NODE_END_BEFORE_START",
                message=f"{NODE_LABELS[interval_code]}存在结束早于开始的事件。",
                order_id=order_id,
                interval_code=interval_code,
            )
        )
    pair: tuple[PreparedEvent, PreparedEvent] | None = None
    for start in starts:
        end = next(
            (candidate for candidate in ends if candidate.event_time >= start.event_time),
            None,
        )
        if end is not None:
            pair = (start, end)
            break
    if pair is None:
        return None, True, warnings
    if len(starts) > 1 or len(ends) > 1:
        warnings.append(
            DataWarning(
                code="MULTIPLE_NODE_CYCLES",
                message=f"{NODE_LABELS[interval_code]}出现多次，第一条完整有效区间用于指标。",
                order_id=order_id,
                interval_code=interval_code,
            )
        )
    start, end = pair
    duration = (end.event_time - start.event_time).total_seconds() / 3600
    return (
        NodeDuration(
            interval_code=interval_code,
            display_name=NODE_LABELS[interval_code],
            duration_hours=duration,
            start_time=start.event_time.isoformat(),
            end_time=end.event_time.isoformat(),
            shipment_id=shipment_id,
            location_code=location_code,
        ),
        True,
        warnings,
    )


def evaluate(
    orders: Sequence[dict[str, Any]],
    warehouse_events: Sequence[dict[str, Any]] = (),
    tracking_events: Sequence[dict[str, Any]] = (),
) -> EngineOutput:
    prepared_orders, total_orders, invalid_count, warnings = prepare_orders(orders)
    valid_order_ids = {str(order["order_id"]) for order in prepared_orders}
    created_by_order = {
        str(order["order_id"]): created
        for order in prepared_orders
        if (created := parse_time(order.get("created_at"))) is not None
    }
    prepared_warehouse, warehouse_warnings = prepare_events(
        warehouse_events,
        id_field="event_id",
        valid_order_ids=valid_order_ids,
        created_by_order=created_by_order,
    )
    prepared_tracking, tracking_warnings = prepare_events(
        tracking_events,
        id_field="tracking_event_id",
        valid_order_ids=valid_order_ids,
        created_by_order=created_by_order,
    )
    warnings.extend(warehouse_warnings)
    warnings.extend(tracking_warnings)

    warehouse_by_order: defaultdict[str, list[PreparedEvent]] = defaultdict(list)
    tracking_by_order: defaultdict[str, list[PreparedEvent]] = defaultdict(list)
    for event in prepared_warehouse:
        warehouse_by_order[event.order_id].append(event)
    for event in prepared_tracking:
        tracking_by_order[event.order_id].append(event)

    interval_eligible: dict[str, set[str]] = {code: set() for code in NODE_LABELS}
    evaluations: list[Evaluation] = []
    for order in prepared_orders:
        order_id = str(order["order_id"])
        status = str(order.get("order_status") or "unmapped")
        created = parse_time(order.get("created_at"))
        promised = parse_time(order.get("promised_delivery_time"))
        actual = parse_time(order.get("actual_delivery_time"))
        ordered_quantity = finite_number(order.get("ordered_quantity"))
        delivered_quantity = finite_number(order.get("delivered_quantity"))

        if status in COMPLETED_STATUSES:
            if promised is None or actual is None:
                ot = Decision(
                    status="not_computable",
                    reason="完成订单缺少有效承诺时间或实际交付时间。",
                )
            else:
                value = actual <= promised
                ot = Decision(
                    status="true" if value else "false",
                    value=value,
                    reason="实际交付时间不晚于承诺时间。"
                    if value
                    else "实际交付时间晚于承诺时间。",
                )
            if (
                ordered_quantity is None
                or delivered_quantity is None
                or not str(order.get("quantity_unit") or "").strip()
            ):
                in_full = Decision(
                    status="not_computable",
                    reason="完成订单缺少有效订购数量、交付数量或数量单位。",
                )
            else:
                value = delivered_quantity >= ordered_quantity
                in_full = Decision(
                    status="true" if value else "false",
                    value=value,
                    reason="累计交付数量达到订购数量。" if value else "累计交付数量不足。",
                )
            if ot.value is None or in_full.value is None:
                otif = Decision(
                    status="not_computable",
                    reason="OT 或 IF 至少一项不可计算。",
                )
            else:
                value = ot.value and in_full.value
                otif = Decision(
                    status="true" if value else "false",
                    value=value,
                    reason="同时满足按时和足量。" if value else "未同时满足按时和足量。",
                )
        elif status == "cancelled":
            excluded_reason = "取消订单不进入 OT、IF 和 OTIF 分母。"
            ot = Decision(status="excluded", reason=excluded_reason)
            in_full = Decision(status="excluded", reason=excluded_reason)
            otif = Decision(status="excluded", reason=excluded_reason)
        else:
            pending_reason = "订单尚未完成交付，不进入完成订单分母。"
            ot = Decision(status="pending", reason=pending_reason)
            in_full = Decision(status="pending", reason=pending_reason)
            otif = Decision(status="pending", reason=pending_reason)

        duration: float | None = None
        detail_warnings: list[DataWarning] = []
        if status in COMPLETED_STATUSES and created is not None and actual is not None:
            if actual >= created:
                duration = (actual - created).total_seconds() / 3600
            else:
                detail_warnings.append(
                    DataWarning(
                        code="NEGATIVE_FULFILLMENT_DURATION",
                        message="实际交付时间早于订单创建时间，时长不可计算。",
                        order_id=order_id,
                    )
                )

        node_durations: list[NodeDuration] = []
        warehouse_order_events = warehouse_by_order[order_id]
        tracking_order_events = tracking_by_order[order_id]
        for interval_code, (start_code, end_code) in WAREHOUSE_INTERVALS.items():
            node, eligible, node_warnings = first_interval(
                warehouse_order_events,
                interval_code=interval_code,
                start_code=start_code,
                end_code=end_code,
            )
            if eligible:
                interval_eligible[interval_code].add(order_id)
            if node is not None:
                node_durations.append(node)
            detail_warnings.extend(node_warnings)

        ready_events = [
            *[event for event in warehouse_order_events if event.event_code == "ready_to_ship"],
            *[event for event in tracking_order_events if event.event_code == "carrier_picked_up"],
        ]
        ready_events.sort(key=lambda event: event.event_time)
        node, eligible, node_warnings = first_interval(
            ready_events,
            interval_code="ready_to_pickup",
            start_code="ready_to_ship",
            end_code="carrier_picked_up",
        )
        if eligible:
            interval_eligible["ready_to_pickup"].add(order_id)
        if node is not None:
            node_durations.append(node)
        detail_warnings.extend(node_warnings)

        shipments: defaultdict[str, list[PreparedEvent]] = defaultdict(list)
        for event in tracking_order_events:
            shipments[str(event.raw.get("shipment_id") or UNKNOWN_DIMENSION)].append(event)
        for shipment_id, shipment_events in shipments.items():
            node, eligible, node_warnings = first_interval(
                shipment_events,
                interval_code="carrier_transit",
                start_code="carrier_picked_up",
                end_code="delivered",
                shipment_id=shipment_id,
            )
            if eligible:
                interval_eligible["carrier_transit"].add(order_id)
            if node is not None:
                node_durations.append(node)
            detail_warnings.extend(node_warnings)

            hub_groups: defaultdict[str, list[PreparedEvent]] = defaultdict(list)
            for event in shipment_events:
                if event.event_code in {"arrived_at_hub", "departed_hub"}:
                    hub_groups[str(event.raw.get("location_code") or UNKNOWN_DIMENSION)].append(
                        event
                    )
            for location_code, hub_events in hub_groups.items():
                node, eligible, node_warnings = first_interval(
                    hub_events,
                    interval_code="hub_dwell",
                    start_code="arrived_at_hub",
                    end_code="departed_hub",
                    shipment_id=shipment_id,
                    location_code=location_code,
                )
                if eligible:
                    interval_eligible["hub_dwell"].add(order_id)
                if node is not None:
                    node_durations.append(node)
                detail_warnings.extend(node_warnings)

        anomaly_reasons: list[str] = []
        if status == "returned":
            anomaly_reasons.append("订单状态为 returned。")
        if (
            status in COMPLETED_STATUSES
            and ordered_quantity is not None
            and delivered_quantity is not None
            and delivered_quantity < ordered_quantity
        ):
            anomaly_reasons.append("完成订单存在部分交付。")
        if any(event.event_code in WAREHOUSE_ANOMALY_CODES for event in warehouse_order_events):
            anomaly_reasons.append("仓库事件命中 quality_check_failed。")
        tracking_codes = {
            event.event_code
            for event in tracking_order_events
            if event.event_code in TRACKING_ANOMALY_CODES
        }
        if tracking_codes:
            anomaly_reasons.append(f"物流事件命中：{', '.join(sorted(tracking_codes))}。")
        detail_warnings.extend(warning for warning in warnings if warning.order_id == order_id)
        detail_warnings = [
            *{
                (
                    warning.code,
                    warning.order_id,
                    warning.event_id,
                    warning.interval_code,
                    warning.message,
                ): warning
                for warning in detail_warnings
            }.values()
        ]
        detail = OrderMetricDetail(
            order_id=order_id,
            order_status=status,
            created_at=order.get("created_at"),
            promised_delivery_time=order.get("promised_delivery_time"),
            actual_delivery_time=order.get("actual_delivery_time"),
            ordered_quantity=ordered_quantity,
            delivered_quantity=delivered_quantity,
            quantity_unit=(
                str(order["quantity_unit"]) if order.get("quantity_unit") is not None else None
            ),
            warehouse_id=dimension_value(order, "warehouse_id"),
            carrier_id=dimension_value(order, "carrier_id"),
            destination_region=dimension_value(order, "destination_region"),
            sales_channel=dimension_value(order, "sales_channel"),
            ot=ot,
            in_full=in_full,
            otif=otif,
            fulfillment_duration_hours=duration,
            anomaly=bool(anomaly_reasons),
            anomaly_reasons=anomaly_reasons,
            node_durations=node_durations,
            warnings=detail_warnings,
        )
        evaluations.append(Evaluation(order=order, detail=detail))
    warnings.extend(warning for evaluation in evaluations for warning in evaluation.detail.warnings)
    return EngineOutput(
        evaluations=evaluations,
        total_unique_orders=total_orders,
        invalid_order_count=invalid_count,
        warnings=[
            *{
                (
                    warning.code,
                    warning.order_id,
                    warning.event_id,
                    warning.interval_code,
                    warning.message,
                ): warning
                for warning in warnings
            }.values()
        ],
        interval_eligible_orders=interval_eligible,
    )


def decision_metric(
    evaluations: Sequence[Evaluation],
    *,
    attribute: Literal["ot", "in_full", "otif"],
    code: str,
    display_name: str,
) -> MetricResult:
    decisions = [getattr(evaluation.detail, attribute) for evaluation in evaluations]
    eligible = [
        decision for decision in decisions if decision.status not in {"pending", "excluded"}
    ]
    computable = [decision for decision in eligible if decision.status in {"true", "false"}]
    numerator = sum(decision.status == "true" for decision in computable)
    coverage = ratio(len(computable), len(eligible))
    return MetricResult(
        code=code,
        display_name=display_name,
        value=ratio(numerator, len(computable)),
        unit="ratio",
        numerator=numerator,
        denominator=len(computable),
        coverage=coverage,
        eligible_count=len(eligible),
        computable_count=len(computable),
        pending_count=sum(decision.status == "pending" for decision in decisions),
        not_computable_count=sum(decision.status == "not_computable" for decision in decisions),
        warnings=common_warnings(len(computable), coverage),
    )


def duration_metrics(evaluations: Sequence[Evaluation]) -> list[MetricResult]:
    eligible = [
        evaluation
        for evaluation in evaluations
        if evaluation.detail.order_status in COMPLETED_STATUSES
    ]
    values = [
        evaluation.detail.fulfillment_duration_hours
        for evaluation in eligible
        if evaluation.detail.fulfillment_duration_hours is not None
    ]
    coverage = ratio(len(values), len(eligible))
    warnings = common_warnings(len(values), coverage)
    return [
        MetricResult(
            code="fulfillment_duration_mean_hours",
            display_name="平均履约时长",
            value=average(values),
            unit="hour",
            numerator=sum(values) if values else None,
            denominator=len(values),
            coverage=coverage,
            eligible_count=len(eligible),
            computable_count=len(values),
            pending_count=sum(
                evaluation.detail.order_status in PENDING_STATUSES for evaluation in evaluations
            ),
            not_computable_count=len(eligible) - len(values),
            warnings=warnings,
        ),
        MetricResult(
            code="fulfillment_duration_median_hours",
            display_name="中位履约时长",
            value=quantile_type7(values, 0.5),
            unit="hour",
            numerator=None,
            denominator=len(values),
            coverage=coverage,
            eligible_count=len(eligible),
            computable_count=len(values),
            not_computable_count=len(eligible) - len(values),
            warnings=warnings,
        ),
        MetricResult(
            code="fulfillment_duration_p90_hours",
            display_name="P90 履约时长",
            value=quantile_type7(values, 0.9),
            unit="hour",
            numerator=None,
            denominator=len(values),
            coverage=coverage,
            eligible_count=len(eligible),
            computable_count=len(values),
            not_computable_count=len(eligible) - len(values),
            warnings=warnings,
        ),
    ]


def node_metrics(output: EngineOutput) -> list[MetricResult]:
    results: list[MetricResult] = []
    statistic_labels = {"mean": "平均", "median": "中位", "p90": "P90"}
    for interval_code, display_name in NODE_LABELS.items():
        values = [
            node.duration_hours
            for evaluation in output.evaluations
            for node in evaluation.detail.node_durations
            if node.interval_code == interval_code
        ]
        eligible = len(output.interval_eligible_orders[interval_code])
        computable_orders = {
            evaluation.detail.order_id
            for evaluation in output.evaluations
            if any(node.interval_code == interval_code for node in evaluation.detail.node_durations)
        }
        coverage = ratio(len(computable_orders), eligible)
        warning_messages = common_warnings(len(values), coverage)
        for statistic, value, numerator in (
            ("mean", average(values), sum(values) if values else None),
            ("median", quantile_type7(values, 0.5), None),
            ("p90", quantile_type7(values, 0.9), None),
        ):
            results.append(
                MetricResult(
                    code=f"node_duration_{interval_code}_{statistic}_hours",
                    display_name=(f"{display_name}{statistic_labels[statistic]}时长"),
                    value=value,
                    unit="hour",
                    numerator=numerator,
                    denominator=len(values),
                    coverage=coverage,
                    eligible_count=eligible,
                    computable_count=len(computable_orders),
                    not_computable_count=max(eligible - len(computable_orders), 0),
                    warnings=warning_messages,
                )
            )
    return results


def build_metrics(output: EngineOutput) -> list[MetricResult]:
    evaluations = output.evaluations
    valid_count = len(evaluations)
    count_coverage = ratio(valid_count, output.total_unique_orders)
    count_warnings = common_warnings(valid_count, count_coverage)
    results = [
        MetricResult(
            code="order_count",
            display_name="订单总数",
            value=output.total_unique_orders,
            unit="order",
            numerator=output.total_unique_orders,
            denominator=output.total_unique_orders,
            coverage=1.0 if output.total_unique_orders else None,
            eligible_count=output.total_unique_orders,
            computable_count=output.total_unique_orders,
            warnings=([] if output.total_unique_orders else ["当前数据集没有订单。"]),
        ),
        MetricResult(
            code="valid_order_count",
            display_name="有效订单数",
            value=valid_count,
            unit="order",
            numerator=valid_count,
            denominator=output.total_unique_orders,
            coverage=count_coverage,
            eligible_count=output.total_unique_orders,
            computable_count=valid_count,
            not_computable_count=output.invalid_order_count,
            warnings=count_warnings,
        ),
        decision_metric(
            evaluations,
            attribute="ot",
            code="ot_rate",
            display_name="按时交付率（OT）",
        ),
        decision_metric(
            evaluations,
            attribute="in_full",
            code="if_rate",
            display_name="足量交付率（IF）",
        ),
        decision_metric(
            evaluations,
            attribute="otif",
            code="otif_rate",
            display_name="按时足量交付率（OTIF）",
        ),
    ]
    results.extend(duration_metrics(evaluations))

    for code, display_name, target_status in (
        (
            "cancellation_rate",
            "取消率",
            "cancelled",
        ),
        (
            "return_rate",
            "退回率",
            "returned",
        ),
    ):
        numerator = sum(
            evaluation.detail.order_status == target_status for evaluation in evaluations
        )
        known = sum(evaluation.detail.order_status != "unmapped" for evaluation in evaluations)
        coverage = ratio(known, valid_count)
        results.append(
            MetricResult(
                code=code,
                display_name=display_name,
                value=ratio(numerator, valid_count),
                unit="ratio",
                numerator=numerator,
                denominator=valid_count,
                coverage=coverage,
                eligible_count=valid_count,
                computable_count=known,
                not_computable_count=valid_count - known,
                warnings=common_warnings(valid_count, coverage),
            )
        )

    anomaly_eligible = [
        evaluation for evaluation in evaluations if evaluation.detail.order_status != "cancelled"
    ]
    anomaly_numerator = sum(evaluation.detail.anomaly for evaluation in anomaly_eligible)
    results.append(
        MetricResult(
            code="anomaly_order_rate",
            display_name="异常订单率",
            value=ratio(anomaly_numerator, len(anomaly_eligible)),
            unit="ratio",
            numerator=anomaly_numerator,
            denominator=len(anomaly_eligible),
            coverage=1.0 if anomaly_eligible else None,
            eligible_count=len(anomaly_eligible),
            computable_count=len(anomaly_eligible),
            warnings=[
                *common_warnings(len(anomaly_eligible), 1.0 if anomaly_eligible else None),
                "异常率使用 metric-baseline-rules-v1.0.0，不代表因果诊断。",
            ],
        )
    )
    completed = [
        evaluation
        for evaluation in evaluations
        if evaluation.detail.order_status in COMPLETED_STATUSES
    ]
    covered = [
        evaluation
        for evaluation in completed
        if evaluation.detail.ot.value is not None
        and evaluation.detail.in_full.value is not None
        and evaluation.detail.fulfillment_duration_hours is not None
    ]
    coverage = ratio(len(covered), len(completed))
    results.append(
        MetricResult(
            code="data_coverage_rate",
            display_name="核心履约数据覆盖率",
            value=coverage,
            unit="ratio",
            numerator=len(covered),
            denominator=len(completed),
            coverage=coverage,
            eligible_count=len(completed),
            computable_count=len(covered),
            not_computable_count=len(completed) - len(covered),
            warnings=common_warnings(len(covered), coverage),
        )
    )
    results.extend(node_metrics(output))
    return results


def subset_output(output: EngineOutput, order_ids: set[str]) -> EngineOutput:
    evaluations = [
        evaluation for evaluation in output.evaluations if evaluation.detail.order_id in order_ids
    ]
    return EngineOutput(
        evaluations=evaluations,
        total_unique_orders=len(order_ids),
        invalid_order_count=0,
        warnings=[
            warning
            for warning in output.warnings
            if warning.order_id is None or warning.order_id in order_ids
        ],
        interval_eligible_orders={
            code: eligible & order_ids for code, eligible in output.interval_eligible_orders.items()
        },
    )


def group_metrics(
    output: EngineOutput,
    groups: dict[str, set[str]],
) -> list[MetricGroup]:
    results: list[MetricGroup] = []
    for key in sorted(groups):
        group_output = subset_output(output, groups[key])
        metrics = build_metrics(group_output)
        warnings = (
            ["该分组订单量小于 30，只作为核查线索。"]
            if len(groups[key]) < SMALL_SAMPLE_THRESHOLD
            else []
        )
        results.append(
            MetricGroup(
                key=key,
                label="未知" if key == UNKNOWN_DIMENSION else key,
                metrics=metrics,
                order_count=len(groups[key]),
                warnings=warnings,
            )
        )
    return results


def trend(
    output: EngineOutput,
    *,
    grain: Literal["date", "week"],
    timezone_name: str,
    datasets: Any,
) -> TrendResponse:
    try:
        timezone = ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError as error:
        raise ValueError("趋势时区不是有效的 IANA 时区") from error
    groups: defaultdict[str, set[str]] = defaultdict(set)
    for evaluation in output.evaluations:
        created = parse_time(evaluation.detail.created_at)
        if created is None:
            groups[UNKNOWN_DIMENSION].add(evaluation.detail.order_id)
            continue
        local_date = created.astimezone(timezone).date()
        if grain == "week":
            local_date = date.fromordinal(local_date.toordinal() - local_date.weekday())
        groups[local_date.isoformat()].add(evaluation.detail.order_id)
    return TrendResponse(
        datasets=datasets,
        grain=grain,
        timezone=timezone_name,
        groups=group_metrics(output, dict(groups)),
    )


def breakdown(
    output: EngineOutput,
    *,
    dimension: Literal[
        "warehouse_id",
        "carrier_id",
        "destination_region",
        "sales_channel",
    ],
    datasets: Any,
) -> BreakdownResponse:
    groups: defaultdict[str, set[str]] = defaultdict(set)
    for evaluation in output.evaluations:
        groups[dimension_value(evaluation.order, dimension)].add(evaluation.detail.order_id)
    return BreakdownResponse(
        datasets=datasets,
        dimension=dimension,
        groups=group_metrics(output, dict(groups)),
    )


def histogram(values: Sequence[float], bin_count: int) -> list[DistributionBin]:
    if not values:
        return []
    minimum = min(values)
    maximum = max(values)
    if minimum == maximum:
        return [
            DistributionBin(
                lower_bound=minimum,
                upper_bound=maximum,
                count=len(values),
                includes_upper_bound=True,
            )
        ]
    width = (maximum - minimum) / bin_count
    counts = [0] * bin_count
    for value in values:
        index = min(int((value - minimum) / width), bin_count - 1)
        counts[index] += 1
    return [
        DistributionBin(
            lower_bound=minimum + index * width,
            upper_bound=minimum + (index + 1) * width,
            count=count,
            includes_upper_bound=index == bin_count - 1,
        )
        for index, count in enumerate(counts)
    ]


def distribution(
    output: EngineOutput,
    *,
    metric_code: str,
    bin_count: int,
    datasets: Any,
) -> DistributionResponse:
    if metric_code == "fulfillment_duration_hours":
        values = [
            evaluation.detail.fulfillment_duration_hours
            for evaluation in output.evaluations
            if evaluation.detail.fulfillment_duration_hours is not None
        ]
    elif metric_code.startswith("node_duration_") and metric_code.endswith("_hours"):
        interval_code = metric_code.removeprefix("node_duration_").removesuffix("_hours")
        if interval_code not in NODE_LABELS:
            raise ValueError("不支持的节点时长分布代码")
        values = [
            node.duration_hours
            for evaluation in output.evaluations
            for node in evaluation.detail.node_durations
            if node.interval_code == interval_code
        ]
    else:
        raise ValueError("仅支持履约时长和标准节点时长分布")
    return DistributionResponse(
        datasets=datasets,
        metric_code=metric_code,
        unit="hour",
        sample_size=len(values),
        minimum=min(values) if values else None,
        maximum=max(values) if values else None,
        mean=average(values),
        median=quantile_type7(values, 0.5),
        p90=quantile_type7(values, 0.9),
        bins=histogram(values, bin_count),
        warnings=common_warnings(len(values), None),
    )
