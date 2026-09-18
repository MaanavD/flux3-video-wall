# FLUX 3 Video Wall

A local, projector-ready video wall that turns typed prompts into FLUX 3 films — built by Black Forest Labs to demo FLUX 3 live at events, booths, or meetups.

The entire application runs on one laptop. The only external traffic is the submission, polling, and MP4 download flow against the BFL API.

## First-time setup

For the download-and-launch bundles, follow [the nontechnical setup guide](scripts/RELEASE-README.md). They include the runtime and ten starting films.

To run from source:

1. Install Node.js 24 LTS from https://nodejs.org/.
2. Download and extract this repository, then open a terminal in the extracted folder.
3. Run `npm ci` once to install the locked dependencies.
4. Run `npm run local -- --open`. Paste the BFL API key when prompted and press Enter. The key stays hidden while entering it and is saved locally; no `.env` editing is needed.
5. Leave the terminal open. The browser opens after startup, using a free port if 3000 is occupied. Press Ctrl+C in the terminal to stop.

The ten included starting films are imported automatically. New generations use the account's BFL API credits. The key must have FLUX 3 video access.

To replace a saved key from source, run `npm run local -- --change-key --open`. Advanced settings remain optional in `.env.local`; see `.env.example`.

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

The console at the bottom is keyboard only. It walks each person through three
stages: name, film, length.

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
