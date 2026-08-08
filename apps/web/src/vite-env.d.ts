/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_DEPLOY_TARGET?: "cloudflare" | "local";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
