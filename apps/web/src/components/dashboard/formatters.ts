import type { MetricResult } from "../../types/metrics";

export const statusLabels: Record<string, string> = {
  created: "已创建",
  confirmed: "已确认",
  processing: "处理中",
  shipped: "已发货",
  delivered: "已交付",
  cancelled: "已取消",
  returned: "已退回",
  unmapped: "未映射",
  unknown: "未知",
};

export const anomalyLabels: Record<string, string> = {
  returned_order: "退回订单",
  partial_delivery: "部分交付",
  warehouse_quality_failure: "仓库质检失败",
  tracking_exception: "物流异常事件",
};

export function metricByCode(
  metrics: MetricResult[],
  code: string,
): MetricResult | undefined {
  return metrics.find((metric) => metric.code === code);
}

export function formatPercent(value: number | null): string {
  return value === null ? "不可计算" : `${(value * 100).toFixed(1)}%`;
}

export function formatMetricValue(metric: MetricResult): string {
  if (metric.value === null) {
    return "不可计算";
  }
  if (metric.unit === "ratio") {
    return formatPercent(Number(metric.value));
  }
  if (metric.unit === "hour") {
    return `${Number(metric.value).toFixed(1)} 小时`;
  }
  return `${metric.value}`;
}

export function formatHours(value: number | null): string {
  return value === null ? "不可计算" : `${value.toFixed(1)} 小时`;
}

export function formatDateTime(value: string | null): string {
  if (value === null) {
    return "缺失";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Shanghai",
  }).format(parsed);
}
