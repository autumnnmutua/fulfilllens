import { apiRequest } from "./client";
import type { DatasetSelection } from "../types/metrics";
import type {
  BaselineResponse,
  ParameterCatalog,
  ScenarioParameters,
  ScenarioRecord,
  SensitivityParameter,
  SensitivityResponse,
  SimulationResponse,
} from "../types/simulation";

export const simulationApi = {
  parameters: (signal?: AbortSignal) =>
    apiRequest<ParameterCatalog>("/api/simulations/parameters", { signal }),
  baseline: (
    datasets: DatasetSelection,
    timezone: string,
    signal?: AbortSignal,
  ) =>
    apiRequest<BaselineResponse>("/api/simulations/baseline", {
      body: JSON.stringify({ datasets, timezone }),
      method: "POST",
      signal,
    }),
  scenarios: (ordersDatasetId: string, signal?: AbortSignal) => {
    const query = new URLSearchParams({ orders_dataset_id: ordersDatasetId });
    return apiRequest<ScenarioRecord[]>(
      `/api/simulations/scenarios?${query.toString()}`,
      { signal },
    );
  },
  create: (
    name: string,
    datasets: DatasetSelection,
    timezone: string,
    parameters: ScenarioParameters,
  ) =>
    apiRequest<ScenarioRecord>("/api/simulations/scenarios", {
      body: JSON.stringify({ name, datasets, timezone, parameters }),
      method: "POST",
    }),
  update: (
    scenarioId: string,
    payload: { name?: string; parameters?: ScenarioParameters },
  ) =>
    apiRequest<ScenarioRecord>(
      `/api/simulations/scenarios/${encodeURIComponent(scenarioId)}`,
      { body: JSON.stringify(payload), method: "PATCH" },
    ),
  copy: (scenarioId: string, name: string) =>
    apiRequest<ScenarioRecord>(
      `/api/simulations/scenarios/${encodeURIComponent(scenarioId)}/copy`,
      { body: JSON.stringify({ name }), method: "POST" },
    ),
  delete: (scenarioId: string) =>
    apiRequest<void>(
      `/api/simulations/scenarios/${encodeURIComponent(scenarioId)}`,
      { method: "DELETE" },
    ),
  run: (
    datasets: DatasetSelection,
    scenarioId: string,
    adjustmentDetailLimit = 200,
  ) =>
    apiRequest<SimulationResponse>("/api/simulations/run", {
      body: JSON.stringify({
        datasets,
        scenario_id: scenarioId,
        adjustment_detail_limit: adjustmentDetailLimit,
      }),
      method: "POST",
    }),
  sensitivity: (
    datasets: DatasetSelection,
    timezone: string,
    parameters: ScenarioParameters,
    parameter: SensitivityParameter,
    values: number[],
  ) =>
    apiRequest<SensitivityResponse>("/api/simulations/sensitivity", {
      body: JSON.stringify({
        datasets,
        timezone,
        parameters,
        parameter,
        values,
      }),
      method: "POST",
    }),
};
