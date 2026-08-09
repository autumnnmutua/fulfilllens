import type { DashboardOverview } from "../types/dashboard";
import type {
  RecommendationBundle,
  RecommendationFact,
  RecommendationPriority,
} from "../types/reports";

function percent(value: number | null): string {
  return value === null ? "不可计算" : `${(value * 100).toFixed(1)}%`;
}

function metric(overview: DashboardOverview, code: string) {
  return overview.metrics.find((item) => item.code === code);
}

function priority(score: number): RecommendationPriority {
  return score >= 75 ? "high" : score >= 50 ? "medium" : "watch";
}

export function buildClientRecommendations(
  overview: DashboardOverview,
): RecommendationBundle {
  const facts: RecommendationFact[] = [];
  const coverage = overview.context.data_coverage;
  const missingMetrics = overview.metrics.filter((item) => item.value === null);
  if (coverage === null || coverage < 0.8 || missingMetrics.length > 0) {
    const score = coverage === null || coverage < 0.6 ? 82 : 62;
    facts.push({
      fact_id: "data:coverage",
      topic: "data_quality",
      priority: priority(score),
      priority_score: score,
      title: "先补齐分析所需数据",
      factual_observation: `数据覆盖率为 ${percent(coverage)}；不可计算指标包括：${missingMetrics.map((item) => item.display_name).join("、") || "部分订单级指标"}。`,
      evidence: [
        { label: "数据覆盖率", value: percent(coverage) },
        { label: "质量警告", value: String(overview.context.warning_count) },
      ],
      affected_order_count:
        overview.context.order_count - overview.context.valid_order_count,
      coverage,
      confidence_warning: ["数据不足时不生成 OT、IF、OTIF 等经营改善结论。"],
      recommended_action: [
        "OT 需补充订单承诺送达时间和实际交付时间。",
        "IF 需补充订购数量与实际交付数量。",
        "OTIF 只有在 OT 与 IF 均可计算时才生成。",
      ],
      suggested_kpis: ["数据覆盖率", "不可计算订单数", "质量错误行数"],
      suggested_target:
        "先把关键指标覆盖率提升到可解释水平，再设经营改善目标。",
      risk: "把不可计算订单当作成功、失败或 0% 会产生误导。",
      next_validation: "补齐关联订单表后，以相同订单范围重新导入并对账。",
    });
  }
  const addRateFact = ({
    code,
    target,
    factId,
    topic,
    title,
    action,
  }: {
    code: string;
    target: number;
    factId: string;
    topic: string;
    title: string;
    action: string;
  }) => {
    const result = metric(overview, code);
    if (
      result?.value === null ||
      result?.value === undefined ||
      result.value >= target
    ) {
      return;
    }
    const gap = target - result.value;
    const score = Math.min(
      94,
      Math.round(45 + gap * 180 + (result.coverage ?? 0) * 15),
    );
    facts.push({
      fact_id: factId,
      topic,
      priority: priority(
        result.coverage !== null && result.coverage < 0.8
          ? Math.min(score, 64)
          : score,
      ),
      priority_score:
        result.coverage !== null && result.coverage < 0.8
          ? Math.min(score, 64)
          : score,
      title,
      factual_observation: `${result.display_name}为 ${percent(result.value)}，分子/分母为 ${result.numerator}/${result.denominator}。`,
      evidence: [
        { label: result.display_name, value: percent(result.value) },
        { label: "可计算覆盖率", value: percent(result.coverage) },
        { label: "不可计算订单", value: String(result.not_computable_count) },
      ],
      affected_order_count:
        result.denominator === null
          ? null
          : Math.max(0, result.denominator - (result.numerator ?? 0)),
      coverage: result.coverage,
      confidence_warning: [
        ...result.warnings,
        ...(result.coverage !== null && result.coverage < 0.8
          ? ["该指标覆盖不足 80%，优先补齐数据后再承诺改善幅度。"]
          : []),
      ],
      recommended_action: [action],
      suggested_kpis: [result.display_name, "可计算覆盖率"],
      suggested_target: `先将${result.display_name}稳定提升至接近 ${percent(target)}；正式目标需按线路和服务等级复核。`,
      risk: "样本结构、承诺口径或覆盖率变化时，指标变化不能直接归因于单一动作。",
      next_validation: "按相同筛选与口径复算，并对比受影响订单明细和分母变化。",
    });
  };
  addRateFact({
    code: "ot_rate",
    target: 0.95,
    factId: "metric:ot",
    topic: "ot",
    title: "按时交付表现需要改善",
    action: "按承运商、地区和承诺时效分层检查晚到订单。",
  });
  addRateFact({
    code: "if_rate",
    target: 0.98,
    factId: "metric:if",
    topic: "if",
    title: "足量交付表现需要改善",
    action: "核对缺货、部分交付和数量回传证据，区分运营问题与数据问题。",
  });
  const otif = metric(overview, "otif_rate");
  if (otif?.value !== null && otif?.value !== undefined && otif.value < 0.95) {
    const gap = 0.95 - otif.value;
    const score = Math.min(
      94,
      Math.round(50 + gap * 180 + (otif.coverage ?? 0) * 12),
    );
    facts.push({
      fact_id: "metric:otif",
      topic: "otif",
      priority: priority(score),
      priority_score: score,
      title: "按时足量交付仍有改善空间",
      factual_observation: `OTIF 为 ${percent(otif.value)}，分子/分母为 ${otif.numerator}/${otif.denominator}。`,
      evidence: [
        { label: "OTIF", value: percent(otif.value) },
        { label: "可计算覆盖率", value: percent(otif.coverage) },
        { label: "不可计算订单", value: String(otif.not_computable_count) },
      ],
      affected_order_count:
        otif.denominator === null
          ? null
          : Math.max(0, otif.denominator - (otif.numerator ?? 0)),
      coverage: otif.coverage,
      confidence_warning: otif.warnings,
      recommended_action: [
        "分别核对 OT 与 IF 的失败订单，先处理贡献更高的一侧。",
      ],
      suggested_kpis: ["OTIF", "OT", "IF", "可计算覆盖率"],
      suggested_target:
        "先将 OTIF 稳定提升至接近 95%；正式目标需按线路和服务等级复核。",
      risk: "样本结构或承诺口径变化时，指标变化不能直接归因于单一动作。",
      next_validation: "按相同筛选与口径复算，并对比失败订单明细和分母变化。",
    });
  }
  const p50 = metric(overview, "fulfillment_duration_median_hours");
  const p90 = metric(overview, "fulfillment_duration_p90_hours");
  if (
    p50?.value !== null &&
    p50?.value !== undefined &&
    p90?.value !== null &&
    p90?.value !== undefined
  ) {
    const gap = p90.value - p50.value;
    if (gap > Math.max(8, p50.value * 0.35)) {
      const score = Math.min(90, Math.round(58 + Math.min(gap, 72) / 4));
      facts.push({
        fact_id: "metric:fulfillment_long_tail",
        topic: "fulfillment_long_tail",
        priority: priority(score),
        priority_score: score,
        title: "履约时长存在长尾",
        factual_observation: `P50 为 ${p50.value.toFixed(1)} 小时，P90 为 ${p90.value.toFixed(1)} 小时，长尾差为 ${gap.toFixed(1)} 小时。`,
        evidence: [
          { label: "P50", value: `${p50.value.toFixed(1)} 小时` },
          { label: "P90", value: `${p90.value.toFixed(1)} 小时` },
          { label: "长尾差值", value: `${gap.toFixed(1)} 小时` },
        ],
        affected_order_count: Math.max(
          1,
          Math.round((p90.denominator ?? 0) * 0.1),
        ),
        coverage: p90.coverage,
        confidence_warning: [...new Set([...p50.warnings, ...p90.warnings])],
        recommended_action: [
          "按承运商、地区、仓库和时间窗下钻最慢 10% 订单。",
          "对高贡献分组分别比较 P50 与 P90，避免只优化平均值。",
        ],
        suggested_kpis: ["P90 履约时长", "P50 履约时长", "P90-P50 长尾差"],
        suggested_target: "优先缩小 P90-P50 差值，同时保持 P50 不恶化。",
        risk: "业务结构不同的订单不可直接横向排名；需控制线路和服务等级。",
        next_validation:
          "对最慢 10% 订单做 cohort 对账，确认集中分组后再试点。",
      });
    }
  }
  const anomaly = metric(overview, "anomaly_order_rate");
  if (
    anomaly?.value !== null &&
    anomaly?.value !== undefined &&
    anomaly.value >= 0.05
  ) {
    const score = Math.min(92, Math.round(50 + anomaly.value * 180));
    facts.push({
      fact_id: "metric:anomaly",
      topic: "anomaly",
      priority: priority(score),
      priority_score: score,
      title: "优先核查异常订单",
      factual_observation: `异常订单率为 ${percent(anomaly.value)}，影响 ${anomaly.numerator ?? 0} / ${anomaly.denominator ?? 0} 个订单。`,
      evidence: [
        { label: "异常率", value: percent(anomaly.value) },
        {
          label: "影响订单",
          value: `${anomaly.numerator ?? 0} / ${anomaly.denominator ?? 0}`,
        },
      ],
      affected_order_count: anomaly.numerator,
      coverage: anomaly.coverage,
      confidence_warning: anomaly.warnings,
      recommended_action: [
        "按异常类型、承运商和节点下钻，先核对高贡献订单证据。",
      ],
      suggested_kpis: ["异常订单率", "受影响订单数", "重复触发率"],
      suggested_target:
        "先减少证据充分、重复出现的异常订单，不以隐藏规则触发为目标。",
      risk: "异常规则是筛查结果，不等于已确认根因或责任归属。",
      next_validation: "完成核查动作后按同一规则版本复算，并对账订单明细。",
    });
  }
  if (facts.length === 0) {
    facts.push({
      fact_id: "observe:stable",
      topic: "overall",
      priority: "watch",
      priority_score: 30,
      title: "当前未发现需要立即升级的主要问题",
      factual_observation: "现有可计算指标未形成高优先级改善触发。",
      evidence: [
        {
          label: "有效订单",
          value: String(overview.context.valid_order_count),
        },
      ],
      affected_order_count: 0,
      coverage,
      confidence_warning: [],
      recommended_action: ["保持当前口径，按固定周期复算并关注新出现的长尾。"],
      suggested_kpis: ["OTIF", "P90 履约时长", "异常率"],
      suggested_target: "保持核心指标稳定，并确保覆盖率不下降。",
      risk: "小样本或低覆盖可能掩盖局部问题。",
      next_validation: "下一周期使用相同口径复算并比较订单结构变化。",
    });
  }
  facts.sort(
    (left, right) =>
      right.priority_score - left.priority_score ||
      left.fact_id.localeCompare(right.fact_id),
  );
  const professional = facts.map((fact) => ({
    fact_id: fact.fact_id,
    priority: fact.priority,
    problem_diagnosis: fact.title,
    data_evidence: fact.evidence.map((item) => `${item.label}：${item.value}`),
    root_cause_judgement: `确定性指标支持上述数据判断；不能仅凭该结果认定经营因果。${fact.risk}`,
    improvement_actions: fact.recommended_action,
    impact_scope:
      fact.affected_order_count === null
        ? "影响范围需通过订单明细进一步确认"
        : `影响 ${fact.affected_order_count} 个订单`,
    suggested_kpis: fact.suggested_kpis,
    suggested_target: fact.suggested_target,
    risk: fact.risk,
    next_validation: fact.next_validation,
  }));
  const top = facts.slice(0, 3);
  return {
    facts,
    professional_action_plan: professional,
    executive_brief: {
      overall_conclusion: `当前共形成 ${facts.length} 项有数据依据的行动建议；高优先级 ${facts.filter((item) => item.priority === "high").length} 项。`,
      major_findings: top.map((item) => item.factual_observation),
      top_priorities: top.map((item) => ({
        fact_id: item.fact_id,
        priority: item.priority,
        what_happened: item.title,
        impact:
          item.affected_order_count === null
            ? item.factual_observation
            : `影响 ${item.affected_order_count} 个订单；${item.evidence[0]?.label ?? "证据"}为 ${item.evidence[0]?.value ?? "—"}。`,
        action: item.recommended_action[0] ?? "继续核查",
        monitor: item.suggested_kpis.slice(0, 3).join("、"),
      })),
      expected_direction:
        "优先处理高影响、高偏差且数据覆盖充分的问题，再复算同口径指标验证方向。",
      monitor_metrics: [
        ...new Set(top.flatMap((item) => item.suggested_kpis)),
      ].slice(0, 6),
    },
    definition_version: "recommendations-v1.0.0",
    ai_used: false,
    presentation_source: "deterministic_template",
    privacy_note:
      "仅使用聚合指标、诊断结果与匿名化证据生成；原始 CSV 不会因建议功能上传。",
  };
}
