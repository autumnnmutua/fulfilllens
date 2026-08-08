from __future__ import annotations

import math

from app.core.config import Settings
from app.core.errors import AppError
from app.diagnostics.config import load_default_rule_set, resolve_rule_set
from app.diagnostics.engine import (
    SEVERITY_RANK,
    DiagnosticComputation,
    analyze,
    findings_for_order,
    timeline_for_order,
)
from app.diagnostics.models import (
    DiagnosticAnalysisResponse,
    DiagnosticCategory,
    DiagnosticOrderDetail,
    DiagnosticOrderItem,
    DiagnosticOrderPage,
    DiagnosticRequest,
    DiagnosticRuleSet,
    Severity,
)
from app.metrics.service import MetricsService


class DiagnosticsService:
    def __init__(self, settings: Settings) -> None:
        self.metrics = MetricsService(settings)

    @staticmethod
    def rules() -> DiagnosticRuleSet:
        return load_default_rule_set().model_copy(deep=True)

    def _compute(
        self,
        request: DiagnosticRequest,
        *,
        order_ids: set[str] | None = None,
    ) -> DiagnosticComputation:
        orders, warehouse_events, tracking_events = self.metrics.load_selection_rows(
            request.datasets
        )
        if order_ids is not None:
            orders = [row for row in orders if str(row.get("order_id")) in order_ids]
            warehouse_events = [
                row for row in warehouse_events if str(row.get("order_id")) in order_ids
            ]
            tracking_events = [
                row for row in tracking_events if str(row.get("order_id")) in order_ids
            ]
        try:
            return analyze(
                [dict(row) for row in orders],
                [dict(row) for row in warehouse_events],
                [dict(row) for row in tracking_events],
                datasets=request.datasets,
                rule_set=resolve_rule_set(request.rule_overrides),
                timezone_name=request.timezone,
                max_evidence=request.max_evidence_per_result,
            )
        except ValueError as error:
            raise AppError(
                code="INVALID_DIAGNOSTIC_PARAMETER",
                message=str(error),
                status_code=422,
            ) from error

    def analysis(self, request: DiagnosticRequest) -> DiagnosticAnalysisResponse:
        return self._compute(request).response

    def analysis_for_order_ids(
        self,
        request: DiagnosticRequest,
        *,
        order_ids: set[str],
    ) -> DiagnosticAnalysisResponse:
        return self._compute(request, order_ids=order_ids).response

    def orders(
        self,
        request: DiagnosticRequest,
        *,
        page: int,
        page_size: int,
        severity: Severity | None,
        category: DiagnosticCategory | None,
        rule_id: str | None,
    ) -> DiagnosticOrderPage:
        computation = self._compute(request)
        details = {
            evaluation.detail.order_id: evaluation.detail
            for evaluation in computation.metrics_output.evaluations
        }
        matching_records = [
            record
            for record in computation.records
            if (severity is None or record.result.severity == severity)
            and (category is None or record.result.category == category)
            and (rule_id is None or record.result.rule_id == rule_id)
        ]
        order_ids = {
            order_id for record in matching_records for order_id in record.affected_order_ids
        }
        items: list[DiagnosticOrderItem] = []
        for order_id in order_ids:
            selected = [
                record.result
                for record in matching_records
                if order_id in record.affected_order_ids
            ]
            if not selected:
                continue
            detail = details[order_id]
            items.append(
                DiagnosticOrderItem(
                    order_id=order_id,
                    order_status=detail.order_status,
                    warehouse_id=detail.warehouse_id,
                    carrier_id=detail.carrier_id,
                    destination_region=detail.destination_region,
                    highest_severity=max(
                        (item.severity for item in selected),
                        key=SEVERITY_RANK.__getitem__,
                    ),
                    categories=sorted({item.category for item in selected}),
                    rule_ids=sorted(
                        {
                            rule
                            for item in selected
                            for rule in [item.rule_id, *item.merged_rule_ids]
                        }
                    ),
                    finding_count=len(selected),
                )
            )
        items.sort(key=lambda item: (-SEVERITY_RANK[item.highest_severity], item.order_id))
        total = len(items)
        page_count = math.ceil(total / page_size) if total else 0
        start = (page - 1) * page_size
        return DiagnosticOrderPage(
            datasets=request.datasets,
            items=items[start : start + page_size],
            total=total,
            page=page,
            page_size=page_size,
            page_count=page_count,
            rule_set_version=computation.response.rule_set_version,
        )

    def order_detail(
        self,
        request: DiagnosticRequest,
        *,
        order_id: str,
    ) -> DiagnosticOrderDetail:
        computation = self._compute(request)
        detail = next(
            (
                evaluation.detail
                for evaluation in computation.metrics_output.evaluations
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
        return DiagnosticOrderDetail(
            metric_detail=detail,
            findings=findings_for_order(computation, order_id),
            timeline=timeline_for_order(computation, order_id),
            rule_set_version=computation.response.rule_set_version,
        )


__all__ = ["DiagnosticsService"]
