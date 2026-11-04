import unittest

import engine


def config(**overrides):
    value = {
        "max_seats": 4,
        "starting_stack": 1000,
        "small_blind": 5,
        "big_blind": 10,
        "level_minutes": 1,
        "turn_seconds": 30,
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
    def test_lobby_host_seated_and_heads_up_blinds(self):
        state = heads_up()
        self.assertEqual(state["status"], "playing")
        self.assertEqual(state["hand_no"], 1)
        self.assertEqual(state["hand"]["button_id"], "p1")
        self.assertEqual(state["hand"]["small_blind_id"], "p1")
        self.assertEqual(state["hand"]["big_blind_id"], "p2")
        self.assertEqual(state["hand"]["bets"], {"p1": 5, "p2": 10})
        self.assertEqual(state["hand"]["to_act"], "p1")
        self.assertEqual(state["seats"][0]["stack"], 995)
        self.assertEqual(state["seats"][1]["stack"], 990)

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
        engine.apply_action(
            state, "p1", "call", None, hand_no, turn_version, now=104
        )
        self.assertEqual(state["hand"]["to_act"], "p2")
        with self.assertRaises(engine.GameError) as caught:
            engine.apply_action(
                state, "p1", "call", None, hand_no, turn_version, now=105
            )
        self.assertEqual(caught.exception.code, "stale_turn")
        self.assertEqual(caught.exception.status, 409)
        engine.apply_action(
            state,
            "p2",
            "check",
            None,
            state["hand_no"],
            state["turn_version"],
            now=106,
        )
        self.assertEqual(state["hand"]["street"], "flop")
        self.assertEqual(state["hand"]["to_act"], "p2")

    def test_raise_to_rules_and_short_all_in(self):
        state = heads_up(starting_stack=100)
        hand = state["hand"]
        with self.assertRaises(engine.GameError) as caught:
            engine.apply_action(
                state, "p1", "raise", 15, state["hand_no"], state["turn_version"], now=104
            )
        self.assertEqual(caught.exception.code, "raise_too_small")
        self.assertEqual(hand["to_act"], "p1")

        # SB has 95 chips after posting 5, so raising to 100 is a legal all-in
        # even though it exceeds the normal minimum raise-to amount.
        engine.apply_action(
            state, "p1", "raise", 100, state["hand_no"], state["turn_version"], now=105
        )
        self.assertEqual(hand["current_bet"], 100)
        self.assertEqual(hand["min_raise"], 90)
        self.assertEqual(hand["to_act"], "p2")
        self.assertEqual(state["seats"][0]["stack"], 0)

    def test_fold_awards_pot_without_showing_hole_cards(self):
        state = heads_up()
        before_total = sum(seat["stack"] for seat in state["seats"]) + sum(
            state["hand"]["contrib"].values()
        )
        engine.apply_action(
            state,
            "p1",
            "fold",
            None,
            state["hand_no"],
            state["turn_version"],
            now=105,
        )
        self.assertEqual(state["hand"]["street"], "showdown")
        self.assertEqual(state["hand"]["showdown"], [])
        self.assertEqual(state["hand"]["payouts"]["p2"], 15)
        after_total = sum(seat["stack"] for seat in state["seats"])
        self.assertEqual(after_total, before_total)
        self.assertTrue(any("wins 15 without showdown" in item["text"] for item in state["action_log"]))

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

    def test_timeout_folds_when_facing_a_bet(self):
        state = heads_up(now=100)
        actor = state["hand"]["to_act"]
        deadline = state["hand"]["turn_deadline"]
        self.assertEqual(actor, "p1")
        engine.advance(state, now=deadline + 0.1)
        self.assertIn("p1", state["hand"]["folded"])
        self.assertEqual(state["hand"]["street"], "showdown")
        self.assertTrue(any("timed out and folded" in item["text"] for item in state["action_log"]))

    def test_blind_clock_increases_at_level_boundary(self):
        state = heads_up(now=100)
        engine.advance(state, now=162)
        self.assertEqual(state["blinds"]["level"], 2)
        self.assertEqual(state["blinds"]["small"], 10)
        self.assertEqual(state["blinds"]["big"], 20)
        # The hand that started before the boundary keeps its original blind.
        self.assertEqual(state["hand"]["big_blind"], 10)

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
            {"p1": "Straight flush, A high", "p2": "Two pair"},
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

    def test_invalid_config_rejected(self):
        with self.assertRaises(engine.GameError) as caught:
            engine.create_lobby(
                "bad", "p1", "Ada", config(max_seats=10), now=1
            )
        self.assertEqual(caught.exception.code, "invalid_config")

    def test_short_big_blind_keeps_nominal_preflop_bring_in(self):
        state = engine.create_lobby(
            "short-bb", "p1", "Ada", config(), now=1
        )
        engine.join(state, "p2", "Bea", now=2)
        state["seats"][1]["stack"] = 3
        engine.start(state, "p1", now=3)
        hand = state["hand"]
        self.assertEqual(hand["bets"], {"p1": 5, "p2": 3})
        self.assertEqual(hand["current_bet"], 10)
        self.assertEqual(hand["to_act"], "p1")
        self.assertEqual(engine._to_call(hand, "p1"), 5)

    def test_only_player_with_chips_can_call_then_board_runs_without_dry_betting(self):
        state = engine.create_lobby(
            "dry-side", "p1", "Ada", config(starting_stack=100), now=100
        )
        engine.join(state, "p2", "Bea", now=101)
        state["seats"][1]["stack"] = 10
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
        self.assertEqual(state["hand"]["street"], "showdown")
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

        # Complete preflop betting to reach the flop.
        for player_id, action, amount in (
            ("p1", "call", None),
            ("p2", "call", None),
            ("p3", "check", None),
        ):
            engine.apply_action(
                state, player_id, action, amount,
                state["hand_no"], state["turn_version"], now=5
            )
        self.assertEqual(state["hand"]["street"], "flop")
        self.assertEqual(state["hand"]["to_act"], "p2")

        # Bea checks, then Cy can only wager five chips, below the ten-chip
        # minimum opening bet. Bea must still be allowed to raise to a full bet.
        engine.apply_action(
            state, "p2", "check", None,
            state["hand_no"], state["turn_version"], now=6
        )
        state["seats"][2]["stack"] = 5
        engine.apply_action(
            state, "p3", "all_in", None,
            state["hand_no"], state["turn_version"], now=7
        )
        engine.apply_action(
            state, "p1", "call", None,
            state["hand_no"], state["turn_version"], now=8
        )
        self.assertEqual(state["hand"]["to_act"], "p2")
        view = engine.public_view(state, "p2")
        self.assertTrue(view["viewer"]["raise_rights"])
        self.assertEqual(view["viewer"]["min_raise_to"], 15)
        engine.apply_action(
            state, "p2", "raise", 15,
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

    def test_button_avoids_consecutive_big_blind_when_button_busts_three_to_two(self):
        state = engine.create_lobby(
            "transition", "p1", "Ada", config(max_seats=3), now=1
        )
        engine.join(state, "p2", "Bea", now=2)
        engine.join(state, "p3", "Cy", now=3)
        engine.start(state, "p1", now=4)
        old_hand = state["hand"]
        self.assertEqual(old_hand["button_id"], "p1")
        self.assertEqual(old_hand["big_blind_id"], "p3")
        state["seats"][0]["stack"] = 0
        old_hand["street"] = "showdown"
        old_hand["to_act"] = None
        old_hand["turn_deadline"] = None
        old_hand["next_hand_at"] = 10
        engine.advance(state, now=11)
        self.assertEqual(state["hand_no"], 2)
        self.assertEqual(state["hand"]["button_id"], "p3")
        self.assertEqual(state["hand"]["small_blind_id"], "p3")
        self.assertEqual(state["hand"]["big_blind_id"], "p2")

    def test_simultaneous_bust_orders_larger_stack_higher(self):
        state = engine.create_lobby(
            "bust-order", "p1", "Ada", config(max_seats=3), now=1
        )
        engine.join(state, "p2", "Bea", now=2)
        engine.join(state, "p3", "Cy", now=3)
        engine.start(state, "p1", now=4)
        hand = state["hand"]
        hand["stack_before"] = {"p1": 100, "p2": 200, "p3": 300}
        state["seats"][0]["stack"] = 0
        state["seats"][1]["stack"] = 0
        state["seats"][2]["stack"] = 300
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


if __name__ == "__main__":
    unittest.main()

