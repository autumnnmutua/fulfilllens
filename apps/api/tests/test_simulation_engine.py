from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any, cast

import pytest
from app.metrics.engine import evaluate
from app.metrics.models import DatasetSelection
from app.simulation.engine import (
    build_baseline,
    run_simulation,
    sensitivity_analysis,
    transform_rows,
)
from app.simulation.models import (
    CarrierMixAdjustment,
    PickupImprovement,
    PromiseStrategy,
    ScenarioParameters,
    SensitivityRequest,
    WarehouseImprovement,
)
from pydantic import ValidationError

FIXTURE = Path(__file__).parent / "fixtures" / "gold_metrics.json"
SELECTION = DatasetSelection(
    orders_dataset_id="11111111-1111-4111-8111-111111111111",
    warehouse_events_dataset_id="22222222-2222-4222-8222-222222222222",
    tracking_events_dataset_id="33333333-3333-4333-8333-333333333333",
)


@pytest.fixture
def gold() -> dict[str, Any]:
    return cast(dict[str, Any], json.loads(FIXTURE.read_text(encoding="utf-8")))


def run(gold: dict[str, Any], parameters: ScenarioParameters):
    return run_simulation(
        scenario_id=None,
        scenario_name="测试方案",
        datasets=SELECTION,
        timezone="Asia/Shanghai",
        orders=gold["orders"],
        warehouse_events=gold["warehouse_events"],
        tracking_events=gold["tracking_events"],
        parameters=parameters,
    )


def comparisons(result: Any) -> dict[str, Any]:
    return {item.code: item for item in result.comparisons}


def test_baseline_reuses_metric_engine_and_returns_lineage(gold: dict[str, Any]) -> None:
    baseline = build_baseline(
        datasets=SELECTION,
        timezone="Asia/Shanghai",
        orders=gold["orders"],
        warehouse_events=gold["warehouse_events"],
        tracking_events=gold["tracking_events"],
    )
    metrics = {item.code: item for item in baseline.metrics}

    assert baseline.order_count == 8
    assert metrics["otif_rate"].value == pytest.approx(0.6)
    assert metrics["fulfillment_duration_p90_hours"].value == pytest.approx(63)
    assert len(baseline.input_fingerprint) == 64
    assert {item.carrier_id for item in baseline.carrier_distribution} == {"CAR-A", "CAR-B"}


def test_zero_parameter_scenario_equals_baseline(gold: dict[str, Any]) -> None:
    result = run(gold, ScenarioParameters())

    assert result.affected_order_count == 0
    assert result.total_adjustments == 0
    assert all(
        item.absolute_change == 0
        for item in result.comparisons
        if item.code != "affected_order_count" and item.baseline_value is not None
    )


def test_warehouse_fixed_reduction_shifts_node_and_delivery(gold: dict[str, Any]) -> None:
    parameters = ScenarioParameters(
        warehouse_improvements=[
            WarehouseImprovement(node_code="picking", method="fixed_hours", value=0.5)
        ]
    )
    artifacts = transform_rows(
        gold["orders"],
        gold["warehouse_events"],
        gold["tracking_events"],
        parameters,
    )
    detail = (
        evaluate(
            artifacts.orders,
            artifacts.warehouse_events,
            artifacts.tracking_events,
        )
        .evaluations[0]
        .detail
    )
    picking = next(item for item in detail.node_durations if item.interval_code == "picking")

    assert picking.duration_hours == pytest.approx(1)
    assert detail.fulfillment_duration_hours == pytest.approx(51.5)
    assert len(artifacts.affected_order_ids) == 1
    assert artifacts.adjustments[0].source_order_id == "ORD-GOLD-001"


def test_warehouse_percentage_is_capped_at_original_duration(gold: dict[str, Any]) -> None:
    result = run(
        gold,
        ScenarioParameters(
            warehouse_improvements=[
                WarehouseImprovement(node_code="picking", method="percentage", value=100)
            ]
        ),
    )

    adjustment = result.adjustments[0]
    assert adjustment.before_value == pytest.approx(1.5)
    assert adjustment.after_value == pytest.approx(0)
    assert adjustment.delta_hours == pytest.approx(-1.5)


def test_warehouse_filter_protects_non_matching_orders(gold: dict[str, Any]) -> None:
    result = run(
        gold,
        ScenarioParameters(
            warehouse_improvements=[
                WarehouseImprovement(
                    node_code="picking",
                    method="fixed_hours",
                    value=1,
                    warehouse_ids=["WH-NOT-FOUND"],
                )
            ]
        ),
    )

    assert result.affected_order_count == 0
    assert any("没有完整有效区间" in warning for warning in result.warnings)


def test_pickup_reduction_uses_complete_interval_only(gold: dict[str, Any]) -> None:
    parameters = ScenarioParameters(pickup_improvement=PickupImprovement(reduction_hours=1))
    artifacts = transform_rows(
        gold["orders"],
        gold["warehouse_events"],
        gold["tracking_events"],
        parameters,
    )
    detail = (
        evaluate(
            artifacts.orders,
            artifacts.warehouse_events,
            artifacts.tracking_events,
        )
        .evaluations[0]
        .detail
    )
    pickup = next(item for item in detail.node_durations if item.interval_code == "ready_to_pickup")

    assert pickup.duration_hours == 0
    assert detail.fulfillment_duration_hours == 51
    assert len(artifacts.affected_order_ids) == 1


def test_pickup_reduction_cannot_create_negative_duration(gold: dict[str, Any]) -> None:
    result = run(
        gold,
        ScenarioParameters(pickup_improvement=PickupImprovement(reduction_hours=168)),
    )

    adjustment = next(
        item for item in result.adjustments if item.transform_type == "pickup_improvement"
    )
    assert adjustment.after_value == 0
    assert adjustment.delta_hours == -1


def test_promise_extension_changes_ot_without_changing_duration(gold: dict[str, Any]) -> None:
    result = run(
        gold,
        ScenarioParameters(promise_strategy=PromiseStrategy(extension_hours=16)),
    )
    metrics = comparisons(result)

    assert metrics["ot_rate"].baseline_value == pytest.approx(0.8)
    assert metrics["ot_rate"].scenario_value == pytest.approx(1)
    assert metrics["otif_rate"].scenario_value == pytest.approx(0.8)
    assert metrics["fulfillment_duration_mean_hours"].absolute_change == 0
    assert any("不等于真实运营改善" in warning for warning in result.warnings)


def test_carrier_mix_reconciles_order_count_and_is_reproducible(gold: dict[str, Any]) -> None:
    parameters = ScenarioParameters(
        carrier_mix=CarrierMixAdjustment(
            weights={"CAR-A": 0, "CAR-B": 100},
            random_seed=20260729,
        )
    )
    first = run(gold, parameters)
    second = run(gold, parameters)
    artifacts = transform_rows(
        gold["orders"],
        gold["warehouse_events"],
        gold["tracking_events"],
        parameters,
    )

    assert first.scenario_fingerprint == second.scenario_fingerprint
    assert first.comparisons == second.comparisons
    assert len(artifacts.orders) == len(gold["orders"])
    known_carriers = {
        row["carrier_id"] for row in artifacts.orders if row.get("carrier_id") is not None
    }
    assert known_carriers == {"CAR-B"}
    assert first.affected_order_count == 6


def test_carrier_mix_requires_complete_historical_weight_set(gold: dict[str, Any]) -> None:
    parameters = ScenarioParameters(carrier_mix=CarrierMixAdjustment(weights={"CAR-A": 100}))

    with pytest.raises(ValueError, match="缺少历史承运商权重"):
        run(gold, parameters)


@pytest.mark.parametrize(
    "weights",
    [
        {"CAR-A": 70, "CAR-B": 20},
        {"CAR-A": -1, "CAR-B": 101},
        {},
    ],
)
def test_carrier_weight_validation(weights: dict[str, float]) -> None:
    with pytest.raises(ValidationError):
        CarrierMixAdjustment(weights=weights)


@pytest.mark.parametrize(
    ("parameters", "expected"),
    [
        (
            {"warehouse_improvements": [{"node_code": "picking", "value": 73}]},
            "仓内改善不得超过 72小时",
        ),
        (
            {
                "warehouse_improvements": [
                    {"node_code": "picking", "method": "percentage", "value": 101}
                ]
            },
            "仓内改善不得超过 100%",
        ),
        ({"pickup_improvement": {"reduction_hours": -1}}, "greater than or equal"),
        ({"promise_strategy": {"extension_hours": 169}}, "less than or equal"),
    ],
)
def test_parameter_boundaries(parameters: dict[str, Any], expected: str) -> None:
    with pytest.raises(ValidationError, match=expected):
        ScenarioParameters.model_validate(parameters)


def test_original_rows_are_not_mutated(gold: dict[str, Any]) -> None:
    original = copy.deepcopy(gold)
    run(
        gold,
        ScenarioParameters(
            warehouse_improvements=[WarehouseImprovement(node_code="picking", value=1)],
            pickup_improvement=PickupImprovement(reduction_hours=1),
            promise_strategy=PromiseStrategy(extension_hours=12),
        ),
    )

    assert gold == original


def test_empty_input_returns_no_precise_metrics() -> None:
    result = run_simulation(
        scenario_id=None,
        scenario_name="空方案",
        datasets=SELECTION,
        timezone="Asia/Shanghai",
        orders=[],
        warehouse_events=[],
        tracking_events=[],
        parameters=ScenarioParameters(pickup_improvement=PickupImprovement(reduction_hours=1)),
    )

    assert result.affected_order_count == 0
    assert comparisons(result)["otif_rate"].scenario_value is None
    assert any("没有可计算订单" in warning for warning in result.warnings)


@pytest.mark.parametrize(
    ("parameter", "parameters", "values"),
    [
        (
            "warehouse_improvement_value",
            ScenarioParameters(warehouse_improvements=[WarehouseImprovement(node_code="picking")]),
            [0, 0.5, 1],
        ),
        (
            "pickup_reduction_hours",
            ScenarioParameters(pickup_improvement=PickupImprovement()),
            [0, 0.5, 1],
        ),
        (
            "promise_extension_hours",
            ScenarioParameters(promise_strategy=PromiseStrategy()),
            [0, 8, 16],
        ),
    ],
)
def test_sensitivity_is_reproducible_and_ordered(
    gold: dict[str, Any],
    parameter: str,
    parameters: ScenarioParameters,
    values: list[float],
) -> None:
    request = SensitivityRequest(
        datasets=SELECTION,
        parameters=parameters,
        parameter=parameter,
        values=values,
    )
    first = sensitivity_analysis(
        request=request,
        orders=gold["orders"],
        warehouse_events=gold["warehouse_events"],
        tracking_events=gold["tracking_events"],
    )
    second = sensitivity_analysis(
        request=request,
        orders=gold["orders"],
        warehouse_events=gold["warehouse_events"],
        tracking_events=gold["tracking_events"],
    )

    assert first == second
    assert [point.parameter_value for point in first.points] == values


def test_sensitivity_rejects_inactive_parameter(gold: dict[str, Any]) -> None:
    request = SensitivityRequest(
        datasets=SELECTION,
        parameters=ScenarioParameters(),
        parameter="pickup_reduction_hours",
        values=[0, 1, 2],
    )

    with pytest.raises(ValueError, match="尚未启用"):
        sensitivity_analysis(
            request=request,
            orders=gold["orders"],
            warehouse_events=gold["warehouse_events"],
            tracking_events=gold["tracking_events"],
        )
