import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { selectVideo } from "../local/playlist.mjs";

// The same shape local/server.mjs creates, trimmed to the columns the
// playlist reads.
function wallWith(films) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE videos (
      id TEXT PRIMARY KEY,
      creator_name TEXT NOT NULL DEFAULT '',
      play_count INTEGER NOT NULL DEFAULT 0,
      last_cycle INTEGER NOT NULL DEFAULT -1,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    )
  `);
  db.exec(`CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.prepare("INSERT INTO app_meta VALUES ('playlist_cycle', '0')").run();

  const insert = db.prepare(
    `INSERT INTO videos (id, is_active, created_at) VALUES (?, ?, ?)`,
  );
  films.forEach((id, index) => {
    // Oldest first, one minute apart, so "newest" is unambiguous.
    insert.run(id, 1, new Date(index * 60_000).toISOString());
  });
  return db;
}

function playCounts(db) {
  return Object.fromEntries(
    db
      .prepare("SELECT id, play_count FROM videos")
      .all()
      .map((row) => [row.id, row.play_count]),
  );
}

test("rotation shows every film once before repeating any", () => {
  const db = wallWith(["a", "b", "c", "d"]);

  const round = [];
  let last = "";
  for (let play = 0; play < 4; play += 1) {
    const video = selectVideo(db, { mode: "rotation", excludeId: last });
    round.push(video.id);
    last = video.id;
  }

  assert.deepEqual([...round].sort(), ["a", "b", "c", "d"]);
  assert.deepEqual(playCounts(db), { a: 1, b: 1, c: 1, d: 1 });

  // The round turns over instead of stalling once everyone has been shown.
  const next = selectVideo(db, { mode: "rotation", excludeId: last });
  assert.ok(next);
  assert.equal(
    Number(
      db
        .prepare("SELECT value FROM app_meta WHERE key = 'playlist_cycle'")
        .get().value,
    ),
    1,
  );
});

test("latest plays the newest film first and a new arrival next", () => {
  const db = wallWith(["a", "b", "c", "d", "e", "f", "g", "h"]);

  assert.equal(selectVideo(db, { mode: "latest" }).id, "h");
  assert.equal(selectVideo(db, { mode: "latest", excludeId: "h" }).id, "g");

  // A film that finishes rendering now jumps the running order: nobody has
  // to sit through the rest of the wall to see their own.
  db.prepare(
    "INSERT INTO videos (id, is_active, created_at) VALUES ('new', 1, ?)",
  ).run(new Date(9 * 60_000).toISOString());
  assert.equal(selectVideo(db, { mode: "latest", excludeId: "g" }).id, "new");
});

test("latest cycles the recent window instead of looping one film", () => {
  const db = wallWith(["a", "b", "c", "d", "e"]);

  const shown = [];
  let last = "";
  for (let play = 0; play < 6; play += 1) {
    const video = selectVideo(db, {
      mode: "latest",
      excludeId: last,
      recentWindow: 3,
    });
    shown.push(video.id);
    last = video.id;
  }

  assert.deepEqual(shown, ["e", "d", "c", "e", "d", "c"]);
  assert.deepEqual(playCounts(db), { a: 0, b: 0, c: 2, d: 2, e: 2 });
});

test("latest keeps rolling when the wall holds a single film", () => {
  const db = wallWith(["only"]);

  assert.equal(selectVideo(db, { mode: "latest" }).id, "only");
  assert.equal(
    selectVideo(db, { mode: "latest", excludeId: "only" }).id,
    "only",
  );
});

test("a film asked for by id plays, and a deleted one falls back", () => {
  const db = wallWith(["a", "b", "c"]);

  const picked = selectVideo(db, { mode: "latest", videoId: "a" });
  assert.equal(picked.id, "a");
  assert.equal(picked.play_count, 1);

  // Films played out of order still count as shown this round, so switching
  // back to rotation does not replay what the room just watched.
  assert.equal(
    db.prepare("SELECT last_cycle FROM videos WHERE id = 'a'").get()
      .last_cycle,
    0,
  );

  db.prepare("UPDATE videos SET is_active = 0 WHERE id = 'b'").run();
  assert.equal(selectVideo(db, { mode: "latest", videoId: "b" }).id, "c");
});

test("an empty wall selects nothing", () => {
  assert.equal(selectVideo(wallWith([]), { mode: "latest" }), null);
  assert.equal(selectVideo(wallWith([]), { mode: "rotation" }), null);
});
