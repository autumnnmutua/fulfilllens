import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../app/App";

const oldOrders = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const newDatasets = {
  orders_dataset_id: "11111111-1111-4111-8111-111111111111",
  warehouse_events_dataset_id: "22222222-2222-4222-8222-222222222222",
  tracking_events_dataset_id: "33333333-3333-4333-8333-333333333333",
};

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const caseItem = {
  case_id: "normal_operations",
  display_name: "案例 A：正常运营",
  business_background: "订单量平稳，节点时长稳定。",
  generator_version: "case-generator-v1.0.0",
  seed: 20260801,
  timezone: "Asia/Shanghai",
  order_count: 180,
  date_range: { start: "2026-06-01", end: "2026-06-18" },
  row_counts: { orders: 180, warehouse_events: 1620, tracking_events: 1620 },
  injected_anomalies: ["少量随机揽收或运输延迟"],
  expected_findings: [
    { rule_id: "FL-LH-001", description: "统计长尾", required: true },
  ],
  expected_metric_ranges: {},
  learning_objectives: ["复算 OTIF 和 P90"],
  privacy_statement: "本案例完全由程序生成，不包含真实个人信息。",
  content_fingerprint: "a".repeat(64),
  files: [{ name: "orders.csv", media_type: "text/csv", size_bytes: 1024 }],
};

describe("教学案例页面", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/cases");
    window.localStorage.clear();
    window.localStorage.setItem("fulfilllens.dataset.orders", oldOrders);
  });

  it("取消不替换上下文，确认后一次写入三个合成数据集", async () => {
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, options?: RequestInit) => {
        const url = new URL(fetchInputUrl(input), "http://localhost");
        if (url.pathname === "/health")
          return response({
            status: "ok",
            service: "fulfilllens-api",
            version: "1.0.0-rc.4",
          });
        if (url.pathname === "/api/version")
          return response({
            app_name: "FulfillLens CN",
            app_version: "1.0.0-rc.4",
            api_version: "v1",
            environment: "test",
            contract_versions: {},
          });
        if (url.pathname === "/api/cases" && options?.method !== "POST")
          return response({
            cases: [caseItem],
            generator_version: "case-generator-v1.0.0",
            privacy_statement: caseItem.privacy_statement,
          });
        if (url.pathname === "/api/cases/normal_operations/load")
          return response(
            {
              case: caseItem,
              datasets: newDatasets,
              replaced_current_context: true,
              prior_datasets_retained: true,
              message: "旧数据保留，新案例已成为当前上下文。",
            },
            201,
          );
        return Promise.reject(new Error(`未模拟接口：${url.pathname}`));
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByText("案例 A：正常运营")).toBeVisible();
    expect(screen.getByText(/完全合成数据/)).toBeVisible();
    const loadButton = screen.getByRole("button", { name: /一键载入案例A/ });
    await user.click(loadButton);
    expect(
      await screen.findByText("浏览器当前使用的三个数据集标识将被替换"),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        document.querySelectorAll(".ant-modal-footer button"),
      ).toHaveLength(2);
    });
    fireEvent.click(document.querySelectorAll(".ant-modal-footer button")[0]);
    expect(window.localStorage.getItem("fulfilllens.dataset.orders")).toBe(
      oldOrders,
    );

    await user.click(loadButton);
    await waitFor(() => {
      expect(
        document.querySelectorAll(".ant-modal-footer button"),
      ).toHaveLength(2);
    });
    fireEvent.click(document.querySelectorAll(".ant-modal-footer button")[1]);
    await waitFor(() => {
      expect(window.localStorage.getItem("fulfilllens.dataset.orders")).toBe(
        newDatasets.orders_dataset_id,
      );
    });
    expect(
      window.localStorage.getItem("fulfilllens.dataset.warehouse_events"),
    ).toBe(newDatasets.warehouse_events_dataset_id);
    expect(
      window.localStorage.getItem("fulfilllens.dataset.tracking_events"),
    ).toBe(newDatasets.tracking_events_dataset_id);
    expect(screen.getByText(/已成为当前分析上下文/)).toBeVisible();
  });
});

function fetchInputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}
