import { describe, expect, it } from "vitest";

import { enhanceAntdAccessibility } from "./antd-accessibility";

describe("enhanceAntdAccessibility", () => {
  it("names tables and pagination controls and makes scroll regions focusable", () => {
    document.body.innerHTML = `
      <section>
        <h2>订单明细</h2>
        <div class="ant-table-wrapper">
          <div class="ant-table-content"><table><tbody></tbody></table></div>
        </div>
        <ul>
          <li class="ant-pagination-prev"><button class="ant-pagination-item-link"></button></li>
          <li class="ant-pagination-next"><button class="ant-pagination-item-link"></button></li>
        </ul>
      </section>
    `;

    enhanceAntdAccessibility(document);

    const region = document.querySelector<HTMLElement>(".ant-table-content");
    const table = document.querySelector("table");
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region).toHaveAttribute("role", "region");
    expect(region).toHaveAccessibleName("订单明细表格滚动区域");
    expect(table).toHaveAccessibleName("订单明细数据表");
    expect(
      document.querySelector(".ant-pagination-prev button"),
    ).toHaveAccessibleName("上一页");
    expect(
      document.querySelector(".ant-pagination-next button"),
    ).toHaveAccessibleName("下一页");
  });
});
