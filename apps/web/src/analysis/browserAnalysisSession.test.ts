import { beforeEach, describe, expect, it } from "vitest";

import {
  activateBrowserAnalysisSession,
  browserSessionSelection,
  readBrowserAnalysisSession,
} from "./browserAnalysisSession";
import { initialAnalysisDataset } from "./browserSelection";

describe("分析会话隔离", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, "", "/analytics");
  });

  it("确认用户轨迹文件后不会混入旧兼容订单或教学数据", () => {
    window.localStorage.setItem(
      "fulfilllens.browser.dataset.orders",
      "browser-local-old-demo-orders",
    );
    window.localStorage.setItem(
      "fulfilllens.dataset.orders",
      "compatibility-demo-orders",
    );
    const session = activateBrowserAnalysisSession({
      dataType: "tracking_events",
      datasetId: "browser-local-user-tracking",
      fileName: "用户文件.csv",
      fingerprint: "sha256-user-file",
      sourceKind: "user_import",
    });

    expect(browserSessionSelection(session)).toEqual({
      orders_dataset_id: "browser-local-derived-orders",
      warehouse_events_dataset_id: null,
      tracking_events_dataset_id: "browser-local-user-tracking",
    });
    expect(readBrowserAnalysisSession()?.fingerprint).toBe("sha256-user-file");
    expect(initialAnalysisDataset("orders")).toBe(
      "browser-local-derived-orders",
    );
    expect(initialAnalysisDataset("tracking_events")).toBe(
      "browser-local-user-tracking",
    );
    expect(
      window.localStorage.getItem("fulfilllens.dataset.orders"),
    ).toBeNull();
    expect(
      window.localStorage.getItem("fulfilllens.browser.dataset.orders"),
    ).toBeNull();
  });

  it("URL 显式数据包是一个整体，不回退混入本地会话", () => {
    activateBrowserAnalysisSession({
      dataType: "tracking_events",
      datasetId: "browser-local-user-tracking",
      fileName: "用户文件.csv",
      fingerprint: "sha256-user-file",
      sourceKind: "user_import",
    });
    window.history.replaceState(
      {},
      "",
      "/analytics?orders_dataset_id=explicit-orders",
    );
    expect(initialAnalysisDataset("orders")).toBe("explicit-orders");
    expect(initialAnalysisDataset("tracking_events")).toBe("");
  });

  it("旧版浏览器键同时存在时也不会把兼容订单混入用户轨迹", () => {
    window.localStorage.setItem(
      "fulfilllens.browser.dataset.orders",
      "browser-local-legacy-compatibility-orders",
    );
    window.localStorage.setItem(
      "fulfilllens.browser.dataset.tracking_events",
      "browser-local-legacy-user-tracking",
    );

    expect(initialAnalysisDataset("orders")).toBe(
      "browser-local-derived-orders",
    );
    expect(initialAnalysisDataset("tracking_events")).toBe(
      "browser-local-legacy-user-tracking",
    );
  });
});
