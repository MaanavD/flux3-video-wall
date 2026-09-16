import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  assert.match(html, /<title>FLUX 3 Video Wall \/ Black Forest Labs<\/title>/i);
  assert.match(html, /bfl-logotype-white\.svg/);
  assert.match(html, /Black Forest Labs/i);
  assert.match(html, /01 YOUR NAME/);
  assert.match(html, /ROLL FILM/);
  assert.match(html, /ALL FILMS/);
  assert.match(html, /Type a film/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("defers stored display preferences until after hydration", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /useState<DisplayMode>\("full"\)/);
  assert.match(page, /useState<PlaybackMode>\("rotation"\)/);
  assert.match(page, /window\.setTimeout\(\(\) => \{/);
  assert.doesNotMatch(
    page,
    /useState<DisplayMode>\(\(\) => \{[\s\S]*?window\.localStorage/,
  );
  assert.doesNotMatch(
    page,
    /useState<PlaybackMode>\(\(\) => \{[\s\S]*?window\.localStorage/,
  );
});

test("the console keeps the name for the next film", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const submit = page.slice(page.indexOf("const submit = useCallback"));
  const submitBody = submit.slice(0, submit.indexOf("} catch"));

  // A second film starts at the film field with the name still stamped on.
  assert.match(submitBody, /setStage\("prompt"\)/);
  assert.doesNotMatch(submitBody, /setName\(""\)/);

  // A long silence still clears it, so nobody submits under someone
  // else's name.
  const reset = page.slice(page.indexOf("const reset = useCallback"));
  assert.match(reset.slice(0, reset.indexOf("}, [focusStage])")), /setName\(""\)/);
});
