# RIVET

An offline video and audio sports production studio for Ubuntu and suitable Linux systems. Produce locally, keep recordings on your own machine, then explicitly stream or upload when a network is available. Android devices can host the Linux service in Ubuntu through Termux; the Fold5 is the current development device.

This is a new implementation inspired by the supplied SportsCaster and SportsStreamer reference projects. It is an initial release, with device performance and delivery to your chosen destination still requiring real-session validation. The intended mobile target is capable flagship hardware. Minimum supported hardware will be established by sustained recording and encoding benchmarks; there is no claim that every Android device can run the full studio reliably.

## Studio capabilities

- Video and audio together: camera, local video, audio and image sources; separate Preview and Program monitors; live switching; picture-in-picture; microphone and media mixing; voice ducking; and a local soundboard.
- Remembered camera and microphone choices: permitted device lists refresh automatically when opening Devices or when inputs change. After a page reload, **Reconnect inputs** restores the saved choices with one tap; the camera returns to Preview. Preferences stay in the same browser profile and local address across app updates. Clearing site data removes them, and revoked browser permission must be granted again. Missing or ambiguous devices are reported instead of silently selecting a different input.
- Sports presets: universal scoreboard, basketball, American football, soccer and pool/billiards, with relevant score shortcuts, fouls, down/distance, possession or race-to controls.
- Match graphics: team/player names, score undo, period/rack, count-up or countdown clock, live scorebug or matchup/intermission card, lower thirds, sponsor text, local artwork and replay segments.
- Local recording library, file downloads and browser-backed recovery of chunks that could not reach the local service. Recovery requires the same browser profile and origin; clearing browser storage removes that backup.
- Selectable production targets: 480p at 24 fps, 720p at 30 fps, or 1080p at 30 fps. These are requested settings, not measured performance guarantees. Choose between sessions; test the quality you actually need on the intended hardware.
- One to four explicit RTMP/RTMPS destinations using one H.264/AAC encode with FFmpeg's tee output for multiple destinations. A destination failure stops the broadcast; an independently running local recording continues. Encoder activity does not confirm audience delivery.
- Offline MP4 conversion queue with 360p, 480p, 720p and 1080p size options, file-size/quality choices, cancellation and retention of the original. Conversions run one at a time and new queued work waits while broadcasting is active. Interrupted conversions are marked for a new attempt rather than being represented as completed.
- Completed recordings can be queued for HTTPS `PUT` upload. A compatible server or signed object-storage link is required. The queue retries temporary failures and persists across service restarts. This is not an OAuth integration with video platforms.

Availability of individual camera, codec and screen-capture features depends on the browser and OS. The Fold5's Qualcomm H.264 hardware encoder has passed controlled local checks through the optional native Android adapter. Multicamera synchronization and native Android background capture remain future work.

The development verification report is in `rivet/VERIFICATION.md` in the source repository. It records the automated checks and the short recording/conversion/playback test on the actual Fold5; it does not establish full-event reliability.

## Local architecture

```text
Browser at http://127.0.0.1:8787
  camera + microphone + local media
                  ↓
     video compositor + audio mixer
          ├─ Preview / Program
          └─ local recording / broadcast chunks
                              ↓
                    Linux Python service
                      ├─ private recording library
                      ├─ offline FFmpeg conversion jobs
                      ├─ queued HTTPS PUT upload
                      └─ FFmpeg → 1–4 RTMP(S) destinations
```

All runtime fonts, scripts, styles and other UI assets are served from `dist`. There are no CDN imports, cloud accounts or remote AI dependencies for local production. Python's standard library is sufficient for the server; no Python packages are needed. FFmpeg enables conversions and live output.

The server binds only to loopback, using `127.0.0.1:8787` by default. Open that address in a compatible browser on the same device and grant camera/microphone permission. On Android, **use an Android browser for camera and microphone access**: PRoot does not directly own Android capture hardware. Termux:X11 and a Linux desktop are not needed. This release does not expose the studio to other devices on the LAN.

## Ubuntu or another suitable Linux system

Requirements: Python 3.10 or later, Bash, a browser supporting the necessary local media APIs, and enough storage for recordings. A Chromium-based browser is a useful starting point for testing. FFmpeg with `libx264` and AAC support is optional for local recording and required for conversion/live output. On Ubuntu with a healthy package database, prerequisites can be installed once while online:

```sh
sudo apt-get update
sudo apt-get install --no-install-recommends python3 ffmpeg
```

After obtaining a trusted release archive and checksum, verify it, extract into your home directory, and start the local server:

```sh
sha256sum -c rivet-0.1.0-linux.tar.gz.sha256
tar -xzf rivet-0.1.0-linux.tar.gz -C "$HOME"
bash "$HOME/rivet/launch.sh"
```

Then open `http://127.0.0.1:8787/`. The foreground server stops with Ctrl+C. Use a new directory for a first installation; follow the update guidance below for an existing installation. No public download URL is supplied until a release is published.

`RIVET_DATA=/path/to/library bash ~/rivet/launch.sh` selects another library directory. Server options such as `--port 8788` may be passed to `launch.sh`. The Termux convenience wrapper always uses the default 8787.

## Android through Termux and Ubuntu

Android setup needs internet access once to install missing prerequisites. No Android root is needed. Download or transfer the reviewed installer, release archive and its checksum to a directory Termux can read, then run:

```sh
bash ./install-rivet-termux.sh --launch
```

The installer automatically finds the single `rivet-*-linux.tar.gz` beside it. You may pass an archive path explicitly, and may pass the trusted release SHA-256 after it instead of using a companion `.sha256` file. Use `--launch` to start the service automatically after install.
A checksum detects a damaged or changed archive; obtain the installer and expected checksum from a trusted release source.

The installer:

- Installs Termux Python and `proot-distro` only if missing, and installs Ubuntu only when its rootfs is absent. Android itself must install Termux first.
- Reuses an existing Ubuntu installation. It never runs a blanket upgrade, reinstalls Ubuntu, or repairs unrelated unfinished package operations. Nonempty `dpkg --audit` output stops setup with a prerequisite message.
- Installs Ubuntu Python 3 and FFmpeg only when the corresponding commands are missing. Existing Python must be 3.10 or later.
- Verifies the release checksum and rejects links, traversal paths, duplicate names, oversized payloads and unexpected files in the archive before deploying it.
- Adds `~/start-rivet` and creates the `~/.shortcuts/RIVET` Termux:Widget script automatically.
- Refuses to overwrite an existing `/root/rivet` or Termux `~/start-rivet`. It is a first-install tool, not an updater. It does not start a broadcast or upload.

Installed layout:

```text
Termux:  ~/start-rivet
Ubuntu:  /root/rivet/server.py
         /root/rivet/launch.sh
         /root/rivet/dist/...
         /root/rivet/data/...
```

The start wrapper reuses a responding service, or starts Ubuntu with an explicit command that bypasses shell profiles. `~/start-rivet --no-open` checks or starts it without opening the browser. Logs and the launched process ID are under Termux `~/.local/state/rivet/`.

One-tap home launcher:

If you want a home-screen shortcut that starts the service:

If you are still in the installer folder you have:

```sh
bash ./scripts/install-rivet-shortcut.sh
```

If you already ran the Termux installer, run:

```sh
bash ~/.local/bin/install-rivet-shortcut
```

If you get a “No such file” / “not found” message, it means the shortcut installer is not in your current directory. Use the absolute path above (or `cd` to the directory that contains it) and run again.

It creates `~/.shortcuts/RIVET` in Termux. If **Termux:Widget** is installed, add that widget to your Android home screen and pick **RIVET**.
If you use `--no-open`, it starts only the backend; otherwise it opens `127.0.0.1:8787` in your default browser.

This repo currently includes a prior Termux:Widget verification failure log; install the widget from a trusted channel if needed for your environment.

If you want the studio to open as soon as you run install and when you open your Termux launcher, use:
```sh
bash ./install-rivet-termux.sh ./rivet-0.1.0-linux.tar.gz --launch
```

For a foreground session, when another service is not already using port 8787:

```sh
proot-distro login ubuntu -- /usr/bin/env -u BASH_ENV /bin/bash --noprofile --norc /root/rivet/launch.sh
```

Keep Termux and the browser running throughout a session. Android can suspend background processes, and screen locking or heat can interrupt capture. Validate the required event duration with the device, camera, quality profile and power setup you will use.

## Optional Android hardware encoding

Ordinary Linux defaults to its CPU FFmpeg encoder. Android acceleration is opt-in through a local native Termux FFmpeg adapter and a named vendor H.264 codec; listing an encoder alone is insufficient. On the development Fold5, `c2.qti.avc.encoder` has encoded and decoded the expected frames in short 480p/24, 720p/30 and 1080p/30 checks. A generated ten-second 720p run decoded all 300 frames. The application also completed a hardware conversion and sent H.264/AAC to two simultaneous localhost RTMP receivers. These are controlled tests, not full-event or other-device performance guarantees.

The reviewed adapter source is `scripts/android-ffmpeg` in the repository. It invokes native Termux FFmpeg with Android system libraries before Termux's namespace stubs. Native Termux FFmpeg is a separate optional prerequisite; install it only when missing. The portable runtime does not automatically discover or configure Android adapters. The Fold5 deployment helper only copies the already-tested adapter from the existing Ubuntu installation.

For a manually prepared adapter, `launch.sh` accepts `RIVET_ANDROID_FFMPEG` and `RIVET_ANDROID_CODEC` environment variables. A persistent toolchain uses `bin/android-ffmpeg` plus a private `android-codec` text file containing the exact codec name. Place it in `/root/rivet/toolchain` for the Ubuntu copy, or `~/.local/share/rivet/toolchain` for the desktop app. Do not copy a Qualcomm codec choice to another device and assume it works: run **Check hardware** and inspect the verified sizes first.

The launcher reads this configuration at startup. In **Auto** mode, unverified sizes use CPU encoding. **Android** mode rejects an unverified size rather than silently switching to CPU. Both modes report the chosen encoder. The hardware adapter accelerates encoding; it does not give a browser inside PRoot direct camera/microphone access.

## Files, recovery and network behavior

The direct Linux/Termux-Ubuntu runtime defaults to `rivet/data` beside the server; the desktop installer uses its separate `~/.local/share/rivet/data` directory as described above. Original recordings, converted files, recording metadata and queue state are kept in the selected library. Back up that directory while capture, conversion and upload work are stopped.

Browser recording chunks are backed up in IndexedDB before being submitted to the local service. Library **Recover recordings** resubmits pending chunks and finishes those sessions after the service returns. Available browser storage limits this backup; it does not make browser or OS shutdown lossless.

Internet availability alone never starts a live broadcast. The operator supplies destinations and starts it explicitly. A queued upload authorizes later retries when its destination becomes reachable. The destination URL must accept the raw recorded file in an HTTPS `PUT` request and remain valid long enough for delivery; a platform channel or upload webpage does not meet that contract. Uploads retry while the service is running, and pending queue state survives restarts.

Request logs and public status lists do not contain stream keys or upload destination URLs. Pending upload URLs remain in private metadata so retries can survive a restart. FFmpeg receives RTMP destinations as process arguments; someone able to inspect the app's processes or private files can access those details.

## Build, package and update

For development, build the frontend, then create a runtime archive from the repository root:

```sh
npm --prefix rivet ci
npm --prefix rivet run build
python scripts/package-rivet.py rivet-0.1.0-linux.tar.gz
```

The package command emits the archive, prints its SHA-256, writes `rivet-0.1.0-linux.tar.gz.sha256`, and places `install-rivet-termux.sh` beside them. It includes `server.py`, `hardware.py`, `launch.sh`, this README, built `dist` assets, and Termux launch/install scripts. Node.js and frontend dependencies are build tools, not end-user runtime requirements.

Recordings, queue metadata, reference projects, development dependencies and device-specific `toolchain` files are excluded. For an update, stop the existing RIVET server, back up `data`, and replace only the packaged application files. Preserve `data` and any existing `toolchain` directory. The Termux/Ubuntu first-install script intentionally refuses updates. The repository's `deploy_phone.py` can transfer individual reviewed files to the dedicated Termux/Ubuntu paths with SHA-256 verification.

`launch.sh` prepends `rivet/toolchain/bin` to its process PATH when an executable FFmpeg or ffprobe wrapper is present there. This supports an isolated device-specific encoder without changing Ubuntu's package database. These wrappers are not part of the portable release. The development phone's existing Ubuntu package database contains unrelated unfinished configuration; do not use `dpkg --configure -a` as a RIVET installation step.

## Validation before an event

1. With internet disconnected, capture a short show containing video, audible microphone/media audio and changing sports graphics. Stop it and play the saved result.
2. Restart the service, confirm the library remains available, and exercise browser-backed recovery with a controlled interrupted local save.
3. Convert a test recording while offline and play the MP4. Confirm the original remains accessible.
4. Measure the full required session length on the intended hardware. Record actual frame rate, audio synchronization, heat, battery behavior and storage consumption; profile labels alone do not establish support.
5. Separately test the authorized RTMP(S) destination and HTTPS upload link. Check destination playback and exercise network interruption. Unit tests and simulated browser capture cannot prove sustained hardware performance or delivery to a remote platform.
