import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import { generationTimeoutMs, shouldExpireGeneration } from "./queue-policy.mjs";
import { DEFAULT_RECENT_WINDOW, selectVideo } from "./playlist.mjs";
import { createSync } from "./sync.mjs";

const localDir = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(localDir, "..");
// WALL_DATA_DIR lets a second instance run beside the first on one machine
// (tests, rehearsals); every wall at an event just uses ./data.
const dataDir = process.env.WALL_DATA_DIR
  ? resolve(process.env.WALL_DATA_DIR)
  : join(appRoot, "data");
const videoDir = join(dataDir, "videos");
const seedDir = join(dataDir, "seed-videos");
const trashDir = join(dataDir, "trash");
const dbPath = join(dataDir, "wall.sqlite");
const port = Number(process.env.LOCAL_API_PORT || 8788);
const bflApiKey = process.env.BFL_API_KEY || "";
const bflEndpoint =
  process.env.BFL_MODEL_ENDPOINT || "https://api.bfl.ai/v1/flux-3-video";
const bflResolution = process.env.BFL_RESOLUTION === "fhd" ? "fhd" : "hd";
// Several walls share films through Supabase when these are set; each Mac is
// named by WALL_ID. See local/sync.mjs.
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabaseBucket = process.env.SUPABASE_BUCKET || "video-wall";
const syncEnabled = Boolean(supabaseUrl && supabaseKey);
const wallId = (process.env.WALL_ID || hostname()).trim();
// With one BFL key shared by several Macs the per-key concurrency is split
// between them, so a synced wall defaults to a smaller slice.
const bflConcurrency = Number(
  process.env.BFL_CONCURRENCY ||
    (syncEnabled ? 3 : bflResolution === "fhd" ? 5 : 8),
);
const bflVersion = process.env.BFL_MODEL_VERSION || "";
// How many of the newest films the "latest" playback mode cycles through.
const recentWindow = Math.max(
  1,
  Number(process.env.WALL_RECENT_WINDOW) || DEFAULT_RECENT_WINDOW,
);

await Promise.all(
  [dataDir, videoDir, seedDir, trashDir].map((path) =>
    mkdir(path, { recursive: true }),
  ),
);

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL UNIQUE,
    creator_name TEXT NOT NULL,
    prompt TEXT NOT NULL DEFAULT '',
    duration INTEGER,
    source TEXT NOT NULL CHECK (source IN ('seed', 'generated')),
    play_count INTEGER NOT NULL DEFAULT 0,
    last_cycle INTEGER NOT NULL DEFAULT -1,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY,
    creator_name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    duration INTEGER NOT NULL,
    status TEXT NOT NULL,
    provider_task_id TEXT,
    polling_url TEXT,
    provider_seed TEXT,
    video_id TEXT,
    error TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (video_id) REFERENCES videos(id)
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_videos_active_cycle
  ON videos(is_active, last_cycle)
`);
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_submissions_status_retry
  ON submissions(status, retry_at)
`);
// Columns added for shared walls. Existing databases grow them in place.
function ensureColumn(table, column, definition) {
  const present = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
  if (!present) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn("videos", "origin", "TEXT");
ensureColumn("videos", "storage_path", "TEXT");
ensureColumn("videos", "synced", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("submissions", "origin", "TEXT");
ensureColumn("submissions", "synced", "INTEGER NOT NULL DEFAULT 0");
// Rows from before sharing existed belong to this wall.
db.prepare("UPDATE videos SET origin = ? WHERE origin IS NULL").run(wallId);
db.prepare("UPDATE submissions SET origin = ? WHERE origin IS NULL").run(
  wallId,
);
db.exec("PRAGMA optimize");
db.prepare(
  "INSERT OR IGNORE INTO app_meta(key, value) VALUES ('playlist_cycle', '0')",
).run();

function nowIso() {
  return new Date().toISOString();
}

function readManifestEntry(manifest, fileName) {
  if (Array.isArray(manifest)) {
    return manifest.find((entry) => entry?.file === fileName) || null;
  }
  return manifest?.[fileName] || null;
}

async function scanSeedVideos() {
  let manifest = {};
  try {
    manifest = JSON.parse(
      await readFile(join(seedDir, "manifest.json"), "utf8"),
    );
  } catch {
    manifest = {};
  }

  const files = await readdir(seedDir);
  // Seeds stay local to each Mac (copy the folder); only generated films
  // travel through the shared tables, hence synced = 1 from the start.
  const insert = db.prepare(`
    INSERT OR IGNORE INTO videos (
      id, file_name, file_path, creator_name, prompt, duration,
      source, play_count, last_cycle, is_active, created_at, origin, synced
    ) VALUES (?, ?, ?, ?, ?, ?, 'seed', 0, -1, 1, ?, ?, 1)
  `);

  for (const fileName of files) {
    if (extname(fileName).toLowerCase() !== ".mp4") continue;
    const absolutePath = join(seedDir, fileName);
    const entry = readManifestEntry(manifest, fileName);
    const id = `seed_${createHash("sha1")
      .update(fileName)
      .digest("hex")
      .slice(0, 16)}`;

    insert.run(
      id,
      fileName,
      absolutePath,
      String(entry?.name || "Black Forest Labs").slice(0, 40),
      String(entry?.prompt || ""),
      Number(entry?.duration) || null,
      nowIso(),
      wallId,
    );
  }
}

await scanSeedVideos();
setInterval(() => {
  scanSeedVideos().catch((error) =>
    console.error("Seed scan failed:", error.message),
  );
}, 10_000).unref();

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Cache-Control": "no-store",
    ...extra,
  };
}

function sendJson(response, status, value) {
  response.writeHead(
    status,
    corsHeaders({ "Content-Type": "application/json; charset=utf-8" }),
  );
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("Request is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function toPublicVideo(row) {
  return {
    id: row.id,
    name: row.creator_name,
    prompt: row.prompt,
    duration: row.duration,
    source: row.source,
    playCount: row.play_count,
    createdAt: row.created_at,
    wall: row.origin,
    mediaUrl: `http://127.0.0.1:${port}/media/${row.id}`,
  };
}

function toPublicSubmission(row) {
  return {
    id: row.id,
    name: row.creator_name,
    prompt: row.prompt,
    duration: row.duration,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    wall: row.origin,
  };
}

// file_path is stored for reference but not trusted for reads: it's an
// absolute path from wherever the row was created, which breaks the moment
// this folder is copied or moved to a different machine or location. The
// current, correct location is always derivable from file_name + source.
function resolveVideoPath(row) {
  return join(row.source === "seed" ? seedDir : videoDir, row.file_name);
}

function activeVideoRows() {
  return db
    .prepare(
      `SELECT * FROM videos
       WHERE is_active = 1
       ORDER BY created_at DESC`,
    )
    .all();
}

const IN_FLIGHT_STATUSES = [
  "queued",
  "submitting",
  "pending",
  "reasoning",
  "generating",
  "downloading",
];
// Failures stay in the guest feed for a short while: a film that simply
// vanished is the one thing nobody in the room can explain.
const FEED_FAILURE_WINDOW_MS = 15 * 60_000;

async function retireVideoLocally(video) {
  const trashName = `${Date.now()}_${video.file_name}`;
  const trashPath = join(trashDir, trashName);

  try {
    await rename(resolveVideoPath(video), trashPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  db.prepare(
    `UPDATE videos
     SET is_active = 0, deleted_at = ?
     WHERE id = ?`,
  ).run(nowIso(), video.id);
}

async function moveVideoToTrash(id) {
  const video = db
    .prepare("SELECT * FROM videos WHERE id = ? AND is_active = 1")
    .get(id);
  if (!video) return false;

  await retireVideoLocally(video);

  // Shared films disappear from every wall; seeds are this Mac's own.
  if (sync.enabled && video.source === "generated") {
    try {
      await sync.markDeleted(id);
    } catch (error) {
      console.error(`Sync: could not share the delete of ${id}: ${error.message}`);
    }
  }
  return true;
}

async function streamVideo(request, response, id) {
  const video = db
    .prepare("SELECT * FROM videos WHERE id = ? AND is_active = 1")
    .get(id);
  if (!video) {
    sendJson(response, 404, { error: "Video not found" });
    return;
  }

  const videoPath = resolveVideoPath(video);
  let fileStats;
  try {
    fileStats = await stat(videoPath);
  } catch {
    sendJson(response, 404, { error: "Video file is missing" });
    return;
  }

  const range = request.headers.range;
  if (!range) {
    response.writeHead(
      200,
      corsHeaders({
        "Content-Type": "video/mp4",
        "Content-Length": fileStats.size,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
      }),
    );
    createReadStream(videoPath).pipe(response);
    return;
  }

  const match = range.match(/bytes=(\d*)-(\d*)/);
  if (!match) {
    response.writeHead(416);
    response.end();
    return;
  }

  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2]
    ? Math.min(Number(match[2]), fileStats.size - 1)
    : fileStats.size - 1;

  response.writeHead(
    206,
    corsHeaders({
      "Content-Type": "video/mp4",
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${fileStats.size}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
    }),
  );
  createReadStream(videoPath, { start, end }).pipe(response);
}

function updateSubmission(id, fields) {
  const entries = Object.entries(fields);
  if (!entries.length) return;
  const setters = entries.map(([key]) => `${key} = ?`).join(", ");
  db.prepare(
    `UPDATE submissions SET ${setters}, updated_at = ?, synced = 0 WHERE id = ?`,
  ).run(...entries.map(([, value]) => value), nowIso(), id);
}

function expireStalledSubmissions() {
  const completedDurations = db
    .prepare(
      `SELECT (julianday(updated_at) - julianday(created_at)) * 86400000.0 AS duration_ms
       FROM submissions
       WHERE status = 'ready' AND updated_at >= created_at
       ORDER BY updated_at DESC
       LIMIT 50`,
    )
    .all()
    .map((submission) => Number(submission.duration_ms));
  const timeoutMs = generationTimeoutMs(completedDurations);
  const active = db
    .prepare(
      `SELECT id, created_at FROM submissions
       WHERE status IN ('submitting', 'pending', 'reasoning', 'generating', 'downloading')
         AND origin = ?`,
    )
    .all(wallId);

  for (const submission of active) {
    if (
      !shouldExpireGeneration({
        createdAt: submission.created_at,
        timeoutMs,
      })
    ) {
      continue;
    }

    updateSubmission(submission.id, {
      status: "failed",
      error: `Render timed out after ${Math.ceil(timeoutMs / 60_000)} minutes. Likely private or copyrighted content.`,
    });
  }
}

async function downloadCompletedVideo(submission, result, providerSeed) {
  const signedUrl = result?.sample;
  if (!signedUrl) throw new Error("Ready result did not contain result.sample");

  const downloadResponse = await fetch(signedUrl, { redirect: "follow" });
  if (!downloadResponse.ok || !downloadResponse.body) {
    throw new Error(`Video download failed with ${downloadResponse.status}`);
  }

  const finalName = `${submission.id}.mp4`;
  const finalPath = join(videoDir, finalName);
  const temporaryPath = `${finalPath}.partial`;
  await pipeline(
    Readable.fromWeb(downloadResponse.body),
    (await import("node:fs")).createWriteStream(temporaryPath),
  );
  await rename(temporaryPath, finalPath);

  const videoId = randomUUID();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO videos (
        id, file_name, file_path, creator_name, prompt, duration,
        source, play_count, last_cycle, is_active, created_at, origin, synced
      ) VALUES (?, ?, ?, ?, ?, ?, 'generated', 0, -1, 1, ?, ?, 0)`,
    ).run(
      videoId,
      finalName,
      finalPath,
      submission.creator_name,
      submission.prompt,
      submission.duration,
      nowIso(),
      wallId,
    );
    db.prepare(
      `UPDATE submissions
       SET status = 'ready', video_id = ?, provider_seed = ?,
           error = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(
      videoId,
      providerSeed == null ? null : String(providerSeed),
      nowIso(),
      submission.id,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  // Share it right away; if the upload fails the sync tick retries.
  if (sync.enabled) {
    const video = db.prepare("SELECT * FROM videos WHERE id = ?").get(videoId);
    sync
      .publishVideo(video, finalPath)
      .catch((error) =>
        console.error(`Sync: could not publish ${videoId}: ${error.message}`),
      );
  }
}

async function pollSubmission(submission) {
  let response;
  try {
    response = await fetch(submission.polling_url, {
      headers: { "x-key": bflApiKey },
      redirect: "follow",
    });
  } catch (error) {
    updateSubmission(submission.id, {
      error: `Polling network error: ${error.message}`,
    });
    return;
  }

  if (!response.ok) {
    updateSubmission(submission.id, {
      error: `Polling returned ${response.status}`,
    });
    return;
  }

  const payload = await response.json();
  const rawStatus = String(payload.status || "");
  const normalized = rawStatus.toLowerCase().replaceAll(" ", "_");

  if (rawStatus === "Ready") {
    updateSubmission(submission.id, { status: "downloading", error: null });
    try {
      await downloadCompletedVideo(
        submission,
        payload.result,
        payload.seed ?? payload.result?.seed,
      );
    } catch (error) {
      updateSubmission(submission.id, {
        status: "downloading",
        error: error.message,
      });
    }
    return;
  }

  if (
    rawStatus === "Request Moderated" ||
    rawStatus === "Content Moderated"
  ) {
    updateSubmission(submission.id, {
      status: "moderated",
      error: rawStatus,
    });
    return;
  }

  if (rawStatus === "Error" || rawStatus === "Task not found") {
    updateSubmission(submission.id, {
      status: "failed",
      error: rawStatus,
    });
    return;
  }

  if (["Pending", "Reasoning", "Generating"].includes(rawStatus)) {
    updateSubmission(submission.id, {
      status: normalized,
      error: null,
    });
  }
}

async function dispatchSubmission(submission) {
  updateSubmission(submission.id, { status: "submitting", error: null });

  const requestBody = {
    mode: "t2v",
    prompt: submission.prompt,
    aspect_ratio: "16:9",
    resolution: bflResolution,
    duration: submission.duration,
    generate_audio: true,
  };
  if (bflVersion) requestBody.version = bflVersion;

  let response;
  try {
    response = await fetch(bflEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-key": bflApiKey,
      },
      body: JSON.stringify(requestBody),
    });
  } catch (error) {
    updateSubmission(submission.id, {
      status: "needs_review",
      error: `Submission outcome is unknown: ${error.message}`,
    });
    return;
  }

  if (response.status === 429 || response.status === 503) {
    const retryCount = submission.retry_count + 1;
    const delaySeconds =
      response.status === 429
        ? 5
        : Math.min(60, Math.max(3, 2 ** retryCount));
    updateSubmission(submission.id, {
      status: "queued",
      retry_count: retryCount,
      retry_at: Date.now() + delaySeconds * 1000,
      error: response.status === 429 ? null : "BFL is temporarily at capacity",
    });
    return;
  }

  if (!response.ok) {
    const details = (await response.text()).slice(0, 500);
    updateSubmission(submission.id, {
      status: "failed",
      error: `BFL returned ${response.status}: ${details}`,
    });
    return;
  }

  const payload = await response.json();
  if (!payload.id || !payload.polling_url) {
    updateSubmission(submission.id, {
      status: "needs_review",
      error: "BFL response did not include id and polling_url",
    });
    return;
  }

  updateSubmission(submission.id, {
    status: "pending",
    provider_task_id: payload.id,
    polling_url: payload.polling_url,
    error: null,
  });
}

let workerBusy = false;
async function workerTick() {
  if (workerBusy || !bflApiKey) return;
  workerBusy = true;
  try {
    const active = db
      .prepare(
        `SELECT * FROM submissions
         WHERE status IN ('pending', 'reasoning', 'generating', 'downloading')
           AND polling_url IS NOT NULL
           AND origin = ?`,
      )
      .all(wallId);

    await Promise.allSettled(active.map(pollSubmission));
    expireStalledSubmissions();

    const activeCount = db
      .prepare(
        `SELECT COUNT(*) AS count FROM submissions
         WHERE status IN ('submitting', 'pending', 'reasoning', 'generating')
           AND origin = ?`,
      )
      .get(wallId).count;
    const available = Math.max(0, bflConcurrency - activeCount);
    if (!available) return;

    const queued = db
      .prepare(
        `SELECT * FROM submissions
         WHERE status = 'queued' AND retry_at <= ? AND origin = ?
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(Date.now(), wallId, available);

    for (const submission of queued) {
      await dispatchSubmission(submission);
    }
  } finally {
    workerBusy = false;
  }
}

setInterval(() => {
  workerTick().catch((error) => console.error("Worker failed:", error));
}, 3_000).unref();
workerTick().catch((error) => console.error("Worker failed:", error));

const sync = createSync({
  url: supabaseUrl,
  key: supabaseKey,
  bucket: supabaseBucket,
  wallId,
  db,
  videoDir,
  // A film from another wall arrives already cached on disk; from here on it
  // is an ordinary local video and joins the current shuffle round.
  onRemoteVideo(film) {
    db.prepare(
      `INSERT OR IGNORE INTO videos (
        id, file_name, file_path, creator_name, prompt, duration,
        source, play_count, last_cycle, is_active, created_at,
        origin, storage_path, synced
      ) VALUES (?, ?, ?, ?, ?, ?, 'generated', 0, -1, 1, ?, ?, ?, 1)`,
    ).run(
      film.id,
      film.fileName,
      film.filePath,
      film.creatorName,
      film.prompt,
      film.duration,
      film.createdAt,
      film.origin,
      film.storagePath,
    );
    console.log(`Sync: new film from ${film.origin} (${film.creatorName})`);
  },
  onRemoteVideoDeleted: retireVideoLocally,
});
if (sync.enabled) {
  setInterval(() => {
    sync.tick(resolveVideoPath);
  }, 4_000).unref();
  sync.tick(resolveVideoPath);
}

const server = createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders());
    response.end();
    return;
  }

  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  const path = url.pathname;

  try {
    if (request.method === "GET" && path === "/api/health") {
      const counts = db
        .prepare(
          `SELECT
            (SELECT COUNT(*) FROM videos WHERE is_active = 1) AS videos,
            (SELECT COUNT(*) FROM submissions WHERE status = 'queued') AS queued,
            (SELECT COUNT(*) FROM submissions
              WHERE status IN ('submitting','pending','reasoning','generating')
            ) AS active`,
        )
        .get();
      sendJson(response, 200, {
        ok: true,
        providerConfigured: Boolean(bflApiKey),
        endpoint: bflEndpoint,
        concurrency: bflConcurrency,
        wallId,
        sync: sync.state,
        ...counts,
      });
      return;
    }

    if (request.method === "GET" && path === "/api/state") {
      const videos = activeVideoRows();
      const statusRows = db
        .prepare(
          `SELECT status, COUNT(*) AS count
           FROM submissions
           GROUP BY status`,
        )
        .all();
      sendJson(response, 200, {
        providerConfigured: Boolean(bflApiKey),
        endpoint: bflResolution === "fhd" ? "high" : "optimized",
        activeVideoIds: videos.map((video) => video.id),
        videoCount: videos.length,
        recentWindow,
        queue: Object.fromEntries(
          statusRows.map((row) => [row.status, row.count]),
        ),
      });
      return;
    }

    if (request.method === "GET" && path === "/api/library") {
      const videos = activeVideoRows().map(toPublicVideo);
      const submissions = db
        .prepare(
          `SELECT * FROM submissions
           ORDER BY created_at DESC
           LIMIT 200`,
        )
        .all()
        .map(toPublicSubmission);
      sendJson(response, 200, {
        videos,
        submissions,
        providerConfigured: Boolean(bflApiKey),
      });
      return;
    }

    if (request.method === "POST" && path === "/api/submissions") {
      const body = await readJson(request);
      const name = String(body.name || "").trim();
      const prompt = String(body.prompt || "").trim();
      const duration = Number(body.duration);

      if (!name || name.length > 40) {
        sendJson(response, 422, {
          error: "Use a display name between 1 and 40 characters.",
        });
        return;
      }
      if (prompt.length < 1) {
        sendJson(response, 422, {
          error: "Type a prompt for the film.",
        });
        return;
      }
      if (!Number.isInteger(duration) || duration < 5 || duration > 20) {
        sendJson(response, 422, {
          error: "Choose a duration from 5 to 20 seconds.",
        });
        return;
      }

      const id = randomUUID();
      const timestamp = nowIso();
      db.prepare(
        `INSERT INTO submissions (
          id, creator_name, prompt, duration, status, created_at, updated_at,
          origin, synced
        ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, 0)`,
      ).run(id, name, prompt, duration, timestamp, timestamp, wallId);

      sendJson(response, 201, {
        id,
        status: "queued",
        providerConfigured: Boolean(bflApiKey),
      });
      workerTick().catch((error) => console.error("Worker failed:", error));
      return;
    }

    if (request.method === "POST" && path === "/api/videos/next") {
      const body = await readJson(request);
      const video = selectVideo(db, {
        mode: body.mode === "latest" ? "latest" : "rotation",
        excludeId: String(body.excludeId || ""),
        videoId: String(body.videoId || ""),
        recentWindow,
      });
      sendJson(response, 200, {
        video: video ? toPublicVideo(video) : null,
      });
      return;
    }

    if (request.method === "GET" && path === "/api/feed") {
      const limit = Math.min(
        24,
        Math.max(1, Number(url.searchParams.get("limit")) || 12),
      );
      const films = db
        .prepare(
          `SELECT * FROM videos
           WHERE is_active = 1
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .all(limit)
        .map(toPublicVideo);
      const pending = db
        .prepare(
          `SELECT * FROM submissions
           WHERE status IN (${IN_FLIGHT_STATUSES.map(() => "?").join(", ")})
              OR (status IN ('failed', 'moderated', 'needs_review')
                  AND updated_at >= ?)
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(
          ...IN_FLIGHT_STATUSES,
          new Date(Date.now() - FEED_FAILURE_WINDOW_MS).toISOString(),
          limit,
        )
        .map(toPublicSubmission);
      sendJson(response, 200, { films, pending });
      return;
    }

    const videoDeleteMatch = path.match(/^\/api\/videos\/([^/]+)$/);
    if (request.method === "DELETE" && videoDeleteMatch) {
      const removed = await moveVideoToTrash(videoDeleteMatch[1]);
      sendJson(response, removed ? 200 : 404, {
        removed,
        recoverable: removed,
      });
      return;
    }

    const retryMatch = path.match(/^\/api\/submissions\/([^/]+)\/retry$/);
    if (request.method === "POST" && retryMatch) {
      const submission = db
        .prepare("SELECT * FROM submissions WHERE id = ?")
        .get(retryMatch[1]);
      if (!submission) {
        sendJson(response, 404, { error: "Submission not found" });
        return;
      }
      if (submission.origin !== wallId) {
        sendJson(response, 409, {
          error: `This film was typed on wall "${submission.origin}". Retry it there.`,
        });
        return;
      }
      updateSubmission(submission.id, {
        status: "queued",
        provider_task_id: null,
        polling_url: null,
        error: null,
        retry_count: 0,
        retry_at: 0,
      });
      sendJson(response, 200, { retried: true });
      return;
    }

    const mediaMatch = path.match(/^\/media\/([^/]+)$/);
    if (request.method === "GET" && mediaMatch) {
      await streamVideo(request, response, mediaMatch[1]);
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: error.message || "Unexpected error" });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Local wall API: http://127.0.0.1:${port}`);
  console.log(
    bflApiKey
      ? `BFL worker ready: ${bflEndpoint}`
      : "BFL_API_KEY is not set. New prompts will remain safely queued.",
  );
  console.log(
    sync.enabled
      ? `Shared wall "${wallId}": syncing with ${supabaseUrl} (bucket ${supabaseBucket})`
      : `Local wall "${wallId}": no Supabase configured, films stay on this Mac.`,
  );
});
