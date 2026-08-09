import { readFileSync } from "node:fs";

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

function sampleFile(name: string, mediaType: string): File {
  const bytes = readFileSync(
    new URL(`../../../data/samples/${name}`, import.meta.url),
  );
  const contents = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new File([contents], name, { type: mediaType });
}

async function uploadCompatibilitySample(
  env: Env,
  dataType: string,
  file: File,
) {
  const form = new FormData();
  form.set("data_type", dataType);
  form.set("file", file);
  return worker.fetch(
    new Request("https://example.test/api/imports/upload", {
      method: "POST",
      body: form,
    }),
    env,
  );
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
      version: "1.0.0-rc.3",
    });
    await expect(version.json()).resolves.toMatchObject({
      environment: "cloudflare-online-demo",
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

  it("serves an online synthetic dashboard instead of a preview-only error", async () => {
    const response = await worker.fetch(
      new Request("https://example.test/api/dashboard/overview"),
      createEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      context: { dataset_label: "Cloudflare 在线合成履约演示" },
      metrics: expect.arrayContaining([
        expect.objectContaining({ code: "otif_rate" }),
      ]),
    });
  });

  it("loads the online teaching case catalog", async () => {
    const response = await worker.fetch(
      new Request("https://example.test/api/cases"),
      createEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      generator_version: "online-demo-generator-v1",
      cases: expect.arrayContaining([
        expect.objectContaining({ case_id: "promotion_surge" }),
      ]),
    });
  });

  it("lists both compatibility samples and rejects unknown uploads", async () => {
    const env = createEnv();
    const catalogResponse = await worker.fetch(
      new Request("https://example.test/api/imports/samples"),
      env,
    );
    const rejected = await uploadCompatibilitySample(
      env,
      "orders",
      new File(["order_id\nREAL-1\n"], "unknown.csv", { type: "text/csv" }),
    );

    expect(catalogResponse.status).toBe(200);
    await expect(catalogResponse.json()).resolves.toMatchObject({
      samples: [
        { sample_id: "compatibility_orders_csv", file_format: "csv" },
        { sample_id: "compatibility_logistics_xlsx", file_format: "xlsx" },
      ],
    });
    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toMatchObject({
      error: { code: "ONLINE_DEMO_SYNTHETIC_SAMPLE_ONLY" },
    });
  });

  it("runs the exact CSV sample through upload, mapping, validation, confirmation, and metrics", async () => {
    const env = createEnv();
    const upload = await uploadCompatibilitySample(
      env,
      "orders",
      sampleFile("compatibility_demo_orders.csv", "text/csv"),
    );
    const uploaded = (await upload.json()) as {
      task: { task_id: string };
    };
    const parse = await worker.fetch(
      new Request(
        `https://example.test/api/imports/${uploaded.task.task_id}/parse`,
        { method: "POST", body: "{}" },
      ),
      env,
    );
    const parsed = (await parse.json()) as {
      detected_data_type: string;
      total_rows: number;
      suggestions: Array<{
        source_column: string;
        suggested_field: string | null;
      }>;
      unmapped_source_columns: string[];
    };
    const mapping = Object.fromEntries(
      parsed.suggestions.map((item) => [
        item.source_column,
        item.suggested_field,
      ]),
    );
    const validation = await worker.fetch(
      new Request(
        `https://example.test/api/imports/${uploaded.task.task_id}/validation`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mapping,
            default_timezone: "Asia/Shanghai",
            project_status_mappings: {},
          }),
        },
      ),
      env,
    );
    const confirmation = await worker.fetch(
      new Request(
        `https://example.test/api/imports/${uploaded.task.task_id}/confirm`,
        { method: "POST" },
      ),
      env,
    );
    const confirmed = (await confirmation.json()) as {
      dataset_id: string;
      imported_rows: number;
    };
    const dashboard = await worker.fetch(
      new Request(
        `https://example.test/api/dashboard/overview?orders_dataset_id=${confirmed.dataset_id}`,
      ),
      env,
    );

    expect(upload.status).toBe(201);
    expect(parse.status).toBe(200);
    expect(parsed).toMatchObject({
      detected_data_type: "orders",
      total_rows: 8,
    });
    expect(parsed.unmapped_source_columns).toContain("无关备注");
    expect(validation.status).toBe(200);
    await expect(validation.clone().json()).resolves.toMatchObject({
      report: { total_rows: 8, error_rows: 0, duplicate_keys: 0 },
    });
    expect(confirmation.status).toBe(200);
    expect(confirmed.imported_rows).toBe(8);
    await expect(dashboard.json()).resolves.toMatchObject({
      context: { order_count: 8, valid_order_count: 8 },
      metrics: expect.arrayContaining([
        expect.objectContaining({ code: "otif_rate" }),
      ]),
    });
  });

  it("accepts the exact multi-sheet XLSX sample and exposes its conversion evidence", async () => {
    const env = createEnv();
    const upload = await uploadCompatibilitySample(
      env,
      "tracking_events",
      sampleFile(
        "compatibility_demo_logistics.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    );
    const uploaded = (await upload.json()) as {
      task: {
        task_id: string;
        status: string;
        sheets: Array<{ name: string }>;
      };
    };
    const parse = await worker.fetch(
      new Request(
        `https://example.test/api/imports/${uploaded.task.task_id}/parse`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sheet_name: "物流轨迹" }),
        },
      ),
      env,
    );
    const parsed = (await parse.json()) as {
      detected_data_type: string;
      total_rows: number;
      suggestions: Array<{
        source_column: string;
        suggested_field: string | null;
        method: string;
        confidence: number;
      }>;
      warnings: string[];
      conversion_notes: string[];
    };

    expect(upload.status).toBe(201);
    expect(uploaded.task.status).toBe("awaiting_sheet");
    expect(uploaded.task.sheets.map((sheet) => sheet.name)).toEqual([
      "订单数据",
      "仓库事件",
      "物流轨迹",
    ]);
    expect(parse.status).toBe(200);
    expect(parsed).toMatchObject({
      detected_data_type: "tracking_events",
      total_rows: 36,
    });
    expect(
      parsed.suggestions.every(
        (item) =>
          item.suggested_field === null ||
          (item.method.length > 0 && item.confidence > 0),
      ),
    ).toBe(true);
    expect(parsed.warnings.join(" ")).toContain("Excel 日期");
    expect(parsed.conversion_notes.join(" ")).toContain("原始值");
  });

  it("preserves the carrier case anomaly and comparable carrier groups", async () => {
    const env = createEnv();
    const loadResponse = await worker.fetch(
      new Request("https://example.test/api/cases/carrier_disruption/load", {
        method: "POST",
      }),
      env,
    );
    const loaded = (await loadResponse.json()) as {
      datasets: Record<string, string>;
    };
    const diagnosticsResponse = await worker.fetch(
      new Request("https://example.test/api/diagnostics/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datasets: loaded.datasets }),
      }),
      env,
    );
    const diagnostics = (await diagnosticsResponse.json()) as {
      results: Array<{ rule_id: string }>;
    };
    const query = new URLSearchParams({
      ...loaded.datasets,
      dimension: "carrier_id",
    });
    const breakdownResponse = await worker.fetch(
      new Request(`https://example.test/api/metrics/breakdown?${query}`),
      env,
    );
    const breakdown = (await breakdownResponse.json()) as {
      groups: Array<{ key: string; order_count: number }>;
    };

    expect(diagnostics.results.map((item) => item.rule_id)).toContain(
      "FL-CR-001",
    );
    expect(breakdown.groups.map((item) => item.key).sort()).toEqual([
      "Carrier-A",
      "Carrier-B",
      "Carrier-C",
    ]);
    expect(breakdown.groups.every((item) => item.order_count > 0)).toBe(true);
  });

  it("supports the online metrics, diagnostics, simulation, and report flows", async () => {
    const env = createEnv();
    const payload = JSON.stringify({
      datasets: {
        orders_dataset_id: "online-demo-promotion-orders-v1",
      },
      timezone: "Asia/Shanghai",
      sections: ["metrics_overview", "diagnostics"],
      dataset_name: "在线合成案例",
    });
    const headers = { "Content-Type": "application/json" };
    const [metrics, diagnostics, baseline, report] = await Promise.all([
      worker.fetch(
        new Request("https://example.test/api/metrics/summary"),
        env,
      ),
      worker.fetch(
        new Request("https://example.test/api/diagnostics/analyze", {
          method: "POST",
          headers,
          body: payload,
        }),
        env,
      ),
      worker.fetch(
        new Request("https://example.test/api/simulations/baseline", {
          method: "POST",
          headers,
          body: payload,
        }),
        env,
      ),
      worker.fetch(
        new Request("https://example.test/api/reports/preview", {
          method: "POST",
          headers,
          body: payload,
        }),
        env,
      ),
    ]);

    expect(metrics.status).toBe(200);
    expect(diagnostics.status).toBe(200);
    expect(baseline.status).toBe(200);
    expect(report.status).toBe(200);
    await expect(metrics.json()).resolves.toMatchObject({
      metrics: expect.arrayContaining([
        expect.objectContaining({ code: "fulfillment_duration_p90_hours" }),
      ]),
    });
    await expect(diagnostics.json()).resolves.toMatchObject({
      rule_set_version: "online-demo-rules-v1",
    });
    await expect(baseline.json()).resolves.toMatchObject({
      estimate_label: expect.stringContaining("合成数据"),
    });
    await expect(report.json()).resolves.toMatchObject({
      header: { synthetic_data: true },
    });
  });

  it("uses the documented Type-7 quantile for online P50 and P90", async () => {
    const env = createEnv();
    const summaryResponse = await worker.fetch(
      new Request("https://example.test/api/metrics/summary"),
      env,
    );
    const ordersResponse = await worker.fetch(
      new Request("https://example.test/api/dashboard/orders?page_size=100"),
      env,
    );
    const summary = (await summaryResponse.json()) as {
      metrics: Array<{ code: string; value: number | null }>;
    };
    const page = (await ordersResponse.json()) as {
      items: Array<{ fulfillment_duration_hours: number | null }>;
    };
    const values = page.items
      .map((item) => item.fulfillment_duration_hours)
      .filter((value): value is number => value !== null)
      .sort((left, right) => left - right);
    const type7 = (quantile: number) => {
      const position = (values.length - 1) * quantile;
      const lower = Math.floor(position);
      const upper = Math.ceil(position);
      return (
        (values[lower] ?? 0) +
        ((values[upper] ?? values[lower] ?? 0) - (values[lower] ?? 0)) *
          (position - lower)
      );
    };

    expect(
      summary.metrics.find(
        (metric) => metric.code === "fulfillment_duration_median_hours",
      )?.value,
    ).toBeCloseTo(type7(0.5), 2);
    expect(
      summary.metrics.find(
        (metric) => metric.code === "fulfillment_duration_p90_hours",
      )?.value,
    ).toBeCloseTo(type7(0.9), 2);
  });

  it("keeps synthetic node timelines within each order lifecycle", async () => {
    const env = createEnv();
    const pageResponse = await worker.fetch(
      new Request("https://example.test/api/dashboard/orders?page_size=100"),
      env,
    );
    const page = (await pageResponse.json()) as {
      items: Array<{
        order_id: string;
        fulfillment_duration_hours: number | null;
      }>;
    };
    const selected = page.items.find(
      (item) => item.fulfillment_duration_hours !== null,
    );
    expect(selected).toBeDefined();
    const detailResponse = await worker.fetch(
      new Request(
        `https://example.test/api/metrics/orders/${selected?.order_id}`,
      ),
      env,
    );
    const detail = (await detailResponse.json()) as {
      created_at: string;
      actual_delivery_time: string;
      fulfillment_duration_hours: number;
      node_durations: Array<{
        duration_hours: number;
        start_time: string;
        end_time: string;
      }>;
    };
    const durationSum = detail.node_durations.reduce(
      (total, node) => total + node.duration_hours,
      0,
    );

    expect(detail.node_durations[0]?.start_time).toBe(detail.created_at);
    expect(detail.node_durations.at(-1)?.end_time).toBe(
      detail.actual_delivery_time,
    );
    expect(durationSum).toBeCloseTo(detail.fulfillment_duration_hours, 2);
  });

  it("applies online scenarios to order copies before recalculating metrics", async () => {
    const env = createEnv();
    const headers = { "Content-Type": "application/json" };
    const requestBody = JSON.stringify({
      datasets: { orders_dataset_id: "online-demo-promotion-orders-v1" },
      scenario_name: "拣货改善 4 小时",
      parameters: {
        warehouse_improvements: [
          {
            node_code: "picking",
            method: "fixed_hours",
            value: 4,
            warehouse_ids: [],
          },
        ],
      },
    });
    const run = () =>
      worker.fetch(
        new Request("https://example.test/api/simulations/run", {
          method: "POST",
          headers,
          body: requestBody,
        }),
        env,
      );
    const [firstResponse, secondResponse] = await Promise.all([run(), run()]);
    const first = (await firstResponse.json()) as {
      scenario_fingerprint: string;
      affected_order_count: number;
      total_adjustments: number;
      adjustments: Array<{
        transform_type: string;
        before_value: number;
        after_value: number;
        delta_hours: number;
      }>;
      comparisons: Array<{
        code: string;
        baseline_value: number | null;
        scenario_value: number | null;
      }>;
    };
    const second = (await secondResponse.json()) as typeof first;

    expect(first.affected_order_count).toBeGreaterThan(0);
    expect(first.total_adjustments).toBeGreaterThan(0);
    expect(first.adjustments.length).toBeGreaterThan(0);
    expect(
      first.adjustments.every(
        (item) =>
          item.transform_type === "warehouse_improvement" &&
          item.after_value <= item.before_value &&
          item.delta_hours <= 0,
      ),
    ).toBe(true);
    expect(first.scenario_fingerprint).toBe(second.scenario_fingerprint);
    expect(first.comparisons).toEqual(second.comparisons);
    expect(
      first.comparisons.find(
        (metric) => metric.code === "fulfillment_duration_mean_hours",
      )?.scenario_value,
    ).toBeLessThan(
      first.comparisons.find(
        (metric) => metric.code === "fulfillment_duration_mean_hours",
      )?.baseline_value ?? 0,
    );
  });

  it("rejects invalid online simulation ranges and carrier weights", async () => {
    const response = await worker.fetch(
      new Request("https://example.test/api/simulations/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parameters: {
            pickup_improvement: { reduction_hours: -1, carrier_ids: [] },
            carrier_mix: {
              method: "empirical_resample",
              weights: { "Carrier-A": 70, "Carrier-B": 20 },
              random_seed: 20260808,
            },
          },
        }),
      }),
      createEnv(),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_SIMULATION_PARAMETER" },
    });
  });

  it("reconstructs online report downloads without isolate-local state", async () => {
    const env = createEnv();
    const report = {
      datasets: {
        orders_dataset_id: "online-demo-promotion-orders-v1",
      },
      filters: { carriers: ["Carrier-C"], timezone: "Asia/Shanghai" },
      dataset_name: "承运商筛选合成报告",
    };
    const previewResponse = await worker.fetch(
      new Request("https://example.test/api/reports/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(report),
      }),
      env,
    );
    const preview = (await previewResponse.json()) as {
      header: { order_count: number };
    };
    const state = {
      format: "markdown",
      csv_kind: null,
      created_at: "2026-08-09T00:00:00.000Z",
      report,
    };
    const bytes = new TextEncoder().encode(JSON.stringify(state));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const encoded = btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    const response = await worker.fetch(
      new Request(
        `https://example.test/api/reports/jobs/online-demo-report-${encoded}/download`,
      ),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/markdown");
    const content = await response.text();
    expect(preview.header.order_count).toBeGreaterThan(0);
    expect(preview.header.order_count).toBeLessThan(96);
    expect(content).toContain("# Cloudflare 在线合成履约演示");
    expect(content).toContain(`已加载 ${preview.header.order_count} 条`);
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
