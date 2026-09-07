# RIVET local studio

The owner's StreamWorks.GG/SportsCaster and SportsStreamer folders were inspected read-only. RIVET is a local Linux studio with video and audio together, usable from Android browsers. The Fold 5 is the development device; the target includes other Android devices with the required browser capabilities.

## Reference and visual system

The owner accepted the generated studio concept on September 7, 2026, then rejected its working name, FoldCast, and requested a stronger name unrelated to the device or Codex. The implementation uses RIVET and a geometric R mark. The original concept remains the layout and color reference, not the final naming reference.

Concept: C:/Users/fhold/.codex/generated_images/01a07cff-bf14-7352-91eb-39d08ea5190f/exec-d0936e56-0955-4526-838b-64e5374dafc1.png

Tokens: charcoal #101114, panel #191b21, border #303238, orange #ff8c42, purple #ae6bfa, text #f2f1ee, muted #92969e. Barlow Condensed bold forms the wordmark and canvas slate; Inter supplies the controls. Both fonts and their licenses ship locally. Panels use 8–12px radii, major controls have at least 44px targets, and spacing follows an 8px base.

The orange R symbol is a native SVG with an angular bowl, open counter, and diagonal leg. The same asset appears in the desktop rail, mobile header, and SVG favicon. Browser and touch-icon PNGs are rendered from this SVG, so there are no remote branding assets.

## Fidelity ledger

| Element | Implementation | Basis |
| --- | --- | --- |
| Working name | RIVET, replacing FoldCast in visible UI and program graphics | User rejected the device-themed name and requested a proper logo and favicon. |
| Studio structure | Studio/Library/Output rail; title and transport; paired Preview/Program; source strip; mixer; soundboard; right-side controls | Preserves the accepted concept's hierarchy and visual system. |
| Canvas slate | Large centered RIVET wordmark, subtitle, orange underline | Preserves the concept; removes unrequested tiny studio labels. |
| Scorebug | Larger readable team names, scores and clock, with sport-specific metadata | Supports the user's request for interactive sports broadcasting widgets. |
| Widget controls | Universal, basketball, American football, soccer, pool; scoring undo, fouls, down/distance, race-to, possession, count-up/down clock | Added through the user's requested sports-widget scope. |
| Graphics and sources | Matchup/intermission card, lower third, sponsor, replay badge, and optional video/image inset | Added through the user's requested local Streamer-style production scope. |
| Responsive layout | Paired monitors stay visible on narrow phones; navigation moves to the bottom; controls stack below. At unfolded widths, control panels share columns. | Adapts the accepted desktop concept to the expanded Android target. |
| Quality | 480p/24, 720p/30, or 1080p/30 targets | Supports a wider Android hardware range without claiming universal performance. |
| Device access | Explicit camera/microphone permission and discovery, selectable inputs, actual capture settings, reported zoom/torch controls, and supported mic processing | Added for the user's phone-access request. Input replacement/removal is locked during recording, streaming, and replay. |
| Encoder status | Explicit local hardware check and Automatic/CPU/Android preference, with unavailable options disabled | Displays the local service's verification result; browser recording is described separately. |
| Linux environment | Termux launches the local service inside Ubuntu PRoot; the Android browser owns camera and microphone permission | Keeps one tested Android path while preserving a portable Linux runtime. |
| Local workflows | Recording library, recovery, MP4 conversion, explicit upload queue, manual RTMP destinations | Same visual system; requested offline production with optional network delivery. |

Internal foldcast directory names, storage keys, and API identifiers remain stable across the visible rebrand. Fonts, icons, media composition, and controls make no external asset requests. Live destinations and upload links remain user supplied.

## Verification

Desktop Chromium tests verify source import, preview/program audio routing, local A/V recording and replay, MP4 conversion, sport controls, countdown, sponsorship, and picture-in-picture. Desktop 1536×1024, unfolded 768×900, and phone 390×844 views have no horizontal overflow. Camera and microphone tests use browser test devices; actual Android performance and platform delivery require device-specific verification. The RIVET rebrand is checked by a production build, local favicon loads, and desktop/phone screenshots.
Device tests also verify no automatic permission requests or enumeration, release of temporary discovery tracks, camera/mic replacement and removal, recorded-output input locks, processing changes, and final track cleanup. Frontend hardware-status tests use a documented API fixture; these tests do not assert that Android hardware was available on the desktop test machine.
