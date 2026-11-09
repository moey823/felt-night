"""Password-authenticated roles on both origins, bootstrap and concurrency protection."""
import concurrent.futures
import http.client
import json
import sqlite3
from pathlib import Path
import tempfile
import threading
import time
import types
import unittest

import server


class AccountAdminRoleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="felt-admin-roles-")
        self.addCleanup(self.temp.cleanup)
        self.app = server.App(types.SimpleNamespace(public_origin="http://localhost:1", data_dir=self.temp.name),
                              room_password="test-room-invite")
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

    def request(self, listener, method, path, payload=None, auth=None, extra=None):
        headers = {"Host": listener.app.public_netloc, "Origin": listener.app.public_origin}
        if auth:
            headers.update({"Cookie": auth[0], "X-SitNgo-Session": auth[1], "X-SitNgo-CSRF": auth[2]})
        headers.update(extra or {})
        if payload is not None:
            headers["Content-Type"] = "application/json"
        conn = http.client.HTTPConnection("127.0.0.1", listener.server_port, timeout=3)
        try:
            conn.request(method, path, None if payload is None else json.dumps(payload), headers)
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), json.loads(response.read())
        finally:
            conn.close()

    def register(self, username):
        code, headers, data = self.request(self.public, "POST", "/poker/api/register", {
            "username": username, "password": "test-account-password", "room_password": "test-room-invite"})
        self.assertEqual(code, 201, data)
        return data["player"], (headers["Set-Cookie"].split(";", 1)[0], data["session_proof"], data["csrf"])

    def role(self, auth, target, value):
        return self.request(self.public, "POST", "/poker/api/admin/accounts/"+target["id"]+"/role", {"is_admin": value}, auth)

    def test_first_account_is_admin_and_later_accounts_are_players(self):
        first, first_auth = self.register("first")
        second, second_auth = self.register("second")
        self.assertTrue(first["is_admin"])
        self.assertFalse(second["is_admin"])
        self.assertEqual(self.request(self.public, "GET", "/poker/api/admin/config", auth=first_auth)[0], 200)
        self.assertEqual(self.request(self.public, "GET", "/poker/api/admin/config", auth=second_auth)[0], 403)
        code, _, roster = self.request(self.public, "GET", "/poker/api/admin/accounts", auth=first_auth)
        self.assertEqual(code, 200)
        self.assertEqual(roster["admin_count"], 1)
        for row in roster["accounts"]:
            self.assertEqual(set(row), {"username", "display_name", "player_id", "is_admin"})
        self.assertEqual(self.request(self.public, "GET", "/poker/api/admin/accounts", auth=second_auth)[0], 403)

    def test_grant_demote_self_and_live_session_revocation(self):
        first, first_auth = self.register("first")
        second, second_auth = self.register("second")
        self.assertEqual(self.role(second_auth, second, True)[0], 403)
        self.assertEqual(self.role(first_auth, second, "true")[0], 400)
        self.assertEqual(self.role(first_auth, second, True)[0], 200)
        self.assertEqual(self.request(self.public, "GET", "/poker/api/admin/config", auth=second_auth)[0], 200)
        self.assertEqual(self.role(first_auth, first, False)[0], 200)
        self.assertEqual(self.request(self.public, "GET", "/poker/api/admin/config", auth=first_auth)[0], 403)
        self.assertEqual(self.role(first_auth, second, False)[0], 403)
        code, _, result = self.role(second_auth, second, False)
        self.assertEqual(code, 409)
        self.assertEqual(result["error"]["code"], "last_admin")
        # A demoted admin is still signed in as a normal player.
        self.assertTrue(self.request(self.public, "GET", "/poker/api/me", auth=first_auth)[2]["authenticated"])
        self.assertFalse(self.request(self.public, "GET", "/poker/api/me", auth=first_auth)[2]["player"]["is_admin"])

    def test_last_admin_cannot_be_removed_and_role_writes_require_csrf(self):
        first, auth = self.register("first")
        self.assertEqual(self.role(auth, first, False)[0], 409)
        self.assertEqual(self.role((auth[0], auth[1], "bad"), first, False)[0], 403)
        self.assertEqual(self.role((auth[0], "bad", auth[2]), first, False)[0], 401)
        self.assertEqual(self.request(self.public, "POST", "/poker/api/admin/accounts/"+first["id"]+"/role",
            {"is_admin": False}, auth, {"Origin": "https://other.example"})[0], 403)

    def test_both_origins_require_password_and_synthetic_identity_is_retired(self):
        first, _ = self.register("admin")
        for listener in (self.public, self.private):
            for password in ("", "wrong"):
                self.assertEqual(self.request(listener, "POST", "/poker/api/login", {"username": "admin", "password": password})[0], 401)
            code, headers, data = self.request(listener, "POST", "/poker/api/login", {"username": "admin", "password": "test-account-password"})
            self.assertEqual(code, 200, data)
            self.assertEqual(data["player"]["id"], first["id"])
            auth = (headers["Set-Cookie"].split(";", 1)[0], data["session_proof"], data["csrf"])
            self.assertEqual(self.request(listener, "GET", "/poker/api/admin/config", auth=auth)[0], 200)
        with self.assertRaises(RuntimeError):
            self.app.private_admin_app(self.app.public_origin)
        conn = self.app.store.connect()
        try:
            conn.execute("INSERT INTO players(id,name,created) VALUES('admin:old','Old admin',?)", (time.time(),))
            token = self.app.store._issue_session(conn, "admin:old", time.time())
        finally:
            conn.close()
        restarted = server.Store(self.temp.name, "test-room-invite")
        self.assertIsNone(restarted.authenticate(token))
        self.assertTrue(restarted.login_account("admin", "test-account-password", time.time())[0]["is_admin"])

    def test_concurrent_first_registrations_create_exactly_one_admin(self):
        barrier = threading.Barrier(2)
        def create(index):
            barrier.wait()
            return self.app.store.create_account("user%d" % index, "User %d" % index,
                                                  "test-password", time.time())[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            players = list(pool.map(create, (1, 2)))
        self.assertEqual(sum(row["is_admin"] for row in players), 1)

    def test_concurrent_self_demotions_leave_one_admin(self):
        first, _ = self.register("first")
        second, _ = self.register("second")
        self.app.store.set_account_admin(first["id"], second["id"], True)
        barrier = threading.Barrier(2)
        def demote(player):
            barrier.wait()
            try:
                self.app.store.set_account_admin(player["id"], player["id"], False)
                return "removed"
            except server.AppError as error:
                return error.code
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(demote, (first, second)))
        self.assertEqual(sorted(results), ["last_admin", "removed"])
        self.assertEqual(self.app.store.list_account_roles()["admin_count"], 1)

    def test_existing_accounts_are_not_promoted_by_a_new_registration(self):
        first, _ = self.register("first")
        conn = self.app.store.connect()
        try:
            conn.execute("UPDATE accounts SET is_admin=0")
        finally:
            conn.close()
        # This models an existing deployment requiring its explicit owner datafix.
        later, _ = self.register("later")
        self.assertFalse(later["is_admin"])
        self.assertEqual(self.app.store.list_account_roles()["admin_count"], 0)

    def test_legacy_schema_upgrade_preserves_identity_and_password_without_auto_promotion(self):
        with tempfile.TemporaryDirectory(prefix="felt-old-accounts-") as directory:
            conn = sqlite3.connect(str(Path(directory) / "sitngo.sqlite3"))
            salt = bytes(16)
            verifier = server.Store._password_verifier("existing-password", salt)
            player_id = "a" * 32
            try:
                conn.executescript("""
                    CREATE TABLE players(id TEXT PRIMARY KEY,name TEXT NOT NULL,created REAL NOT NULL);
                    CREATE TABLE accounts(username TEXT PRIMARY KEY,display_name TEXT NOT NULL,
                        player_id TEXT NOT NULL UNIQUE REFERENCES players(id),password_salt TEXT NOT NULL,
                        password_verifier TEXT NOT NULL,created REAL NOT NULL);
                """)
                conn.execute("INSERT INTO players VALUES(?,?,?)", (player_id, "Existing owner", 1))
                conn.execute("INSERT INTO accounts VALUES(?,?,?,?,?,?)",
                             ("existing", "Existing owner", player_id, salt.hex(), verifier, 1))
                conn.commit()
            finally:
                conn.close()
            store = server.Store(directory, "test-room-invite")
            player, _ = store.login_account("existing", "existing-password", time.time())
            self.assertEqual(player["id"], player_id)
            self.assertFalse(player["is_admin"])
            self.assertEqual(store.list_account_roles()["admin_count"], 0)
