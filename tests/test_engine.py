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
        self.assertIn(seat_numbers, ([0, 2], [1, 3]))

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
        self.assertEqual(sorted(seat_numbers.values()), [2, 5, 8])
        self.assertEqual(seat_numbers, {"p1": 8, "p2": 5, "p3": 2})
        self.assertEqual(state["hand"]["button_id"], "p2")
        self.assertEqual(state["config"]["max_seats"], 9)

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
                self.assertTrue(all(0 <= seat_no < 9 for seat_no in seat_numbers))

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

    def test_all_in_runout_reveals_live_cards_then_deals_one_street_per_tick(self):
        state = engine.create_lobby(
            "runout", "p1", "Ada", config(starting_stack=100), now=100
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
        self.assertEqual(hand["runout_at"], 105 + engine.RUNOUT_SECONDS)
        self.assertEqual({item["player_id"] for item in hand["revealed"]}, {"p1", "p2"})
        view = engine.public_view(state, "p1")
        self.assertTrue(all("cards" in seat for seat in view["seats"]))

        first_due = hand["runout_at"]
        engine.advance(state, now=first_due - 0.01)
        self.assertEqual(hand["board"], [])
        engine.advance(state, now=first_due)
        self.assertEqual(hand["street"], "flop")
        self.assertEqual(len(hand["board"]), 3)
        self.assertEqual(hand["runout_at"], first_due + engine.RUNOUT_SECONDS)
        engine.advance(state, now=hand["runout_at"])
        self.assertEqual(hand["street"], "turn")
        self.assertEqual(len(hand["board"]), 4)
        engine.advance(state, now=hand["runout_at"])
        self.assertEqual(hand["street"], "showdown")
        self.assertEqual(len(hand["board"]), 5)

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

        folder = state["hand"]["to_act"]
        engine.apply_action(state, folder, "fold", None, state["hand_no"], state["turn_version"], now=106)
        payout = next(event for event in reversed(state["hand"]["events"]) if event["type"] == "payout")
        self.assertEqual(len(payout["winners"]), 1)
        self.assertEqual(payout["winners"][0]["amount"], 20)
        self.assertEqual(sum(payout["payouts"].values()), 20)

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
        engine._seat_by_id(state, "p2")["stack"] = 3
        with patch.object(
            engine.random.SystemRandom,
            "choice",
            side_effect=lambda seats: next(seat for seat in seats if seat["player_id"] == "p1"),
        ):
            engine.start(state, "p1", now=3)
        hand = state["hand"]
        self.assertEqual(hand["small_blind_id"], "p1")
        self.assertEqual(hand["big_blind_id"], "p2")
        self.assertEqual(hand["bets"], {"p1": 5, "p2": 3})
        self.assertEqual(hand["current_bet"], 10)
        self.assertEqual(hand["to_act"], "p1")
        self.assertEqual(engine._to_call(hand, "p1"), 5)

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
        engine.add_bot(state, "p1", 1, now=3.5)

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
        self.assertEqual(caught.exception.code, "seats_occupied")
        with self.assertRaises(engine.GameError) as caught:
            engine.update_settings(
                state, "p1", {"small_blind": 30, "big_blind": 20}, now=7,
            )
        self.assertEqual(caught.exception.code, "invalid_config")

        engine.start(state, "p1", now=8)
        with self.assertRaises(engine.GameError) as caught:
            engine.update_settings(state, "p1", {"starting_stack": 3000}, now=9)
        self.assertEqual(caught.exception.code, "table_started")

    def test_bot_seats_are_public_host_managed_and_frozen_at_start(self):
        state = engine.create_lobby("bots", "p1", "Ada", config(), now=1)
        engine.add_bot(state, "p1", 1, now=2)
        bot = engine._seat_by_id(state, "bot:bots:1")
        self.assertTrue(bot["is_bot"])
        public_seats = engine.public_view(state, "p1")["seats"]
        self.assertTrue(next(seat for seat in public_seats if seat["id"] == bot["player_id"])["is_bot"])

        with self.assertRaises(engine.GameError) as caught:
            engine.add_bot(state, "p2", 2, now=3)
        self.assertEqual(caught.exception.code, "host_only")
        with self.assertRaises(engine.GameError) as caught:
            engine.remove_bot(state, "p2", 1, now=4)
        self.assertEqual(caught.exception.code, "host_only")
        with self.assertRaises(engine.GameError) as caught:
            engine.add_bot(state, "p1", 1, now=5)
        self.assertEqual(caught.exception.code, "seat_taken")

        engine.start(state, "p1", now=6)
        with self.assertRaises(engine.GameError) as caught:
            engine.remove_bot(state, "p1", 1, now=7)
        self.assertEqual(caught.exception.code, "table_started")
        with self.assertRaises(engine.GameError) as caught:
            engine.add_bot(state, "p1", 2, now=8)
        self.assertEqual(caught.exception.code, "table_started")

    def test_old_state_without_bot_fields_remains_readable(self):
        state = heads_up(now=100)
        for seat in state["seats"]:
            seat.pop("is_bot", None)
        state["hand"].pop("bot_action_at", None)

        actor = state["hand"]["to_act"]
        view = engine.public_view(state, actor)
        self.assertFalse(next(seat for seat in view["seats"] if seat["id"] == actor)["is_bot"])
        engine.advance(state, now=104)
        self.assertEqual(state["status"], "playing")
        self.assertEqual(state["hand"]["to_act"], actor)

    def test_host_leave_hands_off_only_to_a_human_not_a_bot(self):
        state = engine.create_lobby("handoff", "p1", "Ada", config(), now=1)
        engine.add_bot(state, "p1", 1, now=2)
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
        engine.add_bot(state, "host", 1, now=101)
        engine.add_bot(state, "host", 2, now=102)
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


if __name__ == "__main__":
    unittest.main()

