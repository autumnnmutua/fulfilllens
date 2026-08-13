import { App as AntdApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";

import { ErrorBoundary } from "../components/ErrorBoundary";
import { NotificationProvider } from "../components/NotificationProvider";
import { AppRoutes } from "./AppRoutes";
import { RouterProvider } from "./RouterProvider";

export function App() {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          // Keep primary button text readable even while Ant Design applies its
          // translucent loading overlay (WCAG AA contrast remains above 4.5:1).
          colorPrimary: "#003049",
          colorInfo: "#146c94",
          colorText: "#102a43",
          colorTextSecondary: "#334e68",
          colorBgLayout: "#f3f7fa",
          borderRadius: 10,
          fontFamily:
            '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif',
        },
        components: {
          Layout: {
            headerBg: "#ffffff",
            siderBg: "#ffffff",
          },
        },
      }}
    >
      <AntdApp>
        <NotificationProvider>
          <ErrorBoundary>
            <RouterProvider>
              <AppRoutes />
            </RouterProvider>
          </ErrorBoundary>
        </NotificationProvider>
      </AntdApp>
    </ConfigProvider>
  );
}
