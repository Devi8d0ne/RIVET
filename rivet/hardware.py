"""Optional Android encoder adapter. Ordinary Linux keeps the software encoder."""
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import threading
import time


class ProbeCancelled(Exception):
    pass


class HardwareEncoder:
    def __init__(self, data_dir):
        self.data_dir = Path(data_dir)
        self.lock = threading.RLock()
        self.executable = os.environ.get("RIVET_ANDROID_FFMPEG", "")
        self.codec = os.environ.get("RIVET_ANDROID_CODEC", "")
        self.mode = "auto"
        self.state = "unconfigured"
        self.detail = "CPU encoding is available. An Android encoder adapter has not been configured."
        self.profiles = {}
        self.checking = False
        self.stop_event = threading.Event()
        self.process = None
        self.worker = None
        try:
            mode = json.loads((self.data_dir / "encoding.json").read_text())["mode"]
            if mode in {"auto", "cpu", "android"}:
                self.mode = mode
        except (OSError, ValueError, KeyError, TypeError):
            pass

    def configured(self):
        # Configuration is local launch configuration, never browser-supplied
        # executable paths or shell commands. Explicit vendor names avoid silently
        # selecting Android's software codec and calling it hardware acceleration.
        return (bool(self.executable) and Path(self.executable).is_file()
                and os.access(self.executable, os.X_OK)
                and bool(re.fullmatch(r"(?:c2\.(?:qti|exynos|mtk|amlogic)|OMX\.(?:qcom|Exynos|MTK))\.[A-Za-z0-9_.-]+", self.codec)))

    def public(self):
        with self.lock:
            available = self.state == "ready" and bool(self.profiles) and self.configured() and not self.stop_event.is_set()
            active = available and self.mode != "cpu"
            forced_unavailable = self.mode == "android" and not active
            return {"available": available, "mode": self.mode, "state": self.state,
                    "encoder": "h264_mediacodec" if active else None if forced_unavailable else "libx264",
                    "kind": "android" if active else "unavailable" if forced_unavailable else "cpu",
                    "label": "Android hardware encoding" if active else "Android encoding unavailable" if forced_unavailable else "CPU encoding",
                    "detail": self.detail, "codec": self.codec if available else None,
                    "profiles": dict(self.profiles)}

    def select(self, mode):
        if not isinstance(mode, str) or mode not in {"auto", "cpu", "android"}:
            raise ValueError("Choose auto, cpu or android encoding")
        with self.lock:
            if self.stop_event.is_set():
                raise ValueError("The encoder manager is closed")
            if mode == "android" and not (self.state == "ready" and self.profiles and self.configured()):
                raise ValueError("Check and verify the Android encoder first")
            path = self.data_dir / "encoding.json"
            temporary = path.with_suffix(".tmp")
            temporary.write_text(json.dumps({"mode": mode}), encoding="utf-8")
            temporary.chmod(0o600)
            temporary.replace(path)
            self.mode = mode

    def check(self):
        with self.lock:
            if self.stop_event.is_set():
                return
            if self.checking:
                return
            if not self.configured():
                self.state = "unconfigured"
                self.profiles = {}
                self.detail = "CPU encoding is available in Auto or CPU mode. No valid Android encoder adapter is configured."
                return
            self.checking = True
            self.state = "checking"
            self.profiles = {}
            self.detail = "Testing the Android encoder with generated video on this device."
            self.worker = threading.Thread(target=self._probe, daemon=True)
            self.worker.start()

    def video_args(self, bitrate, gop=60):
        return ["-c:v", "h264_mediacodec", "-ndk_codec", "1", "-codec_name", self.codec,
                "-bitrate_mode", "vbr", "-b:v", str(bitrate), "-g", str(gop),
                "-bf", "0", "-pix_fmt", "nv12"]

    def choose(self, software, height):
        with self.lock:
            if self.stop_event.is_set():
                raise ValueError("The encoder manager is closed")
            if self.mode == "cpu":
                return software, False
            ready = self.state == "ready" and str(height) in self.profiles and self.configured()
            if self.mode == "android" and not ready:
                raise ValueError("Android encoding is not verified at this size; check hardware or select CPU")
            return (self.executable, True) if ready else (software, False)

    @staticmethod
    def _terminate(process):
        # POSIX probes have their own session, so wrappers cannot leave an
        # encoder child behind after timeout. Never target the server's group.
        if os.name != "nt":
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except (OSError, AttributeError, TypeError):
                pass
        try:
            process.kill()
        except OSError:
            pass
        try:
            process.wait(timeout=3)
        except (OSError, subprocess.TimeoutExpired):
            pass

    def _run_probe(self, arguments, timeout, capture_errors=False):
        options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {"start_new_session": True}
        with self.lock:
            if self.stop_event.is_set():
                raise ProbeCancelled()
            process = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                       stderr=subprocess.PIPE if capture_errors else subprocess.DEVNULL, **options)
            self.process = process
        try:
            _, errors = process.communicate(timeout=timeout)
            if self.stop_event.is_set():
                raise ProbeCancelled()
            return process.returncode, errors or b""
        except subprocess.TimeoutExpired:
            self._terminate(process)
            raise
        except (OSError, ValueError):
            self._terminate(process)
            raise
        finally:
            errors_pipe = getattr(process, "stderr", None)
            if errors_pipe is not None:
                errors_pipe.close()
            with self.lock:
                if self.process is process:
                    self.process = None

    @staticmethod
    def _decoded_profile(errors, width, height, fps):
        # showinfo counts decoded frames and reports their actual dimensions.
        # A successful process exit with an empty video stream is insufficient.
        frames = re.findall(r"\bn:\s*(\d+)\s+pts:.*?\bs:(\d+)x(\d+)\b", errors.decode("utf-8", "replace"))
        return len(frames) == fps and all((int(number), int(w), int(h)) == (index, width, height)
                                          for index, (number, w, h) in enumerate(frames))

    def _probe(self):
        verified = {}
        try:
            with tempfile.TemporaryDirectory(prefix="rivet-codec-", dir=self.data_dir) as folder:
                for width, height, fps in [(854, 480, 24), (1280, 720, 30), (1920, 1080, 30)]:
                    if self.stop_event.is_set():
                        return
                    target = Path(folder) / (str(height) + ".mp4")
                    args = [self.executable, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                            "-f", "lavfi", "-i", f"testsrc2=size={width}x{height}:rate={fps}",
                            "-frames:v", str(fps)] + self.video_args(3000000, fps * 2) + [str(target)]
                    began = time.monotonic()
                    try:
                        result, _ = self._run_probe(args, 15)
                        if result != 0 or not target.is_file() or target.stat().st_size < 100:
                            continue
                        result, errors = self._run_probe([self.executable, "-v", "info", "-nostdin",
                                                          "-i", str(target), "-map", "0:v:0", "-an",
                                                          "-vf", "showinfo", "-f", "null", "-"], 10, capture_errors=True)
                        if result == 0 and self._decoded_profile(errors, width, height, fps):
                            verified[str(height)] = {"width": width, "fps": fps,
                                                     "seconds": round(time.monotonic() - began, 2)}
                    except (OSError, ValueError, subprocess.TimeoutExpired):
                        # Each size is independent; some codecs reject 854-wide
                        # input but support 1280 or 1920 without difficulty.
                        continue
            with self.lock:
                if not self.stop_event.is_set():
                    self.profiles = verified
                    self.state = "ready" if verified else "error"
                    self.detail = ("Listed sizes encoded and decoded the expected frames. Auto uses CPU for unverified sizes; long-session performance still needs testing."
                                   if verified else "Android encoder check failed. Auto mode uses CPU; forced Android mode requires a successful check.")
        except ProbeCancelled:
            pass
        except (OSError, ValueError, subprocess.TimeoutExpired):
            with self.lock:
                if not self.stop_event.is_set():
                    self.state = "error"
                    self.profiles = {}
                    self.detail = "Android encoder could not be checked. Auto mode uses CPU; forced Android mode requires a successful check."
        finally:
            with self.lock:
                self.process = None
                self.checking = False

    def close(self):
        deadline = time.monotonic() + 4
        self.stop_event.set()
        with self.lock:
            process = self.process
            self.state = "closed"
            self.profiles = {}
            self.detail = "The encoder manager is closed."
        if process and process.poll() is None:
            self._terminate(process)
        if self.worker and self.worker is not threading.current_thread():
            self.worker.join(timeout=max(0, deadline - time.monotonic()))
