import unittest

import history


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
        self.assertIn("Buy-in: 10 play credits", text)
        self.assertIn("Entrants: 2", text)
        self.assertIn("Prize pool: 20 play credits", text)
        self.assertIn("Final standings:", text)
        self.assertIn("1. Hero — 3000 chips — 14 play credits", text)
        self.assertIn("2. Rival — 0 chips — 6 play credits", text)
        self.assertNotIn("PokerStars", text)

    def test_hand_text_formats_recorded_actions_results_and_only_visible_cards(self):
        text = history.format_hand_history(self.tournament, self.hand, "hero")
        self.assertIn("Felt Night Hand #7: No-Limit Texas Hold'em (10/20 play chips)", text)
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
