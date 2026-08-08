import { apiRequest } from "./client";
import type {
  DatasetDeleteResponse,
  DatasetListResponse,
} from "../types/datasets";

export const datasetsApi = {
  list: (signal?: AbortSignal) =>
    apiRequest<DatasetListResponse>("/api/datasets", { signal }),
  delete: (datasetId: string) =>
    apiRequest<DatasetDeleteResponse>(
      `/api/datasets/${encodeURIComponent(datasetId)}`,
      { method: "DELETE" },
    ),
};
