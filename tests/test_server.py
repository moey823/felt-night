import http.client
import json
import tempfile
import threading
import types
import unittest
from pathlib import Path

import server


class ServerAuthTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sitngo-test-")
        root = Path(self.temp.name)
        self.password = server.OPERATOR_PASSWORD
        self.data_dir = root / "data"
        args = types.SimpleNamespace(
            public_origin="http://localhost:1",
            data_dir=str(self.data_dir),
        )
        self.app = server.App(args)
        self.httpd = server.LimitedThreadingHTTPServer(("127.0.0.1", 0), server.Handler, self.app)
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

    def request(self, method, path, payload=None, cookie=None, proof=None, csrf=None,
                origin=None, host=None):
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        headers = {
            "Host": host or self.app.public_netloc,
            "Origin": self.origin if origin is None else origin,
        }
        if body is not None:
            headers["Content-Type"] = "application/json"
            headers["Content-Length"] = str(len(body))
        if cookie:
            headers["Cookie"] = cookie
        if proof:
            headers["X-SitNgo-Session"] = proof
        if csrf:
            headers["X-SitNgo-CSRF"] = csrf
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        conn.request(method, path, body=body, headers=headers)
        response = conn.getresponse()
        raw = response.read()
        headers_out = dict(response.getheaders())
        conn.close()
        try:
            body_out = json.loads(raw.decode("utf-8")) if raw else None
        except ValueError:
            body_out = raw
        return response.status, headers_out, body_out

    def login(self, name="Ada"):
        status, headers, body = self.request(
            "POST", "/poker/api/login",
            {"name": name, "password": self.password},
        )
        self.assertEqual(status, 200, body)
        self.assertIn("sitngo_session=", headers.get("Set-Cookie", ""))
        cookie = headers["Set-Cookie"].split(";", 1)[0]
        return cookie, body["session_proof"], body["csrf"], body["player"]

    def test_cookie_alone_cannot_recover_session_or_read_tables(self):
        cookie, proof, _, _ = self.login()
        status, _, body = self.request("GET", "/poker/api/me", cookie=cookie)
        self.assertEqual(status, 200)
        self.assertFalse(body["authenticated"])
        self.assertIsNone(body["csrf"])
        self.assertNotIn("session_proof", body)

        status, _, body = self.request("GET", "/poker/api/tables", cookie=cookie)
        self.assertEqual(status, 401)
        self.assertEqual(body["error"]["code"], "authentication_required")

        # The opaque cookie is not the independent proof header.
        raw_cookie_token = cookie.split("=", 1)[1]
        status, _, body = self.request(
            "GET", "/poker/api/me", cookie=cookie, proof=raw_cookie_token,
        )
        self.assertEqual(status, 200)
        self.assertFalse(body["authenticated"])

        # A different service-origin cannot retrieve the proof through /me.
        status, _, body = self.request(
            "GET", "/poker/api/me", cookie=cookie,
            origin="https://unrelated.example",
        )
        self.assertEqual(status, 200)
        self.assertFalse(body["authenticated"])

    def test_proof_survives_browser_refresh_and_me_returns_only_csrf(self):
        cookie, proof, csrf, player = self.login("Grace")
        first_status, _, first = self.request(
            "GET", "/poker/api/me", cookie=cookie, proof=proof,
        )
        self.assertEqual(first_status, 200)
        self.assertTrue(first["authenticated"])
        self.assertEqual(first["player"]["id"], player["id"])
        self.assertEqual(first["csrf"], csrf)
        self.assertNotIn("session_proof", first)

        # A page refresh loses JS memory but origin-scoped localStorage restores
        # the proof; the new page can reauthenticate without seeing the password.
        refresh_status, _, refreshed = self.request(
            "GET", "/poker/api/me", cookie=cookie, proof=proof,
        )
        self.assertEqual(refresh_status, 200)
        self.assertTrue(refreshed["authenticated"])
        self.assertEqual(refreshed["csrf"], csrf)

    def test_mutations_need_exact_origin_proof_and_csrf_and_keep_custom_table_name(self):
        cookie, proof, csrf, _ = self.login("Host")
        payload = {
            "name": "Friday Friends",
            "max_seats": 9,
            "starting_stack": 1000,
            "small_blind": 10,
            "big_blind": 20,
            "level_minutes": 5,
        }
        status, _, body = self.request(
            "POST", "/poker/api/tables", payload, cookie=cookie, proof=proof,
        )
        self.assertEqual(status, 403)
        self.assertEqual(body["error"]["code"], "csrf_failed")

        status, _, body = self.request(
            "POST", "/poker/api/tables", payload, cookie=cookie, proof=proof, csrf=csrf,
            origin="https://unrelated.example",
        )
        self.assertEqual(status, 403)
        self.assertEqual(body["error"]["code"], "origin_rejected")

        status, _, body = self.request(
            "POST", "/poker/api/tables", payload, cookie=cookie, proof=proof, csrf=csrf,
        )
        self.assertEqual(status, 201, body)
        table = body["table"]
        self.assertEqual(table["name"], "Friday Friends")

        status, _, summaries = self.request(
            "GET", "/poker/api/tables", cookie=cookie, proof=proof,
        )
        self.assertEqual(status, 200)
        self.assertEqual(len(summaries["tables"]), 1)
        self.assertTrue(summaries["tables"][0]["viewer_seated"])
        self.assertEqual(summaries["tables"][0]["name"], "Friday Friends")

        status, _, detail = self.request(
            "GET", "/poker/api/tables/" + table["id"], cookie=cookie, proof=proof,
        )
        self.assertEqual(status, 200)
        self.assertEqual(detail["table"]["name"], "Friday Friends")


    def test_hardcoded_gate_is_example-room-invite(self):
        self.assertEqual(server.OPERATOR_PASSWORD, "example-room-invite")
        cookie, proof, _, _ = self.login("Gate")
        status, _, body = self.request(
            "GET", "/poker/api/me", cookie=cookie, proof=proof,
        )
        self.assertEqual(status, 200)
        self.assertTrue(body["authenticated"])

    def test_changing_gate_and_restarting_revokes_existing_sessions(self):
        cookie, proof, _, _ = self.login("Rotating")
        args = types.SimpleNamespace(
            public_origin=self.origin,
            data_dir=str(self.data_dir),
        )

        original_gate = server.OPERATOR_PASSWORD
        rotated_gate = "changed-test-gate"
        try:
            server.OPERATOR_PASSWORD = rotated_gate
            rotated_app = server.App(args)
        finally:
            server.OPERATOR_PASSWORD = original_gate

        self.app = rotated_app
        self.httpd.app = self.app
        status, _, body = self.request(
            "GET", "/poker/api/me", cookie=cookie, proof=proof,
        )
        self.assertEqual(status, 200)
        self.assertFalse(body["authenticated"])

        self.password = rotated_gate
        new_cookie, new_proof, _, _ = self.login("After rotation")
        status, _, body = self.request(
            "GET", "/poker/api/me", cookie=new_cookie, proof=new_proof,
        )
        self.assertEqual(status, 200)
        self.assertTrue(body["authenticated"])

    def test_login_throttle_applies_to_client_and_aggregate(self):
        for _ in range(server.LOGIN_LIMIT):
            status, _, _ = self.request(
                "POST", "/poker/api/login",
                {"name": "Wrong", "password": "incorrect"},
            )
            self.assertEqual(status, 401)
        status, headers, body = self.request(
            "POST", "/poker/api/login",
            {"name": "Wrong", "password": "incorrect"},
        )
        self.assertEqual(status, 429)
        self.assertGreater(int(headers["Retry-After"]), 0)
        self.assertEqual(body["error"]["code"], "login_throttled")


if __name__ == "__main__":
    unittest.main()

