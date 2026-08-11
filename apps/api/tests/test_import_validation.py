from pathlib import Path

from app.core.config import Settings
from app.imports.contracts import get_contract
from app.imports.parser import parse_csv
from app.imports.privacy import detect_sensitive_risks
from app.imports.validation import parse_datetime_value, validate_import
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


def test_real_world_datetime_formats_are_deterministic() -> None:
    expected = {
        "2026.07.02 06:35": "2026-07-02T06:35:00+08:00",
        "2026/7/3 14:17": "2026-07-03T14:17:00+08:00",
        "2026年07月06日 08:05": "2026-07-06T08:05:00+08:00",
        "Tue Jul 07 2026 18:20:00 GMT+0800 (中国标准时间)": ("2026-07-07T18:20:00+08:00"),
        "7/2/2026 11:46 AM": "2026-07-02T11:46:00+08:00",
        "2026-07-03T07:52+08:00": "2026-07-03T07:52:00+08:00",
        "7-7-2026 11:40": "2026-07-07T11:40:00+08:00",
        "04-07-2026 22:15": "2026-07-04T22:15:00+08:00",
        "02-07-2026 13:42": "2026-07-02T13:42:00+08:00",
    }
    for source, normalized in expected.items():
        assert parse_datetime_value(source, "Asia/Shanghai") == normalized


def test_tracking_id_status_and_exception_normalization(tmp_path: Path) -> None:
    path = tmp_path / "arbitrary-tracking.csv"
    path.write_text(
        "业务交易键,跟单参考,发生时刻(原串),扫描结果,承运单位,异常标注,export_line,场站/网点,系统老码,客户备注\n"
        "ORD-01,SHP-01,2026.07.02 06:35,运输中 | Linehaul,CAR-01,0,1,HUB-A,HUB_ARR,忽略我\n"
        "ORD-01,SHP-01,Tue Jul 07 2026 18:20:00 GMT+0800 "
        "(中国标准时间),妥投(POD),CAR-01,1,2,HUB-B,POD_OK,忽略我\n"
        "ORD-02,SHP-02,2026-07-08T08:20:00+08:00,已揽收,CAR-02,"
        "clear-01,1,HUB-C,PICKUP_OK,忽略我\n",
        encoding="utf-8",
    )
    table = parse_csv(
        path,
        encoding="utf-8",
        settings=Settings(environment="test", import_root=tmp_path / "imports"),
    )
    mapping = {
        "业务交易键": "order_id",
        "跟单参考": "shipment_id",
        "发生时刻(原串)": "event_time",
        "扫描结果": "raw_status",
        "承运单位": "carrier_id",
        "异常标注": "exception_code",
        "export_line": "sequence_number",
        "场站/网点": "location_code",
        "系统老码": None,
        "客户备注": None,
    }
    first = validate_import(
        table=table,
        contract=get_contract(DataType.TRACKING_EVENTS),
        mapping=mapping,
        ignored_source_columns=["系统老码", "客户备注"],
        default_timezone="Asia/Shanghai",
        project_status_mappings={},
        sensitive_risks=[],
        max_cell_chars=4096,
    )
    second = validate_import(
        table=table,
        contract=get_contract(DataType.TRACKING_EVENTS),
        mapping=mapping,
        ignored_source_columns=["系统老码", "客户备注"],
        default_timezone="Asia/Shanghai",
        project_status_mappings={},
        sensitive_risks=[],
        max_cell_chars=4096,
    )

    assert first.report.can_confirm is True
    assert len(first.normalized_rows) == 3
    assert first.normalized_rows[0]["event_code"] == "in_transit"
    assert first.normalized_rows[1]["event_code"] == "delivered"
    assert first.normalized_rows[0]["exception_code"] is None
    assert first.normalized_rows[1]["exception_code"] == "GENERIC_EXCEPTION"
    assert first.normalized_rows[2]["exception_code"] is None
    assert first.normalized_rows[0]["tracking_event_id"].startswith("TRE-GEN-000002-")
    assert first.normalized_rows == second.normalized_rows
    assert "客户备注" not in first.normalized_rows[0]
    assert any(issue.code == "GENERIC_OR_UNKNOWN_EXCEPTION" for issue in first.report.issues)
    assert not any(issue.source_column == "客户备注" for issue in first.report.issues)
    resolutions = {
        (item.target_field, item.status.value) for item in first.report.field_resolutions
    }
    assert ("tracking_event_id", "generated") in resolutions
    assert ("event_code", "inferred") in resolutions
    assert any(
        item.source_column == "客户备注" and item.status.value == "ignored"
        for item in first.report.field_resolutions
    )


def test_minimal_tracking_without_order_or_carrier_is_valid(tmp_path: Path) -> None:
    path = tmp_path / "minimal-tracking.csv"
    path.write_text(
        "运单号,轨迹时间,物流状态\n"
        "SHP-MIN-01,2026-08-01 08:00,已揽收\n"
        "SHP-MIN-01,2026-08-02 08:00,已签收\n",
        encoding="utf-8",
    )
    table = parse_csv(
        path,
        encoding="utf-8",
        settings=Settings(environment="test", import_root=tmp_path / "imports"),
    )
    result = validate_import(
        table=table,
        contract=get_contract(DataType.TRACKING_EVENTS),
        mapping={
            "运单号": "shipment_id",
            "轨迹时间": "event_time",
            "物流状态": "raw_status",
        },
        ignored_source_columns=[],
        default_timezone="Asia/Shanghai",
        project_status_mappings={},
        sensitive_risks=[],
        max_cell_chars=4096,
    )

    assert result.report.can_confirm is True
    assert len(result.normalized_rows) == 2
    assert all(row["tracking_event_id"].startswith("TRE-GEN-") for row in result.normalized_rows)
    assert all("order_id" not in row for row in result.normalized_rows)
    assert all("carrier_id" not in row for row in result.normalized_rows)
