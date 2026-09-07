#!/data/data/com.termux/files/usr/bin/bash
# One-command setup from a reviewed local RIVET release; never starts a broadcast.
set -euo pipefail
umask 077

usage() {
  cat <<'USAGE' >&2
Usage: bash install-rivet-termux.sh [RELEASE.tar.gz] [EXPECTED_SHA256] [--launch] [--no-open]
If RELEASE.tar.gz is omitted, the installer finds the single rivet-*-linux.tar.gz beside itself.
Without EXPECTED_SHA256, the companion RELEASE.tar.gz.sha256 is required.
Use --launch to start RIVET after install.
Use --no-open to skip opening http://127.0.0.1:8787 in the browser.
USAGE
}

if [[ -z "${PREFIX:-}" || -z "${HOME:-}" ]] || ! command -v pkg >/dev/null 2>&1; then
  printf 'Run this installer inside Termux. On ordinary Ubuntu, extract the runtime and run launch.sh.\n' >&2
  exit 1
fi

release=""
expected=""
launch_after_install=false
open_in_browser=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --launch)
      launch_after_install=true
      ;;
    --no-open)
      open_in_browser=false
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --*)
      printf 'Unknown option: %s\n' "$1" >&2
      usage
      exit 2
      ;;
    *)
      if [[ -z "$release" ]]; then
        release="$1"
      elif [[ -z "$expected" ]]; then
        expected="$1"
      else
        usage
        exit 2
      fi
      ;;
  esac
  shift
done

if [[ -z "$release" ]]; then
  installer_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
  shopt -s nullglob
  release_candidates=("$installer_dir"/rivet-*-linux.tar.gz)
  shopt -u nullglob
  if [[ ${#release_candidates[@]} -ne 1 ]]; then
    printf 'Keep this installer beside exactly one rivet-*-linux.tar.gz release, or pass its path explicitly.\n' >&2
    exit 1
  fi
  release="${release_candidates[0]}"
fi
if [[ ! -f "$release" ]]; then
  printf 'The local release archive does not exist.\n' >&2
  exit 1
fi
if [[ -e "$HOME/start-foldcast" || -L "$HOME/start-foldcast" ]]; then
  printf 'An existing ~/start-foldcast was found. This first-install script does not overwrite it.\n' >&2
  exit 1
fi

if [[ -z "$expected" && -f "${release}.sha256" ]]; then
  read -r expected _ < "${release}.sha256" || true
fi
if [[ ! "$expected" =~ ^[a-fA-F0-9]{64}$ ]]; then
  printf 'Provide the release SHA-256 or its companion .sha256 file.\n' >&2
  exit 1
fi

stage="$(mktemp -d "${TMPDIR:-$PREFIX/tmp}/foldcast-install.XXXXXXXX")"
cleanup() { rm -rf -- "$stage"; }
trap cleanup EXIT
cp -- "$release" "$stage/release.tar.gz"
actual="$(sha256sum "$stage/release.tar.gz")"
actual="${actual%% *}"
if [[ "${actual,,}" != "${expected,,}" ]]; then
  printf 'Release SHA-256 mismatch. Installation stopped.\n' >&2
  exit 1
fi

missing=()
command -v python >/dev/null 2>&1 || missing+=(python)
command -v proot-distro >/dev/null 2>&1 || missing+=(proot-distro)
if [[ ${#missing[@]} -gt 0 ]]; then
  audit="$(dpkg --audit)"
  if [[ -n "$audit" ]]; then
    printf 'Termux has unfinished package operations. Resolve those separately before installing RIVET.\n' >&2
    exit 1
  fi
  pkg install -y "${missing[@]}"
fi

# Validate every member before extracting anything. Only regular release files
# are allowed; no links, devices, absolute paths, traversal, duplicates or data.
python - "$stage/release.tar.gz" "$stage" <<'FOLDCAST_ARCHIVE_PY'
from pathlib import Path, PurePosixPath
import sys
import tarfile

archive_path, destination = Path(sys.argv[1]), Path(sys.argv[2]).resolve()
fixed = {"foldcast/server.py", "foldcast/hardware.py", "foldcast/launch.sh", "foldcast/README.md",
         "foldcast/termux/start-foldcast", "foldcast/termux/install-foldcast-termux.sh",
         "foldcast/termux/install-rivet-termux.sh", "foldcast/termux/install-foldcast-shortcut.sh"}
required = fixed | {"foldcast/dist/index.html"}
members, names, total = [], set(), 0
with tarfile.open(archive_path, mode="r:gz") as archive:
    for member in archive:
        name = member.name
        path = PurePosixPath(name)
        if (not member.isfile() or path.is_absolute() or ".." in path.parts
                or "\\" in name or name != path.as_posix()
                or any(ord(char) < 32 for char in name) or name in names
                or not (name in fixed or name.startswith("foldcast/dist/"))
                or member.size < 0 or member.size > 64 * 1024**2):
            raise SystemExit("Unsafe or unsupported release archive member; installation stopped.")
        names.add(name)
        members.append(member)
        total += member.size
        if len(members) > 10000 or total > 256 * 1024**2:
            raise SystemExit("Release archive exceeds the installer size limit.")
    if not required.issubset(names):
        raise SystemExit("Release archive is missing required runtime files.")
    for member in members:
        target = destination / member.name
        target.parent.mkdir(parents=True, exist_ok=True)
        with archive.extractfile(member) as source, target.open("xb") as output:
            while chunk := source.read(1024 * 1024):
                output.write(chunk)
        target.chmod(0o700 if target.name in {"launch.sh", "start-foldcast", "install-foldcast-termux.sh", "install-rivet-termux.sh", "install-foldcast-shortcut.sh"} else 0o600)
print("Release archive validated.")
FOLDCAST_ARCHIVE_PY

rootfs="$PREFIX/var/lib/proot-distro/installed-rootfs/ubuntu"
if [[ ! -e "$rootfs" ]]; then
  proot-distro install ubuntu
fi
proot-distro login ubuntu -- /usr/bin/env -u BASH_ENV /bin/bash --noprofile --norc -c '
  set -euo pipefail
  if [[ -e /root/foldcast || -L /root/foldcast ]]; then
    printf "An existing /root/foldcast was found. This first-install script preserves it and stops.\n" >&2
    exit 1
  fi
  audit="$(dpkg --audit)"
  if [[ -n "$audit" ]]; then
    printf "Ubuntu has unfinished package operations. Resolve them separately; RIVET will not repair or configure unrelated packages.\n" >&2
    exit 1
  fi
  missing=()
  command -v python3 >/dev/null 2>&1 || missing+=(python3)
  command -v ffmpeg >/dev/null 2>&1 || missing+=(ffmpeg)
  if [[ ${#missing[@]} -gt 0 ]]; then
    apt-get update
    apt-get install -y --no-install-recommends "${missing[@]}"
  fi
  python3 -c "import sys; sys.exit(sys.version_info < (3, 10))" || {
    printf "RIVET requires Python 3.10 or later. Upgrade that prerequisite separately.\n" >&2
    exit 1
  }
'

# mkdir is atomic: an existing installation is never overwritten, including
# its recordings and a device-specific isolated encoder toolchain.
tar -C "$stage" -cf - foldcast | proot-distro login ubuntu -- /usr/bin/env -u BASH_ENV /bin/bash --noprofile --norc -c '
  set -euo pipefail
  mkdir -m 700 /root/foldcast
  tar --no-same-owner -xf - -C /root
  chmod 700 /root/foldcast/launch.sh
'

(
  set -o noclobber
cat "$stage/foldcast/termux/start-foldcast" > "$HOME/start-foldcast"
)
chmod 700 "$HOME/start-foldcast"
if [[ ! -e "$HOME/start-rivet" && ! -L "$HOME/start-rivet" ]]; then
  ln -s "$HOME/start-foldcast" "$HOME/start-rivet"
fi
if [[ -f "$stage/foldcast/termux/install-foldcast-shortcut.sh" ]]; then
  mkdir -p "$HOME/.local/bin"
  cp -- "$stage/foldcast/termux/install-foldcast-shortcut.sh" "$HOME/.local/bin/install-foldcast-shortcut"
  chmod 700 "$HOME/.local/bin/install-foldcast-shortcut"
  ln -sf "$HOME/.local/bin/install-foldcast-shortcut" "$HOME/install-foldcast-shortcut"
  "$HOME/.local/bin/install-foldcast-shortcut" --open
fi

if [[ "$launch_after_install" == true ]]; then
  start_flags=()
  if [[ "$open_in_browser" != true ]]; then
    start_flags+=(--no-open)
  fi
  "$HOME/start-foldcast" "${start_flags[@]}"
  printf 'RIVET installed and started. Open http://127.0.0.1:8787/ to check it.\n'
else
  printf 'RIVET installed. Run ~/start-rivet and open http://127.0.0.1:8787/\n'
  printf 'Local production works offline after setup. Streaming and uploads need a destination and network.\n'
fi

printf 'The RIVET Termux:Widget shortcut is ready in ~/.shortcuts/RIVET.\n'
