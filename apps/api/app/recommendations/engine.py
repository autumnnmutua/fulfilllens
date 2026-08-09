from __future__ import annotations

from app.dashboard.models import DashboardOverviewResponse
from app.diagnostics.models import DiagnosticAnalysisResponse, DiagnosticResult
from app.metrics.models import MetricResult
from app.recommendations.models import (
    ExecutiveBrief,
    ExecutivePriorityItem,
    ProfessionalActionPlanItem,
    RecommendationBundle,
    RecommendationEvidence,
    RecommendationFact,
    RecommendationPriority,
)

PRIORITY_ORDER: dict[RecommendationPriority, int] = {"high": 0, "medium": 1, "watch": 2}
SEVERITY_SCORE = {"critical": 95, "high": 82, "medium": 62, "low": 42}


def _metric(overview: DashboardOverviewResponse, code: str) -> MetricResult | None:
    return next((item for item in overview.metrics if item.code == code), None)


def _ratio(value: float | int | None) -> str:
    return "不可计算" if value is None else f"{float(value) * 100:.1f}%"


def _hours(value: float | int | None) -> str:
    return "不可计算" if value is None else f"{float(value):.1f} 小时"


def _priority(score: int) -> RecommendationPriority:
    if score >= 75:
        return "high"
    if score >= 50:
        return "medium"
    return "watch"


def _metric_fact(
    metric: MetricResult,
    *,
    target: float,
    fact_id: str,
    topic: str,
    title: str,
    action: list[str],
) -> RecommendationFact | None:
    if metric.value is None:
        return None
    gap = max(0.0, target - float(metric.value))
    if gap <= 0.01:
        return None
    coverage = metric.coverage
    score = min(100, round(45 + gap * 180 + (coverage or 0) * 15))
    warnings = list(metric.warnings)
    if coverage is None or coverage < 0.8:
        warnings.append("该指标覆盖不足 80%，优先补齐数据后再承诺改善幅度。")
        score = min(score, 64)
    return RecommendationFact(
        fact_id=fact_id,
        topic=topic,
        priority=_priority(score),
        priority_score=score,
        title=title,
        factual_observation=(
            f"{metric.display_name}为 {_ratio(metric.value)}，"
            f"分子/分母为 {metric.numerator}/{metric.denominator}。"
        ),
        evidence=[
            RecommendationEvidence(label=metric.display_name, value=_ratio(metric.value)),
            RecommendationEvidence(label="可计算覆盖率", value=_ratio(metric.coverage)),
            RecommendationEvidence(label="不可计算订单", value=str(metric.not_computable_count)),
        ],
        affected_order_count=(
            int(metric.denominator - int(metric.numerator or 0))
            if metric.denominator is not None
            else None
        ),
        coverage=coverage,
        confidence_warning=list(dict.fromkeys(warnings)),
        recommended_action=action,
        suggested_kpis=[metric.display_name, "可计算覆盖率"],
        suggested_target=(
            f"先将{metric.display_name}稳定提升至接近 {_ratio(target)}；"
            "正式目标应按线路、渠道和服务等级复核。"
        ),
        risk="若样本结构、承诺口径或覆盖率同时变化，指标改善不能直接归因于单一动作。",
        next_validation="按相同筛选与口径复算，并对比受影响订单明细和分母变化。",
    )


def _diagnostic_fact(
    result: DiagnosticResult,
    *,
    order_count: int,
) -> RecommendationFact:
    base = SEVERITY_SCORE[result.severity]
    impact_share = result.affected_order_count / max(order_count, 1)
    score = min(100, round(base * 0.65 + impact_share * 25 + (result.coverage or 0) * 10))
    if result.coverage is None or result.coverage < 0.6:
        score = min(score, 64)
    evidence = [
        RecommendationEvidence(
            label="影响订单",
            value=f"{result.affected_order_count} / {order_count}",
        ),
        RecommendationEvidence(label="规则覆盖率", value=_ratio(result.coverage)),
        RecommendationEvidence(label="样本量", value=str(result.sample_size)),
    ]
    if result.evidence:
        first = result.evidence[0]
        if first.observed_value is not None:
            unit = "小时" if first.unit == "hour" else first.unit or ""
            evidence.append(
                RecommendationEvidence(
                    label="证据样例",
                    value=f"{first.observed_value:.2f} {unit}".strip(),
                )
            )
    return RecommendationFact(
        fact_id=f"diagnostic:{result.rule_id}:{result.dimension_value or 'all'}",
        topic=result.category,
        priority=_priority(score),
        priority_score=score,
        title=result.title,
        factual_observation=result.factual_observation,
        evidence=evidence,
        affected_order_count=result.affected_order_count,
        coverage=result.coverage,
        confidence_warning=result.confidence_warning,
        recommended_action=result.recommended_checks,
        suggested_kpis=["受影响订单数", "规则覆盖率", "同类规则再次触发率"],
        suggested_target="先减少高置信度规则覆盖的受影响订单；具体数值目标需用同口径基线确认。",
        risk="规则判断用于筛查而非责任认定；可能原因尚未经过因果验证。",
        next_validation=("复核订单级证据，并在相同时间窗、线路和服务等级下重新运行该规则。"),
    )


def _long_tail_fact(overview: DashboardOverviewResponse) -> RecommendationFact | None:
    p50 = _metric(overview, "fulfillment_duration_median_hours")
    p90 = _metric(overview, "fulfillment_duration_p90_hours")
    if p50 is None or p90 is None or p50.value is None or p90.value is None:
        return None
    gap = float(p90.value) - float(p50.value)
    if gap <= max(8.0, float(p50.value) * 0.35):
        return None
    coverage = (
        min(value for value in (p50.coverage, p90.coverage) if value is not None)
        if p50.coverage is not None or p90.coverage is not None
        else None
    )
    score = min(90, round(55 + min(gap, 72) / 4 + (coverage or 0) * 10))
    return RecommendationFact(
        fact_id="metric:fulfillment_long_tail",
        topic="fulfillment_long_tail",
        priority=_priority(score),
        priority_score=score,
        title="履约时长存在长尾",
        factual_observation=(
            f"P50 为 {_hours(p50.value)}，P90 为 {_hours(p90.value)}，"
            f"最慢约 10% 订单与典型订单的时长差为 {gap:.1f} 小时。"
        ),
        evidence=[
            RecommendationEvidence(label="P50", value=_hours(p50.value)),
            RecommendationEvidence(label="P90", value=_hours(p90.value)),
            RecommendationEvidence(label="长尾差值", value=f"{gap:.1f} 小时"),
        ],
        affected_order_count=max(1, round((p90.denominator or 0) * 0.1)),
        coverage=coverage,
        confidence_warning=list(dict.fromkeys([*p50.warnings, *p90.warnings])),
        recommended_action=[
            "按承运商、地区、仓库和时间窗下钻最慢 10% 订单。",
            "对高贡献分组分别比较 P50 与 P90，避免只优化平均值。",
        ],
        suggested_kpis=["P90 履约时长", "P50 履约时长", "P90-P50 长尾差"],
        suggested_target="优先缩小 P90-P50 差值，同时保持 P50 不恶化。",
        risk="业务结构不同的订单不可直接横向排名；需控制线路和服务等级。",
        next_validation="对最慢 10% 订单做 cohort 对账，确认长尾集中分组后再试点。",
    )


def _data_coverage_fact(overview: DashboardOverviewResponse) -> RecommendationFact | None:
    coverage = overview.context.data_coverage
    missing_metrics = [metric.display_name for metric in overview.metrics if metric.value is None]
    if coverage is not None and coverage >= 0.8 and not missing_metrics:
        return None
    score = 82 if coverage is None or coverage < 0.6 else 62
    missing_text = "、".join(missing_metrics) if missing_metrics else "部分订单级指标"
    return RecommendationFact(
        fact_id="data:coverage",
        topic="data_quality",
        priority=_priority(score),
        priority_score=score,
        title="先补齐分析所需数据",
        factual_observation=(
            f"当前整体数据覆盖率为 {_ratio(coverage)}；不可计算指标包括：{missing_text}。"
        ),
        evidence=[
            RecommendationEvidence(label="数据覆盖率", value=_ratio(coverage)),
            RecommendationEvidence(label="质量警告", value=str(overview.context.warning_count)),
        ],
        affected_order_count=(overview.context.order_count - overview.context.valid_order_count),
        coverage=coverage,
        confidence_warning=["数据不足时不生成 OT、IF、OTIF 等经营改善结论。"],
        recommended_action=[
            "OT 需补充订单承诺送达时间和实际送达时间。",
            "IF 需补充订购数量与实际交付数量。",
            "OTIF 只有在 OT 与 IF 均可计算时才生成。",
        ],
        suggested_kpis=["数据覆盖率", "不可计算订单数", "质量错误行数"],
        suggested_target="先把关键指标覆盖率提升到可解释水平，再设经营改善目标。",
        risk="把不可计算订单当作成功、失败或 0% 会产生误导。",
        next_validation="补齐关联订单表后使用相同订单范围重新导入并对账。",
    )


def build_recommendations(
    overview: DashboardOverviewResponse,
    diagnostic: DiagnosticAnalysisResponse | None,
) -> RecommendationBundle:
    facts: list[RecommendationFact] = []
    coverage_fact = _data_coverage_fact(overview)
    if coverage_fact is not None:
        facts.append(coverage_fact)

    for metric, target, fact_id, topic, title, action in (
        (
            _metric(overview, "otif_rate"),
            0.95,
            "metric:otif",
            "otif",
            "按时足量交付仍有改善空间",
            ["分别核对 OT 与 IF 的失败订单，先处理贡献更高的一侧。"],
        ),
        (
            _metric(overview, "ot_rate"),
            0.95,
            "metric:ot",
            "ot",
            "按时交付表现需要改善",
            ["按承运商、地区和承诺时效分层检查晚到订单。"],
        ),
        (
            _metric(overview, "if_rate"),
            0.98,
            "metric:if",
            "if",
            "足量交付表现需要改善",
            ["核对缺货、部分交付和数量回传的订单证据，区分运营问题与数据问题。"],
        ),
    ):
        if metric is not None:
            fact = _metric_fact(
                metric,
                target=target,
                fact_id=fact_id,
                topic=topic,
                title=title,
                action=action,
            )
            if fact is not None:
                facts.append(fact)

    long_tail = _long_tail_fact(overview)
    if long_tail is not None:
        facts.append(long_tail)

    if diagnostic is not None:
        facts.extend(
            _diagnostic_fact(result, order_count=diagnostic.context.order_count)
            for result in diagnostic.results[:5]
        )

    if not facts:
        facts.append(
            RecommendationFact(
                fact_id="observe:stable",
                topic="overall",
                priority="watch",
                priority_score=30,
                title="当前未发现需要立即升级的主要问题",
                factual_observation="现有可计算指标和已启用规则未形成高优先级改善触发。",
                evidence=[
                    RecommendationEvidence(
                        label="有效订单", value=str(overview.context.valid_order_count)
                    )
                ],
                affected_order_count=0,
                coverage=overview.context.data_coverage,
                recommended_action=["保持当前口径，按固定周期复算并关注新出现的长尾。"],
                suggested_kpis=["OTIF", "P90 履约时长", "异常率"],
                suggested_target="保持核心指标稳定，并确保覆盖率不下降。",
                risk="小样本或低覆盖可能掩盖局部问题。",
                next_validation="下一周期使用相同口径复算并比较订单结构变化。",
            )
        )

    facts.sort(key=lambda item: (PRIORITY_ORDER[item.priority], -item.priority_score, item.fact_id))
    professional = [
        ProfessionalActionPlanItem(
            fact_id=fact.fact_id,
            priority=fact.priority,
            problem_diagnosis=fact.title,
            data_evidence=[f"{item.label}：{item.value}" for item in fact.evidence],
            root_cause_judgement=(
                f"确定性规则支持上述数据判断；不能仅凭该结果认定经营因果。{fact.risk}"
            ),
            improvement_actions=fact.recommended_action,
            impact_scope=(
                f"影响 {fact.affected_order_count} 个订单"
                if fact.affected_order_count is not None
                else "影响范围需通过订单明细进一步确认"
            ),
            suggested_kpis=fact.suggested_kpis,
            suggested_target=fact.suggested_target,
            risk=fact.risk,
            next_validation=fact.next_validation,
        )
        for fact in facts
    ]
    top = facts[:3]
    executive = ExecutiveBrief(
        overall_conclusion=(
            f"当前共形成 {len(facts)} 项有数据依据的行动建议；"
            f"其中高优先级 {sum(item.priority == 'high' for item in facts)} 项。"
        ),
        major_findings=[item.factual_observation for item in top],
        top_priorities=[
            ExecutivePriorityItem(
                fact_id=item.fact_id,
                priority=item.priority,
                what_happened=item.title,
                impact=(
                    f"影响 {item.affected_order_count} 个订单；{item.evidence[0].label}"
                    f"为 {item.evidence[0].value}。"
                    if item.affected_order_count is not None
                    else item.factual_observation
                ),
                action=item.recommended_action[0],
                monitor="、".join(item.suggested_kpis[:3]),
            )
            for item in top
        ],
        expected_direction="优先处理高影响、高偏差且数据覆盖充分的问题，再复算同口径指标验证方向。",
        monitor_metrics=list(dict.fromkeys(kpi for item in top for kpi in item.suggested_kpis))[:6],
    )
    return RecommendationBundle(
        facts=facts,
        professional_action_plan=professional,
        executive_brief=executive,
    )
