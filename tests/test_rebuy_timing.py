import json
import unittest
from unittest.mock import patch

import engine


class RebuyTimingTests(unittest.TestCase):
    def busted_table(self, busted=("p3",), showdown_seconds=5, players=4):
        state = engine.create_lobby("rebuy-timing", "p1", "Ada", {
            "max_seats": players, "starting_stack": 1000, "small_blind": 5, "big_blind": 10,
            "level_minutes": 1, "showdown_seconds": showdown_seconds,
            "elimination_announcement_seconds": 0, "blind_announcement_seconds": 0,
        }, now=100)
        for pid, name in (("p2", "Bea"), ("p3", "Cy"), ("p4", "Dee")):
            engine.join(state, pid, name, now=101)
        if players == 5:
            engine.join(state, "p5", "Eli", now=101)
        engine.start(state, "p1", now=102)
        hand = state["hand"]
        hand["board"] = ["As", "Kh", "9c", "7s", "3d"]
        hand["showdown"] = [
            {"player_id": seat["player_id"], "name": seat["name"],
             "cards": hand["holes"][seat["player_id"]], "rank": "Pair of aces"}
            for seat in state["seats"]
        ]
        for seat in state["seats"]:
            seat["stack"] = 0 if seat["player_id"] in busted else 1000
        engine._finish_hand(state, {}, now=110)
        return state

    def view(self, state, pid, now):
        with patch("engine.time.time", return_value=now):
            return engine.public_view(state, pid)

    def test_showdown_then_full_offer_and_frozen_clock_for_every_viewer(self):
        state = self.busted_table()
        offer = state["rebuy_offers"]["p3"]
        self.assertEqual((offer["offered_at"], offer["expires_at"]), (115, 175))
        for pid in ("p1", "p3", None):
            before = self.view(state, pid, 114.99)
            self.assertIsNone(before["viewer"]["rebuy_offer"])
            self.assertEqual(before["rebuy_waiting"], [])
            self.assertTrue(before["blinds"]["paused"])
            self.assertEqual(before["blinds"]["seconds_to_next"], 52)
            self.assertEqual(len(before["showdown"]), 4)
        for action in (engine.accept_rebuy, engine.decline_rebuy):
            with self.assertRaises(engine.GameError) as error:
                action(state, "p3", offer["id"], now=114.99)
            self.assertEqual(error.exception.code, "rebuy_not_ready")
        ready = self.view(state, "p3", 115)
        self.assertEqual(ready["viewer"]["rebuy_offer"]["expires_at"] - ready["server_now"], 60)
        other = self.view(state, "p1", 130)
        self.assertIsNone(other["viewer"]["rebuy_offer"])
        self.assertEqual(other["rebuy_waiting"], [{"player_id": "p3", "name": "Cy"}])
        self.assertNotIn(offer["id"], json.dumps(other))
        engine.advance(state, now=150)
        self.assertEqual(state["hand_no"], 1)
        self.assertEqual(state["blinds"]["level"], 1)
        engine.accept_rebuy(state, "p3", offer["id"], now=150)
        self.assertNotIn("rebuy_hold_started_at", state)
        self.assertEqual(state["blinds"]["next_level_at"], 202)
        self.assertEqual(self.view(state, "p1", 150)["blinds"]["seconds_to_next"], 52)
        engine.advance(state, now=150)
        self.assertEqual(state["hand_no"], 2)
        self.assertIn("p3", state["hand"]["holes"])
        self.assertFalse(self.view(state, "p1", 151)["blinds"]["paused"])
        self.assertEqual(self.view(state, "p1", 151)["blinds"]["seconds_to_next"], 51)

    def test_multiple_busts_wait_for_last_decision_and_survive_reload(self):
        state = json.loads(json.dumps(self.busted_table(("p3", "p4"), players=5)))
        engine.accept_rebuy(state, "p3", state["rebuy_offers"]["p3"]["id"], now=120)
        engine.advance(state, now=130)
        self.assertEqual(state["hand_no"], 1)
        self.assertEqual(self.view(state, "p1", 130)["rebuy_waiting"], [{"player_id": "p4", "name": "Dee"}])
        self.assertTrue(self.view(state, "p1", 130)["blinds"]["paused"])
        engine.decline_rebuy(state, "p4", state["rebuy_offers"]["p4"]["id"], now=140)
        engine.advance(state, now=140)
        self.assertEqual(state["hand_no"], 2)
        self.assertEqual(state["blinds"]["next_level_at"], 192)
        self.assertEqual(self.view(state, "p1", 140)["rebuy_waiting"], [])

    def test_timeout_resumes_table_and_only_then_applies_overdue_blinds(self):
        state = self.busted_table()
        state["blinds"]["next_level_at"] = 109
        engine.advance(state, now=174.99)
        self.assertEqual((state["hand_no"], state["blinds"]["level"]), (1, 1))
        engine.advance(state, now=175)
        self.assertEqual(state["rebuy_offers"], {})
        self.assertEqual(state["blinds"]["level"], 2)
        self.assertNotIn("rebuy_hold_started_at", state)
        engine.advance(state, now=180)
        self.assertEqual(state["hand_no"], 2)

    def test_host_pause_does_not_double_count_blind_hold_or_consume_offer(self):
        for accept_while_paused in (False, True):
            with self.subTest(accept_while_paused=accept_while_paused):
                state = self.busted_table()
                offer = state["rebuy_offers"]["p3"]
                engine.pause_table(state, "p1", True, now=120)
                paused = self.view(state, "p3", 160)
                self.assertEqual(paused["blinds"]["seconds_to_next"], 52)
                self.assertEqual(paused["viewer"]["rebuy_offer"]["expires_at"], 215)
                if accept_while_paused:
                    engine.accept_rebuy(state, "p3", offer["id"], now=160)
                engine.pause_table(state, "p1", False, now=160)
                if not accept_while_paused:
                    engine.accept_rebuy(state, "p3", offer["id"], now=160)
                self.assertEqual(state["blinds"]["next_level_at"], 212)
                self.assertEqual(self.view(state, "p1", 160)["blinds"]["seconds_to_next"], 52)
                engine.advance(state, now=160)
                self.assertEqual(state["hand_no"], 2)

    def test_paused_level_duration_edit_restarts_clock_without_counting_the_rebuy_wait(self):
        state = self.busted_table()
        engine.pause_table(state, "p1", True, now=112)
        engine.update_runtime_settings(state, "p1", {"level_minutes": 2}, now=112)
        self.assertEqual(self.view(state, "p1", 130)["blinds"]["seconds_to_next"], 120)
        engine.pause_table(state, "p1", False, now=132)
        engine.accept_rebuy(state, "p3", state["rebuy_offers"]["p3"]["id"], now=140)
        self.assertEqual(self.view(state, "p1", 140)["blinds"]["seconds_to_next"], 120)

    def test_pause_during_showdown_keeps_offer_after_the_hold(self):
        state = self.busted_table()
        engine.pause_table(state, "p1", True, now=112)
        self.assertIsNone(self.view(state, "p3", 150)["viewer"]["rebuy_offer"])
        engine.pause_table(state, "p1", False, now=152)
        self.assertIsNone(self.view(state, "p3", 154.99)["viewer"]["rebuy_offer"])
        self.assertIsNotNone(self.view(state, "p3", 155)["viewer"]["rebuy_offer"])

    def test_bot_elimination_at_heads_up_does_not_add_rebuy_hold(self):
        state = self.busted_table()
        # At heads-up no player, including a bot, gets a rebuy offer.
        engine.decline_rebuy(state, "p3", state["rebuy_offers"]["p3"]["id"], now=115)
        engine._seat_by_id(state, "p4")["is_bot"] = True
        engine._seat_by_id(state, "p4")["stack"] = 0
        engine._create_rebuy_offers(state, [{"player_id": "p4"}], state["hand"], 120)
        self.assertEqual(state["rebuy_offers"], {})
        self.assertNotIn("rebuy_hold_started_at", state)
