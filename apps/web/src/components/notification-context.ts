import { createContext, useContext } from "react";

export interface NotificationActions {
  showError: (title: string, description: string) => void;
  showSuccess: (title: string, description: string) => void;
}

export const NotificationContext = createContext<NotificationActions | null>(
  null,
);

export function useNotifications(): NotificationActions {
  const context = useContext(NotificationContext);

  if (context === null) {
    throw new Error("useNotifications 必须在 NotificationProvider 内使用");
  }

  return context;
}
