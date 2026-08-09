import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../app/App";

const datasetId = "11111111-1111-4111-8111-111111111111";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("设置页本地数据清理", () => {
  afterEach(cleanup);

  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("fulfilllens.dataset.orders", datasetId);
    window.history.replaceState({}, "", "/settings");
  });

  it("二次确认后清理后端数据和浏览器当前上下文", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL, options?: RequestInit) => {
        await Promise.resolve();
        const path = new URL(
          input instanceof Request ? input.url : String(input),
          "http://localhost",
        ).pathname;
        if (path === "/health")
          return json({ status: "ok", service: "api", version: "1.0.0-rc.3" });
        if (path === "/api/version")
          return json({
            app_name: "FulfillLens CN",
            app_version: "1.0.0-rc.3",
            api_version: "v1",
            environment: "test",
            contract_versions: {},
          });
        if (path === "/api/integrations/workers-ai/status")
          return json({
            enabled: false,
            configured: false,
            model: "@cf/test/model",
            external_data_policy: "不发送业务数据",
          });
        if (path === "/api/datasets" && options?.method !== "DELETE")
          return json({
            total: 1,
            datasets: [
              {
                dataset_id: datasetId,
                data_type: "orders",
                row_count: 120,
                created_at: "2026-08-01T10:00:00Z",
                source_kind: "synthetic_case",
              },
            ],
          });
        if (
          path === `/api/datasets/${datasetId}` &&
          options?.method === "DELETE"
        )
          return json({
            dataset_id: datasetId,
            data_type: "orders",
            rows_deleted: 120,
            scenarios_deleted: 2,
            report_jobs_deleted: 1,
            import_artifacts_deleted: false,
            message: "本地数据集及其关联缓存已清理，操作不可撤销。",
          });
        throw new Error(`未处理请求：${path}`);
      },
    );

    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(/订单表 · 120 行/);
    await user.click(screen.getByRole("button", { name: "清理此数据集" }));
    expect(screen.getByText("确认不可逆清理")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认清理" }));

    await waitFor(() => {
      expect(
        screen.getByText("本机目前没有已登记的数据集"),
      ).toBeInTheDocument();
      expect(
        window.localStorage.getItem("fulfilllens.dataset.orders"),
      ).toBeNull();
    });
  });
});
