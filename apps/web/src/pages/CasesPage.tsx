import {
  BookOutlined,
  DatabaseOutlined,
  DownloadOutlined,
  ExperimentOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Flex,
  Modal,
  Row,
  Space,
  Tag,
  Typography,
} from "antd";
import { useEffect, useState } from "react";

import { ApiClientError } from "../api/client";
import { caseApi } from "../api/cases";
import { PageHeader } from "../components/PageHeader";
import { LoadingState } from "../components/PageStates";
import { useNotifications } from "../components/notification-context";
import type {
  CaseCatalogResponse,
  CaseLoadResponse,
  CaseMetadata,
} from "../types/cases";

function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError || error instanceof Error) {
    return error.message;
  }
  return "教学案例操作未完成，请确认本地 API 已启动。";
}

function fileLabel(name: string): string {
  if (name === "case.xlsx") return "完整 XLSX";
  if (name === "orders.csv") return "订单 CSV";
  if (name === "warehouse_events.csv") return "仓库事件 CSV";
  if (name === "tracking_events.csv") return "物流轨迹 CSV";
  return "metadata.json";
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KiB`;
}

export function CasesPage() {
  const notifications = useNotifications();
  const [catalog, setCatalog] = useState<CaseCatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CaseMetadata | null>(null);
  const [loadingCase, setLoadingCase] = useState(false);
  const [loaded, setLoaded] = useState<CaseLoadResponse | null>(null);

  useEffect(() => {
    let active = true;
    void caseApi
      .list()
      .then((response) => {
        if (active) setCatalog(response);
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function confirmLoad() {
    if (selected === null) return;
    setLoadingCase(true);
    setError(null);
    try {
      const response = await caseApi.load(selected.case_id);
      window.localStorage.removeItem("fulfilllens.dashboard.filters");
      window.localStorage.setItem(
        "fulfilllens.dataset.orders",
        response.datasets.orders_dataset_id,
      );
      if (typeof response.datasets.warehouse_events_dataset_id === "string") {
        window.localStorage.setItem(
          "fulfilllens.dataset.warehouse_events",
          response.datasets.warehouse_events_dataset_id,
        );
      }
      if (typeof response.datasets.tracking_events_dataset_id === "string") {
        window.localStorage.setItem(
          "fulfilllens.dataset.tracking_events",
          response.datasets.tracking_events_dataset_id,
        );
      }
      window.localStorage.setItem(
        "fulfilllens.case.current",
        response.case.case_id,
      );
      setLoaded(response);
      setSelected(null);
      notifications.showSuccess("教学案例已载入", response.message);
    } catch (reason) {
      const message = errorMessage(reason);
      setError(message);
      notifications.showError("案例载入失败", message);
    } finally {
      setLoadingCase(false);
    }
  }

  return (
    <>
      <PageHeader
        title="教学案例"
        description="无需准备真实数据，用三套固定种子的合成案例完成导入、指标、诊断和方案模拟练习。"
      />

      <Alert
        className="prominent-alert"
        type="success"
        showIcon
        icon={<SafetyCertificateOutlined />}
        title="全部案例为完全合成数据"
        description={
          catalog?.privacy_statement ??
          "不包含真实姓名、手机号、身份证、详细地址、真实快递单号或公司内部数据。"
        }
      />

      {error !== null ? (
        <Alert
          className="section-card"
          type="error"
          showIcon
          title="教学案例操作未完成"
          description={error}
        />
      ) : null}

      {loaded !== null ? (
        <Alert
          className="section-card"
          type="info"
          showIcon
          title={`${loaded.case.display_name} 已成为当前分析上下文`}
          description={loaded.message}
          action={
            <Space wrap>
              <Button href="/analytics" type="primary">
                打开分析总览
              </Button>
              <Button href="/diagnostics">查看异常诊断</Button>
            </Space>
          }
        />
      ) : null}

      {loading ? <LoadingState label="正在读取合成教学案例" /> : null}

      {!loading && catalog !== null ? (
        <Row gutter={[18, 18]} className="case-grid">
          {catalog.cases.map((item) => (
            <Col xs={24} xl={8} key={item.case_id}>
              <Card
                className="section-card case-card"
                title={
                  <Space wrap>
                    <BookOutlined />
                    <span>{item.display_name}</span>
                  </Space>
                }
              >
                <Typography.Paragraph>
                  {item.business_background}
                </Typography.Paragraph>
                <Flex gap="small" wrap className="case-tags">
                  <Tag color="blue">{item.order_count} 单</Tag>
                  <Tag>种子 {item.seed}</Tag>
                  <Tag>{item.timezone}</Tag>
                </Flex>
                <Descriptions size="small" column={1} bordered>
                  <Descriptions.Item label="订单日期">
                    {item.date_range.start} 至 {item.date_range.end}
                  </Descriptions.Item>
                  <Descriptions.Item label="数据规模">
                    {item.row_counts.orders} 条订单、
                    {item.row_counts.warehouse_events} 条仓库事件、
                    {item.row_counts.tracking_events} 条物流轨迹
                  </Descriptions.Item>
                  <Descriptions.Item label="生成器">
                    {item.generator_version}
                  </Descriptions.Item>
                </Descriptions>

                <Typography.Title level={5}>注入的业务现象</Typography.Title>
                <ul className="case-list">
                  {item.injected_anomalies.map((value) => (
                    <li key={value}>{value}</li>
                  ))}
                </ul>

                <Typography.Title level={5}>预期规则发现</Typography.Title>
                {item.expected_findings.length > 0 ? (
                  <ul className="case-list">
                    {item.expected_findings.map((finding) => (
                      <li key={finding.rule_id}>
                        <Space align="start">
                          <Tag color={finding.required ? "orange" : "default"}>
                            {finding.rule_id}
                          </Tag>
                          <span>{finding.description}</span>
                        </Space>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Typography.Paragraph>
                    仅预期少量随机长尾，不要求固定异常规则。
                  </Typography.Paragraph>
                )}

                <Typography.Title level={5}>学习目标</Typography.Title>
                <ul className="case-list">
                  {item.learning_objectives.map((value) => (
                    <li key={value}>{value}</li>
                  ))}
                </ul>

                <Flex vertical gap="small" className="case-actions">
                  <Button
                    type="primary"
                    size="large"
                    icon={<DatabaseOutlined />}
                    onClick={() => setSelected(item)}
                  >
                    一键载入{item.display_name.replace("案例 ", "案例")}
                  </Button>
                  <Flex gap="small" wrap>
                    {item.files.map((file) => (
                      <Button
                        key={file.name}
                        size="small"
                        icon={<DownloadOutlined />}
                        href={caseApi.fileUrl(item.case_id, file.name)}
                      >
                        {fileLabel(file.name)} · {formatBytes(file.size_bytes)}
                      </Button>
                    ))}
                    <Button
                      size="small"
                      icon={<DownloadOutlined />}
                      href={caseApi.fileUrl(item.case_id, "metadata.json")}
                    >
                      metadata.json
                    </Button>
                  </Flex>
                </Flex>
              </Card>
            </Col>
          ))}
        </Row>
      ) : null}

      <Card className="section-card" title="建议学习路径">
        <Row gutter={[16, 16]}>
          {[
            ["1", "载入案例", "确认替换当前分析上下文，原数据不会被删除。"],
            ["2", "复算指标", "在总览检查 OTIF、覆盖率、P50 和 P90。"],
            ["3", "追溯诊断", "区分事实、规则判断、可能原因与建议核查。"],
            [
              "4",
              "运行模拟",
              "从订单节点变换观察方向性影响，不把情景估算当预测。",
            ],
          ].map(([step, title, description]) => (
            <Col xs={24} md={12} xl={6} key={step}>
              <Card size="small" className="case-learning-step">
                <Tag color="blue">步骤 {step}</Tag>
                <Typography.Title level={5}>{title}</Typography.Title>
                <Typography.Paragraph>{description}</Typography.Paragraph>
              </Card>
            </Col>
          ))}
        </Row>
      </Card>

      <Modal
        open={selected !== null}
        title="确认替换当前分析上下文"
        okText="确认载入案例"
        cancelText="取消"
        confirmLoading={loadingCase}
        onCancel={() => {
          if (!loadingCase) setSelected(null);
        }}
        onOk={() => void confirmLoad()}
      >
        <Flex vertical gap="middle">
          <Alert
            type="warning"
            showIcon
            title="浏览器当前使用的三个数据集标识将被替换"
            description="此前导入的数据仍保留在本机，不会被删除；取消后不会发生任何变化。"
          />
          <Typography.Paragraph>
            即将载入：
            <Typography.Text strong>{selected?.display_name}</Typography.Text>
          </Typography.Paragraph>
          <Typography.Paragraph>
            <ExperimentOutlined /> 载入后可直接打开分析、诊断和 What-if
            模拟页面。
          </Typography.Paragraph>
        </Flex>
      </Modal>
    </>
  );
}
