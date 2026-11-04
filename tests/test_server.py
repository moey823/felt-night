import contextlib
import http.client
import io
import os
import json
import sqlite3
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import server


TEST_ROOM_PASSWORD = "test-room-invite"


class RoomPasswordConfigTests(unittest.TestCase):
    def test_env_password_is_an_explicit_alternative_and_validated(self):
        self.assertEqual(
            server._load_room_password({server.ROOM_PASSWORD_ENV: TEST_ROOM_PASSWORD}),
            TEST_ROOM_PASSWORD,
        )
        with self.assertRaisesRegex(RuntimeError, "single line") as caught:
            server._load_room_password({server.ROOM_PASSWORD_ENV: "private\ninvite"})
        self.assertNotIn("private", str(caught.exception))

    def test_private_file_password_accepts_one_trailing_newline(self):
        with tempfile.TemporaryDirectory(prefix="felt-night-password-") as directory:
            path = Path(directory) / "room-invite.txt"
            path.write_text(TEST_ROOM_PASSWORD + "\r\n", encoding="utf-8")
            path.chmod(0o600)
            self.assertEqual(
                server._load_room_password({server.ROOM_PASSWORD_FILE_ENV: str(path)}),
                TEST_ROOM_PASSWORD,
            )

    @unittest.skipUnless(hasattr(os, "mkfifo"), "named pipes are unavailable")
    def test_non_regular_password_file_is_rejected_without_blocking(self):
        with tempfile.TemporaryDirectory(prefix="felt-night-password-") as directory:
            path = Path(directory) / "room-invite.pipe"
            os.mkfifo(path, 0o600)
            with self.assertRaisesRegex(RuntimeError, "regular file"):
                server._load_room_password({server.ROOM_PASSWORD_FILE_ENV: str(path)})

    def test_file_with_group_or_other_permissions_is_rejected_without_value(self):
        secret = "private-test-invite"
        with tempfile.TemporaryDirectory(prefix="felt-night-password-") as directory:
            path = Path(directory) / "room-invite.txt"
            path.write_text(secret, encoding="utf-8")
            path.chmod(0o644)
            with self.assertRaisesRegex(RuntimeError, "accessible by group or others") as caught:
                server._load_room_password({server.ROOM_PASSWORD_FILE_ENV: str(path)})
            self.assertNotIn(secret, str(caught.exception))

    def test_missing_config_fails_startup_without_secret_output(self):
        with tempfile.TemporaryDirectory(prefix="felt-night-startup-") as directory:
            stderr = io.StringIO()
            with patch.dict(os.environ, {}, clear=True), patch("server.os.umask"), contextlib.redirect_stderr(stderr):
                result = server.main([
                    "--public-origin", "http://localhost:18943",
                    "--data-dir", str(Path(directory) / "data"),
                ])
            self.assertEqual(result, 1)
            self.assertIn(server.ROOM_PASSWORD_FILE_ENV, stderr.getvalue())
            self.assertNotIn(TEST_ROOM_PASSWORD, stderr.getvalue())

    def test_app_uses_the_configured_invite_for_registration_gate(self):
        with tempfile.TemporaryDirectory(prefix="felt-night-app-config-") as directory:
            args = types.SimpleNamespace(
                public_origin="http://localhost:1",
                data_dir=str(Path(directory) / "data"),
            )
            with patch.dict(os.environ, {server.ROOM_PASSWORD_ENV: TEST_ROOM_PASSWORD}, clear=True):
                app = server.App(args)
            self.assertTrue(app.store.verify_room_password(TEST_ROOM_PASSWORD))
            self.assertFalse(app.store.verify_room_password("different-room-invite"))


class ServerAuthTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sitngo-test-")
        root = Path(self.temp.name)
        self.password = TEST_ROOM_PASSWORD
        self.account_password = "test-account-password"
        self.data_dir = root / "data"
        args = types.SimpleNamespace(
            public_origin="http://localhost:1",
            data_dir=str(self.data_dir),
        )
        self.app = server.App(args, room_password=TEST_ROOM_PASSWORD)
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
        username = name.replace(" ", "-")
        status, headers, body = self.request(
            "POST", "/poker/api/register",
            {
                "username": username,
                "password": self.account_password,
                "room_password": self.password,
            },
        )
        self.assertEqual(status, 201, body)
        self.assertIn("sitngo_session=", headers.get("Set-Cookie", ""))
        cookie = headers["Set-Cookie"].split(";", 1)[0]
        return cookie, body["session_proof"], body["csrf"], body["player"]

    def seed_legacy_session(self, name="Legacy"):
        player_id = server.uuid.uuid4().hex
        token = server.secrets.token_urlsafe(32)
        now = time.time()
        conn = self.app.store.connect()
        try:
            conn.execute(
                "INSERT INTO players(id,name,created) VALUES(?,?,?)",
                (player_id, name, now),
            )
            conn.execute(
                "INSERT INTO sessions(token_hash,player_id,created,expires) VALUES(?,?,?,?)",
                (self.app.store.hash_token(token), player_id, now, now + server.SESSION_TTL),
            )
        finally:
            conn.close()
        cookie = "%s=%s" % (server.COOKIE_NAME, token)
        return (
            cookie,
            self.app.store.session_proof(token),
            self.app.store.csrf_token(token),
            {"id": player_id, "name": name},
        )

    def create_table(self, cookie, proof, csrf, name="Lobby", max_seats=4):
        payload = {
            "name": name,
            "max_seats": max_seats,
            "starting_stack": 1000,
            "small_blind": 10,
            "big_blind": 20,
            "level_minutes": 5,
        }
        status, headers, body = self.request(
            "POST", "/poker/api/tables", payload,
            cookie=cookie, proof=proof, csrf=csrf,
        )
        return status, headers, body

    def test_room_assets_and_security_page_are_served_with_safe_content_types(self):
        for path, expected_type in (
            ("/poker/room.css", "text/css"),
            ("/poker/ace.svg", "image/svg+xml"),
            ("/poker/security.html", "text/html"),
        ):
            with self.subTest(path=path):
                status, headers, body = self.request("GET", path)
                self.assertEqual(status, 200)
                self.assertIn(expected_type, headers["Content-Type"])
                self.assertTrue(body)
                self.assertEqual(headers["Cache-Control"], "no-store")
        status, headers, _ = self.request("GET", "/poker/security.html")
        self.assertEqual(status, 200)
        self.assertIn("Content-Security-Policy", headers)

    def test_registration_is_gated_and_account_login_keeps_stable_identity(self):
        wrong_status, _, wrong = self.request(
            "POST", "/poker/api/register",
            {
                "username": "Robin",
                "password": self.account_password,
                "room_password": "not-the-room-password",
            },
        )
        self.assertEqual(wrong_status, 401)
        self.assertEqual(wrong["error"]["code"], "invalid_credentials")

        status, headers, created = self.request(
            "POST", "/poker/api/register",
            {
                "username": "Robin",
                "password": self.account_password,
                "room_password": self.password,
            },
        )
        self.assertEqual(status, 201, created)
        self.assertEqual(created["player"]["name"], "Robin")
        self.assertFalse(created["player"]["needs_claim"])
        cookie = headers["Set-Cookie"].split(";", 1)[0]

        status, login_headers, signed_in = self.request(
            "POST", "/poker/api/login",
            {"username": "robin", "password": self.account_password},
        )
        self.assertEqual(status, 200, signed_in)
        self.assertEqual(signed_in["player"]["id"], created["player"]["id"])
        self.assertEqual(signed_in["player"]["name"], "Robin")
        self.assertNotEqual(
            cookie.split("=", 1)[1],
            login_headers["Set-Cookie"].split(";", 1)[0].split("=", 1)[1],
        )

        status, _, duplicate = self.request(
            "POST", "/poker/api/register",
            {
                "username": "rOBin",
                "password": "another-personal-password",
                "room_password": self.password,
            },
        )
        self.assertEqual(status, 409)
        self.assertEqual(duplicate["error"]["code"], "username_taken")

        # The former shared room password can no longer create a guest seat.
        status, headers, guest = self.request(
            "POST", "/poker/api/login",
            {"name": "Robin", "password": self.password},
        )
        self.assertEqual(status, 401)
        self.assertNotIn("Set-Cookie", headers)
        self.assertEqual(guest["error"]["code"], "invalid_credentials")

    def test_legacy_session_can_claim_only_its_exact_player_identity(self):
        cookie, proof, _, legacy_player = self.seed_legacy_session("Robin")
        status, _, me = self.request(
            "GET", "/poker/api/me", cookie=cookie, proof=proof,
        )
        self.assertEqual(status, 200)
        self.assertTrue(me["authenticated"])
        self.assertTrue(me["needs_claim"])
        self.assertTrue(me["player"]["needs_claim"])

        status, _, denied = self.request(
            "GET", "/poker/api/tables", cookie=cookie, proof=proof,
        )
        self.assertEqual(status, 403)
        self.assertEqual(denied["error"]["code"], "account_required")

        # Registering a matching display name creates a separate identity.
        new_cookie, new_proof, new_csrf, unrelated = self.login("Robin")
        self.assertNotEqual(unrelated["id"], legacy_player["id"])

        status, _, conflict = self.request(
            "POST", "/poker/api/claim",
            {
                "username": "Robin",
                "password": self.account_password,
                "room_password": self.password,
            },
            cookie=cookie, proof=proof, csrf=me["csrf"],
        )
        self.assertEqual(status, 409)
        self.assertEqual(conflict["error"]["code"], "username_taken")
        status, _, still_legacy = self.request(
            "GET", "/poker/api/me", cookie=cookie, proof=proof,
        )
        self.assertTrue(still_legacy["needs_claim"])

        claimed_name = "Robin-legacy"
        status, _, claimed = self.request(
            "POST", "/poker/api/claim",
            {
                "username": claimed_name,
                "password": "legacy-seat-password",
                "room_password": self.password,
            },
            cookie=cookie, proof=proof, csrf=me["csrf"],
        )
        self.assertEqual(status, 200, claimed)
        self.assertEqual(claimed["player"]["id"], legacy_player["id"])
        self.assertEqual(claimed["player"]["name"], claimed_name)
        self.assertFalse(claimed["player"]["needs_claim"])
        self.assertEqual(claimed["session_proof"], proof)

        status, _, by_claimed_account = self.request(
            "POST", "/poker/api/login",
            {"username": claimed_name, "password": "legacy-seat-password"},
        )
        self.assertEqual(status, 200, by_claimed_account)
        self.assertEqual(by_claimed_account["player"]["id"], legacy_player["id"])
        self.assertNotEqual(
            new_cookie.split("=", 1)[1], cookie.split("=", 1)[1],
        )
        self.assertTrue(new_proof)
        self.assertTrue(new_csrf)

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


    def test_configured_room_invite_authenticates_new_accounts(self):
        self.assertTrue(self.app.store.verify_room_password(self.password))
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

        rotated_gate = "changed-test-room-invite"
        rotated_app = server.App(args, room_password=rotated_gate)

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


    def test_players_choose_seats_and_host_keeps_control_when_standing(self):
        host_cookie, host_proof, host_csrf, host = self.login("Lobby host")
        guest_cookie, guest_proof, guest_csrf, guest = self.login("Guest")
        status, _, created = self.create_table(
            host_cookie, host_proof, host_csrf, name="Open lobby", max_seats=4,
        )
        self.assertEqual(status, 201, created)
        table_id = created["table"]["id"]
        path = "/poker/api/tables/" + table_id

        status, _, seated = self.request(
            "POST", path + "/seat", {"seat_no": 3},
            cookie=guest_cookie, proof=guest_proof, csrf=guest_csrf,
        )
        self.assertEqual(status, 200, seated)
        status, _, seated = self.request(
            "POST", path + "/seat", {"seat_no": 1},
            cookie=host_cookie, proof=host_proof, csrf=host_csrf,
        )
        self.assertEqual(status, 200, seated)
        self.assertEqual(
            {seat["id"]: seat["seat_no"] for seat in seated["table"]["seats"]},
            {host["id"]: 1, guest["id"]: 3},
        )

        status, _, updated = self.request(
            "POST", path + "/settings",
            {"name": "Edited lobby", "max_seats": 5, "starting_stack": 2000},
            cookie=host_cookie, proof=host_proof, csrf=host_csrf,
        )
        self.assertEqual(status, 200, updated)
        table = updated["table"]
        self.assertEqual(table["name"], "Edited lobby")
        self.assertEqual(table["config"]["max_seats"], 5)
        self.assertEqual(
            {seat["id"]: seat["stack"] for seat in table["seats"]},
            {host["id"]: 2000, guest["id"]: 2000},
        )

        status, _, standing = self.request(
            "POST", path + "/stand", {},
            cookie=host_cookie, proof=host_proof, csrf=host_csrf,
        )
        self.assertEqual(status, 200, standing)
        self.assertEqual(standing["table"]["host_id"], host["id"])
        self.assertFalse(standing["table"]["viewer"]["seated"])
        self.assertEqual(
            [seat["id"] for seat in standing["table"]["seats"]],
            [guest["id"]],
        )

        # A host who is standing still owns lobby controls.
        status, _, renamed = self.request(
            "POST", path + "/settings", {"name": "Host still owns this"},
            cookie=host_cookie, proof=host_proof, csrf=host_csrf,
        )
        self.assertEqual(status, 200, renamed)
        self.assertEqual(renamed["table"]["host_id"], host["id"])
        self.assertEqual(renamed["table"]["name"], "Host still owns this")

    def test_lobby_mutations_require_authentication_csrf_and_host_ownership(self):
        host_cookie, host_proof, host_csrf, _ = self.login("Host")
        guest_cookie, guest_proof, guest_csrf, _ = self.login("Not host")
        status, _, created = self.create_table(
            host_cookie, host_proof, host_csrf, name="Protected lobby",
        )
        self.assertEqual(status, 201, created)
        path = "/poker/api/tables/" + created["table"]["id"]

        status, _, body = self.request(
            "POST", path + "/seat", {"seat_no": 2},
            cookie=guest_cookie, proof=guest_proof,
        )
        self.assertEqual(status, 403)
        self.assertEqual(body["error"]["code"], "csrf_failed")

        status, _, body = self.request(
            "POST", path + "/seat", {"seat_no": 2},
            cookie=guest_cookie,
        )
        self.assertEqual(status, 401)
        self.assertEqual(body["error"]["code"], "authentication_required")

        for method, suffix, payload in (
            ("POST", "/settings", {"name": "Unauthorized edit"}),
            ("POST", "/bots", {"seat_no": 2}),
            ("DELETE", "/bots/0", None),
        ):
            with self.subTest(method=method, suffix=suffix):
                status, _, body = self.request(
                    method, path + suffix, payload,
                    cookie=guest_cookie, proof=guest_proof, csrf=guest_csrf,
                )
                self.assertEqual(status, 403, body)
                self.assertEqual(body["error"]["code"], "host_only")

    def test_additive_migration_preserves_legacy_data_and_backfills_private_history(self):
        legacy_dir = self.data_dir.parent / "legacy-data"
        legacy_dir.mkdir(mode=0o700)
        database = legacy_dir / "sitngo.sqlite3"
        now = time.time()
        owner_id = server.uuid.uuid4().hex
        guest_id = server.uuid.uuid4().hex
        table_id = server.uuid.uuid4().hex
        raw_token = server.secrets.token_urlsafe(32)
        password_salt = server.secrets.token_bytes(16)
        old_updated = now

        state = server.engine.create_lobby(
            table_id, owner_id, "Morgan", {
                "max_seats": 2, "starting_stack": 1000,
                "small_blind": 10, "big_blind": 20, "level_minutes": 5,
            }, now,
        )
        state = server.engine.join(state, guest_id, "Avery", now, seat_no=1)
        with patch.object(
            server.engine.random.SystemRandom,
            "choice",
            side_effect=lambda seats: next(
                seat for seat in seats if seat["player_id"] == owner_id
            ),
        ):
            state = server.engine.start(state, owner_id, now)
        state["name"] = "Legacy tournament"
        state["status"] = "completed"
        state["hand"]["street"] = "showdown"
        state["hand"]["next_hand_at"] = None
        state["elimination_order"] = [{
            "player_id": guest_id, "name": "Avery", "place": 2,
            "hand_no": 1, "seat_no": 1,
        }]
        state["results"] = [
            {"player_id": owner_id, "name": "Morgan", "place": 1, "chips": 1000},
            {"player_id": guest_id, "name": "Avery", "place": 2, "chips": 0},
        ]
        serialized_state = server._json_dumps(state)

        conn = sqlite3.connect(database)
        try:
            conn.executescript("""
                CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
                CREATE TABLE players (id TEXT PRIMARY KEY,name TEXT NOT NULL,created REAL NOT NULL);
                CREATE TABLE sessions (
                    token_hash TEXT PRIMARY KEY,
                    player_id TEXT NOT NULL REFERENCES players(id),
                    created REAL NOT NULL,
                    expires REAL NOT NULL
                );
                CREATE TABLE tables (
                    id TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL REFERENCES players(id),
                    state TEXT NOT NULL,
                    created REAL NOT NULL,
                    updated REAL NOT NULL
                );
            """)
            conn.executemany(
                "INSERT INTO meta(key,value) VALUES(?,?)",
                (
                    ("csrf_secret", server.secrets.token_hex(32)),
                    ("password_salt", password_salt.hex()),
                    ("password_verifier", server.Store._password_verifier(
                        self.password, password_salt,
                    )),
                ),
            )
            conn.executemany(
                "INSERT INTO players(id,name,created) VALUES(?,?,?)",
                ((owner_id, "Morgan", now), (guest_id, "Avery", now)),
            )
            conn.execute(
                "INSERT INTO sessions(token_hash,player_id,created,expires) VALUES(?,?,?,?)",
                (server.Store.hash_token(raw_token), owner_id, now, now + server.SESSION_TTL),
            )
            conn.execute(
                "INSERT INTO tables(id,owner_id,state,created,updated) VALUES(?,?,?,?,?)",
                (table_id, owner_id, serialized_state, now - 1, old_updated),
            )
            conn.commit()
        finally:
            conn.close()

        args = types.SimpleNamespace(
            public_origin=self.origin,
            data_dir=str(legacy_dir),
        )
        self.app = server.App(args, room_password=TEST_ROOM_PASSWORD)
        self.httpd.app = self.app
        conn = self.app.store.connect()
        try:
            self.assertEqual(
                conn.execute("SELECT state FROM tables WHERE id=?", (table_id,)).fetchone()["state"],
                serialized_state,
            )
            self.assertEqual(
                conn.execute("SELECT COUNT(*) AS n FROM sessions").fetchone()["n"], 1,
            )
            self.assertEqual(
                conn.execute(
                    "SELECT value FROM meta WHERE key='history_backfill_v1'",
                ).fetchone()["value"],
                "1",
            )
        finally:
            conn.close()

        cookie = "%s=%s" % (server.COOKIE_NAME, raw_token)
        proof = self.app.store.session_proof(raw_token)
        status, _, me = self.request(
            "GET", "/poker/api/me", cookie=cookie, proof=proof,
        )
        self.assertEqual(status, 200)
        self.assertTrue(me["needs_claim"])
        status, _, denied = self.request(
            "GET", "/poker/api/history", cookie=cookie, proof=proof,
        )
        self.assertEqual(status, 403)
        self.assertEqual(denied["error"]["code"], "account_required")

        status, _, claimed = self.request(
            "POST", "/poker/api/claim",
            {
                "username": "Morgan",
                "password": "claimed-seat-password",
                "room_password": self.password,
            },
            cookie=cookie, proof=proof, csrf=me["csrf"],
        )
        self.assertEqual(status, 200, claimed)
        self.assertEqual(claimed["player"]["id"], owner_id)

        status, _, history_page = self.request(
            "GET", "/poker/api/history", cookie=cookie, proof=proof,
        )
        self.assertEqual(status, 200, history_page)
        summary = next(item for item in history_page["tournaments"] if item["id"] == table_id)
        self.assertEqual(summary["results"], state["results"])
        self.assertEqual(summary["hand_count"], 1)
        status, _, detail = self.request(
            "GET", "/poker/api/history/" + table_id,
            cookie=cookie, proof=proof,
        )
        self.assertEqual(status, 200, detail)
        self.assertEqual(detail["hands"][0]["ended"], old_updated)
        migrated_players = {
            player["player_id"]: player for player in detail["hands"][0]["players"]
        }
        self.assertIsNone(migrated_players[guest_id]["cards"])
        self.assertEqual(len(migrated_players[owner_id]["cards"]), 2)

    def test_history_is_participant_private_durable_and_retains_prior_results(self):
        host_cookie, host_proof, host_csrf, host = self.login("Robin")
        guest_cookie, guest_proof, guest_csrf, guest = self.login("Morgan")
        spectator_cookie, spectator_proof, _, _ = self.login("Taylor")
        owner_cookie, owner_proof, owner_csrf, _ = self.login("Quinn")

        # Creating an empty lobby does not give its host history access.
        status, _, empty = self.create_table(
            owner_cookie, owner_proof, owner_csrf, name="Never played",
        )
        self.assertEqual(status, 201, empty)
        status, _, owner_history = self.request(
            "GET", "/poker/api/history", cookie=owner_cookie, proof=owner_proof,
        )
        self.assertEqual(status, 200)
        self.assertEqual(owner_history["tournaments"], [])

        status, _, created = self.create_table(
            host_cookie, host_proof, host_csrf, name="Private hand", max_seats=2,
        )
        self.assertEqual(status, 201, created)
        table_id = created["table"]["id"]
        table_path = "/poker/api/tables/" + table_id

        status, _, seated = self.request(
            "POST", table_path + "/seat", {"seat_no": 1},
            cookie=guest_cookie, proof=guest_proof, csrf=guest_csrf,
        )
        self.assertEqual(status, 200, seated)
        with patch.object(
            server.engine.random.SystemRandom,
            "choice",
            side_effect=lambda seats: next(
                seat for seat in seats if seat["player_id"] == host["id"]
            ),
        ):
            status, _, started = self.request(
                "POST", table_path + "/start", {},
                cookie=host_cookie, proof=host_proof, csrf=host_csrf,
            )
        self.assertEqual(status, 200, started)

        status, _, spectator_history = self.request(
            "GET", "/poker/api/history", cookie=spectator_cookie,
            proof=spectator_proof,
        )
        self.assertEqual(status, 200)
        self.assertEqual(spectator_history["tournaments"], [])
        status, _, hidden = self.request(
            "GET", "/poker/api/history/" + table_id,
            cookie=spectator_cookie, proof=spectator_proof,
        )
        self.assertEqual(status, 404)

        status, _, host_page = self.request(
            "GET", "/poker/api/history?offset=0",
            cookie=host_cookie, proof=host_proof,
        )
        self.assertEqual(status, 200, host_page)
        self.assertEqual(host_page["next_offset"], None)
        summary = next(t for t in host_page["tournaments"] if t["id"] == table_id)
        self.assertEqual(summary["hand_count"], 1)
        self.assertEqual(
            {item["player_id"] for item in summary["participants"]},
            {host["id"], guest["id"]},
        )

        status, _, host_detail = self.request(
            "GET", "/poker/api/history/" + table_id + "?offset=0",
            cookie=host_cookie, proof=host_proof,
        )
        self.assertEqual(status, 200, host_detail)
        first_hand = host_detail["hands"][0]
        self.assertTrue(first_hand["events_complete"])
        event_sequences = [event["seq"] for event in first_hand["events"]]
        self.assertEqual(event_sequences, sorted(event_sequences))
        host_players = {item["player_id"]: item for item in first_hand["players"]}
        self.assertEqual(len(host_players[host["id"]]["cards"]), 2)
        self.assertIsNone(host_players[guest["id"]]["cards"])

        status, _, guest_detail = self.request(
            "GET", "/poker/api/history/" + table_id,
            cookie=guest_cookie, proof=guest_proof,
        )
        self.assertEqual(status, 200, guest_detail)
        guest_players = {
            item["player_id"]: item for item in guest_detail["hands"][0]["players"]
        }
        self.assertEqual(len(guest_players[guest["id"]]["cards"]), 2)
        self.assertIsNone(guest_players[host["id"]]["cards"])

        # Simulate a later hand after Morgan is eliminated. Only a legitimate
        # reveal event may make Robin's cards available to Morgan's history.
        host_cards = list(host_players[host["id"]]["cards"])

        def finish_later_hand(state):
            previous = state["hand"]
            host_cards = list(previous["holes"][host["id"]])
            later_id = "%s:2" % table_id
            state["hand_no"] = 2
            state["status"] = "completed"
            state["elimination_order"] = [{
                "player_id": guest["id"], "name": guest["name"],
                "place": 2, "hand_no": 1, "seat_no": 1,
            }]
            state["results"] = [
                {"player_id": host["id"], "name": host["name"],
                 "place": 1, "chips": 2000, "award_cents": 600},
                {"player_id": guest["id"], "name": guest["name"],
                 "place": 2, "chips": 0, "award_cents": 400},
            ]
            state["hand"] = dict(previous)
            state["hand"].update({
                "number": 2, "hand_id": later_id, "event_seq": 1,
                "event_base_seq": 1, "street": "showdown", "board": [],
                "holes": {host["id"]: host_cards},
                "stack_before": {host["id"]: 2000},
                "revealed": [{
                    "player_id": host["id"], "actor_label": host["name"],
                    "seat_no": 0, "cards": host_cards,
                }],
                "showdown": [], "payouts": {host["id"]: 2000},
                "events": [{
                    "id": later_id + ":1", "hand_id": later_id, "seq": 1,
                    "type": "reveal", "street": "showdown",
                    "hands": [{
                        "player_id": host["id"], "actor_label": host["name"],
                        "seat_no": 0, "cards": host_cards,
                    }],
                }],
            })
            return state

        final_state = self.app.store.mutate_table(
            table_id, finish_later_hand, time.time(),
        )
        self.assertEqual(final_state["status"], "completed")
        status, _, guest_final = self.request(
            "GET", "/poker/api/history/" + table_id + "?offset=0",
            cookie=guest_cookie, proof=guest_proof,
        )
        self.assertEqual(status, 200, guest_final)
        self.assertEqual(guest_final["tournament"]["results"], final_state["results"])
        self.assertEqual([item["number"] for item in guest_final["hands"]], [1, 2])
        later_players = {
            item["player_id"]: item for item in guest_final["hands"][1]["players"]
        }
        self.assertEqual(later_players[host["id"]]["cards"], host_cards)
        self.assertTrue(later_players[host["id"]]["revealed"])
        self.assertNotIn(guest["id"], later_players)

        # The history survives app reconstruction and does not depend on the
        # active table's latest state for the previously eliminated player.
        args = types.SimpleNamespace(
            public_origin=self.origin,
            data_dir=str(self.data_dir),
        )
        self.app = server.App(args, room_password=TEST_ROOM_PASSWORD)
        self.httpd.app = self.app
        status, _, restored = self.request(
            "GET", "/poker/api/history/" + table_id,
            cookie=guest_cookie, proof=guest_proof,
        )
        self.assertEqual(status, 200, restored)
        self.assertEqual(restored["tournament"]["results"], final_state["results"])
        self.assertEqual(len(restored["hands"]), 2)

        status, _, invalid_query = self.request(
            "GET", "/poker/api/me?offset=0",
            cookie=host_cookie, proof=host_proof,
        )
        self.assertEqual(status, 400)
        self.assertEqual(invalid_query["error"]["code"], "invalid_url")

    def test_host_can_create_and_edit_arbitrary_tournament_timers(self):
        cookie, proof, csrf, _ = self.login("Host")
        auth = dict(cookie=cookie, proof=proof, csrf=csrf)
        cfg = dict(name="Custom pace", max_seats=2, starting_stack=1000,
                   small_blind=10, big_blind=20, level_minutes=97,
                   turn_seconds=19, runout_seconds=1.5, buy_in=25,
                   payout_percentages=[70, 30])
        status, _, created = self.request("POST", "/poker/api/tables", cfg, **auth)
        self.assertEqual(status, 201, created)
        table = created["table"]
        for field in (
            "level_minutes", "turn_seconds", "runout_seconds",
            "buy_in", "payout_percentages",
        ):
            self.assertEqual(table["config"][field], cfg[field])
        path = "/poker/api/tables/" + table["id"]
        for field, bad in (("level_minutes", 0), ("level_minutes", "3"),
                           ("turn_seconds", 0.5), ("turn_seconds", True),
                           ("runout_seconds", None), ("runout_seconds", 3601)):
            with self.subTest(field=field, bad=bad):
                status, _, _ = self.request("POST", "/poker/api/tables",
                                            dict(cfg, **{field: bad}), **auth)
                self.assertEqual(status, 400)
        status, _, _ = self.request("POST", path + "/bots", {"seat_no": 1}, **auth)
        self.assertEqual(status, 200)
        updated = dict(
            level_minutes=72.5, turn_seconds=7, runout_seconds=3.25,
            buy_in=0, payout_percentages=[80, 20],
        )
        status, _, result = self.request("POST", path + "/settings", updated, **auth)
        self.assertEqual(status, 200, result)
        for field, value in updated.items():
            self.assertEqual(result["table"]["config"][field], value)
        for field in updated:
            invalid = -1 if field == "buy_in" else 0
            status, _, _ = self.request(
                "POST", path + "/settings", {field: invalid}, **auth,
            )
            self.assertEqual(status, 400, field)
        status, _, result = self.request("POST", path + "/start", {}, **auth)
        self.assertEqual(status, 200, result)
        view = result["table"]
        self.assertGreater(view["turn_deadline"] - view["server_now"], 6)
        self.assertLessEqual(view["turn_deadline"] - view["server_now"], 7)
        self.assertEqual(view["config"]["runout_seconds"], 3.25)
        self.assertAlmostEqual(view["blinds"]["seconds_to_next"], 72.5 * 60, delta=1)
        status, _, _ = self.request("POST", path + "/settings", dict(turn_seconds=9), **auth)
        self.assertEqual(status, 409)

    def test_bot_seats_are_explicit_bounded_and_locked_after_start(self):
        host_cookie, host_proof, host_csrf, host = self.login("Host")
        status, _, created = self.create_table(
            host_cookie, host_proof, host_csrf, name="Bot lobby", max_seats=3,
        )
        self.assertEqual(status, 201, created)
        table_id = created["table"]["id"]
        path = "/poker/api/tables/" + table_id

        for seat_no in (1, 2):
            status, _, body = self.request(
                "POST", path + "/bots", {"seat_no": seat_no},
                cookie=host_cookie, proof=host_proof, csrf=host_csrf,
            )
            self.assertEqual(status, 200, body)
        self.assertEqual(
            [(seat["seat_no"], seat["is_bot"])
             for seat in body["table"]["seats"]],
            [(0, False), (1, True), (2, True)],
        )

        status, _, body = self.request(
            "POST", path + "/bots", {"seat_no": 3},
            cookie=host_cookie, proof=host_proof, csrf=host_csrf,
        )
        self.assertEqual(status, 400)
        status, _, body = self.request(
            "POST", path + "/settings", {"max_seats": 2},
            cookie=host_cookie, proof=host_proof, csrf=host_csrf,
        )
        self.assertEqual(status, 409)

        status, _, removed = self.request(
            "DELETE", path + "/bots/1",
            cookie=host_cookie, proof=host_proof, csrf=host_csrf,
        )
        self.assertEqual(status, 200, removed)
        self.assertEqual(
            [(seat["seat_no"], seat["is_bot"])
             for seat in removed["table"]["seats"]],
            [(0, False), (2, True)],
        )
        status, _, body = self.request(
            "DELETE", path + "/bots/0",
            cookie=host_cookie, proof=host_proof, csrf=host_csrf,
        )
        self.assertEqual(status, 409)

        status, _, started = self.request(
            "POST", path + "/start", {},
            cookie=host_cookie, proof=host_proof, csrf=host_csrf,
        )
        self.assertEqual(status, 200, started)
        self.assertEqual(started["table"]["status"], "playing")

        host_seat_no = next(
            seat["seat_no"] for seat in started["table"]["seats"] if seat["id"] == host["id"]
        )
        for method, suffix, payload in (
            ("POST", "/seat", {"seat_no": (host_seat_no + 1) % 3}),
            ("POST", "/stand", {}),
            ("POST", "/settings", {"name": "Too late"}),
            ("POST", "/bots", {"seat_no": 1}),
            ("DELETE", "/bots/2", None),
        ):
            with self.subTest(method=method, suffix=suffix):
                status, _, body = self.request(
                    method, path + suffix, payload,
                    cookie=host_cookie, proof=host_proof, csrf=host_csrf,
                )
                self.assertEqual(status, 409, body)
                self.assertEqual(body["error"]["code"], "table_started")

    def test_tables_are_isolated_and_lobbies_survive_app_restart(self):
        cookie, proof, csrf, host = self.login("Persistent host")
        status, _, first = self.create_table(
            cookie, proof, csrf, name="First room", max_seats=4,
        )
        self.assertEqual(status, 201, first)
        status, _, second = self.create_table(
            cookie, proof, csrf, name="Second room", max_seats=4,
        )
        self.assertEqual(status, 201, second)
        first_id = first["table"]["id"]
        second_id = second["table"]["id"]

        status, _, first = self.request(
            "POST", "/poker/api/tables/" + first_id + "/settings",
            {"name": "First room edited", "starting_stack": 2500},
            cookie=cookie, proof=proof, csrf=csrf,
        )
        self.assertEqual(status, 200, first)
        status, _, second_view = self.request(
            "GET", "/poker/api/tables/" + second_id, cookie=cookie, proof=proof,
        )
        self.assertEqual(status, 200, second_view)
        self.assertEqual(second_view["table"]["name"], "Second room")
        self.assertEqual(second_view["table"]["config"]["starting_stack"], 1000)

        args = types.SimpleNamespace(
            public_origin=self.origin,
            data_dir=str(self.data_dir),
        )
        self.app = server.App(args, room_password=TEST_ROOM_PASSWORD)
        self.httpd.app = self.app
        status, _, persisted = self.request(
            "GET", "/poker/api/tables/" + first_id, cookie=cookie, proof=proof,
        )
        self.assertEqual(status, 200, persisted)
        self.assertEqual(persisted["table"]["host_id"], host["id"])
        self.assertEqual(persisted["table"]["name"], "First room edited")
        self.assertEqual(persisted["table"]["config"]["starting_stack"], 2500)
        self.assertEqual(
            [seat["id"] for seat in persisted["table"]["seats"]],
            [host["id"]],
        )

    def test_server_ticker_acts_for_bots_without_client_polling(self):
        host_cookie, host_proof, host_csrf, host = self.login("Ticker host")
        status, _, created = self.create_table(
            host_cookie, host_proof, host_csrf, name="Ticker table", max_seats=2,
        )
        self.assertEqual(status, 201, created)
        table_id = created["table"]["id"]
        path = "/poker/api/tables/" + table_id
        status, _, with_bot = self.request(
            "POST", path + "/bots", {"seat_no": 1},
            cookie=host_cookie, proof=host_proof, csrf=host_csrf,
        )
        self.assertEqual(status, 200, with_bot)
        bot_id = next(seat["id"] for seat in with_bot["table"]["seats"] if seat["is_bot"])

        with patch.object(
            server.engine.random.SystemRandom,
            "choice",
            side_effect=lambda seats: next(seat for seat in seats if seat["player_id"] == host["id"]),
        ):
            status, _, started = self.request(
                "POST", path + "/start", {},
                cookie=host_cookie, proof=host_proof, csrf=host_csrf,
            )
        self.assertEqual(status, 200, started)
        self.assertEqual(started["table"]["actor_id"], host["id"])
        status, _, acted = self.request(
            "POST", path + "/action",
            {
                "expected_hand": started["table"]["hand_no"],
                "expected_turn_version": started["table"]["turn_version"],
                "action": "call",
            },
            cookie=host_cookie, proof=host_proof, csrf=host_csrf,
        )
        self.assertEqual(status, 200, acted)
        self.assertEqual(acted["table"]["actor_id"], bot_id)
        before_version = acted["table"]["version"]
        before_action_count = len(acted["table"]["action_log"])
        bot_name = next(
            seat["name"] for seat in acted["table"]["seats"] if seat["id"] == bot_id
        )

        # Once the human action has handed over the turn, leave the browser idle.
        # The same periodic worker used by main() must advance the persisted game.
        stop_event = threading.Event()
        ticker = threading.Thread(
            target=server._background_ticks,
            args=(self.app.store, stop_event),
            daemon=True,
        )
        ticker.start()
        bot_action = None
        persisted = None
        try:
            # Poll SQLite only; no HTTP request is made while the bot is thinking.
            # The bounded wait covers the bot's delay and the ticker's one-second cadence.
            for _ in range(40):
                stop_event.wait(0.1)
                conn = self.app.store.connect()
                try:
                    row = conn.execute(
                        "SELECT state FROM tables WHERE id=?", (table_id,)
                    ).fetchone()
                finally:
                    conn.close()
                if row is None:
                    continue
                persisted = json.loads(row["state"])
                new_entries = persisted["action_log"][before_action_count:]
                bot_action = next(
                    (
                        entry for entry in new_entries
                        if entry["text"].startswith(bot_name + " ")
                        and "joined the table" not in entry["text"]
                    ),
                    None,
                )
                if bot_action is not None:
                    break
        finally:
            stop_event.set()
            ticker.join(timeout=2)

        self.assertIsNotNone(
            bot_action,
            "the server ticker should log a bot action without a client poll",
        )
        self.assertIsNotNone(persisted)
        self.assertGreater(persisted["version"], before_version)

if __name__ == "__main__":
    unittest.main()

