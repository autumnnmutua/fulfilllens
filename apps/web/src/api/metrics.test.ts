import { afterEach, describe, expect, it, vi } from "vitest";

import { metricsApi } from "./metrics";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("指标 API client", () => {
  it("明确传递订单与可选事件数据集，不在前端计算公式", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            datasets: {
              orders_dataset_id: "orders-id",
              warehouse_events_dataset_id: "warehouse-id",
            },
            metrics: [],
            warnings: [],
            definition_version: "metrics-v1.1.0",
            taxonomy_version: "status-v1.0-draft",
            rule_set_version: "metric-baseline-rules-v1.0.0",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await metricsApi.summary({
      orders_dataset_id: "orders-id",
      warehouse_events_dataset_id: "warehouse-id",
      tracking_events_dataset_id: null,
    });

    const request = fetchMock.mock.calls[0]?.[0];
    const requestUrl =
      typeof request === "string"
        ? request
        : request instanceof URL
          ? request.href
          : request?.url;
    expect(requestUrl).toContain("orders_dataset_id=orders-id");
    expect(requestUrl).toContain("warehouse_events_dataset_id=warehouse-id");
    expect(requestUrl).not.toContain("tracking_events_dataset_id");
  });
});
