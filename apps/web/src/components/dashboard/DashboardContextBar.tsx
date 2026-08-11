import { Descriptions, Tag, Typography } from "antd";

import { formatDateTime, formatPercent } from "./formatters";
import type { DashboardContext } from "../../types/dashboard";

interface DashboardContextBarProps {
  context: DashboardContext;
}

export function DashboardContextBar({ context }: DashboardContextBarProps) {
  const timeRange =
    context.time_range_start && context.time_range_end
      ? `${context.time_range_start} 至 ${context.time_range_end}`
      : "当前筛选无有效下单时间";
  return (
    <section className="dashboard-context" aria-label="当前分析数据上下文">
      <Typography.Title level={2}>当前分析上下文</Typography.Title>
      <Descriptions
        size="small"
        column={{ xs: 1, sm: 2, md: 3, lg: 4, xl: 7 }}
        items={[
          {
            key: "dataset",
            label: "当前数据集",
            children: context.dataset_label,
          },
          {
            key: "fingerprint",
            label: "分析指纹",
            children: context.analysis_fingerprint ? (
              <Typography.Text code title={context.analysis_fingerprint}>
                {context.analysis_fingerprint.slice(0, 20)}…
              </Typography.Text>
            ) : (
              "服务端数据集"
            ),
          },
          {
            key: "source",
            label: "数据来源",
            children:
              context.analysis_source === "user_import"
                ? "用户本地导入"
                : context.analysis_source === "compatibility_sample"
                  ? "兼容性示例"
                  : context.analysis_source === "teaching_data"
                    ? "教学案例"
                    : "服务端数据集",
          },
          { key: "range", label: "时间范围", children: timeRange },
          {
            key: "orders",
            label: "订单数",
            children:
              context.order_count === context.unfiltered_order_count
                ? context.order_count
                : `${context.order_count} / 全部 ${context.unfiltered_order_count}`,
          },
          {
            key: "valid",
            label: "有效订单",
            children: context.valid_order_count,
          },
          {
            key: "coverage",
            label: "数据覆盖率",
            children: formatPercent(context.data_coverage),
          },
          {
            key: "analyzed",
            label: "最后分析时间",
            children: formatDateTime(context.last_analyzed_at),
          },
          {
            key: "warnings",
            label: "数据警告",
            children: (
              <Tag color={context.warning_count > 0 ? "warning" : "success"}>
                {context.warning_count} 条
              </Tag>
            ),
          },
          ...(context.linkage
            ? [
                {
                  key: "linkage",
                  label: "跨表关联",
                  children: `${context.linkage.linked_order_count} 个订单已关联；${context.linkage.orphan_event_count} 条孤立事件`,
                },
              ]
            : []),
        ]}
      />
    </section>
  );
}
