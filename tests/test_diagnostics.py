import contextlib
import errno
import io
import http.client
import json
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import server


class DiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="felt-night-diagnostics-")
        data_dir = Path(self.temp.name) / "data"
        args = types.SimpleNamespace(
            public_origin="http://localhost:1",
            data_dir=str(data_dir),
        )
        self.app = server.App(args, room_password="diagnostic-test-invite")
        self.httpd = server.LimitedThreadingHTTPServer(
            ("127.0.0.1", 0), server.Handler, self.app,
        )
        self.port = self.httpd.server_port
        self.origin = "http://localhost:%d" % self.port
        self.app.public_origin = self.origin
        self.app.public_netloc = "localhost:%d" % self.port
        self.app.secure_cookie = False
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def request(self, method, target, payload=None, headers=None):
        request_headers = {
            "Host": self.app.public_netloc,
            "Origin": self.origin,
        }
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
            request_headers["Content-Length"] = str(len(body))
        else:
            body = None
        request_headers.update(headers or {})
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request(method, target, body=body, headers=request_headers)
        response = connection.getresponse()
        response_body = response.read()
        response_headers = dict(response.getheaders())
        connection.close()
        try:
            parsed_body = json.loads(response_body.decode("utf-8")) if response_body else None
        except ValueError:
            parsed_body = response_body
        return response.status, response_headers, parsed_body

    def events(self):
        path = Path(self.app.store.data_dir) / "diagnostics.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]

    def event_for(self, request_id):
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            for event in self.events():
                if event.get("request_id") == request_id:
                    return event
            time.sleep(0.01)
        self.fail("diagnostic event for request %s was not written" % request_id)

    def account_headers(self, name):
        player, token = self.app.store.create_account(name, name, "test-password", time.time())
        return player, {
            "Cookie": "%s=%s" % (self.app.cookie_name, token),
            "X-SitNgo-Session": self.app.store.session_proof(token),
        }

    def test_admin_logs_require_current_admin_role(self):
        admin, headers = self.account_headers("logadmin")
        other, other_headers = self.account_headers("logplayer")
        self.assertEqual(self.request("GET", "/poker/api/admin/logs")[0], 401)
        self.assertEqual(self.request("GET", "/poker/api/admin/logs", headers=other_headers)[0], 403)
        self.assertEqual(self.request("GET", "/poker/api/admin/logs", headers=headers)[0], 200)
        with contextlib.closing(self.app.store.connect()) as db:
            db.execute("UPDATE accounts SET is_admin=CASE WHEN player_id=? THEN 1 ELSE 0 END", (other["id"],))
            db.commit()
        self.assertEqual(self.request("GET", "/poker/api/admin/logs", headers=headers)[0], 403)

    def test_admin_logs_filter_short_and_full_references_and_validate_queries(self):
        _, headers = self.account_headers("logadmin")
        logger = self.app.diagnostics
        ref = "cafebabe" + "a" * 24
        logger.emit({"event": "http_request", "status": 500, "request_id": ref,
                     "error_code": "internal_error", "exception": {"class": "RuntimeError", "frames": []}})
        logger.emit({"event": "http_request", "status": 200, "request_id": "b" * 32})
        for prefix in ("CAFEBABE", ref):
            status, _, data = self.request("GET", "/poker/api/admin/logs?reference=" + prefix, headers=headers)
            self.assertEqual(status, 200)
            self.assertEqual([e["request_id"] for e in data["entries"]], [ref])
        _, _, data = self.request("GET", "/poker/api/admin/logs?reference=bbbb&scope=all", headers=headers)
        self.assertEqual(data["entries"][0]["status"], 200)
        _, _, data = self.request("GET", "/poker/api/admin/logs?reference=bbbb", headers=headers)
        self.assertEqual(data["entries"], [])
        for query in ("reference=../secret", "reference=xyz", "reference=abcd&reference=eeee", "scope=invalid", "file=foo"):
            self.assertEqual(self.request("GET", "/poker/api/admin/logs?" + query, headers=headers)[0], 400)

    def test_log_reader_searches_rotated_files_and_skips_partial_lines(self):
        logger = server.DiagnosticLogger(self.app.store.data_dir, max_bytes=1024, backups=3)
        self.assertEqual(logger.recent()["entries"], [])
        ref = "cafebabe" + "c" * 24
        logger.emit({"event": "http_request", "status": 500, "request_id": ref})
        for i in range(12):
            logger.emit({"event": "http_request", "status": 200, "request_id": "%032x" % i})
        self.assertTrue(Path(logger.path + ".1").exists())
        with open(logger.path, "ab") as stream:
            stream.write(b'broken line\n{"partial":')
        result = logger.recent("cafebabe")
        self.assertEqual([e["request_id"] for e in result["entries"]], [ref])
        self.assertEqual(len(logger.recent(scope="all", limit=2)["entries"]), 2)
        self.assertTrue(logger.recent(scope="all", limit=2)["has_more"])

    def test_route_labels_hide_identifiers_queries_and_unmatched_paths(self):
        table_id = "a" * 32
        self.assertEqual(
            server._diagnostic_route(
                "/poker/api/tables/%s/action?session_token=PRIVATE_QUERY" % table_id,
            ),
            "/poker/api/tables/{id}/action",
        )
        self.assertEqual(
            server._diagnostic_route("/private/PRIVATE_PATH?token=PRIVATE_QUERY"),
            "unmatched",
        )
        self.assertEqual(
            server._diagnostic_route("/poker/api/tables/not-an-id/action"),
            "unmatched",
        )

    def test_unexpected_error_has_request_id_and_privacy_filtered_stack(self):
        private_exception = "PRIVATE_EXCEPTION_TEXT"
        private_query = "PRIVATE_QUERY_VALUE"
        original_headers = server.Handler._headers

        def fail_health_check(handler):
            if handler.path.startswith("/poker/healthz"):
                raise RuntimeError(private_exception)
            return original_headers(handler)

        with patch.object(server.Handler, "_headers", fail_health_check):
            status, headers, body = self.request(
                "GET", "/poker/healthz?session_token=" + private_query,
            )

        self.assertEqual(status, 500)
        self.assertEqual(body["error"]["code"], "internal_error")
        request_id = headers["X-Request-ID"]
        self.assertRegex(request_id, r"^[a-f0-9]{32}$")
        event = self.event_for(request_id)
        self.assertEqual(event["event"], "http_request")
        self.assertEqual(event["method"], "GET")
        self.assertEqual(event["route"], "/poker/healthz")
        self.assertEqual(event["status"], 500)
        self.assertEqual(event["error_code"], "internal_error")
        self.assertEqual(event["exception"]["class"], "builtins.RuntimeError")
        self.assertTrue(any(frame["function"] == "do_GET" for frame in event["exception"]["frames"]))
        serialized = json.dumps(event)
        self.assertNotIn(private_exception, serialized)
        self.assertNotIn(private_query, serialized)
        self.assertNotIn("session_token", serialized)

    def test_stale_action_log_includes_versions_without_body_secrets(self):
        player, token = self.app.store.create_account(
            "diagnostic-player", "Diagnostic Player", "private-account-password", time.time(),
        )
        table_id = "b" * 32
        secret_amount = 987654321

        def fake_mutate(_table_id, mutate, now):
            return mutate({
                "hand_no": 12,
                "turn_version": 34,
                "paused": False,
            })

        headers = {
            "Cookie": "%s=%s" % (self.app.cookie_name, token),
            "X-SitNgo-Session": self.app.store.session_proof(token),
            "X-SitNgo-CSRF": self.app.store.csrf_token(token),
        }
        with patch.object(self.app.store, "mutate_table", side_effect=fake_mutate):
            status, response_headers, body = self.request(
                "POST",
                "/poker/api/tables/%s/action" % table_id,
                {
                    "action": "check",
                    "amount": secret_amount,
                    "expected_hand": 3,
                    "expected_turn_version": 34,
                },
                headers,
            )

        self.assertEqual(status, 409)
        self.assertEqual(body["error"]["code"], "stale_hand")
        event = self.event_for(response_headers["X-Request-ID"])
        self.assertEqual(event["route"], "/poker/api/tables/{id}/action")
        self.assertEqual(event["error_code"], "stale_hand")
        self.assertEqual(event["action"], {
            "table_id": table_id,
            "action": "check",
            "expected_hand": 3,
            "expected_turn_version": 34,
            "current_hand": 12,
            "current_turn_version": 34,
            "paused": False,
        })
        serialized = json.dumps(event)
        self.assertNotIn(str(secret_amount), serialized)
        self.assertNotIn(token, serialized)
        self.assertNotIn("private-account-password", serialized)

    def test_diagnostics_sink_failure_does_not_change_http_response(self):
        with contextlib.redirect_stderr(io.StringIO()):
            with patch("server.os.open", side_effect=PermissionError(errno.EACCES, "private path")):
                status, _headers, body = self.request("GET", "/poker/healthz")

        self.assertEqual(status, 200)
        self.assertEqual(body, {"status": "ok"})

    def test_worker_capacity_returns_correlated_503_and_logs_it(self):
        current_slots = self.httpd._slots
        self.httpd._slots = threading.Semaphore(0)
        try:
            status, headers, body = self.request("GET", "/private/raw-path?token=PRIVATE_QUERY")
        finally:
            self.httpd._slots = current_slots

        self.assertEqual(status, 503)
        self.assertEqual(body["error"]["code"], "worker_capacity")
        event = self.event_for(headers["X-Request-ID"])
        self.assertEqual(event["event"], "worker_capacity")
        self.assertEqual(event["status"], 503)
        self.assertEqual(event["error_code"], "worker_capacity")
        self.assertEqual(event["route"], "unparsed")
        serialized = json.dumps(event)
        self.assertNotIn("raw-path", serialized)
        self.assertNotIn("PRIVATE_QUERY", serialized)

    def test_broken_pipe_does_not_attempt_a_second_response(self):
        class BrokenWriter:
            def write(self, _body):
                raise BrokenPipeError(errno.EPIPE, "PRIVATE_SOCKET_ERROR")

        handler = object.__new__(server.Handler)
        handler._diagnostic_id = "a" * 32
        handler._diagnostic_status = None
        handler._diagnostic_error_code = None
        handler._diagnostic_disconnect = None
        handler.close_connection = False
        handler.wfile = BrokenWriter()
        responses = []
        handler.send_response = lambda status: responses.append(status)
        handler.send_header = lambda *_args: None
        handler.end_headers = lambda: None

        handler._send(200, b"response body")

        self.assertEqual(responses, [200])
        self.assertTrue(handler.close_connection)
        self.assertEqual(handler._diagnostic_disconnect["kind"], "client_disconnect")
        self.assertEqual(handler._diagnostic_disconnect["class"], "BrokenPipeError")

    def test_timeout_error_logging_ignores_format_and_exception_text(self):
        handler = object.__new__(server.Handler)
        handler._diagnostic_disconnect = None
        handler._diagnostic_exception = None
        handler.close_connection = False
        try:
            raise TimeoutError("PRIVATE_TIMEOUT_TEXT")
        except TimeoutError:
            handler.log_error("Request line contained PRIVATE_RAW_PATH: %r", "private")
        self.assertEqual(handler._diagnostic_disconnect["kind"], "client_timeout")
        serialized = json.dumps(handler._diagnostic_exception)
        self.assertNotIn("PRIVATE_TIMEOUT_TEXT", serialized)
        self.assertNotIn("PRIVATE_RAW_PATH", serialized)

    def test_ticker_errors_are_logged_without_exception_text(self):
        class Cursor:
            def fetchall(self):
                return [{"id": "c" * 32}]

        class Connection:
            def execute(self, _query):
                return Cursor()

            def close(self):
                pass

        private_error = "PRIVATE_TICK_ERROR"
        with patch.object(self.app.store, "connect", return_value=Connection()):
            with patch.object(
                self.app.store, "mutate_table", side_effect=RuntimeError(private_error),
            ):
                self.app.store.tick_all(time.time())

        event = next(
            event for event in self.events()
            if event.get("event") == "background_tick_error"
        )
        self.assertEqual(event["component"], "table_tick")
        self.assertEqual(event["table_id"], "c" * 32)
        self.assertEqual(event["exception"]["class"], "builtins.RuntimeError")
        self.assertNotIn(private_error, json.dumps(event))

    def test_diagnostic_log_rotation_is_bounded(self):
        with tempfile.TemporaryDirectory(prefix="felt-night-log-rotation-") as directory:
            logger = server.DiagnosticLogger(directory, max_bytes=1024, backups=2)
            for index in range(30):
                logger.emit({"event": "rotation_test", "index": index, "padding": "x" * 100})

            files = sorted(Path(directory).glob("diagnostics.jsonl*"))
            self.assertEqual(
                {file.name for file in files},
                {"diagnostics.jsonl", "diagnostics.jsonl.1", "diagnostics.jsonl.2"},
            )
            self.assertTrue(all(file.stat().st_size <= 1024 for file in files))

    def test_sqlite_exception_codes_are_safe_to_log(self):
        sqlite_codes_available = False
        try:
            with contextlib.closing(server.sqlite3.connect(":memory:")) as connection:
                connection.execute("SELECT * FROM missing_diagnostic_table")
        except server.sqlite3.OperationalError as exc:
            details = server._diagnostic_exception(exc)
            sqlite_codes_available = hasattr(exc, "sqlite_errorcode")
        else:
            self.fail("query unexpectedly succeeded")

        if sqlite_codes_available:
            self.assertIs(type(details["sqlite_errorcode"]), int)
            self.assertRegex(details["sqlite_errorname"], r"^SQLITE_[A-Z0-9_]+$")


if __name__ == "__main__":
    unittest.main()
