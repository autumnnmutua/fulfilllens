from __future__ import annotations

import hashlib
import math
from collections import Counter, defaultdict
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, cast
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.diagnostics.models import (
    BottleneckNode,
    DiagnosticAnalysisResponse,
    DiagnosticCategory,
    DiagnosticContext,
    DiagnosticEvidence,
    DiagnosticResult,
    DiagnosticRule,
    DiagnosticRuleSet,
    DimensionInsight,
    DimensionType,
    ParetoItem,
    ProcessVariant,
    Severity,
    SeveritySummary,
    TimelineEvent,
)
from app.metrics.engine import (
    COMPLETED_STATUSES,
    NODE_LABELS,
    UNKNOWN_DIMENSION,
    EngineOutput,
    PreparedEvent,
    average,
    evaluate,
    parse_time,
    prepare_events,
    quantile_type7,
    ratio,
)
from app.metrics.models import DatasetSelection, OrderMetricDetail

CATEGORY_LABELS: dict[DiagnosticCategory, str] = {
    "warehouse_delay": "仓内作业延迟",
    "pickup_delay": "出库后揽收延迟",
    "linehaul_long_tail": "干线运输长尾",
    "last_mile_backlog": "末端网点积压",
    "carrier_relative": "承运商相对异常",
    "warehouse_congestion": "仓库拥堵观察",
    "time_concentration": "异常时间集中",
    "data_quality": "事件数据异常",
}
SEVERITY_RANK: dict[Severity, int] = {
    "low": 1,
    "medium": 2,
    "high": 3,
    "critical": 4,
}
WAREHOUSE_NODE_CODES = {
    "order_to_pick",
    "picking",
    "pick_to_qc",
    "quality_check",
    "packing",
}
ALLOWED_TRACKING_TRANSITIONS = {
    ("shipment_created", "carrier_picked_up"),
    ("carrier_picked_up", "origin_departed"),
    ("carrier_picked_up", "in_transit"),
    ("origin_departed", "in_transit"),
    ("origin_departed", "arrived_at_hub"),
    ("in_transit", "in_transit"),
    ("in_transit", "arrived_at_hub"),
    ("in_transit", "arrived_at_destination_city"),
    ("arrived_at_hub", "departed_hub"),
    ("departed_hub", "in_transit"),
    ("departed_hub", "arrived_at_hub"),
    ("departed_hub", "arrived_at_destination_city"),
    ("arrived_at_destination_city", "out_for_delivery"),
    ("arrived_at_destination_city", "delivered"),
    ("out_for_delivery", "delivery_failed"),
    ("out_for_delivery", "delivered"),
    ("delivery_failed", "out_for_delivery"),
    ("delivery_failed", "return_initiated"),
    ("exception", "in_transit"),
    ("exception", "out_for_delivery"),
    ("exception", "delivery_failed"),
    ("exception", "return_initiated"),
    ("delivered", "return_initiated"),
    ("delivered", "returned"),
    ("return_initiated", "returned"),
}


@dataclass
class ResultRecord:
    result: DiagnosticResult
    affected_order_ids: set[str]
    evidence_by_order: dict[str, list[DiagnosticEvidence]] = field(default_factory=dict)
    global_evidence: list[DiagnosticEvidence] = field(default_factory=list)


@dataclass
class DiagnosticComputation:
    response: DiagnosticAnalysisResponse
    records: list[ResultRecord]
    metrics_output: EngineOutput
    warehouse_events_by_order: dict[str, list[PreparedEvent]]
    tracking_events_by_order: dict[str, list[PreparedEvent]]


def _parameter(rule: DiagnosticRule, name: str) -> float:
    return rule.parameters[name].value


def _severity_max(values: Sequence[Severity]) -> Severity:
    return max(values, key=SEVERITY_RANK.__getitem__)


def _unique(values: Sequence[str]) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))


def _confidence_warnings(
    sample_size: int,
    coverage: float | None,
    extra: Sequence[str] = (),
) -> list[str]:
    warnings = list(extra)
    if sample_size < 30:
        warnings.append("样本量小于 30，规则结果仅用于核查。")
    if coverage is None:
        warnings.append("无法确定该规则的数据覆盖率。")
    elif coverage < 0.8:
        warnings.append("关键事件覆盖率低于 80%，可能存在漏报或偏差。")
    return _unique(warnings)


def _make_record(
    *,
    rule: DiagnosticRule,
    title: str,
    severity: Severity,
    factual_observation: str,
    rule_judgement: str,
    possible_causes: list[str],
    evidence: list[DiagnosticEvidence],
    affected_order_ids: set[str],
    coverage: float | None,
    confidence_warning: list[str],
    recommended_checks: list[str],
    sample_size: int,
    max_evidence: int,
    dimension_type: DimensionType | None = None,
    dimension_value: str | None = None,
) -> ResultRecord:
    evidence_by_order: defaultdict[str, list[DiagnosticEvidence]] = defaultdict(list)
    global_evidence: list[DiagnosticEvidence] = []
    for item in evidence:
        if item.order_id is None:
            global_evidence.append(item)
        else:
            evidence_by_order[item.order_id].append(item)
    ordered_ids = sorted(affected_order_ids)
    return ResultRecord(
        result=DiagnosticResult(
            rule_id=rule.rule_id,
            rule_version=rule.rule_version,
            merged_rule_ids=[],
            title=title,
            category=rule.category,
            severity=severity,
            factual_observation=factual_observation,
            rule_judgement=rule_judgement,
            possible_causes=possible_causes,
            evidence=evidence[:max_evidence],
            affected_order_count=len(affected_order_ids),
            affected_order_sample=ordered_ids[:20],
            coverage=coverage,
            confidence_warning=confidence_warning,
            recommended_checks=recommended_checks,
            sample_size=sample_size,
            dimension_type=dimension_type,
            dimension_value=dimension_value,
            priority=rule.priority,
        ),
        affected_order_ids=affected_order_ids,
        evidence_by_order=dict(evidence_by_order),
        global_evidence=global_evidence,
    )


def _prepared_events(
    output: EngineOutput,
    warehouse_rows: Sequence[dict[str, Any]],
    tracking_rows: Sequence[dict[str, Any]],
) -> tuple[list[PreparedEvent], list[PreparedEvent]]:
    valid_ids = {evaluation.detail.order_id for evaluation in output.evaluations}
    created = {
        evaluation.detail.order_id: parsed
        for evaluation in output.evaluations
        if (parsed := parse_time(evaluation.detail.created_at)) is not None
    }
    warehouse, _ = prepare_events(
        warehouse_rows,
        id_field="event_id",
        valid_order_ids=valid_ids,
        created_by_order=created,
    )
    tracking, _ = prepare_events(
        tracking_rows,
        id_field="tracking_event_id",
        valid_order_ids=valid_ids,
        created_by_order=created,
    )
    return warehouse, tracking


def _warehouse_delay_records(
    output: EngineOutput,
    rule: DiagnosticRule,
    max_evidence: int,
) -> list[ResultRecord]:
    records: list[ResultRecord] = []
    minimum_sample = int(_parameter(rule, "minimum_baseline_sample"))
    multiplier = _parameter(rule, "baseline_multiplier")
    for node_code in WAREHOUSE_NODE_CODES:
        samples = [
            (evaluation.detail, node)
            for evaluation in output.evaluations
            for node in evaluation.detail.node_durations
            if node.interval_code == node_code
        ]
        grouped_values: defaultdict[str, list[float]] = defaultdict(list)
        for detail, node in samples:
            grouped_values[detail.warehouse_id].append(node.duration_hours)
        threshold = _parameter(rule, f"{node_code}_threshold_hours")
        evidence: list[DiagnosticEvidence] = []
        affected: set[str] = set()
        severe = False
        for detail, node in samples:
            group = grouped_values[detail.warehouse_id]
            baseline = quantile_type7(group, 0.5)
            relative_threshold = (
                baseline * multiplier
                if baseline is not None and len(group) >= minimum_sample
                else None
            )
            business_hit = node.duration_hours > threshold
            relative_hit = (
                relative_threshold is not None and node.duration_hours > relative_threshold
            )
            if not business_hit and not relative_hit:
                continue
            affected.add(detail.order_id)
            severe = severe or node.duration_hours > threshold * 2
            evidence.append(
                DiagnosticEvidence(
                    order_id=detail.order_id,
                    node_code=node_code,
                    start_time=node.start_time,
                    end_time=node.end_time,
                    observed_value=node.duration_hours,
                    threshold_value=threshold,
                    baseline_value=baseline,
                    unit="hour",
                    dimension_type="warehouse",
                    dimension_value=detail.warehouse_id,
                    comparison=(
                        "超过业务阈值及同仓中位基线倍数。"
                        if business_hit and relative_hit
                        else "超过业务阈值。"
                        if business_hit
                        else "超过同仓中位基线倍数。"
                    ),
                )
            )
        if not affected:
            continue
        coverage = ratio(len({detail.order_id for detail, _ in samples}), len(output.evaluations))
        records.append(
            _make_record(
                rule=rule,
                title=f"仓内作业延迟：{NODE_LABELS[node_code]}",
                severity="high" if severe else rule.severity,
                factual_observation=(
                    f"{len(affected)} 个订单的{NODE_LABELS[node_code]}时长超过业务阈值"
                    "或足量同仓样本的中位基线倍数。"
                ),
                rule_judgement=(
                    f"规则以 {threshold:g} 小时为业务阈值；同仓样本不少于"
                    f" {minimum_sample} 时，同时比较中位数的 {multiplier:g} 倍。"
                ),
                possible_causes=[
                    "可能与作业排队、波次安排或人员/设备可用性有关，尚不能据此确认原因。",
                    "也可能由事件扫描延迟或节点定义不一致造成。",
                ],
                evidence=evidence,
                affected_order_ids=affected,
                coverage=coverage,
                confidence_warning=_confidence_warnings(len(samples), coverage),
                recommended_checks=[
                    "核对该节点的作业日志、班次与扫描时间是否一致。",
                    "按仓库、班次和订单类型复核受影响订单。",
                ],
                sample_size=len(samples),
                max_evidence=max_evidence,
                dimension_type="node",
                dimension_value=node_code,
            )
        )
    return records


def _node_delay_record(
    output: EngineOutput,
    rule: DiagnosticRule,
    *,
    node_code: str,
    threshold: float,
    factual_name: str,
    possible_causes: list[str],
    recommended_checks: list[str],
    max_evidence: int,
) -> ResultRecord | None:
    samples = [
        (evaluation.detail, node)
        for evaluation in output.evaluations
        for node in evaluation.detail.node_durations
        if node.interval_code == node_code
    ]
    hits = [(detail, node) for detail, node in samples if node.duration_hours > threshold]
    if not hits:
        return None
    affected = {detail.order_id for detail, _ in hits}
    evidence = [
        DiagnosticEvidence(
            order_id=detail.order_id,
            shipment_id=node.shipment_id,
            node_code=node_code,
            start_time=node.start_time,
            end_time=node.end_time,
            observed_value=node.duration_hours,
            threshold_value=threshold,
            unit="hour",
            dimension_type="carrier",
            dimension_value=detail.carrier_id,
            comparison="实际时长严格大于业务阈值。",
        )
        for detail, node in hits
    ]
    coverage = ratio(len({detail.order_id for detail, _ in samples}), len(output.evaluations))
    return _make_record(
        rule=rule,
        title=rule.title,
        severity=(
            "critical" if any(node.duration_hours > threshold * 3 for _, node in hits) else "high"
        ),
        factual_observation=f"{len(affected)} 个订单的{factual_name}超过 {threshold:g} 小时。",
        rule_judgement="只对具有完整起止事件且时长严格超过阈值的区间触发。",
        possible_causes=possible_causes,
        evidence=evidence,
        affected_order_ids=affected,
        coverage=coverage,
        confidence_warning=_confidence_warnings(len(samples), coverage),
        recommended_checks=recommended_checks,
        sample_size=len(samples),
        max_evidence=max_evidence,
        dimension_type="node",
        dimension_value=node_code,
    )


def _linehaul_record(
    output: EngineOutput,
    rule: DiagnosticRule,
    max_evidence: int,
) -> ResultRecord | None:
    samples = [
        (evaluation.detail, node)
        for evaluation in output.evaluations
        for node in evaluation.detail.node_durations
        if node.interval_code == "carrier_transit" and evaluation.detail.order_status != "cancelled"
    ]
    values = [node.duration_hours for _, node in samples]
    threshold = _parameter(rule, "threshold_hours")
    percentile = _parameter(rule, "percentile")
    minimum_sample = int(_parameter(rule, "minimum_baseline_sample"))
    baseline = quantile_type7(values, percentile) if len(values) >= minimum_sample else None
    hits = [
        (detail, node)
        for detail, node in samples
        if node.duration_hours > threshold
        or (baseline is not None and node.duration_hours > baseline)
    ]
    if not hits:
        return None
    affected = {detail.order_id for detail, _ in hits}
    evidence = [
        DiagnosticEvidence(
            order_id=detail.order_id,
            shipment_id=node.shipment_id,
            node_code="carrier_transit",
            start_time=node.start_time,
            end_time=node.end_time,
            observed_value=node.duration_hours,
            threshold_value=threshold,
            baseline_value=baseline,
            unit="hour",
            dimension_type="carrier",
            dimension_value=detail.carrier_id,
            comparison=(
                "超过业务阈值和当前样本 P90。"
                if baseline is not None
                and node.duration_hours > threshold
                and node.duration_hours > baseline
                else "超过业务阈值。"
                if node.duration_hours > threshold
                else "在足量样本下超过当前样本 P90。"
            ),
        )
        for detail, node in hits
    ]
    coverage = ratio(len({detail.order_id for detail, _ in samples}), len(output.evaluations))
    extra = [] if baseline is not None else [f"样本少于 {minimum_sample}，未启用分位数判断。"]
    return _make_record(
        rule=rule,
        title=rule.title,
        severity="high",
        factual_observation=(
            f"{len(affected)} 个订单的承运运输时长超过 {threshold:g} 小时或足量样本的 P90。"
        ),
        rule_judgement=(
            f"业务阈值与 Type 7 P{percentile * 100:g} 并行判断；任一严格超出即进入核查清单。"
        ),
        possible_causes=[
            "可能与路由、中转等待、运输资源或外部条件有关，当前数据不能确认因果。",
            "也可能存在首末事件扫描延迟。",
        ],
        evidence=evidence,
        affected_order_ids=affected,
        coverage=coverage,
        confidence_warning=_confidence_warnings(len(samples), coverage, extra),
        recommended_checks=[
            "核对运单路由、中转节点和承运商原始轨迹。",
            "按线路、地区和发运日期比较同类订单。",
        ],
        sample_size=len(samples),
        max_evidence=max_evidence,
        dimension_type="node",
        dimension_value="carrier_transit",
    )


def _last_mile_records(
    output: EngineOutput,
    tracking_by_order: dict[str, list[PreparedEvent]],
    rule: DiagnosticRule,
    max_evidence: int,
) -> list[ResultRecord]:
    detail_by_id = {item.detail.order_id: item.detail for item in output.evaluations}
    intervals: defaultdict[str, list[tuple[OrderMetricDetail, PreparedEvent, PreparedEvent]]] = (
        defaultdict(list)
    )
    eligible_by_node: defaultdict[str, set[str]] = defaultdict(set)
    for order_id, events in tracking_by_order.items():
        shipments: defaultdict[str, list[PreparedEvent]] = defaultdict(list)
        for event in events:
            shipments[str(event.raw.get("shipment_id") or UNKNOWN_DIMENSION)].append(event)
        for shipment_events in shipments.values():
            shipment_events.sort(key=lambda event: event.event_time)
            arrived = next(
                (
                    event
                    for event in shipment_events
                    if event.event_code == "arrived_at_destination_city"
                ),
                None,
            )
            if arrived is not None:
                eligible_by_node["destination_dwell"].add(order_id)
                end = next(
                    (
                        event
                        for event in shipment_events
                        if event.event_time >= arrived.event_time
                        and event.event_code in {"out_for_delivery", "delivered"}
                    ),
                    None,
                )
                if end is not None:
                    intervals["destination_dwell"].append((detail_by_id[order_id], arrived, end))
            dispatched = next(
                (event for event in shipment_events if event.event_code == "out_for_delivery"),
                None,
            )
            if dispatched is not None:
                eligible_by_node["delivery_attempt"].add(order_id)
                delivered = next(
                    (
                        event
                        for event in shipment_events
                        if event.event_time >= dispatched.event_time
                        and event.event_code == "delivered"
                    ),
                    None,
                )
                if delivered is not None:
                    intervals["delivery_attempt"].append(
                        (detail_by_id[order_id], dispatched, delivered)
                    )

    records: list[ResultRecord] = []
    specs = (
        (
            "destination_dwell",
            "station_dwell_threshold_hours",
            "到达目的城市后等待派送",
        ),
        (
            "delivery_attempt",
            "delivery_attempt_threshold_hours",
            "派送到签收",
        ),
    )
    for node_code, parameter_name, label in specs:
        threshold = _parameter(rule, parameter_name)
        samples = intervals[node_code]
        hits = [
            (detail, start, end)
            for detail, start, end in samples
            if (end.event_time - start.event_time).total_seconds() / 3600 > threshold
        ]
        if not hits:
            continue
        affected = {detail.order_id for detail, _, _ in hits}
        evidence = [
            DiagnosticEvidence(
                order_id=detail.order_id,
                event_id=start.event_id,
                shipment_id=str(start.raw.get("shipment_id") or "") or None,
                node_code=node_code,
                start_time=start.event_time.isoformat(),
                end_time=end.event_time.isoformat(),
                observed_value=(end.event_time - start.event_time).total_seconds() / 3600,
                threshold_value=threshold,
                unit="hour",
                dimension_type="region",
                dimension_value=detail.destination_region,
                comparison="完整末端区间时长严格超过业务阈值。",
            )
            for detail, start, end in hits
        ]
        coverage = ratio(
            len({detail.order_id for detail, _, _ in samples}),
            len(eligible_by_node[node_code]),
        )
        records.append(
            _make_record(
                rule=rule,
                title=f"末端网点积压：{label}",
                severity="high",
                factual_observation=f"{len(affected)} 个订单的{label}超过 {threshold:g} 小时。",
                rule_judgement="仅使用同一运单内按 UTC 排序后的完整起止事件。",
                possible_causes=[
                    "可能与末端网点待处理量、派送资源或扫描延迟有关，尚不能确认原因。"
                ],
                evidence=evidence,
                affected_order_ids=affected,
                coverage=coverage,
                confidence_warning=_confidence_warnings(len(samples), coverage),
                recommended_checks=[
                    "核对目的网点到件、派送批次和签收扫描。",
                    "检查同地区、同日期订单是否同步出现。",
                ],
                sample_size=len(samples),
                max_evidence=max_evidence,
                dimension_type="node",
                dimension_value=node_code,
            )
        )
    return records


def _carrier_relative_records(
    output: EngineOutput,
    rule: DiagnosticRule,
    max_evidence: int,
) -> list[ResultRecord]:
    groups: defaultdict[str, list[OrderMetricDetail]] = defaultdict(list)
    for evaluation in output.evaluations:
        detail = evaluation.detail
        if detail.carrier_id != UNKNOWN_DIMENSION and detail.order_status in COMPLETED_STATUSES:
            groups[detail.carrier_id].append(detail)
    minimum_sample = int(_parameter(rule, "minimum_sample"))
    minimum_coverage = _parameter(rule, "minimum_coverage")
    otif_gap_threshold = _parameter(rule, "otif_gap")
    p90_ratio_threshold = _parameter(rule, "p90_ratio")
    records: list[ResultRecord] = []
    for carrier, details in sorted(groups.items()):
        peers = [item for key, items in groups.items() if key != carrier for item in items]
        carrier_otif = [item.otif.value for item in details if item.otif.value is not None]
        peer_otif = [item.otif.value for item in peers if item.otif.value is not None]
        carrier_coverage = ratio(len(carrier_otif), len(details))
        carrier_rate = (
            sum(bool(value) for value in carrier_otif) / len(carrier_otif) if carrier_otif else None
        )
        peer_rate = sum(bool(value) for value in peer_otif) / len(peer_otif) if peer_otif else None
        carrier_durations = [
            item.fulfillment_duration_hours
            for item in details
            if item.fulfillment_duration_hours is not None
        ]
        peer_durations = [
            item.fulfillment_duration_hours
            for item in peers
            if item.fulfillment_duration_hours is not None
        ]
        carrier_p90 = quantile_type7(carrier_durations, 0.9)
        peer_p90 = quantile_type7(peer_durations, 0.9)
        rate_hit = (
            len(carrier_otif) >= minimum_sample
            and len(peer_otif) >= minimum_sample
            and carrier_coverage is not None
            and carrier_coverage >= minimum_coverage
            and carrier_rate is not None
            and peer_rate is not None
            and (
                peer_rate - carrier_rate > otif_gap_threshold
                or math.isclose(
                    peer_rate - carrier_rate,
                    otif_gap_threshold,
                    rel_tol=1e-12,
                    abs_tol=1e-12,
                )
            )
        )
        p90_hit = (
            len(carrier_durations) >= minimum_sample
            and len(peer_durations) >= minimum_sample
            and carrier_p90 is not None
            and peer_p90 is not None
            and carrier_p90 >= peer_p90 * p90_ratio_threshold
        )
        if not rate_hit and not p90_hit:
            continue
        affected = {item.order_id for item in details}
        evidence = [
            DiagnosticEvidence(
                order_id=item.order_id,
                observed_value=carrier_rate if rate_hit else carrier_p90,
                threshold_value=(
                    otif_gap_threshold
                    if rate_hit
                    else peer_p90 * p90_ratio_threshold
                    if peer_p90 is not None
                    else None
                ),
                baseline_value=peer_rate if rate_hit else peer_p90,
                unit="ratio" if rate_hit else "hour",
                dimension_type="carrier",
                dimension_value=carrier,
                comparison=(
                    "承运商 OTIF 低于其余承运商基线。"
                    if rate_hit
                    else "承运商 P90 高于其余承运商基线倍数。"
                ),
            )
            for item in details
        ]
        observations: list[str] = []
        if rate_hit and carrier_rate is not None and peer_rate is not None:
            observations.append(f"OTIF 为 {carrier_rate:.1%}，其余可比承运商为 {peer_rate:.1%}")
        if p90_hit and carrier_p90 is not None and peer_p90 is not None:
            observations.append(
                f"履约 P90 为 {carrier_p90:.2f} 小时，其余可比承运商为 {peer_p90:.2f} 小时"
            )
        records.append(
            _make_record(
                rule=rule,
                title=f"承运商相对异常：{carrier}",
                severity="high" if rate_hit and p90_hit else rule.severity,
                factual_observation=f"承运商 {carrier}：{'；'.join(observations)}。",
                rule_judgement=(
                    f"仅在本承运商和同批次其他承运商各不少于 {minimum_sample} 个"
                    "可比样本时进行相对判断。"
                ),
                possible_causes=[
                    "差异可能与线路、地区、订单结构或承运过程有关，不能直接归因为承运商能力。"
                ],
                evidence=evidence,
                affected_order_ids=affected,
                coverage=carrier_coverage,
                confidence_warning=_confidence_warnings(
                    max(len(carrier_otif), len(carrier_durations)), carrier_coverage
                ),
                recommended_checks=[
                    "按地区、线路、日期和订单类型做同口径复核。",
                    "核对承运商扫描覆盖和承诺时效是否可比。",
                ],
                sample_size=len(details),
                max_evidence=max_evidence,
                dimension_type="carrier",
                dimension_value=carrier,
            )
        )
    return records


def _warehouse_congestion_records(
    output: EngineOutput,
    rule: DiagnosticRule,
    timezone: ZoneInfo,
    max_evidence: int,
) -> list[ResultRecord]:
    daily_orders: defaultdict[str, defaultdict[str, list[OrderMetricDetail]]] = defaultdict(
        lambda: defaultdict(list)
    )
    daily_durations: defaultdict[str, defaultdict[str, list[float]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for evaluation in output.evaluations:
        detail = evaluation.detail
        created = parse_time(detail.created_at)
        if created is None or detail.warehouse_id == UNKNOWN_DIMENSION:
            continue
        date_key = created.astimezone(timezone).date().isoformat()
        daily_orders[detail.warehouse_id][date_key].append(detail)
        internal = [
            node.duration_hours
            for node in detail.node_durations
            if node.interval_code in WAREHOUSE_NODE_CODES
        ]
        if internal:
            daily_durations[detail.warehouse_id][date_key].append(sum(internal))

    minimum_orders = int(_parameter(rule, "minimum_daily_orders"))
    minimum_days = int(_parameter(rule, "minimum_baseline_days"))
    volume_ratio = _parameter(rule, "volume_ratio")
    duration_ratio = _parameter(rule, "duration_ratio")
    records: list[ResultRecord] = []
    for warehouse, by_date in daily_orders.items():
        dates = sorted(by_date)
        for index, date_key in enumerate(dates):
            previous_dates = dates[:index]
            if len(previous_dates) < minimum_days or len(by_date[date_key]) < minimum_orders:
                continue
            baseline_volume = quantile_type7(
                [float(len(by_date[item])) for item in previous_dates], 0.5
            )
            current_p90 = quantile_type7(daily_durations[warehouse][date_key], 0.9)
            prior_p90s = [
                value
                for item in previous_dates
                if (value := quantile_type7(daily_durations[warehouse][item], 0.9)) is not None
            ]
            baseline_duration = quantile_type7(prior_p90s, 0.5)
            if (
                baseline_volume is None
                or baseline_duration is None
                or current_p90 is None
                or len(prior_p90s) < minimum_days
                or len(by_date[date_key]) < baseline_volume * volume_ratio
                or current_p90 < baseline_duration * duration_ratio
            ):
                continue
            affected = {item.order_id for item in by_date[date_key]}
            evidence = [
                DiagnosticEvidence(
                    order_id=item.order_id,
                    observed_value=current_p90,
                    threshold_value=baseline_duration * duration_ratio,
                    baseline_value=baseline_duration,
                    unit="hour",
                    dimension_type="warehouse",
                    dimension_value=warehouse,
                    comparison=(
                        f"{date_key} 订单量 {len(by_date[date_key])}，历史中位量"
                        f" {baseline_volume:.2f}；仓内 P90 同步恶化。"
                    ),
                )
                for item in by_date[date_key]
            ]
            coverage = ratio(len(daily_durations[warehouse][date_key]), len(by_date[date_key]))
            records.append(
                _make_record(
                    rule=rule,
                    title=f"仓库拥堵相关性观察：{warehouse} · {date_key}",
                    severity=rule.severity,
                    factual_observation=(
                        f"仓库 {warehouse} 在 {date_key} 的订单量为 {len(by_date[date_key])}，"
                        f"仓内总时长 P90 为 {current_p90:.2f} 小时；两者相对历史基线同步上升。"
                    ),
                    rule_judgement=(
                        "该规则只标记订单量与仓内时长共同恶化的相关性观察，不构成拥堵因果证明。"
                    ),
                    possible_causes=[
                        "可能与订单结构、排班、设备或波次有关，也可能存在共同的活动/日期因素。"
                    ],
                    evidence=evidence,
                    affected_order_ids=affected,
                    coverage=coverage,
                    confidence_warning=_confidence_warnings(
                        len(by_date[date_key]), coverage, ["相关性观察不能解释因果。"]
                    ),
                    recommended_checks=[
                        "复核当日班次、波次、SKU 结构和设备可用性。",
                        "与相邻日期和其他仓库的同类订单对照。",
                    ],
                    sample_size=len(by_date[date_key]),
                    max_evidence=max_evidence,
                    dimension_type="warehouse",
                    dimension_value=warehouse,
                )
            )
    return records


def _data_quality_records(
    output: EngineOutput,
    tracking_by_order: dict[str, list[PreparedEvent]],
    tracking_rows_provided: bool,
    rule: DiagnosticRule,
    max_evidence: int,
) -> list[ResultRecord]:
    valid_ids = {evaluation.detail.order_id for evaluation in output.evaluations}
    warning_labels = {
        "NODE_BOUNDARY_MISSING": ("事件边界缺失", "medium"),
        "NODE_END_BEFORE_START": ("节点结束早于开始", "high"),
        "SOURCE_EVENT_OUT_OF_ORDER": ("源事件倒序", "medium"),
        "EXACT_DUPLICATE_EVENT": ("完全重复事件", "low"),
        "POSSIBLE_DUPLICATE_SCAN": ("疑似重复扫描", "low"),
        "DUPLICATE_EVENT_CONFLICT": ("事件主键冲突", "high"),
        "INVALID_EVENT_TIME": ("非法事件时间", "high"),
        "EVENT_BEFORE_ORDER_CREATED": ("事件早于订单创建", "high"),
        "MULTIPLE_NODE_CYCLES": ("同节点多次循环", "low"),
    }
    grouped_warnings: defaultdict[str, list[Any]] = defaultdict(list)
    for warning in output.warnings:
        if warning.code in warning_labels and warning.order_id in valid_ids:
            grouped_warnings[warning.code].append(warning)

    records: list[ResultRecord] = []
    coverage = ratio(len(output.evaluations), output.total_unique_orders)
    for code, warnings in grouped_warnings.items():
        label, severity_text = warning_labels[code]
        severity = cast(Severity, severity_text)
        affected = {warning.order_id for warning in warnings if warning.order_id is not None}
        evidence = [
            DiagnosticEvidence(
                order_id=warning.order_id,
                event_id=warning.event_id,
                node_code=warning.interval_code,
                comparison=warning.message,
            )
            for warning in warnings
        ]
        records.append(
            _make_record(
                rule=rule,
                title=f"数据异常：{label}",
                severity=severity,
                factual_observation=f"{len(affected)} 个订单出现{label}证据。",
                rule_judgement="保留原记录并生成数据质量警告；未通过删除异常行美化指标。",
                possible_causes=["可能由采集顺序、重复上报、字段映射或源系统补传造成。"],
                evidence=evidence,
                affected_order_ids=affected,
                coverage=coverage,
                confidence_warning=_confidence_warnings(len(warnings), coverage),
                recommended_checks=[
                    "按事件 ID、原始行和源系统时间核对。",
                    "确认问题属于真实流程变体还是采集质量。",
                ],
                sample_size=len(warnings),
                max_evidence=max_evidence,
            )
        )

    state_jump_evidence: list[DiagnosticEvidence] = []
    long_gap_evidence: list[DiagnosticEvidence] = []
    unmapped_evidence: list[DiagnosticEvidence] = []
    long_threshold = _parameter(rule, "long_interval_threshold_hours")
    for order_id, events in tracking_by_order.items():
        shipments: defaultdict[str, list[PreparedEvent]] = defaultdict(list)
        for event in events:
            shipment_id = str(event.raw.get("shipment_id") or UNKNOWN_DIMENSION)
            shipments[shipment_id].append(event)
            if event.event_code == "unmapped":
                unmapped_evidence.append(
                    DiagnosticEvidence(
                        order_id=order_id,
                        event_id=event.event_id,
                        shipment_id=shipment_id,
                        start_time=event.event_time.isoformat(),
                        comparison="事件状态为 unmapped，原始状态仍保留。",
                    )
                )
        for shipment_id, shipment_events in shipments.items():
            shipment_events.sort(key=lambda item: item.event_time)
            for previous, current in zip(shipment_events, shipment_events[1:], strict=False):
                gap = (current.event_time - previous.event_time).total_seconds() / 3600
                if gap > long_threshold:
                    long_gap_evidence.append(
                        DiagnosticEvidence(
                            order_id=order_id,
                            event_id=current.event_id,
                            shipment_id=shipment_id,
                            start_time=previous.event_time.isoformat(),
                            end_time=current.event_time.isoformat(),
                            observed_value=gap,
                            threshold_value=long_threshold,
                            unit="hour",
                            comparison="相邻物流事件间隔严格超过异常长间隔阈值。",
                        )
                    )
                if (
                    previous.event_code != "unmapped"
                    and current.event_code != "unmapped"
                    and previous.event_code != "exception"
                    and (previous.event_code, current.event_code)
                    not in ALLOWED_TRACKING_TRANSITIONS
                ):
                    state_jump_evidence.append(
                        DiagnosticEvidence(
                            order_id=order_id,
                            event_id=current.event_id,
                            shipment_id=shipment_id,
                            start_time=previous.event_time.isoformat(),
                            end_time=current.event_time.isoformat(),
                            comparison=(
                                f"状态从 {previous.event_code} 跳到 {current.event_code}；"
                                "可能是中间扫描缺失。"
                            ),
                        )
                    )

    completed_missing_final: list[DiagnosticEvidence] = []
    if tracking_rows_provided:
        for evaluation in output.evaluations:
            detail = evaluation.detail
            if detail.order_status not in COMPLETED_STATUSES:
                continue
            codes = {event.event_code for event in tracking_by_order.get(detail.order_id, [])}
            if "delivered" not in codes and "returned" not in codes:
                completed_missing_final.append(
                    DiagnosticEvidence(
                        order_id=detail.order_id,
                        comparison="完成订单缺少 delivered/returned 末端轨迹事件。",
                    )
                )

    for label, severity, evidence in (
        ("状态跳跃", "medium", state_jump_evidence),
        ("异常长事件间隔", "high", long_gap_evidence),
        ("未知物流状态", "medium", unmapped_evidence),
        ("完成订单缺少末端事件", "medium", completed_missing_final),
    ):
        if not evidence:
            continue
        affected = {item.order_id for item in evidence if item.order_id is not None}
        records.append(
            _make_record(
                rule=rule,
                title=f"数据异常：{label}",
                severity=severity,
                factual_observation=f"{len(affected)} 个订单出现{label}。",
                rule_judgement=("该结果表示流程或采集需要核查；状态跳跃不会被自动补造为中间事件。"),
                possible_causes=["可能是流程变体、事件漏采、补传或状态映射不完整。"],
                evidence=evidence,
                affected_order_ids=affected,
                coverage=coverage,
                confidence_warning=_confidence_warnings(len(evidence), coverage),
                recommended_checks=["查看订单时间线并与源系统轨迹逐条对照。"],
                sample_size=len(evidence),
                max_evidence=max_evidence,
            )
        )
    return records


def _time_concentration_records(
    records: Sequence[ResultRecord],
    details: dict[str, OrderMetricDetail],
    rule: DiagnosticRule,
    timezone: ZoneInfo,
    max_evidence: int,
) -> list[ResultRecord]:
    affected = {
        order_id
        for record in records
        if record.result.category != "time_concentration"
        for order_id in record.affected_order_ids
    }
    minimum_orders = int(_parameter(rule, "minimum_anomaly_orders"))
    minimum_dates = int(_parameter(rule, "minimum_distinct_dates"))
    threshold = _parameter(rule, "concentration_share")
    dated: list[tuple[str, datetime]] = []
    for order_id in affected:
        parsed = parse_time(details[order_id].created_at)
        if parsed is not None:
            dated.append((order_id, parsed.astimezone(timezone)))
    distinct_dates = {item.date() for _, item in dated}
    if len(dated) < minimum_orders or len(distinct_dates) < minimum_dates:
        return []
    weekday_labels = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
    buckets: list[tuple[str, Counter[str]]] = [
        ("星期", Counter(weekday_labels[item.weekday()] for _, item in dated)),
        (
            "时段",
            Counter(
                f"{item.hour // 6 * 6:02d}:00–{item.hour // 6 * 6 + 6:02d}:00" for _, item in dated
            ),
        ),
    ]
    results: list[ResultRecord] = []
    for bucket_type, counts in buckets:
        bucket, count = counts.most_common(1)[0]
        share = count / len(dated)
        if share < threshold:
            continue
        bucket_orders = {
            order_id
            for order_id, item in dated
            if (
                weekday_labels[item.weekday()] == bucket
                if bucket_type == "星期"
                else f"{item.hour // 6 * 6:02d}:00–{item.hour // 6 * 6 + 6:02d}:00" == bucket
            )
        }
        evidence = [
            DiagnosticEvidence(
                order_id=order_id,
                start_time=item.isoformat(),
                observed_value=share,
                threshold_value=threshold,
                unit="ratio",
                dimension_type="time_bucket",
                dimension_value=bucket,
                comparison=f"异常订单创建时间落在{bucket_type}桶 {bucket}。",
            )
            for order_id, item in dated
            if order_id in bucket_orders
        ]
        results.append(
            _make_record(
                rule=rule,
                title=f"异常时间集中：{bucket_type} {bucket}",
                severity=rule.severity,
                factual_observation=(
                    f"{len(dated)} 个有有效创建时间的异常订单中，{count} 个集中在"
                    f"{bucket_type} {bucket}，占 {share:.1%}。"
                ),
                rule_judgement=(
                    f"异常样本不少于 {minimum_orders}、覆盖至少 {minimum_dates} 个日期且"
                    f"单桶占比达到 {threshold:.0%} 时触发。"
                ),
                possible_causes=[
                    "可能与班次、截单、活动节奏或数据采集批次有关，需要结合业务日历核查。"
                ],
                evidence=evidence,
                affected_order_ids=bucket_orders,
                coverage=ratio(len(dated), len(affected)),
                confidence_warning=_confidence_warnings(
                    len(dated), ratio(len(dated), len(affected))
                ),
                recommended_checks=["对照班次、截单时间、促销日期和批量数据同步时间。"],
                sample_size=len(dated),
                max_evidence=max_evidence,
                dimension_type="time_bucket",
                dimension_value=bucket,
            )
        )
    return results


def _pareto(records: Sequence[ResultRecord]) -> list[ParetoItem]:
    category_orders: defaultdict[DiagnosticCategory, set[str]] = defaultdict(set)
    category_findings: Counter[DiagnosticCategory] = Counter()
    for record in records:
        category_orders[record.result.category].update(record.affected_order_ids)
        category_findings[record.result.category] += 1
    ordered = sorted(category_orders, key=lambda item: len(category_orders[item]), reverse=True)
    total = sum(len(category_orders[item]) for item in ordered)
    cumulative = 0
    items: list[ParetoItem] = []
    for category in ordered:
        count = len(category_orders[category])
        cumulative += count
        items.append(
            ParetoItem(
                category=category,
                display_name=CATEGORY_LABELS[category],
                finding_count=category_findings[category],
                affected_order_count=count,
                cumulative_share=cumulative / total if total else 0,
            )
        )
    return items


def _severity_summary(records: Sequence[ResultRecord]) -> list[SeveritySummary]:
    order_ids: defaultdict[Severity, set[str]] = defaultdict(set)
    counts: Counter[Severity] = Counter()
    for record in records:
        counts[record.result.severity] += 1
        order_ids[record.result.severity].update(record.affected_order_ids)
    return [
        SeveritySummary(
            severity=severity,
            finding_count=counts[severity],
            affected_order_count=len(order_ids[severity]),
        )
        for severity in ("critical", "high", "medium", "low")
    ]


def _bottlenecks(
    output: EngineOutput,
    records: Sequence[ResultRecord],
    rules: dict[str, DiagnosticRule],
) -> list[BottleneckNode]:
    threshold_by_node: dict[str, float] = {}
    warehouse_rule = rules.get("FL-WH-001")
    if warehouse_rule is not None:
        for node in WAREHOUSE_NODE_CODES:
            threshold_by_node[node] = _parameter(warehouse_rule, f"{node}_threshold_hours")
    pickup_rule = rules.get("FL-PU-001")
    if pickup_rule is not None:
        threshold_by_node["ready_to_pickup"] = _parameter(pickup_rule, "threshold_hours")
    linehaul_rule = rules.get("FL-LH-001")
    if linehaul_rule is not None:
        threshold_by_node["carrier_transit"] = _parameter(linehaul_rule, "threshold_hours")
    affected_by_node: defaultdict[str, set[str]] = defaultdict(set)
    for record in records:
        node_dimension: str | None = (
            record.result.dimension_value if record.result.dimension_type == "node" else None
        )
        if node_dimension:
            affected_by_node[node_dimension].update(record.affected_order_ids)
    items: list[BottleneckNode] = []
    for node_code, display_name in NODE_LABELS.items():
        values = [
            node.duration_hours
            for evaluation in output.evaluations
            for node in evaluation.detail.node_durations
            if node.interval_code == node_code
        ]
        eligible = len(output.interval_eligible_orders.get(node_code, set()))
        threshold = threshold_by_node.get(node_code)
        p90 = quantile_type7(values, 0.9)
        items.append(
            BottleneckNode(
                node_code=node_code,
                display_name=display_name,
                mean_hours=average(values),
                p90_hours=p90,
                threshold_hours=threshold,
                sample_size=len(values),
                affected_order_count=len(affected_by_node[node_code]),
                coverage=ratio(
                    len(
                        {
                            evaluation.detail.order_id
                            for evaluation in output.evaluations
                            if any(
                                item.interval_code == node_code
                                for item in evaluation.detail.node_durations
                            )
                        }
                    ),
                    eligible,
                ),
                is_bottleneck=(
                    bool(affected_by_node[node_code])
                    or (threshold is not None and p90 is not None and p90 > threshold)
                ),
            )
        )
    return sorted(
        items,
        key=lambda item: (
            item.is_bottleneck,
            item.p90_hours if item.p90_hours is not None else -1,
        ),
        reverse=True,
    )


def _process_variants(
    output: EngineOutput,
    warehouse_by_order: dict[str, list[PreparedEvent]],
    tracking_by_order: dict[str, list[PreparedEvent]],
    affected_orders: set[str],
) -> list[ProcessVariant]:
    groups: defaultdict[tuple[str, ...], list[str]] = defaultdict(list)
    for evaluation in output.evaluations:
        order_id = evaluation.detail.order_id
        events = [*warehouse_by_order.get(order_id, []), *tracking_by_order.get(order_id, [])]
        events.sort(key=lambda item: (item.event_time, item.source_index, item.event_id))
        sequence = tuple(event.event_code for event in events)
        if sequence:
            groups[sequence].append(order_id)
    total = sum(len(order_ids) for order_ids in groups.values())
    return [
        ProcessVariant(
            variant_id=(
                "V-" + hashlib.sha256("|".join(sequence).encode("utf-8")).hexdigest()[:8].upper()
            ),
            sequence=list(sequence),
            order_count=len(order_ids),
            share=len(order_ids) / total if total else 0,
            affected_order_count=len(set(order_ids) & affected_orders),
        )
        for sequence, order_ids in sorted(
            groups.items(), key=lambda item: len(item[1]), reverse=True
        )[:20]
    ]


def _dimension_insights(
    records: Sequence[ResultRecord],
    details: dict[str, OrderMetricDetail],
) -> list[DimensionInsight]:
    entries: dict[
        tuple[DimensionType, str],
        dict[str, Any],
    ] = {}
    for record in records:
        for order_id in record.affected_order_ids:
            detail = details.get(order_id)
            if detail is None:
                continue
            for dimension_type, value in (
                ("warehouse", detail.warehouse_id),
                ("carrier", detail.carrier_id),
                ("region", detail.destination_region),
            ):
                key = (cast(DimensionType, dimension_type), value)
                entry = entries.setdefault(
                    key,
                    {"orders": set(), "records": set(), "categories": set(), "severities": []},
                )
                entry["orders"].add(order_id)
                entry["records"].add((record.result.rule_id, record.result.title))
                entry["categories"].add(record.result.category)
                entry["severities"].append(record.result.severity)
    return sorted(
        [
            DimensionInsight(
                dimension_type=dimension_type,
                dimension_value=dimension_value,
                finding_count=len(entry["records"]),
                affected_order_count=len(entry["orders"]),
                highest_severity=_severity_max(entry["severities"]),
                categories=sorted(entry["categories"]),
            )
            for (dimension_type, dimension_value), entry in entries.items()
        ],
        key=lambda item: (
            item.affected_order_count,
            SEVERITY_RANK[item.highest_severity],
        ),
        reverse=True,
    )


def analyze(
    orders: Sequence[dict[str, Any]],
    warehouse_events: Sequence[dict[str, Any]],
    tracking_events: Sequence[dict[str, Any]],
    *,
    datasets: DatasetSelection,
    rule_set: DiagnosticRuleSet,
    timezone_name: str,
    max_evidence: int,
) -> DiagnosticComputation:
    try:
        timezone = ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError as error:
        raise ValueError("无法识别所选时区") from error
    output = evaluate(orders, warehouse_events, tracking_events)
    prepared_warehouse, prepared_tracking = _prepared_events(
        output, warehouse_events, tracking_events
    )
    warehouse_by_order: defaultdict[str, list[PreparedEvent]] = defaultdict(list)
    tracking_by_order: defaultdict[str, list[PreparedEvent]] = defaultdict(list)
    for event in prepared_warehouse:
        warehouse_by_order[event.order_id].append(event)
    for event in prepared_tracking:
        tracking_by_order[event.order_id].append(event)

    rules = {rule.rule_id: rule for rule in rule_set.rules if rule.enabled}
    records: list[ResultRecord] = []
    if rule := rules.get("FL-WH-001"):
        records.extend(_warehouse_delay_records(output, rule, max_evidence))
    if rule := rules.get("FL-PU-001"):
        pickup = _node_delay_record(
            output,
            rule,
            node_code="ready_to_pickup",
            threshold=_parameter(rule, "threshold_hours"),
            factual_name="出库/待揽收到首次揽收等待",
            possible_causes=["可能与交接批次、揽收班次或扫描延迟有关，当前证据不能确认原因。"],
            recommended_checks=["核对出库交接单、承运商揽收班次和首次扫描时间。"],
            max_evidence=max_evidence,
        )
        if pickup is not None:
            records.append(pickup)
    if rule := rules.get("FL-LH-001"):
        linehaul = _linehaul_record(output, rule, max_evidence)
        if linehaul is not None:
            records.append(linehaul)
    if rule := rules.get("FL-LM-001"):
        records.extend(_last_mile_records(output, dict(tracking_by_order), rule, max_evidence))
    if rule := rules.get("FL-CR-001"):
        records.extend(_carrier_relative_records(output, rule, max_evidence))
    if rule := rules.get("FL-WC-001"):
        records.extend(_warehouse_congestion_records(output, rule, timezone, max_evidence))
    if rule := rules.get("FL-DQ-001"):
        records.extend(
            _data_quality_records(
                output,
                dict(tracking_by_order),
                bool(tracking_events),
                rule,
                max_evidence,
            )
        )
    details = {evaluation.detail.order_id: evaluation.detail for evaluation in output.evaluations}
    if rule := rules.get("FL-TC-001"):
        records.extend(_time_concentration_records(records, details, rule, timezone, max_evidence))

    records.sort(
        key=lambda item: (
            SEVERITY_RANK[item.result.severity],
            item.result.priority,
            item.result.affected_order_count,
        ),
        reverse=True,
    )
    affected_orders = {order_id for record in records for order_id in record.affected_order_ids}
    triggered_rules = {record.result.rule_id for record in records}
    data_coverage = ratio(len(output.evaluations), output.total_unique_orders)
    analysis_warnings: list[str] = []
    if not warehouse_events:
        analysis_warnings.append("未提供仓库事件数据，仓内规则无法完整评估。")
    if not tracking_events:
        analysis_warnings.append("未提供物流轨迹数据，运输与末端规则无法评估。")
    if len(output.evaluations) < 30:
        analysis_warnings.append("有效订单少于 30，群体对比规则可能不触发。")
    if data_coverage is not None and data_coverage < 0.8:
        analysis_warnings.append("有效订单覆盖率低于 80%。")
    if not records:
        analysis_warnings.append("当前阈值下未触发诊断；这不等同于已证明没有问题。")
    response = DiagnosticAnalysisResponse(
        context=DiagnosticContext(
            datasets=datasets,
            analyzed_at=datetime.now(UTC),
            order_count=output.total_unique_orders,
            valid_order_count=len(output.evaluations),
            affected_order_count=len(affected_orders),
            finding_count=len(records),
            enabled_rule_count=len(rules),
            triggered_rule_count=len(triggered_rules),
            data_coverage=data_coverage,
            warning_count=len(output.warnings) + len(analysis_warnings),
            timezone=timezone_name,
        ),
        results=[record.result for record in records],
        severity_summary=_severity_summary(records),
        pareto=_pareto(records),
        bottleneck_nodes=_bottlenecks(output, records, rules),
        process_variants=_process_variants(
            output, dict(warehouse_by_order), dict(tracking_by_order), affected_orders
        ),
        dimension_insights=_dimension_insights(records, details),
        analysis_warnings=analysis_warnings,
        rule_set_version=rule_set.rule_set_version,
    )
    return DiagnosticComputation(
        response=response,
        records=records,
        metrics_output=output,
        warehouse_events_by_order=dict(warehouse_by_order),
        tracking_events_by_order=dict(tracking_by_order),
    )


def findings_for_order(
    computation: DiagnosticComputation,
    order_id: str,
    *,
    max_evidence: int = 100,
) -> list[DiagnosticResult]:
    candidates: list[DiagnosticResult] = []
    for record in computation.records:
        if order_id not in record.affected_order_ids:
            continue
        evidence = [
            *record.evidence_by_order.get(order_id, []),
            *record.global_evidence,
        ][:max_evidence]
        candidates.append(
            record.result.model_copy(
                update={
                    "evidence": evidence,
                    "affected_order_count": 1,
                    "affected_order_sample": [order_id],
                },
                deep=True,
            )
        )
    grouped: defaultdict[DiagnosticCategory, list[DiagnosticResult]] = defaultdict(list)
    for item in candidates:
        grouped[item.category].append(item)
    merged: list[DiagnosticResult] = []
    for category, items in grouped.items():
        items.sort(key=lambda item: (SEVERITY_RANK[item.severity], item.priority), reverse=True)
        primary = items[0]
        if len(items) == 1:
            merged.append(primary)
            continue
        evidence_by_key: dict[str, DiagnosticEvidence] = {}
        for item in items:
            for item_evidence in item.evidence:
                evidence_by_key[item_evidence.model_dump_json()] = item_evidence
        merged.append(
            primary.model_copy(
                update={
                    "title": f"{CATEGORY_LABELS[category]}（已合并同类命中）",
                    "merged_rule_ids": _unique(
                        [
                            *primary.merged_rule_ids,
                            *(item.rule_id for item in items[1:]),
                            *(rule_id for item in items[1:] for rule_id in item.merged_rule_ids),
                        ]
                    ),
                    "factual_observation": "；".join(
                        _unique([item.factual_observation.rstrip("。") for item in items])
                    )
                    + "。",
                    "rule_judgement": "；".join(
                        _unique([item.rule_judgement.rstrip("。") for item in items])
                    )
                    + "。",
                    "possible_causes": _unique(
                        [cause for item in items for cause in item.possible_causes]
                    ),
                    "recommended_checks": _unique(
                        [check for item in items for check in item.recommended_checks]
                    ),
                    "confidence_warning": _unique(
                        [warning for item in items for warning in item.confidence_warning]
                    ),
                    "evidence": list(evidence_by_key.values())[:max_evidence],
                    "sample_size": max(item.sample_size for item in items),
                    "coverage": min(
                        (item.coverage for item in items if item.coverage is not None),
                        default=None,
                    ),
                },
                deep=True,
            )
        )
    return sorted(
        merged,
        key=lambda item: (SEVERITY_RANK[item.severity], item.priority),
        reverse=True,
    )


def timeline_for_order(
    computation: DiagnosticComputation,
    order_id: str,
) -> list[TimelineEvent]:
    timeline: list[TimelineEvent] = []
    for source, events in (
        ("warehouse", computation.warehouse_events_by_order.get(order_id, [])),
        ("tracking", computation.tracking_events_by_order.get(order_id, [])),
    ):
        for event in events:
            timeline.append(
                TimelineEvent(
                    source=cast(Any, source),
                    event_id=event.event_id,
                    event_time=event.event_time.isoformat(),
                    event_code=event.event_code,
                    raw_status=str(event.raw.get("raw_status") or event.event_code),
                    shipment_id=(
                        str(event.raw["shipment_id"])
                        if event.raw.get("shipment_id") is not None
                        else None
                    ),
                    location_code=(
                        str(event.raw["location_code"])
                        if event.raw.get("location_code") is not None
                        else None
                    ),
                )
            )
    return sorted(timeline, key=lambda item: (item.event_time, item.event_id))
