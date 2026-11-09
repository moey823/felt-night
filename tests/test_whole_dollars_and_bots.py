import copy
import json
import unittest
from unittest.mock import patch

import engine
import history
from payouts import whole_dollar_awards, rounded_tournament


class WholeDollarAndBotTests(unittest.TestCase):
    def table(self, count=4, busted_bot=True):
        state = engine.create_lobby("bot-rebuy", "p1", "Ada", {
            "max_seats": count, "starting_stack": 1000, "small_blind": 5, "big_blind": 10,
            "level_minutes": 1, "buy_in": 13, "payout_percentages": [75,25],
            "showdown_seconds": 5, "elimination_announcement_seconds": 0, "blind_announcement_seconds": 0,
        }, now=100)
        for i in range(2,count+1):
            engine.join(state,"p%d"%i,"Player %d"%i,now=101)
        if busted_bot:
            engine._seat_by_id(state,"p%d"%count)["is_bot"] = True
        engine.start(state,"p1",now=102)
        state["hand"]["showdown"] = [{"player_id":"p1","name":"Ada","cards":["As","Ah"],"rank":"Pair of aces"}]
        for seat in state["seats"]:
            seat["stack"] = 0 if seat["player_id"]=="p%d"%count else 1000
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

    def test_no_rebuys_from_two_or_three_player_fields_when_two_or_fewer_remain(self):
        for count in (2,3):
            for bot in (False,True):
                state=self.table(count,bot)
                self.assertEqual(state["rebuy_offers"],{})
                self.assertNotIn("rebuy_hold_started_at",state)
                self.assertEqual(state["status"],"completed" if count==2 else "playing")
                with patch("engine.time.time",return_value=115):
                    for seat in state["seats"]:
                        self.assertIsNone(engine.public_view(state,seat["player_id"])["viewer"]["rebuy_offer"])

    def test_saved_pending_offer_is_closed_on_heads_up_transition(self):
        state=self.table(busted_bot=False)
        old=state["rebuy_offers"]["p4"]["id"]
        engine._seat_by_id(state,"p3")["stack"]=0
        with self.assertRaises(engine.GameError):
            engine.accept_rebuy(state,"p4",old,now=115)
        engine.advance(state,now=115)
        self.assertEqual(state["rebuy_offers"],{})
        self.assertNotIn("rebuy_hold_started_at",state)
        self.assertEqual(state["prize"]["rebuys"],0)
