"""Exercise separate listeners with disposable data, including stolen-session replay."""
import http.client
import json
import tempfile
import os
import socket
import subprocess
import sys
import time
import threading
import types
import unittest

import server


class PrivateAdminTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="felt-ingress-test-")
        self.addCleanup(self.temp.cleanup)
        self.app = server.App(types.SimpleNamespace(
            public_origin="http://localhost:1", data_dir=self.temp.name),
            room_password="test-room-invite", admin_username="admin")
        self.public = self.listen(self.app)
        self.private_app = self.app.private_admin_app("http://localhost:2")
        self.private = self.listen(self.private_app)

    def listen(self, app):
        httpd = server.LimitedThreadingHTTPServer(("127.0.0.1", 0), server.Handler, app)
        app.public_netloc = "localhost:%d" % httpd.server_port
        app.public_origin = "http://" + app.public_netloc
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        def stop():
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=2)
        self.addCleanup(stop)
        return httpd

    def request(self, listener, method, path, payload=None, auth=None, **extra):
        headers = {"Host": listener.app.public_netloc,
                   "Origin": listener.app.public_origin, **extra}
        if auth:
            cookie, proof, csrf = auth
            headers.update({"Cookie": cookie, "X-SitNgo-Session": proof,
                            "X-SitNgo-CSRF": csrf})
        raw = None if payload is None else json.dumps(payload)
        if raw is not None:
            headers["Content-Type"] = "application/json"
        conn = http.client.HTTPConnection("127.0.0.1", listener.server_port, timeout=3)
        try:
            conn.request(method, path, raw, headers)
            response = conn.getresponse()
            body = json.loads(response.read())
            return response.status, dict(response.getheaders()), body
        finally:
            conn.close()

    def sign_in(self, listener, username, register=False):
        payload = {"username": username, "password": "" if username == "admin"
                   else "test-account-password"}
        if register:
            payload["room_password"] = "test-room-invite"
        status, headers, body = self.request(listener, "POST",
            "/poker/api/register" if register else "/poker/api/login", payload)
        self.assertEqual(status, 201 if register else 200, body)
        return (headers["Set-Cookie"].split(";", 1)[0],
                body["session_proof"], body["csrf"])

    def test_public_players_create_and_join_while_admin_stays_private(self):
        host = self.sign_in(self.public, "Host", register=True)
        guest = self.sign_in(self.public, "Guest", register=True)
        admin = self.sign_in(self.private, "admin")
        self.assertTrue(admin[0].startswith("sitngo_session_admin="))
        self.assertTrue(host[0].startswith("sitngo_session="))
        status, _, body = self.request(self.public, "POST", "/poker/api/tables", {
            "name": "Public lobby", "max_seats": 4, "starting_stack": 1000,
            "small_blind": 10, "big_blind": 20, "level_minutes": 5}, host)
        self.assertEqual(status, 201, body)
        status, _, body = self.request(self.public, "POST",
            "/poker/api/tables/" + body["table"]["id"] + "/join", {}, guest)
        self.assertEqual(status, 200, body)
        # Both listeners share one live store, rather than independent room state.
        status, _, body = self.request(self.private, "GET",
                                      "/poker/api/admin/config", auth=admin)
        self.assertEqual(status, 200, body)
        status, _, body = self.request(self.public, "GET",
                                      "/poker/api/admin/config", auth=host)
        self.assertEqual(status, 403, body)
        self.sign_in(self.public, "Host")  # Existing accounts still reconnect.

    def test_public_rejects_admin_login_and_replayed_admin_sessions(self):
        admin = self.sign_in(self.private, "admin")
        status, _, _ = self.request(self.public, "POST", "/poker/api/login",
                                   {"username": "admin", "password": ""})
        self.assertEqual(status, 401)
        for cookie in (admin[0], admin[0].replace("_admin=", "=")):
            auth = (cookie, admin[1], admin[2])
            for method, path, payload in (
                ("GET", "/poker/api/admin/config", None),
                ("GET", "/poker/api/admin/history", None),
                ("POST", "/poker/api/admin/config", {"showdown_seconds": 0}),
                ("POST", "/poker/api/tables/" + "a" * 32 + "/bots", {"seat_no": 1}),
                ("POST", "/poker/api/admin/history/delete",
                 {"ids": ["a" * 32], "confirm_delete": True}),
            ):
                with self.subTest(cookie=cookie.split("=")[0], path=path):
                    status, _, body = self.request(self.public, method, path, payload, auth)
                    self.assertEqual(status, 401, body)
            status, _, body = self.request(self.public, "GET", "/poker/api/me", auth=auth)
            self.assertEqual(status, 200)
            self.assertFalse(body["authenticated"])
        # Client-supplied routing/identity headers cannot select the private listener.
        status, _, _ = self.request(self.public, "POST", "/poker/api/login",
            {"username": "admin", "password": ""},
            **{"Host": self.private_app.public_netloc,
               "Origin": self.private_app.public_origin,
               "X-Forwarded-Host": self.private_app.public_netloc,
               "Tailscale-User-Login": "admin"})
        self.assertEqual(status, 421)

    def test_invalid_private_origin_leaves_existing_listener_policy_unchanged(self):
        with self.assertRaises(RuntimeError):
            self.app.private_admin_app(self.app.public_origin)
        self.assertFalse(self.app.allow_admin)

    def test_cli_starts_both_listeners_with_public_admin_blocked(self):
        # Exercise the deployed command, not just manually constructed HTTP servers.
        with socket.socket() as one, socket.socket() as two:
            one.bind(("127.0.0.1", 0))
            two.bind(("127.0.0.1", 0))
            public_port, private_port = one.getsockname()[1], two.getsockname()[1]
        with tempfile.TemporaryDirectory(prefix="felt-cli-test-") as data:
            env = dict(os.environ)
            env.pop(server.ROOM_PASSWORD_FILE_ENV, None)
            env[server.ROOM_PASSWORD_ENV] = "test-room-invite"
            env[server.ADMIN_USERNAME_ENV] = "admin"
            process = subprocess.Popen([
                sys.executable, "-B", server.__file__,
                "--port", str(public_port), "--public-origin", "http://localhost:%d" % public_port,
                "--admin-port", str(private_port),
                "--admin-origin", "http://localhost:%d" % private_port, "--data-dir", data,
            ], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                for port, expected in ((public_port, 401), (private_port, 200)):
                    listener = types.SimpleNamespace(server_port=port, app=types.SimpleNamespace(
                        public_netloc="localhost:%d" % port,
                        public_origin="http://localhost:%d" % port))
                    deadline = time.monotonic() + 8
                    while True:
                        try:
                            status, _, body = self.request(listener, "POST", "/poker/api/login",
                                {"username": "admin", "password": ""})
                            break
                        except OSError:
                            if process.poll() is not None or time.monotonic() >= deadline:
                                self.fail("CLI listeners did not start")
                            time.sleep(0.05)
                    self.assertEqual(status, expected, body)
            finally:
                process.terminate()
                process.communicate(timeout=5)
