import http.client
import json
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import engine
import server


TEST_ROOM_PASSWORD = "test-room-invite"


def config(**overrides):
    value = {
        "max_seats": 4,
        "starting_stack": 1000,
        "small_blind": 5,
        "big_blind": 10,
        "level_minutes": 5,
        "turn_seconds": 30,
    }
    value.update(overrides)
    return value


def start_table(player_ids=("p1", "p2")):
    state = engine.create_lobby(
        "preaction-table", player_ids[0], "Robin", config(), now=100,
    )
    for index, player_id in enumerate(player_ids[1:], 2):
        engine.join(state, player_id, "Player%d" % index, now=100 + index)
    with patch.object(
        engine.random.SystemRandom,
        "choice",
        side_effect=lambda seats: next(
            item for item in seats if item["player_id"] == player_ids[0]
        ),
    ):
        engine.start(state, player_ids[0], now=110)
    return state


def actions(state):
    return [
        event for event in state["hand"]["events"]
        if event.get("type") == "action"
    ]


class PreactionEngineTests(unittest.TestCase):
    def test_private_selection_checks_when_free_and_clears_on_street_change(self):
        state = start_table()
        hand = state["hand"]
        actor = hand["to_act"]
        waiting = next(player_id for player_id in hand["holes"] if player_id != actor)
        original_version = state["version"]
        actor_revision = engine.public_view(state, actor)["viewer"]["check_fold_revision"]
        waiting_revision = engine.public_view(state, waiting)["viewer"]["check_fold_revision"]
        expected_hand = state["hand_no"]
        expected_turn = state["turn_version"]

        engine.set_preaction(
            state, waiting, True, expected_hand, expected_turn,
        )

        self.assertEqual(state["version"], original_version)
        self.assertEqual(
            engine.public_view(state, waiting)["viewer"]["check_fold_revision"],
            waiting_revision + 1,
        )
        self.assertEqual(
            engine.public_view(state, actor)["viewer"]["check_fold_revision"],
            actor_revision,
        )
        self.assertTrue(engine.public_view(state, waiting)["viewer"]["check_fold_selected"])
        self.assertFalse(engine.public_view(state, actor)["viewer"]["check_fold_selected"])
        self.assertNotIn("preactions", engine.public_view(state, waiting))
        self.assertEqual(len(actions(state)), 2)  # blinds only

        engine.apply_action(
            state, actor, "call", None, expected_hand, expected_turn, now=111,
        )

        waiting_checks = [
            event for event in actions(state)
            if event.get("actor_id") == waiting and event.get("action") == "check"
        ]
        self.assertEqual(len(waiting_checks), 1)
        self.assertEqual(state["hand"]["street"], "flop")
        self.assertEqual(state["hand"]["preactions"], {})
        self.assertFalse(engine.public_view(state, waiting)["viewer"]["check_fold_selected"])
        self.assertEqual(
            engine.public_view(state, waiting)["viewer"]["check_fold_revision"],
            waiting_revision + 2,
        )

    def test_chained_preactions_fold_the_small_blind_then_check_the_big_blind_once(self):
        state = start_table(("p1", "p2", "p3"))
        hand = state["hand"]
        actor = hand["to_act"]
        self.assertEqual(actor, hand["button_id"])
        small_id = hand["small_blind_id"]
        big_id = hand["big_blind_id"]

        for player_id in (small_id, big_id):
            engine.set_preaction(
                state, player_id, True, state["hand_no"], state["turn_version"],
            )

        engine.apply_action(
            state, actor, "call", None, state["hand_no"], state["turn_version"], now=111,
        )

        rows = actions(state)
        small_folds = [
            event for event in rows
            if event.get("actor_id") == small_id and event.get("action") == "fold"
        ]
        big_checks = [
            event for event in rows
            if event.get("actor_id") == big_id and event.get("action") == "check"
        ]
        self.assertEqual(len(small_folds), 1)
        self.assertEqual(len(big_checks), 1)
        self.assertEqual(state["hand"]["street"], "flop")
        self.assertEqual(state["hand"]["preactions"], {})
        self.assertEqual(
            engine.public_view(state, small_id)["viewer"]["check_fold_revision"],
            2,
        )
        self.assertEqual(
            engine.public_view(state, big_id)["viewer"]["check_fold_revision"],
            2,
        )

    def test_selected_player_folds_if_a_bet_is_open_when_their_turn_arrives(self):
        state = start_table()
        hand = state["hand"]
        actor = hand["to_act"]
        waiting = next(player_id for player_id in hand["holes"] if player_id != actor)
        expected_hand = state["hand_no"]
        expected_turn = state["turn_version"]
        engine.set_preaction(state, waiting, True, expected_hand, expected_turn)

        engine.apply_action(
            state, actor, "raise", 40, expected_hand, expected_turn, now=111,
        )

        folds = [
            event for event in actions(state)
            if event.get("actor_id") == waiting and event.get("action") == "fold"
        ]
        self.assertEqual(len(folds), 1)
        self.assertEqual(state["hand"]["street"], "showdown")
        self.assertEqual(state["hand"]["preactions"], {})

    def test_opponents_can_act_while_selection_and_cancellation_are_in_flight(self):
        state = start_table(("p1", "p2", "p3", "p4"))
        hand = state["hand"]
        waiting = hand["big_blind_id"]
        observed = state["turn_version"]
        number = state["hand_no"]
        engine.apply_action(state, hand["to_act"], "call", None, number, observed, now=111)
        engine.set_preaction(state, waiting, True, number, observed, expected_revision=0)
        engine.apply_action(state, hand["to_act"], "call", None, number, state["turn_version"], now=112)
        engine.set_preaction(state, waiting, False, number, observed, expected_revision=1)
        with self.assertRaises(engine.GameError):
            engine.set_preaction(state, waiting, True, number, observed, expected_revision=0)
        engine.apply_action(state, hand["to_act"], "call", None, number, state["turn_version"], now=113)
        self.assertEqual(hand["to_act"], waiting)
        self.assertNotIn(waiting, hand["preactions"])

    def test_unused_selection_follows_the_next_decision_across_a_street(self):
        state = start_table()
        hand = state["hand"]
        small, big = hand["small_blind_id"], hand["big_blind_id"]
        number = state["hand_no"]
        engine.apply_action(state, small, "call", None, number, state["turn_version"], now=111)
        observed = state["turn_version"]
        engine.set_preaction(state, small, True, number, observed, expected_revision=0)
        engine.apply_action(state, big, "check", None, number, observed, now=112)
        self.assertTrue(engine.public_view(state, small)["viewer"]["check_fold_selected"])
        engine.apply_action(state, big, "bet", 20, number, state["turn_version"], now=113)
        self.assertEqual(actions(state)[-1]["action"], "fold")
        self.assertEqual(actions(state)[-1]["actor_id"], small)

    def test_late_request_after_manual_action_cannot_fold_a_later_turn(self):
        state = start_table(("p1", "p2", "p3"))
        hand = state["hand"]
        number, observed = state["hand_no"], state["turn_version"]
        small = hand["small_blind_id"]
        for _ in range(2):
            engine.apply_action(state, hand["to_act"], "call", None, number, state["turn_version"], now=111)
        with self.assertRaises(engine.GameError) as error:
            engine.set_preaction(state, small, True, number, observed, expected_revision=0)
        self.assertEqual(error.exception.code, "stale_turn")
        self.assertNotIn(small, hand["preactions"])

    def test_toggle_can_be_cleared_and_rejects_current_actor_and_stale_turn(self):
        state = start_table()
        hand = state["hand"]
        actor = hand["to_act"]
        waiting = next(player_id for player_id in hand["holes"] if player_id != actor)
        hand_no = state["hand_no"]
        turn_version = state["turn_version"]

        with self.assertRaises(engine.GameError) as caught:
            engine.set_preaction(state, actor, True, hand_no, turn_version)
        self.assertEqual(caught.exception.code, "preaction_unavailable")

        engine.set_preaction(state, waiting, True, hand_no, turn_version)
        self.assertTrue(engine.public_view(state, waiting)["viewer"]["check_fold_selected"])
        engine.set_preaction(state, waiting, False, hand_no, turn_version)
        self.assertFalse(engine.public_view(state, waiting)["viewer"]["check_fold_selected"])
        self.assertEqual(
            engine.public_view(state, waiting)["viewer"]["check_fold_revision"],
            2,
        )

        engine.apply_action(state, actor, "call", None, hand_no, turn_version, now=111)
        with self.assertRaises(engine.GameError) as caught:
            engine.set_preaction(state, waiting, True, hand_no, turn_version)
        self.assertEqual(caught.exception.code, "stale_turn")


class PreactionRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sitngo-preaction-")
        data_dir = Path(self.temp.name) / "data"
        args = types.SimpleNamespace(
            public_origin="http://localhost:1",
            data_dir=str(data_dir),
        )
        self.app = server.App(args, room_password=TEST_ROOM_PASSWORD)
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

    def request(self, method, path, payload=None, session=None):
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        headers = {
            "Host": self.app.public_netloc,
            "Origin": self.origin,
        }
        if body is not None:
            headers["Content-Type"] = "application/json"
            headers["Content-Length"] = str(len(body))
        if session:
            headers["Cookie"] = session["cookie"]
            headers["X-SitNgo-Session"] = session["proof"]
            headers["X-SitNgo-CSRF"] = session["csrf"]
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        raw = response.read()
        connection.close()
        parsed = json.loads(raw.decode("utf-8")) if raw else None
        return response.status, parsed

    def register(self, username):
        payload = {
            "username": username,
            "password": "test-account-password",
            "room_password": TEST_ROOM_PASSWORD,
        }
        body = json.dumps(payload).encode("utf-8")
        headers = {
            "Host": self.app.public_netloc,
            "Origin": self.origin,
            "Content-Type": "application/json",
            "Content-Length": str(len(body)),
        }
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request("POST", "/poker/api/register", body=body, headers=headers)
        response = connection.getresponse()
        raw = response.read()
        cookie_header = response.getheader("Set-Cookie", "")
        connection.close()
        data = json.loads(raw.decode("utf-8")) if raw else None
        self.assertEqual(response.status, 201, data)
        return {
            "cookie": cookie_header.split(";", 1)[0],
            "proof": data["session_proof"],
            "csrf": data["csrf"],
            "player": data["player"],
        }

    def test_authenticated_preaction_endpoint_is_private_and_rejects_stale_token(self):
        host = self.register("Robin")
        guest = self.register("Morgan")

        status, created = self.request(
            "POST",
            "/poker/api/tables",
            {
                "name": "Preaction test",
                "max_seats": 2,
                "starting_stack": 1000,
                "small_blind": 5,
                "big_blind": 10,
                "level_minutes": 5,
                "turn_seconds": 30,
            },
            host,
        )
        self.assertEqual(status, 201, created)
        table_id = created["table"]["id"]

        status, joined = self.request(
            "POST",
            "/poker/api/tables/" + table_id + "/join",
            {},
            guest,
        )
        self.assertEqual(status, 200, joined)

        with patch.object(
            server.engine.random.SystemRandom,
            "choice",
            side_effect=lambda seats: next(
                item for item in seats
                if item["player_id"] == host["player"]["id"]
            ),
        ):
            status, started = self.request(
                "POST",
                "/poker/api/tables/" + table_id + "/start",
                {},
                host,
            )
        self.assertEqual(status, 200, started)
        current = started["table"]
        expected_hand = current["hand_no"]
        expected_turn = current["turn_version"]
        self.assertEqual(current["actor_id"], host["player"]["id"])

        status, armed = self.request(
            "POST",
            "/poker/api/tables/" + table_id + "/preaction",
            {
                "selected": True,
                "expected_hand": expected_hand,
                "expected_turn_version": expected_turn,
            },
            guest,
        )
        self.assertEqual(status, 200, armed)
        self.assertTrue(armed["table"]["viewer"]["check_fold_selected"])
        self.assertEqual(armed["table"]["viewer"]["check_fold_revision"], 1)
        self.assertEqual(armed["table"]["version"], current["version"])

        status, acted = self.request(
            "POST",
            "/poker/api/tables/" + table_id + "/action",
            {
                "action": "call",
                "expected_hand": expected_hand,
                "expected_turn_version": expected_turn,
            },
            host,
        )
        self.assertEqual(status, 200, acted)
        status, guest_view = self.request(
            "GET", "/poker/api/tables/" + table_id, session=guest,
        )
        self.assertEqual(status, 200, guest_view)
        table = guest_view["table"]
        self.assertEqual(table["street"], "flop")
        self.assertFalse(table["viewer"]["check_fold_selected"])
        self.assertEqual(table["viewer"]["check_fold_revision"], 2)
        guest_checks = [
            event for event in table["events"]
            if event.get("type") == "action"
            and event.get("actor_id") == guest["player"]["id"]
            and event.get("action") == "check"
        ]
        self.assertEqual(len(guest_checks), 1)

        status, stale = self.request(
            "POST",
            "/poker/api/tables/" + table_id + "/preaction",
            {
                "selected": False,
                "expected_hand": expected_hand,
                "expected_turn_version": expected_turn,
            },
            guest,
        )
        self.assertEqual(status, 409, stale)
        self.assertEqual(stale["error"]["code"], "stale_turn")
