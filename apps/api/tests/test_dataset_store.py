from pathlib import Path

from app.datasets.store import DatasetStore
from app.schemas.imports import DataType


def test_sqlite_connections_are_released_after_store_operations(tmp_path: Path) -> None:
    control_path = tmp_path / "control.sqlite3"
    store = DatasetStore(
        analytics_path=tmp_path / "analytics.duckdb",
        control_path=control_path,
    )
    dataset_id = "44444444-4444-4444-8444-444444444444"
    store.register(
        dataset_id=dataset_id,
        data_type=DataType.ORDERS,
        task_id="connection-release-test",
        rows=[],
    )

    assert store.get(dataset_id).row_count == 0
    control_path.unlink()
    assert not control_path.exists()


def test_list_and_delete_remove_rows_and_metadata(tmp_path: Path) -> None:
    store = DatasetStore(
        analytics_path=tmp_path / "analytics.duckdb",
        control_path=tmp_path / "control.sqlite3",
    )
    dataset_id = "55555555-5555-4555-8555-555555555555"
    store.register(
        dataset_id=dataset_id,
        data_type=DataType.ORDERS,
        task_id="delete-test",
        rows=[
            {
                "order_id": "SYN-1",
                "created_at": "2026-01-01T00:00:00+08:00",
                "ordered_quantity": 1,
                "quantity_unit": "piece",
                "order_status": "created",
                "raw_order_status": "created",
            }
        ],
    )

    assert [item.dataset_id for item in store.list_records()] == [dataset_id]
    record, rows_deleted = store.delete(dataset_id)

    assert record.dataset_id == dataset_id
    assert rows_deleted == 1
    assert store.list_records() == []
