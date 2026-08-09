import { InfoCircleOutlined } from "@ant-design/icons";
import {
  Alert,
  Card,
  Col,
  Descriptions,
  Drawer,
  Row,
  Statistic,
  Tag,
  Typography,
} from "antd";
import { useState } from "react";

import { formatMetricValue, formatPercent, metricByCode } from "./formatters";
import { metricGuidance } from "./metric-guidance";
import type { MetricResult } from "../../types/metrics";

const headlineCodes = [
  "ot_rate",
  "if_rate",
  "otif_rate",
  "fulfillment_duration_mean_hours",
  "fulfillment_duration_median_hours",
  "fulfillment_duration_p90_hours",
  "anomaly_order_rate",
];

interface DashboardMetricCardsProps {
  metrics: MetricResult[];
}

export function DashboardMetricCards({ metrics }: DashboardMetricCardsProps) {
  const [selected, setSelected] = useState<MetricResult | null>(null);
  const selectedGuidance = selected ? metricGuidance(selected.code) : undefined;
  return (
    <>
      <Row gutter={[14, 14]} className="metrics-grid" aria-label="核心履约指标">
        {headlineCodes
          .map((code) => metricByCode(metrics, code))
          .filter((metric): metric is MetricResult => metric !== undefined)
          .map((metric) => {
            const guidance = metricGuidance(metric.code);
            return (
              <Col xs={12} md={8} xl={6} xxl={3} key={metric.code}>
                <Card
                  className="metric-card dashboard-metric-card"
                  size="small"
                >
                  <button
                    type="button"
                    className="metric-card-button"
                    aria-label={`查看${metric.display_name}定义`}
                    onClick={() => setSelected(metric)}
                  >
                    <Statistic
                      title={metric.display_name}
                      value={formatMetricValue(metric)}
                    />
                    <span className="metric-card-evidence">
                      覆盖 {formatPercent(metric.coverage)} ·{" "}
                      {metric.computable_count} 个可计算
                    </span>
                    {guidance ? (
                      <span className="metric-card-guidance">
                        {guidance.direction}
                        {guidance.requiresContext ? " · 需结合覆盖率/样本" : ""}
                      </span>
                    ) : null}
                    <InfoCircleOutlined aria-hidden />
                  </button>
                </Card>
              </Col>
            );
          })}
      </Row>
      <Drawer
        title={selected?.display_name ?? "指标定义"}
        open={selected !== null}
        size="large"
        onClose={() => setSelected(null)}
      >
        {selected !== null ? (
          <>
            {selectedGuidance ? (
              <Alert
                type={selectedGuidance.requiresContext ? "warning" : "info"}
                showIcon
                message={selectedGuidance.direction}
                description={`${selectedGuidance.explanation} 注意：${selectedGuidance.caution}`}
              />
            ) : null}
            <Typography.Paragraph>
              此结果由当前数据上下文的统一指标引擎计算，展示层未临时改写公式。分母只包含符合该指标口径且可计算的订单。
            </Typography.Paragraph>
            <Descriptions
              bordered
              size="small"
              column={1}
              items={[
                {
                  key: "value",
                  label: "当前值",
                  children: formatMetricValue(selected),
                },
                {
                  key: "fraction",
                  label: "分子 / 分母",
                  children: `${selected.numerator ?? "不适用"} / ${selected.denominator ?? "不适用"}`,
                },
                {
                  key: "coverage",
                  label: "数据覆盖率",
                  children: formatPercent(selected.coverage),
                },
                {
                  key: "eligible",
                  label: "应参与订单",
                  children: selected.eligible_count,
                },
                {
                  key: "not-computable",
                  label: "不可计算",
                  children: selected.not_computable_count,
                },
                {
                  key: "pending",
                  label: "待完成",
                  children: selected.pending_count,
                },
                {
                  key: "version",
                  label: "口径版本",
                  children: <Tag>{selected.definition_version}</Tag>,
                },
              ]}
            />
            {selected.warnings.map((warning) => (
              <Typography.Paragraph type="warning" key={warning}>
                {warning}
              </Typography.Paragraph>
            ))}
          </>
        ) : null}
      </Drawer>
    </>
  );
}
