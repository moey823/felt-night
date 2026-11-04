import http.client
import json
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

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

    def test_host_can_create_and_edit_arbitrary_tournament_timers(self):
        cookie, proof, csrf, _ = self.login("Host")
        auth = dict(cookie=cookie, proof=proof, csrf=csrf)
        cfg = dict(name="Custom pace", max_seats=2, starting_stack=1000,
                   small_blind=10, big_blind=20, level_minutes=97,
                   turn_seconds=19, runout_seconds=1.5)
        status, _, created = self.request("POST", "/poker/api/tables", cfg, **auth)
        self.assertEqual(status, 201, created)
        table = created["table"]
        for field in ("level_minutes", "turn_seconds", "runout_seconds"):
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
        updated = dict(level_minutes=72.5, turn_seconds=7, runout_seconds=3.25)
        status, _, result = self.request("POST", path + "/settings", updated, **auth)
        self.assertEqual(status, 200, result)
        for field, value in updated.items():
            self.assertEqual(result["table"]["config"][field], value)
        for field in updated:
            status, _, _ = self.request("POST", path + "/settings", {field: 0}, **auth)
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
        self.app = server.App(args)
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

