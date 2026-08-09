import { describe, expect, it } from "vitest";

import { browserLocalAnalyticsService } from "./browserLocalAnalyticsService";
import { buildClientRecommendations } from "./recommendations";
import { browserLocalDiagnosticsService } from "./browserLocalDiagnosticsService";
import { browserLocalReportsService } from "./browserLocalReportsService";
import { saveBrowserDataset } from "../imports/browserDatasetStore";

function qualityReport() {
  return {
    total_rows: 2,
    valid_rows: 2,
    error_rows: 0,
    warning_rows: 0,
    null_counts: {},
    duplicate_keys: 0,
    invalid_times: 0,
    time_order_conflicts: 0,
    negative_quantities: 0,
    unknown_statuses: 0,
    long_text_values: 0,
    unparseable_values: 0,
    exact_duplicate_rows: 0,
    ignored_source_columns: ["客户备注"],
    unresolved_source_columns: [],
    field_resolutions: [
      {
        source_column: "客户备注",
        target_field: null,
        status: "ignored" as const,
        reason: "用户明确忽略",
      },
    ],
    sensitive_risks: [],
    status_normalizations: [],
    issues: [],
    can_confirm: true,
  };
}

describe("浏览器本地分析", () => {
  it("只有轨迹事件时不伪造 OT/IF/OTIF，并从同一事实生成两种建议视图", async () => {
    const datasetId = "browser-local-tracking-analysis-test";
    await saveBrowserDataset({
      createdAt: "2026-08-10T00:00:00.000Z",
      dataType: "tracking_events",
      datasetId,
      fileName: "synthetic-nonstandard-tracking.csv",
      qualityReport: qualityReport(),
      rows: [
        {
          tracking_event_id: "TRE-1",
          order_id: "ORD-001",
          shipment_id: "SHP-001",
          event_time: "2026-08-01T08:00:00+08:00",
          raw_status: "已揽收",
          event_code: "carrier_picked_up",
          carrier_id: "CAR-A",
          location_code: "HUB-A",
        },
        {
          tracking_event_id: "TRE-2",
          order_id: "ORD-001",
          shipment_id: "SHP-001",
          event_time: "2026-08-02T12:00:00+08:00",
          raw_status: "收件人已签收",
          event_code: "delivered",
          carrier_id: "CAR-A",
          location_code: "SITE-A",
        },
      ],
      sourceKind: "browser_local_import",
    });
    const selection = {
      orders_dataset_id: "browser-local-derived-orders",
      warehouse_events_dataset_id: null,
      tracking_events_dataset_id: datasetId,
    };
    const overview = await browserLocalAnalyticsService.overview(
      selection,
      {
        start_date: null,
        end_date: null,
        warehouses: [],
        carriers: [],
        regions: [],
        statuses: [],
        anomaly_types: [],
        timezone: "Asia/Shanghai",
      },
      {
        grain: "date",
        dimension: "carrier_id",
        breakdownSortBy: "anomaly_order_rate",
        breakdownSortDirection: "desc",
      },
    );
    expect(overview.context.order_count).toBe(1);
    for (const code of ["ot_rate", "if_rate", "otif_rate"]) {
      const item = overview.metrics.find((metric) => metric.code === code);
      expect(item?.value).toBeNull();
      expect(item?.denominator).toBeNull();
      expect(item?.warnings.join(" ")).toContain("数据不足");
    }
    const bundle = buildClientRecommendations(overview);
    expect(bundle.facts.some((fact) => fact.fact_id === "data:coverage")).toBe(
      true,
    );
    expect(bundle.facts.some((fact) => fact.fact_id === "metric:otif")).toBe(
      false,
    );
    const factIds = new Set(bundle.facts.map((fact) => fact.fact_id));
    expect(
      bundle.professional_action_plan.every((item) =>
        factIds.has(item.fact_id),
      ),
    ).toBe(true);
    expect(
      bundle.executive_brief.top_priorities.every((item) =>
        factIds.has(item.fact_id),
      ),
    ).toBe(true);
    expect(bundle.ai_used).toBe(false);

    const diagnostic = await browserLocalDiagnosticsService.analyze({
      datasets: selection,
      timezone: "Asia/Shanghai",
      rule_overrides: {},
      max_evidence_per_result: 20,
    });
    expect(diagnostic.analysis_warnings.join(" ")).toContain("只有事件数据");

    const report = await browserLocalReportsService.preview({
      datasets: selection,
      dataset_name: "浏览器本地轨迹验收",
      filters: overview.active_filters,
      trend_grain: "date",
      breakdown_dimension: "carrier_id",
      sections: ["metrics_overview", "recommendations", "diagnostics"],
      order_sample_limit: 20,
      include_order_identifiers: false,
      sensitive_export_confirmed: false,
      reading_mode: "guided",
      simulation: null,
    });
    expect(report.header.synthetic_data).toBe(false);
    expect(report.recommendations.facts.map((fact) => fact.fact_id)).toEqual(
      bundle.facts.map((fact) => fact.fact_id),
    );
    expect(report.recommendations.ai_used).toBe(false);
  });
});
