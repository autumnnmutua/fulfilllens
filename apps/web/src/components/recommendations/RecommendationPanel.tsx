import {
  Alert,
  Card,
  Descriptions,
  Empty,
  Segmented,
  Space,
  Tag,
  Typography,
} from "antd";
import { useState } from "react";

import type { RecommendationBundle } from "../../types/reports";

const PRIORITY_LABEL = {
  high: "高优先级",
  medium: "中优先级",
  watch: "观察项",
};
const PRIORITY_COLOR = { high: "red", medium: "default", watch: "blue" };

export function RecommendationPanel({
  bundle,
}: {
  bundle: RecommendationBundle;
}) {
  const [view, setView] = useState<"professional" | "executive">(
    "professional",
  );
  return (
    <Card className="section-card" title="行动建议">
      <Space orientation="vertical" size="middle" className="report-stack">
        <Alert
          type="info"
          showIcon
          title="建议来自可追溯分析事实"
          description={`${bundle.privacy_note} AI 不参与 KPI、异常或优先级计算；AI 不可用时本区域仍正常展示。`}
        />
        <Segmented
          value={view}
          options={[
            { label: "专业行动方案", value: "professional" },
            { label: "管理层简报", value: "executive" },
          ]}
          onChange={(value) => setView(value as "professional" | "executive")}
        />
        {view === "professional" ? (
          bundle.professional_action_plan.map((plan) => (
            <Card
              size="small"
              key={plan.fact_id}
              title={plan.problem_diagnosis}
              extra={
                <Tag color={PRIORITY_COLOR[plan.priority]}>
                  {PRIORITY_LABEL[plan.priority]}
                </Tag>
              }
            >
              <Descriptions bordered size="small" column={1}>
                <Descriptions.Item label="数据依据">
                  {plan.data_evidence.join("；")}
                </Descriptions.Item>
                <Descriptions.Item label="根因判断">
                  {plan.root_cause_judgement}
                </Descriptions.Item>
                <Descriptions.Item label="改善动作">
                  {plan.improvement_actions.join("；")}
                </Descriptions.Item>
                <Descriptions.Item label="影响范围">
                  {plan.impact_scope}
                </Descriptions.Item>
                <Descriptions.Item label="建议 KPI">
                  {plan.suggested_kpis.join("、")}
                </Descriptions.Item>
                <Descriptions.Item label="建议目标">
                  {plan.suggested_target}
                </Descriptions.Item>
                <Descriptions.Item label="风险">{plan.risk}</Descriptions.Item>
                <Descriptions.Item label="下一步验证">
                  {plan.next_validation}
                </Descriptions.Item>
              </Descriptions>
              <Typography.Text>事实编号：{plan.fact_id}</Typography.Text>
            </Card>
          ))
        ) : bundle.executive_brief.top_priorities.length > 0 ? (
          <Card size="small" title="最值得先处理的 3 件事">
            <Typography.Paragraph strong>
              {bundle.executive_brief.overall_conclusion}
            </Typography.Paragraph>
            <ol>
              {bundle.executive_brief.top_priorities.map((item) => (
                <li key={item.fact_id}>
                  <Typography.Paragraph>
                    <strong>{item.what_happened}</strong>：{item.impact}
                    <br />
                    怎么处理：{item.action}
                    <br />
                    处理后关注：{item.monitor}
                  </Typography.Paragraph>
                </li>
              ))}
            </ol>
            <Typography.Paragraph>
              预期改善方向：{bundle.executive_brief.expected_direction}
            </Typography.Paragraph>
          </Card>
        ) : (
          <Empty description="当前没有可展示的建议" />
        )}
      </Space>
    </Card>
  );
}
