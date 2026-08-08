from __future__ import annotations

import csv
import io
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from app.core.config import Settings
from app.core.errors import AppError
from app.dashboard.models import DashboardOverviewResponse
from app.dashboard.service import DashboardService
from app.datasets.store import DatasetStore
from app.diagnostics.models import DIAGNOSTIC_RULE_SET_VERSION, DiagnosticRequest
from app.diagnostics.service import DiagnosticsService
from app.metrics.models import DataWarning, MetricResult
from app.reports.models import (
    DEFAULT_REPORT_SECTIONS,
    CsvExportKind,
    ReportDocument,
    ReportHeader,
    ReportReadingGuideItem,
    ReportRequest,
    ReportSection,
)
from app.reports.renderers import render_html, render_markdown
from app.reports.security import mask_identifier, safe_csv_cell
from app.schemas.imports import DataType
from app.simulation.models import (
    ESTIMATE_LABEL,
    SIMULATION_DEFINITION_VERSION,
    SimulationRequest,
    SimulationResponse,
)
from app.simulation.service import SimulationService

ProgressCallback = Callable[[int, str], None]
CancelCallback = Callable[[], bool]

SECTION_TITLES = {
    "executive_summary": "Executive Summary",
    "data_quality": "数据质量决定结论可信度",
    "metrics_overview": "整体履约表现",
    "trend": "履约表现随时间的变化",
    "node_duration": "流程节点耗时与瓶颈",
    "dimension_breakdown": "问题集中在哪些业务维度",
    "diagnostics": "异常事实、规则判断与核查方向",
    "order_samples": "可追溯订单样例",
    "simulation": "What-if 情景估算",
    "methods_limits": "建议核查、进一步问题与方法限制",
}
READING_GUIDE = [
    ReportReadingGuideItem(
        term="OT（按时交付率）",
        meaning="在承诺时间内送达的可计算订单占比。",
        direction="通常越高越好。",
        caution="缺承诺时间或实际送达时间的订单不进入分母。",
        requires_context=True,
    ),
    ReportReadingGuideItem(
        term="IF（足量交付率）",
        meaning="实际交付数量达到订购数量的可计算订单占比。",
        direction="通常越高越好。",
        caution="缺订购量或交付量的订单不可计算；第一版按订单整体判断。",
        requires_context=True,
    ),
    ReportReadingGuideItem(
        term="OTIF（按时足量交付率）",
        meaning="同时做到按时和足量交付的订单占比。",
        direction="通常越高越好。",
        caution="必须同时看分母、覆盖率和不可计算数量，不能只比较百分比。",
        requires_context=True,
    ),
    ReportReadingGuideItem(
        term="平均履约时长",
        meaning="订单从创建到实际交付所用时间的算术平均值。",
        direction="在服务承诺一致时通常越低表示整体更快。",
        caution="容易被少量极慢订单拉高，应和 P50、P90 一起看。",
        requires_context=True,
    ),
    ReportReadingGuideItem(
        term="P50（中位数）",
        meaning="一半可计算订单的履约时长不超过此值。",
        direction="在可比条件下通常越低越好。",
        caution="不代表最慢订单，也不能替代 P90。",
    ),
    ReportReadingGuideItem(
        term="P90",
        meaning="90% 可计算订单的履约时长不超过此值，用于观察长尾。",
        direction="在可比条件下通常越低越好。",
        caution="小样本、低覆盖或业务结构不同的分组不能直接排名。",
        requires_context=True,
    ),
    ReportReadingGuideItem(
        term="异常率",
        meaning="至少触发一条透明异常规则的订单占比。",
        direction="越高表示需要核查的订单更多。",
        caution="规则触发不是已证实的经营原因，也不自动代表责任归属。",
        requires_context=True,
    ),
    ReportReadingGuideItem(
        term="数据覆盖率",
        meaning="具备相应计算所需字段的数据占应参与数据的比例。",
        direction="通常越高，指标越有代表性。",
        caution="覆盖率高不等于数据一定正确，仍需查看质量警告。",
    ),
]
IDENTIFIER_KEYS = {
    "order_id",
    "event_id",
    "shipment_id",
    "tracking_event_id",
    "source_order_id",
}


def _metric(metrics: list[MetricResult], code: str) -> MetricResult | None:
    return next((item for item in metrics if item.code == code), None)


def _format_metric(metric: MetricResult | None) -> str:
    if metric is None or metric.value is None:
        return "不可计算"
    if metric.unit == "ratio":
        return f"{float(metric.value) * 100:.2f}%"
    if metric.unit == "hour":
        return f"{float(metric.value):.2f} 小时"
    return f"{int(metric.value):,}"


def _check_cancel(cancelled: CancelCallback) -> None:
    if cancelled():
        raise AppError(
            code="REPORT_EXPORT_CANCELLED",
            message="报告导出已取消。",
            status_code=409,
        )


def _mask_structure(value: Any, *, include_identifiers: bool, key: str = "") -> Any:
    if include_identifiers:
        return value
    if key in IDENTIFIER_KEYS and isinstance(value, str):
        return mask_identifier(value)
    if key in {"affected_order_sample", "order_ids"} and isinstance(value, list):
        return [mask_identifier(str(item)) for item in value]
    if isinstance(value, dict):
        return {
            item_key: _mask_structure(
                item_value,
                include_identifiers=include_identifiers,
                key=item_key,
            )
            for item_key, item_value in value.items()
        }
    if isinstance(value, list):
        return [
            _mask_structure(item, include_identifiers=include_identifiers, key=key)
            for item in value
        ]
    return value


class ReportService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.dashboard = DashboardService(settings)
        self.diagnostics = DiagnosticsService(settings)
        self.simulation = SimulationService(settings)
        self.datasets = DatasetStore(
            analytics_path=settings.analytics_database,
            control_path=settings.control_database,
        )

    def _overview(self, request: ReportRequest) -> tuple[DashboardOverviewResponse, set[str]]:
        return self.dashboard.overview_with_order_ids(
            request.datasets,
            filters=request.filters,
            grain=request.trend_grain,
            dimension=request.breakdown_dimension,
            breakdown_sort_by="anomaly_order_rate",
            breakdown_sort_direction="desc",
        )

    def _simulation(
        self,
        request: ReportRequest,
        *,
        order_ids: set[str],
    ) -> SimulationResponse | None:
        selected = request.simulation
        if selected is None:
            return None
        return self.simulation.run_for_order_ids(
            SimulationRequest(
                datasets=request.datasets,
                timezone=request.filters.timezone,
                scenario_id=selected.scenario_id,
                scenario_name=selected.scenario_name,
                parameters=selected.parameters,
                adjustment_detail_limit=request.order_sample_limit,
            ),
            order_ids=order_ids,
        )

    def _synthetic(self, request: ReportRequest) -> bool:
        record = self.datasets.get(request.datasets.orders_dataset_id)
        return record.task_id.startswith("case:") or "合成" in request.dataset_name

    @staticmethod
    def _quality_warnings(
        warnings: list[DataWarning],
        *,
        include_identifiers: bool,
    ) -> list[dict[str, Any]]:
        return [
            _mask_structure(
                warning.model_dump(mode="json"),
                include_identifiers=include_identifiers,
            )
            for warning in warnings
        ]

    @staticmethod
    def _executive_summary(
        overview: DashboardOverviewResponse,
        *,
        finding_count: int,
        simulation: SimulationResponse | None,
    ) -> list[str]:
        otif = _metric(overview.metrics, "otif_rate")
        p90 = _metric(overview.metrics, "fulfillment_duration_p90_hours")
        anomaly = _metric(overview.metrics, "anomaly_order_rate")
        coverage = overview.context.data_coverage
        summary = [
            (
                "整体表现：当前筛选范围的 OTIF 为 "
                f"{_format_metric(otif)}，P90 履约时长为 {_format_metric(p90)}。"
            ),
            (
                "风险范围：异常订单率为 "
                f"{_format_metric(anomaly)}，透明规则共形成 {finding_count} 条聚合发现；"
                "这些发现用于定位核查方向，不等同于已证实根因。"
            ),
            (
                "数据可信度：数据覆盖率为 "
                f"{('不可计算' if coverage is None else f'{coverage * 100:.2f}%')}，"
                f"报告保留 {overview.context.warning_count} 条数据警告计数。"
            ),
        ]
        if simulation is not None:
            summary.append(
                "情景估算：已纳入方案“"
                f"{simulation.scenario_name}”，影响 {simulation.affected_order_count} 个订单；"
                "结果基于历史数据和简化假设，不代表预测或保证。"
            )
        return summary

    def build_document(
        self,
        request: ReportRequest,
        *,
        progress: ProgressCallback | None = None,
        cancelled: CancelCallback | None = None,
    ) -> ReportDocument:
        report_progress = progress or (lambda _value, _message: None)
        is_cancelled = cancelled or (lambda: False)
        _check_cancel(is_cancelled)
        report_progress(8, "正在读取筛选一致的分析结果")
        overview, filtered_order_ids = self._overview(request)

        needs_diagnostics = "diagnostics" in request.sections
        diagnostic = None
        if needs_diagnostics:
            _check_cancel(is_cancelled)
            report_progress(30, "正在执行透明诊断")
            diagnostic = self.diagnostics.analysis_for_order_ids(
                DiagnosticRequest(
                    datasets=request.datasets,
                    timezone=request.filters.timezone,
                    max_evidence_per_result=min(request.order_sample_limit, 100),
                ),
                order_ids=filtered_order_ids,
            )

        simulation = None
        if "simulation" in request.sections and request.simulation is not None:
            _check_cancel(is_cancelled)
            report_progress(48, "正在复算情景方案")
            simulation = self._simulation(request, order_ids=filtered_order_ids)

        _check_cancel(is_cancelled)
        order_samples = []
        order_sample_total = 0
        if "order_samples" in request.sections:
            report_progress(60, "正在读取订单样例")
            order_page = self.dashboard.orders(
                request.datasets,
                filters=request.filters,
                page=1,
                page_size=request.order_sample_limit,
                sort_by="anomaly",
                sort_direction="desc",
            )
            order_sample_total = order_page.total
            for item in order_page.items:
                order_samples.append(
                    {
                        "order_id": (
                            item.order_id
                            if request.include_order_identifiers
                            else mask_identifier(item.order_id)
                        ),
                        "order_status": item.order_status,
                        "warehouse_id": item.warehouse_id,
                        "carrier_id": item.carrier_id,
                        "destination_region": item.destination_region,
                        "otif_status": item.otif.status,
                        "fulfillment_duration_hours": item.fulfillment_duration_hours,
                        "anomaly_types": item.anomaly_types,
                    }
                )

        finding_count = diagnostic.context.finding_count if diagnostic is not None else 0
        executive_summary = self._executive_summary(
            overview,
            finding_count=finding_count,
            simulation=simulation,
        )
        sections: list[ReportSection] = []
        for code in DEFAULT_REPORT_SECTIONS:
            if code not in request.sections:
                continue
            if code == "executive_summary":
                sections.append(ReportSection(code=code, title=SECTION_TITLES[code]))
            elif code == "data_quality":
                sections.append(
                    ReportSection(
                        code=code,
                        title=SECTION_TITLES[code],
                        narrative=[
                            "覆盖率和警告决定指标能否用于判断；缺失数据不会被默认为成功或失败。"
                        ],
                        data={
                            "order_count": overview.context.order_count,
                            "valid_order_count": overview.context.valid_order_count,
                            "data_coverage": overview.context.data_coverage,
                            "warning_count": overview.context.warning_count,
                            "warnings": self._quality_warnings(
                                overview.warnings,
                                include_identifiers=request.include_order_identifiers,
                            ),
                        },
                        warnings=(
                            ["质量警告列表已截断，完整计数仍保留在报告头部。"]
                            if overview.warnings_truncated
                            else []
                        ),
                    )
                )
            elif code == "metrics_overview":
                sections.append(
                    ReportSection(
                        code=code,
                        title=SECTION_TITLES[code],
                        narrative=[
                            "下列指标来自同一筛选订单集合，比例同时展示分子、分母、覆盖率和不可计算数量。"
                        ],
                        data={
                            "metrics": [item.model_dump(mode="json") for item in overview.metrics]
                        },
                    )
                )
            elif code == "trend":
                sections.append(
                    ReportSection(
                        code=code,
                        title=SECTION_TITLES[code],
                        narrative=[
                            "趋势只描述当前筛选下的时间变化；时间上的共同变化不能单独证明因果关系。"
                        ],
                        data=overview.trend.model_dump(mode="json"),
                        warnings=(
                            ["趋势点不足 2 个，报告保留精确值表但不绘制趋势线。"]
                            if len(overview.trend.groups) < 2
                            else []
                        ),
                    )
                )
            elif code == "node_duration":
                sections.append(
                    ReportSection(
                        code=code,
                        title=SECTION_TITLES[code],
                        narrative=[
                            "P90 用于观察长尾，平均值与中位数用于区分普遍变慢和少量极端订单。"
                        ],
                        data={"nodes": [item.model_dump(mode="json") for item in overview.nodes]},
                    )
                )
            elif code == "dimension_breakdown":
                sections.append(
                    ReportSection(
                        code=code,
                        title=SECTION_TITLES[code],
                        narrative=[
                            "分组差异用于确定下钻优先级；样本量、线路和订单结构差异可能影响可比性。"
                        ],
                        data=overview.breakdown.model_dump(mode="json"),
                    )
                )
            elif code == "diagnostics":
                results = [] if diagnostic is None else diagnostic.results
                sections.append(
                    ReportSection(
                        code=code,
                        title=SECTION_TITLES[code],
                        narrative=[
                            "每条诊断严格分为数据观察事实、规则判断、未经因果验证的可能原因和建议核查。"
                        ],
                        data={
                            "results": _mask_structure(
                                [item.model_dump(mode="json") for item in results],
                                include_identifiers=request.include_order_identifiers,
                            )
                        },
                        warnings=(diagnostic.analysis_warnings if diagnostic is not None else []),
                    )
                )
            elif code == "order_samples":
                sections.append(
                    ReportSection(
                        code=code,
                        title=SECTION_TITLES[code],
                        narrative=[
                            f"仅展示前 {request.order_sample_limit} 个订单样例；"
                            "完整明细应使用安全 CSV 导出。"
                        ],
                        data={"orders": order_samples, "total": order_sample_total},
                    )
                )
            elif code == "simulation":
                sections.append(
                    ReportSection(
                        code=code,
                        title=SECTION_TITLES[code],
                        narrative=[
                            "模拟从订单和节点层应用可解释变换后重新调用指标引擎，不能被解释为真实预测。"
                        ],
                        data={
                            "result": (
                                _mask_structure(
                                    simulation.model_dump(mode="json"),
                                    include_identifiers=request.include_order_identifiers,
                                )
                                if simulation is not None
                                else None
                            )
                        },
                        warnings=(
                            ["未选择模拟方案，本节不生成结果。"]
                            if simulation is None
                            else simulation.warnings
                        ),
                    )
                )
            elif code == "methods_limits":
                sections.append(
                    ReportSection(
                        code=code,
                        title=SECTION_TITLES[code],
                        data={
                            "items": [
                                "建议先核查高严重度且覆盖率充足的规则证据，再决定运营动作。",
                                "需要进一步确认：不同承运商是否处于相同线路、服务等级和订单结构。",
                                "OT、IF、OTIF 的不可计算订单不进入成功或失败分母。",
                                "分位数采用 Hyndman-Fan Type 7 线性插值；所有时间按报告时区解释。",
                                "诊断规则用于透明筛查，相关性观察不能证明因果。",
                                "情景模拟采用历史样本和简化传导假设，不代表真实预测、收益或服务保证。",
                                "报告是生成时点的本地快照；更改数据、筛选、规则或方案后必须重新生成。",
                            ]
                        },
                    )
                )

        report_progress(82, "正在生成报告结构")
        _check_cancel(is_cancelled)
        report_warnings = [item.message for item in overview.warnings[:10]]
        if overview.context.data_coverage is None or overview.context.data_coverage < 0.8:
            report_warnings.insert(0, "数据覆盖率不足 80%，结论应与质量问题一并解释。")
        if simulation is not None:
            report_warnings.append(ESTIMATE_LABEL)
        source_notes = [
            f"指标来源：MetricsService / {overview.definition_version}",
            f"诊断来源：DiagnosticsService / {DIAGNOSTIC_RULE_SET_VERSION}",
            f"模拟来源：SimulationService / {SIMULATION_DEFINITION_VERSION}",
            "筛选来源：DashboardFilters；报告、页面与 CSV 使用相同字段和时区。",
        ]
        chart_map = [
            {
                "section": "trend",
                "question": "OTIF 与异常率是否随时间变化",
                "chart": "两条折线，共用 0%–100% 比例轴",
                "fallback": "少于 2 个时间点时使用精确值表",
            },
            {
                "section": "node_duration",
                "question": "哪些节点存在长尾耗时",
                "chart": "从零开始的 P90 横向条形图",
                "fallback": "无可计算节点时显示空状态",
            },
            {
                "section": "dimension_breakdown",
                "question": "哪些业务分组的 OTIF 更低",
                "chart": "从零开始的 OTIF 横向条形图",
                "fallback": "无分组时显示空状态",
            },
        ]
        report_progress(92, "正在完成报告元数据")
        return ReportDocument(
            header=ReportHeader(
                title=f"{request.dataset_name}履约分析报告",
                dataset_name=request.dataset_name,
                time_range_start=(
                    overview.context.time_range_start.isoformat()
                    if overview.context.time_range_start is not None
                    else None
                ),
                time_range_end=(
                    overview.context.time_range_end.isoformat()
                    if overview.context.time_range_end is not None
                    else None
                ),
                order_count=overview.context.order_count,
                valid_order_count=overview.context.valid_order_count,
                data_coverage=overview.context.data_coverage,
                generated_at=datetime.now(UTC),
                timezone=request.filters.timezone,
                metrics_definition_version=overview.definition_version,
                diagnostic_rule_version=(
                    diagnostic.rule_set_version
                    if diagnostic is not None
                    else DIAGNOSTIC_RULE_SET_VERSION
                ),
                simulation_version=(
                    simulation.definition_version
                    if simulation is not None
                    else SIMULATION_DEFINITION_VERSION
                ),
                synthetic_data=self._synthetic(request),
            ),
            filters=request.filters,
            executive_summary=executive_summary,
            sections=sections,
            warnings=list(dict.fromkeys(report_warnings)),
            source_notes=source_notes,
            chart_map=chart_map,
            identifier_policy=(
                "已二次确认，报告包含标准数据中的订单/事件标识；"
                "标准 Schema 仍不包含姓名、手机号、身份证或详细地址。"
                if request.include_order_identifiers
                else "默认最小化：订单、事件与运单标识已掩码；"
                "姓名、手机号、身份证和详细地址不在标准 Schema 中。"
            ),
            reading_mode=request.reading_mode,
            reading_guide=READING_GUIDE if request.reading_mode == "guided" else [],
        )

    def render_report(
        self,
        request: ReportRequest,
        *,
        format_name: str,
        progress: ProgressCallback,
        cancelled: CancelCallback,
    ) -> bytes:
        document = self.build_document(request, progress=progress, cancelled=cancelled)
        _check_cancel(cancelled)
        progress(96, "正在渲染导出文件")
        if format_name == "markdown":
            return render_markdown(document)
        if format_name == "html":
            return render_html(document)
        raise AppError(
            code="UNSUPPORTED_REPORT_FORMAT", message="不支持的报告格式。", status_code=422
        )

    def _write_csv(
        self,
        headers: list[str],
        rows: list[list[object]],
        *,
        progress: ProgressCallback,
        cancelled: CancelCallback,
    ) -> bytes:
        buffer = io.StringIO(newline="")
        writer = csv.writer(buffer, lineterminator="\r\n")
        writer.writerow([safe_csv_cell(value) for value in headers])
        total = max(len(rows), 1)
        for index, row in enumerate(rows):
            if index % 100 == 0:
                _check_cancel(cancelled)
                progress(55 + int(40 * index / total), f"正在写入第 {index + 1} 行")
            writer.writerow([safe_csv_cell(value) for value in row])
        return ("\ufeff" + buffer.getvalue()).encode("utf-8")

    def export_csv(
        self,
        request: ReportRequest,
        *,
        kind: CsvExportKind,
        progress: ProgressCallback,
        cancelled: CancelCallback,
    ) -> bytes:
        _check_cancel(cancelled)
        progress(10, "正在准备 CSV 数据")
        overview, filtered_order_ids = self._overview(request)
        headers: list[str]
        rows: list[list[object]]
        if kind == "anomaly_orders":
            page = self.dashboard.orders(
                request.datasets,
                filters=request.filters,
                page=1,
                page_size=self.settings.max_import_rows,
                sort_by="anomaly",
                sort_direction="desc",
            )
            headers = [
                "订单标识",
                "订单状态",
                "仓库",
                "承运商",
                "目的地区",
                "OTIF",
                "履约时长（小时）",
                "异常类型",
                "异常证据",
                "指标版本",
            ]
            rows = [
                [
                    item.order_id
                    if request.include_order_identifiers
                    else mask_identifier(item.order_id),
                    item.order_status,
                    item.warehouse_id,
                    item.carrier_id,
                    item.destination_region,
                    item.otif.status,
                    item.fulfillment_duration_hours,
                    "；".join(item.anomaly_types),
                    "；".join(item.anomaly_reasons),
                    item.definition_version,
                ]
                for item in page.items
                if item.anomaly
            ]
        elif kind == "data_quality_errors":
            headers = ["警告代码", "说明", "订单标识", "事件标识", "节点区间", "指标版本"]
            rows = [
                [
                    item.code,
                    item.message,
                    (
                        item.order_id
                        if request.include_order_identifiers
                        else mask_identifier(item.order_id)
                    ),
                    (
                        item.event_id
                        if request.include_order_identifiers
                        else mask_identifier(item.event_id)
                    ),
                    item.interval_code,
                    overview.definition_version,
                ]
                for item in overview.warnings
            ]
        elif kind == "status_mapping":
            headers = ["数据类型", "原始状态", "标准状态", "映射来源", "映射置信度"]
            mappings: set[tuple[str, str, str]] = set()
            selections = [
                (
                    DataType.ORDERS,
                    request.datasets.orders_dataset_id,
                    "raw_order_status",
                    "order_status",
                ),
                (
                    DataType.WAREHOUSE_EVENTS,
                    request.datasets.warehouse_events_dataset_id,
                    "raw_status",
                    "event_code",
                ),
                (
                    DataType.TRACKING_EVENTS,
                    request.datasets.tracking_events_dataset_id,
                    "raw_status",
                    "event_code",
                ),
            ]
            for data_type, dataset_id, raw_field, normalized_field in selections:
                if dataset_id is None:
                    continue
                for item in self.datasets.load_rows(dataset_id, expected_type=data_type):
                    if str(item.get("order_id")) not in filtered_order_ids:
                        continue
                    mappings.add(
                        (
                            data_type.value,
                            str(item.get(raw_field) or ""),
                            str(item.get(normalized_field) or "unmapped"),
                        )
                    )
            rows = [
                [data_type, raw, normalized, "confirmed_standard_dataset", ""]
                for data_type, raw, normalized in sorted(mappings)
            ]
        elif kind == "metric_detail":
            headers = [
                "层级",
                "分组",
                "指标代码",
                "指标名称",
                "值",
                "单位",
                "分子",
                "分母",
                "覆盖率",
                "不可计算数",
                "指标版本",
            ]
            rows = [
                [
                    "overall",
                    "总体",
                    metric.code,
                    metric.display_name,
                    metric.value,
                    metric.unit,
                    metric.numerator,
                    metric.denominator,
                    metric.coverage,
                    metric.not_computable_count,
                    metric.definition_version,
                ]
                for metric in overview.metrics
            ]
            for group in overview.breakdown.groups:
                rows.extend(
                    [
                        request.breakdown_dimension,
                        group.label,
                        metric.code,
                        metric.display_name,
                        metric.value,
                        metric.unit,
                        metric.numerator,
                        metric.denominator,
                        metric.coverage,
                        metric.not_computable_count,
                        metric.definition_version,
                    ]
                    for metric in group.metrics
                )
        else:
            simulation = self._simulation(request, order_ids=filtered_order_ids)
            if simulation is None:
                raise AppError(
                    code="SIMULATION_REQUIRED_FOR_EXPORT",
                    message="模拟对比 CSV 必须先选择可复算方案。",
                    status_code=422,
                )
            headers = [
                "方案名称",
                "指标代码",
                "指标名称",
                "基线",
                "方案",
                "绝对变化",
                "相对变化",
                "分子（基线/方案）",
                "分母（基线/方案）",
                "覆盖率（基线/方案）",
                "模拟版本",
                "情景估算声明",
            ]
            rows = [
                [
                    simulation.scenario_name,
                    item.code,
                    item.display_name,
                    item.baseline_value,
                    item.scenario_value,
                    item.absolute_change,
                    item.relative_change,
                    f"{item.baseline_numerator}/{item.scenario_numerator}",
                    f"{item.baseline_denominator}/{item.scenario_denominator}",
                    f"{item.baseline_coverage}/{item.scenario_coverage}",
                    simulation.definition_version,
                    simulation.estimate_label,
                ]
                for item in simulation.comparisons
            ]
        progress(50, f"已准备 {len(rows)} 行 CSV")
        return self._write_csv(headers, rows, progress=progress, cancelled=cancelled)
