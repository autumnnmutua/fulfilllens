import { afterEach, describe, expect, it, vi } from "vitest";

import { diagnosticsApi } from "./diagnostics";
import type { DiagnosticRequest } from "../types/diagnostics";

const request: DiagnosticRequest = {
  datasets: {
    orders_dataset_id: "11111111-1111-4111-8111-111111111111",
  },
  timezone: "Asia/Shanghai",
  rule_overrides: {},
  max_evidence_per_result: 20,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("诊断 API client", () => {
  it("使用 POST 发送规则请求并编码订单筛选", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            datasets: request.datasets,
            items: [],
            total: 0,
            page: 2,
            page_size: 10,
            page_count: 0,
            rule_set_version: "diagnostics-v1.0.0",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await diagnosticsApi.orders(request, {
      page: 2,
      pageSize: 10,
      severity: "high",
      category: "pickup_delay",
      ruleId: "FL-PU-001",
    });

    const input = fetchMock.mock.calls[0]?.[0];
    const options = fetchMock.mock.calls[0]?.[1];
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input?.url;
    expect(url).toContain("severity=high");
    expect(url).toContain("category=pickup_delay");
    expect(url).toContain("rule_id=FL-PU-001");
    expect(options?.method).toBe("POST");
    expect(typeof options?.body).toBe("string");
    const body = typeof options?.body === "string" ? options.body : "";
    expect(JSON.parse(body)).toEqual(request);
  });
});
