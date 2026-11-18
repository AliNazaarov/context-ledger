"""H7: a model call whose timeout was capped by the read deadline is a 504.

On Windows the socket timeout and time.monotonic() tick at about 15.6 ms, so a
socket can time out while remaining() still shows a few milliseconds left. These
tests make the timeout fire with the deadline still ahead, so they do not depend
on the clock's resolution.
"""

import socket
import time
import unittest
import urllib.error
from unittest import mock

from latent_pool import ApiError
from latent_pool.pool import DEADLINE, _Run
from latent_pool.vllm_client import VllmClient


def raise_timeout(*args, **kwargs):
    raise socket.timeout("timed out")


def raise_http_500(request, *args, **kwargs):
    raise urllib.error.HTTPError(request.full_url, 500, "boom", {}, None)


def run_with(client, seconds_left):
    return _Run(client, "system", time.monotonic() + seconds_left)


class CappedTimeoutTest(unittest.TestCase):
    def call(self, run, opener):
        with mock.patch("latent_pool.vllm_client.urllib.request.urlopen", opener):
            with self.assertRaises(ApiError) as caught:
                run.call("reader", "user", 16)
        return caught.exception

    def test_timeout_capped_by_the_deadline_is_504_with_time_left(self):
        # The deadline (5 s away) is below the client's own 30 s timeout, so it set
        # this call's timeout. The socket times out while remaining() is still > 0.
        run = run_with(VllmClient("http://127.0.0.1:9", "m", timeout=30), 5)
        error = self.call(run, raise_timeout)
        self.assertGreater(run.remaining(), 0)
        self.assertEqual((error.status, error.message), (504, DEADLINE))

    def test_client_timeout_shorter_than_the_deadline_stays_502(self):
        run = run_with(VllmClient("http://127.0.0.1:9", "m", timeout=1), 5)
        error = self.call(run, raise_timeout)
        self.assertEqual((error.status, error.message), (502, "Model server timed out."))

    def test_other_502_with_time_left_stays_502(self):
        run = run_with(VllmClient("http://127.0.0.1:9", "m", timeout=30), 5)
        error = self.call(run, raise_http_500)
        self.assertEqual((error.status, error.message), (502, "Model server returned HTTP 500."))

    def test_other_502_after_the_deadline_is_504_as_before(self):
        client = VllmClient("http://127.0.0.1:9", "m", timeout=30)
        run = run_with(client, 5)

        def late_http_500(request, *args, **kwargs):
            run.deadline = time.monotonic() - 1  # the deadline passes during the call
            raise_http_500(request)

        error = self.call(run, late_http_500)
        self.assertEqual((error.status, error.message), (504, DEADLINE))


if __name__ == "__main__":
    unittest.main()
