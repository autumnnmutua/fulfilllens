/* Build-output acceptance runner: starts the local Worker, runs Chrome, cleans up. */
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const port = process.env.FL_E2E_PORT || "8787";
const baseUrl = `http://127.0.0.1:${port}`;
const isWindows = process.platform === "win32";
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
  } else {
    server.kill("SIGTERM");
  }
  await delay(250);
}

(async () => {
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
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

    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, "browser_import_e2e.cjs")],
      {
        cwd: repoRoot,
        env: { ...process.env, FL_WEB_URL: baseUrl },
        stdio: "inherit",
        windowsHide: true,
      },
    );
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
