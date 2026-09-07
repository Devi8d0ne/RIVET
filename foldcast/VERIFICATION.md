# RIVET development verification

Validation recorded on 2026-09-07. These results establish a working local production path on the development Fold5 and document the automated checks completed so far. They do not certify event-length recording or remote platform delivery.

## Automated checks

| Check | Reported result |
| --- | --- |
| Python server and hardware suites | 38 tests passed, including authenticated encoder selection, explicit hardware failure, timeout/cancellation and actual decoded-frame checks. |
| JavaScript capture/recovery suite | 7 tests passed. |
| Studio engine checks | 50 checks passed; 7 device-control UI flows also passed with controlled browser sources. |
| Remembered input regression | 51 engine checks and 8 rendered UI flows passed with controlled Chromium inputs: picker reopen, full reload, changed update query, exact-ID and unique-label restoration, redacted lists, missing devices, permission denial, storage failures, cancellation and output-lock races. The existing 50 media/device checks also passed after this change. |
| Release packaging/security suite | 4 tests passed, including adversarial archive cases for links, traversal, duplicate names and private runtime files. |
| Browser layout/runtime checks | Three viewport sizes checked; no page overflow, external asset requests or runtime errors observed in those runs. |
| Launcher/installer syntax | Three Bash scripts passed syntax checks; the first-install script was not executed on the development phone. |

The package checks verify reproducible release content and SHA-256 output, exclude recording data and device-specific toolchains, and exercise the installer archive validator without invoking package managers. Automated browser/capture checks use controlled sources and do not prove camera or microphone behavior on every device.

Remembered inputs were checked in Playwright/Chrome at 1536 × 1024 and 390 × 844 because the Browser plugin was unavailable. The page identity and meaningful UI were correct, both layouts fit, and no framework overlay, JavaScript errors or external asset requests were observed. Reconnect restored one camera and microphone while leaving Program on the slate. A browser reload is needed to load a newly deployed UI; old, unsaved input choices cannot be recovered after the old page has already been discarded.

## Actual Fold5 recording and conversion

The phone ran Android Chrome as the local studio interface and Ubuntu PRoot in Termux as the Python/FFmpeg backend. The controlled program source was the studio slate with a changing clock, plus triggered chime and sting sounds. The recording lasted approximately nine seconds.

| Artifact/check | Observed result |
| --- | --- |
| Original local recording | 496,440 bytes; 1280 × 720; approximately 9.03 seconds; browser recording configured for WebM VP8/Opus. |
| On-phone conversion | 720p MP4 job completed; output 80,437 bytes. |
| Converted-file playback | Browser reported 1280 × 720 and duration 9.033333 seconds; playback time advanced. |
| Converted-file probe | FFprobe confirmed H.264 video and AAC audio, 30/1 video frame rate and duration 9.033333 seconds. |
| Converted audio signal | FFmpeg volume detection reported mean −37.7 dB and maximum −16.8 dB, confirming a non-silent audio signal in the converted file. |

This checks real phone recording, local persistence, on-phone conversion, browser playback and a non-silent encoded audio track. The controlled soundboard signal is not a test of the phone microphone or a substitute for listening and synchronization checks with real capture.

The UI now carries the RIVET name, with local `icon.svg`, `favicon-32.png` and `apple-touch-icon.png` assets. Internal `foldcast` filenames, paths and API names remain unchanged.

## Actual Android hardware encoder checks

The native Termux FFmpeg adapter invoked the Fold5 vendor codec `c2.qti.avc.encoder` explicitly through MediaCodec NDK mode, with NV12 input and VBR H.264 output. Startup probes verified the actual decoded frames at 480p/24 fps, 720p/30 fps and 1080p/30 fps. A separate ten-second 720p H.264/AAC test decoded all 300 video frames and reported approximately 5.72× encoding speed for that generated input.

RIVET then completed a 720p hardware conversion of the controlled recording. Application broadcasting to **two simultaneous localhost RTMP receivers** also passed; both received playable H.264/AAC video at 1280 × 720 with duration 9.033 seconds. This verifies local multi-output encoding and transport. No external platform delivery was attempted. Device evidence was recorded under Termux `~/.local/state/rivet-hardware-tests/app-pipeline/`, including `multi-output-result.json`.

These short generated-media and controlled-recording checks do not establish camera capture quality, sustained frame rate, battery life, thermal stability or minimum hardware requirements. The optional adapter's success on this Fold5 does not establish support on other Android devices.

## Remaining device and delivery validation

- Record the actual rear/front camera and microphone, then check audible audio, synchronization and camera switching on the phone.
- Run sustained recording, replay and encoding sessions at the required quality while measuring frame rate, thermal behavior, battery use and storage consumption. Minimum supported hardware remains undetermined.
- Test authorized RTMP/RTMPS destinations and generic HTTPS PUT uploads, including network interruption and recovery. No remote platform broadcast was used for these checks.
- Validate another Ubuntu computer and additional Android hardware before expanding the compatibility claim.

The controlled tests establish working hardware encoding on this Fold5. Full-game reliability, external platform delivery and support across other Fold or Android devices remain unverified.
