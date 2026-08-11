import type { DataType, QualityReport } from "../types/imports";

export interface BrowserDataset {
  analysisSource?: "user_import" | "compatibility_sample" | "teaching_data";
  createdAt: string;
  dataType: DataType;
  datasetId: string;
  fileName: string;
  fingerprint?: string;
  qualityReport: QualityReport;
  rows: Record<string, unknown>[];
  sourceKind: "browser_local_import";
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function fallbackHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export async function fingerprintBrowserDataset(
  dataType: DataType,
  rows: Record<string, unknown>[],
): Promise<string> {
  const canonical = JSON.stringify(stableValue({ dataType, rows }));
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonical),
    );
    return `sha256-${[...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("")}`;
  }
  return fallbackHash(canonical);
}

const memoryDatasets = new Map<string, BrowserDataset>();
// Keep the legacy database name so the public rebrand does not orphan datasets
// already stored in users' browsers.
const DATABASE_NAME = "fulfilllens-cn-browser-data";
const STORE_NAME = "datasets";

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onerror = () =>
      reject(request.error ?? new Error("无法打开浏览器数据存储。"));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "datasetId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionRequest<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return openDatabase().then(
    (database) =>
      new Promise<T | null>((resolve, reject) => {
        if (!database) {
          resolve(null);
          return;
        }
        const transaction = database.transaction(STORE_NAME, mode);
        const request = run(transaction.objectStore(STORE_NAME));
        request.onerror = () =>
          reject(request.error ?? new Error("浏览器数据存储操作失败。"));
        request.onsuccess = () => resolve(request.result);
        transaction.oncomplete = () => database.close();
      }),
  );
}

export async function saveBrowserDataset(
  dataset: BrowserDataset,
): Promise<void> {
  memoryDatasets.set(dataset.datasetId, dataset);
  await transactionRequest("readwrite", (store) => store.put(dataset));
}

export async function readBrowserDataset(
  datasetId: string,
): Promise<BrowserDataset | null> {
  const memory = memoryDatasets.get(datasetId);
  if (memory) return memory;
  const stored = await transactionRequest<BrowserDataset>(
    "readonly",
    (store) => store.get(datasetId) as IDBRequest<BrowserDataset>,
  );
  if (stored) memoryDatasets.set(datasetId, stored);
  return stored;
}

export async function deleteBrowserDataset(datasetId: string): Promise<void> {
  memoryDatasets.delete(datasetId);
  await transactionRequest("readwrite", (store) => store.delete(datasetId));
}

export async function listBrowserDatasets(): Promise<BrowserDataset[]> {
  const stored = await transactionRequest<BrowserDataset[]>(
    "readonly",
    (store) => store.getAll() as IDBRequest<BrowserDataset[]>,
  );
  if (stored)
    stored.forEach((dataset) => memoryDatasets.set(dataset.datasetId, dataset));
  return stored ?? [...memoryDatasets.values()];
}
