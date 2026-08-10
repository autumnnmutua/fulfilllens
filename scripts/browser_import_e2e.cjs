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
const manualCsvPaths = [
  process.env.FL_MANUAL_CSV_1,
  process.env.FL_MANUAL_CSV_2,
].filter(Boolean);
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

async function assertPublicBrand(page) {
  const title = await page.title();
  const body = await page.locator("body").innerText();
  if (title !== "FulfillLens") {
    throw new Error(`Unexpected page title: ${title}`);
  }
  if (body.includes("FulfillLens CN")) {
    throw new Error("Legacy public brand remains visible in the application");
  }
}

async function chooseDataType(page, label) {
  await page.getByText(label, { exact: true }).click();
}

async function expandAdvancedFields(page) {
  const advanced = page.getByText(/高级字段设置（\d+ 个源字段）/);
  const table = page.locator(".mapping-table, .mapping-mobile-list");
  if ((await table.count()) === 0 || !(await table.first().isVisible())) {
    await advanced.click();
    await table.first().waitFor();
  }
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
  try {
    await page.getByRole("heading", { name: "4. 数据预览" }).waitFor();
  } catch (error) {
    const pageText = (await page.locator("body").innerText()).slice(-3000);
    throw new Error(
      `Import preview did not become ready. Visible page text:\n${pageText}`,
      { cause: error },
    );
  }
}

function mappingRow(page, text) {
  return page
    .locator(".mapping-table tbody tr, .mapping-mobile-card")
    .filter({ hasText: text })
    .first();
}

async function inspectMappingLayout(page, width) {
  await expandAdvancedFields(page);
  const selectInput = page.locator('[aria-label$="映射目标"]').first();
  const select = selectInput.locator(
    "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' ant-select ')][1]",
  );
  const selectBox = await select.boundingBox();
  const layoutContext = await select.evaluate((element) => {
    const widthOf = (candidate) =>
      candidate?.getBoundingClientRect().width ?? null;
    const control = element.closest(".mapping-target-control");
    const controlStyle = control ? getComputedStyle(control) : null;
    return {
      control: widthOf(control),
      field: widthOf(element.closest(".import-field")),
      cardBody: widthOf(element.closest(".ant-card-body")),
      controlStyle: controlStyle
        ? {
            boxSizing: controlStyle.boxSizing,
            display: controlStyle.display,
            gap: controlStyle.gap,
            margin: controlStyle.margin,
            maxWidth: controlStyle.maxWidth,
            padding: controlStyle.padding,
            width: controlStyle.width,
          }
        : null,
    };
  });
  // At 360 px the card's usable content width is 262 px; 220 px keeps the
  // control near full width after the intentional card and control padding.
  const minimum = width >= 768 ? 320 : 220;
  if (!selectBox || selectBox.width < minimum) {
    throw new Error(
      `Mapping target select is only ${selectBox?.width ?? 0}px wide at ${width}px: ${JSON.stringify(layoutContext)}`,
    );
  }
  await selectInput.click();
  const popupHandle = await page.waitForFunction(
    ({ popupSelector, inputSelector, minimumWidth }) => {
      const expanded = [...document.querySelectorAll(inputSelector)].some(
        (element) => element.getAttribute("aria-expanded") === "true",
      );
      const candidates = [...document.querySelectorAll(popupSelector)]
        .map((popup) => {
          const option = popup.querySelector(".ant-select-item-option-content");
          const popupBox = popup.getBoundingClientRect();
          const optionBox = option?.getBoundingClientRect();
          return {
            popupWidth: popupBox.width,
            optionHeight: optionBox?.height ?? 0,
            optionWidth: optionBox?.width ?? 0,
          };
        })
        .sort((left, right) => right.popupWidth - left.popupWidth);
      const shape = candidates[0];
      return expanded && shape?.popupWidth >= minimumWidth ? shape : false;
    },
    {
      inputSelector: '[aria-label$="映射目标"]',
      popupSelector: ".mapping-target-popup",
      minimumWidth: minimum,
    },
  );
  const popupShape = await popupHandle.jsonValue();
  await popupHandle.dispose();
  if (popupShape.popupWidth < minimum) {
    throw new Error(
      `Mapping dropdown is only ${popupShape.popupWidth}px wide at ${width}px`,
    );
  }
  if (popupShape.optionWidth < 180 || popupShape.optionHeight > 90) {
    throw new Error(
      `Mapping option text is abnormally compressed at ${width}px: ${JSON.stringify(popupShape)}`,
    );
  }
  await page.keyboard.press("Escape");
}

async function ignoreSource(page, source) {
  await expandAdvancedFields(page);
  const row = mappingRow(page, source);
  const ignoreButton = row.getByRole("button", { name: /^忽\s*略$/ });
  if ((await ignoreButton.count()) === 0) {
    const visibleRows = await page
      .locator(".mapping-table tbody tr, .mapping-mobile-card")
      .allTextContents();
    throw new Error(
      `Cannot find ignore action for ${source}: ${JSON.stringify(visibleRows)}`,
    );
  }
  await ignoreButton.click();
  await row.getByText("Ignored", { exact: true }).waitFor();
  return row;
}

async function resolveMapping(page, options = {}) {
  let groupedConfirmations = 0;
  let ignoredCount = 0;
  const recommended = page.getByRole("button", {
    name: /全部采用推荐映射（[1-9]\d*）/,
  });
  if ((await recommended.count()) > 0 && (await recommended.isEnabled())) {
    groupedConfirmations = 1;
    await recommended.click();
    await page.getByText(/已应用 \d+ 个推荐映射/).waitFor();
  }
  if ((await page.getByRole("button", { name: "确认建议" }).count()) > 0) {
    throw new Error(
      "Beginner import unexpectedly requires per-field confirmation",
    );
  }
  if (options.bulkIgnore) {
    const bulkButton = page.getByRole("button", {
      name: /一键忽略非必要字段（[1-9]\d*）/,
    });
    const label = (await bulkButton.textContent()) || "";
    ignoredCount = Number(label.match(/（(\d+)）/)?.[1] || 0);
    await bulkButton.click();
    await page.getByText(/已忽略 \d+ 个非分析字段/).waitFor();
    await page.getByRole("button", { name: "撤销本次忽略" }).click();
    await page
      .getByRole("button", { name: /一键忽略非必要字段（[1-9]\d*）/ })
      .click();
  }
  if (options.ignoreSource) {
    const row = await ignoreSource(page, options.ignoreSource);
    await row.getByRole("button", { name: "取消忽略并重新映射" }).click();
    await row.getByText("Unresolved", { exact: true }).waitFor();
    await row.getByRole("button", { name: /^忽\s*略$/ }).click();
    await row.getByText("Ignored", { exact: true }).waitFor();
  }
  await page.getByText(/还有 \d+ 个字段待处理/).waitFor({ state: "detached" });
  await page.getByText("字段已准备好，可以开始分析", { exact: true }).waitFor();
  const taskStatus = page.locator(".import-task-status");
  await taskStatus.getByText("可开始分析", { exact: true }).waitFor();
  if ((await taskStatus.getByText("待映射", { exact: true }).count()) > 0) {
    throw new Error("Import task status conflicts with the current readiness");
  }
  return { groupedConfirmations, ignoredCount };
}

async function openMapping(page, filePath, sheetName) {
  await page.goto(`${baseUrl}/import`, { waitUntil: "networkidle" });
  await assertPublicBrand(page);
  await page.getByText("自动识别（推荐）", { exact: true }).waitFor();
  await chooseCustomFile(page, filePath);
  await parseSelectedFile(page, sheetName);
  await page.getByText(/数据类型识别：物流轨迹数据/).waitFor();
  await page.getByRole("button", { name: "下一步：字段映射" }).click();
  await page.getByRole("heading", { name: "5. 快速导入" }).waitFor();
}

async function confirmImport(page, options = {}) {
  const mappingStats = await resolveMapping(page, options);
  await page.getByRole("button", { name: "运行质量校验" }).click();
  await page.getByText("校验通过，可以确认导入", { exact: true }).waitFor();
  await page.getByRole("button", { name: "下一步：确认导入" }).click();
  await page.getByRole("button", { name: "确认并生成可分析数据集" }).click();
  await page.getByText("数据已导入当前浏览器", { exact: true }).waitFor();
  return mappingStats;
}

async function runImport(page, filePath, sheetName) {
  await openMapping(page, filePath, sheetName);
  return confirmImport(page, {
    bulkIgnore: true,
  });
}

async function readLatestDataset(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("fulfilllens-cn-browser-data", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const query = database
            .transaction("datasets", "readonly")
            .objectStore("datasets")
            .getAll();
          query.onerror = () => reject(query.error);
          query.onsuccess = () => {
            const latest = [...query.result]
              .sort((left, right) =>
                String(left.createdAt).localeCompare(String(right.createdAt)),
              )
              .at(-1);
            database.close();
            resolve(latest ?? null);
          };
        };
      }),
  );
}

(async () => {
  assertFixture(csvPath);
  assertFixture(xlsxPath);
  manualCsvPaths.forEach(assertFixture);
  const browser = await chromium.launch({ headless: true, executablePath });
  const consoleErrors = [];
  const requestFailures = [];
  const rawUploadRequests = [];
  const records = [];
  const invalidFile = path.join(os.tmpdir(), `fulfilllens-${Date.now()}.pdf`);
  fs.writeFileSync(invalidFile, "%PDF-1.4 synthetic invalid upload\n", "utf8");

  try {
    for (const width of [360, 390, 430, 1366, 1440, 1920]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
      });
      const page = await context.newPage();
      await openMapping(page, csvPath);
      await inspectMappingLayout(page, width);
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth + 1,
      );
      if (overflow) {
        throw new Error(`Import page overflows horizontally at ${width}px`);
      }
      records.push({ scenario: `mapping-layout-${width}`, passed: true });
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
    const latestFixtureDataset = await readLatestDataset(page);
    const persisted = {
      ignored:
        latestFixtureDataset?.qualityReport?.ignored_source_columns ?? [],
      rowKeys: Object.keys(latestFixtureDataset?.rows?.[0] ?? {}),
    };
    if (
      !persisted.ignored.includes("无关说明") ||
      persisted.rowKeys.includes("无关说明")
    ) {
      throw new Error(
        `Ignored source leaked into dataset: ${JSON.stringify(persisted)}`,
      );
    }
    records.push({ scenario: "nonstandard-csv", passed: true });
    records.push({ scenario: "ignored-field-excluded", passed: true });
    await page.getByRole("link", { name: "前往分析总览" }).click();
    await page.getByRole("heading", { name: "分析总览" }).waitFor();
    try {
      await page.getByText("行动建议", { exact: true }).waitFor();
    } catch (error) {
      throw new Error(
        `Browser-local analytics did not render recommendations. Visible text:\n${(
          await page.locator("body").innerText()
        ).slice(-5000)}`,
        { cause: error },
      );
    }
    await page
      .getByRole("button", { name: "查看按时足量交付率（OTIF）定义" })
      .click();
    await page.getByText(/当前数据不足以计算 OTIF/).waitFor();
    await page.keyboard.press("Escape");
    await page.getByText("管理层简报", { exact: true }).click();
    await page.getByText("最值得先处理的 3 件事", { exact: true }).waitFor();
    records.push({
      scenario: "browser-local-analysis-recommendations",
      passed: true,
    });
    await page.goto(`${baseUrl}/diagnostics`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "异常诊断" }).waitFor();
    await page
      .getByText(/只有事件数据/)
      .first()
      .waitFor();
    records.push({ scenario: "browser-local-diagnostics", passed: true });
    await page.goto(`${baseUrl}/reports`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "生成预览" }).click();
    await page
      .getByText("两种视图使用同一组分析事实", { exact: true })
      .waitFor();
    await page.getByText("管理层简报", { exact: true }).last().click();
    await page
      .getByText(/当前共形成 \d+ 项有数据依据的行动建议/)
      .last()
      .waitFor();
    records.push({
      scenario: "browser-local-report-recommendations",
      passed: true,
    });
    await page.reload({ waitUntil: "networkidle" });
    await page.goto(`${baseUrl}/settings`, { waitUntil: "networkidle" });
    await page.getByText("浏览器本地导入", { exact: false }).first().waitFor();
    records.push({ scenario: "refresh-persistence", passed: true });

    await runImport(page, xlsxPath, "物流轨迹");
    records.push({ scenario: "multi-sheet-xlsx", passed: true });

    for (const [index, manualPath] of manualCsvPaths.entries()) {
      const mappingStats = await runImport(page, manualPath);
      const dataset = await readLatestDataset(page);
      if (!dataset)
        throw new Error(`Manual CSV ${index + 1} was not persisted`);
      const quality = dataset.qualityReport;
      const rows = dataset.rows;
      const blockers = quality.issues.filter(
        (issue) => issue.severity === "error",
      ).length;
      const fieldConfirmations = await page
        .getByRole("button", { name: "确认建议" })
        .count();
      if (rows.length !== quality.total_rows || blockers !== 0) {
        throw new Error(
          `Manual CSV ${index + 1} lost rows or retained blockers: ${JSON.stringify({ blockers, imported: rows.length, total: quality.total_rows })}`,
        );
      }
      const unique = (field) =>
        new Set(rows.map((row) => row[field]).filter(Boolean)).size;
      records.push({
        scenario: `manual-nonstandard-csv-${index + 1}`,
        passed: true,
        file: path.basename(manualPath),
        detected_type: dataset.dataType,
        parsed_rows: quality.total_rows,
        imported_rows: rows.length,
        silent_dropped_rows: quality.total_rows - rows.length,
        shipments: unique("shipment_id"),
        orders: unique("order_id"),
        carriers: unique("carrier_id"),
        mapped_or_generated_fields: quality.field_resolutions.filter((item) =>
          ["mapped", "generated", "inferred"].includes(item.status),
        ).length,
        ignored_fields: quality.ignored_source_columns.length,
        unresolved_fields: quality.unresolved_source_columns.length,
        blocking_issues: blockers,
        invalid_times: quality.invalid_times,
        unknown_statuses: quality.unknown_statuses,
        grouped_confirmations: mappingStats.groupedConfirmations,
        field_confirmations: fieldConfirmations,
      });
      await page.goto(`${baseUrl}/analytics`, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: "分析总览" }).waitFor();
      await page.getByText("平均首末轨迹时效", { exact: true }).waitFor();
      await page.getByText("专业行动方案", { exact: true }).waitFor();
      await page.getByText("管理层简报", { exact: true }).click();
      await page.getByText("最值得先处理的 3 件事", { exact: true }).waitFor();
      await page.goto(`${baseUrl}/diagnostics`, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: "异常诊断" }).waitFor();
      await page.goto(`${baseUrl}/reports`, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "生成预览" }).click();
      await page
        .getByText("两种视图使用同一组分析事实", { exact: true })
        .waitFor();
    }

    await openMapping(page, csvPath);
    await resolveMapping(page, { ignoreSource: "无关说明" });
    await ignoreSource(page, "订单号");
    await page.getByRole("button", { name: "运行质量校验" }).click();
    await page
      .getByText("存在阻断错误，暂不能确认导入", { exact: true })
      .waitFor();
    await page
      .getByText(/order_id/)
      .first()
      .waitFor();
    records.push({ scenario: "required-field-ignore-blocked", passed: true });

    await page.goto(`${baseUrl}/import`, { waitUntil: "networkidle" });
    await chooseDataType(page, "物流轨迹数据");
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
