import { getImportContract } from "./contracts";
import {
  detectDataTypes,
  detectSensitiveRisks,
  suggestMappings,
} from "./mapping";
import {
  BrowserImportError,
  detectCsvEncoding,
  inspectWorkbook,
  parseCsvFile,
  parseWorkbookSheet,
  validateFileBasics,
  validateFileSignature,
  type BrowserParsedTable,
  type WorkbookInspection,
} from "./parser";
import { scalarText } from "./scalar";
import { saveBrowserDataset } from "./browserDatasetStore";
import { validateBrowserImport, type ValidationArtifacts } from "./validation";
import type {
  ConfirmResponse,
  DataType,
  ImportStatus,
  ImportTask,
  ParseResponse,
  ValidationResponse,
} from "../types/imports";
import type { ValidationPayload } from "../api/imports";

interface BrowserTaskRecord {
  artifacts?: ValidationArtifacts;
  file: File | null;
  inspection?: WorkbookInspection;
  parseResponse?: ParseResponse;
  parsedTable?: BrowserParsedTable;
  task: ImportTask;
}

const taskStore = new Map<string, BrowserTaskRecord>();
const errorsUrlStore = new Map<string, string>();

function taskId(dataType: DataType): string {
  const id =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `browser-import-${dataType}-${id}`;
}

function statusLabel(status: ImportStatus): string {
  const labels: Record<ImportStatus, string> = {
    analyzable: "可分析",
    awaiting_encoding: "待选择编码",
    awaiting_mapping: "待映射",
    awaiting_sheet: "待选择工作表",
    cancelled: "已取消",
    parsing: "解析中",
    pending_upload: "待上传",
    ready_to_confirm: "可确认导入",
    validation_failed: "校验失败",
  };
  return labels[status];
}

function withStatus(
  task: ImportTask,
  status: ImportStatus,
  message: string,
): ImportTask {
  return {
    ...task,
    can_reconfigure: status !== "analyzable" && status !== "cancelled",
    message,
    status,
    status_label: statusLabel(status),
  };
}

function requireRecord(id: string): BrowserTaskRecord {
  const record = taskStore.get(id);
  if (!record) {
    throw new BrowserImportError(
      "BROWSER_IMPORT_TASK_NOT_FOUND",
      "浏览器本地导入任务不存在或页面已刷新，请重新选择文件。",
      404,
    );
  }
  return record;
}

function csvSafe(value: unknown): string {
  let text = scalarText(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function conversionNotes(format: "csv" | "xlsx"): string[] {
  return [
    "原始文件只在当前浏览器内存中解析，不上传到 Cloudflare 或第三方服务器。",
    "源字段、原始值和行号保持可追溯；自动建议不会在用户确认前改变字段含义。",
    "文本数字只在目标数量字段通过严格校验后转为数值，空值不会变成 0。",
    "时间只转换表达格式并附加用户选择的时区，不会调整真实发生顺序。",
    "未知状态保留原值并标记为 unmapped，不强制归入正常状态。",
    ...(format === "xlsx"
      ? ["XLSX 公式、宏和外部链接不会执行；公式单元格按质量问题处理。"]
      : []),
  ];
}

export const browserImportService = {
  isTask(id: string): boolean {
    return id.startsWith("browser-import-");
  },

  async upload(dataType: DataType, file: File): Promise<{ task: ImportTask }> {
    const format = validateFileBasics(file);
    await validateFileSignature(file, format);
    const id = taskId(dataType);
    let encoding: string | null = null;
    let encodingOptions: string[] = [];
    let inspection: WorkbookInspection | undefined;
    let selectedSheet: string | null = null;
    let status: ImportStatus = "parsing";
    if (format === "csv") {
      const detection = await detectCsvEncoding(file);
      encoding = detection.encoding;
      encodingOptions = detection.options;
      if (!encoding) status = "awaiting_encoding";
    } else {
      inspection = await inspectWorkbook(file);
      if (inspection.sheets.length === 1) {
        selectedSheet = inspection.sheets[0]?.name ?? null;
      } else {
        status = "awaiting_sheet";
      }
    }
    const task: ImportTask = {
      can_reconfigure: true,
      data_type: dataType,
      default_timezone: "Asia/Shanghai",
      encoding,
      encoding_options: encodingOptions,
      encoding_required: status === "awaiting_encoding",
      file_format: format,
      file_name: file.name,
      file_size_bytes: file.size,
      message:
        status === "awaiting_encoding"
          ? "UTF-8 检测未通过；请人工选择 GB18030 或 GBK，系统不会静默猜测。"
          : status === "awaiting_sheet"
            ? "已在浏览器本地读取工作簿目录，请选择要解析的工作表。"
            : "文件已通过浏览器本地安全检查，准备解析。",
      processing_location: "browser",
      selected_sheet: selectedSheet,
      sheet_count: inspection?.sheets.length ?? 0,
      sheets:
        inspection?.sheets.map(({ name, state }) => ({ name, state })) ?? [],
      status,
      status_label: statusLabel(status),
      task_id: id,
    };
    taskStore.set(id, { file, inspection, task });
    return { task };
  },

  async parse(
    id: string,
    payload: { encoding?: string; sheet_name?: string },
  ): Promise<ParseResponse> {
    const record = requireRecord(id);
    if (!record.file) {
      throw new BrowserImportError(
        "IMPORT_FILE_CLEARED",
        "原始文件已清理，请重新选择文件。",
        409,
      );
    }
    let table: BrowserParsedTable;
    if (record.task.file_format === "csv") {
      const encoding = payload.encoding ?? record.task.encoding;
      if (!encoding) {
        throw new BrowserImportError(
          "CSV_ENCODING_REQUIRED",
          "必须先选择 CSV 编码。",
          422,
        );
      }
      table = await parseCsvFile(record.file, encoding);
      record.task = { ...record.task, encoding, encoding_required: false };
    } else {
      const inspection =
        record.inspection ?? (await inspectWorkbook(record.file));
      record.inspection = inspection;
      const selectedSheet = payload.sheet_name ?? record.task.selected_sheet;
      if (!selectedSheet) {
        throw new BrowserImportError(
          "WORKSHEET_REQUIRED",
          "必须先选择工作表。",
          422,
        );
      }
      table = parseWorkbookSheet(inspection, selectedSheet);
      record.task = { ...record.task, selected_sheet: selectedSheet };
    }
    const contract = getImportContract(record.task.data_type);
    const suggestions = suggestMappings(table.headers, contract, table.rows);
    const candidates = detectDataTypes(table.headers, table.rows);
    const sensitiveRisks = detectSensitiveRisks(table.headers, table.rows);
    const top = candidates[0];
    record.task = withStatus(
      record.task,
      "awaiting_mapping",
      "解析和数据类型识别已在浏览器本地完成；请复核字段映射。",
    );
    const response: ParseResponse = {
      conversion_notes: conversionNotes(record.task.file_format),
      data_type_candidates: candidates,
      detected_data_type: top?.data_type ?? record.task.data_type,
      detection_confidence: top?.confidence ?? 0,
      fields: contract.fields,
      preview_rows: table.rows.slice(0, 20),
      sensitive_risks: sensitiveRisks,
      source_columns: table.headers,
      suggestions,
      task: record.task,
      total_rows: table.rows.length,
      unmapped_source_columns: suggestions
        .filter((suggestion) => suggestion.suggested_field === null)
        .map((suggestion) => suggestion.source_column),
      warnings: table.warnings,
    };
    record.parseResponse = response;
    record.parsedTable = table;
    record.artifacts = undefined;
    return response;
  },

  validate(
    id: string,
    payload: ValidationPayload,
  ): Promise<ValidationResponse> {
    const record = requireRecord(id);
    if (!record.parsedTable || !record.parseResponse) {
      throw new BrowserImportError(
        "IMPORT_NOT_PARSED",
        "必须先完成文件解析。",
        409,
      );
    }
    const artifacts = validateBrowserImport(
      record.task.data_type,
      record.parsedTable,
      payload.mapping,
      payload.ignored_source_columns ?? [],
      payload.default_timezone,
      payload.project_status_mappings,
      record.parseResponse.sensitive_risks,
    );
    record.artifacts = artifacts;
    record.task = withStatus(
      record.task,
      artifacts.report.can_confirm ? "ready_to_confirm" : "validation_failed",
      artifacts.report.can_confirm
        ? "浏览器本地 Schema 与质量校验通过，可以确认导入。"
        : "浏览器本地校验发现阻断错误，请修正映射或原始文件后重试。",
    );
    return Promise.resolve({
      normalized_preview: artifacts.normalizedRows.slice(0, 20),
      report: artifacts.report,
      task: record.task,
    });
  },

  async confirm(id: string): Promise<ConfirmResponse> {
    const record = requireRecord(id);
    if (!record.artifacts?.report.can_confirm) {
      throw new BrowserImportError(
        "IMPORT_NOT_READY_TO_CONFIRM",
        "只有解析、映射、Schema 和质量校验全部通过后才能确认导入。",
        409,
      );
    }
    const datasetId = `browser-local-${crypto.randomUUID()}`;
    await saveBrowserDataset({
      createdAt: new Date().toISOString(),
      dataType: record.task.data_type,
      datasetId,
      fileName: record.task.file_name,
      qualityReport: record.artifacts.report,
      rows: record.artifacts.normalizedRows,
      sourceKind: "browser_local_import",
    });
    record.file = null;
    record.inspection = undefined;
    record.task = withStatus(
      record.task,
      "analyzable",
      "标准化数据已保存到此浏览器的 IndexedDB；原始文件引用已清理。",
    );
    return {
      dataset_id: datasetId,
      imported_rows: record.artifacts.normalizedRows.length,
      message: "导入完成；原始文件和内容没有离开浏览器。",
      task: record.task,
    };
  },

  cancel(id: string): Promise<ImportTask> {
    const record = requireRecord(id);
    record.file = null;
    record.inspection = undefined;
    record.task = withStatus(
      record.task,
      "cancelled",
      "浏览器本地任务和原始文件引用已清理。",
    );
    taskStore.delete(id);
    const previousUrl = errorsUrlStore.get(id);
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    errorsUrlStore.delete(id);
    return Promise.resolve(record.task);
  },

  errorsUrl(id: string): string {
    const record = requireRecord(id);
    const previousUrl = errorsUrlStore.get(id);
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    const header = [
      "issue_id",
      "severity",
      "code",
      "sheet",
      "row_number",
      "source_column",
      "target_field",
      "raw_value",
      "message",
      "suggestion",
    ];
    const lines = [
      header.map(csvSafe).join(","),
      ...(record.artifacts?.report.issues ?? []).map((issue) =>
        header
          .map((field) => csvSafe(issue[field as keyof typeof issue]))
          .join(","),
      ),
    ];
    const url = URL.createObjectURL(
      new Blob(["\uFEFF", lines.join("\r\n")], {
        type: "text/csv;charset=utf-8",
      }),
    );
    errorsUrlStore.set(id, url);
    return url;
  },
};
