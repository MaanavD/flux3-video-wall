# FLUX 3 Video Wall

## Quick start

**Mac:** the first launch needs one manual approval since this isn't a signed/notarized app — **right-click "Launch FLUX 3 Wall.command" → Open**, then click "Open" on the dialog. (Double-clicking directly will refuse to open the first time — that's macOS Gatekeeper, not a bug.) Every launch after that works with a normal double-click.

**Windows:** double-click **Launch FLUX 3 Wall.bat**. If SmartScreen says "Windows protected your PC," click **More info → Run anyway** (same one-time-approval idea as Mac).

**Linux:** most file managers won't execute a `.sh` on double-click, so open a terminal in the extracted folder and run `./launch.sh`.

1. Launch it (see above).
2. First run: paste your BFL API key when prompted (get one at [api.bfl.ai](https://api.bfl.ai)). Press Enter to skip and add it later.
3. Your browser opens the video wall. Type a prompt at the console at the bottom to generate a film.

No Node, npm, or anything else to install — everything needed is bundled in the `app/` folder.

## Stopping

Close the terminal window (Mac) or the two node windows (Windows), or press Ctrl+C.

## Changing your API key later

Edit `app/.env.local` and relaunch.

## Source

Full source: https://github.com/MaanavD/flux3-video-wall
