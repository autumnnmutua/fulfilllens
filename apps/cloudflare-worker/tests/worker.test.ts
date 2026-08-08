import { describe, expect, it, vi } from "vitest";

import worker, { type Env } from "../src/index";

function createEnv(): Env {
  return {
    AI: {
      run: vi.fn().mockResolvedValue({
        response: "FULFILLLENS_WORKERS_AI_OK",
        usage: {
          prompt_tokens: 12,
          completion_tokens: 6,
          total_tokens: 18,
        },
      }),
    },
    ASSETS: {
      fetch: vi.fn().mockResolvedValue(
        new Response("<html></html>", {
          headers: { "Content-Type": "text/html" },
        }),
      ),
    },
  };
}

describe("Cloudflare Worker", () => {
  it("returns health and version contracts", async () => {
    const env = createEnv();
    const health = await worker.fetch(
      new Request("https://example.test/health"),
      env,
    );
    const version = await worker.fetch(
      new Request("https://example.test/api/version"),
      env,
    );

    await expect(health.json()).resolves.toMatchObject({
      status: "ok",
      version: "1.0.0-rc.1",
    });
    await expect(version.json()).resolves.toMatchObject({
      environment: "cloudflare-preview",
      api_version: "v1",
    });
  });

  it("requires explicit confirmation before calling Workers AI", async () => {
    const env = createEnv();
    const response = await worker.fetch(
      new Request("https://example.test/api/integrations/workers-ai/probe", {
        method: "POST",
      }),
      env,
    );

    expect(response.status).toBe(403);
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("uses the native AI binding for the fixed synthetic probe", async () => {
    const env = createEnv();
    const response = await worker.fetch(
      new Request("https://example.test/api/integrations/workers-ai/probe", {
        method: "POST",
        headers: { "X-FulfillLens-External-Call": "confirm" },
      }),
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      reachable: true,
      sentinel_matched: true,
      usage: { total_tokens: 18 },
    });
    expect(env.AI.run).toHaveBeenCalledTimes(1);
  });

  it("keeps local-only API capabilities explicit", async () => {
    const response = await worker.fetch(
      new Request("https://example.test/api/metrics/summary"),
      createEnv(),
    );

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "CLOUD_PREVIEW_LOCAL_API_REQUIRED" },
    });
  });

  it("adds security headers to static assets", async () => {
    const response = await worker.fetch(
      new Request("https://example.test/"),
      createEnv(),
    );

    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
  });
});
