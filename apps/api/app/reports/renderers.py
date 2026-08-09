# HTML/SVG/CSS 模板中的完整标签保持在单行，避免拆分后改变导出内容。
# ruff: noqa: E501

from __future__ import annotations

import html
import json
from collections.abc import Iterable
from typing import Any

from app.reports.models import ReportDocument, ReportSection


def _metric_value(value: object, unit: str | None = None) -> str:
    if value is None:
        return "不可计算"
    if isinstance(value, bool):
        return "是" if value else "否"
    if isinstance(value, (int, float)):
        if unit == "ratio":
            return f"{float(value) * 100:.2f}%"
        if unit == "hour":
            return f"{float(value):.2f} 小时"
        if isinstance(value, float):
            return f"{value:.2f}"
        return f"{value:,}"
    return str(value)


def _metric_by_code(metrics: Iterable[dict[str, Any]], code: str) -> dict[str, Any] | None:
    return next((metric for metric in metrics if metric.get("code") == code), None)


def _md_table(headers: list[str], rows: list[list[object]]) -> str:
    def cell(value: object) -> str:
        return _md_text(value)

    output = [
        "| " + " | ".join(cell(value) for value in headers) + " |",
        "| " + " | ".join("---" for _ in headers) + " |",
    ]
    output.extend("| " + " | ".join(cell(value) for value in row) + " |" for row in rows)
    return "\n".join(output)


def _md_text(value: object) -> str:
    text = html.escape("" if value is None else str(value), quote=False)
    text = text.replace("\\", "\\\\")
    for character in ("`", "*", "_", "[", "]", "#", "|"):
        text = text.replace(character, f"\\{character}")
    return text.replace("\r", " ").replace("\n", " ")


def _markdown_section(section: ReportSection) -> str:
    lines = [f"## {_md_text(section.title)}", ""]
    lines.extend(f"{_md_text(paragraph)}\n" for paragraph in section.narrative)
    data = section.data
    if section.code == "data_quality":
        lines.append(
            _md_table(
                ["项目", "结果"],
                [
                    ["订单数", data.get("order_count")],
                    ["有效订单", data.get("valid_order_count")],
                    ["数据覆盖率", _metric_value(data.get("data_coverage"), "ratio")],
                    ["质量警告", data.get("warning_count")],
                ],
            )
        )
        warnings = data.get("warnings", [])
        if warnings:
            lines.extend(["", "### 可追溯质量问题", ""])
            lines.append(
                _md_table(
                    ["代码", "说明", "订单标识", "事件标识"],
                    [
                        [
                            item.get("code"),
                            item.get("message"),
                            item.get("order_id", ""),
                            item.get("event_id", ""),
                        ]
                        for item in warnings
                    ],
                )
            )
    elif section.code == "metrics_overview":
        lines.append(
            _md_table(
                ["指标", "结果", "分子", "分母", "覆盖率", "不可计算", "口径版本"],
                [
                    [
                        metric.get("display_name"),
                        _metric_value(metric.get("value"), metric.get("unit")),
                        metric.get("numerator", ""),
                        metric.get("denominator", ""),
                        _metric_value(metric.get("coverage"), "ratio"),
                        metric.get("not_computable_count", 0),
                        metric.get("definition_version"),
                    ]
                    for metric in data.get("metrics", [])
                ],
            )
        )
    elif section.code == "trend":
        rows: list[list[object]] = []
        for group in data.get("groups", []):
            metrics = group.get("metrics", [])
            rows.append(
                [
                    group.get("label"),
                    group.get("order_count"),
                    _metric_value(
                        (_metric_by_code(metrics, "otif_rate") or {}).get("value"), "ratio"
                    ),
                    _metric_value(
                        (_metric_by_code(metrics, "anomaly_order_rate") or {}).get("value"),
                        "ratio",
                    ),
                ]
            )
        lines.append(_md_table(["期间", "订单量", "OTIF", "异常率"], rows))
    elif section.code == "node_duration":
        lines.append(
            _md_table(
                ["节点", "平均", "P50", "P90", "样本", "覆盖率", "瓶颈"],
                [
                    [
                        node.get("display_name"),
                        _metric_value(node.get("mean_hours"), "hour"),
                        _metric_value(node.get("median_hours"), "hour"),
                        _metric_value(node.get("p90_hours"), "hour"),
                        node.get("sample_size"),
                        _metric_value(node.get("coverage"), "ratio"),
                        "是" if node.get("is_bottleneck") else "否",
                    ]
                    for node in data.get("nodes", [])
                ],
            )
        )
    elif section.code == "dimension_breakdown":
        rows = []
        for group in data.get("groups", []):
            metrics = group.get("metrics", [])
            rows.append(
                [
                    group.get("label"),
                    group.get("order_count"),
                    _metric_value(
                        (_metric_by_code(metrics, "otif_rate") or {}).get("value"), "ratio"
                    ),
                    _metric_value(
                        (_metric_by_code(metrics, "fulfillment_duration_p90_hours") or {}).get(
                            "value"
                        ),
                        "hour",
                    ),
                    _metric_value(
                        (_metric_by_code(metrics, "anomaly_order_rate") or {}).get("value"),
                        "ratio",
                    ),
                ]
            )
        lines.append(_md_table(["分组", "订单量", "OTIF", "P90", "异常率"], rows))
    elif section.code == "diagnostics":
        for finding in data.get("results", []):
            lines.extend(
                [
                    f"### {_md_text(finding.get('title'))}（{_md_text(finding.get('rule_id'))}）",
                    "",
                    f"- **数据观察事实**：{_md_text(finding.get('factual_observation'))}",
                    f"- **规则判断**：{_md_text(finding.get('rule_judgement'))}",
                    "- **可能原因（未经因果验证）**："
                    + _md_text("；".join(finding.get("possible_causes", []))),
                    "- **建议核查**：" + _md_text("；".join(finding.get("recommended_checks", []))),
                    f"- 影响订单：{finding.get('affected_order_count')}；样本：{finding.get('sample_size')}；覆盖率：{_metric_value(finding.get('coverage'), 'ratio')}",
                    "",
                ]
            )
    elif section.code == "order_samples":
        lines.append(
            _md_table(
                ["订单标识", "状态", "仓库", "承运商", "地区", "OTIF", "时效", "异常"],
                [
                    [
                        order.get("order_id"),
                        order.get("order_status"),
                        order.get("warehouse_id"),
                        order.get("carrier_id"),
                        order.get("destination_region"),
                        order.get("otif_status"),
                        _metric_value(order.get("fulfillment_duration_hours"), "hour"),
                        "；".join(order.get("anomaly_types", [])),
                    ]
                    for order in data.get("orders", [])
                ],
            )
        )
    elif section.code == "simulation":
        simulation = data.get("result")
        if simulation:
            lines.extend(
                [
                    f"> **情景估算**：{_md_text(simulation.get('estimate_label'))}",
                    "",
                    f"方案：{_md_text(simulation.get('scenario_name'))}；影响订单：{_md_text(simulation.get('affected_order_count'))}。",
                    "",
                    _md_table(
                        ["指标", "基线", "方案", "绝对变化", "相对变化"],
                        [
                            [
                                item.get("display_name"),
                                _metric_value(item.get("baseline_value"), item.get("unit")),
                                _metric_value(item.get("scenario_value"), item.get("unit")),
                                _metric_value(item.get("absolute_change"), item.get("unit")),
                                _metric_value(item.get("relative_change"), "ratio"),
                            ]
                            for item in simulation.get("comparisons", [])
                        ],
                    ),
                    "",
                    "**参数**：`"
                    + _md_text(json.dumps(simulation.get("parameters", {}), ensure_ascii=False))
                    + "`",
                    "",
                    "**模型假设**：" + _md_text("；".join(simulation.get("assumptions", []))),
                ]
            )
        else:
            lines.append("未选择可复算模拟方案，本节不生成看似精确的结果。")
    elif section.code == "methods_limits":
        for item in data.get("items", []):
            lines.append(f"- {_md_text(item)}")
    if section.warnings:
        lines.extend(["", "### 本节限制", ""])
        lines.extend(f"- {_md_text(warning)}" for warning in section.warnings)
    return "\n".join(lines).strip()


def render_markdown(report: ReportDocument) -> bytes:
    header = report.header
    lines = [
        f"# {_md_text(header.title)}",
        "",
        f"> 数据集：{_md_text(header.dataset_name)}；时间范围：{_md_text(header.time_range_start or '未知')} 至 {_md_text(header.time_range_end or '未知')}；生成时间：{_md_text(header.generated_at.isoformat())}。",
        "",
        _md_table(
            ["订单数", "有效订单", "覆盖率", "指标版本", "规则版本", "模拟版本", "报告版本"],
            [
                [
                    header.order_count,
                    header.valid_order_count,
                    _metric_value(header.data_coverage, "ratio"),
                    header.metrics_definition_version,
                    header.diagnostic_rule_version,
                    header.simulation_version,
                    header.report_version,
                ]
            ],
        ),
        "",
    ]
    if report.reading_guide:
        lines.extend(["## 快速阅读版：指标怎么读", ""])
        for item in report.reading_guide:
            context = "【需结合上下文】" if item.requires_context else ""
            lines.append(
                f"- **{_md_text(item.term)}**{context}：{_md_text(item.meaning)}"
                f" {_md_text(item.direction)} 注意：{_md_text(item.caution)}"
            )
        lines.append("")
    if "executive_summary" in [section.code for section in report.sections]:
        lines.extend(["## Executive Summary", ""])
        lines.extend(f"- {_md_text(item)}" for item in report.executive_summary)
        lines.append("")
    lines.extend(
        _markdown_section(section)
        for section in report.sections
        if section.code != "executive_summary"
    )
    if report.warnings:
        lines.extend(["", "## 报告级警告", ""])
        lines.extend(f"- {_md_text(warning)}" for warning in report.warnings)
    return ("\ufeff" + "\n\n".join(lines).strip() + "\n").encode("utf-8")


def _h(value: object) -> str:
    return html.escape("" if value is None else str(value), quote=True)


def _html_table(headers: list[str], rows: list[list[object]], *, dense: bool = False) -> str:
    density = " dense" if dense else ""
    head = "".join(f'<th scope="col">{_h(item)}</th>' for item in headers)
    body = "".join(
        "<tr>" + "".join(f"<td>{_h(item)}</td>" for item in row) + "</tr>" for row in rows
    )
    if not body:
        body = f'<tr><td colspan="{len(headers)}" class="empty">当前筛选下无可展示数据</td></tr>'
    caption = f"{headers[0]}等数据"
    return f'<div class="table-wrap"><table class="{density.strip()}"><caption>{_h(caption)}</caption><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>'


def _svg_rate_trend(groups: list[dict[str, Any]]) -> str:
    if len(groups) < 2:
        return '<p class="empty">时间点不足 2 个，不绘制趋势线。</p>'
    width, height, left, top, bottom = 760, 260, 56, 24, 48
    plot_w, plot_h = width - left - 20, height - top - bottom
    step = plot_w / max(len(groups) - 1, 1)

    def points(code: str) -> str:
        output: list[str] = []
        for index, group in enumerate(groups):
            metric = _metric_by_code(group.get("metrics", []), code) or {}
            value = metric.get("value")
            if value is None:
                continue
            x = left + index * step
            y = top + plot_h * (1 - max(0.0, min(float(value), 1.0)))
            output.append(f"{x:.1f},{y:.1f}")
        return " ".join(output)

    grid = "".join(
        f'<line x1="{left}" y1="{top + plot_h * (1 - i / 4):.1f}" x2="{width - 20}" y2="{top + plot_h * (1 - i / 4):.1f}" class="grid"/><text x="8" y="{top + plot_h * (1 - i / 4) + 4:.1f}">{i * 25}%</text>'
        for i in range(5)
    )
    label_indexes = sorted({0, len(groups) // 2, len(groups) - 1})
    labels = "".join(
        f'<text x="{left + index * step:.1f}" y="{height - 16}" text-anchor="middle">{_h(groups[index].get("label"))}</text>'
        for index in label_indexes
    )
    return (
        f'<svg class="chart" viewBox="0 0 {width} {height}" role="img" aria-label="OTIF 与异常率趋势，比例轴从 0% 到 100%">'
        + grid
        + f'<polyline points="{points("otif_rate")}" class="line primary"/><polyline points="{points("anomaly_order_rate")}" class="line secondary dashed"/>'
        + labels
        + '<g class="legend"><line x1="560" y1="14" x2="590" y2="14" class="line primary"/><text x="596" y="18">OTIF</text><line x1="650" y1="14" x2="680" y2="14" class="line secondary dashed"/><text x="686" y="18">异常率</text></g>'
        + "</svg>"
    )


def _svg_horizontal_bars(
    rows: list[tuple[str, float | None]],
    *,
    unit: str,
    percentage: bool = False,
) -> str:
    valid = [(label, value) for label, value in rows if value is not None][:12]
    if not valid:
        return '<p class="empty">当前筛选下没有足够数据绘图。</p>'
    maximum = 1.0 if percentage else max(float(value) for _, value in valid) or 1.0
    row_height = 34
    width, left, right = 760, 220, 80
    height = 28 + row_height * len(valid)
    plot_width = width - left - right
    bars = []
    for index, (label, value) in enumerate(valid):
        numeric = float(value)
        y = 20 + index * row_height
        bar_width = max(0, min(numeric / maximum, 1)) * plot_width
        display = f"{numeric * 100:.1f}%" if percentage else f"{numeric:.2f} {unit}"
        bars.append(
            f'<text x="{left - 12}" y="{y + 16}" text-anchor="end">{_h(label)}</text>'
            f'<rect x="{left}" y="{y}" width="{plot_width}" height="20" class="bar-track"/>'
            f'<rect x="{left}" y="{y}" width="{bar_width:.1f}" height="20" class="bar"/>'
            f'<text x="{left + bar_width + 8:.1f}" y="{y + 15}">{_h(display)}</text>'
        )
    return f'<svg class="chart" viewBox="0 0 {width} {height}" role="img" aria-label="从零开始的横向条形图">{"".join(bars)}</svg>'


def _html_section(section: ReportSection) -> str:
    narrative = "".join(f"<p>{_h(item)}</p>" for item in section.narrative)
    data = section.data
    content = ""
    if section.code == "data_quality":
        content = _html_table(
            ["项目", "结果"],
            [
                ["订单数", data.get("order_count")],
                ["有效订单", data.get("valid_order_count")],
                ["数据覆盖率", _metric_value(data.get("data_coverage"), "ratio")],
                ["质量警告", data.get("warning_count")],
            ],
        )
        if data.get("warnings"):
            content += _html_table(
                ["代码", "说明", "订单标识", "事件标识"],
                [
                    [w.get("code"), w.get("message"), w.get("order_id", ""), w.get("event_id", "")]
                    for w in data["warnings"]
                ],
                dense=True,
            )
    elif section.code == "metrics_overview":
        metrics = data.get("metrics", [])
        cards = "".join(
            f'<article class="metric"><span>{_h(m.get("display_name"))}</span><strong>{_h(_metric_value(m.get("value"), m.get("unit")))}</strong><small>分子 {_h(m.get("numerator"))} / 分母 {_h(m.get("denominator"))} · 覆盖率 {_h(_metric_value(m.get("coverage"), "ratio"))}</small></article>'
            for m in metrics
        )
        content = f'<div class="metric-grid">{cards}</div>'
    elif section.code == "trend":
        groups = data.get("groups", [])
        content = (
            '<h3>OTIF 与异常率趋势</h3><p class="chart-note">统一比例轴 0%–100%，实线为 OTIF，虚线为异常率。</p>'
            + _svg_rate_trend(groups)
        )
        content += _html_table(
            ["期间", "订单量", "OTIF", "异常率"],
            [
                [
                    g.get("label"),
                    g.get("order_count"),
                    _metric_value(
                        (_metric_by_code(g.get("metrics", []), "otif_rate") or {}).get("value"),
                        "ratio",
                    ),
                    _metric_value(
                        (_metric_by_code(g.get("metrics", []), "anomaly_order_rate") or {}).get(
                            "value"
                        ),
                        "ratio",
                    ),
                ]
                for g in groups
            ],
            dense=True,
        )
    elif section.code == "node_duration":
        nodes = data.get("nodes", [])
        content = '<h3>节点 P90 耗时</h3><p class="chart-note">从零开始，按报告中的标准节点展示；样本不足的节点不绘制。</p>'
        content += _svg_horizontal_bars(
            [(n.get("display_name", ""), n.get("p90_hours")) for n in nodes], unit="小时"
        )
        content += _html_table(
            ["节点", "平均", "P50", "P90", "样本", "覆盖率", "瓶颈"],
            [
                [
                    n.get("display_name"),
                    _metric_value(n.get("mean_hours"), "hour"),
                    _metric_value(n.get("median_hours"), "hour"),
                    _metric_value(n.get("p90_hours"), "hour"),
                    n.get("sample_size"),
                    _metric_value(n.get("coverage"), "ratio"),
                    "是" if n.get("is_bottleneck") else "否",
                ]
                for n in nodes
            ],
            dense=True,
        )
    elif section.code == "dimension_breakdown":
        groups = data.get("groups", [])
        content = (
            '<h3>分组 OTIF</h3><p class="chart-note">从零开始，分母与样本量见下方精确值表。</p>'
        )
        content += _svg_horizontal_bars(
            [
                (
                    g.get("label", ""),
                    (_metric_by_code(g.get("metrics", []), "otif_rate") or {}).get("value"),
                )
                for g in groups
            ],
            unit="",
            percentage=True,
        )
        content += _html_table(
            ["分组", "订单量", "OTIF", "P90", "异常率"],
            [
                [
                    g.get("label"),
                    g.get("order_count"),
                    _metric_value(
                        (_metric_by_code(g.get("metrics", []), "otif_rate") or {}).get("value"),
                        "ratio",
                    ),
                    _metric_value(
                        (
                            _metric_by_code(g.get("metrics", []), "fulfillment_duration_p90_hours")
                            or {}
                        ).get("value"),
                        "hour",
                    ),
                    _metric_value(
                        (_metric_by_code(g.get("metrics", []), "anomaly_order_rate") or {}).get(
                            "value"
                        ),
                        "ratio",
                    ),
                ]
                for g in groups
            ],
            dense=True,
        )
    elif section.code == "diagnostics":
        findings = []
        for item in data.get("results", []):
            findings.append(
                f'<article class="finding"><h3>{_h(item.get("title"))} <code>{_h(item.get("rule_id"))}</code></h3>'
                f"<dl><dt>数据观察事实</dt><dd>{_h(item.get('factual_observation'))}</dd><dt>规则判断</dt><dd>{_h(item.get('rule_judgement'))}</dd><dt>可能原因（未经因果验证）</dt><dd>{_h('；'.join(item.get('possible_causes', [])))}</dd><dt>建议核查</dt><dd>{_h('；'.join(item.get('recommended_checks', [])))}</dd></dl>"
                f'<p class="evidence">影响订单 {_h(item.get("affected_order_count"))} · 样本 {_h(item.get("sample_size"))} · 覆盖率 {_h(_metric_value(item.get("coverage"), "ratio"))}</p></article>'
            )
        content = "".join(findings) or '<p class="empty">当前筛选下未触发诊断规则。</p>'
    elif section.code == "order_samples":
        content = _html_table(
            ["订单标识", "状态", "仓库", "承运商", "地区", "OTIF", "时效", "异常"],
            [
                [
                    o.get("order_id"),
                    o.get("order_status"),
                    o.get("warehouse_id"),
                    o.get("carrier_id"),
                    o.get("destination_region"),
                    o.get("otif_status"),
                    _metric_value(o.get("fulfillment_duration_hours"), "hour"),
                    "；".join(o.get("anomaly_types", [])),
                ]
                for o in data.get("orders", [])
            ],
            dense=True,
        )
    elif section.code == "simulation":
        simulation = data.get("result")
        if simulation:
            content = f'<div class="scenario-warning"><strong>情景估算</strong><p>{_h(simulation.get("estimate_label"))}</p></div>'
            content += f"<p>方案：{_h(simulation.get('scenario_name'))}；影响订单：{_h(simulation.get('affected_order_count'))}。</p>"
            content += _html_table(
                ["指标", "基线", "方案", "绝对变化", "相对变化"],
                [
                    [
                        c.get("display_name"),
                        _metric_value(c.get("baseline_value"), c.get("unit")),
                        _metric_value(c.get("scenario_value"), c.get("unit")),
                        _metric_value(c.get("absolute_change"), c.get("unit")),
                        _metric_value(c.get("relative_change"), "ratio"),
                    ]
                    for c in simulation.get("comparisons", [])
                ],
            )
            content += f"<h3>参数与假设</h3><pre>{_h(json.dumps(simulation.get('parameters', {}), ensure_ascii=False, indent=2))}</pre><ul>{''.join(f'<li>{_h(item)}</li>' for item in simulation.get('assumptions', []))}</ul>"
        else:
            content = '<p class="empty">未选择可复算模拟方案，本节不生成看似精确的结果。</p>'
    elif section.code == "methods_limits":
        content = (
            "<ul>" + "".join(f"<li>{_h(item)}</li>" for item in data.get("items", [])) + "</ul>"
        )
    warnings = ""
    if section.warnings:
        warnings = (
            '<aside class="warning"><strong>本节限制</strong><ul>'
            + "".join(f"<li>{_h(item)}</li>" for item in section.warnings)
            + "</ul></aside>"
        )
    return f'<section id="{_h(section.code)}"><h2>{_h(section.title)}</h2>{narrative}{content}{warnings}</section>'


def render_html(report: ReportDocument) -> bytes:
    header = report.header
    metadata = _html_table(
        ["订单数", "有效订单", "覆盖率", "指标版本", "规则版本", "模拟版本", "报告版本"],
        [
            [
                header.order_count,
                header.valid_order_count,
                _metric_value(header.data_coverage, "ratio"),
                header.metrics_definition_version,
                header.diagnostic_rule_version,
                header.simulation_version,
                header.report_version,
            ]
        ],
    )
    executive = ""
    if "executive_summary" in [section.code for section in report.sections]:
        executive = (
            '<section id="executive-summary"><h2>Executive Summary</h2><ul class="summary">'
            + "".join(f"<li>{_h(item)}</li>" for item in report.executive_summary)
            + "</ul></section>"
        )
    reading_guide = ""
    if report.reading_guide:
        cards = "".join(
            '<article class="guide-item">'
            f"<h3>{_h(item.term)} {'<span>需结合上下文</span>' if item.requires_context else ''}</h3>"
            f"<p>{_h(item.meaning)} {_h(item.direction)}</p><p><strong>注意：</strong>{_h(item.caution)}</p>"
            "</article>"
            for item in report.reading_guide
        )
        reading_guide = f'<section id="reading-guide"><h2>快速阅读版：指标怎么读</h2><div class="guide-grid">{cards}</div></section>'
    sections = "".join(
        _html_section(section) for section in report.sections if section.code != "executive_summary"
    )
    global_warnings = ""
    if report.warnings:
        global_warnings = (
            '<aside class="warning"><strong>报告级警告</strong><ul>'
            + "".join(f"<li>{_h(item)}</li>" for item in report.warnings)
            + "</ul></aside>"
        )
    document = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>{_h(header.title)}</title>
<style>
:root{{--ink:#102a43;--muted:#52677c;--line:#cbd8e5;--panel:#f5f9fc;--primary:#1577a3;--primary-open:#d9eef7;--orange:#c56a18;--orange-open:#fff1df;--paper:#fff}}*{{box-sizing:border-box}}body{{margin:0;background:#edf3f7;color:var(--ink);font:15px/1.65 "Noto Sans CJK SC","Microsoft YaHei","PingFang SC","Source Han Sans SC",sans-serif}}main{{width:min(1020px,calc(100% - 32px));margin:28px auto;background:var(--paper);padding:52px 64px;box-shadow:0 8px 32px rgba(16,42,67,.08)}}h1{{font-size:32px;margin:0 0 8px}}h2{{font-size:23px;margin:0 0 18px;border-bottom:2px solid var(--primary-open);padding-bottom:8px}}h3{{font-size:17px;margin:20px 0 8px}}p{{margin:8px 0 14px}}.lede{{color:var(--muted);margin-bottom:22px}}section{{margin:38px 0;break-inside:avoid-page}}.summary li{{margin:8px 0;font-weight:600}}.table-wrap{{overflow-x:auto;margin:18px 0}}table{{width:100%;border-collapse:collapse}}caption{{padding:8px;text-align:left;font-weight:700}}th,td{{border:1px solid var(--line);padding:10px 12px;text-align:left;vertical-align:top}}th{{background:var(--panel)}}table.dense th,table.dense td{{padding:7px 9px;font-size:13px}}.metric-grid,.guide-grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}}.metric,.guide-item{{border:1px solid var(--line);border-radius:10px;padding:15px;background:var(--panel)}}.guide-item h3{{margin-top:0}}.guide-item h3 span{{display:inline-block;padding:2px 7px;border-radius:12px;background:var(--orange-open);color:#69360c;font-size:12px}}.metric span,.metric small{{display:block;color:var(--muted)}}.metric strong{{display:block;font-size:23px;margin:4px 0}}.finding{{border-left:4px solid var(--primary);padding:8px 18px;margin:18px 0;background:var(--panel);break-inside:avoid}}dl{{display:grid;grid-template-columns:150px 1fr;gap:7px 14px}}dt{{font-weight:700}}dd{{margin:0}}code,pre{{font-family:Consolas,"SFMono-Regular",monospace}}pre{{white-space:pre-wrap;background:var(--panel);padding:14px;border-radius:8px}}.scenario-warning,.warning{{border:2px solid var(--orange);background:var(--orange-open);padding:14px 18px;margin:16px 0;color:#69360c}}.empty{{color:var(--muted)}}.chart{{display:block;width:100%;height:auto;margin:8px 0 18px;overflow:visible}}.chart text{{font:12px "Noto Sans CJK SC","Microsoft YaHei",sans-serif;fill:var(--muted)}}.grid{{stroke:#dce6ee;stroke-width:1}}.line{{fill:none;stroke-width:3;stroke-linejoin:round;stroke-linecap:round}}.primary{{stroke:var(--primary)}}.secondary{{stroke:var(--orange)}}.dashed{{stroke-dasharray:8 5}}.bar-track{{fill:#e7eef4}}.bar{{fill:var(--primary);stroke:#0f5b7d;stroke-width:1}}.chart-note,.evidence{{color:var(--muted);font-size:13px}}footer{{border-top:1px solid var(--line);padding-top:18px;color:var(--muted);font-size:12px}}
@media(max-width:680px){{main{{width:100%;margin:0;padding:28px 18px;box-shadow:none}}h1{{font-size:26px}}dl{{grid-template-columns:1fr}}.metric-grid{{grid-template-columns:1fr}}}}
@media print{{@page{{size:A4;margin:14mm}}body{{background:#fff;font-size:10pt}}main{{width:auto;margin:0;padding:0;box-shadow:none}}h1,h2,h3{{break-after:avoid}}thead{{display:table-header-group}}tr,.metric,.finding,.warning{{break-inside:avoid}}.table-wrap{{overflow:visible}}a{{color:inherit;text-decoration:none}}}}
</style></head><body><main><header><h1>{_h(header.title)}</h1><p class="lede">数据集：{_h(header.dataset_name)} · 时间范围：{_h(header.time_range_start or "未知")} 至 {_h(header.time_range_end or "未知")} · 生成时间：{_h(header.generated_at.isoformat())} · 时区：{_h(header.timezone)}</p>{metadata}</header>{reading_guide}{executive}{global_warnings}{sections}<footer>标识策略：{_h(report.identifier_policy)}。本报告由 FulfillLens 本地生成；诊断中的可能原因未经因果验证，模拟结果不代表预测或保证。</footer></main></body></html>"""
    return document.encode("utf-8")
