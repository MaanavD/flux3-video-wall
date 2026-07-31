import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("renders the FLUX 3 video wall shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>FLUX 3 — BFL × Nous Research<\/title>/i);
  assert.match(html, /bfl-logotype-white\.svg/);
  assert.match(html, /Black Forest Labs/i);
  assert.match(html, /NOUS RESEARCH/);
  assert.match(html, /01 YOUR NAME/);
  assert.match(html, /ROLL FILM/);
  assert.match(html, /Type a film/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});
