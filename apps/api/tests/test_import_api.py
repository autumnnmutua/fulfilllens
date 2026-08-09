from io import BytesIO
from typing import Any

from app.core.config import get_settings
from app.datasets.store import DatasetStore
from app.schemas.imports import DataType
from fastapi.testclient import TestClient
from openpyxl import Workbook


def synthetic_mapping(payload: dict[str, Any]) -> dict[str, str | None]:
    return {item["source_column"]: item["suggested_field"] for item in payload["suggestions"]}


def test_synthetic_orders_complete_upload_to_analyzable(client: TestClient) -> None:
    created = client.post(
        "/api/imports/synthetic",
        json={"data_type": "orders"},
    )
    assert created.status_code == 201
    payload = created.json()
    assert payload["task"]["status"] == "awaiting_mapping"
    assert payload["total_rows"] == 3

    task_id = payload["task"]["task_id"]
    checked = client.put(
        f"/api/imports/{task_id}/validation",
        json={
            "mapping": synthetic_mapping(payload),
            "default_timezone": "Asia/Shanghai",
        },
    )
    assert checked.status_code == 200
    assert checked.json()["task"]["status"] == "ready_to_confirm"
    assert checked.json()["report"]["valid_rows"] == 3
    assert checked.json()["report"]["error_rows"] == 0
    assert checked.json()["report"]["unknown_statuses"] == 0

    confirmed = client.post(f"/api/imports/{task_id}/confirm")
    assert confirmed.status_code == 200
    assert confirmed.json()["task"]["status"] == "analyzable"
    assert confirmed.json()["imported_rows"] == 3
    dataset_id = confirmed.json()["dataset_id"]
    settings = get_settings()
    dataset_store = DatasetStore(
        analytics_path=settings.analytics_database,
        control_path=settings.control_database,
    )
    record = dataset_store.get(dataset_id)
    assert record.data_type == DataType.ORDERS
    assert len(dataset_store.load_rows(dataset_id, expected_type=DataType.ORDERS)) == 3
    cannot_cancel = client.delete(f"/api/imports/{task_id}")
    assert cannot_cancel.status_code == 409
    assert cannot_cancel.json()["error"]["code"] == "CONFIRMED_DATASET_CANNOT_BE_CANCELLED"


def test_gb18030_upload_requires_explicit_encoding(client: TestClient) -> None:
    content = (
        "订单编号,下单时间,订购数量,数量单位,订单状态\n"
        "ORD-SYN-GB-1,2026-07-01T08:00:00+08:00,1,piece,已签收\n"
    ).encode("gb18030")
    uploaded = client.post(
        "/api/imports/upload",
        data={"data_type": "orders"},
        files={"file": ("../../订单.csv", content, "text/csv")},
    )

    assert uploaded.status_code == 201
    task = uploaded.json()["task"]
    assert task["file_name"] == "订单.csv"
    assert task["status"] == "awaiting_encoding"
    assert task["encoding_options"] == ["gb18030", "gbk"]

    parsed = client.post(
        f"/api/imports/{task['task_id']}/parse",
        json={"encoding": "gb18030"},
    )
    assert parsed.status_code == 200
    assert parsed.json()["preview_rows"][0]["values"]["订单状态"] == "已签收"


def test_xlsx_upload_requires_sheet_and_ignores_formula(
    client: TestClient,
) -> None:
    workbook = Workbook()
    orders = workbook.active
    assert orders is not None
    orders.title = "订单数据"
    orders.append(["订单编号", "下单时间", "订购数量", "数量单位", "订单状态"])
    orders.append(["ORD-XLSX-1", "2026-07-01T08:00:00+08:00", "=1+1", "piece", "已签收"])
    workbook.create_sheet("说明")
    content = BytesIO()
    workbook.save(content)

    uploaded = client.post(
        "/api/imports/upload",
        data={"data_type": "orders"},
        files={
            "file": (
                "orders.xlsx",
                content.getvalue(),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        },
    )

    assert uploaded.status_code == 201
    task = uploaded.json()["task"]
    assert task["status"] == "awaiting_sheet"
    assert [sheet["name"] for sheet in task["sheets"]] == ["订单数据", "说明"]

    parsed = client.post(
        f"/api/imports/{task['task_id']}/parse",
        json={"sheet_name": "订单数据"},
    )
    assert parsed.status_code == 200
    assert parsed.json()["preview_rows"][0]["values"]["订购数量"] is None


def test_validation_failure_persists_report_and_safe_error_csv(
    client: TestClient,
) -> None:
    content = (
        "订单编号,下单时间,订购数量,数量单位,订单状态\n"
        "ORD-BAD-1,2026-07-01T08:00:00+08:00,=2+2,piece,本地妥投\n"
    ).encode()
    uploaded = client.post(
        "/api/imports/upload",
        data={"data_type": "orders"},
        files={"file": ("bad.csv", content, "text/csv")},
    ).json()["task"]
    parsed = client.post(
        f"/api/imports/{uploaded['task_id']}/parse",
        json={},
    ).json()
    checked = client.put(
        f"/api/imports/{uploaded['task_id']}/validation",
        json={
            "mapping": synthetic_mapping(parsed),
            "default_timezone": "Asia/Shanghai",
        },
    )

    assert checked.status_code == 200
    assert checked.json()["task"]["status"] == "validation_failed"
    assert checked.json()["report"]["unparseable_values"] >= 1
    downloaded = client.get(f"/api/imports/{uploaded['task_id']}/errors.csv")
    assert downloaded.status_code == 200
    assert b"'=2+2" in downloaded.content


def test_project_status_mapping_can_be_applied_without_reupload(
    client: TestClient,
) -> None:
    content = (
        "订单编号,下单时间,订购数量,数量单位,订单状态\n"
        "ORD-CUSTOM-1,2026-07-01T08:00:00+08:00,1,piece,本地妥投\n"
    ).encode()
    task = client.post(
        "/api/imports/upload",
        data={"data_type": "orders"},
        files={"file": ("custom.csv", content, "text/csv")},
    ).json()["task"]
    parsed = client.post(f"/api/imports/{task['task_id']}/parse", json={}).json()
    checked = client.put(
        f"/api/imports/{task['task_id']}/validation",
        json={
            "mapping": synthetic_mapping(parsed),
            "default_timezone": "Asia/Shanghai",
            "project_status_mappings": {"本地妥投": "delivered"},
        },
    )

    status = checked.json()["report"]["status_normalizations"][0]
    assert status["normalized_status"] == "delivered"
    assert status["mapping_source"] == "project_user"
    assert checked.json()["task"]["status"] == "ready_to_confirm"


def test_ignored_optional_column_is_excluded_but_required_mapping_still_blocks(
    client: TestClient,
) -> None:
    content = (
        "订单编号,下单时间,订单数量,单位,订单状态,客服备注\n"
        "ORD-IGN-1,2026-07-01T08:00:00+08:00,1,piece,已签收,无需分析\n"
    ).encode()
    task = client.post(
        "/api/imports/upload",
        data={"data_type": "orders"},
        files={"file": ("ignored.csv", content, "text/csv")},
    ).json()["task"]
    parsed = client.post(f"/api/imports/{task['task_id']}/parse", json={}).json()
    mapping = synthetic_mapping(parsed)
    mapping["客服备注"] = None
    checked = client.put(
        f"/api/imports/{task['task_id']}/validation",
        json={
            "mapping": mapping,
            "ignored_source_columns": ["客服备注"],
            "default_timezone": "Asia/Shanghai",
        },
    )

    assert checked.status_code == 200
    payload = checked.json()
    assert payload["report"]["can_confirm"] is True
    assert payload["report"]["ignored_source_columns"] == ["客服备注"]
    assert payload["report"]["unresolved_source_columns"] == []
    assert "客服备注" not in payload["normalized_preview"][0]

    mapping["订单编号"] = None
    blocked = client.put(
        f"/api/imports/{task['task_id']}/validation",
        json={
            "mapping": mapping,
            "ignored_source_columns": ["订单编号", "客服备注"],
            "default_timezone": "Asia/Shanghai",
        },
    )
    assert blocked.status_code == 422
    assert "order_id" in str(blocked.json())


def test_template_download_and_cancellation(client: TestClient) -> None:
    template = client.get("/api/imports/templates/orders")
    assert template.status_code == 200
    assert template.content.startswith(b"order_id,created_at")

    created = client.post(
        "/api/imports/synthetic",
        json={"data_type": "tracking_events"},
    ).json()
    task_id = created["task"]["task_id"]
    cancelled = client.delete(f"/api/imports/{task_id}")

    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "cancelled"
    assert client.post(f"/api/imports/{task_id}/parse", json={}).status_code == 409


def test_mime_mismatch_and_unsupported_extension_are_rejected(
    client: TestClient,
) -> None:
    mismatch = client.post(
        "/api/imports/upload",
        data={"data_type": "orders"},
        files={"file": ("orders.xlsx", b"not-a-zip", "text/csv")},
    )
    unsupported = client.post(
        "/api/imports/upload",
        data={"data_type": "orders"},
        files={"file": ("orders.xlsm", b"payload", "application/octet-stream")},
    )

    assert mismatch.status_code == 415
    assert mismatch.json()["error"]["code"] == "UNSUPPORTED_MIME_TYPE"
    assert unsupported.status_code == 415
    assert unsupported.json()["error"]["code"] == "UNSUPPORTED_FILE_EXTENSION"
