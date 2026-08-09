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
    await page.getByText("物流轨迹表", { exact: true }).click();
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "自主上传文件" }).click();
    await (await chooserPromise).setFiles(fixture);
    await page.getByRole("button", { name: "浏览器本地读取并检查" }).click();
    await page.getByRole("heading", { name: "4. 数据预览" }).waitFor();
    await page.getByRole("button", { name: "下一步：字段映射" }).click();
    const mappingHeading = page.getByRole("heading", { name: "5. 字段映射" });
    await mappingHeading.waitFor();
    const bulkIgnore = page.getByRole("button", {
      name: /一键忽略可忽略项（\d+）/,
    });
    await bulkIgnore.waitFor();
    await bulkIgnore.scrollIntoViewIfNeeded();
    await screenshotViewport(page, "import-mapping.png");

    await page.goto(`${baseUrl}/analytics`, { waitUntil: "networkidle" });
    const contextHeading = page.getByRole("heading", {
      name: "当前分析上下文",
    });
    await contextHeading.waitFor();
    await contextHeading.scrollIntoViewIfNeeded();
    await screenshotViewport(page, "dashboard-overview.png");

    await page.goto(`${baseUrl}/diagnostics`, { waitUntil: "networkidle" });
    await page.getByText("当前诊断上下文", { exact: true }).waitFor();
    const timelineButton = page
      .getByRole("button", { name: "查看时间线" })
      .first();
    await timelineButton.waitFor();
    await timelineButton.click();
    const orderDiagnosis = page.getByRole("heading", { name: "订单诊断" });
    await orderDiagnosis.waitFor();
    await orderDiagnosis.scrollIntoViewIfNeeded();
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
