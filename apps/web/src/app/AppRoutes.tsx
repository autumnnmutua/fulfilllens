import { lazy, Suspense, type ReactNode } from "react";

import { LoadingState } from "../components/PageStates";
import { AppShell } from "../layout/AppShell";
import { HomePage } from "../pages/HomePage";
import { ImportPage } from "../pages/ImportPage";
import { NotFoundPage } from "../pages/NotFoundPage";
import { SettingsPage } from "../pages/SettingsPage";
import { useRouting } from "./routing-context";

const AnalyticsPage = lazy(async () => {
  const module = await import("../pages/AnalyticsPage");
  return {
    default: module.AnalyticsPage,
  };
});

const DiagnosticsPage = lazy(async () => {
  const module = await import("../pages/DiagnosticsPage");
  return {
    default: module.DiagnosticsPage,
  };
});

const ScenariosPage = lazy(async () => {
  const module = await import("../pages/ScenariosPage");
  return {
    default: module.ScenariosPage,
  };
});

const CasesPage = lazy(async () => {
  const module = await import("../pages/CasesPage");
  return {
    default: module.CasesPage,
  };
});

const ReportsPage = lazy(async () => {
  const module = await import("../pages/ReportsPage");
  return {
    default: module.ReportsPage,
  };
});

function resolvePage(pathname: string): ReactNode {
  if (pathname === "/") {
    return <HomePage />;
  }
  if (pathname === "/analytics") {
    return <AnalyticsPage />;
  }
  if (pathname === "/diagnostics") {
    return <DiagnosticsPage />;
  }
  if (pathname === "/scenarios") {
    return <ScenariosPage />;
  }
  if (pathname === "/cases") {
    return <CasesPage />;
  }
  if (pathname === "/reports") {
    return <ReportsPage />;
  }
  if (pathname === "/import") {
    return <ImportPage />;
  }
  if (pathname === "/settings") {
    return <SettingsPage />;
  }

  return <NotFoundPage />;
}

export function AppRoutes() {
  const { pathname } = useRouting();

  return (
    <AppShell>
      <Suspense fallback={<LoadingState label="正在加载页面" />}>
        {resolvePage(pathname)}
      </Suspense>
    </AppShell>
  );
}
