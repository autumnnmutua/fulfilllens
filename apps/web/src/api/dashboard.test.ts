import { afterEach, describe, expect, it, vi } from "vitest";

import { dashboardApi } from "./dashboard";
import type { DashboardFilters } from "../types/dashboard";

const selection = {
  orders_dataset_id: "11111111-1111-4111-8111-111111111111",
  warehouse_events_dataset_id: "22222222-2222-4222-8222-222222222222",
  tracking_events_dataset_id: null,
};
const filters: DashboardFilters = {
  start_date: "2026-07-01",
  end_date: "2026-07-31",
  warehouses: ["WH-A"],
  carriers: ["CAR-A", "CAR-B"],
  regions: [],
  statuses: ["delivered"],
  anomaly_types: ["tracking_exception"],
  timezone: "Asia/Shanghai",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("仪表盘 API client", () => {
  it("把多选筛选作为重复参数传给统一总览", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ context: {}, metrics: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await dashboardApi.overview(selection, filters, {
      grain: "week",
      dimension: "carrier_id",
      breakdownSortBy: "anomaly_order_rate",
      breakdownSortDirection: "desc",
    });

    const request = fetchMock.mock.calls[0]?.[0];
    const requestUrl =
      typeof request === "string"
        ? request
        : request instanceof URL
          ? request.href
          : request?.url;
    const url = new URL(requestUrl ?? "/", "http://localhost");
    expect(url.pathname).toBe("/api/dashboard/overview");
    expect(url.searchParams.getAll("carrier")).toEqual(["CAR-A", "CAR-B"]);
    expect(url.searchParams.get("warehouse")).toBe("WH-A");
    expect(url.searchParams.get("anomaly_type")).toBe("tracking_exception");
    expect(url.searchParams.get("grain")).toBe("week");
    expect(url.searchParams.get("tracking_events_dataset_id")).toBeNull();
  });

  it("CSV 导出沿用当前筛选与排序", () => {
    const url = new URL(
      dashboardApi.ordersCsvUrl(selection, filters, {
        sortBy: "anomaly",
        sortDirection: "desc",
      }),
      "http://localhost",
    );

    expect(url.pathname).toBe("/api/dashboard/orders.csv");
    expect(url.searchParams.getAll("carrier")).toEqual(["CAR-A", "CAR-B"]);
    expect(url.searchParams.get("sort_by")).toBe("anomaly");
    expect(url.searchParams.get("sort_direction")).toBe("desc");
  });
});
