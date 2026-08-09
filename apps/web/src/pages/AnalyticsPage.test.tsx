import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../app/App";

vi.mock("../components/EChart", () => ({
  EChart: ({ ariaLabel }: { ariaLabel: string }) => (
    <div role="img" aria-label={ariaLabel} />
  ),
}));

const datasetId = "11111111-1111-4111-8111-111111111111";

function metric(
  code: string,
  displayName: string,
  value: number | null,
  unit: "order" | "ratio" | "hour" = "ratio",
) {
  return {
    code,
    display_name: displayName,
    value,
    unit,
    numerator: value,
    denominator: 8,
    coverage: 1,
    eligible_count: 8,
    computable_count: 8,
    pending_count: 0,
    not_computable_count: 0,
    definition_version: "metrics-v1.1.0",
    warnings: [],
  };
}

const metrics = [
  metric("order_count", "订单总数", 8, "order"),
  metric("valid_order_count", "有效订单数", 8, "order"),
  metric("ot_rate", "按时交付率（OT）", 0.8),
  metric("if_rate", "足量交付率（IF）", 0.75),
  metric("otif_rate", "按时足量交付率（OTIF）", 0.625),
  metric("fulfillment_duration_mean_hours", "平均履约时长", 48, "hour"),
  metric("fulfillment_duration_median_hours", "中位履约时长", 46, "hour"),
  metric("fulfillment_duration_p90_hours", "P90 履约时长", 70, "hour"),
  metric("anomaly_order_rate", "异常订单率", 0.25),
  metric("data_coverage_rate", "数据覆盖率", 1),
];

const decision = {
  status: "false",
  value: false,
  reason: "未同时满足按时和足量。",
};
const order = {
  order_id: "ORD-SYN-ANOMALY-001",
  order_status: "delivered",
  created_at: "2026-07-01T08:00:00+08:00",
  promised_delivery_time: "2026-07-03T18:00:00+08:00",
  actual_delivery_time: "2026-07-04T10:00:00+08:00",
  ordered_quantity: 2,
  delivered_quantity: 2,
  quantity_unit: "piece",
  warehouse_id: "WH-A",
  carrier_id: "CAR-B",
  destination_region: "CN-SH",
  sales_channel: "synthetic",
  ot: decision,
  in_full: { status: "true", value: true, reason: "足量。" },
  otif: decision,
  fulfillment_duration_hours: 74,
  anomaly: true,
  anomaly_reasons: ["物流事件命中：exception。"],
  anomaly_types: ["tracking_exception"],
  node_durations: [
    {
      interval_code: "carrier_transit",
      display_name: "承运运输",
      duration_hours: 58,
      start_time: "2026-07-01T12:00:00+08:00",
      end_time: "2026-07-03T22:00:00+08:00",
      shipment_id: "SYN-001",
      location_code: null,
    },
  ],
  warnings: [],
  definition_version: "metrics-v1.1.0",
  rule_set_version: "metric-baseline-rules-v1.0.0",
};

function overviewPayload(filtered: boolean) {
  return {
    context: {
      dataset_label: "订单数据集 11111111",
      datasets: { orders_dataset_id: datasetId },
      time_range_start: "2026-07-01",
      time_range_end: "2026-07-02",
      order_count: filtered ? 2 : 8,
      valid_order_count: filtered ? 2 : 8,
      unfiltered_order_count: 8,
      data_coverage: 1,
      last_analyzed_at: "2026-07-30T08:00:00Z",
      warning_count: 1,
    },
    active_filters: {
      start_date: null,
      end_date: null,
      warehouses: [],
      carriers: filtered ? ["CAR-B"] : [],
      regions: [],
      statuses: [],
      anomaly_types: [],
      timezone: "Asia/Shanghai",
    },
    filter_options: {
      minimum_date: "2026-07-01",
      maximum_date: "2026-07-02",
      warehouses: [{ value: "WH-A", label: "WH-A", count: 8 }],
      carriers: [
        { value: "CAR-A", label: "CAR-A", count: 6 },
        { value: "CAR-B", label: "CAR-B", count: 2 },
      ],
      regions: [{ value: "CN-SH", label: "CN-SH", count: 8 }],
      statuses: [{ value: "delivered", label: "已交付", count: 8 }],
      anomaly_types: [
        {
          value: "tracking_exception",
          label: "物流异常事件",
          count: 1,
        },
      ],
    },
    metrics,
    trend: {
      datasets: { orders_dataset_id: datasetId },
      grain: "date",
      timezone: "Asia/Shanghai",
      groups: [
        {
          key: "2026-07-01",
          label: "2026-07-01",
          metrics,
          order_count: filtered ? 1 : 4,
          warnings: [],
        },
        {
          key: "2026-07-02",
          label: "2026-07-02",
          metrics,
          order_count: filtered ? 1 : 4,
          warnings: [],
        },
      ],
      definition_version: "metrics-v1.1.0",
    },
    distribution: {
      datasets: { orders_dataset_id: datasetId },
      metric_code: "fulfillment_duration_hours",
      unit: "hour",
      sample_size: 2,
      minimum: 40,
      maximum: 74,
      mean: 57,
      median: 57,
      p90: 70.6,
      quantile_method: "Hyndman-Fan Type 7 / linear",
      bins: [
        {
          lower_bound: 40,
          upper_bound: 57,
          count: 1,
          includes_upper_bound: false,
        },
        {
          lower_bound: 57,
          upper_bound: 74,
          count: 1,
          includes_upper_bound: true,
        },
      ],
      warnings: [],
      definition_version: "metrics-v1.1.0",
    },
    distribution_coverage: 1,
    nodes: [
      {
        interval_code: "carrier_transit",
        display_name: "承运运输",
        mean_hours: 48,
        median_hours: 48,
        p90_hours: 58,
        sample_size: 2,
        eligible_count: 2,
        coverage: 1,
        is_bottleneck: true,
        warnings: [],
      },
    ],
    breakdown: {
      dimension: "carrier_id",
      sort_by: "anomaly_order_rate",
      sort_direction: "desc",
      groups: [
        {
          key: "CAR-B",
          label: "CAR-B",
          metrics,
          order_count: filtered ? 2 : 2,
          warnings: ["该分组订单量小于 30，只作为核查线索。"],
        },
      ],
    },
    warnings: [
      {
        code: "SMALL_SAMPLE",
        message: "样本量较小。",
        order_id: null,
      },
    ],
    warnings_truncated: false,
    definition_version: "metrics-v1.1.0",
    rule_set_version: "metric-baseline-rules-v1.0.0",
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function fetchInputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

describe("分析总览用户路径", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("fulfilllens.dataset.orders", datasetId);
    window.history.replaceState({}, "", "/analytics");
  });

  it("打开总览、筛选承运商并查看异常订单证据", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        "http://localhost",
      );
      if (url.pathname === "/health") {
        return Promise.resolve(
          jsonResponse({
            status: "ok",
            service: "fulfilllens-api",
            version: "1.0.0-rc.4",
          }),
        );
      }
      if (url.pathname === "/api/version") {
        return Promise.resolve(
          jsonResponse({
            app_name: "FulfillLens CN",
            app_version: "1.0.0-rc.4",
            api_version: "v1",
            environment: "test",
            contract_versions: {},
          }),
        );
      }
      if (url.pathname === "/api/dashboard/overview") {
        return Promise.resolve(
          jsonResponse(overviewPayload(url.searchParams.has("carrier"))),
        );
      }
      if (url.pathname === "/api/dashboard/orders") {
        return Promise.resolve(
          jsonResponse({
            datasets: { orders_dataset_id: datasetId },
            active_filters: overviewPayload(url.searchParams.has("carrier"))
              .active_filters,
            items: [order],
            total: 1,
            page: 1,
            page_size: 20,
            page_count: 1,
            sort_by: "created_at",
            sort_direction: "desc",
            definition_version: "metrics-v1.1.0",
          }),
        );
      }
      if (url.pathname.includes("/api/metrics/orders/")) {
        return Promise.resolve(jsonResponse(order));
      }
      return Promise.reject(new Error(`未模拟接口：${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByText("当前分析上下文")).toBeVisible();
    expect(screen.getByText("订单数据集 11111111")).toBeVisible();

    await user.click(screen.getByLabelText("承运商"));
    await user.click(await screen.findByText("CAR-B（2）"));
    await user.click(screen.getByRole("button", { name: /应用筛选/ }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some((call) =>
          fetchInputUrl(call[0]).includes("carrier=CAR-B"),
        ),
      ).toBe(true);
    });
    expect(await screen.findByText("ORD-SYN-ANOMALY-001")).toBeVisible();
    expect(screen.getByText("物流异常事件")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /查看履约时间线/ }));
    expect(
      await screen.findByText("当前为阶段 4 可复算履约证据"),
    ).toBeVisible();
    expect(screen.getByText("承运运输 · 58.0 小时")).toBeVisible();
  }, 10_000);
});
