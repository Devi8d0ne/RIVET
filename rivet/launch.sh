#!/usr/bin/env bash
# Foreground Linux entrypoint; no desktop, profile, package manager or network setup.
set -euo pipefail
umask 077
app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
toolchain_dir="${RIVET_TOOLCHAIN_DIR:-$app_dir/toolchain}"
if [[ -x "$toolchain_dir/bin/ffmpeg" || -x "$toolchain_dir/bin/ffprobe" ]]; then
  export PATH="$toolchain_dir/bin:$PATH"
fi
if [[ -x "$toolchain_dir/bin/android-ffmpeg" && -f "$toolchain_dir/android-codec" ]]; then
  export RIVET_ANDROID_FFMPEG="$toolchain_dir/bin/android-ffmpeg"
  IFS= read -r RIVET_ANDROID_CODEC < "$toolchain_dir/android-codec"
  export RIVET_ANDROID_CODEC
fi
if ! command -v python3 >/dev/null 2>&1; then
  printf 'RIVET needs Python 3.10 or later. Install your Linux python3 package.\n' >&2
  exit 1
fi
if ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))'; then
  printf 'RIVET needs Python 3.10 or later.\n' >&2
  exit 1
fi
if [[ ! -f "$app_dir/server.py" || ! -f "$app_dir/hardware.py" || ! -f "$app_dir/dist/index.html" ]]; then
  printf 'RIVET files are incomplete. Deploy server.py, hardware.py and the built dist directory.\n' >&2
  exit 1
fi
exec python3 -u "$app_dir/server.py" --port 8787 --dist "$app_dir/dist" --data "${RIVET_DATA:-$app_dir/data}" "$@"
