import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../app/App";

vi.mock("../components/EChart", () => ({
  EChart: ({ ariaLabel }: { ariaLabel: string }) => (
    <div role="img" aria-label={ariaLabel} />
  ),
}));

const ordersId = "11111111-1111-4111-8111-111111111111";
const warehouseId = "22222222-2222-4222-8222-222222222222";

const rule = {
  rule_id: "FL-WH-001",
  rule_version: "1.0.0",
  title: "仓内作业延迟",
  category: "warehouse_delay",
  description: "识别仓内节点超过阈值的订单。",
  severity: "medium",
  priority: 70,
  enabled: true,
  parameters: {
    order_to_pick_threshold_hours: {
      display_name: "接单到拣货阈值",
      value: 4,
      minimum: 0.25,
      maximum: 168,
      unit: "hour",
    },
  },
};

const evidence = {
  order_id: "DIAG-001",
  event_id: null,
  shipment_id: null,
  node_code: "order_to_pick",
  start_time: "2026-07-01T00:00:00Z",
  end_time: "2026-07-01T05:00:00Z",
  observed_value: 5,
  threshold_value: 4,
  baseline_value: 1,
  unit: "hour",
  dimension_type: "warehouse",
  dimension_value: "WH-A",
  comparison: "实际时长严格超过业务阈值。",
};

const result = {
  rule_id: "FL-WH-001",
  rule_version: "1.0.0",
  merged_rule_ids: [],
  title: "仓内作业延迟：接单后等待拣货",
  category: "warehouse_delay",
  severity: "medium",
  factual_observation: "1 个订单的接单后等待拣货时长超过业务阈值。",
  rule_judgement: "规则以 4 小时为业务阈值。",
  possible_causes: ["可能与作业排队有关，尚不能确认原因。"],
  evidence: [evidence],
  affected_order_count: 1,
  affected_order_sample: ["DIAG-001"],
  coverage: 1,
  confidence_warning: ["样本量小于 30，规则结果仅用于核查。"],
  recommended_checks: ["核对作业日志。"],
  sample_size: 1,
  dimension_type: "node",
  dimension_value: "order_to_pick",
  priority: 70,
};

const analysis = {
  context: {
    datasets: {
      orders_dataset_id: ordersId,
      warehouse_events_dataset_id: warehouseId,
    },
    analyzed_at: "2026-08-01T04:00:00Z",
    order_count: 1,
    valid_order_count: 1,
    affected_order_count: 1,
    finding_count: 1,
    enabled_rule_count: 1,
    triggered_rule_count: 1,
    data_coverage: 1,
    warning_count: 1,
    timezone: "Asia/Shanghai",
  },
  results: [result],
  severity_summary: [
    { severity: "critical", finding_count: 0, affected_order_count: 0 },
    { severity: "high", finding_count: 0, affected_order_count: 0 },
    { severity: "medium", finding_count: 1, affected_order_count: 1 },
    { severity: "low", finding_count: 0, affected_order_count: 0 },
  ],
  pareto: [
    {
      category: "warehouse_delay",
      display_name: "仓内作业延迟",
      finding_count: 1,
      affected_order_count: 1,
      cumulative_share: 1,
    },
  ],
  bottleneck_nodes: [
    {
      node_code: "order_to_pick",
      display_name: "接单后等待拣货",
      mean_hours: 5,
      p90_hours: 5,
      threshold_hours: 4,
      sample_size: 1,
      affected_order_count: 1,
      coverage: 1,
      is_bottleneck: true,
    },
  ],
  process_variants: [
    {
      variant_id: "V-TEST",
      sequence: ["order_received", "picking_started"],
      order_count: 1,
      share: 1,
      affected_order_count: 1,
    },
  ],
  dimension_insights: [
    {
      dimension_type: "warehouse",
      dimension_value: "WH-A",
      finding_count: 1,
      affected_order_count: 1,
      highest_severity: "medium",
      categories: ["warehouse_delay"],
    },
  ],
  analysis_warnings: ["有效订单少于 30，群体对比规则可能不触发。"],
  rule_set_version: "diagnostics-v1.0.0",
};

const orderItem = {
  order_id: "DIAG-001",
  order_status: "delivered",
  warehouse_id: "WH-A",
  carrier_id: "CAR-A",
  destination_region: "华东",
  highest_severity: "medium",
  categories: ["warehouse_delay"],
  rule_ids: ["FL-WH-001"],
  finding_count: 1,
};

const metricDetail = {
  order_id: "DIAG-001",
  order_status: "delivered",
  created_at: "2026-07-01T08:00:00+08:00",
  promised_delivery_time: "2026-07-03T08:00:00+08:00",
  actual_delivery_time: "2026-07-02T08:00:00+08:00",
  ordered_quantity: 1,
  delivered_quantity: 1,
  quantity_unit: "piece",
  warehouse_id: "WH-A",
  carrier_id: "CAR-A",
  destination_region: "华东",
  sales_channel: "synthetic",
  ot: { status: "true", value: true, reason: "按时。" },
  in_full: { status: "true", value: true, reason: "足量。" },
  otif: { status: "true", value: true, reason: "按时足量。" },
  fulfillment_duration_hours: 24,
  anomaly: false,
  anomaly_reasons: [],
  node_durations: [],
  warnings: [],
  definition_version: "metrics-v1.1.0",
  rule_set_version: "metric-baseline-rules-v1.0.0",
};

function response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("异常诊断页面", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("fulfilllens.dataset.orders", ordersId);
    window.localStorage.setItem(
      "fulfilllens.dataset.warehouse_events",
      warehouseId,
    );
    window.history.replaceState({}, "", "/diagnostics");
  });

  it("从聚合诊断下钻到订单事件证据", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        "http://localhost",
      );
      if (url.pathname === "/health") {
        return Promise.resolve(
          response({
            status: "ok",
            service: "fulfilllens-api",
            version: "1.1.1",
          }),
        );
      }
      if (url.pathname === "/api/version") {
        return Promise.resolve(
          response({
            app_name: "FulfillLens",
            app_version: "1.1.1",
            api_version: "v1",
            environment: "test",
            contract_versions: {},
          }),
        );
      }
      if (url.pathname === "/api/diagnostics/rules") {
        return Promise.resolve(
          response({ rule_set_version: "diagnostics-v1.0.0", rules: [rule] }),
        );
      }
      if (url.pathname === "/api/diagnostics/analyze") {
        return Promise.resolve(response(analysis));
      }
      if (url.pathname === "/api/diagnostics/orders/search") {
        return Promise.resolve(
          response({
            datasets: analysis.context.datasets,
            items: [orderItem],
            total: 1,
            page: 1,
            page_size: 20,
            page_count: 1,
            rule_set_version: "diagnostics-v1.0.0",
          }),
        );
      }
      if (url.pathname === "/api/diagnostics/orders/DIAG-001") {
        return Promise.resolve(
          response({
            metric_detail: metricDetail,
            findings: [result],
            timeline: [
              {
                source: "warehouse",
                event_id: "W-1",
                event_time: "2026-07-01T00:00:00Z",
                event_code: "order_received",
                raw_status: "仓库接单",
                shipment_id: null,
                location_code: null,
              },
              {
                source: "warehouse",
                event_id: "W-2",
                event_time: "2026-07-01T05:00:00Z",
                event_code: "picking_started",
                raw_status: "开始拣货",
                shipment_id: null,
                location_code: null,
              },
            ],
            rule_set_version: "diagnostics-v1.0.0",
          }),
        );
      }
      return Promise.reject(new Error(`未模拟接口：${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByText("当前诊断上下文")).toBeVisible();
    expect(screen.getByText("诊断是规则判断，不是因果结论")).toBeVisible();
    expect(screen.getByText("DIAG-001")).toBeVisible();
    expect(screen.getByRole("img", { name: /异常帕累托/ })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "查看时间线" }));

    expect(await screen.findByText("完整证据链")).toBeVisible();
    expect(screen.getByText("order_received")).toBeVisible();
    expect(screen.getByText(/原始状态：仓库接单/)).toBeVisible();
  }, 30_000);
});
