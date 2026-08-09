function sectionLabel(element: Element): string {
  const scope =
    element.closest(".ant-card, section, main") ?? element.ownerDocument.body;
  const heading = scope.querySelector(
    ".ant-card-head-title, h2, h3, [role='heading']",
  );
  return heading?.textContent?.trim() || "数据";
}

export function enhanceAntdAccessibility(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>(".ant-table-content").forEach((region) => {
    if (!region.hasAttribute("tabindex")) region.tabIndex = 0;
    if (!region.hasAttribute("role")) region.setAttribute("role", "region");
    if (!region.hasAttribute("aria-label")) {
      region.setAttribute("aria-label", `${sectionLabel(region)}表格滚动区域`);
    }
  });

  root
    .querySelectorAll<HTMLTableElement>(".ant-table-wrapper table")
    .forEach((table) => {
      if (
        !table.hasAttribute("aria-label") &&
        !table.querySelector("caption")
      ) {
        table.setAttribute("aria-label", `${sectionLabel(table)}数据表`);
      }
    });

  const paginationLabels: Array<[string, string]> = [
    [".ant-pagination-prev .ant-pagination-item-link", "上一页"],
    [".ant-pagination-next .ant-pagination-item-link", "下一页"],
    [".ant-pagination-jump-prev .ant-pagination-item-link", "向前跳页"],
    [".ant-pagination-jump-next .ant-pagination-item-link", "向后跳页"],
  ];
  for (const [selector, label] of paginationLabels) {
    root.querySelectorAll<HTMLElement>(selector).forEach((control) => {
      if (!control.hasAttribute("aria-label")) {
        control.setAttribute("aria-label", label);
      }
    });
  }
}
