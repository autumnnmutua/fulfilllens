import { zhCNMessages } from "./zh-CN";

export const defaultLocale = "zh-CN" as const;

export const messages = {
  [defaultLocale]: zhCNMessages,
} as const;

export type SupportedLocale = keyof typeof messages;
