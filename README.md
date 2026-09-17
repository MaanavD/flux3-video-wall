# FLUX 3 Video Wall

A local, projector-ready video wall that turns typed prompts into FLUX 3 films — built by Black Forest Labs to demo FLUX 3 live at events, booths, or meetups.

The entire application runs on one laptop. The only external traffic is the submission, polling, and MP4 download flow against the BFL API.

## First-time setup

1. Copy `.env.example` to `.env.local`.
2. Add your BFL API key to `BFL_API_KEY`.
3. Add a model version to `BFL_MODEL_VERSION` if you're pinning one.
4. Drop the starting MP4 files into `data/seed-videos`.
5. Run `npm run local`.
6. Open [http://localhost:3000](http://localhost:3000) and move the window to the projector.

The local API runs at `http://127.0.0.1:8788`.

## Starting videos

Any MP4 placed in `data/seed-videos` is imported automatically. The app rescans the folder every ten seconds.

If there is no manifest entry, the film is credited to `Black Forest Labs`. Edit `data/seed-videos/manifest.json` to add a creator, prompt, and duration:

```json
[
  {
    "file": "forest-film.mp4",
    "name": "Maya",
    "prompt": "A glass forest growing in the rain",
    "duration": 10
  }
]
```

The manifest is optional.

## Console controls

The console at the bottom walks each person through three stages: name, film,
length. It is built for the keyboard, but every step also takes a click: the
name and film fields, the length options and `ROLL FILM`.

- Typing anywhere lands in the current field. People just walk up and type.
- `Enter` (or `Tab`) moves to the next stage. `Esc` (or `Backspace` on an
  empty field) goes back.
- The name is typed once. After a film is sent the console keeps it stamped on
  and reopens at the film field, so a second prompt takes one line of typing.
  `Esc` from the film field (or a click on the name) changes it.
- On the length stage, arrow keys pick 5 / 10 / 15 / 20 seconds and `Enter`
  submits ("ROLL FILM"). A printed ticket confirms, then the console returns to
  the film field with the name still on it.
- A half-finished entry clears itself after 90 seconds of no typing.
- Press `Control + Shift + L` or `Command + Shift + L` to toggle the operator
  library. Arrow keys switch tabs, `S` skips the current film, `Esc` closes.
- Press `Control + Shift + M` or `Command + Shift + M` to switch playback mode.
- Press `Option + F` (`Control + Shift + F` / `Command + Shift + F`, or the
  `FULLSCREEN` button) for cinema: the browser goes fullscreen and the console,
  feed, credits and header disappear, leaving only the film. `F` on its own
  works too when no field has focus. Move the mouse to reveal the exit key;
  `Esc` leaves cinema.
- Delete moves an MP4 into `data/trash` and removes it from playback.

## Local data

- `data/wall.sqlite` stores prompts, queue state, provider task IDs, and playback history.
- `data/videos` stores every completed FLUX 3 generation.
- `data/seed-videos` stores the starting collection.
- `data/trash` stores videos removed through the interface.

## Playback modes

The button in the top-right switches how the wall chooses what plays next
(`Control + Shift + M`, or `Option + M`). The choice is remembered on this
laptop.

- **ALL FILMS** is the house playlist: shuffle rounds where every active video
  is selected once in a random order before the next round begins. New videos
  join the current round, so they appear without causing older videos to be
  overplayed.
- **LATEST** puts the newest films first. A film that finishes rendering plays
  next instead of waiting out the round, so the person who typed it sees it
  within a film or two. It cycles the newest six rather than looping one file,
  so the wall keeps moving in a quiet room. Set `WALL_RECENT_WINDOW` in
  `.env.local` to change how many that is.

LATEST also opens a feed down the right-hand side: films still rendering, then
the most recent ones, newest at the top. Clicking any film plays it
immediately. Renders that fail or get moderated stay in the feed for fifteen
minutes so nobody is left wondering where their film went. `HIDE` closes the
feed; switching modes brings it back.

## Several walls, one library (Supabase)

At an event with more than one Mac, every wall can show every film. Each Mac
still runs its own local server, its own SQLite and its own playback; on top
of that the server pushes finished films and in-flight prompts to Supabase
and pulls everyone else's down. Films from other walls are downloaded once
into `data/videos`, so playback never depends on the venue Wi-Fi.

Setup, once per project:

1. Apply `supabase/migrations/20260917120000_video_wall_shared.sql` to the
   Supabase project (two tables and a private bucket). With the CLI linked to
   the project: `supabase db query --linked -f supabase/migrations/20260917120000_video_wall_shared.sql`.
2. On every Mac, add to `.env.local`:

   ```
   SUPABASE_URL=https://<project>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<service role key>
   SUPABASE_BUCKET=video-wall
   WALL_ID=wall-1          # a short name per Mac: wall-1, wall-2, wall-3
   ```

3. Restart `npm run local`. The startup log says `Shared wall "wall-1": syncing…`.

How it behaves:

- A prompt is rendered by the Mac it was typed on. The other walls see it in
  the LATEST feed as rendering, then as a film, within a few seconds of it
  finishing.
- Deleting a film in the library removes it on every wall.
- Retrying a failed film only works on the wall that took it.
- Seed videos stay local: copy `data/seed-videos` to each Mac.
- With one BFL key shared by all Macs, the per-key concurrency is split.
  A synced wall defaults to `BFL_CONCURRENCY=3`; set it explicitly if you
  use one key per Mac.
- Leave the Supabase variables empty and the wall runs fully local as before.
- `GET /api/health` shows the sync state (`lastPullAt`, `lastError`).

## Default generation request

- Text to video only (`mode: t2v`)
- 16:9
- HD resolution
- Audio on (synchronized generation) — the wall stays muted until the first keystroke or tap, since browsers block unmuted autoplay before a user gesture
- User-selectable duration from 5 to 20 seconds
- Default duration of 10 seconds

Requests go to `https://api.bfl.ai/v1/flux-3-video` at `hd` resolution with eight concurrent jobs. Set `BFL_RESOLUTION=fhd` in `.env.local` for full-HD output (defaults to five concurrent jobs instead).

Set `WALL_RECENT_WINDOW` in `.env.local` to change how many of the newest films
the LATEST mode cycles through. It defaults to six.

## Useful commands

- `npm run local`: start the wall and local API together
- `npm run dev`: start only the visual interface
- `npm run api`: start only the local API and generation worker
- `npm run build`: verify the visual interface
- `npm test`: build and test the rendered wall shell
