import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../app/App";

const ordersId = "11111111-1111-4111-8111-111111111111";
let capturedReport: Record<string, unknown> | null = null;

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonBody(options?: RequestInit): unknown {
  if (typeof options?.body !== "string") {
    throw new Error("请求体应为 JSON 字符串");
  }
  return JSON.parse(options.body) as unknown;
}

const capabilities = {
  supported_formats: ["markdown", "html", "csv"],
  csv_export_kinds: [
    "anomaly_orders",
    "data_quality_errors",
    "status_mapping",
    "metric_detail",
    "simulation_comparison",
  ],
  pdf_available: false,
  pdf_reason: "当前环境未完成 Docker 中文字体复现验证。",
  max_export_bytes: 52_428_800,
  contract_version: "report-v1.0.0",
};

const preview = {
  header: {
    title: "促销爆单履约分析报告",
    dataset_name: "促销爆单",
    time_range_start: "2026-06-01T00:00:00+08:00",
    time_range_end: "2026-06-30T00:00:00+08:00",
    order_count: 80,
    valid_order_count: 78,
    data_coverage: 0.975,
    generated_at: "2026-08-01T02:00:00Z",
    timezone: "Asia/Shanghai",
    metrics_definition_version: "metrics-v1.1.0",
    diagnostic_rule_version: "diagnostics-v1.0.0",
    simulation_version: "simulation-v1.0.0",
    report_version: "report-v1.0.0",
    renderer_version: "report-renderer-v1.0.0",
    synthetic_data: true,
  },
  filters: {
    start_date: null,
    end_date: null,
    warehouses: [],
    carriers: ["CAR-B"],
    regions: [],
    statuses: [],
    anomaly_types: [],
    timezone: "Asia/Shanghai",
  },
  executive_summary: ["整体表现：当前筛选范围 OTIF 为 75.0%。"],
  sections: [
    {
      code: "metrics_overview",
      title: "整体履约表现",
      narrative: ["比例指标同时展示分子和分母。"],
      data: {
        metrics: [
          {
            code: "otif_rate",
            display_name: "按时足量交付率（OTIF）",
            value: 0.75,
            unit: "ratio",
            numerator: 60,
            denominator: 80,
            coverage: 1,
          },
        ],
      },
      warnings: [],
    },
  ],
  warnings: [],
  source_notes: ["指标来源：MetricsService / metrics-v1.1.0"],
  chart_map: [],
  identifier_policy: "默认最小化：订单、事件与运单标识已掩码。",
  reading_mode: "guided",
  reading_guide: [
    {
      term: "OTIF（按时足量交付率）",
      meaning: "同时做到按时和足量交付的订单占比。",
      direction: "通常越高越好。",
      caution: "必须同时看分母、覆盖率和不可计算数量。",
      requires_context: true,
    },
  ],
  contract_version: "report-v1.0.0",
};

function installFetchMock() {
  let jobPolls = 0;
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async (input: RequestInfo | URL, options?: RequestInit) => {
        await Promise.resolve();
        const url = new URL(
          input instanceof Request ? input.url : String(input),
          "http://localhost",
        );
        if (url.pathname === "/health") {
          return response({
            status: "ok",
            service: "fulfilllens-api",
            version: "1.0.0-rc.3",
          });
        }
        if (url.pathname === "/api/version") {
          return response({
            app_name: "FulfillLens CN",
            app_version: "1.0.0-rc.3",
            api_version: "v1",
            environment: "test",
            contract_versions: { reports: "report-v1.0.0" },
          });
        }
        if (url.pathname === "/api/reports/capabilities")
          return response(capabilities);
        if (url.pathname === "/api/simulations/scenarios") return response([]);
        if (url.pathname === "/api/reports/preview") {
          capturedReport = jsonBody(options) as Record<string, unknown>;
          return response(preview);
        }
        if (
          url.pathname === "/api/reports/jobs" &&
          options?.method === "POST"
        ) {
          capturedReport = (
            jsonBody(options) as {
              report: Record<string, unknown>;
            }
          ).report;
          return response(
            {
              job_id: "job-001",
              status: "queued",
              progress: 0,
              message: "等待处理",
              format: "html",
              csv_kind: null,
              created_at: "2026-08-01T02:00:00Z",
              updated_at: "2026-08-01T02:00:00Z",
              file_name: null,
              media_type: null,
              size_bytes: null,
              error_code: null,
              download_ready: false,
            },
            202,
          );
        }
        if (url.pathname === "/api/reports/jobs/job-001") {
          jobPolls += 1;
          return response({
            job_id: "job-001",
            status: "completed",
            progress: 100,
            message: `导出完成（轮询 ${jobPolls}）`,
            format: "html",
            csv_kind: null,
            created_at: "2026-08-01T02:00:00Z",
            updated_at: "2026-08-01T02:00:01Z",
            file_name: "促销爆单-履约分析报告.html",
            media_type: "text/html; charset=utf-8",
            size_bytes: 1024,
            error_code: null,
            download_ready: true,
          });
        }
        throw new Error(`未处理的请求：${url.pathname}`);
      },
    );
}

describe("分析报告页面", () => {
  afterEach(cleanup);

  beforeEach(() => {
    capturedReport = null;
    window.localStorage.clear();
    window.localStorage.setItem("fulfilllens.dataset.orders", ordersId);
    window.localStorage.setItem(
      "fulfilllens.dashboard.filters",
      JSON.stringify({ ...preview.filters, carriers: ["CAR-B"] }),
    );
    window.history.replaceState({}, "", "/reports");
  });

  it("沿用分析筛选生成可复核预览，默认隐藏订单标识", async () => {
    installFetchMock();
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText("PDF 暂未开放")).toBeInTheDocument();
    expect(screen.getByText("承运商 1")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("数据集名称"));
    await user.type(screen.getByLabelText("数据集名称"), "促销爆单");
    await user.click(screen.getByRole("button", { name: /生成预览/ }));

    expect(await screen.findByText("促销爆单履约分析报告")).toBeInTheDocument();
    expect(screen.getByText("按时足量交付率（OTIF）")).toBeInTheDocument();
    expect(screen.getByText("通常越高越好。")).toBeInTheDocument();
    expect(screen.getByText("需结合覆盖率/样本")).toBeInTheDocument();
    expect(
      screen.getByText("默认最小化：订单、事件与运单标识已掩码。"),
    ).toBeInTheDocument();
    expect(capturedReport).toMatchObject({
      dataset_name: "促销爆单",
      include_order_identifiers: false,
      sensitive_export_confirmed: false,
      reading_mode: "guided",
      filters: { carriers: ["CAR-B"] },
    });
  });

  it("二次确认标识风险，并显示异步 HTML 导出的完成下载", async () => {
    installFetchMock();
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("PDF 暂未开放");
    const identifierSwitch = screen.getByRole("switch", {
      name: "导出订单标识",
    });
    await user.click(identifierSwitch);
    expect(screen.getByText("确认导出订单标识")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "我理解风险，继续" }));
    expect(identifierSwitch).toBeChecked();

    await user.click(screen.getByRole("button", { name: /导出自包含 HTML/ }));
    expect(await screen.findByText(/等待导出/)).toBeInTheDocument();
    const download = await screen.findByRole(
      "link",
      { name: /下载 促销爆单-履约分析报告\.html/ },
      { timeout: 2500 },
    );
    expect(download).toHaveAttribute(
      "href",
      "/api/reports/jobs/job-001/download",
    );
    await waitFor(() => {
      expect(capturedReport).toMatchObject({
        include_order_identifiers: true,
        sensitive_export_confirmed: true,
      });
    });
  });
});
