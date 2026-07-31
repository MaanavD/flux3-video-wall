import { spawn } from "node:child_process";

const children = [
  spawn(
    process.execPath,
    ["--env-file-if-exists=.env.local", "local/server.mjs"],
    { stdio: "inherit" },
  ),
  spawn("npm", ["run", "dev"], { stdio: "inherit" }),
];

let stopping = false;

function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stop(signal);
    setTimeout(() => process.exit(0), 250);
  });
}

for (const child of children) {
  child.on("exit", (code) => {
    if (!stopping && code && code !== 0) {
      stop();
      process.exitCode = code;
    }
  });
}
