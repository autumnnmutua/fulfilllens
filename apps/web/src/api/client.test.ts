import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiClientError, systemApi } from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("API client", () => {
  it("保留标准错误代码和请求标识", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: "SERVICE_NOT_READY",
                message: "服务尚未准备完成",
                request_id: "req-synthetic-001",
                details: [],
              },
            }),
            {
              status: 503,
              headers: {
                "Content-Type": "application/json",
              },
            },
          ),
        ),
      ),
    );

    const error = await systemApi.health().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({
      code: "SERVICE_NOT_READY",
      requestId: "req-synthetic-001",
      status: 503,
    });
  });
});
