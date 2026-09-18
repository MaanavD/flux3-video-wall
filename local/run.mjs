import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setup } from "./setup.mjs";

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const production = process.argv.includes("--production");
const windows = process.platform === "win32";
const children = [];
let stopping = false;

function availablePort(port) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => {
      const chosen = probe.address().port;
      probe.close(() => resolve(chosen));
    });
  });
}

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue;
    if (windows) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try { process.kill(-child.pid, "SIGTERM"); } catch (error) {
        if (error.code !== "ESRCH") console.error(error.message);
      }
    }
  }
  const timer = setTimeout(() => {
    if (!windows) for (const child of children) {
      if (child.exitCode === null && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
          if (error.code !== "ESRCH") console.error(error.message);
        }
      }
    }
    process.exit(code);
  }, 4000);
  timer.unref();
  process.exitCode = code;
}

function start(args, env = process.env) {
  const child = spawn(process.execPath, args, {
    stdio: "inherit", detached: !windows, env,
  });
  children.push(child);
  child.once("error", (error) => { console.error(error.message); void stop(1); });
  child.once("exit", (code) => { if (!stopping) void stop(code || 1); });
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void stop());

try {
  await setup({ replace: process.argv.includes("--change-key") });
  try { process.loadEnvFile(".env.local"); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  // The browser currently uses this fixed API port. Do not silently change it.
  await availablePort(8788).catch(() => {
    throw new Error("Port 8788 is in use. Close the other video wall window and launch again.");
  });
  const port = await availablePort(Number(process.env.PORT || 3000)).catch(() => availablePort(0));
  const url = `http://127.0.0.1:${port}`;
  start(["local/server.mjs"], { ...process.env, LOCAL_API_PORT: "8788" });
  start(["node_modules/vinext/dist/cli.js", production ? "start" : "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    ...process.env, WRANGLER_LOG_PATH: ".wrangler/wrangler.log",
  });
  let ready = false;
  const deadline = Date.now() + 60_000;
  while (!stopping && Date.now() < deadline) {
    try {
      const responses = await Promise.all([url, "http://127.0.0.1:8788/api/health"].map(
        (address) => fetch(address, { signal: AbortSignal.timeout(1500) }),
      ));
      if (responses.every((response) => response.ok)) { ready = true; break; }
    } catch { /* Startup is still in progress; the deadline reports failure. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!stopping && !ready) throw new Error("The wall did not start within 60 seconds. See the error above and launch again.");
  if (!stopping) {
    console.log(`\nVideo wall ready: ${url}\nKeep this window open. Press Ctrl+C to stop.\n`);
    if (process.argv.includes("--open")) {
      const command = windows ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
      const browser = spawn(command, [url], { stdio: "ignore" });
      browser.on("error", () => console.log(`Open ${url} in your browser.`));
      browser.on("exit", (code) => { if (code) console.log(`Open ${url} in your browser.`); });
    }
  }
} catch (error) {
  console.error(`\n${error.message}`);
  await stop(1);
}
