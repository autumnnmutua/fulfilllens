/* Chromium viewport and structural accessibility audit. Requires Playwright. */
const fs = require("node:fs");
const path = require("node:path");

const playwrightModule = process.env.FL_PLAYWRIGHT_MODULE || "playwright";
const { chromium } = require(playwrightModule);

const baseUrl = process.env.FL_WEB_URL || "http://127.0.0.1:5173";
const executablePath = process.env.FL_CHROMIUM_PATH || undefined;
const outputPath =
  process.env.FL_AUDIT_OUTPUT || "docs/chromium-audit-results.json";
const auditCaseId = process.env.FL_AUDIT_CASE_ID || "";
const axePath =
  process.env.FL_AXE_PATH ||
  path.resolve(__dirname, "..", "node_modules", "axe-core", "axe.min.js");
const routes = [
  "/",
  "/import",
  "/analytics",
  "/diagnostics",
  "/scenarios",
  "/cases",
  "/reports",
  "/settings",
];
const viewports = [
  { width: 360, height: 800 },
  { width: 768, height: 900 },
  { width: 1440, height: 1000 },
];

function accessibleProblems() {
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0
    );
  };
  const name = (element) => {
    const labelledBy = element.getAttribute("aria-labelledby");
    const labelledText = labelledBy
      ? labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent || "")
          .join(" ")
      : "";
    const idLabel = element.id
      ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)
          ?.textContent || ""
      : "";
    return (
      element.getAttribute("aria-label") ||
      labelledText ||
      idLabel ||
      element.closest("label")?.textContent ||
      element.getAttribute("title") ||
      element.textContent ||
      ""
    ).trim();
  };
  const interactive = [
    ...document.querySelectorAll(
      "button,a[href],input,select,textarea,[role=button],[role=link],[role=combobox]",
    ),
  ].filter(
    (element) =>
      visible(element) &&
      !element.disabled &&
      element.getAttribute("aria-hidden") !== "true",
  );
  const duplicateIds = [...document.querySelectorAll("[id]")]
    .map((element) => element.id)
    .filter((id, index, values) => id && values.indexOf(id) !== index);
  return {
    mainCount: document.querySelectorAll("main").length,
    h1Count: document.querySelectorAll("h1").length,
    horizontalOverflow:
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth + 1,
    unnamedInteractive: interactive
      .filter((element) => !name(element))
      .map((element) => element.outerHTML.slice(0, 160)),
    duplicateIds: [...new Set(duplicateIds)],
    tablesWithoutCaption: [...document.querySelectorAll("table")].filter(
      (table) =>
        !table.closest(".ant-descriptions") &&
        !table.querySelector("caption") &&
        !table.getAttribute("aria-label"),
    ).length,
    imagesWithoutText: [...document.querySelectorAll("img,[role=img]")].filter(
      (element) => visible(element) && !name(element),
    ).length,
  };
}

(async () => {
  let auditDatasets = null;
  if (auditCaseId) {
    const caseResponse = await fetch(
      `${baseUrl}/api/cases/${encodeURIComponent(auditCaseId)}/load`,
      {
        method: "POST",
      },
    );
    if (!caseResponse.ok) {
      throw new Error(
        `Unable to load audit case ${auditCaseId}: HTTP ${caseResponse.status}`,
      );
    }
    const payload = await caseResponse.json();
    auditDatasets = payload.datasets || null;
    if (!auditDatasets?.orders_dataset_id) {
      throw new Error(
        `Audit case ${auditCaseId} did not return an orders dataset`,
      );
    }
  }

  const browser = await chromium.launch({ headless: true, executablePath });
  const results = [];
  let failed = false;
  try {
    for (const viewport of viewports) {
      // Axe is injected only inside this isolated audit context. Production CSP
      // stays strict; bypassing it here prevents the test harness from being
      // blocked by the application policy it is meant to inspect.
      const context = await browser.newContext({ viewport, bypassCSP: true });
      if (auditDatasets) {
        await context.addInitScript((datasets) => {
          localStorage.setItem(
            "fulfilllens.dataset.orders",
            datasets.orders_dataset_id,
          );
          if (datasets.warehouse_events_dataset_id) {
            localStorage.setItem(
              "fulfilllens.dataset.warehouse_events",
              datasets.warehouse_events_dataset_id,
            );
          }
          if (datasets.tracking_events_dataset_id) {
            localStorage.setItem(
              "fulfilllens.dataset.tracking_events",
              datasets.tracking_events_dataset_id,
            );
          }
        }, auditDatasets);
      }
      const page = await context.newPage();
      for (const route of routes) {
        const response = await page.goto(`${baseUrl}${route}`, {
          waitUntil: "networkidle",
          timeout: 30000,
        });
        await page.addScriptTag({ path: axePath });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.locator("body").press("Tab");
        const focusTag = await page.evaluate(
          () => document.activeElement?.tagName || "",
        );
        const audit = await page.evaluate(accessibleProblems);
        const axe = await page.evaluate(async () => {
          const report = await window.axe.run(document, {
            runOnly: {
              type: "tag",
              values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
            },
          });
          return report.violations.map((violation) => ({
            id: violation.id,
            impact: violation.impact,
            nodes: violation.nodes.length,
            samples: violation.nodes.slice(0, 5).map((node) => ({
              target: node.target,
              html: node.html,
              summary: node.failureSummary,
            })),
          }));
        });
        const record = {
          route,
          viewport: `${viewport.width}x${viewport.height}`,
          status: response?.status() || 0,
          focusTag,
          axeViolations: axe,
          ...audit,
        };
        const problems =
          record.status !== 200 ||
          record.mainCount !== 1 ||
          record.h1Count !== 1 ||
          record.horizontalOverflow ||
          record.unnamedInteractive.length > 0 ||
          record.duplicateIds.length > 0 ||
          record.tablesWithoutCaption > 0 ||
          record.imagesWithoutText > 0 ||
          record.axeViolations.length > 0 ||
          !["A", "BUTTON", "INPUT"].includes(record.focusTag);
        record.passed = !problems;
        failed ||= problems;
        results.push(record);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const payload = {
    generated_at: new Date().toISOString(),
    engine: "Chromium",
    base_url: baseUrl,
    results,
    passed: !failed,
  };
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf8");
  process.stdout.write(JSON.stringify(payload, null, 2));
  process.exitCode = failed ? 1 : 0;
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
