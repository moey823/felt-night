import base64
import contextlib
import http.client
import io
import os
import json
import sqlite3
import struct
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch

import server


TEST_ROOM_PASSWORD = "test-room-invite"


def _test_png_data_uri(width=1, height=1):
    def chunk(kind, payload):
        checksum = zlib.crc32(kind + payload) & 0xffffffff
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", checksum)

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    pixels = b"".join(b"\x00" + bytes(width * 4) for _ in range(height))
    image = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(pixels))
        + chunk(b"IEND", b"")
    )
    return "data:image/png;base64," + base64.b64encode(image).decode("ascii")


class RoomPasswordConfigTests(unittest.TestCase):
    def test_env_password_is_an_explicit_alternative_and_validated(self):
        self.assertEqual(
            server._load_room_password({server.ROOM_PASSWORD_ENV: TEST_ROOM_PASSWORD}),
            TEST_ROOM_PASSWORD,
        )
        with self.assertRaisesRegex(RuntimeError, "single line") as caught:
            server._load_room_password({server.ROOM_PASSWORD_ENV: "private\ninvite"})
        self.assertNotIn("private", str(caught.exception))

    def test_admin_username_is_explicitly_opt_in_and_validated(self):
        self.assertIsNone(server._load_admin_username({}))
        self.assertEqual(
            server._load_admin_username({server.ADMIN_USERNAME_ENV: "Admin.Room"}),
            "admin.room",
        )
        with self.assertRaisesRegex(RuntimeError, "admin username"):
            server._load_admin_username({server.ADMIN_USERNAME_ENV: "bad username"})

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


@unittest.skipUnless(
    sys.platform == "darwin" and Path("/usr/bin/sandbox-exec").is_file(),
    "requires the macOS sandbox-exec facility",
)
class SQLiteTempStoreSandboxTests(unittest.TestCase):
    def test_bulk_delete_keeps_large_hand_history_temporary_work_in_memory(self):
        with tempfile.TemporaryDirectory(prefix="felt-night-temp-store-", dir="/private/tmp") as scratch:
            scratch_path = Path(scratch)
            data_dir = scratch_path / "data"
            store = server.Store(str(data_dir), TEST_ROOM_PASSWORD, admin_username="sandbox-admin")
            owner_id = "f" * 32
            table_ids = [f"{index + 1:032x}" for index in range(20)]
            now = time.time()
            conn = store.connect()
            try:
                conn.execute(
                    "INSERT INTO players(id,name,created) VALUES(?,?,?)",
                    (owner_id, "Synthetic sandbox owner", now),
                )
                for index, table_id in enumerate(table_ids):
                    name = "Synthetic archived game %d" % (index + 1)
                    state = json.dumps({"status": "cancelled", "name": name})
                    conn.execute(
                        "INSERT INTO tables(id,owner_id,state,created,updated) VALUES(?,?,?,?,?)",
                        (table_id, owner_id, state, now, now),
                    )
                    conn.execute(
                        "INSERT INTO tournament_history(table_id,owner_id,name,status,created) VALUES(?,?,?,?,?)",
                        (table_id, owner_id, name, "cancelled", now),
                    )

                hand_rows = []
                event_rows = []
                payload = '{"synthetic":"' + ("x" * 120) + '"}'
                for number in range(1, 80001):
                    hand_id = table_ids[0] + ("%08x" % number)
                    hand_rows.append((hand_id, table_ids[0], number, now, now, "showdown"))
                    event_rows.append((hand_id, 1, payload, now))
                    if len(hand_rows) >= 5000:
                        conn.executemany(
                            "INSERT INTO hand_history(hand_id,table_id,number,started,ended,street) VALUES(?,?,?,?,?,?)",
                            hand_rows,
                        )
                        conn.executemany(
                            "INSERT INTO hand_history_events(hand_id,seq,payload_json,recorded_at) VALUES(?,?,?,?)",
                            event_rows,
                        )
                        hand_rows.clear()
                        event_rows.clear()
                if hand_rows:
                    conn.executemany(
                        "INSERT INTO hand_history(hand_id,table_id,number,started,ended,street) VALUES(?,?,?,?,?,?)",
                        hand_rows,
                    )
                    conn.executemany(
                        "INSERT INTO hand_history_events(hand_id,seq,payload_json,recorded_at) VALUES(?,?,?,?)",
                        event_rows,
                    )
                conn.commit()
            finally:
                conn.close()

            profile_path = scratch_path / "test.sb"
            profile = "\n".join((
                "(version 1)",
                "(deny default)",
                "(allow file-read*)",
                '(allow file-write* (subpath "%s") (literal "/dev/null"))' % scratch,
                "(allow process-exec)",
                "(allow sysctl-read)",
                "(allow signal (target self))",
                "",
            ))
            profile_path.write_text(profile, encoding="utf-8")
            repository = Path(__file__).resolve().parents[1]
            child = r"""import json, sqlite3, sys
sys.path.insert(0, %r)
import server
store = server.Store.__new__(server.Store)
store.db_path = sys.argv[1]
ids = sys.argv[2:]
original_connect = store.connect
def file_temp_connect():
    conn = original_connect()
    conn.execute("PRAGMA temp_store=FILE")
    conn.execute("PRAGMA temp.cache_size=8")
    return conn
store.connect = file_temp_connect
try:
    store.delete_admin_history_bulk(ids)
except sqlite3.OperationalError as exc:
    if "disk I/O error" not in str(exc):
        raise
    print("FILE_TEMP_SPILL_DENIED:" + str(exc))
else:
    raise SystemExit("The synthetic archive did not force a denied SQLite temp-file spill.")
store.connect = original_connect
conn = store.connect()
try:
    if conn.execute("PRAGMA temp_store").fetchone()[0] != 2:
        raise SystemExit("Store.connect did not select SQLite in-memory temporary storage.")
finally:
    conn.close()
result = store.delete_admin_history_bulk(ids)
if result.get("deleted_count") != len(ids):
    raise SystemExit("The in-memory bulk delete returned an unexpected result.")
print("MEMORY_TEMP_DELETE_OK:" + json.dumps(result, sort_keys=True))
""" % str(repository)
            command = [
                "/usr/bin/sandbox-exec", "-f", str(profile_path), sys.executable, "-B", "-c",
                child, str(data_dir / "sitngo.sqlite3"), *table_ids,
            ]
            environment = os.environ.copy()
            environment.update({"PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1"})
            result = subprocess.run(command, cwd=repository, env=environment, text=True,
                                    capture_output=True, check=False)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("FILE_TEMP_SPILL_DENIED:disk I/O error", result.stdout)
            self.assertIn("MEMORY_TEMP_DELETE_OK:", result.stdout)


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
                origin=None, host=None, declared_length=None):
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        headers = {
            "Host": host or self.app.public_netloc,
            "Origin": self.origin if origin is None else origin,
        }
        if body is not None:
            headers["Content-Type"] = "application/json"
            headers["Content-Length"] = str(
                len(body) if declared_length is None else declared_length
            )
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

    def enable_admin(self, username="admin"):
        args = types.SimpleNamespace(
            public_origin=self.origin,
            data_dir=str(self.data_dir),
        )
        self.app = server.App(
            args, room_password=self.password, admin_username=username,
        )
        self.app.public_origin = self.origin
        self.app.public_netloc = "localhost:%d" % self.port
        self.app.secure_cookie = False
        self.httpd.app = self.app
        status, headers, body = self.request(
            "POST", "/poker/api/login", {"username": username, "password": ""},
        )
        if status != 200:
            raise AssertionError((status, body))
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

    def upload_avatar(self, cookie, proof, csrf, image_data):
        return self.request(
            "POST", "/poker/api/profile/avatar", {"image_data": image_data},
            cookie=cookie, proof=proof, csrf=csrf,
        )

    def test_avatar_upload_get_persistence_and_remove(self):
        cookie, proof, csrf, player = self.login("Avatar Player")
        self.assertEqual(player["avatar_url"], "")
        data_uri = _test_png_data_uri()
        image_bytes = base64.b64decode(data_uri.split(",", 1)[1])

        status, _, body = self.request(
            "POST", "/poker/api/profile/avatar", {"image_data": data_uri},
            cookie=cookie, proof=proof,
        )
        self.assertEqual(status, 403)
        self.assertEqual(body["error"]["code"], "csrf_failed")

        status, _, body = self.upload_avatar(cookie, proof, csrf, data_uri)
        self.assertEqual(status, 200, body)
        avatar_url = body["player"]["avatar_url"]
        self.assertRegex(avatar_url, r"^/poker/api/players/[a-f0-9]{32}/avatar\?v=[a-f0-9]{64}$")

        status, _, body = self.request("GET", avatar_url)
        self.assertEqual(status, 401)
        status, _, body = self.request("GET", avatar_url, cookie=cookie)
        self.assertEqual(status, 401)
        status, headers, served = self.request(
            "GET", avatar_url, cookie=cookie, proof=proof,
        )
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/png")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(served, image_bytes)

        avatar_id = avatar_url.split("/players/", 1)[1].split("/", 1)[0]
        status, _, bad_version = self.request(
            "GET", "/poker/api/players/" + avatar_id + "/avatar?v=bad",
            cookie=cookie, proof=proof,
        )
        self.assertEqual(status, 400)
        status, _, stale_version = self.request(
            "GET", "/poker/api/players/" + avatar_id + "/avatar?v=" + ("0" * 64),
            cookie=cookie, proof=proof,
        )
        self.assertEqual(status, 404)

        reopened_store = server.Store(str(self.data_dir), self.password)
        stored = reopened_store.get_player_avatar(player["id"])
        self.assertEqual(stored["content_type"], "image/png")
        self.assertEqual(stored["image_data"], image_bytes)

        status, _, me = self.request("GET", "/poker/api/me", cookie=cookie, proof=proof)
        self.assertEqual(status, 200)
        self.assertEqual(me["player"]["avatar_url"], avatar_url)

        status, _, removed = self.upload_avatar(cookie, proof, csrf, "")
        self.assertEqual(status, 200, removed)
        self.assertEqual(removed["player"]["avatar_url"], "")
        status, _, missing = self.request(
            "GET", avatar_url, cookie=cookie, proof=proof,
        )
        self.assertEqual(status, 404)

    def test_avatar_validation_rejects_bad_types_signatures_dimensions_and_sizes(self):
        cookie, proof, csrf, player = self.login("Avatar Validation")
        invalid_values = (
            "https://example.com/avatar.png",
            "data:image/svg+xml;base64,PHN2Zy8+",
            "data:image/png;base64," + base64.b64encode(b"not a png").decode("ascii"),
            "data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8\xffnot a jpeg\xff\xd9").decode("ascii"),
            _test_png_data_uri(width=1025),
        )
        for image_data in invalid_values:
            with self.subTest(image_data=image_data[:40]):
                status, _, body = self.upload_avatar(cookie, proof, csrf, image_data)
                self.assertEqual(status, 400, body)
                self.assertEqual(body["error"]["code"], "invalid_avatar")

        oversized_decoded = base64.b64encode(
            b"x" * (server.MAX_AVATAR_BYTES + 1)
        ).decode("ascii")
        status, _, body = self.upload_avatar(
            cookie, proof, csrf, "data:image/png;base64," + oversized_decoded,
        )
        self.assertEqual(status, 400, body)
        self.assertEqual(body["error"]["code"], "invalid_avatar")

        status, _, normal_too_large = self.request(
            "POST", "/poker/api/logout", {"padding": "x"},
            cookie=cookie, proof=proof, csrf=csrf,
            declared_length=server.MAX_BODY + 1,
        )
        self.assertEqual(status, 413)
        self.assertEqual(normal_too_large["error"]["code"], "body_too_large")

        status, _, avatar_too_large = self.request(
            "POST", "/poker/api/profile/avatar", {"image_data": "x"},
            cookie=cookie, proof=proof, csrf=csrf,
            declared_length=server.MAX_AVATAR_BODY + 1,
        )
        self.assertEqual(status, 413)
        self.assertEqual(avatar_too_large["error"]["code"], "body_too_large")

        status, _, me = self.request("GET", "/poker/api/me", cookie=cookie, proof=proof)
        self.assertEqual(me["player"]["avatar_url"], "")

    def test_avatar_urls_follow_players_in_table_views_without_revealing_opponent_cards(self):
        host_cookie, host_proof, host_csrf, host = self.login("Avatar Host")
        guest_cookie, guest_proof, guest_csrf, guest = self.login("Avatar Guest")
        status, _, uploaded = self.upload_avatar(
            host_cookie, host_proof, host_csrf, _test_png_data_uri(),
        )
        self.assertEqual(status, 200, uploaded)
        host_avatar_url = uploaded["player"]["avatar_url"]

        status, _, created = self.create_table(
            host_cookie, host_proof, host_csrf, name="Avatar seats",
        )
        self.assertEqual(status, 201, created)
        table_id = created["table"]["id"]
        self.assertEqual(
            next(seat for seat in created["table"]["seats"] if seat["id"] == host["id"])["avatar_url"],
            host_avatar_url,
        )

        status, _, joined = self.request(
            "POST", "/poker/api/tables/" + table_id + "/join", {},
            cookie=guest_cookie, proof=guest_proof, csrf=guest_csrf,
        )
        self.assertEqual(status, 200, joined)
        seats = joined["table"]["seats"]
        self.assertEqual(
            next(seat for seat in seats if seat["id"] == host["id"])["avatar_url"],
            host_avatar_url,
        )
        self.assertEqual(
            next(seat for seat in seats if seat["id"] == guest["id"])["avatar_url"],
            "",
        )
        self.assertTrue(all("avatar_url" in seat for seat in seats))
        self.assertTrue(all("image_data" not in seat and "avatar_data" not in seat for seat in seats))

        table_path = "/poker/api/tables/" + table_id
        status, _, started = self.request(
            "POST", table_path + "/start", {},
            cookie=host_cookie, proof=host_proof, csrf=host_csrf,
        )
        self.assertEqual(status, 200, started)
        status, _, polled = self.request(
            "GET", table_path, cookie=guest_cookie, proof=guest_proof,
        )
        self.assertEqual(status, 200, polled)
        table = polled["table"]
        self.assertEqual(
            next(seat for seat in table["seats"] if seat["id"] == host["id"])["avatar_url"],
            host_avatar_url,
        )
        own_seat = next(seat for seat in table["seats"] if seat["id"] == guest["id"])
        opponent_seat = next(seat for seat in table["seats"] if seat["id"] == host["id"])
        self.assertIn("cards", own_seat)
        self.assertNotIn("cards", opponent_seat)

    def test_existing_database_migrates_avatar_table_without_losing_players(self):
        with tempfile.TemporaryDirectory(prefix="sitngo-avatar-migration-") as directory:
            old_store = server.Store(directory, TEST_ROOM_PASSWORD)
            player_id = "a" * 32
            conn = old_store.connect()
            try:
                conn.execute(
                    "INSERT INTO players(id,name,created) VALUES(?,?,?)",
                    (player_id, "Existing", time.time()),
                )
                conn.execute("DROP TABLE player_avatars")
            finally:
                conn.close()

            migrated_store = server.Store(directory, TEST_ROOM_PASSWORD)
            conn = migrated_store.connect()
            try:
                player = conn.execute(
                    "SELECT id,name FROM players WHERE id=?", (player_id,),
                ).fetchone()
                avatar_table = conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='player_avatars'",
                ).fetchone()
            finally:
                conn.close()
            self.assertEqual(player["name"], "Existing")
            self.assertIsNotNone(avatar_table)

    def test_room_assets_and_security_page_are_served_with_safe_content_types(self):
        for path, expected_type in (
            ("/poker/room.css", "text/css"),
            ("/poker/ace.svg", "image/svg+xml"),
            ("/poker/manifest.webmanifest", "application/manifest+json"),
            ("/poker/service-worker.js", "text/javascript"),
            ("/poker/icon.svg", "image/svg+xml"),
            ("/poker/icon-192.png", "image/png"),
            ("/poker/icon-512.png", "image/png"),
            ("/poker/apple-touch-icon.png", "image/png"),
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

    def test_lobby_and_standalone_table_routes_serve_the_shared_app_shell(self):
        table_id = "a" * 32
        for path in (
            "/poker/",
            "/poker/lobby",
            "/poker/lobby?table=%s&setup=1" % table_id,
            "/lobby",
            "/table?table=%s" % table_id,
        ):
            with self.subTest(path=path):
                status, headers, body = self.request("GET", path)
                self.assertEqual(status, 200)
                self.assertIn("text/html", headers["Content-Type"])
                self.assertIn(b"id=\"table-view\"", body)
                self.assertNotIn(b"id=\"empty-state\"", body)
                self.assertNotIn(b"copy-invite-button", body)
                self.assertNotIn(b"open-table-window-button", body)
        status, _, body = self.request("GET", "/poker/api/me?table=%s" % table_id)
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "invalid_url")

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
            {"name": "Edited lobby", "starting_stack": 2000},
            cookie=host_cookie, proof=host_proof, csrf=host_csrf,
        )
        self.assertEqual(status, 200, updated)
        table = updated["table"]
        self.assertEqual(table["name"], "Edited lobby")
        self.assertEqual(table["config"]["max_seats"], 9)
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
                expected = "admin_required" if "bots" in suffix else "host_only"
                self.assertEqual(body["error"]["code"], expected)

    def test_sit_out_route_checks_csrf_ownership_and_persists_toggle(self):
        host_cookie, host_proof, host_csrf, host = self.login("Sitout Host")
        guest_cookie, guest_proof, guest_csrf, guest = self.login("Sitout Guest")
        outsider_cookie, outsider_proof, outsider_csrf, outsider = self.login("Sitout Outsider")
        status, _, created = self.create_table(
            host_cookie, host_proof, host_csrf, name="Sit-out table",
        )
        self.assertEqual(status, 201, created)
        table_id = created["table"]["id"]
        path = "/poker/api/tables/" + table_id
        status, _, joined = self.request(
            "POST", path + "/join", {}, cookie=guest_cookie,
            proof=guest_proof, csrf=guest_csrf,
        )
        self.assertEqual(status, 200, joined)
        status, _, started = self.request(
            "POST", path + "/start", {}, cookie=host_cookie,
            proof=host_proof, csrf=host_csrf,
        )
        self.assertEqual(status, 200, started)

        status, _, detail = self.request(
            "GET", path, cookie=host_cookie, proof=host_proof,
        )
        self.assertEqual(status, 200, detail)
        actor_id = detail["table"]["actor_id"]
        actor_auth = (
            (host_cookie, host_proof, host_csrf)
            if actor_id == host["id"]
            else (guest_cookie, guest_proof, guest_csrf)
        )

        status, _, body = self.request(
            "POST", path + "/sit-out", {"sitting_out": True},
            cookie=actor_auth[0], proof=actor_auth[1],
        )
        self.assertEqual(status, 403)
        self.assertEqual(body["error"]["code"], "csrf_failed")
        status, _, body = self.request(
            "POST", path + "/sit-out", {"sitting_out": True},
            cookie=actor_auth[0], proof=actor_auth[1], csrf=actor_auth[2],
            origin="https://unrelated.example",
        )
        self.assertEqual(status, 403)
        self.assertEqual(body["error"]["code"], "origin_rejected")

        status, _, body = self.request(
            "POST", path + "/sit-out", {"sitting_out": 1},
            cookie=actor_auth[0], proof=actor_auth[1], csrf=actor_auth[2],
        )
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "invalid_sitting_out")

        status, _, body = self.request(
            "POST", path + "/sit-out", {"sitting_out": True},
            cookie=outsider_cookie, proof=outsider_proof, csrf=outsider_csrf,
        )
        self.assertEqual(status, 409)
        self.assertEqual(body["error"]["code"], "not_seated")

        status, _, changed = self.request(
            "POST", path + "/sit-out", {"sitting_out": True},
            cookie=actor_auth[0], proof=actor_auth[1], csrf=actor_auth[2],
        )
        self.assertEqual(status, 200, changed)
        actor_seat = next(item for item in changed["table"]["seats"] if item["id"] == actor_id)
        self.assertTrue(actor_seat["sitting_out"])
        self.assertTrue(actor_seat["folded"])
        self.assertNotEqual(changed["table"]["actor_id"], actor_id)

        reopened = server.Store(str(self.data_dir), self.password)
        conn = reopened.connect()
        try:
            row = conn.execute("SELECT state FROM tables WHERE id=?", (table_id,)).fetchone()
            persisted = json.loads(row["state"])
        finally:
            conn.close()
        self.assertTrue(next(seat for seat in persisted["seats"] if seat["player_id"] == actor_id)["sitting_out"])

        status, _, returned = self.request(
            "POST", path + "/sit-out", {"sitting_out": False},
            cookie=actor_auth[0], proof=actor_auth[1], csrf=actor_auth[2],
        )
        self.assertEqual(status, 200, returned)
        actor_seat = next(item for item in returned["table"]["seats"] if item["id"] == actor_id)
        self.assertFalse(actor_seat["sitting_out"])
        self.assertTrue(actor_seat["folded"])

    def test_chat_is_table_scoped_available_to_spectators_and_independent_of_game_tokens(self):
        host_cookie, host_proof, host_csrf, host = self.login("Chat Host")
        player_cookie, player_proof, player_csrf, _ = self.login("Chat Player")
        spectator_cookie, spectator_proof, spectator_csrf, spectator = self.login("Chat Spectator")
        status, _, first = self.create_table(
            host_cookie, host_proof, host_csrf, name="Chat first",
        )
        self.assertEqual(status, 201, first)
        first_id = first["table"]["id"]
        first_path = "/poker/api/tables/" + first_id
        status, _, joined = self.request(
            "POST", first_path + "/join", {}, cookie=player_cookie,
            proof=player_proof, csrf=player_csrf,
        )
        self.assertEqual(status, 200, joined)
        status, _, started = self.request(
            "POST", first_path + "/start", {}, cookie=host_cookie,
            proof=host_proof, csrf=host_csrf,
        )
        self.assertEqual(status, 200, started)

        status, _, second = self.create_table(
            host_cookie, host_proof, host_csrf, name="Chat second",
        )
        self.assertEqual(status, 201, second)
        second_path = "/poker/api/tables/" + second["table"]["id"]

        status, _, unauthenticated = self.request(
            "GET", first_path + "/chat",
        )
        self.assertEqual(status, 401)
        self.assertEqual(unauthenticated["error"]["code"], "authentication_required")

        status, _, before = self.request(
            "GET", first_path, cookie=host_cookie, proof=host_proof,
        )
        self.assertEqual(status, 200, before)
        turn_version = before["table"]["turn_version"]

        chat_path = first_path + "/chat"
        message_text = "<b>hello</b>\nsecond line"
        status, _, missing_csrf = self.request(
            "POST", chat_path, {"text": message_text},
            cookie=spectator_cookie, proof=spectator_proof,
        )
        self.assertEqual(status, 403)
        self.assertEqual(missing_csrf["error"]["code"], "csrf_failed")
        status, _, wrong_origin = self.request(
            "POST", chat_path, {"text": message_text},
            cookie=spectator_cookie, proof=spectator_proof,
            csrf=spectator_csrf, origin="https://unrelated.example",
        )
        self.assertEqual(status, 403)
        self.assertEqual(wrong_origin["error"]["code"], "origin_rejected")

        status, _, created_message = self.request(
            "POST", chat_path,
            {"text": message_text, "name": "Spoofed", "player_id": "spoofed"},
            cookie=spectator_cookie, proof=spectator_proof, csrf=spectator_csrf,
        )
        self.assertEqual(status, 201, created_message)
        message = created_message["message"]
        self.assertIsInstance(message["id"], int)
        self.assertEqual(message["player_id"], spectator["id"])
        self.assertEqual(message["name"], spectator["name"])
        self.assertEqual(message["text"], message_text)
        self.assertIsInstance(message["created_at"], (int, float))

        status, _, limited = self.request(
            "POST", second_path + "/chat", {"text": "too soon"},
            cookie=spectator_cookie, proof=spectator_proof, csrf=spectator_csrf,
        )
        self.assertEqual(status, 429)
        self.assertEqual(limited["error"]["code"], "chat_rate_limited")

        for invalid_text in ("  \n ", "x" * 501, "bad" + chr(0) + "text"):
            status, _, invalid = self.request(
                "POST", chat_path, {"text": invalid_text},
                cookie=player_cookie, proof=player_proof, csrf=player_csrf,
            )
            self.assertEqual(status, 400)
            self.assertEqual(invalid["error"]["code"], "invalid_chat_message")

        status, _, first_messages = self.request(
            "GET", chat_path, cookie=spectator_cookie, proof=spectator_proof,
        )
        self.assertEqual(status, 200, first_messages)
        self.assertEqual(first_messages["messages"], [message])
        self.assertIsInstance(first_messages["server_now"], (int, float))
        status, _, second_messages = self.request(
            "GET", second_path + "/chat", cookie=spectator_cookie, proof=spectator_proof,
        )
        self.assertEqual(status, 200, second_messages)
        self.assertEqual(second_messages["messages"], [])

        status, _, after = self.request(
            "GET", first_path, cookie=host_cookie, proof=host_proof,
        )
        self.assertEqual(status, 200, after)
        self.assertEqual(after["table"]["turn_version"], turn_version)

        unknown = "/poker/api/tables/" + ("a" * 32) + "/chat"
        status, _, body = self.request(
            "GET", unknown, cookie=spectator_cookie, proof=spectator_proof,
        )
        self.assertEqual(status, 404)
        self.assertEqual(body["error"]["code"], "table_not_found")

    def test_reactions_are_private_to_the_sender_and_delivered_to_table_viewers(self):
        host_cookie, host_proof, host_csrf, host = self.login("Reaction Host")
        guest_cookie, guest_proof, guest_csrf, guest = self.login("Reaction Guest")
        spectator_cookie, spectator_proof, spectator_csrf, spectator = self.login("Reaction Watcher")
        status, _, created = self.create_table(
            host_cookie, host_proof, host_csrf, name="Reaction table",
        )
        self.assertEqual(status, 201, created)
        table_id = created["table"]["id"]
        path = "/poker/api/tables/" + table_id

        for cookie, proof, csrf, seat_no in (
            (host_cookie, host_proof, host_csrf, 4),
            (guest_cookie, guest_proof, guest_csrf, 2),
        ):
            status, _, seated = self.request(
                "POST", path + "/seat", {"seat_no": seat_no},
                cookie=cookie, proof=proof, csrf=csrf,
            )
            self.assertEqual(status, 200, seated)
        status, _, started = self.request(
            "POST", path + "/start", {},
            cookie=host_cookie, proof=host_proof, csrf=host_csrf,
        )
        self.assertEqual(status, 200, started)
        host_seat_no = next(
            seat["seat_no"] for seat in started["table"]["seats"] if seat["id"] == host["id"]
        )
        spoofed_seat_no = (host_seat_no + 1) % 9

        status, _, unauthenticated = self.request("GET", path + "/reactions")
        self.assertEqual(status, 401)
        self.assertEqual(unauthenticated["error"]["code"], "authentication_required")
        status, _, initial = self.request(
            "GET", path + "/reactions", cookie=spectator_cookie, proof=spectator_proof,
        )
        self.assertEqual(status, 200, initial)
        self.assertEqual(initial["reactions"], [])
        initial_cursor = initial["cursor"]

        status, _, not_seated = self.request(
            "POST", path + "/reactions", {"emoji": "👏"},
            cookie=spectator_cookie, proof=spectator_proof, csrf=spectator_csrf,
        )
        self.assertEqual(status, 403)
        self.assertEqual(not_seated["error"]["code"], "not_seated")
        status, _, invalid = self.request(
            "POST", path + "/reactions", {"emoji": "<script>"},
            cookie=host_cookie, proof=host_proof, csrf=host_csrf,
        )
        self.assertEqual(status, 400)
        self.assertEqual(invalid["error"]["code"], "invalid_reaction")

        conn = self.app.store.connect()
        try:
            table_state_before = conn.execute(
                "SELECT state FROM tables WHERE id=?", (table_id,),
            ).fetchone()["state"]
        finally:
            conn.close()
        status, _, sent = self.request(
            "POST", path + "/reactions",
            {"emoji": "👏", "seat_no": spoofed_seat_no, "player_id": spectator["id"]},
            cookie=host_cookie, proof=host_proof, csrf=host_csrf,
        )
        self.assertEqual(status, 201, sent)
        reaction = sent["reaction"]
        self.assertEqual(reaction["player_id"], host["id"])
        self.assertEqual(reaction["seat_no"], host_seat_no)
        self.assertEqual(reaction["emoji"], "👏")
        self.assertNotEqual(reaction["seat_no"], spoofed_seat_no)
        status, _, limited = self.request(
            "POST", path + "/reactions", {"emoji": "❤️"},
            cookie=host_cookie, proof=host_proof, csrf=host_csrf,
        )
        self.assertEqual(status, 429)
        self.assertEqual(limited["error"]["code"], "reaction_rate_limited")

        status, _, delivered = self.request(
            "GET", path + "/reactions?after=" + str(initial_cursor),
            cookie=spectator_cookie, proof=spectator_proof,
        )
        self.assertEqual(status, 200, delivered)
        self.assertEqual([item["id"] for item in delivered["reactions"]], [reaction["id"]])
        self.assertEqual(delivered["reactions"][0]["player_id"], host["id"])
        status, _, already_seen = self.request(
            "GET", path + "/reactions?after=" + str(reaction["id"]),
            cookie=guest_cookie, proof=guest_proof,
        )
        self.assertEqual(status, 200, already_seen)
        self.assertEqual(already_seen["reactions"], [])
        status, _, reconnect = self.request(
            "GET", path + "/reactions", cookie=spectator_cookie, proof=spectator_proof,
        )
        self.assertEqual(status, 200, reconnect)
        self.assertEqual(reconnect["reactions"], [], "initial connection must not replay old bursts")

        conn = self.app.store.connect()
        try:
            table_state_after = conn.execute(
                "SELECT state FROM tables WHERE id=?", (table_id,),
            ).fetchone()["state"]
        finally:
            conn.close()
        self.assertEqual(table_state_after, table_state_before,
                         "a reaction must not change poker state, revisions, or deadlines")

    def test_reaction_events_are_capped_and_expired(self):
        host_cookie, host_proof, host_csrf, host = self.login("Reaction Storage")
        status, _, created = self.create_table(
            host_cookie, host_proof, host_csrf, name="Reaction storage",
        )
        self.assertEqual(status, 201, created)
        table_id = created["table"]["id"]
        status, _, seated = self.request(
            "POST", "/poker/api/tables/" + table_id + "/seat", {"seat_no": 0},
            cookie=host_cookie, proof=host_proof, csrf=host_csrf,
        )
        self.assertEqual(status, 200, seated)

        lifetime = server.REACTION_LIFETIME_SECONDS
        server.REACTION_LIFETIME_SECONDS = 1000.0
        try:
            base = time.time() - 100
            for index in range(40):
                self.app.store.add_table_reaction(
                    table_id, host["id"], "👏", base + index,
                )
            conn = self.app.store.connect()
            try:
                count = conn.execute(
                    "SELECT COUNT(*) AS n FROM table_reactions WHERE table_id=?",
                    (table_id,),
                ).fetchone()["n"]
            finally:
                conn.close()
            self.assertEqual(count, server.REACTION_TABLE_LIMIT)
        finally:
            server.REACTION_LIFETIME_SECONDS = lifetime

        self.app.store.prune_expired_table_reactions(time.time() + lifetime + 1000)
        conn = self.app.store.connect()
        try:
            count = conn.execute(
                "SELECT COUNT(*) AS n FROM table_reactions WHERE table_id=?",
                (table_id,),
            ).fetchone()["n"]
        finally:
            conn.close()
        self.assertEqual(count, 0)

    def test_chat_storage_is_bounded_and_rate_limit_insert_is_atomic(self):
        host_cookie, host_proof, host_csrf, host = self.login("Chat Storage")
        status, _, created = self.create_table(
            host_cookie, host_proof, host_csrf, name="Bounded chat",
        )
        self.assertEqual(status, 201, created)
        table_id = created["table"]["id"]

        for index in range(101):
            self.app.store.add_chat_message(
                table_id, host["id"], host["name"], "message %d" % index,
                now=1000 + index,
            )
        conn = self.app.store.connect()
        try:
            stored_count = conn.execute(
                "SELECT COUNT(*) AS n FROM chat_messages WHERE table_id=?",
                (table_id,),
            ).fetchone()["n"]
        finally:
            conn.close()
        self.assertEqual(stored_count, 100)

        page = self.app.store.list_chat_messages(table_id)
        self.assertEqual(len(page), server.CHAT_READ_LIMIT)
        self.assertEqual(page[0]["text"], "message 51")
        self.assertEqual(page[-1]["text"], "message 100")
        self.assertEqual([item["id"] for item in page], sorted(item["id"] for item in page))

        barrier = threading.Barrier(2)
        results = []
        def insert_simultaneously(message_text):
            barrier.wait(timeout=2)
            try:
                self.app.store.add_chat_message(
                    table_id, host["id"], host["name"], message_text, now=2000,
                )
                results.append(("created", None))
            except server.AppError as exc:
                results.append(("error", exc.status, exc.code))

        workers = [
            threading.Thread(target=insert_simultaneously, args=("parallel 1",)),
            threading.Thread(target=insert_simultaneously, args=("parallel 2",)),
        ]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(timeout=3)
        self.assertTrue(all(not worker.is_alive() for worker in workers))
        self.assertEqual(sum(result[0] == "created" for result in results), 1)
        self.assertIn(("error", 429, "chat_rate_limited"), results)
        self.assertEqual(len(self.app.store.list_chat_messages(table_id)), 50)

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
        # Simulate the older retained table shape, before hand header metadata existed.
        for field in ("small_blind", "big_blind", "blind_level", "button_id"):
            state["hand"].pop(field, None)
        state["blinds"] = {"level": 1}
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
                    ("history_backfill_v1", "1"),
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
            self.assertEqual(
                conn.execute(
                    "SELECT value FROM meta WHERE key='history_text_metadata_v1'",
                ).fetchone()["value"],
                "1",
            )
            migrated_hand = conn.execute(
                "SELECT small_blind,big_blind,blind_level,button_player_id "
                "FROM hand_history WHERE table_id=? AND number=1",
                (table_id,),
            ).fetchone()
            self.assertEqual(
                tuple(migrated_hand),
                (10, 20, 1, state["hand"]["small_blind_id"]),
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
        self.assertIn("Felt Night Tournament Summary", summary["summary_text"])
        self.assertIn("Starting blinds: 10/20", summary["summary_text"])
        status, _, detail = self.request(
            "GET", "/poker/api/history/" + table_id,
            cookie=cookie, proof=proof,
        )
        self.assertEqual(status, 200, detail)
        self.assertEqual(detail["hands"][0]["ended"], old_updated)
        self.assertIn("Felt Night Hand #1", detail["hands"][0]["history_text"])
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
        self.assertIn("Felt Night Hand #1", first_hand["history_text"])
        self.assertIn("Dealt to Robin [" + " ".join(host_players[host["id"]]["cards"]) + "]", first_hand["history_text"])

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
        hidden_host_pair = "[" + " ".join(host_players[host["id"]]["cards"]) + "]"
        self.assertNotIn(hidden_host_pair, guest_detail["hands"][0]["history_text"])
        self.assertIn("Dealt to Morgan [" + " ".join(guest_players[guest["id"]]["cards"]) + "]", guest_detail["hands"][0]["history_text"])

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
        self.assertIn("[" + " ".join(host_cards) + "]", guest_final["hands"][1]["history_text"])
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

    def test_admin_config_owns_shared_timers_presets_and_existing_table_defaults(self):
        admin_cookie, admin_proof, admin_csrf, admin = self.enable_admin("admin")
        admin_auth = dict(cookie=admin_cookie, proof=admin_proof, csrf=admin_csrf)
        host_cookie, host_proof, host_csrf, host = self.login("Host")
        guest_cookie, guest_proof, guest_csrf, guest = self.login("Guest")
        host_auth = dict(cookie=host_cookie, proof=host_proof, csrf=host_csrf)

        status, _, reserved = self.request(
            "POST", "/poker/api/register",
            {"username": "ADMIN", "password": self.account_password,
             "room_password": self.password},
        )
        self.assertEqual(status, 409)
        self.assertEqual(reserved["error"]["code"], "username_reserved")
        status, _, wrong_admin_password = self.request(
            "POST", "/poker/api/login", {"username": "admin", "password": "wrong"},
        )
        self.assertEqual(status, 401)

        status, _, normal_config = self.request(
            "GET", "/poker/api/config", cookie=host_cookie, proof=host_proof,
        )
        self.assertEqual(status, 200, normal_config)
        self.assertEqual(normal_config["config"]["bet_presets"]["preflop_bb"], [2.5, 3, 4])
        status, _, not_admin = self.request(
            "GET", "/poker/api/admin/config", cookie=host_cookie, proof=host_proof,
        )
        self.assertEqual(status, 403)
        self.assertEqual(not_admin["error"]["code"], "admin_required")
        status, _, not_admin_write = self.request(
            "POST", "/poker/api/admin/config", {"runout_seconds": 3}, **host_auth,
        )
        self.assertEqual(status, 403)
        self.assertEqual(not_admin_write["error"]["code"], "admin_required")

        for bad_config in (
            {"runout_seconds": 0},
            {"showdown_seconds": 61},
            {"uncontested_seconds": -1},
            {"uncontested_seconds": 61},
            {"uncontested_seconds": True},
            {"bet_presets": {"preflop_bb": [3, 2]}},
            {"bet_presets": {"postflop_percent": [0, 50]}},
        ):
            status, _, rejected = self.request(
                "POST", "/poker/api/admin/config", bad_config, **admin_auth,
            )
            self.assertEqual(status, 400, rejected)
            self.assertEqual(rejected["error"]["code"], "invalid_admin_config")

        cfg = {
            "name": "Admin controlled pace", "max_seats": 2,
            "starting_stack": 1000, "small_blind": 10, "big_blind": 20,
            "level_minutes": 97, "turn_seconds": 19, "runout_seconds": 1.5,
            "blind_announcement_seconds": 0, "elimination_announcement_seconds": 61,
            "showdown_seconds": -1, "buy_in": 25,
            "payout_percentages": [60, 25, 15],
        }
        status, _, created = self.request("POST", "/poker/api/tables", cfg, **host_auth)
        self.assertEqual(status, 201, created)
        table = created["table"]
        self.assertEqual(table["config"]["max_seats"], 9)
        for field, default in (
            ("runout_seconds", 2.5), ("blind_announcement_seconds", 5),
            ("elimination_announcement_seconds", 5), ("showdown_seconds", 5),
            ("uncontested_seconds", 1.5),
        ):
            self.assertEqual(table["config"][field], default)
        self.assertEqual(table["config"]["level_minutes"], 97)
        self.assertEqual(table["config"]["turn_seconds"], 19)
        table_id = table["id"]
        path = "/poker/api/tables/" + table_id

        status, _, forbidden_seat = self.request(
            "POST", path + "/seat", {"seat_no": 1}, **admin_auth,
        )
        self.assertEqual(status, 403)
        self.assertEqual(forbidden_seat["error"]["code"], "admin_read_only")
        status, _, seated = self.request(
            "POST", path + "/seat", {"seat_no": 8},
            cookie=guest_cookie, proof=guest_proof, csrf=guest_csrf,
        )
        self.assertEqual(status, 200, seated)
        status, _, not_host_start = self.request(
            "POST", path + "/start", {}, **admin_auth,
        )
        self.assertEqual(status, 403)
        self.assertEqual(not_host_start["error"]["code"], "admin_read_only")

        for field, value in (
            ("max_seats", 4), ("runout_seconds", 7),
            ("blind_announcement_seconds", 10),
            ("elimination_announcement_seconds", 10), ("showdown_seconds", 10),
            ("uncontested_seconds", 10),
        ):
            status, _, rejected = self.request(
                "POST", path + "/settings", {field: value}, **host_auth,
            )
            self.assertEqual(status, 400, rejected)
            self.assertEqual(rejected["error"]["code"], "invalid_settings")

        status, _, changed = self.request(
            "POST", "/poker/api/admin/config",
            {
                "runout_seconds": 3.25,
                "blind_announcement_seconds": 4,
                "elimination_announcement_seconds": 6,
                "showdown_seconds": 7,
                "uncontested_seconds": 8.25,
                "bet_presets": {
                    "preflop_bb": [2, 2.5, 4, 5],
                    "postflop_percent": [25, 50, 75, 100, 150],
                },
            },
            **admin_auth,
        )
        self.assertEqual(status, 200, changed)
        self.assertEqual(changed["config"]["runout_seconds"], 3.25)
        self.assertEqual(changed["config"]["uncontested_seconds"], 8.25)
        self.assertEqual(changed["config"]["bet_presets"]["postflop_percent"], [25, 50, 75, 100, 150])

        status, _, started = self.request("POST", path + "/start", {}, **host_auth)
        self.assertEqual(status, 200, started)
        self.assertEqual(started["table"]["config"]["max_seats"], 2)
        self.assertEqual(started["table"]["config"]["uncontested_seconds"], 8.25)
        self.assertEqual(started["table"]["config"]["payout_percentages"], [71, 29])
        self.assertEqual(started["table"]["prize"]["payout_percentages"], [71, 29])
        self.assertAlmostEqual(
            started["table"]["turn_deadline"] - started["table"]["server_now"],
            19, delta=0.1,
        )
        status, _, forbidden_action = self.request(
            "POST", path + "/action",
            {"action": "check", "expected_hand": started["table"]["hand_no"],
             "expected_turn_version": started["table"]["turn_version"]},
            **admin_auth,
        )
        self.assertEqual(status, 403)
        self.assertEqual(forbidden_action["error"]["code"], "admin_read_only")

        future_runout = time.time() + 90
        def preserve_deadline(state):
            state["hand"]["runout_at"] = future_runout
            return state
        self.app.store.mutate_table(table_id, preserve_deadline, time.time())
        status, _, updated_detail = self.request(
            "GET", path, cookie=host_cookie, proof=host_proof,
        )
        self.assertEqual(status, 200, updated_detail)
        original_turn_deadline = updated_detail["table"]["turn_deadline"]
        status, _, changed_again = self.request(
            "POST", "/poker/api/admin/config", {"runout_seconds": 2}, **admin_auth,
        )
        self.assertEqual(status, 200, changed_again)
        status, _, refreshed = self.request("GET", path, cookie=host_cookie, proof=host_proof)
        self.assertEqual(status, 200, refreshed)
        self.assertEqual(refreshed["table"]["config"]["runout_seconds"], 2)
        self.assertEqual(refreshed["table"]["turn_deadline"], original_turn_deadline)
        self.assertEqual(refreshed["table"]["runout_at"], future_runout)

        status, _, admin_tables = self.request(
            "GET", "/poker/api/tables", cookie=admin_cookie, proof=admin_proof,
        )
        self.assertEqual(status, 200, admin_tables)
        status, _, admin_detail = self.request(
            "GET", path, cookie=admin_cookie, proof=admin_proof,
        )
        self.assertEqual(status, 200, admin_detail)
        self.assertFalse(admin_detail["table"]["viewer"]["seated"])
        self.assertTrue(all("cards" not in seat for seat in admin_detail["table"]["seats"]))

        args = types.SimpleNamespace(public_origin=self.origin, data_dir=str(self.data_dir))
        self.app = server.App(args, room_password=self.password, admin_username="admin")
        self.app.public_origin = self.origin
        self.app.public_netloc = "localhost:%d" % self.port
        self.httpd.app = self.app
        status, _, persisted = self.request(
            "GET", "/poker/api/config", cookie=host_cookie, proof=host_proof,
        )
        self.assertEqual(status, 200, persisted)
        self.assertEqual(persisted["config"]["runout_seconds"], 2)
        self.assertEqual(persisted["config"]["bet_presets"]["preflop_bb"], [2, 2.5, 4, 5])

    def test_host_pause_and_paused_runtime_settings_are_authorized_and_pacing_only(self):
        host_cookie, host_proof, host_csrf, host = self.login("Host")
        guest_cookie, guest_proof, guest_csrf, guest = self.login("Guest")
        host_auth = dict(cookie=host_cookie, proof=host_proof, csrf=host_csrf)
        guest_auth = dict(cookie=guest_cookie, proof=guest_proof, csrf=guest_csrf)
        status, _, created = self.create_table(
            host_cookie, host_proof, host_csrf, name="Pause control", max_seats=2,
        )
        self.assertEqual(status, 201, created)
        table_id = created["table"]["id"]
        path = "/poker/api/tables/" + table_id
        status, _, joined = self.request("POST", path + "/join", {}, **guest_auth)
        self.assertEqual(status, 200, joined)
        status, _, started = self.request("POST", path + "/start", {}, **host_auth)
        self.assertEqual(status, 200, started)

        status, _, denied = self.request(
            "POST", path + "/pause", {"paused": True}, **guest_auth,
        )
        self.assertEqual(status, 403)
        self.assertEqual(denied["error"]["code"], "host_only")
        status, _, invalid_pause = self.request(
            "POST", path + "/pause", {"paused": 1}, **host_auth,
        )
        self.assertEqual(status, 400)
        self.assertEqual(invalid_pause["error"]["code"], "invalid_pause")

        status, _, unpaused_settings = self.request(
            "POST", path + "/settings", {"turn_seconds": 8}, **host_auth,
        )
        self.assertEqual(status, 409)
        self.assertEqual(unpaused_settings["error"]["code"], "table_not_paused")
        status, _, paused = self.request(
            "POST", path + "/pause", {"paused": True}, **host_auth,
        )
        self.assertEqual(status, 200, paused)
        self.assertTrue(paused["table"]["paused"])
        self.assertIsNotNone(paused["table"]["paused_at"])
        self.assertFalse(paused["table"]["viewer"]["can_act"])

        view = paused["table"]
        status, _, rejected_action = self.request(
            "POST", path + "/action",
            {"action": "check", "expected_hand": view["hand_no"],
             "expected_turn_version": view["turn_version"]},
            **guest_auth,
        )
        self.assertEqual(status, 409)
        self.assertEqual(rejected_action["error"]["code"], "table_paused")
        status, _, rejected_sit_out = self.request(
            "POST", path + "/sit-out", {"sitting_out": True}, **guest_auth,
        )
        self.assertEqual(status, 409)
        self.assertEqual(rejected_sit_out["error"]["code"], "table_paused")

        pacing = {"turn_seconds": 15, "level_minutes": 0.5}
        status, _, updated = self.request(
            "POST", path + "/settings", pacing, **host_auth,
        )
        self.assertEqual(status, 200, updated)
        for field, value in pacing.items():
            self.assertEqual(updated["table"]["config"][field], value)

        for forbidden in (
            {"max_seats": 3}, {"starting_stack": 2000},
            {"small_blind": 20}, {"big_blind": 40},
            {"buy_in": 0}, {"payout_percentages": [100]},
            {"runout_seconds": 3}, {"showdown_seconds": 4},
            {"name": "Renamed while playing"},
        ):
            with self.subTest(forbidden=forbidden):
                status, _, rejected = self.request(
                    "POST", path + "/settings", forbidden, **host_auth,
                )
                expected_status = 409 if "name" in forbidden else 400
                self.assertEqual(status, expected_status)
                self.assertIn(rejected["error"]["code"], {
                    "invalid_config", "invalid_settings", "table_started",
                })

        for field, value in (
            ("blind_announcement_seconds", -1),
            ("blind_announcement_seconds", 61),
            ("elimination_announcement_seconds", float("nan")),
            ("elimination_announcement_seconds", float("inf")),
            ("showdown_seconds", -1),
            ("showdown_seconds", 61),
            ("showdown_seconds", True),
        ):
            with self.subTest(field=field, value=value):
                status, _, rejected = self.request(
                    "POST", path + "/settings", {field: value}, **host_auth,
                )
                self.assertEqual(status, 400)

        status, _, resumed = self.request(
            "POST", path + "/pause", {"paused": False}, **host_auth,
        )
        self.assertEqual(status, 200, resumed)
        self.assertFalse(resumed["table"]["paused"])
        self.assertIsNone(resumed["table"]["paused_at"])

    def test_testing_bots_are_admin_only_and_capacity_locks_at_start(self):
        admin_cookie, admin_proof, admin_csrf, admin = self.enable_admin()
        admin_auth = dict(cookie=admin_cookie, proof=admin_proof, csrf=admin_csrf)
        host_cookie, host_proof, host_csrf, host = self.login("Bot host")
        host_auth = dict(cookie=host_cookie, proof=host_proof, csrf=host_csrf)
        guest_cookie, guest_proof, guest_csrf, guest = self.login("Bot guest")
        status, _, created = self.create_table(
            host_cookie, host_proof, host_csrf, name="Bot lobby", max_seats=3,
        )
        self.assertEqual(status, 201, created)
        table_id = created["table"]["id"]
        path = "/poker/api/tables/" + table_id
        self.assertEqual(created["table"]["config"]["max_seats"], 9)

        status, _, host_bot = self.request("POST", path + "/bots", {"seat_no": 1}, **host_auth)
        self.assertEqual(status, 403)
        self.assertEqual(host_bot["error"]["code"], "admin_required")
        status, _, admin_bot = self.request("POST", path + "/bots", {"seat_no": 4}, **admin_auth)
        self.assertEqual(status, 200, admin_bot)
        self.assertTrue(next(seat for seat in admin_bot["table"]["seats"] if seat["seat_no"] == 4)["is_bot"])
        status, _, host_remove = self.request(
            "DELETE", path + "/bots/4", cookie=host_cookie, proof=host_proof, csrf=host_csrf,
        )
        self.assertEqual(status, 403)
        self.assertEqual(host_remove["error"]["code"], "admin_required")
        status, _, removed = self.request(
            "DELETE", path + "/bots/4", **admin_auth,
        )
        self.assertEqual(status, 200, removed)

        status, _, guest_seat = self.request(
            "POST", path + "/seat", {"seat_no": 8},
            cookie=guest_cookie, proof=guest_proof, csrf=guest_csrf,
        )
        self.assertEqual(status, 200, guest_seat)
        status, _, admin_seat = self.request("POST", path + "/join", {}, **admin_auth)
        self.assertEqual(status, 403)
        self.assertEqual(admin_seat["error"]["code"], "admin_read_only")
        status, _, admin_start = self.request("POST", path + "/start", {}, **admin_auth)
        self.assertEqual(status, 403)
        self.assertEqual(admin_start["error"]["code"], "admin_read_only")

        status, _, started = self.request("POST", path + "/start", {}, **host_auth)
        self.assertEqual(status, 200, started)
        self.assertEqual(started["table"]["status"], "playing")
        self.assertEqual(started["table"]["config"]["max_seats"], 2)
        status, _, too_late = self.request(
            "POST", path + "/bots", {"seat_no": 7}, **admin_auth,
        )
        self.assertEqual(status, 409)
        self.assertEqual(too_late["error"]["code"], "table_started")

    def test_host_end_requires_scoped_one_time_confirmation_and_preserves_private_history(self):
        host_cookie, host_proof, host_csrf, host = self.login("End host")
        guest_cookie, guest_proof, guest_csrf, guest = self.login("End guest")
        host_auth = dict(cookie=host_cookie, proof=host_proof, csrf=host_csrf)
        guest_auth = dict(cookie=guest_cookie, proof=guest_proof, csrf=guest_csrf)
        status, _, created = self.create_table(
            host_cookie, host_proof, host_csrf, name="End safely", max_seats=4,
        )
        self.assertEqual(status, 201, created)
        table_id = created["table"]["id"]
        path = "/poker/api/tables/" + table_id
        status, _, other_lobby = self.create_table(
            host_cookie, host_proof, host_csrf, name="Other end target",
        )
        self.assertEqual(status, 201, other_lobby)
        other_path = "/poker/api/tables/" + other_lobby["table"]["id"]
        status, _, joined = self.request("POST", path + "/seat", {"seat_no": 8}, **guest_auth)
        self.assertEqual(status, 200, joined)
        status, _, started = self.request("POST", path + "/start", {}, **host_auth)
        self.assertEqual(status, 200, started)

        status, _, confirmation = self.request("POST", path + "/end", {"confirm": True}, **host_auth)
        self.assertEqual(status, 200, confirmation)
        token = confirmation["confirmation_token"]
        self.assertGreater(confirmation["expires_at"], time.time())
        status, _, wrong_host = self.request(
            "POST", path + "/end", {"confirmation_token": token}, **guest_auth,
        )
        self.assertEqual(status, 403)
        self.assertEqual(wrong_host["error"]["code"], "invalid_confirmation")
        status, _, wrong_table = self.request(
            "POST", other_path + "/end", {"confirmation_token": token}, **host_auth,
        )
        self.assertEqual(status, 403)
        self.assertEqual(wrong_table["error"]["code"], "invalid_confirmation")

        status, _, ended = self.request(
            "POST", path + "/end", {"confirmation_token": token}, **host_auth,
        )
        self.assertEqual(status, 200, ended)
        table = ended["table"]
        self.assertEqual(table["status"], "ended")
        self.assertEqual(table["results"], [])
        self.assertEqual(table["turn_deadline"], None)
        self.assertEqual(table["runout_at"], None)
        self.assertEqual(table["actor_id"], None)
        self.assertEqual(table["config"]["max_seats"], 2)
        self.assertTrue(all("cards" not in seat for seat in table["seats"] if seat["id"] != host["id"]))

        status, _, history_page = self.request(
            "GET", "/poker/api/history/" + table_id, cookie=host_cookie, proof=host_proof,
        )
        self.assertEqual(status, 200, history_page)
        self.assertEqual(history_page["tournament"]["status"], "ended")
        self.assertEqual(history_page["tournament"]["results"], [])
        self.assertEqual(len(history_page["hands"]), 1)
        hand_players = {item["player_id"]: item for item in history_page["hands"][0]["players"]}
        self.assertIsNotNone(hand_players[host["id"]]["cards"])
        self.assertIsNone(hand_players[guest["id"]]["cards"])
        status, _, reused = self.request(
            "POST", path + "/end", {"confirmation_token": token}, **host_auth,
        )
        self.assertEqual(status, 403)
        self.assertEqual(reused["error"]["code"], "invalid_confirmation")
        status, _, lobby_confirmation = self.request(
            "POST", other_path + "/end", {"confirm": True}, **host_auth,
        )
        self.assertEqual(status, 200, lobby_confirmation)
        status, _, cancelled_lobby = self.request(
            "POST", other_path + "/end",
            {"confirmation_token": lobby_confirmation["confirmation_token"]}, **host_auth,
        )
        self.assertEqual(status, 200, cancelled_lobby)
        self.assertEqual(cancelled_lobby["table"]["status"], "cancelled")

    def test_admin_history_lists_only_terminal_games_with_paging_and_redaction(self):
        admin_cookie, admin_proof, admin_csrf, _ = self.enable_admin()
        admin_auth = dict(cookie=admin_cookie, proof=admin_proof, csrf=admin_csrf)
        host_cookie, host_proof, host_csrf, host = self.login("History Host")
        guest_cookie, guest_proof, guest_csrf, guest = self.login("History Guest")
        host_auth = dict(cookie=host_cookie, proof=host_proof, csrf=host_csrf)

        status, _, denied = self.request("GET", "/poker/api/admin/history")
        self.assertEqual(status, 401)
        status, _, denied = self.request(
            "GET", "/poker/api/admin/history", cookie=host_cookie, proof=host_proof,
        )
        self.assertEqual(status, 403)
        self.assertEqual(denied["error"]["code"], "admin_required")

        def finish(path):
            status, _, prompt = self.request("POST", path + "/end", {"confirm": True}, **host_auth)
            self.assertEqual(status, 200, prompt)
            status, _, ended = self.request(
                "POST", path + "/end",
                {"confirmation_token": prompt["confirmation_token"]}, **host_auth,
            )
            self.assertEqual(status, 200, ended)
            return ended

        status, _, lobby = self.create_table(host_cookie, host_proof, host_csrf, name="Empty cancel")
        self.assertEqual(status, 201, lobby)
        lobby_id = lobby["table"]["id"]
        lobby_path = "/poker/api/tables/" + lobby_id
        status, _, active_detail = self.request(
            "GET", "/poker/api/admin/history/" + lobby_id, **admin_auth,
        )
        self.assertEqual(status, 409)
        status, _, active_delete = self.request(
            "POST", "/poker/api/admin/history/" + lobby_id + "/delete",
            {"confirm_delete": True}, **admin_auth,
        )
        self.assertEqual(status, 409)
        cancelled = finish(lobby_path)
        self.assertEqual(cancelled["table"]["status"], "cancelled")

        status, _, created = self.create_table(host_cookie, host_proof, host_csrf, name="Ended game")
        self.assertEqual(status, 201, created)
        table_id = created["table"]["id"]
        table_path = "/poker/api/tables/" + table_id
        status, _, seated = self.request(
            "POST", table_path + "/seat", {"seat_no": 1},
            cookie=guest_cookie, proof=guest_proof, csrf=guest_csrf,
        )
        self.assertEqual(status, 200, seated)
        status, _, started = self.request("POST", table_path + "/start", {}, **host_auth)
        self.assertEqual(status, 200, started)
        status, _, playing_detail = self.request(
            "GET", "/poker/api/admin/history/" + table_id, **admin_auth,
        )
        self.assertEqual(status, 409)
        status, _, playing_delete = self.request(
            "POST", "/poker/api/admin/history/" + table_id + "/delete",
            {"confirm_delete": True}, **admin_auth,
        )
        self.assertEqual(status, 409)
        ended = finish(table_path)
        self.assertEqual(ended["table"]["status"], "ended")

        status, _, expiring = self.create_table(
            host_cookie, host_proof, host_csrf, name="Empty expire",
        )
        self.assertEqual(status, 201, expiring)
        expired_id = expiring["table"]["id"]
        future = time.time() + server.engine.LOBBY_IDLE_SECONDS + 1
        expired = self.app.store.mutate_table(expired_id, lambda state: state, future)
        self.assertEqual(expired["status"], "expired")

        # Isolated archive rows exercise the 20-item pagination cursor.
        conn = self.app.store.connect()
        synthetic_ids = []
        try:
            created_at = time.time() + 10000
            for index in range(21):
                archive_id = server.uuid.uuid4().hex
                synthetic_ids.append(archive_id)
                conn.execute(
                    """INSERT INTO tournament_history
                       (table_id,owner_id,name,status,created,results_json,standings_json)
                       VALUES(?,?,?,?,?,'[]','[]')""",
                    (archive_id, host["id"], "Archive %02d" % index,
                     "cancelled", created_at + index),
                )
        finally:
            conn.close()

        status, _, page0 = self.request(
            "GET", "/poker/api/admin/history?offset=0", **admin_auth,
        )
        self.assertEqual(status, 200, page0)
        self.assertEqual(len(page0["tournaments"]), 20)
        self.assertEqual(page0["next_offset"], 20)
        status, _, page1 = self.request(
            "GET", "/poker/api/admin/history?offset=20", **admin_auth,
        )
        self.assertEqual(status, 200, page1)
        self.assertEqual(len(page1["tournaments"]), 4)
        self.assertIsNone(page1["next_offset"])
        listed = page0["tournaments"] + page1["tournaments"]
        listed_ids = {item["id"] for item in listed}
        self.assertTrue(set(synthetic_ids + [lobby_id, table_id, expired_id]).issubset(listed_ids))
        statuses = {item["id"]: item["status"] for item in listed}
        self.assertEqual(statuses[lobby_id], "cancelled")
        self.assertEqual(statuses[table_id], "ended")
        self.assertEqual(statuses[expired_id], "expired")

        status, _, empty_detail = self.request(
            "GET", "/poker/api/admin/history/" + lobby_id, **admin_auth,
        )
        self.assertEqual(status, 200, empty_detail)
        self.assertEqual(empty_detail["tournament"]["participants"], [])
        self.assertEqual(empty_detail["tournament"]["results"], [])
        self.assertEqual(empty_detail["hands"], [])
        status, _, detail = self.request(
            "GET", "/poker/api/admin/history/" + table_id, **admin_auth,
        )
        self.assertEqual(status, 200, detail)
        self.assertEqual(detail["tournament"]["results"], [])
        self.assertEqual(len(detail["hands"]), 1)
        self.assertEqual(
            {item["player_id"] for item in detail["hands"][0]["players"]},
            {host["id"], guest["id"]},
        )
        self.assertTrue(all(
            item["cards"] is None and not item["revealed"]
            for item in detail["hands"][0]["players"]
        ))
        self.assertIn("Felt Night Tournament Summary", detail["tournament"]["summary_text"])
        hand_text = detail["hands"][0]["history_text"]
        self.assertIn("Felt Night Hand #1", hand_text)
        self.assertNotIn("Dealt to History Host", hand_text)
        conn = self.app.store.connect()
        try:
            private_row = conn.execute(
                "SELECT cards_json FROM hand_history_players WHERE hand_id=? AND player_id=?",
                (detail["hands"][0]["hand_id"], host["id"]),
            ).fetchone()
        finally:
            conn.close()
        private_pair = "[" + " ".join(json.loads(private_row["cards_json"])) + "]"
        self.assertNotIn(private_pair, hand_text)
        self.assertNotIn(private_pair, json.dumps(detail["hands"][0]))
        status, _, host_denied = self.request(
            "GET", "/poker/api/admin/history/" + table_id,
            cookie=host_cookie, proof=host_proof,
        )
        self.assertEqual(status, 403)
        self.assertEqual(host_denied["error"]["code"], "admin_required")

    def test_admin_history_delete_is_confirmed_cleans_game_data_and_keeps_accounts(self):
        admin_cookie, admin_proof, admin_csrf, _ = self.enable_admin()
        admin_auth = dict(cookie=admin_cookie, proof=admin_proof, csrf=admin_csrf)
        host_cookie, host_proof, host_csrf, host = self.login("Delete Host")
        guest_cookie, guest_proof, guest_csrf, guest = self.login("Delete Guest")
        host_auth = dict(cookie=host_cookie, proof=host_proof, csrf=host_csrf)
        guest_auth = dict(cookie=guest_cookie, proof=guest_proof, csrf=guest_csrf)

        status, _, created = self.create_table(host_cookie, host_proof, host_csrf, name="Delete archive")
        self.assertEqual(status, 201, created)
        table_id = created["table"]["id"]
        table_path = "/poker/api/tables/" + table_id
        status, _, seated = self.request(
            "POST", table_path + "/seat", {"seat_no": 1}, **guest_auth,
        )
        self.assertEqual(status, 200, seated)
        status, _, started = self.request("POST", table_path + "/start", {}, **host_auth)
        self.assertEqual(status, 200, started)
        status, _, prompt = self.request(
            "POST", table_path + "/end", {"confirm": True}, **host_auth,
        )
        self.assertEqual(status, 200, prompt)
        status, _, ended = self.request(
            "POST", table_path + "/end",
            {"confirmation_token": prompt["confirmation_token"]}, **host_auth,
        )
        self.assertEqual(status, 200, ended)

        conn = self.app.store.connect()
        try:
            conn.execute(
                "INSERT INTO chat_messages(table_id,player_id,name,text,created_at) VALUES(?,?,?,?,?)",
                (table_id, host["id"], host["name"], "isolated test chat", time.time()),
            )
            conn.execute(
                "INSERT INTO end_confirmations(token_hash,table_id,host_id,expires) VALUES(?,?,?,?)",
                ("unused-test-token", table_id, host["id"], time.time() + 60),
            )
            for table in (
                "tables", "chat_messages", "end_confirmations", "tournament_history",
                "hand_history", "hand_history_events", "hand_history_players",
                "tournament_participants",
            ):
                if table in ("hand_history_events", "hand_history_players"):
                    query = (
                        "SELECT COUNT(*) AS n FROM " + table +
                        " WHERE hand_id IN (SELECT hand_id FROM hand_history WHERE table_id=?)"
                    )
                else:
                    key = "id" if table == "tables" else "table_id"
                    query = "SELECT COUNT(*) AS n FROM " + table + " WHERE " + key + "=?"
                count = conn.execute(query, (table_id,)).fetchone()["n"]
                self.assertGreater(count, 0, table)
        finally:
            conn.close()

        path = "/poker/api/admin/history/" + table_id + "/delete"
        status, _, denied = self.request(
            "POST", path, {"confirm_delete": True}, **host_auth,
        )
        self.assertEqual(status, 403)
        self.assertEqual(denied["error"]["code"], "admin_required")
        status, _, missing = self.request("POST", path, {}, **admin_auth)
        self.assertEqual(status, 400)
        self.assertEqual(missing["error"]["code"], "confirmation_required")
        status, _, false_confirm = self.request(
            "POST", path, {"confirm_delete": 1}, **admin_auth,
        )
        self.assertEqual(status, 400)
        self.assertEqual(false_confirm["error"]["code"], "confirmation_required")
        status, _, deleted = self.request(
            "POST", path, {"confirm_delete": True}, **admin_auth,
        )
        self.assertEqual(status, 200, deleted)
        self.assertEqual(deleted, {
            "deleted": True, "id": table_id, "name": "Delete archive", "status": "ended",
        })

        conn = self.app.store.connect()
        try:
            for table in (
                "tables", "chat_messages", "end_confirmations", "tournament_history",
                "hand_history", "hand_history_events", "hand_history_players",
                "tournament_participants",
            ):
                if table in ("hand_history_events", "hand_history_players"):
                    query = (
                        "SELECT COUNT(*) AS n FROM " + table +
                        " WHERE hand_id IN (SELECT hand_id FROM hand_history WHERE table_id=?)"
                    )
                else:
                    key = "id" if table == "tables" else "table_id"
                    query = "SELECT COUNT(*) AS n FROM " + table + " WHERE " + key + "=?"
                count = conn.execute(query, (table_id,)).fetchone()["n"]
                self.assertEqual(count, 0, table)
            accounts = conn.execute(
                "SELECT COUNT(*) AS n FROM accounts WHERE player_id IN (?,?)",
                (host["id"], guest["id"]),
            ).fetchone()["n"]
            sessions = conn.execute(
                "SELECT COUNT(*) AS n FROM sessions WHERE player_id IN (?,?)",
                (host["id"], guest["id"]),
            ).fetchone()["n"]
            players = conn.execute(
                "SELECT COUNT(*) AS n FROM players WHERE id IN (?,?)",
                (host["id"], guest["id"]),
            ).fetchone()["n"]
            self.assertEqual(accounts, 2)
            self.assertGreaterEqual(sessions, 2)
            self.assertEqual(players, 2)
            self.assertEqual(conn.execute("PRAGMA foreign_key_check").fetchall(), [])
        finally:
            conn.close()

        status, _, host_history = self.request(
            "GET", "/poker/api/history", cookie=host_cookie, proof=host_proof,
        )
        self.assertEqual(status, 200)
        self.assertNotIn(table_id, {item["id"] for item in host_history["tournaments"]})
        status, _, admin_history = self.request(
            "GET", "/poker/api/admin/history", **admin_auth,
        )
        self.assertEqual(status, 200)
        self.assertNotIn(table_id, {item["id"] for item in admin_history["tournaments"]})
        status, _, live_tables = self.request(
            "GET", "/poker/api/tables", cookie=host_cookie, proof=host_proof,
        )
        self.assertEqual(status, 200)
        self.assertNotIn(table_id, {item["id"] for item in live_tables["tables"]})
        status, _, host_detail = self.request(
            "GET", "/poker/api/history/" + table_id,
            cookie=host_cookie, proof=host_proof,
        )
        self.assertEqual(status, 404)
        status, _, admin_detail = self.request(
            "GET", "/poker/api/admin/history/" + table_id, **admin_auth,
        )
        self.assertEqual(status, 404)
        self.assertEqual(admin_detail["error"]["code"], "history_not_found")
        status, _, repeat = self.request("POST", path, {"confirm_delete": True}, **admin_auth)
        self.assertEqual(status, 404)
        self.assertEqual(repeat["error"]["code"], "history_not_found")

    def test_admin_history_bulk_delete_is_atomic_admin_only_and_preserves_accounts_and_live_games(self):
        admin_cookie, admin_proof, admin_csrf, _ = self.enable_admin()
        admin_auth = dict(cookie=admin_cookie, proof=admin_proof, csrf=admin_csrf)
        host_cookie, host_proof, host_csrf, host = self.login("Bulk Delete Host")
        host_auth = dict(cookie=host_cookie, proof=host_proof, csrf=host_csrf)

        status, _, created = self.create_table(
            host_cookie, host_proof, host_csrf, name="Bulk cancelled game",
        )
        self.assertEqual(status, 201, created)
        cancelled_id = created["table"]["id"]
        cancelled_path = "/poker/api/tables/" + cancelled_id
        status, _, prompt = self.request(
            "POST", cancelled_path + "/end", {"confirm": True}, **host_auth,
        )
        self.assertEqual(status, 200, prompt)
        status, _, cancelled = self.request(
            "POST", cancelled_path + "/end",
            {"confirmation_token": prompt["confirmation_token"]}, **host_auth,
        )
        self.assertEqual(status, 200, cancelled)
        self.assertEqual(cancelled["table"]["status"], "cancelled")

        status, _, live = self.create_table(
            host_cookie, host_proof, host_csrf, name="Still live during bulk delete",
        )
        self.assertEqual(status, 201, live)
        live_id = live["table"]["id"]
        archive_id = server.uuid.uuid4().hex
        stale_id = server.uuid.uuid4().hex
        conn = self.app.store.connect()
        try:
            conn.execute(
                """INSERT INTO tournament_history
                   (table_id,owner_id,name,status,created,results_json,standings_json)
                   VALUES(?,?,?,?,?,'[]','[]')""",
                (archive_id, host["id"], "History-only archived game", "ended", time.time()),
            )
        finally:
            conn.close()

        path = "/poker/api/admin/history/delete"
        payload = {"ids": [cancelled_id, archive_id], "confirm_delete": True}
        status, _, denied = self.request("POST", path, payload)
        self.assertEqual(status, 401)
        status, _, denied = self.request("POST", path, payload, **host_auth)
        self.assertEqual(status, 403)
        self.assertEqual(denied["error"]["code"], "admin_required")
        status, _, no_confirmation = self.request(
            "POST", path, {"ids": [cancelled_id, archive_id]}, **admin_auth,
        )
        self.assertEqual(status, 400)
        self.assertEqual(no_confirmation["error"]["code"], "confirmation_required")
        status, _, duplicate = self.request(
            "POST", path,
            {"ids": [cancelled_id, cancelled_id], "confirm_delete": True}, **admin_auth,
        )
        self.assertEqual(status, 400)
        self.assertEqual(duplicate["error"]["code"], "invalid_history_ids")

        status, _, stale = self.request(
            "POST", path,
            {"ids": [cancelled_id, stale_id], "confirm_delete": True}, **admin_auth,
        )
        self.assertEqual(status, 404)
        status, _, still_cancelled = self.request(
            "GET", "/poker/api/admin/history/" + cancelled_id, **admin_auth,
        )
        self.assertEqual(status, 200, still_cancelled)

        status, _, active = self.request(
            "POST", path,
            {"ids": [archive_id, live_id], "confirm_delete": True}, **admin_auth,
        )
        self.assertEqual(status, 409)
        self.assertEqual(active["error"]["code"], "game_active")
        status, _, still_archived = self.request(
            "GET", "/poker/api/admin/history/" + archive_id, **admin_auth,
        )
        self.assertEqual(status, 200, still_archived)
        status, _, still_live = self.request(
            "GET", "/poker/api/tables/" + live_id, cookie=host_cookie, proof=host_proof,
        )
        self.assertEqual(status, 200, still_live)
        self.assertEqual(still_live["table"]["status"], "lobby")

        status, _, deleted = self.request("POST", path, payload, **admin_auth)
        self.assertEqual(status, 200, deleted)
        self.assertEqual(deleted, {
            "deleted": True,
            "deleted_count": 2,
            "ids": [cancelled_id, archive_id],
        })
        status, _, deleted_history = self.request(
            "GET", "/poker/api/admin/history/" + cancelled_id, **admin_auth,
        )
        self.assertEqual(status, 404)
        status, _, missing_archive = self.request(
            "GET", "/poker/api/admin/history/" + archive_id, **admin_auth,
        )
        self.assertEqual(status, 404)
        status, _, live_after = self.request(
            "GET", "/poker/api/tables/" + live_id, cookie=host_cookie, proof=host_proof,
        )
        self.assertEqual(status, 200, live_after)
        conn = self.app.store.connect()
        try:
            self.assertEqual(conn.execute(
                "SELECT COUNT(*) AS n FROM accounts WHERE player_id=?", (host["id"],),
            ).fetchone()["n"], 1)
            self.assertEqual(conn.execute(
                "SELECT COUNT(*) AS n FROM sessions WHERE player_id=?", (host["id"],),
            ).fetchone()["n"], 1)
            self.assertEqual(conn.execute(
                "SELECT COUNT(*) AS n FROM tables WHERE id=?", (live_id,),
            ).fetchone()["n"], 1)
        finally:
            conn.close()

    def test_last_hand_replay_is_authenticated_sanitized_and_selects_latest_completed(self):
        host_cookie, host_proof, host_csrf, host = self.login("Replay Host")
        guest_cookie, guest_proof, guest_csrf, guest = self.login("Replay Guest")
        folded_cookie, folded_proof, folded_csrf, folded = self.login("Folded Player")
        spectator_cookie, spectator_proof, spectator_csrf, spectator = self.login("Replay Spectator")

        # Authentication and empty history use the same table-read conventions.
        empty_status, _, empty_table = self.create_table(
            spectator_cookie, spectator_proof, spectator_csrf, name="Empty replay",
        )
        self.assertEqual(empty_status, 201, empty_table)
        empty_path = "/poker/api/tables/" + empty_table["table"]["id"] + "/last-hand"
        status, _, unauthenticated = self.request("GET", empty_path)
        self.assertEqual(status, 401)
        status, _, empty = self.request(
            "GET", empty_path, cookie=spectator_cookie, proof=spectator_proof,
        )
        self.assertEqual(status, 200, empty)
        self.assertEqual(empty, {"hand": None})

        status, _, created = self.create_table(
            host_cookie, host_proof, host_csrf, name="Replay privacy", max_seats=3,
        )
        self.assertEqual(status, 201, created)
        table_id = created["table"]["id"]
        table_path = "/poker/api/tables/" + table_id

        for session, seat_no in (
            ((guest_cookie, guest_proof, guest_csrf), 1),
            ((folded_cookie, folded_proof, folded_csrf), 2),
        ):
            status, _, seated = self.request(
                "POST", table_path + "/seat", {"seat_no": seat_no},
                cookie=session[0], proof=session[1], csrf=session[2],
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
        status, _, removed_route = self.request(
            "POST", table_path + "/preaction", {"selected": True},
            cookie=host_cookie, proof=host_proof, csrf=host_csrf,
        )
        self.assertEqual(status, 404)
        status, _, live_view = self.request(
            "GET", table_path, cookie=host_cookie, proof=host_proof,
        )
        self.assertEqual(status, 200, live_view)
        self.assertNotIn("check_fold_selected", live_view["table"]["viewer"])
        self.assertNotIn("check_fold_revision", live_view["table"]["viewer"])

        folded_cards = {}

        def complete_hand(state):
            hand = state["hand"]
            player_ids = list(hand["holes"])
            used = {card for cards in hand["holes"].values() for card in cards}
            hand["board"] = [
                card for card in server.engine._deck() if card not in used
            ][:5]
            hand["street"] = "river"
            hand["folded"] = [folded["id"]]
            hand["contrib"] = {
                host["id"]: 10, guest["id"]: 20, folded["id"]: 5,
            }
            hand["bets"] = {player_id: 0 for player_id in player_ids}
            hand["current_bet"] = 0
            for seat in state["seats"]:
                seat["stack"] = state["config"]["starting_stack"] - hand["contrib"][seat["player_id"]]
            folded_cards["cards"] = list(hand["holes"][folded["id"]])
            server.engine._settle_showdown(state, now=time.time())
            return state

        finished = self.app.store.mutate_table(table_id, complete_hand, time.time())
        self.assertEqual(finished["hand"]["street"], "showdown")
        self.assertEqual(finished["hand"]["folded"], [folded["id"]])
        self.assertEqual(finished["hand"]["returns"][0]["player_id"], guest["id"])
        live_status, _, live_result = self.request(
            "GET", table_path, cookie=host_cookie, proof=host_proof,
        )
        self.assertEqual(live_status, 200, live_result)
        live_hand = live_result["table"]
        self.assertEqual(live_hand["showdown"][0]["hand_name"],
                         live_hand["hand_ranks"][live_hand["showdown"][0]["player_id"]]["hand_name"])
        self.assertEqual(
            sum(item["amount"] for item in live_hand["winners"]),
            sum(live_hand["pot_winnings"].values()),
        )
        self.assertEqual(live_hand["returns"][0]["amount"], 10)
        completed_cards = {
            player_id: list(cards)
            for player_id, cards in finished["hand"]["holes"].items()
        }

        # A live hand can follow the completed hand without becoming the replay.
        next_hand_at = finished["hand"]["next_hand_at"]
        self.assertIsNotNone(next_hand_at)
        current = self.app.store.mutate_table(table_id, lambda state: state, next_hand_at)
        self.assertEqual(current["hand"]["number"], 2)
        self.assertNotEqual(current["hand"]["street"], "showdown")

        replay_path = table_path + "/last-hand"
        status, _, replay = self.request(
            "GET", replay_path, cookie=host_cookie, proof=host_proof,
        )
        self.assertEqual(status, 200, replay)
        hand = replay["hand"]
        self.assertEqual((hand["id"], hand["number"]), (table_id + ":1", 1))
        self.assertEqual(
            [item["name"] for item in hand["streets"]],
            ["preflop", "flop", "turn", "river", "showdown"],
        )
        self.assertEqual(hand["board"], finished["hand"]["board"])
        players = {item["player_id"]: item for item in hand["players"]}
        self.assertEqual(players[host["id"]]["cards"], completed_cards[host["id"]])
        self.assertEqual(players[host["id"]]["cards_source"], "own")
        self.assertEqual(players[guest["id"]]["cards"], completed_cards[guest["id"]])
        self.assertEqual(players[guest["id"]]["cards_source"], "revealed")
        self.assertEqual(players[folded["id"]]["cards"], [])
        self.assertEqual({item["player_id"] for item in hand["showdown"]},
                         {host["id"], guest["id"]})
        self.assertEqual(set(hand["hand_ranks"]), {host["id"], guest["id"]})
        self.assertNotIn(folded["id"], hand["hand_ranks"])
        replay_winners = {item["player_id"]: item for item in hand["winners"]}
        self.assertEqual(
            {player_id: item["amount"] for player_id, item in replay_winners.items()},
            {player_id: amount for player_id, amount in hand["pot_winnings"].items() if amount > 0},
        )
        self.assertEqual(hand["returns"], [{"player_id": guest["id"], "amount": 10}])
        self.assertNotIn("events", hand)
        self.assertTrue(
            set(folded_cards["cards"]).isdisjoint(
                set(hand["board"]) |
                {card for player in hand["players"] for card in player["cards"]}
            )
        )

        # Spectators receive public reveals but never anyone else's hidden cards.
        status, _, spectator_replay = self.request(
            "GET", replay_path, cookie=spectator_cookie, proof=spectator_proof,
        )
        self.assertEqual(status, 200, spectator_replay)
        spectator_players = {
            item["player_id"]: item for item in spectator_replay["hand"]["players"]
        }
        self.assertEqual(spectator_players[host["id"]]["cards"], completed_cards[host["id"]])
        self.assertEqual(spectator_players[guest["id"]]["cards"], completed_cards[guest["id"]])
        self.assertEqual(spectator_players[folded["id"]]["cards"], [])
        self.assertTrue(all(
            item.get("cards_source") == "revealed"
            for player_id, item in spectator_players.items()
            if player_id in (host["id"], guest["id"])
        ))
        self.assertNotIn(
            "[" + " ".join(folded_cards["cards"]) + "]",
            spectator_replay["hand"]["history_text"],
        )

        def complete_second_hand(state):
            hand = state["hand"]
            used = {card for cards in hand["holes"].values() for card in cards}
            hand["board"] = [card for card in server.engine._deck() if card not in used][:5]
            hand["street"] = "river"
            hand["folded"] = []
            hand["contrib"] = {player_id: amount for player_id, amount in zip(hand["holes"], (10, 20, 5))}
            hand["bets"] = {player_id: 0 for player_id in hand["holes"]}
            for seat in state["seats"]:
                seat["stack"] = max(0, seat["stack"] - hand["contrib"].get(seat["player_id"], 0))
            server.engine._settle_showdown(state, now=time.time())
            return state

        self.app.store.mutate_table(table_id, complete_second_hand, time.time())
        status, _, latest_replay = self.request(
            "GET", replay_path, cookie=host_cookie, proof=host_proof,
        )
        self.assertEqual(status, 200, latest_replay)
        self.assertEqual(latest_replay["hand"]["number"], 2)
        self.assertEqual(latest_replay["hand"]["history_count"], 2)
        self.assertEqual(latest_replay["hand"]["previous_hand_number"], 1)
        self.assertIsNone(latest_replay["hand"]["next_hand_number"])
        status, _, older_replay = self.request(
            "GET", replay_path + "?number=1", cookie=host_cookie, proof=host_proof,
        )
        self.assertEqual(status, 200, older_replay)
        self.assertEqual(older_replay["hand"]["number"], 1)
        self.assertIsNone(older_replay["hand"]["previous_hand_number"])
        self.assertEqual(older_replay["hand"]["next_hand_number"], 2)
        self.assertIn("Felt Night Hand #1", older_replay["hand"]["history_text"])
        status, _, invalid_number = self.request(
            "GET", replay_path + "?number=0", cookie=host_cookie, proof=host_proof,
        )
        self.assertEqual(status, 400)
        self.assertEqual(invalid_number["error"]["code"], "invalid_url")

        unknown_id = server.uuid.uuid4().hex
        status, _, unknown = self.request(
            "GET", "/poker/api/tables/" + unknown_id + "/last-hand",
            cookie=host_cookie, proof=host_proof,
        )
        self.assertEqual(status, 404)
        self.assertEqual(unknown["error"]["code"], "table_not_found")

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
        admin_cookie, admin_proof, admin_csrf, _ = self.enable_admin()
        host_cookie, host_proof, host_csrf, host = self.login("Ticker host")
        status, _, created = self.create_table(
            host_cookie, host_proof, host_csrf, name="Ticker table", max_seats=2,
        )
        self.assertEqual(status, 201, created)
        table_id = created["table"]["id"]
        path = "/poker/api/tables/" + table_id
        status, _, with_bot = self.request(
            "POST", path + "/bots", {"seat_no": 1},
            cookie=admin_cookie, proof=admin_proof, csrf=admin_csrf,
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

