import { apiDownloadUrl, apiRequest } from "./client";
import type {
  DashboardFilters,
  DashboardOrderOptions,
  DashboardOrderPage,
  DashboardOverview,
  DashboardViewOptions,
} from "../types/dashboard";
import type { DatasetSelection } from "../types/metrics";
import { browserLocalAnalyticsService } from "../analysis/browserLocalAnalyticsService";
import { hasBrowserDatasetSelection } from "../analysis/browserSelection";

function dashboardQuery(
  selection: DatasetSelection,
  filters: DashboardFilters,
): URLSearchParams {
  const query = new URLSearchParams({
    orders_dataset_id: selection.orders_dataset_id,
    timezone: filters.timezone,
  });
  if (selection.warehouse_events_dataset_id) {
    query.set(
      "warehouse_events_dataset_id",
      selection.warehouse_events_dataset_id,
    );
  }
  if (selection.tracking_events_dataset_id) {
    query.set(
      "tracking_events_dataset_id",
      selection.tracking_events_dataset_id,
    );
  }
  if (filters.start_date) {
    query.set("start_date", filters.start_date);
  }
  if (filters.end_date) {
    query.set("end_date", filters.end_date);
  }
  for (const [key, values] of [
    ["warehouse", filters.warehouses],
    ["carrier", filters.carriers],
    ["region", filters.regions],
    ["status", filters.statuses],
    ["anomaly_type", filters.anomaly_types],
  ] as const) {
    values.forEach((value) => query.append(key, value));
  }
  return query;
}

export const dashboardApi = {
  overview: (
    selection: DatasetSelection,
    filters: DashboardFilters,
    options: DashboardViewOptions,
    signal?: AbortSignal,
  ) => {
    if (hasBrowserDatasetSelection(selection)) {
      return browserLocalAnalyticsService.overview(selection, filters, options);
    }
    const query = dashboardQuery(selection, filters);
    query.set("grain", options.grain);
    query.set("dimension", options.dimension);
    query.set("breakdown_sort_by", options.breakdownSortBy);
    query.set("breakdown_sort_direction", options.breakdownSortDirection);
    return apiRequest<DashboardOverview>(
      `/api/dashboard/overview?${query.toString()}`,
      { signal },
    );
  },
  orders: (
    selection: DatasetSelection,
    filters: DashboardFilters,
    options: DashboardOrderOptions,
    signal?: AbortSignal,
  ) => {
    if (hasBrowserDatasetSelection(selection)) {
      return browserLocalAnalyticsService.orders(selection, filters, options);
    }
    const query = dashboardQuery(selection, filters);
    query.set("page", String(options.page));
    query.set("page_size", String(options.pageSize));
    query.set("sort_by", options.sortBy);
    query.set("sort_direction", options.sortDirection);
    return apiRequest<DashboardOrderPage>(
      `/api/dashboard/orders?${query.toString()}`,
      { signal },
    );
  },
  ordersCsvUrl: (
    selection: DatasetSelection,
    filters: DashboardFilters,
    options: Pick<DashboardOrderOptions, "sortBy" | "sortDirection">,
  ): string => {
    if (hasBrowserDatasetSelection(selection)) return "";
    const query = dashboardQuery(selection, filters);
    query.set("sort_by", options.sortBy);
    query.set("sort_direction", options.sortDirection);
    return apiDownloadUrl(`/api/dashboard/orders.csv?${query.toString()}`);
  },
  downloadOrdersCsv: async (
    selection: DatasetSelection,
    filters: DashboardFilters,
    options: Pick<DashboardOrderOptions, "sortBy" | "sortDirection">,
  ): Promise<void> => {
    const remoteUrl = dashboardApi.ordersCsvUrl(selection, filters, options);
    const link = document.createElement("a");
    if (remoteUrl) {
      link.href = remoteUrl;
    } else {
      const content = await browserLocalAnalyticsService.ordersCsv(
        selection,
        filters,
        options,
      );
      link.href = URL.createObjectURL(
        new Blob([content], { type: "text/csv;charset=utf-8" }),
      );
      link.download = "fulfilllens-order-details.csv";
    }
    document.body.append(link);
    link.click();
    link.remove();
    if (!remoteUrl) URL.revokeObjectURL(link.href);
  },
};
