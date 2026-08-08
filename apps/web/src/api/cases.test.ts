import { afterEach, describe, expect, it, vi } from "vitest";

import { caseApi } from "./cases";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("教学案例 API client", () => {
  it("使用 POST 载入案例且不向请求体写入数据集", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            case: { case_id: "normal_operations" },
            datasets: {
              orders_dataset_id: "11111111-1111-4111-8111-111111111111",
            },
            replaced_current_context: true,
            prior_datasets_retained: true,
            message: "已载入",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await caseApi.load("normal_operations");

    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
    expect(fetchInputUrl(fetchMock.mock.calls[0]?.[0])).toContain(
      "/api/cases/normal_operations/load",
    );
  });
});

function fetchInputUrl(input: RequestInfo | URL | undefined): string {
  if (input === undefined) return "";
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}
