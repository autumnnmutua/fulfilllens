import type { DataType } from "../types/imports";
import type { DatasetSelection } from "../types/metrics";
import { BROWSER_DERIVED_ORDERS_ID } from "./browserSelectionConstants";

export type AnalysisSourceKind =
  "user_import" | "compatibility_sample" | "teaching_data";

export interface BrowserAnalysisSession {
  activeDataType: DataType;
  activatedAt: string;
  datasetIds: Partial<Record<DataType, string>>;
  fileNames: Partial<Record<DataType, string>>;
  fingerprint: string;
  sessionId: string;
  sourceKind: AnalysisSourceKind;
  version: 1;
}

const SESSION_KEY = "fulfilllens.browser.analysis.session.v1";
const DATA_TYPES: DataType[] = [
  "orders",
  "warehouse_events",
  "tracking_events",
];

function storage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDataTypeStringRecord(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return DATA_TYPES.every((dataType) => {
    const item = value[dataType];
    return item === undefined || (typeof item === "string" && item.length > 0);
  });
}

function isAnalysisSession(value: unknown): value is BrowserAnalysisSession {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    typeof value.fingerprint === "string" &&
    value.fingerprint.length > 0 &&
    typeof value.activatedAt === "string" &&
    DATA_TYPES.includes(value.activeDataType as DataType) &&
    isDataTypeStringRecord(value.datasetIds) &&
    (value.fileNames === undefined ||
      isDataTypeStringRecord(value.fileNames)) &&
    ["user_import", "compatibility_sample", "teaching_data"].includes(
      String(value.sourceKind),
    )
  );
}

export function readBrowserAnalysisSession(): BrowserAnalysisSession | null {
  const local = storage();
  const raw = local?.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isAnalysisSession(value)) {
      local?.removeItem(SESSION_KEY);
      return null;
    }
    return value;
  } catch {
    local?.removeItem(SESSION_KEY);
    return null;
  }
}

export function browserSessionSelection(
  session: BrowserAnalysisSession,
): DatasetSelection {
  const orders = session.datasetIds.orders;
  const eventDataset =
    session.datasetIds.warehouse_events ?? session.datasetIds.tracking_events;
  const hasBrowserEvents = Boolean(eventDataset?.startsWith("browser-local-"));
  return {
    orders_dataset_id:
      orders ?? (hasBrowserEvents ? BROWSER_DERIVED_ORDERS_ID : ""),
    warehouse_events_dataset_id: session.datasetIds.warehouse_events ?? null,
    tracking_events_dataset_id: session.datasetIds.tracking_events ?? null,
  };
}

export function activateBrowserAnalysisSession(input: {
  dataType: DataType;
  datasetId: string;
  fileName: string;
  fingerprint: string;
  sourceKind: AnalysisSourceKind;
}): BrowserAnalysisSession {
  const session: BrowserAnalysisSession = {
    activeDataType: input.dataType,
    activatedAt: new Date().toISOString(),
    datasetIds: { [input.dataType]: input.datasetId },
    fileNames: { [input.dataType]: input.fileName },
    fingerprint: input.fingerprint,
    sessionId: crypto.randomUUID(),
    sourceKind: input.sourceKind,
    version: 1,
  };
  const local = storage();
  if (local) {
    DATA_TYPES.forEach((dataType) => {
      local.removeItem(`fulfilllens.browser.dataset.${dataType}`);
      local.removeItem(`fulfilllens.dataset.${dataType}`);
    });
    local.removeItem("fulfilllens.dashboard.filters");
    local.setItem(SESSION_KEY, JSON.stringify(session));
    local.setItem(
      input.datasetId.startsWith("browser-local-")
        ? `fulfilllens.browser.dataset.${input.dataType}`
        : `fulfilllens.dataset.${input.dataType}`,
      input.datasetId,
    );
  }
  return session;
}

export function clearBrowserAnalysisSession(): void {
  const local = storage();
  if (!local) return;
  local.removeItem(SESSION_KEY);
  DATA_TYPES.forEach((dataType) => {
    local.removeItem(`fulfilllens.browser.dataset.${dataType}`);
    local.removeItem(`fulfilllens.dataset.${dataType}`);
  });
}

export const BROWSER_ANALYSIS_SESSION_KEY = SESSION_KEY;
