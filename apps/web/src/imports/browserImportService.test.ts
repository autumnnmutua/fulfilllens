import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { readBrowserDataset } from "./browserDatasetStore";
import { browserImportService } from "./browserImportService";
import { getImportContract } from "./contracts";
import { findSafelyIgnorableColumns, suggestMappings } from "./mapping";
import {
  BrowserImportError,
  MAX_IMPORT_BYTES,
  detectCsvEncoding,
  inspectWorkbook,
  parseCsvFile,
  parseWorkbookSheet,
  validateFileBasics,
} from "./parser";
import { inferDateOrder, parseImportDateValue } from "./dateParser";
import { parseImportDate } from "./validation";

function fixture(relativePath: string, name: string, type: string): File {
  const bytes = readFileSync(resolve(process.cwd(), "..", "..", relativePath));
  const content = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  return new File([content], name, { type });
}

function csvFile(content: string, name = "user-export.csv"): File {
  return new File([content], name, { type: "text/csv" });
}

function mappingFrom(
  suggestions: Awaited<
    ReturnType<typeof browserImportService.parse>
  >["suggestions"],
): Record<string, string | null> {
  return Object.fromEntries(
    suggestions.map((suggestion) => [
      suggestion.source_column,
      suggestion.suggested_field ?? null,
    ]),
  );
}

function ignoredFrom(
  suggestions: Awaited<
    ReturnType<typeof browserImportService.parse>
  >["suggestions"],
): string[] {
  return suggestions
    .filter((suggestion) => suggestion.suggested_field === null)
    .map((suggestion) => suggestion.source_column);
}

describe("浏览器本地 CSV/XLSX 导入", () => {
  it("真实走完非标准物流轨迹 CSV 的解析、映射、校验与确认", async () => {
    const selected = fixture(
      "tests/fixtures/nonstandard_tracking_user.csv",
      "完全不同的客户轨迹导出-202608.csv",
      "text/csv",
    );
    const uploaded = await browserImportService.upload(
      "tracking_events",
      selected,
    );
    expect(uploaded.task.processing_location).toBe("browser");
    expect(uploaded.task.encoding).toBe("utf-8");

    const parsed = await browserImportService.parse(uploaded.task.task_id, {});
    expect(parsed.total_rows).toBe(12);
    expect(parsed.detected_data_type).toBe("tracking_events");
    expect(
      parsed.suggestions.find(
        (suggestion) => suggestion.source_column === "快递单号",
      ),
    ).toMatchObject({ method: "Alias", suggested_field: "shipment_id" });
    expect(parsed.unmapped_source_columns).toContain("无关说明");

    const validated = await browserImportService.validate(
      uploaded.task.task_id,
      {
        default_timezone: "Asia/Shanghai",
        ignored_source_columns: ignoredFrom(parsed.suggestions),
        mapping: mappingFrom(parsed.suggestions),
        project_status_mappings: {},
      },
    );
    expect(validated.report).toMatchObject({
      can_confirm: true,
      error_rows: 0,
      total_rows: 12,
      unknown_statuses: 0,
      valid_rows: 12,
    });
    expect(validated.report.ignored_source_columns).toEqual(["无关说明"]);
    expect(validated.report.unresolved_source_columns).toEqual([]);
    expect(validated.normalized_preview[0]).toMatchObject({
      event_code: "shipment_created",
      shipment_id: "SYN-WB-0001",
      tracking_event_id: "SYN-TE-0001-01",
    });

    const confirmed = await browserImportService.confirm(uploaded.task.task_id);
    expect(confirmed.dataset_id).toMatch(/^browser-local-/);
    expect(confirmed.imported_rows).toBe(12);
    const stored = await readBrowserDataset(confirmed.dataset_id);
    expect(stored?.rows).toHaveLength(12);
    expect(stored?.rows[0]).not.toHaveProperty("无关说明");
  });

  it("以任意文件名读取多工作表非标准 XLSX 并保护前导零和 Excel 日期", async () => {
    const selected = fixture(
      "data/samples/compatibility_demo_logistics.xlsx",
      "客户TMS导出_任意文件名.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    const uploaded = await browserImportService.upload(
      "tracking_events",
      selected,
    );
    expect(uploaded.task.status).toBe("awaiting_sheet");
    expect(uploaded.task.sheets.map((sheet) => sheet.name)).toEqual([
      "订单数据",
      "仓库事件",
      "物流轨迹",
    ]);

    const parsed = await browserImportService.parse(uploaded.task.task_id, {
      sheet_name: "物流轨迹",
    });
    expect(parsed.total_rows).toBe(36);
    expect(parsed.task.selected_sheet).toBe("物流轨迹");
    expect(parsed.warnings.join(" ")).toMatch(/Excel 日期/);
    expect(parsed.preview_rows[0]?.values.waybillNo).toBe("SHP-SYN-0001");
    expect(
      findSafelyIgnorableColumns(
        parsed.suggestions,
        mappingFrom(parsed.suggestions),
        [],
        getImportContract("tracking_events"),
      ),
    ).toContain("附加备注");

    const validated = await browserImportService.validate(
      uploaded.task.task_id,
      {
        default_timezone: "Asia/Shanghai",
        ignored_source_columns: ignoredFrom(parsed.suggestions),
        mapping: mappingFrom(parsed.suggestions),
        project_status_mappings: {},
      },
    );
    expect(validated.report.can_confirm).toBe(true);
    expect(validated.report.valid_rows).toBe(36);
    expect(validated.report.time_order_conflicts).toBe(0);
  });

  it("支持 UTF-8 BOM、引号内逗号、CRLF、LF 和引号内换行", async () => {
    const content =
      "\uFEFF订单号,下单时间,订单数量,单位,订单状态,备注\r\n" +
      'SYN-001,2026-08-01 08:00,10,件,已签收,"包含,逗号\n以及换行"\r\n';
    const selected = csvFile(content, "mixed-lines.csv");
    await expect(detectCsvEncoding(selected)).resolves.toEqual({
      encoding: "utf-8-sig",
      options: [],
    });
    const table = await parseCsvFile(selected, "utf-8-sig");
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.values.备注).toBe("包含,逗号\n以及换行");
  });

  it.each(["gbk", "gb18030"])("允许用户明确选择 %s 编码", async (encoding) => {
    const base64 =
      "tqm1pbrFLLaptaXXtMysLM/CtaXKsbzkLLaptaXK/cG/LLWlzrsKU1lOLUdCSy0wMSzS0cepytUsMjAyNi0wOC0wMSAwODowMCwxMCy8/go=";
    const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
    const selected = new File([bytes], `${encoding}.csv`, { type: "text/csv" });
    await expect(detectCsvEncoding(selected)).resolves.toEqual({
      encoding: null,
      options: ["gb18030", "gbk"],
    });
    const table = await parseCsvFile(selected, encoding);
    expect(table.headers).toContain("订单号");
    expect(table.rows[0]?.values.订单号).toBe("SYN-GBK-01");
  });

  it("陌生表头可由内容画像识别时间和状态，其余字段仍可人工映射", async () => {
    const selected = csvFile(
      "a1,b2,c3,d4,e5,f6,g7\nTE-01,ORD-01,WB-01,2026-08-01 08:00,已揽件,CAR-A,HUB-A\n",
      "opaque-columns.csv",
    );
    const uploaded = await browserImportService.upload(
      "tracking_events",
      selected,
    );
    const parsed = await browserImportService.parse(uploaded.task.task_id, {});
    expect(
      parsed.suggestions.find((item) => item.source_column === "d4"),
    ).toMatchObject({
      suggested_field: "event_time",
      confidence_level: "high",
    });
    expect(
      parsed.suggestions.find((item) => item.source_column === "e5"),
    ).toMatchObject({
      suggested_field: "raw_status",
      confidence_level: "high",
    });
    expect(
      parsed.suggestions
        .filter((item) => !["d4", "e5"].includes(item.source_column))
        .every((item) => item.suggested_field === null),
    ).toBe(true);
    const manual = {
      a1: "tracking_event_id",
      b2: "order_id",
      c3: "shipment_id",
      d4: "event_time",
      e5: "raw_status",
      f6: "carrier_id",
      g7: "location_code",
    };
    const validated = await browserImportService.validate(
      uploaded.task.task_id,
      {
        default_timezone: "Asia/Shanghai",
        mapping: manual,
        project_status_mappings: {},
      },
    );
    expect(validated.report.can_confirm).toBe(true);
    expect(validated.normalized_preview[0]?.event_code).toBe(
      "carrier_picked_up",
    );
  });

  it("缺失必填字段和未知状态分别按错误与 unmapped 报告", async () => {
    const selected = csvFile(
      "轨迹记录ID,订单号,快递单号,操作时间,轨迹状态,快递公司\nTE-01,ORD-01,WB-01,2026-08-01 08:00,自定义未知节点,CAR-A\n",
    );
    const uploaded = await browserImportService.upload(
      "tracking_events",
      selected,
    );
    const parsed = await browserImportService.parse(uploaded.task.task_id, {});
    const complete = mappingFrom(parsed.suggestions);
    const valid = await browserImportService.validate(uploaded.task.task_id, {
      default_timezone: "Asia/Shanghai",
      mapping: complete,
      project_status_mappings: {},
    });
    expect(valid.report.can_confirm).toBe(true);
    expect(valid.report.unknown_statuses).toBe(1);
    expect(valid.normalized_preview[0]?.event_code).toBe("unmapped");

    complete["快递公司"] = null;
    const missing = await browserImportService.validate(uploaded.task.task_id, {
      default_timezone: "Asia/Shanghai",
      mapping: complete,
      project_status_mappings: {},
    });
    expect(missing.report.can_confirm).toBe(false);
    expect(
      missing.report.issues.some(
        (issue) => issue.code === "INVALID_FIELD_MAPPING",
      ),
    ).toBe(true);
  });

  it("明确区分 ignored 与 unresolved，且忽略唯一必填源字段不能绕过 Schema", async () => {
    const selected = csvFile(
      "轨迹记录ID,订单号,快递单号,操作时间,轨迹状态,carrier_id,客服备注\nTE-01,ORD-01,WB-01,2026-08-01 08:00,已揽件,CAR-01,无需分析\n",
      "ignored-fields.csv",
    );
    const uploaded = await browserImportService.upload(
      "tracking_events",
      selected,
    );
    const parsed = await browserImportService.parse(uploaded.task.task_id, {});
    const mapping = mappingFrom(parsed.suggestions);

    const unresolved = await browserImportService.validate(
      uploaded.task.task_id,
      {
        default_timezone: "Asia/Shanghai",
        mapping,
        project_status_mappings: {},
      },
    );
    expect(unresolved.report.can_confirm).toBe(false);
    expect(unresolved.report.unresolved_source_columns).toEqual(["客服备注"]);
    expect(unresolved.report.ignored_source_columns).toEqual([]);

    const ignored = await browserImportService.validate(uploaded.task.task_id, {
      default_timezone: "Asia/Shanghai",
      ignored_source_columns: ["客服备注"],
      mapping,
      project_status_mappings: {},
    });
    expect(ignored.report.can_confirm).toBe(true);
    expect(ignored.report.ignored_source_columns).toEqual(["客服备注"]);
    expect(ignored.normalized_preview[0]).not.toHaveProperty("客服备注");
    expect(
      ignored.report.issues.some((issue) => issue.source_column === "客服备注"),
    ).toBe(false);
    expect(
      ignored.report.field_resolutions.find(
        (resolution) => resolution.source_column === "客服备注",
      )?.status,
    ).toBe("ignored");

    const orderSource = parsed.suggestions.find(
      (suggestion) => suggestion.suggested_field === "order_id",
    )?.source_column;
    expect(orderSource).toBe("订单号");
    const withoutOrder = { ...mapping, [orderSource as string]: null };
    const requiredIgnored = await browserImportService.validate(
      uploaded.task.task_id,
      {
        default_timezone: "Asia/Shanghai",
        ignored_source_columns: ["客服备注", orderSource as string],
        mapping: withoutOrder,
        project_status_mappings: {},
      },
    );
    expect(requiredIgnored.report.can_confirm).toBe(false);
    expect(
      requiredIgnored.report.issues.some(
        (issue) =>
          issue.code === "MISSING_REQUIRED_MAPPING" &&
          issue.message.includes("order_id"),
      ),
    ).toBe(true);
    expect(
      requiredIgnored.report.field_resolutions.some(
        (resolution) =>
          resolution.status === "blocking" &&
          resolution.target_field === "order_id",
      ),
    ).toBe(true);
  });

  it("camelCase、snake_case、中英文别名和人工方式均可解释", () => {
    const contract = getImportContract("tracking_events");
    const suggestions = suggestMappings(
      [
        "tracking_event_id",
        "trackingNumber",
        "Order ID",
        "操作时间",
        "tracking_status",
        "courierCode",
      ],
      contract,
    );
    expect(suggestions.map((item) => item.suggested_field)).toEqual([
      "tracking_event_id",
      "shipment_id",
      "order_id",
      "event_time",
      "raw_status",
      "carrier_id",
    ]);
    expect(suggestions[0]?.method).toBe("Exact");
    expect(suggestions[1]?.method).toBe("Alias");
    expect(suggestions[3]?.method).toBe("Alias");
  });

  it("泛化识别括号补充字段并安全筛选可批量忽略列", () => {
    const contract = getImportContract("tracking_events");
    const columns = [
      "业务交易键",
      "跟单参考",
      "发生时刻(原串)",
      "扫描结果",
      "承运单位",
      "异常标注",
      "export_line",
      "场站/网点",
      "批次流水",
      "系统老码",
      "签收回传",
      "客户备注",
      "额外字段-营销",
    ];
    const rows = [
      {
        row_number: 2,
        values: Object.fromEntries(columns.map((column) => [column, "A"])),
      },
      {
        row_number: 3,
        values: Object.fromEntries(columns.map((column) => [column, "A"])),
      },
    ];
    const suggestions = suggestMappings(columns, contract, rows);
    const bySource = Object.fromEntries(
      suggestions.map((suggestion) => [suggestion.source_column, suggestion]),
    );
    expect(bySource["业务交易键"]?.suggested_field).toBe("order_id");
    expect(bySource["跟单参考"]?.suggested_field).toBe("shipment_id");
    expect(bySource["发生时刻(原串)"]?.suggested_field).toBe("event_time");
    expect(bySource["扫描结果"]?.suggested_field).toBe("raw_status");
    expect(bySource["承运单位"]?.suggested_field).toBe("carrier_id");
    expect(bySource["异常标注"]?.suggested_field).toBe("exception_code");
    expect(bySource.export_line?.suggested_field).toBe("sequence_number");
    expect(bySource["场站/网点"]?.suggested_field).toBe("location_code");
    expect(bySource["批次流水"]?.suggested_field).not.toBe("tracking_event_id");

    const mapping = mappingFrom(suggestions);
    const safe = findSafelyIgnorableColumns(suggestions, mapping, [], contract);
    expect(safe).toEqual(
      expect.arrayContaining(["批次流水", "客户备注", "额外字段-营销"]),
    );
    expect(safe).not.toEqual(expect.arrayContaining(["系统老码", "签收回传"]));
  });

  it("自动识别物流轨迹 Schema，并用画像和关系处理第二套陌生表头", async () => {
    const content =
      "row_key,物流合作方,运输动态描述,发生记录时间,节点作业地点,包裹凭据号,客户业务关联码,历史状态枚举,签收反馈,调试标签\n" +
      "E-001,承运商甲,货物已交接,14-Aug-2026 08:32,南京中转中心,SHP-01,ORD-01,COLLECT_OK,no-pod,debug-a\n" +
      "E-002,承运商甲,干线在途定位,17 Aug 2026 09:44,上海分拨中心,SHP-01,ORD-01,GEO_IN_TRANSIT,no-pod,debug-b\n" +
      "E-003,承运商甲,客户签收确认,Tue 19 Aug 2026 08:11,杭州末端站,SHP-01,ORD-01,CUSTOMER_ACCEPT,ack:customer,debug-c\n";
    const uploaded = await browserImportService.upload(
      "auto",
      csvFile(content, "任意客户导出.csv"),
    );
    const parsed = await browserImportService.parse(uploaded.task.task_id, {});
    expect(parsed).toMatchObject({
      detected_data_type: "tracking_events",
      schema_selection_mode: "auto",
      selected_data_type: "tracking_events",
      total_rows: 3,
    });
    const bySource = Object.fromEntries(
      parsed.suggestions.map((item) => [item.source_column, item]),
    );
    expect(bySource["发生记录时间"]).toMatchObject({
      suggested_field: "event_time",
      confidence_level: "high",
    });
    expect(bySource["运输动态描述"]?.suggested_field).toBe("raw_status");
    expect(bySource["包裹凭据号"]?.suggested_field).toBe("shipment_id");
    expect(bySource["客户业务关联码"]?.suggested_field).toBe("order_id");
    expect(bySource["历史状态枚举"]?.auxiliary_purpose).toBe(
      "legacy_status_code",
    );
    expect(bySource["签收反馈"]?.auxiliary_purpose).toBe(
      "delivery_confirmation",
    );
  });

  it.each([
    ["2026.07.02 06:35", "2026-07-02T06:35:00+08:00"],
    ["2026/7/3 14:17", "2026-07-03T14:17:00+08:00"],
    ["2026年07月06日 08:05", "2026-07-06T08:05:00+08:00"],
    [
      "Tue Jul 07 2026 18:20:00 GMT+0800 (中国标准时间)",
      "2026-07-07T18:20:00+08:00",
    ],
    ["7/2/2026 11:46 AM", "2026-07-02T11:46:00+08:00"],
    ["2026-07-03T07:52+08:00", "2026-07-03T07:52:00+08:00"],
    ["7-7-2026 11:40", "2026-07-07T11:40:00+08:00"],
    ["04-07-2026 22:15", "2026-07-04T22:15:00+08:00"],
    ["02-07-2026 13:42", "2026-07-02T13:42:00+08:00"],
  ])("确定性解析时间 %s", (source, expected) => {
    expect(parseImportDate(source, "Asia/Shanghai")).toBe(expected);
  });

  it("缺少真实事件 ID 时生成稳定唯一 ID，并综合原状态和辅助码", async () => {
    const content =
      "业务交易键,跟单参考,发生时刻(原串),扫描结果,承运单位,异常标注,export_line,场站/网点,系统老码,客户备注\n" +
      "ORD-01,SHP-01,2026.07.02 06:35,运输中 | Linehaul,CAR-01,0,1,HUB-A,HUB_ARR,忽略我\n" +
      "ORD-01,SHP-01,Tue Jul 07 2026 18:20:00 GMT+0800 (中国标准时间),妥投(POD),CAR-01,WEATHER_DELAY,2,HUB-B,POD_OK,忽略我\n";
    const uploaded = await browserImportService.upload(
      "tracking_events",
      csvFile(content, "arbitrary-export.csv"),
    );
    const parsed = await browserImportService.parse(uploaded.task.task_id, {});
    expect(parsed.detected_data_type).toBe("tracking_events");
    const mapping = mappingFrom(parsed.suggestions);
    const ignored = ignoredFrom(parsed.suggestions);
    const first = await browserImportService.validate(uploaded.task.task_id, {
      default_timezone: "Asia/Shanghai",
      ignored_source_columns: ignored,
      mapping,
      project_status_mappings: {},
    });
    const second = await browserImportService.validate(uploaded.task.task_id, {
      default_timezone: "Asia/Shanghai",
      ignored_source_columns: ignored,
      mapping,
      project_status_mappings: {},
    });
    expect(first.report.can_confirm).toBe(true);
    expect(first.normalized_preview).toHaveLength(2);
    expect(first.normalized_preview[0]?.tracking_event_id).toMatch(
      /^TRE-GEN-000002-[0-9A-F]{8}$/,
    );
    expect(first.normalized_preview[0]?.event_code).toBe("in_transit");
    expect(first.normalized_preview[1]?.event_code).toBe("delivered");
    expect(first.normalized_preview[0]?.tracking_event_id).not.toBe(
      first.normalized_preview[1]?.tracking_event_id,
    );
    expect(second.normalized_preview).toEqual(first.normalized_preview);
    expect(first.normalized_preview[0]).not.toHaveProperty("客户备注");
    expect(first.normalized_preview[0]?.exception_code).toBeNull();
    expect(first.normalized_preview[1]?.exception_code).toBe("WEATHER_DELAY");
  });

  it("无 AM/PM 的模糊斜杠日期要求一次文件级确认", () => {
    expect(() => parseImportDate("7/2/2026 11:46", "Asia/Shanghai")).toThrow(
      /日\/月顺序歧义/,
    );
  });

  it.each([
    ["07/07/2026 09:30", "DMY", "2026-07-07T09:30:00+08:00", "minute"],
    ["2026年8月15日", null, "2026-08-15", "date"],
    ["14 Aug 2026", null, "2026-08-14", "date"],
    ["14-Aug-2026 08:32", null, "2026-08-14T08:32:00+08:00", "minute"],
    ["17 Aug 2026 09:44", null, "2026-08-17T09:44:00+08:00", "minute"],
    ["Tue 19 Aug 2026 08:11", null, "2026-08-19T08:11:00+08:00", "minute"],
    ["13 Aug 2026, 10:08", null, "2026-08-13T10:08:00+08:00", "minute"],
    ["Sat, 15 Aug 2026 04:50", null, "2026-08-15T04:50:00+08:00", "minute"],
    ["22-08-2026 09:22", null, "2026-08-22T09:22:00+08:00", "minute"],
    ["2026-08-14T16:26:08+08:00", null, "2026-08-14T16:26:08+08:00", "second"],
    ["17/08/2026", "DMY", "2026-08-17", "date"],
  ] as const)(
    "统一日期解析器保留 %s 的精度",
    (source, order, iso, precision) => {
      expect(parseImportDateValue(source, "Asia/Shanghai", order)).toEqual({
        iso,
        precision,
      });
    },
  );

  it("按整列证据推断日期顺序，无法判断时只返回一次歧义", () => {
    expect(inferDateOrder(["17/08/2026", "07/07/2026"])).toMatchObject({
      ambiguous: false,
      order: "DMY",
    });
    expect(inferDateOrder(["07/08/2026", "08/09/2026"])).toMatchObject({
      ambiguous: true,
      order: null,
    });
  });

  it("无效日期不会被静默纠正", () => {
    expect(() => parseImportDateValue("2026-02-31", "Asia/Shanghai")).toThrow(
      /无法可靠解析/,
    );
  });

  it("解析多工作表时不忽略其他工作表，只有用户选择后读取数据", async () => {
    const selected = fixture(
      "data/samples/compatibility_demo_logistics.xlsx",
      "multi.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    const workbook = await inspectWorkbook(selected);
    expect(workbook.sheets).toHaveLength(3);
    expect(parseWorkbookSheet(workbook, "订单数据").rows).toHaveLength(6);
    expect(parseWorkbookSheet(workbook, "仓库事件").rows).toHaveLength(36);
    expect(parseWorkbookSheet(workbook, "物流轨迹").rows).toHaveLength(36);
  });

  it("按 Excel 零填充显示格式保护数字型业务 ID 的前导零", () => {
    const encode = (value: string) => new TextEncoder().encode(value);
    const workbook = {
      date1904: false,
      entries: {
        "xl/styles.xml": encode(
          '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="165" formatCode="00000000"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="165"/></cellXfs></styleSheet>',
        ),
        "xl/worksheets/sheet1.xml": encode(
          '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>订单编号</t></is></c></row><row r="2"><c r="A2" s="1"><v>1234</v></c></row></sheetData></worksheet>',
        ),
      },
      sheets: [
        { name: "订单", path: "xl/worksheets/sheet1.xml", state: "visible" },
      ],
      warnings: [],
    };
    const table = parseWorkbookSheet(workbook, "订单");
    expect(table.rows[0]?.values.订单编号).toBe("00001234");
  });

  it("在解析前拒绝非法扩展名和超过 10 MiB 的文件", () => {
    expect(() =>
      validateFileBasics(
        new File(["%PDF"], "report.pdf", { type: "application/pdf" }),
      ),
    ).toThrowError(BrowserImportError);
    expect(() =>
      validateFileBasics(
        new File([new Uint8Array(MAX_IMPORT_BYTES + 1)], "huge.csv", {
          type: "text/csv",
        }),
      ),
    ).toThrow(/10 MiB/);
  });
});
