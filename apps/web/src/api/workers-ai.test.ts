import { afterEach, describe, expect, it, vi } from "vitest";

import { workersAIApi } from "./workers-ai";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Workers AI API client", () => {
  it("探针使用 POST 和显式外部调用确认头且不发送用户正文", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            provider: "cloudflare_workers_ai",
            model: "@cf/meta/llama-3.1-8b-instruct-fast",
            token_status: "active",
            reachable: true,
            sentinel_matched: true,
            usage: { total_tokens: 7 },
            message: "探针通过",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await workersAIApi.probe();

    const options = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(options?.headers);
    expect(options?.method).toBe("POST");
    expect(options?.body).toBeUndefined();
    expect(headers.get("X-FulfillLens-External-Call")).toBe("confirm");
  });
});
