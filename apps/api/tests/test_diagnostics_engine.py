from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta

import pytest
from app.diagnostics.config import load_default_rule_set, resolve_rule_set
from app.diagnostics.engine import analyze, findings_for_order
from app.diagnostics.models import DiagnosticRuleSet, RuleOverride
from app.metrics.models import DatasetSelection

SELECTION = DatasetSelection(
    orders_dataset_id="61111111-1111-4111-8111-111111111111",
    warehouse_events_dataset_id="62222222-2222-4222-8222-222222222222",
    tracking_events_dataset_id="63333333-3333-4333-8333-333333333333",
)


def iso(value: datetime) -> str:
    return value.isoformat()


def order(
    order_id: str,
    *,
    created: datetime,
    warehouse: str = "WH-A",
    carrier: str = "CAR-A",
    delivered: bool = True,
    late: bool = False,
) -> dict[str, object]:
    promised = created + timedelta(hours=48)
    actual = promised + timedelta(hours=1) if late else created + timedelta(hours=24)
    return {
        "order_id": order_id,
        "created_at": iso(created),
        "promised_delivery_time": iso(promised),
        "actual_delivery_time": iso(actual) if delivered else None,
        "ordered_quantity": 1,
        "delivered_quantity": 1 if delivered else None,
        "quantity_unit": "piece",
        "order_status": "delivered" if delivered else "shipped",
        "raw_order_status": "合成状态",
        "warehouse_id": warehouse,
        "carrier_id": carrier,
        "destination_region": "华东",
        "sales_channel": "synthetic",
    }


def warehouse_event(
    event_id: str,
    order_id: str,
    event_time: datetime,
    code: str,
) -> dict[str, object]:
    return {
        "event_id": event_id,
        "order_id": order_id,
        "event_time": iso(event_time),
        "event_code": code,
        "raw_status": code,
        "warehouse_id": "WH-A",
    }


def tracking_event(
    event_id: str,
    order_id: str,
    event_time: datetime,
    code: str,
    *,
    shipment_id: str | None = None,
) -> dict[str, object]:
    return {
        "tracking_event_id": event_id,
        "order_id": order_id,
        "shipment_id": shipment_id or f"S-{order_id}",
        "event_time": iso(event_time),
        "event_code": code,
        "raw_status": code,
        "carrier_id": "CAR-A",
    }


def selected_rule_set(
    enabled: set[str],
    parameters: dict[str, dict[str, float]] | None = None,
) -> DiagnosticRuleSet:
    overrides = {
        rule.rule_id: RuleOverride(
            enabled=rule.rule_id in enabled,
            parameters=(parameters or {}).get(rule.rule_id, {}),
        )
        for rule in load_default_rule_set().rules
    }
    return resolve_rule_set(overrides)


def run(
    orders: list[dict[str, object]],
    warehouse: list[dict[str, object]],
    tracking: list[dict[str, object]],
    *,
    rules: set[str],
    parameters: dict[str, dict[str, float]] | None = None,
):
    return analyze(
        orders,
        warehouse,
        tracking,
        datasets=SELECTION,
        rule_set=selected_rule_set(rules, parameters),
        timezone_name="Asia/Shanghai",
        max_evidence=100,
    )


@pytest.mark.parametrize(
    ("case", "duration", "complete", "expected"),
    [
        ("positive", 5, True, True),
        ("boundary", 4, True, False),
        ("negative", 1, True, False),
        ("false_positive_guard", 5, False, False),
    ],
)
def test_warehouse_delay_positive_boundary_negative_and_guard(
    case: str,
    duration: float,
    complete: bool,
    expected: bool,
) -> None:
    del case
    created = datetime.fromisoformat("2026-07-01T08:00:00+08:00")
    events = [warehouse_event("W-1", "O-1", created, "order_received")]
    if complete:
        events.append(
            warehouse_event("W-2", "O-1", created + timedelta(hours=duration), "picking_started")
        )
    result = run([order("O-1", created=created)], events, [], rules={"FL-WH-001"})

    assert any(item.result.rule_id == "FL-WH-001" for item in result.records) is expected


@pytest.mark.parametrize(
    ("case", "duration", "complete", "expected"),
    [
        ("positive", 13, True, True),
        ("boundary", 12, True, False),
        ("negative", 2, True, False),
        ("false_positive_guard", 13, False, False),
    ],
)
def test_pickup_delay_positive_boundary_negative_and_guard(
    case: str,
    duration: float,
    complete: bool,
    expected: bool,
) -> None:
    del case
    created = datetime.fromisoformat("2026-07-01T08:00:00+08:00")
    warehouse = [warehouse_event("W-1", "O-1", created, "ready_to_ship")]
    tracking = (
        [tracking_event("T-1", "O-1", created + timedelta(hours=duration), "carrier_picked_up")]
        if complete
        else []
    )
    result = run([order("O-1", created=created)], warehouse, tracking, rules={"FL-PU-001"})

    assert any(item.result.rule_id == "FL-PU-001" for item in result.records) is expected


@pytest.mark.parametrize(
    ("case", "duration", "cancelled", "expected"),
    [
        ("positive", 73, False, True),
        ("boundary", 72, False, False),
        ("negative", 12, False, False),
        ("false_positive_guard", 100, True, False),
    ],
)
def test_linehaul_positive_boundary_negative_and_guard(
    case: str,
    duration: float,
    cancelled: bool,
    expected: bool,
) -> None:
    del case
    created = datetime.fromisoformat("2026-07-01T08:00:00+08:00")
    item = order("O-1", created=created)
    if cancelled:
        item.update(
            order_status="cancelled",
            actual_delivery_time=None,
            delivered_quantity=0,
        )
    events = [
        tracking_event("T-1", "O-1", created, "carrier_picked_up"),
        tracking_event("T-2", "O-1", created + timedelta(hours=duration), "delivered"),
    ]
    result = run([item], [], events, rules={"FL-LH-001"})

    assert any(item.result.rule_id == "FL-LH-001" for item in result.records) is expected


@pytest.mark.parametrize(
    ("case", "duration", "complete", "expected"),
    [
        ("positive", 25, True, True),
        ("boundary", 24, True, False),
        ("negative", 4, True, False),
        ("false_positive_guard", 25, False, False),
    ],
)
def test_last_mile_positive_boundary_negative_and_guard(
    case: str,
    duration: float,
    complete: bool,
    expected: bool,
) -> None:
    del case
    created = datetime.fromisoformat("2026-07-01T08:00:00+08:00")
    events = [tracking_event("T-1", "O-1", created, "arrived_at_destination_city")]
    if complete:
        events.append(
            tracking_event("T-2", "O-1", created + timedelta(hours=duration), "out_for_delivery")
        )
    result = run([order("O-1", created=created)], [], events, rules={"FL-LM-001"})

    assert any(item.result.rule_id == "FL-LM-001" for item in result.records) is expected


@pytest.mark.parametrize(
    ("case", "a_late", "b_late", "minimum_sample", "gap", "expected"),
    [
        ("positive", 5, 0, 5, 0.2, True),
        ("boundary", 1, 0, 5, 0.2, True),
        ("negative", 0, 0, 5, 0.2, False),
        ("false_positive_guard", 2, 0, 30, 0.2, False),
    ],
)
def test_carrier_relative_positive_boundary_negative_and_guard(
    case: str,
    a_late: int,
    b_late: int,
    minimum_sample: int,
    gap: float,
    expected: bool,
) -> None:
    del case
    base = datetime.fromisoformat("2026-07-01T08:00:00+08:00")
    orders = [
        order(
            f"A-{index}",
            created=base + timedelta(minutes=index),
            carrier="CAR-A",
            late=index < a_late,
        )
        for index in range(5)
    ] + [
        order(
            f"B-{index}",
            created=base + timedelta(minutes=100 + index),
            carrier="CAR-B",
            late=index < b_late,
        )
        for index in range(5)
    ]
    result = run(
        orders,
        [],
        [],
        rules={"FL-CR-001"},
        parameters={
            "FL-CR-001": {
                "minimum_sample": minimum_sample,
                "otif_gap": gap,
                "p90_ratio": 10,
            }
        },
    )

    assert any(item.result.rule_id == "FL-CR-001" for item in result.records) is expected


def congestion_fixture(
    counts: list[int],
    durations: list[float],
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    base = datetime.fromisoformat("2026-07-01T08:00:00+08:00")
    orders: list[dict[str, object]] = []
    events: list[dict[str, object]] = []
    for day, (count, duration) in enumerate(zip(counts, durations, strict=True)):
        for index in range(count):
            order_id = f"D{day}-O{index}"
            created = base + timedelta(days=day, minutes=index)
            orders.append(order(order_id, created=created))
            events.extend(
                [
                    warehouse_event(f"{order_id}-1", order_id, created, "order_received"),
                    warehouse_event(
                        f"{order_id}-2",
                        order_id,
                        created + timedelta(hours=duration),
                        "picking_started",
                    ),
                ]
            )
    return orders, events


@pytest.mark.parametrize(
    ("case", "counts", "durations", "expected"),
    [
        ("positive", [4, 4, 6], [1, 1, 2], True),
        ("boundary", [4, 4, 5], [1, 1, 1.2], True),
        ("negative", [4, 4, 5], [1, 1, 1], False),
        ("false_positive_guard", [4, 6], [1, 2], False),
    ],
)
def test_congestion_positive_boundary_negative_and_guard(
    case: str,
    counts: list[int],
    durations: list[float],
    expected: bool,
) -> None:
    del case
    orders, events = congestion_fixture(counts, durations)
    result = run(
        orders,
        events,
        [],
        rules={"FL-WC-001"},
        parameters={
            "FL-WC-001": {
                "minimum_daily_orders": 3,
                "minimum_baseline_days": 2,
            }
        },
    )

    assert any(item.result.rule_id == "FL-WC-001" for item in result.records) is expected


def time_fixture(
    times: list[str],
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    orders: list[dict[str, object]] = []
    events: list[dict[str, object]] = []
    for index, time in enumerate(times):
        created = datetime.fromisoformat(time)
        order_id = f"O-{index}"
        orders.append(order(order_id, created=created))
        events.extend(
            [
                warehouse_event(f"W-{index}-1", order_id, created, "order_received"),
                warehouse_event(
                    f"W-{index}-2",
                    order_id,
                    created + timedelta(hours=5),
                    "picking_started",
                ),
            ]
        )
    return orders, events


@pytest.mark.parametrize(
    ("case", "times", "expected"),
    [
        (
            "positive",
            [
                "2026-07-06T01:00:00+08:00",
                "2026-07-13T07:00:00+08:00",
                "2026-07-20T13:00:00+08:00",
                "2026-07-27T19:00:00+08:00",
            ],
            True,
        ),
        (
            "boundary",
            [
                "2026-07-06T01:00:00+08:00",
                "2026-07-13T07:00:00+08:00",
                "2026-07-21T13:00:00+08:00",
                "2026-07-29T19:00:00+08:00",
            ],
            True,
        ),
        (
            "negative",
            [
                "2026-07-06T01:00:00+08:00",
                "2026-07-14T07:00:00+08:00",
                "2026-07-22T13:00:00+08:00",
                "2026-07-30T19:00:00+08:00",
            ],
            False,
        ),
        (
            "false_positive_guard",
            [
                "2026-07-06T01:00:00+08:00",
                "2026-07-06T07:00:00+08:00",
                "2026-07-06T13:00:00+08:00",
                "2026-07-06T19:00:00+08:00",
            ],
            False,
        ),
    ],
)
def test_time_concentration_positive_boundary_negative_and_guard(
    case: str,
    times: list[str],
    expected: bool,
) -> None:
    del case
    orders, events = time_fixture(times)
    result = run(
        orders,
        events,
        [],
        rules={"FL-WH-001", "FL-TC-001"},
        parameters={
            "FL-TC-001": {
                "minimum_anomaly_orders": 4,
                "minimum_distinct_dates": 2,
            }
        },
    )

    assert any(item.result.rule_id == "FL-TC-001" for item in result.records) is expected


@pytest.mark.parametrize(
    ("case", "event_mode", "expected"),
    [
        ("positive", "duplicate", True),
        ("boundary", "gap_720", False),
        ("negative", "normal", False),
        ("false_positive_guard", "retry_delivery", False),
    ],
)
def test_data_quality_positive_boundary_negative_and_guard(
    case: str,
    event_mode: str,
    expected: bool,
) -> None:
    del case
    created = datetime.fromisoformat("2026-07-01T08:00:00+08:00")
    completed = order("O-1", created=created)
    warehouse: list[dict[str, object]] = []
    if event_mode == "duplicate":
        first = tracking_event("T-1", "O-1", created, "shipment_created")
        events = [first, deepcopy(first)]
    elif event_mode == "gap_720":
        warehouse = [warehouse_event("W-1", "O-1", created + timedelta(hours=719), "ready_to_ship")]
        events = [
            tracking_event("T-1", "O-1", created, "shipment_created"),
            tracking_event("T-2", "O-1", created + timedelta(hours=720), "carrier_picked_up"),
            tracking_event("T-3", "O-1", created + timedelta(hours=721), "origin_departed"),
            tracking_event("T-4", "O-1", created + timedelta(hours=722), "in_transit"),
            tracking_event(
                "T-5", "O-1", created + timedelta(hours=723), "arrived_at_destination_city"
            ),
            tracking_event("T-6", "O-1", created + timedelta(hours=724), "out_for_delivery"),
            tracking_event("T-7", "O-1", created + timedelta(hours=725), "delivered"),
        ]
    elif event_mode == "normal":
        warehouse = [warehouse_event("W-1", "O-1", created, "ready_to_ship")]
        events = [
            tracking_event("T-1", "O-1", created, "shipment_created"),
            tracking_event("T-2", "O-1", created + timedelta(hours=2), "carrier_picked_up"),
            tracking_event("T-3", "O-1", created + timedelta(hours=3), "origin_departed"),
            tracking_event("T-4", "O-1", created + timedelta(hours=4), "in_transit"),
            tracking_event(
                "T-5", "O-1", created + timedelta(hours=5), "arrived_at_destination_city"
            ),
            tracking_event("T-6", "O-1", created + timedelta(hours=6), "out_for_delivery"),
            tracking_event("T-7", "O-1", created + timedelta(hours=7), "delivered"),
        ]
    else:
        warehouse = [warehouse_event("W-1", "O-1", created, "ready_to_ship")]
        events = [
            tracking_event("T-1", "O-1", created + timedelta(hours=1), "carrier_picked_up"),
            tracking_event("T-2", "O-1", created + timedelta(hours=2), "origin_departed"),
            tracking_event("T-3", "O-1", created + timedelta(hours=3), "in_transit"),
            tracking_event(
                "T-4", "O-1", created + timedelta(hours=4), "arrived_at_destination_city"
            ),
            tracking_event("T-5", "O-1", created + timedelta(hours=5), "out_for_delivery"),
            tracking_event("T-6", "O-1", created + timedelta(hours=6), "delivery_failed"),
            tracking_event("T-7", "O-1", created + timedelta(hours=7), "out_for_delivery"),
            tracking_event("T-8", "O-1", created + timedelta(hours=8), "delivered"),
        ]
    result = run([completed], warehouse, events, rules={"FL-DQ-001"})

    assert any(item.result.rule_id == "FL-DQ-001" for item in result.records) is expected


def test_same_order_same_category_findings_are_merged_and_reconcilable() -> None:
    created = datetime.fromisoformat("2026-07-01T08:00:00+08:00")
    events = [
        tracking_event("T-1", "O-1", created, "shipment_created"),
        tracking_event("T-2", "O-1", created + timedelta(hours=721), "carrier_picked_up"),
        tracking_event("T-3", "O-1", created + timedelta(hours=722), "arrived_at_destination_city"),
    ]
    result = run([order("O-1", created=created)], [], events, rules={"FL-DQ-001"})

    findings = findings_for_order(result, "O-1")
    assert len(findings) == 1
    assert findings[0].category == "data_quality"
    assert result.response.context.affected_order_count == 1
