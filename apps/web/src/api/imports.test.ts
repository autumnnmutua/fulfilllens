import { afterEach, describe, expect, it, vi } from "vitest";

import { importApi } from "./imports";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("导入 API client", () => {
  it("上传使用 FormData 且不手动覆盖 multipart boundary", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            task: {
              task_id: "synthetic-task",
              status: "awaiting_mapping",
            },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await importApi.upload(
      "orders",
      new File(["order_id\nORD-1\n"], "orders.csv", {
        type: "text/csv",
      }),
    );

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init).toBeDefined();
    if (init === undefined) {
      throw new Error("fetch 缺少请求配置");
    }
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect(new Headers(init.headers).has("Content-Type")).toBe(false);
  });
});
