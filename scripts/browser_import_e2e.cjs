/* Browser-level acceptance for the Cloudflare local-first import path. */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { chromium } = require(process.env.FL_PLAYWRIGHT_MODULE || "playwright");

const repoRoot = path.resolve(__dirname, "..");
const baseUrl = process.env.FL_WEB_URL || "http://127.0.0.1:8787";
const csvPath = path.join(
  repoRoot,
  "tests",
  "fixtures",
  "nonstandard_tracking_user.csv",
);
const xlsxPath = path.join(
  repoRoot,
  "data",
  "samples",
  "compatibility_demo_logistics.xlsx",
);
const executablePath =
  process.env.FL_CHROMIUM_PATH ||
  [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].find((candidate) => fs.existsSync(candidate));

function assertFixture(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing browser fixture: ${filePath}`);
  }
}

async function chooseDataType(page, label) {
  await page.getByText(label, { exact: true }).click();
}

async function chooseCustomFile(page, filePath) {
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "自主上传文件" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(filePath);
  await page.getByText(path.basename(filePath), { exact: true }).waitFor();
}

async function parseSelectedFile(page, sheetName) {
  await page.getByRole("button", { name: "浏览器本地读取并检查" }).click();
  if (sheetName) {
    await page.getByLabel("工作表").click();
    await page.getByText(sheetName, { exact: true }).last().click();
    await page.getByRole("button", { name: "解析并预览" }).click();
  }
  await page.getByRole("heading", { name: "4. 数据预览" }).waitFor();
}

async function confirmImport(page) {
  await page.getByRole("button", { name: "下一步：字段映射" }).click();
  await page.getByRole("heading", { name: "5. 字段映射" }).waitFor();
  await page.getByRole("button", { name: "运行质量校验" }).click();
  await page.getByText("校验通过，可以确认导入", { exact: true }).waitFor();
  await page.getByRole("button", { name: "下一步：确认导入" }).click();
  await page.getByRole("button", { name: "确认并生成可分析数据集" }).click();
  await page.getByText("数据已导入当前浏览器", { exact: true }).waitFor();
}

async function runImport(page, filePath, sheetName) {
  await page.goto(`${baseUrl}/import`, { waitUntil: "networkidle" });
  await chooseDataType(page, "物流轨迹表");
  await chooseCustomFile(page, filePath);
  await parseSelectedFile(page, sheetName);
  await confirmImport(page);
}

(async () => {
  assertFixture(csvPath);
  assertFixture(xlsxPath);
  const browser = await chromium.launch({ headless: true, executablePath });
  const consoleErrors = [];
  const requestFailures = [];
  const rawUploadRequests = [];
  const records = [];
  const invalidFile = path.join(os.tmpdir(), `fulfilllens-${Date.now()}.pdf`);
  fs.writeFileSync(invalidFile, "%PDF-1.4 synthetic invalid upload\n", "utf8");

  try {
    for (const width of [360, 390, 430]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
      });
      const page = await context.newPage();
      await page.goto(`${baseUrl}/import`, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "自主上传文件" }).waitFor();
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth + 1,
      );
      if (overflow) {
        throw new Error(`Import page overflows horizontally at ${width}px`);
      }
      records.push({ scenario: `mobile-${width}`, passed: true });
      await context.close();
    }

    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      acceptDownloads: true,
    });
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("requestfailed", (request) => {
      requestFailures.push(`${request.method()} ${request.url()}`);
    });
    page.on("request", (request) => {
      if (request.url().includes("/api/imports/upload")) {
        rawUploadRequests.push(`${request.method()} ${request.url()}`);
      }
    });

    await runImport(page, csvPath);
    records.push({ scenario: "nonstandard-csv", passed: true });
    await page.reload({ waitUntil: "networkidle" });
    await page.goto(`${baseUrl}/settings`, { waitUntil: "networkidle" });
    await page.getByText("浏览器本地导入", { exact: false }).first().waitFor();
    records.push({ scenario: "refresh-persistence", passed: true });

    await runImport(page, xlsxPath, "物流轨迹");
    records.push({ scenario: "multi-sheet-xlsx", passed: true });

    await page.goto(`${baseUrl}/import`, { waitUntil: "networkidle" });
    await chooseDataType(page, "物流轨迹表");
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "自主上传文件" }).click();
    await (await chooserPromise).setFiles(invalidFile);
    await page
      .getByText("仅支持 .csv 和 .xlsx 文件", { exact: false })
      .waitFor();
    records.push({ scenario: "invalid-file-rejected", passed: true });

    if (rawUploadRequests.length > 0) {
      throw new Error(
        `Raw custom file unexpectedly left the browser: ${rawUploadRequests.join(", ")}`,
      );
    }
    if (requestFailures.length > 0) {
      throw new Error(
        `Browser request failures: ${requestFailures.join(", ")}`,
      );
    }
    const actionableConsoleErrors = consoleErrors.filter(
      (message) =>
        !message.includes("ResizeObserver loop") &&
        !message.includes("favicon.ico"),
    );
    if (actionableConsoleErrors.length > 0) {
      throw new Error(
        `Browser console errors: ${actionableConsoleErrors.join(" | ")}`,
      );
    }
    await context.close();
  } finally {
    await browser.close();
    fs.rmSync(invalidFile, { force: true });
  }

  process.stdout.write(
    `${JSON.stringify({ base_url: baseUrl, records, raw_upload_requests: 0 }, null, 2)}\n`,
  );
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
