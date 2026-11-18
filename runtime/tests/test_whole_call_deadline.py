"""H8: a model call keeps to its whole budget, not to a timeout per socket read.

A synthetic model server trickles its reply a byte at a time, so every single read
is quick but the reply as a whole is late. The call must stop at its budget and a
late reply must never be used.
"""

import json
import socket
import threading
import time
import unittest
import urllib.error
from unittest import mock

from latent_pool import ApiError, ModelTimeout
from latent_pool.pool import DEADLINE, _Run
from latent_pool.vllm_client import NOT_READY, VllmClient

REPLY = json.dumps({"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}]}).encode()


class TrickleServer:
    """Answers one request at a time; mode is 'body', 'headers' or 'whole'.

    'body' sends the headers at once and the body a byte every `gap` seconds;
    'headers' trickles the status line and headers too; 'whole' answers at once.
    """

    def __init__(self, mode, gap=0.05):
        self.mode = mode
        self.gap = gap
        self.listener = socket.create_server(("127.0.0.1", 0))
        self.listener.settimeout(0.2)
        self.closing = False
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.listener.getsockname()[1]}/v1"

    def close(self):
        self.closing = True
        self.thread.join(5)
        self.listener.close()

    def _serve(self):
        while not self.closing:
            try:
                conn, _ = self.listener.accept()
            except (socket.timeout, OSError):
                continue
            threading.Thread(target=self._answer, args=(conn,), daemon=True).start()

    def _answer(self, conn):
        try:
            data = b""
            while b"\r\n\r\n" not in data:
                chunk = conn.recv(65536)
                if not chunk:
                    return
                data += chunk
            head, _, body = data.partition(b"\r\n\r\n")
            length = 0
            for line in head.split(b"\r\n")[1:]:
                name, _, value = line.partition(b":")
                if name.strip().lower() == b"content-length":
                    length = int(value.strip())
            while len(body) < length:
                chunk = conn.recv(65536)
                if not chunk:
                    return
                body += chunk
            headers = (b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                       b"Content-Length: %d\r\nConnection: close\r\n\r\n" % len(REPLY))
            if self.mode == "error503":
                # The status line and headers at once, then the error body trickled.
                text = b'{"error": "model is loading, please wait a little longer"}'
                conn.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\n"
                             b"Content-Length: %d\r\nConnection: close\r\n\r\n" % len(text))
                for index in range(len(text)):
                    if self.closing:
                        return
                    conn.sendall(text[index:index + 1])
                    time.sleep(self.gap)
                return
            if self.mode == "truncated400":
                # Says 100 bytes, sends 10, and hangs up.
                conn.sendall(b"HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\n"
                             b"Content-Length: 100\r\nConnection: close\r\n\r\n0123456789")
                return
            if self.mode == "whole":
                conn.sendall(headers + REPLY)
                return
            if self.mode == "body":
                conn.sendall(headers)
                slow = REPLY
            else:
                slow = headers + REPLY
            for index in range(len(slow)):
                if self.closing:
                    return
                conn.sendall(slow[index:index + 1])
                time.sleep(self.gap)
        except OSError:
            pass  # the client gave up, which is what these tests expect
        finally:
            conn.close()


def run_with(client, seconds_left):
    return _Run(client, "system", time.monotonic() + seconds_left)


class TrickledReplyTest(unittest.TestCase):
    def read(self, mode, client_timeout, seconds_left):
        server = TrickleServer(mode)
        try:
            run = run_with(VllmClient(server.url, "m", timeout=client_timeout), seconds_left)
            started = time.monotonic()
            with self.assertRaises(ApiError) as caught:
                run.call("reader", "user", 16)
            return caught.exception, time.monotonic() - started
        finally:
            server.close()

    def test_trickled_body_stops_at_the_deadline(self):
        # The body takes about 3 s at one byte per 50 ms; the deadline is 1 s away.
        error, elapsed = self.read("body", client_timeout=30, seconds_left=1)
        self.assertEqual((error.status, error.message), (504, DEADLINE))
        self.assertLess(elapsed, 2)

    def test_trickled_headers_stop_at_the_deadline(self):
        error, elapsed = self.read("headers", client_timeout=30, seconds_left=1)
        self.assertEqual((error.status, error.message), (504, DEADLINE))
        self.assertLess(elapsed, 2)

    def test_clients_own_timeout_stays_502(self):
        # The client's 0.5 s timeout is the shorter limit, so this is the model's timeout.
        error, elapsed = self.read("body", client_timeout=0.5, seconds_left=5)
        self.assertEqual((error.status, error.message), (502, "Model server timed out."))
        self.assertLess(elapsed, 1.5)

    def test_a_late_reply_is_a_timeout_not_a_result(self):
        server = TrickleServer("body", gap=0.015)  # about 1 s for the whole body
        try:
            client = VllmClient(server.url, "m", timeout=30)
            started = time.monotonic()
            with self.assertRaises(ModelTimeout):
                client.chat("system", "user", 16, timeout=0.5)
            self.assertLess(time.monotonic() - started, 1)
        finally:
            server.close()

    def test_a_prompt_reply_is_still_used(self):
        server = TrickleServer("whole")
        try:
            run = run_with(VllmClient(server.url, "m", timeout=30), 5)
            result = run.call("reader", "user", 16)
        finally:
            server.close()
        self.assertEqual(result.content, "ok")
        self.assertEqual(len(run.calls), 1)


class _SilentTimer:
    """A watch timer that never fires, as if its thread had not been scheduled yet."""

    def __init__(self, *args, **kwargs):
        self.daemon = True

    def start(self):
        pass

    def cancel(self):
        pass


class ReviewRoundOneTest(unittest.TestCase):
    """Codex review of 5686880."""

    def test_a_late_reply_is_refused_even_if_the_timer_has_not_run(self):
        server = TrickleServer("body", gap=0.02)  # about 1.4 s for the whole body
        try:
            client = VllmClient(server.url, "m", timeout=30)
            with mock.patch("latent_pool.vllm_client.threading.Timer", _SilentTimer):
                with self.assertRaises(ModelTimeout):
                    client.chat("system", "user", 16, timeout=0.3)
        finally:
            server.close()

    def test_a_slow_503_body_after_the_deadline_is_504(self):
        server = TrickleServer("error503")
        try:
            run = run_with(VllmClient(server.url, "m", timeout=30), 1)
            started = time.monotonic()
            with self.assertRaises(ApiError) as caught:
                run.call("reader", "user", 16)
            elapsed = time.monotonic() - started
        finally:
            server.close()
        self.assertEqual((caught.exception.status, caught.exception.message), (504, DEADLINE))
        self.assertLess(elapsed, 2)

    def test_a_truncated_error_body_is_still_mapped(self):
        server = TrickleServer("truncated400")
        try:
            run = run_with(VllmClient(server.url, "m", timeout=30), 5)
            with self.assertRaises(ApiError) as caught:
                run.call("reader", "user", 16)
        finally:
            server.close()
        self.assertEqual((caught.exception.status, caught.exception.message),
                         (502, "Model server returned HTTP 400."))

    def test_a_stalled_name_lookup_stops_at_the_deadline(self):
        real = socket.getaddrinfo

        def stalled(host, *args, **kwargs):
            if host == "model.invalid":
                time.sleep(3)
            return real(host, *args, **kwargs)

        client = VllmClient("http://model.invalid:8000/v1", "m", timeout=30)
        started = time.monotonic()
        with mock.patch("latent_pool.vllm_client.socket.getaddrinfo", stalled):
            with self.assertRaises(ModelTimeout):
                client.chat("system", "user", 16, timeout=0.5)
        self.assertLess(time.monotonic() - started, 1.5)

    def test_a_stalled_tls_handshake_stops_at_the_deadline(self):
        listener = socket.create_server(("127.0.0.1", 0))
        held = []
        stop = threading.Event()

        def accept_and_say_nothing():
            listener.settimeout(0.2)
            while not stop.is_set():
                try:
                    held.append(listener.accept()[0])
                except OSError:
                    continue

        thread = threading.Thread(target=accept_and_say_nothing, daemon=True)
        thread.start()
        try:
            client = VllmClient(f"https://127.0.0.1:{listener.getsockname()[1]}/v1", "m", timeout=30)
            started = time.monotonic()
            with self.assertRaises(ModelTimeout):
                client.chat("system", "user", 16, timeout=0.5)
            self.assertLess(time.monotonic() - started, 1.5)
        finally:
            stop.set()
            thread.join(5)
            for conn in held:
                conn.close()
            listener.close()


class ConnectTimeoutTest(unittest.TestCase):
    def call(self, run, error):
        def fail(request, *args, **kwargs):
            raise error
        with mock.patch("latent_pool.vllm_client._open", fail):
            with self.assertRaises(ApiError) as caught:
                run.call("reader", "user", 16)
        return caught.exception

    def test_connect_timeout_capped_by_the_deadline_is_504(self):
        run = run_with(VllmClient("http://127.0.0.1:9", "m", timeout=30), 5)
        error = self.call(run, urllib.error.URLError(socket.timeout("timed out")))
        self.assertEqual((error.status, error.message), (504, DEADLINE))

    def test_connect_timeout_on_the_clients_own_timeout_is_502(self):
        run = run_with(VllmClient("http://127.0.0.1:9", "m", timeout=1), 5)
        error = self.call(run, urllib.error.URLError(socket.timeout("timed out")))
        self.assertEqual((error.status, error.message), (502, "Model server timed out."))

    def test_refused_connection_stays_503(self):
        run = run_with(VllmClient("http://127.0.0.1:9", "m", timeout=30), 5)
        error = self.call(run, urllib.error.URLError(ConnectionRefusedError("refused")))
        self.assertEqual((error.status, error.message), (503, NOT_READY))


if __name__ == "__main__":
    unittest.main()
