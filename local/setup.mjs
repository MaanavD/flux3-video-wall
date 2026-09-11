import { readFile, writeFile, chmod } from "node:fs/promises";
import { parseEnv } from "node:util";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

// Keep setup shared by all launchers, including Windows (no shell interpolation).
export async function setup({ file = ".env.local", ask = askKey, replace = false } = {}) {
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const saved = parseEnv(text).BFL_API_KEY?.trim();
  if (!replace && (saved || process.env.BFL_API_KEY?.trim())) return;
  const key = (await ask()).trim();
  if (!key) throw new Error("No API key saved. Launch again when you have your BFL API key.");
  if (!/^[\x21-\x7e]+$/.test(key) || /["'`#\\]/.test(key)) {
    throw new Error("Paste only the API key, without quotes or spaces.");
  }
  // Remove every old assignment so Node cannot pick a stale duplicate.
  const rest = text.replace(/^\s*(?:export\s+)?BFL_API_KEY\s*=.*$/gm, "").trim();
  await writeFile(file, `${rest}${rest ? "\n" : ""}BFL_API_KEY=${key}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  console.log("API key saved on this computer. New films use your BFL API credits.");
}

async function askKey() {
  if (!process.stdin.isTTY) throw new Error("Run the launcher in a terminal to enter your API key.");
  const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const reader = createInterface({ input: process.stdin, output, terminal: true });
  console.log("First-time setup: paste your BFL API key, then press Enter.");
  console.log("The key will stay hidden while you paste. No film is generated during setup.");
  try {
    return await reader.question("", { signal: AbortSignal.timeout(300_000) });
  } finally {
    reader.close();
    console.log();
  }
}
