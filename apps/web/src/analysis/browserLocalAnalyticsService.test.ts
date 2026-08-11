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
    const mean = overview.metrics.find(
      (metric) => metric.code === "fulfillment_duration_mean_hours",
    );
    const p50 = overview.metrics.find(
      (metric) => metric.code === "fulfillment_duration_median_hours",
    );
    const p90 = overview.metrics.find(
      (metric) => metric.code === "fulfillment_duration_p90_hours",
    );
    expect(mean).toMatchObject({ display_name: "平均首末轨迹时效", value: 28 });
    expect(p50).toMatchObject({ display_name: "P50 首末轨迹时效", value: 28 });
    expect(p90).toMatchObject({ display_name: "P90 首末轨迹时效", value: 28 });
    expect(mean?.warnings.join(" ")).toContain(
      "不等于订单创建至交付的完整履约时长",
    );
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
    expect(diagnostic.context.analysis_fingerprint).toBe(
      overview.context.analysis_fingerprint,
    );

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
    expect(report.header.analysis_fingerprint).toBe(
      overview.context.analysis_fingerprint,
    );
    expect(report.recommendations.facts.map((fact) => fact.fact_id)).toEqual(
      bundle.facts.map((fact) => fact.fact_id),
    );
    expect(report.recommendations.ai_used).toBe(false);
  });

  it("不同输入与内容变异会改变分析指纹、时效、诊断和建议", async () => {
    const saveTracking = async (
      datasetId: string,
      secondEnd: string,
      carrier: string,
      status: string,
      eventCode: string,
    ) => {
      await saveBrowserDataset({
        createdAt: "2026-08-10T00:00:00.000Z",
        dataType: "tracking_events",
        datasetId,
        fileName: `${datasetId}.csv`,
        qualityReport: qualityReport(),
        rows: [
          {
            tracking_event_id: `${datasetId}-1`,
            order_id: "ORD-001",
            shipment_id: "SHP-001",
            event_time: "2026-08-01T08:00:00+08:00",
            raw_status: "已揽收",
            event_code: "carrier_picked_up",
            carrier_id: carrier,
            location_code: "HUB-A",
          },
          {
            tracking_event_id: `${datasetId}-2`,
            order_id: "ORD-001",
            shipment_id: "SHP-001",
            event_time: secondEnd,
            raw_status: status,
            event_code: eventCode,
            carrier_id: carrier,
            location_code: "SITE-A",
          },
        ],
        sourceKind: "browser_local_import",
      });
    };
    await saveTracking(
      "browser-local-mutation-a",
      "2026-08-02T08:00:00+08:00",
      "CAR-A",
      "已签收",
      "delivered",
    );
    await saveTracking(
      "browser-local-mutation-b",
      "2026-08-03T08:00:00+08:00",
      "CAR-B",
      "派送失败",
      "delivery_failed",
    );
    const filters = {
      start_date: null,
      end_date: null,
      warehouses: [],
      carriers: [],
      regions: [],
      statuses: [],
      anomaly_types: [],
      timezone: "Asia/Shanghai",
    };
    const view = {
      grain: "date" as const,
      dimension: "carrier_id" as const,
      breakdownSortBy: "anomaly_order_rate" as const,
      breakdownSortDirection: "desc" as const,
    };
    const overviewA = await browserLocalAnalyticsService.overview(
      {
        orders_dataset_id: "browser-local-derived-orders",
        warehouse_events_dataset_id: null,
        tracking_events_dataset_id: "browser-local-mutation-a",
      },
      filters,
      view,
    );
    const overviewB = await browserLocalAnalyticsService.overview(
      {
        orders_dataset_id: "browser-local-derived-orders",
        warehouse_events_dataset_id: null,
        tracking_events_dataset_id: "browser-local-mutation-b",
      },
      filters,
      view,
    );
    expect(overviewA.context.analysis_fingerprint).not.toBe(
      overviewB.context.analysis_fingerprint,
    );
    expect(overviewA.distribution.mean).toBe(24);
    expect(overviewB.distribution.mean).toBe(48);
    expect(overviewA.breakdown.groups[0]?.key).toBe("CAR-A");
    expect(overviewB.breakdown.groups[0]?.key).toBe("CAR-B");
    const recommendationsA = buildClientRecommendations(overviewA);
    const recommendationsB = buildClientRecommendations(overviewB);
    expect(recommendationsA.facts).not.toEqual(recommendationsB.facts);
  });

  it("仅有运单、时间和状态仍计算时效，缺订单、承运商或地点只关闭对应能力", async () => {
    const datasetId = "browser-local-partial-tracking";
    await saveBrowserDataset({
      createdAt: "2026-08-10T00:00:00.000Z",
      dataType: "tracking_events",
      datasetId,
      fileName: "partial.csv",
      qualityReport: qualityReport(),
      rows: [
        {
          tracking_event_id: "P-1",
          shipment_id: "SHP-P",
          event_time: "2026-08-01T08:00:00+08:00",
          raw_status: "未知自定义状态",
          event_code: "unmapped",
        },
        {
          tracking_event_id: "P-2",
          shipment_id: "SHP-P",
          event_time: "2026-08-02T08:00:00+08:00",
          raw_status: "已签收",
          event_code: "delivered",
        },
      ],
      sourceKind: "browser_local_import",
    });
    const overview = await browserLocalAnalyticsService.overview(
      {
        orders_dataset_id: "browser-local-derived-orders",
        warehouse_events_dataset_id: null,
        tracking_events_dataset_id: datasetId,
      },
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
    expect(overview.distribution.mean).toBe(24);
    expect(
      overview.context.capabilities?.find((item) => item.code === "carrier")
        ?.available,
    ).toBe(false);
    expect(
      overview.context.capabilities?.find((item) => item.code === "location")
        ?.available,
    ).toBe(false);
    for (const code of ["ot_rate", "if_rate", "otif_rate"]) {
      expect(
        overview.metrics.find((item) => item.code === code)?.value,
      ).toBeNull();
    }
    expect(
      overview.metrics.find((item) => item.code === "anomaly_order_rate")
        ?.value,
    ).toBe(0);
  });

  it("轨迹首末时效包含取消和退回路径，未知状态只计数据质量而非经营异常", async () => {
    const datasetId = "browser-local-return-span";
    await saveBrowserDataset({
      createdAt: "2026-08-10T00:00:00.000Z",
      dataType: "tracking_events",
      datasetId,
      fileName: "return-span.csv",
      qualityReport: qualityReport(),
      rows: [
        {
          tracking_event_id: "R-1",
          order_id: "ORD-R",
          shipment_id: "SHP-R",
          event_time: "2026-08-01T08:00:00+08:00",
          raw_status: "自定义揽收",
          event_code: "unmapped",
        },
        {
          tracking_event_id: "R-2",
          order_id: "ORD-R",
          shipment_id: "SHP-R",
          event_time: "2026-08-04T08:00:00+08:00",
          raw_status: "退回完成",
          event_code: "returned",
        },
        {
          tracking_event_id: "D-1",
          order_id: "ORD-D",
          shipment_id: "SHP-D",
          event_time: "2026-08-01T08:00:00+08:00",
          raw_status: "已揽收",
          event_code: "carrier_picked_up",
        },
        {
          tracking_event_id: "D-2",
          order_id: "ORD-D",
          shipment_id: "SHP-D",
          event_time: "2026-08-02T08:00:00+08:00",
          raw_status: "已签收",
          event_code: "delivered",
        },
      ],
      sourceKind: "browser_local_import",
    });
    const overview = await browserLocalAnalyticsService.overview(
      {
        orders_dataset_id: "browser-local-derived-orders",
        warehouse_events_dataset_id: null,
        tracking_events_dataset_id: datasetId,
      },
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
    expect(overview.distribution).toMatchObject({
      mean: 48,
      median: 48,
      p90: 67.2,
      sample_size: 2,
    });
    expect(overview.context.time_range_start).toBe("2026-08-01");
    expect(overview.context.time_range_end).toBe("2026-08-04");
  });
});
