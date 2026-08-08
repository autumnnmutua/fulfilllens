import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";

import { RoutingContext, type RoutingContextValue } from "./routing-context";

export function RouterProvider({ children }: PropsWithChildren) {
  const [pathname, setPathname] = useState(window.location.pathname);

  useEffect(() => {
    const handlePopState = () => {
      setPathname(window.location.pathname);
    };
    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  const navigate = useCallback((path: string) => {
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new Error("只允许应用内绝对路径");
    }

    if (window.location.pathname !== path) {
      window.history.pushState({}, "", path);
      setPathname(path);
      window.scrollTo({
        top: 0,
        behavior: "auto",
      });
    }
  }, []);

  const value = useMemo<RoutingContextValue>(
    () => ({
      pathname,
      navigate,
    }),
    [navigate, pathname],
  );

  return (
    <RoutingContext.Provider value={value}>{children}</RoutingContext.Provider>
  );
}
