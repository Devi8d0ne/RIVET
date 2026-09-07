#!/usr/bin/env python3
"""Package the built local RIVET runtime without recordings or private metadata."""
import argparse
import gzip
import hashlib
from pathlib import Path
import shutil
import tarfile


def package(destination):
    repo = Path(__file__).resolve().parents[1]
    root = repo / "foldcast"
    required = [root / "server.py", root / "hardware.py", root / "launch.sh", root / "README.md", root / "dist" / "index.html"]
    if any(not path.is_file() for path in required):
        raise SystemExit("Build RIVET first; server.py, hardware.py, launch.sh, README.md and dist/index.html are required.")
    runtime_files = required[:-1] + sorted(path for path in (root / "dist").rglob("*") if path.is_file())
    host_files = [
        (repo / "scripts" / "start-foldcast", "start-foldcast"),
        (repo / "scripts" / "install-foldcast-termux.sh", "install-foldcast-termux.sh"),
        (repo / "scripts" / "install-foldcast-termux.sh", "install-rivet-termux.sh"),
        (repo / "scripts" / "install-foldcast-shortcut.sh", "install-foldcast-shortcut.sh"),
    ]
    if any(not path.is_file() for path, _ in host_files):
        raise SystemExit("Termux launcher and installer files are required.")
    files = [(path, "foldcast/" + path.relative_to(root).as_posix()) for path in runtime_files]
    files += [(path, "foldcast/termux/" + archive_name) for path, archive_name in host_files]
    if any(path.is_symlink() or not path.resolve().is_relative_to(repo) for path, _ in files):
        raise SystemExit("Refusing to package linked files or files outside the repository.")
    destination = Path(destination).resolve()
    if destination.is_relative_to(root / "dist") or destination in [path.resolve() for path, _ in files]:
        raise SystemExit("The archive destination must be outside the runtime files and dist directory.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("wb") as output:
        with gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0) as zipped:
            with tarfile.open(mode="w", fileobj=zipped) as archive:
                for path, archive_name in files:
                    info = archive.gettarinfo(str(path), arcname=archive_name)
                    info.uid = info.gid = 0
                    info.uname = info.gname = ""
                    info.mtime = 0
                    info.mode = 0o700 if path.name in {"launch.sh", "start-foldcast", "install-foldcast-termux.sh", "install-foldcast-shortcut.sh"} else 0o600
                    with path.open("rb") as source:
                        archive.addfile(info, source)
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    digest_path = destination.with_name(destination.name + ".sha256")
    digest_path.write_text(digest + "  " + destination.name + "\n", encoding="utf-8")
    standalone_installer = destination.parent / "install-rivet-termux.sh"
    shutil.copyfile(repo / "scripts" / "install-foldcast-termux.sh", standalone_installer)
    print(f"Packaged {len(files)} runtime files: {destination}")
    print(f"SHA-256: {digest}")
    print(f"Checksum file: {digest_path}")
    print(f"Termux installer: {standalone_installer}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    package(parser.parse_args().destination)
