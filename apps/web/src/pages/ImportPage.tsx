import {
  CheckCircleOutlined,
  DownloadOutlined,
  InboxOutlined,
  SafetyCertificateOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Flex,
  Grid,
  Input,
  Progress,
  Radio,
  Result,
  Row,
  Select,
  Statistic,
  Steps,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from "antd";
import { useEffect, useMemo, useRef, useState } from "react";

import { importApi } from "../api/imports";
import { ApiClientError } from "../api/client";
import { useNotifications } from "../components/notification-context";
import { PageHeader } from "../components/PageHeader";
import { isCloudflareDeploy } from "../config/runtime";
import { MAX_IMPORT_BYTES, validateFileBasics } from "../imports/parser";
import { getImportContract } from "../imports/contracts";
import {
  findRecommendedMappingSources,
  findSafelyIgnorableColumns,
} from "../imports/mapping";
import type {
  ConfirmResponse,
  CompatibilitySample,
  CompatibilitySampleCatalog,
  DataType,
  DataTypeSelection,
  FieldSuggestion,
  ImportTask,
  ParseResponse,
  QualityIssue,
  ValidationResponse,
  ImportDateOrder,
} from "../types/imports";

const { Dragger } = Upload;

const stepItems = [
  { title: "选择数据类型" },
  { title: "上传" },
  { title: "选择工作表" },
  { title: "数据预览" },
  { title: "字段映射" },
  { title: "质量校验" },
  { title: "确认导入" },
];

const dataTypeOptions: Array<{
  value: DataTypeSelection;
  label: string;
  description: string;
}> = [
  {
    value: "auto",
    label: "自动识别（推荐）",
    description: "系统结合表头、内容特征和行间关系判断数据类型。",
  },
  {
    value: "orders",
    label: "订单数据",
    description: "订单创建、承诺与实际交付、数量和订单状态。",
  },
  {
    value: "warehouse_events",
    label: "仓库作业数据",
    description: "拣货、质检、打包、出库等仓内作业事件。",
  },
  {
    value: "tracking_events",
    label: "物流轨迹数据",
    description: "揽收、中转、派送、签收和运输异常轨迹。",
  },
];

const statusOptions: Record<DataType, string[]> = {
  orders: [
    "created",
    "confirmed",
    "processing",
    "shipped",
    "delivered",
    "cancelled",
    "returned",
  ],
  warehouse_events: [
    "order_received",
    "picking_started",
    "picking_completed",
    "quality_check_started",
    "quality_check_failed",
    "quality_check_completed",
    "packing_started",
    "packing_completed",
    "ready_to_ship",
    "shipped_from_warehouse",
    "warehouse_cancelled",
  ],
  tracking_events: [
    "shipment_created",
    "carrier_picked_up",
    "origin_departed",
    "in_transit",
    "arrived_at_hub",
    "departed_hub",
    "arrived_at_destination_city",
    "out_for_delivery",
    "delivered",
    "delivery_failed",
    "exception",
    "return_initiated",
    "returned",
  ],
};

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return `${value}`;
  }
  return "[不支持的值]";
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    const details = error.details.map((detail) => detail.message).join("；");
    return `${error.message}${details ? ` ${details}` : ""}（错误代码：${error.code}）`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "操作未完成，请检查本地服务后重试。";
}

function statusColor(status: ImportTask["status"]): string {
  if (status === "analyzable" || status === "ready_to_confirm") {
    return "success";
  }
  if (status === "validation_failed") {
    return "error";
  }
  if (status === "cancelled") {
    return "default";
  }
  return "processing";
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

export function ImportPage() {
  const notifications = useNotifications();
  const screens = Grid.useBreakpoint();
  const nativeFileInput = useRef<HTMLInputElement>(null);
  const [current, setCurrent] = useState(0);
  const [dataType, setDataType] = useState<DataType>("orders");
  const [dataTypeSelection, setDataTypeSelection] =
    useState<DataTypeSelection>("auto");
  const [file, setFile] = useState<File | null>(null);
  const [task, setTask] = useState<ImportTask | null>(null);
  const [encoding, setEncoding] = useState<string>();
  const [sheetName, setSheetName] = useState<string>();
  const [parsed, setParsed] = useState<ParseResponse | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [ignoredSourceColumns, setIgnoredSourceColumns] = useState<string[]>(
    [],
  );
  const [manualSourceColumns, setManualSourceColumns] = useState<string[]>([]);
  const [lastBulkIgnored, setLastBulkIgnored] = useState<string[]>([]);
  const [timezone, setTimezone] = useState("Asia/Shanghai");
  const [dateOrder, setDateOrder] = useState<ImportDateOrder>();
  const [projectStatusMappings, setProjectStatusMappings] = useState<
    Record<string, string>
  >({});
  const [validation, setValidation] = useState<ValidationResponse | null>(null);
  const [confirmed, setConfirmed] = useState<ConfirmResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [persistentError, setPersistentError] = useState<string | null>(null);
  const [validationStale, setValidationStale] = useState(false);
  const [sampleCatalog, setSampleCatalog] =
    useState<CompatibilitySampleCatalog | null>(null);
  const [sampleCatalogError, setSampleCatalogError] = useState<string | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    void importApi
      .listSamples()
      .then((response) => {
        if (active) setSampleCatalog(response);
      })
      .catch((error: unknown) => {
        if (active) setSampleCatalogError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, []);

  const previewColumns = useMemo(
    () => [
      {
        title: "源行号",
        dataIndex: "row_number",
        key: "row_number",
        fixed: "left" as const,
        width: 88,
      },
      ...(parsed?.source_columns ?? []).map((column) => ({
        title: column,
        key: column,
        width: 180,
        render: (_: unknown, row: ParseResponse["preview_rows"][number]) =>
          stringifyCell(row.values[column]),
      })),
    ],
    [parsed],
  );

  const unknownStatuses =
    validation?.report.status_normalizations.filter(
      (item) => item.normalized_status === "unmapped",
    ) ?? [];

  const ignoredSourceSet = useMemo(
    () => new Set(ignoredSourceColumns),
    [ignoredSourceColumns],
  );
  const manualSourceSet = useMemo(
    () => new Set(manualSourceColumns),
    [manualSourceColumns],
  );
  const mappingSummary = useMemo(() => {
    const result = {
      auxiliary: 0,
      ignored: 0,
      mapped: 0,
      pendingConfirmation: 0,
      unresolved: 0,
    };
    (parsed?.suggestions ?? []).forEach((suggestion) => {
      const source = suggestion.source_column;
      const target = mapping[source] ?? null;
      if (ignoredSourceSet.has(source)) {
        result.ignored += 1;
      } else if (suggestion.auxiliary_purpose && target === null) {
        result.auxiliary += 1;
      } else if (target === null) {
        result.unresolved += 1;
      } else if (
        suggestion.requires_confirmation &&
        !manualSourceSet.has(source)
      ) {
        result.pendingConfirmation += 1;
      } else {
        result.mapped += 1;
      }
    });
    return result;
  }, [ignoredSourceSet, manualSourceSet, mapping, parsed]);

  const safelyIgnorableColumns = useMemo(
    () =>
      parsed === null
        ? []
        : findSafelyIgnorableColumns(
            parsed.suggestions,
            mapping,
            ignoredSourceColumns,
            getImportContract(dataType),
          ),
    [dataType, ignoredSourceColumns, mapping, parsed],
  );
  const recommendedMappingSources = useMemo(
    () =>
      parsed === null
        ? []
        : findRecommendedMappingSources(
            parsed.suggestions,
            mapping,
            ignoredSourceColumns,
          ).filter((source) => !manualSourceSet.has(source)),
    [ignoredSourceColumns, manualSourceSet, mapping, parsed],
  );
  const blockingMappingCount =
    mappingSummary.pendingConfirmation + mappingSummary.unresolved;

  function applyParsed(response: ParseResponse) {
    setDataType(response.selected_data_type ?? response.task.data_type);
    setTask(response.task);
    setParsed(response);
    setMapping(
      Object.fromEntries(
        response.suggestions.map((suggestion) => [
          suggestion.source_column,
          suggestion.suggested_field ?? null,
        ]),
      ),
    );
    setIgnoredSourceColumns([]);
    setManualSourceColumns([]);
    setLastBulkIgnored([]);
    setDateOrder(response.date_order_inference?.order ?? undefined);
    setPersistentError(null);
    setValidation(null);
    setConfirmed(null);
    setValidationStale(false);
    setCurrent(3);
  }

  function invalidateValidation(
    message = "字段映射已修改，需要重新运行质量校验。",
  ) {
    setValidation(null);
    setValidationStale(false);
    setTask((previous) =>
      previous === null
        ? null
        : {
            ...previous,
            message,
            status: "awaiting_mapping",
            status_label: "待映射",
          },
    );
  }

  function selectMappingTarget(source: string, target?: string) {
    setLastBulkIgnored([]);
    setMapping((previous) => ({ ...previous, [source]: target ?? null }));
    setIgnoredSourceColumns((previous) =>
      previous.filter((column) => column !== source),
    );
    setManualSourceColumns((previous) =>
      target === undefined
        ? previous.filter((column) => column !== source)
        : [...new Set([...previous, source])],
    );
    invalidateValidation();
  }

  function ignoreSourceColumn(source: string) {
    setLastBulkIgnored([]);
    setMapping((previous) => ({ ...previous, [source]: null }));
    setIgnoredSourceColumns((previous) => [...new Set([...previous, source])]);
    setManualSourceColumns((previous) =>
      previous.filter((column) => column !== source),
    );
    invalidateValidation("字段已明确忽略，需要重新运行质量校验。");
  }

  function confirmSuggestedMapping(source: string) {
    setLastBulkIgnored([]);
    setManualSourceColumns((previous) => [...new Set([...previous, source])]);
    setIgnoredSourceColumns((previous) =>
      previous.filter((column) => column !== source),
    );
    invalidateValidation("低置信度映射已人工确认，需要重新运行质量校验。");
  }

  function restoreSourceColumn(source: string) {
    setLastBulkIgnored([]);
    setIgnoredSourceColumns((previous) =>
      previous.filter((column) => column !== source),
    );
    setMapping((previous) => ({ ...previous, [source]: null }));
    invalidateValidation("已取消忽略，请为该源字段选择目标字段或重新忽略。");
  }

  function ignoreSafelyInBulk() {
    if (safelyIgnorableColumns.length === 0) return;
    const columns = [...safelyIgnorableColumns];
    setMapping((previous) => ({
      ...previous,
      ...Object.fromEntries(columns.map((column) => [column, null])),
    }));
    setIgnoredSourceColumns((previous) => [
      ...new Set([...previous, ...columns]),
    ]);
    setManualSourceColumns((previous) =>
      previous.filter((column) => !columns.includes(column)),
    );
    setLastBulkIgnored(columns);
    invalidateValidation("已批量忽略非分析字段，需要重新运行质量校验。");
    notifications.showSuccess(
      `已忽略 ${columns.length} 个非分析字段`,
      "必填字段、关键语义候选和辅助解析字段均未被忽略。",
    );
  }

  function applyRecommendedMappings() {
    if (recommendedMappingSources.length === 0) return;
    setManualSourceColumns((previous) => [
      ...new Set([...previous, ...recommendedMappingSources]),
    ]);
    setIgnoredSourceColumns((previous) =>
      previous.filter((column) => !recommendedMappingSources.includes(column)),
    );
    setLastBulkIgnored([]);
    invalidateValidation("已应用高置信度推荐映射，需要运行最新质量校验。");
    notifications.showSuccess(
      `已应用 ${recommendedMappingSources.length} 个推荐映射`,
      "系统只确认高置信度且无目标冲突的建议；低置信度字段仍需人工决定。",
    );
  }

  function undoBulkIgnore() {
    if (lastBulkIgnored.length === 0) return;
    const restored = [...lastBulkIgnored];
    setIgnoredSourceColumns((previous) =>
      previous.filter((column) => !restored.includes(column)),
    );
    setMapping((previous) => ({
      ...previous,
      ...Object.fromEntries(restored.map((column) => [column, null])),
    }));
    setLastBulkIgnored([]);
    invalidateValidation("已撤销本次批量忽略，请继续处理恢复的字段。");
    notifications.showSuccess(
      "已撤销本次忽略",
      `已恢复 ${restored.length} 个源字段为未处理状态。`,
    );
  }

  function selectFile(selected: File | null) {
    if (selected === null) {
      setFile(null);
      return;
    }
    try {
      validateFileBasics(selected);
    } catch (error) {
      setFile(null);
      setPersistentError(errorMessage(error));
      return;
    }
    setFile(selected);
    setTask(null);
    setParsed(null);
    setValidation(null);
    setConfirmed(null);
    setValidationStale(false);
    setPersistentError(null);
  }

  function startCustomUpload() {
    setPersistentError(null);
    setCurrent(1);
    window.requestAnimationFrame(() => {
      if (nativeFileInput.current) {
        nativeFileInput.current.value = "";
        nativeFileInput.current.click();
      }
    });
  }

  async function runAction<T>(action: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    setPersistentError(null);
    try {
      return await action();
    } catch (error) {
      const message = errorMessage(error);
      setPersistentError(message);
      notifications.showError("导入操作未完成", message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function handleUpload() {
    if (file === null) {
      setPersistentError("请先选择一个 CSV 或 XLSX 文件。");
      return;
    }
    const response = await runAction(() =>
      importApi.upload(dataTypeSelection, file),
    );
    if (response === null) {
      return;
    }
    setTask(response.task);
    setEncoding(response.task.encoding ?? undefined);
    setSheetName(response.task.selected_sheet ?? undefined);
    if (
      response.task.status === "awaiting_encoding" ||
      response.task.status === "awaiting_sheet"
    ) {
      setCurrent(2);
      return;
    }
    await handleParse(response.task);
  }

  async function handleParse(activeTask = task) {
    if (activeTask === null) {
      return;
    }
    const response = await runAction(() =>
      importApi.parse(activeTask.task_id, {
        ...(encoding === undefined ? {} : { encoding }),
        ...(sheetName === undefined ? {} : { sheet_name: sheetName }),
      }),
    );
    if (response !== null) {
      applyParsed(response);
    }
  }

  async function switchParsedDataType(next: DataType) {
    setDataTypeSelection(next);
    setDataType(next);
    if (task === null) return;
    if (!task.task_id.startsWith("browser-import-")) {
      setPersistentError(
        "本地服务模式下请返回上传步骤并按新的数据类型重新读取文件。",
      );
      return;
    }
    const response = await runAction(() =>
      importApi.parse(task.task_id, {
        data_type: next,
        ...(encoding === undefined ? {} : { encoding }),
        ...(sheetName === undefined ? {} : { sheet_name: sheetName }),
      }),
    );
    if (response !== null) applyParsed(response);
  }

  async function handleSynthetic() {
    const response = await runAction(() => importApi.createSynthetic(dataType));
    if (response !== null) {
      setFile(null);
      applyParsed(response);
      notifications.showSuccess(
        "合成样例已载入",
        "样例不包含真实订单或个人信息，可直接检查映射与校验规则。",
      );
    }
  }

  async function handleCompatibilitySample(sample: CompatibilitySample) {
    const response = await runAction(async () => {
      const download = await fetch(importApi.sampleFileUrl(sample.sample_id));
      if (!download.ok) {
        throw new Error(`兼容性示例下载失败（HTTP ${download.status}）。`);
      }
      const selected = new File([await download.blob()], sample.file_name, {
        type:
          sample.file_format === "csv"
            ? "text/csv"
            : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const uploaded = await importApi.upload(
        sample.default_data_type,
        selected,
      );
      return { selected, uploaded };
    });
    if (response === null) return;
    setDataType(sample.default_data_type);
    setFile(response.selected);
    setTask(response.uploaded.task);
    setEncoding(response.uploaded.task.encoding ?? undefined);
    setSheetName(sample.default_sheet ?? undefined);
    setParsed(null);
    setValidation(null);
    setConfirmed(null);
    if (response.uploaded.task.status === "awaiting_sheet") {
      setCurrent(2);
    } else if (response.uploaded.task.status === "awaiting_encoding") {
      setCurrent(2);
    } else {
      const parsedResponse = await runAction(() =>
        importApi.parse(response.uploaded.task.task_id, {
          ...(response.uploaded.task.encoding
            ? { encoding: response.uploaded.task.encoding }
            : {}),
        }),
      );
      if (parsedResponse !== null) applyParsed(parsedResponse);
    }
    notifications.showSuccess(
      "兼容性示例已进入导入流程",
      "它会经过与普通文件相同的解析、映射、校验和确认步骤。",
    );
  }

  async function handleValidate() {
    if (task === null) {
      return;
    }
    const response = await runAction(() =>
      importApi.validate(task.task_id, {
        mapping,
        ignored_source_columns: ignoredSourceColumns,
        default_timezone: timezone.trim() || null,
        project_status_mappings: projectStatusMappings,
        date_order: dateOrder ?? null,
      }),
    );
    if (response !== null) {
      setTask(response.task);
      setValidation(response);
      setValidationStale(false);
      setCurrent(5);
    }
  }

  async function handleConfirm() {
    if (task === null) {
      return;
    }
    if (!validation?.report.can_confirm || validationStale) {
      setPersistentError(
        "当前字段映射或状态映射尚未通过最新校验，不能确认导入。",
      );
      return;
    }
    const response = await runAction(() => importApi.confirm(task.task_id));
    if (response !== null) {
      persistConfirmed(response);
      notifications.showSuccess("导入完成", "数据集已进入“可分析”状态。");
    }
  }

  function persistConfirmed(response: ConfirmResponse) {
    setTask(response.task);
    setConfirmed(response);
    window.localStorage.setItem(
      response.dataset_id.startsWith("browser-local-")
        ? `fulfilllens.browser.dataset.${response.task.data_type}`
        : `fulfilllens.dataset.${response.task.data_type}`,
      response.dataset_id,
    );
  }

  async function handleQuickAnalyze() {
    if (task === null || blockingMappingCount > 0) return;
    const result = await runAction(async () => {
      const checked = await importApi.validate(task.task_id, {
        mapping,
        ignored_source_columns: ignoredSourceColumns,
        default_timezone: timezone.trim() || null,
        project_status_mappings: projectStatusMappings,
        date_order: dateOrder ?? null,
      });
      if (!checked.report.can_confirm) return { checked, imported: null };
      const imported = await importApi.confirm(task.task_id);
      return { checked, imported };
    });
    if (result === null) return;
    setTask(result.checked.task);
    setValidation(result.checked);
    setValidationStale(false);
    if (result.imported === null) {
      setCurrent(5);
      return;
    }
    persistConfirmed(result.imported);
    notifications.showSuccess(
      "已准备好分析",
      `已导入 ${result.imported.imported_rows} 行；正在打开分析总览。`,
    );
    window.location.assign("/analytics");
  }

  async function handleCancel() {
    if (task !== null && task.status !== "analyzable") {
      const cancelled = await runAction(() => importApi.cancel(task.task_id));
      if (cancelled === null) {
        return;
      }
    }
    setTask(null);
    setParsed(null);
    setValidation(null);
    setConfirmed(null);
    setFile(null);
    setMapping({});
    setIgnoredSourceColumns([]);
    setManualSourceColumns([]);
    setLastBulkIgnored([]);
    setProjectStatusMappings({});
    setDateOrder(undefined);
    setValidationStale(false);
    setPersistentError(null);
    setCurrent(0);
  }

  function renderMappingTarget(suggestion: FieldSuggestion) {
    const source = suggestion.source_column;
    if (ignoredSourceSet.has(source)) {
      return (
        <Flex
          className="mapping-ignored-control"
          align="center"
          gap="small"
          wrap
        >
          <Tag color="default">已忽略</Tag>
          <Button size="small" onClick={() => restoreSourceColumn(source)}>
            取消忽略并重新映射
          </Button>
        </Flex>
      );
    }
    if (suggestion.auxiliary_purpose && mapping[source] == null) {
      return (
        <Flex
          className="mapping-ignored-control"
          align="center"
          gap="small"
          wrap
        >
          <Tag color="cyan">用于辅助识别</Tag>
          <Typography.Text>
            不直接写入分析字段；仅辅助判断状态、签收或异常。
          </Typography.Text>
          <Button size="small" onClick={() => ignoreSourceColumn(source)}>
            不使用该辅助列
          </Button>
        </Flex>
      );
    }
    return (
      <Flex className="mapping-target-control" align="center" gap="small">
        <Select
          className="mapping-target-select"
          aria-label={`${source} 映射目标`}
          allowClear
          showSearch
          optionFilterProp="label"
          popupMatchSelectWidth={screens.md === false ? true : 480}
          classNames={{ popup: { root: "mapping-target-popup" } }}
          value={mapping[source] ?? undefined}
          options={(parsed?.fields ?? []).map((field) => ({
            value: field.field,
            label: `${field.label}（${field.field}）${field.required ? " *" : ""}`,
          }))}
          optionRender={(option) => {
            const readableLabel =
              typeof option.label === "string"
                ? option.label
                : typeof option.value === "string"
                  ? option.value
                  : typeof option.value === "number"
                    ? `${option.value}`
                    : "";
            return <span title={readableLabel}>{readableLabel}</span>;
          }}
          onChange={(value: string | undefined) =>
            selectMappingTarget(source, value)
          }
        />
        {suggestion.requires_confirmation &&
        mapping[source] != null &&
        !manualSourceSet.has(source) ? (
          <Button
            className="mapping-confirm-button"
            size="small"
            onClick={() => confirmSuggestedMapping(source)}
          >
            确认建议
          </Button>
        ) : null}
        <Button
          className="mapping-ignore-button"
          size="small"
          onClick={() => ignoreSourceColumn(source)}
        >
          忽略
        </Button>
      </Flex>
    );
  }

  function renderMappingConfidence(suggestion: FieldSuggestion) {
    const source = suggestion.source_column;
    if (ignoredSourceSet.has(source)) {
      return <Typography.Text type="secondary">— 已忽略</Typography.Text>;
    }
    if (suggestion.auxiliary_purpose && mapping[source] == null) {
      return <Typography.Text type="secondary">— 辅助证据</Typography.Text>;
    }
    const target = mapping[source] ?? null;
    if (target === null) {
      return <Tag color="warning">待处理</Tag>;
    }
    if (manualSourceSet.has(source)) {
      return <Typography.Text>— 人工确认</Typography.Text>;
    }
    return (
      <Flex vertical gap={4}>
        <Progress
          percent={Math.round(suggestion.confidence * 100)}
          size="small"
          status={suggestion.confidence >= 0.86 ? "success" : "normal"}
        />
        {suggestion.requires_confirmation ? (
          <Tag color="warning">需要人工确认</Tag>
        ) : null}
      </Flex>
    );
  }

  function renderMappingMethod(suggestion: FieldSuggestion) {
    const source = suggestion.source_column;
    if (ignoredSourceSet.has(source)) {
      return <Tag>Ignored</Tag>;
    }
    if (suggestion.auxiliary_purpose && mapping[source] == null) {
      return <Tag color="cyan">Inferred</Tag>;
    }
    if ((mapping[source] ?? null) === null) {
      return <Tag color="warning">Unresolved</Tag>;
    }
    if (manualSourceSet.has(source)) {
      return <Tag color="purple">Manual</Tag>;
    }
    const evidenceItems = suggestion.candidates[0]?.evidence ?? [];
    return (
      <Tooltip
        title={
          evidenceItems.length > 0
            ? evidenceItems.map((item) => item.label).join("；")
            : "依据字段名和内容画像生成"
        }
      >
        <Tag color="blue">{suggestion.method}</Tag>
      </Tooltip>
    );
  }

  function applyIssueRecommendation(issue: QualityIssue) {
    const source = issue.recommended_source_column;
    const target = issue.target_field;
    if (!source || !target) return;
    setMapping((previous) => ({ ...previous, [source]: target }));
    setIgnoredSourceColumns((previous) =>
      previous.filter((column) => column !== source),
    );
    setManualSourceColumns((previous) => [...new Set([...previous, source])]);
    invalidateValidation("已应用推荐修复，请复核后重新运行质量校验。");
    setCurrent(4);
    notifications.showSuccess(
      "已应用推荐修复",
      `已将“${source}”映射到 ${target}，请复核后重新校验。`,
    );
  }

  const qualityIssueColumns = [
    {
      title: "级别",
      dataIndex: "severity",
      key: "severity",
      width: 88,
      render: (severity: QualityIssue["severity"]) => (
        <Tag color={severity === "error" ? "error" : "warning"}>
          {severity === "error"
            ? "错误"
            : severity === "warning"
              ? "警告"
              : "提示"}
        </Tag>
      ),
    },
    { title: "工作表", dataIndex: "sheet", key: "sheet", width: 120 },
    { title: "行号", dataIndex: "row_number", key: "row_number", width: 80 },
    {
      title: "列名",
      dataIndex: "source_column",
      key: "source_column",
      width: 140,
    },
    {
      title: "问题 / 原因 / 影响",
      key: "message",
      width: 360,
      render: (_: unknown, issue: QualityIssue) => (
        <Flex vertical gap={4}>
          <Typography.Text strong>{issue.message}</Typography.Text>
          {issue.cause ? (
            <Typography.Text>原因：{issue.cause}</Typography.Text>
          ) : null}
          {issue.impact ? (
            <Typography.Text>影响：{issue.impact}</Typography.Text>
          ) : null}
        </Flex>
      ),
    },
    {
      title: "原始值",
      dataIndex: "raw_value",
      key: "raw_value",
      width: 160,
      render: (value: string | null) => value || "—",
    },
    {
      title: "建议修复",
      key: "suggestion",
      width: 260,
      render: (_: unknown, issue: QualityIssue) => (
        <Flex vertical gap={6} align="start">
          <Typography.Text>{issue.suggestion}</Typography.Text>
          {issue.action_label && issue.recommended_source_column ? (
            <Button
              size="small"
              onClick={() => applyIssueRecommendation(issue)}
            >
              {issue.action_label}
            </Button>
          ) : null}
        </Flex>
      ),
    },
  ];

  const taskStatusView =
    task === null
      ? null
      : current === 4
        ? {
            message:
              blockingMappingCount === 0
                ? "核心字段已满足；可直接开始分析，或展开高级设置复核。"
                : `还需处理 ${blockingMappingCount} 个字段；批量操作后会立即刷新准备度。`,
            status:
              blockingMappingCount === 0
                ? ("ready_to_confirm" as const)
                : ("awaiting_mapping" as const),
            status_label: blockingMappingCount === 0 ? "可开始分析" : "待处理",
          }
        : task;

  return (
    <>
      <PageHeader
        title="数据导入"
        description={
          isCloudflareDeploy
            ? "在线版支持自主选择 CSV/XLSX，并在当前浏览器内完成解析、转换、映射和质量校验；原始文件不会上传到 Cloudflare。"
            : "逐步导入订单、仓库作业或物流轨迹。系统会先预览、映射和校验，只有确认后才形成可分析数据集。"
        }
      />

      <Alert
        className="prominent-alert"
        showIcon
        type="info"
        message={
          isCloudflareDeploy
            ? "在线版文件仅在浏览器本地处理"
            : "文件仅在本机处理"
        }
        description={
          isCloudflareDeploy
            ? "自主文件的原始内容只存在于当前浏览器内存；确认后的标准化数据保存在此浏览器 IndexedDB。请仍先移除分析不需要的个人信息字段。"
            : "限制为 CSV/XLSX，单文件最大 10 MiB；不执行宏与公式。姓名、手机号、详细地址和身份证等字段只提示风险，预览会脱敏。"
        }
      />

      <Card className="section-card" title="数据兼容性示例">
        {sampleCatalogError !== null ? (
          <Alert
            type="error"
            showIcon
            message="兼容性示例暂时不可用"
            description={sampleCatalogError}
          />
        ) : null}
        {sampleCatalog !== null ? (
          <>
            <Alert
              type="success"
              showIcon
              message="两份文件均为全新合成数据"
              description={sampleCatalog.privacy_statement}
            />
            <Row gutter={[16, 16]} className="compatibility-sample-grid">
              {sampleCatalog.samples.map((sample) => (
                <Col xs={24} lg={12} key={sample.sample_id}>
                  <Card size="small" title={sample.display_name}>
                    <Typography.Paragraph>
                      {sample.purpose}
                    </Typography.Paragraph>
                    <Flex gap="small" wrap>
                      <Tag color="blue">{sample.file_format.toUpperCase()}</Tag>
                      <Tag>
                        {Object.values(sample.row_counts).reduce(
                          (total, value) => total + value,
                          0,
                        )}{" "}
                        条数据
                      </Tag>
                      {sample.sheet_names.length > 0 ? (
                        <Tag>{sample.sheet_names.length} 个工作表</Tag>
                      ) : null}
                    </Flex>
                    <ul className="case-list">
                      {sample.conversion_features.map((feature) => (
                        <li key={feature}>{feature}</li>
                      ))}
                    </ul>
                    <Flex gap="small" wrap>
                      <Button
                        type="primary"
                        loading={busy}
                        onClick={() => void handleCompatibilitySample(sample)}
                      >
                        加载并进入导入流程
                      </Button>
                      <Button
                        icon={<DownloadOutlined />}
                        href={importApi.sampleFileUrl(sample.sample_id)}
                      >
                        下载原文件
                      </Button>
                    </Flex>
                  </Card>
                </Col>
              ))}
            </Row>
          </>
        ) : null}
      </Card>

      <Card className="section-card import-wizard">
        <Steps
          current={current}
          items={stepItems}
          responsive
          size="small"
          aria-label="数据导入步骤"
        />
        <input
          ref={nativeFileInput}
          className="visually-hidden"
          type="file"
          accept=".csv,.xlsx"
          aria-label="选择自主上传的 CSV 或 XLSX 文件"
          onChange={(event) => {
            selectFile(event.target.files?.[0] ?? null);
          }}
        />
        {taskStatusView !== null && persistentError === null ? (
          <Flex className="import-task-status" align="center" gap="small" wrap>
            <Typography.Text strong>当前任务</Typography.Text>
            <Tag color={statusColor(taskStatusView.status)}>
              {taskStatusView.status_label}
            </Tag>
            <Typography.Text>{taskStatusView.message}</Typography.Text>
          </Flex>
        ) : null}
        {persistentError !== null ? (
          <Alert
            className="import-persistent-error"
            type="error"
            showIcon
            message="当前导入操作失败"
            description={persistentError}
          />
        ) : null}

        <section className="import-step-panel">
          {current === 0 ? (
            <Flex vertical gap="large">
              <Typography.Title level={3}>1. 选择数据类型</Typography.Title>
              <Radio.Group
                className="data-type-grid"
                value={dataTypeSelection}
                onChange={(event) => {
                  const selected = event.target.value as DataTypeSelection;
                  setDataTypeSelection(selected);
                  if (selected !== "auto") setDataType(selected);
                }}
              >
                {dataTypeOptions.map((option) => (
                  <Radio.Button key={option.value} value={option.value}>
                    <strong>{option.label}</strong>
                    <span>{option.description}</span>
                  </Radio.Button>
                ))}
              </Radio.Group>
              <Flex gap="small" wrap>
                <Button
                  type="primary"
                  icon={<UploadOutlined />}
                  onClick={startCustomUpload}
                >
                  自主上传文件
                </Button>
                <Button
                  loading={isCloudflareDeploy && busy}
                  onClick={() => {
                    if (isCloudflareDeploy) {
                      void handleSynthetic();
                      return;
                    }
                    setCurrent(1);
                  }}
                >
                  {isCloudflareDeploy ? "加载在线合成示例" : "下一步：选择文件"}
                </Button>
                <Button
                  icon={<SafetyCertificateOutlined />}
                  loading={busy}
                  onClick={() => void handleSynthetic()}
                >
                  一键导入合成样例
                </Button>
                <Button
                  icon={<DownloadOutlined />}
                  href={importApi.templateUrl(dataType)}
                  disabled={dataTypeSelection === "auto"}
                  title={
                    dataTypeSelection === "auto"
                      ? "下载模板前请先选择一种具体数据类型"
                      : undefined
                  }
                >
                  下载空白模板
                </Button>
              </Flex>
            </Flex>
          ) : null}

          {current === 1 ? (
            <Flex vertical gap="large">
              <Typography.Title level={3}>2. 上传 CSV 或 XLSX</Typography.Title>
              <Dragger
                accept=".csv,.xlsx"
                beforeUpload={(selected) => {
                  selectFile(selected);
                  return false;
                }}
                maxCount={1}
                multiple={false}
                onRemove={() => {
                  selectFile(null);
                }}
              >
                <p className="ant-upload-drag-icon">
                  <InboxOutlined />
                </p>
                <p className="ant-upload-text">点击或拖拽文件到这里</p>
                <p className="ant-upload-hint">
                  支持 UTF-8、UTF-8 BOM、GB18030/GBK CSV 与 XLSX。
                </p>
              </Dragger>
              {file !== null ? (
                <Descriptions bordered size="small" column={{ xs: 1, sm: 3 }}>
                  <Descriptions.Item label="文件名">
                    {file.name}
                  </Descriptions.Item>
                  <Descriptions.Item label="文件大小">
                    {formatFileSize(file.size)}
                  </Descriptions.Item>
                  <Descriptions.Item label="格式">
                    {file.name.toLocaleLowerCase().endsWith(".xlsx")
                      ? "XLSX"
                      : "CSV"}
                  </Descriptions.Item>
                  {task?.file_format === "csv" ? (
                    <Descriptions.Item label="检测编码">
                      {task.encoding ?? "需人工选择"}
                    </Descriptions.Item>
                  ) : null}
                  {task?.file_format === "xlsx" ? (
                    <Descriptions.Item label="工作表数量">
                      {task.sheet_count ?? task.sheets.length}
                    </Descriptions.Item>
                  ) : null}
                </Descriptions>
              ) : null}
              <Typography.Text type="secondary">
                仅接受 .csv 和 .xlsx，单文件最大{" "}
                {formatFileSize(MAX_IMPORT_BYTES)}。
              </Typography.Text>
              <Flex gap="small" wrap>
                <Button onClick={() => setCurrent(0)}>上一步</Button>
                <Button
                  type="primary"
                  loading={busy}
                  disabled={file === null}
                  onClick={() => void handleUpload()}
                >
                  浏览器本地读取并检查
                </Button>
              </Flex>
            </Flex>
          ) : null}

          {current === 2 && task !== null ? (
            <Flex vertical gap="large">
              <Typography.Title level={3}>3. 选择解析方式</Typography.Title>
              {task.encoding_required ? (
                <Alert
                  showIcon
                  type="warning"
                  message="编码无法可靠自动确认"
                  description="请选择与原文件一致的中文编码；系统不会静默猜测。"
                />
              ) : null}
              {task.encoding_options.length > 0 ? (
                <label className="import-field">
                  <Typography.Text strong>CSV 编码</Typography.Text>
                  <Select
                    aria-label="CSV 编码"
                    value={encoding}
                    options={task.encoding_options.map((value) => ({
                      value,
                      label: value,
                    }))}
                    onChange={setEncoding}
                  />
                </label>
              ) : null}
              {task.sheets.length > 0 ? (
                <label className="import-field">
                  <Typography.Text strong>工作表</Typography.Text>
                  <Select
                    aria-label="工作表"
                    value={sheetName}
                    options={task.sheets.map((sheet) => ({
                      value: sheet.name,
                      label: `${sheet.name}${sheet.state === "visible" ? "" : "（隐藏）"}`,
                    }))}
                    onChange={setSheetName}
                  />
                </label>
              ) : null}
              <Flex gap="small" wrap>
                <Button onClick={() => setCurrent(1)}>上一步</Button>
                <Button
                  type="primary"
                  loading={busy}
                  disabled={
                    (task.encoding_required && encoding === undefined) ||
                    (task.sheets.length > 0 && sheetName === undefined)
                  }
                  onClick={() => void handleParse()}
                >
                  解析并预览
                </Button>
              </Flex>
            </Flex>
          ) : null}

          {current === 3 && parsed !== null ? (
            <Flex vertical gap="large">
              <Typography.Title level={3}>4. 数据预览</Typography.Title>
              <Card size="small" title="数据类型">
                <Flex vertical gap="small">
                  <Flex gap="small" align="center" wrap>
                    <Select
                      aria-label="当前数据类型"
                      value={dataType}
                      style={{ width: 260 }}
                      options={dataTypeOptions
                        .filter(
                          (
                            option,
                          ): option is (typeof dataTypeOptions)[number] & {
                            value: DataType;
                          } => option.value !== "auto",
                        )
                        .map((option) => ({
                          label: option.label,
                          value: option.value,
                        }))}
                      onChange={(value: DataType) =>
                        void switchParsedDataType(value)
                      }
                    />
                    <Tag
                      color={
                        parsed.detection_confidence >= 0.9 ? "green" : "blue"
                      }
                    >
                      {parsed.schema_selection_mode === "auto"
                        ? `自动识别 ${Math.round(parsed.detection_confidence * 100)}%`
                        : "用户指定"}
                    </Tag>
                  </Flex>
                  <Typography.Text>
                    系统结合字段名称、内容特征、唯一值比例和一单多事件关系完成判断；可在此一次切换，不需要理解内部
                    Schema 名称。
                  </Typography.Text>
                  {parsed.type_mismatch_warning ? (
                    <Alert
                      showIcon
                      type="warning"
                      message={parsed.type_mismatch_warning}
                      action={
                        <Button
                          size="small"
                          onClick={() =>
                            void switchParsedDataType(parsed.detected_data_type)
                          }
                        >
                          切换为
                          {
                            dataTypeOptions.find(
                              (item) =>
                                item.value === parsed.detected_data_type,
                            )?.label
                          }
                        </Button>
                      }
                    />
                  ) : null}
                </Flex>
              </Card>
              {parsed.date_order_inference?.ambiguous ? (
                <Alert
                  showIcon
                  type="warning"
                  message="该文件存在日期顺序歧义，只需确认一次"
                  description={
                    <Flex vertical gap="small">
                      <Typography.Text>
                        {parsed.date_order_inference.evidence.join("；")}
                      </Typography.Text>
                      <Radio.Group
                        aria-label="整份文件日期顺序"
                        value={dateOrder}
                        onChange={(event) =>
                          setDateOrder(event.target.value as ImportDateOrder)
                        }
                        options={[
                          { label: "日/月/年", value: "DMY" },
                          { label: "月/日/年", value: "MDY" },
                        ]}
                      />
                    </Flex>
                  }
                />
              ) : null}
              <Alert
                showIcon
                type={parsed.sensitive_risks.length > 0 ? "warning" : "success"}
                message={
                  parsed.sensitive_risks.length > 0
                    ? `发现 ${parsed.sensitive_risks.length} 个疑似敏感字段`
                    : "未在预览中发现常见个人信息字段"
                }
                description={
                  parsed.sensitive_risks.length > 0
                    ? parsed.sensitive_risks
                        .map((risk) => `${risk.source_column}：${risk.message}`)
                        .join("；")
                    : "仍建议在导入前删除分析不需要的姓名、电话和详细地址。"
                }
              />
              <Row gutter={[12, 12]}>
                {[
                  ["原始总行数", parsed.total_rows],
                  [
                    "识别字段数",
                    parsed.suggestions.filter(
                      (suggestion) => suggestion.candidates.length > 0,
                    ).length,
                  ],
                  ["未识别字段数", parsed.unmapped_source_columns.length],
                  [
                    "自动匹配字段数",
                    parsed.suggestions.filter(
                      (suggestion) =>
                        suggestion.suggested_field !== null &&
                        !suggestion.requires_confirmation,
                    ).length,
                  ],
                  [
                    "需要人工确认",
                    parsed.suggestions.filter(
                      (suggestion) => suggestion.requires_confirmation,
                    ).length,
                  ],
                ].map(([title, value]) => (
                  <Col xs={12} md={8} xl={4} key={String(title)}>
                    <Card size="small">
                      <Statistic title={title} value={value} />
                    </Card>
                  </Col>
                ))}
              </Row>
              <Descriptions bordered size="small" column={{ xs: 1, md: 2 }}>
                <Descriptions.Item label="文件名">
                  {parsed.task.file_name}
                </Descriptions.Item>
                <Descriptions.Item label="数据类型">
                  {
                    dataTypeOptions.find((item) => item.value === dataType)
                      ?.label
                  }
                </Descriptions.Item>
                <Descriptions.Item label="工作表">
                  {parsed.task.selected_sheet ?? "CSV 单表"}
                </Descriptions.Item>
                <Descriptions.Item label="处理位置">
                  {parsed.task.processing_location === "browser"
                    ? "当前浏览器"
                    : "本地 API"}
                </Descriptions.Item>
              </Descriptions>
              <Alert
                showIcon
                type={
                  parsed.detected_data_type === dataType ? "success" : "warning"
                }
                message={`数据类型识别：${
                  parsed.data_type_candidates[0]?.display_name ??
                  parsed.detected_data_type
                }（${Math.round(parsed.detection_confidence * 100)}%）`}
                description={
                  parsed.detected_data_type === dataType
                    ? "识别结果与当前选择一致；仍请结合业务含义复核。"
                    : "识别结果与当前选择不同。系统没有静默改型，请返回第一步选择正确类型后重新上传。"
                }
              />
              {parsed.warnings.map((warning) => (
                <Alert
                  key={warning}
                  showIcon
                  type="warning"
                  message={warning}
                />
              ))}
              <Typography.Text>
                共 {parsed.total_rows} 行；下表仅展示前{" "}
                {parsed.preview_rows.length} 行， 敏感内容已经遮罩。
              </Typography.Text>
              <Table
                columns={previewColumns}
                dataSource={parsed.preview_rows}
                pagination={false}
                rowKey="row_number"
                scroll={{ x: "max-content", y: 420 }}
                size="small"
              />
              <Flex gap="small" wrap>
                <Button
                  onClick={() =>
                    setCurrent(
                      parsed.task.encoding_options.length > 0 ||
                        parsed.task.sheets.length > 0
                        ? 2
                        : 1,
                    )
                  }
                >
                  {parsed.task.encoding_options.length > 0 ||
                  parsed.task.sheets.length > 0
                    ? "返回解析设置"
                    : "返回上传"}
                </Button>
                <Button type="primary" onClick={() => setCurrent(4)}>
                  下一步：字段映射
                </Button>
              </Flex>
            </Flex>
          ) : null}

          {current === 4 && parsed !== null ? (
            <Flex vertical gap="large">
              <Typography.Title level={3}>5. 快速导入</Typography.Title>
              <Alert
                showIcon
                type={blockingMappingCount === 0 ? "success" : "info"}
                message={
                  blockingMappingCount === 0
                    ? "字段已准备好，可以开始分析"
                    : `还需处理 ${blockingMappingCount} 个字段`
                }
                description="高置信度字段已自动映射；中等置信度建议可一次批量采用，非必要字段可一次批量忽略。完整字段表默认折叠。"
              />
              {parsed.unmapped_source_columns.length > 0 ? (
                <Alert
                  showIcon
                  type="info"
                  message={`${parsed.unmapped_source_columns.length} 个附加字段未自动映射`}
                  description={`这些列仍保留在预览中且不会静默删除：${parsed.unmapped_source_columns.join("、")}`}
                />
              ) : null}
              <Alert
                showIcon
                type="info"
                message="数据标准化规则"
                description={
                  <ul className="case-list">
                    {parsed.conversion_notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                }
              />
              <Row gutter={[12, 12]} aria-label="字段映射进度">
                {[
                  ["已映射", mappingSummary.mapped],
                  ["待确认", mappingSummary.pendingConfirmation],
                  ["未处理", mappingSummary.unresolved],
                  ["已忽略", mappingSummary.ignored],
                  ["辅助识别", mappingSummary.auxiliary],
                ].map(([title, value]) => (
                  <Col xs={12} md={6} xl={4} key={String(title)}>
                    <Card size="small">
                      <Statistic title={title} value={value} />
                    </Card>
                  </Col>
                ))}
              </Row>
              <Flex gap="small" wrap>
                <Tooltip title="一次采用所有中等置信度且没有目标冲突的推荐；高置信度字段已经自动完成。">
                  <Button
                    disabled={recommendedMappingSources.length === 0}
                    onClick={applyRecommendedMappings}
                  >
                    全部采用推荐映射（{recommendedMappingSources.length}）
                  </Button>
                </Tooltip>
                <Tooltip title="仅忽略不影响当前数据类型和后续分析的未处理字段">
                  <Button
                    disabled={safelyIgnorableColumns.length === 0}
                    onClick={ignoreSafelyInBulk}
                  >
                    一键忽略非必要字段（{safelyIgnorableColumns.length}）
                  </Button>
                </Tooltip>
                {lastBulkIgnored.length > 0 ? (
                  <Button onClick={undoBulkIgnore}>撤销本次忽略</Button>
                ) : null}
                <Button
                  type="primary"
                  loading={busy}
                  disabled={
                    blockingMappingCount > 0 ||
                    (parsed.date_order_inference?.ambiguous === true &&
                      dateOrder === undefined)
                  }
                  onClick={() => void handleQuickAnalyze()}
                >
                  开始分析
                </Button>
              </Flex>
              {blockingMappingCount > 0 ? (
                <Alert
                  showIcon
                  type="warning"
                  message={`还有 ${blockingMappingCount} 个字段待处理`}
                  description="请为字段选择目标、重新选择以确认低置信度建议，或明确忽略后再运行质量校验。"
                />
              ) : null}
              <Collapse
                className="advanced-mapping-collapse"
                items={[
                  {
                    key: "advanced-fields",
                    label: `高级字段设置（${parsed.suggestions.length} 个源字段）`,
                    children:
                      screens.md === false ? (
                        <Flex
                          className="mapping-mobile-list"
                          vertical
                          gap="middle"
                        >
                          {parsed.suggestions.map((suggestion) => (
                            <Card
                              className={
                                ignoredSourceSet.has(suggestion.source_column)
                                  ? "mapping-mobile-card mapping-row-ignored"
                                  : "mapping-mobile-card"
                              }
                              key={suggestion.source_column}
                              size="small"
                              title={suggestion.source_column}
                            >
                              <Flex vertical gap="middle">
                                <label className="import-field">
                                  <Typography.Text strong>
                                    目标字段
                                  </Typography.Text>
                                  {renderMappingTarget(suggestion)}
                                </label>
                                <Row gutter={[12, 12]}>
                                  <Col xs={14}>
                                    <Typography.Text strong>
                                      置信度
                                    </Typography.Text>
                                    <div className="mapping-mobile-meta">
                                      {renderMappingConfidence(suggestion)}
                                    </div>
                                  </Col>
                                  <Col xs={10}>
                                    <Typography.Text strong>
                                      匹配方式
                                    </Typography.Text>
                                    <div className="mapping-mobile-meta">
                                      {renderMappingMethod(suggestion)}
                                    </div>
                                  </Col>
                                </Row>
                              </Flex>
                            </Card>
                          ))}
                        </Flex>
                      ) : (
                        <Table
                          className="mapping-table"
                          rowClassName={(suggestion) =>
                            ignoredSourceSet.has(suggestion.source_column)
                              ? "mapping-row-ignored"
                              : ""
                          }
                          rowKey="source_column"
                          pagination={false}
                          scroll={{ x: 1120 }}
                          dataSource={parsed.suggestions}
                          columns={[
                            {
                              title: "原字段",
                              dataIndex: "source_column",
                              key: "source_column",
                              width: 210,
                            },
                            {
                              title: "目标字段",
                              key: "target",
                              width: 560,
                              render: (_, suggestion) =>
                                renderMappingTarget(suggestion),
                            },
                            {
                              title: "置信度",
                              key: "confidence",
                              width: 200,
                              render: (_, suggestion) =>
                                renderMappingConfidence(suggestion),
                            },
                            {
                              title: "匹配方式",
                              key: "method",
                              width: 150,
                              render: (_, suggestion) =>
                                renderMappingMethod(suggestion),
                            },
                          ]}
                        />
                      ),
                  },
                ]}
              />
              <label className="import-field">
                <Typography.Text strong>无时区时间的默认时区</Typography.Text>
                <Input
                  aria-label="默认时区"
                  value={timezone}
                  onChange={(event) => setTimezone(event.target.value)}
                  placeholder="例如 Asia/Shanghai"
                />
                <Typography.Text type="secondary">
                  已带 UTC 偏移的 ISO 8601
                  时间保持原偏移；无时区时间必须使用有效 IANA 时区后才能计算。
                </Typography.Text>
              </label>
              <Flex gap="small" wrap>
                <Button onClick={() => setCurrent(3)}>返回预览</Button>
                <Button
                  type="primary"
                  loading={busy}
                  disabled={blockingMappingCount > 0}
                  onClick={() => void handleValidate()}
                >
                  运行质量校验
                </Button>
              </Flex>
            </Flex>
          ) : null}

          {current === 5 && validation !== null && task !== null ? (
            <Flex vertical gap="large">
              <Typography.Title level={3}>6. 质量校验报告</Typography.Title>
              <Alert
                showIcon
                type={validation.report.can_confirm ? "success" : "error"}
                message={
                  validation.report.can_confirm
                    ? "校验通过，可以确认导入"
                    : "存在阻断错误，暂不能确认导入"
                }
                description={
                  validation.report.can_confirm
                    ? "警告项仍会保留，请在使用数据前复核。"
                    : "请下载错误明细，或返回修改字段映射后重新校验。"
                }
              />
              <Row gutter={[16, 16]}>
                {[
                  ["总行数", validation.report.total_rows],
                  ["有效行数", validation.report.valid_rows],
                  ["错误行数", validation.report.error_rows],
                  ["警告行数", validation.report.warning_rows],
                  ["重复键", validation.report.duplicate_keys],
                  ["非法时间", validation.report.invalid_times],
                  ["时间顺序冲突", validation.report.time_order_conflicts],
                  ["负数量", validation.report.negative_quantities],
                  ["未知状态", validation.report.unknown_statuses],
                  ["异常长文本", validation.report.long_text_values],
                  ["无法解析值", validation.report.unparseable_values],
                  ["完全重复行", validation.report.exact_duplicate_rows],
                  [
                    "已忽略字段",
                    validation.report.ignored_source_columns.length,
                  ],
                  [
                    "未处理字段",
                    validation.report.unresolved_source_columns.length,
                  ],
                ].map(([title, value]) => (
                  <Col xs={12} md={8} xl={6} key={String(title)}>
                    <Card size="small">
                      <Statistic title={title} value={value} />
                    </Card>
                  </Col>
                ))}
              </Row>
              {unknownStatuses.length > 0 ? (
                <Card title="项目级状态映射" size="small">
                  <Alert
                    showIcon
                    type="warning"
                    message="未知状态已保留为 unmapped"
                    description="可在这里补充项目级映射并重新校验；原始状态始终保留。"
                  />
                  <Flex vertical gap="small" className="status-mapping-list">
                    {unknownStatuses.map((item) => (
                      <Flex
                        key={item.raw_status}
                        gap="small"
                        align="center"
                        wrap
                      >
                        <Typography.Text className="status-raw-value">
                          {item.raw_status}（{item.occurrences} 次）
                        </Typography.Text>
                        <Select
                          aria-label={`${item.raw_status} 标准状态`}
                          placeholder="选择标准状态"
                          value={projectStatusMappings[item.raw_status]}
                          options={statusOptions[dataType].map((status) => ({
                            value: status,
                            label: status,
                          }))}
                          onChange={(value: string) => {
                            setProjectStatusMappings((previous) => ({
                              ...previous,
                              [item.raw_status]: value,
                            }));
                            setValidationStale(true);
                            setTask((previous) =>
                              previous === null
                                ? null
                                : {
                                    ...previous,
                                    message:
                                      "项目级状态映射已修改，需要重新运行质量校验。",
                                    status: "awaiting_mapping",
                                    status_label: "待映射",
                                  },
                            );
                          }}
                        />
                      </Flex>
                    ))}
                    <Button
                      loading={busy}
                      onClick={() => void handleValidate()}
                    >
                      应用状态映射并重新校验
                    </Button>
                  </Flex>
                </Card>
              ) : null}
              <Card title="逐项问题明细" size="small">
                <Table
                  rowKey="issue_id"
                  columns={qualityIssueColumns}
                  dataSource={validation.report.issues}
                  locale={{ emptyText: "没有需要报告的问题" }}
                  pagination={{ pageSize: 20, hideOnSinglePage: true }}
                  scroll={{ x: 1200, y: 460 }}
                  size="small"
                />
              </Card>
              <Card title="字段处理状态" size="small">
                <Flex gap="small" wrap>
                  {(
                    [
                      "mapped",
                      "generated",
                      "inferred",
                      "ignored",
                      "unresolved",
                      "blocking",
                    ] as const
                  ).map((status) => (
                    <Tag
                      key={status}
                      color={
                        status === "blocking"
                          ? "red"
                          : status === "unresolved"
                            ? "orange"
                            : undefined
                      }
                    >
                      {status}：
                      {
                        validation.report.field_resolutions.filter(
                          (item) => item.status === status,
                        ).length
                      }
                    </Tag>
                  ))}
                </Flex>
              </Card>
              <Flex gap="small" wrap>
                <Button onClick={() => setCurrent(4)}>返回修改映射</Button>
                <Button
                  icon={<DownloadOutlined />}
                  href={importApi.errorsUrl(task.task_id)}
                >
                  下载错误明细 CSV
                </Button>
                <Button
                  type="primary"
                  disabled={!validation.report.can_confirm || validationStale}
                  onClick={() => setCurrent(6)}
                >
                  下一步：确认导入
                </Button>
              </Flex>
            </Flex>
          ) : null}

          {current === 6 && validation !== null && task !== null ? (
            confirmed === null ? (
              <Flex vertical gap="large">
                <Typography.Title level={3}>7. 确认导入</Typography.Title>
                <Alert
                  showIcon
                  type="warning"
                  message="确认后原始上传文件会被清理"
                  description="系统只保留标准化后的本地数据集和可追溯质量报告。当前结果是导入校验结果，不是业务预测。"
                />
                <Descriptions bordered size="small" column={1}>
                  <Descriptions.Item label="数据类型">
                    {
                      dataTypeOptions.find((item) => item.value === dataType)
                        ?.label
                    }
                  </Descriptions.Item>
                  <Descriptions.Item label="文件">
                    {task.file_name}
                  </Descriptions.Item>
                  <Descriptions.Item label="有效行">
                    {validation.report.valid_rows}
                  </Descriptions.Item>
                  <Descriptions.Item label="错误行">
                    {validation.report.error_rows}
                  </Descriptions.Item>
                  <Descriptions.Item label="已忽略字段">
                    {validation.report.ignored_source_columns.length > 0
                      ? validation.report.ignored_source_columns.join("、")
                      : "无"}
                  </Descriptions.Item>
                  <Descriptions.Item label="默认时区">
                    {timezone || "未设置"}
                  </Descriptions.Item>
                </Descriptions>
                <Flex gap="small" wrap>
                  <Button onClick={() => setCurrent(5)}>返回质量报告</Button>
                  <Button
                    type="primary"
                    icon={<CheckCircleOutlined />}
                    loading={busy}
                    disabled={!validation.report.can_confirm || validationStale}
                    onClick={() => void handleConfirm()}
                  >
                    确认并生成可分析数据集
                  </Button>
                </Flex>
              </Flex>
            ) : (
              <Result
                status="success"
                title={
                  confirmed.dataset_id.startsWith("browser-local-")
                    ? "数据已导入当前浏览器"
                    : "数据已进入可分析状态"
                }
                subTitle={
                  confirmed.dataset_id.startsWith("browser-local-")
                    ? `已在浏览器 IndexedDB 保存 ${confirmed.imported_rows} 行标准化数据；原始文件没有上传。可以立即分析当前可用信息，缺少订单表时 OT、IF、OTIF 会明确显示不可计算。`
                    : `数据集 ${confirmed.dataset_id} 已导入 ${confirmed.imported_rows} 行；可前往“分析总览”计算指标。`
                }
                extra={[
                  <Button key="analytics" type="primary" href="/analytics">
                    前往分析总览
                  </Button>,
                  <Button key="again" onClick={() => void handleCancel()}>
                    导入另一份数据
                  </Button>,
                ]}
              />
            )
          ) : null}
        </section>

        {task !== null && confirmed === null ? (
          <Flex justify="end">
            <Button danger disabled={busy} onClick={() => void handleCancel()}>
              取消任务并清理文件
            </Button>
          </Flex>
        ) : null}
      </Card>
    </>
  );
}
