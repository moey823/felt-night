"""Authoritative, JSON-serializable no-limit Texas Hold'em sit-and-go engine.

This module has no I/O and uses only the Python standard library. A caller owns
persistence and must serialize each table's mutations (for example with a DB
transaction). Chip values are integer play-money units only.
"""
from __future__ import annotations

import itertools
import math
import random
import time
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


TURN_SECONDS = 30
MAX_SEATS = 9
MAX_LOG_ENTRIES = 40
MAX_CHIPS = 1_000_000_000
LOBBY_IDLE_SECONDS = 4 * 60 * 60
SUITS = ("s", "h", "d", "c")
RANK_CHARS = "23456789TJQKA"
RANK_VALUES = {char: value for value, char in enumerate(RANK_CHARS, 2)}
HAND_NAMES = (
    "High card",
    "One pair",
    "Two pair",
    "Three of a kind",
    "Straight",
    "Flush",
    "Full house",
    "Four of a kind",
    "Straight flush",
)


class GameError(Exception):
    """Expected game-rule error with a stable API-friendly code and status."""

    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def _now(value: Optional[float]) -> float:
    return time.time() if value is None else float(value)


def _integer(value: Any, label: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise GameError("invalid_config", "%s must be a whole number." % label)
    if value < minimum or value > maximum:
        raise GameError(
            "invalid_config",
            "%s must be between %d and %d." % (label, minimum, maximum),
        )
    return value


def _valid_name(name: Any) -> str:
    if not isinstance(name, str):
        raise GameError("invalid_name", "Enter a player name.")
    cleaned = name.strip()
    if not cleaned or len(cleaned) > 32 or any(ord(char) < 32 or ord(char) == 127 for char in cleaned):
        raise GameError("invalid_name", "Player names must be 1–32 printable characters.")
    return cleaned


def _seat_by_id(state: Dict[str, Any], player_id: str) -> Optional[Dict[str, Any]]:
    for seat in state["seats"]:
        if seat["player_id"] == player_id:
            return seat
    return None


def _seats_in_order(state: Dict[str, Any]) -> List[Dict[str, Any]]:
    return sorted(state["seats"], key=lambda item: item["seat_no"])


def _clockwise_after(state: Dict[str, Any], player_id: Optional[str]) -> List[Dict[str, Any]]:
    seats = _seats_in_order(state)
    if not seats:
        return []
    found = next((idx for idx, seat in enumerate(seats) if seat["player_id"] == player_id), None)
    start = 0 if found is None else (found + 1) % len(seats)
    return seats[start:] + seats[:start]


def _next_live_after(state: Dict[str, Any], player_id: Optional[str]) -> Optional[str]:
    for seat in _clockwise_after(state, player_id):
        if seat["stack"] > 0:
            return seat["player_id"]
    return None


def _log(state: Dict[str, Any], text: str, now: float) -> None:
    state["action_log"].append({"text": text, "time": int(now)})
    if len(state["action_log"]) > MAX_LOG_ENTRIES:
        del state["action_log"][:-MAX_LOG_ENTRIES]


def _bump(state: Dict[str, Any]) -> None:
    state["version"] += 1


def create_lobby(
    table_id: str,
    host_id: str,
    host_name: str,
    config: Dict[str, Any],
    now: Optional[float] = None,
) -> Dict[str, Any]:
    """Create a lobby and seat its host."""
    if not isinstance(config, dict):
        raise GameError("invalid_config", "Table settings are required.")
    max_seats = _integer(config.get("max_seats", 9), "Seat count", 2, MAX_SEATS)
    starting_stack = _integer(config.get("starting_stack", 1500), "Starting stack", 100, MAX_CHIPS)
    small_blind = _integer(config.get("small_blind", 10), "Small blind", 1, MAX_CHIPS)
    big_blind = _integer(config.get("big_blind", 20), "Big blind", 2, MAX_CHIPS)
    level_minutes = _integer(config.get("level_minutes", 10), "Blind level length", 1, 60)
    turn_seconds = _integer(config.get("turn_seconds", TURN_SECONDS), "Turn length", 10, 120)
    if big_blind < small_blind:
        raise GameError("invalid_config", "The big blind must be at least the small blind.")
    if big_blind > starting_stack:
        raise GameError("invalid_config", "The starting stack must cover the big blind.")

    timestamp = _now(now)
    host_name = _valid_name(host_name)
    return {
        "id": str(table_id),
        "name": " ".join(host_name.split()) + "'s table",
        "host_id": str(host_id),
        "host_name": host_name,
        "status": "lobby",
        "config": {
            "max_seats": max_seats,
            "starting_stack": starting_stack,
            "small_blind": small_blind,
            "big_blind": big_blind,
            "level_minutes": level_minutes,
            "turn_seconds": turn_seconds,
        },
        "seats": [
            {
                "player_id": str(host_id),
                "name": host_name,
                "seat_no": 0,
                "stack": starting_stack,
            }
        ],
        "created_at": timestamp,
        "last_activity_at": timestamp,
        "started_at": None,
        "button_id": None,
        "hand_no": 0,
        "turn_version": 0,
        "version": 1,
        "blinds": {
            "level": 1,
            "small": small_blind,
            "big": big_blind,
            "started_at": None,
            "next_level_at": None,
        },
        "hand": None,
        "action_log": [],
        "elimination_order": [],
        "results": [],
    }


def join(
    state: Dict[str, Any],
    player_id: str,
    name: str,
    now: Optional[float] = None,
) -> Dict[str, Any]:
    """Seat a player in a lobby. Repeating a join for the same identity is safe."""
    if _seat_by_id(state, player_id):
        return state
    if state["status"] != "lobby":
        raise GameError("table_started", "This table has already started.", 409)
    if len(state["seats"]) >= state["config"]["max_seats"]:
        raise GameError("table_full", "This table has no open seats.", 409)
    player_name = _valid_name(name)
    used = {seat["seat_no"] for seat in state["seats"]}
    seat_no = next(index for index in range(state["config"]["max_seats"]) if index not in used)
    state["seats"].append(
        {
            "player_id": str(player_id),
            "name": player_name,
            "seat_no": seat_no,
            "stack": state["config"]["starting_stack"],
        }
    )
    state["seats"].sort(key=lambda item: item["seat_no"])
    timestamp = _now(now)
    state["last_activity_at"] = timestamp
    _log(state, "%s joined the table." % player_name, timestamp)
    _bump(state)
    return state


def leave(
    state: Dict[str, Any],
    actor_id: str,
    now: Optional[float] = None,
) -> Dict[str, Any]:
    """Let a seated player leave a lobby; reassign the host if needed."""
    if state["status"] != "lobby":
        raise GameError("table_started", "Players cannot leave after the tournament starts.", 409)
    seat = _seat_by_id(state, actor_id)
    if seat is None:
        raise GameError("not_seated", "You do not have a seat at this table.", 409)
    timestamp = _now(now)
    player_name = seat["name"]
    state["seats"].remove(seat)
    _log(state, "%s left the lobby." % player_name, timestamp)
    state["last_activity_at"] = timestamp
    if not state["seats"]:
        state["status"] = "cancelled"
        state["cancelled_at"] = timestamp
        state["cancellation_reason"] = "empty"
        _log(state, "Lobby closed because it is empty.", timestamp)
    elif actor_id == state["host_id"]:
        replacement = min(state["seats"], key=lambda item: item["seat_no"])
        state["host_id"] = replacement["player_id"]
        state["host_name"] = replacement["name"]
        state["name"] = " ".join(replacement["name"].split()) + "'s table"
        _log(state, "%s is now the host." % replacement["name"], timestamp)
    _bump(state)
    return state


def cancel(
    state: Dict[str, Any],
    actor_id: str,
    now: Optional[float] = None,
) -> Dict[str, Any]:
    """Cancel a lobby. Only its current host can do so."""
    if actor_id != state["host_id"]:
        raise GameError("host_only", "Only the table host can cancel this lobby.", 403)
    if state["status"] != "lobby":
        raise GameError("table_started", "Only a lobby can be cancelled.", 409)
    timestamp = _now(now)
    state["status"] = "cancelled"
    state["cancelled_at"] = timestamp
    state["cancellation_reason"] = "host"
    state["last_activity_at"] = timestamp
    _log(state, "Lobby cancelled by the host.", timestamp)
    _bump(state)
    return state


def start(
    state: Dict[str, Any],
    actor_id: str,
    now: Optional[float] = None,
) -> Dict[str, Any]:
    """Start a tournament. The creator must start it with at least two seats."""
    if actor_id != state["host_id"]:
        raise GameError("host_only", "Only the table host can start this tournament.", 403)
    if state["status"] != "lobby":
        raise GameError("table_started", "This table has already started.", 409)
    if len(state["seats"]) < 2:
        raise GameError("need_players", "At least two players are needed to start.", 409)

    timestamp = _now(now)
    state["status"] = "playing"
    state["started_at"] = timestamp
    state["last_activity_at"] = timestamp
    state["blinds"]["started_at"] = timestamp
    state["blinds"]["next_level_at"] = timestamp + state["config"]["level_minutes"] * 60
    _log(state, "Tournament started at level 1.", timestamp)
    _start_hand(state, timestamp, first=True)
    _bump(state)
    return state


def _deck() -> List[str]:
    cards = [rank + suit for rank in RANK_CHARS for suit in SUITS]
    random.SystemRandom().shuffle(cards)
    return cards


def _take_card(hand: Dict[str, Any]) -> str:
    return hand["deck"].pop()


def _post_blind(state: Dict[str, Any], hand: Dict[str, Any], player_id: str, amount: int) -> int:
    seat = _seat_by_id(state, player_id)
    assert seat is not None
    paid = min(seat["stack"], amount)
    seat["stack"] -= paid
    hand["bets"][player_id] = paid
    hand["contrib"][player_id] = paid
    return paid


def _start_hand(state: Dict[str, Any], now: float, first: bool = False) -> None:
    alive = [seat for seat in _seats_in_order(state) if seat["stack"] > 0]
    if len(alive) <= 1:
        _complete_tournament(state, now)
        return

    previous_hand = state.get("hand")
    alive_ids = {seat["player_id"] for seat in alive}
    if first or state["button_id"] is None:
        button = alive[0]["player_id"]
    elif (
        len(alive) == 2
        and previous_hand is not None
        and len(previous_hand.get("holes", {})) == 3
        and previous_hand.get("button_id") not in alive_ids
        and previous_hand.get("big_blind_id") in alive_ids
    ):
        # On a three-to-two transition where the old button busts, make the
        # previous big blind the button so they do not post the big blind twice.
        button = previous_hand["big_blind_id"]
    else:
        button = _next_live_after(state, state["button_id"])
        if button is None:
            button = alive[0]["player_id"]
    state["button_id"] = button

    if len(alive) == 2:
        small_id = button
        big_id = _next_live_after(state, button)
    else:
        small_id = _next_live_after(state, button)
        big_id = _next_live_after(state, small_id)
    assert small_id is not None and big_id is not None

    state["hand_no"] += 1
    hole_cards: Dict[str, List[str]] = {seat["player_id"]: [] for seat in alive}
    hand: Dict[str, Any] = {
        "number": state["hand_no"],
        "street": "preflop",
        "board": [],
        "deck": _deck(),
        "holes": hole_cards,
        "bets": {seat["player_id"]: 0 for seat in alive},
        "contrib": {seat["player_id"]: 0 for seat in alive},
        "folded": [],
        "acted": [],
        "acted_at_bet": {},
        "short_opening": False,
        "current_bet": 0,
        "min_raise": state["blinds"]["big"],
        "button_id": button,
        "small_blind_id": small_id,
        "big_blind_id": big_id,
        "to_act": None,
        "turn_deadline": None,
        "stack_before": {seat["player_id"]: seat["stack"] for seat in alive},
        "showdown": [],
        "payouts": {},
        "next_hand_at": None,
        "small_blind": state["blinds"]["small"],
        "big_blind": state["blinds"]["big"],
    }
    state["hand"] = hand

    deal_order = [seat["player_id"] for seat in _clockwise_after(state, button) if seat["stack"] > 0]
    for _ in range(2):
        for player_id in deal_order:
            hole_cards[player_id].append(_take_card(hand))

    small_paid = _post_blind(state, hand, small_id, hand["small_blind"])
    big_paid = _post_blind(state, hand, big_id, hand["big_blind"])
    # The nominal big blind establishes the preflop bring-in even when the
    # actual big blind stack was too short to post it in full.
    hand["current_bet"] = max(hand["big_blind"], small_paid, big_paid)
    _log(
        state,
        "Hand %d: %s posts %d, %s posts %d." % (
            hand["number"],
            _seat_by_id(state, small_id)["name"],
            small_paid,
            _seat_by_id(state, big_id)["name"],
            big_paid,
        ),
        now,
    )
    _set_next_actor(state, big_id, now)


def _hand_live_ids(hand: Dict[str, Any]) -> List[str]:
    folded = set(hand["folded"])
    return [player_id for player_id in hand["holes"] if player_id not in folded]


def _players_able_to_act(state: Dict[str, Any], hand: Dict[str, Any]) -> List[str]:
    folded = set(hand["folded"])
    return [
        player_id
        for player_id in hand["holes"]
        if player_id not in folded and (_seat_by_id(state, player_id) or {}).get("stack", 0) > 0
    ]


def _pending(state: Dict[str, Any], hand: Dict[str, Any], player_id: str) -> bool:
    if player_id in hand["folded"]:
        return False
    seat = _seat_by_id(state, player_id)
    if seat is None or seat["stack"] <= 0:
        return False
    bet = hand["bets"].get(player_id, 0)
    return bet < hand["current_bet"] or player_id not in hand["acted"]


def _arm_turn(state: Dict[str, Any], hand: Dict[str, Any], player_id: str, now: float) -> None:
    state["turn_version"] += 1
    hand["to_act"] = player_id
    hand["turn_deadline"] = now + state["config"]["turn_seconds"]


def _set_next_actor(state: Dict[str, Any], after_id: Optional[str], now: float) -> None:
    hand = state["hand"]
    assert hand is not None
    contenders = _hand_live_ids(hand)
    if len(contenders) <= 1:
        _award_without_showdown(state, contenders[0] if contenders else None, now)
        return

    able = _players_able_to_act(state, hand)
    if len(able) == 1:
        only_player = able[0]
        if hand["bets"].get(only_player, 0) >= hand["current_bet"]:
            # No opponent can call a further wager, so there is no dry-side-pot
            # betting. Advance the board instead of forcing meaningless checks.
            _advance_street(state, now)
            return

    for seat in _clockwise_after(state, after_id):
        player_id = seat["player_id"]
        if player_id in hand["holes"] and _pending(state, hand, player_id):
            _arm_turn(state, hand, player_id, now)
            return

    _advance_street(state, now)


def _round_complete(state: Dict[str, Any], hand: Dict[str, Any]) -> bool:
    for player_id in _hand_live_ids(hand):
        seat = _seat_by_id(state, player_id)
        if seat is None or seat["stack"] <= 0:
            continue
        if hand["bets"].get(player_id, 0) < hand["current_bet"]:
            return False
        if player_id not in hand["acted"]:
            return False
    return True


def _advance_street(state: Dict[str, Any], now: float) -> None:
    hand = state["hand"]
    assert hand is not None
    while True:
        live = _hand_live_ids(hand)
        if len(live) <= 1:
            _award_without_showdown(state, live[0] if live else None, now)
            return

        if hand["street"] == "river":
            _settle_showdown(state, now)
            return

        if hand["street"] == "preflop":
            _take_card(hand)  # burn
            hand["board"].extend([_take_card(hand) for _ in range(3)])
            hand["street"] = "flop"
        elif hand["street"] == "flop":
            _take_card(hand)
            hand["board"].append(_take_card(hand))
            hand["street"] = "turn"
        elif hand["street"] == "turn":
            _take_card(hand)
            hand["board"].append(_take_card(hand))
            hand["street"] = "river"
        else:
            _settle_showdown(state, now)
            return

        hand["bets"] = {player_id: 0 for player_id in hand["holes"]}
        hand["current_bet"] = 0
        hand["min_raise"] = hand["big_blind"]
        hand["acted"] = []
        hand["acted_at_bet"] = {}
        hand["short_opening"] = False
        _log(state, "%s dealt." % hand["street"].capitalize(), now)

        if not _players_able_to_act(state, hand):
            continue

        _set_next_actor(state, hand["button_id"], now)
        return


def _contribute(state: Dict[str, Any], hand: Dict[str, Any], player_id: str, amount: int) -> None:
    seat = _seat_by_id(state, player_id)
    assert seat is not None
    if amount < 0 or amount > seat["stack"]:
        raise AssertionError("invalid chip contribution")
    seat["stack"] -= amount
    hand["bets"][player_id] = hand["bets"].get(player_id, 0) + amount
    hand["contrib"][player_id] = hand["contrib"].get(player_id, 0) + amount


def _to_call(hand: Dict[str, Any], player_id: str) -> int:
    return max(0, hand["current_bet"] - hand["bets"].get(player_id, 0))


def _has_raise_right(hand: Dict[str, Any], player_id: str) -> bool:
    """Check whether action since this player's last action has reopened."""
    if player_id not in hand.get("acted_at_bet", {}):
        return True
    baseline = hand["acted_at_bet"][player_id]
    if hand["current_bet"] - baseline >= hand["min_raise"]:
        return True
    return bool(hand.get("short_opening") and baseline == 0)


def _has_raise_opponent(state: Dict[str, Any], hand: Dict[str, Any], actor_id: str) -> bool:
    return any(player_id != actor_id for player_id in _players_able_to_act(state, hand))


def _action_text(state: Dict[str, Any], player_id: str, action: str, paid: int, target: int) -> str:
    seat = _seat_by_id(state, player_id)
    name = seat["name"] if seat else "Player"
    if action == "fold":
        return "%s folds." % name
    if action == "check":
        return "%s checks." % name
    if action == "call":
        return "%s calls %d." % (name, paid)
    if action == "bet":
        return "%s bets %d." % (name, target)
    if action == "raise":
        return "%s raises to %d." % (name, target)
    if action == "all_in":
        return "%s is all-in for %d." % (name, paid)
    return "%s acts." % name


def _perform_action(
    state: Dict[str, Any],
    actor_id: str,
    action: str,
    amount: Optional[int],
    now: float,
    timed_out: bool = False,
) -> None:
    hand = state["hand"]
    assert hand is not None
    if state["status"] != "playing" or hand["street"] == "showdown":
        raise GameError("hand_not_active", "There is no active betting round.", 409)
    if hand["to_act"] != actor_id:
        raise GameError("not_your_turn", "It is not your turn.", 409)
    if actor_id in hand["folded"]:
        raise GameError("already_folded", "You have folded this hand.", 409)
    seat = _seat_by_id(state, actor_id)
    if seat is None or seat["stack"] <= 0:
        raise GameError("cannot_act", "You have no chips available to act.", 409)

    current = hand["current_bet"]
    player_bet = hand["bets"].get(actor_id, 0)
    to_call = max(0, current - player_bet)
    max_total = player_bet + seat["stack"]
    action = action.lower() if isinstance(action, str) else ""

    if timed_out:
        action = "check" if to_call == 0 else "fold"

    if action == "fold":
        hand["folded"].append(actor_id)
        paid = 0
        target = player_bet
    elif action == "check":
        if to_call != 0:
            raise GameError("cannot_check", "There is a bet to call.", 400)
        paid = 0
        target = player_bet
    elif action == "call":
        if to_call == 0:
            raise GameError("nothing_to_call", "There is no bet to call; check instead.", 400)
        paid = min(to_call, seat["stack"])
        _contribute(state, hand, actor_id, paid)
        target = hand["bets"][actor_id]
    elif action in ("bet", "raise"):
        if action == "bet" and current != 0:
            raise GameError("use_raise", "A bet is already open; raise instead.", 400)
        if action == "raise" and current == 0:
            raise GameError("use_bet", "There is no bet to raise; bet instead.", 400)
        if isinstance(amount, bool) or not isinstance(amount, int):
            raise GameError("invalid_amount", "Enter a whole-chip raise-to amount.")
        target = amount
        if target <= current:
            raise GameError("raise_too_small", "The raise-to amount must exceed the current bet.", 400)
        if target > max_total:
            raise GameError("over_stack", "The raise exceeds your available chips.", 400)
        if not _has_raise_right(hand, actor_id):
            raise GameError("raise_not_reopened", "The action has not been reopened for you to raise.", 400)
        if not _has_raise_opponent(state, hand, actor_id):
            raise GameError("dry_side_pot", "No opponent has chips available to call a raise.", 400)
        minimum = current + hand["min_raise"] if current else hand["min_raise"]
        if target < minimum and target != max_total:
            raise GameError("raise_too_small", "The minimum raise-to amount is %d." % minimum, 400)
        paid = target - player_bet
        _contribute(state, hand, actor_id, paid)
        increase = target - current
        full_raise = increase >= hand["min_raise"]
        if full_raise:
            hand["min_raise"] = increase
            hand["acted"] = [actor_id]
        elif current == 0:
            hand["short_opening"] = True
        hand["current_bet"] = target
    elif action == "all_in":
        paid = seat["stack"]
        target = player_bet + paid
        if target > current and not _has_raise_right(hand, actor_id):
            raise GameError("raise_not_reopened", "The action has not been reopened for you to raise.", 400)
        if target > current and not _has_raise_opponent(state, hand, actor_id):
            raise GameError("dry_side_pot", "No opponent has chips available to call a raise.", 400)
        _contribute(state, hand, actor_id, paid)
        if target > current:
            increase = target - current
            if increase >= hand["min_raise"]:
                hand["min_raise"] = increase
                hand["acted"] = [actor_id]
            elif current == 0:
                hand["short_opening"] = True
            hand["current_bet"] = target
    else:
        raise GameError("invalid_action", "Choose fold, check, call, bet, raise, or all-in.")

    if actor_id not in hand["acted"]:
        hand["acted"].append(actor_id)
    hand.setdefault("acted_at_bet", {})[actor_id] = hand["current_bet"]
    text = _action_text(state, actor_id, action, paid, target)
    if timed_out:
        text = "%s timed out and %s." % (
            seat["name"],
            "checked" if action == "check" else "folded",
        )
    _log(state, text, now)

    live = _hand_live_ids(hand)
    if len(live) <= 1:
        _award_without_showdown(state, live[0] if live else None, now)
        return

    if _round_complete(state, hand):
        _advance_street(state, now)
    else:
        _set_next_actor(state, actor_id, now)


def apply_action(
    state: Dict[str, Any],
    actor_id: str,
    action: str,
    amount: Optional[int],
    expected_hand: int,
    expected_turn_version: int,
    now: Optional[float] = None,
) -> Dict[str, Any]:
    """Apply an action only if it targets the current hand and exact turn token."""
    if isinstance(expected_hand, bool) or not isinstance(expected_hand, int) or expected_hand != state["hand_no"]:
        raise GameError("stale_hand", "That hand has moved on. Refresh the table.", 409)
    if isinstance(expected_turn_version, bool) or not isinstance(expected_turn_version, int) or expected_turn_version != state["turn_version"]:
        raise GameError("stale_turn", "That turn has moved on. Refresh the table.", 409)
    timestamp = _now(now)
    _perform_action(state, actor_id, action, amount, timestamp)
    _bump(state)
    return state


def advance(state: Dict[str, Any], now: Optional[float] = None) -> Dict[str, Any]:
    """Advance blind clocks, turn timeouts, and the short showdown pause."""
    timestamp = _now(now)
    changed = False
    if state["status"] == "lobby":
        last_activity = state.get("last_activity_at", state["created_at"])
        if timestamp - last_activity >= LOBBY_IDLE_SECONDS:
            state["status"] = "expired"
            state["cancelled_at"] = timestamp
            state["cancellation_reason"] = "idle"
            _log(state, "Lobby expired after four hours without activity.", timestamp)
            _bump(state)
        return state
    if state["status"] != "playing":
        return state

    blinds = state["blinds"]
    level_seconds = state["config"]["level_minutes"] * 60
    while blinds["next_level_at"] is not None and timestamp >= blinds["next_level_at"]:
        blinds["level"] += 1
        blinds["small"] = min(MAX_CHIPS, blinds["small"] * 2)
        blinds["big"] = min(MAX_CHIPS, blinds["big"] * 2)
        blinds["next_level_at"] += level_seconds
        _log(
            state,
            "Blind level %d: %d/%d." % (blinds["level"], blinds["small"], blinds["big"]),
            timestamp,
        )
        changed = True

    hand = state["hand"]
    if hand is not None and hand["street"] == "showdown":
        if (
            state["status"] == "playing"
            and hand["next_hand_at"] is not None
            and timestamp >= hand["next_hand_at"]
        ):
            _start_hand(state, timestamp)
            changed = True
    elif (
        hand is not None
        and hand["to_act"] is not None
        and hand["turn_deadline"] is not None
        and timestamp >= hand["turn_deadline"]
    ):
        _perform_action(state, hand["to_act"], "check", None, timestamp, timed_out=True)
        changed = True

    if changed:
        _bump(state)
    return state


def _rank_values(cards: Sequence[str]) -> List[int]:
    return sorted((RANK_VALUES[card[0]] for card in cards), reverse=True)


def _straight_high(values: Iterable[int]) -> Optional[int]:
    distinct = sorted(set(values), reverse=True)
    if 14 in distinct:
        distinct.append(1)
    run = 1
    for index in range(len(distinct) - 1):
        if distinct[index] - 1 == distinct[index + 1]:
            run += 1
            if run >= 5:
                return distinct[index + 1] + 4
        else:
            run = 1
    return None


def rank_five(cards: Sequence[str]) -> Tuple[int, ...]:
    """Return a comparable five-card hand rank, best hands sorting highest."""
    if len(cards) != 5:
        raise ValueError("rank_five requires exactly five cards")
    ranks = _rank_values(cards)
    counts: Dict[int, int] = {}
    for rank in ranks:
        counts[rank] = counts.get(rank, 0) + 1
    groups = sorted(((count, rank) for rank, count in counts.items()), reverse=True)
    flush = len({card[1] for card in cards}) == 1
    straight = _straight_high(ranks)

    if flush and straight is not None:
        return (8, straight)
    if groups[0][0] == 4:
        quad = groups[0][1]
        kicker = max(rank for rank in counts if rank != quad)
        return (7, quad, kicker)
    if groups[0][0] == 3 and len(groups) > 1 and groups[1][0] >= 2:
        return (6, groups[0][1], groups[1][1])
    if flush:
        return (5,) + tuple(ranks)
    if straight is not None:
        return (4, straight)
    if groups[0][0] == 3:
        trip = groups[0][1]
        kickers = sorted((rank for rank in counts if rank != trip), reverse=True)
        return (3, trip) + tuple(kickers)
    pairs = sorted((rank for rank, count in counts.items() if count == 2), reverse=True)
    if len(pairs) >= 2:
        kicker = max(rank for rank in counts if rank not in pairs[:2])
        return (2, pairs[0], pairs[1], kicker)
    if len(pairs) == 1:
        pair = pairs[0]
        kickers = sorted((rank for rank in counts if rank != pair), reverse=True)
        return (1, pair) + tuple(kickers)
    return (0,) + tuple(ranks)


def rank_seven(cards: Sequence[str]) -> Tuple[int, ...]:
    """Return the strongest five-card hand from five, six, or seven cards."""
    if len(cards) < 5 or len(cards) > 7:
        raise ValueError("rank_seven requires five to seven cards")
    return max(rank_five(combo) for combo in itertools.combinations(cards, 5))


def _rank_description(rank: Tuple[int, ...]) -> str:
    category = HAND_NAMES[rank[0]]
    high = rank[1] if len(rank) > 1 else 0
    if rank[0] == 8:
        return "%s, %s high" % (category, RANK_CHARS[high - 2])
    if rank[0] == 4:
        return "%s, %s high" % (category, RANK_CHARS[high - 2])
    return category


def _split_side_pots(
    state: Dict[str, Any],
    hand: Dict[str, Any],
    now: float,
) -> Dict[str, int]:
    contributions = hand["contrib"]
    folded = set(hand["folded"])
    levels = sorted(set(amount for amount in contributions.values() if amount > 0))
    payouts = {player_id: 0 for player_id in contributions}
    previous = 0
    ranks: Dict[str, Tuple[int, ...]] = {}
    for player_id in hand["holes"]:
        if player_id not in folded:
            ranks[player_id] = rank_seven(hand["holes"][player_id] + hand["board"])

    for level in levels:
        contributors = [player_id for player_id, total in contributions.items() if total >= level]
        pot_amount = (level - previous) * len(contributors)
        previous = level
        eligible = [player_id for player_id in contributors if player_id not in folded]
        if pot_amount <= 0:
            continue
        if not eligible:
            # The action rules prevent this; keeping the chips in play is safer
            # than silently assigning a pot to a folded player.
            raise GameError("invalid_pot", "No active player can claim a pot.", 500)
        if len(eligible) == 1:
            payouts[eligible[0]] += pot_amount
            continue
        best = max(ranks[player_id] for player_id in eligible)
        winners = [player_id for player_id in eligible if ranks[player_id] == best]
        share, odd = divmod(pot_amount, len(winners))
        for player_id in winners:
            payouts[player_id] += share
        if odd:
            order = [seat["player_id"] for seat in _clockwise_after(state, hand["button_id"])]
            ordered_winners = [player_id for player_id in order if player_id in winners]
            for player_id in ordered_winners[:odd]:
                payouts[player_id] += 1
    return payouts


def _record_eliminations(state: Dict[str, Any], hand: Dict[str, Any], now: float) -> None:
    already = {item["player_id"] for item in state["elimination_order"]}
    newly_out = [
        seat
        for seat in _seats_in_order(state)
        if seat["stack"] == 0
        and seat["player_id"] in hand["holes"]
        and seat["player_id"] not in already
    ]
    newly_out.sort(
        key=lambda seat: (
            hand["stack_before"].get(seat["player_id"], 0),
            seat["seat_no"],
        )
    )
    total = len(state["seats"])
    for seat in newly_out:
        place = total - len(state["elimination_order"])
        item = {
            "player_id": seat["player_id"],
            "name": seat["name"],
            "place": place,
            "eliminated_at": int(now),
        }
        state["elimination_order"].append(item)
        _log(state, "%s is out in %s place." % (seat["name"], _ordinal(place)), now)


def _ordinal(number: int) -> str:
    if number % 100 in (11, 12, 13):
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(number % 10, "th")
    return "%d%s" % (number, suffix)


def _set_results(state: Dict[str, Any], winner_id: Optional[str], now: float) -> None:
    if winner_id is None:
        state["results"] = []
        return
    winner = _seat_by_id(state, winner_id)
    results = []
    if winner is not None:
        results.append(
            {
                "player_id": winner_id,
                "name": winner["name"],
                "place": 1,
                "chips": winner["stack"],
            }
        )
    for item in reversed(state["elimination_order"]):
        seat = _seat_by_id(state, item["player_id"])
        results.append(
            {
                "player_id": item["player_id"],
                "name": item["name"],
                "place": item["place"],
                "chips": seat["stack"] if seat else 0,
            }
        )
    state["results"] = results
    state["status"] = "completed"
    _log(state, "%s wins the tournament." % winner["name"], now)


def _complete_tournament(state: Dict[str, Any], now: float) -> None:
    alive = [seat for seat in _seats_in_order(state) if seat["stack"] > 0]
    _set_results(state, alive[0]["player_id"] if len(alive) == 1 else None, now)


def _finish_hand(state: Dict[str, Any], payouts: Dict[str, int], now: float) -> None:
    hand = state["hand"]
    assert hand is not None
    for player_id, amount in payouts.items():
        seat = _seat_by_id(state, player_id)
        if seat is not None:
            seat["stack"] += amount
    hand["payouts"] = payouts
    _record_eliminations(state, hand, now)
    remaining = [seat for seat in _seats_in_order(state) if seat["stack"] > 0]
    hand["street"] = "showdown"
    hand["to_act"] = None
    hand["turn_deadline"] = None
    hand["next_hand_at"] = now + 5
    if len(remaining) <= 1:
        _set_results(state, remaining[0]["player_id"] if remaining else None, now)
        hand["next_hand_at"] = None


def _award_without_showdown(
    state: Dict[str, Any],
    winner_id: Optional[str],
    now: float,
) -> None:
    hand = state["hand"]
    assert hand is not None
    pot = sum(hand["contrib"].values())
    payouts = {player_id: 0 for player_id in hand["contrib"]}
    if winner_id is not None:
        payouts[winner_id] = pot
        seat = _seat_by_id(state, winner_id)
        _log(state, "%s wins %d without showdown." % (seat["name"], pot), now)
    _finish_hand(state, payouts, now)


def _settle_showdown(state: Dict[str, Any], now: float) -> None:
    hand = state["hand"]
    assert hand is not None
    while len(hand["board"]) < 5:
        if hand["street"] == "preflop":
            _take_card(hand)
            hand["board"].extend([_take_card(hand) for _ in range(3)])
            hand["street"] = "flop"
        elif hand["street"] == "flop":
            _take_card(hand)
            hand["board"].append(_take_card(hand))
            hand["street"] = "turn"
        else:
            _take_card(hand)
            hand["board"].append(_take_card(hand))
            hand["street"] = "river"

    payouts = _split_side_pots(state, hand, now)
    showdown = []
    for player_id in _hand_live_ids(hand):
        seat = _seat_by_id(state, player_id)
        rank = rank_seven(hand["holes"][player_id] + hand["board"])
        showdown.append(
            {
                "player_id": player_id,
                "name": seat["name"] if seat else "Player",
                "cards": list(hand["holes"][player_id]),
                "rank": _rank_description(rank),
                "rank_value": list(rank),
                "payout": payouts.get(player_id, 0),
            }
        )
    hand["showdown"] = showdown

    for player_id, amount in payouts.items():
        if amount > 0:
            seat = _seat_by_id(state, player_id)
            if seat is not None:
                _log(state, "%s wins %d." % (seat["name"], amount), now)
    _finish_hand(state, payouts, now)


def public_view(state: Dict[str, Any], viewer_id: Optional[str]) -> Dict[str, Any]:
    """Return only public information and the requesting player's own hole cards."""
    hand = state.get("hand")
    viewer_seat = _seat_by_id(state, viewer_id) if viewer_id else None
    showdown_cards = {}
    if hand:
        showdown_cards = {
            item["player_id"]: list(item["cards"])
            for item in hand.get("showdown", [])
        }

    seats = []
    for seat in _seats_in_order(state):
        player_id = seat["player_id"]
        folded = bool(hand and player_id in hand["folded"])
        in_hand = bool(hand and player_id in hand["holes"])
        item = {
            "id": player_id,
            "name": seat["name"],
            "seat_no": seat["seat_no"],
            "stack": seat["stack"],
            "folded": folded,
            "all_in": bool(in_hand and seat["stack"] == 0 and not folded),
            "bet": hand["bets"].get(player_id, 0) if hand else 0,
        }
        if hand and player_id in hand["holes"]:
            if player_id == viewer_id:
                item["cards"] = list(hand["holes"][player_id])
            elif player_id in showdown_cards:
                item["cards"] = showdown_cards[player_id]
        seats.append(item)

    blinds = state["blinds"]
    next_level = blinds["next_level_at"]
    timestamp = time.time()
    seconds_to_next = max(0, int(math.ceil(next_level - timestamp))) if next_level is not None else None
    actor_id = hand["to_act"] if hand else None
    can_act = bool(
        hand
        and state["status"] == "playing"
        and actor_id == viewer_id
        and hand["street"] != "showdown"
    )
    if hand and viewer_id in hand["holes"]:
        hole_cards = list(hand["holes"][viewer_id])
        to_call = _to_call(hand, viewer_id)
        raise_rights = bool(
            can_act
            and _has_raise_right(hand, viewer_id)
            and _has_raise_opponent(state, hand, viewer_id)
        )
        seat = _seat_by_id(state, viewer_id)
        max_to = hand["bets"].get(viewer_id, 0) + (seat["stack"] if seat else 0)
        min_to = (hand["current_bet"] + hand["min_raise"]) if hand["current_bet"] else hand["min_raise"]
        if not can_act or not raise_rights or max_to <= hand["current_bet"]:
            min_to_value = None
            max_to_value = None
        else:
            min_to_value = min_to
            max_to_value = max_to
    else:
        hole_cards = None
        to_call = 0
        raise_rights = False
        min_to_value = None
        max_to_value = None

    view = {
        "id": state["id"],
        "name": state["name"],
        "status": state["status"],
        "host_id": state["host_id"],
        "host_name": state["host_name"],
        "config": {
            "max_seats": state["config"]["max_seats"],
            "starting_stack": state["config"]["starting_stack"],
            "small_blind": state["config"]["small_blind"],
            "big_blind": state["config"]["big_blind"],
            "level_minutes": state["config"]["level_minutes"],
        },
        "blinds": {
            "level": blinds["level"],
            "small": blinds["small"],
            "big": blinds["big"],
            "next_level_at": next_level,
            "seconds_to_next": seconds_to_next,
        },
        "hand_no": state["hand_no"],
        "street": hand["street"] if hand else "lobby",
        "board": list(hand["board"]) if hand else [],
        "pot": 0 if not hand or hand["street"] == "showdown" else sum(hand["contrib"].values()),
        "current_bet": hand["current_bet"] if hand else 0,
        "min_raise": hand["min_raise"] if hand else blinds["big"],
        "button_id": state["button_id"],
        "actor_id": actor_id,
        "turn_deadline": hand["turn_deadline"] if hand else None,
        "turn_version": state["turn_version"],
        "version": state["version"],
        "seats": seats,
        "viewer": {
            "player_id": viewer_id,
            "seated": viewer_seat is not None,
            "can_act": can_act,
            "hole_cards": hole_cards,
            "to_call": to_call,
            "raise_rights": raise_rights,
            "min_raise_to": min_to_value,
            "max_raise_to": max_to_value,
        },
        "action_log": list(state["action_log"]),
        "results": list(state["results"]),
        "showdown": list(hand.get("showdown", [])) if hand else [],
        "next_hand_at": hand["next_hand_at"] if hand else None,
    }
    return view


def summary(
    state: Dict[str, Any],
    viewer_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Return a listing-safe table summary."""
    blinds = state["blinds"]
    return {
        "id": state["id"],
        "name": state["name"],
        "status": state["status"],
        "host_name": state["host_name"],
        "max_seats": state["config"]["max_seats"],
        "seated_count": len(state["seats"]),
        "blinds": {
            "level": blinds["level"],
            "small": blinds["small"],
            "big": blinds["big"],
        },
        "hand_no": state["hand_no"],
        "viewer_seated": bool(viewer_id and _seat_by_id(state, viewer_id)),
    }

