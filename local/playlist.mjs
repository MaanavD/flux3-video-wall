// Two ways to run the wall.
//
// "rotation" is the house playlist: shuffle rounds where every active film is
// drawn once before the next round starts, so nothing is over-played.
//
// "latest" is for the person who just typed a prompt: the newest films come
// first, so their own premiere arrives in a minute instead of after the whole
// wall has been shown. It still cycles the newest handful rather than looping a
// single file, so the wall keeps moving in a quiet room.

export const DEFAULT_RECENT_WINDOW = 6;

function readCycle(db) {
  return Number(
    db
      .prepare("SELECT value FROM app_meta WHERE key = 'playlist_cycle'")
      .get().value,
  );
}

// Marking the film for the current round in both modes means a switch back to
// rotation does not immediately replay what the room has just seen.
function markPlayed(db, video, cycle) {
  db.prepare(
    `UPDATE videos
     SET last_cycle = ?, play_count = play_count + 1
     WHERE id = ?`,
  ).run(cycle, video.id);
  return { ...video, play_count: video.play_count + 1, last_cycle: cycle };
}

function pickRequested(db, videoId) {
  if (!videoId) return null;
  return (
    db
      .prepare("SELECT * FROM videos WHERE id = ? AND is_active = 1")
      .get(videoId) || null
  );
}

function pickRecent(db, excludeId, recentWindow) {
  const pick = (allowExcluded) =>
    db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM videos
           WHERE is_active = 1
           ORDER BY created_at DESC, id DESC
           LIMIT ?
         )
         ${allowExcluded ? "" : "WHERE id != ?"}
         ORDER BY play_count ASC, created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(
        ...(allowExcluded
          ? [recentWindow]
          : [recentWindow, excludeId || ""]),
      );

  return pick(false) || pick(true) || null;
}

function pickRotation(db, excludeId, cycle) {
  const pick = (round, allowExcluded) =>
    db
      .prepare(
        `SELECT * FROM videos
         WHERE is_active = 1
           AND last_cycle < ?
           ${allowExcluded ? "" : "AND id != ?"}
         ORDER BY RANDOM()
         LIMIT 1`,
      )
      .get(...(allowExcluded ? [round] : [round, excludeId || ""]));

  const video = pick(cycle, false) || pick(cycle, true);
  if (video) return { video, cycle };

  const activeCount = db
    .prepare("SELECT COUNT(*) AS count FROM videos WHERE is_active = 1")
    .get().count;
  if (!activeCount) return { video: null, cycle };

  // Everyone has been shown: turn the round over and draw again.
  const nextCycle = cycle + 1;
  db.prepare("UPDATE app_meta SET value = ? WHERE key = 'playlist_cycle'").run(
    String(nextCycle),
  );
  return {
    video: pick(nextCycle, false) || pick(nextCycle, true) || null,
    cycle: nextCycle,
  };
}

export function selectVideo(db, options = {}) {
  const {
    mode = "rotation",
    excludeId = "",
    videoId = "",
    recentWindow = DEFAULT_RECENT_WINDOW,
  } = options;

  db.exec("BEGIN IMMEDIATE");
  try {
    let cycle = readCycle(db);
    // A film asked for by id (the feed) wins; if it has since been deleted,
    // fall through to the mode so the wall never goes dark.
    let video = pickRequested(db, videoId);
    if (!video) {
      if (mode === "latest") {
        video = pickRecent(db, excludeId, recentWindow);
      } else {
        ({ video, cycle } = pickRotation(db, excludeId, cycle));
      }
    }

    if (!video) {
      db.exec("COMMIT");
      return null;
    }

    const played = markPlayed(db, video, cycle);
    db.exec("COMMIT");
    return played;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
