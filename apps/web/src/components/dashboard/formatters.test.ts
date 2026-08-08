import { describe, expect, it } from "vitest";

import { formatMetricValue, formatPercent, metricByCode } from "./formatters";
import type { MetricResult } from "../../types/metrics";

const metric: MetricResult = {
  code: "otif_rate",
  display_name: "OTIF",
  value: 0.75,
  unit: "ratio",
  numerator: 3,
  denominator: 4,
  coverage: 0.8,
  eligible_count: 5,
  computable_count: 4,
  pending_count: 0,
  not_computable_count: 1,
  definition_version: "metrics-v1.1.0",
  warnings: [],
};

describe("仪表盘格式化", () => {
  it("比例以一位小数展示且不把缺失显示成 0", () => {
    expect(formatPercent(0.756)).toBe("75.6%");
    expect(formatPercent(null)).toBe("不可计算");
    expect(formatMetricValue(metric)).toBe("75.0%");
    expect(formatMetricValue({ ...metric, value: null })).toBe("不可计算");
  });

  it("按代码读取后端指标，不在前端重算", () => {
    expect(metricByCode([metric], "otif_rate")).toBe(metric);
    expect(metricByCode([metric], "ot_rate")).toBeUndefined();
  });
});
