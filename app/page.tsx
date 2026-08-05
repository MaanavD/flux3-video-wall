"use client";

import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "motion/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const API_BASE = "http://127.0.0.1:8788";
const DURATIONS = [5, 10, 15, 20];
const IDLE_RESET_MS = 90_000;

type WallVideo = {
  id: string;
  name: string;
  prompt: string;
  duration: number | null;
  source: "seed" | "generated";
  playCount: number;
  createdAt: string;
  mediaUrl: string;
};

type Submission = {
  id: string;
  name: string;
  prompt: string;
  duration: number;
  status: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type WallState = {
  providerConfigured: boolean;
  endpoint: "high" | "optimized";
  activeVideoIds: string[];
  videoCount: number;
  queue: Record<string, number>;
};

type DisplayMode = "full" | "framed";
const DISPLAY_MODE_STORAGE_KEY = "flux-video-wall-display-mode";

type LibraryState = {
  videos: WallVideo[];
  submissions: Submission[];
  providerConfigured: boolean;
};

const EMPTY_STATE: WallState = {
  providerConfigured: false,
  endpoint: "optimized",
  activeVideoIds: [],
  videoCount: 0,
  queue: {},
};

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || "Something went wrong");
  }
  return body as T;
}

const ACTIVE_STATUSES = [
  "queued",
  "submitting",
  "pending",
  "reasoning",
  "generating",
  "downloading",
];

function queueTotal(queue: Record<string, number>) {
  return ACTIVE_STATUSES.reduce(
    (total, status) => total + (queue[status] || 0),
    0,
  );
}

function friendlyStatus(status: string, error?: string | null) {
  const labels: Record<string, string> = {
    queued: "IN QUEUE",
    submitting: "SUBMITTING",
    pending: "PENDING",
    reasoning: "PLANNING",
    generating: "RENDERING",
    downloading: "SAVING",
    ready: "ON THE WALL",
    moderated: "MODERATED",
    failed: "FAILED",
    needs_review: "NEEDS REVIEW",
  };
  if (status === "failed" && error?.startsWith("Render timed out")) {
    return "FAILED / LIKELY COPYRIGHTED";
  }
  return labels[status] || status.replaceAll("_", " ").toUpperCase();
}

function reelCode(id: string) {
  return id.replaceAll(/[^a-z0-9]/gi, "").slice(-4).toUpperCase();
}

/* ---------------------------------- */
/* Holding screen (no film available) */
/* ---------------------------------- */

function HoldingScreen() {
  return (
    <div className="holding" aria-label="Waiting for the first film">
      <div className="holding-wash" />
      <div className="holding-inner">
        <span className="holding-eyebrow">
          BLACK FOREST LABS × NOUS RESEARCH / SAN FRANCISCO
        </span>
        <h1 className="holding-title">
          Type a film
          <br />
          into existence.
        </h1>
        <p className="holding-sub">
          FLUX 3 turns one sentence into cinema. Step up to the keyboard.
        </p>
      </div>
    </div>
  );
}

/* ---------------------------------- */
/* Teleprinter console                */
/* ---------------------------------- */

type Stage = "name" | "prompt" | "duration";
type Ticket = { name: string; duration: number } | null;

function Console({
  providerConfigured,
  onSubmitted,
}: {
  providerConfigured: boolean;
  onSubmitted: () => void;
}) {
  const [stage, setStage] = useState<Stage>("name");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [durationIndex, setDurationIndex] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [ticket, setTicket] = useState<Ticket>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const nameRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLInputElement>(null);
  const durationRef = useRef<HTMLDivElement>(null);
  const idleTimer = useRef<number | null>(null);
  const stageRef = useRef<Stage>("name");
  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);

  const focusStage = useCallback((target: Stage) => {
    const attempt = () => {
      if (target === "name") nameRef.current?.focus();
      if (target === "prompt") promptRef.current?.focus();
      if (target === "duration") durationRef.current?.focus();
    };
    attempt();
    window.setTimeout(attempt, 50);
  }, []);

  const reset = useCallback(() => {
    setStage("name");
    setName("");
    setPrompt("");
    setDurationIndex(1);
    setNotice(null);
    focusStage("name");
  }, [focusStage]);

  // Kiosk behavior: typing anywhere lands in the current field, and an
  // abandoned half-entry clears itself for the next guest.
  useEffect(() => {
    function armIdleReset() {
      if (idleTimer.current) window.clearTimeout(idleTimer.current);
      idleTimer.current = window.setTimeout(() => {
        if (stageRef.current !== "name" || nameRef.current?.value) reset();
      }, IDLE_RESET_MS);
    }
    function onKeyDown(event: KeyboardEvent) {
      armIdleReset();
      const target = event.target as HTMLElement;
      const inField =
        target instanceof HTMLInputElement ||
        target.getAttribute?.("role") === "radiogroup";
      if (
        !inField &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.key === "Tab"
      ) {
        event.preventDefault();
        focusStage(stageRef.current);
        return;
      }
      if (
        !inField &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.key.length === 1
      ) {
        focusStage(stageRef.current);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    armIdleReset();
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (idleTimer.current) window.clearTimeout(idleTimer.current);
    };
  }, [focusStage, reset]);

  const advanceFromName = useCallback(() => {
    if (name.trim().length < 1) {
      setNotice("TYPE A NAME TO BEGIN");
      return;
    }
    setNotice(null);
    setStage("prompt");
    focusStage("prompt");
  }, [name, focusStage]);

  const advanceFromPrompt = useCallback(() => {
    if (prompt.trim().length < 10) {
      setNotice("GIVE YOUR FILM A LITTLE MORE DETAIL");
      return;
    }
    setNotice(null);
    setStage("duration");
    focusStage("duration");
  }, [prompt, focusStage]);

  const submit = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await api("/api/submissions", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          prompt: prompt.trim(),
          duration: DURATIONS[durationIndex],
        }),
      });
      setTicket({ name: name.trim(), duration: DURATIONS[durationIndex] });
      onSubmitted();
      window.setTimeout(() => {
        setTicket(null);
        focusStage("name");
      }, 6_000);
      setStage("name");
      setName("");
      setPrompt("");
      setDurationIndex(1);
      setNotice(null);
    } catch (error) {
      setNotice(
        (error instanceof Error
          ? error.message
          : "The console could not save your film"
        ).toUpperCase(),
      );
    } finally {
      setSubmitting(false);
    }
  }, [submitting, name, prompt, durationIndex, onSubmitted, focusStage]);

  function durationKeys(event: React.KeyboardEvent) {
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault();
      setDurationIndex((index) => Math.max(0, index - 1));
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      setDurationIndex((index) => Math.min(DURATIONS.length - 1, index + 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      void submit();
    } else if (event.key === "Escape" || event.key === "Backspace") {
      event.preventDefault();
      setStage("prompt");
      focusStage("prompt");
    }
  }

  const stageNumber = stage === "name" ? "01" : stage === "prompt" ? "02" : "03";

  return (
    <section className="console" aria-label="Make a film">
      <div className="console-rule" aria-hidden="true" />
      <AnimatePresence mode="wait">
        {ticket ? (
          <motion.div
            key="ticket"
            className="ticket"
            initial={{ opacity: 0, y: 26 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -18 }}
            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            role="status"
          >
            <span className="ticket-stamp">PRINTED</span>
            <span className="ticket-line">
              {ticket.name.toUpperCase()}&apos;S FILM IS ROLLING. {ticket.duration}S. {" "}
              {providerConfigured
                ? "IT PREMIERES ON THIS WALL IN 3–10 MINUTES"
                : "QUEUED LOCALLY UNTIL THE WALL GOES LIVE"}
            </span>
          </motion.div>
        ) : (
          <motion.div
            key="entry"
            className="console-row"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className={`console-field ${stage === "name" ? "is-live" : name ? "is-stamped" : "is-idle"}`}>
              <span className="field-tag">01 YOUR NAME</span>
              {stage === "name" ? (
                <input
                  ref={nameRef}
                  className="field-input name-input"
                  value={name}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="who's directing?"
                  onChange={(event) => setName(event.target.value.slice(0, 40))}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.currentTarget.blur();
                    } else if (event.key === "Enter" || event.key === "Tab") {
                      event.preventDefault();
                      advanceFromName();
                    }
                  }}
                />
              ) : (
                <span className="field-stamp">{name.toUpperCase()}</span>
              )}
            </div>

            <div className={`console-field grow ${stage === "prompt" ? "is-live" : prompt ? "is-stamped" : "is-idle"}`}>
              <span className="field-tag">02 YOUR FILM</span>
              {stage === "prompt" ? (
                <input
                  ref={promptRef}
                  className="field-input"
                  value={prompt}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="describe a shot: subject, motion, light…"
                  onChange={(event) =>
                    setPrompt(event.target.value.slice(0, 500))
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === "Tab") {
                      event.preventDefault();
                      advanceFromPrompt();
                    } else if (
                      event.key === "Escape" ||
                      (event.key === "Backspace" && prompt.length === 0)
                    ) {
                      event.preventDefault();
                      setStage("name");
                      focusStage("name");
                    }
                  }}
                />
              ) : (
                <span className="field-stamp ellipsis">
                  {prompt ? `“${prompt}”` : "NOT SET"}
                </span>
              )}
            </div>

            <div
              className={`console-field duration ${stage === "duration" ? "is-live" : "is-idle"}`}
              ref={durationRef}
              role="radiogroup"
              aria-label="Film length in seconds. Use arrow keys."
              tabIndex={stage === "duration" ? 0 : -1}
              onKeyDown={durationKeys}
            >
              <span className="field-tag">03 LENGTH</span>
              <span className="duration-options">
                {DURATIONS.map((seconds, index) => (
                  <span
                    key={seconds}
                    role="radio"
                    aria-checked={index === durationIndex}
                    className={index === durationIndex ? "is-chosen" : ""}
                  >
                    {seconds}s
                  </span>
                ))}
              </span>
            </div>

            <div className={`console-go ${stage === "duration" ? "is-armed" : ""}`}>
              <kbd>↵</kbd>
              <span>{submitting ? "PRINTING…" : "ROLL FILM"}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="console-hints">
        <span className="hint-stage">STEP {stageNumber} OF 03</span>
        {notice ? (
          <span className="hint-notice" role="alert">
            {notice}
          </span>
        ) : (
          <span className="hint-keys">
            {stage === "name"
              ? "ESC TO UNFOCUS · TAB TO RETURN"
              : "ENTER TO CONTINUE · ESC TO GO BACK"}
            {stage === "duration" ? " · ←/→ TO CHOOSE" : ""}
          </span>
        )}
        <span className="hint-brand">FLUX 3 / TEXT TO VIDEO</span>
      </div>
    </section>
  );
}

/* ---------------------------------- */
/* Operator library (⌥L)               */
/* ---------------------------------- */

function DeleteVideoDialog({
  video,
  onDeleted,
}: {
  video: WallVideo;
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState(false);

  async function remove() {
    setDeleting(true);
    try {
      await api(`/api/videos/${video.id}`, { method: "DELETE" });
      onDeleted();
    } catch {
      setDeleting(false);
    }
  }

  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger asChild>
        <button className="lib-delete" type="button">
          DELETE
        </button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="dialog-overlay nested" />
        <AlertDialog.Content className="confirm-dialog">
          <AlertDialog.Title>Remove this film?</AlertDialog.Title>
          <AlertDialog.Description>
            It leaves the wall immediately. The file moves to the local trash
            folder, so it can be recovered.
          </AlertDialog.Description>
          <div className="confirm-actions">
            <AlertDialog.Cancel asChild>
              <button className="lib-button">KEEP</button>
            </AlertDialog.Cancel>
            <button
              className="lib-button danger"
              onClick={remove}
              disabled={deleting}
            >
              {deleting ? "REMOVING…" : "REMOVE"}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function LibraryDialog({
  open,
  onOpenChange,
  currentVideoId,
  onSkip,
  onLibraryChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentVideoId?: string;
  onSkip: () => void;
  onLibraryChanged: () => void;
}) {
  const [library, setLibrary] = useState<LibraryState | null>(null);
  const [tab, setTab] = useState<"videos" | "queue">("videos");

  const loadLibrary = useCallback(async () => {
    try {
      setLibrary(await api<LibraryState>("/api/library"));
    } catch {
      setLibrary(null);
    }
  }, []);

  async function retrySubmission(id: string) {
    try {
      await api(`/api/submissions/${id}/retry`, { method: "POST" });
      loadLibrary();
    } catch {
      /* the queue row keeps its failed state */
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="library"
          onOpenAutoFocus={() => void loadLibrary()}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              if (event.target instanceof HTMLInputElement) return;
              setTab((current) => (current === "videos" ? "queue" : "videos"));
            }
            if (event.key.toLowerCase() === "s" && currentVideoId) {
              onSkip();
            }
          }}
        >
          <header className="library-head">
            <div>
              <span className="lib-kicker">OPERATOR / THIS LAPTOP</span>
              <Dialog.Title className="lib-title">Reel library</Dialog.Title>
            </div>
            <div className="library-head-actions">
              {currentVideoId && (
                <button className="lib-button" onClick={onSkip}>
                  SKIP CURRENT <kbd>S</kbd>
                </button>
              )}
              <Dialog.Close asChild>
                <button className="lib-button">
                  CLOSE <kbd>ESC</kbd>
                </button>
              </Dialog.Close>
            </div>
          </header>

          <div className="lib-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={tab === "videos"}
              className={tab === "videos" ? "is-open" : ""}
              onClick={() => setTab("videos")}
            >
              SAVED FILMS ({library?.videos.length || 0})
            </button>
            <button
              role="tab"
              aria-selected={tab === "queue"}
              className={tab === "queue" ? "is-open" : ""}
              onClick={() => setTab("queue")}
            >
              GENERATION QUEUE ({library?.submissions.length || 0})
            </button>
            <span className="lib-tab-hint">←/→ TO SWITCH</span>
          </div>

          {tab === "videos" ? (
            library?.videos.length ? (
              <div className="lib-grid">
                {library.videos.map((video) => (
                  <article className="lib-card" key={video.id}>
                    <div className="lib-media">
                      <video
                        src={video.mediaUrl}
                        muted
                        playsInline
                        preload="metadata"
                      />
                      <span className="lib-reel">REEL {reelCode(video.id)}</span>
                    </div>
                    <div className="lib-copy">
                      <strong>{video.name.toUpperCase()}</strong>
                      <p>
                        {video.prompt || "From the opening-night collection"}
                      </p>
                      <div className="lib-meta">
                        <span>
                          {video.source === "generated"
                            ? "MADE TONIGHT"
                            : "SEED"}{" "}
                          · {video.playCount} PLAYS
                        </span>
                        <DeleteVideoDialog
                          video={video}
                          onDeleted={() => {
                            loadLibrary();
                            onLibraryChanged();
                          }}
                        />
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="lib-empty">
                <h3>No films yet</h3>
                <p>
                  Drop MP4s into <code>data/seed-videos</code> or take a prompt
                  at the console.
                </p>
              </div>
            )
          ) : (
            <div className="lib-queue">
              {!library?.providerConfigured && (
                <p className="lib-warning">
                  BFL API KEY NOT CONNECTED. PROMPTS ARE SAVED AND WAIT IN THE
                  QUEUE.
                </p>
              )}
              {library?.submissions.length ? (
                library.submissions.map((submission) => (
                  <article className="lib-row" key={submission.id}>
                    <span className="lib-row-name">
                      {submission.name.toUpperCase()}
                    </span>
                    <span className="lib-row-prompt">{submission.prompt}</span>
                    <span
                      className={`lib-status status-${submission.status}`}
                    >
                      {friendlyStatus(submission.status, submission.error)}
                    </span>
                    {["failed", "moderated", "needs_review"].includes(
                      submission.status,
                    ) && (
                      <button
                        className="lib-button"
                        onClick={() => retrySubmission(submission.id)}
                      >
                        RETRY
                      </button>
                    )}
                  </article>
                ))
              ) : (
                <div className="lib-empty">
                  <h3>The queue is clear</h3>
                  <p>New prompts appear here the moment they print.</p>
                </div>
              )}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ---------------------------------- */
/* The wall                           */
/* ---------------------------------- */

export default function Home() {
  const [currentVideo, setCurrentVideo] = useState<WallVideo | null>(null);
  const [wallState, setWallState] = useState<WallState>(EMPTY_STATE);
  const [rendering, setRendering] = useState<Submission[]>([]);
  const [serverOnline, setServerOnline] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("full");
  const [videoKey, setVideoKey] = useState(0);
  const currentVideoRef = useRef<WallVideo | null>(null);
  const historyRef = useRef<WallVideo[]>([]);
  const futureRef = useRef<WallVideo[]>([]);
  const advancingRef = useRef(false);
  const displayModeIsReadyRef = useRef(false);

  const playVideo = useCallback((video: WallVideo | null) => {
    currentVideoRef.current = video;
    setCurrentVideo(video);
    setVideoKey((key) => key + 1);
  }, []);

  const advanceVideo = useCallback(async (excludeId?: string) => {
    if (advancingRef.current) return;
    advancingRef.current = true;
    try {
      const result = await api<{ video: WallVideo | null }>(
        "/api/videos/next",
        {
          method: "POST",
          body: JSON.stringify({ excludeId }),
        },
      );
      const activeVideo = currentVideoRef.current;
      if (result.video && activeVideo && result.video.id !== activeVideo.id) {
        historyRef.current = [...historyRef.current, activeVideo].slice(-24);
        futureRef.current = [];
      }
      playVideo(result.video);
      setServerOnline(true);
    } catch {
      setServerOnline(false);
      playVideo(null);
    } finally {
      advancingRef.current = false;
    }
  }, [playVideo]);

  const goBack = useCallback(() => {
    const previousVideo = historyRef.current.pop();
    if (!previousVideo) return;

    const activeVideo = currentVideoRef.current;
    if (activeVideo) futureRef.current.unshift(activeVideo);
    playVideo(previousVideo);
  }, [playVideo]);

  const goForward = useCallback(() => {
    const nextVideo = futureRef.current.shift();
    if (nextVideo) {
      const activeVideo = currentVideoRef.current;
      if (activeVideo) historyRef.current.push(activeVideo);
      playVideo(nextVideo);
      return;
    }

    void advanceVideo(currentVideoRef.current?.id);
  }, [advanceVideo, playVideo]);

  const refreshState = useCallback(async () => {
    try {
      const state = await api<WallState>("/api/state");
      setWallState(state);
      setServerOnline(true);

      const activeVideo = currentVideoRef.current;
      if (activeVideo && !state.activeVideoIds.includes(activeVideo.id)) {
        currentVideoRef.current = null;
        setCurrentVideo(null);
        void advanceVideo(activeVideo.id);
      } else if (!activeVideo && state.videoCount > 0) {
        void advanceVideo();
      }

      if (queueTotal(state.queue) > 0) {
        const library = await api<LibraryState>("/api/library");
        setRendering(
          library.submissions
            .filter((submission) => ACTIVE_STATUSES.includes(submission.status))
            .sort(
              (first, second) =>
                Date.parse(first.createdAt) - Date.parse(second.createdAt),
            ),
        );
      } else {
        setRendering([]);
      }
      return state;
    } catch {
      setServerOnline(false);
      return null;
    }
  }, [advanceVideo]);

  useEffect(() => {
    const initial = window.setTimeout(() => void refreshState(), 0);
    const interval = window.setInterval(() => void refreshState(), 3_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [refreshState]);

  useEffect(() => {
    const savedMode = window.localStorage.getItem(DISPLAY_MODE_STORAGE_KEY);
    const restorePreference = window.setTimeout(() => {
      if (savedMode === "framed") setDisplayMode("framed");
      displayModeIsReadyRef.current = true;
    }, 0);
    return () => window.clearTimeout(restorePreference);
  }, []);

  useEffect(() => {
    if (!displayModeIsReadyRef.current) return;
    window.localStorage.setItem(DISPLAY_MODE_STORAGE_KEY, displayMode);
  }, [displayMode]);

  useEffect(() => {
    function keyboardShortcuts(event: KeyboardEvent) {
      if (
        event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.key === "ArrowLeft"
      ) {
        event.preventDefault();
        goBack();
        return;
      }

      if (
        event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.key === "ArrowRight"
      ) {
        event.preventDefault();
        goForward();
        return;
      }

      const libraryShortcut =
        (event.altKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          event.code === "KeyL") ||
        ((event.metaKey || event.ctrlKey) &&
          event.shiftKey &&
          event.code === "KeyL");
      if (libraryShortcut) {
        event.preventDefault();
        setLibraryOpen((open) => !open);
        return;
      }

      const target = event.target as HTMLElement | null;
      const isTyping =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        Boolean(target?.isContentEditable);
      if (
        event.key.toLowerCase() === "v" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !isTyping
      ) {
        event.preventDefault();
        setDisplayMode((mode) => (mode === "full" ? "framed" : "full"));
      }
    }
    window.addEventListener("keydown", keyboardShortcuts);
    return () => window.removeEventListener("keydown", keyboardShortcuts);
  }, [goBack, goForward]);

  const pendingCount = useMemo(
    () => queueTotal(wallState.queue),
    [wallState.queue],
  );
  const nowRendering = rendering[0];

  return (
    <main className={`wall view-${displayMode}`}>
      <header className="masthead" aria-label="Black Forest Labs and Nous Research">
        <div className="lockup">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="bfl-mark"
            src="/bfl-logotype-white.svg"
            alt="Black Forest Labs"
          />
          <span className="lockup-x" aria-hidden="true">
            ×
          </span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="nous-mark"
            src="/nous-girl.webp"
            alt="Nous Research"
          />
        </div>
        <div className="masthead-status">
          <nav className="operator-controls" aria-label="Wall controls">
            <div className="wall-presence">
              <span className={`live-dot ${serverOnline ? "" : "is-offline"}`} />
              <span>{serverOnline ? "LIVE" : "OFFLINE"}</span>
              <i aria-hidden="true" />
              <span>{wallState.videoCount} FILMS</span>
              {pendingCount > 0 && (
                <span className="in-motion">{pendingCount} RENDERING</span>
              )}
            </div>
            <button
              className="view-key"
              onClick={() =>
                setDisplayMode((mode) => (mode === "full" ? "framed" : "full"))
              }
              aria-pressed={displayMode === "full"}
              aria-label={`Switch to ${displayMode === "full" ? "framed" : "full"} view`}
            >
              {displayMode === "full" ? "FULL" : "FRAME"}
            </button>
            <button
              className="library-key"
              onClick={() => setLibraryOpen(true)}
              aria-label="Open the reel library"
            >
              LIBRARY <kbd>⌥L</kbd>
            </button>
          </nav>
        </div>
      </header>

      <div className="stage">
        <AnimatePresence mode="wait">
          {currentVideo ? (
            <motion.div
              key={`${currentVideo.id}-${videoKey}`}
              className="film-stack"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
            >
              <video
                className="film-glow"
                src={currentVideo.mediaUrl}
                autoPlay
                muted
                playsInline
                preload="auto"
                aria-hidden="true"
                tabIndex={-1}
              />
              <video
                className="film"
                src={currentVideo.mediaUrl}
                autoPlay
                muted
                playsInline
                preload="auto"
                onEnded={goForward}
                onError={() => advanceVideo(currentVideo.id)}
              />
            </motion.div>
          ) : (
            <motion.div
              key="holding"
              className="holding-slot"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.7 }}
            >
              <HoldingScreen />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <section className="credit-section" aria-label="Current film" aria-live="polite">
        <AnimatePresence mode="wait">
          {currentVideo && (
            <motion.div
              key={currentVideo.id}
              className="credit"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ delay: 0.3, duration: 0.5 }}
            >
              <span className="credit-reel">REEL {reelCode(currentVideo.id)}</span>
              {currentVideo.prompt && (
                <span className="credit-prompt">
                  “{currentVideo.prompt}”
                </span>
              )}
              <span className="credit-name">
                FILM BY {currentVideo.name.toUpperCase()}
                {currentVideo.source === "generated" &&
                  currentVideo.playCount <= 1 && (
                    <em className="premiere"> · WORLD PREMIERE</em>
                  )}
              </span>
            </motion.div>
          )}
        </AnimatePresence>
        {nowRendering && (
          <span className="rendering-note">
            NOW RENDERING / {nowRendering.name.toUpperCase()}
            {rendering.length > 1 ? ` +${rendering.length - 1} MORE` : ""}
          </span>
        )}
      </section>

      <Console
        providerConfigured={wallState.providerConfigured}
        onSubmitted={refreshState}
      />

      <LibraryDialog
        open={libraryOpen}
        onOpenChange={setLibraryOpen}
        currentVideoId={currentVideo?.id}
        onSkip={() => {
          setLibraryOpen(false);
          goForward();
        }}
        onLibraryChanged={refreshState}
      />
    </main>
  );
}
