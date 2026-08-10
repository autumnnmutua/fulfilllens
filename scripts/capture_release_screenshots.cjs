/* Reproducible release screenshots from the real built application. */
const fs = require("node:fs");
const path = require("node:path");

const { chromium } = require(process.env.FL_PLAYWRIGHT_MODULE || "playwright");

const repoRoot = path.resolve(__dirname, "..");
const baseUrl = process.env.FL_WEB_URL || "http://127.0.0.1:8787";
const outputDir = path.join(repoRoot, "docs", "media");
const fixture = path.join(
  repoRoot,
  "tests",
  "fixtures",
  "nonstandard_tracking_user.csv",
);
const executablePath =
  process.env.FL_CHROMIUM_PATH ||
  [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].find((candidate) => fs.existsSync(candidate));

async function screenshotViewport(page, fileName) {
  await page.screenshot({
    animations: "disabled",
    path: path.join(outputDir, fileName),
    type: "png",
  });
}

async function assertNoLegacyBrand(page) {
  const body = await page.locator("body").innerText();
  if (body.includes("FulfillLens CN")) {
    throw new Error(`Legacy brand visible on ${page.url()}`);
  }
}

(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext({
    colorScheme: "light",
    deviceScaleFactor: 1,
    locale: "zh-CN",
    reducedMotion: "reduce",
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  try {
    await page.goto(`${baseUrl}/import`, { waitUntil: "networkidle" });
    await page.getByText("自动识别（推荐）", { exact: true }).waitFor();
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "自主上传文件" }).click();
    await (await chooserPromise).setFiles(fixture);
    await page.getByRole("button", { name: "浏览器本地读取并检查" }).click();
    await page.getByRole("heading", { name: "4. 数据预览" }).waitFor();
    await page.getByRole("button", { name: "下一步：字段映射" }).click();
    const mappingHeading = page.getByRole("heading", { name: "5. 快速导入" });
    await mappingHeading.waitFor();
    const recommended = page.getByRole("button", {
      name: /全部采用推荐映射（[1-9]\d*）/,
    });
    if ((await recommended.count()) > 0 && (await recommended.isEnabled())) {
      await recommended.click();
    }
    const bulkIgnore = page.getByRole("button", {
      name: /一键忽略非必要字段（[1-9]\d*）/,
    });
    await bulkIgnore.waitFor();
    await bulkIgnore.scrollIntoViewIfNeeded();
    await bulkIgnore.click();
    await page
      .getByText("字段已准备好，可以开始分析", { exact: true })
      .waitFor();
    await mappingHeading.scrollIntoViewIfNeeded();
    await screenshotViewport(page, "import-mapping.png");

    await page.getByRole("button", { name: "开始分析" }).click();
    await page.getByRole("heading", { name: "分析总览" }).waitFor();

    const contextHeading = page.getByRole("heading", {
      name: "当前分析上下文",
    });
    await contextHeading.waitFor();
    await contextHeading.scrollIntoViewIfNeeded();
    await screenshotViewport(page, "dashboard-overview.png");

    const recommendationCard = page
      .locator(".ant-card")
      .filter({ has: page.getByText("行动建议", { exact: true }) })
      .first();
    await recommendationCard.waitFor();
    await recommendationCard.evaluate((element) =>
      element.scrollIntoView({ block: "start" }),
    );
    await screenshotViewport(page, "professional-action-plan.png");
    await recommendationCard.getByText("管理层简报", { exact: true }).click();
    await recommendationCard
      .getByText("最值得先处理的 3 件事", { exact: true })
      .waitFor();
    await recommendationCard.evaluate((element) =>
      element.scrollIntoView({ block: "start" }),
    );
    await screenshotViewport(page, "executive-brief.png");

    // Diagnostics and What-if require the linked order data supplied by a
    // deterministic teaching case. The browser-local tracking screenshot and
    // recommendations above remain evidence for the custom-file path.
    await page.goto(`${baseUrl}/cases`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /一键载入.*促销爆单/ }).click();
    await page.getByRole("button", { name: "确认载入案例" }).click();
    await page.getByText(/已成为当前分析上下文/).waitFor();

    await page.goto(`${baseUrl}/diagnostics`, { waitUntil: "networkidle" });
    await page.getByText("当前诊断上下文", { exact: true }).waitFor();
    const evidenceSection = page.getByText("诊断结果与可追溯证据", {
      exact: true,
    });
    await evidenceSection.waitFor();
    await evidenceSection.scrollIntoViewIfNeeded();
    await screenshotViewport(page, "diagnostics-trace.png");

    await page.goto(`${baseUrl}/scenarios`, { waitUntil: "networkidle" });
    const runButton = page.getByRole("button", { name: "保存并运行情景估算" });
    await runButton.waitFor();
    await runButton.click();
    const scenarioResult = page.locator(
      '[aria-label="情景估算结果与基线对比"]',
    );
    await scenarioResult.waitFor();
    await page.waitForTimeout(5_000);
    await scenarioResult.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "scenario-comparison.png"),
      type: "png",
    });

    await page.goto(`${baseUrl}/cases`, { waitUntil: "networkidle" });
    await page.getByText("稳定运营", { exact: false }).first().waitFor();
    await screenshotViewport(page, "teaching-cases.png");

    await assertNoLegacyBrand(page);
    const actionableErrors = consoleErrors.filter(
      (message) =>
        !message.includes("ResizeObserver loop") &&
        !message.includes("favicon.ico"),
    );
    if (actionableErrors.length > 0) {
      throw new Error(`Console errors: ${actionableErrors.join(" | ")}`);
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const files = fs
    .readdirSync(outputDir)
    .filter((file) => file.endsWith(".png"))
    .map((file) => ({
      bytes: fs.statSync(path.join(outputDir, file)).size,
      file,
    }));
  process.stdout.write(
    `${JSON.stringify({ base_url: baseUrl, files }, null, 2)}\n`,
  );
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
