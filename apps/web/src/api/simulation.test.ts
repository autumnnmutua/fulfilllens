import { afterEach, describe, expect, it, vi } from "vitest";

import { simulationApi } from "./simulation";

const datasets = {
  orders_dataset_id: "11111111-1111-4111-8111-111111111111",
};
const parameters = {
  warehouse_improvements: [],
  pickup_improvement: null,
  carrier_mix: null,
  promise_strategy: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("模拟 API client", () => {
  it("使用 PATCH 更新方案并保留结构化参数", async () => {
    const fetchMock = vi.fn<typeof fetch>((_input, options) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            scenario_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            name: "更新方案",
            datasets,
            timezone: "Asia/Shanghai",
            parameters,
            created_at: "2026-08-01T00:00:00Z",
            updated_at: "2026-08-01T01:00:00Z",
            definition_version: "simulation-v1.0.0",
          }),
          {
            status: options?.method === "PATCH" ? 200 : 500,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await simulationApi.update("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
      name: "更新方案",
      parameters,
    });

    const options = fetchMock.mock.calls[0]?.[1];
    expect(options?.method).toBe("PATCH");
    if (typeof options?.body !== "string") {
      throw new Error("方案更新请求体应为 JSON 字符串");
    }
    const parsedBody: unknown = JSON.parse(options.body);
    expect(parsedBody).toEqual({
      name: "更新方案",
      parameters,
    });
  });

  it("敏感性请求发送单参数取值序列", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            parameter: "pickup_reduction_hours",
            unit: "hour",
            points: [],
            input_fingerprint: "a".repeat(64),
            warnings: [],
            definition_version: "simulation-v1.0.0",
            estimate_label: "情景估算",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await simulationApi.sensitivity(
      datasets,
      "Asia/Shanghai",
      {
        ...parameters,
        pickup_improvement: { reduction_hours: 1, carrier_ids: [] },
      },
      "pickup_reduction_hours",
      [0, 1, 2],
    );

    const rawBody = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof rawBody !== "string") {
      throw new Error("敏感性请求体应为 JSON 字符串");
    }
    const body: unknown = JSON.parse(rawBody);
    expect(body).toMatchObject({
      parameter: "pickup_reduction_hours",
      values: [0, 1, 2],
    });
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
  });
});
