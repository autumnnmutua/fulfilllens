import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readBrowserDataset,
  saveBrowserDataset,
  type BrowserDataset,
} from "./browserDatasetStore";

function abortingIndexedDb(close: ReturnType<typeof vi.fn>): IDBFactory {
  const database = {
    close,
    transaction: () => {
      const transaction: {
        error: DOMException;
        objectStore: () => { put: () => IDBRequest<unknown> };
        onabort: ((event: Event) => void) | null;
        oncomplete: ((event: Event) => void) | null;
        onerror: ((event: Event) => void) | null;
      } = {
        error: new DOMException("模拟事务中止", "AbortError"),
        objectStore: () => ({
          put: () => {
            const request = {
              result: undefined,
            } as unknown as IDBRequest<unknown>;
            Object.defineProperty(request, "onsuccess", {
              set(listener: ((event: Event) => void) | null) {
                queueMicrotask(() => {
                  listener?.(new Event("success"));
                  queueMicrotask(() =>
                    transaction.onabort?.(new Event("abort")),
                  );
                });
              },
            });
            return request;
          },
        }),
        onabort: null,
        oncomplete: null,
        onerror: null,
      };
      return transaction;
    },
  };
  const openRequest = { result: database } as unknown as IDBOpenDBRequest;
  Object.defineProperty(openRequest, "onsuccess", {
    set(listener: ((event: Event) => void) | null) {
      queueMicrotask(() => listener?.(new Event("success")));
    },
  });
  return {
    open: () => openRequest,
  } as unknown as IDBFactory;
}

function failingTransactionIndexedDb(
  close: ReturnType<typeof vi.fn>,
): IDBFactory {
  const database = {
    close,
    transaction: () => {
      throw new DOMException("模拟无法创建事务", "InvalidStateError");
    },
  };
  const openRequest = { result: database } as unknown as IDBOpenDBRequest;
  Object.defineProperty(openRequest, "onsuccess", {
    set(listener: ((event: Event) => void) | null) {
      queueMicrotask(() => listener?.(new Event("success")));
    },
  });
  return {
    open: () => openRequest,
  } as unknown as IDBFactory;
}

function dataset(datasetId: string): BrowserDataset {
  return {
    createdAt: "2026-08-25T00:00:00.000Z",
    dataType: "orders",
    datasetId,
    fileName: "synthetic.csv",
    qualityReport: {
      can_confirm: true,
      duplicate_keys: 0,
      error_rows: 0,
      exact_duplicate_rows: 0,
      field_resolutions: [],
      ignored_source_columns: [],
      invalid_times: 0,
      issues: [],
      long_text_values: 0,
      negative_quantities: 0,
      null_counts: {},
      sensitive_risks: [],
      status_normalizations: [],
      time_order_conflicts: 0,
      total_rows: 0,
      unknown_statuses: 0,
      unparseable_values: 0,
      unresolved_source_columns: [],
      valid_rows: 0,
      warning_rows: 0,
    },
    rows: [],
    sourceKind: "browser_local_import",
  };
}

describe("浏览器数据集持久化", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("写请求成功后事务仍中止时，不会向调用方报告保存成功", async () => {
    const close = vi.fn();
    vi.stubGlobal("indexedDB", abortingIndexedDb(close));
    const pendingDataset = dataset("browser-local-aborted-write");

    await expect(saveBrowserDataset(pendingDataset)).rejects.toThrow(
      "模拟事务中止",
    );
    expect(close).toHaveBeenCalledOnce();

    vi.stubGlobal("indexedDB", undefined);
    await expect(
      readBrowserDataset(pendingDataset.datasetId),
    ).resolves.toBeNull();
  });

  it("创建事务失败时关闭数据库连接并保留原始错误", async () => {
    const close = vi.fn();
    vi.stubGlobal("indexedDB", failingTransactionIndexedDb(close));

    await expect(
      saveBrowserDataset(dataset("browser-local-transaction-failed")),
    ).rejects.toThrow("模拟无法创建事务");
    expect(close).toHaveBeenCalledOnce();
  });
});
