import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const apiProxyTarget =
  process.env.FL_API_PROXY_TARGET ?? "http://127.0.0.1:8000";

export default defineConfig(({ mode }) => ({
  publicDir: "../../data/samples",
  define: {
    "import.meta.env.VITE_DEPLOY_TARGET": JSON.stringify(
      mode === "cloudflare" ? "cloudflare" : "local",
    ),
  },
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: false,
      },
      "/health": {
        target: apiProxyTarget,
        changeOrigin: false,
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "echarts",
              test: /node_modules[\\/]echarts/,
              priority: 30,
            },
            {
              name: "antd",
              test: /node_modules[\\/](?:antd|@ant-design|rc-)/,
              priority: 20,
            },
            {
              name: "react",
              test: /node_modules[\\/](?:react|react-dom|scheduler)/,
              priority: 10,
            },
            {
              name: "vendor",
              test: /node_modules/,
              priority: 1,
            },
          ],
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: true,
  },
}));
