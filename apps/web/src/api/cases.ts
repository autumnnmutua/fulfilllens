import { apiDownloadUrl, apiRequest } from "./client";
import type {
  CaseCatalogResponse,
  CaseId,
  CaseLoadResponse,
} from "../types/cases";

export const caseApi = {
  list: () => apiRequest<CaseCatalogResponse>("/api/cases"),
  load: (caseId: CaseId) =>
    apiRequest<CaseLoadResponse>(`/api/cases/${caseId}/load`, {
      method: "POST",
    }),
  fileUrl: (caseId: CaseId, fileName: string) =>
    apiDownloadUrl(
      `/api/cases/${caseId}/files/${encodeURIComponent(fileName)}`,
    ),
};
