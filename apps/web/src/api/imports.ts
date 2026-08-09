import { apiDownloadUrl, apiRequest } from "./client";
import { isCloudflareDeploy } from "../config/runtime";
import { browserImportService } from "../imports/browserImportService";
import type {
  ConfirmResponse,
  CompatibilitySampleCatalog,
  DataType,
  ImportTask,
  ParseResponse,
  ValidationResponse,
} from "../types/imports";

export interface ValidationPayload {
  mapping: Record<string, string | null>;
  default_timezone: string | null;
  project_status_mappings: Record<string, string>;
}

export const importApi = {
  listSamples: () =>
    apiRequest<CompatibilitySampleCatalog>("/api/imports/samples"),
  sampleFileUrl: (sampleId: string) =>
    apiDownloadUrl(`/api/imports/samples/${encodeURIComponent(sampleId)}/file`),
  upload: (dataType: DataType, file: File) => {
    if (isCloudflareDeploy) {
      return browserImportService.upload(dataType, file);
    }
    const body = new FormData();
    body.append("data_type", dataType);
    body.append("file", file);
    return apiRequest<{ task: ImportTask }>("/api/imports/upload", {
      body,
      method: "POST",
    });
  },
  createSynthetic: (dataType: DataType) =>
    apiRequest<ParseResponse>("/api/imports/synthetic", {
      body: JSON.stringify({ data_type: dataType }),
      method: "POST",
    }),
  parse: (
    taskId: string,
    payload: { encoding?: string; sheet_name?: string },
  ) => {
    if (browserImportService.isTask(taskId)) {
      return browserImportService.parse(taskId, payload);
    }
    return apiRequest<ParseResponse>(`/api/imports/${taskId}/parse`, {
      body: JSON.stringify(payload),
      method: "POST",
    });
  },
  validate: (taskId: string, payload: ValidationPayload) => {
    if (browserImportService.isTask(taskId)) {
      return browserImportService.validate(taskId, payload);
    }
    return apiRequest<ValidationResponse>(`/api/imports/${taskId}/validation`, {
      body: JSON.stringify(payload),
      method: "PUT",
    });
  },
  confirm: (taskId: string) => {
    if (browserImportService.isTask(taskId)) {
      return browserImportService.confirm(taskId);
    }
    return apiRequest<ConfirmResponse>(`/api/imports/${taskId}/confirm`, {
      method: "POST",
    });
  },
  cancel: (taskId: string) => {
    if (browserImportService.isTask(taskId)) {
      return browserImportService.cancel(taskId);
    }
    return apiRequest<ImportTask>(`/api/imports/${taskId}`, {
      method: "DELETE",
    });
  },
  templateUrl: (dataType: DataType) =>
    apiDownloadUrl(`/api/imports/templates/${dataType}`),
  errorsUrl: (taskId: string) =>
    browserImportService.isTask(taskId)
      ? browserImportService.errorsUrl(taskId)
      : apiDownloadUrl(`/api/imports/${taskId}/errors.csv`),
};
