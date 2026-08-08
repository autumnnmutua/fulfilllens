import {
  AlertOutlined,
  BarChartOutlined,
  BookOutlined,
  ExperimentOutlined,
  FileTextOutlined,
  HomeOutlined,
  MenuOutlined,
  SettingOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Drawer,
  Grid,
  Layout,
  Menu,
  Space,
  Tag,
  Typography,
  type MenuProps,
} from "antd";
import { useState, type PropsWithChildren } from "react";

import { useRouting } from "../app/routing-context";
import { isCloudflareDeploy } from "../config/runtime";
import { zhCNMessages } from "../i18n/zh-CN";

const { Header, Content, Sider } = Layout;

const navigationItems: MenuProps["items"] = [
  {
    key: "/",
    icon: <HomeOutlined />,
    label: zhCNMessages.nav.home,
  },
  {
    key: "/import",
    icon: <UploadOutlined />,
    label: zhCNMessages.nav.importData,
  },
  {
    key: "/analytics",
    icon: <BarChartOutlined />,
    label: zhCNMessages.nav.analytics,
  },
  {
    key: "/diagnostics",
    icon: <AlertOutlined />,
    label: zhCNMessages.nav.diagnostics,
  },
  {
    key: "/scenarios",
    icon: <ExperimentOutlined />,
    label: zhCNMessages.nav.scenarios,
  },
  {
    key: "/cases",
    icon: <BookOutlined />,
    label: zhCNMessages.nav.cases,
  },
  {
    key: "/reports",
    icon: <FileTextOutlined />,
    label: zhCNMessages.nav.reports,
  },
  {
    key: "/settings",
    icon: <SettingOutlined />,
    label: zhCNMessages.nav.settings,
  },
];

function Brand() {
  return (
    <div className="brand" aria-label="FulfillLens CN">
      <div className="brand-mark" aria-hidden="true">
        FL
      </div>
      <div>
        <Typography.Text className="brand-name">FulfillLens CN</Typography.Text>
        <Typography.Text className="brand-subtitle">
          履约分析工作台
        </Typography.Text>
      </div>
    </div>
  );
}

export function AppShell({ children }: PropsWithChildren) {
  const screens = Grid.useBreakpoint();
  const isDesktop = Boolean(screens.lg);
  const { navigate, pathname } = useRouting();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const menu = (
    <Menu
      className="app-menu"
      mode="inline"
      items={navigationItems}
      selectedKeys={[pathname]}
      onClick={({ key }) => {
        navigate(key);
        setDrawerOpen(false);
      }}
    />
  );

  return (
    <Layout className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      {isDesktop ? (
        <Sider className="app-sider" width={248} theme="light">
          <Brand />
          <nav aria-label="主导航">{menu}</nav>
          <div className="sider-footer">
            <Tag color="blue">
              {isCloudflareDeploy ? "Cloudflare 在线预览" : "本地优先"}
            </Tag>
            <Typography.Paragraph>
              {isCloudflareDeploy
                ? "在线预览验证界面与 Workers AI；业务数据分析请使用本地或 Docker 完整版。"
                : "数据导入、履约指标、透明诊断、情景模拟、教学案例和安全报告已开放。"}
            </Typography.Paragraph>
          </div>
        </Sider>
      ) : null}

      <Layout className="app-main">
        <Header className="app-header">
          {!isDesktop ? (
            <Button
              type="text"
              icon={<MenuOutlined />}
              aria-label="打开主导航"
              onClick={() => {
                setDrawerOpen(true);
              }}
            />
          ) : null}
          {!isDesktop ? <Brand /> : <span />}
          <Space>
            <Tag color="blue">v1.0.0-rc.1</Tag>
          </Space>
        </Header>

        <Content className="app-content">
          <div id="main-content" className="content-inner" tabIndex={-1}>
            {isCloudflareDeploy ? (
              <Alert
                className="prominent-alert"
                type="info"
                showIcon
                message="Cloudflare 在线预览"
                description="当前站点已使用原生 Workers AI 绑定；只允许用户确认后的固定合成连接探针。导入、指标、诊断、模拟和报告仍由本地或 Docker 完整版处理，业务数据不会上传到此预览。"
              />
            ) : null}
            {children}
          </div>
        </Content>
      </Layout>

      <Drawer
        title={<Brand />}
        placement="left"
        width="min(84vw, 320px)"
        open={!isDesktop && drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
        }}
        styles={{
          body: {
            padding: 12,
          },
        }}
      >
        <nav aria-label="移动端主导航">{menu}</nav>
      </Drawer>
    </Layout>
  );
}
