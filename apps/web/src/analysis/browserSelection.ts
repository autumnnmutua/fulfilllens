import { onlineDemoDatasetId } from "../config/runtime";
import {
  browserSessionSelection,
  readBrowserAnalysisSession,
} from "./browserAnalysisSession";
import { BROWSER_DERIVED_ORDERS_ID } from "./browserSelectionConstants";

export { BROWSER_DERIVED_ORDERS_ID } from "./browserSelectionConstants";

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
  const parameters = new URLSearchParams(window.location.search);
  const parameter = `${dataType}_dataset_id`;
  const hasExplicitBundle = [
    "orders_dataset_id",
    "warehouse_events_dataset_id",
    "tracking_events_dataset_id",
  ].some((key) => parameters.has(key));
  if (hasExplicitBundle) return parameters.get(parameter)?.trim() ?? "";
  const session = readBrowserAnalysisSession();
  if (session) {
    const selection = browserSessionSelection(session);
    return String(selection[parameter as keyof typeof selection] ?? "").trim();
  }
  const browser = window.localStorage
    .getItem(`fulfilllens.browser.dataset.${dataType}`)
    ?.trim();
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
  if (browser) return browser;
  return (
    window.localStorage.getItem(`fulfilllens.dataset.${dataType}`)?.trim() ??
    onlineDemoDatasetId(dataType)
  );
}
