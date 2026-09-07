"""Release integrity and installer archive boundaries; never invokes package managers."""
import contextlib
import hashlib
import importlib.util
import io
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch


REPO = Path(__file__).resolve().parents[1]
INSTALLER = (REPO / "scripts/install-rivet-termux.sh").read_text(encoding="utf-8")
VALIDATOR = INSTALLER.split("<<'RIVET_ARCHIVE_PY'\n", 1)[1].split("\nRIVET_ARCHIVE_PY", 1)[0]
BASE_FILES = ["rivet/server.py", "rivet/hardware.py", "rivet/launch.sh", "rivet/README.md",
              "rivet/dist/index.html", "rivet/termux/start-rivet",
              "rivet/termux/install-rivet-termux.sh", "rivet/termux/install-rivet-shortcut.sh"]


class RivetPackagingTests(unittest.TestCase):
    def validate(self, archive, destination):
        with patch.object(sys, "argv", ["validator", str(archive), str(destination)]):
            with contextlib.redirect_stdout(io.StringIO()):
                exec(compile(VALIDATOR, "installer-archive-validator", "exec"), {"__name__": "__main__"})

    def archive(self, destination, extra=None, omit=None):
        with tarfile.open(destination, "w:gz") as archive:
            for name in BASE_FILES:
                if name == omit:
                    continue
                entry = tarfile.TarInfo(name)
                entry.size = 4
                archive.addfile(entry, io.BytesIO(b"test"))
            if extra:
                archive.addfile(extra, io.BytesIO(b"x" * extra.size) if extra.isfile() else None)

    def test_valid_archive_extracts_required_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "release.tar.gz"
            self.archive(archive)
            self.validate(archive, root / "extracted")
            self.assertEqual((root / "extracted/rivet/dist/index.html").read_bytes(), b"test")

    def test_rejects_links_traversal_duplicates_and_private_files_before_extraction(self):
        cases = ["../outside", "/absolute", "rivet/dist/../../outside", "rivet/dist/a\\b",
                 "rivet/data/private.json", "rivet/toolchain/ffmpeg", "rivet/server.py"]
        entries = [tarfile.TarInfo(name) for name in cases]
        link = tarfile.TarInfo("rivet/dist/link")
        link.type, link.linkname = tarfile.SYMTYPE, "/root/.bashrc"
        entries.append(link)
        hardlink = tarfile.TarInfo("rivet/dist/hardlink")
        hardlink.type, hardlink.linkname = tarfile.LNKTYPE, "rivet/server.py"
        entries.append(hardlink)
        for entry in entries:
            with self.subTest(name=entry.name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                archive = root / "release.tar.gz"
                self.archive(archive, extra=entry)
                with self.assertRaises(SystemExit):
                    self.validate(archive, root / "extracted")
                self.assertFalse((root / "extracted").exists())

    def test_rejects_incomplete_release(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "release.tar.gz"
            self.archive(archive, omit="rivet/termux/start-rivet")
            with self.assertRaises(SystemExit):
                self.validate(archive, root / "extracted")

    def test_package_is_reproducible_hashes_and_excludes_runtime_data(self):
        spec = importlib.util.spec_from_file_location("rivet_package", REPO / "scripts/package-rivet.py")
        package = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(package)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            repo = root / "repo"
            for name in ["rivet/server.py", "rivet/hardware.py", "rivet/launch.sh", "rivet/README.md", "rivet/dist/index.html",
                         "scripts/start-rivet", "scripts/install-rivet-termux.sh",
                         "scripts/install-rivet-shortcut.sh",
                         "rivet/data/private.json", "rivet/toolchain/bin/ffmpeg"]:
                path = repo / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(name)
            with patch.object(package, "__file__", str(repo / "scripts/package-rivet.py")):
                with contextlib.redirect_stdout(io.StringIO()):
                    package.package(root / "one.tar.gz")
                    package.package(root / "two.tar.gz")
            first = (root / "one.tar.gz").read_bytes()
            self.assertEqual(first, (root / "two.tar.gz").read_bytes())
            self.assertEqual((root / "one.tar.gz.sha256").read_text().split()[0], hashlib.sha256(first).hexdigest())
            with tarfile.open(root / "one.tar.gz") as archive:
                self.assertEqual(set(archive.getnames()), set(BASE_FILES))
            self.validate(root / "one.tar.gz", root / "validated")


if __name__ == "__main__":
    unittest.main()
