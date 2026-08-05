import assert from "node:assert/strict";
import test from "node:test";

import {
  generationTimeoutMs,
  shouldExpireGeneration,
} from "../local/queue-policy.mjs";

const minute = 60_000;

test("sets a generous deadline from the longest completed generation", () => {
  const timeout = generationTimeoutMs([4 * minute, 7 * minute]);

  assert.equal(timeout, 21 * minute);
  assert.equal(
    shouldExpireGeneration({
      createdAt: new Date(0).toISOString(),
      timeoutMs: timeout,
      now: 21 * minute + 1,
    }),
    true,
  );
  assert.equal(
    shouldExpireGeneration({
      createdAt: new Date(0).toISOString(),
      timeoutMs: timeout,
      now: 21 * minute,
    }),
    false,
  );
});
