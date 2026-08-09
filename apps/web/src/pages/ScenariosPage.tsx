import {
  CopyOutlined,
  DeleteOutlined,
  ExperimentOutlined,
  PlusOutlined,
  SaveOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Collapse,
  Descriptions,
  Empty,
  Flex,
  Input,
  InputNumber,
  List,
  Popconfirm,
  Select,
  Skeleton,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiClientError } from "../api/client";
import { simulationApi } from "../api/simulation";
import { useNotifications } from "../components/notification-context";
import { PageHeader } from "../components/PageHeader";
import { onlineDemoDatasetId } from "../config/runtime";
import type { DatasetSelection } from "../types/metrics";
import type {
  BaselineResponse,
  MetricComparison,
  ParameterCatalog,
  ScenarioParameters,
  ScenarioRecord,
  SensitivityParameter,
  SensitivityResponse,
  SimulationResponse,
  WarehouseImprovement,
  WarehouseNodeCode,
} from "../types/simulation";

const ESTIMATE_LABEL =
  "基于历史数据和简化假设的情景估算，不代表真实预测或保证。";

function emptyParameters(): ScenarioParameters {
  return {
    warehouse_improvements: [],
    pickup_improvement: null,
    carrier_mix: null,
    promise_strategy: null,
  };
}

function initialDataset(key: string): string {
  const fromUrl = new URLSearchParams(window.location.search)
    .get(`${key}_dataset_id`)
    ?.trim();
  return (
    fromUrl ||
    window.localStorage.getItem(`fulfilllens.dataset.${key}`) ||
    onlineDemoDatasetId(key)
  );
}

function readableError(error: unknown): string {
  if (error instanceof ApiClientError) {
    const details = error.details.map((item) => item.message).join("；");
    return `${error.message}${details ? ` ${details}` : ""}（${error.code}）`;
  }
  return error instanceof Error ? error.message : "模拟请求未完成。";
}

function metricText(value: number | null, unit: string): string {
  if (value === null) {
    return "不可计算";
  }
  if (unit === "ratio") {
    return `${(value * 100).toFixed(1)}%`;
  }
  if (unit === "hour") {
    return `${value.toFixed(2)} 小时`;
  }
  return `${value.toFixed(0)} 单`;
}

function deltaText(item: MetricComparison): string {
  if (item.absolute_change === null) {
    return "不可计算";
  }
  if (item.unit === "ratio") {
    return `${item.absolute_change >= 0 ? "+" : ""}${(item.absolute_change * 100).toFixed(1)} 个百分点`;
  }
  const suffix = item.unit === "hour" ? "小时" : "单";
  return `${item.absolute_change >= 0 ? "+" : ""}${item.absolute_change.toFixed(2)} ${suffix}`;
}

function completeWeights(baseline: BaselineResponse): Record<string, number> {
  const weights: Record<string, number> = {};
  baseline.carrier_distribution.forEach((item, index) => {
    if (index === baseline.carrier_distribution.length - 1) {
      weights[item.carrier_id] =
        100 - Object.values(weights).reduce((sum, value) => sum + value, 0);
    } else {
      weights[item.carrier_id] = Number((item.share * 100).toFixed(6));
    }
  });
  return weights;
}

function cloneParameters(parameters: ScenarioParameters): ScenarioParameters {
  return structuredClone(parameters);
}

function ParametersEditor({
  baseline,
  catalog,
  parameters,
  onChange,
}: {
  baseline: BaselineResponse;
  catalog: ParameterCatalog;
  parameters: ScenarioParameters;
  onChange: (parameters: ScenarioParameters) => void;
}) {
  const nodeOptions = Object.entries(catalog.supported_warehouse_nodes).map(
    ([value, label]) => ({ value, label }),
  );
  const weightTotal = Object.values(
    parameters.carrier_mix?.weights ?? {},
  ).reduce((sum, value) => sum + value, 0);

  function updateWarehouse(
    index: number,
    update: Partial<WarehouseImprovement>,
  ) {
    const improvements = parameters.warehouse_improvements.map(
      (item, itemIndex) =>
        itemIndex === index ? { ...item, ...update } : item,
    );
    onChange({ ...parameters, warehouse_improvements: improvements });
  }

  return (
    <div className="scenario-parameter-stack">
      <Card
        size="small"
        title="仓内处理改善"
        extra={
          <Button
            icon={<PlusOutlined />}
            disabled={parameters.warehouse_improvements.length >= 5}
            onClick={() => {
              onChange({
                ...parameters,
                warehouse_improvements: [
                  ...parameters.warehouse_improvements,
                  {
                    node_code: "picking",
                    method: "fixed_hours",
                    value: 0,
                    warehouse_ids: [],
                  },
                ],
              });
            }}
          >
            添加节点
          </Button>
        }
      >
        {parameters.warehouse_improvements.length ? (
          <div className="scenario-parameter-rows">
            {parameters.warehouse_improvements.map((item, index) => (
              <div
                className="scenario-parameter-row"
                key={`${item.node_code}-${index}`}
              >
                <label>
                  <Typography.Text strong>节点</Typography.Text>
                  <Select
                    aria-label={`仓内改善节点 ${index + 1}`}
                    value={item.node_code}
                    options={nodeOptions}
                    onChange={(value: WarehouseNodeCode) => {
                      updateWarehouse(index, { node_code: value });
                    }}
                  />
                </label>
                <label>
                  <Typography.Text strong>改善方式</Typography.Text>
                  <Select
                    aria-label={`仓内改善方式 ${index + 1}`}
                    value={item.method}
                    options={[
                      { value: "fixed_hours", label: "固定减少（小时）" },
                      { value: "percentage", label: "比例改善（%）" },
                    ]}
                    onChange={(method: WarehouseImprovement["method"]) => {
                      updateWarehouse(index, {
                        method,
                        value: Math.min(
                          item.value,
                          method === "fixed_hours" ? 72 : 100,
                        ),
                      });
                    }}
                  />
                </label>
                <label>
                  <Typography.Text strong>
                    数值（{item.method === "fixed_hours" ? "小时" : "%"}）
                  </Typography.Text>
                  <InputNumber
                    aria-label={`仓内改善数值 ${index + 1}`}
                    min={0}
                    max={item.method === "fixed_hours" ? 72 : 100}
                    value={item.value}
                    onChange={(value) => {
                      updateWarehouse(index, { value: value ?? 0 });
                    }}
                  />
                </label>
                <Button
                  danger
                  aria-label={`删除仓内改善 ${index + 1}`}
                  icon={<DeleteOutlined />}
                  onClick={() => {
                    onChange({
                      ...parameters,
                      warehouse_improvements:
                        parameters.warehouse_improvements.filter(
                          (_value, itemIndex) => itemIndex !== index,
                        ),
                    });
                  }}
                />
              </div>
            ))}
          </div>
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="尚未设置仓内节点改善"
          />
        )}
        <Typography.Paragraph className="scenario-assumption">
          仅处理首个完整有效区间；节省时间假设完整传导至后续事件，不模拟资源排队反弹。
        </Typography.Paragraph>
      </Card>

      <Card size="small" title="出库至揽收等待改善">
        <Flex gap={16} align="center" wrap>
          <Switch
            aria-label="启用揽收等待改善"
            checked={parameters.pickup_improvement !== null}
            onChange={(enabled) => {
              onChange({
                ...parameters,
                pickup_improvement: enabled
                  ? { reduction_hours: 0, carrier_ids: [] }
                  : null,
              });
            }}
          />
          <Typography.Text strong>启用</Typography.Text>
          <label>
            <Typography.Text>减少小时数（0–168）</Typography.Text>
            <InputNumber
              aria-label="揽收等待减少小时数"
              min={0}
              max={168}
              disabled={parameters.pickup_improvement === null}
              value={parameters.pickup_improvement?.reduction_hours ?? 0}
              onChange={(value) => {
                if (parameters.pickup_improvement) {
                  onChange({
                    ...parameters,
                    pickup_improvement: {
                      ...parameters.pickup_improvement,
                      reduction_hours: value ?? 0,
                    },
                  });
                }
              }}
            />
          </label>
        </Flex>
        <Typography.Paragraph className="scenario-assumption">
          只对完整“待揽收→首次揽收”区间生效，假设揽收及后续轨迹等量前移。
        </Typography.Paragraph>
      </Card>

      <Card size="small" title="承运商结构调整">
        <Flex gap={16} align="center" wrap>
          <Switch
            aria-label="启用承运商结构调整"
            checked={parameters.carrier_mix !== null}
            disabled={baseline.carrier_distribution.length === 0}
            onChange={(enabled) => {
              onChange({
                ...parameters,
                carrier_mix: enabled
                  ? {
                      method: "empirical_resample",
                      weights: completeWeights(baseline),
                      random_seed: 20260729,
                    }
                  : null,
              });
            }}
          />
          <Typography.Text strong>启用经验重采样</Typography.Text>
          {parameters.carrier_mix ? (
            <Tag
              color={Math.abs(weightTotal - 100) < 0.000001 ? "green" : "red"}
            >
              权重合计 {weightTotal.toFixed(2)}%
            </Tag>
          ) : null}
        </Flex>
        {parameters.carrier_mix ? (
          <div className="scenario-weight-grid">
            {baseline.carrier_distribution.map((carrier) => (
              <label key={carrier.carrier_id}>
                <Typography.Text>
                  {carrier.carrier_id}（历史 {(carrier.share * 100).toFixed(1)}
                  %，n=
                  {carrier.order_count}）
                </Typography.Text>
                <InputNumber
                  aria-label={`${carrier.carrier_id} 目标权重`}
                  min={0}
                  max={100}
                  value={
                    parameters.carrier_mix?.weights[carrier.carrier_id] ?? 0
                  }
                  onChange={(value) => {
                    if (parameters.carrier_mix) {
                      onChange({
                        ...parameters,
                        carrier_mix: {
                          ...parameters.carrier_mix,
                          weights: {
                            ...parameters.carrier_mix.weights,
                            [carrier.carrier_id]: value ?? 0,
                          },
                        },
                      });
                    }
                  }}
                />
              </label>
            ))}
            <label>
              <Typography.Text>固定随机种子</Typography.Text>
              <InputNumber
                aria-label="承运商重采样随机种子"
                min={0}
                max={2_147_483_647}
                value={parameters.carrier_mix.random_seed}
                onChange={(value) => {
                  if (parameters.carrier_mix) {
                    onChange({
                      ...parameters,
                      carrier_mix: {
                        ...parameters.carrier_mix,
                        random_seed: value ?? 20260729,
                      },
                    });
                  }
                }}
              />
            </label>
          </div>
        ) : null}
        <Typography.Paragraph className="scenario-assumption">
          保留承运商历史订单的联合表现，但不控制线路、重量、服务等级或选择偏差；小样本只能看方向。
        </Typography.Paragraph>
      </Card>

      <Card size="small" title="承诺时效策略">
        <Flex gap={16} align="center" wrap>
          <Switch
            aria-label="启用承诺时效策略"
            checked={parameters.promise_strategy !== null}
            onChange={(enabled) => {
              onChange({
                ...parameters,
                promise_strategy: enabled ? { extension_hours: 0 } : null,
              });
            }}
          />
          <Typography.Text strong>启用</Typography.Text>
          <label>
            <Typography.Text>放宽小时数（0–168）</Typography.Text>
            <InputNumber
              aria-label="承诺时间放宽小时数"
              min={0}
              max={168}
              disabled={parameters.promise_strategy === null}
              value={parameters.promise_strategy?.extension_hours ?? 0}
              onChange={(value) => {
                if (parameters.promise_strategy) {
                  onChange({
                    ...parameters,
                    promise_strategy: { extension_hours: value ?? 0 },
                  });
                }
              }}
            />
          </label>
        </Flex>
        <Alert
          className="scenario-inline-warning"
          type="warning"
          showIcon
          title="放宽承诺可能改善 OT/OTIF 口径，但不等于真实运营改善。"
        />
      </Card>
    </div>
  );
}

export function ScenariosPage() {
  const notifications = useNotifications();
  const [ordersId, setOrdersId] = useState(() => initialDataset("orders"));
  const [warehouseId, setWarehouseId] = useState(() =>
    initialDataset("warehouse_events"),
  );
  const [trackingId, setTrackingId] = useState(() =>
    initialDataset("tracking_events"),
  );
  const [timezone, setTimezone] = useState("Asia/Shanghai");
  const [catalog, setCatalog] = useState<ParameterCatalog | null>(null);
  const [baseline, setBaseline] = useState<BaselineResponse | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scenarioName, setScenarioName] = useState("改进方案 1");
  const [parameters, setParameters] =
    useState<ScenarioParameters>(emptyParameters);
  const [result, setResult] = useState<SimulationResponse | null>(null);
  const [sensitivity, setSensitivity] = useState<SensitivityResponse | null>(
    null,
  );
  const [sensitivityParameter, setSensitivityParameter] =
    useState<SensitivityParameter>("pickup_reduction_hours");
  const [sensitivityMinimum, setSensitivityMinimum] = useState(0);
  const [sensitivityMaximum, setSensitivityMaximum] = useState(4);
  const [sensitivitySteps, setSensitivitySteps] = useState(5);
  const [busy, setBusy] = useState(false);
  const [persistentError, setPersistentError] = useState<string | null>(null);
  const autoLoaded = useRef(false);

  const datasets = useMemo<DatasetSelection>(
    () => ({
      orders_dataset_id: ordersId.trim(),
      warehouse_events_dataset_id: warehouseId.trim() || null,
      tracking_events_dataset_id: trackingId.trim() || null,
    }),
    [ordersId, trackingId, warehouseId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void simulationApi
      .parameters(controller.signal)
      .then(setCatalog)
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setPersistentError(readableError(error));
        }
      });
    return () => controller.abort();
  }, []);

  const establishBaseline = useCallback(
    async (announce = true) => {
      if (!datasets.orders_dataset_id) {
        setPersistentError("请先填写订单数据集 ID。");
        return;
      }
      setBusy(true);
      setPersistentError(null);
      try {
        const [nextBaseline, nextScenarios] = await Promise.all([
          simulationApi.baseline(datasets, timezone),
          simulationApi.scenarios(datasets.orders_dataset_id),
        ]);
        setBaseline(nextBaseline);
        setScenarios(nextScenarios);
        setResult(null);
        setSensitivity(null);
        if (nextScenarios.length) {
          const selected = nextScenarios[0];
          setSelectedId(selected.scenario_id);
          setScenarioName(selected.name);
          setParameters(cloneParameters(selected.parameters));
        } else {
          setSelectedId(null);
          setScenarioName("改进方案 1");
          setParameters(emptyParameters());
        }
        if (announce) {
          notifications.showSuccess(
            "当前基线已建立",
            `按 ${nextBaseline.metrics_definition_version} 计算，共 ${nextBaseline.order_count} 个订单。`,
          );
        }
      } catch (error) {
        const message = readableError(error);
        setPersistentError(message);
        if (announce) {
          notifications.showError("基线建立失败", message);
        }
      } finally {
        setBusy(false);
      }
    },
    [datasets, notifications, timezone],
  );

  useEffect(() => {
    if (autoLoaded.current || !datasets.orders_dataset_id || catalog === null) {
      return;
    }
    autoLoaded.current = true;
    void establishBaseline(false);
  }, [catalog, datasets.orders_dataset_id, establishBaseline]);

  async function createScenario() {
    if (!baseline) {
      setPersistentError("请先建立当前基线。");
      return;
    }
    setBusy(true);
    try {
      const created = await simulationApi.create(
        `改进方案 ${scenarios.length + 1}`,
        datasets,
        timezone,
        emptyParameters(),
      );
      setScenarios((current) => [created, ...current]);
      setSelectedId(created.scenario_id);
      setScenarioName(created.name);
      setParameters(cloneParameters(created.parameters));
      setResult(null);
      notifications.showSuccess("方案已创建", "可以设置参数后保存并运行。");
    } catch (error) {
      const message = readableError(error);
      setPersistentError(message);
      notifications.showError("方案创建失败", message);
    } finally {
      setBusy(false);
    }
  }

  async function saveScenario(): Promise<ScenarioRecord | null> {
    if (!selectedId) {
      setPersistentError("请先创建或选择方案。");
      return null;
    }
    try {
      const updated = await simulationApi.update(selectedId, {
        name: scenarioName,
        parameters,
      });
      setScenarios((current) =>
        current.map((item) =>
          item.scenario_id === selectedId ? updated : item,
        ),
      );
      setSelectedId(updated.scenario_id);
      notifications.showSuccess("方案已保存", "参数和名称已写入本地方案配置。");
      return updated;
    } catch (error) {
      const message = readableError(error);
      setPersistentError(message);
      notifications.showError("方案保存失败", message);
      return null;
    }
  }

  async function runScenario() {
    setBusy(true);
    setPersistentError(null);
    try {
      const saved = await saveScenario();
      if (!saved) return;
      const nextResult = await simulationApi.run(datasets, saved.scenario_id);
      setResult(nextResult);
      setSensitivity(null);
      notifications.showSuccess(
        "情景估算已完成",
        `从订单/节点层变换后重算，影响 ${nextResult.affected_order_count} 个订单。`,
      );
    } catch (error) {
      const message = readableError(error);
      setPersistentError(message);
      notifications.showError("情景估算失败", message);
    } finally {
      setBusy(false);
    }
  }

  async function copyScenario() {
    if (!selectedId) return;
    setBusy(true);
    try {
      const copied = await simulationApi.copy(
        selectedId,
        `${scenarioName} 副本`,
      );
      setScenarios((current) => [copied, ...current]);
      setSelectedId(copied.scenario_id);
      setScenarioName(copied.name);
      setParameters(cloneParameters(copied.parameters));
      setResult(null);
      notifications.showSuccess("方案已复制", "副本拥有独立参数，可继续修改。");
    } catch (error) {
      const message = readableError(error);
      setPersistentError(message);
      notifications.showError("方案复制失败", message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteScenario() {
    if (!selectedId) return;
    setBusy(true);
    try {
      await simulationApi.delete(selectedId);
      const remaining = scenarios.filter(
        (item) => item.scenario_id !== selectedId,
      );
      setScenarios(remaining);
      const next = remaining[0];
      setSelectedId(next?.scenario_id ?? null);
      setScenarioName(next?.name ?? `改进方案 ${remaining.length + 1}`);
      setParameters(
        next ? cloneParameters(next.parameters) : emptyParameters(),
      );
      setResult(null);
      setSensitivity(null);
      notifications.showSuccess(
        "方案已删除",
        "仅删除方案配置，原始数据没有变化。",
      );
    } catch (error) {
      const message = readableError(error);
      setPersistentError(message);
      notifications.showError("方案删除失败", message);
    } finally {
      setBusy(false);
    }
  }

  async function runSensitivity() {
    if (sensitivityMaximum < sensitivityMinimum) {
      setPersistentError("敏感性最大值不得小于最小值。");
      return;
    }
    const activeParameter = sensitivityOptions.some(
      (item) => item.value === sensitivityParameter,
    )
      ? sensitivityParameter
      : sensitivityOptions[0]?.value;
    if (!activeParameter) {
      setPersistentError("请先启用一个可做敏感性分析的参数。");
      return;
    }
    const values = Array.from({ length: sensitivitySteps }, (_value, index) =>
      Number(
        (
          sensitivityMinimum +
          ((sensitivityMaximum - sensitivityMinimum) * index) /
            (sensitivitySteps - 1)
        ).toFixed(6),
      ),
    );
    setBusy(true);
    setPersistentError(null);
    try {
      setSensitivity(
        await simulationApi.sensitivity(
          datasets,
          timezone,
          parameters,
          activeParameter,
          values,
        ),
      );
      notifications.showSuccess(
        "敏感性分析已完成",
        "每个取值均从订单/事件层重算。",
      );
    } catch (error) {
      const message = readableError(error);
      setPersistentError(message);
      notifications.showError("敏感性分析失败", message);
    } finally {
      setBusy(false);
    }
  }

  const sensitivityOptions: Array<{
    value: SensitivityParameter;
    label: string;
  }> = [];
  if (parameters.warehouse_improvements.length) {
    sensitivityOptions.push({
      value: "warehouse_improvement_value",
      label: "第一个仓内改善数值",
    });
  }
  if (parameters.pickup_improvement) {
    sensitivityOptions.push({
      value: "pickup_reduction_hours",
      label: "揽收等待减少小时",
    });
  }
  if (parameters.promise_strategy) {
    sensitivityOptions.push({
      value: "promise_extension_hours",
      label: "承诺放宽小时",
    });
  }

  return (
    <>
      <PageHeader
        title="What-if 改进方案模拟器"
        description="从订单和节点层应用透明变换，重新计算履约指标并比较方向性影响。"
      />
      <Alert
        className="prominent-alert"
        type="warning"
        showIcon
        title="所有结果都是情景估算"
        description={ESTIMATE_LABEL}
      />
      {persistentError ? (
        <Alert
          className="persistent-error"
          type="error"
          showIcon
          title="当前操作未完成"
          description={persistentError}
          closable
          onClose={() => setPersistentError(null)}
        />
      ) : null}

      <Card className="section-card" title="数据与当前基线">
        <div className="scenario-dataset-grid">
          <label>
            <Typography.Text strong>订单数据集 ID（必填）</Typography.Text>
            <Input
              value={ordersId}
              onChange={(event) => setOrdersId(event.target.value)}
            />
          </label>
          <label>
            <Typography.Text strong>仓库事件数据集 ID</Typography.Text>
            <Input
              value={warehouseId}
              onChange={(event) => setWarehouseId(event.target.value)}
            />
          </label>
          <label>
            <Typography.Text strong>物流轨迹数据集 ID</Typography.Text>
            <Input
              value={trackingId}
              onChange={(event) => setTrackingId(event.target.value)}
            />
          </label>
          <label>
            <Typography.Text strong>分析时区</Typography.Text>
            <Input
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
            />
          </label>
        </div>
        <Button
          type="primary"
          icon={<ExperimentOutlined />}
          loading={busy}
          onClick={() => void establishBaseline()}
        >
          建立当前基线
        </Button>
      </Card>

      {busy && !baseline ? <Skeleton active paragraph={{ rows: 8 }} /> : null}
      {baseline ? (
        <>
          <Card className="scenario-baseline-card" title="只读基线">
            <Descriptions column={{ xs: 1, sm: 2, lg: 4 }} size="small">
              <Descriptions.Item label="订单数">
                {baseline.order_count}
              </Descriptions.Item>
              <Descriptions.Item label="指标版本">
                {baseline.metrics_definition_version}
              </Descriptions.Item>
              <Descriptions.Item label="模拟版本">
                {baseline.definition_version}
              </Descriptions.Item>
              <Descriptions.Item label="输入指纹">
                <Typography.Text code>
                  {baseline.input_fingerprint.slice(0, 12)}…
                </Typography.Text>
              </Descriptions.Item>
            </Descriptions>
            <div className="scenario-metric-grid">
              {baseline.metrics.map((metric) => (
                <Card size="small" key={metric.code}>
                  <Statistic
                    title={metric.display_name}
                    value={metricText(metric.value, metric.unit)}
                  />
                  <Typography.Text>
                    覆盖：
                    {metric.coverage === null
                      ? "不可计算"
                      : `${(metric.coverage * 100).toFixed(1)}%`}
                  </Typography.Text>
                </Card>
              ))}
            </div>
          </Card>

          <Card
            className="section-card"
            title="方案管理"
            extra={<Tag>{scenarios.length} 个方案</Tag>}
          >
            <div className="scenario-management-grid">
              <label>
                <Typography.Text strong>当前方案</Typography.Text>
                <Select
                  aria-label="当前方案"
                  placeholder="先创建方案"
                  value={selectedId}
                  options={scenarios.map((item) => ({
                    value: item.scenario_id,
                    label: item.name,
                  }))}
                  onChange={(value) => {
                    const selected = scenarios.find(
                      (item) => item.scenario_id === value,
                    );
                    if (selected) {
                      setSelectedId(value);
                      setScenarioName(selected.name);
                      setParameters(cloneParameters(selected.parameters));
                      setResult(null);
                      setSensitivity(null);
                    }
                  }}
                />
              </label>
              <label>
                <Typography.Text strong>方案名称</Typography.Text>
                <Input
                  aria-label="方案名称"
                  maxLength={64}
                  value={scenarioName}
                  onChange={(event) => setScenarioName(event.target.value)}
                />
              </label>
            </div>
            <Flex gap={8} wrap>
              <Button
                icon={<PlusOutlined />}
                onClick={() => void createScenario()}
              >
                新建方案
              </Button>
              <Button
                icon={<SaveOutlined />}
                disabled={!selectedId}
                onClick={() => void saveScenario()}
              >
                保存/重命名
              </Button>
              <Button
                icon={<CopyOutlined />}
                disabled={!selectedId}
                onClick={() => void copyScenario()}
              >
                复制方案
              </Button>
              <Popconfirm
                title="删除当前方案？"
                description="只删除本地方案参数，不会删除或改写原始数据。"
                okText="删除"
                cancelText="取消"
                onConfirm={() => void deleteScenario()}
              >
                <Button danger icon={<DeleteOutlined />} disabled={!selectedId}>
                  删除方案
                </Button>
              </Popconfirm>
            </Flex>
          </Card>

          {selectedId && catalog ? (
            <>
              <Card className="section-card" title="方案参数与影响路径">
                <ParametersEditor
                  baseline={baseline}
                  catalog={catalog}
                  parameters={parameters}
                  onChange={setParameters}
                />
                <Button
                  className="scenario-run-button"
                  type="primary"
                  size="large"
                  loading={busy}
                  icon={<ExperimentOutlined />}
                  onClick={() => void runScenario()}
                >
                  保存并运行情景估算
                </Button>
              </Card>

              <Collapse
                className="section-card"
                items={[
                  {
                    key: "catalog",
                    label: "查看全部参数业务含义、范围与模型假设",
                    children: (
                      <List
                        dataSource={catalog.parameters}
                        renderItem={(item) => (
                          <List.Item>
                            <List.Item.Meta
                              title={`${item.display_name} · ${item.minimum}–${item.maximum} ${item.unit}`}
                              description={`${item.business_meaning} 影响路径：${item.impact_path} 假设：${item.model_assumption}`}
                            />
                          </List.Item>
                        )}
                      />
                    ),
                  },
                ]}
              />
            </>
          ) : null}

          {result ? (
            <>
              <Alert
                className="prominent-alert"
                type="warning"
                showIcon
                title={`${result.scenario_name}：情景估算结果`}
                description={result.estimate_label}
              />
              <Card className="section-card" title="基线与方案指标变化">
                <Table
                  rowKey="code"
                  pagination={false}
                  scroll={{ x: 900 }}
                  dataSource={result.comparisons}
                  columns={[
                    { title: "指标", dataIndex: "display_name", width: 190 },
                    {
                      title: "基线",
                      width: 130,
                      render: (_value, item) =>
                        metricText(item.baseline_value, item.unit),
                    },
                    {
                      title: "方案",
                      width: 130,
                      render: (_value, item) =>
                        metricText(item.scenario_value, item.unit),
                    },
                    {
                      title: "绝对变化",
                      width: 150,
                      render: (_value, item) => deltaText(item),
                    },
                    {
                      title: "相对变化",
                      width: 120,
                      render: (_value, item) =>
                        item.relative_change === null
                          ? "不可计算"
                          : `${item.relative_change >= 0 ? "+" : ""}${(item.relative_change * 100).toFixed(1)}%`,
                    },
                    {
                      title: "分子/分母与覆盖",
                      render: (_value, item) =>
                        `基线 ${item.baseline_numerator ?? "—"}/${item.baseline_denominator ?? "—"}；方案 ${item.scenario_numerator ?? "—"}/${item.scenario_denominator ?? "—"}；覆盖 ${item.scenario_coverage === null ? "—" : `${(item.scenario_coverage * 100).toFixed(1)}%`}`,
                    },
                  ]}
                />
              </Card>

              <Card className="section-card" title="复现信息与模型假设">
                <Descriptions column={{ xs: 1, sm: 2, lg: 3 }} size="small">
                  <Descriptions.Item label="受影响订单">
                    {result.affected_order_count}
                  </Descriptions.Item>
                  <Descriptions.Item label="调整明细">
                    {result.total_adjustments}
                  </Descriptions.Item>
                  <Descriptions.Item label="随机种子">
                    {result.random_seed ?? "未使用随机过程"}
                  </Descriptions.Item>
                  <Descriptions.Item label="方案指纹">
                    <Typography.Text code>
                      {result.scenario_fingerprint.slice(0, 12)}…
                    </Typography.Text>
                  </Descriptions.Item>
                  <Descriptions.Item label="重算版本">
                    {result.metrics_definition_version}
                  </Descriptions.Item>
                  <Descriptions.Item label="调整节点">
                    {result.adjusted_nodes.length
                      ? result.adjusted_nodes.map((node) => (
                          <Tag key={node}>{node}</Tag>
                        ))
                      : "无"}
                  </Descriptions.Item>
                </Descriptions>
                <List
                  size="small"
                  header="模型假设"
                  dataSource={result.assumptions}
                  renderItem={(item) => <List.Item>{item}</List.Item>}
                />
                {result.warnings.map((warning) => (
                  <Alert
                    className="scenario-inline-warning"
                    key={warning}
                    type="warning"
                    showIcon
                    title={warning}
                  />
                ))}
              </Card>

              <Card className="section-card" title="调整订单与节点明细">
                {result.adjustments.length ? (
                  <Table
                    rowKey={(item) =>
                      `${item.order_id}-${item.transform_type}-${item.node_code ?? item.field_name}-${String(item.before_value)}-${String(item.after_value)}`
                    }
                    size="small"
                    pagination={{ pageSize: 10, hideOnSinglePage: true }}
                    scroll={{ x: 900 }}
                    dataSource={result.adjustments}
                    columns={[
                      { title: "方案订单", dataIndex: "order_id", width: 180 },
                      {
                        title: "来源订单",
                        dataIndex: "source_order_id",
                        width: 160,
                      },
                      {
                        title: "变换",
                        dataIndex: "transform_type",
                        width: 170,
                      },
                      {
                        title: "节点/字段",
                        render: (_value, item) =>
                          item.node_code ?? item.field_name,
                        width: 150,
                      },
                      {
                        title: "变换前",
                        dataIndex: "before_value",
                        width: 130,
                      },
                      { title: "变换后", dataIndex: "after_value", width: 130 },
                      { title: "解释", dataIndex: "explanation" },
                    ]}
                  />
                ) : (
                  <Empty description="当前参数没有调整任何可计算订单；不会用零伪装改善。" />
                )}
              </Card>

              <Card className="section-card" title="单参数敏感性分析">
                {sensitivityOptions.length ? (
                  <>
                    <div className="scenario-sensitivity-grid">
                      <label>
                        <Typography.Text strong>参数</Typography.Text>
                        <Select
                          aria-label="敏感性参数"
                          value={
                            sensitivityOptions.some(
                              (item) => item.value === sensitivityParameter,
                            )
                              ? sensitivityParameter
                              : sensitivityOptions[0]?.value
                          }
                          options={sensitivityOptions}
                          onChange={setSensitivityParameter}
                        />
                      </label>
                      <label>
                        <Typography.Text strong>最小值</Typography.Text>
                        <InputNumber
                          aria-label="敏感性最小值"
                          min={0}
                          value={sensitivityMinimum}
                          onChange={(value) =>
                            setSensitivityMinimum(value ?? 0)
                          }
                        />
                      </label>
                      <label>
                        <Typography.Text strong>最大值</Typography.Text>
                        <InputNumber
                          aria-label="敏感性最大值"
                          min={0}
                          value={sensitivityMaximum}
                          onChange={(value) =>
                            setSensitivityMaximum(value ?? 0)
                          }
                        />
                      </label>
                      <label>
                        <Typography.Text strong>取值点（3–11）</Typography.Text>
                        <InputNumber
                          aria-label="敏感性取值点"
                          min={3}
                          max={11}
                          value={sensitivitySteps}
                          onChange={(value) => setSensitivitySteps(value ?? 5)}
                        />
                      </label>
                    </div>
                    <Button
                      loading={busy}
                      onClick={() => void runSensitivity()}
                    >
                      运行敏感性分析
                    </Button>
                  </>
                ) : (
                  <Empty description="先启用仓内、揽收或承诺参数，再运行单参数敏感性分析。" />
                )}
                {sensitivity ? (
                  <Table
                    className="scenario-sensitivity-table"
                    rowKey="parameter_value"
                    pagination={false}
                    scroll={{ x: 720 }}
                    dataSource={sensitivity.points}
                    columns={[
                      {
                        title: `参数值（${sensitivity.unit === "hour" ? "小时" : "%"}）`,
                        dataIndex: "parameter_value",
                      },
                      {
                        title: "OTIF",
                        render: (_value, item) =>
                          metricText(item.otif, "ratio"),
                      },
                      {
                        title: "平均时效",
                        render: (_value, item) =>
                          metricText(item.fulfillment_mean_hours, "hour"),
                      },
                      {
                        title: "P50",
                        render: (_value, item) =>
                          metricText(item.fulfillment_p50_hours, "hour"),
                      },
                      {
                        title: "P90",
                        render: (_value, item) =>
                          metricText(item.fulfillment_p90_hours, "hour"),
                      },
                      {
                        title: "异常率",
                        render: (_value, item) =>
                          metricText(item.anomaly_rate, "ratio"),
                      },
                      {
                        title: "受影响订单",
                        dataIndex: "affected_order_count",
                      },
                    ]}
                  />
                ) : null}
              </Card>
            </>
          ) : null}
        </>
      ) : (
        <Card className="section-card">
          <Empty description="填写数据集并建立当前基线后，才会显示方案和模拟结果。" />
        </Card>
      )}
    </>
  );
}
