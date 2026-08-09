import { onlineDemoDatasetId } from "../config/runtime";

export const BROWSER_DERIVED_ORDERS_ID = "browser-local-derived-orders";

export function isBrowserDatasetId(value: string | null | undefined): boolean {
  return (
    value === BROWSER_DERIVED_ORDERS_ID ||
    Boolean(value?.startsWith("browser-local-"))
  );
}

export function hasBrowserDatasetSelection(selection: {
  orders_dataset_id: string;
  warehouse_events_dataset_id?: string | null;
  tracking_events_dataset_id?: string | null;
}): boolean {
  return [
    selection.orders_dataset_id,
    selection.warehouse_events_dataset_id,
    selection.tracking_events_dataset_id,
  ].some(isBrowserDatasetId);
}

export function initialAnalysisDataset(dataType: string): string {
  const parameter = `${dataType}_dataset_id`;
  const fromUrl = new URLSearchParams(window.location.search)
    .get(parameter)
    ?.trim();
  if (fromUrl) return fromUrl;
  const browser = window.localStorage
    .getItem(`fulfilllens.browser.dataset.${dataType}`)
    ?.trim();
  if (browser) return browser;
  if (
    dataType === "orders" &&
    (window.localStorage.getItem(
      "fulfilllens.browser.dataset.tracking_events",
    ) ||
      window.localStorage.getItem(
        "fulfilllens.browser.dataset.warehouse_events",
      ))
  ) {
    return BROWSER_DERIVED_ORDERS_ID;
  }
  return (
    window.localStorage.getItem(`fulfilllens.dataset.${dataType}`)?.trim() ??
    onlineDemoDatasetId(dataType)
  );
}
