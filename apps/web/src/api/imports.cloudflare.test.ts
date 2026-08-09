import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/runtime", () => ({
  isCloudflareDeploy: true,
}));

import { importApi } from "./imports";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Cloudflare 浏览器本地导入适配", () => {
  it("合法自主 CSV 完整处理时不调用网络上传接口", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const selected = new File(
      [
        "轨迹记录ID,订单号,快递单号,操作时间,轨迹状态,快递公司\n" +
          "SYN-E-01,SYN-O-01,SYN-W-01,2026-08-01 08:00,已揽件,SYN-C-A\n",
      ],
      "任意客户物流导出.csv",
      { type: "text/csv" },
    );

    const uploaded = await importApi.upload("tracking_events", selected);
    const parsed = await importApi.parse(uploaded.task.task_id, {});
    const mapping = Object.fromEntries(
      parsed.suggestions.map((suggestion) => [
        suggestion.source_column,
        suggestion.suggested_field ?? null,
      ]),
    );
    const validated = await importApi.validate(uploaded.task.task_id, {
      default_timezone: "Asia/Shanghai",
      mapping,
      project_status_mappings: {},
    });
    const confirmed = await importApi.confirm(uploaded.task.task_id);

    expect(validated.report.can_confirm).toBe(true);
    expect(confirmed.dataset_id).toMatch(/^browser-local-/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
