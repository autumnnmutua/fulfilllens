import { createContext, useContext } from "react";

export interface RoutingContextValue {
  pathname: string;
  navigate: (path: string) => void;
}

export const RoutingContext = createContext<RoutingContextValue | null>(null);

export function useRouting(): RoutingContextValue {
  const context = useContext(RoutingContext);
  if (context === null) {
    throw new Error("useRouting 必须在 RouterProvider 内使用");
  }
  return context;
}
