import {
  CheckCircleOutlined,
  CloudDownloadOutlined,
  EyeOutlined,
  FileTextOutlined,
  SafetyCertificateOutlined,
  StopOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Descriptions,
  Empty,
  Flex,
  Input,
  Modal,
  Progress,
  Row,
  Segmented,
  Select,
  Skeleton,
  Space,
  Statistic,
  Switch,
  Tag,
  Typography,
} from "antd";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiClientError } from "../api/client";
import { reportsApi } from "../api/reports";
import { simulationApi } from "../api/simulation";
import { useNotifications } from "../components/notification-context";
import { PageHeader } from "../components/PageHeader";
import {
  hasBrowserDatasetSelection,
  initialAnalysisDataset,
} from "../analysis/browserSelection";
import type { DashboardFilters } from "../types/dashboard";
import type { DatasetSelection } from "../types/metrics";
import type {
  CsvExportKind,
  ReportCapabilities,
  ReportDocument,
  ReportFormat,
  ReportJob,
  ReportRequest,
  ReportReadingMode,
  ReportSection,
  ReportSectionCode,
} from "../types/reports";
import type { ScenarioRecord } from "../types/simulation";

const FILTER_STORAGE_KEY = "fulfilllens.dashboard.filters";
const DEFAULT_FILTERS: DashboardFilters = {
  start_date: null,
  end_date: null,
  warehouses: [],
  carriers: [],
  regions: [],
  statuses: [],
  anomaly_types: [],
  timezone: "Asia/Shanghai",
};

const SECTION_OPTIONS: Array<{ label: string; value: ReportSectionCode }> = [
  { label: "执行摘要", value: "executive_summary" },
  { label: "数据质量", value: "data_quality" },
  { label: "指标总览", value: "metrics_overview" },
  { label: "趋势", value: "trend" },
  { label: "节点耗时", value: "node_duration" },
  { label: "维度对比", value: "dimension_breakdown" },
  { label: "异常诊断", value: "diagnostics" },
  { label: "行动建议", value: "recommendations" },
  { label: "订单样例", value: "order_samples" },
  { label: "模拟方案", value: "simulation" },
  { label: "方法与限制", value: "methods_limits" },
];
const ALL_SECTIONS = SECTION_OPTIONS.map((item) => item.value);
const CSV_OPTIONS: Array<{ label: string; value: CsvExportKind }> = [
  { label: "异常订单", value: "anomaly_orders" },
  { label: "数据质量错误", value: "data_quality_errors" },
  { label: "状态映射", value: "status_mapping" },
  { label: "指标明细", value: "metric_detail" },
  { label: "模拟对比", value: "simulation_comparison" },
];
const JOB_STATUS: Record<ReportJob["status"], string> = {
  queued: "等待导出",
  running: "正在导出",
  completed: "导出完成",
  failed: "导出失败",
  cancelled: "已取消",
};

function datasetId(key: string): string {
  return initialAnalysisDataset(key);
}

function storedFilters(): DashboardFilters {
  const raw = window.localStorage.getItem(FILTER_STORAGE_KEY);
  if (!raw) return DEFAULT_FILTERS;
  try {
    const value = JSON.parse(raw) as Partial<DashboardFilters>;
    return {
      ...DEFAULT_FILTERS,
      ...value,
      warehouses: Array.isArray(value.warehouses) ? value.warehouses : [],
      carriers: Array.isArray(value.carriers) ? value.carriers : [],
      regions: Array.isArray(value.regions) ? value.regions : [],
      statuses: Array.isArray(value.statuses) ? value.statuses : [],
      anomaly_types: Array.isArray(value.anomaly_types)
        ? value.anomaly_types
        : [],
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}

function readableError(error: unknown): string {
  if (error instanceof ApiClientError) {
    const detail = error.details.map((item) => item.message).join("；");
    return `${error.message}${detail ? ` ${detail}` : ""}（${error.code}）`;
  }
  return error instanceof Error ? error.message : "报告请求未完成。";
}

function percent(value: number | null): string {
  return value === null ? "不可计算" : `${(value * 100).toFixed(1)}%`;
}

function dateTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString("zh-CN");
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null,
  );
}

function valueText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.map(valueText).join("、") || "—";
  if (typeof value === "number")
    return Number.isInteger(value) ? `${value}` : value.toFixed(2);
  if (typeof value === "object") return JSON.stringify(value) ?? "—";
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || typeof value === "bigint")
    return `${value}`;
  return "—";
}

function PreviewSection({ section }: { section: ReportSection }) {
  const [recommendationView, setRecommendationView] = useState<
    "professional" | "executive"
  >("professional");
  const metrics = arrayOfRecords(section.data.metrics);
  const findings = arrayOfRecords(section.data.results);
  const orders = arrayOfRecords(section.data.orders);
  const groups = arrayOfRecords(section.data.groups);
  const nodes = arrayOfRecords(section.data.nodes);
  const qualityWarnings = arrayOfRecords(section.data.warnings);
  const methodItems = Array.isArray(section.data.items)
    ? section.data.items
    : [];
  const result =
    typeof section.data.result === "object" && section.data.result !== null
      ? (section.data.result as Record<string, unknown>)
      : null;
  const professionalPlans = arrayOfRecords(
    section.data.professional_action_plan,
  );
  const executiveBrief =
    typeof section.data.executive_brief === "object" &&
    section.data.executive_brief !== null
      ? (section.data.executive_brief as Record<string, unknown>)
      : null;

  return (
    <Card className="section-card report-preview-section" title={section.title}>
      {section.narrative.map((item) => (
        <Typography.Paragraph key={item}>{item}</Typography.Paragraph>
      ))}
      {section.code === "executive_summary" ? (
        <Typography.Text>本节内容汇总在报告顶部的执行摘要中。</Typography.Text>
      ) : null}
      {section.code === "data_quality" ? (
        <>
          <Descriptions size="small" bordered column={{ xs: 1, sm: 2 }}>
            <Descriptions.Item label="订单数">
              {valueText(section.data.order_count)}
            </Descriptions.Item>
            <Descriptions.Item label="有效订单">
              {valueText(section.data.valid_order_count)}
            </Descriptions.Item>
            <Descriptions.Item label="覆盖率">
              {percent(
                typeof section.data.data_coverage === "number"
                  ? section.data.data_coverage
                  : null,
              )}
            </Descriptions.Item>
            <Descriptions.Item label="质量警告">
              {valueText(section.data.warning_count)}
            </Descriptions.Item>
          </Descriptions>
          {qualityWarnings.slice(0, 3).map((warning, index) => (
            <Alert
              key={`${valueText(warning.code)}-${index}`}
              type="warning"
              showIcon
              title={valueText(warning.message)}
            />
          ))}
        </>
      ) : null}
      {metrics.length > 0 ? (
        <Row gutter={[12, 12]}>
          {metrics.slice(0, 8).map((metric) => (
            <Col xs={24} sm={12} lg={6} key={String(metric.code)}>
              <Card size="small">
                <Statistic
                  title={String(metric.display_name ?? metric.code)}
                  value={
                    metric.value === null || metric.value === undefined
                      ? "不可计算"
                      : metric.unit === "ratio"
                        ? `${(Number(metric.value) * 100).toFixed(1)}%`
                        : Number(metric.value).toFixed(
                            metric.unit === "order" ? 0 : 2,
                          )
                  }
                  suffix={metric.unit === "hour" ? "小时" : undefined}
                />
                <Typography.Text>
                  分子 {valueText(metric.numerator)} / 分母{" "}
                  {valueText(metric.denominator)}； 覆盖率{" "}
                  {percent(
                    typeof metric.coverage === "number"
                      ? metric.coverage
                      : null,
                  )}
                </Typography.Text>
              </Card>
            </Col>
          ))}
        </Row>
      ) : null}
      {findings.length > 0 ? (
        <Space orientation="vertical" size="middle" className="report-stack">
          {findings.slice(0, 4).map((finding, index) => (
            <Card
              size="small"
              key={valueText(finding.rule_id ?? index)}
              title={valueText(finding.title ?? "诊断发现")}
              extra={<Tag>{valueText(finding.severity ?? "未分级")}</Tag>}
            >
              <Descriptions size="small" column={1}>
                <Descriptions.Item label="数据观察事实">
                  {valueText(finding.factual_observation)}
                </Descriptions.Item>
                <Descriptions.Item label="规则判断">
                  {valueText(finding.rule_judgement)}
                </Descriptions.Item>
                <Descriptions.Item label="可能原因（待核查）">
                  {valueText(finding.possible_causes)}
                </Descriptions.Item>
                <Descriptions.Item label="建议核查">
                  {valueText(finding.recommended_checks)}
                </Descriptions.Item>
              </Descriptions>
            </Card>
          ))}
        </Space>
      ) : null}
      {section.code === "recommendations" ? (
        <Space orientation="vertical" size="middle" className="report-stack">
          <Alert
            type="info"
            showIcon
            title="两种视图使用同一组分析事实"
            description="优先级、数值和触发条件由确定性指标与诊断生成；AI 不参与核心计算，服务不可用时仍可完整展示。"
          />
          <Segmented
            value={recommendationView}
            options={[
              { label: "专业行动方案", value: "professional" },
              { label: "管理层简报", value: "executive" },
            ]}
            onChange={(value) =>
              setRecommendationView(value as "professional" | "executive")
            }
          />
          {recommendationView === "professional" ? (
            professionalPlans.map((plan) => (
              <Card
                key={valueText(plan.fact_id)}
                size="small"
                title={valueText(plan.problem_diagnosis)}
                extra={
                  <Tag
                    color={
                      plan.priority === "high"
                        ? "red"
                        : plan.priority === "medium"
                          ? "default"
                          : "blue"
                    }
                  >
                    {valueText(plan.priority)}
                  </Tag>
                }
              >
                <Descriptions bordered size="small" column={1}>
                  <Descriptions.Item label="数据依据">
                    {valueText(plan.data_evidence)}
                  </Descriptions.Item>
                  <Descriptions.Item label="根因判断边界">
                    {valueText(plan.root_cause_judgement)}
                  </Descriptions.Item>
                  <Descriptions.Item label="改善动作">
                    {valueText(plan.improvement_actions)}
                  </Descriptions.Item>
                  <Descriptions.Item label="影响范围">
                    {valueText(plan.impact_scope)}
                  </Descriptions.Item>
                  <Descriptions.Item label="建议 KPI">
                    {valueText(plan.suggested_kpis)}
                  </Descriptions.Item>
                  <Descriptions.Item label="建议目标">
                    {valueText(plan.suggested_target)}
                  </Descriptions.Item>
                  <Descriptions.Item label="风险">
                    {valueText(plan.risk)}
                  </Descriptions.Item>
                  <Descriptions.Item label="下一步验证">
                    {valueText(plan.next_validation)}
                  </Descriptions.Item>
                </Descriptions>
                <Typography.Text>
                  事实编号：{valueText(plan.fact_id)}
                </Typography.Text>
              </Card>
            ))
          ) : executiveBrief ? (
            <Card size="small" title="管理层简报">
              <Typography.Paragraph strong>
                {valueText(executiveBrief.overall_conclusion)}
              </Typography.Paragraph>
              <ol>
                {arrayOfRecords(executiveBrief.top_priorities).map((item) => (
                  <li key={valueText(item.fact_id)}>
                    <Typography.Paragraph>
                      <strong>{valueText(item.what_happened)}</strong>：
                      {valueText(item.impact)}
                      <br />
                      建议：{valueText(item.action)}
                      <br />
                      后续关注：{valueText(item.monitor)}
                    </Typography.Paragraph>
                  </li>
                ))}
              </ol>
            </Card>
          ) : (
            <Empty description="当前没有可展示的管理层建议" />
          )}
        </Space>
      ) : null}
      {section.code === "diagnostics" && findings.length === 0 ? (
        <Empty description="当前筛选未形成规则诊断结果" />
      ) : null}
      {section.code === "trend" ? (
        groups.length > 0 ? (
          <Typography.Text>
            共 {groups.length} 个时间点；导出 HTML 将显示统一 0%–100% 轴的
            OTIF/异常率趋势和精确值表。
          </Typography.Text>
        ) : (
          <Empty description="当前筛选没有趋势数据" />
        )
      ) : null}
      {section.code === "node_duration" ? (
        nodes.length > 0 ? (
          <div
            className="report-table-scroll"
            role="region"
            aria-label="节点耗时预览"
            tabIndex={0}
          >
            <table className="report-plain-table">
              <caption>节点耗时预览</caption>
              <thead>
                <tr>
                  <th>节点</th>
                  <th>平均</th>
                  <th>P50</th>
                  <th>P90</th>
                  <th>样本</th>
                </tr>
              </thead>
              <tbody>
                {nodes.slice(0, 10).map((node, index) => (
                  <tr key={`${valueText(node.code)}-${index}`}>
                    <td>{valueText(node.display_name)}</td>
                    <td>{valueText(node.mean_hours)}</td>
                    <td>{valueText(node.median_hours)}</td>
                    <td>{valueText(node.p90_hours)}</td>
                    <td>{valueText(node.sample_size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty description="当前筛选没有可计算节点" />
        )
      ) : null}
      {section.code === "dimension_breakdown" ? (
        groups.length > 0 ? (
          <div
            className="report-table-scroll"
            role="region"
            aria-label="维度对比预览"
            tabIndex={0}
          >
            <table className="report-plain-table">
              <caption>维度对比预览</caption>
              <thead>
                <tr>
                  <th>分组</th>
                  <th>订单量</th>
                  <th>指标数</th>
                </tr>
              </thead>
              <tbody>
                {groups.slice(0, 10).map((group, index) => (
                  <tr key={`${valueText(group.label)}-${index}`}>
                    <td>{valueText(group.label)}</td>
                    <td>{valueText(group.order_count)}</td>
                    <td>
                      {Array.isArray(group.metrics) ? group.metrics.length : 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty description="当前筛选没有维度分组" />
        )
      ) : null}
      {orders.length > 0 ? (
        <div
          className="report-table-scroll"
          role="region"
          aria-label="订单样例表格"
          tabIndex={0}
        >
          <table className="report-plain-table">
            <caption>订单样例预览</caption>
            <thead>
              <tr>
                <th>订单</th>
                <th>状态</th>
                <th>仓库</th>
                <th>承运商</th>
                <th>异常标签</th>
              </tr>
            </thead>
            <tbody>
              {orders.slice(0, 10).map((order, index) => (
                <tr key={`${String(order.order_id)}-${index}`}>
                  <td>{valueText(order.order_id)}</td>
                  <td>{valueText(order.order_status)}</td>
                  <td>{valueText(order.warehouse_id)}</td>
                  <td>{valueText(order.carrier_id)}</td>
                  <td>{valueText(order.anomaly_types)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {section.code === "simulation" ? (
        result ? (
          <Alert
            type="warning"
            showIcon
            title="情景估算，不代表真实预测或保证"
            description={`方案：${valueText(result.scenario_name)}；影响订单：${valueText(result.affected_order_count)}。参数、假设和不确定性会写入导出报告。`}
          />
        ) : (
          <Empty description="未选择模拟方案，因此不生成模拟结果" />
        )
      ) : null}
      {section.code === "methods_limits" ? (
        <ul className="report-summary-list">
          {methodItems.map((item, index) => (
            <li key={`${valueText(item)}-${index}`}>{valueText(item)}</li>
          ))}
        </ul>
      ) : null}
      {section.warnings.map((warning) => (
        <Alert key={warning} type="warning" showIcon title={warning} />
      ))}
    </Card>
  );
}

export function ReportsPage() {
  const notifications = useNotifications();
  const datasets = useMemo<DatasetSelection>(
    () => ({
      orders_dataset_id: datasetId("orders"),
      warehouse_events_dataset_id: datasetId("warehouse_events") || null,
      tracking_events_dataset_id: datasetId("tracking_events") || null,
    }),
    [],
  );
  const [filters] = useState(storedFilters);
  const [datasetName, setDatasetName] = useState("当前履约数据集");
  const [sections, setSections] = useState<ReportSectionCode[]>(ALL_SECTIONS);
  const [scenarios, setScenarios] = useState<ScenarioRecord[]>([]);
  const [scenarioId, setScenarioId] = useState<string | null>(null);
  const [includeIdentifiers, setIncludeIdentifiers] = useState(false);
  const [readingMode, setReadingMode] = useState<ReportReadingMode>("guided");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [capabilities, setCapabilities] = useState<ReportCapabilities | null>(
    null,
  );
  const [preview, setPreview] = useState<ReportDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [job, setJob] = useState<ReportJob | null>(null);
  const [csvKind, setCsvKind] = useState<CsvExportKind>("anomaly_orders");
  const [error, setError] = useState<string | null>(null);

  const selectedScenario = scenarios.find(
    (item) => item.scenario_id === scenarioId,
  );
  const reportRequest = useMemo<ReportRequest>(
    () => ({
      datasets,
      dataset_name: datasetName.trim() || "当前履约数据集",
      filters,
      trend_grain: "date",
      breakdown_dimension: "carrier_id",
      sections,
      order_sample_limit: 20,
      include_order_identifiers: includeIdentifiers,
      sensitive_export_confirmed: includeIdentifiers,
      reading_mode: readingMode,
      simulation: selectedScenario
        ? {
            scenario_id: selectedScenario.scenario_id,
            scenario_name: selectedScenario.name,
            parameters: null,
          }
        : null,
    }),
    [
      datasetName,
      datasets,
      filters,
      includeIdentifiers,
      readingMode,
      sections,
      selectedScenario,
    ],
  );

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      reportsApi.capabilities(controller.signal),
      datasets.orders_dataset_id && !hasBrowserDatasetSelection(datasets)
        ? simulationApi.scenarios(datasets.orders_dataset_id, controller.signal)
        : Promise.resolve([]),
    ])
      .then(([nextCapabilities, nextScenarios]) => {
        setCapabilities(nextCapabilities);
        setScenarios(nextScenarios);
      })
      .catch((reason: unknown) => {
        if (!(reason instanceof DOMException && reason.name === "AbortError")) {
          setError(readableError(reason));
        }
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [datasets]);

  useEffect(() => {
    if (!job || (job.status !== "queued" && job.status !== "running")) return;
    const timer = window.setTimeout(() => {
      void reportsApi
        .job(job.job_id)
        .then(setJob)
        .catch((reason: unknown) => setError(readableError(reason)));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [job]);

  const createExport = useCallback(
    async (format: ReportFormat, kind: CsvExportKind | null = null) => {
      if (!datasets.orders_dataset_id || sections.length === 0) return;
      setError(null);
      try {
        const nextJob = await reportsApi.createJob(reportRequest, format, kind);
        setJob(nextJob);
        notifications.showSuccess(
          "导出任务已创建",
          "页面会持续显示进度，可随时取消。",
        );
      } catch (reason) {
        const message = readableError(reason);
        setError(message);
        notifications.showError("导出任务未创建", message);
      }
    },
    [datasets.orders_dataset_id, notifications, reportRequest, sections.length],
  );

  async function loadPreview() {
    if (!datasets.orders_dataset_id || sections.length === 0) return;
    setPreviewing(true);
    setError(null);
    try {
      setPreview(await reportsApi.preview(reportRequest));
    } catch (reason) {
      const message = readableError(reason);
      setError(message);
      notifications.showError("报告预览未生成", message);
    } finally {
      setPreviewing(false);
    }
  }

  async function cancelJob() {
    if (!job) return;
    try {
      setJob(await reportsApi.cancel(job.job_id));
    } catch (reason) {
      setError(readableError(reason));
    }
  }

  const activeFilters = [
    filters.start_date || filters.end_date ? "时间" : null,
    filters.warehouses.length > 0 ? `仓库 ${filters.warehouses.length}` : null,
    filters.carriers.length > 0 ? `承运商 ${filters.carriers.length}` : null,
    filters.regions.length > 0 ? `地区 ${filters.regions.length}` : null,
    filters.statuses.length > 0 ? `状态 ${filters.statuses.length}` : null,
    filters.anomaly_types.length > 0
      ? `异常 ${filters.anomaly_types.length}`
      : null,
  ].filter((item): item is string => item !== null);

  return (
    <div>
      <PageHeader
        title="分析报告与结果导出"
        description="将当前筛选下的指标、诊断证据和情景估算整理为可复核快照；报告默认隐藏订单标识。"
      />

      {!datasets.orders_dataset_id ? (
        <Alert
          type="warning"
          showIcon
          title="请先导入或载入一套订单数据，再生成报告。"
        />
      ) : null}
      {error ? (
        <Alert
          className="persistent-alert"
          type="error"
          showIcon
          title="报告任务未完成"
          description={error}
        />
      ) : null}
      {loading ? <Skeleton active paragraph={{ rows: 6 }} /> : null}
      {capabilities && !capabilities.pdf_available ? (
        <Alert
          className="persistent-alert"
          type="info"
          showIcon
          title="PDF 暂未开放"
          description={`${capabilities.pdf_reason} 当前请使用自包含 HTML 打印或分享，或使用 Markdown 继续编辑。`}
        />
      ) : null}

      <Card className="section-card" title="1. 报告范围与隐私">
        <div className="report-config-grid">
          <label>
            <Typography.Text strong>数据集名称</Typography.Text>
            <Input
              value={datasetName}
              maxLength={80}
              onChange={(event) => setDatasetName(event.target.value)}
            />
          </label>
          <label>
            <Typography.Text strong>阅读方式</Typography.Text>
            <Select
              value={readingMode}
              options={[
                { label: "快速阅读版（推荐首次使用）", value: "guided" },
                { label: "标准分析版", value: "standard" },
              ]}
              onChange={setReadingMode}
            />
          </label>
          <label>
            <Typography.Text strong>纳入模拟方案（可选）</Typography.Text>
            <Select
              allowClear
              value={scenarioId}
              placeholder="不纳入模拟结果"
              options={scenarios.map((item) => ({
                label: item.name,
                value: item.scenario_id,
              }))}
              onChange={(value) => setScenarioId(value ?? null)}
            />
          </label>
        </div>
        <Flex gap="small" wrap className="report-filter-summary">
          <Tag color="blue">沿用分析总览筛选</Tag>
          {activeFilters.length > 0 ? (
            activeFilters.map((item) => <Tag key={item}>{item}</Tag>)
          ) : (
            <Tag>全部数据</Tag>
          )}
          <Tag>{filters.timezone}</Tag>
        </Flex>
        <Typography.Title level={5}>选择报告章节</Typography.Title>
        <Checkbox.Group
          className="report-section-options"
          options={SECTION_OPTIONS}
          value={sections}
          onChange={setSections}
        />
        {sections.length === 0 ? (
          <Alert type="warning" showIcon title="至少选择一个报告章节。" />
        ) : null}
        <Flex align="center" gap="middle" wrap className="report-sensitive-row">
          <Switch
            checked={includeIdentifiers}
            aria-label="导出订单标识"
            onChange={(checked) => {
              if (checked) setConfirmOpen(true);
              else setIncludeIdentifiers(false);
            }}
          />
          <div>
            <Typography.Text strong>导出订单与事件标识</Typography.Text>
            <Typography.Paragraph>
              默认关闭并掩码。即使标准 Schema
              不含姓名、手机号、身份证和详细地址，订单标识仍可能用于关联个人。
            </Typography.Paragraph>
          </div>
        </Flex>
        <Button
          type="primary"
          icon={<EyeOutlined />}
          loading={previewing}
          disabled={!datasets.orders_dataset_id || sections.length === 0}
          onClick={() => void loadPreview()}
        >
          生成预览
        </Button>
      </Card>

      <Card className="section-card" title="2. 导出文件">
        <Alert
          type="success"
          showIcon
          icon={<SafetyCertificateOutlined />}
          title="安全导出策略已启用"
          description="CSV 对 =、+、-、@ 开头单元格进行公式注入转义；文件名会去除路径与系统保留字符；日志不记录敏感原值。"
        />
        <Flex gap="small" wrap className="report-export-actions">
          <Button
            icon={<FileTextOutlined />}
            onClick={() => void createExport("markdown")}
          >
            导出 Markdown
          </Button>
          <Button
            icon={<CloudDownloadOutlined />}
            onClick={() => void createExport("html")}
          >
            导出自包含 HTML
          </Button>
          <Select
            aria-label="CSV 导出内容"
            value={csvKind}
            options={CSV_OPTIONS}
            onChange={setCsvKind}
          />
          <Button onClick={() => void createExport("csv", csvKind)}>
            导出 CSV
          </Button>
        </Flex>
        {job ? (
          <div className="report-job" aria-live="polite">
            <Flex align="center" justify="space-between" gap="small" wrap>
              <Typography.Text strong>
                {JOB_STATUS[job.status]}：{job.message}
              </Typography.Text>
              {job.status === "queued" || job.status === "running" ? (
                <Button
                  danger
                  icon={<StopOutlined />}
                  onClick={() => void cancelJob()}
                >
                  取消导出
                </Button>
              ) : null}
            </Flex>
            <Progress
              percent={job.progress}
              status={
                job.status === "failed"
                  ? "exception"
                  : job.status === "completed"
                    ? "success"
                    : "active"
              }
            />
            {job.download_ready ? (
              <Button
                type="primary"
                icon={<CheckCircleOutlined />}
                href={reportsApi.downloadUrl(job.job_id)}
                download={job.file_name ?? true}
              >
                下载 {job.file_name}（
                {job.size_bytes?.toLocaleString("zh-CN") ?? "—"} 字节）
              </Button>
            ) : null}
            {job.error_code ? (
              <Alert
                type="error"
                showIcon
                title={`${job.message}（${job.error_code}）`}
              />
            ) : null}
          </div>
        ) : null}
      </Card>

      <section aria-labelledby="report-preview-title">
        <Typography.Title id="report-preview-title" level={2}>
          3. 报告预览
        </Typography.Title>
        {!preview ? (
          <Empty description="选择章节并生成预览；未生成时不会显示静态假结果。" />
        ) : (
          <Space orientation="vertical" size="large" className="report-stack">
            <Card className="section-card" title={preview.header.title}>
              {preview.header.synthetic_data ? (
                <Tag color="blue">完全合成数据</Tag>
              ) : null}
              <Descriptions
                bordered
                size="small"
                column={{ xs: 1, sm: 2, lg: 3 }}
              >
                <Descriptions.Item label="时间范围">
                  {preview.header.time_range_start ?? "—"} 至{" "}
                  {preview.header.time_range_end ?? "—"}
                </Descriptions.Item>
                <Descriptions.Item label="订单 / 有效订单">
                  {preview.header.order_count} /{" "}
                  {preview.header.valid_order_count}
                </Descriptions.Item>
                <Descriptions.Item label="数据覆盖率">
                  {percent(preview.header.data_coverage)}
                </Descriptions.Item>
                <Descriptions.Item label="生成时间">
                  {dateTime(preview.header.generated_at)}
                </Descriptions.Item>
                <Descriptions.Item label="指标版本">
                  {preview.header.metrics_definition_version}
                </Descriptions.Item>
                <Descriptions.Item label="规则版本">
                  {preview.header.diagnostic_rule_version}
                </Descriptions.Item>
                <Descriptions.Item label="模拟版本">
                  {preview.header.simulation_version}
                </Descriptions.Item>
                <Descriptions.Item label="报告 / 渲染版本">
                  {preview.header.report_version} /{" "}
                  {preview.header.renderer_version}
                </Descriptions.Item>
                <Descriptions.Item label="标识策略">
                  {preview.identifier_policy}
                </Descriptions.Item>
                {preview.header.analysis_fingerprint ? (
                  <Descriptions.Item label="分析指纹">
                    <Typography.Text
                      code
                      title={preview.header.analysis_fingerprint}
                    >
                      {preview.header.analysis_fingerprint.slice(0, 20)}…
                    </Typography.Text>
                  </Descriptions.Item>
                ) : null}
              </Descriptions>
              {preview.reading_guide.length > 0 ? (
                <section aria-labelledby="report-guide-title">
                  <Typography.Title id="report-guide-title" level={3}>
                    指标怎么读
                  </Typography.Title>
                  <Row gutter={[12, 12]}>
                    {preview.reading_guide.map((item) => (
                      <Col xs={24} md={12} key={item.term}>
                        <Card size="small" title={item.term}>
                          {item.requires_context ? (
                            <Tag color="orange">需结合覆盖率/样本</Tag>
                          ) : null}
                          <Typography.Paragraph>
                            {item.meaning}
                          </Typography.Paragraph>
                          <Typography.Text strong>
                            {item.direction}
                          </Typography.Text>
                          <Typography.Paragraph>
                            注意：{item.caution}
                          </Typography.Paragraph>
                        </Card>
                      </Col>
                    ))}
                  </Row>
                </section>
              ) : null}
              <Typography.Title level={3}>Executive Summary</Typography.Title>
              <ul className="report-summary-list">
                {preview.executive_summary.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              {preview.warnings.map((warning) => (
                <Alert key={warning} type="warning" showIcon title={warning} />
              ))}
            </Card>
            {preview.sections.map((section) => (
              <PreviewSection key={section.code} section={section} />
            ))}
          </Space>
        )}
      </section>

      <Modal
        title="确认导出订单标识"
        open={confirmOpen}
        okText="我理解风险，继续"
        cancelText="保持默认隐藏"
        onOk={() => {
          setIncludeIdentifiers(true);
          setConfirmOpen(false);
        }}
        onCancel={() => setConfirmOpen(false)}
      >
        <Alert
          type="warning"
          showIcon
          title="订单与事件标识可能被用于关联个人或业务记录"
          description="只在有明确业务必要、接收方可信且传输方式安全时导出。姓名、手机号、身份证、详细地址始终不属于标准报告字段。"
        />
      </Modal>
    </div>
  );
}
