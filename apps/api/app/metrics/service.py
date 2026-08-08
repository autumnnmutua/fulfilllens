from __future__ import annotations

from typing import Literal, cast

from app.core.config import Settings
from app.core.errors import AppError
from app.datasets.store import DatasetStore
from app.imports.store import ImportTaskRecord
from app.metrics.engine import (
    EngineOutput,
    breakdown,
    build_metrics,
    distribution,
    evaluate,
    trend,
)
from app.metrics.models import (
    BreakdownResponse,
    DatasetSelection,
    DistributionResponse,
    MetricsSummaryResponse,
    OrderMetricDetail,
    TrendResponse,
)
from app.schemas.imports import DataType, ImportStatus


class MetricsService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.store = DatasetStore(
            analytics_path=settings.analytics_database,
            control_path=settings.control_database,
        )

    def _migrate_legacy_dataset(self, dataset_id: str) -> None:
        root = self.settings.import_root
        if not root.is_dir():
            return
        for directory in root.iterdir():
            metadata = directory / "task.json"
            normalized = directory / "normalized.jsonl"
            if not metadata.is_file() or not normalized.is_file():
                continue
            try:
                task = ImportTaskRecord.model_validate_json(metadata.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if task.dataset_id == dataset_id and task.status == ImportStatus.ANALYZABLE:
                self.store.register(
                    dataset_id=dataset_id,
                    data_type=task.data_type,
                    task_id=task.task_id,
                    rows=DatasetStore.load_jsonl(normalized),
                )
                return

    def _load_rows(
        self,
        dataset_id: str,
        *,
        expected_type: DataType,
    ) -> list[dict[str, object]]:
        try:
            return self.store.load_rows(dataset_id, expected_type=expected_type)
        except AppError as error:
            if error.code != "DATASET_NOT_FOUND":
                raise
        self._migrate_legacy_dataset(dataset_id)
        return self.store.load_rows(dataset_id, expected_type=expected_type)

    def evaluate_selection(
        self,
        selection: DatasetSelection,
    ) -> EngineOutput:
        orders, warehouse_events, tracking_events = self.load_selection_rows(selection)
        return evaluate(orders, warehouse_events, tracking_events)

    def load_selection_rows(
        self,
        selection: DatasetSelection,
    ) -> tuple[
        list[dict[str, object]],
        list[dict[str, object]],
        list[dict[str, object]],
    ]:
        """按数据集选择读取三类标准行，供指标与后续领域引擎共享。"""
        orders = self._load_rows(
            selection.orders_dataset_id,
            expected_type=DataType.ORDERS,
        )
        warehouse_events = (
            self._load_rows(
                selection.warehouse_events_dataset_id,
                expected_type=DataType.WAREHOUSE_EVENTS,
            )
            if selection.warehouse_events_dataset_id
            else []
        )
        tracking_events = (
            self._load_rows(
                selection.tracking_events_dataset_id,
                expected_type=DataType.TRACKING_EVENTS,
            )
            if selection.tracking_events_dataset_id
            else []
        )
        return orders, warehouse_events, tracking_events

    def summary(self, selection: DatasetSelection) -> MetricsSummaryResponse:
        output = self.evaluate_selection(selection)
        return MetricsSummaryResponse(
            datasets=selection,
            metrics=build_metrics(output),
            warnings=output.warnings,
        )

    def trend(
        self,
        selection: DatasetSelection,
        *,
        grain: str,
        timezone_name: str,
    ) -> TrendResponse:
        if grain not in {"date", "week"}:
            raise AppError(
                code="UNSUPPORTED_TREND_GRAIN",
                message="趋势粒度仅支持 date 或 week。",
                status_code=422,
            )
        try:
            return trend(
                self.evaluate_selection(selection),
                grain=cast(Literal["date", "week"], grain),
                timezone_name=timezone_name,
                datasets=selection,
            )
        except ValueError as error:
            raise AppError(
                code="INVALID_METRICS_PARAMETER",
                message=str(error),
                status_code=422,
            ) from error

    def breakdown(
        self,
        selection: DatasetSelection,
        *,
        dimension: str,
    ) -> BreakdownResponse:
        allowed = {
            "warehouse_id",
            "carrier_id",
            "destination_region",
            "sales_channel",
        }
        if dimension not in allowed:
            raise AppError(
                code="UNSUPPORTED_BREAKDOWN_DIMENSION",
                message="维度仅支持仓库、承运商、目的地区和渠道。",
                status_code=422,
            )
        return breakdown(
            self.evaluate_selection(selection),
            dimension=cast(
                Literal[
                    "warehouse_id",
                    "carrier_id",
                    "destination_region",
                    "sales_channel",
                ],
                dimension,
            ),
            datasets=selection,
        )

    def distribution(
        self,
        selection: DatasetSelection,
        *,
        metric_code: str,
        bin_count: int,
    ) -> DistributionResponse:
        try:
            return distribution(
                self.evaluate_selection(selection),
                metric_code=metric_code,
                bin_count=bin_count,
                datasets=selection,
            )
        except ValueError as error:
            raise AppError(
                code="UNSUPPORTED_DISTRIBUTION_METRIC",
                message=str(error),
                status_code=422,
            ) from error

    def order_detail(
        self,
        selection: DatasetSelection,
        *,
        order_id: str,
    ) -> OrderMetricDetail:
        output = self.evaluate_selection(selection)
        detail = next(
            (
                evaluation.detail
                for evaluation in output.evaluations
                if evaluation.detail.order_id == order_id
            ),
            None,
        )
        if detail is None:
            raise AppError(
                code="ORDER_NOT_FOUND",
                message="所选数据集中不存在该订单。",
                status_code=404,
            )
        return detail
