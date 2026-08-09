import { apiRequest } from "./client";
import type {
  DiagnosticAnalysis,
  DiagnosticOrderDetail,
  DiagnosticOrderFilters,
  DiagnosticOrderPage,
  DiagnosticRequest,
  DiagnosticRuleSet,
} from "../types/diagnostics";
import { browserLocalDiagnosticsService } from "../analysis/browserLocalDiagnosticsService";
import { hasBrowserDatasetSelection } from "../analysis/browserSelection";

export const diagnosticsApi = {
  rules: (signal?: AbortSignal) =>
    apiRequest<DiagnosticRuleSet>("/api/diagnostics/rules", { signal }),
  analyze: (request: DiagnosticRequest, signal?: AbortSignal) =>
    hasBrowserDatasetSelection(request.datasets)
      ? browserLocalDiagnosticsService.analyze(request)
      : apiRequest<DiagnosticAnalysis>("/api/diagnostics/analyze", {
          body: JSON.stringify(request),
          method: "POST",
          signal,
        }),
  orders: (
    request: DiagnosticRequest,
    filters: DiagnosticOrderFilters,
    signal?: AbortSignal,
  ) => {
    if (hasBrowserDatasetSelection(request.datasets)) {
      return browserLocalDiagnosticsService.orders(request, filters);
    }
    const query = new URLSearchParams({
      page: String(filters.page),
      page_size: String(filters.pageSize),
    });
    if (filters.severity) {
      query.set("severity", filters.severity);
    }
    if (filters.category) {
      query.set("category", filters.category);
    }
    if (filters.ruleId) {
      query.set("rule_id", filters.ruleId);
    }
    return apiRequest<DiagnosticOrderPage>(
      `/api/diagnostics/orders/search?${query.toString()}`,
      {
        body: JSON.stringify(request),
        method: "POST",
        signal,
      },
    );
  },
  orderDetail: (
    request: DiagnosticRequest,
    orderId: string,
    signal?: AbortSignal,
  ) =>
    hasBrowserDatasetSelection(request.datasets)
      ? browserLocalDiagnosticsService.orderDetail(request, orderId)
      : apiRequest<DiagnosticOrderDetail>(
          `/api/diagnostics/orders/${encodeURIComponent(orderId)}`,
          {
            body: JSON.stringify(request),
            method: "POST",
            signal,
          },
        ),
};
