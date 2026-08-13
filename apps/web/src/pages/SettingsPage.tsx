import { Alert, Button, Card, List, Modal, Spin, Typography } from "antd";
import { useEffect, useState } from "react";

import { ApiClientError } from "../api/client";
import { datasetsApi } from "../api/datasets";
import { PageHeader } from "../components/PageHeader";
import { useNotifications } from "../components/notification-context";
import {
  clearBrowserAnalysisSession,
  readBrowserAnalysisSession,
} from "../analysis/browserAnalysisSession";
import { isCloudflareDeploy } from "../config/runtime";
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
      const session = readBrowserAnalysisSession();
      if (
        session &&
        Object.values(session.datasetIds).includes(result.dataset_id)
      ) {
        clearBrowserAnalysisSession();
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

  return (
    <>
      <PageHeader
        title="设置"
        description={
          isCloudflareDeploy
            ? "管理当前浏览器中的自主导入数据与分析上下文。"
            : "管理本地数据集、分析上下文与隐私清理。"
        }
      />

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
        {persistentError ? (
          <Alert
            type="error"
            showIcon
            message="本地数据操作失败"
            description={persistentError}
          />
        ) : null}
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
