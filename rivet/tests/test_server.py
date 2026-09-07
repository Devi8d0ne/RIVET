"""Real HTTP/storage tests; network streaming is isolated behind a fake encoder."""
import http.client
import importlib.util
import json
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).parents[1]))
SPEC = importlib.util.spec_from_file_location("rivet_server", Path(__file__).parents[1] / "server.py")
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.dist = self.root / "dist"
        self.dist.mkdir()
        (self.dist / "index.html").write_text("<h1>RIVET</h1>")
        (self.root / "private.txt").write_text("private")
        self.app = server.App(self.root / "data", self.dist, start_upload_worker=False, start_transcode_worker=False)
        self.httpd = server.make_server(self.app, 0)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.app.close()
        self.temporary.cleanup()

    def request(self, method, path, body=None, headers=None, token=True):
        merged = {}
        if method == "POST":
            merged["Content-Type"] = "application/octet-stream" if isinstance(body, bytes) else "application/json"
            if token:
                merged["X-Rivet-Token"] = self.app.token
            if not isinstance(body, bytes):
                body = json.dumps(body or {}).encode()
        merged.update(headers or {})
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        try:
            connection.request(method, path, body=body, headers=merged)
            response = connection.getresponse()
            raw = response.read()
            return response.status, dict(response.getheaders()), raw
        finally:
            connection.close()

    def json_request(self, method, path, body=None, **kwargs):
        status, headers, raw = self.request(method, path, body, **kwargs)
        return status, json.loads(raw)

    def recording(self):
        status, response = self.json_request("POST", "/api/recordings", {"title": "Home vs Away", "mime": "video/webm;codecs=vp8,opus"})
        self.assertEqual(status, 201)
        return response["id"]

    def test_host_origin_and_session_token_required(self):
        self.assertEqual(self.request("GET", "/api/session", headers={"Host": "attacker.example"})[0], 403)
        self.assertEqual(self.request("GET", "/api/session", headers={"Origin": "https://attacker.example"})[0], 403)
        self.assertEqual(self.request("GET", "/api/session", headers={"Sec-Fetch-Site": "cross-site"})[0], 403)
        self.assertEqual(self.request("POST", "/api/recordings", token=False)[0], 403)
        self.assertEqual(self.request("POST", "/api/recordings", headers={"X-Rivet-Token": "wrong"})[0], 403)
        status, response = self.json_request("GET", "/api/session")
        self.assertEqual(status, 200)
        self.assertEqual(response["token"], self.app.token)

    def test_hardware_selection_is_local_authenticated_and_honest(self):
        self.app.hardware.executable = ""
        status, payload = self.json_request("GET", "/api/status")
        self.assertEqual(status, 200)
        self.assertFalse(payload["hardware"]["available"])
        self.assertEqual(payload["hardware"]["kind"], "cpu")
        self.assertEqual(self.request("POST", "/api/hardware/check", token=False)[0], 403)
        self.assertEqual(self.request("POST", "/api/hardware/selection", {"mode": "android"})[0], 400)
        self.assertEqual(self.request("POST", "/api/hardware/selection", {"mode": ["cpu"]})[0], 400)
        status, payload = self.json_request("POST", "/api/hardware/selection", {"mode": "cpu"})
        self.assertEqual((status, payload["mode"]), (200, "cpu"))
        status, payload = self.json_request("POST", "/api/hardware/check")
        self.assertEqual((status, payload["available"]), (202, False))
        self.recording()
        self.assertEqual(self.request("POST", "/api/hardware/check")[0], 409)
        self.assertEqual(self.request("POST", "/api/hardware/selection", {"mode": "auto"})[0], 409)

    def test_forced_hardware_failure_does_not_silently_use_cpu(self):
        record_id = self.recording()
        self.app.append_recording(record_id, 0, b"original")
        self.app.finish_recording(record_id)
        self.app.ffmpeg = "test-encoder"
        self.app.hardware.mode = "android"
        self.app.hardware.state = "error"
        job_id = self.app.queue_transcode(record_id, 720, "balanced")
        with mock.patch.object(server.subprocess, "Popen") as launch:
            self.app.run_transcode(job_id)
            self.assertEqual(self.app.job(job_id)["status"], "error")
            launch.assert_not_called()
        self.assertEqual(self.app.media_path(record_id).read_bytes(), b"original")

    def test_cross_site_top_level_navigation_opens_only_the_studio_document(self):
        headers = {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"}
        for method in ("GET", "HEAD"):
            for path in ("/", "/index.html"):
                status, response_headers, body = self.request(method, path, headers=headers)
                self.assertEqual((status, response_headers["Content-Type"]), (200, "text/html"))
                self.assertEqual(body, b"<h1>RIVET</h1>" if method == "GET" else b"")
        for path in ("/api/session", "/api/status", "/media/" + "a" * 32):
            self.assertEqual(self.request("GET", path, headers=headers)[0], 403)
        self.assertEqual(self.request("POST", "/", headers=headers)[0], 403)
        self.assertEqual(self.request("POST", "/api/recordings", {"title": "Test", "mime": "video/webm"}, headers=headers)[0], 403)
        self.assertEqual(self.request("GET", "/", headers={**headers, "Host": "attacker.example"})[0], 403)
        self.assertEqual(self.request("GET", "/", headers={**headers, "Origin": "https://attacker.example"})[0], 403)
        self.assertEqual(self.request("GET", "/", headers={**headers, "Sec-Fetch-Dest": "iframe"})[0], 403)
        self.assertEqual(self.request("GET", "/", headers={**headers, "Sec-Fetch-Mode": "cors"})[0], 403)

    def test_ordered_idempotent_chunks_and_conflicts(self):
        record_id = self.recording()
        base = "/api/recordings/" + record_id + "/chunk?seq="
        self.assertEqual(self.request("POST", base + "1", b"second")[0], 409)
        self.assertEqual(self.request("POST", base + "0", b"first")[0], 200)
        self.assertEqual(self.request("POST", base + "0", b"first")[0], 200)
        self.assertEqual(self.request("POST", base + "0", b"changed")[0], 409)
        self.assertEqual(self.request("POST", base + "1", b"second")[0], 200)
        self.assertEqual(self.app.media_path(record_id).read_bytes(), b"firstsecond")
        status, metadata = self.json_request("POST", "/api/recordings/" + record_id + "/finish")
        self.assertEqual((status, metadata["size"], metadata["status"]), (200, 11, "complete"))
        self.assertEqual(self.request("POST", base + "2", b"third")[0], 409)
        self.assertEqual(self.request("POST", base + "1", b"second")[0], 200)

    def test_restart_recovers_acknowledged_partial_and_discards_crash_tail(self):
        record_id = self.recording()
        self.app.append_recording(record_id, 0, b"persisted")
        with self.app.media_path(record_id).open("ab") as output:
            output.write(b"unacknowledged")
        recovered = server.App(self.app.data_dir, self.dist, start_upload_worker=False)
        try:
            self.assertEqual(recovered.record(record_id)["status"], "partial")
            self.assertEqual(recovered.media_path(record_id).read_bytes(), b"persisted")
            recovered.append_recording(record_id, 0, b"persisted")
            recovered.append_recording(record_id, 1, b"next")
            self.assertEqual(recovered.finish_recording(record_id)["size"], 13)
        finally:
            recovered.close()

    def test_byte_ranges_and_head(self):
        record_id = self.recording()
        self.app.append_recording(record_id, 0, b"0123456789")
        for value, expected, content_range in [("bytes=2-5", b"2345", "bytes 2-5/10"),
                                                ("bytes=-3", b"789", "bytes 7-9/10"),
                                                ("bytes=7-", b"789", "bytes 7-9/10")]:
            status, headers, data = self.request("GET", "/media/" + record_id, headers={"Range": value})
            self.assertEqual((status, data, headers["Content-Range"]), (206, expected, content_range))
        self.assertEqual(self.request("GET", "/media/" + record_id, headers={"Range": "bytes=10-11"})[0], 416)
        self.assertEqual(self.request("GET", "/media/" + record_id, headers={"Range": "bytes=0-1,4-5"})[0], 416)
        status, headers, raw = self.request("HEAD", "/media/" + record_id)
        self.assertEqual((status, headers["Content-Length"], raw), (200, "10", b""))

    def test_static_and_media_path_boundaries(self):
        self.assertEqual(self.request("GET", "/")[0], 200)
        for path in ("/../private.txt", "/%2e%2e/private.txt", "/%2e%2e%5cprivate.txt", "/media/../../private.txt", "/server.py", "/data/private.json"):
            self.assertEqual(self.request("GET", path)[0], 404, path)
        self.assertEqual(self.request("GET", "/api/missing")[0], 404)

    def test_body_mime_limits_and_seq_validation(self):
        self.assertEqual(self.request("POST", "/api/recordings", {"title": "bad", "mime": "text/html"})[0], 400)
        record_id = self.recording()
        endpoint = "/api/recordings/" + record_id + "/chunk"
        for query in ("?seq=-1", "?seq=0&seq=1", "?seq=abc", "", "?seq=9999999999999999"):
            self.assertEqual(self.request("POST", endpoint + query, b"x")[0], 400)
        self.assertEqual(self.request("POST", endpoint + "?seq=0", b"")[0], 413)
        with mock.patch.object(server, "MAX_CHUNK", 3):
            self.assertEqual(self.request("POST", endpoint + "?seq=0", b"four")[0], 413)
        self.assertEqual(self.request("POST", endpoint + "?seq=0", b"a", headers={"Content-Type": "text/plain"})[0], 415)

    def test_missing_ffmpeg_and_destination_protocols(self):
        self.app.ffmpeg = None
        status, response = self.json_request("POST", "/api/stream/start", {"url": "rtmps://example.com/live", "key": "secret"})
        self.assertEqual(status, 503)
        self.assertIn("FFmpeg", response["error"])
        for url in ("file:///tmp/output", "http://example.com", "rtmp://user:pass@example.com/live", "rtmp://example.com/live\n"):
            self.assertEqual(self.request("POST", "/api/stream/start", {"url": url, "key": "secret"})[0], 400)

    def test_durable_upload_retry_and_private_url(self):
        record_id = self.recording()
        self.app.append_recording(record_id, 0, b"media")
        self.app.finish_recording(record_id)
        url = "https://example.com/upload?signature=DO-NOT-DISCLOSE"
        status, metadata = self.json_request("POST", "/api/recordings/" + record_id + "/upload", {"url": url})
        self.assertEqual((status, metadata["upload"]["status"]), (202, "queued"))
        self.assertNotIn("DO-NOT-DISCLOSE", json.dumps(metadata))
        with mock.patch.object(self.app, "_put_file", side_effect=OSError("private endpoint")):
            self.app.upload_once(record_id)
        metadata = self.app.public_record(self.app.record(record_id))
        self.assertEqual(metadata["upload"]["status"], "queued")
        self.assertNotIn("private endpoint", json.dumps(metadata))
        recovered = server.App(self.app.data_dir, self.dist, start_upload_worker=False)
        try:
            upload = recovered.record(record_id)["upload"]
            self.assertEqual(upload["url"], url)
            upload["next_attempt"] = 0
            with mock.patch.object(recovered, "_put_file", return_value=201):
                recovered.upload_once(record_id)
            self.assertEqual(upload["status"], "complete")
            self.assertNotIn("url", upload)
        finally:
            recovered.close()

    def test_upload_rejects_non_https_and_does_not_follow_redirect(self):
        record_id = self.recording()
        self.app.append_recording(record_id, 0, b"media")
        self.app.finish_recording(record_id)
        self.assertEqual(self.request("POST", "/api/recordings/" + record_id + "/upload", {"url": "http://example.com"})[0], 400)
        self.app.queue_upload(record_id, "https://example.com/signed")
        connection = mock.MagicMock()
        connection.getresponse.return_value.status = 307
        with mock.patch.object(server.http.client, "HTTPSConnection", return_value=connection) as factory:
            self.app.upload_once(record_id)
        factory.assert_called_once_with("example.com", 443, timeout=20)
        connection.putrequest.assert_called_once_with("PUT", "/signed")
        self.assertEqual(self.app.record(record_id)["upload"]["status"], "failed")

    def test_transcode_queue_validation_cancel_and_restart(self):
        record_id = self.recording()
        self.app.append_recording(record_id, 0, b"saved video")
        self.app.finish_recording(record_id)
        self.app.ffmpeg = "test-encoder"
        endpoint = "/api/recordings/" + record_id + "/transcode"
        for body in ({"height": 999, "quality": "balanced"}, {"height": 720, "quality": {}},
                     {"height": True, "quality": "high"}):
            self.assertEqual(self.request("POST", endpoint, body)[0], 400)
        status, payload = self.json_request("POST", endpoint, {"height": 480, "quality": "small"})
        self.assertEqual(status, 202)
        job_id = payload["jobId"]
        _, payload = self.json_request("GET", "/api/jobs")
        self.assertEqual(payload["jobs"][0]["status"], "queued")
        status, payload = self.json_request("POST", "/api/jobs/" + job_id + "/cancel")
        self.assertEqual((status, payload["status"]), (200, "cancelled"))
        for _ in range(server.MAX_TRANSCODE_JOBS):
            self.app.queue_transcode(record_id, 360, "balanced")
        self.assertEqual(self.request("POST", endpoint, {"height": 360, "quality": "balanced"})[0], 429)
        recovered = server.App(self.app.data_dir, self.dist, start_upload_worker=False, start_transcode_worker=False)
        try:
            states = [job["status"] for job in recovered.jobs.values()]
            self.assertEqual(states.count("interrupted"), server.MAX_TRANSCODE_JOBS)
            self.assertEqual(states.count("cancelled"), 1)
        finally:
            recovered.close()

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg/ffprobe are not installed")
    def test_real_transcode_creates_playable_h264_aac_mp4_and_keeps_original(self):
        source = self.root / "source.webm"
        make_test_video(source)
        record_id = self.recording()
        original_bytes = source.read_bytes()
        self.app.append_recording(record_id, 0, original_bytes)
        self.app.finish_recording(record_id)
        job_id = self.app.queue_transcode(record_id, 360, "balanced")
        self.app.run_transcode(job_id)
        job = self.app.job(job_id)
        self.assertEqual(job["status"], "complete", job)
        self.assertEqual(job["progress"], 1)
        result_id = job["resultId"]
        self.assertNotEqual(result_id, record_id)
        self.assertEqual(self.app.media_path(record_id).read_bytes(), original_bytes)
        output = subprocess.run([shutil.which("ffprobe"), "-v", "error", "-show_streams", "-of", "json",
                                 str(self.app.media_path(result_id))], capture_output=True, timeout=10)
        streams = json.loads(output.stdout)["streams"]
        self.assertEqual({item["codec_name"] for item in streams}, {"h264", "aac"})
        self.assertEqual(next(item for item in streams if item["codec_type"] == "video")["height"], 360)
        status, headers, data = self.request("GET", "/media/" + result_id, headers={"Range": "bytes=0-31"})
        self.assertEqual((status, headers["Content-Type"], len(data)), (206, "video/mp4", 32))
        recovered = server.App(self.app.data_dir, self.dist, start_upload_worker=False, start_transcode_worker=False)
        try:
            self.assertEqual(recovered.record(result_id)["mime"], "video/mp4")
            self.assertTrue(recovered.media_path(result_id).is_file())
            self.assertEqual(recovered.job(job_id)["resultId"], result_id)
        finally:
            recovered.close()

    def test_running_transcode_can_be_cancelled(self):
        record_id = self.recording()
        self.app.append_recording(record_id, 0, b"original")
        self.app.finish_recording(record_id)
        self.app.ffmpeg = "test-encoder"
        job_id = self.app.queue_transcode(record_id, 720, "balanced")
        started = threading.Event()
        finished = threading.Event()

        class ProgressPipe:
            def readline(self, size):
                finished.wait(3)
                return b""

            def close(self):
                finished.set()

        class Process:
            stdout = ProgressPipe()
            returncode = None

            def __init__(self, *args, **kwargs):
                started.set()

            def poll(self):
                return self.returncode

            def terminate(self):
                self.returncode = -15
                finished.set()

            kill = terminate

            def wait(self, timeout=None):
                return self.returncode

        with mock.patch.object(self.app, "_media_duration", return_value=None), mock.patch.object(server.subprocess, "Popen", Process):
            worker = threading.Thread(target=self.app.run_transcode, args=(job_id,))
            worker.start()
            self.assertTrue(started.wait(2))
            self.app.cancel_transcode(job_id)
            worker.join(timeout=3)
            self.assertFalse(worker.is_alive())
        self.assertEqual(self.app.job(job_id)["status"], "cancelled")
        self.assertEqual(self.app.media_path(record_id).read_bytes(), b"original")

    def test_multi_destination_validation_and_single_encoder_dispatch(self):
        self.app.ffmpeg = "test-encoder"
        destinations = [{"url": "rtmps://example.com/live", "key": "private" + str(i)} for i in range(4)]
        with mock.patch.object(server, "Broadcast") as encoder:
            encoder.return_value.id = "a" * 32
            _, payload = self.json_request("POST", "/api/stream/start", {"destinations": destinations})
            self.assertEqual(payload["id"], "a" * 32)
            encoder.assert_called_once()
            self.assertEqual(len(encoder.call_args.args[1]), 4)
            self.assertEqual(encoder.call_args.kwargs["quality"], "standard")
        self.app.broadcast = None
        for entries in ([], destinations + [destinations[0]],
                        [{"url": "rtmp://example.com/live", "key": "bad|output"}, destinations[0]],
                        [{"url": "rtmp://example.com/live", "key": "bad'quote"}, destinations[0]],
                        [{"url": "file:///tmp/out", "key": ""}]):
            self.assertEqual(self.request("POST", "/api/stream/start", {"destinations": entries})[0], 400)

    def test_quality_profile_is_validated_and_forwarded(self):
        self.app.ffmpeg = "test-encoder"
        for quality in (None, {}, "-b:v 999999k", "ultra"):
            self.assertEqual(self.request("POST", "/api/stream/start", {
                "url": "rtmp://example.com/live", "key": "test", "quality": quality})[0], 400)
        with mock.patch.object(server, "Broadcast") as encoder:
            encoder.return_value.id = "a" * 32
            self.assertEqual(self.request("POST", "/api/stream/start", {
                "url": "rtmp://example.com/live", "key": "test", "quality": "high"})[0], 201)
            self.assertEqual(encoder.call_args.kwargs["quality"], "high")
        self.app.broadcast = None

    def test_live_production_and_offline_conversion_do_not_compete(self):
        self.app.ffmpeg = "test-encoder"
        self.app.active_job_id = "a" * 32
        status, response = self.json_request("POST", "/api/stream/start", {"url": "rtmp://example.com/live", "key": "test"})
        self.assertEqual(status, 409)
        self.assertIn("Finish or cancel", response["error"])
        self.app.active_job_id = None
        record_id = self.recording()
        self.app.append_recording(record_id, 0, b"stored video")
        self.app.finish_recording(record_id)
        job_id = self.app.queue_transcode(record_id, 720, "balanced")
        self.app.broadcast = mock.Mock(done=threading.Event())
        with mock.patch.object(server.subprocess, "Popen") as encoder:
            self.app.run_transcode(job_id)
            encoder.assert_not_called()
        self.assertEqual(self.app.job(job_id)["status"], "queued")
        self.app.broadcast = None


def make_test_video(path):
    created = subprocess.run([shutil.which("ffmpeg"), "-v", "error", "-f", "lavfi", "-i",
                              "color=c=blue:s=320x180:r=15", "-f", "lavfi", "-i",
                              "sine=frequency=440:sample_rate=48000", "-t", "1",
                              "-c:v", "libvpx", "-b:v", "300k", "-c:a", "libopus", str(path)],
                             stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=15)
    if created.returncode:
        raise AssertionError(created.stderr.decode(errors="replace"))


class FakePipe:
    def __init__(self):
        self.entered = threading.Event()
        self.release = threading.Event()
        self.data = []
        self.closed = False

    def write(self, chunk):
        self.entered.set()
        self.release.wait(3)
        self.data.append(chunk)

    def flush(self):
        pass

    def close(self):
        self.closed = True


class FakeProcess:
    def __init__(self, *args, **kwargs):
        self.arguments, self.options = args, kwargs
        self.stdin = FakePipe()
        self.returncode = None

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        self.returncode = 0 if self.returncode is None else self.returncode
        return self.returncode

    def kill(self):
        self.returncode = -9
        self.stdin.release.set()


class BroadcastTests(unittest.TestCase):
    def test_encoder_quality_presets_and_total_buffer_bound(self):
        for quality, bitrate, gop in (("light", "1200k", "48"), ("standard", "3000k", "60"), ("high", "6000k", "60")):
            broadcast = server.Broadcast("ffmpeg", "rtmp://example.com/live/test", popen=FakeProcess, quality=quality)
            try:
                arguments = broadcast.process.arguments[0]
                self.assertEqual(arguments[arguments.index("-b:v") + 1], bitrate)
                self.assertEqual(arguments[arguments.index("-maxrate") + 1], bitrate)
                self.assertEqual(arguments[arguments.index("-g") + 1], gop)
                self.assertEqual(arguments[arguments.index("-bufsize") + 1], str(int(bitrate[:-1]) * 2) + "k")
                if quality == "high":
                    data = bytes(8 * 1024 * 1024)
                    broadcast.append(0, data)
                    self.assertTrue(broadcast.process.stdin.entered.wait(1))
                    for seq in range(1, 4):
                        broadcast.append(seq, data)
                    with self.assertRaises(server.APIError) as raised:
                        broadcast.append(4, data)
                    self.assertEqual(raised.exception.status, 429)
                    self.assertEqual(broadcast.queued_bytes, server.STREAM_QUEUE_BYTES)
            finally:
                broadcast.process.stdin.release.set()
                broadcast.stop()
                self.assertTrue(broadcast.done.wait(2))
                self.assertEqual(broadcast.queued_bytes, 0)

    def test_missing_browser_input_kills_orphan_encoder_and_releases_resources(self):
        broadcast = server.Broadcast("ffmpeg", "rtmp://example.com/live/private", popen=FakeProcess, idle_timeout=0.08)
        broadcast.append(0, b"first chunk")
        self.assertTrue(broadcast.process.stdin.entered.wait(1))
        # The fake encoder is blocked on stdin; the independent watchdog must
        # terminate it even though the writer cannot run its own timeout check.
        self.assertTrue(broadcast.done.wait(2))
        self.assertEqual(broadcast.process.returncode, -9)
        self.assertTrue(broadcast.process.stdin.closed)
        status = broadcast.public()
        self.assertEqual(status["status"], "error")
        self.assertIn("no new media", status["error"])
        self.assertNotIn("private", json.dumps(status))

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg is not installed")
    def test_real_tee_writes_both_outputs_and_fails_if_one_output_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.webm"
            make_test_video(source)
            targets = [(root / "first.flv").as_posix(), (root / "second.flv").as_posix()]
            broadcast = server.Broadcast(shutil.which("ffmpeg"), targets)
            broadcast.append(0, source.read_bytes())
            broadcast.stop()
            self.assertTrue(broadcast.done.wait(10))
            self.assertEqual(broadcast.public()["status"], "stopped")
            self.assertTrue(all(Path(path).stat().st_size > 0 for path in targets))
            failed = server.Broadcast(shutil.which("ffmpeg"), [(root / "third.flv").as_posix(),
                                      (root / "missing" / "fourth.flv").as_posix()])
            failed.append(0, source.read_bytes())
            failed.stop()
            self.assertTrue(failed.done.wait(10))
            self.assertEqual(failed.public()["status"], "error")

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg is not installed")
    def test_real_encoder_preserves_video_and_audio(self):
        executable = shutil.which("ffmpeg")
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.webm"
            destination = Path(directory) / "output.flv"
            created = subprocess.run([executable, "-v", "error", "-f", "lavfi", "-i",
                                      "color=c=blue:s=320x180:r=15", "-f", "lavfi", "-i",
                                      "sine=frequency=440:sample_rate=48000", "-t", "1",
                                      "-c:v", "libvpx", "-b:v", "300k", "-c:a", "libopus", str(source)],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=15)
            self.assertEqual(created.returncode, 0, created.stderr.decode(errors="replace"))
            broadcast = server.Broadcast(executable, str(destination))
            broadcast.append(0, source.read_bytes())
            broadcast.stop()
            self.assertTrue(broadcast.done.wait(10))
            self.assertEqual(broadcast.public()["status"], "stopped")
            checked = subprocess.run([executable, "-v", "error", "-i", str(destination),
                                      "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=15)
            self.assertEqual(checked.returncode, 0, checked.stderr.decode(errors="replace"))

    def test_queue_backpressure_idempotency_and_graceful_stop(self):
        broadcast = server.Broadcast("ffmpeg", "rtmps://example.com/live/PRIVATE", popen=FakeProcess)
        try:
            broadcast.append(0, b"zero")
            self.assertTrue(broadcast.process.stdin.entered.wait(1))
            for seq in range(1, server.STREAM_QUEUE_SIZE + 1):
                broadcast.append(seq, str(seq).encode())
            broadcast.append(1, b"1")
            with self.assertRaises(server.APIError) as raised:
                broadcast.append(server.STREAM_QUEUE_SIZE + 1, b"overflow")
            self.assertEqual(raised.exception.status, 429)
            with self.assertRaises(server.APIError) as raised:
                broadcast.append(1, b"changed")
            self.assertEqual(raised.exception.status, 409)
            self.assertNotIn("PRIVATE", json.dumps(broadcast.public()))
            self.assertFalse(broadcast.process.options["shell"])
            broadcast.stop()
            with self.assertRaises(server.APIError):
                broadcast.append(server.STREAM_QUEUE_SIZE + 1, b"late")
            broadcast.process.stdin.release.set()
            self.assertTrue(broadcast.done.wait(2))
            self.assertEqual(broadcast.public()["status"], "stopped")
            self.assertEqual(len(broadcast.process.stdin.data), server.STREAM_QUEUE_SIZE + 1)
        finally:
            broadcast.process.stdin.release.set()
            broadcast.stop()
            broadcast.done.wait(2)

    def test_encoder_start_failure_redacts_destination(self):
        def failed(*args, **kwargs):
            raise OSError("private destination key")
        with self.assertRaises(server.APIError) as raised:
            server.Broadcast("ffmpeg", "rtmp://example.com/PRIVATE", popen=failed)
        self.assertNotIn("private", raised.exception.message)
        self.assertNotIn("PRIVATE", raised.exception.message)


if __name__ == "__main__":
    unittest.main()
