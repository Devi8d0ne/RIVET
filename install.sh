#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
umask 077

if [[ -z "${PREFIX:-}" ]] || ! command -v pkg >/dev/null 2>&1; then
  printf 'Open Termux on Android and run this command there.\n' >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  pkg install -y curl
fi

release_base="https://github.com/Devi8d0ne/RIVET/releases/latest/download"
stage="$(mktemp -d "${TMPDIR:-$PREFIX/tmp}/rivet-bootstrap.XXXXXXXX")"
cleanup() { rm -rf -- "$stage"; }
trap cleanup EXIT

curl --fail --location --silent --show-error "$release_base/install-rivet-termux.sh" --output "$stage/install-rivet-termux.sh"
curl --fail --location --silent --show-error "$release_base/rivet-0.1.0-linux.tar.gz" --output "$stage/rivet-0.1.0-linux.tar.gz"
curl --fail --location --silent --show-error "$release_base/rivet-0.1.0-linux.tar.gz.sha256" --output "$stage/rivet-0.1.0-linux.tar.gz.sha256"

bash "$stage/install-rivet-termux.sh" "$stage/rivet-0.1.0-linux.tar.gz" --launch
