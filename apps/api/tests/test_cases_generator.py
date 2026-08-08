from __future__ import annotations

from pathlib import Path

import pytest
from app.cases.generator import (
    CASE_CONFIGS,
    generate_case,
    metadata_payload,
    validate_generated_case,
    write_case_artifacts,
)
from app.cases.models import CaseId
from app.diagnostics.config import load_default_rule_set
from app.diagnostics.engine import analyze
from app.metrics.engine import build_metrics, evaluate
from app.metrics.models import DatasetSelection

SELECTION = DatasetSelection(
    orders_dataset_id="10111111-1111-4111-8111-111111111111",
    warehouse_events_dataset_id="10222222-2222-4222-8222-222222222222",
    tracking_events_dataset_id="10333333-3333-4333-8333-333333333333",
)


@pytest.mark.parametrize("case_id", list(CaseId))
def test_cases_conform_to_schema_keys_time_order_and_expected_scale(case_id: CaseId) -> None:
    generated = generate_case(CASE_CONFIGS[case_id])

    assert validate_generated_case(generated) == []
    assert len(generated.orders) == CASE_CONFIGS[case_id].order_count
    assert len(generated.warehouse_events) == len(generated.orders) * 9
    assert len(generated.tracking_events) >= len(generated.orders) * 9
    assert {str(row["order_id"]) for row in generated.orders} == {
        str(row["order_id"]) for row in generated.warehouse_events
    }
    assert {str(row["order_id"]) for row in generated.orders} == {
        str(row["order_id"]) for row in generated.tracking_events
    }


@pytest.mark.parametrize("case_id", list(CaseId))
def test_case_metrics_stay_in_documented_ranges_and_required_rules_trigger(
    case_id: CaseId,
) -> None:
    generated = generate_case(CASE_CONFIGS[case_id])
    output = evaluate(generated.orders, generated.warehouse_events, generated.tracking_events)
    metrics = {item.code: item for item in build_metrics(output)}
    for code, (minimum, maximum, _) in CASE_CONFIGS[case_id].expected_metric_ranges.items():
        value = metrics[code].value
        assert value is not None
        assert minimum <= float(value) <= maximum, (case_id, code, value)

    diagnostics = analyze(
        generated.orders,
        generated.warehouse_events,
        generated.tracking_events,
        datasets=SELECTION,
        rule_set=load_default_rule_set(),
        timezone_name="Asia/Shanghai",
        max_evidence=3,
    )
    triggered = {item.rule_id for item in diagnostics.response.results}
    expected = {
        rule_id for rule_id, _, required in CASE_CONFIGS[case_id].expected_findings if required
    }
    assert expected <= triggered
    if case_id == CaseId.PROMOTION_SURGE:
        assert {"FL-WH-001", "FL-WC-001"} <= triggered
    if case_id == CaseId.CARRIER_DISRUPTION:
        assert {"FL-PU-001", "FL-LH-001", "FL-LM-001", "FL-CR-001"} <= triggered


def test_fixed_seed_and_all_artifacts_are_byte_reproducible(tmp_path: Path) -> None:
    first = generate_case(CASE_CONFIGS[CaseId.NORMAL_OPERATIONS])
    second = generate_case(CASE_CONFIGS[CaseId.NORMAL_OPERATIONS])

    assert (
        metadata_payload(first)["content_fingerprint"]
        == metadata_payload(second)["content_fingerprint"]
    )
    first_dir = write_case_artifacts(first, tmp_path / "first")
    second_dir = write_case_artifacts(second, tmp_path / "second")
    for name in (
        "orders.csv",
        "warehouse_events.csv",
        "tracking_events.csv",
        "case.xlsx",
        "metadata.json",
    ):
        assert (first_dir / name).read_bytes() == (second_dir / name).read_bytes()


@pytest.mark.parametrize("case_id", list(CaseId))
def test_cases_do_not_contain_pii_fields_or_realistic_personal_values(case_id: CaseId) -> None:
    generated = generate_case(CASE_CONFIGS[case_id])
    all_rows = [*generated.orders, *generated.warehouse_events, *generated.tracking_events]
    forbidden_fields = {"name", "phone", "mobile", "address", "id_card", "tracking_number"}
    assert not any(forbidden_fields & row.keys() for row in all_rows)
    serialized = str(all_rows)
    for forbidden in ("手机号", "身份证", "详细地址", "顺丰", "京东物流", "圆通"):
        assert forbidden not in serialized
