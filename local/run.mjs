import { spawn } from "node:child_process";

// Each child is `detached` so it becomes its own process group leader on
// POSIX. That lets stop() signal the whole group (negative pid), not just
// the immediate child — otherwise grandchildren (vite/workerd) can survive
// and keep holding the ports, causing EADDRINUSE on the next run.
const children = [
  spawn(
    process.execPath,
    ["--env-file-if-exists=.env.local", "local/server.mjs"],
    { stdio: "inherit", detached: true },
  ),
  spawn(
    process.execPath,
    ["node_modules/vinext/dist/cli.js", "dev"],
    {
      stdio: "inherit",
      detached: true,
      env: { ...process.env, WRANGLER_LOG_PATH: ".wrangler/wrangler.log" },
    },
  ),
];

const exited = children.map(() => false);
let stopping = false;

function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

function waitForExit(timeoutMs) {
  const pending = children.map(
    (child, i) =>
      new Promise((resolve) => {
        if (exited[i]) return resolve();
        child.once("exit", () => resolve());
      }),
  );
  return Promise.race([
    Promise.all(pending),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;

  for (const child of children) signalGroup(child, signal);
  await waitForExit(4000);

  children.forEach((child, i) => {
    if (!exited[i]) signalGroup(child, "SIGKILL");
  });
  await waitForExit(1000);

  process.exit(process.exitCode ?? 0);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stop(signal));
}

children.forEach((child, i) => {
  child.on("exit", (code) => {
    exited[i] = true;
    if (!stopping && code && code !== 0) {
      process.exitCode = code;
      stop();
    }
  });
});
