import copy
import json
import unittest
from unittest.mock import patch

import engine
import history
from payouts import whole_dollar_awards, rounded_tournament


class WholeDollarAndBotTests(unittest.TestCase):
    def table(self, count=4, busted_bot=True, busted_ids=None, bots=None):
        state = engine.create_lobby("bot-rebuy", "p1", "Ada", {
            "max_seats": count, "starting_stack": 1000, "small_blind": 5, "big_blind": 10,
            "level_minutes": 1, "buy_in": 13, "payout_percentages": [75,25],
            "showdown_seconds": 5, "elimination_announcement_seconds": 0, "blind_announcement_seconds": 0,
        }, now=100)
        for i in range(2,count+1):
            engine.join(state,"p%d"%i,"Player %d"%i,now=101)
        if busted_ids is None:
            busted_ids = ("p%d" % count,)
        if bots is None:
            bots = ("p%d" % count,) if busted_bot else ()
        for player_id in bots:
            engine._seat_by_id(state,player_id)["is_bot"] = True
        engine.start(state,"p1",now=102)
        state["hand"]["showdown"] = [{"player_id":"p1","name":"Ada","cards":["As","Ah"],"rank":"Pair of aces"}]
        for seat in state["seats"]:
            seat["stack"] = 0 if seat["player_id"] in busted_ids else 1000
        engine._finish_hand(state,{},now=110)
        return state

    def test_balanced_rounding_conserves_every_pool_and_never_overpays(self):
        for dollars in range(0,201):
            for weights in ([75,25],[71,29],[50,30,20],[33,33,34],[1,1,1,97]):
                raw=[{"player_id":"p%d"%i,"place":i+1,"award_cents":dollars*w} for i,w in enumerate(weights)]
                result=whole_dollar_awards(raw,dollars*100)
                self.assertEqual(sum(row["award_cents"] for row in result),dollars*100)
                self.assertTrue(all(row["award_cents"]>=0 and row["award_cents"]%100==0 for row in result))
        rows=[{"player_id":"a","place":1,"award_cents":1950},{"player_id":"b","place":2,"award_cents":650}]
        self.assertEqual([row["award_cents"] for row in whole_dollar_awards(rows,2600)],[2000,600])
        rows=[{"player_id":"a","place":1,"award_cents":2130},{"player_id":"b","place":2,"award_cents":870}]
        self.assertEqual([row["award_cents"] for row in whole_dollar_awards(rows,3000)],[2100,900])

    def test_saved_completed_views_round_consistently_without_mutating_history(self):
        rows=[{"player_id":"a","name":"Ada","place":1,"award_cents":1950},{"player_id":"b","name":"Bea","place":2,"award_cents":650}]
        old={"status":"completed","prize":{"pool_cents":2600},"results":rows,"standings":rows,"participants":rows}
        before=copy.deepcopy(old)
        view=rounded_tournament(old)
        for key in ("results","standings","participants"):
            self.assertEqual([row["award_cents"] for row in view[key]],[2000,600])
        self.assertEqual(old,before)
        text=history.format_tournament_summary(old)
        self.assertNotIn("19.50",text);self.assertNotIn("6.50",text)

    def test_bot_waits_five_seconds_after_showdown_then_draws_once_and_accounts_rebuy(self):
        for decision in (False,True):
            with self.subTest(rebuy=decision):
                state=self.table()
                offer=state["rebuy_offers"]["p4"]
                self.assertEqual((offer["offered_at"],offer["bot_decision_at"]),(115,120))
                before_pool=state["prize"]["pool_cents"]
                with patch.object(engine.random.SystemRandom,"choice",return_value=decision) as coin:
                    engine.advance(state,now=119.99)
                    coin.assert_not_called()
                    self.assertEqual(state["hand_no"],1)
                    engine.advance(state,now=120)
                    self.assertEqual(coin.call_count,1)
                    self.assertEqual(coin.call_args.args[0],(True,False))
                    engine.advance(state,now=120.01)
                    self.assertEqual(coin.call_count,1)
                self.assertEqual(state["rebuy_offers"],{})
                self.assertEqual(state["prize"]["pool_cents"],before_pool+(1300 if decision else 0))
                self.assertEqual(engine._seat_by_id(state,"p4")["rebuy_count"],int(decision))
                self.assertEqual(state["rebuy_history"][-1]["action"],"accepted" if decision else "declined")
                self.assertNotIn("rebuy_hold_started_at",state)
                self.assertEqual(state["hand_no"],1)
                self.assertEqual(state["rebuy_announcement"]["players"][0]["status"],"accepted" if decision else "declined")
                engine.advance(state,now=124)
                self.assertEqual(state["hand_no"],2)
                if decision:
                    self.assertIn("p4",state["hand"]["holes"])
                else:
                    self.assertNotIn("p4",state["hand"]["holes"])
                # This assertion isolates final payout accounting after the
                # rebuy decision has been checked; the synthetic final hand is
                # no longer an open rebuy hand.
                state["rebuy_enabled"]=False
                for seat in state["seats"]:
                    seat["stack"]=5000 if seat["player_id"]=="p1" else 0
                engine._finish_hand(state,{},now=130)
                self.assertEqual(state["status"],"completed")
                self.assertEqual(sum(row["award_cents"] for row in state["results"]),state["prize"]["pool_cents"])
                self.assertTrue(all(row["award_cents"]%100==0 for row in state["results"]))

    def test_bot_delay_survives_reload_and_freezes_with_host_pause(self):
        state=json.loads(json.dumps(self.table()))
        engine.pause_table(state,"p1",True,now=117)
        with patch.object(engine.random.SystemRandom,"choice",return_value=True) as coin:
            engine.advance(state,now=180)
            coin.assert_not_called()
            engine.pause_table(state,"p1",False,now=200)
            self.assertEqual(state["rebuy_offers"]["p4"]["bot_decision_at"],203)
            engine.advance(state,now=202.99)
            coin.assert_not_called()
            engine.advance(state,now=203)
            self.assertEqual(coin.call_count,1)
        self.assertEqual(state["prize"]["buy_ins"],5)

    def test_two_busted_bots_decide_independently_after_the_full_showdown_hold(self):
        state=self.table(count=4,busted_bot=False,busted_ids=("p3","p4"),bots=("p3","p4"))
        self.assertEqual(set(state["rebuy_offers"]),{"p3","p4"})
        self.assertEqual(sum(seat["stack"] > 0 for seat in state["seats"]),2)
        self.assertEqual(
            {player_id: (offer["offered_at"],offer["bot_decision_at"])
             for player_id,offer in state["rebuy_offers"].items()},
            {"p3": (115,120),"p4": (115,120)},
        )
        # Seating is randomized; decisions follow the recorded offer order.
        declined, accepted = list(state["rebuy_offers"])
        pool_before=state["prize"]["pool_cents"]

        with patch.object(engine.random.SystemRandom,"choice",side_effect=(False,True)) as coin:
            engine.advance(state,now=114.99)
            coin.assert_not_called()
            engine.advance(state,now=115)
            coin.assert_not_called()
            self.assertEqual(state["hand_no"],1)
            engine.advance(state,now=119.99)
            coin.assert_not_called()
            engine.advance(state,now=120)
            self.assertEqual(coin.call_count,2)
            self.assertEqual(coin.call_args_list[0].args[0],(True,False))
            self.assertEqual(coin.call_args_list[1].args[0],(True,False))

        self.assertEqual(state["hand_no"],1)
        self.assertEqual(state["status"],"playing")
        self.assertEqual(state["rebuy_offers"],{})
        self.assertEqual(engine._seat_by_id(state,declined)["stack"],0)
        self.assertEqual(engine._seat_by_id(state,accepted)["stack"],1000)
        self.assertEqual(state["prize"]["rebuys"],1)
        self.assertEqual(state["prize"]["pool_cents"],pool_before+1300)
        self.assertEqual(
            {row["player_id"]: row["action"] for row in state["rebuy_history"] if row["action"] != "offered"},
            {declined:"declined",accepted:"accepted"},
        )
        engine.advance(state,now=123.99)
        self.assertEqual(state["hand_no"],1)
        engine.advance(state,now=124)
        self.assertEqual(state["hand_no"],2)
        self.assertNotIn(declined,state["hand"]["holes"])
        self.assertIn(accepted,state["hand"]["holes"])

    def test_two_player_hand_has_no_offer_but_three_player_hand_can_rebuy_from_heads_up(self):
        for bot in (False,True):
            with self.subTest(bot=bot, starting_players=2):
                state=self.table(count=2,busted_bot=bot)
                self.assertEqual(state["rebuy_offers"],{})
                self.assertNotIn("rebuy_hold_started_at",state)
                self.assertEqual(state["status"],"completed")
                with patch("engine.time.time",return_value=115):
                    for seat in state["seats"]:
                        self.assertIsNone(engine.public_view(state,seat["player_id"])["viewer"]["rebuy_offer"])
            with self.subTest(bot=bot, starting_players=3):
                state=self.table(count=3,busted_bot=bot)
                self.assertEqual(set(state["rebuy_offers"]),{"p3"})
                self.assertIn("rebuy_hold_started_at",state)
                self.assertEqual(state["status"],"playing")
                self.assertEqual(sum(seat["stack"] > 0 for seat in state["seats"]),2)
                with patch("engine.time.time",return_value=115):
                    self.assertIsNotNone(engine.public_view(state,"p3")["viewer"]["rebuy_offer"])

    def test_saved_pending_offer_remains_valid_after_multi_bust_heads_up_transition(self):
        state=json.loads(json.dumps(self.table(busted_bot=False,busted_ids=("p3","p4"))))
        old=state["rebuy_offers"]["p4"]["id"]
        self.assertEqual(sum(seat["stack"] > 0 for seat in state["seats"]),2)
        self.assertEqual(set(state["rebuy_offers"]),{"p3","p4"})
        engine.accept_rebuy(state,"p4",old,now=115)
        self.assertEqual(engine._seat_by_id(state,"p4")["stack"],1000)
        self.assertEqual(set(state["rebuy_offers"]),{"p3"})
        self.assertEqual(state["status"],"playing")
        self.assertEqual(state["prize"]["rebuys"],1)

    def test_simultaneous_human_and_bot_busts_can_both_reenter_from_heads_up(self):
        state=self.table(count=4,busted_bot=False,busted_ids=("p3","p4"),bots=("p4",))
        self.assertEqual(set(state["rebuy_offers"]),{"p3","p4"})
        self.assertEqual(sum(seat["stack"] > 0 for seat in state["seats"]),2)
        self.assertEqual(state["rebuy_offers"]["p4"]["bot_decision_at"],120)
        pool_before=state["prize"]["pool_cents"]

        engine.accept_rebuy(state,"p3",state["rebuy_offers"]["p3"]["id"],now=115)
        self.assertEqual(set(state["rebuy_offers"]),{"p4"})
        with patch.object(engine.random.SystemRandom,"choice",return_value=True) as coin:
            engine.advance(state,now=119.99)
            coin.assert_not_called()
            self.assertEqual(state["hand_no"],1)
            engine.advance(state,now=120)
            self.assertEqual(coin.call_count,1)
            self.assertEqual(state["hand_no"],1)

        self.assertEqual(state["rebuy_offers"],{})
        self.assertEqual(state["status"],"playing")
        self.assertEqual(engine._seat_by_id(state,"p3")["stack"],1000)
        self.assertEqual(engine._seat_by_id(state,"p4")["stack"],1000)
        self.assertEqual(state["prize"]["rebuys"],2)
        self.assertEqual(state["prize"]["pool_cents"],pool_before+2600)
        engine.advance(state,now=123.99)
        self.assertEqual(state["hand_no"],1)
        engine.advance(state,now=124)
        self.assertEqual(state["hand_no"],2)
        self.assertTrue({"p3","p4"}.issubset(state["hand"]["holes"]))
