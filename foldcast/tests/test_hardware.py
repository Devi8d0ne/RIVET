"""Encoder selection/probe boundaries. No hardware, camera or network is used."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location("rivet_hardware_tests", Path(__file__).parents[1] / "hardware.py")
hardware = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(hardware)


class FakeProbe:
    """Creates synthetic encoder files and decoder diagnostics, never media."""
    def __init__(self, behavior=None):
        self.behavior = behavior or {}
        self.processes = []
        self.entered = threading.Event()

    def __call__(self, arguments, **options):
        factory = self
        encoding = "-frames:v" in arguments
        target = Path(arguments[-1] if encoding else arguments[arguments.index("-i") + 1])
        height = int(target.stem)
        width, fps = {480: (854, 24), 720: (1280, 30), 1080: (1920, 30)}[height]
        stage = "encode" if encoding else "decode"
        behavior = self.behavior.get((height, stage), "success")

        class Process:
            pid = None
            def __init__(self):
                self.arguments, self.options = arguments, options
                self.returncode = None
                self.killed = False
                self.released = threading.Event()
                self.stage, self.height = stage, height

            def communicate(self, timeout):
                if behavior == "block":
                    factory.entered.set()
                    if not self.released.wait(3):
                        raise AssertionError("Test did not cancel blocked process")
                if self.killed:
                    self.returncode = -9
                    return None, b""
                if behavior == "timeout":
                    raise subprocess.TimeoutExpired(arguments, timeout)
                self.returncode = 1 if behavior == "fail" else 0
                if encoding:
                    if self.returncode == 0:
                        target.write_bytes(b"x" * (0 if behavior == "empty" else 512))
                    return None, b""
                count = 0 if behavior == "no-frames" else fps - 1 if behavior == "short" else fps
                actual_width = width + 8 if behavior == "wrong-size" else width
                output = "\n".join(f"[Parsed_showinfo_0] n: {index:3} pts: {index} pts_time:0 fmt:yuv420p s:{actual_width}x{height}"
                                   for index in range(count))
                return None, output.encode()

            def kill(self):
                self.killed = True
                self.returncode = -9
                self.released.set()

            def wait(self, timeout):
                return self.returncode

            def poll(self):
                return self.returncode

        process = Process()
        self.processes.append(process)
        return process


class HardwareTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.executable = self.root / "android-ffmpeg"
        self.executable.write_text("fake executable")
        self.executable.chmod(0o700)
        self.environment = mock.patch.dict(os.environ, {"RIVET_ANDROID_FFMPEG": str(self.executable),
                                                       "RIVET_ANDROID_CODEC": "c2.qti.avc.encoder"})
        self.environment.start()
        self.manager = hardware.HardwareEncoder(self.root)

    def tearDown(self):
        self.manager.close()
        self.environment.stop()
        self.temporary.cleanup()

    def probe(self, factory):
        with mock.patch.object(hardware.subprocess, "Popen", side_effect=factory):
            self.manager.check()
            self.manager.worker.join(timeout=3)
            self.assertFalse(self.manager.worker.is_alive())
        self.assertFalse(self.manager.checking)
        self.assertIsNone(self.manager.process)

    def test_forced_vendor_and_real_decode_are_required_for_each_profile(self):
        factory = FakeProbe()
        self.probe(factory)
        self.assertEqual(set(self.manager.profiles), {"480", "720", "1080"})
        self.assertEqual(self.manager.public()["kind"], "android")
        self.assertEqual(len(factory.processes), 6)
        for process in factory.processes:
            if process.stage == "encode":
                self.assertEqual(process.arguments[process.arguments.index("-codec_name") + 1], "c2.qti.avc.encoder")
                self.assertIn("h264_mediacodec", process.arguments)
                self.assertNotIn("libx264", process.arguments)
            else:
                self.assertIn("showinfo", process.arguments)
        self.assertEqual(list(self.root.glob("rivet-codec-*")), [])

    def test_success_exit_without_decoded_frames_never_becomes_ready(self):
        self.probe(FakeProbe({(height, "decode"): "no-frames" for height in (480, 720, 1080)}))
        self.assertEqual(self.manager.state, "error")
        self.assertFalse(self.manager.public()["available"])

    def test_wrong_dimensions_and_missing_frames_do_not_verify_profiles(self):
        self.probe(FakeProbe({(480, "decode"): "wrong-size", (720, "decode"): "short"}))
        self.assertEqual(set(self.manager.profiles), {"1080"})

    def test_first_profile_failure_does_not_hide_supported_larger_profiles(self):
        self.probe(FakeProbe({(480, "encode"): "fail"}))
        self.assertEqual(set(self.manager.profiles), {"720", "1080"})
        self.assertEqual(self.manager.choose("software", 480), ("software", False))
        self.assertEqual(self.manager.choose("software", 720), (str(self.executable), True))

    def test_encode_and_decode_timeouts_kill_children_and_keep_other_profiles(self):
        factory = FakeProbe({(480, "encode"): "timeout", (720, "decode"): "timeout"})
        self.probe(factory)
        self.assertEqual(set(self.manager.profiles), {"1080"})
        self.assertTrue(next(p for p in factory.processes if p.height == 480).killed)
        self.assertTrue(next(p for p in factory.processes if p.height == 720 and p.stage == "decode").killed)

    def test_close_cancels_encoding_and_prevents_restart(self):
        factory = FakeProbe({(480, "encode"): "block"})
        with mock.patch.object(hardware.subprocess, "Popen", side_effect=factory):
            self.manager.check()
            self.assertTrue(factory.entered.wait(1))
            worker = self.manager.worker
            self.manager.check()
            self.assertIs(worker, self.manager.worker)
            self.manager.close()
            self.manager.check()
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(factory.processes), 1)
        self.assertTrue(factory.processes[0].killed)
        self.assertEqual(self.manager.state, "closed")
        self.assertFalse(self.manager.checking)

    def test_close_tracks_and_cancels_decoder_too(self):
        factory = FakeProbe({(480, "decode"): "block"})
        with mock.patch.object(hardware.subprocess, "Popen", side_effect=factory):
            self.manager.check()
            self.assertTrue(factory.entered.wait(1))
            self.assertEqual(self.manager.process.stage, "decode")
            self.manager.close()
        self.assertFalse(self.manager.worker.is_alive())
        self.assertTrue(factory.processes[-1].killed)
        self.assertFalse(self.manager.public()["available"])

    def test_android_mode_never_silently_uses_cpu(self):
        self.probe(FakeProbe({(480, "encode"): "fail"}))
        self.manager.select("android")
        with self.assertRaises(ValueError):
            self.manager.choose("software", 480)
        self.assertEqual(self.manager.choose("software", 720), (str(self.executable), True))
        self.manager.state = "error"
        with self.assertRaises(ValueError):
            self.manager.choose("software", 720)
        public = self.manager.public()
        self.assertEqual(public["kind"], "unavailable")
        self.assertIsNone(public["encoder"])
        self.assertNotIn("CPU", public["label"])

    def test_cpu_mode_selects_cpu_even_when_hardware_verified(self):
        self.probe(FakeProbe())
        self.manager.select("cpu")
        self.assertEqual(self.manager.choose("software", 720), ("software", False))
        self.assertEqual(self.manager.public()["kind"], "cpu")
        self.assertEqual(json.loads((self.root / "encoding.json").read_text()), {"mode": "cpu"})

    def test_android_software_codec_name_and_missing_adapter_are_rejected(self):
        for codec in ("c2.android.avc.encoder", "OMX.google.h264.encoder", "c2.qti.avc.encoder; echo bad"):
            with self.subTest(codec=codec), mock.patch.object(hardware.subprocess, "Popen") as popen:
                self.manager.codec = codec
                self.manager.check()
                self.assertEqual(self.manager.state, "unconfigured")
                popen.assert_not_called()
        self.manager.codec = "c2.qti.avc.encoder"
        self.manager.executable = str(self.root / "missing")
        self.assertFalse(self.manager.configured())

    def test_failed_settings_write_does_not_change_selected_mode(self):
        (self.root / "encoding.json").write_text('{"mode":"auto"}')
        with mock.patch.object(Path, "replace", side_effect=OSError("disk error")):
            with self.assertRaises(OSError):
                self.manager.select("cpu")
        self.assertEqual(self.manager.mode, "auto")
        self.assertEqual(json.loads((self.root / "encoding.json").read_text())["mode"], "auto")

    def test_invalid_selection_and_empty_ready_state_are_rejected(self):
        for mode in ({}, None, "gpu"):
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                self.manager.select(mode)
        self.manager.state = "ready"
        with self.assertRaises(ValueError):
            self.manager.select("android")

    def test_real_timed_out_child_is_reaped(self):
        processes = []
        original = subprocess.Popen
        def launch(*args, **kwargs):
            process = original(*args, **kwargs)
            processes.append(process)
            return process
        with mock.patch.object(hardware.subprocess, "Popen", side_effect=launch):
            with self.assertRaises(subprocess.TimeoutExpired):
                self.manager._run_probe([sys.executable, "-c", "import time; time.sleep(30)"], 0.15)
        self.assertIsNotNone(processes[0].poll())
        self.assertIsNone(self.manager.process)

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg unavailable for generated-media decoder check")
    def test_real_ffmpeg_decode_metadata_matches_generated_frames(self):
        executable = shutil.which("ffmpeg")
        target = self.root / "generated.mp4"
        subprocess.run([executable, "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=854x480:rate=24",
                        "-frames:v", "24", "-c:v", "libx264", "-threads", "1", "-preset", "ultrafast",
                        str(target)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=15,
                       **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}))
        code, output = self.manager._run_probe([executable, "-v", "info", "-nostdin", "-i", str(target),
                                               "-map", "0:v:0", "-an", "-vf", "showinfo", "-f", "null", "-"],
                                              10, capture_errors=True)
        self.assertEqual(code, 0)
        self.assertTrue(self.manager._decoded_profile(output, 854, 480, 24))
        self.assertFalse(self.manager._decoded_profile(output, 1280, 720, 24))


if __name__ == "__main__":
    unittest.main()
