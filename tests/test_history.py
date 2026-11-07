import sqlite3
import unittest

import history


class HistoryRebuyPersistenceTests(unittest.TestCase):
    def test_legacy_participant_total_is_known_only_when_saved_prize_has_buyin(self):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        try:
            history.create_schema(conn)
            for table_id, prize, expected in (
                ("k" * 32, {"buy_in": 15, "entrants": 1}, 1500),
                ("u" * 32, {"entrants": 1}, None),
            ):
                state = {
                    "id": table_id, "host_id": "p1", "name": "Legacy ledger",
                    "status": "playing", "created_at": 1.0, "started_at": 2.0,
                    "config": {"buy_in": 99},
                    "prize": prize,
                    "seats": [{"player_id": "p1", "name": "Ada", "stack": 100}],
                    "hand_no": 1, "results": [], "elimination_order": [],
                }
                history.record_table_created(conn, state, "p1", 1.0)
                history.sync_state(conn, state, 2.0)
                participant = history._participants(conn, table_id)[0]
                self.assertEqual(participant["buy_in_count"], 1)
                self.assertEqual(participant["total_buy_in_cents"], expected)
                summary = history.format_tournament_summary({
                    "name": "Legacy ledger", "status": "playing", "config": state["config"],
                    "prize": state["prize"], "participants": [participant],
                    "standings": [{"name": "Ada", "status": "active", "chips": 100,
                                   "total_buy_in_cents": participant["total_buy_in_cents"],
                                   "rebuy_count": 0}],
                })
                if expected is None:
                    self.assertNotIn("total buy-in", summary)
                else:
                    self.assertIn("total buy-in $15", summary)
        finally:
            conn.close()

    def test_rebuy_sync_keeps_ended_hand_stack_and_clears_provisional_place(self):
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        try:
            history.create_schema(conn)
            state = {
                "id": "t" * 32,
                "host_id": "p1",
                "name": "History rebuy",
                "status": "playing",
                "created_at": 100.0,
                "started_at": 101.0,
                "config": {"buy_in": 10, "starting_stack": 100},
                "prize": {
                    "buy_in": 10, "entrants": 2, "buy_ins": 2,
                    "rebuys": 0, "pool_cents": 2000,
                    "payout_percentages": [75, 25],
                },
                "results": [],
                "seats": [
                    {"player_id": "p1", "name": "Ada", "seat_no": 0,
                     "stack": 0, "rebuy_count": 0, "buy_in_count": 1,
                     "total_buy_in_cents": 1000},
                    {"player_id": "p2", "name": "Bea", "seat_no": 1,
                     "stack": 200, "rebuy_count": 0, "buy_in_count": 1,
                     "total_buy_in_cents": 1000},
                ],
                "hand_no": 1,
                "elimination_order": [{
                    "player_id": "p1", "name": "Ada", "seat_no": 0,
                    "place": 2, "hand_no": 1, "award_cents": 500,
                }],
                "hand": {
                    "number": 1, "hand_id": "t" * 32 + ":1",
                    "started_at": 101.0, "street": "showdown", "board": [],
                    "events": [], "event_seq": 0,
                    "holes": {"p1": ["As", "Ks"], "p2": ["Ah", "Kh"]},
                    "stack_before": {"p1": 100, "p2": 100},
                    "showdown": [], "payouts": {}, "pot_winnings": {},
                    "pots": [], "returns": [], "revealed": [],
                },
            }
            history.record_table_created(conn, state, "p1", 100.0)
            history.sync_state(conn, state, 102.0)
            hand_row = conn.execute(
                "SELECT stack_after FROM hand_history_players WHERE hand_id=? AND player_id='p1'",
                (state["hand"]["hand_id"],),
            ).fetchone()
            self.assertEqual(hand_row["stack_after"], 0)

            state["seats"][0].update({
                "stack": 100, "rebuy_count": 1, "buy_in_count": 2,
                "total_buy_in_cents": 2000,
            })
            state["prize"].update({"buy_ins": 3, "rebuys": 1, "pool_cents": 3000})
            state["elimination_order"] = []
            history.sync_state(conn, state, 103.0)

            hand_row = conn.execute(
                "SELECT stack_after FROM hand_history_players WHERE hand_id=? AND player_id='p1'",
                (state["hand"]["hand_id"],),
            ).fetchone()
            self.assertEqual(hand_row["stack_after"], 0)
            participant = next(
                row for row in history._participants(conn, state["id"])
                if row["player_id"] == "p1"
            )
            self.assertIsNone(participant["place"])
            self.assertIsNone(participant["award_cents"])
            self.assertEqual(participant["rebuy_count"], 1)
            self.assertEqual(participant["buy_in_count"], 2)
            self.assertEqual(participant["total_buy_in_cents"], 2000)
            self.assertEqual(state["prize"]["entrants"], 2)
        finally:
            conn.close()


class HistoryTextTests(unittest.TestCase):
    def setUp(self):
        self.tournament = {
            "id": "a" * 32,
            "name": "Saturday Sit & Go",
            "status": "completed",
            "created": 1_800_000_000,
            "started": 1_800_000_010,
            "completed": 1_800_003_000,
            "hand_count": 12,
            "config": {
                "buy_in": 10,
                "starting_stack": 1500,
                "small_blind": 10,
                "big_blind": 20,
                "payout_percentages": [70, 30],
            },
            "prize": {"buy_in": 10, "entrants": 2, "pool_cents": 2000},
            "participants": [
                {"player_id": "hero", "name": "Hero"},
                {"player_id": "rival", "name": "Rival"},
            ],
            "results": [
                {"player_id": "hero", "name": "Hero", "place": 1, "chips": 3000, "award_cents": 1400},
                {"player_id": "rival", "name": "Rival", "place": 2, "chips": 0, "award_cents": 600},
            ],
            "standings": [],
        }
        self.hand = {
            "number": 7,
            "started": 1_800_002_000,
            "ended": 1_800_002_030,
            "street": "showdown",
            "small_blind": 10,
            "big_blind": 20,
            "blind_level": 3,
            "button_player_id": "hero",
            "board": ["2c", "3d", "4h", "5s", "6c"],
            "events_complete": True,
            "events": [
                {"seq": 1, "type": "action", "street": "preflop", "actor_id": "hero", "blind": "small", "action": "small_blind", "amount": 10},
                {"seq": 2, "type": "action", "street": "preflop", "actor_id": "rival", "blind": "big", "action": "big_blind", "amount": 20},
                {"seq": 3, "type": "action", "street": "preflop", "actor_id": "hero", "action": "raise", "amount": 50, "target": 60},
                {"seq": 4, "type": "action", "street": "preflop", "actor_id": "rival", "action": "all-in", "amount": 100, "target": 120},
                {"seq": 5, "type": "action", "street": "preflop", "actor_id": "hero", "action": "call", "amount": 60, "target": 120},
                {"seq": 6, "type": "street", "street": "flop", "board": ["2c", "3d", "4h"]},
                {"seq": 7, "type": "action", "street": "flop", "actor_id": "hero", "action": "check", "amount": 0},
                {"seq": 8, "type": "street", "street": "turn", "board": ["2c", "3d", "4h", "5s"]},
                {"seq": 9, "type": "street", "street": "river", "board": ["2c", "3d", "4h", "5s", "6c"]},
            ],
            "players": [
                {"player_id": "hero", "name": "Hero", "seat_no": 0, "cards": ["As", "Kd"], "revealed": False, "stack_before": 200},
                {"player_id": "rival", "name": "Rival", "seat_no": 1, "cards": None, "revealed": False, "stack_before": 180},
            ],
            "result": {
                "pots": [{"label": "Main pot", "amount": 260}],
                "pot_winnings": {"hero": 260},
                "returns": [{"player_id": "rival", "amount": 10}],
                "showdown": [{"player_id": "hero", "hand_name": "Straight", "rank": "Straight, Six high"}],
            },
        }

    def test_tournament_summary_uses_saved_entries_prize_and_finish(self):
        text = history.format_tournament_summary(self.tournament)
        self.assertIn("Felt Night Tournament Summary", text)
        self.assertIn("Tournament: Saturday Sit & Go", text)
        self.assertIn("Buy-in: $10", text)
        self.assertIn("Entrants: 2", text)
        self.assertIn("Prize pool: $20", text)
        self.assertIn("Final standings:", text)
        self.assertIn("1. Hero — 3000 chips — $14", text)
        self.assertIn("2. Rival — 0 chips — $6", text)
        self.assertNotIn("PokerStars", text)

    def test_hand_text_formats_recorded_actions_results_and_only_visible_cards(self):
        text = history.format_hand_history(self.tournament, self.hand, "hero")
        self.assertIn("Felt Night Hand #7: No-Limit Texas Hold'em (10/20 chips)", text)
        self.assertIn("Blind level 3 (10/20)", text)
        self.assertIn("Seat #1 is the button", text)
        self.assertIn("Dealt to Hero [As Kd]", text)
        self.assertIn("Hero: raises to 60", text)
        self.assertIn("Rival: is all-in for 100", text)
        self.assertIn("Hero: calls 60", text)
        self.assertIn("*** FLOP *** [2c 3d 4h]", text)
        self.assertIn("*** TURN *** [2c 3d 4h 5s]", text)
        self.assertIn("*** RIVER *** [2c 3d 4h 5s 6c]", text)
        self.assertIn("Main pot: 260 chips", text)
        self.assertIn("Hero collected 260 chips with Straight", text)
        self.assertIn("Uncalled bet of 10 chips returned to Rival", text)
        self.assertNotIn("Dealt to Rival", text)
        self.assertNotIn("PokerStars", text)

    def test_ended_early_summary_does_not_invent_a_winner(self):
        tournament = dict(self.tournament)
        tournament.update({
            "status": "ended",
            "results": [],
            "standings": [{"player_id": "hero", "name": "Hero", "status": "active", "chips": 200}],
        })
        text = history.format_tournament_summary(tournament)
        self.assertIn("Status: Ended early", text)
        self.assertIn("Standings when the game ended:", text)
        self.assertIn("No final result was declared.", text)
        self.assertNotIn("Final standings:", text)


if __name__ == "__main__":
    unittest.main()
