import { unzipSync } from "fflate";

import type { PreviewRow, SheetInfo } from "../types/imports";
import { scalarText } from "./scalar";

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 50_000;
export const MAX_IMPORT_COLUMNS = 200;
const MAX_CSV_FIELD_CHARS = 1_048_576;
const MAX_XLSX_ENTRIES = 512;
const MAX_XLSX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;

export interface BrowserParseIssue {
  code: string;
  message: string;
  rawValue?: string | null;
  rowNumber?: number | null;
  severity: "error" | "warning";
  sourceColumn?: string | null;
  suggestion: string;
}

export interface BrowserParsedTable {
  headers: string[];
  issues: BrowserParseIssue[];
  rows: PreviewRow[];
  sheetName: string | null;
  warnings: string[];
}

export interface WorkbookInspection {
  date1904: boolean;
  entries: Record<string, Uint8Array>;
  sheets: Array<SheetInfo & { path: string }>;
  warnings: string[];
}

export class BrowserImportError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 422) {
    super(message);
    this.name = "BrowserImportError";
    this.code = code;
    this.status = status;
  }
}

function extension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot < 0 ? "" : fileName.slice(dot).toLocaleLowerCase("en-US");
}

export function validateFileBasics(file: File): "csv" | "xlsx" {
  const fileExtension = extension(file.name);
  if (fileExtension !== ".csv" && fileExtension !== ".xlsx") {
    throw new BrowserImportError(
      "UNSUPPORTED_FILE_TYPE",
      "仅支持 .csv 和 .xlsx 文件；PDF、DOCX、ZIP、图片及可执行文件不能进入导入流程。",
      415,
    );
  }
  if (file.size <= 0) {
    throw new BrowserImportError("EMPTY_FILE", "文件为空，无法导入。", 400);
  }
  if (file.size > MAX_IMPORT_BYTES) {
    throw new BrowserImportError(
      "UPLOAD_TOO_LARGE",
      "文件超过 10 MiB 浏览器安全上限，请拆分后重试。",
      413,
    );
  }
  const allowedMime =
    fileExtension === ".csv"
      ? new Set([
          "",
          "text/csv",
          "application/csv",
          "text/plain",
          "application/vnd.ms-excel",
        ])
      : new Set([
          "",
          "application/octet-stream",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ]);
  if (file.type && !allowedMime.has(file.type.toLocaleLowerCase("en-US"))) {
    throw new BrowserImportError(
      "MIME_TYPE_MISMATCH",
      "浏览器报告的文件类型与扩展名不一致，已在解析前阻止。",
      415,
    );
  }
  return fileExtension === ".csv" ? "csv" : "xlsx";
}

export async function validateFileSignature(
  file: File,
  format: "csv" | "xlsx",
): Promise<void> {
  const bytes = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  if (format === "xlsx") {
    if (
      bytes.length < 4 ||
      bytes[0] !== 0x50 ||
      bytes[1] !== 0x4b ||
      ![0x03, 0x05, 0x07].includes(bytes[2] ?? -1) ||
      ![0x04, 0x06, 0x08].includes(bytes[3] ?? -1)
    ) {
      throw new BrowserImportError(
        "XLSX_SIGNATURE_MISMATCH",
        "文件扩展名为 .xlsx，但内容不是有效的 Office Open XML 工作簿。",
        415,
      );
    }
    return;
  }
  const prefix = new TextDecoder("latin1").decode(bytes.slice(0, 8));
  if (
    prefix.startsWith("%PDF") ||
    prefix.startsWith("PK\u0003\u0004") ||
    prefix.startsWith("MZ")
  ) {
    throw new BrowserImportError(
      "CSV_SIGNATURE_MISMATCH",
      "文件扩展名为 .csv，但内容像 PDF、ZIP/XLSX 或可执行文件。",
      415,
    );
  }
  if (bytes.includes(0)) {
    throw new BrowserImportError(
      "BINARY_FILE_REJECTED",
      "CSV 检测到二进制内容，已在解析前阻止。",
      415,
    );
  }
}

export async function detectCsvEncoding(
  file: File,
): Promise<{ encoding: string | null; options: string[] }> {
  const bytes = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    return { encoding: "utf-8-sig", options: [] };
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { encoding: "utf-8", options: [] };
  } catch {
    try {
      new TextDecoder("gb18030", { fatal: true }).decode(bytes);
      return { encoding: null, options: ["gb18030", "gbk"] };
    } catch {
      throw new BrowserImportError(
        "CSV_ENCODING_UNRECOGNIZED",
        "CSV 无法按 UTF-8、GB18030 或 GBK 解码，请另存为受支持编码。",
      );
    }
  }
}

function canonicalEncoding(encoding: string): string {
  const normalized = encoding
    .trim()
    .toLocaleLowerCase("en-US")
    .replaceAll("_", "-");
  const aliases: Record<string, string> = {
    cp936: "gbk",
    gb2312: "gbk",
    utf8: "utf-8",
    "utf8-sig": "utf-8-sig",
  };
  const selected = aliases[normalized] ?? normalized;
  if (!["utf-8", "utf-8-sig", "gbk", "gb18030"].includes(selected)) {
    throw new BrowserImportError(
      "UNSUPPORTED_CSV_ENCODING",
      "CSV 编码仅支持 UTF-8、UTF-8 BOM、GB18030 和 GBK。",
    );
  }
  return selected;
}

function decodeCsv(bytes: Uint8Array, encoding: string): string {
  const selected = canonicalEncoding(encoding);
  try {
    const decoderEncoding = selected === "utf-8-sig" ? "utf-8" : selected;
    return new TextDecoder(decoderEncoding, { fatal: true }).decode(bytes);
  } catch {
    throw new BrowserImportError(
      "CSV_DECODING_FAILED",
      `文件无法按 ${selected} 严格解码，请选择其他编码。`,
    );
  }
}

function countDelimiter(sample: string, delimiter: string): number {
  let count = 0;
  let quoted = false;
  for (let index = 0; index < sample.length; index += 1) {
    const value = sample[index];
    if (value === '"') {
      if (quoted && sample[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && value === delimiter) count += 1;
  }
  return count;
}

function detectDelimiter(text: string): string {
  const sample = text.slice(0, 8192);
  return (
    [",", "\t", ";", "|"]
      .map((delimiter) => ({
        delimiter,
        score: countDelimiter(sample, delimiter),
      }))
      .sort((left, right) => right.score - left.score)[0]?.delimiter ?? ","
  );
}

interface CsvRow {
  line: number;
  values: string[];
}

function csvRows(text: string, delimiter: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let physicalLine = 1;
  let rowStartLine = 1;

  const appendRow = () => {
    row.push(field);
    rows.push({ line: rowStartLine, values: row });
    row = [];
    field = "";
    rowStartLine = physicalLine + 1;
  };

  for (let index = 0; index < text.length; index += 1) {
    const value = text[index] ?? "";
    if (quoted) {
      if (value === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += value;
        if (value === "\n") physicalLine += 1;
      }
      if (field.length > MAX_CSV_FIELD_CHARS) {
        throw new BrowserImportError(
          "CSV_FIELD_TOO_LONG",
          "CSV 单元格超过 1 MiB 字符安全上限。",
          413,
        );
      }
      continue;
    }
    if (value === '"' && field.length === 0) quoted = true;
    else if (value === delimiter) {
      row.push(field);
      field = "";
    } else if (value === "\r" || value === "\n") {
      if (value === "\r" && text[index + 1] === "\n") index += 1;
      appendRow();
      physicalLine += 1;
    } else field += value;
  }
  if (quoted) {
    throw new BrowserImportError(
      "CSV_PARSING_FAILED",
      "CSV 引号未闭合，请检查字段引号和换行。",
    );
  }
  if (field.length > 0 || row.length > 0) appendRow();
  return rows;
}

function validateHeaders(headers: string[]): void {
  if (headers.length === 0 || headers.every((header) => !header)) {
    throw new BrowserImportError(
      "MISSING_HEADER_ROW",
      "文件第一行必须包含字段名。",
    );
  }
  if (headers.some((header) => !header)) {
    throw new BrowserImportError(
      "EMPTY_COLUMN_NAME",
      "表头包含空列名，请补充名称。",
    );
  }
  const normalized = headers.map((header) => header.toLocaleLowerCase("zh-CN"));
  const duplicates = normalized.filter(
    (header, index) => normalized.indexOf(header) !== index,
  );
  if (duplicates.length > 0) {
    throw new BrowserImportError(
      "DUPLICATE_COLUMN_NAMES",
      "表头包含重复列名，必须先改为唯一名称。",
    );
  }
  if (headers.length > MAX_IMPORT_COLUMNS) {
    throw new BrowserImportError(
      "TOO_MANY_COLUMNS",
      "文件列数超过 200 列安全上限。",
      413,
    );
  }
}

export async function parseCsvFile(
  file: File,
  encoding: string,
): Promise<BrowserParsedTable> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const text = decodeCsv(bytes, encoding).replace(/^\uFEFF/, "");
  const rows = csvRows(text, detectDelimiter(text));
  const headerRow = rows.shift();
  if (!headerRow)
    throw new BrowserImportError("EMPTY_FILE", "CSV 文件为空。", 400);
  const headers = headerRow.values.map((value) =>
    value.normalize("NFKC").trim(),
  );
  validateHeaders(headers);
  const parsedRows: PreviewRow[] = [];
  const issues: BrowserParseIssue[] = [];
  let blankRows = 0;
  for (const row of rows) {
    if (parsedRows.length >= MAX_IMPORT_ROWS) {
      throw new BrowserImportError(
        "TOO_MANY_ROWS",
        "CSV 超过 100,000 行安全上限。",
        413,
      );
    }
    if (row.values.every((value) => !value.trim())) {
      blankRows += 1;
      continue;
    }
    if (row.values.length !== headers.length) {
      issues.push({
        code: "COLUMN_COUNT_MISMATCH",
        message: "该行列数与表头不一致。",
        rowNumber: row.line,
        severity: "error",
        suggestion: "检查分隔符、引号和缺失单元格。",
      });
    }
    const values = [
      ...row.values,
      ...Array<string>(headers.length).fill(""),
    ].slice(0, headers.length);
    parsedRows.push({
      row_number: row.line,
      values: Object.fromEntries(
        headers.map((header, index) => [header, values[index] ?? ""]),
      ),
    });
  }
  if (parsedRows.length === 0) {
    throw new BrowserImportError("NO_DATA_ROWS", "文件仅包含表头或空行。");
  }
  return {
    headers,
    issues,
    rows: parsedRows,
    sheetName: null,
    warnings: blankRows > 0 ? [`已跳过 ${blankRows} 个完全空白行。`] : [],
  };
}

function inspectZipCentralDirectory(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let entries = 0;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  for (let index = 0; index <= bytes.length - 46; index += 1) {
    if (view.getUint32(index, true) !== 0x02014b50) continue;
    const compressed = view.getUint32(index + 20, true);
    const uncompressed = view.getUint32(index + 24, true);
    const nameLength = view.getUint16(index + 28, true);
    const extraLength = view.getUint16(index + 30, true);
    const commentLength = view.getUint16(index + 32, true);
    const nameStart = index + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.length) {
      throw new BrowserImportError(
        "XLSX_ARCHIVE_INVALID",
        "XLSX 压缩目录损坏。",
      );
    }
    const name = new TextDecoder().decode(bytes.slice(nameStart, nameEnd));
    if (
      name.includes("\\") ||
      name.startsWith("/") ||
      name.split("/").some((part) => part === "..")
    ) {
      throw new BrowserImportError(
        "XLSX_PATH_TRAVERSAL",
        "XLSX 包含不安全的内部路径。",
        415,
      );
    }
    if (/vbaProject\.bin$|\.exe$|\.dll$/i.test(name)) {
      throw new BrowserImportError(
        "XLSX_ACTIVE_CONTENT",
        "工作簿包含宏或主动二进制内容，已拒绝。",
        415,
      );
    }
    entries += 1;
    totalCompressed += compressed;
    totalUncompressed += uncompressed;
    index = nameEnd + extraLength + commentLength - 1;
  }
  if (entries === 0) {
    throw new BrowserImportError(
      "XLSX_ARCHIVE_INVALID",
      "XLSX 缺少有效的 ZIP 中央目录。",
    );
  }
  if (
    entries > MAX_XLSX_ENTRIES ||
    totalUncompressed > MAX_XLSX_UNCOMPRESSED_BYTES
  ) {
    throw new BrowserImportError(
      "XLSX_DECOMPRESSION_LIMIT",
      "XLSX 解压规模超过安全上限。",
      413,
    );
  }
  if (
    totalUncompressed > 20 * 1024 * 1024 &&
    totalUncompressed / Math.max(1, totalCompressed) > 200
  ) {
    throw new BrowserImportError(
      "XLSX_DECOMPRESSION_BOMB",
      "XLSX 压缩比异常，疑似解压炸弹。",
      413,
    );
  }
}

function xml(bytes: Uint8Array | undefined, label: string): XMLDocument {
  if (!bytes)
    throw new BrowserImportError("XLSX_PART_MISSING", `XLSX 缺少 ${label}。`);
  const document = new DOMParser().parseFromString(
    new TextDecoder().decode(bytes),
    "application/xml",
  );
  if (document.getElementsByTagName("parsererror").length > 0) {
    throw new BrowserImportError(
      "XLSX_XML_INVALID",
      `XLSX 的 ${label} 无法解析。`,
    );
  }
  return document;
}

function nodes(document: Document | Element, localName: string): Element[] {
  return Array.from(document.getElementsByTagNameNS("*", localName));
}

function resolveWorksheetPath(target: string): string {
  const normalized = target.replace(/^\/+/, "");
  return normalized.startsWith("xl/")
    ? normalized
    : `xl/${normalized.replace(/^\.\//, "")}`;
}

export async function inspectWorkbook(file: File): Promise<WorkbookInspection> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  inspectZipCentralDirectory(bytes);
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new BrowserImportError(
      "XLSX_PARSING_FAILED",
      "XLSX 无法安全解压或文件已损坏。",
    );
  }
  const workbook = xml(entries["xl/workbook.xml"], "workbook.xml");
  const relationships = xml(
    entries["xl/_rels/workbook.xml.rels"],
    "workbook.xml.rels",
  );
  const targets = new Map(
    nodes(relationships, "Relationship").map((relationship) => [
      relationship.getAttribute("Id") ?? "",
      relationship.getAttribute("Target") ?? "",
    ]),
  );
  const sheets = nodes(workbook, "sheet").map((sheet) => {
    const relationshipId =
      sheet.getAttribute("r:id") ??
      sheet.getAttributeNS(
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
        "id",
      ) ??
      "";
    const target = targets.get(relationshipId);
    if (!target)
      throw new BrowserImportError(
        "XLSX_SHEET_RELATION_MISSING",
        "工作表关系缺失。",
      );
    return {
      name: sheet.getAttribute("name") ?? "未命名工作表",
      path: resolveWorksheetPath(target),
      state: sheet.getAttribute("state") ?? "visible",
    };
  });
  if (sheets.length === 0)
    throw new BrowserImportError("EMPTY_WORKBOOK", "工作簿不包含工作表。");
  const workbookPr = nodes(workbook, "workbookPr")[0];
  const warnings = Object.keys(entries).some((name) =>
    name.startsWith("xl/externalLinks/"),
  )
    ? ["工作簿包含外部链接定义；浏览器不会访问或执行这些链接。"]
    : [];
  return {
    date1904: workbookPr?.getAttribute("date1904") === "1",
    entries,
    sheets,
    warnings,
  };
}

function cellColumnIndex(reference: string): number {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? "A";
  return (
    [...letters].reduce(
      (value, letter) => value * 26 + letter.charCodeAt(0) - 64,
      0,
    ) - 1
  );
}

function sharedStrings(entries: Record<string, Uint8Array>): string[] {
  const value = entries["xl/sharedStrings.xml"];
  if (!value) return [];
  const document = xml(value, "sharedStrings.xml");
  return nodes(document, "si").map((item) =>
    nodes(item, "t")
      .map((text) => text.textContent ?? "")
      .join(""),
  );
}

function styleFormats(entries: Record<string, Uint8Array>): string[] {
  const value = entries["xl/styles.xml"];
  if (!value) return [];
  const document = xml(value, "styles.xml");
  const custom = new Map(
    nodes(document, "numFmt").map((format) => [
      Number(format.getAttribute("numFmtId")),
      format.getAttribute("formatCode") ?? "",
    ]),
  );
  const builtinDates = new Set([
    14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47,
  ]);
  const cellXfs = nodes(document, "cellXfs")[0];
  if (!cellXfs) return [];
  return nodes(cellXfs, "xf").map((format) => {
    const id = Number(format.getAttribute("numFmtId") ?? 0);
    return (
      custom.get(id) ?? (builtinDates.has(id) ? "yyyy-mm-dd hh:mm:ss" : "")
    );
  });
}

function isDateFormat(format: string): boolean {
  return /(^|[^\\])[ymdhis]/i.test(format.replace(/"[^"]*"/g, ""));
}

function excelDate(serial: number, date1904: boolean): string {
  const epoch = Date.UTC(
    date1904 ? 1904 : 1899,
    date1904 ? 0 : 11,
    date1904 ? 1 : 30,
  );
  const value = new Date(epoch + Math.round(serial * 86_400_000));
  return value.toISOString().replace(/\.000Z$/, "");
}

function cellValue(
  cell: Element,
  strings: string[],
  formats: string[],
  date1904: boolean,
): { issue?: BrowserParseIssue; value: unknown } {
  const reference = cell.getAttribute("r") ?? "";
  if (nodes(cell, "f").length > 0) {
    return {
      issue: {
        code: "FORMULA_CELL_IGNORED",
        message: "公式单元格未执行，当前值按缺失处理。",
        rawValue: "[公式已忽略]",
        severity: "error",
        suggestion: "在原工作簿中复制并粘贴为值后重新导入。",
      },
      value: null,
    };
  }
  const type = cell.getAttribute("t") ?? "n";
  const raw = nodes(cell, "v")[0]?.textContent ?? "";
  if (type === "inlineStr") {
    return {
      value: nodes(cell, "t")
        .map((item) => item.textContent ?? "")
        .join(""),
    };
  }
  if (type === "s") return { value: strings[Number(raw)] ?? "" };
  if (type === "str") return { value: raw };
  if (type === "b") return { value: raw === "1" };
  if (type === "e") {
    return {
      issue: {
        code: "EXCEL_ERROR_CELL",
        message: "Excel 错误单元格无法解析。",
        rawValue: "[Excel 错误值]",
        severity: "error",
        suggestion: "修复工作簿中的错误值并粘贴为普通值。",
      },
      value: null,
    };
  }
  if (raw === "") return { value: null };
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return { value: raw };
  const format = formats[Number(cell.getAttribute("s") ?? 0)] ?? "";
  if (isDateFormat(format)) return { value: excelDate(numeric, date1904) };
  if (/^0+$/.test(format) && Number.isInteger(numeric)) {
    return { value: String(numeric).padStart(format.length, "0") };
  }
  if (!reference) return { value: numeric };
  return { value: numeric };
}

export function parseWorkbookSheet(
  workbook: WorkbookInspection,
  sheetName: string,
): BrowserParsedTable {
  const sheet = workbook.sheets.find(
    (candidate) => candidate.name === sheetName,
  );
  if (!sheet)
    throw new BrowserImportError("WORKSHEET_NOT_FOUND", "选择的工作表不存在。");
  const document = xml(workbook.entries[sheet.path], sheet.path);
  const strings = sharedStrings(workbook.entries);
  const formats = styleFormats(workbook.entries);
  const sourceRows = nodes(document, "row");
  if (sourceRows.length > MAX_IMPORT_ROWS + 1) {
    throw new BrowserImportError(
      "TOO_MANY_ROWS",
      "工作表超过 100,000 行安全上限。",
      413,
    );
  }

  const decodedRows = sourceRows.map((row) => {
    const rowNumber = Number(row.getAttribute("r") ?? 0) || 1;
    const values: unknown[] = [];
    const issues: Array<{ column: number; issue: BrowserParseIssue }> = [];
    nodes(row, "c").forEach((cell) => {
      const column = cellColumnIndex(cell.getAttribute("r") ?? "A1");
      if (column >= MAX_IMPORT_COLUMNS) {
        throw new BrowserImportError(
          "TOO_MANY_COLUMNS",
          "工作表超过 200 列安全上限。",
          413,
        );
      }
      const decoded = cellValue(cell, strings, formats, workbook.date1904);
      values[column] = decoded.value;
      if (decoded.issue) issues.push({ column, issue: decoded.issue });
    });
    return { issues, rowNumber, values };
  });
  const headerIndex = decodedRows.findIndex((row) =>
    row.values.some((value) => scalarText(value).trim() !== ""),
  );
  if (headerIndex < 0)
    throw new BrowserImportError("EMPTY_WORKSHEET", "选择的工作表为空。");
  const headerRow = decodedRows[headerIndex];
  if (!headerRow)
    throw new BrowserImportError("EMPTY_WORKSHEET", "选择的工作表为空。");
  const lastHeader = headerRow.values.reduce<number>(
    (last, value, index) => (scalarText(value).trim() !== "" ? index : last),
    -1,
  );
  const headers = headerRow.values
    .slice(0, lastHeader + 1)
    .map((value) =>
      value === null || value === undefined
        ? ""
        : scalarText(value).normalize("NFKC").trim(),
    );
  validateHeaders(headers);

  const rows: PreviewRow[] = [];
  const issues: BrowserParseIssue[] = [];
  let blankRows = headerIndex;
  let excelDates = 0;
  let paddedIdentifiers = 0;
  decodedRows.slice(headerIndex + 1).forEach((row) => {
    const values = [
      ...row.values,
      ...Array<unknown>(headers.length).fill(null),
    ].slice(0, headers.length);
    if (values.every((value) => scalarText(value).trim() === "")) {
      blankRows += 1;
      return;
    }
    values.forEach((value) => {
      if (
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)
      )
        excelDates += 1;
      if (typeof value === "string" && /^0+\d+$/.test(value))
        paddedIdentifiers += 1;
    });
    rows.push({
      row_number: row.rowNumber,
      values: Object.fromEntries(
        headers.map((header, index) => [header, values[index] ?? null]),
      ),
    });
    row.issues.forEach(({ column, issue }) => {
      issues.push({
        ...issue,
        rowNumber: row.rowNumber,
        sourceColumn: headers[column] ?? null,
      });
    });
  });
  if (rows.length === 0)
    throw new BrowserImportError("NO_DATA_ROWS", "工作表仅包含表头或空行。");
  const warnings = [...workbook.warnings];
  if (sheet.state !== "visible")
    warnings.push("当前工作表为隐藏状态，请确认是否应导入。");
  if (blankRows > 0) warnings.push(`已跳过 ${blankRows} 个完全空白行。`);
  if (excelDates > 0)
    warnings.push(
      `识别到 ${excelDates} 个 Excel 日期单元格；实际时区将在校验时应用。`,
    );
  if (paddedIdentifiers > 0)
    warnings.push(
      `识别到 ${paddedIdentifiers} 个零填充数字单元格；已按显示格式保留前导零。`,
    );
  return { headers, issues, rows, sheetName, warnings };
}
