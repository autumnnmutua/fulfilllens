import { apiRequest } from "./client";
import type {
  BreakdownResponse,
  DatasetSelection,
  DistributionResponse,
  MetricsSummary,
  OrderMetricDetail,
  TrendResponse,
} from "../types/metrics";
import { browserLocalAnalyticsService } from "../analysis/browserLocalAnalyticsService";
import { hasBrowserDatasetSelection } from "../analysis/browserSelection";

function selectionQuery(selection: DatasetSelection): URLSearchParams {
  const query = new URLSearchParams({
    orders_dataset_id: selection.orders_dataset_id,
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
  return query;
}

export const metricsApi = {
  summary: (selection: DatasetSelection) =>
    apiRequest<MetricsSummary>(
      `/api/metrics/summary?${selectionQuery(selection).toString()}`,
    ),
  trend: (
    selection: DatasetSelection,
    grain: "date" | "week",
    timezone: string,
  ) => {
    const query = selectionQuery(selection);
    query.set("grain", grain);
    query.set("timezone", timezone);
    return apiRequest<TrendResponse>(`/api/metrics/trend?${query.toString()}`);
  },
  distribution: (
    selection: DatasetSelection,
    metricCode = "fulfillment_duration_hours",
  ) => {
    const query = selectionQuery(selection);
    query.set("metric_code", metricCode);
    query.set("bin_count", "8");
    return apiRequest<DistributionResponse>(
      `/api/metrics/distribution?${query.toString()}`,
    );
  },
  breakdown: (
    selection: DatasetSelection,
    dimension: BreakdownResponse["dimension"],
  ) => {
    const query = selectionQuery(selection);
    query.set("dimension", dimension);
    return apiRequest<BreakdownResponse>(
      `/api/metrics/breakdown?${query.toString()}`,
    );
  },
  orderDetail: (selection: DatasetSelection, orderId: string) =>
    hasBrowserDatasetSelection(selection)
      ? browserLocalAnalyticsService.orderDetail(selection, orderId)
      : apiRequest<OrderMetricDetail>(
          `/api/metrics/orders/${encodeURIComponent(orderId)}?${selectionQuery(selection).toString()}`,
        ),
};
