import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

describe("FulfillLens 应用壳", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url =
          input instanceof Request
            ? input.url
            : input instanceof URL
              ? input.href
              : input;
        if (url.endsWith("/health")) {
          return Promise.resolve(
            jsonResponse({
              status: "ok",
              service: "fulfilllens-api",
              version: "1.1.2",
            }),
          );
        }

        if (url.endsWith("/api/version")) {
          return Promise.resolve(
            jsonResponse({
              app_name: "FulfillLens",
              app_version: "1.1.2",
              api_version: "v1",
              environment: "test",
              contract_versions: {
                data: "data-contract-v1.1.0",
                metrics: "metrics-v1.1.0",
                status: "status-v1.0-draft",
                diagnostics: "diagnostics-v1.0.0",
                simulation: "simulation-v1.0.0",
                cases: "teaching-cases-v1.0.0",
              },
            }),
          );
        }

        if (url.endsWith("/api/imports/samples")) {
          return Promise.resolve(
            jsonResponse({
              privacy_statement: "两份文件均为全新合成数据。",
              samples: [
                {
                  sample_id: "compatibility_orders_csv",
                  display_name: "非标准订单 CSV 自动转换示例",
                  file_name: "compatibility_demo_orders.csv",
                  file_format: "csv",
                  default_data_type: "orders",
                  default_sheet: null,
                  sheet_names: [],
                  row_counts: { orders: 8 },
                  purpose: "验证混合字段自动转换。",
                  conversion_features: ["中文与英文业务别名"],
                  sha256: "a".repeat(64),
                  privacy_statement: "完全合成。",
                },
                {
                  sample_id: "compatibility_logistics_xlsx",
                  display_name: "非标准物流 XLSX 自动转换示例",
                  file_name: "compatibility_demo_logistics.xlsx",
                  file_format: "xlsx",
                  default_data_type: "tracking_events",
                  default_sheet: "物流轨迹",
                  sheet_names: ["订单数据", "仓库事件", "物流轨迹"],
                  row_counts: {
                    orders: 6,
                    warehouse_events: 36,
                    tracking_events: 36,
                  },
                  purpose: "验证多工作表和 Excel 日期。",
                  conversion_features: ["多工作表", "Excel 日期"],
                  sha256: "b".repeat(64),
                  privacy_statement: "完全合成。",
                },
              ],
            }),
          );
        }

        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: "NOT_FOUND",
                message: "资源不存在",
                request_id: "test-request",
                details: [],
              },
            },
            404,
          ),
        );
      }),
    );
  });

  it("展示产品边界并读取真实系统状态接口", async () => {
    render(<App />);

    expect(
      screen.getByRole("heading", {
        name: "在本机看清订单从创建到交付的每一步",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("本地分析", { selector: ".ant-tag" }),
    ).toBeVisible();
    expect(screen.getByText(/结果仅用于分析与模拟/)).toBeVisible();
    expect(await screen.findByText("服务正常")).toBeVisible();
  });

  it("数据导入路由展示真实七步向导而不是伪造结果", async () => {
    window.history.pushState({}, "", "/import");

    render(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "数据导入",
      }),
    ).toBeVisible();
    expect(screen.getByText("1. 选择数据类型")).toBeVisible();
    expect(
      screen.getByRole("radio", { name: /自动识别（推荐）/ }),
    ).toBeChecked();
    expect(screen.getByText("一键导入合成样例")).toBeVisible();
    expect(screen.getByRole("button", { name: /自主上传文件/ })).toBeVisible();
    expect(
      await screen.findByText("非标准订单 CSV 自动转换示例"),
    ).toBeVisible();
    expect(screen.getByText("非标准物流 XLSX 自动转换示例")).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: "加载并进入导入流程" }),
    ).toHaveLength(2);
    expect(screen.queryByText("开发中")).not.toBeInTheDocument();
  });

  it("设置页只管理本地数据，不展示外部 AI 配置", async () => {
    window.history.pushState({}, "", "/settings");

    render(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "设置",
      }),
    ).toBeVisible();
    expect(screen.getByText(/管理本地数据集/)).toBeVisible();
    expect(screen.queryByText(/Workers AI/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: /token|密钥/i }),
    ).not.toBeInTheDocument();
  });
});
