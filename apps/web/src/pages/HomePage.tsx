import {
  ApiOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import { Alert, Button, Card, Descriptions, Flex, Tag, Typography } from "antd";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { ApiClientError, systemApi } from "../api/client";
import { useRouting } from "../app/routing-context";
import { useNotifications } from "../components/notification-context";
import { LoadingState } from "../components/PageStates";
import { isCloudflareDeploy } from "../config/runtime";
import type { HealthResponse, VersionResponse } from "../types/api";

type SystemStatus =
  | {
      kind: "loading";
    }
  | {
      kind: "ready";
      health: HealthResponse;
      version: VersionResponse;
    }
  | {
      kind: "error";
      message: string;
    };

interface PrincipleCardProps {
  icon: ReactNode;
  title: string;
  description: string;
}

function PrincipleCard({ icon, title, description }: PrincipleCardProps) {
  return (
    <Card className="principle-card">
      <Flex vertical gap="middle">
        <span className="principle-icon" aria-hidden="true">
          {icon}
        </span>
        <Typography.Title level={3}>{title}</Typography.Title>
        <Typography.Paragraph>{description}</Typography.Paragraph>
      </Flex>
    </Card>
  );
}

export function HomePage() {
  const notifications = useNotifications();
  const { navigate } = useRouting();
  const [status, setStatus] = useState<SystemStatus>({
    kind: "loading",
  });
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => {
    setRefreshKey((current) => current + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function loadSystemStatus() {
      setStatus({
        kind: "loading",
      });

      try {
        const [health, version] = await Promise.all([
          systemApi.health(controller.signal),
          systemApi.version(controller.signal),
        ]);
        setStatus({
          kind: "ready",
          health,
          version,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        const message =
          error instanceof ApiClientError
            ? error.message
            : "读取本地服务状态时发生未知错误。";
        setStatus({
          kind: "error",
          message,
        });
        notifications.showError("本地 API 未就绪", message);
      }
    }

    void loadSystemStatus();
    return () => {
      controller.abort();
    };
  }, [notifications, refreshKey]);

  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <Flex gap="small" wrap>
            <Tag color="blue">本地分析</Tag>
            <Tag className="tag-cyan-accessible">合成示例</Tag>
            <Tag color="purple">可解释规则</Tag>
          </Flex>
          <Typography.Title>
            在本机看清订单从创建到交付的每一步
          </Typography.Title>
          <Typography.Paragraph>
            FulfillLens
            面向物流管理教学和中小电商履约分析。用户数据默认留在本机，指标、异常和模拟结果必须能追溯到公式、字段或规则。
          </Typography.Paragraph>
          <Flex gap="middle" wrap>
            <Button
              type="primary"
              size="large"
              onClick={() => navigate("/cases")}
            >
              一键体验教学案例
            </Button>
            <Button size="large" onClick={() => navigate("/import")}>
              导入自己的数据
            </Button>
            <Button size="large" onClick={() => navigate("/reports")}>
              生成分析报告
            </Button>
          </Flex>
        </div>
        <Card className="hero-notice" bordered={false}>
          <SafetyCertificateOutlined aria-hidden="true" />
          <Typography.Title level={2}>使用边界</Typography.Title>
          <Typography.Paragraph>
            结果仅用于分析与模拟。What-if
            结果将始终标记为情景估算，不代表真实预测、因果结论或服务保证。
          </Typography.Paragraph>
        </Card>
      </section>

      <Alert
        className="prominent-alert"
        type="warning"
        showIcon
        title="无需真实数据即可完成首次体验"
        description="三套固定种子的合成教学案例已开放，可连续体验导入、指标、规则诊断、订单/事件层 What-if 模拟和安全报告导出；所有示例都不含真实订单或个人信息。"
      />

      <section aria-labelledby="principles-title">
        <Typography.Title id="principles-title" level={2}>
          产品原则
        </Typography.Title>
        <div className="principle-grid">
          <PrincipleCard
            icon={<DatabaseOutlined />}
            title={isCloudflareDeploy ? "在线合成案例" : "本地分析"}
            description={
              isCloudflareDeploy
                ? "在线版默认加载公开合成数据，可直接完成分析、诊断、模拟和报告；不会接收或保存真实业务数据。"
                : "浏览器连接本机 API；当前版本没有云端上传、账号或外部数据库。"
            }
          />
          <PrincipleCard
            icon={<ExperimentOutlined />}
            title="合成示例"
            description="公开案例只能由可复现生成器产生，不提交真实订单和个人信息。"
          />
          <PrincipleCard
            icon={<ApiOutlined />}
            title="可验证契约"
            description="字段、状态和接口使用版本化契约，错误不会被静默处理成成功。"
          />
        </div>
      </section>

      <section aria-labelledby="system-status-title">
        <Typography.Title id="system-status-title" level={2}>
          {isCloudflareDeploy ? "在线服务状态" : "本地服务状态"}
        </Typography.Title>
        <Card className="section-card">
          {status.kind === "loading" ? (
            <LoadingState label="正在检查本地 API" />
          ) : null}

          {status.kind === "ready" ? (
            <Descriptions
              bordered
              column={{
                xs: 1,
                sm: 2,
              }}
            >
              <Descriptions.Item label="API 状态">
                <Tag className="tag-success-accessible">服务正常</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="应用版本">
                {status.version.app_version}
              </Descriptions.Item>
              <Descriptions.Item label="接口版本">
                {status.version.api_version}
              </Descriptions.Item>
              <Descriptions.Item label="运行环境">
                {status.version.environment === "cloudflare-online-demo"
                  ? "Cloudflare 在线合成演示"
                  : status.version.environment}
              </Descriptions.Item>
              <Descriptions.Item label="指标定义">
                {status.version.contract_versions.metrics}
              </Descriptions.Item>
              <Descriptions.Item label="数据契约">
                {status.version.contract_versions.data}
              </Descriptions.Item>
              <Descriptions.Item label="报告契约">
                {status.version.contract_versions.reports}
              </Descriptions.Item>
            </Descriptions>
          ) : null}

          {status.kind === "error" ? (
            <Alert
              type="error"
              showIcon
              message="API 服务不可用"
              description={
                <Flex vertical align="flex-start" gap="middle">
                  <Typography.Text>{status.message}</Typography.Text>
                  <Button onClick={refresh}>重新检查</Button>
                </Flex>
              }
            />
          ) : null}
        </Card>
      </section>
    </>
  );
}
