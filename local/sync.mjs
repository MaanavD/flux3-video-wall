// Shared films across several walls, one per Mac, through Supabase.
//
// Every wall keeps its own SQLite as the working store and playback engine.
// This module is the bridge: it pushes this wall's submissions and finished
// films up to two shared tables and a private bucket, and pulls everyone
// else's down into the local tables, caching each MP4 in data/videos so the
// projector never streams over the venue Wi-Fi.
//
// Ownership is simple: a submission is worked on only by the wall that took
// it (origin = WALL_ID). Films belong to everyone once uploaded; a delete on
// any wall sets deleted_at in the shared row and every wall follows.

import { createWriteStream } from "node:fs";
import { readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const PULL_DOWNLOADS_PER_TICK = 3;
const EPOCH = "1970-01-01T00:00:00.000Z";

export function createSync({
  url,
  key,
  bucket,
  wallId,
  db,
  videoDir,
  onRemoteVideo,
  onRemoteVideoDeleted,
  log = console,
}) {
  const enabled = Boolean(url && key && bucket);
  const base = String(url || "").replace(/\/$/, "");
  const state = {
    enabled,
    wallId,
    bucket,
    lastPullAt: null,
    lastPushAt: null,
    lastError: null,
  };

  function headers(extra = {}) {
    return { apikey: key, authorization: `Bearer ${key}`, ...extra };
  }

  async function rest(method, table, query, body, prefer) {
    const response = await fetch(`${base}/rest/v1/${table}?${query}`, {
      method,
      headers: headers({
        "content-type": "application/json",
        accept: "application/json",
        ...(prefer ? { prefer } : {}),
      }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const details = (await response.text()).slice(0, 300);
      throw new Error(`${table} ${method} failed (${response.status}): ${details}`);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  function readMeta(name) {
    const row = db
      .prepare("SELECT value FROM app_meta WHERE key = ?")
      .get(name);
    return row ? row.value : EPOCH;
  }

  function writeMeta(name, value) {
    db.prepare(
      `INSERT INTO app_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(name, value);
  }

  function isoOf(value) {
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : value;
  }

  // ---- push: this wall's submissions -------------------------------------

  async function pushSubmissions() {
    const rows = db
      .prepare(
        `SELECT * FROM submissions
         WHERE origin = ? AND synced = 0
         ORDER BY updated_at ASC
         LIMIT 50`,
      )
      .all(wallId);
    if (!rows.length) return;

    await rest(
      "POST",
      "wall_submissions",
      "on_conflict=id",
      rows.map((row) => ({
        id: row.id,
        origin: wallId,
        creator_name: row.creator_name,
        prompt: row.prompt,
        duration: row.duration,
        status: row.status,
        error: row.error,
        video_id: row.video_id,
        created_at: row.created_at,
      })),
      "resolution=merge-duplicates,return=minimal",
    );

    // Only clear the flag if nothing changed underneath us meanwhile.
    const clear = db.prepare(
      "UPDATE submissions SET synced = 1 WHERE id = ? AND updated_at = ?",
    );
    for (const row of rows) clear.run(row.id, row.updated_at);
  }

  // ---- push: this wall's finished films ----------------------------------

  async function publishVideo(video, filePath) {
    const storagePath = `videos/${video.id}.mp4`;
    const data = await readFile(filePath);
    const upload = await fetch(
      `${base}/storage/v1/object/${bucket}/${storagePath}`,
      {
        method: "POST",
        headers: headers({ "content-type": "video/mp4", "x-upsert": "true" }),
        body: data,
      },
    );
    if (!upload.ok) {
      throw new Error(
        `Upload failed (${upload.status}): ${(await upload.text()).slice(0, 300)}`,
      );
    }

    await rest(
      "POST",
      "wall_videos",
      "on_conflict=id",
      [
        {
          id: video.id,
          origin: wallId,
          creator_name: video.creator_name,
          prompt: video.prompt,
          duration: video.duration,
          storage_path: storagePath,
          created_at: video.created_at,
          deleted_at: video.is_active ? null : video.deleted_at,
        },
      ],
      "resolution=merge-duplicates,return=minimal",
    );

    db.prepare(
      "UPDATE videos SET synced = 1, storage_path = ? WHERE id = ?",
    ).run(storagePath, video.id);
  }

  async function pushVideos(resolvePath) {
    const rows = db
      .prepare(
        `SELECT * FROM videos
         WHERE origin = ? AND source = 'generated' AND synced = 0
         ORDER BY created_at ASC
         LIMIT 5`,
      )
      .all(wallId);
    for (const row of rows) {
      if (!row.is_active) {
        // Deleted before it ever made it up: nothing to share.
        db.prepare("UPDATE videos SET synced = 1 WHERE id = ?").run(row.id);
        continue;
      }
      try {
        await publishVideo(row, resolvePath(row));
      } catch (error) {
        log.error(`Sync: could not publish ${row.id}: ${error.message}`);
      }
    }
  }

  // Any wall may delete any film. Deletes travel through the shared row.
  async function markDeleted(id) {
    await rest(
      "PATCH",
      "wall_videos",
      `id=eq.${encodeURIComponent(id)}`,
      { deleted_at: new Date().toISOString() },
      "return=minimal",
    );
  }

  // ---- pull: everyone else's submissions ---------------------------------

  async function pullSubmissions() {
    const since = readMeta("sync_submissions_since");
    const rows = await rest(
      "GET",
      "wall_submissions",
      `origin=neq.${encodeURIComponent(wallId)}&updated_at=gte.${encodeURIComponent(since)}&order=updated_at.asc&limit=200`,
    );
    if (!rows?.length) return;

    const upsert = db.prepare(
      `INSERT INTO submissions (
         id, creator_name, prompt, duration, status, error, video_id,
         origin, synced, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         error = excluded.error,
         video_id = excluded.video_id,
         updated_at = excluded.updated_at`,
    );
    // submissions.video_id is a foreign key into the local videos table; a
    // film this wall has not cached yet is simply not linked.
    const hasVideo = db.prepare("SELECT 1 FROM videos WHERE id = ?");
    let newest = since;
    for (const row of rows) {
      upsert.run(
        row.id,
        row.creator_name,
        row.prompt,
        row.duration,
        row.status,
        row.error,
        row.video_id && hasVideo.get(row.video_id) ? row.video_id : null,
        row.origin,
        isoOf(row.created_at),
        isoOf(row.updated_at),
      );
      if (row.updated_at > newest) newest = row.updated_at;
    }
    writeMeta("sync_submissions_since", newest);
  }

  // ---- pull: films from every wall ---------------------------------------

  async function downloadObject(storagePath, targetPath) {
    const response = await fetch(
      `${base}/storage/v1/object/${bucket}/${storagePath}`,
      { headers: headers() },
    );
    if (!response.ok || !response.body) {
      throw new Error(`Download failed (${response.status})`);
    }
    const temporaryPath = `${targetPath}.partial`;
    try {
      await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(temporaryPath),
      );
      await rename(temporaryPath, targetPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }

  async function pullVideos() {
    const since = readMeta("sync_videos_since");
    const rows = await rest(
      "GET",
      "wall_videos",
      `updated_at=gte.${encodeURIComponent(since)}&order=updated_at.asc&limit=100`,
    );
    if (!rows?.length) return;

    let downloads = 0;
    let newest = since;
    for (const row of rows) {
      const local = db
        .prepare("SELECT * FROM videos WHERE id = ?")
        .get(row.id);

      if (row.deleted_at) {
        if (local?.is_active) await onRemoteVideoDeleted(local);
        else if (!local) {
          // Never seen here and already gone: nothing to fetch.
        }
      } else if (!local && row.origin !== wallId) {
        // A film from another wall: cache it, then let it join playback.
        if (downloads >= PULL_DOWNLOADS_PER_TICK) break;
        downloads += 1;
        const fileName = `${row.id}.mp4`;
        const targetPath = join(videoDir, fileName);
        let present = false;
        try {
          present = (await stat(targetPath)).size > 0;
        } catch {
          present = false;
        }
        if (!present) await downloadObject(row.storage_path, targetPath);
        onRemoteVideo({
          id: row.id,
          fileName,
          filePath: targetPath,
          creatorName: row.creator_name,
          prompt: row.prompt,
          duration: row.duration,
          origin: row.origin,
          storagePath: row.storage_path,
          createdAt: isoOf(row.created_at),
        });
      }
      if (row.updated_at > newest) newest = row.updated_at;
    }
    writeMeta("sync_videos_since", newest);
  }

  // ---- tick --------------------------------------------------------------

  let busy = false;
  async function tick(resolvePath) {
    if (!enabled || busy) return;
    busy = true;
    try {
      await pushSubmissions();
      await pushVideos(resolvePath);
      state.lastPushAt = new Date().toISOString();
      // Films first, so a finished submission can link to its cached film.
      await pullVideos();
      await pullSubmissions();
      state.lastPullAt = new Date().toISOString();
      state.lastError = null;
    } catch (error) {
      // The same failure every tick (tables missing, Wi-Fi down) is logged
      // once; the health endpoint always carries the current message.
      if (state.lastError !== error.message) log.error(`Sync: ${error.message}`);
      state.lastError = error.message;
    } finally {
      busy = false;
    }
  }

  return {
    enabled,
    state,
    tick,
    publishVideo,
    markDeleted,
  };
}
