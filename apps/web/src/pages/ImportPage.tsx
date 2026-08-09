import {
  CheckCircleOutlined,
  DownloadOutlined,
  InboxOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Flex,
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
  Typography,
  Upload,
} from "antd";
import { useMemo, useState } from "react";

import { importApi } from "../api/imports";
import { ApiClientError } from "../api/client";
import { useNotifications } from "../components/notification-context";
import { PageHeader } from "../components/PageHeader";
import { isCloudflareDeploy } from "../config/runtime";
import type {
  ConfirmResponse,
  DataType,
  ImportTask,
  ParseResponse,
  QualityIssue,
  ValidationResponse,
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
  value: DataType;
  label: string;
  description: string;
}> = [
  {
    value: "orders",
    label: "订单表",
    description: "订单创建、承诺与实际交付、数量和订单状态。",
  },
  {
    value: "warehouse_events",
    label: "仓库事件表",
    description: "拣货、质检、打包、出库等仓内作业事件。",
  },
  {
    value: "tracking_events",
    label: "物流轨迹表",
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

export function ImportPage() {
  const notifications = useNotifications();
  const [current, setCurrent] = useState(0);
  const [dataType, setDataType] = useState<DataType>("orders");
  const [file, setFile] = useState<File | null>(null);
  const [task, setTask] = useState<ImportTask | null>(null);
  const [encoding, setEncoding] = useState<string>();
  const [sheetName, setSheetName] = useState<string>();
  const [parsed, setParsed] = useState<ParseResponse | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [timezone, setTimezone] = useState("Asia/Shanghai");
  const [projectStatusMappings, setProjectStatusMappings] = useState<
    Record<string, string>
  >({});
  const [validation, setValidation] = useState<ValidationResponse | null>(null);
  const [confirmed, setConfirmed] = useState<ConfirmResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [persistentError, setPersistentError] = useState<string | null>(null);

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

  function applyParsed(response: ParseResponse) {
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
    setPersistentError(null);
    setCurrent(3);
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
    const response = await runAction(() => importApi.upload(dataType, file));
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

  async function handleValidate() {
    if (task === null) {
      return;
    }
    const response = await runAction(() =>
      importApi.validate(task.task_id, {
        mapping,
        default_timezone: timezone.trim() || null,
        project_status_mappings: projectStatusMappings,
      }),
    );
    if (response !== null) {
      setTask(response.task);
      setValidation(response);
      setCurrent(5);
    }
  }

  async function handleConfirm() {
    if (task === null) {
      return;
    }
    const response = await runAction(() => importApi.confirm(task.task_id));
    if (response !== null) {
      setTask(response.task);
      setConfirmed(response);
      window.localStorage.setItem(
        `fulfilllens.dataset.${response.task.data_type}`,
        response.dataset_id,
      );
      notifications.showSuccess("导入完成", "数据集已进入“可分析”状态。");
    }
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
    setProjectStatusMappings({});
    setPersistentError(null);
    setCurrent(0);
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
    { title: "问题", dataIndex: "message", key: "message", width: 260 },
    {
      title: "原始值",
      dataIndex: "raw_value",
      key: "raw_value",
      width: 160,
      render: (value: string | null) => value || "—",
    },
    {
      title: "建议修复",
      dataIndex: "suggestion",
      key: "suggestion",
      width: 260,
    },
  ];

  return (
    <>
      <PageHeader
        title="数据导入"
        description={
          isCloudflareDeploy
            ? "在线版可直接加载公开合成示例；真实订单、仓库作业和物流轨迹不会上传到此站点。"
            : "逐步导入订单、仓库作业或物流轨迹。系统会先预览、映射和校验，只有确认后才形成可分析数据集。"
        }
      />

      <Alert
        className="prominent-alert"
        showIcon
        type="info"
        message={
          isCloudflareDeploy ? "在线版不接收真实文件" : "文件仅在本机处理"
        }
        description={
          isCloudflareDeploy
            ? "请使用下方的合成案例完成完整操作流程。真实业务数据请使用本地版或经授权的私有云部署。"
            : "限制为 CSV/XLSX，单文件最大 10 MiB；不执行宏与公式。姓名、手机号、详细地址和身份证等字段只提示风险，预览会脱敏。"
        }
      />

      <Card className="section-card import-wizard">
        <Steps
          current={current}
          items={stepItems}
          responsive
          size="small"
          aria-label="数据导入步骤"
        />
        {task !== null ? (
          <Flex className="import-task-status" align="center" gap="small" wrap>
            <Typography.Text strong>当前任务</Typography.Text>
            <Tag color={statusColor(task.status)}>{task.status_label}</Tag>
            <Typography.Text>{task.message}</Typography.Text>
          </Flex>
        ) : null}
        {persistentError !== null ? (
          <Alert
            className="import-persistent-error"
            type="error"
            showIcon
            message="导入操作未完成"
            description={persistentError}
          />
        ) : null}

        <section className="import-step-panel">
          {current === 0 ? (
            <Flex vertical gap="large">
              <Typography.Title level={3}>1. 选择数据类型</Typography.Title>
              <Radio.Group
                className="data-type-grid"
                value={dataType}
                onChange={(event) => {
                  setDataType(event.target.value as DataType);
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
                  setFile(selected);
                  setPersistentError(null);
                  return false;
                }}
                maxCount={1}
                multiple={false}
                onRemove={() => {
                  setFile(null);
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
              <Flex gap="small" wrap>
                <Button onClick={() => setCurrent(0)}>上一步</Button>
                <Button
                  type="primary"
                  loading={busy}
                  disabled={file === null}
                  onClick={() => void handleUpload()}
                >
                  安全上传并检查
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
              <Typography.Title level={3}>5. 字段映射</Typography.Title>
              <Alert
                showIcon
                type="info"
                message="自动匹配只是建议"
                description="建议基于英文代码、中文别名和字段名相似度；请根据置信度复核。返回本页修改映射不需要重新上传。"
              />
              <Table
                rowKey="source_column"
                pagination={false}
                scroll={{ x: 760 }}
                dataSource={parsed.suggestions}
                columns={[
                  {
                    title: "源字段",
                    dataIndex: "source_column",
                    key: "source_column",
                    width: 180,
                  },
                  {
                    title: "映射到",
                    key: "target",
                    width: 280,
                    render: (_, suggestion) => (
                      <Select
                        aria-label={`${suggestion.source_column} 映射目标`}
                        allowClear
                        showSearch
                        optionFilterProp="label"
                        value={mapping[suggestion.source_column] ?? undefined}
                        options={parsed.fields.map((field) => ({
                          value: field.field,
                          label: `${field.label}（${field.field}）${field.required ? " *" : ""}`,
                        }))}
                        onChange={(value: string | undefined) => {
                          setMapping((previous) => ({
                            ...previous,
                            [suggestion.source_column]: value ?? null,
                          }));
                        }}
                      />
                    ),
                  },
                  {
                    title: "置信度",
                    dataIndex: "confidence",
                    key: "confidence",
                    width: 160,
                    render: (confidence: number) => (
                      <Progress
                        percent={Math.round(confidence * 100)}
                        size="small"
                        status={confidence >= 0.86 ? "success" : "normal"}
                      />
                    ),
                  },
                  {
                    title: "依据",
                    dataIndex: "method",
                    key: "method",
                    width: 140,
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
                  disabled={!validation.report.can_confirm}
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
                    onClick={() => void handleConfirm()}
                  >
                    确认并生成可分析数据集
                  </Button>
                </Flex>
              </Flex>
            ) : (
              <Result
                status="success"
                title="数据已进入可分析状态"
                subTitle={`数据集 ${confirmed.dataset_id} 已导入 ${confirmed.imported_rows} 行；可复制数据集标识并前往“分析总览”计算指标。`}
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
