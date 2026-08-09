import { apiDownloadUrl, apiRequest } from "./client";
import type {
  CsvExportKind,
  ReportCapabilities,
  ReportDocument,
  ReportFormat,
  ReportJob,
  ReportRequest,
} from "../types/reports";
import { browserLocalReportsService } from "../analysis/browserLocalReportsService";
import { hasBrowserDatasetSelection } from "../analysis/browserSelection";

export const reportsApi = {
  capabilities: (signal?: AbortSignal) =>
    apiRequest<ReportCapabilities>("/api/reports/capabilities", { signal }),
  preview: (report: ReportRequest, signal?: AbortSignal) =>
    hasBrowserDatasetSelection(report.datasets)
      ? browserLocalReportsService.preview(report)
      : apiRequest<ReportDocument>("/api/reports/preview", {
          body: JSON.stringify(report),
          method: "POST",
          signal,
        }),
  createJob: (
    report: ReportRequest,
    format: ReportFormat,
    csvKind: CsvExportKind | null = null,
  ) =>
    hasBrowserDatasetSelection(report.datasets)
      ? browserLocalReportsService.createJob(report, format, csvKind)
      : apiRequest<ReportJob>("/api/reports/jobs", {
          body: JSON.stringify({ report, format, csv_kind: csvKind }),
          method: "POST",
        }),
  job: (jobId: string, signal?: AbortSignal) =>
    jobId.startsWith("browser-report-")
      ? browserLocalReportsService.job(jobId)
      : apiRequest<ReportJob>(
          `/api/reports/jobs/${encodeURIComponent(jobId)}`,
          {
            signal,
          },
        ),
  cancel: (jobId: string) =>
    jobId.startsWith("browser-report-")
      ? browserLocalReportsService.cancel(jobId)
      : apiRequest<ReportJob>(
          `/api/reports/jobs/${encodeURIComponent(jobId)}`,
          {
            method: "DELETE",
          },
        ),
  downloadUrl: (jobId: string) =>
    jobId.startsWith("browser-report-")
      ? browserLocalReportsService.downloadUrl(jobId)
      : apiDownloadUrl(
          `/api/reports/jobs/${encodeURIComponent(jobId)}/download`,
        ),
};
