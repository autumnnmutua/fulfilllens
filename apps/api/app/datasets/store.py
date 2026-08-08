from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from dataclasses import dataclass
from datetime import UTC, datetime
from importlib import import_module
from pathlib import Path
from threading import RLock
from typing import Any, cast
from uuid import UUID

import duckdb

from app.core.errors import AppError
from app.schemas.imports import DataType

DATASET_FIELDS: dict[DataType, tuple[str, ...]] = {
    DataType.ORDERS: (
        "order_id",
        "created_at",
        "promised_delivery_time",
        "actual_delivery_time",
        "ordered_quantity",
        "delivered_quantity",
        "quantity_unit",
        "order_status",
        "raw_order_status",
        "warehouse_id",
        "carrier_id",
        "destination_region",
        "sales_channel",
    ),
    DataType.WAREHOUSE_EVENTS: (
        "event_id",
        "order_id",
        "event_time",
        "event_code",
        "raw_status",
        "warehouse_id",
        "quantity",
        "quantity_unit",
        "source_system",
    ),
    DataType.TRACKING_EVENTS: (
        "tracking_event_id",
        "order_id",
        "shipment_id",
        "event_time",
        "event_code",
        "raw_status",
        "carrier_id",
        "location_code",
        "region_code",
        "exception_code",
        "sequence_number",
    ),
}
TABLE_NAMES = {
    DataType.ORDERS: "orders",
    DataType.WAREHOUSE_EVENTS: "warehouse_events",
    DataType.TRACKING_EVENTS: "tracking_events",
}
TABLE_DEFINITIONS = {
    DataType.ORDERS: """
        dataset_id VARCHAR NOT NULL,
        order_id VARCHAR NOT NULL,
        created_at VARCHAR NOT NULL,
        promised_delivery_time VARCHAR,
        actual_delivery_time VARCHAR,
        ordered_quantity DOUBLE NOT NULL,
        delivered_quantity DOUBLE,
        quantity_unit VARCHAR NOT NULL,
        order_status VARCHAR NOT NULL,
        raw_order_status VARCHAR NOT NULL,
        warehouse_id VARCHAR,
        carrier_id VARCHAR,
        destination_region VARCHAR,
        sales_channel VARCHAR
    """,
    DataType.WAREHOUSE_EVENTS: """
        dataset_id VARCHAR NOT NULL,
        event_id VARCHAR NOT NULL,
        order_id VARCHAR NOT NULL,
        event_time VARCHAR NOT NULL,
        event_code VARCHAR NOT NULL,
        raw_status VARCHAR NOT NULL,
        warehouse_id VARCHAR NOT NULL,
        quantity DOUBLE,
        quantity_unit VARCHAR,
        source_system VARCHAR
    """,
    DataType.TRACKING_EVENTS: """
        dataset_id VARCHAR NOT NULL,
        tracking_event_id VARCHAR NOT NULL,
        order_id VARCHAR NOT NULL,
        shipment_id VARCHAR NOT NULL,
        event_time VARCHAR NOT NULL,
        event_code VARCHAR NOT NULL,
        raw_status VARCHAR NOT NULL,
        carrier_id VARCHAR NOT NULL,
        location_code VARCHAR,
        region_code VARCHAR,
        exception_code VARCHAR,
        sequence_number BIGINT
    """,
}
WRITE_LOCK = RLock()


@dataclass(frozen=True)
class DatasetRecord:
    dataset_id: str
    data_type: DataType
    task_id: str
    row_count: int
    created_at: str


class DatasetStore:
    def __init__(self, *, analytics_path: Path, control_path: Path) -> None:
        self.analytics_path = analytics_path.resolve()
        self.control_path = control_path.resolve()
        self.analytics_path.parent.mkdir(parents=True, exist_ok=True)
        self.control_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _initialize(self) -> None:
        with WRITE_LOCK:
            with closing(self._sqlite_connection()) as control, control:
                control.execute(
                    """
                    CREATE TABLE IF NOT EXISTS datasets (
                        dataset_id TEXT PRIMARY KEY,
                        data_type TEXT NOT NULL,
                        task_id TEXT NOT NULL UNIQUE,
                        row_count INTEGER NOT NULL CHECK (row_count >= 0),
                        created_at TEXT NOT NULL,
                        definition_version TEXT NOT NULL
                    )
                    """
                )
            with self._duckdb_connection() as analytics:
                for data_type, table_name in TABLE_NAMES.items():
                    analytics.execute(
                        f"CREATE TABLE IF NOT EXISTS {table_name} ({TABLE_DEFINITIONS[data_type]})"
                    )

    def _sqlite_connection(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.control_path, timeout=10)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    def _duckdb_connection(self) -> duckdb.DuckDBPyConnection:
        return duckdb.connect(str(self.analytics_path))

    @staticmethod
    def validate_dataset_id(dataset_id: str) -> str:
        try:
            canonical = str(UUID(dataset_id))
        except ValueError as error:
            raise AppError(
                code="DATASET_NOT_FOUND",
                message="数据集不存在。",
                status_code=404,
            ) from error
        if canonical != dataset_id:
            raise AppError(
                code="DATASET_NOT_FOUND",
                message="数据集不存在。",
                status_code=404,
            )
        return canonical

    def register(
        self,
        *,
        dataset_id: str,
        data_type: DataType,
        task_id: str,
        rows: list[dict[str, Any]],
    ) -> DatasetRecord:
        canonical = self.validate_dataset_id(dataset_id)
        table_name = TABLE_NAMES[data_type]
        fields = DATASET_FIELDS[data_type]
        column_names = ("dataset_id", *fields)
        columns = ", ".join(column_names)
        values = [tuple([canonical, *(row.get(field) for field in fields)]) for row in rows]
        created_at = datetime.now(UTC).isoformat()
        with WRITE_LOCK:
            with self._duckdb_connection() as analytics:
                analytics.begin()
                try:
                    analytics.execute(
                        f"DELETE FROM {table_name} WHERE dataset_id = ?",
                        [canonical],
                    )
                    if values:
                        pandas = cast(Any, import_module("pandas"))
                        frame = pandas.DataFrame.from_records(values, columns=column_names)
                        view_name = "_incoming_dataset"
                        analytics.register(view_name, frame)
                        try:
                            analytics.execute(
                                f"INSERT INTO {table_name} ({columns}) "
                                f"SELECT {columns} FROM {view_name}"
                            )
                        finally:
                            analytics.unregister(view_name)
                    analytics.commit()
                except Exception:
                    analytics.rollback()
                    raise
            try:
                with closing(self._sqlite_connection()) as control, control:
                    control.execute(
                        """
                        INSERT INTO datasets (
                            dataset_id, data_type, task_id, row_count,
                            created_at, definition_version
                        ) VALUES (?, ?, ?, ?, ?, ?)
                        ON CONFLICT(dataset_id) DO UPDATE SET
                            data_type = excluded.data_type,
                            task_id = excluded.task_id,
                            row_count = excluded.row_count,
                            created_at = excluded.created_at,
                            definition_version = excluded.definition_version
                        """,
                        (
                            canonical,
                            data_type.value,
                            task_id,
                            len(rows),
                            created_at,
                            "data-contract-v1.0-draft",
                        ),
                    )
            except Exception:
                with self._duckdb_connection() as analytics:
                    analytics.execute(
                        f"DELETE FROM {table_name} WHERE dataset_id = ?",
                        [canonical],
                    )
                raise
        return DatasetRecord(
            dataset_id=canonical,
            data_type=data_type,
            task_id=task_id,
            row_count=len(rows),
            created_at=created_at,
        )

    def get(self, dataset_id: str) -> DatasetRecord:
        canonical = self.validate_dataset_id(dataset_id)
        with closing(self._sqlite_connection()) as connection:
            row = connection.execute(
                """
                SELECT dataset_id, data_type, task_id, row_count, created_at
                FROM datasets
                WHERE dataset_id = ?
                """,
                (canonical,),
            ).fetchone()
        if row is None:
            raise AppError(
                code="DATASET_NOT_FOUND",
                message="数据集不存在或尚未完成登记。",
                status_code=404,
            )
        return DatasetRecord(
            dataset_id=str(row[0]),
            data_type=DataType(str(row[1])),
            task_id=str(row[2]),
            row_count=int(row[3]),
            created_at=str(row[4]),
        )

    def list_records(self) -> list[DatasetRecord]:
        with closing(self._sqlite_connection()) as connection:
            rows = connection.execute(
                """
                SELECT dataset_id, data_type, task_id, row_count, created_at
                FROM datasets
                ORDER BY created_at DESC, dataset_id
                """
            ).fetchall()
        return [
            DatasetRecord(
                dataset_id=str(row[0]),
                data_type=DataType(str(row[1])),
                task_id=str(row[2]),
                row_count=int(row[3]),
                created_at=str(row[4]),
            )
            for row in rows
        ]

    def delete(self, dataset_id: str) -> tuple[DatasetRecord, int]:
        """Delete analytical rows before metadata so a partial failure favors privacy."""
        record = self.get(dataset_id)
        table_name = TABLE_NAMES[record.data_type]
        with WRITE_LOCK:
            with self._duckdb_connection() as analytics:
                analytics.begin()
                try:
                    count_row = analytics.execute(
                        f"SELECT count(*) FROM {table_name} WHERE dataset_id = ?",
                        [record.dataset_id],
                    ).fetchone()
                    if count_row is None:
                        raise RuntimeError("数据集行数查询未返回结果")
                    row_count = int(count_row[0])
                    analytics.execute(
                        f"DELETE FROM {table_name} WHERE dataset_id = ?",
                        [record.dataset_id],
                    )
                    analytics.commit()
                except Exception:
                    analytics.rollback()
                    raise
            with closing(self._sqlite_connection()) as control, control:
                control.execute(
                    "DELETE FROM datasets WHERE dataset_id = ?",
                    (record.dataset_id,),
                )
        return record, row_count

    def load_rows(
        self,
        dataset_id: str,
        *,
        expected_type: DataType,
    ) -> list[dict[str, Any]]:
        record = self.get(dataset_id)
        if record.data_type != expected_type:
            raise AppError(
                code="DATASET_TYPE_MISMATCH",
                message=f"数据集类型应为 {expected_type.value}。",
                status_code=422,
            )
        table_name = TABLE_NAMES[expected_type]
        fields = DATASET_FIELDS[expected_type]
        with self._duckdb_connection() as analytics:
            result = analytics.execute(
                f"SELECT {', '.join(fields)} FROM {table_name} WHERE dataset_id = ? ORDER BY rowid",
                [record.dataset_id],
            )
            rows = result.fetchall()
        return [dict(zip(fields, row, strict=True)) for row in rows]

    @staticmethod
    def load_jsonl(path: Path) -> list[dict[str, Any]]:
        return [
            json.loads(line)
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
