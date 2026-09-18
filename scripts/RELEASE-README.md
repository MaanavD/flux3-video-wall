# FLUX 3 Video Wall

The download includes the app, its runtime, and ten starting films. No Node.js, npm, code editor, or separate video download is needed. An internet connection and a BFL API key with FLUX 3 video access and available credits are needed to generate new films.

## First launch

1. Download the ZIP for the computer: `mac-arm64.zip` for a Mac with an M1 or newer chip, or `win-x64.zip` for a Windows PC with an Intel or AMD processor. On a Mac, Apple menu > About This Mac shows the chip. These downloads do not cover Intel Macs or Windows on ARM.
2. Extract the ZIP. On Mac, double-click it. On Windows, right-click it and choose **Extract All**. Keep the extracted folder together; do not move just the launcher out of it or run it inside the ZIP.
3. Open **Launch FLUX 3 Wall.command** on Mac or **Launch FLUX 3 Wall.bat** on Windows. If macOS blocks this unsigned launcher, open System Settings > Privacy & Security and use **Open Anyway** for this launcher, then confirm. If Windows shows SmartScreen, use **More info > Run anyway** only for the ZIP downloaded from this repository. A managed work computer may require IT approval.
4. When the terminal asks, paste the BFL API key and press Enter. Nothing appears while the key is pasted; this is intentional. The key stays in `app/.env.local` on this computer. Setup itself does not generate or charge for a film.
5. Wait for the browser to open. The starting films play automatically. Leave the terminal window open while using the wall.

An empty key stops setup without saving it. Launch again to try again. Saving a key does not verify that the account has video access or credits; the first generation checks that.

## Make a film

1. Click the name field at the bottom, type a display name, and press Enter.
2. Type a description of the film and press Enter. For example: `A red paper boat floats down a quiet stream in warm afternoon light.`
3. Use the left and right arrow keys to choose 5, 10, 15, or 20 seconds. Press Enter to submit. Each submitted film uses the BFL account's API credits.
4. The starting films keep playing while the new one generates. Open **Library > Generation Queue** to see its status. Once ready, the new film joins the playlist automatically.

For a projector, move the browser window onto the projector display and use the browser's full-screen option. Click or type once to enable audio, and check the computer's volume.

## Stop and start again

Click the terminal window and press **Ctrl+C** to stop both parts of the app. On the next launch, double-click the same launcher. The saved key and films stay on this computer.

## Change a key

Stop the wall. Delete only `app/.env.local` from the extracted folder, then launch again to enter the new key. On Mac, press **Command+Shift+.** in Finder to show hidden files. Deleting this file resets any advanced settings in it, but does not delete saved films. Do not share this file or the whole used app folder with someone else; share the original ZIP instead.

## If something does not work

- **The browser did not open:** copy the `Video wall ready:` address from the terminal into the browser. The launcher picks a free browser port if port 3000 is already in use.
- **Port 8788 is in use:** stop the other video wall terminal with Ctrl+C, then launch again.
- **The queue says BFL returned 401 or 403:** check the key and ask the BFL account owner whether it has FLUX 3 video access. A 402 response indicates an account or credit issue. Do not keep retrying before resolving the error.
- **A film failed or timed out:** read its error in Generation Queue. A timeout alone does not establish the cause. Retrying submits a new request and may use more credits.
- **The download is blocked by company policy:** ask IT rather than disabling the computer's security settings.

## Linux

Extract the matching Linux ZIP, open a terminal in its folder, and run `./launch.sh`. The key prompt and browser flow are the same.

## Source

https://github.com/MaanavD/flux3-video-wall
