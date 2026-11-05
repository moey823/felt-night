import random
import time
import unittest

import bot_strategy
import engine


def make_context(
    street="preflop",
    hole_cards=("As", "Ah"),
    board=(),
    player_count=2,
    hero_seat=0,
    button_seat=0,
    stack=1000,
    hero_bet=0,
    current_bet=20,
    pot=100,
    raise_allowed=True,
    folded_seats=(),
    all_in_seats=(),
    opponent_bets=None,
):
    opponent_bets = opponent_bets or {}
    folded_seats = set(folded_seats)
    all_in_seats = set(all_in_seats)
    return {
        "street": street,
        "hole_cards": list(hole_cards),
        "board": list(board),
        "hero_seat": hero_seat,
        "button_seat": button_seat,
        "players": [
            {
                "seat": seat,
                "stack": stack if seat == hero_seat else (0 if seat in all_in_seats else 1000),
                "street_bet": hero_bet if seat == hero_seat else opponent_bets.get(seat, 0),
                "folded": seat in folded_seats,
                "all_in": seat in all_in_seats,
            }
            for seat in range(player_count)
        ],
        "small_blind": 10,
        "big_blind": 20,
        "pot": pot,
        "current_bet": current_bet,
        "min_raise": 20,
        "raise_allowed": raise_allowed,
    }


class BotStrategyTests(unittest.TestCase):
    def assert_action_bounded(self, context, action, amount):
        hero = next(row for row in context["players"] if row["seat"] == context["hero_seat"])
        to_call = max(0, context["current_bet"] - hero["street_bet"])
        maximum = hero["street_bet"] + hero["stack"]
        self.assertIn(action, {"check", "call", "fold", "bet", "raise", "all_in"})
        if action == "check":
            self.assertEqual(to_call, 0)
            self.assertIsNone(amount)
        elif action == "fold":
            self.assertGreater(to_call, 0)
            self.assertIsNone(amount)
        elif action == "call":
            self.assertGreater(to_call, 0)
            self.assertIsNone(amount)
        elif action == "all_in":
            self.assertGreater(maximum, context["current_bet"])
            self.assertIsNone(amount)
        else:
            self.assertIsInstance(amount, int)
            self.assertGreater(amount, context["current_bet"])
            self.assertLessEqual(amount, maximum)
            minimum = (
                context["current_bet"] + context["min_raise"]
                if context["current_bet"]
                else context["min_raise"]
            )
            self.assertTrue(amount >= minimum or amount == maximum)

    def test_every_source_range_expands(self):
        for spec in set(bot_strategy._PREFLOP_RANGES.values()):
            with self.subTest(spec=spec):
                self.assertTrue(bot_strategy._expand_range(spec))
        self.assertTrue(bot_strategy._in_range(("5s", "5h"), "99-22"))
        self.assertTrue(bot_strategy._in_range(("As", "2s"), "A5s-A2s"))
        self.assertFalse(bot_strategy._in_range(("As", "2h"), "A5s-A2s"))

    def test_preflop_premium_opens_and_trash_folds(self):
        strong = make_context(hole_cards=("As", "Ah"), current_bet=20)
        action, amount = bot_strategy.choose_action(strong, engine._rank_seven_fast, random.Random(7))
        self.assertEqual((action, amount), ("raise", 50))
        self.assert_action_bounded(strong, action, amount)

        weak = make_context(hole_cards=("7h", "2c"), current_bet=20)
        action, amount = bot_strategy.choose_action(weak, engine._rank_seven_fast, random.Random(7))
        self.assertEqual((action, amount), ("fold", None))
        self.assert_action_bounded(weak, action, amount)

    def test_premium_calls_when_raise_is_closed_or_stack_is_short(self):
        no_reopen = make_context(
            hole_cards=("As", "Ah"), current_bet=20, raise_allowed=False
        )
        action, amount = bot_strategy.choose_action(no_reopen, engine._rank_seven_fast, random.Random(1))
        self.assertEqual((action, amount), ("call", None))
        self.assert_action_bounded(no_reopen, action, amount)

        four_bet_closed = make_context(
            hole_cards=("Ks", "Kh"), current_bet=80, raise_allowed=False
        )
        action, amount = bot_strategy.choose_action(
            four_bet_closed, engine._rank_seven_fast, random.Random(2)
        )
        self.assertEqual((action, amount), ("call", None))
        self.assert_action_bounded(four_bet_closed, action, amount)

        short_call = make_context(
            hole_cards=("As", "Ah"), current_bet=80, stack=40, raise_allowed=True
        )
        action, amount = bot_strategy.choose_action(short_call, engine._rank_seven_fast, random.Random(3))
        self.assertEqual((action, amount), ("call", None))
        self.assert_action_bounded(short_call, action, amount)

        short_raise = make_context(
            hole_cards=("As", "Ah"), current_bet=20, stack=30, raise_allowed=True
        )
        action, amount = bot_strategy.choose_action(short_raise, engine._rank_seven_fast, random.Random(4))
        self.assertEqual((action, amount), ("all_in", None))
        self.assert_action_bounded(short_raise, action, amount)

    def test_made_hand_bets_and_weak_air_folds_to_price(self):
        set_on_flop = make_context(
            street="flop", hole_cards=("Js", "Jc"), board=("Jd", "7c", "2h"),
            current_bet=0, pot=100, stack=1000,
        )
        action, amount = bot_strategy.choose_action(
            set_on_flop, engine._rank_seven_fast, random.Random(5)
        )
        self.assertEqual((action, amount), ("bet", 50))
        self.assert_action_bounded(set_on_flop, action, amount)

        weak_air = make_context(
            street="flop", hole_cards=("2c", "3d"), board=("Kh", "9s", "4c"),
            current_bet=80, opponent_bets={1: 80}, pot=100, stack=1000,
        )
        action, amount = bot_strategy.choose_action(
            weak_air, engine._rank_seven_fast, random.Random(6)
        )
        self.assertEqual((action, amount), ("fold", None))
        self.assert_action_bounded(weak_air, action, amount)

    def test_board_only_royal_flush_is_not_a_private_monster(self):
        context = make_context(
            street="river", hole_cards=("2c", "3d"),
            board=("Ts", "Js", "Qs", "Ks", "As"),
            player_count=9, current_bet=5, opponent_bets={1: 5}, pot=100,
        )
        normalized = bot_strategy._validate_context(context)
        self.assertEqual(
            bot_strategy._postflop_class(
                normalized["hole_cards"], normalized["board"], engine._rank_seven_fast
            ),
            "Air",
        )
        action, amount = bot_strategy.choose_action(
            context, engine._rank_seven_fast, random.Random(8)
        )
        self.assertEqual((action, amount), ("call", None))
        self.assert_action_bounded(context, action, amount)

    def test_top_pair_kicker_classification_uses_available_top_kicker(self):
        board = ("Kh", "3c", "2d")
        weak_kicker = bot_strategy._postflop_class(
            ("Ks", "4s"), board, engine._rank_seven_fast
        )
        top_kicker = bot_strategy._postflop_class(
            ("Ks", "As"), board, engine._rank_seven_fast
        )
        self.assertEqual(weak_kicker, "TopPair")
        self.assertEqual(top_kicker, "TPTK")

    def test_seeded_actions_repeat_and_hidden_fields_are_rejected(self):
        context = make_context(hole_cards=("9s", "8s"), current_bet=20)
        first = bot_strategy.choose_action(
            context, engine._rank_seven_fast, random.Random(19)
        )
        second = bot_strategy.choose_action(
            context, engine._rank_seven_fast, random.Random(19)
        )
        self.assertEqual(first, second)

        hidden_top_level = dict(context, opponent_hole_cards=[["Kd", "Kc"]])
        with self.assertRaisesRegex(ValueError, "unsupported or missing"):
            bot_strategy.choose_action(hidden_top_level, engine._rank_seven_fast)
        hidden_nested = dict(context)
        hidden_nested["players"] = [dict(context["players"][0]), dict(context["players"][1])]
        hidden_nested["players"][1]["hole_cards"] = ["Kd", "Kc"]
        with self.assertRaisesRegex(ValueError, "public seat summaries"):
            bot_strategy.choose_action(hidden_nested, engine._rank_seven_fast)

    def test_tied_runouts_receive_fractional_pot_share(self):
        context = make_context(
            street="river", hole_cards=("2c", "3d"),
            board=("Ts", "Js", "Qs", "Ks", "As"),
            player_count=2, current_bet=20,
        )
        normalized = bot_strategy._validate_context(context)
        equity = bot_strategy._estimate_equity(
            normalized, engine._rank_seven_fast, random.Random(21)
        )
        self.assertEqual(equity, 0.5)

        three_way = make_context(
            street="river", hole_cards=("2c", "3d"),
            board=("Ts", "Js", "Qs", "Ks", "As"),
            player_count=3, current_bet=20,
        )
        normalized = bot_strategy._validate_context(three_way)
        equity = bot_strategy._estimate_equity(
            normalized, engine._rank_seven_fast, random.Random(21)
        )
        self.assertAlmostEqual(equity, 1.0 / 3.0)

    def test_draw_equity_drops_multiway_and_policy_checks_draws(self):
        heads_up = make_context(
            street="flop", hole_cards=("Jd", "Td"), board=("Qd", "9d", "2c"),
            player_count=2, current_bet=0, pot=100, stack=400,
        )
        nine_way = make_context(
            street="flop", hole_cards=("Jd", "Td"), board=("Qd", "9d", "2c"),
            player_count=9, hero_seat=0, button_seat=0,
            current_bet=0, pot=100, stack=400,
        )
        hu_eq = bot_strategy._estimate_equity(
            bot_strategy._validate_context(heads_up), engine._rank_seven_fast, random.Random(23)
        )
        mw_eq = bot_strategy._estimate_equity(
            bot_strategy._validate_context(nine_way), engine._rank_seven_fast, random.Random(23)
        )
        self.assertGreater(hu_eq, mw_eq)
        self.assertEqual(
            bot_strategy._postflop_class(
                heads_up["hole_cards"], heads_up["board"], engine._rank_seven_fast
            ),
            "ComboDraw",
        )
        hu_action, _ = bot_strategy.choose_action(
            heads_up, engine._rank_seven_fast, random.Random(24)
        )
        mw_action, _ = bot_strategy.choose_action(
            nine_way, engine._rank_seven_fast, random.Random(24)
        )
        self.assertEqual(hu_action, "bet")
        self.assertEqual(mw_action, "check")

    def test_nine_way_sampling_is_bounded_and_fast(self):
        context = make_context(
            street="flop", hole_cards=("Js", "Jc"), board=("Jd", "7c", "2h"),
            player_count=9, current_bet=0, pot=100, stack=1000,
        )
        calls = 0

        def counting_rank(cards):
            nonlocal calls
            calls += 1
            return engine._rank_seven_fast(cards)

        started = time.perf_counter()
        action, amount = bot_strategy.choose_action(
            context, counting_rank, random.Random(25)
        )
        elapsed = time.perf_counter() - started
        self.assertEqual(action, "bet")
        self.assert_action_bounded(context, action, amount)
        self.assertLessEqual(calls, bot_strategy.EQUITY_SAMPLES * 9 + 1)
        self.assertLess(elapsed, 2.0, "nine-way evaluation exceeded the bounded runtime")

    def test_large_pot_uses_total_table_limit(self):
        context = make_context(
            hole_cards=("As", "Ah"), player_count=9, pot=3_000_000_000,
            stack=3_000_000_000, current_bet=20,
        )
        normalized = bot_strategy._validate_context(context)
        self.assertEqual(normalized["pot"], 3_000_000_000)
        self.assertEqual(normalized["players"][0]["stack"], 3_000_000_000)


if __name__ == "__main__":
    unittest.main()
