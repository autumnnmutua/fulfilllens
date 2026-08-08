import json
from copy import deepcopy
from pathlib import Path
from typing import Any, cast

import pytest
from app.metrics.engine import (
    breakdown,
    build_metrics,
    distribution,
    evaluate,
    quantile_type7,
    trend,
)
from app.metrics.models import DatasetSelection, MetricResult

FIXTURE = Path(__file__).parent / "fixtures" / "gold_metrics.json"


@pytest.fixture(scope="module")
def gold() -> dict[str, Any]:
    return cast(
        dict[str, Any],
        json.loads(FIXTURE.read_text(encoding="utf-8")),
    )


def metric(metrics: list[MetricResult], code: str) -> MetricResult:
    return next(item for item in metrics if item.code == code)


def selection() -> DatasetSelection:
    return DatasetSelection(
        orders_dataset_id="11111111-1111-4111-8111-111111111111",
        warehouse_events_dataset_id="22222222-2222-4222-8222-222222222222",
        tracking_events_dataset_id="33333333-3333-4333-8333-333333333333",
    )


def single_order(**overrides: object) -> dict[str, object]:
    order = {
        "order_id": "ORD-ONE",
        "created_at": "2026-07-01T08:00:00+08:00",
        "promised_delivery_time": "2026-07-02T08:00:00+08:00",
        "actual_delivery_time": "2026-07-02T08:00:00+08:00",
        "ordered_quantity": 1,
        "delivered_quantity": 1,
        "quantity_unit": "piece",
        "order_status": "delivered",
        "raw_order_status": "已签收",
    }
    order.update(overrides)
    return order


def test_empty_data_returns_zero_counts_and_null_rates() -> None:
    metrics = build_metrics(evaluate([]))

    assert metric(metrics, "order_count").value == 0
    assert metric(metrics, "otif_rate").value is None
    assert metric(metrics, "fulfillment_duration_p90_hours").value is None


def test_single_order_equals_promise_is_ot_if_and_otif() -> None:
    output = evaluate([single_order()])
    metrics = build_metrics(output)

    assert metric(metrics, "ot_rate").value == 1
    assert metric(metrics, "if_rate").value == 1
    assert metric(metrics, "otif_rate").value == 1
    assert output.evaluations[0].detail.ot.status == "true"


def test_gold_order_counts(gold: dict[str, Any]) -> None:
    metrics = build_metrics(evaluate(gold["orders"]))

    assert metric(metrics, "order_count").value == gold["expected"]["order_count"]
    assert metric(metrics, "valid_order_count").value == gold["expected"]["valid_order_count"]


def test_gold_ot_denominator_and_coverage(gold: dict[str, Any]) -> None:
    ot = metric(build_metrics(evaluate(gold["orders"])), "ot_rate")

    assert ot.value == pytest.approx(gold["expected"]["ot_rate"])
    assert ot.numerator == gold["expected"]["ot_numerator"]
    assert ot.denominator == gold["expected"]["ot_denominator"]
    assert ot.coverage == pytest.approx(gold["expected"]["ot_coverage"])
    assert ot.not_computable_count == 1


def test_gold_if_is_calculated_on_completed_orders(gold: dict[str, Any]) -> None:
    in_full = metric(build_metrics(evaluate(gold["orders"])), "if_rate")

    assert in_full.value == pytest.approx(gold["expected"]["if_rate"])
    assert in_full.numerator == 5
    assert in_full.denominator == 6


def test_gold_otif_is_order_level_intersection(gold: dict[str, Any]) -> None:
    otif = metric(build_metrics(evaluate(gold["orders"])), "otif_rate")

    assert otif.value == pytest.approx(gold["expected"]["otif_rate"])
    assert otif.numerator == 3
    assert otif.denominator == 5


def test_gold_duration_statistics_use_unrounded_hours(
    gold: dict[str, Any],
) -> None:
    metrics = build_metrics(evaluate(gold["orders"]))

    assert metric(metrics, "fulfillment_duration_mean_hours").value == pytest.approx(
        gold["expected"]["duration_mean"]
    )
    assert metric(metrics, "fulfillment_duration_median_hours").value == pytest.approx(
        gold["expected"]["duration_median"]
    )
    assert metric(metrics, "fulfillment_duration_p90_hours").value == pytest.approx(
        gold["expected"]["duration_p90"]
    )


def test_type7_quantile_empty_single_and_interpolation() -> None:
    assert quantile_type7([], 0.9) is None
    assert quantile_type7([7.5], 0.9) == 7.5
    assert quantile_type7([52, 53, 73], 0.9) == pytest.approx(69)


def test_missing_promise_makes_ot_and_otif_not_computable() -> None:
    detail = evaluate([single_order(promised_delivery_time=None)]).evaluations[0].detail

    assert detail.ot.status == "not_computable"
    assert detail.in_full.status == "true"
    assert detail.otif.status == "not_computable"


def test_missing_delivered_quantity_makes_if_and_otif_not_computable() -> None:
    detail = evaluate([single_order(delivered_quantity=None)]).evaluations[0].detail

    assert detail.ot.status == "true"
    assert detail.in_full.status == "not_computable"
    assert detail.otif.status == "not_computable"


def test_cancelled_order_is_excluded_from_completion_denominators() -> None:
    output = evaluate(
        [
            single_order(),
            single_order(
                order_id="ORD-CANCEL",
                order_status="cancelled",
                actual_delivery_time=None,
                delivered_quantity=0,
            ),
        ]
    )
    metrics = build_metrics(output)
    cancelled = output.evaluations[1].detail

    assert cancelled.ot.status == "excluded"
    assert metric(metrics, "ot_rate").denominator == 1
    assert metric(metrics, "cancellation_rate").value == 0.5


def test_returned_order_keeps_original_delivery_judgement_and_is_anomalous() -> None:
    detail = evaluate([single_order(order_status="returned")]).evaluations[0].detail

    assert detail.otif.status == "true"
    assert detail.anomaly is True
    assert "returned" in detail.anomaly_reasons[0]


def test_pending_order_does_not_enter_completed_denominator() -> None:
    output = evaluate([single_order(order_status="shipped", actual_delivery_time=None)])
    result = metric(build_metrics(output), "ot_rate")

    assert output.evaluations[0].detail.ot.status == "pending"
    assert result.denominator == 0
    assert result.pending_count == 1


def test_exact_duplicate_order_is_counted_once_with_warning() -> None:
    order = single_order()
    output = evaluate([order, deepcopy(order)])

    assert len(output.evaluations) == 1
    assert output.total_unique_orders == 1
    assert any(warning.code == "EXACT_DUPLICATE_ORDER" for warning in output.warnings)


def test_conflicting_duplicate_order_is_isolated() -> None:
    first = single_order()
    second = single_order(delivered_quantity=0)
    output = evaluate([first, second])

    assert output.total_unique_orders == 1
    assert output.evaluations == []
    assert output.invalid_order_count == 1
    assert any(warning.code == "DUPLICATE_ORDER_CONFLICT" for warning in output.warnings)


def test_cross_timezone_comparison_is_done_in_utc() -> None:
    detail = (
        evaluate(
            [
                single_order(
                    promised_delivery_time="2026-07-02T08:00:00+08:00",
                    actual_delivery_time="2026-07-02T00:00:00Z",
                )
            ]
        )
        .evaluations[0]
        .detail
    )

    assert detail.ot.status == "true"
    assert detail.fulfillment_duration_hours == 24


def test_negative_duration_is_not_deleted_and_generates_warning() -> None:
    output = evaluate(
        [
            single_order(
                actual_delivery_time="2026-07-01T07:00:00+08:00",
                promised_delivery_time="2026-07-02T08:00:00+08:00",
            )
        ]
    )
    detail = output.evaluations[0].detail

    assert detail.fulfillment_duration_hours is None
    assert any(warning.code == "NEGATIVE_FULFILLMENT_DURATION" for warning in detail.warnings)
    assert any(warning.code == "NEGATIVE_FULFILLMENT_DURATION" for warning in output.warnings)


def test_gold_node_intervals_and_cross_table_pairing(
    gold: dict[str, Any],
) -> None:
    metrics = build_metrics(
        evaluate(
            gold["orders"],
            gold["warehouse_events"],
            gold["tracking_events"],
        )
    )

    assert metric(metrics, "node_duration_picking_mean_hours").value == pytest.approx(
        gold["expected"]["picking_hours"]
    )
    assert metric(metrics, "node_duration_hub_dwell_mean_hours").value == pytest.approx(
        gold["expected"]["hub_dwell_hours"]
    )
    assert metric(metrics, "node_duration_ready_to_pickup_mean_hours").value == pytest.approx(
        gold["expected"]["ready_to_pickup_hours"]
    )
    assert metric(metrics, "node_duration_carrier_transit_mean_hours").value == pytest.approx(
        gold["expected"]["carrier_transit_hours"]
    )


def test_source_event_order_is_sorted_but_warning_is_retained(
    gold: dict[str, Any],
) -> None:
    output = evaluate(
        gold["orders"],
        gold["warehouse_events"],
        gold["tracking_events"],
    )

    assert any(
        warning.code == "SOURCE_EVENT_OUT_OF_ORDER" and warning.order_id == "ORD-GOLD-002"
        for warning in output.warnings
    )
    order = next(
        evaluation.detail
        for evaluation in output.evaluations
        if evaluation.detail.order_id == "ORD-GOLD-002"
    )
    transit = next(node for node in order.node_durations if node.interval_code == "carrier_transit")
    assert transit.duration_hours == 70


def test_multiple_cycles_use_first_complete_interval_and_warn() -> None:
    events = [
        {
            "event_id": f"E-{index}",
            "order_id": "ORD-ONE",
            "event_time": time,
            "event_code": code,
        }
        for index, (time, code) in enumerate(
            [
                ("2026-07-01T09:00:00+08:00", "picking_started"),
                ("2026-07-01T10:00:00+08:00", "picking_completed"),
                ("2026-07-01T11:00:00+08:00", "picking_started"),
                ("2026-07-01T13:00:00+08:00", "picking_completed"),
            ],
            start=1,
        )
    ]
    output = evaluate([single_order()], events)
    detail = output.evaluations[0].detail

    assert (
        next(
            node.duration_hours for node in detail.node_durations if node.interval_code == "picking"
        )
        == 1
    )
    assert any(warning.code == "MULTIPLE_NODE_CYCLES" for warning in detail.warnings)


def test_end_before_start_has_no_negative_node_duration_and_warns() -> None:
    events = [
        {
            "event_id": "E-END",
            "order_id": "ORD-ONE",
            "event_time": "2026-07-01T09:00:00+08:00",
            "event_code": "picking_completed",
        },
        {
            "event_id": "E-START",
            "order_id": "ORD-ONE",
            "event_time": "2026-07-01T10:00:00+08:00",
            "event_code": "picking_started",
        },
    ]
    output = evaluate([single_order()], events)
    detail = output.evaluations[0].detail

    assert all(node.interval_code != "picking" for node in detail.node_durations)
    assert any(warning.code == "NODE_END_BEFORE_START" for warning in detail.warnings)


def test_gold_cancel_return_anomaly_and_coverage_rates(
    gold: dict[str, Any],
) -> None:
    metrics = build_metrics(
        evaluate(
            gold["orders"],
            gold["warehouse_events"],
            gold["tracking_events"],
        )
    )

    for code, expected in (
        ("cancellation_rate", "cancellation_rate"),
        ("return_rate", "return_rate"),
        ("anomaly_order_rate", "anomaly_rate"),
        ("data_coverage_rate", "data_coverage_rate"),
    ):
        assert metric(metrics, code).value == pytest.approx(gold["expected"][expected])


def test_missing_dimension_is_grouped_as_unknown(gold: dict[str, Any]) -> None:
    response = breakdown(
        evaluate(gold["orders"]),
        dimension="warehouse_id",
        datasets=selection(),
    )
    groups = {group.key: group for group in response.groups}

    assert groups["unknown"].order_count == 2
    assert sum(group.order_count for group in response.groups) == 8


def test_breakdown_reconciles_numerators_and_denominators(
    gold: dict[str, Any],
) -> None:
    output = evaluate(gold["orders"])
    total = metric(build_metrics(output), "otif_rate")
    response = breakdown(
        output,
        dimension="sales_channel",
        datasets=selection(),
    )
    grouped = [metric(group.metrics, "otif_rate") for group in response.groups]

    assert sum(item.numerator or 0 for item in grouped) == total.numerator
    assert sum(item.denominator or 0 for item in grouped) == total.denominator


def test_date_and_week_trends_reconcile_to_total_orders(
    gold: dict[str, Any],
) -> None:
    output = evaluate(gold["orders"])
    daily = trend(
        output,
        grain="date",
        timezone_name="Asia/Shanghai",
        datasets=selection(),
    )
    weekly = trend(
        output,
        grain="week",
        timezone_name="Asia/Shanghai",
        datasets=selection(),
    )

    assert sum(group.order_count for group in daily.groups) == 8
    assert sum(group.order_count for group in weekly.groups) == 8
    assert weekly.groups[0].key == "2026-06-29"


def test_distribution_is_finite_and_reconciles_histogram(
    gold: dict[str, Any],
) -> None:
    response = distribution(
        evaluate(gold["orders"]),
        metric_code="fulfillment_duration_hours",
        bin_count=4,
        datasets=selection(),
    )

    assert response.sample_size == 6
    assert sum(item.count for item in response.bins) == response.sample_size
    assert response.mean == pytest.approx(52)
    assert response.p90 == pytest.approx(63)


def test_anomaly_excludes_cancelled_from_denominator(
    gold: dict[str, Any],
) -> None:
    result = metric(
        build_metrics(
            evaluate(
                gold["orders"],
                gold["warehouse_events"],
                gold["tracking_events"],
            )
        ),
        "anomaly_order_rate",
    )

    assert result.numerator == 3
    assert result.denominator == 7
