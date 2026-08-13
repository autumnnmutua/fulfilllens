import {
  BarChartOutlined,
  CalculatorOutlined,
  DatabaseOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Collapse,
  Empty,
  Flex,
  Input,
  Segmented,
  Select,
  Skeleton,
  Table,
  Tag,
  Typography,
} from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiClientError } from "../api/client";
import { dashboardApi } from "../api/dashboard";
import { DashboardContextBar } from "../components/dashboard/DashboardContextBar";
import { DashboardFiltersPanel } from "../components/dashboard/DashboardFiltersPanel";
import { DashboardMetricCards } from "../components/dashboard/DashboardMetricCards";
import { DashboardOrderList } from "../components/dashboard/DashboardOrderList";
import { RecommendationPanel } from "../components/recommendations/RecommendationPanel";
import { buildClientRecommendations } from "../analysis/recommendations";
import {
  formatHours,
  formatMetricValue,
  formatPercent,
  metricByCode,
} from "../components/dashboard/formatters";
import { EChart, type EChartOption } from "../components/EChart";
import { useNotifications } from "../components/notification-context";
import { PageHeader } from "../components/PageHeader";
import { initialAnalysisDataset } from "../analysis/browserSelection";
import type {
  BreakdownDimension,
  BreakdownSort,
  DashboardFilters,
  DashboardOrderOptions,
  DashboardOrderPage,
  DashboardOverview,
  DashboardViewOptions,
  OrderSort,
  SortDirection,
} from "../types/dashboard";
import type { DatasetSelection } from "../types/metrics";

const EMPTY_FILTERS: DashboardFilters = {
  start_date: null,
  end_date: null,
  warehouses: [],
  carriers: [],
  regions: [],
  statuses: [],
  anomaly_types: [],
  timezone: "Asia/Shanghai",
};
const DEFAULT_VIEW: DashboardViewOptions = {
  grain: "date",
  dimension: "carrier_id",
  breakdownSortBy: "anomaly_order_rate",
  breakdownSortDirection: "desc",
};
const DEFAULT_ORDERS: DashboardOrderOptions = {
  page: 1,
  pageSize: 20,
  sortBy: "created_at",
  sortDirection: "desc",
};

const breakdownLabels: Record<BreakdownDimension, string> = {
  carrier_id: "承运商",
  warehouse_id: "仓库",
  destination_region: "目的地区",
};
const breakdownMetricLabels: Record<BreakdownSort, string> = {
  order_count: "订单量",
  otif_rate: "OTIF",
  fulfillment_duration_p90_hours: "P90 时效",
  anomaly_order_rate: "异常率",
};

function initialDataset(dataType: string): string {
  return initialAnalysisDataset(dataType);
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    const details = error.details.map((detail) => detail.message).join("；");
    return `${error.message}${details ? ` ${details}` : ""}（${error.code}）`;
  }
  return error instanceof Error ? error.message : "分析总览读取失败。";
}

export function AnalyticsPage() {
  const notifications = useNotifications();
  const [ordersId, setOrdersId] = useState(() => initialDataset("orders"));
  const [warehouseId, setWarehouseId] = useState(() =>
    initialDataset("warehouse_events"),
  );
  const [trackingId, setTrackingId] = useState(() =>
    initialDataset("tracking_events"),
  );
  const [draftFilters, setDraftFilters] =
    useState<DashboardFilters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] =
    useState<DashboardFilters>(EMPTY_FILTERS);
  const [viewOptions, setViewOptions] =
    useState<DashboardViewOptions>(DEFAULT_VIEW);
  const [orderOptions, setOrderOptions] =
    useState<DashboardOrderOptions>(DEFAULT_ORDERS);
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [orders, setOrders] = useState<DashboardOrderPage | null>(null);
  const [overviewBusy, setOverviewBusy] = useState(false);
  const [ordersBusy, setOrdersBusy] = useState(false);
  const [persistentError, setPersistentError] = useState<string | null>(null);
  const autoLoaded = useRef(false);
  const overviewRequest = useRef(0);
  const orderRequest = useRef(0);

  const selection: DatasetSelection = useMemo(
    () => ({
      orders_dataset_id: ordersId.trim(),
      warehouse_events_dataset_id: warehouseId.trim() || null,
      tracking_events_dataset_id: trackingId.trim() || null,
    }),
    [ordersId, trackingId, warehouseId],
  );

  const loadOverview = useCallback(
    async (
      filters: DashboardFilters,
      options: DashboardViewOptions,
      announce = false,
    ) => {
      if (!selection.orders_dataset_id) {
        setPersistentError(
          "请先导入订单、仓库作业或物流轨迹数据。只有物流轨迹也可以分析时效、状态与异常。 ",
        );
        return;
      }
      const requestId = overviewRequest.current + 1;
      overviewRequest.current = requestId;
      setOverviewBusy(true);
      setPersistentError(null);
      try {
        const result = await dashboardApi.overview(selection, filters, options);
        if (overviewRequest.current === requestId) {
          setOverview(result);
          if (announce) {
            notifications.showSuccess(
              "分析总览已更新",
              "指标、趋势、分布、节点和维度对比已使用同一筛选集合重算。",
            );
          }
        }
      } catch (error) {
        if (overviewRequest.current === requestId) {
          const message = errorMessage(error);
          setPersistentError(message);
          notifications.showError("分析总览未完成", message);
        }
      } finally {
        if (overviewRequest.current === requestId) {
          setOverviewBusy(false);
        }
      }
    },
    [notifications, selection],
  );

  const loadOrders = useCallback(
    async (filters: DashboardFilters, options: DashboardOrderOptions) => {
      if (!selection.orders_dataset_id) {
        return;
      }
      const requestId = orderRequest.current + 1;
      orderRequest.current = requestId;
      setOrdersBusy(true);
      try {
        const result = await dashboardApi.orders(selection, filters, options);
        if (orderRequest.current === requestId) {
          setOrders(result);
        }
      } catch (error) {
        if (orderRequest.current === requestId) {
          setPersistentError(errorMessage(error));
        }
      } finally {
        if (orderRequest.current === requestId) {
          setOrdersBusy(false);
        }
      }
    },
    [selection],
  );

  const loadDashboard = useCallback(
    (
      filters: DashboardFilters,
      nextView: DashboardViewOptions,
      nextOrders: DashboardOrderOptions,
      announce = false,
    ) => {
      void loadOverview(filters, nextView, announce);
      void loadOrders(filters, nextOrders);
    },
    [loadOrders, loadOverview],
  );

  useEffect(() => {
    if (autoLoaded.current || !selection.orders_dataset_id) {
      return;
    }
    autoLoaded.current = true;
    loadDashboard(EMPTY_FILTERS, DEFAULT_VIEW, DEFAULT_ORDERS);
  }, [loadDashboard, selection.orders_dataset_id]);

  function recalculate() {
    autoLoaded.current = true;
    window.localStorage.setItem(
      "fulfilllens.dashboard.filters",
      JSON.stringify(draftFilters),
    );
    setAppliedFilters(draftFilters);
    setOrderOptions(DEFAULT_ORDERS);
    loadDashboard(draftFilters, viewOptions, DEFAULT_ORDERS, true);
  }

  function clearFilters() {
    const cleared = { ...EMPTY_FILTERS };
    window.localStorage.removeItem("fulfilllens.dashboard.filters");
    setDraftFilters(cleared);
    setAppliedFilters(cleared);
    setOrderOptions(DEFAULT_ORDERS);
    loadDashboard(cleared, viewOptions, DEFAULT_ORDERS, true);
  }

  function changeView(next: DashboardViewOptions) {
    setViewOptions(next);
    void loadOverview(appliedFilters, next);
  }

  function changeOrderPage(page: number, pageSize: number) {
    const next = { ...orderOptions, page, pageSize };
    setOrderOptions(next);
    void loadOrders(appliedFilters, next);
  }

  function changeOrderSort(sortBy: OrderSort, sortDirection: SortDirection) {
    const next = { ...orderOptions, page: 1, sortBy, sortDirection };
    setOrderOptions(next);
    void loadOrders(appliedFilters, next);
  }

  const trackingOnly =
    overview?.distribution.metric_code === "tracking_span_hours";
  const analysisVolumeLabel = trackingOnly ? "运单量" : "订单量";
  const durationTitle = trackingOnly ? "轨迹首末时效分布" : "履约时长分布";
  const durationAxisLabel = trackingOnly
    ? "轨迹首末时效（小时）"
    : "履约时长（小时）";
  const durationSampleLabel = trackingOnly ? "运单数" : "订单数";

  const trendOption: EChartOption = {
    color: ["#4f6d7a", "#146c94", "#d9485f"],
    tooltip: { trigger: "axis" },
    legend: { data: [analysisVolumeLabel, "OTIF", "异常率"] },
    grid: { left: 58, right: 64, top: 56, bottom: 62 },
    xAxis: {
      type: "category",
      data: overview?.trend.groups.map((group) => group.label) ?? [],
    },
    yAxis: [
      {
        type: "value",
        name: analysisVolumeLabel,
        min: 0,
        minInterval: 1,
      },
      {
        type: "value",
        name: "比例",
        min: 0,
        max: 1,
        axisLabel: {
          formatter: (value: number) => `${Math.round(value * 100)}%`,
        },
      },
    ],
    series: [
      {
        name: analysisVolumeLabel,
        type: "bar",
        yAxisIndex: 0,
        data: overview?.trend.groups.map((group) => group.order_count) ?? [],
      },
      {
        name: "OTIF",
        type: "line",
        yAxisIndex: 1,
        connectNulls: false,
        symbol: "circle",
        data:
          overview?.trend.groups.map(
            (group) => metricByCode(group.metrics, "otif_rate")?.value ?? null,
          ) ?? [],
      },
      {
        name: "异常率",
        type: "line",
        yAxisIndex: 1,
        connectNulls: false,
        symbol: "diamond",
        lineStyle: { type: "dashed" },
        data:
          overview?.trend.groups.map(
            (group) =>
              metricByCode(group.metrics, "anomaly_order_rate")?.value ?? null,
          ) ?? [],
      },
    ],
  };

  const distributionOption: EChartOption = {
    color: ["#146c94"],
    tooltip: { trigger: "axis" },
    grid: { left: 58, right: 24, top: 28, bottom: 78 },
    xAxis: {
      type: "category",
      name: durationAxisLabel,
      nameLocation: "middle",
      nameGap: 56,
      axisLabel: { rotate: 28 },
      data:
        overview?.distribution.bins.map(
          (bin) =>
            `${bin.lower_bound.toFixed(1)}–${bin.upper_bound.toFixed(1)}`,
        ) ?? [],
    },
    yAxis: {
      type: "value",
      name: durationSampleLabel,
      min: 0,
      minInterval: 1,
    },
    series: [
      {
        name: durationSampleLabel,
        type: "bar",
        data: overview?.distribution.bins.map((bin) => bin.count) ?? [],
      },
    ],
  };

  const nodeOption: EChartOption = {
    color: ["#7895a3", "#146c94", "#d97706"],
    tooltip: { trigger: "axis" },
    legend: { data: ["平均", "P50", "P90"] },
    grid: { left: 118, right: 34, top: 58, bottom: 60 },
    xAxis: {
      type: "value",
      name: "小时",
      nameLocation: "middle",
      nameGap: 38,
      axisLabel: { margin: 12 },
      min: 0,
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: overview?.nodes.map((node) => node.display_name) ?? [],
    },
    series: [
      {
        name: "平均",
        type: "bar",
        data: overview?.nodes.map((node) => node.mean_hours) ?? [],
      },
      {
        name: "P50",
        type: "bar",
        data: overview?.nodes.map((node) => node.median_hours) ?? [],
      },
      {
        name: "P90",
        type: "bar",
        data:
          overview?.nodes.map((node) =>
            node.p90_hours === null
              ? null
              : {
                  value: node.p90_hours,
                  itemStyle: {
                    color: node.is_bottleneck ? "#c2410c" : "#d97706",
                  },
                },
          ) ?? [],
      },
    ],
  };

  const breakdownGroups = overview?.breakdown.groups ?? [];
  const breakdownChartGroups = breakdownGroups.slice(0, 20);
  const breakdownIsRatio =
    viewOptions.breakdownSortBy === "otif_rate" ||
    viewOptions.breakdownSortBy === "anomaly_order_rate";
  const breakdownIsHours =
    viewOptions.breakdownSortBy === "fulfillment_duration_p90_hours";
  const breakdownOption: EChartOption = {
    color: ["#146c94"],
    tooltip: { trigger: "axis" },
    grid: { left: 108, right: 38, top: 30, bottom: 52 },
    xAxis: {
      type: "value",
      min: 0,
      ...(breakdownIsRatio ? { max: 1 } : {}),
      name: breakdownIsRatio ? "比例" : breakdownIsHours ? "小时" : "订单数",
      axisLabel: breakdownIsRatio
        ? {
            formatter: (value: number) => `${Math.round(value * 100)}%`,
          }
        : undefined,
      minInterval: breakdownIsRatio || breakdownIsHours ? undefined : 1,
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: breakdownChartGroups.map((group) => group.label),
    },
    series: [
      {
        name: breakdownMetricLabels[viewOptions.breakdownSortBy],
        type: "bar",
        data: breakdownChartGroups.map((group) => {
          if (viewOptions.breakdownSortBy === "order_count") {
            return group.order_count;
          }
          return (
            metricByCode(group.metrics, viewOptions.breakdownSortBy)?.value ??
            null
          );
        }),
      },
    ],
  };

  const bottleneck = overview?.nodes.find((node) => node.is_bottleneck);
  const recommendations = useMemo(
    () => (overview ? buildClientRecommendations(overview) : null),
    [overview],
  );
  return (
    <>
      <PageHeader
        title="分析总览"
        description="用一致筛选回答整体表现、问题位置和需核查订单；服务端与浏览器本地数据均使用统一、可追溯的指标口径。"
      />
      <Alert
        className="prominent-alert"
        type="info"
        showIcon
        title="分析结论可追溯，异常不等于根因"
        description="指标保留分子、分母、不可计算数量、覆盖率与口径版本；基线异常只用于定位核查对象，不代表因果诊断。"
      />

      <Card
        className="section-card dataset-selection-card"
        title="当前分析数据"
        extra={<DatabaseOutlined />}
      >
        <Flex vertical gap="middle">
          <Typography.Paragraph>
            系统默认只分析最近确认的当前文件，不会自动混入教学案例或兼容性示例。切换文件后会依据内容指纹重新计算。
          </Typography.Paragraph>
          <Collapse
            items={[
              {
                key: "technical-datasets",
                label: "高级设置 / 技术详情（数据集编号）",
                children: (
                  <div className="dataset-id-grid">
                    <label className="import-field">
                      <Typography.Text strong>订单数据集 ID</Typography.Text>
                      <Input
                        aria-label="订单数据集 ID"
                        value={ordersId}
                        onChange={(event) => setOrdersId(event.target.value)}
                      />
                    </label>
                    <label className="import-field">
                      <Typography.Text strong>
                        仓库事件数据集 ID
                      </Typography.Text>
                      <Input
                        aria-label="仓库事件数据集 ID"
                        value={warehouseId}
                        onChange={(event) => setWarehouseId(event.target.value)}
                      />
                    </label>
                    <label className="import-field">
                      <Typography.Text strong>
                        物流轨迹数据集 ID
                      </Typography.Text>
                      <Input
                        aria-label="物流轨迹数据集 ID"
                        value={trackingId}
                        onChange={(event) => setTrackingId(event.target.value)}
                      />
                    </label>
                  </div>
                ),
              },
            ]}
          />
          <Button
            type="primary"
            icon={<CalculatorOutlined />}
            loading={overviewBusy || ordersBusy}
            onClick={recalculate}
          >
            重新分析所选数据集
          </Button>
        </Flex>
      </Card>

      {persistentError ? (
        <Alert
          className="section-card"
          type="error"
          showIcon
          title="无法完成分析"
          description={persistentError}
          action={
            <Button
              danger
              onClick={() =>
                loadDashboard(appliedFilters, viewOptions, orderOptions, true)
              }
            >
              重试
            </Button>
          }
        />
      ) : null}

      <DashboardFiltersPanel
        busy={overviewBusy || ordersBusy}
        options={overview?.filter_options ?? null}
        value={draftFilters}
        onChange={setDraftFilters}
        onApply={recalculate}
        onClear={clearFilters}
      />

      {overviewBusy && overview === null ? (
        <Card
          className="section-card"
          role="status"
          aria-live="polite"
          aria-label="正在加载分析总览"
        >
          <Skeleton active paragraph={{ rows: 8 }} />
        </Card>
      ) : overview === null ? (
        <Card className="section-card">
          <Empty description="请先导入并确认任一种业务数据，再读取当前数据能够支持的分析。" />
        </Card>
      ) : (
        <>
          <DashboardContextBar context={overview.context} />
          <Card className="section-card" title="当前可分析能力">
            <Flex vertical gap="small">
              {(overview.context.capabilities ?? []).map((capability) => (
                <Flex key={capability.code} align="start" gap="small">
                  <Tag color={capability.available ? "success" : "default"}>
                    {capability.available ? "已支持" : "数据不足"}
                  </Tag>
                  <div>
                    <Typography.Text strong>{capability.label}</Typography.Text>
                    <br />
                    <Typography.Text>{capability.reason}</Typography.Text>
                  </div>
                </Flex>
              ))}
            </Flex>
          </Card>
          <DashboardMetricCards
            context={overview.context}
            metrics={overview.metrics}
          />

          {overview.context.order_count === 0 ? (
            <Alert
              className="section-card"
              type="warning"
              showIcon
              title="当前筛选没有订单"
              description="系统不会用 0 冒充指标结果。请清除部分筛选，或确认日期、仓库、承运商、地区、状态和异常类型是否同时成立。"
            />
          ) : (
            <>
              <Card
                className="section-card"
                title="订单量与履约质量趋势"
                extra={
                  <Segmented
                    aria-label="趋势粒度"
                    value={viewOptions.grain}
                    options={[
                      { value: "date", label: "按日" },
                      { value: "week", label: "按周" },
                    ]}
                    onChange={(value) =>
                      changeView({
                        ...viewOptions,
                        grain: value as "date" | "week",
                      })
                    }
                  />
                }
              >
                <Typography.Paragraph>
                  回答“何时变差”：柱为{analysisVolumeLabel}，实线为
                  OTIF，虚线菱形为异常率；比例轴固定 0–100%。样本{" "}
                  {overview.context.order_count} 单，OTIF 覆盖{" "}
                  {formatPercent(
                    metricByCode(overview.metrics, "otif_rate")?.coverage ??
                      null,
                  )}
                  。
                </Typography.Paragraph>
                {overview.trend.groups.length < 2 ? (
                  <Alert
                    showIcon
                    type="warning"
                    title="趋势点不足"
                    description="当前时间范围少于 2 个有效时间点，只能查看该点快照，不能据此判断趋势。"
                  />
                ) : null}
                <EChart
                  ariaLabel="订单量柱形与 OTIF、异常率折线趋势图"
                  option={trendOption}
                />
              </Card>

              <Card
                className="section-card"
                title={durationTitle}
                extra={<BarChartOutlined />}
              >
                <Typography.Paragraph>
                  回答“时效长尾有多严重”：单位为小时；样本{" "}
                  {overview.distribution.sample_size}，覆盖{" "}
                  {formatPercent(overview.distribution_coverage)}，P50{" "}
                  {formatHours(overview.distribution.median)}，P90{" "}
                  {formatHours(overview.distribution.p90)}
                  。合法非负样本全部保留；非法或负时长不进入分布并保留警告。
                  {trackingOnly
                    ? " 当前按同一运单的首个与最后一个有效事件计算，不等于订单创建到交付的完整履约时长。"
                    : " 当前使用订单创建时间到实际交付时间。"}
                </Typography.Paragraph>
                {overview.distribution.sample_size === 0 ? (
                  <Empty
                    description={
                      overview.distribution.warnings[0] ??
                      (trackingOnly
                        ? "同一运单至少需要两个有效时间事件，当前无法形成轨迹首末时效分布。"
                        : "完成订单缺少有效创建/交付时间，无法形成履约时长分布。")
                    }
                  />
                ) : (
                  <EChart
                    ariaLabel={`${durationTitle}直方图，横轴小时，纵轴${durationSampleLabel}`}
                    option={distributionOption}
                  />
                )}
              </Card>

              <Card className="section-card" title="标准节点耗时">
                <Typography.Paragraph>
                  回答“流程卡在哪里”：比较平均、P50 和
                  P90；各节点按事件完整配对后计算。
                  {bottleneck?.p90_hours !== null &&
                  bottleneck?.p90_hours !== undefined
                    ? ` 当前 P90 最大的是“${bottleneck.display_name}”（${bottleneck.p90_hours.toFixed(1)} 小时），仅作为优先核查线索。`
                    : " 当前关联事件不足，无法确定瓶颈。"}
                </Typography.Paragraph>
                {overview.nodes.every((node) => node.p90_hours === null) ? (
                  <Empty description="缺少可配对的仓库或物流事件。请关联事件数据集，或检查事件状态与时间顺序。" />
                ) : (
                  <>
                    <div className="node-duration-chart">
                      <EChart
                        ariaLabel="各标准节点平均、P50、P90 时长对比图"
                        option={nodeOption}
                      />
                    </div>
                    <Table
                      rowKey="interval_code"
                      size="small"
                      pagination={false}
                      scroll={{ x: 720 }}
                      dataSource={overview.nodes}
                      columns={[
                        {
                          title: "节点",
                          dataIndex: "display_name",
                          key: "display_name",
                          render: (value, node) => (
                            <>
                              {value}{" "}
                              {node.is_bottleneck ? (
                                <Tag color="volcano">P90 最大</Tag>
                              ) : null}
                            </>
                          ),
                        },
                        {
                          title: "平均",
                          dataIndex: "mean_hours",
                          key: "mean",
                          render: formatHours,
                        },
                        {
                          title: "P50",
                          dataIndex: "median_hours",
                          key: "median",
                          render: formatHours,
                        },
                        {
                          title: "P90",
                          dataIndex: "p90_hours",
                          key: "p90",
                          render: formatHours,
                        },
                        {
                          title: "样本 / 应参与",
                          key: "sample",
                          render: (_, node) =>
                            `${node.sample_size} / ${node.eligible_count}`,
                        },
                        {
                          title: "覆盖率",
                          dataIndex: "coverage",
                          key: "coverage",
                          render: formatPercent,
                        },
                      ]}
                    />
                  </>
                )}
              </Card>

              <Card
                className="section-card"
                title="业务维度对比"
                extra={
                  <Flex gap="small" wrap>
                    <Select<BreakdownDimension>
                      aria-label="对比维度"
                      value={viewOptions.dimension}
                      options={Object.entries(breakdownLabels).map(
                        ([value, label]) => ({
                          value: value as BreakdownDimension,
                          label,
                        }),
                      )}
                      onChange={(dimension) =>
                        changeView({ ...viewOptions, dimension })
                      }
                    />
                    <Select<BreakdownSort>
                      aria-label="维度排序指标"
                      value={viewOptions.breakdownSortBy}
                      options={Object.entries(breakdownMetricLabels).map(
                        ([value, label]) => ({
                          value: value as BreakdownSort,
                          label,
                        }),
                      )}
                      onChange={(breakdownSortBy) =>
                        changeView({ ...viewOptions, breakdownSortBy })
                      }
                    />
                  </Flex>
                }
              >
                <Typography.Paragraph>
                  回答“哪个{breakdownLabels[viewOptions.dimension]}
                  优先核查”：当前按
                  {breakdownMetricLabels[viewOptions.breakdownSortBy]}
                  降序；比例指标从 0
                  起，缺失值排在末尾。每组均保留订单量、覆盖率和小样本提示。
                  {breakdownGroups.length > 20
                    ? ` 图表只展示排序前 20 组，表格保留全部 ${breakdownGroups.length} 组并分页。`
                    : ""}
                </Typography.Paragraph>
                {breakdownGroups.length === 0 ? (
                  <Empty description="当前筛选没有可比较分组。" />
                ) : (
                  <>
                    <EChart
                      ariaLabel={`${breakdownLabels[viewOptions.dimension]}按${breakdownMetricLabels[viewOptions.breakdownSortBy]}对比图`}
                      option={breakdownOption}
                    />
                    <Table
                      rowKey="key"
                      size="small"
                      pagination={{
                        pageSize: 20,
                        hideOnSinglePage: true,
                        showTotal: (total) => `共 ${total} 组`,
                      }}
                      scroll={{ x: 920 }}
                      dataSource={breakdownGroups}
                      columns={[
                        {
                          title: breakdownLabels[viewOptions.dimension],
                          dataIndex: "label",
                          key: "label",
                        },
                        {
                          title: "订单量",
                          dataIndex: "order_count",
                          key: "order_count",
                        },
                        ...[
                          "otif_rate",
                          "fulfillment_duration_p90_hours",
                          "anomaly_order_rate",
                        ].map((code) => ({
                          title: breakdownMetricLabels[code as BreakdownSort],
                          key: code,
                          render: (
                            _: unknown,
                            group: (typeof breakdownGroups)[number],
                          ) => {
                            const item = metricByCode(group.metrics, code);
                            return item ? formatMetricValue(item) : "不可计算";
                          },
                        })),
                        {
                          title: "样本提示",
                          key: "warning",
                          render: (
                            _: unknown,
                            group: (typeof breakdownGroups)[number],
                          ) => group.warnings.join("；") || "—",
                        },
                      ]}
                    />
                  </>
                )}
              </Card>
            </>
          )}

          {recommendations ? (
            <RecommendationPanel bundle={recommendations} />
          ) : null}

          <DashboardOrderList
            busy={ordersBusy}
            onExportCsv={() =>
              dashboardApi.downloadOrdersCsv(
                selection,
                appliedFilters,
                orderOptions,
              )
            }
            data={orders}
            selection={selection}
            sortBy={orderOptions.sortBy}
            sortDirection={orderOptions.sortDirection}
            onPageChange={changeOrderPage}
            onSortChange={changeOrderSort}
          />

          {overview.warnings.length > 0 ? (
            <Card className="section-card" title="数据警告">
              <Typography.Paragraph>
                共 {overview.context.warning_count} 条；页面展示前{" "}
                {overview.warnings.length} 条
                {overview.warnings_truncated
                  ? "，其余警告已为浏览器性能截断。"
                  : "。"}
              </Typography.Paragraph>
              <Collapse
                items={overview.warnings.map((warning, index) => ({
                  key: `${warning.code}-${warning.order_id ?? ""}-${index}`,
                  label: `${warning.code}${warning.order_id ? ` · ${warning.order_id}` : ""}`,
                  children: warning.message,
                }))}
              />
            </Card>
          ) : null}
        </>
      )}
    </>
  );
}
