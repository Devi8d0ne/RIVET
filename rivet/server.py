#!/usr/bin/env python3
"""RIVET local recording and explicit broadcast service (Python stdlib only).

Media and private queue metadata stay in --data. Only user-requested RTMP
broadcasts and HTTPS uploads contact external hosts. Destination URLs, stream
keys and upload signatures are never returned through the API or request logs.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import platform
import queue
import re
import secrets
import shutil
import subprocess
import threading
import time
from urllib.parse import parse_qs, unquote, urlsplit
from hardware import HardwareEncoder

ROOT = Path(__file__).resolve().parent
MAX_CHUNK = 8 * 1024 * 1024
MAX_JSON = 16 * 1024
MAX_RECORDING = 32 * 1024**3
STREAM_QUEUE_SIZE = 4
STREAM_QUEUE_BYTES = 32 * 1024 * 1024
STREAM_IDLE_SECONDS = 30
STREAM_PROFILES = {"light": (1200, 48), "standard": (3000, 60), "high": (6000, 60)}
MAX_TRANSCODE_JOBS = 8
ID_RE = re.compile(r"^[a-f0-9]{32}$")


class APIError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def checked_url(value, schemes):
    if not isinstance(value, str) or len(value) > 8192 or any(ord(c) < 33 for c in value):
        raise APIError(400, "Provide a valid destination URL")
    try:
        parts = urlsplit(value)
        if parts.scheme not in schemes or not parts.hostname or parts.username or parts.password or parts.fragment:
            raise ValueError()
        _ = parts.port
    except ValueError:
        raise APIError(400, "Destination scheme or address is not supported") from None
    return parts


def atomic_json(path, value):
    temporary = path.with_suffix(".tmp")
    with temporary.open("w", encoding="utf-8") as output:
        json.dump(value, output, separators=(",", ":"))
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)
    try:
        path.chmod(0o600)
    except OSError:
        pass


class Broadcast:
    """Bounded browser-to-encoder queue. No shell and no destination logging."""

    def __init__(self, executable, destination, popen=subprocess.Popen, idle_timeout=STREAM_IDLE_SECONDS, quality="standard", hardware=None):
        if not isinstance(quality, str) or quality not in STREAM_PROFILES:
            raise APIError(400, "Choose light, standard or high broadcast quality")
        bitrate, gop = STREAM_PROFILES[quality]
        self.id = secrets.token_hex(16)
        self.status = "starting"
        self.error = None
        self.lock = threading.Lock()
        self.items = queue.Queue(maxsize=STREAM_QUEUE_SIZE)
        self.queued_bytes = 0
        self.hashes = []
        self.stop_requested = threading.Event()
        self.done = threading.Event()
        self.idle_timeout = idle_timeout
        self.last_input = time.monotonic()
        destinations = destination if isinstance(destination, list) else [destination]
        self.destination_count = len(destinations)
        self.quality = quality
        self.encoder = "h264_mediacodec" if hardware else "libx264"
        video = (hardware.video_args(bitrate * 1000, gop) if hardware else
                 ["-c:v", "libx264", "-preset", "ultrafast", "-threads", "2", "-tune", "zerolatency",
                  "-pix_fmt", "yuv420p", "-b:v", str(bitrate) + "k", "-maxrate", str(bitrate) + "k",
                  "-bufsize", str(bitrate * 2) + "k", "-g", str(gop)])
        arguments = [executable, "-hide_banner", "-loglevel", "error", "-nostdin",
                     "-fflags", "+genpts", "-i", "pipe:0", "-map", "0:v:0?", "-map", "0:a:0?",
                     "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2"] + video + ["-c:a", "aac", "-b:a", "128k", "-ar", "48000"]
        if len(destinations) == 1:
            arguments += ["-f", "flv", destinations[0]]
        else:
            # Fail the whole encoder if any output fails. No silent loss of a
            # destination and no claim that encoder activity proves delivery.
            arguments += ["-flags", "+global_header", "-f", "tee",
                          "|".join("[f=flv:onfail=abort]" + item for item in destinations)]
        options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
        try:
            self.process = popen(arguments, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, shell=False, **options)
        except OSError:
            raise APIError(503, "The broadcast encoder could not start") from None
        self.worker = threading.Thread(target=self._run, daemon=True)
        self.worker.start()
        threading.Thread(target=self._watch_idle, daemon=True).start()

    def public(self):
        with self.lock:
            result = {"id": self.id, "status": self.status, "destinationCount": self.destination_count,
                      "deliveryConfirmed": False, "failurePolicy": "stop-all", "quality": self.quality, "encoder": self.encoder}
            if self.error:
                result["error"] = self.error
            return result

    def append(self, seq, data):
        digest = hashlib.sha256(data).hexdigest()
        with self.lock:
            if seq < len(self.hashes):
                if self.hashes[seq] != digest:
                    raise APIError(409, "Sequence already contains different bytes")
                return
            if seq != len(self.hashes):
                raise APIError(409, "Chunks must arrive in sequence")
            if self.stop_requested.is_set() or self.status in {"error", "stopped"}:
                raise APIError(409, "Broadcast no longer accepts chunks")
            if self.queued_bytes + len(data) > STREAM_QUEUE_BYTES:
                raise APIError(429, "Encoder queue is full; retry this same chunk")
            try:
                self.items.put_nowait(data)
            except queue.Full:
                raise APIError(429, "Encoder queue is full; retry this same chunk") from None
            self.hashes.append(digest)
            self.queued_bytes += len(data)
            self.last_input = time.monotonic()

    def _watch_idle(self):
        # Browser/tab termination does not reliably deliver a stop request.
        # A separate watcher can also kill an encoder blocked on a full pipe.
        while not self.done.wait(min(1, self.idle_timeout / 4)):
            with self.lock:
                if self.stop_requested.is_set() or time.monotonic() - self.last_input < self.idle_timeout:
                    continue
                self.status = "error"
                self.error = "Broadcast stopped because no new media arrived for 30 seconds"
            try:
                self.process.kill()
            except OSError:
                pass
            return

    def stop(self):
        with self.lock:
            if self.status not in {"error", "stopped"}:
                self.status = "stopping"
        self.stop_requested.set()
        # A blocked encoder pipe must not keep the process alive forever.
        threading.Thread(target=self._stop_deadline, daemon=True).start()

    def _stop_deadline(self):
        if not self.done.wait(8):
            try:
                self.process.kill()
            except OSError:
                pass

    def _run(self):
        try:
            while True:
                if self.process.poll() is not None:
                    raise OSError("encoder exited")
                if self.stop_requested.is_set() and self.items.empty():
                    break
                try:
                    chunk = self.items.get(timeout=0.2)
                except queue.Empty:
                    continue
                self.process.stdin.write(chunk)
                self.process.stdin.flush()
                with self.lock:
                    self.queued_bytes -= len(chunk)
                    if not self.stop_requested.is_set():
                        self.status = "running"
            self.process.stdin.close()
            code = self.process.wait(timeout=5)
            with self.lock:
                self.status = "stopped" if code == 0 else "error"
                if code != 0:
                    self.error = "Broadcast encoder stopped with an error; check destination and codec support"
        except (OSError, ValueError, subprocess.TimeoutExpired):
            with self.lock:
                self.status = "error"
                self.error = self.error or "Broadcast encoder stopped; check destination, network and codec support"
        finally:
            if self.process.poll() is None:
                try:
                    self.process.kill()
                    self.process.wait(timeout=3)
                except (OSError, subprocess.TimeoutExpired):
                    pass
            try:
                self.process.stdin.close()
            except (OSError, ValueError):
                pass
            with self.lock:
                while not self.items.empty():
                    try:
                        self.items.get_nowait()
                    except queue.Empty:
                        break
                self.queued_bytes = 0
            self.done.set()


class App:
    def __init__(self, data_dir=None, dist_dir=None, start_upload_worker=True, start_transcode_worker=True):
        self.data_dir = Path(data_dir or ROOT / "data").resolve()
        self.dist_dir = Path(dist_dir or ROOT / "dist").resolve()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        try:
            self.data_dir.chmod(0o700)
        except OSError:
            pass
        self.token = secrets.token_urlsafe(32)
        self.lock = threading.RLock()
        self.records = {}
        self.jobs = {}
        self.transcode_process = None
        self.active_job_id = None
        self.transcode_lock = threading.Lock()
        self.transcode_wakeup = threading.Event()
        self.broadcast = None
        self.ffmpeg = shutil.which("ffmpeg")
        self.hardware = HardwareEncoder(self.data_dir)
        try:
            self.runtime = platform.freedesktop_os_release().get("ID", "linux")
        except OSError:
            self.runtime = platform.system().lower()
        self.shutdown_event = threading.Event()
        self.upload_wakeup = threading.Event()
        self._load()
        self._load_jobs()
        if start_transcode_worker and self.hardware.configured():
            self.hardware.check()
        if start_upload_worker:
            threading.Thread(target=self._upload_loop, daemon=True).start()
        if start_transcode_worker:
            threading.Thread(target=self._transcode_loop, daemon=True).start()

    def _metadata_path(self, record_id):
        return self.data_dir / (record_id + ".json")

    def media_path(self, record_id, extension=None):
        if not ID_RE.fullmatch(record_id):
            raise APIError(404, "Recording not found")
        extension = extension or self.records.get(record_id, {}).get("extension", "webm")
        if extension not in {"webm", "mp4"}:
            raise APIError(404, "Recording not found")
        return self.data_dir / (record_id + "." + extension)

    def _save(self, record):
        atomic_json(self._metadata_path(record["id"]), record)

    def _load(self):
        for metadata in self.data_dir.glob("*.json"):
            if not ID_RE.fullmatch(metadata.stem):
                continue
            try:
                record = json.loads(metadata.read_text(encoding="utf-8"))
                if record["id"] != metadata.stem:
                    continue
                media = self.media_path(record["id"], record.get("extension", "webm"))
                actual_size = media.stat().st_size
                expected_size = int(record["size"])
                chunks = record["chunks"]
                if expected_size < 0 or not isinstance(chunks, list):
                    continue
                # A crash between writing bytes and committing metadata leaves
                # an unacknowledged tail; discard it before accepting retries.
                if actual_size > expected_size:
                    with media.open("r+b") as output:
                        output.truncate(expected_size)
                elif actual_size < expected_size:
                    record["size"] = actual_size
                    record["status"] = "partial"
                    record["error"] = "Recording was shortened outside RIVET"
                    record["resume_blocked"] = True
                if record["status"] == "recording":
                    record["status"] = "partial"
                if record.get("upload", {}).get("status") == "uploading":
                    record["upload"]["status"] = "queued"
                self.records[record["id"]] = record
                self._save(record)
            except (OSError, ValueError, KeyError, TypeError):
                continue

    def record(self, record_id):
        if not ID_RE.fullmatch(record_id) or record_id not in self.records:
            raise APIError(404, "Recording not found")
        return self.records[record_id]

    def public_record(self, record):
        result = {key: record[key] for key in ("id", "title", "mime", "size", "created", "status")}
        result["url"] = "/media/" + record["id"]
        upload = record.get("upload")
        if upload:
            result["upload"] = {key: upload[key] for key in ("status", "error") if key in upload}
        if record.get("error"):
            result["error"] = record["error"]
        return result

    def create_recording(self, title, mime):
        if not isinstance(title, str) or not title.strip() or len(title) > 160:
            raise APIError(400, "Provide a title of 1 to 160 characters")
        if not isinstance(mime, str) or len(mime) > 150 or mime.split(";")[0].strip() not in {"video/webm", "audio/webm"} or "\r" in mime or "\n" in mime:
            raise APIError(400, "Recording must use video/webm or audio/webm")
        with self.lock:
            record_id = secrets.token_hex(16)
            record = {"id": record_id, "title": title.strip(), "mime": mime,
                      "size": 0, "created": utc_now(), "status": "recording", "chunks": []}
            self.media_path(record_id).touch(exist_ok=False)
            self._save(record)
            self.records[record_id] = record
            return record_id

    def append_recording(self, record_id, seq, data):
        digest = hashlib.sha256(data).hexdigest()
        with self.lock:
            record = self.record(record_id)
            if seq < len(record["chunks"]):
                if record["chunks"][seq]["sha256"] != digest:
                    raise APIError(409, "Sequence already contains different bytes")
                return
            if seq != len(record["chunks"]):
                raise APIError(409, "Chunks must arrive in sequence")
            if record["status"] not in {"recording", "partial"} or record.get("resume_blocked"):
                raise APIError(409, "Recording no longer accepts chunks")
            if record["size"] + len(data) > MAX_RECORDING or shutil.disk_usage(self.data_dir).free < len(data) + 32 * 1024**2:
                raise APIError(507, "Not enough recording storage")
            with self.media_path(record_id).open("r+b") as output:
                output.seek(record["size"])
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            previous_size, previous_status = record["size"], record["status"]
            record["size"] += len(data)
            record["chunks"].append({"sha256": digest, "size": len(data)})
            record["status"] = "recording"
            try:
                self._save(record)
            except OSError:
                record["size"], record["status"] = previous_size, previous_status
                record["chunks"].pop()
                with self.media_path(record_id).open("r+b") as output:
                    output.truncate(previous_size)
                raise

    def finish_recording(self, record_id):
        with self.lock:
            record = self.record(record_id)
            if record["size"] == 0:
                raise APIError(409, "Recording has no media yet")
            record["status"] = "complete"
            self._save(record)
            return self.public_record(record)

    def start_stream(self, url=None, key="", destinations=None, quality="standard"):
        if not isinstance(quality, str) or quality not in STREAM_PROFILES:
            raise APIError(400, "Choose light, standard or high broadcast quality")
        supplied = destinations if destinations is not None else [{"url": url, "key": key}]
        if not isinstance(supplied, list) or not 1 <= len(supplied) <= 4:
            raise APIError(400, "Provide between one and four broadcast destinations")
        targets = []
        for entry in supplied:
            if not isinstance(entry, dict):
                raise APIError(400, "Each destination needs a URL and stream key")
            address, secret = entry.get("url"), entry.get("key", "")
            parts = checked_url(address, {"rtmp", "rtmps"})
            if parts.query or not isinstance(secret, str) or len(secret) > 4096 or any(ord(c) < 33 for c in secret) or "#" in secret:
                raise APIError(400, "Provide the RTMP server URL and a valid stream key")
            destination = address.rstrip("/") + ("/" + secret.lstrip("/") if secret else "")
            if len(supplied) > 1 and any(c in destination for c in "|\\'[]"):
                raise APIError(400, "Multi-destination addresses cannot contain tee separator or escape characters")
            targets.append(destination)
        with self.lock:
            if not self.ffmpeg:
                raise APIError(503, "FFmpeg is unavailable; install it to enable broadcasting")
            if self.hardware.checking:
                raise APIError(409, "Wait for the hardware check before going live")
            if self.active_job_id is not None:
                raise APIError(409, "Finish or cancel the current conversion before going live")
            if self.broadcast and not self.broadcast.done.is_set():
                raise APIError(409, "A broadcast is already active")
            try:
                executable, android = self.hardware.choose(self.ffmpeg, {"light": 480, "standard": 720, "high": 1080}[quality])
            except ValueError as error:
                raise APIError(409, str(error)) from None
            self.broadcast = Broadcast(executable, targets, quality=quality, hardware=self.hardware if android else None)
            return self.broadcast.id

    def configure_hardware(self, mode=None):
        with self.lock:
            if self.active_job_id or (self.broadcast and not self.broadcast.done.is_set()):
                raise APIError(409, "Finish the conversion or broadcast before changing the encoder")
            if any(record["status"] == "recording" for record in self.records.values()):
                raise APIError(409, "Stop recording before checking or changing the encoder")
            if mode is None:
                self.hardware.check()
            else:
                if self.hardware.checking:
                    raise APIError(409, "Wait for the hardware check to finish")
                try:
                    self.hardware.select(mode)
                except (ValueError, TypeError) as error:
                    raise APIError(400, str(error)) from None
            self.transcode_wakeup.set()
            return self.hardware.public()

    def get_stream(self, stream_id):
        with self.lock:
            if not self.broadcast or stream_id != self.broadcast.id:
                raise APIError(404, "Broadcast not found")
            return self.broadcast

    def _job_path(self, job_id):
        return self.data_dir / (job_id + ".job.json")

    def _save_job(self, job):
        atomic_json(self._job_path(job["id"]), job)

    def _load_jobs(self):
        for path in self.data_dir.glob("*.job.json"):
            job_id = path.name.removesuffix(".job.json")
            if not ID_RE.fullmatch(job_id):
                continue
            try:
                job = json.loads(path.read_text(encoding="utf-8"))
                if job["id"] != job_id or job["recordingId"] not in self.records:
                    continue
                if job["status"] in {"queued", "running", "cancelling"}:
                    job.update(status="interrupted", error="Server restarted before this transcode finished; create a new job to retry")
                    self._save_job(job)
                self.jobs[job_id] = job
            except (OSError, ValueError, KeyError, TypeError):
                continue

    def public_job(self, job):
        return {key: job[key] for key in ("id", "status", "progress", "recordingId", "resultId", "error", "height", "quality", "encoder") if key in job}

    def job(self, job_id):
        if not ID_RE.fullmatch(job_id) or job_id not in self.jobs:
            raise APIError(404, "Transcode job not found")
        return self.jobs[job_id]

    def queue_transcode(self, record_id, height, quality):
        if type(height) is not int or height not in {360, 480, 720, 1080} or not isinstance(quality, str) or quality not in {"small", "balanced", "high"}:
            raise APIError(400, "Choose 360, 480, 720 or 1080 pixels and small, balanced or high quality")
        with self.lock:
            if not self.ffmpeg:
                raise APIError(503, "FFmpeg is unavailable; install it to enable transcoding")
            record = self.record(record_id)
            if record["status"] != "complete" or not record["mime"].startswith("video/"):
                raise APIError(409, "Finish a video recording before transcoding")
            if sum(job["status"] in {"queued", "running", "cancelling"} for job in self.jobs.values()) >= MAX_TRANSCODE_JOBS:
                raise APIError(429, "Transcode queue is full")
            job_id = secrets.token_hex(16)
            job = {"id": job_id, "recordingId": record_id, "height": height,
                   "quality": quality, "status": "queued", "created": utc_now()}
            self._save_job(job)
            self.jobs[job_id] = job
            self.transcode_wakeup.set()
            return job_id

    def cancel_transcode(self, job_id):
        with self.lock:
            job = self.job(job_id)
            if job["status"] in {"queued", "running", "cancelling"}:
                job["status"] = "cancelling" if job["status"] == "running" else "cancelled"
                self._save_job(job)
                if self.active_job_id == job_id and self.transcode_process:
                    try:
                        self.transcode_process.terminate()
                    except OSError:
                        pass
            self.transcode_wakeup.set()
            return self.public_job(job)

    def _media_duration(self, source):
        executable = shutil.which("ffprobe")
        if not executable:
            return None
        try:
            result = subprocess.run([executable, "-v", "error", "-protocol_whitelist", "file,pipe",
                                     "-show_entries", "format=duration", "-of", "json", str(source)],
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5,
                                    **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}))
            duration = float(json.loads(result.stdout)["format"]["duration"])
            return duration if duration > 0 else None
        except (OSError, ValueError, KeyError, subprocess.TimeoutExpired):
            return None

    def run_transcode(self, job_id):
        # The lock makes single-worker execution an invariant even in callers
        # that invoke this method directly (for example integration tests).
        with self.transcode_lock:
            with self.lock:
                job = self.job(job_id)
                if job["status"] != "queued":
                    return
                if self.hardware.checking or (self.broadcast and not self.broadcast.done.is_set()):
                    return
                original = self.record(job["recordingId"])
                try:
                    executable, android = self.hardware.choose(self.ffmpeg, job["height"])
                except ValueError as error:
                    job.update(status="error", error=str(error))
                    self._save_job(job)
                    return
                job["status"] = "running"
                job["encoder"] = "h264_mediacodec" if android else "libx264"
                self.active_job_id = job_id
                self._save_job(job)
                source = self.media_path(original["id"])
                result_id = secrets.token_hex(16)
                temporary = self.data_dir / (result_id + ".mp4.partial")
                result_path = self.media_path(result_id, "mp4")
            duration = self._media_duration(source)
            crf = {"small": "30", "balanced": "25", "high": "20"}[job["quality"]]
            rate = int({360: 900000, 480: 1600000, 720: 3500000, 1080: 6500000}[job["height"]]
                       * {"small": 0.65, "balanced": 1, "high": 1.6}[job["quality"]])
            video = (self.hardware.video_args(rate) if android else
                     ["-c:v", "libx264", "-preset", "veryfast", "-threads", "2", "-crf", crf, "-pix_fmt", "yuv420p"])
            args = [executable, "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
                    "-protocol_whitelist", "file,pipe", "-f", "mov" if original["mime"] == "video/mp4" else "matroska",
                    "-i", str(source), "-map", "0:v:0", "-map", "0:a:0?",
                    "-vf", "scale=-2:" + str(job["height"])] + video + [
                    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
                    "-progress", "pipe:1", "-stats_period", "0.5", "-f", "mp4", str(temporary)]
            process = None
            try:
                with self.lock:
                    if job["status"] != "running" or self.shutdown_event.is_set():
                        raise InterruptedError()
                    process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                               stderr=subprocess.DEVNULL, shell=False,
                                               **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}))
                    self.transcode_process = process
                progress_lines = queue.Queue(maxsize=64)

                def read_progress():
                    try:
                        while line := process.stdout.readline(1024):
                            try:
                                progress_lines.put_nowait(line)
                            except queue.Full:
                                pass
                    except (OSError, ValueError):
                        pass

                reader = threading.Thread(target=read_progress, daemon=True)
                reader.start()
                while process.poll() is None:
                    with self.lock:
                        if job["status"] in {"cancelling", "cancelled"} or self.shutdown_event.is_set():
                            raise InterruptedError()
                    if shutil.disk_usage(self.data_dir).free < 32 * 1024**2:
                        raise OSError("insufficient storage")
                    try:
                        line = progress_lines.get(timeout=0.2).decode("ascii", errors="ignore").strip()
                        if duration and line.startswith("out_time_us="):
                            value = int(line.split("=", 1)[1]) / (duration * 1000000)
                            with self.lock:
                                job["progress"] = max(0, min(0.99, value))
                    except (queue.Empty, ValueError):
                        pass
                reader.join(timeout=1)
                with self.lock:
                    if job["status"] in {"cancelling", "cancelled"} or self.shutdown_event.is_set():
                        raise InterruptedError()
                    if process.returncode != 0 or not temporary.is_file() or temporary.stat().st_size == 0:
                        raise OSError("encoder failed")
                    temporary.replace(result_path)
                    result = {"id": result_id, "title": (original["title"][:130] + " " + str(job["height"]) + "p MP4"),
                              "mime": "video/mp4", "extension": "mp4", "size": result_path.stat().st_size,
                              "created": utc_now(), "status": "complete", "chunks": [], "sourceId": original["id"]}
                    self._save(result)
                    self.records[result_id] = result
                    job.update(status="complete", progress=1, resultId=result_id)
                    self._save_job(job)
            except InterruptedError:
                with self.lock:
                    job["status"] = "interrupted" if self.shutdown_event.is_set() else "cancelled"
                    self._save_job(job)
            except (OSError, ValueError):
                with self.lock:
                    job.update(status="error", error="Transcode failed; check video, available storage and FFmpeg codec support")
                    self._save_job(job)
            finally:
                if process:
                    if process.poll() is None:
                        try:
                            process.kill()
                            process.wait(timeout=3)
                        except (OSError, subprocess.TimeoutExpired):
                            pass
                    process.stdout.close()
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass
                with self.lock:
                    self.transcode_process = None
                    self.active_job_id = None

    def _transcode_loop(self):
        while not self.shutdown_event.is_set():
            with self.lock:
                live = self.hardware.checking or (self.broadcast and not self.broadcast.done.is_set())
                pending = None if live else next((job["id"] for job in self.jobs.values() if job["status"] == "queued"), None)
            if pending:
                try:
                    self.run_transcode(pending)
                except OSError:
                    pass
            else:
                self.transcode_wakeup.wait(1)
                self.transcode_wakeup.clear()

    def queue_upload(self, record_id, url):
        checked_url(url, {"https"})
        with self.lock:
            record = self.record(record_id)
            if record["status"] != "complete":
                raise APIError(409, "Finish the recording before uploading")
            if record.get("upload", {}).get("status") in {"queued", "uploading"}:
                raise APIError(409, "An upload is already queued")
            record["upload"] = {"status": "queued", "url": url, "attempts": 0, "next_attempt": 0}
            self._save(record)
            self.upload_wakeup.set()
            return self.public_record(record)

    def _put_file(self, record, url):
        parts = checked_url(url, {"https"})
        connection = http.client.HTTPSConnection(parts.hostname, parts.port or 443, timeout=20)
        try:
            path = parts.path or "/"
            if parts.query:
                path += "?" + parts.query
            connection.putrequest("PUT", path)
            connection.putheader("Content-Type", record["mime"])
            connection.putheader("Content-Length", str(record["size"]))
            connection.endheaders()
            with self.media_path(record["id"]).open("rb") as source:
                while chunk := source.read(256 * 1024):
                    if self.shutdown_event.is_set():
                        raise OSError("server stopping")
                    connection.send(chunk)
            response = connection.getresponse()
            return response.status
        finally:
            connection.close()

    def upload_once(self, record_id):
        with self.lock:
            record = self.record(record_id)
            upload = record.get("upload", {})
            if upload.get("status") != "queued" or upload.get("next_attempt", 0) > time.time():
                return
            upload["status"] = "uploading"
            upload["attempts"] += 1
            self._save(record)
            url = upload["url"]
        try:
            status = self._put_file(record, url)
        except (OSError, ValueError, APIError, http.client.HTTPException):
            status = 0
        with self.lock:
            if 200 <= status < 300:
                upload.update(status="complete")
                upload.pop("error", None)
                upload.pop("url", None)
            elif status == 0 or status in {408, 429} or status >= 500:
                delay = min(300, 5 * 2 ** min(upload["attempts"] - 1, 6))
                upload.update(status="queued", next_attempt=time.time() + delay,
                              error="Upload unavailable; saved locally and queued for retry")
            else:
                upload.update(status="failed", error="Upload destination rejected the request (HTTP " + str(status) + ")")
                upload.pop("url", None)
            self._save(record)

    def _upload_loop(self):
        while not self.shutdown_event.is_set():
            with self.lock:
                pending = [r["id"] for r in self.records.values() if r.get("upload", {}).get("status") == "queued"]
            for record_id in pending:
                if self.shutdown_event.is_set():
                    break
                try:
                    self.upload_once(record_id)
                except OSError:
                    # Keep private media/queue details out of stderr.
                    pass
            self.upload_wakeup.wait(2)
            self.upload_wakeup.clear()

    def close(self):
        self.shutdown_event.set()
        self.hardware.close()
        self.upload_wakeup.set()
        self.transcode_wakeup.set()
        with self.lock:
            if self.transcode_process:
                try:
                    self.transcode_process.terminate()
                except OSError:
                    pass
        if self.broadcast:
            self.broadcast.stop()


def range_bounds(value, size):
    if value is None:
        return 0, max(0, size - 1), False
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", value)
    if not match or not any(match.groups()) or any(len(v) > 20 for v in match.groups()) or size == 0:
        raise APIError(416, "Range not satisfiable")
    left, right = match.groups()
    if not left:
        suffix = int(right)
        if suffix < 1:
            raise APIError(416, "Range not satisfiable")
        return max(0, size - suffix), size - 1, True
    start, end = int(left), min(int(right), size - 1) if right else size - 1
    if start >= size or end < start:
        raise APIError(416, "Range not satisfiable")
    return start, end, True


class Handler(BaseHTTPRequestHandler):
    server_version = "RIVET"

    @property
    def app(self):
        return self.server.app

    def log_message(self, *_):
        pass

    def _headers(self, status, mime, length, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()

    def _json(self, status, value):
        raw = json.dumps(value).encode()
        self._headers(status, "application/json", len(raw))
        if self.command != "HEAD":
            self.wfile.write(raw)

    def _check(self, mutate=False):
        port = self.server.server_address[1]
        hosts = {"localhost:" + str(port), "127.0.0.1:" + str(port)}
        if self.headers.get("Host", "").lower() not in hosts or len(self.headers.get_all("Host", [])) != 1:
            raise APIError(403, "Invalid request host")
        origin = self.headers.get("Origin")
        if origin and origin not in {"http://" + host for host in hosts}:
            raise APIError(403, "Invalid request origin")
        document_navigation = (
            self.command in {"GET", "HEAD"}
            and urlsplit(self.path).path in {"/", "/index.html"}
            and self.headers.get("Sec-Fetch-Mode") == "navigate"
            and self.headers.get("Sec-Fetch-Dest") == "document"
        )
        if self.headers.get("Sec-Fetch-Site") == "cross-site" and not document_navigation:
            raise APIError(403, "Cross-site requests are forbidden")
        if mutate and not secrets.compare_digest(self.headers.get("X-Rivet-Token", "").encode(), self.app.token.encode()):
            raise APIError(403, "Missing or invalid session token")

    def _body(self, raw=False):
        if self.headers.get("Transfer-Encoding"):
            raise APIError(400, "Chunked request transfer is not supported")
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1 or not lengths[0].isdigit() or len(lengths[0]) > 12:
            raise APIError(411, "Content-Length is required")
        length = int(lengths[0])
        if length > (MAX_CHUNK if raw else MAX_JSON) or (raw and length == 0):
            raise APIError(413, "Request body is outside the allowed size")
        expected_type = "application/octet-stream" if raw else "application/json"
        if self.headers.get("Content-Type", "").split(";")[0].strip() != expected_type:
            raise APIError(415, "Unsupported request content type")
        self.connection.settimeout(20)
        body = self.rfile.read(length)
        if len(body) != length:
            raise APIError(400, "Incomplete request body")
        if raw:
            return body
        try:
            value = json.loads(body)
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except (ValueError, UnicodeError):
            raise APIError(400, "Provide a JSON object") from None

    def _sequence(self, query):
        values = parse_qs(query)
        if set(values) != {"seq"} or len(values["seq"]) != 1 or not values["seq"][0].isdigit() or len(values["seq"][0]) > 9:
            raise APIError(400, "Provide one nonnegative seq parameter")
        return int(values["seq"][0])

    def _file(self, path, mime, ranges=False):
        with path.open("rb") as source:
            size = os.fstat(source.fileno()).st_size
            try:
                start, end, partial = range_bounds(self.headers.get("Range") if ranges else None, size)
            except APIError as error:
                self._headers(error.status, "text/plain", 0, {"Content-Range": "bytes */" + str(size)})
                return
            count = end - start + 1 if size else 0
            headers = {"Accept-Ranges": "bytes"} if ranges else {}
            if partial:
                headers["Content-Range"] = "bytes " + str(start) + "-" + str(end) + "/" + str(size)
            self._headers(206 if partial else 200, mime, count, headers)
            if self.command == "HEAD":
                return
            source.seek(start)
            while count:
                chunk = source.read(min(count, 256 * 1024))
                if not chunk:
                    break
                self.wfile.write(chunk)
                count -= len(chunk)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        try:
            self._check()
            path = urlsplit(self.path).path
            if path == "/api/session":
                return self._json(200, {"token": self.app.token})
            if path == "/api/status":
                stream = self.app.broadcast.public() if self.app.broadcast else {"status": "idle"}
                return self._json(200, {"service": "rivet", "pid": os.getpid(), "runtime": self.app.runtime,
                                        "ffmpeg": bool(self.app.ffmpeg), "stream": stream, "hardware": self.app.hardware.public()})
            if path == "/api/recordings":
                with self.app.lock:
                    records = [self.app.public_record(r) for r in self.app.records.values()]
                return self._json(200, {"recordings": sorted(records, key=lambda r: r["created"], reverse=True)})
            if path == "/api/jobs":
                with self.app.lock:
                    jobs = [self.app.public_job(job) for job in reversed(list(self.app.jobs.values()))]
                return self._json(200, {"jobs": jobs})
            if path.startswith("/media/"):
                record_id = path[len("/media/"):]
                with self.app.lock:
                    record = self.app.record(record_id)
                    mime = record["mime"]
                return self._file(self.app.media_path(record_id), mime, ranges=True)
            if path.startswith("/api/"):
                raise APIError(404, "Endpoint not found")
            decoded = unquote(path)
            if "\\" in decoded or "\x00" in decoded:
                raise APIError(404, "File not found")
            relative = "index.html" if decoded == "/" else decoded.lstrip("/")
            target = (self.app.dist_dir / relative).resolve()
            if not target.is_relative_to(self.app.dist_dir) or not target.is_file():
                raise APIError(404, "File not found")
            return self._file(target, mimetypes.guess_type(target.name)[0] or "application/octet-stream")
        except APIError as error:
            self._json(error.status, {"error": error.message})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except OSError:
            self._json(500, {"error": "Local storage could not be read"})

    def do_POST(self):
        try:
            self._check(mutate=True)
            request = urlsplit(self.path)
            path = request.path
            match = re.fullmatch(r"/api/(recordings|stream)/([a-f0-9]{32})/chunk", path)
            if match:
                seq, data = self._sequence(request.query), self._body(raw=True)
                if match[1] == "recordings":
                    self.app.append_recording(match[2], seq, data)
                else:
                    self.app.get_stream(match[2]).append(seq, data)
                return self._json(200, {"ok": True})
            body = self._body()
            if path == "/api/hardware/check":
                return self._json(202, self.app.configure_hardware())
            if path == "/api/hardware/selection":
                if body.get("mode") not in ("auto", "cpu", "android"):
                    raise APIError(400, "Choose auto, cpu or android encoding")
                return self._json(200, self.app.configure_hardware(body["mode"]))
            if path == "/api/recordings":
                return self._json(201, {"id": self.app.create_recording(body.get("title"), body.get("mime"))})
            if path == "/api/stream/start":
                return self._json(201, {"id": self.app.start_stream(body.get("url"), body.get("key", ""), body.get("destinations"), body.get("quality", "standard"))})
            match = re.fullmatch(r"/api/recordings/([a-f0-9]{32})/transcode", path)
            if match:
                return self._json(202, {"jobId": self.app.queue_transcode(match[1], body.get("height"), body.get("quality"))})
            match = re.fullmatch(r"/api/jobs/([a-f0-9]{32})/cancel", path)
            if match:
                return self._json(200, self.app.cancel_transcode(match[1]))
            match = re.fullmatch(r"/api/recordings/([a-f0-9]{32})/(finish|upload)", path)
            if match:
                result = self.app.finish_recording(match[1]) if match[2] == "finish" else self.app.queue_upload(match[1], body.get("url"))
                return self._json(200 if match[2] == "finish" else 202, result)
            match = re.fullmatch(r"/api/stream/([a-f0-9]{32})/stop", path)
            if match:
                stream = self.app.get_stream(match[1])
                stream.stop()
                return self._json(200, {"ok": True})
            raise APIError(404, "Endpoint not found")
        except APIError as error:
            self._json(error.status, {"error": error.message})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except OSError:
            self._json(500, {"error": "Local storage or connection failed; media remains saved locally"})


def make_server(app, port=8787):
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    server.app = app
    return server


def main():
    parser = argparse.ArgumentParser(description="RIVET local sports broadcast studio")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--data", type=Path, default=ROOT / "data")
    parser.add_argument("--dist", type=Path, default=ROOT / "dist")
    options = parser.parse_args()
    app = App(options.data, options.dist)
    server = make_server(app, options.port)
    print("RIVET: http://127.0.0.1:" + str(server.server_address[1]) + "/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        app.close()


if __name__ == "__main__":
    main()
