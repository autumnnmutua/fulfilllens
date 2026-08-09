export const isCloudflareDeploy =
  import.meta.env.VITE_DEPLOY_TARGET === "cloudflare";

const ONLINE_DEMO_DATASETS: Record<string, string> = {
  orders: "online-demo-promotion-orders-v1",
  warehouse_events: "online-demo-promotion-warehouse-events-v1",
  tracking_events: "online-demo-promotion-tracking-events-v1",
};

export function onlineDemoDatasetId(dataType: string): string {
  return isCloudflareDeploy ? (ONLINE_DEMO_DATASETS[dataType] ?? "") : "";
}
