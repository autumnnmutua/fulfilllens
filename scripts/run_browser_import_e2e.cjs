/* Build-output acceptance runner: starts the local Worker, runs Chrome, cleans up. */
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const port = process.env.FL_E2E_PORT || "8787";
const baseUrl = `http://127.0.0.1:${port}`;
const isWindows = process.platform === "win32";
const build = spawnSync(
  isWindows ? "cmd.exe" : "npm",
  isWindows
    ? ["/d", "/s", "/c", "npm.cmd run build:cloudflare"]
    : ["run", "build:cloudflare"],
  {
    cwd: repoRoot,
    stdio: "inherit",
    windowsHide: true,
  },
);
if (build.error) throw build.error;
if (build.status !== 0) {
  throw new Error(`Cloudflare web build failed with exit code ${build.status}`);
}
const command = isWindows ? "cmd.exe" : "npx";
const commandArguments = isWindows
  ? [
      "/d",
      "/s",
      "/c",
      `npx.cmd --yes wrangler@4.120.0 dev --local --port ${port}`,
    ]
  : ["--yes", "wrangler@4.120.0", "dev", "--local", "--port", port];
const server = spawn(command, commandArguments, {
  cwd: repoRoot,
  detached: !isWindows,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let logs = "";
server.stdout.on("data", (chunk) => {
  logs += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  logs += chunk.toString();
});

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function stopServer() {
  if (server.exitCode !== null) return;
  if (isWindows) {
    spawnSync("taskkill.exe", ["/PID", String(server.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } else if (server.pid) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      // The process group may already have completed.
    }
  }
  await delay(250);
  if (!isWindows && server.exitCode === null && server.pid) {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {
      // The process group may have exited after SIGTERM.
    }
  }
  server.stdout.destroy();
  server.stderr.destroy();
  server.unref();
}

(async () => {
  try {
    let ready = false;
    // A cold Windows/npm cache can spend more than 20 seconds resolving
    // Wrangler and starting workerd after a reboot. Keep this bounded but
    // large enough that an environment cold start is not mistaken for an app
    // failure.
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (server.exitCode !== null) break;
      try {
        const response = await fetch(`${baseUrl}/health`);
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        // The server is expected to refuse connections while starting.
      }
      await delay(500);
    }
    if (!ready) {
      throw new Error(
        `Local Worker did not become ready.\n${logs.slice(-5000)}`,
      );
    }

    const browserScript = process.env.FL_BROWSER_SCRIPT
      ? path.resolve(repoRoot, process.env.FL_BROWSER_SCRIPT)
      : path.join(__dirname, "browser_import_e2e.cjs");
    const result = spawnSync(process.execPath, [browserScript], {
      cwd: repoRoot,
      env: { ...process.env, FL_WEB_URL: baseUrl },
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status || 1;
  } finally {
    await stopServer();
  }
})().catch(async (error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
  await stopServer();
});
