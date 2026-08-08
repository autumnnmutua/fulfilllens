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

describe("FulfillLens CN 应用壳", () => {
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
              version: "1.0.0-rc.1",
            }),
          );
        }

        if (url.endsWith("/api/version")) {
          return Promise.resolve(
            jsonResponse({
              app_name: "FulfillLens CN",
              app_version: "1.0.0-rc.1",
              api_version: "v1",
              environment: "test",
              contract_versions: {
                data: "data-contract-v1.0-draft",
                metrics: "metrics-v1.1.0",
                status: "status-v1.0-draft",
                diagnostics: "diagnostics-v1.0.0",
                simulation: "simulation-v1.0.0",
                cases: "teaching-cases-v1.0.0",
              },
            }),
          );
        }

        if (url.endsWith("/api/integrations/workers-ai/status")) {
          return Promise.resolve(
            jsonResponse({
              provider: "cloudflare_workers_ai",
              enabled: false,
              configured: false,
              model: "@cf/meta/llama-3.1-8b-instruct-fast",
              external_data_policy:
                "仅允许显式合成探针；不会自动发送导入数据或个人信息。",
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
    expect(screen.getByText("一键导入合成样例")).toBeVisible();
    expect(screen.queryByText("开发中")).not.toBeInTheDocument();
  });

  it("设置页只展示脱敏 Workers AI 状态，不提供浏览器密钥输入", async () => {
    window.history.pushState({}, "", "/settings");

    render(<App />);

    expect(
      await screen.findByRole("heading", {
        name: "设置",
      }),
    ).toBeVisible();
    expect(
      screen.getByText("默认关闭", { selector: ".ant-tag" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "执行合成连接探针" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("textbox", { name: /token|密钥/i }),
    ).not.toBeInTheDocument();
  });
});
