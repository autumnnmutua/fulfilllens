import { apiRequest } from "./client";
import { isCloudflareDeploy } from "../config/runtime";
import {
  deleteBrowserDataset,
  listBrowserDatasets,
  readBrowserDataset,
} from "../imports/browserDatasetStore";
import type {
  DatasetDeleteResponse,
  DatasetListResponse,
} from "../types/datasets";

export const datasetsApi = {
  list: async (signal?: AbortSignal) => {
    const remote = await apiRequest<DatasetListResponse>("/api/datasets", {
      signal,
    });
    if (!isCloudflareDeploy) return remote;
    const local = await listBrowserDatasets();
    const datasets = [
      ...local.map((dataset) => ({
        created_at: dataset.createdAt,
        data_type: dataset.dataType,
        dataset_id: dataset.datasetId,
        row_count: dataset.rows.length,
        source_kind: dataset.sourceKind,
      })),
      ...remote.datasets,
    ];
    return { datasets, total: datasets.length } satisfies DatasetListResponse;
  },
  delete: async (datasetId: string) => {
    if (datasetId.startsWith("browser-local-")) {
      const dataset = await readBrowserDataset(datasetId);
      if (!dataset) throw new Error("浏览器本地数据集不存在或已清理。");
      await deleteBrowserDataset(datasetId);
      return {
        data_type: dataset.dataType,
        dataset_id: datasetId,
        import_artifacts_deleted: true,
        message: "浏览器本地数据集已清理。",
        report_jobs_deleted: 0,
        rows_deleted: dataset.rows.length,
        scenarios_deleted: 0,
      } satisfies DatasetDeleteResponse;
    }
    return apiRequest<DatasetDeleteResponse>(
      `/api/datasets/${encodeURIComponent(datasetId)}`,
      { method: "DELETE" },
    );
  },
};
