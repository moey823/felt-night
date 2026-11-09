import json
import unittest
from unittest.mock import patch

import engine


class RebuyTimingTests(unittest.TestCase):
    def busted_table(self, busted=("p3",), showdown_seconds=5, players=4,
                     bots=(), elimination_seconds=0):
        state = engine.create_lobby("rebuy-timing", "p1", "Ada", {
            "max_seats": players, "starting_stack": 1000, "small_blind": 5, "big_blind": 10,
            "level_minutes": 1, "showdown_seconds": showdown_seconds,
            "elimination_announcement_seconds": elimination_seconds, "blind_announcement_seconds": 0,
        }, now=100)
        names = {2: "Bea", 3: "Cy", 4: "Dee", 5: "Eli"}
        for number in range(2, players + 1):
            player_id = "p%d" % number
            engine.join(state, player_id, names.get(number, "Player %d" % number), now=101)
        for player_id in bots:
            engine._seat_by_id(state, player_id)["is_bot"] = True
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
        self.assertEqual(state["hand_no"], 1)
        outcome = self.view(state, "p1", 150)["rebuy_announcement"]
        self.assertEqual(outcome["players"][0]["status"], "accepted")
        self.assertEqual(outcome["until"], 154)
        engine.advance(state, now=154)
        self.assertEqual(state["hand_no"], 2)
        self.assertIn("p3", state["hand"]["holes"])
        self.assertFalse(self.view(state, "p1", 151)["blinds"]["paused"])
        self.assertEqual(self.view(state, "p1", 151)["blinds"]["seconds_to_next"], 51)

    def test_three_player_hand_can_rebuy_from_two_remaining_and_clears_elimination_announcement(self):
        state = self.busted_table(("p3",), players=3, elimination_seconds=10)
        self.assertTrue(state["hand"]["rebuy_eligible"])
        self.assertEqual(sum(seat["stack"] > 0 for seat in state["seats"]), 2)
        self.assertEqual(set(state["rebuy_offers"]), {"p3"})
        self.assertEqual(state["elimination_announcement"]["players"][0]["player_id"], "p3")
        visible = self.view(state, "p3", 115)
        self.assertEqual(visible["viewer"]["rebuy_offer"]["id"], state["rebuy_offers"]["p3"]["id"])
        self.assertEqual(visible["elimination_announcement"]["players"][0]["player_id"], "p3")

        engine.accept_rebuy(state, "p3", state["rebuy_offers"]["p3"]["id"], now=115)
        self.assertEqual(state["status"], "playing")
        self.assertIsNone(state["elimination_announcement"])
        self.assertEqual(state["hand"]["next_hand_at"], 119)
        engine.advance(state, now=119)
        self.assertEqual(state["hand_no"], 2)
        self.assertIn("p3", state["hand"]["holes"])

    def test_three_to_one_multi_bust_offers_stay_open_until_each_decision_after_reload(self):
        state = json.loads(json.dumps(self.busted_table(("p2", "p3"), players=3)))
        self.assertTrue(engine._rebuys_open(state))
        self.assertEqual(sum(seat["stack"] > 0 for seat in state["seats"]), 1)
        self.assertEqual(set(state["rebuy_offers"]), {"p2", "p3"})
        self.assertEqual(state["status"], "playing")
        self.assertEqual(
            self.view(state, "p2", 115)["viewer"]["rebuy_offer"]["id"],
            state["rebuy_offers"]["p2"]["id"],
        )

        engine.accept_rebuy(state, "p2", state["rebuy_offers"]["p2"]["id"], now=120)
        self.assertEqual(state["status"], "playing")
        self.assertEqual(state["hand_no"], 1)
        self.assertEqual(set(state["rebuy_offers"]), {"p3"})
        engine.advance(state, now=130)
        self.assertEqual(state["status"], "playing")
        self.assertEqual(state["hand_no"], 1)

        engine.accept_rebuy(state, "p3", state["rebuy_offers"]["p3"]["id"], now=140)
        self.assertEqual(state["status"], "playing")
        self.assertEqual(state["rebuy_offers"], {})
        self.assertEqual(sum(seat["stack"] > 0 for seat in state["seats"]), 3)
        engine.advance(state, now=143.99)
        self.assertEqual(state["hand_no"], 1)
        engine.advance(state, now=144)
        self.assertEqual(state["hand_no"], 2)
        self.assertTrue({"p2", "p3"}.issubset(state["hand"]["holes"]))

    def test_three_to_one_tournament_finishes_only_after_all_eligible_offers_resolve(self):
        state = self.busted_table(("p2", "p3"), players=3)
        engine.decline_rebuy(state, "p2", state["rebuy_offers"]["p2"]["id"], now=120)
        self.assertEqual(state["status"], "playing")
        self.assertEqual(set(state["rebuy_offers"]), {"p3"})
        engine.advance(state, now=130)
        self.assertEqual(state["status"], "playing")
        self.assertEqual(state["hand_no"], 1)

        engine.decline_rebuy(state, "p3", state["rebuy_offers"]["p3"]["id"], now=140)
        self.assertEqual(state["status"], "completed")
        self.assertEqual(state["rebuy_offers"], {})
        self.assertIsNone(state["hand"]["next_hand_at"])

    def test_legacy_hand_eligibility_falls_back_to_stack_and_hole_snapshots(self):
        state = self.busted_table(players=4)
        hand = state["hand"]
        hand.pop("rebuy_eligible")
        self.assertTrue(engine._hand_rebuy_eligible(hand))
        hand.pop("stack_before")
        self.assertTrue(engine._hand_rebuy_eligible(hand))

        heads_up = self.busted_table(("p2",), players=2)
        heads_up["hand"].pop("rebuy_eligible")
        self.assertFalse(engine._hand_rebuy_eligible(heads_up["hand"]))

    def test_multiple_busts_wait_for_last_decision_and_survive_reload(self):
        state = json.loads(json.dumps(self.busted_table(("p3", "p4"), players=5)))
        engine.accept_rebuy(state, "p3", state["rebuy_offers"]["p3"]["id"], now=120)
        engine.advance(state, now=130)
        self.assertEqual(state["hand_no"], 1)
        self.assertEqual(self.view(state, "p1", 130)["rebuy_waiting"], [{"player_id": "p4", "name": "Dee"}])
        self.assertTrue(self.view(state, "p1", 130)["blinds"]["paused"])
        engine.decline_rebuy(state, "p4", state["rebuy_offers"]["p4"]["id"], now=140)
        engine.advance(state, now=140)
        self.assertEqual(state["hand_no"], 1)
        self.assertEqual(self.view(state, "p1", 140)["rebuy_announcement"]["players"][0]["status"], "declined")
        engine.advance(state, now=144)
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
        self.assertEqual(state["blinds"]["level"], 1)
        self.assertEqual(self.view(state, "p1", 175)["rebuy_announcement"]["players"][0]["status"], "expired")
        engine.advance(state, now=179)
        self.assertEqual(state["blinds"]["level"], 2)
        self.assertNotIn("rebuy_hold_started_at", state)
        engine.advance(state, now=180.5)
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
                self.assertEqual(state["hand_no"], 1)
                self.assertEqual(self.view(state, "p1", 160)["rebuy_announcement"]["until"], 164)
                engine.advance(state, now=164)
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

    def test_host_rebuy_switch_and_inclusive_level_cutoff_apply_to_people_and_bots(self):
        for bot in (False, True):
            for enabled, limit, level, allowed in ((False, None, 1, False), (True, 4, 4, True),
                                                  (True, 4, 5, False), (True, None, 50, True)):
                with self.subTest(bot=bot, enabled=enabled, limit=limit, level=level):
                    state = self.busted_table()
                    state["rebuy_offers"] = {}
                    state.pop("rebuy_hold_started_at", None)
                    state["rebuy_enabled"] = enabled
                    state["config"].update(rebuy_enabled=enabled, rebuy_max_level=limit)
                    state["blinds"]["level"] = level
                    engine._seat_by_id(state, "p3")["is_bot"] = bot
                    engine._create_rebuy_offers(state, [{"player_id": "p3"}], state["hand"], 110)
                    self.assertEqual(bool(state["rebuy_offers"]), allowed)
                    if allowed:
                        engine.accept_rebuy(state, "p3", state["rebuy_offers"]["p3"]["id"], now=115, _bot_decision=bot)
                        self.assertEqual(engine._seat_by_id(state, "p3")["stack"], 1000)
                    else:
                        with self.assertRaises(engine.GameError) as error:
                            engine.accept_rebuy(state, "p3", "not-offered", now=115)
                        self.assertEqual(error.exception.code, "rebuy_unavailable")

    def test_host_can_choose_rebuy_policy_before_dealing_and_it_locks_at_start(self):
        state = engine.create_lobby("policy", "p1", "Ada", {}, now=100)
        engine.join(state, "p2", "Bea", now=101)
        engine.update_settings(state, "p1", {"rebuy_enabled": False, "rebuy_max_level": 3}, now=102)
        self.assertFalse(state["rebuy_enabled"])
        self.assertEqual(self.view(state, "p1", 102)["config"]["rebuy_max_level"], 3)
        engine.start(state, "p1", now=103)
        for change in ({"rebuy_enabled": True}, {"rebuy_max_level": None}):
            with self.assertRaises(engine.GameError):
                engine.update_settings(state, "p1", change, now=104)
            engine.pause_table(state, "p1", True, now=104)
            with self.assertRaises(engine.GameError):
                engine.update_runtime_settings(state, "p1", change, now=104)
        legacy = engine.create_lobby("legacy", "p1", "Ada", {}, now=100)
        legacy.pop("rebuy_enabled")
        legacy["config"].pop("rebuy_enabled")
        legacy["config"].pop("rebuy_max_level")
        engine.update_settings(legacy, "p1", {"turn_seconds": 40}, now=101)
        self.assertFalse(legacy["rebuy_enabled"])

    def test_shared_outcome_survives_reload_and_host_pause(self):
        state = self.busted_table()
        engine.decline_rebuy(state, "p3", state["rebuy_offers"]["p3"]["id"], now=120)
        state = json.loads(json.dumps(state))
        for pid in ("p1", "p3", None):
            result = self.view(state, pid, 121)["rebuy_announcement"]
            self.assertEqual(result["players"], [{"player_id": "p3", "name": "Cy", "status": "declined"}])
        engine.pause_table(state, "p1", True, now=121)
        engine.advance(state, now=200)
        self.assertEqual(state["hand_no"], 1)
        self.assertEqual(self.view(state, None, 200)["rebuy_announcement"]["until"], 203)
        engine.pause_table(state, "p1", False, now=201)
        engine.advance(state, now=203.99)
        self.assertEqual(state["hand_no"], 1)
        engine.advance(state, now=204)
        self.assertEqual(state["hand_no"], 2)
        self.assertIsNone(self.view(state, None, 204)["rebuy_announcement"])

    def test_simultaneous_decisions_are_announced_together(self):
        state = self.busted_table(("p3", "p4"), players=5)
        engine.accept_rebuy(state, "p3", state["rebuy_offers"]["p3"]["id"], now=120)
        engine.decline_rebuy(state, "p4", state["rebuy_offers"]["p4"]["id"], now=121)
        result = self.view(state, None, 121)["rebuy_announcement"]
        self.assertEqual([row["status"] for row in result["players"]], ["accepted", "declined"])
        self.assertEqual(result["until"], 125)
        engine.advance(state, now=124.99)
        self.assertEqual(state["hand_no"], 1)
        engine.advance(state, now=125)
        self.assertEqual(state["hand_no"], 2)

    def test_simultaneous_busts_remain_eligible_when_the_hand_ends_heads_up(self):
        state = self.busted_table(("p3", "p4"), players=4)
        self.assertTrue(state["hand"]["rebuy_eligible"])
        self.assertEqual(sum(seat["stack"] > 0 for seat in state["seats"]), 2)
        self.assertEqual(set(state["rebuy_offers"]), {"p3", "p4"})
        self.assertIn("rebuy_hold_started_at", state)
