from pathlib import Path

from app.core.config import Settings
from app.imports.contracts import get_contract
from app.imports.parser import parse_csv
from app.imports.privacy import detect_sensitive_risks
from app.imports.validation import validate_import
from app.schemas.imports import DataType


def test_quality_report_covers_required_error_categories(tmp_path: Path) -> None:
    # Deliberately synthetic PII-like fixtures verify that raw values never reach issues.
    path = tmp_path / "bad-orders.csv"
    path.write_text(
        "订单编号,下单时间,承诺送达时间,订购数量,数量单位,订单状态,姓名,手机号\n"
        "ORD-1,2026-07-03 10:00,2026-07-01 10:00,-1,piece,未知节点,张三,13800138000\n"
        "ORD-1,not-a-time,2026-07-04 10:00,abc,piece,已签收,李四,13900139000\n",
        encoding="utf-8",
    )
    table = parse_csv(
        path,
        encoding="utf-8",
        settings=Settings(environment="test", import_root=tmp_path / "imports"),
    )
    mapping: dict[str, str | None] = {
        "订单编号": "order_id",
        "下单时间": "created_at",
        "承诺送达时间": "promised_delivery_time",
        "订购数量": "ordered_quantity",
        "数量单位": "quantity_unit",
        "订单状态": "raw_order_status",
        "姓名": None,
        "手机号": None,
    }
    risks = detect_sensitive_risks(
        table.headers,
        [row.values for row in table.rows],
    )

    artifacts = validate_import(
        table=table,
        contract=get_contract(DataType.ORDERS),
        mapping=mapping,
        ignored_source_columns=["姓名", "手机号"],
        default_timezone="Asia/Shanghai",
        project_status_mappings={},
        sensitive_risks=risks,
        max_cell_chars=4096,
    )

    assert artifacts.report.can_confirm is False
    assert artifacts.report.error_rows == 2
    assert artifacts.report.duplicate_keys == 1
    assert artifacts.report.negative_quantities >= 1
    assert artifacts.report.invalid_times >= 1
    assert artifacts.report.time_order_conflicts >= 1
    assert artifacts.report.unknown_statuses == 1
    assert artifacts.report.ignored_source_columns == ["姓名", "手机号"]
    assert {risk.source_column for risk in artifacts.report.sensitive_risks} == {
        "姓名",
        "手机号",
    }
    assert all(
        issue.raw_value not in {"张三", "李四", "13800138000", "13900139000"}
        for issue in artifacts.report.issues
    )


def test_exact_duplicate_is_deduplicated_with_warning(tmp_path: Path) -> None:
    path = tmp_path / "duplicate.csv"
    row = "ORD-SYN-1,2026-07-01T08:00:00+08:00,1,piece,已签收\n"
    path.write_text(
        "订单编号,下单时间,订购数量,数量单位,订单状态\n" + row + row,
        encoding="utf-8",
    )
    table = parse_csv(
        path,
        encoding="utf-8",
        settings=Settings(environment="test", import_root=tmp_path / "imports"),
    )
    mapping: dict[str, str | None] = {
        "订单编号": "order_id",
        "下单时间": "created_at",
        "订购数量": "ordered_quantity",
        "数量单位": "quantity_unit",
        "订单状态": "raw_order_status",
    }

    artifacts = validate_import(
        table=table,
        contract=get_contract(DataType.ORDERS),
        mapping=mapping,
        default_timezone=None,
        project_status_mappings={},
        sensitive_risks=[],
        max_cell_chars=4096,
    )

    assert artifacts.report.can_confirm is True
    assert artifacts.report.exact_duplicate_rows == 1
    assert artifacts.report.valid_rows == 1
