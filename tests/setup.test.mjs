import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { get } from "node:http";
import test from "node:test";
import { setup } from "../local/setup.mjs";

test("first-launch key setup preserves settings, hides no empty success, and supports replacement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wall-setup-"));
  const file = join(dir, ".env.local");
  const original = process.env.BFL_API_KEY;
  delete process.env.BFL_API_KEY;
  try {
    await assert.rejects(setup({ file, ask: async () => " " }), /No API key saved/);
    await assert.rejects(readFile(file), { code: "ENOENT" });
    await writeFile(file, "BFL_RESOLUTION=fhd\nBFL_API_KEY=\n");
    await setup({ file, ask: async () => "test-key&with%shell!characters=" });
    assert.equal(parseEnv(await readFile(file, "utf8")).BFL_API_KEY, "test-key&with%shell!characters=");
    assert.equal(parseEnv(await readFile(file, "utf8")).BFL_RESOLUTION, "fhd");
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
    await setup({ file, ask: async () => { assert.fail("Existing key should not prompt"); } });
    await setup({ file, replace: true, ask: async () => "replacement-test-key" });
    assert.equal(parseEnv(await readFile(file, "utf8")).BFL_API_KEY, "replacement-test-key");
    const saved = await readFile(file, "utf8");
    await assert.rejects(setup({ file, replace: true, ask: async () => "bad\nINJECTED=yes" }), /without quotes or spaces/);
    assert.equal(await readFile(file, "utf8"), saved);
  } finally {
    if (original === undefined) delete process.env.BFL_API_KEY;
    else process.env.BFL_API_KEY = original;
    await rm(dir, { recursive: true, force: true });
  }
});

test("local API accepts wall origins, rejects external sites and rebinding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wall-api-"));
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  await cp(new URL("../local", import.meta.url), join(dir, "local"), { recursive: true });
  const child = spawn(process.execPath, [join(dir, "local/server.mjs")], {
    env: { ...process.env, BFL_API_KEY: "", LOCAL_API_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => { log += chunk; });
  child.stderr.on("data", (chunk) => { log += chunk; });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, log);
    const good = await fetch(`${base}/api/state`, { headers: { Origin: "http://127.0.0.1:3000" } });
    assert.equal(good.status, 200);
    assert.equal(good.headers.get("access-control-allow-origin"), "http://127.0.0.1:3000");
    for (const origin of ["https://evil.example", "null", "http://localhost.evil.example:3000"]) {
      const bad = await fetch(`${base}/api/submissions`, { method: "POST", headers: { Origin: origin }, body: "{}" });
      assert.equal(bad.status, 403);
      assert.equal(bad.headers.get("access-control-allow-origin"), null);
    }
    const rebound = await new Promise((resolve, reject) => {
      get(`${base}/api/state`, { headers: { Host: `evil.example:${port}` } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on("error", reject);
    });
    assert.equal(rebound, 403);
    assert.equal((await fetch(`${base}/api/submissions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 422);
  } finally {
    child.kill();
    await once(child, "exit");
    await rm(dir, { recursive: true, force: true });
  }
});
