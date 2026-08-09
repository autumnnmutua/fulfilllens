import {
  Alert,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Flex,
  List,
  Modal,
  Spin,
  Tag,
  Typography,
} from "antd";
import { useEffect, useState } from "react";

import { ApiClientError } from "../api/client";
import { datasetsApi } from "../api/datasets";
import { workersAIApi } from "../api/workers-ai";
import { PageHeader } from "../components/PageHeader";
import { useNotifications } from "../components/notification-context";
import { isCloudflareDeploy } from "../config/runtime";
import type {
  WorkersAIProbeResult,
  WorkersAIStatus,
} from "../types/integrations";
import type { DatasetSummary } from "../types/datasets";

const DATA_TYPE_LABELS: Record<DatasetSummary["data_type"], string> = {
  orders: "订单表",
  warehouse_events: "仓库事件表",
  tracking_events: "物流轨迹表",
};

function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    return `${error.message}${error.requestId ? `（请求标识：${error.requestId}）` : ""}`;
  }
  return "本地请求发生未知错误，请重试。";
}

export function SettingsPage() {
  const [status, setStatus] = useState<WorkersAIStatus | null>(null);
  const [probe, setProbe] = useState<WorkersAIProbeResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [probing, setProbing] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [persistentError, setPersistentError] = useState<string | null>(null);
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [datasetsLoading, setDatasetsLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DatasetSummary | null>(
    null,
  );
  const notifications = useNotifications();

  useEffect(() => {
    const controller = new AbortController();
    workersAIApi
      .status(controller.signal)
      .then((response) => {
        setStatus(response);
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setPersistentError(errorMessage(error));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });
    return () => {
      controller.abort();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    datasetsApi
      .list(controller.signal)
      .then((response) => setDatasets(response.datasets))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setPersistentError(errorMessage(error));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setDatasetsLoading(false);
      });
    return () => controller.abort();
  }, []);

  async function deleteDataset() {
    if (!pendingDelete) return;
    setDeleting(pendingDelete.dataset_id);
    setPersistentError(null);
    try {
      const result = await datasetsApi.delete(pendingDelete.dataset_id);
      setDatasets((current) =>
        current.filter((item) => item.dataset_id !== result.dataset_id),
      );
      for (const key of ["orders", "warehouse_events", "tracking_events"]) {
        for (const prefix of [
          "fulfilllens.dataset",
          "fulfilllens.browser.dataset",
        ]) {
          const storageKey = `${prefix}.${key}`;
          if (window.localStorage.getItem(storageKey) === result.dataset_id) {
            window.localStorage.removeItem(storageKey);
          }
        }
      }
      notifications.showSuccess(
        "本地数据已清理",
        `删除 ${result.rows_deleted.toLocaleString("zh-CN")} 行，并清理 ${result.scenarios_deleted} 个关联方案。`,
      );
      setPendingDelete(null);
    } catch (error) {
      const message = errorMessage(error);
      setPersistentError(message);
      notifications.showError("本地数据未能清理", message);
    } finally {
      setDeleting(null);
    }
  }

  async function runProbe() {
    setProbing(true);
    setPersistentError(null);
    setProbe(null);
    try {
      const result = await workersAIApi.probe();
      setProbe(result);
      notifications.showSuccess("连接测试完成", result.message);
    } catch (error) {
      const message = errorMessage(error);
      setPersistentError(message);
      notifications.showError("连接测试失败", message);
    } finally {
      setConfirmed(false);
      setProbing(false);
    }
  }

  const ready = Boolean(status?.enabled && status.configured);

  return (
    <>
      <PageHeader
        title="设置"
        description={
          isCloudflareDeploy
            ? "查看 Cloudflare 原生绑定状态。AI 凭据不进入浏览器，也不保存在前端资源中。"
            : "查看本地配置与可选外部连接状态。真实密钥只从本机 API 进程环境读取，不进入浏览器。"
        }
      />
      <Alert
        className="prominent-alert"
        type="warning"
        showIcon
        message={
          isCloudflareDeploy
            ? "Workers AI 已通过 Cloudflare 原生绑定连接"
            : "Workers AI 是显式可选的外部连接"
        }
        description={
          isCloudflareDeploy
            ? "在线预览只在你勾选确认并点击测试后发送固定合成短句；不会读取或发送订单、仓库事件、物流轨迹或个人信息。"
            : "默认关闭；连接探针只发送固定合成短句。FulfillLens 不会自动把订单、仓库事件、物流轨迹或个人信息发送给 Cloudflare。"
        }
      />

      <Card title="Cloudflare Workers AI" className="section-card">
        {loading ? (
          <Spin tip="正在读取脱敏配置状态" />
        ) : (
          <Flex vertical gap="middle">
            <Descriptions bordered column={{ xs: 1, sm: 2 }}>
              <Descriptions.Item label="运行开关">
                <Tag color={status?.enabled ? "green" : "default"}>
                  {status?.enabled ? "已启用" : "默认关闭"}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="凭据状态">
                <Tag color={status?.configured ? "green" : "orange"}>
                  {status?.configured ? "已配置（已脱敏）" : "未配置"}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="模型">
                {status?.model ?? "—"}
              </Descriptions.Item>
              <Descriptions.Item label="数据策略">
                {status?.external_data_policy ?? "—"}
              </Descriptions.Item>
            </Descriptions>

            {!ready ? (
              <Alert
                type="info"
                showIcon
                message="连接测试尚不可用"
                description={
                  isCloudflareDeploy
                    ? "Cloudflare AI 绑定未就绪，请联系部署维护者检查绑定配置。"
                    : "请在本机已忽略的 apps/api/.env 中同时配置开关、Account ID 和 API Token，然后重启 API。"
                }
              />
            ) : null}

            <Checkbox
              checked={confirmed}
              disabled={!ready}
              onChange={(event) => setConfirmed(event.target.checked)}
            >
              我确认本次测试会向 Cloudflare 发送固定合成短句并可能产生少量用量
            </Checkbox>
            <Button
              type="primary"
              disabled={!ready || !confirmed}
              loading={probing}
              onClick={() => void runProbe()}
            >
              执行合成连接探针
            </Button>

            {persistentError ? (
              <Alert
                type="error"
                showIcon
                message="Workers AI 连接测试失败"
                description={persistentError}
              />
            ) : null}
            {probe ? (
              <Alert
                type={probe.sentinel_matched ? "success" : "warning"}
                showIcon
                message={probe.message}
                description={
                  <Typography.Text>
                    模型 {probe.model}；Token 状态 {probe.token_status}
                    ；本次总用量 {probe.usage.total_tokens ?? "未返回"} tokens。
                  </Typography.Text>
                }
              />
            ) : null}
          </Flex>
        )}
      </Card>

      <Card
        title={
          isCloudflareDeploy ? "在线示例与浏览器本地数据" : "本地数据与隐私清理"
        }
        className="section-card"
      >
        <Alert
          type="warning"
          showIcon
          message={
            isCloudflareDeploy ? "浏览器本地数据可随时清理" : "删除后无法恢复"
          }
          description={
            isCloudflareDeploy
              ? "Worker 合成案例是只读公开数据；自主上传后确认的标准化数据只保存在本浏览器，可在下方单独清理。"
              : "清理会删除分析库中的数据行、关联模拟方案、内存报告和可识别的导入任务文件。请先导出确实需要保留的结果。"
          }
        />
        {datasetsLoading ? (
          <Spin tip="正在读取本地数据清单" />
        ) : (
          <List
            locale={{ emptyText: "本机目前没有已登记的数据集" }}
            dataSource={datasets}
            renderItem={(dataset) => (
              <List.Item
                actions={
                  isCloudflareDeploy &&
                  dataset.source_kind !== "browser_local_import"
                    ? []
                    : [
                        <Button
                          danger
                          key="delete"
                          loading={deleting === dataset.dataset_id}
                          onClick={() => setPendingDelete(dataset)}
                        >
                          清理此数据集
                        </Button>,
                      ]
                }
              >
                <List.Item.Meta
                  title={`${DATA_TYPE_LABELS[dataset.data_type]} · ${dataset.row_count.toLocaleString("zh-CN")} 行`}
                  description={`${
                    dataset.source_kind === "synthetic_case"
                      ? "合成案例"
                      : dataset.source_kind === "browser_local_import"
                        ? "浏览器本地导入"
                        : "用户导入"
                  } · ${new Date(dataset.created_at).toLocaleString("zh-CN")} · 标识 ${dataset.dataset_id.slice(0, 8)}…`}
                />
              </List.Item>
            )}
          />
        )}
      </Card>

      <Modal
        title="确认不可逆清理"
        open={pendingDelete !== null}
        okText="确认清理"
        okButtonProps={{ danger: true, loading: deleting !== null }}
        cancelText="取消"
        onOk={() => void deleteDataset()}
        onCancel={() => setPendingDelete(null)}
      >
        <Typography.Paragraph>
          将删除
          {pendingDelete
            ? ` ${DATA_TYPE_LABELS[pendingDelete.data_type]} `
            : ""}
          及与其关联的本地分析缓存。当前分析页面若正在使用该数据集，需要重新选择数据。
        </Typography.Paragraph>
      </Modal>
    </>
  );
}
