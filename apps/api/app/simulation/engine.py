from __future__ import annotations

import copy
import hashlib
import json
import math
import random
from collections import Counter, defaultdict
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from app.metrics.engine import build_metrics, evaluate, parse_time
from app.metrics.models import DEFINITION_VERSION, MetricResult
from app.simulation.models import (
    ASSUMPTIONS_VERSION,
    ESTIMATE_LABEL,
    SIMULATION_DEFINITION_VERSION,
    AdjustmentDetail,
    BaselineResponse,
    CarrierDistributionItem,
    MetricComparison,
    MetricSnapshot,
    ScenarioParameters,
    SensitivityPoint,
    SensitivityRequest,
    SensitivityResponse,
    SimulationResponse,
)

WAREHOUSE_NODE_LABELS = {
    "order_to_pick": "接单后等待拣货",
    "picking": "拣货处理",
    "pick_to_qc": "拣货后等待复核",
    "quality_check": "复核处理",
    "packing": "打包处理",
}
COMPARISON_CODES = (
    "ot_rate",
    "if_rate",
    "otif_rate",
    "fulfillment_duration_mean_hours",
    "fulfillment_duration_median_hours",
    "fulfillment_duration_p90_hours",
    "anomaly_order_rate",
)


@dataclass
class SimulationArtifacts:
    orders: list[dict[str, Any]]
    warehouse_events: list[dict[str, Any]]
    tracking_events: list[dict[str, Any]]
    source_order_ids: dict[str, str]
    adjustments: list[AdjustmentDetail] = field(default_factory=list)
    affected_order_ids: set[str] = field(default_factory=set)
    adjusted_nodes: set[str] = field(default_factory=set)
    skipped_counts: Counter[str] = field(default_factory=Counter)
    warnings: list[str] = field(default_factory=list)
    orders_by_id: dict[str, dict[str, Any]] = field(default_factory=dict)
    warehouse_by_order: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    tracking_by_order: dict[str, list[dict[str, Any]]] = field(default_factory=dict)


def _rebuild_artifact_indexes(artifacts: SimulationArtifacts) -> None:
    artifacts.orders_by_id = {str(order.get("order_id")): order for order in artifacts.orders}
    warehouse_by_order: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    tracking_by_order: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    for event in artifacts.warehouse_events:
        warehouse_by_order[str(event.get("order_id"))].append(event)
    for event in artifacts.tracking_events:
        tracking_by_order[str(event.get("order_id"))].append(event)
    artifacts.warehouse_by_order = dict(warehouse_by_order)
    artifacts.tracking_by_order = dict(tracking_by_order)


def _jsonable_rows(rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    return [dict(row) for row in rows]


def input_fingerprint(
    orders: Sequence[dict[str, Any]],
    warehouse_events: Sequence[dict[str, Any]],
    tracking_events: Sequence[dict[str, Any]],
) -> str:
    payload = {
        "orders": _jsonable_rows(orders),
        "warehouse_events": _jsonable_rows(warehouse_events),
        "tracking_events": _jsonable_rows(tracking_events),
    }
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _scenario_fingerprint(input_hash: str, parameters: ScenarioParameters) -> str:
    payload = {
        "input_fingerprint": input_hash,
        "parameters": parameters.model_dump(mode="json"),
        "definition_version": SIMULATION_DEFINITION_VERSION,
        "assumptions_version": ASSUMPTIONS_VERSION,
    }
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _metric_map(rows: list[MetricResult]) -> dict[str, MetricResult]:
    return {item.code: item for item in rows}


def _metric_snapshots(rows: list[MetricResult]) -> list[MetricSnapshot]:
    metrics = _metric_map(rows)
    return [
        MetricSnapshot(
            code=item.code,
            display_name=item.display_name,
            value=item.value,
            unit=item.unit,
            numerator=item.numerator,
            denominator=item.denominator,
            coverage=item.coverage,
            warnings=item.warnings,
        )
        for code in COMPARISON_CODES
        if (item := metrics.get(code)) is not None
    ]


def build_baseline(
    *,
    datasets: Any,
    timezone: str,
    orders: Sequence[dict[str, Any]],
    warehouse_events: Sequence[dict[str, Any]],
    tracking_events: Sequence[dict[str, Any]],
) -> BaselineResponse:
    output = evaluate(orders, warehouse_events, tracking_events)
    metrics = build_metrics(output)
    carrier_counts = Counter(
        str(order.get("carrier_id"))
        for order in orders
        if order.get("carrier_id") is not None and str(order.get("carrier_id")).strip()
    )
    carrier_total = sum(carrier_counts.values())
    distribution = [
        CarrierDistributionItem(
            carrier_id=carrier,
            order_count=count,
            share=count / carrier_total if carrier_total else 0,
        )
        for carrier, count in sorted(carrier_counts.items())
    ]
    warnings = list(dict.fromkeys(warning.message for warning in output.warnings))
    if not orders:
        warnings.append("订单数据集为空，基线指标不可计算。")
    return BaselineResponse(
        datasets=datasets,
        timezone=timezone,
        input_fingerprint=input_fingerprint(orders, warehouse_events, tracking_events),
        calculated_at=datetime.now(UTC),
        metrics=_metric_snapshots(metrics),
        carrier_distribution=distribution,
        order_count=output.total_unique_orders,
        warnings=list(dict.fromkeys(warnings)),
        metrics_definition_version=DEFINITION_VERSION,
    )


def _shift_iso(value: object, delta_hours: float) -> str | None:
    if not isinstance(value, str):
        return None
    parsed = parse_time(value)
    if parsed is None:
        return None
    original = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return (original - timedelta(hours=delta_hours)).isoformat()


def _extend_iso(value: object, delta_hours: float) -> str | None:
    if not isinstance(value, str):
        return None
    parsed = parse_time(value)
    if parsed is None:
        return None
    original = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return (original + timedelta(hours=delta_hours)).isoformat()


def _shift_order_delivery(
    artifacts: SimulationArtifacts,
    order_id: str,
    cutoff: datetime,
    delta_hours: float,
) -> None:
    order = artifacts.orders_by_id.get(order_id)
    if order is None:
        return
    actual = parse_time(order.get("actual_delivery_time"))
    if actual is not None and actual >= cutoff:
        shifted = _shift_iso(order.get("actual_delivery_time"), delta_hours)
        if shifted is not None:
            order["actual_delivery_time"] = shifted


def _shift_events(
    rows_by_order: dict[str, list[dict[str, Any]]],
    *,
    order_id: str,
    cutoff: datetime,
    delta_hours: float,
) -> None:
    for event in rows_by_order.get(order_id, []):
        event_time = parse_time(event.get("event_time"))
        if event_time is None or event_time < cutoff:
            continue
        shifted = _shift_iso(event.get("event_time"), delta_hours)
        if shifted is not None:
            event["event_time"] = shifted


def _largest_remainder_allocations(
    total: int,
    weights: dict[str, float],
) -> dict[str, int]:
    raw = {carrier: total * weight / 100 for carrier, weight in weights.items()}
    allocations = {carrier: math.floor(value) for carrier, value in raw.items()}
    remaining = total - sum(allocations.values())
    ranked = sorted(
        weights,
        key=lambda carrier: (-(raw[carrier] - allocations[carrier]), carrier),
    )
    for carrier in ranked[:remaining]:
        allocations[carrier] += 1
    return allocations


def _apply_carrier_mix(
    artifacts: SimulationArtifacts,
    parameters: ScenarioParameters,
) -> None:
    mix = parameters.carrier_mix
    if mix is None:
        return
    pools: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    unknown_orders: list[dict[str, Any]] = []
    for order in artifacts.orders:
        carrier = order.get("carrier_id")
        if carrier is None or not str(carrier).strip():
            unknown_orders.append(order)
        else:
            pools[str(carrier)].append(order)
    historical_carriers = set(pools)
    target_carriers = set(mix.weights)
    if target_carriers != historical_carriers:
        missing = sorted(historical_carriers - target_carriers)
        extra = sorted(target_carriers - historical_carriers)
        parts: list[str] = []
        if missing:
            parts.append(f"缺少历史承运商权重：{', '.join(missing)}")
        if extra:
            parts.append(f"目标承运商没有历史样本：{', '.join(extra)}")
        raise ValueError("；".join(parts))
    eligible_count = sum(len(pool) for pool in pools.values())
    if eligible_count == 0:
        raise ValueError("没有可用于承运商结构调整的历史订单")
    allocations = _largest_remainder_allocations(eligible_count, mix.weights)
    rng = random.Random(mix.random_seed)
    warehouse_by_order: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    tracking_by_order: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    for event in artifacts.warehouse_events:
        warehouse_by_order[str(event.get("order_id"))].append(event)
    for event in artifacts.tracking_events:
        tracking_by_order[str(event.get("order_id"))].append(event)

    resampled_orders = [copy.deepcopy(order) for order in unknown_orders]
    resampled_warehouse = [
        copy.deepcopy(event)
        for order in unknown_orders
        for event in warehouse_by_order[str(order.get("order_id"))]
    ]
    resampled_tracking = [
        copy.deepcopy(event)
        for order in unknown_orders
        for event in tracking_by_order[str(order.get("order_id"))]
    ]
    source_map = {
        str(order.get("order_id")): artifacts.source_order_ids.get(
            str(order.get("order_id")), str(order.get("order_id"))
        )
        for order in unknown_orders
    }
    sequence = 0
    for carrier in sorted(allocations):
        count = allocations[carrier]
        pool = pools[carrier]
        if count <= len(pool):
            sampled = rng.sample(pool, count)
        else:
            sampled = [rng.choice(pool) for _ in range(count)]
        if len(pool) < 30 and count:
            artifacts.warnings.append(
                f"承运商 {carrier} 仅有 {len(pool)} 个历史订单，重采样结果不稳定。"
            )
        for source_order in sampled:
            sequence += 1
            source_id = str(source_order.get("order_id"))
            original_source_id = artifacts.source_order_ids.get(source_id, source_id)
            digest = hashlib.sha256(f"{source_id}-{sequence}".encode()).hexdigest()[:8]
            simulated_id = f"SIM-{sequence:06d}-{digest}"
            cloned_order = copy.deepcopy(source_order)
            cloned_order["order_id"] = simulated_id
            resampled_orders.append(cloned_order)
            source_map[simulated_id] = original_source_id
            for event_index, source_event in enumerate(warehouse_by_order[source_id], start=1):
                event = copy.deepcopy(source_event)
                event["order_id"] = simulated_id
                event["event_id"] = f"SIM-W-{sequence:06d}-{event_index:04d}"
                resampled_warehouse.append(event)
            for event_index, source_event in enumerate(tracking_by_order[source_id], start=1):
                event = copy.deepcopy(source_event)
                event["order_id"] = simulated_id
                event["tracking_event_id"] = f"SIM-T-{sequence:06d}-{event_index:04d}"
                resampled_tracking.append(event)
            artifacts.adjustments.append(
                AdjustmentDetail(
                    transform_type="carrier_mix_resample",
                    order_id=simulated_id,
                    source_order_id=original_source_id,
                    field_name="carrier_id",
                    before_value=carrier,
                    after_value=carrier,
                    explanation=(
                        f"从承运商 {carrier} 的历史联合分布按固定种子抽取该样本；"
                        "这不是把原订单真实改派给承运商。"
                    ),
                )
            )
            artifacts.affected_order_ids.add(simulated_id)
    artifacts.orders = resampled_orders
    artifacts.warehouse_events = resampled_warehouse
    artifacts.tracking_events = resampled_tracking
    artifacts.source_order_ids = source_map


def _apply_warehouse_improvements(
    artifacts: SimulationArtifacts,
    parameters: ScenarioParameters,
) -> None:
    for improvement in parameters.warehouse_improvements:
        if improvement.value == 0:
            continue
        output = evaluate(
            artifacts.orders,
            artifacts.warehouse_events,
            artifacts.tracking_events,
        )
        matched = 0
        for evaluation in output.evaluations:
            detail = evaluation.detail
            if improvement.warehouse_ids and detail.warehouse_id not in improvement.warehouse_ids:
                continue
            node = next(
                (
                    item
                    for item in detail.node_durations
                    if item.interval_code == improvement.node_code
                ),
                None,
            )
            if node is None:
                artifacts.skipped_counts[f"{improvement.node_code}:missing_interval"] += 1
                continue
            reduction = (
                improvement.value
                if improvement.method == "fixed_hours"
                else node.duration_hours * improvement.value / 100
            )
            reduction = min(reduction, node.duration_hours)
            if reduction <= 0:
                continue
            cutoff = parse_time(node.end_time)
            if cutoff is None:
                artifacts.skipped_counts[f"{improvement.node_code}:invalid_time"] += 1
                continue
            _shift_events(
                artifacts.warehouse_by_order,
                order_id=detail.order_id,
                cutoff=cutoff,
                delta_hours=reduction,
            )
            _shift_events(
                artifacts.tracking_by_order,
                order_id=detail.order_id,
                cutoff=cutoff,
                delta_hours=reduction,
            )
            _shift_order_delivery(artifacts, detail.order_id, cutoff, reduction)
            source_id = artifacts.source_order_ids.get(detail.order_id, detail.order_id)
            artifacts.adjustments.append(
                AdjustmentDetail(
                    transform_type="warehouse_improvement",
                    order_id=detail.order_id,
                    source_order_id=source_id,
                    field_name="node_duration_hours",
                    node_code=improvement.node_code,
                    before_value=node.duration_hours,
                    after_value=node.duration_hours - reduction,
                    delta_hours=-reduction,
                    explanation=(
                        f"{WAREHOUSE_NODE_LABELS[improvement.node_code]}节省 {reduction:.3f} 小时，"
                        "并假设节省时间完整传导到后续事件。"
                    ),
                )
            )
            artifacts.affected_order_ids.add(detail.order_id)
            artifacts.adjusted_nodes.add(improvement.node_code)
            matched += 1
        if matched == 0:
            artifacts.warnings.append(
                f"{WAREHOUSE_NODE_LABELS[improvement.node_code]}没有完整有效区间，未施加改善。"
            )


def _apply_pickup_improvement(
    artifacts: SimulationArtifacts,
    parameters: ScenarioParameters,
) -> None:
    improvement = parameters.pickup_improvement
    if improvement is None or improvement.reduction_hours == 0:
        return
    output = evaluate(
        artifacts.orders,
        artifacts.warehouse_events,
        artifacts.tracking_events,
    )
    matched = 0
    for evaluation in output.evaluations:
        detail = evaluation.detail
        if improvement.carrier_ids and detail.carrier_id not in improvement.carrier_ids:
            continue
        node = next(
            (item for item in detail.node_durations if item.interval_code == "ready_to_pickup"),
            None,
        )
        if node is None:
            artifacts.skipped_counts["ready_to_pickup:missing_interval"] += 1
            continue
        reduction = min(improvement.reduction_hours, node.duration_hours)
        if reduction <= 0:
            continue
        cutoff = parse_time(node.end_time)
        if cutoff is None:
            artifacts.skipped_counts["ready_to_pickup:invalid_time"] += 1
            continue
        _shift_events(
            artifacts.tracking_by_order,
            order_id=detail.order_id,
            cutoff=cutoff,
            delta_hours=reduction,
        )
        _shift_order_delivery(artifacts, detail.order_id, cutoff, reduction)
        source_id = artifacts.source_order_ids.get(detail.order_id, detail.order_id)
        artifacts.adjustments.append(
            AdjustmentDetail(
                transform_type="pickup_improvement",
                order_id=detail.order_id,
                source_order_id=source_id,
                field_name="ready_to_pickup_hours",
                node_code="ready_to_pickup",
                before_value=node.duration_hours,
                after_value=node.duration_hours - reduction,
                delta_hours=-reduction,
                explanation=(f"出库至揽收等待减少 {reduction:.3f} 小时，并假设后续轨迹等量前移。"),
            )
        )
        artifacts.affected_order_ids.add(detail.order_id)
        artifacts.adjusted_nodes.add("ready_to_pickup")
        matched += 1
    if matched == 0:
        artifacts.warnings.append("没有完整的出库至揽收区间，未施加等待改善。")


def _apply_promise_strategy(
    artifacts: SimulationArtifacts,
    parameters: ScenarioParameters,
) -> None:
    strategy = parameters.promise_strategy
    if strategy is None or strategy.extension_hours == 0:
        return
    matched = 0
    for order in artifacts.orders:
        before = order.get("promised_delivery_time")
        after = _extend_iso(before, strategy.extension_hours)
        order_id = str(order.get("order_id"))
        if after is None:
            artifacts.skipped_counts["promise_strategy:missing_or_invalid"] += 1
            continue
        order["promised_delivery_time"] = after
        source_id = artifacts.source_order_ids.get(order_id, order_id)
        artifacts.adjustments.append(
            AdjustmentDetail(
                transform_type="promise_strategy",
                order_id=order_id,
                source_order_id=source_id,
                field_name="promised_delivery_time",
                before_value=str(before),
                after_value=after,
                delta_hours=strategy.extension_hours,
                explanation=(
                    f"承诺交付时间放宽 {strategy.extension_hours:.3f} 小时；"
                    "实际作业和交付时间未改善。"
                ),
            )
        )
        artifacts.affected_order_ids.add(order_id)
        matched += 1
    if matched == 0:
        artifacts.warnings.append("没有有效承诺时间，承诺策略未作用于任何订单。")
    artifacts.warnings.append("放宽承诺可能提高 OT/OTIF，但不等于真实运营改善。")


def transform_rows(
    orders: Sequence[dict[str, Any]],
    warehouse_events: Sequence[dict[str, Any]],
    tracking_events: Sequence[dict[str, Any]],
    parameters: ScenarioParameters,
) -> SimulationArtifacts:
    original_hash = input_fingerprint(orders, warehouse_events, tracking_events)
    artifacts = SimulationArtifacts(
        orders=copy.deepcopy(list(orders)),
        warehouse_events=copy.deepcopy(list(warehouse_events)),
        tracking_events=copy.deepcopy(list(tracking_events)),
        source_order_ids={str(row.get("order_id")): str(row.get("order_id")) for row in orders},
    )
    _apply_carrier_mix(artifacts, parameters)
    _rebuild_artifact_indexes(artifacts)
    _apply_warehouse_improvements(artifacts, parameters)
    _apply_pickup_improvement(artifacts, parameters)
    _apply_promise_strategy(artifacts, parameters)
    if original_hash != input_fingerprint(orders, warehouse_events, tracking_events):
        raise RuntimeError("模拟过程修改了原始输入")
    return artifacts


def _comparison(
    baseline: MetricResult,
    scenario: MetricResult,
) -> MetricComparison:
    absolute: float | int | None = None
    relative: float | None = None
    warnings = list(dict.fromkeys([*baseline.warnings, *scenario.warnings]))
    if baseline.value is not None and scenario.value is not None:
        absolute = scenario.value - baseline.value
        if baseline.value != 0:
            relative = float(absolute) / abs(float(baseline.value))
        elif scenario.value != 0:
            warnings.append("基线值为 0，相对变化不可计算。")
    else:
        warnings.append("基线或方案指标不可计算，未生成变化值。")
    return MetricComparison(
        code=baseline.code,
        display_name=baseline.display_name,
        unit=baseline.unit,
        baseline_value=baseline.value,
        scenario_value=scenario.value,
        absolute_change=absolute,
        relative_change=relative,
        baseline_numerator=baseline.numerator,
        baseline_denominator=baseline.denominator,
        scenario_numerator=scenario.numerator,
        scenario_denominator=scenario.denominator,
        baseline_coverage=baseline.coverage,
        scenario_coverage=scenario.coverage,
        warnings=warnings,
    )


def run_simulation(
    *,
    scenario_id: str | None,
    scenario_name: str,
    datasets: Any,
    timezone: str,
    orders: Sequence[dict[str, Any]],
    warehouse_events: Sequence[dict[str, Any]],
    tracking_events: Sequence[dict[str, Any]],
    parameters: ScenarioParameters,
    adjustment_detail_limit: int = 200,
) -> SimulationResponse:
    source_hash = input_fingerprint(orders, warehouse_events, tracking_events)
    baseline_output = evaluate(orders, warehouse_events, tracking_events)
    baseline_metrics = _metric_map(build_metrics(baseline_output))
    try:
        artifacts = transform_rows(orders, warehouse_events, tracking_events, parameters)
    except ValueError:
        raise
    scenario_output = evaluate(
        artifacts.orders,
        artifacts.warehouse_events,
        artifacts.tracking_events,
    )
    scenario_metrics = _metric_map(build_metrics(scenario_output))
    comparisons = [
        _comparison(baseline_metrics[code], scenario_metrics[code]) for code in COMPARISON_CODES
    ]
    affected_count = len(artifacts.affected_order_ids)
    comparisons.append(
        MetricComparison(
            code="affected_order_count",
            display_name="受影响订单数",
            unit="order",
            baseline_value=0,
            scenario_value=affected_count,
            absolute_change=affected_count,
            relative_change=None,
            baseline_numerator=0,
            baseline_denominator=baseline_output.total_unique_orders,
            scenario_numerator=affected_count,
            scenario_denominator=scenario_output.total_unique_orders,
            baseline_coverage=1 if baseline_output.total_unique_orders else None,
            scenario_coverage=(
                affected_count / scenario_output.total_unique_orders
                if scenario_output.total_unique_orders
                else None
            ),
            warnings=["基线受影响订单数固定为 0，因此不提供相对变化。"],
        )
    )
    warnings = list(artifacts.warnings)
    warnings.extend(warning.message for warning in scenario_output.warnings)
    if scenario_output.total_unique_orders == 0:
        warnings.append("方案没有可计算订单，所有结果均为空。")
    assumptions = [
        "所有变换先作用于订单或事件副本，再重新调用指标引擎；原始数据不被覆盖。",
        "仓内和揽收节省时间假设完整传导到后续事件及实际交付时间。",
        "模型不包含资源容量、排班、线路、成本、需求变化或因果效应。",
    ]
    if parameters.carrier_mix is not None:
        assumptions.append(
            "承运商结构采用固定种子的历史订单联合分布经验重采样，不代表真实改派结果。"
        )
    if parameters.promise_strategy is not None:
        assumptions.append("承诺时间调整不改变任何真实作业或交付时间。")
    return SimulationResponse(
        scenario_id=scenario_id,
        scenario_name=scenario_name,
        datasets=datasets,
        timezone=timezone,
        input_fingerprint=source_hash,
        scenario_fingerprint=_scenario_fingerprint(source_hash, parameters),
        calculated_at=datetime.now(UTC),
        parameters=parameters,
        comparisons=comparisons,
        affected_order_count=affected_count,
        total_adjustments=len(artifacts.adjustments),
        adjustments=artifacts.adjustments[:adjustment_detail_limit],
        adjustments_truncated=len(artifacts.adjustments) > adjustment_detail_limit,
        adjusted_nodes=sorted(artifacts.adjusted_nodes),
        skipped_counts=dict(sorted(artifacts.skipped_counts.items())),
        assumptions=assumptions,
        warnings=list(dict.fromkeys(warnings)),
        random_seed=(
            parameters.carrier_mix.random_seed if parameters.carrier_mix is not None else None
        ),
        metrics_definition_version=DEFINITION_VERSION,
    )


def _sensitivity_parameters(
    request: SensitivityRequest,
    value: float,
) -> ScenarioParameters:
    data = request.parameters.model_dump(mode="python")
    if request.parameter == "warehouse_improvement_value":
        improvements = data["warehouse_improvements"]
        if request.warehouse_improvement_index >= len(improvements):
            raise ValueError("指定的仓内改善参数不存在")
        improvements[request.warehouse_improvement_index]["value"] = value
    elif request.parameter == "pickup_reduction_hours":
        if data["pickup_improvement"] is None:
            raise ValueError("方案尚未启用揽收等待改善")
        data["pickup_improvement"]["reduction_hours"] = value
    elif request.parameter == "promise_extension_hours":
        if data["promise_strategy"] is None:
            raise ValueError("方案尚未启用承诺时效策略")
        data["promise_strategy"]["extension_hours"] = value
    return ScenarioParameters.model_validate(data)


def sensitivity_analysis(
    *,
    request: SensitivityRequest,
    orders: Sequence[dict[str, Any]],
    warehouse_events: Sequence[dict[str, Any]],
    tracking_events: Sequence[dict[str, Any]],
) -> SensitivityResponse:
    points: list[SensitivityPoint] = []
    all_warnings: list[str] = []
    for value in request.values:
        parameters = _sensitivity_parameters(request, value)
        result = run_simulation(
            scenario_id=None,
            scenario_name="敏感性分析",
            datasets=request.datasets,
            timezone=request.timezone,
            orders=orders,
            warehouse_events=warehouse_events,
            tracking_events=tracking_events,
            parameters=parameters,
            adjustment_detail_limit=1,
        )
        metrics = {item.code: item.scenario_value for item in result.comparisons}
        point_warnings = list(
            dict.fromkeys(
                warning
                for item in result.comparisons
                for warning in item.warnings
                if "样本量" in warning or "不可计算" in warning
            )
        )
        points.append(
            SensitivityPoint(
                parameter_value=value,
                otif=_as_float(metrics.get("otif_rate")),
                fulfillment_mean_hours=_as_float(metrics.get("fulfillment_duration_mean_hours")),
                fulfillment_p50_hours=_as_float(metrics.get("fulfillment_duration_median_hours")),
                fulfillment_p90_hours=_as_float(metrics.get("fulfillment_duration_p90_hours")),
                anomaly_rate=_as_float(metrics.get("anomaly_order_rate")),
                affected_order_count=result.affected_order_count,
                warnings=point_warnings,
            )
        )
        all_warnings.extend(result.warnings)
    unit: Literal["hour", "percentage"] = (
        "percentage"
        if request.parameter == "warehouse_improvement_value"
        and request.parameters.warehouse_improvements[request.warehouse_improvement_index].method
        == "percentage"
        else "hour"
    )
    return SensitivityResponse(
        parameter=request.parameter,
        unit=unit,
        points=points,
        input_fingerprint=input_fingerprint(orders, warehouse_events, tracking_events),
        warnings=list(dict.fromkeys(all_warnings)),
    )


def _as_float(value: float | int | None) -> float | None:
    return float(value) if value is not None else None


__all__ = [
    "ESTIMATE_LABEL",
    "build_baseline",
    "input_fingerprint",
    "run_simulation",
    "sensitivity_analysis",
    "transform_rows",
]
