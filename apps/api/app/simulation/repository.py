from __future__ import annotations

import sqlite3
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock
from uuid import UUID, uuid4

from app.core.errors import AppError
from app.metrics.models import DatasetSelection
from app.simulation.models import ScenarioCreate, ScenarioParameters, ScenarioRecord

SCENARIO_WRITE_LOCK = RLock()


class ScenarioRepository:
    def __init__(self, control_path: Path) -> None:
        self.control_path = control_path.resolve()
        self.control_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connection(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.control_path, timeout=10)
        connection.execute("PRAGMA journal_mode=WAL")
        return connection

    def _initialize(self) -> None:
        with SCENARIO_WRITE_LOCK, closing(self._connection()) as connection, connection:
            connection.execute(
                """
                    CREATE TABLE IF NOT EXISTS simulation_scenarios (
                        scenario_id TEXT PRIMARY KEY,
                        name TEXT NOT NULL,
                        orders_dataset_id TEXT NOT NULL,
                        datasets_json TEXT NOT NULL,
                        timezone TEXT NOT NULL,
                        parameters_json TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL,
                        definition_version TEXT NOT NULL
                    )
                    """
            )
            connection.execute(
                """
                    CREATE INDEX IF NOT EXISTS idx_simulation_scenarios_orders
                    ON simulation_scenarios(orders_dataset_id, updated_at)
                    """
            )

    @staticmethod
    def _validate_id(scenario_id: str) -> str:
        try:
            canonical = str(UUID(scenario_id))
        except ValueError as error:
            raise AppError(
                code="SCENARIO_NOT_FOUND",
                message="方案不存在。",
                status_code=404,
            ) from error
        if canonical != scenario_id:
            raise AppError(
                code="SCENARIO_NOT_FOUND",
                message="方案不存在。",
                status_code=404,
            )
        return canonical

    @staticmethod
    def _record(row: tuple[object, ...]) -> ScenarioRecord:
        return ScenarioRecord(
            scenario_id=str(row[0]),
            name=str(row[1]),
            datasets=DatasetSelection.model_validate_json(str(row[2])),
            timezone=str(row[3]),
            parameters=ScenarioParameters.model_validate_json(str(row[4])),
            created_at=datetime.fromisoformat(str(row[5])),
            updated_at=datetime.fromisoformat(str(row[6])),
            definition_version=str(row[7]),
        )

    def create(self, payload: ScenarioCreate) -> ScenarioRecord:
        now = datetime.now(UTC)
        scenario_id = str(uuid4())
        record = ScenarioRecord(
            scenario_id=scenario_id,
            name=payload.name,
            datasets=payload.datasets,
            timezone=payload.timezone,
            parameters=payload.parameters,
            created_at=now,
            updated_at=now,
        )
        with SCENARIO_WRITE_LOCK, closing(self._connection()) as connection, connection:
            connection.execute(
                """
                    INSERT INTO simulation_scenarios (
                        scenario_id, name, orders_dataset_id, datasets_json,
                        timezone, parameters_json, created_at, updated_at,
                        definition_version
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                (
                    record.scenario_id,
                    record.name,
                    record.datasets.orders_dataset_id,
                    record.datasets.model_dump_json(),
                    record.timezone,
                    record.parameters.model_dump_json(),
                    record.created_at.isoformat(),
                    record.updated_at.isoformat(),
                    record.definition_version,
                ),
            )
        return record

    def get(self, scenario_id: str) -> ScenarioRecord:
        canonical = self._validate_id(scenario_id)
        with closing(self._connection()) as connection:
            row = connection.execute(
                """
                SELECT scenario_id, name, datasets_json, timezone,
                       parameters_json, created_at, updated_at, definition_version
                FROM simulation_scenarios WHERE scenario_id = ?
                """,
                (canonical,),
            ).fetchone()
        if row is None:
            raise AppError(
                code="SCENARIO_NOT_FOUND",
                message="方案不存在或已删除。",
                status_code=404,
            )
        return self._record(row)

    def list(self, orders_dataset_id: str) -> list[ScenarioRecord]:
        with closing(self._connection()) as connection:
            rows = connection.execute(
                """
                SELECT scenario_id, name, datasets_json, timezone,
                       parameters_json, created_at, updated_at, definition_version
                FROM simulation_scenarios
                WHERE orders_dataset_id = ?
                ORDER BY updated_at DESC, scenario_id
                """,
                (orders_dataset_id,),
            ).fetchall()
        return [self._record(row) for row in rows]

    def update(self, record: ScenarioRecord) -> ScenarioRecord:
        updated = record.model_copy(update={"updated_at": datetime.now(UTC)})
        with SCENARIO_WRITE_LOCK, closing(self._connection()) as connection, connection:
            cursor = connection.execute(
                """
                    UPDATE simulation_scenarios
                    SET name = ?, parameters_json = ?, updated_at = ?
                    WHERE scenario_id = ?
                    """,
                (
                    updated.name,
                    updated.parameters.model_dump_json(),
                    updated.updated_at.isoformat(),
                    updated.scenario_id,
                ),
            )
        if cursor.rowcount != 1:
            raise AppError(
                code="SCENARIO_NOT_FOUND",
                message="方案不存在或已删除。",
                status_code=404,
            )
        return updated

    def delete(self, scenario_id: str) -> None:
        canonical = self._validate_id(scenario_id)
        with SCENARIO_WRITE_LOCK, closing(self._connection()) as connection, connection:
            cursor = connection.execute(
                "DELETE FROM simulation_scenarios WHERE scenario_id = ?",
                (canonical,),
            )
        if cursor.rowcount != 1:
            raise AppError(
                code="SCENARIO_NOT_FOUND",
                message="方案不存在或已删除。",
                status_code=404,
            )

    def delete_for_dataset(self, dataset_id: str) -> int:
        """Remove every scenario that references the deleted dataset in any role."""
        with SCENARIO_WRITE_LOCK, closing(self._connection()) as connection:
            rows = connection.execute(
                "SELECT scenario_id, datasets_json FROM simulation_scenarios"
            ).fetchall()
            matching = [
                str(row[0])
                for row in rows
                if dataset_id
                in DatasetSelection.model_validate_json(str(row[1])).model_dump().values()
            ]
            if matching:
                connection.executemany(
                    "DELETE FROM simulation_scenarios WHERE scenario_id = ?",
                    [(scenario_id,) for scenario_id in matching],
                )
            connection.commit()
        return len(matching)
