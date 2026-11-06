import unittest
from unittest.mock import patch

import engine


def config(**overrides):
    value = {
        "max_seats": 4,
        "starting_stack": 1000,
        "small_blind": 5,
        "big_blind": 10,
        "level_minutes": 1,
        "turn_seconds": 30,
        "blind_announcement_seconds": 0,
        "elimination_announcement_seconds": 0,
        "showdown_seconds": 1.5,
    }
    value.update(overrides)
    return value


def heads_up(now=100.0, starting_stack=1000):
    state = engine.create_lobby(
        "table-1",
        "p1",
        "Ada",
        config(starting_stack=starting_stack),
        now=now,
    )
    engine.join(state, "p2", "Bea", now=now + 1)
    engine.start(state, "p1", now=now + 2)
    return state


class EngineTests(unittest.TestCase):
    def test_rank_descriptions_name_the_made_hand(self):
        cases = (
            ((0, 14, 12, 9, 5, 3), "Ace high"),
            ((1, 11, 14, 9, 8), "Pair of jacks"),
            ((2, 14, 13, 9), "Two pair, aces and kings"),
            ((3, 12, 14, 9), "Three queens"),
            ((4, 5), "Five-high straight"),
            ((5, 14, 12, 9, 5, 3), "Ace-high flush"),
            ((6, 14, 13), "Aces full of kings"),
            ((7, 6, 14), "Four sixes"),
            ((8, 14), "Ace-high straight flush"),
        )
        for rank, expected in cases:
            with self.subTest(rank=rank):
                self.assertEqual(engine._rank_description(rank), expected)

    def test_announcement_defaults_are_backward_compatible_and_require_finite_bounded_numbers(self):
        legacy_config = config()
        legacy_config.pop("blind_announcement_seconds")
        legacy_config.pop("elimination_announcement_seconds")
        legacy_config.pop("showdown_seconds")
        state = engine.create_lobby("default-announcements", "p1", "Ada", legacy_config, now=1)
        self.assertEqual(state["config"]["blind_announcement_seconds"], 5)
        self.assertEqual(state["config"]["elimination_announcement_seconds"], 5)
        self.assertEqual(state["config"]["showdown_seconds"], 5)

        for setting in ("blind_announcement_seconds", "elimination_announcement_seconds", "showdown_seconds"):
            for value in (-0.1, 60.1, True, float("nan"), float("inf"), -float("inf")):
                with self.subTest(setting=setting, value=value):
                    with self.assertRaises(engine.GameError):
                        engine.create_lobby(
                            "bad-announcement", "p1", "Ada",
                            config(**{setting: value}), now=1,
                        )
            accepted = engine.create_lobby(
                "valid-announcement", "p1", "Ada",
                config(**{setting: 60}), now=1,
            )
            self.assertEqual(accepted["config"][setting], 60)

    def test_pause_freezes_deadlines_rejects_actions_and_invalidates_turn_tokens(self):
        state = heads_up()
        hand = state["hand"]
        actor_id = hand["to_act"]
        expected_hand = state["hand_no"]
        expected_turn = state["turn_version"]
        original_deadlines = {
            "turn_deadline": hand["turn_deadline"],
            "bot_action_at": 110.5,
            "runout_at": 111.0,
            "hand_complete_at": 112.0,
            "next_hand_at": 112.0,
            "blind_started_at": state["blinds"]["started_at"],
            "next_level_at": state["blinds"]["next_level_at"],
        }
        hand.update({
            "bot_action_at": original_deadlines["bot_action_at"],
            "runout_at": original_deadlines["runout_at"],
            "hand_complete_at": original_deadlines["hand_complete_at"],
            "next_hand_at": original_deadlines["next_hand_at"],
        })
        engine.pause_table(state, "p1", True, now=105)
        paused_turn_version = state["turn_version"]
        self.assertTrue(state["paused"])
        self.assertEqual(state["paused_at"], 105)

        with patch("engine.time.time", return_value=2000):
            view = engine.public_view(state, actor_id)
        self.assertFalse(view["viewer"]["can_act"])
        self.assertEqual(view["turn_deadline"], original_deadlines["turn_deadline"] + 1895)
        self.assertEqual(view["blinds"]["seconds_to_next"], 57)

        version = state["version"]
        engine.advance(state, now=5000)
        self.assertEqual(state["version"], version)
        self.assertEqual(state["hand_no"], expected_hand)
        self.assertEqual(hand["turn_deadline"], original_deadlines["turn_deadline"])
        self.assertEqual(hand["bot_action_at"], original_deadlines["bot_action_at"])
        self.assertEqual(hand["runout_at"], original_deadlines["runout_at"])
        self.assertEqual(hand["next_hand_at"], original_deadlines["next_hand_at"])
        self.assertEqual(state["blinds"]["next_level_at"], original_deadlines["next_level_at"])

        with self.assertRaises(engine.GameError) as caught:
            engine.apply_action(
                state, actor_id, "check", None, expected_hand, expected_turn, now=5000,
            )
        self.assertEqual(caught.exception.code, "table_paused")
        with self.assertRaises(engine.GameError) as caught:
            engine.set_sitting_out(state, actor_id, True, now=5000)
        self.assertEqual(caught.exception.code, "table_paused")

        engine.pause_table(state, "p1", False, now=500)
        self.assertFalse(state["paused"])
        self.assertEqual(state["paused_at"], None)
        self.assertEqual(state["turn_version"], paused_turn_version + 1)
        pause_duration = 395
        self.assertEqual(hand["turn_deadline"], original_deadlines["turn_deadline"] + pause_duration)
        self.assertEqual(hand["bot_action_at"], original_deadlines["bot_action_at"] + pause_duration)
        self.assertEqual(hand["runout_at"], original_deadlines["runout_at"] + pause_duration)
        self.assertEqual(hand["next_hand_at"], original_deadlines["next_hand_at"] + pause_duration)
        self.assertEqual(state["blinds"]["started_at"], original_deadlines["blind_started_at"] + pause_duration)
        self.assertEqual(state["blinds"]["next_level_at"], original_deadlines["next_level_at"] + pause_duration)
        with self.assertRaises(engine.GameError) as caught:
            engine.apply_action(
                state, actor_id, "check", None, expected_hand, expected_turn, now=500,
            )
        self.assertEqual(caught.exception.code, "stale_turn")

    def test_paused_advance_does_not_run_a_due_bot_action(self):
        state = engine.create_lobby(
            "paused-bot", "p1", "Ada", config(max_seats=2), now=10,
        )
        engine.add_bot(state, "p1", 1, now=11, is_admin=True)
        engine.start(state, "p1", now=12)
        bot_id = "bot:paused-bot:1"
        hand = state["hand"]
        hand["to_act"] = bot_id
        hand["bot_action_at"] = 13
        hand["turn_deadline"] = 14
        bot_stack = engine._seat_by_id(state, bot_id)["stack"]
        engine.pause_table(state, "p1", True, now=12.5)

        engine.advance(state, now=1000)

        self.assertEqual(state["hand"]["to_act"], bot_id)
        self.assertEqual(state["hand"]["bot_action_at"], 13)
        self.assertEqual(engine._seat_by_id(state, bot_id)["stack"], bot_stack)

    def test_blind_announcement_holds_one_hand_boundary_even_when_next_level_is_due(self):
        state = heads_up()
        state["config"]["level_minutes"] = 0.01
        state["config"]["blind_announcement_seconds"] = 5
        hand = state["hand"]
        hand["street"] = "showdown"
        hand["to_act"] = None
        hand["hand_complete_at"] = 102
        hand["next_hand_at"] = 102
        state["blinds"]["next_level_at"] = 102.5

        engine.advance(state, now=103)
        announced_hand_no = state["hand_no"]
        announcement = state["blind_announcement"]
        self.assertEqual(announcement, {
            "level": 2, "small": 10, "big": 20, "starts_at": 103, "until": 108,
        })
        self.assertEqual(hand["next_hand_at"], 108)
        self.assertIsNone(state["blinds"]["started_at"])
        self.assertIsNone(state["blinds"]["next_level_at"])
        self.assertTrue(engine.public_view(state, None)["blinds"]["waiting_for_hand"])

        # A delayed poll after both deadlines still deals once; it does not
        # replace the announcement and postpone this same hand boundary again.
        engine.advance(state, now=109)
        self.assertEqual(state["hand_no"], announced_hand_no + 1)
        self.assertEqual(state["blinds"]["level"], 2)
        self.assertIsNone(state["blind_announcement"])
        self.assertEqual(state["blinds"]["started_at"], 109)
        self.assertEqual(state["blinds"]["next_level_at"], 109.6)

    def test_bust_and_blind_announcements_hold_together_and_survive_final_completion(self):
        state = engine.create_lobby(
            "announcements", "p1", "Ada",
            config(max_seats=3, blind_announcement_seconds=8,
                   elimination_announcement_seconds=4), now=1,
        )
        engine.join(state, "p2", "Bea", now=2)
        engine.join(state, "p3", "Cy", now=3)
        engine.start(state, "p1", now=4)
        hand = state["hand"]
        hand["stack_before"] = {"p1": 100, "p2": 200, "p3": 300}
        engine._seat_by_id(state, "p1")["stack"] = 0
        engine._seat_by_id(state, "p2")["stack"] = 200
        engine._seat_by_id(state, "p3")["stack"] = 300
        state["blinds"]["next_level_at"] = 10

        engine._finish_hand(state, {player_id: 0 for player_id in hand["contrib"]}, now=10)

        self.assertEqual(state["elimination_announcement"]["starts_at"], 11.5)
        self.assertEqual(state["elimination_announcement"]["until"], 15.5)
        self.assertEqual(state["blind_announcement"]["starts_at"], 15.5)
        self.assertEqual(state["blind_announcement"]["until"], 23.5)
        self.assertEqual(hand["next_hand_at"], 23.5)
        self.assertEqual(state["status"], "playing")

        final = engine.create_lobby(
            "final-announcement", "p1", "Ada",
            config(max_seats=2, starting_stack=100, elimination_announcement_seconds=6),
            now=100,
        )
        engine.join(final, "p2", "Bea", now=101)
        engine.start(final, "p1", now=102)
        final_hand = final["hand"]
        final_hand["stack_before"] = {"p1": 100, "p2": 100}
        engine._seat_by_id(final, "p1")["stack"] = 0
        engine._seat_by_id(final, "p2")["stack"] = 200
        engine._finish_hand(final, {player_id: 0 for player_id in final_hand["contrib"]}, now=200)
        self.assertEqual(final["status"], "completed")
        self.assertIsNone(final["hand"]["next_hand_at"])
        with patch("engine.time.time", return_value=203):
            view = engine.public_view(final, "p2")
        self.assertEqual(view["results"][0]["name"], "Bea")
        self.assertEqual(view["elimination_announcement"]["players"], [
            {"name": "Ada", "place": 2, "tied": False, "tie_count": 1},
        ])
        self.assertEqual(view["elimination_announcement"]["starts_at"], 201.5)
        self.assertEqual(view["elimination_announcement"]["until"], 207.5)
        self.assertEqual(view["presentation_until"], 207.5)

    def test_showdown_elimination_blind_and_deal_windows_are_sequential(self):
        state = engine.create_lobby(
            "sequenced", "p1", "Ada",
            config(max_seats=3, starting_stack=100, showdown_seconds=5,
                   elimination_announcement_seconds=4, blind_announcement_seconds=8),
            now=1,
        )
        engine.join(state, "p2", "Bea", now=2)
        engine.join(state, "p3", "Cy", now=3)
        engine.start(state, "p1", now=4)
        hand = state["hand"]
        hand["showdown"] = [{
            "player_id": "p2", "name": "Bea", "cards": ["As", "Ah"],
            "rank": "Four of a kind", "hand_name": "Four of a kind",
        }]
        hand["stack_before"] = {"p1": 100, "p2": 100, "p3": 100}
        for player_id, stack in (("p1", 0), ("p2", 100), ("p3", 100)):
            engine._seat_by_id(state, player_id)["stack"] = stack
        state["blinds"]["next_level_at"] = 10

        engine._finish_hand(
            state, {player_id: 0 for player_id in hand["contrib"]}, now=10,
        )

        self.assertEqual(hand["showdown_until"], 15)
        self.assertEqual(state["elimination_announcement"]["starts_at"], 15)
        self.assertEqual(state["elimination_announcement"]["until"], 19)
        self.assertEqual(state["blind_announcement"]["starts_at"], 19)
        self.assertEqual(state["blind_announcement"]["until"], 27)
        self.assertEqual(hand["presentation_until"], 27)
        self.assertEqual(hand["next_hand_at"], 27)

        with patch("engine.time.time", return_value=14.99):
            view = engine.public_view(state, "p2")
        self.assertIsNone(view["elimination_announcement"])
        self.assertIsNone(view["blind_announcement"])
        self.assertEqual(view["showdown_until"], 15)
        with patch("engine.time.time", return_value=15):
            view = engine.public_view(state, "p2")
        self.assertEqual(view["elimination_announcement"]["starts_at"], 15)
        self.assertIsNone(view["blind_announcement"])
        with patch("engine.time.time", return_value=19):
            view = engine.public_view(state, "p2")
        self.assertIsNone(view["elimination_announcement"])
        self.assertEqual(view["blind_announcement"]["starts_at"], 19)

        hand_no = state["hand_no"]
        engine.advance(state, now=26.99)
        self.assertEqual(state["hand_no"], hand_no)
        engine.advance(state, now=27)
        self.assertEqual(state["hand_no"], hand_no + 1)

    def test_final_tournament_showdown_keeps_result_and_elimination_windows(self):
        state = engine.create_lobby(
            "final-showdown-window", "p1", "Ada",
            config(max_seats=2, starting_stack=100, showdown_seconds=5,
                   elimination_announcement_seconds=6),
            now=100,
        )
        engine.join(state, "p2", "Bea", now=101)
        engine.start(state, "p1", now=102)
        hand = state["hand"]
        hand["showdown"] = [{
            "player_id": "p2", "name": "Bea", "cards": ["As", "Ah"],
            "rank": "Four of a kind", "hand_name": "Four of a kind",
        }]
        hand["stack_before"] = {"p1": 100, "p2": 100}
        engine._seat_by_id(state, "p1")["stack"] = 0
        engine._seat_by_id(state, "p2")["stack"] = 200

        engine._finish_hand(
            state, {player_id: 0 for player_id in hand["contrib"]}, now=200,
        )

        self.assertEqual(state["status"], "completed")
        self.assertEqual(hand["showdown_until"], 205)
        self.assertIsNone(hand["next_hand_at"])
        self.assertEqual(state["elimination_announcement"]["starts_at"], 205)
        self.assertEqual(state["elimination_announcement"]["until"], 211)
        self.assertEqual(hand["presentation_until"], 211)
        with patch("engine.time.time", return_value=204.99):
            view = engine.public_view(state, "p2")
        self.assertIsNone(view["elimination_announcement"])
        self.assertEqual(view["presentation_until"], 211)
        with patch("engine.time.time", return_value=205):
            view = engine.public_view(state, "p2")
        self.assertIsNotNone(view["elimination_announcement"])
        self.assertEqual(view["elimination_announcement"]["starts_at"], 205)

    def test_river_showdown_holds_after_all_in_runout_is_already_complete(self):
        state = heads_up(starting_stack=100)
        state["config"]["showdown_seconds"] = 7
        hand = state["hand"]
        hand.update({
            "street": "river",
            "board": ["2c", "3d", "4h", "9s", "Jc"],
            "holes": {"p1": ["As", "Ah"], "p2": ["Ks", "Kh"]},
            "folded": [],
            "contrib": {"p1": 20, "p2": 20},
            "bets": {"p1": 0, "p2": 0},
            "runout_at": None,
            "to_act": None,
        })
        for seat in state["seats"]:
            seat["stack"] = 80

        engine._settle_showdown(state, now=200)

        self.assertEqual(hand["street"], "showdown")
        self.assertIsNone(hand["runout_at"])
        self.assertEqual(hand["showdown_started_at"], 200)
        self.assertEqual(hand["showdown_until"], 207)
        self.assertEqual(hand["next_hand_at"], 207)
        self.assertTrue(all("hand_name" in item for item in hand["showdown"]))
        hand_no = state["hand_no"]
        engine.advance(state, now=206.99)
        self.assertEqual(state["hand_no"], hand_no)
        engine.advance(state, now=207)
        self.assertEqual(state["hand_no"], hand_no + 1)

    def test_paused_runtime_edits_are_limited_to_host_timers(self):
        state = heads_up()
        hand = state["hand"]
        hand["to_act"] = "p1"
        engine.pause_table(state, "p1", True, now=110)
        original_globals = {
            key: state["config"][key]
            for key in (
                "runout_seconds", "blind_announcement_seconds",
                "elimination_announcement_seconds", "showdown_seconds",
            )
        }
        updated = engine.update_runtime_settings(
            state, "p1", {"turn_seconds": 12, "level_minutes": 2}, now=120,
        )
        self.assertEqual(updated["config"]["turn_seconds"], 12)
        self.assertEqual(updated["config"]["level_minutes"], 2)
        for key, value in original_globals.items():
            self.assertEqual(updated["config"][key], value)

        with self.assertRaises(engine.GameError) as caught:
            engine.update_runtime_settings(
                state, "p1", {"showdown_seconds": 10}, now=121,
            )
        self.assertEqual(caught.exception.code, "invalid_config")

    def test_legacy_showdown_windows_are_sequenced_once_and_expired_windows_stay_expired(self):
        state = heads_up()
        hand = state["hand"]
        hand.update({
            "street": "showdown",
            "showdown": [{"player_id": "p1", "name": "Ada", "cards": ["As", "Ah"],
                           "rank": "One pair"}],
            "hand_complete_at": 102,
            "next_hand_at": 107,
        })
        for key in ("presentation_version", "showdown_started_at", "showdown_until", "presentation_until"):
            hand.pop(key, None)
        state["config"]["elimination_announcement_seconds"] = 4
        state["config"]["blind_announcement_seconds"] = 5
        state["elimination_announcement"] = {"players": [], "until": 105}
        state["blind_announcement"] = {"level": 2, "small": 10, "big": 20, "until": 106}

        engine.advance(state, now=101)

        self.assertEqual(hand["showdown_started_at"], 100.5)
        self.assertEqual(hand["showdown_until"], 102)
        self.assertEqual(state["elimination_announcement"]["starts_at"], 102)
        self.assertEqual(state["elimination_announcement"]["until"], 106)
        self.assertEqual(state["blind_announcement"]["starts_at"], 106)
        self.assertEqual(state["blind_announcement"]["until"], 111)
        self.assertEqual(hand["next_hand_at"], 111)

        expired = heads_up(now=200)
        old_hand = expired["hand"]
        old_hand.update({
            "street": "showdown",
            "showdown": [{"player_id": "p1", "name": "Ada", "cards": ["As", "Ah"],
                           "rank": "One pair"}],
            "hand_complete_at": 201,
            "next_hand_at": 202,
        })
        for key in ("presentation_version", "showdown_started_at", "showdown_until", "presentation_until"):
            old_hand.pop(key, None)
        expired["config"]["elimination_announcement_seconds"] = 4
        expired["config"]["blind_announcement_seconds"] = 5
        expired["elimination_announcement"] = {"players": [], "until": 205}
        expired["blind_announcement"] = {"level": 2, "small": 10, "big": 20, "until": 206}

        engine.advance(expired, now=210)

        self.assertIsNone(expired["elimination_announcement"])
        self.assertIsNone(expired["blind_announcement"])
        self.assertGreater(expired["hand_no"], 1)

    def test_lobby_host_seated_and_heads_up_blinds(self):
        state = heads_up()
        hand = state["hand"]
        self.assertEqual(state["status"], "playing")
        self.assertEqual(state["hand_no"], 1)
        self.assertEqual(hand["button_id"], hand["small_blind_id"])
        self.assertEqual({hand["button_id"], hand["big_blind_id"]}, {"p1", "p2"})
        self.assertEqual(hand["bets"], {hand["small_blind_id"]: 5, hand["big_blind_id"]: 10})
        self.assertEqual(hand["to_act"], hand["button_id"])
        seats = {seat["player_id"]: seat for seat in state["seats"]}
        self.assertEqual(seats[hand["small_blind_id"]]["stack"], 995)
        self.assertEqual(seats[hand["big_blind_id"]]["stack"], 990)
        seat_numbers = sorted(seat["seat_no"] for seat in state["seats"])
        self.assertEqual(seat_numbers, [0, 1])
        self.assertEqual(state["config"]["max_seats"], 2)

    def test_start_randomizes_players_across_ring_and_draws_button_independently(self):
        state = engine.create_lobby(
            "random-seat", "p1", "Ada", config(max_seats=9), now=1
        )
        engine.join(state, "p2", "Bea", now=2, seat_no=4)
        engine.join(state, "p3", "Cy", now=3, seat_no=8)

        def reverse(values):
            values.reverse()

        with patch.object(engine.random.SystemRandom, "shuffle", side_effect=reverse):
            with patch.object(engine.random.SystemRandom, "randrange", return_value=2):
                with patch.object(
                    engine.random.SystemRandom,
                    "choice",
                    side_effect=lambda seats: next(seat for seat in seats if seat["player_id"] == "p2"),
                ):
                    engine.start(state, "p1", now=4)

        seat_numbers = {seat["player_id"]: seat["seat_no"] for seat in state["seats"]}
        self.assertEqual(sorted(seat_numbers.values()), [0, 1, 2])
        self.assertEqual(seat_numbers, {"p1": 1, "p2": 0, "p3": 2})
        self.assertEqual(state["hand"]["button_id"], "p2")
        self.assertEqual(state["config"]["max_seats"], 3)

    def test_freezeout_start_accepts_every_field_size_from_two_to_nine(self):
        for player_count in range(2, 10):
            with self.subTest(player_count=player_count):
                state = engine.create_lobby(
                    "field-%d" % player_count,
                    "p1",
                    "Ada",
                    config(max_seats=9),
                    now=player_count,
                )
                for index in range(2, player_count + 1):
                    engine.join(state, "p%d" % index, "P%d" % index, now=player_count + index)
                engine.start(state, "p1", now=player_count + 20)
                self.assertEqual(state["status"], "playing")
                self.assertEqual(len(state["hand"]["holes"]), player_count)
                self.assertEqual(len(state["seats"]), player_count)
                seat_numbers = [seat["seat_no"] for seat in state["seats"]]
                self.assertEqual(len(set(seat_numbers)), player_count)
                self.assertEqual(state["config"]["max_seats"], player_count)
                self.assertTrue(all(0 <= seat_no < player_count for seat_no in seat_numbers))

    def test_join_is_idempotent_and_lobby_limits_are_enforced(self):
        state = engine.create_lobby(
            "table-2", "p1", "Ada", config(max_seats=2), now=1
        )
        engine.join(state, "p1", "Ada", now=2)
        engine.join(state, "p2", "Bea", now=3)
        version = state["version"]
        engine.join(state, "p2", "Bea", now=4)
        self.assertEqual(state["version"], version)
        with self.assertRaises(engine.GameError) as caught:
            engine.join(state, "p3", "Cy", now=5)
        self.assertEqual(caught.exception.code, "table_full")

    def test_stale_turn_token_rejected_and_round_advances(self):
        state = heads_up()
        turn_version = state["turn_version"]
        hand_no = state["hand_no"]
        actor = state["hand"]["to_act"]
        opponent = "p2" if actor == "p1" else "p1"
        engine.apply_action(
            state, actor, "call", None, hand_no, turn_version, now=104
        )
        self.assertEqual(state["hand"]["to_act"], opponent)
        with self.assertRaises(engine.GameError) as caught:
            engine.apply_action(
                state, actor, "call", None, hand_no, turn_version, now=105
            )
        self.assertEqual(caught.exception.code, "stale_turn")
        self.assertEqual(caught.exception.status, 409)
        engine.apply_action(
            state,
            opponent,
            "check",
            None,
            state["hand_no"],
            state["turn_version"],
            now=106,
        )
        self.assertEqual(state["hand"]["street"], "flop")
        self.assertEqual(state["hand"]["to_act"], opponent)

    def test_legacy_check_fold_selection_never_executes_and_is_discarded(self):
        state = heads_up()
        hand = state["hand"]
        actor = hand["to_act"]
        waiting = next(player_id for player_id in hand["holes"] if player_id != actor)
        hand["preactions"] = {waiting: {"hand_no": state["hand_no"]}}
        hand["preaction_revisions"] = {waiting: 1}
        waiting_actions_before = sum(
            event.get("type") == "action" and event.get("actor_id") == waiting
            for event in hand["events"]
        )

        engine.apply_action(
            state, actor, "call", None, state["hand_no"], state["turn_version"], now=104,
        )

        self.assertEqual(hand["to_act"], waiting)
        waiting_actions_after = sum(
            event.get("type") == "action" and event.get("actor_id") == waiting
            for event in hand["events"]
        )
        self.assertEqual(waiting_actions_after, waiting_actions_before)
        viewer = engine.public_view(state, waiting)["viewer"]
        self.assertNotIn("check_fold_selected", viewer)
        self.assertNotIn("check_fold_revision", viewer)

        engine.advance(state, now=105)
        self.assertNotIn("preactions", hand)
        self.assertNotIn("preaction_revisions", hand)

    def test_fold_completion_uses_short_pause_separate_from_runout_delay(self):
        state = heads_up()
        hand = state["hand"]
        now = 104
        engine.apply_action(
            state, hand["to_act"], "fold", None,
            state["hand_no"], state["turn_version"], now=now,
        )

        self.assertEqual(engine.HAND_COMPLETE_PAUSE_SECONDS, 1.5)
        self.assertEqual(hand["next_hand_at"], now + engine.HAND_COMPLETE_PAUSE_SECONDS)
        self.assertEqual(engine.RUNOUT_SECONDS, 2.5)
        engine.advance(state, now=hand["next_hand_at"] - 0.01)
        self.assertEqual(state["hand_no"], 1)
        engine.advance(state, now=hand["next_hand_at"])
        self.assertEqual(state["hand_no"], 2)

    def test_raise_to_rules_and_short_all_in(self):
        state = heads_up(starting_stack=100)
        hand = state["hand"]
        small_id = hand["small_blind_id"]
        big_id = hand["big_blind_id"]
        with self.assertRaises(engine.GameError) as caught:
            engine.apply_action(
                state, small_id, "raise", 15, state["hand_no"], state["turn_version"], now=104
            )
        self.assertEqual(caught.exception.code, "raise_too_small")
        self.assertEqual(hand["to_act"], small_id)

        # The SB has 95 chips after posting 5, so raising to 100 is a legal all-in.
        engine.apply_action(
            state, small_id, "raise", 100, state["hand_no"], state["turn_version"], now=105
        )
        self.assertEqual(hand["current_bet"], 100)
        self.assertEqual(hand["min_raise"], 90)
        self.assertEqual(hand["to_act"], big_id)
        self.assertEqual(engine._seat_by_id(state, small_id)["stack"], 0)

    def test_fold_awards_pot_without_showing_hole_cards(self):
        state = heads_up()
        before_total = sum(seat["stack"] for seat in state["seats"]) + sum(
            state["hand"]["contrib"].values()
        )
        folder = state["hand"]["to_act"]
        winner = "p2" if folder == "p1" else "p1"
        engine.apply_action(
            state,
            folder,
            "fold",
            None,
            state["hand_no"],
            state["turn_version"],
            now=105,
        )
        self.assertEqual(state["hand"]["street"], "showdown")
        self.assertEqual(state["hand"]["showdown"], [])
        self.assertEqual(state["hand"]["payouts"][winner], 15)
        self.assertEqual(state["hand"]["pot_winnings"][winner], 10)
        self.assertEqual(state["hand"]["returns"][0]["amount"], 5)
        after_total = sum(seat["stack"] for seat in state["seats"])
        self.assertEqual(after_total, before_total)
        self.assertTrue(any("wins 10 without showdown" in item["text"] for item in state["action_log"]))

    def test_public_view_only_reveals_viewers_hole_cards(self):
        state = heads_up()
        p1_cards = state["hand"]["holes"]["p1"]
        p2_cards = state["hand"]["holes"]["p2"]
        view = engine.public_view(state, "p1")
        seats = {seat["id"]: seat for seat in view["seats"]}
        self.assertEqual(view["viewer"]["hole_cards"], p1_cards)
        self.assertEqual(seats["p1"]["cards"], p1_cards)
        self.assertNotIn("cards", seats["p2"])
        self.assertNotIn("deck", view)
        self.assertNotIn("holes", view)
        self.assertEqual(len(p2_cards), 2)

    def test_all_in_runout_reveals_live_cards_then_deals_one_street_per_tick(self):
        state = engine.create_lobby(
            "runout", "p1", "Ada",
            config(starting_stack=100, runout_seconds=1.25), now=100
        )
        engine.join(state, "p2", "Bea", now=101)
        engine._seat_by_id(state, "p2")["stack"] = 10
        with patch.object(
            engine.random.SystemRandom,
            "choice",
            side_effect=lambda seats: next(seat for seat in seats if seat["player_id"] == "p1"),
        ):
            engine.start(state, "p1", now=102)

        engine.apply_action(
            state, "p1", "call", None,
            state["hand_no"], state["turn_version"], now=105,
        )
        hand = state["hand"]
        self.assertEqual(hand["board"], [])
        self.assertEqual(hand["street"], "preflop")
        delay = state["config"]["runout_seconds"]
        self.assertEqual(hand["runout_at"], 105 + delay)
        self.assertEqual({item["player_id"] for item in hand["revealed"]}, {"p1", "p2"})
        self.assertEqual(len(hand["runout_odds"]), 2)
        self.assertFalse(hand["runout_odds"][0]["exact"])
        deck_count_before = len(hand["deck"])
        view = engine.public_view(state, "p1")
        self.assertTrue(all("cards" in seat for seat in view["seats"]))
        self.assertEqual(view["runout_odds"], hand["runout_odds"])

        expected_streets = ["flop", "turn", "river"]
        expected_board_sizes = [3, 4, 5]
        expected_new_cards = [3, 1, 1]
        for index, expected_street in enumerate(expected_streets):
            due = hand["runout_at"]
            engine.advance(state, now=due - 0.01)
            self.assertEqual(len(hand["board"]), [0, 3, 4][index])
            engine.advance(state, now=due)
            card_event = next(
                event for event in reversed(hand["events"])
                if event["type"] == "street"
            )
            self.assertEqual(card_event["street"], expected_street)
            self.assertEqual(len(hand["board"]), expected_board_sizes[index])
            self.assertEqual(len(card_event["new_cards"]), expected_new_cards[index])
            self.assertEqual(card_event["runout_card_index"], expected_board_sizes[index])
            self.assertEqual(card_event["runout_card_total"], 5)
            self.assertEqual(len(card_event["runout_odds"]), 2)
            if index < len(expected_streets) - 1:
                self.assertEqual(hand["street"], expected_street)
                self.assertEqual(hand["runout_at"], due + delay)
            else:
                self.assertIsNone(hand["runout_at"])
                self.assertEqual(hand["street"], "showdown")
        self.assertEqual(len(hand["board"]), 5)
        self.assertEqual(deck_count_before - len(hand["deck"]), 8)
        self.assertEqual(hand["runout_odds_board"], hand["board"])
        self.assertTrue(hand["runout_odds_exact"])

    def test_all_in_does_not_reveal_or_run_out_while_two_players_can_make_side_pot(self):
        state = engine.create_lobby(
            "side-pot-privacy", "p1", "Ada", config(max_seats=3), now=1
        )
        engine.join(state, "p2", "Bea", now=2)
        engine.join(state, "p3", "Cy", now=3)
        engine.start(state, "p1", now=4)
        hand = state["hand"]
        all_in_id = "p1"
        for seat in state["seats"]:
            seat["stack"] = 0 if seat["player_id"] == all_in_id else 100
        hand["street"] = "flop"
        hand["board"] = [engine._take_card(hand) for _ in range(3)]
        hand["bets"] = {player_id: 0 for player_id in hand["holes"]}
        hand["contrib"] = {player_id: 0 for player_id in hand["holes"]}
        hand["current_bet"] = 0
        hand["acted"] = []
        hand["acted_at_bet"] = {}
        hand["to_act"] = None
        hand["turn_deadline"] = None
        engine._set_next_actor(state, hand["button_id"], now=5)

        first_actor = hand["to_act"]
        second_actor = next(
            player_id for player_id in ("p1", "p2", "p3")
            if player_id != all_in_id and player_id != first_actor
        )
        self.assertNotEqual(first_actor, all_in_id)
        engine.apply_action(
            state, first_actor, "bet", 20,
            state["hand_no"], state["turn_version"], now=6,
        )
        self.assertEqual(hand["to_act"], second_actor)
        engine.apply_action(
            state, second_actor, "call", None,
            state["hand_no"], state["turn_version"], now=7,
        )

        self.assertEqual(hand["street"], "turn")
        self.assertIsNone(hand["runout_at"])
        self.assertEqual(hand["revealed"], [])
        view = engine.public_view(state, second_actor)
        other = next(seat for seat in view["seats"] if seat["id"] == all_in_id)
        self.assertNotIn("cards", other)
        self.assertFalse(any(event["type"] == "reveal" for event in view["events"]))
        self.assertEqual(
            [(event["action"], event["street"]) for event in view["events"] if event["type"] == "action" and event.get("street") == "flop"],
            [("bet", "flop"), ("call", "flop")],
        )

    def test_all_in_reveal_excludes_folded_players(self):
        state = engine.create_lobby(
            "reveal-live-only", "p1", "Ada", config(max_seats=3), now=1
        )
        engine.join(state, "p2", "Bea", now=2)
        engine.join(state, "p3", "Cy", now=3)
        engine.start(state, "p1", now=4)
        hand = state["hand"]
        hand["street"] = "flop"
        hand["board"] = [engine._take_card(hand) for _ in range(3)]
        hand["folded"] = ["p3"]
        for seat in state["seats"]:
            seat["stack"] = 0 if seat["player_id"] == "p1" else 100
        engine._advance_street(state, now=5)

        self.assertEqual(
            {item["player_id"] for item in hand["revealed"]},
            {"p1", "p2"},
        )
        reveal = next(event for event in hand["events"] if event["type"] == "reveal")
        self.assertEqual({item["player_id"] for item in reveal["hands"]}, {"p1", "p2"})
        view = engine.public_view(state, "p2")
        p3 = next(seat for seat in view["seats"] if seat["id"] == "p3")
        self.assertNotIn("cards", p3)

    def test_event_history_is_ordered_bounded_and_has_real_payout_rows(self):
        state = heads_up()
        view = engine.public_view(state, "p1")
        events = view["events"]
        self.assertEqual([event["seq"] for event in events], [1, 2])
        self.assertEqual(events[0]["action"], "small_blind")
        self.assertEqual(events[1]["action"], "big_blind")
        self.assertEqual(events[0]["actor_label"], engine._seat_by_id(state, events[0]["actor"])["name"])
        self.assertIn("street_contribution", events[0])

        actor = state["hand"]["to_act"]
        opponent = "p2" if actor == "p1" else "p1"
        engine.apply_action(state, actor, "call", None, state["hand_no"], state["turn_version"], now=104)
        engine.apply_action(state, opponent, "check", None, state["hand_no"], state["turn_version"], now=105)
        events = engine.public_view(state, actor)["events"]
        types = [event["type"] for event in events]
        self.assertLess(types.index("action", 2), types.index("sweep"))
        self.assertLess(types.index("sweep"), types.index("street"))
        last_action = next(event for event in events if event.get("actor") == actor and event.get("action") == "call")
        self.assertEqual(last_action["amount"], 5)
        self.assertEqual(last_action["street_contribution"], 10)
        self.assertEqual(last_action["contribution"], 10)

        for _ in range(engine.MAX_HAND_EVENTS + 2):
            engine._record_event(state, state["hand"], "marker", street=state["hand"]["street"])
        view = engine.public_view(state, actor)
        self.assertEqual(len(view["events"]), engine.MAX_HAND_EVENTS)
        self.assertEqual(view["event_base_seq"], view["events"][0]["seq"])
        self.assertGreater(view["event_base_seq"], 1)

        bettor = state["hand"]["to_act"]
        engine.apply_action(state, bettor, "bet", 20, state["hand_no"], state["turn_version"], now=106)
        folder = state["hand"]["to_act"]
        engine.apply_action(state, folder, "fold", None, state["hand_no"], state["turn_version"], now=107)
        payout = next(event for event in reversed(state["hand"]["events"]) if event["type"] == "payout")
        self.assertEqual(len(payout["winners"]), 1)
        self.assertEqual(payout["winners"][0]["amount"], 20)
        self.assertEqual(len(payout["pots"]), 1)
        self.assertEqual(payout["pots"][0]["recipients"][0]["amount"], 20)
        self.assertEqual(payout["returns"][0]["amount"], 20)
        self.assertEqual(payout["return_total"], 20)
        self.assertEqual(payout["pot_total"], 40)
        self.assertEqual(sum(payout["payouts"].values()), 40)

    def test_legacy_runout_recovers_without_redealing_an_existing_flop(self):
        state = heads_up()
        hand = state["hand"]
        for seat in state["seats"]:
            seat["stack"] = 0 if seat["player_id"] == "p1" else 100
        hand["street"] = "flop"
        hand["board"] = [engine._take_card(hand) for _ in range(3)]
        hand["to_act"] = None
        hand["turn_deadline"] = None
        for key in ("runout_at", "runout_swept_street", "events", "event_seq", "event_base_seq", "hand_id", "revealed"):
            hand.pop(key, None)

        engine.advance(state, now=200)
        self.assertEqual(hand["street"], "flop")
        self.assertEqual(len(hand["board"]), 3)
        self.assertEqual(hand["runout_at"], 200 + engine.RUNOUT_SECONDS)
        self.assertEqual(len(hand["revealed"]), 2)
        engine.advance(state, now=hand["runout_at"])
        self.assertEqual(hand["street"], "turn")
        self.assertEqual(len(hand["board"]), 4)
        view = engine.public_view(state, "p2")
        self.assertEqual(view["hand_id"], "table-1:1")
        self.assertTrue(view["events"])

    def test_all_in_on_river_reveals_and_settles_without_a_ticker(self):
        state = heads_up()
        hand = state["hand"]
        hand["street"] = "river"
        hand["board"] = [engine._take_card(hand) for _ in range(5)]
        hand["to_act"] = None
        for seat in state["seats"]:
            seat["stack"] = 0 if seat["player_id"] == "p1" else 100

        engine._advance_street(state, now=200)
        self.assertEqual(hand["street"], "showdown")
        self.assertEqual(len(hand["board"]), 5)
        self.assertIsNone(hand["runout_at"])
        self.assertEqual({item["player_id"] for item in hand["revealed"]}, {"p1", "p2"})
        event_types = [event["type"] for event in hand["events"]]
        self.assertLess(event_types.index("reveal"), event_types.index("showdown_result"))

    def test_timeout_folds_when_facing_a_bet(self):
        state = heads_up(now=100)
        actor = state["hand"]["to_act"]
        deadline = state["hand"]["turn_deadline"]
        self.assertIn(actor, ("p1", "p2"))
        engine.advance(state, now=deadline + 0.1)
        self.assertIn(actor, state["hand"]["folded"])
        self.assertEqual(state["hand"]["street"], "showdown")
        self.assertTrue(any("timed out and folded" in item["text"] for item in state["action_log"]))

    def test_blind_expiry_waits_for_the_hand_boundary_and_preserves_legal_raise(self):
        state = heads_up(now=100)
        hand = state["hand"]
        deadline = state["blinds"]["next_level_at"]
        hand["turn_deadline"] = deadline + 1000

        engine.advance(state, now=deadline + 0.25)
        self.assertEqual(state["blinds"]["level"], 1)
        self.assertEqual((state["blinds"]["small"], state["blinds"]["big"]), (5, 10))
        self.assertEqual((hand["small_blind"], hand["big_blind"]), (5, 10))
        self.assertEqual(hand["min_raise"], 10)
        self.assertEqual(hand["to_act"], hand["button_id"])

        actor = hand["to_act"]
        engine.apply_action(
            state, actor, "raise", 20,
            state["hand_no"], state["turn_version"], now=deadline + 1,
        )
        opponent = hand["to_act"]
        engine.apply_action(
            state, opponent, "fold", None,
            state["hand_no"], state["turn_version"], now=deadline + 2,
        )

        self.assertEqual(hand["street"], "showdown")
        self.assertEqual((hand["small_blind"], hand["big_blind"]), (5, 10))
        self.assertEqual((state["blinds"]["level"], state["blinds"]["small"], state["blinds"]["big"]), (2, 10, 20))
        self.assertEqual(hand["next_hand_at"], deadline + 3.5)
        update = next(event for event in hand["events"] if event["type"] == "blind_level_updated")
        self.assertEqual((update["level"], update["small_blind"], update["big_blind"]), (2, 10, 20))
        view = engine.public_view(state, None)
        self.assertEqual(view["hand_blinds"], {"small": 5, "big": 10})
        self.assertEqual((view["blinds"]["small"], view["blinds"]["big"]), (10, 20))

        engine.advance(state, now=hand["next_hand_at"])
        self.assertEqual(state["hand_no"], 2)
        self.assertEqual((state["hand"]["small_blind"], state["hand"]["big_blind"]), (10, 20))

    def test_blind_expiry_during_showdown_pause_publishes_before_next_deal(self):
        state = heads_up(now=100)
        hand = state["hand"]
        deadline = state["blinds"]["next_level_at"]
        hand["turn_deadline"] = deadline + 1000
        actor = hand["to_act"]
        engine.apply_action(
            state, actor, "raise", 20,
            state["hand_no"], state["turn_version"], now=deadline - 12,
        )
        opponent = hand["to_act"]
        engine.apply_action(
            state, opponent, "fold", None,
            state["hand_no"], state["turn_version"], now=deadline - 11,
        )
        original_pause = hand["next_hand_at"]
        self.assertLess(original_pause, deadline)
        self.assertEqual(state["blinds"]["level"], 1)

        engine.advance(state, now=deadline)
        self.assertEqual(state["hand_no"], 1)
        self.assertEqual(hand["street"], "showdown")
        self.assertEqual(state["blinds"]["level"], 2)
        self.assertEqual(hand["next_hand_at"], deadline + engine.HAND_COMPLETE_PAUSE_SECONDS)
        self.assertTrue(any(event["type"] == "blind_level_updated" for event in hand["events"]))

        engine.advance(state, now=hand["next_hand_at"])
        self.assertEqual(state["hand_no"], 2)
        self.assertEqual(state["hand"]["big_blind"], 20)

    def test_long_runout_advances_only_one_level_and_waits_for_the_deal(self):
        state = engine.create_lobby(
            "blind-runout", "p1", "Ada",
            config(max_seats=3, starting_stack=100), now=100,
        )
        engine.join(state, "p2", "Bea", now=101, seat_no=1)
        engine.join(state, "p3", "Cy", now=102, seat_no=2)
        with patch.object(
            engine.random.SystemRandom, "choice",
            side_effect=lambda seats: next(seat for seat in seats if seat["player_id"] == "p1"),
        ):
            engine.start(state, "p1", now=103)
        hand = state["hand"]
        deadline = state["blinds"]["next_level_at"]
        hand["turn_deadline"] = deadline + 1000
        action_time = deadline + 180

        first = hand["to_act"]
        engine.apply_action(
            state, first, "all_in", None,
            state["hand_no"], state["turn_version"], now=action_time,
        )
        second = hand["to_act"]
        engine.apply_action(
            state, second, "call", None,
            state["hand_no"], state["turn_version"], now=action_time + 1,
        )
        third = hand["to_act"]
        self.assertIsNotNone(third)
        self.assertGreater(engine._to_call(hand, third), 0)
        engine.apply_action(
            state, third, "fold", None,
            state["hand_no"], state["turn_version"], now=action_time + 2,
        )
        self.assertIsNotNone(hand["runout_at"])
        self.assertEqual(state["blinds"]["level"], 1)

        while hand["street"] != "showdown":
            engine.advance(state, now=hand["runout_at"])
            if hand["street"] != "showdown":
                self.assertEqual(state["blinds"]["level"], 1)

        self.assertEqual(state["status"], "playing")
        self.assertEqual(state["blinds"]["level"], 2)
        self.assertEqual((state["blinds"]["small"], state["blinds"]["big"]), (10, 20))
        self.assertIsNone(state["blinds"]["next_level_at"])
        self.assertEqual(hand["big_blind"], 10)

    def test_each_level_waits_for_a_deal_even_after_delayed_polls_without_announcements(self):
        state = heads_up()
        for level in (2, 3):
            hand = state["hand"]
            expired_at = state["blinds"]["next_level_at"] + 300
            hand["turn_deadline"] = expired_at + 1000
            engine.apply_action(
                state, hand["to_act"], "fold", None,
                state["hand_no"], state["turn_version"], now=expired_at,
            )
            self.assertEqual(state["blinds"]["level"], level)
            self.assertIsNone(state["blinds"]["started_at"])
            self.assertIsNone(state["blinds"]["next_level_at"])
            deal_at = hand["next_hand_at"] + 300
            engine.advance(state, now=deal_at)
            self.assertEqual(state["blinds"]["level"], level)
            self.assertEqual(state["hand"]["big_blind"], 10 * 2 ** (level - 1))
            self.assertEqual(state["blinds"]["started_at"], deal_at)
            self.assertEqual(state["blinds"]["next_level_at"], deal_at + 60)
            self.assertFalse(engine.public_view(state, None)["blinds"]["waiting_for_hand"])

            # Further hands at the same level must not restart its timer.
            next_hand = state["hand"]
            engine.apply_action(
                state, next_hand["to_act"], "fold", None,
                state["hand_no"], state["turn_version"], now=deal_at + 1,
            )
            engine.advance(state, now=next_hand["next_hand_at"])
            self.assertEqual(state["blinds"]["next_level_at"], deal_at + 60)

    def test_pausing_and_editing_pending_level_keeps_clock_waiting_for_deal(self):
        state = heads_up()
        deadline = state["blinds"]["next_level_at"]
        hand = state["hand"]
        hand["turn_deadline"] = deadline + 1000
        engine.apply_action(
            state, hand["to_act"], "fold", None,
            state["hand_no"], state["turn_version"], now=deadline + 1,
        )
        engine.pause_table(state, "p1", True, now=deadline + 1.1)
        engine.update_runtime_settings(state, "p1", {"level_minutes": 2}, now=deadline + 10)
        engine.advance(state, now=deadline + 300)
        self.assertIsNone(state["blinds"]["started_at"])
        self.assertIsNone(state["blinds"]["next_level_at"])
        engine.pause_table(state, "p1", False, now=deadline + 300)
        deal_at = hand["next_hand_at"] + 100
        engine.advance(state, now=deal_at)
        self.assertEqual(state["blinds"]["level"], 2)
        self.assertEqual(state["blinds"]["started_at"], deal_at)
        self.assertEqual(state["blinds"]["next_level_at"], deal_at + 120)

    def test_final_tournament_hand_does_not_apply_pending_blind_level(self):
        state = heads_up(now=100, starting_stack=100)
        hand = state["hand"]
        deadline = state["blinds"]["next_level_at"]
        hand["turn_deadline"] = deadline + 1000
        actor = hand["to_act"]
        engine.apply_action(
            state, actor, "all_in", None,
            state["hand_no"], state["turn_version"], now=deadline + 1,
        )
        opponent = hand["to_act"]
        engine.apply_action(
            state, opponent, "call", None,
            state["hand_no"], state["turn_version"], now=deadline + 2,
        )
        self.assertIsNotNone(hand["runout_at"])
        while state["status"] == "playing":
            engine.advance(state, now=hand["runout_at"])

        self.assertEqual(state["status"], "completed")
        self.assertEqual(state["blinds"]["level"], 1)
        self.assertFalse(any(event["type"] == "blind_level_updated" for event in hand["events"]))
        self.assertIsNone(hand["next_hand_at"])

    def test_rank_evaluator_handles_wheel_and_full_house(self):
        wheel = ["As", "2d", "3h", "4c", "5s"]
        six_high = ["2s", "3d", "4h", "5c", "6s"]
        self.assertEqual(engine.rank_five(wheel), (4, 5))
        self.assertGreater(engine.rank_five(six_high), engine.rank_five(wheel))
        full_house = ["As", "Ah", "Ad", "Ks", "Kh"]
        self.assertEqual(engine.rank_five(full_house), (6, 14, 13))
        straight_flush = ["9s", "Ts", "Js", "Qs", "Ks", "2d", "3c"]
        self.assertEqual(engine.rank_seven(straight_flush), (8, 13))

    def test_side_pots_return_uncalled_top_layer(self):
        state = engine.create_lobby(
            "table-3", "p1", "Ada", config(max_seats=3), now=1
        )
        engine.join(state, "p2", "Bea", now=2)
        engine.join(state, "p3", "Cy", now=3)
        engine.start(state, "p1", now=4)
        seats = {seat["player_id"]: seat for seat in state["seats"]}
        seats["p1"]["stack"] = 900
        seats["p2"]["stack"] = 800
        seats["p3"]["stack"] = 800
        state["hand"] = {
            "number": 1,
            "street": "river",
            "board": ["Qs", "Js", "Ts", "2d", "2c"],
            "deck": [],
            "holes": {
                "p1": ["As", "Ks"],
                "p2": ["Ah", "Ad"],
                "p3": ["Qh", "Qc"],
            },
            "bets": {"p1": 0, "p2": 0, "p3": 0},
            "contrib": {"p1": 100, "p2": 200, "p3": 200},
            "folded": ["p3"],
            "acted": [],
            "current_bet": 0,
            "min_raise": 10,
            "button_id": "p1",
            "small_blind_id": "p2",
            "big_blind_id": "p3",
            "to_act": None,
            "turn_deadline": None,
            "stack_before": {"p1": 1000, "p2": 1000, "p3": 1000},
            "showdown": [],
            "payouts": {},
            "next_hand_at": None,
            "small_blind": 5,
            "big_blind": 10,
        }
        engine._settle_showdown(state, now=10)
        self.assertEqual(state["hand"]["payouts"], {"p1": 300, "p2": 200, "p3": 0})
        self.assertEqual(seats["p1"]["stack"], 1200)
        self.assertEqual(seats["p2"]["stack"], 1000)
        self.assertEqual(seats["p3"]["stack"], 800)
        self.assertEqual(
            {item["player_id"]: item["rank"] for item in state["hand"]["showdown"]},
            {"p1": "Ace-high straight flush", "p2": "Two pair, aces and twos"},
        )
        result = next(
            event for event in state["hand"]["events"]
            if event["type"] == "showdown_result"
        )
        self.assertEqual(result["payouts"], {"p1": 300, "p2": 200, "p3": 0})
        self.assertEqual(
            {item["player_id"]: item["amount"] for item in result["winners"]},
            {"p1": 300, "p2": 200},
        )

    def test_tied_pot_odd_chip_goes_left_of_button(self):
        state = engine.create_lobby(
            "table-4", "p1", "Ada", config(max_seats=3), now=1
        )
        engine.join(state, "p2", "Bea", now=2)
        engine.join(state, "p3", "Cy", now=3)
        engine.start(state, "p1", now=4)
        hand = state["hand"]
        hand.update(
            {
                "board": ["2s", "3d", "4h", "5c", "9s"],
                "holes": {
                    "p1": ["As", "Kc"],
                    "p2": ["Ah", "Qc"],
                    "p3": ["Kd", "Kh"],
                },
                "contrib": {"p1": 34, "p2": 34, "p3": 33},
                "folded": ["p3"],
                "button_id": "p1",
            }
        )
        payouts = engine._split_side_pots(state, hand, now=5)
        self.assertEqual(payouts, {"p1": 50, "p2": 51, "p3": 0})

    def test_buy_in_and_payout_settings_validate_and_serialize(self):
        state = engine.create_lobby("defaults", "p1", "Ada", config(), now=1)
        self.assertEqual(state["config"]["buy_in"], 10)
        self.assertEqual(state["config"]["payout_percentages"], [60, 25, 15])
        view = engine.public_view(state, "p1")
        self.assertEqual(view["config"]["buy_in"], 10)
        self.assertEqual(view["config"]["payout_percentages"], [60, 25, 15])
        summary = engine.summary(state, "p1")
        self.assertEqual(summary["buy_in"], 10)
        self.assertEqual(summary["payout_percentages"], [60, 25, 15])
        self.assertEqual(summary["entrant_count"], 1)
        self.assertEqual(summary["prize_pool_cents"], 1000)

        nine_places = [25, 20, 15, 10, 8, 7, 6, 5, 4]
        engine.update_settings(state, "p1", {
            "buy_in": 0,
            "payout_percentages": nine_places,
        }, now=2)
        self.assertEqual(state["config"]["buy_in"], 0)
        self.assertEqual(state["config"]["payout_percentages"], nine_places)
        self.assertEqual(engine.summary(state)["prize_pool_cents"], 0)

        invalid_schedules = [
            [],
            [100] * 10,
            [60, 39],
            [True, 99],
            [-1, 101],
            [50, 25, 20],
        ]
        for percentages in invalid_schedules:
            with self.subTest(percentages=percentages):
                with self.assertRaises(engine.GameError) as caught:
                    engine.create_lobby(
                        "bad-payout", "p1", "Ada",
                        config(payout_percentages=percentages), now=1,
                    )
                self.assertEqual(caught.exception.code, "invalid_config")
        for buy_in in (True, -1, 1.5):
            with self.subTest(buy_in=buy_in):
                with self.assertRaises(engine.GameError) as caught:
                    engine.create_lobby(
                        "bad-buyin", "p1", "Ada", config(buy_in=buy_in), now=1,
                    )
                self.assertEqual(caught.exception.code, "invalid_config")

    def test_legacy_settings_default_without_fabricating_completed_awards(self):
        state = engine.create_lobby("legacy", "p1", "Ada", config(), now=1)
        state["config"].pop("buy_in")
        state["config"].pop("payout_percentages")
        state["status"] = "completed"
        state["results"] = [{
            "player_id": "p1", "name": "Ada", "place": 1, "chips": 1000,
        }]
        legacy_results = [dict(result) for result in state["results"]]
        engine._set_results(state, "p1", now=2)
        self.assertEqual(state["results"], legacy_results)

        view = engine.public_view(state, "p1")
        self.assertEqual(view["config"]["buy_in"], 10)
        self.assertEqual(view["config"]["payout_percentages"], [60, 25, 15])
        self.assertNotIn("award_cents", view["standings"][0])
        self.assertNotIn("award_cents", view["results"][0])
        self.assertIsNone(view["prize"])
        self.assertIsNone(view["prize_pool_cents"])
        self.assertIsNone(engine.summary(state)["prize_pool_cents"])

        legacy_lobby = engine.create_lobby("legacy-lobby", "p1", "Ada", config(), now=1)
        legacy_lobby["config"].pop("buy_in")
        legacy_lobby["config"].pop("payout_percentages")
        engine.join(legacy_lobby, "p2", "Bea", now=2)
        engine.start(legacy_lobby, "p1", now=3)
        self.assertEqual(legacy_lobby["config"]["buy_in"], 10)
        self.assertEqual(legacy_lobby["prize"]["pool_cents"], 2000)

    def test_tournament_awards_conserve_pool_and_combine_tied_places(self):
        state = engine.create_lobby(
            "awards", "p1", "Ada", config(max_seats=3), now=1
        )
        engine.join(state, "p2", "Bea", now=2)
        engine.join(state, "p3", "Cy", now=3)
        engine.start(state, "p1", now=4)
        view = engine.public_view(state, "p1")
        self.assertEqual(view["entrant_count"], 3)
        self.assertEqual(view["prize_pool_cents"], 3000)
        self.assertEqual(view["prize"]["buy_in"], 10)
        hand = state["hand"]
        for seat in state["seats"]:
            seat["stack"] = 0 if seat["player_id"] in ("p2", "p3") else 1000
        hand["stack_before"] = {"p1": 1000, "p2": 1000, "p3": 1000}
        newly_out = engine._record_eliminations(state, hand, now=5)
        self.assertEqual({item["player_id"]: item["place"] for item in newly_out}, {"p2": 2, "p3": 2})
        self.assertEqual({item["award_cents"] for item in newly_out}, {600})
        engine._set_results(state, "p1", now=6)

        awards = {item["player_id"]: item["award_cents"] for item in state["results"]}
        self.assertEqual(awards, {"p1": 1800, "p2": 600, "p3": 600})
        self.assertEqual(sum(awards.values()), state["prize"]["pool_cents"])
        standings = {item["player_id"]: item for item in engine.public_view(state, "p1")["standings"]}
        self.assertEqual({player_id: row["award_cents"] for player_id, row in standings.items()}, awards)

    def test_tied_award_floors_whole_credits_and_small_fields_renormalize(self):
        state = engine.create_lobby(
            "odd-award", "p1", "Ada",
            config(max_seats=3, buy_in=1, payout_percentages=[33, 33, 34]),
            now=1,
        )
        engine.join(state, "p2", "Bea", now=2)
        engine.join(state, "p3", "Cy", now=3)
        engine.start(state, "p1", now=4)
        hand = state["hand"]
        for seat in state["seats"]:
            seat["stack"] = 0 if seat["player_id"] in ("p2", "p3") else 1000
        hand["stack_before"] = {"p1": 1000, "p2": 1000, "p3": 1000}
        engine._record_eliminations(state, hand, now=5)
        tie_awards = {item["player_id"]: item["award_cents"] for item in state["elimination_order"]}
        self.assertEqual(set(tie_awards.values()), {100})
        self.assertEqual(sum(tie_awards.values()), 200)
        engine._set_results(state, "p1", now=6)
        completed_awards = {item["player_id"]: item["award_cents"] for item in state["results"]}
        self.assertEqual(completed_awards, {"p1": 100, "p2": 100, "p3": 100})
        self.assertEqual(sum(completed_awards.values()), state["prize"]["pool_cents"])

        two_player = engine.create_lobby(
            "short-field", "p1", "Ada",
            config(max_seats=2, buy_in=10),
            now=1,
        )
        engine.join(two_player, "p2", "Bea", now=2)
        engine.start(two_player, "p1", now=3)
        short_hand = two_player["hand"]
        for seat in two_player["seats"]:
            seat["stack"] = 0 if seat["player_id"] == "p2" else 1000
        short_hand["stack_before"] = {"p1": 1000, "p2": 1000}
        engine._record_eliminations(two_player, short_hand, now=4)
        engine._set_results(two_player, "p1", now=5)
        short_awards = {item["player_id"]: item["award_cents"] for item in two_player["results"]}
        self.assertEqual(short_awards, {"p1": 1500, "p2": 500})
        self.assertEqual(sum(short_awards.values()), two_player["prize"]["pool_cents"])
        self.assertEqual(engine.summary(two_player)["entrant_count"], 2)
        self.assertEqual(engine.summary(two_player)["prize_pool_cents"], 2000)

    def test_finalizing_in_progress_recalculates_old_ties_and_conserves_whole_credits(self):
        state = engine.create_lobby(
            "mid-game-payout-upgrade", "p1", "Ada",
            config(
                max_seats=5,
                buy_in=3,
                payout_percentages=[40, 30, 20, 10],
            ),
            now=1,
        )
        for player_id, name in (("p2", "Bea"), ("p3", "Cy"), ("p4", "Dee"), ("p5", "Eli")):
            engine.join(state, player_id, name, now=2)
        engine.start(state, "p1", now=3)
        hand = state["hand"]
        hand["stack_before"] = {
            "p1": 1000, "p2": 900, "p3": 900, "p4": 800, "p5": 800,
        }

        for player_id in ("p4", "p5"):
            engine._seat_by_id(state, player_id)["stack"] = 0
        engine._record_eliminations(state, hand, now=4)
        self.assertEqual(
            {item["player_id"]: item["place"] for item in state["elimination_order"]},
            {"p4": 4, "p5": 4},
        )

        for player_id in ("p2", "p3"):
            engine._seat_by_id(state, player_id)["stack"] = 0
        engine._record_eliminations(state, hand, now=5)
        self.assertEqual(
            {item["player_id"]: item["place"] for item in state["elimination_order"]},
            {"p4": 4, "p5": 4, "p2": 2, "p3": 2},
        )

        # Simulate awards saved by the old cent-based tie splitter.
        for index, item in enumerate(state["elimination_order"]):
            item["award_cents"] = 101 + index
        engine._set_results(state, "p1", now=6)

        awards = {item["player_id"]: item["award_cents"] for item in state["results"]}
        self.assertEqual(awards, {"p1": 900, "p2": 300, "p3": 300, "p4": 0, "p5": 0})
        self.assertTrue(all(amount % 100 == 0 for amount in awards.values()))
        self.assertEqual(sum(awards.values()), state["prize"]["pool_cents"])
        self.assertEqual(
            {item["player_id"]: item["award_cents"] for item in state["elimination_order"]},
            {"p4": 0, "p5": 0, "p2": 300, "p3": 300},
        )

    def test_malformed_prize_snapshots_do_not_create_awards(self):
        state = engine.create_lobby("bad-prize", "p1", "Ada", config(), now=1)
        engine.join(state, "p2", "Bea", now=2)
        engine.start(state, "p1", now=3)
        valid = dict(state["prize"])
        malformed = [
            dict(valid, pool_cents=True),
            dict(valid, pool_cents=1),
            dict(valid, entrants=False),
            dict(valid, payout_percentages=[True, 99]),
            dict(valid, payout_percentages=[101]),
        ]
        for prize in malformed:
            with self.subTest(prize=prize):
                state["prize"] = prize
                self.assertIsNone(engine._prize_awards_for_group(state, 2, ["p2"]))
        state["prize"] = valid

    def test_unreachable_payout_weights_award_the_pool_to_the_winner(self):
        state = engine.create_lobby(
            "unreachable", "p1", "Ada",
            config(max_seats=2, buy_in=10, payout_percentages=[0, 0, 100]),
            now=1,
        )
        engine.join(state, "p2", "Bea", now=2)
        engine.start(state, "p1", now=3)
        hand = state["hand"]
        engine._seat_by_id(state, "p2")["stack"] = 0
        engine._seat_by_id(state, "p1")["stack"] = 1000
        hand["stack_before"] = {"p1": 1000, "p2": 1000}
        engine._record_eliminations(state, hand, now=4)
        engine._set_results(state, "p1", now=5)
        awards = {item["player_id"]: item["award_cents"] for item in state["results"]}
        self.assertEqual(awards, {"p1": 2000, "p2": 0})
        self.assertEqual(state["elimination_order"][0]["award_cents"], 0)
        self.assertEqual(sum(awards.values()), state["prize"]["pool_cents"])

    def test_invalid_config_rejected(self):
        with self.assertRaises(engine.GameError) as caught:
            engine.create_lobby(
                "bad", "p1", "Ada", config(max_seats=10), now=1
            )
        self.assertEqual(caught.exception.code, "invalid_config")

    def test_short_big_blind_keeps_nominal_bring_in_for_other_active_players(self):
        state = engine.create_lobby(
            "short-bb", "p1", "Ada", config(max_seats=3), now=1
        )
        engine.join(state, "p2", "Bea", now=2, seat_no=1)
        engine.join(state, "p3", "Cy", now=2.5, seat_no=2)
        engine._seat_by_id(state, "p2")["stack"] = 3
        with patch.object(engine.random.SystemRandom, "shuffle", side_effect=lambda values: None):
            with patch.object(
                engine.random.SystemRandom,
                "choice",
                side_effect=lambda seats: next(seat for seat in seats if seat["player_id"] == "p3"),
            ):
                engine.start(state, "p1", now=3)
        hand = state["hand"]
        self.assertEqual(hand["button_id"], "p3")
        self.assertEqual(hand["small_blind_id"], "p1")
        self.assertEqual(hand["big_blind_id"], "p2")
        self.assertEqual(hand["bets"], {"p1": 5, "p2": 3, "p3": 0})
        self.assertEqual(hand["current_bet"], 10)
        self.assertEqual(hand["to_act"], "p3")
        self.assertEqual(engine._to_call(hand, "p3"), 10)

    def test_short_all_in_big_blind_does_not_force_unmatched_nominal_call(self):
        state = engine.create_lobby("short-bb-runout", "p1", "Ada", config(), now=1)
        engine.join(state, "p2", "Bea", now=2)
        engine._seat_by_id(state, "p2")["stack"] = 3
        with patch.object(
            engine.random.SystemRandom, "choice",
            side_effect=lambda seats: next(seat for seat in seats if seat["player_id"] == "p1"),
        ):
            engine.start(state, "p1", now=3)

        hand = state["hand"]
        self.assertEqual(hand["current_bet"], 0)
        self.assertEqual(hand["street"], "preflop")
        self.assertIsNone(hand["to_act"])
        self.assertIsNotNone(hand["runout_at"])
        self.assertNotIn("p1", hand["folded"])
        while hand["street"] != "showdown":
            engine.advance(state, now=hand["runout_at"])

        self.assertEqual(hand["street"], "showdown")
        self.assertEqual(hand["returns"][0]["player_id"], "p1")
        self.assertEqual(hand["returns"][0]["amount"], 2)
        self.assertEqual(sum(seat["stack"] for seat in state["seats"]), 1003)

    def test_only_player_with_chips_can_call_then_board_runs_without_dry_betting(self):
        state = engine.create_lobby(
            "dry-side", "p1", "Ada", config(starting_stack=100), now=100
        )
        engine.join(state, "p2", "Bea", now=101)
        engine._seat_by_id(state, "p2")["stack"] = 10
        with patch.object(
            engine.random.SystemRandom,
            "choice",
            side_effect=lambda seats: next(seat for seat in seats if seat["player_id"] == "p1"),
        ):
            engine.start(state, "p1", now=102)
        view = engine.public_view(state, "p1")
        self.assertTrue(view["viewer"]["can_act"])
        self.assertFalse(view["viewer"]["raise_rights"])
        self.assertIsNone(view["viewer"]["min_raise_to"])
        with self.assertRaises(engine.GameError) as caught:
            engine.apply_action(
                state, "p1", "raise", 30,
                state["hand_no"], state["turn_version"], now=104
            )
        self.assertEqual(caught.exception.code, "dry_side_pot")

        engine.apply_action(
            state, "p1", "call", None,
            state["hand_no"], state["turn_version"], now=105
        )
        self.assertEqual(state["hand"]["street"], "preflop")
        self.assertEqual(state["hand"]["board"], [])
        self.assertIsNone(state["hand"]["to_act"])
        self.assertEqual(state["hand"]["runout_at"], 107.5)
        revealed = {item["player_id"] for item in state["hand"]["revealed"]}
        self.assertEqual(revealed, {"p1", "p2"})
        while state["hand"]["street"] != "showdown":
            engine.advance(state, now=state["hand"]["runout_at"])
        self.assertEqual(len(state["hand"]["board"]), 5)
        self.assertIsNone(state["hand"]["to_act"])
        self.assertIn(state["status"], ("playing", "completed"))

    def test_previous_checker_can_raise_over_short_opening_all_in(self):
        state = engine.create_lobby(
            "short-open", "p1", "Ada", config(max_seats=3), now=1
        )
        engine.join(state, "p2", "Bea", now=2)
        engine.join(state, "p3", "Cy", now=3)
        engine.start(state, "p1", now=4)
        button = state["hand"]["button_id"]
        small = state["hand"]["small_blind_id"]
        big = state["hand"]["big_blind_id"]

        # Complete preflop betting in the actual randomized order.
        for player_id, action, amount in (
            (button, "call", None),
            (small, "call", None),
            (big, "check", None),
        ):
            engine.apply_action(
                state, player_id, action, amount,
                state["hand_no"], state["turn_version"], now=5
            )
        self.assertEqual(state["hand"]["street"], "flop")
        self.assertEqual(state["hand"]["to_act"], small)

        # The small blind checks, then the big blind can only wager five chips,
        # below the ten-chip minimum opening bet. The button must still raise.
        engine.apply_action(
            state, small, "check", None,
            state["hand_no"], state["turn_version"], now=6
        )
        engine._seat_by_id(state, big)["stack"] = 5
        engine.apply_action(
            state, big, "all_in", None,
            state["hand_no"], state["turn_version"], now=7
        )
        engine.apply_action(
            state, button, "call", None,
            state["hand_no"], state["turn_version"], now=8
        )
        self.assertEqual(state["hand"]["to_act"], small)
        view = engine.public_view(state, small)
        self.assertTrue(view["viewer"]["raise_rights"])
        self.assertEqual(view["viewer"]["min_raise_to"], 15)
        engine.apply_action(
            state, small, "raise", 15,
            state["hand_no"], state["turn_version"], now=9
        )
        self.assertEqual(state["hand"]["current_bet"], 15)

    def test_cumulative_short_all_ins_reopen_raise_right(self):
        hand = {
            "current_bet": 105,
            "min_raise": 10,
            "acted_at_bet": {"p1": 100},
            "short_opening": False,
        }
        self.assertFalse(engine._has_raise_right(hand, "p1"))
        hand["current_bet"] = 110
        self.assertTrue(engine._has_raise_right(hand, "p1"))

    def test_paused_legacy_showdown_migrates_at_frozen_time_and_hides_future_notice(self):
        state = heads_up()
        hand = state["hand"]
        state["config"]["showdown_seconds"] = 5
        state["config"]["elimination_announcement_seconds"] = 4
        state["config"]["blind_announcement_seconds"] = 5
        hand.update({
            "street": "showdown",
            "showdown": [{"player_id": "p1", "name": "Ada", "cards": ["As", "Ah"],
                           "rank": "One pair"}],
            "hand_complete_at": 102,
            "next_hand_at": 107,
        })
        for key in ("presentation_version", "showdown_started_at", "showdown_until", "presentation_until"):
            hand.pop(key, None)
        state["elimination_announcement"] = {"players": [], "until": 107}
        state["blind_announcement"] = {"level": 2, "small": 10, "big": 20, "until": 109}
        state["paused"] = True
        state["paused_at"] = 106

        engine.advance(state, now=1000)
        normalized = dict(state["elimination_announcement"])
        version = state["version"]
        engine.advance(state, now=1001)
        self.assertEqual(state["version"], version)
        self.assertEqual(normalized, state["elimination_announcement"])
        self.assertEqual(hand["presentation_version"], 2)
        self.assertEqual(hand["showdown_until"], 105.5)
        self.assertEqual(state["elimination_announcement"]["starts_at"], 105.5)
        self.assertEqual(state["elimination_announcement"]["until"], 109.5)
        self.assertEqual(state["blind_announcement"]["starts_at"], 109.5)
        with patch("engine.time.time", return_value=1000):
            view = engine.public_view(state, "p1")
        self.assertIsNotNone(view["elimination_announcement"])
        self.assertIsNone(view["blind_announcement"])
        self.assertEqual(hand["next_hand_at"], 114.5)

    def test_button_avoids_consecutive_big_blind_when_button_busts_three_to_two(self):
        state = engine.create_lobby(
            "transition", "p1", "Ada", config(max_seats=3), now=1
        )
        engine.join(state, "p2", "Bea", now=2)
        engine.join(state, "p3", "Cy", now=3)
        engine.start(state, "p1", now=4)
        old_hand = state["hand"]
        old_button = old_hand["button_id"]
        old_big_blind = old_hand["big_blind_id"]
        self.assertIn(old_button, {"p1", "p2", "p3"})
        self.assertIn(old_big_blind, {"p1", "p2", "p3"})
        engine._seat_by_id(state, old_button)["stack"] = 0
        old_hand["street"] = "showdown"
        old_hand["to_act"] = None
        old_hand["turn_deadline"] = None
        old_hand["next_hand_at"] = 10
        old_hand["hand_complete_at"] = 10
        old_hand["presentation_until"] = 10
        old_hand["presentation_version"] = 2
        engine.advance(state, now=11)
        self.assertEqual(state["hand_no"], 2)
        self.assertEqual(state["hand"]["button_id"], old_big_blind)
        self.assertEqual(state["hand"]["small_blind_id"], old_big_blind)
        self.assertNotEqual(state["hand"]["big_blind_id"], old_button)

    def test_simultaneous_bust_orders_larger_stack_higher(self):
        state = engine.create_lobby(
            "bust-order", "p1", "Ada", config(max_seats=3), now=1
        )
        engine.join(state, "p2", "Bea", now=2)
        engine.join(state, "p3", "Cy", now=3)
        engine.start(state, "p1", now=4)
        hand = state["hand"]
        hand["stack_before"] = {"p1": 100, "p2": 200, "p3": 300}
        engine._seat_by_id(state, "p1")["stack"] = 0
        engine._seat_by_id(state, "p2")["stack"] = 0
        engine._seat_by_id(state, "p3")["stack"] = 300
        engine._record_eliminations(state, hand, now=10)
        places = {item["player_id"]: item["place"] for item in state["elimination_order"]}
        self.assertEqual(places, {"p1": 3, "p2": 2})

    def test_lobby_leave_reassigns_host_and_empty_lobby_closes(self):
        state = engine.create_lobby(
            "leaving", "p1", "Ada", config(), now=1
        )
        engine.join(state, "p2", "Bea", now=2)
        engine.leave(state, "p1", now=3)
        self.assertEqual(state["host_id"], "p2")
        self.assertEqual(state["host_name"], "Bea")
        self.assertEqual(state["seats"][0]["player_id"], "p2")
        self.assertTrue(engine.summary(state, "p2")["viewer_seated"])
        engine.leave(state, "p2", now=4)
        self.assertEqual(state["status"], "cancelled")
        self.assertEqual(state["cancellation_reason"], "empty")

    def test_host_end_aborts_without_payout_and_stops_all_deadlines(self):
        state = heads_up()
        hand = state["hand"]
        hand["runout_at"] = 120
        hand["bot_action_at"] = 121
        hand["turn_deadline"] = 122
        hand["hand_complete_at"] = 123
        hand["next_hand_at"] = 124

        with self.assertRaises(engine.GameError) as caught:
            engine.end_tournament(state, "p2", now=110)
        self.assertEqual(caught.exception.code, "host_only")

        engine.end_tournament(state, "p1", now=111)
        self.assertEqual(state["status"], "ended")
        self.assertEqual(state["end_reason"], "host_aborted")
        self.assertFalse(state["paused"])
        self.assertIsNone(hand["to_act"])
        for key in (
            "turn_deadline", "bot_action_at", "runout_at", "hand_complete_at",
            "next_hand_at", "showdown_until", "presentation_until",
            "blind_transition_until",
        ):
            self.assertIsNone(hand[key])
        self.assertEqual(state["results"], [])
        view = engine.public_view(state, "p1")
        opponent = next(seat for seat in view["seats"] if seat["id"] == "p2")
        self.assertNotIn("cards", opponent)
        version = state["version"]
        engine.advance(state, now=10_000)
        self.assertEqual(state["status"], "ended")
        self.assertEqual(state["version"], version)

    def test_start_normalizes_payout_places_and_locks_field_capacity(self):
        state = engine.create_lobby(
            "payout-normalize", "p1", "Ada",
            config(max_seats=9, payout_percentages=[60, 25, 15]), now=1,
        )
        engine.join(state, "p2", "Bea", now=2, seat_no=8)
        engine.start(state, "p1", now=3)
        self.assertEqual(state["config"]["max_seats"], 2)
        self.assertEqual(state["config"]["payout_percentages"], [71, 29])
        self.assertEqual(state["prize"]["payout_percentages"], [71, 29])
        self.assertEqual(sorted(seat["seat_no"] for seat in state["seats"]), [0, 1])

    def test_host_can_cancel_and_idle_lobbies_expire(self):
        cancelled = engine.create_lobby(
            "cancelled", "p1", "Ada", config(), now=1
        )
        with self.assertRaises(engine.GameError) as caught:
            engine.cancel(cancelled, "p2", now=2)
        self.assertEqual(caught.exception.code, "host_only")
        engine.cancel(cancelled, "p1", now=3)
        self.assertEqual(cancelled["status"], "cancelled")

        expired = engine.create_lobby(
            "expired", "p1", "Ada", config(), now=10
        )
        engine.join(expired, "p2", "Bea", now=20)
        engine.advance(expired, now=20 + engine.LOBBY_IDLE_SECONDS - 1)
        self.assertEqual(expired["status"], "lobby")
        engine.advance(expired, now=20 + engine.LOBBY_IDLE_SECONDS)
        self.assertEqual(expired["status"], "expired")
        self.assertEqual(expired["cancellation_reason"], "idle")

    def test_fold_is_illegal_when_check_is_free_for_players_bots_and_timeouts(self):
        state = heads_up()
        hand = state["hand"]
        for _ in range(2):
            actor = hand["to_act"]
            action = "call" if engine._to_call(hand, actor) else "check"
            engine.apply_action(
                state, actor, action, None,
                state["hand_no"], state["turn_version"], now=104 + _,
            )
        hand = state["hand"]
        actor = hand["to_act"]
        self.assertEqual(engine._to_call(hand, actor), 0)
        with self.assertRaises(engine.GameError) as caught:
            engine.apply_action(
                state, actor, "fold", None,
                state["hand_no"], state["turn_version"], now=107,
            )
        self.assertEqual(caught.exception.code, "cannot_fold")

        from types import SimpleNamespace
        engine._seat_by_id(state, actor)["is_bot"] = True
        policy = SimpleNamespace(choose_action=lambda context, rank_hand, rng=None: ("fold", None))
        with patch.dict("sys.modules", {"bot_strategy": policy}):
            bot_action, amount = engine._choose_bot_action(state, hand, actor)
        self.assertEqual((bot_action, amount), ("check", None))

        engine._seat_by_id(state, actor)["is_bot"] = False
        hand["turn_deadline"] = 108
        engine.advance(state, now=108)
        self.assertNotIn(actor, hand["folded"])
        timeout = next(
            event for event in reversed(hand["events"])
            if event.get("actor") == actor and event.get("timed_out")
        )
        self.assertEqual(timeout["action"], "check")

    def test_bot_adapter_passes_only_hero_and_public_state(self):
        from types import SimpleNamespace

        state = heads_up()
        hand = state["hand"]
        actor = hand["to_act"]
        opponent = next(player_id for player_id in hand["holes"] if player_id != actor)
        engine._seat_by_id(state, actor)["is_bot"] = True
        captured = {}

        def choose(context, rank_hand, rng=None):
            captured.update(context=context, rank_hand=rank_hand, rng=rng)
            return "call", None

        with patch.dict("sys.modules", {"bot_strategy": SimpleNamespace(choose_action=choose)}):
            action = engine._choose_bot_action(state, hand, actor)

        context = captured["context"]
        self.assertEqual(action, ("call", None))
        self.assertEqual(set(context), {
            "street", "hole_cards", "board", "hero_seat", "button_seat",
            "players", "small_blind", "big_blind", "pot", "current_bet",
            "min_raise", "raise_allowed",
        })
        self.assertEqual(context["hole_cards"], hand["holes"][actor])
        self.assertNotIn(hand["holes"][opponent][0], context["hole_cards"])
        self.assertTrue(all(set(item) == {"seat", "stack", "street_bet", "folded", "all_in"}
                            for item in context["players"]))
        self.assertFalse(any("player_id" in item or "cards" in item or "name" in item
                             for item in context["players"]))
        self.assertIs(captured["rank_hand"], engine._rank_seven_fast)
        self.assertIsNotNone(captured["rng"])

    def test_completed_hand_keeps_only_revealed_cards_public_to_every_viewer(self):
        state = heads_up()
        hand = state["hand"]
        folded, revealed = list(hand["holes"])
        hand["street"] = "showdown"
        hand["folded"] = [folded]
        hand["showdown"] = [{
            "player_id": revealed,
            "name": engine._seat_by_id(state, revealed)["name"],
            "cards": list(hand["holes"][revealed]),
        }]
        hand["revealed"] = []
        state["status"] = "completed"

        for viewer_id in (None, folded, revealed):
            view = engine.public_view(state, viewer_id)
            seats = {seat["id"]: seat for seat in view["seats"]}
            self.assertTrue(seats[folded]["in_hand"])
            self.assertTrue(seats[revealed]["in_hand"])
            self.assertEqual(seats[revealed]["cards"], hand["holes"][revealed])
            if viewer_id != folded:
                self.assertNotIn("cards", seats[folded])
            else:
                self.assertEqual(seats[folded]["cards"], hand["holes"][folded])

    def test_sitting_out_current_actor_folds_now_and_return_does_not_unfold(self):
        state = heads_up()
        hand = state["hand"]
        actor = hand["to_act"]
        hand["turn_deadline"] = 1000

        engine.set_sitting_out(state, actor, True, now=104)
        self.assertTrue(engine._seat_by_id(state, actor)["sitting_out"])
        self.assertIn(actor, hand["folded"])
        self.assertNotEqual(hand["to_act"], actor)
        fold = next(
            event for event in reversed(hand["events"])
            if event.get("actor") == actor and event["type"] == "action"
        )
        self.assertTrue(fold["sitting_out"])
        self.assertEqual(fold["action"], "fold")

        engine.set_sitting_out(state, actor, False, now=105)
        self.assertFalse(engine._seat_by_id(state, actor)["sitting_out"])
        self.assertIn(actor, hand["folded"])
        seat = next(item for item in engine.public_view(state, actor)["seats"] if item["id"] == actor)
        self.assertTrue(seat["in_hand"])
        self.assertTrue(seat["folded"])

    def test_future_sitting_out_actor_folds_a_bet_without_waiting(self):
        state = heads_up()
        hand = state["hand"]
        actor = hand["to_act"]
        other = next(player_id for player_id in hand["holes"] if player_id != actor)
        engine.set_sitting_out(state, other, True, now=103)

        engine.apply_action(
            state, actor, "raise", hand["current_bet"] + hand["min_raise"],
            state["hand_no"], state["turn_version"], now=104,
        )
        self.assertEqual(hand["street"], "showdown")
        self.assertIn(other, hand["folded"])
        fold = next(
            event for event in reversed(hand["events"])
            if event.get("actor") == other and event["type"] == "action"
        )
        self.assertTrue(fold["sitting_out"])
        self.assertEqual(fold["action"], "fold")

    def test_sitting_out_checks_are_iterative_and_preserve_button_order(self):
        state = engine.create_lobby(
            "sitout-order", "p1", "Ada", config(max_seats=3), now=1,
        )
        engine.join(state, "p2", "Bea", now=2, seat_no=1)
        engine.join(state, "p3", "Cy", now=3, seat_no=2)
        with patch.object(engine.random.SystemRandom, "shuffle", side_effect=lambda values: None):
            with patch.object(
                engine.random.SystemRandom, "choice",
                side_effect=lambda seats: next(seat for seat in seats if seat["player_id"] == "p1"),
            ):
                engine.start(state, "p1", now=4)
        hand = state["hand"]
        self.assertEqual(hand["button_id"], "p1")
        engine.set_sitting_out(state, "p3", True, now=4.5)

        engine.apply_action(
            state, "p1", "call", None,
            state["hand_no"], state["turn_version"], now=5,
        )
        engine.apply_action(
            state, "p2", "call", None,
            state["hand_no"], state["turn_version"], now=6,
        )
        self.assertEqual(hand["street"], "flop")
        self.assertEqual(hand["to_act"], "p2")

        engine.apply_action(
            state, "p2", "check", None,
            state["hand_no"], state["turn_version"], now=7,
        )
        self.assertEqual(hand["to_act"], "p1")
        p3_checks = [
            event for event in hand["events"]
            if event.get("actor") == "p3" and event["type"] == "action"
            and event["action"] == "check" and event.get("sitting_out")
        ]
        self.assertEqual(len(p3_checks), 2)

    def test_all_sitting_out_table_advances_boundedly_across_streets_and_hands(self):
        state = engine.create_lobby(
            "all-sitting-out", "p1", "Ada",
            config(max_seats=9, starting_stack=200, small_blind=1, big_blind=2, level_minutes=60),
            now=10,
        )
        for seat_no in range(1, 9):
            player_id = "p%d" % (seat_no + 1)
            engine.join(state, player_id, "Player %d" % seat_no, now=10 + seat_no, seat_no=seat_no)
        for seat in list(state["seats"]):
            engine.set_sitting_out(state, seat["player_id"], True, now=20)
        engine.start(state, "p1", now=30)

        self.assertEqual(state["hand"]["street"], "showdown")
        self.assertEqual(state["hand"]["next_hand_at"], 30 + engine.HAND_COMPLETE_PAUSE_SECONDS)
        automatic_actions = [
            event for event in state["hand"]["events"]
            if event["type"] == "action" and event.get("sitting_out")
        ]
        self.assertLessEqual(len(automatic_actions), 4 * 9)
        self.assertTrue(automatic_actions)
        self.assertTrue(all(seat["sitting_out"] for seat in state["seats"]))

        next_start = state["hand"]["next_hand_at"]
        engine.advance(state, now=next_start)
        self.assertEqual(state["hand_no"], 2)
        self.assertEqual(state["hand"]["street"], "showdown")
        self.assertEqual(state["hand"]["next_hand_at"], next_start + engine.HAND_COMPLETE_PAUSE_SECONDS)

    def test_runout_odds_report_ties_and_sampled_preflop_is_deterministic(self):
        tie_rows = engine._calculate_runout_odds(
            (("p1", ("2c", "3d")), ("p2", ("4c", "5d"))),
            ("Ah", "Kh", "Qh", "Jh", "Th"),
        )
        self.assertEqual(tie_rows[0][1:4], (0.0, 100.0, 50.0))
        self.assertEqual(tie_rows[1][1:4], (0.0, 100.0, 50.0))
        self.assertTrue(tie_rows[0][4])
        self.assertEqual(tie_rows[0][5], 1)

        holes = (("p1", ("As", "Ah")), ("p2", ("Ks", "Kh")))
        sampled = engine._calculate_runout_odds(holes, ())
        self.assertEqual(sampled, engine._calculate_runout_odds(holes, ()))
        self.assertFalse(sampled[0][4])
        self.assertEqual(sampled[0][5], engine.RUNOUT_SAMPLE_COUNT)
        self.assertLessEqual(abs(sum(row[3] for row in sampled) - 100), 0.2)

    def test_fast_seven_card_evaluator_matches_reference_evaluator(self):
        rng = engine.random.Random(734)
        deck = [rank + suit for rank in engine.RANK_CHARS for suit in engine.SUITS]
        for _ in range(300):
            cards = rng.sample(deck, 7)
            self.assertEqual(engine._rank_seven_fast(cards), engine.rank_seven(cards))

    def test_payout_separates_contested_winnings_from_uncalled_return(self):
        state = heads_up(starting_stack=1000)
        hand = state["hand"]
        hand["contrib"] = {"p1": 1000, "p2": 20}
        hand["bets"] = {"p1": 0, "p2": 0}
        hand["folded"] = ["p2"]
        hand["stack_before"] = {"p1": 1000, "p2": 20}
        engine._seat_by_id(state, "p1")["stack"] = 0
        engine._seat_by_id(state, "p2")["stack"] = 980

        engine._award_without_showdown(state, "p1", now=200)
        event = next(event for event in reversed(hand["events"]) if event["type"] == "payout")
        self.assertEqual(event["pot_total"], 1020)
        self.assertEqual(event["pot_winnings"], {"p1": 40, "p2": 0})
        self.assertEqual(event["pots"][0]["amount"], 40)
        self.assertEqual(event["pots"][0]["recipients"][0]["player_id"], "p1")
        self.assertEqual(event["pots"][0]["recipients"][0]["amount"], 40)
        self.assertEqual(event["returns"], [
            {"player_id": "p1", "actor_label": "Ada", "amount": 980},
        ])
        self.assertEqual(event["return_total"], 980)
        self.assertEqual(event["payouts"], {"p1": 1020, "p2": 0})
        self.assertEqual(sum(seat["stack"] for seat in state["seats"]), 2000)

    def test_showdown_merges_layers_with_same_eligible_players_before_odd_chip_split(self):
        state = engine.create_lobby(
            "merged-pots", "p1", "Ada", config(max_seats=5), now=1
        )
        for index, name in enumerate(("Bea", "Cy", "Dee", "Eli"), 2):
            engine.join(state, "p%d" % index, name, now=index)
        engine.start(state, "p1", now=10)
        hand = state["hand"]
        hand["board"] = ["Ah", "Kh", "Qh", "Jh", "Th"]
        hand["holes"] = {
            "p1": ["2c", "3d"],
            "p2": ["4c", "5d"],
            "p3": ["6c", "7d"],
            "p4": ["8c", "9d"],
            "p5": ["Tc", "Td"],
        }
        hand["folded"] = ["p3", "p4", "p5"]
        hand["contrib"] = {"p1": 53, "p2": 53, "p3": 11, "p4": 21, "p5": 32}
        payouts, winnings, pots, returns = engine._allocate_pots(
            state, hand, engine._showdown_ranks(hand),
        )
        self.assertEqual(returns, [])
        self.assertEqual(len(pots), 1)
        self.assertEqual(pots[0]["amount"], 170)
        self.assertEqual(set(pots[0]["eligible_player_ids"]), {"p1", "p2"})
        self.assertEqual({item["amount"] for item in pots[0]["recipients"]}, {85})
        self.assertEqual(winnings, {"p1": 85, "p2": 85, "p3": 0, "p4": 0, "p5": 0})
        self.assertEqual(sum(payouts.values()), 170)

    def test_showdown_event_reports_each_contested_side_pot_recipient(self):
        state = engine.create_lobby(
            "side-pot-events", "p1", "Ada",
            config(max_seats=3, starting_stack=100), now=1,
        )
        engine.join(state, "p2", "Bea", now=2)
        engine.join(state, "p3", "Cy", now=3)
        engine.start(state, "p1", now=4)
        hand = state["hand"]
        hand["street"] = "river"
        hand["board"] = ["2c", "3d", "4h", "9s", "Jc"]
        hand["holes"] = {
            "p1": ["As", "Ah"],
            "p2": ["Ks", "Kh"],
            "p3": ["Qs", "Qh"],
        }
        hand["folded"] = []
        hand["contrib"] = {"p1": 10, "p2": 20, "p3": 30}
        hand["stack_before"] = {"p1": 100, "p2": 100, "p3": 100}
        hand["bets"] = {"p1": 0, "p2": 0, "p3": 0}
        for player_id, contributed in hand["contrib"].items():
            engine._seat_by_id(state, player_id)["stack"] = 100 - contributed

        engine._settle_showdown(state, now=100)
        event = next(event for event in reversed(hand["events"]) if event["type"] == "showdown_result")
        self.assertEqual(
            [(pot["label"], pot["amount"]) for pot in event["pots"]],
            [("Main pot", 30), ("Side pot 1", 20)],
        )
        self.assertEqual(
            [
                (pot["recipients"][0]["player_id"], pot["recipients"][0]["amount"])
                for pot in event["pots"]
            ],
            [("p1", 30), ("p2", 20)],
        )
        self.assertEqual(
            event["returns"],
            [{"player_id": "p3", "actor_label": "Cy", "amount": 10}],
        )
        self.assertEqual(event["pot_winnings"], {"p1": 30, "p2": 20, "p3": 0})
        self.assertEqual(event["payouts"], {"p1": 30, "p2": 20, "p3": 10})
        self.assertEqual(sum(seat["stack"] for seat in state["seats"]), 300)

    def test_simultaneous_equal_stack_busts_share_place_and_emit_standings(self):
        state = engine.create_lobby(
            "tied-busts", "p1", "Ada", config(max_seats=4), now=1
        )
        engine.join(state, "p2", "Bea", now=2)
        engine.join(state, "p3", "Cy", now=3)
        engine.join(state, "p4", "Dee", now=4)
        engine.start(state, "p1", now=5)
        hand = state["hand"]
        hand["stack_before"] = {"p1": 100, "p2": 100, "p3": 300, "p4": 400}
        engine._seat_by_id(state, "p1")["stack"] = 0
        engine._seat_by_id(state, "p2")["stack"] = 0
        engine._seat_by_id(state, "p3")["stack"] = 300
        engine._seat_by_id(state, "p4")["stack"] = 400

        engine._finish_hand(
            state, {player_id: 0 for player_id in hand["contrib"]}, now=10,
        )
        tied = [item for item in state["elimination_order"] if item["player_id"] in {"p1", "p2"}]
        self.assertEqual({item["place"] for item in tied}, {3})
        self.assertTrue(all(item["tied"] and item["tie_count"] == 2 for item in tied))
        event = next(event for event in reversed(hand["events"]) if event["type"] == "standings")
        self.assertEqual({item["player_id"] for item in event["eliminated"]}, {"p1", "p2"})
        self.assertEqual({item["place"] for item in event["eliminated"]}, {3})
        view = engine.public_view(state, "p3")
        tied_rows = [item for item in view["standings"] if item["status"] == "eliminated"]
        self.assertEqual({item["place"] for item in tied_rows}, {3})

    def test_showdown_event_reports_contested_pot_and_unmatched_return(self):
        state = heads_up(starting_stack=1000)
        hand = state["hand"]
        hand["street"] = "river"
        hand["board"] = ["2c", "3d", "4h", "5s", "9c"]
        hand["holes"] = {"p1": ["As", "Ah"], "p2": ["Ks", "Kh"]}
        hand["folded"] = []
        hand["contrib"] = {"p1": 1000, "p2": 20}
        hand["stack_before"] = {"p1": 1000, "p2": 20}
        hand["bets"] = {"p1": 0, "p2": 0}
        for seat in state["seats"]:
            seat["stack"] = 0
        engine._seat_by_id(state, "p1")["stack"] = 0
        engine._seat_by_id(state, "p2")["stack"] = 0

        engine._settle_showdown(state, now=200)
        event = next(event for event in reversed(hand["events"]) if event["type"] == "showdown_result")
        self.assertEqual(event["pots"][0]["amount"], 40)
        self.assertEqual(event["pots"][0]["recipients"][0]["player_id"], "p1")
        self.assertEqual(event["pot_winnings"], {"p1": 40, "p2": 0})
        self.assertEqual(event["returns"][0]["amount"], 980)
        self.assertEqual(event["showdown"][0]["payout"], 40)
        self.assertEqual(event["showdown"][0]["returned"], 980)
        self.assertEqual(event["payouts"], {"p1": 1020, "p2": 0})
        self.assertEqual(sum(seat["stack"] for seat in state["seats"]), 1020)
        view = engine.public_view(state, "p1")
        self.assertEqual(view["winners"], [{
            "player_id": "p1", "name": "Ada", "amount": 40,
            "rank": view["hand_ranks"]["p1"]["rank"],
            "hand_name": view["hand_ranks"]["p1"]["hand_name"],
        }])
        self.assertEqual(view["pot_winnings"]["p1"], 40)
        self.assertEqual(view["returns"][0]["amount"], 980)

    def test_check_call_tournament_finishes_without_losing_chips(self):
        state = engine.create_lobby(
            "full-game",
            "p1",
            "Ada",
            config(max_seats=4, starting_stack=120, small_blind=1, big_blind=2),
            now=1000,
        )
        for index, name in enumerate(("Bea", "Cy", "Dee"), 1):
            engine.join(state, "p%d" % (index + 1), name, now=1000 + index)
        engine.start(state, "p1", now=1010)
        total_chips = 4 * 120
        now = 1010
        for _ in range(10000):
            if state["status"] == "completed":
                break
            hand = state["hand"]
            if hand["street"] == "showdown":
                now = max(now + 1, hand["next_hand_at"] or now + 1)
                engine.advance(state, now=now)
            elif hand.get("runout_at") is not None:
                now = max(now + 0.01, hand["runout_at"])
                engine.advance(state, now=now)
            else:
                actor = hand["to_act"]
                self.assertIsNotNone(actor)
                action = "call" if engine._to_call(hand, actor) else "check"
                now += 1
                engine.apply_action(
                    state,
                    actor,
                    action,
                    None,
                    state["hand_no"],
                    state["turn_version"],
                    now=now,
                )
            if state["status"] == "playing" and state["hand"]["street"] != "showdown":
                self.assertEqual(
                    sum(seat["stack"] for seat in state["seats"])
                    + sum(state["hand"]["contrib"].values()),
                    total_chips,
                )
            else:
                self.assertEqual(
                    sum(seat["stack"] for seat in state["seats"]),
                    total_chips,
                )
        self.assertEqual(state["status"], "completed")
        self.assertEqual(state["results"][0]["place"], 1)
        self.assertEqual(len(state["results"]), 4)


    def test_host_can_stand_watch_and_retake_a_selected_seat(self):
        state = engine.create_lobby("stand", "p1", "Ada", config(), now=1)
        engine.join(state, "p2", "Bea", now=2, seat_no=3)

        engine.stand(state, "p1", now=3)
        self.assertEqual(state["status"], "lobby")
        self.assertEqual(state["host_id"], "p1")
        self.assertIsNone(engine._seat_by_id(state, "p1"))
        self.assertFalse(engine.public_view(state, "p1")["viewer"]["seated"])
        engine.stand(state, "p2", now=3.5)
        self.assertEqual(state["seats"], [])
        self.assertEqual(state["status"], "lobby")
        self.assertEqual(state["host_id"], "p1")

        engine.join(state, "p1", "Ada", now=4, seat_no=1)
        self.assertEqual(engine._seat_by_id(state, "p1")["seat_no"], 1)
        self.assertEqual(state["host_id"], "p1")
        self.assertEqual(state["status"], "lobby")

    def test_join_moves_host_and_rejects_an_occupied_or_invalid_seat(self):
        state = engine.create_lobby("seat-choice", "p1", "Ada", config(), now=1)
        engine.join(state, "p2", "Bea", now=2, seat_no=3)
        engine.join(state, "p1", "Ada", now=3, seat_no=2)
        self.assertEqual(engine._seat_by_id(state, "p1")["seat_no"], 2)

        with self.assertRaises(engine.GameError) as caught:
            engine.join(state, "p3", "Cy", now=4, seat_no=3)
        self.assertEqual(caught.exception.code, "seat_taken")
        with self.assertRaises(engine.GameError) as caught:
            engine.join(state, "p3", "Cy", now=5, seat_no=True)
        self.assertEqual(caught.exception.code, "invalid_seat")

    def test_lobby_settings_are_host_only_reset_stacks_and_lock_capacity(self):
        state = engine.create_lobby("settings", "p1", "Ada", config(), now=1)
        engine.join(state, "p2", "Bea", now=2, seat_no=2)
        engine.join(state, "p3", "Cy", now=3, seat_no=3)
        engine.add_bot(state, "p1", 1, now=3.5, is_admin=True)

        with self.assertRaises(engine.GameError) as caught:
            engine.update_settings(state, "p2", {"starting_stack": 2000}, now=4)
        self.assertEqual(caught.exception.code, "host_only")

        engine.update_settings(
            state, "p1",
            {"starting_stack": 2000, "small_blind": 10, "big_blind": 20},
            now=5, name="A" * 40,
        )
        self.assertEqual(state["name"], "A" * 40)
        self.assertEqual([seat["stack"] for seat in state["seats"]], [2000, 2000, 2000, 2000])
        self.assertEqual(state["blinds"]["small"], 10)
        self.assertEqual(state["blinds"]["big"], 20)

        with self.assertRaises(engine.GameError) as caught:
            engine.update_settings(state, "p1", {"max_seats": 2}, now=6)
        self.assertEqual(caught.exception.code, "invalid_config")
        with self.assertRaises(engine.GameError) as caught:
            engine.update_settings(
                state, "p1", {"small_blind": 30, "big_blind": 20}, now=7,
            )
        self.assertEqual(caught.exception.code, "invalid_config")

        engine.start(state, "p1", now=8)
        with self.assertRaises(engine.GameError) as caught:
            engine.update_settings(state, "p1", {"starting_stack": 3000}, now=9)
        self.assertEqual(caught.exception.code, "table_started")

    def test_bot_seats_are_public_admin_managed_and_frozen_at_start(self):
        state = engine.create_lobby("bots", "p1", "Ada", config(), now=1)
        engine.add_bot(state, "admin", 1, now=2, is_admin=True)
        bot = engine._seat_by_id(state, "bot:bots:1")
        self.assertTrue(bot["is_bot"])
        public_seats = engine.public_view(state, "p1")["seats"]
        self.assertTrue(next(seat for seat in public_seats if seat["id"] == bot["player_id"])["is_bot"])

        with self.assertRaises(engine.GameError) as caught:
            engine.add_bot(state, "p1", 2, now=3)
        self.assertEqual(caught.exception.code, "admin_required")
        with self.assertRaises(engine.GameError) as caught:
            engine.remove_bot(state, "p1", 1, now=4)
        self.assertEqual(caught.exception.code, "admin_required")
        with self.assertRaises(engine.GameError) as caught:
            engine.add_bot(state, "admin", 1, now=5, is_admin=True)
        self.assertEqual(caught.exception.code, "seat_taken")

        engine.start(state, "p1", now=6)
        with self.assertRaises(engine.GameError) as caught:
            engine.remove_bot(state, "admin", 1, now=7, is_admin=True)
        self.assertEqual(caught.exception.code, "table_started")
        with self.assertRaises(engine.GameError) as caught:
            engine.add_bot(state, "admin", 2, now=8, is_admin=True)
        self.assertEqual(caught.exception.code, "table_started")

    def test_old_state_without_bot_fields_remains_readable(self):
        state = heads_up(now=100)
        for seat in state["seats"]:
            seat.pop("is_bot", None)
        state["hand"].pop("bot_action_at", None)

        actor = state["hand"]["to_act"]
        view = engine.public_view(state, actor)
        public_actor = next(seat for seat in view["seats"] if seat["id"] == actor)
        self.assertFalse(public_actor["is_bot"])
        self.assertFalse(public_actor["sitting_out"])
        engine.advance(state, now=104)
        self.assertEqual(state["status"], "playing")
        self.assertEqual(state["hand"]["to_act"], actor)

    def test_host_leave_hands_off_only_to_a_human_not_a_bot(self):
        state = engine.create_lobby("handoff", "p1", "Ada", config(), now=1)
        engine.add_bot(state, "p1", 1, now=2, is_admin=True)
        engine.join(state, "p2", "Bea", now=3, seat_no=2)
        engine.leave(state, "p1", now=4)
        self.assertEqual(state["host_id"], "p2")
        self.assertNotEqual(state["host_id"], "bot:handoff:1")

    def test_bot_turns_wait_then_make_legal_progress_across_hands(self):
        from unittest.mock import patch

        state = engine.create_lobby(
            "bot-game", "host", "Host",
            config(max_seats=3, starting_stack=100, small_blind=5, big_blind=10),
            now=100,
        )
        engine.add_bot(state, "host", 1, now=101, is_admin=True)
        engine.add_bot(state, "host", 2, now=102, is_admin=True)
        engine.stand(state, "host", now=103)
        engine.start(state, "host", now=104)
        initial_chips = 200
        now = 104.0
        checked_delay = False

        def passive_legal_action(options):
            return next((item for item in options if item[0] in ("check", "call")), options[0])

        with patch.object(engine.random.SystemRandom, "choice", side_effect=passive_legal_action):
            for _ in range(3000):
                if state["status"] != "playing":
                    break
                hand = state["hand"]
                if hand["street"] == "showdown":
                    now = max(now + 0.01, hand["next_hand_at"] or now + 0.01)
                    engine.advance(state, now=now)
                elif hand.get("runout_at") is not None:
                    now = max(now + 0.01, hand["runout_at"])
                    engine.advance(state, now=now)
                else:
                    actor_id = hand["to_act"]
                    self.assertIsNotNone(actor_id)
                    self.assertTrue(engine._seat_by_id(state, actor_id)["is_bot"])
                    due = hand["bot_action_at"]
                    self.assertIsNotNone(due)
                    if not checked_delay:
                        version = state["version"]
                        engine.advance(state, now=due - 0.01)
                        self.assertEqual(state["version"], version)
                        self.assertEqual(state["hand"]["to_act"], actor_id)
                        self.assertGreaterEqual(due - now, 0.8)
                        self.assertLessEqual(due - now, 1.4)
                        checked_delay = True
                    now = max(now + 0.01, due)
                    engine.advance(state, now=now)

                if state["status"] == "playing" and state["hand"]["street"] != "showdown":
                    total = sum(seat["stack"] for seat in state["seats"]) + sum(state["hand"]["contrib"].values())
                else:
                    total = sum(seat["stack"] for seat in state["seats"])
                self.assertEqual(total, initial_chips)

        self.assertTrue(checked_delay)
        self.assertGreaterEqual(state["hand_no"], 2)
        self.assertIn(state["status"], ("playing", "completed"))
        self.assertTrue(any(item["text"].startswith("Bot ") for item in state["action_log"]))


    def test_three_and_nine_bot_tournaments_conserve_chips_with_sitting_out_human(self):
        def simulate(state, initial_chips, start_time, max_steps=300):
            now = float(start_time)
            for _ in range(max_steps):
                if state["status"] != "playing":
                    break
                hand = state["hand"]
                if hand["street"] == "showdown":
                    next_hand = hand.get("next_hand_at")
                    if next_hand is None:
                        break
                    now = max(now + 0.01, next_hand)
                    engine.advance(state, now=now)
                elif hand.get("runout_at") is not None:
                    now = max(now + 0.01, hand["runout_at"])
                    engine.advance(state, now=now)
                else:
                    actor = hand.get("to_act")
                    self.assertIsNotNone(actor)
                    seat = engine._seat_by_id(state, actor)
                    if seat.get("sitting_out", False):
                        self.fail("A sitting-out human was left waiting for a turn.")
                    self.assertTrue(seat.get("is_bot", False))
                    due = hand.get("bot_action_at")
                    if due is None:
                        now += 1.5
                        engine.advance(state, now=now)
                    else:
                        now = max(now + 0.01, due)
                        engine.advance(state, now=now)

                hand = state.get("hand")
                if state["status"] == "playing" and hand is not None and hand["street"] != "showdown":
                    total = sum(seat["stack"] for seat in state["seats"]) + sum(hand["contrib"].values())
                else:
                    total = sum(seat["stack"] for seat in state["seats"])
                self.assertEqual(total, initial_chips)

            self.assertGreaterEqual(state["hand_no"], 2)
            return state

        three = engine.create_lobby(
            "three-bot-adapter", "host", "Host",
            config(max_seats=4, starting_stack=300, small_blind=5, big_blind=10),
            now=100,
        )
        engine.add_bot(three, "host", 1, now=101, is_admin=True)
        engine.add_bot(three, "host", 2, now=102, is_admin=True)
        engine.add_bot(three, "host", 3, now=103, is_admin=True)
        engine.set_sitting_out(three, "host", True, now=104)
        engine.start(three, "host", now=105)
        self.assertTrue(engine._seat_by_id(three, "host")["sitting_out"])
        simulate(three, 1200, 105)

        nine = engine.create_lobby(
            "nine-bot-adapter", "host", "Host",
            config(max_seats=9, starting_stack=300, small_blind=5, big_blind=10),
            now=200,
        )
        engine.stand(nine, "host", now=201)
        for seat_no in range(9):
            engine.add_bot(nine, "admin", seat_no, now=202 + seat_no, is_admin=True)
        engine.start(nine, "host", now=211)
        self.assertEqual(len(nine["seats"]), 9)
        self.assertTrue(all(seat["is_bot"] for seat in nine["seats"]))
        simulate(nine, 2700, 211)


if __name__ == "__main__":
    unittest.main()

