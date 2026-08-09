import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../app/App";

const ordersId = "11111111-1111-4111-8111-111111111111";
const scenarioId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const datasets = { orders_dataset_id: ordersId };
const emptyParameters = {
  warehouse_improvements: [],
  pickup_improvement: null,
  carrier_mix: null,
  promise_strategy: null,
};

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const catalog = {
  parameters: [
    {
      code: "pickup_reduction_hours",
      display_name: "出库至揽收等待减少",
      business_meaning: "缩短等待。",
      unit: "hour",
      minimum: 0,
      maximum: 168,
      default: 0,
      impact_path: "后续轨迹前移。",
      model_assumption: "时间完整传导。",
    },
  ],
  supported_warehouse_nodes: {
    order_to_pick: "接单后等待拣货",
    picking: "拣货处理",
    pick_to_qc: "拣货后等待复核",
    quality_check: "复核处理",
    packing: "打包处理",
  },
  definition_version: "simulation-v1.0.0",
  estimate_label: "情景估算",
};

function metric(code: string, name: string, value: number, unit = "ratio") {
  return {
    code,
    display_name: name,
    value,
    unit,
    numerator: 3,
    denominator: 5,
    coverage: 1,
    warnings: [],
  };
}

const metrics = [
  metric("ot_rate", "按时交付率（OT）", 0.8),
  metric("if_rate", "足量交付率（IF）", 0.8),
  metric("otif_rate", "按时足量交付率（OTIF）", 0.6),
  metric("fulfillment_duration_mean_hours", "平均履约时长", 52, "hour"),
  metric("fulfillment_duration_median_hours", "中位履约时长", 52, "hour"),
  metric("fulfillment_duration_p90_hours", "P90 履约时长", 63, "hour"),
  metric("anomaly_order_rate", "异常订单率", 0.4),
];

const baseline = {
  datasets,
  timezone: "Asia/Shanghai",
  input_fingerprint: "a".repeat(64),
  calculated_at: "2026-08-01T00:00:00Z",
  metrics,
  carrier_distribution: [
    { carrier_id: "CAR-A", order_count: 3, share: 0.6 },
    { carrier_id: "CAR-B", order_count: 2, share: 0.4 },
  ],
  order_count: 5,
  warnings: [],
  metrics_definition_version: "metrics-v1.1.0",
  definition_version: "simulation-v1.0.0",
  estimate_label: "情景估算",
};

function scenario(parameters: unknown = emptyParameters) {
  return {
    scenario_id: scenarioId,
    name: "改进方案 1",
    datasets,
    timezone: "Asia/Shanghai",
    parameters,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    definition_version: "simulation-v1.0.0",
  };
}

const comparisons = metrics.map((item) => ({
  code: item.code,
  display_name: item.display_name,
  unit: item.unit,
  baseline_value: item.value,
  scenario_value: item.unit === "hour" ? item.value - 1 : item.value,
  absolute_change: item.unit === "hour" ? -1 : 0,
  relative_change: item.unit === "hour" ? -1 / item.value : 0,
  baseline_numerator: item.numerator,
  baseline_denominator: item.denominator,
  scenario_numerator: item.numerator,
  scenario_denominator: item.denominator,
  baseline_coverage: 1,
  scenario_coverage: 1,
  warnings: [],
}));

describe("What-if 方案模拟页面", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("fulfilllens.dataset.orders", ordersId);
    window.history.replaceState({}, "", "/scenarios");
  });

  it("自动建立基线、创建方案并从节点层运行揽收改善", async () => {
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
          "http://localhost",
        );
        if (url.pathname === "/health") {
          return response({
            status: "ok",
            service: "fulfilllens-api",
            version: "1.0.0-rc.5",
          });
        }
        if (url.pathname === "/api/version") {
          return response({
            app_name: "FulfillLens",
            app_version: "1.0.0-rc.5",
            api_version: "v1",
            environment: "test",
            contract_versions: {},
          });
        }
        if (url.pathname === "/api/simulations/parameters")
          return response(catalog);
        if (url.pathname === "/api/simulations/baseline")
          return response(baseline);
        if (
          url.pathname === "/api/simulations/scenarios" &&
          options?.method !== "POST"
        ) {
          return response([]);
        }
        if (
          url.pathname === "/api/simulations/scenarios" &&
          options?.method === "POST"
        ) {
          return response(scenario(), 201);
        }
        if (url.pathname === `/api/simulations/scenarios/${scenarioId}`) {
          if (typeof options?.body !== "string") {
            throw new Error("方案更新请求体应为 JSON 字符串");
          }
          const body: unknown = JSON.parse(options.body);
          if (
            typeof body !== "object" ||
            body === null ||
            !("parameters" in body)
          ) {
            throw new Error("方案更新缺少 parameters");
          }
          return Promise.resolve(response(scenario(body.parameters)));
        }
        if (url.pathname === "/api/simulations/run") {
          return response({
            scenario_id: scenarioId,
            scenario_name: "改进方案 1",
            datasets,
            timezone: "Asia/Shanghai",
            input_fingerprint: "a".repeat(64),
            scenario_fingerprint: "b".repeat(64),
            calculated_at: "2026-08-01T01:00:00Z",
            parameters: {
              ...emptyParameters,
              pickup_improvement: { reduction_hours: 1, carrier_ids: [] },
            },
            comparisons: [
              ...comparisons,
              {
                code: "affected_order_count",
                display_name: "受影响订单数",
                unit: "order",
                baseline_value: 0,
                scenario_value: 1,
                absolute_change: 1,
                relative_change: null,
                baseline_numerator: 0,
                baseline_denominator: 5,
                scenario_numerator: 1,
                scenario_denominator: 5,
                baseline_coverage: 1,
                scenario_coverage: 0.2,
                warnings: [],
              },
            ],
            affected_order_count: 1,
            total_adjustments: 1,
            adjustments: [
              {
                transform_type: "pickup_improvement",
                order_id: "ORD-GOLD-001",
                source_order_id: "ORD-GOLD-001",
                field_name: "ready_to_pickup_hours",
                node_code: "ready_to_pickup",
                before_value: 2,
                after_value: 1,
                delta_hours: -1,
                explanation: "出库至揽收等待减少 1 小时，后续轨迹等量前移。",
              },
            ],
            adjustments_truncated: false,
            adjusted_nodes: ["ready_to_pickup"],
            skipped_counts: {},
            assumptions: ["原始数据不被覆盖。"],
            warnings: [],
            random_seed: null,
            reproducible: true,
            metrics_definition_version: "metrics-v1.1.0",
            definition_version: "simulation-v1.0.0",
            assumptions_version: "simulation-assumptions-v1.0.0",
            estimate_label:
              "基于历史数据和简化假设的情景估算，不代表真实预测或保证。",
          });
        }
        return Promise.reject(new Error(`未模拟接口：${url.pathname}`));
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByText("只读基线")).toBeVisible();
    expect(screen.getByText("按时足量交付率（OTIF）")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /新建方案/ }));
    await user.click(await screen.findByLabelText("启用揽收等待改善"));
    const reduction = screen.getByLabelText("揽收等待减少小时数");
    await user.clear(reduction);
    await user.type(reduction, "1");
    await user.click(
      screen.getByRole("button", { name: /保存并运行情景估算/ }),
    );

    expect(await screen.findByText("改进方案 1：情景估算结果")).toBeVisible();
    expect(screen.getAllByText("ORD-GOLD-001").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/后续轨迹等量前移/).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some((call) =>
          fetchInputUrl(call[0]).includes("/api/simulations/run"),
        ),
      ).toBe(true);
    });
  }, 20_000);
});

function fetchInputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}
