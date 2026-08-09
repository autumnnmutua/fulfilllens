import {
  AlertOutlined,
  ApartmentOutlined,
  DatabaseOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Collapse,
  Descriptions,
  Drawer,
  Empty,
  Flex,
  Input,
  InputNumber,
  Pagination,
  Select,
  Skeleton,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Timeline,
  Typography,
} from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiClientError } from "../api/client";
import { diagnosticsApi } from "../api/diagnostics";
import { EChart, type EChartOption } from "../components/EChart";
import { useNotifications } from "../components/notification-context";
import { PageHeader } from "../components/PageHeader";
import { initialAnalysisDataset } from "../analysis/browserSelection";
import type {
  DiagnosticAnalysis,
  DiagnosticCategory,
  DiagnosticOrderDetail,
  DiagnosticOrderFilters,
  DiagnosticOrderPage,
  DiagnosticRequest,
  DiagnosticResult,
  DiagnosticRule,
  DiagnosticRuleSet,
  DiagnosticSeverity,
  RuleOverride,
} from "../types/diagnostics";
import type { DatasetSelection } from "../types/metrics";

const CATEGORY_LABELS: Record<DiagnosticCategory, string> = {
  warehouse_delay: "仓内作业延迟",
  pickup_delay: "出库后揽收延迟",
  linehaul_long_tail: "干线运输长尾",
  last_mile_backlog: "末端网点积压",
  carrier_relative: "承运商相对异常",
  warehouse_congestion: "仓库拥堵观察",
  time_concentration: "异常时间集中",
  data_quality: "事件数据异常",
};
const SEVERITY_LABELS: Record<DiagnosticSeverity, string> = {
  critical: "严重",
  high: "高",
  medium: "中",
  low: "低",
};
const SEVERITY_COLORS: Record<DiagnosticSeverity, string> = {
  critical: "red",
  high: "volcano",
  medium: "gold",
  low: "blue",
};
const DEFAULT_ORDER_FILTERS: DiagnosticOrderFilters = {
  page: 1,
  pageSize: 20,
  severity: null,
  category: null,
  ruleId: null,
};

function initialDataset(dataType: string): string {
  return initialAnalysisDataset(dataType);
}

function readableError(error: unknown): string {
  if (error instanceof ApiClientError) {
    const details = error.details.map((detail) => detail.message).join("；");
    return `${error.message}${details ? ` ${details}` : ""}（${error.code}）`;
  }
  return error instanceof Error ? error.message : "诊断未完成。";
}

function formatPercent(value: number | null): string {
  return value === null ? "不可计算" : `${(value * 100).toFixed(1)}%`;
}

function formatEvidenceValue(value: number | null, unit: string | null) {
  if (value === null) {
    return "—";
  }
  if (unit === "ratio") {
    return formatPercent(value);
  }
  return `${value.toFixed(2)}${unit === "hour" ? " 小时" : ""}`;
}

function severityTag(severity: DiagnosticSeverity) {
  return (
    <Tag color={SEVERITY_COLORS[severity]}>{SEVERITY_LABELS[severity]}</Tag>
  );
}

function ResultEvidence({ result }: { result: DiagnosticResult }) {
  return (
    <div className="diagnostic-result-content">
      <section>
        <Typography.Title level={5}>数据观察事实</Typography.Title>
        <Typography.Paragraph>
          {result.factual_observation}
        </Typography.Paragraph>
      </section>
      <section>
        <Typography.Title level={5}>规则判断</Typography.Title>
        <Typography.Paragraph>{result.rule_judgement}</Typography.Paragraph>
      </section>
      <section>
        <Typography.Title level={5}>可能原因（待核查）</Typography.Title>
        <ul>
          {result.possible_causes.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>
      {result.confidence_warning.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          title="置信度提示"
          description={result.confidence_warning.join("；")}
        />
      ) : null}
      <section>
        <Typography.Title level={5}>建议进一步核查</Typography.Title>
        <ul>
          {result.recommended_checks.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>
      <Typography.Title level={5}>证据样例</Typography.Title>
      {result.evidence.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="没有可展示的订单级证据"
        />
      ) : (
        <Table
          rowKey={(item, index) =>
            `${item.order_id ?? "group"}-${item.event_id ?? index}`
          }
          size="small"
          pagination={false}
          scroll={{ x: 900 }}
          dataSource={result.evidence}
          columns={[
            { title: "订单", dataIndex: "order_id", width: 150 },
            { title: "节点", dataIndex: "node_code", width: 140 },
            {
              title: "实际值",
              key: "observed",
              width: 120,
              render: (_value, item) =>
                formatEvidenceValue(item.observed_value, item.unit),
            },
            {
              title: "阈值",
              key: "threshold",
              width: 120,
              render: (_value, item) =>
                formatEvidenceValue(item.threshold_value, item.unit),
            },
            {
              title: "对比基线",
              key: "baseline",
              width: 120,
              render: (_value, item) =>
                formatEvidenceValue(item.baseline_value, item.unit),
            },
            { title: "判定证据", dataIndex: "comparison", width: 280 },
          ]}
        />
      )}
    </div>
  );
}

function RuleControls({
  ruleSet,
  overrides,
  onChange,
}: {
  ruleSet: DiagnosticRuleSet;
  overrides: Record<string, RuleOverride>;
  onChange: (ruleId: string, override: RuleOverride) => void;
}) {
  function currentOverride(rule: DiagnosticRule): RuleOverride {
    return overrides[rule.rule_id] ?? { parameters: {} };
  }

  return (
    <Collapse
      items={ruleSet.rules.map((rule) => {
        const override = currentOverride(rule);
        const enabled = override.enabled ?? rule.enabled;
        return {
          key: rule.rule_id,
          label: (
            <Flex gap={8} wrap align="center">
              <Typography.Text strong>{rule.title}</Typography.Text>
              <Tag>{rule.rule_id}</Tag>
              {severityTag(rule.severity)}
            </Flex>
          ),
          children: (
            <div className="diagnostic-rule-panel">
              <Typography.Paragraph>{rule.description}</Typography.Paragraph>
              <Flex gap={10} align="center">
                <Switch
                  checked={enabled}
                  aria-label={`${rule.title}启用状态`}
                  onChange={(checked) => {
                    onChange(rule.rule_id, { ...override, enabled: checked });
                  }}
                />
                <Typography.Text>
                  {enabled ? "已启用" : "已禁用"}
                </Typography.Text>
              </Flex>
              <div className="diagnostic-parameter-grid">
                {Object.entries(rule.parameters).map(([name, parameter]) => (
                  <label className="dashboard-filter-field" key={name}>
                    <Typography.Text>{parameter.display_name}</Typography.Text>
                    <InputNumber
                      aria-label={`${rule.title}-${parameter.display_name}`}
                      min={parameter.minimum}
                      max={parameter.maximum}
                      value={override.parameters[name] ?? parameter.value}
                      onChange={(value) => {
                        if (value === null) {
                          return;
                        }
                        onChange(rule.rule_id, {
                          ...override,
                          parameters: {
                            ...override.parameters,
                            [name]: value,
                          },
                        });
                      }}
                    />
                    <Typography.Text>
                      范围 {parameter.minimum}–{parameter.maximum} ·{" "}
                      {parameter.unit}
                    </Typography.Text>
                  </label>
                ))}
              </div>
            </div>
          ),
        };
      })}
    />
  );
}

export function DiagnosticsPage() {
  const notifications = useNotifications();
  const [ordersId, setOrdersId] = useState(() => initialDataset("orders"));
  const [warehouseId, setWarehouseId] = useState(() =>
    initialDataset("warehouse_events"),
  );
  const [trackingId, setTrackingId] = useState(() =>
    initialDataset("tracking_events"),
  );
  const [timezone, setTimezone] = useState("Asia/Shanghai");
  const [ruleSet, setRuleSet] = useState<DiagnosticRuleSet | null>(null);
  const [overrides, setOverrides] = useState<Record<string, RuleOverride>>({});
  const [analysis, setAnalysis] = useState<DiagnosticAnalysis | null>(null);
  const [appliedRequest, setAppliedRequest] =
    useState<DiagnosticRequest | null>(null);
  const [orderPage, setOrderPage] = useState<DiagnosticOrderPage | null>(null);
  const [orderFilters, setOrderFilters] = useState<DiagnosticOrderFilters>(
    DEFAULT_ORDER_FILTERS,
  );
  const [orderDetail, setOrderDetail] = useState<DiagnosticOrderDetail | null>(
    null,
  );
  const [detailBusy, setDetailBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [persistentError, setPersistentError] = useState<string | null>(null);
  const autoLoaded = useRef(false);
  const requestCounter = useRef(0);

  const selection: DatasetSelection = useMemo(
    () => ({
      orders_dataset_id: ordersId.trim(),
      warehouse_events_dataset_id: warehouseId.trim() || null,
      tracking_events_dataset_id: trackingId.trim() || null,
    }),
    [ordersId, trackingId, warehouseId],
  );
  const diagnosticRequest: DiagnosticRequest = useMemo(
    () => ({
      datasets: selection,
      timezone,
      rule_overrides: overrides,
      max_evidence_per_result: 20,
    }),
    [overrides, selection, timezone],
  );

  useEffect(() => {
    const controller = new AbortController();
    void diagnosticsApi
      .rules(controller.signal)
      .then(setRuleSet)
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setPersistentError(readableError(error));
        }
      });
    return () => {
      controller.abort();
    };
  }, []);

  const execute = useCallback(
    async (
      request: DiagnosticRequest,
      filters: DiagnosticOrderFilters,
      announce: boolean,
    ) => {
      if (!request.datasets.orders_dataset_id) {
        setPersistentError(
          "必须先选择已确认的订单数据集。请从数据导入页完成导入。 ",
        );
        return;
      }
      const requestId = requestCounter.current + 1;
      requestCounter.current = requestId;
      setBusy(true);
      setPersistentError(null);
      try {
        const [nextAnalysis, nextOrders] = await Promise.all([
          diagnosticsApi.analyze(request),
          diagnosticsApi.orders(request, filters),
        ]);
        if (requestCounter.current === requestId) {
          setAnalysis(nextAnalysis);
          setOrderPage(nextOrders);
          setAppliedRequest(request);
          if (announce) {
            notifications.showSuccess(
              "诊断已重算",
              "聚合洞察、规则证据和受影响订单来自同一规则版本。",
            );
          }
        }
      } catch (error) {
        if (requestCounter.current === requestId) {
          const message = readableError(error);
          setPersistentError(message);
          notifications.showError("诊断未完成", message);
        }
      } finally {
        if (requestCounter.current === requestId) {
          setBusy(false);
        }
      }
    },
    [notifications],
  );

  useEffect(() => {
    if (
      autoLoaded.current ||
      ruleSet === null ||
      !selection.orders_dataset_id
    ) {
      return;
    }
    autoLoaded.current = true;
    void execute(diagnosticRequest, DEFAULT_ORDER_FILTERS, false);
  }, [diagnosticRequest, execute, ruleSet, selection.orders_dataset_id]);

  async function loadOrders(filters: DiagnosticOrderFilters) {
    if (appliedRequest === null) {
      return;
    }
    try {
      setBusy(true);
      setPersistentError(null);
      setOrderPage(await diagnosticsApi.orders(appliedRequest, filters));
    } catch (error) {
      setPersistentError(readableError(error));
    } finally {
      setBusy(false);
    }
  }

  async function openOrder(orderId: string) {
    if (appliedRequest === null) {
      return;
    }
    setDetailBusy(true);
    setOrderDetail(null);
    try {
      setOrderDetail(await diagnosticsApi.orderDetail(appliedRequest, orderId));
    } catch (error) {
      const message = readableError(error);
      setPersistentError(message);
      notifications.showError("订单证据读取失败", message);
    } finally {
      setDetailBusy(false);
    }
  }

  const paretoOption: EChartOption = {
    color: ["#c2414b", "#146c94"],
    tooltip: { trigger: "axis" },
    legend: { data: ["受影响订单", "累计占比"] },
    grid: { left: 58, right: 64, top: 52, bottom: 86 },
    xAxis: {
      type: "category",
      data: analysis?.pareto.map((item) => item.display_name) ?? [],
      axisLabel: { interval: 0, rotate: 24 },
    },
    yAxis: [
      { type: "value", name: "订单数", min: 0, minInterval: 1 },
      {
        type: "value",
        name: "累计占比",
        min: 0,
        max: 1,
        axisLabel: {
          formatter: (value: number) => `${Math.round(value * 100)}%`,
        },
      },
    ],
    series: [
      {
        name: "受影响订单",
        type: "bar",
        data: analysis?.pareto.map((item) => item.affected_order_count) ?? [],
      },
      {
        name: "累计占比",
        type: "line",
        yAxisIndex: 1,
        data: analysis?.pareto.map((item) => item.cumulative_share) ?? [],
      },
    ],
  };
  const bottleneckOption: EChartOption = {
    color: ["#4f6d7a", "#d9485f", "#e09f3e"],
    tooltip: { trigger: "axis" },
    legend: { data: ["平均", "P90", "业务阈值"] },
    grid: { left: 132, right: 28, top: 52, bottom: 48 },
    xAxis: { type: "value", name: "小时", min: 0 },
    yAxis: {
      type: "category",
      data: analysis?.bottleneck_nodes.map((item) => item.display_name) ?? [],
    },
    series: [
      {
        name: "平均",
        type: "bar",
        data: analysis?.bottleneck_nodes.map((item) => item.mean_hours) ?? [],
      },
      {
        name: "P90",
        type: "bar",
        data: analysis?.bottleneck_nodes.map((item) => item.p90_hours) ?? [],
      },
      {
        name: "业务阈值",
        type: "line",
        data:
          analysis?.bottleneck_nodes.map((item) => item.threshold_hours) ?? [],
      },
    ],
  };

  return (
    <>
      <PageHeader
        title="流程瓶颈与异常诊断"
        description="用版本化透明规则定位需要核查的流程与订单，并从聚合结论追溯到事件证据。"
      />
      <Alert
        className="prominent-alert"
        type="warning"
        showIcon
        title="诊断是规则判断，不是因果结论"
        description="本页不使用大模型臆测经营原因。可能原因均以谨慎措辞列出，必须结合原始业务记录进一步核查。"
      />
      {persistentError ? (
        <Alert
          className="diagnostic-persistent-error"
          type="error"
          showIcon
          title="诊断任务需要处理"
          description={persistentError}
        />
      ) : null}

      <Card
        className="section-card"
        title={
          <Space>
            <DatabaseOutlined />
            数据与分析参数
          </Space>
        }
      >
        <div className="dataset-id-grid">
          <label className="dashboard-filter-field">
            <Typography.Text strong>订单数据集 ID（必填）</Typography.Text>
            <Input
              aria-label="诊断订单数据集 ID"
              value={ordersId}
              onChange={(event) => setOrdersId(event.target.value)}
            />
          </label>
          <label className="dashboard-filter-field">
            <Typography.Text strong>仓库事件数据集 ID</Typography.Text>
            <Input
              aria-label="诊断仓库事件数据集 ID"
              value={warehouseId}
              onChange={(event) => setWarehouseId(event.target.value)}
            />
          </label>
          <label className="dashboard-filter-field">
            <Typography.Text strong>物流轨迹数据集 ID</Typography.Text>
            <Input
              aria-label="诊断物流轨迹数据集 ID"
              value={trackingId}
              onChange={(event) => setTrackingId(event.target.value)}
            />
          </label>
          <label className="dashboard-filter-field">
            <Typography.Text strong>分析时区</Typography.Text>
            <Input
              aria-label="诊断分析时区"
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
            />
          </label>
        </div>
        <Flex className="diagnostic-actions" gap={12} wrap>
          <Button
            type="primary"
            icon={<AlertOutlined />}
            loading={busy}
            onClick={() => {
              autoLoaded.current = true;
              setOrderFilters(DEFAULT_ORDER_FILTERS);
              void execute(diagnosticRequest, DEFAULT_ORDER_FILTERS, true);
            }}
          >
            运行诊断
          </Button>
          <Typography.Text>
            阈值覆盖仅作用于本次分析，不会修改原始数据或默认配置。
          </Typography.Text>
        </Flex>
      </Card>

      <Card
        className="section-card"
        title={
          <Space>
            <SettingOutlined />
            规则与阈值
          </Space>
        }
        extra={ruleSet ? <Tag>{ruleSet.rule_set_version}</Tag> : null}
      >
        {ruleSet ? (
          <RuleControls
            ruleSet={ruleSet}
            overrides={overrides}
            onChange={(ruleId, override) => {
              setOverrides((current) => ({ ...current, [ruleId]: override }));
            }}
          />
        ) : (
          <Skeleton active />
        )}
      </Card>

      {busy && analysis === null ? (
        <Skeleton active paragraph={{ rows: 8 }} />
      ) : null}
      {!busy && analysis === null ? (
        <Card className="section-card">
          <Empty description="选择订单数据集后运行诊断；没有数据时不会用 0 或静态结果代替。" />
        </Card>
      ) : null}

      {analysis ? (
        <>
          <Card className="diagnostic-context" title="当前诊断上下文">
            <Descriptions column={{ xs: 1, sm: 2, lg: 4 }} size="small">
              <Descriptions.Item label="订单 / 有效">
                {analysis.context.order_count} /{" "}
                {analysis.context.valid_order_count}
              </Descriptions.Item>
              <Descriptions.Item label="受影响订单">
                {analysis.context.affected_order_count}
              </Descriptions.Item>
              <Descriptions.Item label="诊断结果">
                {analysis.context.finding_count}
              </Descriptions.Item>
              <Descriptions.Item label="数据覆盖">
                {formatPercent(analysis.context.data_coverage)}
              </Descriptions.Item>
              <Descriptions.Item label="规则">
                {analysis.context.triggered_rule_count} /{" "}
                {analysis.context.enabled_rule_count} 条触发
              </Descriptions.Item>
              <Descriptions.Item label="规则集版本">
                {analysis.rule_set_version}
              </Descriptions.Item>
              <Descriptions.Item label="分析时间">
                {new Date(analysis.context.analyzed_at).toLocaleString("zh-CN")}
              </Descriptions.Item>
              <Descriptions.Item label="警告">
                {analysis.context.warning_count}
              </Descriptions.Item>
            </Descriptions>
          </Card>

          {analysis.analysis_warnings.map((warning) => (
            <Alert
              key={warning}
              className="diagnostic-warning"
              type="warning"
              showIcon
              title={warning}
            />
          ))}

          <div className="diagnostic-severity-grid">
            {analysis.severity_summary.map((item) => (
              <Card key={item.severity} className="metric-card">
                <Statistic
                  title={`${SEVERITY_LABELS[item.severity]}严重度结果`}
                  value={item.finding_count}
                  suffix="项"
                />
                <Flex gap={8} align="center">
                  {severityTag(item.severity)}
                  <Typography.Text>
                    涉及 {item.affected_order_count} 个唯一订单
                  </Typography.Text>
                </Flex>
              </Card>
            ))}
          </div>

          <div className="diagnostic-chart-grid">
            <Card className="section-card" title="异常帕累托">
              {analysis.pareto.length ? (
                <>
                  <EChart
                    ariaLabel={`异常帕累托，共 ${analysis.context.affected_order_count} 个受影响订单`}
                    option={paretoOption}
                  />
                  <Typography.Paragraph>
                    柱形按各类别唯一受影响订单排序；累计占比以类别贡献总量为分母，跨类别订单可能重复贡献。
                  </Typography.Paragraph>
                </>
              ) : (
                <Empty description="当前阈值下没有帕累托数据" />
              )}
            </Card>
            <Card className="section-card" title="瓶颈节点时长">
              {analysis.bottleneck_nodes.some(
                (item) => item.sample_size > 0,
              ) ? (
                <>
                  <EChart
                    ariaLabel="各节点平均、P90 与业务阈值对比，单位小时"
                    option={bottleneckOption}
                  />
                  <Typography.Paragraph>
                    仅展示有完整起止事件的样本；P90 使用 Type 7
                    分位数，空值不显示为 0。
                  </Typography.Paragraph>
                </>
              ) : (
                <Empty description="缺少完整节点起止事件，无法绘制时长" />
              )}
            </Card>
          </div>

          <Card
            className="section-card"
            title={
              <Space>
                <ApartmentOutlined />
                流程路径与变体
              </Space>
            }
          >
            {analysis.process_variants.length ? (
              <Table
                rowKey="variant_id"
                size="small"
                pagination={{ pageSize: 8, hideOnSinglePage: true }}
                scroll={{ x: 780 }}
                dataSource={analysis.process_variants}
                columns={[
                  { title: "变体", dataIndex: "variant_id", width: 110 },
                  {
                    title: "状态路径",
                    key: "sequence",
                    render: (_value, item) => item.sequence.join(" → "),
                  },
                  { title: "订单数", dataIndex: "order_count", width: 90 },
                  {
                    title: "占比",
                    key: "share",
                    width: 90,
                    render: (_value, item) => formatPercent(item.share),
                  },
                  {
                    title: "受影响",
                    dataIndex: "affected_order_count",
                    width: 90,
                  },
                ]}
              />
            ) : (
              <Empty description="没有足够事件生成流程变体" />
            )}
          </Card>

          <Card className="section-card" title="维度下钻">
            {analysis.dimension_insights.length ? (
              <Table
                rowKey={(item) =>
                  `${item.dimension_type}-${item.dimension_value}`
                }
                size="small"
                pagination={{ pageSize: 10, hideOnSinglePage: true }}
                scroll={{ x: 680 }}
                dataSource={analysis.dimension_insights}
                columns={[
                  { title: "维度", dataIndex: "dimension_type", width: 110 },
                  { title: "值", dataIndex: "dimension_value", width: 160 },
                  { title: "诊断项", dataIndex: "finding_count", width: 90 },
                  {
                    title: "受影响订单",
                    dataIndex: "affected_order_count",
                    width: 110,
                  },
                  {
                    title: "最高严重度",
                    key: "severity",
                    width: 110,
                    render: (_value, item) =>
                      severityTag(item.highest_severity),
                  },
                  {
                    title: "类别",
                    key: "categories",
                    render: (_value, item) =>
                      item.categories.map((category) => (
                        <Tag key={category}>{CATEGORY_LABELS[category]}</Tag>
                      )),
                  },
                ]}
              />
            ) : (
              <Empty description="当前没有可下钻的维度异常" />
            )}
          </Card>

          <Card className="section-card" title="诊断结果与可追溯证据">
            {analysis.results.length ? (
              <Collapse
                items={analysis.results.map((result) => ({
                  key: `${result.rule_id}-${result.title}`,
                  label: (
                    <Flex gap={8} align="center" wrap>
                      {severityTag(result.severity)}
                      <Typography.Text strong>{result.title}</Typography.Text>
                      <Tag>
                        {result.rule_id} · v{result.rule_version}
                      </Tag>
                      <Typography.Text>
                        {result.affected_order_count} 个订单 · 样本{" "}
                        {result.sample_size} · 覆盖{" "}
                        {formatPercent(result.coverage)}
                      </Typography.Text>
                    </Flex>
                  ),
                  children: <ResultEvidence result={result} />,
                }))}
              />
            ) : (
              <Empty description="当前规则与阈值下没有触发项；这不等同于证明没有问题。" />
            )}
          </Card>

          <Card className="section-card" title="受影响订单与时间线入口">
            <div className="diagnostic-order-filter-grid">
              <label className="dashboard-filter-field">
                <Typography.Text>严重度</Typography.Text>
                <Select
                  aria-label="诊断订单严重度"
                  allowClear
                  value={orderFilters.severity}
                  options={Object.entries(SEVERITY_LABELS).map(
                    ([value, label]) => ({ value, label }),
                  )}
                  onChange={(value) => {
                    const next = {
                      ...orderFilters,
                      page: 1,
                      severity: value ?? null,
                    };
                    setOrderFilters(next);
                    void loadOrders(next);
                  }}
                />
              </label>
              <label className="dashboard-filter-field">
                <Typography.Text>异常类别</Typography.Text>
                <Select
                  aria-label="诊断订单异常类别"
                  allowClear
                  value={orderFilters.category}
                  options={Object.entries(CATEGORY_LABELS).map(
                    ([value, label]) => ({ value, label }),
                  )}
                  onChange={(value) => {
                    const next = {
                      ...orderFilters,
                      page: 1,
                      category: value ?? null,
                    };
                    setOrderFilters(next);
                    void loadOrders(next);
                  }}
                />
              </label>
              <label className="dashboard-filter-field">
                <Typography.Text>规则</Typography.Text>
                <Select
                  aria-label="诊断订单规则"
                  allowClear
                  value={orderFilters.ruleId}
                  options={ruleSet?.rules.map((rule) => ({
                    value: rule.rule_id,
                    label: `${rule.rule_id} · ${rule.title}`,
                  }))}
                  onChange={(value) => {
                    const next = {
                      ...orderFilters,
                      page: 1,
                      ruleId: value ?? null,
                    };
                    setOrderFilters(next);
                    void loadOrders(next);
                  }}
                />
              </label>
            </div>
            {orderPage && orderPage.items.length ? (
              <>
                <Table
                  rowKey="order_id"
                  size="small"
                  pagination={false}
                  scroll={{ x: 860 }}
                  dataSource={orderPage.items}
                  columns={[
                    { title: "订单", dataIndex: "order_id", width: 160 },
                    {
                      title: "严重度",
                      key: "severity",
                      width: 100,
                      render: (_value, item) =>
                        severityTag(item.highest_severity),
                    },
                    { title: "仓库", dataIndex: "warehouse_id", width: 120 },
                    { title: "承运商", dataIndex: "carrier_id", width: 120 },
                    {
                      title: "地区",
                      dataIndex: "destination_region",
                      width: 120,
                    },
                    {
                      title: "类别",
                      key: "categories",
                      render: (_value, item) =>
                        item.categories.map((category) => (
                          <Tag key={category}>{CATEGORY_LABELS[category]}</Tag>
                        )),
                    },
                    {
                      title: "操作",
                      key: "action",
                      fixed: "right",
                      width: 120,
                      render: (_value, item) => (
                        <Button
                          type="link"
                          onClick={() => void openOrder(item.order_id)}
                        >
                          查看时间线
                        </Button>
                      ),
                    },
                  ]}
                />
                <Pagination
                  className="diagnostic-pagination"
                  current={orderPage.page}
                  pageSize={orderPage.page_size}
                  total={orderPage.total}
                  showSizeChanger
                  onChange={(page, pageSize) => {
                    const next = { ...orderFilters, page, pageSize };
                    setOrderFilters(next);
                    void loadOrders(next);
                  }}
                />
              </>
            ) : (
              <Empty description="当前筛选下没有受影响订单" />
            )}
          </Card>
        </>
      ) : null}

      <Drawer
        title={
          orderDetail
            ? `订单证据 · ${orderDetail.metric_detail.order_id}`
            : "订单证据"
        }
        size="large"
        open={detailBusy || orderDetail !== null}
        onClose={() => setOrderDetail(null)}
      >
        {detailBusy ? <Skeleton active /> : null}
        {orderDetail ? (
          <>
            <Alert
              type="info"
              showIcon
              title="完整证据链"
              description={`订单判定、诊断规则与原始标准状态时间线使用规则集 ${orderDetail.rule_set_version}。`}
            />
            <Descriptions
              className="diagnostic-detail-summary"
              size="small"
              column={{ xs: 1, sm: 2 }}
            >
              <Descriptions.Item label="订单状态">
                {orderDetail.metric_detail.order_status}
              </Descriptions.Item>
              <Descriptions.Item label="仓库 / 承运商">
                {orderDetail.metric_detail.warehouse_id} /{" "}
                {orderDetail.metric_detail.carrier_id}
              </Descriptions.Item>
              <Descriptions.Item label="OTIF">
                {orderDetail.metric_detail.otif.status}
              </Descriptions.Item>
              <Descriptions.Item label="履约时长">
                {orderDetail.metric_detail.fulfillment_duration_hours === null
                  ? "不可计算"
                  : `${orderDetail.metric_detail.fulfillment_duration_hours.toFixed(2)} 小时`}
              </Descriptions.Item>
            </Descriptions>
            <Typography.Title level={4}>订单诊断</Typography.Title>
            <Collapse
              items={orderDetail.findings.map((result) => ({
                key: `${result.category}-${result.rule_id}`,
                label: (
                  <Flex gap={8} wrap>
                    {severityTag(result.severity)}
                    <Typography.Text strong>{result.title}</Typography.Text>
                    <Tag>
                      {[result.rule_id, ...result.merged_rule_ids].join(" / ")}
                    </Tag>
                  </Flex>
                ),
                children: <ResultEvidence result={result} />,
              }))}
            />
            <Typography.Title level={4}>事件时间线</Typography.Title>
            {orderDetail.timeline.length ? (
              <Timeline
                items={orderDetail.timeline.map((event) => ({
                  color: event.source === "warehouse" ? "blue" : "green",
                  content: (
                    <div>
                      <Typography.Text strong>
                        {event.event_code}
                      </Typography.Text>
                      <br />
                      <Typography.Text>{event.event_time}</Typography.Text>
                      <br />
                      <Typography.Text>
                        {event.source === "warehouse" ? "仓库" : "物流"} ·
                        原始状态：{event.raw_status}
                        {event.location_code
                          ? ` · 位置：${event.location_code}`
                          : ""}
                      </Typography.Text>
                    </div>
                  ),
                }))}
              />
            ) : (
              <Empty description="没有可展示的有效事件；请查看数据质量警告。" />
            )}
          </>
        ) : null}
      </Drawer>
    </>
  );
}
