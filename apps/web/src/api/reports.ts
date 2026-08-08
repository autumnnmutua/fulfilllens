import { apiDownloadUrl, apiRequest } from "./client";
import type {
  CsvExportKind,
  ReportCapabilities,
  ReportDocument,
  ReportFormat,
  ReportJob,
  ReportRequest,
} from "../types/reports";

export const reportsApi = {
  capabilities: (signal?: AbortSignal) =>
    apiRequest<ReportCapabilities>("/api/reports/capabilities", { signal }),
  preview: (report: ReportRequest, signal?: AbortSignal) =>
    apiRequest<ReportDocument>("/api/reports/preview", {
      body: JSON.stringify(report),
      method: "POST",
      signal,
    }),
  createJob: (
    report: ReportRequest,
    format: ReportFormat,
    csvKind: CsvExportKind | null = null,
  ) =>
    apiRequest<ReportJob>("/api/reports/jobs", {
      body: JSON.stringify({ report, format, csv_kind: csvKind }),
      method: "POST",
    }),
  job: (jobId: string, signal?: AbortSignal) =>
    apiRequest<ReportJob>(`/api/reports/jobs/${encodeURIComponent(jobId)}`, {
      signal,
    }),
  cancel: (jobId: string) =>
    apiRequest<ReportJob>(`/api/reports/jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
    }),
  downloadUrl: (jobId: string) =>
    apiDownloadUrl(`/api/reports/jobs/${encodeURIComponent(jobId)}/download`),
};
