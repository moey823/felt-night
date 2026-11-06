"""Authoritative, JSON-serializable no-limit Texas Hold'em sit-and-go engine.

This module has no I/O and uses only the Python standard library. A caller owns
persistence and must serialize each table's mutations (for example with a DB
transaction). Chip values are integer play-money units only.
"""
from __future__ import annotations

import hashlib
import itertools
import math
import random
import time
from functools import lru_cache
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


TURN_SECONDS = 30
MAX_LEVEL_MINUTES = 2**31 - 1
MAX_TIMER_SECONDS = 3600
MAX_SEATS = 9
MAX_LOG_ENTRIES = 40
MAX_HAND_EVENTS = 128
RUNOUT_SECONDS = 2.5
BLIND_ANNOUNCEMENT_SECONDS = 5
ELIMINATION_ANNOUNCEMENT_SECONDS = 5
HAND_COMPLETE_PAUSE_SECONDS = 1.5
SHOWDOWN_SECONDS = 5
RUNOUT_EXACT_LIMIT = 10000
DEFAULT_BUY_IN = 10
DEFAULT_PAYOUT_PERCENTAGES = (60, 25, 15)
MAX_PAYOUT_PLACES = 9
RUNOUT_SAMPLE_COUNT = 10000
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


def _validated_config(config: Dict[str, Any], base: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    if not isinstance(config, dict):
        raise GameError("invalid_config", "Table settings are required.")
    allowed = {"max_seats", "starting_stack", "small_blind", "big_blind", "level_minutes", "turn_seconds", "runout_seconds", "blind_announcement_seconds", "elimination_announcement_seconds", "showdown_seconds", "buy_in", "payout_percentages"}
    unknown = set(config) - allowed
    if unknown:
        raise GameError("invalid_config", "Unknown table setting: %s." % sorted(unknown)[0])
    values = dict(base or {
        "max_seats": 9, "starting_stack": 1500, "small_blind": 10,
        "big_blind": 20, "level_minutes": 10, "turn_seconds": TURN_SECONDS,
        "buy_in": DEFAULT_BUY_IN, "payout_percentages": list(DEFAULT_PAYOUT_PERCENTAGES),
    })
    values.setdefault("runout_seconds", RUNOUT_SECONDS)  # Lobbies saved before customizable pacing.
    values.setdefault("blind_announcement_seconds", BLIND_ANNOUNCEMENT_SECONDS)
    values.setdefault("elimination_announcement_seconds", ELIMINATION_ANNOUNCEMENT_SECONDS)
    values.setdefault("showdown_seconds", SHOWDOWN_SECONDS)
    values.setdefault("buy_in", DEFAULT_BUY_IN)  # Tables saved before configurable play-money buy-ins.
    values.setdefault("payout_percentages", list(DEFAULT_PAYOUT_PERCENTAGES))
    values.update(config)
    minutes = values["level_minutes"]
    if (type(minutes) not in (int, float) or not 0.01 <= minutes <= MAX_LEVEL_MINUTES
            or not math.isfinite(minutes)):
        raise GameError("invalid_config", "Blind level length must be at least 0.01 minutes and within range.")
    delay = values["runout_seconds"]
    if (type(delay) not in (float, int) or not 1 <= delay <= MAX_TIMER_SECONDS
            or not math.isfinite(delay)):
        raise GameError("invalid_config", "Time between all-in cards must be 1 to 3600 seconds.")
    blind_announcement = values["blind_announcement_seconds"]
    if (type(blind_announcement) not in (int, float) or not 0 <= blind_announcement <= 60
            or not math.isfinite(blind_announcement)):
        raise GameError("invalid_config", "Blind announcement length must be 0 to 60 seconds.")
    elimination_announcement = values["elimination_announcement_seconds"]
    if (type(elimination_announcement) not in (int, float) or not 0 <= elimination_announcement <= 60
            or not math.isfinite(elimination_announcement)):
        raise GameError("invalid_config", "Elimination announcement length must be 0 to 60 seconds.")
    showdown_seconds = values["showdown_seconds"]
    if (type(showdown_seconds) not in (int, float) or not 0 <= showdown_seconds <= 60
            or not math.isfinite(showdown_seconds)):
        raise GameError("invalid_config", "Showdown display length must be 0 to 60 seconds.")
    payout_percentages = values["payout_percentages"]
    if (
        not isinstance(payout_percentages, (list, tuple))
        or not 1 <= len(payout_percentages) <= MAX_PAYOUT_PLACES
        or any(type(percentage) is not int or percentage < 0 or percentage > 100 for percentage in payout_percentages)
        or sum(payout_percentages) != 100
    ):
        raise GameError("invalid_config", "Payout percentages must be 1 to 9 whole-number places totaling 100.")
    result = {
        "max_seats": _integer(values["max_seats"], "Seat count", 2, MAX_SEATS),
        "starting_stack": _integer(values["starting_stack"], "Starting stack", 100, MAX_CHIPS),
        "small_blind": _integer(values["small_blind"], "Small blind", 1, MAX_CHIPS),
        "big_blind": _integer(values["big_blind"], "Big blind", 2, MAX_CHIPS),
        "level_minutes": minutes,
        "turn_seconds": _integer(values["turn_seconds"], "Shot clock", 1, MAX_TIMER_SECONDS),
        "runout_seconds": delay,
        "blind_announcement_seconds": blind_announcement,
        "elimination_announcement_seconds": elimination_announcement,
        "showdown_seconds": showdown_seconds,
        "buy_in": _integer(values["buy_in"], "Buy-in", 0, MAX_CHIPS),
        "payout_percentages": list(payout_percentages),
    }
    if result["big_blind"] < result["small_blind"]:
        raise GameError("invalid_config", "The big blind must be at least the small blind.")
    if result["big_blind"] > result["starting_stack"]:
        raise GameError("invalid_config", "The starting stack must cover the big blind.")
    return result


def _validate_seat_no(seat_no: Any, max_seats: int) -> int:
    if isinstance(seat_no, bool) or not isinstance(seat_no, int):
        raise GameError("invalid_seat", "Choose a valid seat number.")
    if seat_no < 0 or seat_no >= max_seats:
        raise GameError("invalid_seat", "Choose a seat within this table's capacity.")
    return seat_no


def _valid_name(name: Any) -> str:
    if not isinstance(name, str):
        raise GameError("invalid_name", "Enter a player name.")
    cleaned = name.strip()
    if not cleaned or len(cleaned) > 32 or any(ord(char) < 32 or ord(char) == 127 for char in cleaned):
        raise GameError("invalid_name", "Player names must be 1–32 printable characters.")
    return cleaned


def _valid_table_name(name: Any) -> str:
    if not isinstance(name, str):
        raise GameError("invalid_table_name", "Choose a table name.")
    cleaned = " ".join(name.strip().split())
    if not cleaned or len(cleaned) > 48 or any(not char.isprintable() for char in cleaned) or any(
        char in "<>" for char in cleaned
    ):
        raise GameError("invalid_table_name", "Table names must be 1 to 48 printable characters.")
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


def _hand_id(state: Dict[str, Any], hand: Dict[str, Any]) -> str:
    return str(hand.get("hand_id") or "%s:%s" % (state["id"], hand.get("number", state["hand_no"])))


def _record_event(
    state: Dict[str, Any],
    hand: Dict[str, Any],
    event_type: str,
    **fields: Any,
) -> Dict[str, Any]:
    seq = int(hand.get("event_seq", 0)) + 1
    hand["event_seq"] = seq
    hand_id = _hand_id(state, hand)
    event = {"id": "%s:%d" % (hand_id, seq), "hand_id": hand_id, "seq": seq, "type": event_type}
    event.update(fields)
    events = hand.setdefault("events", [])
    events.append(event)
    if len(events) > MAX_HAND_EVENTS:
        del events[:-MAX_HAND_EVENTS]
    hand["event_base_seq"] = events[0]["seq"] if events else seq + 1
    hand["hand_id"] = hand_id
    return event


def _record_action_event(
    state: Dict[str, Any],
    hand: Dict[str, Any],
    player_id: str,
    action: str,
    amount: int,
    **fields: Any,
) -> None:
    seat = _seat_by_id(state, player_id)
    label = seat["name"] if seat is not None else "Player"
    event_action = "all-in" if action == "all_in" else action
    _record_event(
        state,
        hand,
        "action",
        actor=player_id,
        actor_id=player_id,
        actor_label=label,
        seat_no=seat["seat_no"] if seat is not None else None,
        action=event_action,
        amount=amount,
        street_contribution=hand.get("bets", {}).get(player_id, 0),
        contribution=hand.get("contrib", {}).get(player_id, 0),
        pot=sum(hand.get("contrib", {}).values()),
        street=hand.get("street"),
        **fields,
    )


def _record_sweep(state: Dict[str, Any], hand: Dict[str, Any]) -> None:
    amount = sum(hand.get("bets", {}).values())
    _record_event(
        state,
        hand,
        "sweep",
        street=hand.get("street"),
        amount=amount,
        swept_amount=amount,
        pot=sum(hand.get("contrib", {}).values()),
    )


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
    validated = _validated_config(config)
    max_seats = validated["max_seats"]
    starting_stack = validated["starting_stack"]
    small_blind = validated["small_blind"]
    big_blind = validated["big_blind"]
    level_minutes = validated["level_minutes"]
    turn_seconds = validated["turn_seconds"]

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
            "runout_seconds": validated["runout_seconds"],
            "blind_announcement_seconds": validated["blind_announcement_seconds"],
            "elimination_announcement_seconds": validated["elimination_announcement_seconds"],
            "showdown_seconds": validated["showdown_seconds"],
            "buy_in": validated["buy_in"],
            "payout_percentages": list(validated["payout_percentages"]),
        },
        "seats": [
            {
                "player_id": str(host_id),
                "name": host_name,
                "seat_no": 0,
                "stack": starting_stack,
                "is_bot": False,
                "sitting_out": False,
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
        "paused": False,
        "paused_at": None,
        "blind_announcement": None,
        "elimination_announcement": None,
        "action_log": [],
        "elimination_order": [],
        "results": [],
    }


def join(
    state: Dict[str, Any],
    player_id: str,
    name: str,
    now: Optional[float] = None,
    seat_no: Optional[int] = None,
) -> Dict[str, Any]:
    """Seat or move a player in a lobby. Repeating the same join is safe."""
    existing = _seat_by_id(state, player_id)
    requested = _validate_seat_no(seat_no, state["config"]["max_seats"]) if seat_no is not None else None
    if existing is not None and (requested is None or requested == existing["seat_no"]):
        return state
    if state["status"] != "lobby":
        raise GameError("table_started", "This table has already started.", 409)
    if requested is not None and any(
        seat["seat_no"] == requested and seat["player_id"] != player_id for seat in state["seats"]
    ):
        raise GameError("seat_taken", "That seat is already occupied.", 409)
    if existing is not None:
        old_no = existing["seat_no"]
        existing["seat_no"] = requested
        state["seats"].sort(key=lambda item: item["seat_no"])
        timestamp = _now(now)
        state["last_activity_at"] = timestamp
        _log(state, "%s moved from seat %d to seat %d." % (existing["name"], old_no + 1, requested + 1), timestamp)
        _bump(state)
        return state
    if len(state["seats"]) >= state["config"]["max_seats"]:
        raise GameError("table_full", "This table has no open seats.", 409)
    player_name = _valid_name(name)
    used = {seat["seat_no"] for seat in state["seats"]}
    if requested is None:
        requested = next((i for i in range(state["config"]["max_seats"]) if i not in used), None)
        if requested is None:
            raise GameError("table_full", "This table has no open seats.", 409)
    state["seats"].append({
        "player_id": str(player_id), "name": player_name, "seat_no": requested,
        "stack": state["config"]["starting_stack"], "is_bot": False,
        "sitting_out": False,
    })
    state["seats"].sort(key=lambda item: item["seat_no"])
    timestamp = _now(now)
    state["last_activity_at"] = timestamp
    _log(state, "%s joined the table in seat %d." % (player_name, requested + 1), timestamp)
    _bump(state)
    return state


def leave(
    state: Dict[str, Any],
    actor_id: str,
    now: Optional[float] = None,
) -> Dict[str, Any]:
    """Let a seated player leave; a departing host hands off only to a human."""
    if state["status"] != "lobby":
        raise GameError("table_started", "Players cannot leave after the tournament starts.", 409)
    seat = _seat_by_id(state, actor_id)
    if seat is None:
        raise GameError("not_seated", "You do not have a seat at this table.", 409)
    timestamp = _now(now)
    state["seats"].remove(seat)
    _log(state, "%s left the lobby." % seat["name"], timestamp)
    state["last_activity_at"] = timestamp
    if actor_id == state["host_id"]:
        humans = [item for item in state["seats"] if not item.get("is_bot", False)]
        if humans:
            replacement = min(humans, key=lambda item: item["seat_no"])
            state["host_id"] = replacement["player_id"]
            state["host_name"] = replacement["name"]
            state["name"] = " ".join(replacement["name"].split()) + "'s table"
            _log(state, "%s is now the host." % replacement["name"], timestamp)
        else:
            state["status"] = "cancelled"
            state["cancelled_at"] = timestamp
            state["cancellation_reason"] = "empty" if not state["seats"] else "host_left"
            _log(state, "Lobby closed because the host left.", timestamp)
    _bump(state)
    return state


def stand(state: Dict[str, Any], actor_id: str, now: Optional[float] = None) -> Dict[str, Any]:
    """Remove a player's lobby seat without changing table ownership or closing it."""
    if state["status"] != "lobby":
        raise GameError("table_started", "Players cannot stand after the tournament starts.", 409)
    seat = _seat_by_id(state, actor_id)
    if seat is None:
        raise GameError("not_seated", "You do not have a seat at this table.", 409)
    timestamp = _now(now)
    state["seats"].remove(seat)
    state["last_activity_at"] = timestamp
    _log(state, "%s is watching from the rail." % seat["name"], timestamp)
    _bump(state)
    return state


def pause_table(
    state: Dict[str, Any],
    actor_id: str,
    paused: bool,
    now: Optional[float] = None,
) -> Dict[str, Any]:
    """Pause or resume a running tournament without consuming any game clocks."""
    if actor_id != state["host_id"]:
        raise GameError("host_only", "Only the table host can pause or resume the tournament.", 403)
    if type(paused) is not bool:
        raise GameError("invalid_pause", "Choose whether the tournament is paused.")
    if state.get("status") != "playing":
        raise GameError("table_not_playing", "Only a running tournament can be paused.", 409)
    if bool(state.get("paused", False)) == paused:
        return state

    timestamp = _now(now)
    if paused:
        state["paused"] = True
        state["paused_at"] = timestamp
        state["turn_version"] += 1
        _log(state, "The host paused the tournament.", timestamp)
    else:
        paused_at = state.get("paused_at")
        duration = max(0.0, timestamp - paused_at) if isinstance(paused_at, (int, float)) else 0.0
        if duration:
            blinds = state.get("blinds", {})
            for key in ("started_at", "next_level_at"):
                if blinds.get(key) is not None:
                    blinds[key] += duration
            hand = state.get("hand")
            if hand is not None:
                for key in (
                    "turn_deadline", "bot_action_at", "runout_at", "hand_complete_at",
                    "next_hand_at", "showdown_started_at", "showdown_until", "presentation_until",
                    "blind_transition_until",
                ):
                    if hand.get(key) is not None:
                        hand[key] += duration
            for key in ("blind_announcement", "elimination_announcement"):
                announcement = state.get(key)
                if isinstance(announcement, dict):
                    for deadline in ("starts_at", "until"):
                        if announcement.get(deadline) is not None:
                            announcement[deadline] += duration
        state["paused"] = False
        state["paused_at"] = None
        state["turn_version"] += 1
        _log(state, "The host resumed the tournament.", timestamp)
    _bump(state)
    return state


def _deadline_number(value: Any) -> Optional[float]:
    return float(value) if type(value) in (int, float) and math.isfinite(value) else None


def _presentation_end(state: Dict[str, Any], hand: Dict[str, Any]) -> Optional[float]:
    deadlines = [
        _deadline_number(hand.get("hand_complete_at")),
        _deadline_number(hand.get("showdown_until")),
        _deadline_number(hand.get("blind_transition_until")),
    ]
    for key in ("elimination_announcement", "blind_announcement"):
        announcement = state.get(key)
        if isinstance(announcement, dict):
            deadlines.append(_deadline_number(announcement.get("until")))
    valid = [deadline for deadline in deadlines if deadline is not None]
    return max(valid) if valid else None


def _refresh_presentation_deadline(state: Dict[str, Any], hand: Dict[str, Any]) -> None:
    until = _presentation_end(state, hand)
    hand["presentation_until"] = until
    hand["next_hand_at"] = until if state.get("status") == "playing" else None


def _announcement_start(announcement: Dict[str, Any], fallback: float) -> float:
    value = _deadline_number(announcement.get("starts_at"))
    return fallback if value is None else value


def _set_announcement_duration(
    announcement: Optional[Dict[str, Any]],
    duration: float,
    effective_at: float,
    predecessor_until: float,
) -> Optional[Dict[str, Any]]:
    """Resize an existing announcement without reviving an expired window."""
    if not isinstance(announcement, dict):
        return None
    old_until = _deadline_number(announcement.get("until"))
    if old_until is None or old_until <= effective_at or duration <= 0:
        return None
    old_start = _announcement_start(announcement, effective_at)
    if old_start <= effective_at:
        start = old_start
        until = effective_at + duration
    else:
        start = max(predecessor_until, effective_at)
        until = start + duration
    updated = dict(announcement)
    updated["starts_at"] = start
    updated["until"] = until
    return updated


def update_runtime_settings(
    state: Dict[str, Any],
    actor_id: str,
    settings: Dict[str, Any],
    now: Optional[float] = None,
) -> Dict[str, Any]:
    """Update only pacing controls while the host has paused a tournament."""
    if actor_id != state["host_id"]:
        raise GameError("host_only", "Only the table host can update settings.", 403)
    if state.get("status") != "playing":
        raise GameError("table_started", "Runtime settings are only available during a tournament.", 409)
    if not state.get("paused", False):
        raise GameError("table_not_paused", "Pause the tournament before changing runtime settings.", 409)
    allowed = {
        # Timing shared across all tables is controlled by the room admin.
        "turn_seconds", "level_minutes",
    }
    if not isinstance(settings, dict) or set(settings) - allowed:
        raise GameError("invalid_config", "Only pacing settings can change during a tournament.")
    if not settings:
        raise GameError("invalid_config", "Choose at least one pacing setting to update.")

    updated = _validated_config(settings, state.get("config", {}))
    timestamp = _now(now)
    paused_at = state.get("paused_at")
    effective_at = paused_at if isinstance(paused_at, (int, float)) else timestamp
    state["config"] = updated
    hand = state.get("hand")

    if hand is not None and hand.get("to_act") is not None and "turn_seconds" in settings:
        actor_seat = _seat_by_id(state, hand["to_act"])
        if actor_seat is not None and not actor_seat.get("is_bot", False):
            hand["turn_deadline"] = effective_at + updated["turn_seconds"]
    if hand is not None and hand.get("runout_at") is not None and "runout_seconds" in settings:
        hand["runout_at"] = effective_at + updated["runout_seconds"]

    announcements_rescheduled = False
    if hand is not None and hand.get("street") == "showdown":
        if "showdown_seconds" in settings:
            started = _deadline_number(hand.get("showdown_started_at"))
            old_until = _deadline_number(hand.get("showdown_until"))
            if started is not None and old_until is not None and old_until > effective_at:
                hand["showdown_until"] = max(effective_at, started + updated["showdown_seconds"])
                hand["hand_complete_at"] = hand["showdown_until"]
                announcements_rescheduled = True

        result_end = max(
            _deadline_number(hand.get("showdown_until")) or effective_at,
            _deadline_number(hand.get("hand_complete_at")) or effective_at,
        )
        elimination = state.get("elimination_announcement")
        if "elimination_announcement_seconds" in settings:
            resized = _set_announcement_duration(
                elimination, updated["elimination_announcement_seconds"],
                effective_at, result_end,
            )
            if elimination is not None:
                state["elimination_announcement"] = resized
                announcements_rescheduled = True
        elif isinstance(elimination, dict):
            old_start = _announcement_start(elimination, effective_at)
            old_until = _deadline_number(elimination.get("until"))
            if old_until is not None and old_until > effective_at and old_start > effective_at:
                duration = max(0.0, old_until - old_start)
                state["elimination_announcement"] = _set_announcement_duration(
                    elimination, duration, effective_at, result_end,
                )
                announcements_rescheduled = True

        elimination = state.get("elimination_announcement")
        elimination_end = (
            _deadline_number(elimination.get("until"))
            if isinstance(elimination, dict) else None
        )
        blind_predecessor = max(result_end, elimination_end or result_end)
        blind = state.get("blind_announcement")
        if "blind_announcement_seconds" in settings:
            resized = _set_announcement_duration(
                blind, updated["blind_announcement_seconds"],
                effective_at, blind_predecessor,
            )
            if blind is not None:
                state["blind_announcement"] = resized
                if resized is None:
                    hand["blind_transition_until"] = max(
                        effective_at + HAND_COMPLETE_PAUSE_SECONDS, blind_predecessor,
                    )
                else:
                    hand["blind_transition_until"] = max(
                        resized["until"], resized["starts_at"],
                        effective_at + HAND_COMPLETE_PAUSE_SECONDS,
                    )
                announcements_rescheduled = True
        elif isinstance(blind, dict):
            old_start = _announcement_start(blind, effective_at)
            old_until = _deadline_number(blind.get("until"))
            if old_until is not None and old_until > effective_at and old_start > effective_at:
                duration = max(0.0, old_until - old_start)
                state["blind_announcement"] = _set_announcement_duration(
                    blind, duration, effective_at, blind_predecessor,
                )
                resized = state["blind_announcement"]
                if resized is not None:
                    hand["blind_transition_until"] = max(
                        resized["until"], resized["starts_at"],
                        effective_at + HAND_COMPLETE_PAUSE_SECONDS,
                    )
                announcements_rescheduled = True

        _refresh_presentation_deadline(state, hand)

    if (
        "level_minutes" in settings or "blind_announcement_seconds" in settings or announcements_rescheduled
    ) and state["blinds"].get("started_at") is not None:
        blinds = state["blinds"]
        announcement = state.get("blind_announcement")
        announcement_until = (
            _deadline_number(announcement.get("until"))
            if isinstance(announcement, dict) else None
        )
        level_started = announcement_until or effective_at
        if hand is not None and hand.get("street") == "showdown":
            presentation_end = _deadline_number(hand.get("presentation_until"))
            if presentation_end is not None:
                level_started = max(level_started, presentation_end)
        blinds["started_at"] = level_started
        blinds["next_level_at"] = level_started + updated["level_minutes"] * 60

    state["last_activity_at"] = timestamp
    _log(state, "The host updated tournament pacing settings.", timestamp)
    _bump(state)
    return state


def update_settings(
    state: Dict[str, Any],
    actor_id: str,
    settings: Dict[str, Any],
    now: Optional[float] = None,
    name: Optional[str] = None,
) -> Dict[str, Any]:
    """Update pregame settings; all unplayed stacks follow the starting stack."""
    if actor_id != state["host_id"]:
        raise GameError("host_only", "Only the table host can update settings.", 403)
    if state["status"] != "lobby":
        raise GameError("table_started", "Table settings cannot change after the tournament starts.", 409)
    allowed = {
        "starting_stack", "small_blind", "big_blind", "level_minutes",
        "turn_seconds", "buy_in", "payout_percentages",
    }
    if not isinstance(settings, dict) or set(settings) - allowed:
        raise GameError("invalid_config", "Only host-controlled table settings can change.")
    updated = _validated_config(settings, state["config"])
    table_name = _valid_table_name(name) if name is not None else state["name"]
    timestamp = _now(now)
    state["config"] = updated
    state["name"] = table_name
    for seat in state["seats"]:
        seat["stack"] = updated["starting_stack"]
    state["blinds"]["small"] = updated["small_blind"]
    state["blinds"]["big"] = updated["big_blind"]
    state["blinds"]["level"] = 1
    state["blinds"]["started_at"] = None
    state["blinds"]["next_level_at"] = None
    state["last_activity_at"] = timestamp
    _log(state, "The host updated table settings.", timestamp)
    _bump(state)
    return state


def add_bot(state: Dict[str, Any], actor_id: str, seat_no: int, now: Optional[float] = None, *, is_admin: bool = False) -> Dict[str, Any]:
    """Add an automated player at an open seat in the lobby as a room admin."""
    if not is_admin:
        raise GameError("admin_required", "Only a room admin can add testing bots.", 403)
    if state["status"] != "lobby":
        raise GameError("table_started", "Bots can only be added before the tournament starts.", 409)
    requested = _validate_seat_no(seat_no, state["config"]["max_seats"])
    if any(seat["seat_no"] == requested for seat in state["seats"]):
        raise GameError("seat_taken", "That seat is already occupied.", 409)
    if len(state["seats"]) >= state["config"]["max_seats"]:
        raise GameError("table_full", "This table has no open seats.", 409)
    bot_id = "bot:%s:%d" % (state["id"], requested)
    state["seats"].append({
        "player_id": bot_id, "name": "Bot %d" % (requested + 1),
        "seat_no": requested, "stack": state["config"]["starting_stack"], "is_bot": True,
        "sitting_out": False,
    })
    state["seats"].sort(key=lambda item: item["seat_no"])
    timestamp = _now(now)
    state["last_activity_at"] = timestamp
    _log(state, "%s joined the table." % _seat_by_id(state, bot_id)["name"], timestamp)
    _bump(state)
    return state


def remove_bot(state: Dict[str, Any], actor_id: str, seat_no: int, now: Optional[float] = None, *, is_admin: bool = False) -> Dict[str, Any]:
    """Remove a bot from a lobby seat as a room admin."""
    if not is_admin:
        raise GameError("admin_required", "Only a room admin can remove testing bots.", 403)
    if state["status"] != "lobby":
        raise GameError("table_started", "Bots cannot be removed after the tournament starts.", 409)
    requested = _validate_seat_no(seat_no, state["config"]["max_seats"])
    seat = next((item for item in state["seats"] if item["seat_no"] == requested), None)
    if seat is None or not seat.get("is_bot", False):
        raise GameError("not_bot", "There is no bot in that seat.", 409)
    state["seats"].remove(seat)
    timestamp = _now(now)
    state["last_activity_at"] = timestamp
    _log(state, "%s left the table." % seat["name"], timestamp)
    _bump(state)
    return state


def set_sitting_out(
    state: Dict[str, Any],
    actor_id: str,
    sitting_out: bool,
    now: Optional[float] = None,
) -> Dict[str, Any]:
    """Toggle the authenticated human player's persistent seat preference."""
    if type(sitting_out) is not bool:
        raise GameError("invalid_sitting_out", "Choose whether to sit out.")
    if state.get("paused", False):
        raise GameError("table_paused", "Player actions are unavailable while the tournament is paused.", 409)
    seat = _seat_by_id(state, actor_id)
    if seat is None:
        raise GameError("not_seated", "You do not have a seat at this table.", 409)
    if seat.get("is_bot", False):
        raise GameError("human_seat_required", "Only a seated player can change this setting.", 403)
    if bool(seat.get("sitting_out", False)) == sitting_out:
        return state

    seat["sitting_out"] = sitting_out
    timestamp = _now(now)
    state["last_activity_at"] = timestamp
    text = "%s is sitting out." % seat["name"] if sitting_out else "%s is back at the table." % seat["name"]
    _log(state, text, timestamp)

    hand = state.get("hand")
    if (
        sitting_out
        and state.get("status") == "playing"
        and hand is not None
        and hand.get("street") != "showdown"
        and hand.get("to_act") == actor_id
    ):
        action = "check" if _to_call(hand, actor_id) == 0 else "fold"
        _perform_action(state, actor_id, action, None, timestamp, sitting_out=True)

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


def end_tournament(
    state: Dict[str, Any],
    actor_id: str,
    now: Optional[float] = None,
) -> Dict[str, Any]:
    """End a lobby or abort a running tournament without inventing awards."""
    if actor_id != state["host_id"]:
        raise GameError("host_only", "Only the table host can end this tournament.", 403)
    status = state.get("status")
    if status not in ("lobby", "playing"):
        raise GameError("table_not_active", "Only an active lobby or tournament can be ended.", 409)

    timestamp = _now(now)
    state["last_activity_at"] = timestamp
    if status == "lobby":
        state["status"] = "cancelled"
        state["cancelled_at"] = timestamp
        state["cancellation_reason"] = "host_end"
        _log(state, "Lobby cancelled by the host.", timestamp)
    else:
        state["status"] = "ended"
        state["ended_at"] = timestamp
        state["end_reason"] = "host_aborted"
        state["paused"] = False
        state["paused_at"] = None
        state["blind_announcement"] = None
        state["elimination_announcement"] = None
        state["turn_version"] += 1
        hand = state.get("hand")
        if isinstance(hand, dict):
            hand["to_act"] = None
            for key in (
                "turn_deadline", "bot_action_at", "runout_at", "hand_complete_at",
                "next_hand_at", "showdown_until", "presentation_until",
                "blind_transition_until",
            ):
                hand[key] = None
        _log(state, "Tournament ended by the host; no additional payout was awarded.", timestamp)
    _bump(state)
    return state


def _normalize_payout_percentages(percentages: Sequence[int], entrants: int) -> List[int]:
    """Trim unreachable places and normalize the paid places to exactly 100%."""
    weights = list(percentages[:min(entrants, len(percentages))])
    total = sum(weights)
    if total <= 0:
        return [100] + [0] * (len(weights) - 1)
    shares = [(weight * 100) // total for weight in weights]
    remainders = [(weight * 100) % total for weight in weights]
    left = 100 - sum(shares)
    for index in sorted(range(len(weights)), key=lambda slot: (-remainders[slot], slot))[:left]:
        shares[index] += 1
    return shares


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
    # Normalize lobbies created before newer settings were introduced.
    state["config"] = _validated_config(state.get("config", {}))
    entrants = len(state["seats"])
    state["config"]["max_seats"] = entrants
    state["config"]["payout_percentages"] = _normalize_payout_percentages(
        state["config"]["payout_percentages"], entrants,
    )
    state["prize"] = {
        "buy_in": state["config"]["buy_in"],
        "entrants": entrants,
        "pool_cents": state["config"]["buy_in"] * entrants * 100,
        "payout_percentages": list(state["config"]["payout_percentages"]),
    }
    state["status"] = "playing"
    state["started_at"] = timestamp
    state["last_activity_at"] = timestamp
    _randomize_starting_seats(state)
    _log(state, "Tournament started at level 1.", timestamp)
    _start_hand(state, timestamp, first=True)
    _bump(state)
    return state


def _randomize_starting_seats(state: Dict[str, Any]) -> None:
    """Shuffle entrants into a compact ring sized to the field at start."""
    seats = list(state["seats"])
    capacity = state["config"]["max_seats"]
    random.SystemRandom().shuffle(seats)
    offset = random.SystemRandom().randrange(capacity)
    positions = [(offset + index) % capacity for index in range(len(seats))]
    for seat_no, seat in zip(positions, seats):
        seat["seat_no"] = seat_no
    state["seats"] = sorted(seats, key=lambda seat: seat["seat_no"])


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
    for key in ("blind_announcement", "elimination_announcement"):
        announcement = state.get(key)
        if isinstance(announcement, dict) and announcement.get("until", 0) <= now:
            state[key] = None
    alive = [seat for seat in _seats_in_order(state) if seat["stack"] > 0]
    if len(alive) <= 1:
        _complete_tournament(state, now)
        return

    # A new level gets its full duration from its first actual deal.
    blinds = state["blinds"]
    if blinds.get("next_level_at") is None:
        blinds["started_at"] = now
        blinds["next_level_at"] = now + state["config"]["level_minutes"] * 60

    previous_hand = state.get("hand")
    alive_ids = {seat["player_id"] for seat in alive}
    if first or state["button_id"] is None:
        button = random.SystemRandom().choice(alive)["player_id"]
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
        "hand_id": "%s:%d" % (state["id"], state["hand_no"]),
        "event_seq": 0,
        "event_base_seq": 1,
        "events": [],
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
        "revealed": [],
        "payouts": {},
        "pot_winnings": {},
        "pots": [],
        "returns": [],
        "runout_odds": [],
        "runout_odds_street": None,
        "runout_odds_board": [],
        "runout_odds_exact": None,
        "runout_odds_samples": 0,
        "next_hand_at": None,
        "hand_complete_at": None,
        "showdown_started_at": None,
        "showdown_until": None,
        "presentation_until": None,
        "blind_transition_until": None,
        "blind_transition_announced": False,
        "runout_at": None,
        "runout_swept_street": None,
        "bot_action_at": None,
        "small_blind": state["blinds"]["small"],
        "big_blind": state["blinds"]["big"],
    }
    state["hand"] = hand

    deal_order = [seat["player_id"] for seat in _clockwise_after(state, button) if seat["stack"] > 0]
    for _ in range(2):
        for player_id in deal_order:
            hole_cards[player_id].append(_take_card(hand))

    small_paid = _post_blind(state, hand, small_id, hand["small_blind"])
    _record_action_event(state, hand, small_id, "small_blind", small_paid, blind="small")
    big_paid = _post_blind(state, hand, big_id, hand["big_blind"])
    _record_action_event(state, hand, big_id, "big_blind", big_paid, blind="big")
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
    seat = _seat_by_id(state, player_id)
    hand["bot_action_at"] = (
        now + random.SystemRandom().uniform(0.8, 1.4)
        if seat is not None and seat.get("is_bot", False) else None
    )


def _set_next_actor(state: Dict[str, Any], after_id: Optional[str], now: float) -> None:
    hand = state["hand"]
    assert hand is not None
    # Sit-out actions are applied inline. The fixed bound covers at most one
    # action for every dealt player on each of four streets, plus street edges.
    max_steps = 4 * max(1, len(hand.get("holes", {}))) + 4
    for _ in range(max_steps):
        if state.get("hand") is not hand or state.get("status") != "playing":
            return
        contenders = _hand_live_ids(hand)
        if len(contenders) <= 1:
            _award_without_showdown(state, contenders[0] if contenders else None, now)
            return

        able = _players_able_to_act(state, hand)
        if len(able) == 1:
            only_player = able[0]
            opponent_bet = max(
                (
                    hand["bets"].get(player_id, 0)
                    for player_id in contenders
                    if player_id != only_player
                ),
                default=0,
            )
            if hand["bets"].get(only_player, 0) >= opponent_bet:
                # No live opponent can match another chip. This also covers a
                # short blind whose nominal bring-in exceeds its actual wager.
                _advance_street(state, now, chain_actor=False)
                if hand.get("street") == "showdown" or hand.get("runout_at") is not None:
                    return
                after_id = hand["button_id"]
                continue

        next_id = next(
            (
                seat["player_id"]
                for seat in _clockwise_after(state, after_id)
                if seat["player_id"] in hand["holes"]
                and _pending(state, hand, seat["player_id"])
            ),
            None,
        )
        if next_id is None:
            _advance_street(state, now, chain_actor=False)
            if hand.get("street") == "showdown" or hand.get("runout_at") is not None:
                return
            after_id = hand["button_id"]
            continue

        seat = _seat_by_id(state, next_id)
        if seat is not None and seat.get("sitting_out", False):
            action = "check" if _to_call(hand, next_id) == 0 else "fold"
            previous_street = hand.get("street")
            hand["to_act"] = next_id
            hand["turn_deadline"] = None
            hand["bot_action_at"] = None
            _perform_action(
                state, next_id, action, None, now,
                sitting_out=True, continue_turn=False,
            )
            if state.get("hand") is not hand or state.get("status") != "playing":
                return
            if hand.get("street") == "showdown" or hand.get("runout_at") is not None:
                return
            after_id = hand["button_id"] if hand.get("street") != previous_street else next_id
            continue

        _arm_turn(state, hand, next_id, now)
        return

    # A malformed legacy state must not recurse or spin forever while choosing
    # actors. Clearing the expired actor lets later server ticks recover safely.
    hand["to_act"] = None
    hand["turn_deadline"] = None
    hand["bot_action_at"] = None

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


def _has_live_all_in(state: Dict[str, Any], hand: Dict[str, Any]) -> bool:
    if len(_hand_live_ids(hand)) < 2:
        return False
    for player_id in _hand_live_ids(hand):
        seat = _seat_by_id(state, player_id)
        if seat is not None and seat["stack"] <= 0:
            return True
    return False


def _has_all_in(state: Dict[str, Any], hand: Dict[str, Any]) -> bool:
    """Only run out once no more than one live player can build a side pot."""
    return _has_live_all_in(state, hand) and len(_players_able_to_act(state, hand)) <= 1


def _reveal_live_hands(state: Dict[str, Any], hand: Dict[str, Any]) -> None:
    if hand.get("revealed"):
        return
    revealed = []
    for player_id in _hand_live_ids(hand):
        seat = _seat_by_id(state, player_id)
        revealed.append({
            "player_id": player_id,
            "actor_label": seat["name"] if seat is not None else "Player",
            "seat_no": seat["seat_no"] if seat is not None else None,
            "cards": list(hand["holes"].get(player_id, [])),
        })
    hand["revealed"] = revealed
    odds = _refresh_runout_odds(state, hand)
    _record_event(
        state, hand, "reveal", street=hand.get("street"), hands=revealed,
        runout_odds=odds,
        odds_street=hand.get("runout_odds_street"),
        odds_board=list(hand.get("runout_odds_board", [])),
        odds_exact=hand.get("runout_odds_exact"),
        odds_samples=hand.get("runout_odds_samples", 0),
    )


def _deal_next_street(state: Dict[str, Any], hand: Dict[str, Any], now: float) -> bool:
    previous_street = hand.get("street")
    previous_board = list(hand.get("board", []))
    board = hand.setdefault("board", [])
    if len(board) == 0:
        _take_card(hand)  # burn
        board.extend([_take_card(hand) for _ in range(3)])
        hand["street"] = "flop"
    elif len(board) == 3:
        _take_card(hand)
        board.append(_take_card(hand))
        hand["street"] = "turn"
    elif len(board) == 4:
        _take_card(hand)
        board.append(_take_card(hand))
        hand["street"] = "river"
    else:
        return False

    hand["bets"] = {player_id: 0 for player_id in hand["holes"]}
    hand["current_bet"] = 0
    hand["min_raise"] = hand["big_blind"]
    hand["acted"] = []
    hand["acted_at_bet"] = {}
    hand["short_opening"] = False
    hand["runout_swept_street"] = None
    _log(state, "%s dealt." % hand["street"].capitalize(), now)
    odds = _refresh_runout_odds(state, hand)
    _record_event(
        state,
        hand,
        "street",
        from_street=previous_street,
        street=hand["street"],
        board=list(board),
        new_cards=board[len(previous_board):],
        runout_odds=odds,
        odds_street=hand.get("runout_odds_street"),
        odds_board=list(hand.get("runout_odds_board", [])),
        odds_exact=hand.get("runout_odds_exact"),
        odds_samples=hand.get("runout_odds_samples", 0),
    )
    return True


def _begin_runout(state: Dict[str, Any], hand: Dict[str, Any], now: float) -> None:
    _record_sweep(state, hand)
    hand["runout_swept_street"] = hand.get("street")
    _reveal_live_hands(state, hand)
    hand["to_act"] = None
    hand["turn_deadline"] = None
    hand["bot_action_at"] = None
    hand["bets"] = {player_id: 0 for player_id in hand.get("holes", {})}
    hand["current_bet"] = 0
    hand["acted"] = []
    hand["acted_at_bet"] = {}
    if hand.get("street") == "river" or len(hand.get("board", [])) >= 5:
        hand["runout_at"] = None
        _settle_showdown(state, now)
        return
    delay = state["config"].get("runout_seconds", RUNOUT_SECONDS)
    hand["runout_at"] = now + delay


def _deal_runout_card(
    state: Dict[str, Any],
    hand: Dict[str, Any],
    now: float,
) -> bool:
    """Expose a grouped flop, then the turn and river on separate intervals."""
    previous_street = hand.get("street")
    previous_board = list(hand.get("board", []))
    board = hand.setdefault("board", [])
    count = len(board)
    if count < 3:
        if count == 0:
            _take_card(hand)  # burn once before the flop
        hand["street"] = "flop"
        board.extend(_take_card(hand) for _ in range(3 - count))
    elif count == 3:
        _take_card(hand)
        board.append(_take_card(hand))
        hand["street"] = "turn"
    elif count == 4:
        _take_card(hand)
        board.append(_take_card(hand))
        hand["street"] = "river"
    else:
        return False

    _log(state, "%s dealt." % hand["street"].capitalize(), now)
    odds = _refresh_runout_odds(state, hand)
    _record_event(
        state,
        hand,
        "street",
        from_street=previous_street,
        street=hand["street"],
        board=list(board),
        new_cards=board[len(previous_board):],
        runout_card_index=len(board),
        runout_card_total=5,
        runout_odds=odds,
        odds_street=hand.get("runout_odds_street"),
        odds_board=list(hand.get("runout_odds_board", [])),
        odds_exact=hand.get("runout_odds_exact"),
        odds_samples=hand.get("runout_odds_samples", 0),
    )
    return True


def _advance_runout(state: Dict[str, Any], now: float) -> None:
    hand = state["hand"]
    assert hand is not None
    if not _deal_runout_card(state, hand, now):
        hand["runout_at"] = None
        _settle_showdown(state, now)
        return
    if len(hand.get("board", [])) >= 5:
        hand["runout_at"] = None
        _settle_showdown(state, now)
        return
    delay = state["config"].get("runout_seconds", RUNOUT_SECONDS)
    hand["runout_at"] = now + delay


def _advance_street(
    state: Dict[str, Any],
    now: float,
    chain_actor: bool = True,
) -> None:
    hand = state["hand"]
    assert hand is not None
    live = _hand_live_ids(hand)
    if len(live) <= 1:
        _award_without_showdown(state, live[0] if live else None, now)
        return

    if hand.get("street") == "river" or len(hand.get("board", [])) >= 5:
        _record_sweep(state, hand)
        if _has_live_all_in(state, hand):
            _reveal_live_hands(state, hand)
        _settle_showdown(state, now)
        return

    if _has_all_in(state, hand):
        _begin_runout(state, hand, now)
        return

    _record_sweep(state, hand)

    _deal_next_street(state, hand, now)
    if not _players_able_to_act(state, hand):
        # This is normally an all-in runout. The guard keeps malformed or legacy
        # persisted states progressing without dealing duplicate board cards.
        if _has_all_in(state, hand):
            _begin_runout(state, hand, now)
        else:
            _settle_showdown(state, now)
        return
    if chain_actor:
        _set_next_actor(state, hand["button_id"], now)
    else:
        hand["to_act"] = None
        hand["turn_deadline"] = None
        hand["bot_action_at"] = None


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
    sitting_out: bool = False,
    continue_turn: bool = True,
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
        if to_call == 0:
            raise GameError("cannot_fold", "Check is free.", 400)
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

    hand.setdefault("last_action_turn", {})[actor_id] = state["turn_version"]
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
    _record_action_event(
        state, hand, actor_id, action, paid, target=target,
        timed_out=timed_out, sitting_out=sitting_out,
    )

    live = _hand_live_ids(hand)
    if len(live) <= 1:
        _award_without_showdown(state, live[0] if live else None, now)
        return

    if _round_complete(state, hand):
        _advance_street(state, now, chain_actor=continue_turn)
    elif continue_turn:
        _set_next_actor(state, actor_id, now)
    else:
        hand["to_act"] = None
        hand["turn_deadline"] = None
        hand["bot_action_at"] = None


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
    if state.get("paused", False):
        raise GameError("table_paused", "Player actions are unavailable while the tournament is paused.", 409)
    if isinstance(expected_hand, bool) or not isinstance(expected_hand, int) or expected_hand != state["hand_no"]:
        raise GameError("stale_hand", "That hand has moved on. Refresh the table.", 409)
    if isinstance(expected_turn_version, bool) or not isinstance(expected_turn_version, int) or expected_turn_version != state["turn_version"]:
        raise GameError("stale_turn", "That turn has moved on. Refresh the table.", 409)
    timestamp = _now(now)
    _perform_action(state, actor_id, action, amount, timestamp)
    _bump(state)
    return state



def _choose_bot_action(
    state: Dict[str, Any],
    hand: Dict[str, Any],
    player_id: str,
) -> Tuple[str, Optional[int]]:
    """Ask the isolated policy using only hero and public hand information."""
    seat = _seat_by_id(state, player_id)
    if seat is None:
        raise GameError("cannot_act", "The bot no longer has a seat.", 409)

    button = _seat_by_id(state, hand.get("button_id"))
    participants = []
    for public_seat in _seats_in_order(state):
        public_id = public_seat["player_id"]
        if public_id not in hand.get("holes", {}):
            continue
        folded = public_id in hand.get("folded", [])
        participants.append({
            "seat": public_seat["seat_no"],
            "stack": public_seat["stack"],
            "street_bet": hand.get("bets", {}).get(public_id, 0),
            "folded": folded,
            "all_in": bool(public_seat["stack"] == 0 and not folded),
        })

    context = {
        "street": hand.get("street", "preflop"),
        "hole_cards": list(hand.get("holes", {}).get(player_id, [])),
        "board": list(hand.get("board", [])),
        "hero_seat": seat["seat_no"],
        "button_seat": button["seat_no"] if button is not None else seat["seat_no"],
        "players": participants,
        "small_blind": hand.get("small_blind", state["blinds"]["small"]),
        "big_blind": hand.get("big_blind", state["blinds"]["big"]),
        "pot": sum(hand.get("contrib", {}).values()),
        "current_bet": hand.get("current_bet", 0),
        "min_raise": hand.get("min_raise", hand.get("big_blind", 0)),
        "raise_allowed": bool(
            _has_raise_right(hand, player_id)
            and _has_raise_opponent(state, hand, player_id)
        ),
    }

    current = hand.get("current_bet", 0)
    player_bet = hand.get("bets", {}).get(player_id, 0)
    to_call = max(0, current - player_bet)
    max_total = player_bet + seat["stack"]
    raise_allowed = context["raise_allowed"]

    def fallback() -> Tuple[str, Optional[int]]:
        return ("check", None) if to_call == 0 else ("fold", None)

    try:
        import bot_strategy
        proposed = bot_strategy.choose_action(
            context, _rank_seven_fast, rng=random.SystemRandom(),
        )
    except Exception:
        return fallback()

    if not isinstance(proposed, (tuple, list)) or len(proposed) != 2:
        return fallback()
    action, amount = proposed
    if not isinstance(action, str):
        return fallback()
    action = action.lower()
    if action == "check":
        return (action, None) if to_call == 0 else fallback()
    if action == "fold":
        return (action, None) if to_call > 0 else fallback()
    if action == "call":
        return (action, None) if to_call > 0 else fallback()
    if action in ("bet", "raise"):
        if (action == "bet") != (current == 0):
            return fallback()
        if type(amount) is not int:
            return fallback()
        minimum = current + hand.get("min_raise", 0) if current else hand.get("min_raise", 0)
        if (
            amount <= current
            or amount > max_total
            or not raise_allowed
            or not _has_raise_right(hand, player_id)
            or not _has_raise_opponent(state, hand, player_id)
            or (amount < minimum and amount != max_total)
        ):
            return fallback()
        return action, amount
    if action == "all_in":
        if max_total > current and (
            not raise_allowed
            or not _has_raise_right(hand, player_id)
            or not _has_raise_opponent(state, hand, player_id)
        ):
            return fallback()
        return action, None
    return fallback()


def _apply_due_blinds(
    state: Dict[str, Any],
    timestamp: float,
    not_before: Optional[float] = None,
) -> bool:
    """Advance one level at a hand boundary; its clock waits for the deal."""
    if state.get("status") != "playing":
        return False
    blinds = state["blinds"]
    deadline = blinds.get("next_level_at")
    if deadline is None or timestamp < deadline:
        return False

    blinds["level"] += 1
    blinds["small"] = min(MAX_CHIPS, blinds["small"] * 2)
    blinds["big"] = min(MAX_CHIPS, blinds["big"] * 2)
    announcement_seconds = state["config"].get(
        "blind_announcement_seconds", BLIND_ANNOUNCEMENT_SECONDS,
    )

    starts_at = max(timestamp, not_before if not_before is not None else timestamp)
    hand = state.get("hand")
    if hand is not None and hand.get("street") == "showdown":
        for key in ("hand_complete_at", "showdown_until", "presentation_until"):
            value = _deadline_number(hand.get(key))
            if value is not None:
                starts_at = max(starts_at, value)
        elimination = state.get("elimination_announcement")
        if isinstance(elimination, dict):
            value = _deadline_number(elimination.get("until"))
            if value is not None:
                starts_at = max(starts_at, value)
    existing = state.get("blind_announcement")
    if isinstance(existing, dict):
        value = _deadline_number(existing.get("until"))
        if value is not None:
            starts_at = max(starts_at, value)

    announcement_until = starts_at + announcement_seconds
    blinds["started_at"] = None
    blinds["next_level_at"] = None
    state["blind_announcement"] = (
        {
            "level": blinds["level"],
            "small": blinds["small"],
            "big": blinds["big"],
            "starts_at": starts_at,
            "until": announcement_until,
        }
        if announcement_seconds > 0 else None
    )
    _log(
        state,
        "Blind level %d: %d/%d." % (blinds["level"], blinds["small"], blinds["big"]),
        timestamp,
    )

    if hand is not None and hand.get("street") == "showdown":
        hand["blind_transition_announced"] = True
        hand["blind_transition_until"] = max(
            announcement_until, starts_at, timestamp + HAND_COMPLETE_PAUSE_SECONDS,
        )
        _record_event(
            state, hand, "blind_level_updated",
            level=blinds["level"],
            small_blind=blinds["small"],
            big_blind=blinds["big"],
            changed_at=timestamp,
            starts_at=starts_at,
            until=announcement_until if announcement_seconds > 0 else starts_at,
        )
        _refresh_presentation_deadline(state, hand)
    return True


def _migrate_presentation_timing(state: Dict[str, Any], hand: Dict[str, Any], now: float) -> bool:
    """Add sequential deadlines to a persisted hand from an older engine version."""
    if hand.get("presentation_version", 0) >= 2:
        return False
    if hand.get("street") != "showdown":
        return False

    actual_showdown = bool(hand.get("showdown"))
    complete_at = _deadline_number(hand.get("hand_complete_at"))
    if actual_showdown:
        started_at = _deadline_number(hand.get("showdown_started_at"))
        if started_at is None:
            started_at = complete_at - HAND_COMPLETE_PAUSE_SECONDS if complete_at is not None else now
            hand["showdown_started_at"] = started_at
        if hand.get("showdown_until") is None:
            hand["showdown_until"] = started_at + state.get("config", {}).get(
                "showdown_seconds", SHOWDOWN_SECONDS,
            )
        hand["hand_complete_at"] = hand["showdown_until"]
    elif complete_at is None:
        complete_at = now + HAND_COMPLETE_PAUSE_SECONDS
        hand["hand_complete_at"] = complete_at

    result_end = max(
        _deadline_number(hand.get("showdown_until")) or 0,
        _deadline_number(hand.get("hand_complete_at")) or now,
    )
    elimination = state.get("elimination_announcement")
    if isinstance(elimination, dict):
        until = _deadline_number(elimination.get("until"))
        if until is not None and until > now and elimination.get("starts_at") is None:
            duration = state.get("config", {}).get(
                "elimination_announcement_seconds", ELIMINATION_ANNOUNCEMENT_SECONDS,
            )
            starts_at = max(result_end, now if complete_at is None else complete_at)
            if duration > 0:
                elimination["starts_at"] = starts_at
                elimination["until"] = starts_at + duration
            else:
                state["elimination_announcement"] = None

    elimination = state.get("elimination_announcement")
    elimination_end = (
        _deadline_number(elimination.get("until"))
        if isinstance(elimination, dict) else None
    )
    blind = state.get("blind_announcement")
    if isinstance(blind, dict):
        until = _deadline_number(blind.get("until"))
        if until is not None and until > now and blind.get("starts_at") is None:
            duration = state.get("config", {}).get(
                "blind_announcement_seconds", BLIND_ANNOUNCEMENT_SECONDS,
            )
            starts_at = max(result_end, elimination_end or result_end)
            if duration > 0:
                blind["starts_at"] = starts_at
                blind["until"] = starts_at + duration
                hand["blind_transition_until"] = max(
                    blind["until"], starts_at, now + HAND_COMPLETE_PAUSE_SECONDS,
                )
            else:
                state["blind_announcement"] = None

    hand["presentation_version"] = 2
    old_next_hand = _deadline_number(hand.get("next_hand_at"))
    _refresh_presentation_deadline(state, hand)
    if state.get("status") == "playing" and old_next_hand is not None:
        hand["next_hand_at"] = max(hand["next_hand_at"] or old_next_hand, old_next_hand)
    return True


def advance(state: Dict[str, Any], now: Optional[float] = None) -> Dict[str, Any]:
    """Advance blind clocks, turn timeouts, and the short showdown pause."""
    timestamp = _now(now)
    hand = state.get("hand")
    migrated = False
    if state.get("status") == "playing" and isinstance(hand, dict) and hand.get("street") == "showdown":
        paused_at = state.get("paused_at") if state.get("paused", False) else None
        effective_now = paused_at if isinstance(paused_at, (int, float)) else timestamp
        migrated = _migrate_presentation_timing(state, hand, effective_now)
    if state.get("paused", False):
        if migrated:
            _bump(state)
        return state
    # Discard check/fold selections left in tables by older versions.
    if isinstance(hand, dict):
        hand.pop("preactions", None)
        hand.pop("preaction_revisions", None)
    changed = migrated
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

    hand = state["hand"]
    if hand is not None and hand.get("street") == "showdown":
        remaining = sum(1 for seat in state["seats"] if seat["stack"] > 0)
        announcement_active = any(
            isinstance(state.get(key), dict)
            and state[key].get("until") is not None
            and timestamp < state[key]["until"]
            for key in ("blind_announcement", "elimination_announcement")
        )
        if (
            state["status"] == "playing"
            and remaining > 1
            and not hand.get("blind_transition_announced", False)
            and not announcement_active
            and _apply_due_blinds(state, timestamp)
        ):
            # Preserve the normal showdown pause and hold for any announcement.
            deadlines = [
                hand.get("next_hand_at")
                or hand.get("hand_complete_at")
                or timestamp + HAND_COMPLETE_PAUSE_SECONDS,
            ]
            for key in ("blind_announcement", "elimination_announcement"):
                announcement = state.get(key)
                if isinstance(announcement, dict) and announcement.get("until") is not None:
                    deadlines.append(announcement["until"])
            hand["next_hand_at"] = max(deadlines)
            changed = True
        elif (
            state["status"] == "playing"
            and hand.get("next_hand_at") is not None
            and timestamp >= hand["next_hand_at"]
        ):
            _start_hand(state, timestamp)
            changed = True
    elif hand is not None and hand.get("runout_at") is not None:
        if timestamp >= hand["runout_at"]:
            _advance_runout(state, timestamp)
            changed = True
    elif (
        hand is not None
        and hand.get("to_act") is None
        and hand.get("street") != "showdown"
        and _has_all_in(state, hand)
    ):
        # Recover old persisted hands that had already closed their betting
        # round before the runout ticker was added.
        _advance_street(state, timestamp)
        changed = True
    elif hand is not None and hand.get("to_act") is not None:
        actor_id = hand["to_act"]
        actor_seat = _seat_by_id(state, actor_id)
        if actor_seat is not None and actor_seat.get("is_bot", False):
            due = hand.get("bot_action_at")
            if due is None:
                hand["bot_action_at"] = timestamp + random.SystemRandom().uniform(0.8, 1.4)
                changed = True
            elif timestamp >= due:
                action, amount = _choose_bot_action(state, hand, actor_id)
                _perform_action(state, actor_id, action, amount, timestamp)
                changed = True
        elif hand["turn_deadline"] is not None and timestamp >= hand["turn_deadline"]:
            _perform_action(state, actor_id, "check", None, timestamp, timed_out=True)
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


def _rank_seven_fast(cards: Sequence[str]) -> Tuple[int, ...]:
    """Rank five to seven cards without enumerating all five-card subsets."""
    if len(cards) < 5 or len(cards) > 7:
        raise ValueError("rank_seven_fast requires five to seven cards")
    counts: Dict[int, int] = {}
    suited: Dict[str, List[int]] = {suit: [] for suit in SUITS}
    for card in cards:
        rank = RANK_VALUES[card[0]]
        counts[rank] = counts.get(rank, 0) + 1
        suited[card[1]].append(rank)

    ranks = sorted(counts, reverse=True)
    for suit_ranks in suited.values():
        if len(suit_ranks) >= 5:
            straight_flush = _straight_high(suit_ranks)
            if straight_flush is not None:
                return (8, straight_flush)

    quads = [rank for rank, count in counts.items() if count == 4]
    if quads:
        quad = max(quads)
        kicker = max(rank for rank in ranks if rank != quad)
        return (7, quad, kicker)

    trips = sorted((rank for rank, count in counts.items() if count >= 3), reverse=True)
    pairs = sorted((rank for rank, count in counts.items() if count >= 2), reverse=True)
    if trips:
        pair = next((rank for rank in pairs if rank != trips[0]), None)
        if pair is not None:
            return (6, trips[0], pair)

    for suit_ranks in suited.values():
        if len(suit_ranks) >= 5:
            return (5,) + tuple(sorted(suit_ranks, reverse=True)[:5])

    straight = _straight_high(ranks)
    if straight is not None:
        return (4, straight)
    if trips:
        trip = trips[0]
        kickers = [rank for rank in ranks if rank != trip][:2]
        return (3, trip) + tuple(kickers)
    if len(pairs) >= 2:
        first, second = pairs[:2]
        kicker = max(rank for rank in ranks if rank not in (first, second))
        return (2, first, second, kicker)
    if pairs:
        pair = pairs[0]
        kickers = [rank for rank in ranks if rank != pair][:3]
        return (1, pair) + tuple(kickers)
    return (0,) + tuple(ranks[:5])


@lru_cache(maxsize=256)
def _calculate_runout_odds(
    holes: Tuple[Tuple[str, Tuple[str, ...]], ...],
    board: Tuple[str, ...],
) -> Tuple[Tuple[str, float, float, float, bool, int], ...]:
    """Return sole-win, shared-best, and equal-share pot percentages.

    tie_pct counts outcomes where a player shares the best hand with one or
    more opponents. equity_pct gives each tied player an equal pot share;
    it is an all-live-hand estimate and does not model side-pot eligibility or
    odd-chip assignment. Large preflop spaces use deterministic sampling.
    """
    players = tuple(player_id for player_id, _ in holes)
    known_cards = {card for _, cards in holes for card in cards}
    known_cards.update(board)
    deck = tuple(
        rank + suit
        for rank in RANK_CHARS
        for suit in SUITS
        if rank + suit not in known_cards
    )
    missing = 5 - len(board)
    if missing < 0:
        return ()
    outcome_count = math.comb(len(deck), missing)
    exact = outcome_count <= RUNOUT_EXACT_LIMIT
    samples = outcome_count if exact else RUNOUT_SAMPLE_COUNT
    wins = {player_id: 0 for player_id in players}
    ties = {player_id: 0 for player_id in players}
    shares = {player_id: 0.0 for player_id in players}

    if exact:
        runouts: Iterable[Sequence[str]] = itertools.combinations(deck, missing)
    else:
        seed_data = repr((holes, board)).encode("utf-8")
        seed = int.from_bytes(hashlib.sha256(seed_data).digest()[:8], "big")
        rng = random.Random(seed)
        runouts = (rng.sample(deck, missing) for _ in range(samples))

    for runout in runouts:
        complete_board = board + tuple(runout)
        ranks = {
            player_id: _rank_seven_fast(cards + complete_board)
            for player_id, cards in holes
        }
        best = max(ranks.values())
        winners = [player_id for player_id, rank in ranks.items() if rank == best]
        if len(winners) == 1:
            wins[winners[0]] += 1
        else:
            for player_id in winners:
                ties[player_id] += 1
        share = 1.0 / len(winners)
        for player_id in winners:
            shares[player_id] += share

    total = samples or 1
    return tuple(
        (
            player_id,
            round(wins[player_id] * 100.0 / total, 1),
            round(ties[player_id] * 100.0 / total, 1),
            round(shares[player_id] * 100.0 / total, 1),
            exact,
            samples,
        )
        for player_id in players
    )


def _refresh_runout_odds(
    state: Dict[str, Any],
    hand: Dict[str, Any],
) -> List[Dict[str, Any]]:
    revealed_ids = {
        item["player_id"]
        for item in hand.get("revealed", [])
        if item.get("player_id") in hand.get("holes", {})
    }
    live_ids = [
        seat["player_id"]
        for seat in _seats_in_order(state)
        if seat["player_id"] in revealed_ids
        and seat["player_id"] not in set(hand.get("folded", []))
    ]
    hand["runout_odds_street"] = hand.get("street")
    hand["runout_odds_board"] = list(hand.get("board", []))
    if len(live_ids) < 2 or len(hand.get("board", [])) > 5:
        hand["runout_odds"] = []
        hand["runout_odds_exact"] = None
        hand["runout_odds_samples"] = 0
        return []

    holes = tuple(
        (player_id, tuple(hand["holes"][player_id]))
        for player_id in live_ids
    )
    cached_rows = _calculate_runout_odds(holes, tuple(hand.get("board", [])))
    rows = [
        {
            "player_id": player_id,
            "win_pct": win_pct,
            "tie_pct": tie_pct,
            "equity_pct": equity_pct,
            "exact": exact,
            "samples": samples,
        }
        for player_id, win_pct, tie_pct, equity_pct, exact, samples in cached_rows
    ]
    hand["runout_odds"] = rows
    hand["runout_odds_exact"] = bool(rows[0]["exact"]) if rows else None
    hand["runout_odds_samples"] = int(rows[0]["samples"]) if rows else 0
    return rows


def _hand_name(rank: Tuple[int, ...]) -> str:
    return HAND_NAMES[rank[0]]


def _rank_description(rank: Tuple[int, ...]) -> str:
    singles = ("two", "three", "four", "five", "six", "seven", "eight",
               "nine", "ten", "jack", "queen", "king", "ace")
    plurals = ("twos", "threes", "fours", "fives", "sixes", "sevens", "eights",
               "nines", "tens", "jacks", "queens", "kings", "aces")
    category, high = rank[0], rank[1]
    name, plural = singles[high - 2], plurals[high - 2]
    if category == 0:
        return "%s high" % name.capitalize()
    if category == 1:
        return "Pair of %s" % plural
    if category == 2:
        return "Two pair, %s and %s" % (plural, plurals[rank[2] - 2])
    if category == 3:
        return "Three %s" % plural
    if category == 4:
        return "%s-high straight" % name.capitalize()
    if category == 5:
        return "%s-high flush" % name.capitalize()
    if category == 6:
        return "%s full of %s" % (plural.capitalize(), plurals[rank[2] - 2])
    if category == 7:
        return "Four %s" % plural
    return "%s-high straight flush" % name.capitalize()


def _allocate_pots(
    state: Dict[str, Any],
    hand: Dict[str, Any],
    ranks: Optional[Dict[str, Tuple[int, ...]]] = None,
) -> Tuple[Dict[str, int], Dict[str, int], List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Allocate merged contested pots and return unmatched single-player layers."""
    contributions = hand["contrib"]
    folded = set(hand["folded"])
    payouts = {player_id: 0 for player_id in contributions}
    pot_winnings = {player_id: 0 for player_id in contributions}
    levels = sorted(set(amount for amount in contributions.values() if amount > 0))
    layers: List[Dict[str, Any]] = []
    returns: List[Dict[str, Any]] = []
    previous = 0

    for level in levels:
        contributors = [
            player_id for player_id, total in contributions.items()
            if total >= level
        ]
        layer_amount = (level - previous) * len(contributors)
        previous = level
        if layer_amount <= 0:
            continue

        # A layer with one contributor is an unmatched bet, not a pot won.
        if len(contributors) == 1:
            player_id = contributors[0]
            if player_id in folded:
                raise GameError("invalid_pot", "An unmatched bet cannot be returned to a folded player.", 500)
            seat = _seat_by_id(state, player_id)
            payouts[player_id] += layer_amount
            returns.append({
                "player_id": player_id,
                "actor_label": seat["name"] if seat is not None else "Player",
                "amount": layer_amount,
            })
            continue

        eligible = [player_id for player_id in contributors if player_id not in folded]
        if not eligible:
            raise GameError("invalid_pot", "No active player can claim a pot.", 500)
        eligible_key = frozenset(eligible)
        if layers and layers[-1]["eligible_key"] == eligible_key:
            layers[-1]["amount"] += layer_amount
            layers[-1]["cap"] = level
        else:
            layers.append({
                "amount": layer_amount,
                "cap": level,
                "eligible": eligible,
                "eligible_key": eligible_key,
            })

    clockwise = [seat["player_id"] for seat in _clockwise_after(state, hand["button_id"])]
    pots: List[Dict[str, Any]] = []
    for layer in layers:
        eligible = layer["eligible"]
        if len(eligible) == 1:
            winners = eligible
        elif ranks is None:
            raise GameError("invalid_pot", "More than one player is eligible for an unshown pot.", 500)
        else:
            best = max(ranks[player_id] for player_id in eligible)
            winners = [player_id for player_id in eligible if ranks[player_id] == best]

        share, odd = divmod(layer["amount"], len(winners))
        recipient_amounts = {player_id: share for player_id in winners}
        ordered_winners = [player_id for player_id in clockwise if player_id in winners]
        for player_id in ordered_winners[:odd]:
            recipient_amounts[player_id] += 1

        recipients = []
        for player_id in clockwise:
            amount = recipient_amounts.get(player_id, 0)
            if amount <= 0:
                continue
            seat = _seat_by_id(state, player_id)
            recipient = {
                "player_id": player_id,
                "actor_label": seat["name"] if seat is not None else "Player",
                "amount": amount,
                "rank": _rank_description(ranks[player_id]) if ranks is not None else None,
                "hand_name": _hand_name(ranks[player_id]) if ranks is not None else None,
            }
            recipients.append(recipient)
            payouts[player_id] += amount
            pot_winnings[player_id] += amount

        pot_index = len(pots)
        pots.append({
            "pot_index": pot_index,
            "label": "Main pot" if pot_index == 0 else "Side pot %d" % pot_index,
            "amount": layer["amount"],
            "cap": layer["cap"],
            "eligible_player_ids": [
                player_id for player_id in clockwise if player_id in layer["eligible_key"]
            ],
            "recipients": recipients,
        })

    if sum(payouts.values()) != sum(contributions.values()):
        raise GameError("invalid_pot", "Pot allocation did not conserve all contributed chips.", 500)
    return payouts, pot_winnings, pots, returns


def _split_side_pots(
    state: Dict[str, Any],
    hand: Dict[str, Any],
    now: float,
) -> Dict[str, int]:
    """Return each player's total credits, including any uncalled return."""
    payouts, _, _, _ = _allocate_pots(state, hand, _showdown_ranks(hand))
    return payouts


def _showdown_ranks(hand: Dict[str, Any]) -> Dict[str, Tuple[int, ...]]:
    folded = set(hand["folded"])
    return {
        player_id: rank_seven(hand["holes"][player_id] + hand["board"])
        for player_id in hand["holes"]
        if player_id not in folded
    }


def _winner_rows(
    state: Dict[str, Any],
    amounts: Dict[str, int],
    ranks: Optional[Dict[str, Tuple[int, ...]]] = None,
) -> List[Dict[str, Any]]:
    rows = []
    for seat in _seats_in_order(state):
        amount = amounts.get(seat["player_id"], 0)
        if amount <= 0:
            continue
        row = {
            "player_id": seat["player_id"],
            "actor_label": seat["name"],
            "amount": amount,
        }
        if ranks is not None and seat["player_id"] in ranks:
            row["rank"] = _rank_description(ranks[seat["player_id"]])
            row["hand_name"] = _hand_name(ranks[seat["player_id"]])
        rows.append(row)
    return rows


def _record_eliminations(
    state: Dict[str, Any],
    hand: Dict[str, Any],
    now: float,
) -> List[Dict[str, Any]]:
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
    newly_recorded: List[Dict[str, Any]] = []
    cursor = 0
    while cursor < len(newly_out):
        starting_stack = hand["stack_before"].get(newly_out[cursor]["player_id"], 0)
        group = []
        while (
            cursor < len(newly_out)
            and hand["stack_before"].get(newly_out[cursor]["player_id"], 0) == starting_stack
        ):
            group.append(newly_out[cursor])
            cursor += 1
        place = total - len(state["elimination_order"]) - len(group) + 1
        group_awards = _prize_awards_for_group(
            state, place, [seat["player_id"] for seat in group]
        )
        for seat in group:
            item = {
                "player_id": seat["player_id"],
                "name": seat["name"],
                "seat_no": seat["seat_no"],
                "place": place,
                "tied": len(group) > 1,
                "tie_count": len(group),
                "stack_before": starting_stack,
                "hand_no": hand.get("number", state.get("hand_no")),
                "eliminated_at": int(now),
            }
            if group_awards is not None:
                item["award_cents"] = group_awards[seat["player_id"]]
            state["elimination_order"].append(item)
            newly_recorded.append(item)
            if len(group) > 1:
                _log(
                    state,
                    "%s ties for %s place with %d players." % (
                        seat["name"], _ordinal(place), len(group),
                    ),
                    now,
                )
            else:
                _log(state, "%s is out in %s place." % (seat["name"], _ordinal(place)), now)
    return newly_recorded


def _prize_schedule(state: Dict[str, Any]) -> Optional[Tuple[int, List[int], int]]:
    """Return a validated immutable prize snapshot and its payable weights."""
    prize = state.get("prize")
    if not isinstance(prize, dict):
        return None
    pool_cents = prize.get("pool_cents")
    entrants = prize.get("entrants")
    percentages = prize.get("payout_percentages")
    if (
        type(pool_cents) is not int or pool_cents < 0 or pool_cents % 100 != 0
        or type(entrants) is not int or entrants < 1
        or not isinstance(percentages, (list, tuple))
        or not 1 <= len(percentages) <= MAX_PAYOUT_PLACES
        or any(type(value) is not int or value < 0 or value > 100 for value in percentages)
    ):
        return None
    weights = list(percentages[:min(entrants, len(percentages))])
    return pool_cents, weights, sum(weights)


def _prize_awards_for_group(
    state: Dict[str, Any],
    place: int,
    player_ids: Sequence[str],
) -> Optional[Dict[str, int]]:
    """Pool tied-place weights, divide equally, then floor each share to credits."""
    schedule = _prize_schedule(state)
    if schedule is None:
        return None
    if not player_ids:
        return {}
    pool_cents, weights, denominator = schedule

    pooled_weight = sum(
        weights[slot - 1]
        for slot in range(place, place + len(player_ids))
        if 1 <= slot <= len(weights)
    )
    if denominator == 0:
        # No reachable place has a positive weight; only the champion can win.
        pooled_weight = 100 if place <= 1 < place + len(player_ids) else 0
        denominator = 100
    amount = (
        pool_cents * pooled_weight
        // (denominator * len(player_ids) * 100)
    ) * 100
    return {player_id: amount for player_id in player_ids}


def _prize_summary(state: Dict[str, Any]) -> Dict[str, Optional[int]]:
    """Return the fixed start pool or a lobby projection without inventing history."""
    prize = state.get("prize")
    if isinstance(prize, dict):
        return {
            "entrant_count": prize.get("entrants"),
            "prize_pool_cents": prize.get("pool_cents"),
        }
    entrant_count = len(state.get("seats", []))
    if state.get("status") != "lobby":
        return {"entrant_count": entrant_count, "prize_pool_cents": None}
    buy_in = state.get("config", {}).get("buy_in", DEFAULT_BUY_IN)
    return {
        "entrant_count": entrant_count,
        "prize_pool_cents": buy_in * entrant_count * 100,
    }


def _standings_rows(state: Dict[str, Any]) -> List[Dict[str, Any]]:
    if state.get("status") == "completed" and state.get("results"):
        rows = []
        elimination = {item["player_id"]: item for item in state.get("elimination_order", [])}
        for result in state["results"]:
            item = elimination.get(result["player_id"], {})
            rows.append({
                "player_id": result["player_id"],
                "name": result["name"],
                "seat_no": item.get("seat_no", _seat_by_id(state, result["player_id"])["seat_no"] if _seat_by_id(state, result["player_id"]) else None),
                "chips": result.get("chips", 0),
                "status": "winner" if result.get("place") == 1 else "eliminated",
                "place": result.get("place"),
                "tied": bool(result.get("tied", item.get("tied", False))),
                "tie_count": result.get("tie_count", item.get("tie_count", 1)),
                "hand_no": item.get("hand_no"),
                **({"award_cents": result["award_cents"]} if "award_cents" in result else {}),
            })
        return rows

    elimination = {item["player_id"]: item for item in state.get("elimination_order", [])}
    hand = state.get("hand") or {}
    in_current_hand = set(hand.get("holes", {}))
    active = [
        seat for seat in _seats_in_order(state)
        if seat["player_id"] not in elimination
        and (seat["stack"] > 0 or seat["player_id"] in in_current_hand)
    ]
    active.sort(key=lambda seat: (-seat["stack"], seat["seat_no"]))
    rows = []
    last_stack = None
    stack_rank = 0
    for index, seat in enumerate(active, 1):
        if seat["stack"] != last_stack:
            stack_rank = index
            last_stack = seat["stack"]
        rows.append({
            "player_id": seat["player_id"],
            "name": seat["name"],
            "seat_no": seat["seat_no"],
            "chips": seat["stack"],
            "status": "active",
            "place": None,
            "stack_rank": stack_rank,
        })
    for item in sorted(
        state.get("elimination_order", []),
        key=lambda row: (row["place"], row.get("seat_no", 0)),
    ):
        rows.append({
            "player_id": item["player_id"],
            "name": item["name"],
            "seat_no": item.get("seat_no"),
            "chips": (_seat_by_id(state, item["player_id"]) or {}).get("stack", 0),
            "status": "eliminated",
            "place": item["place"],
            "tied": bool(item.get("tied", False)),
            "tie_count": item.get("tie_count", 1),
            "hand_no": item.get("hand_no"),
            **({"award_cents": item["award_cents"]} if "award_cents" in item else {}),
        })
    return rows


def _ordinal(number: int) -> str:
    if number % 100 in (11, 12, 13):
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(number % 10, "th")
    return "%d%s" % (number, suffix)


def _set_results(state: Dict[str, Any], winner_id: Optional[str], now: float) -> None:
    # Results and awards from completed games are historical records.
    if state.get("status") == "completed":
        return
    if winner_id is None:
        state["results"] = []
        return
    winner = _seat_by_id(state, winner_id)
    if winner is None:
        state["results"] = []
        return

    # A tournament may have been saved mid-game by an older engine version.
    # Recompute its elimination awards from the tie groups before finalizing, so
    # old cent splits do not survive beside the new whole-credit award rule.
    schedule = _prize_schedule(state)
    if schedule is not None:
        grouped_eliminations: Dict[int, List[Dict[str, Any]]] = {}
        for item in state.get("elimination_order", []):
            place = item.get("place")
            if type(place) is int and place >= 1:
                grouped_eliminations.setdefault(place, []).append(item)
        for place, group in grouped_eliminations.items():
            group_awards = _prize_awards_for_group(
                state, place, [item["player_id"] for item in group]
            )
            if group_awards is not None:
                for item in group:
                    item["award_cents"] = group_awards[item["player_id"]]

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
        result = {
            "player_id": item["player_id"],
            "name": item["name"],
            "place": item["place"],
            "chips": seat["stack"] if seat else 0,
            "tied": bool(item.get("tied", False)),
            "tie_count": item.get("tie_count", 1),
        }
        if "award_cents" in item:
            result["award_cents"] = item["award_cents"]
        results.append(result)

    if schedule is not None and winner is not None:
        pool_cents = schedule[0]
        eliminated_total = sum(
            result["award_cents"]
            for result in results
            if result.get("place") != 1
            and type(result.get("award_cents")) is int
            and result["award_cents"] >= 0
        )
        winner_result = next(result for result in results if result["player_id"] == winner_id)
        if eliminated_total <= pool_cents:
            # The champion receives all whole credits left after every other
            # finisher's exact tied-place share was floored.
            winner_result["award_cents"] = pool_cents - eliminated_total

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
    hand["bets"] = {player_id: 0 for player_id in hand.get("holes", {})}
    hand["current_bet"] = 0
    hand["runout_at"] = None
    eliminated = _record_eliminations(state, hand, now)
    remaining = [seat for seat in _seats_in_order(state) if seat["stack"] > 0]
    hand["street"] = "showdown"
    hand["to_act"] = None
    hand["turn_deadline"] = None
    hand["bot_action_at"] = None
    hand["presentation_version"] = 2

    # A contested showdown gets its own result window. An uncontested fold keeps
    # the short hand-complete pause before any elimination announcement.
    if hand.get("showdown"):
        duration = state["config"].get("showdown_seconds", SHOWDOWN_SECONDS)
        hand["showdown_started_at"] = now
        hand["showdown_until"] = now + duration
        hand["hand_complete_at"] = hand["showdown_until"]
    else:
        hand["showdown_started_at"] = None
        hand["showdown_until"] = None
        hand["hand_complete_at"] = now + HAND_COMPLETE_PAUSE_SECONDS
    hand["next_hand_at"] = hand["hand_complete_at"]
    hand["presentation_until"] = hand["hand_complete_at"]

    if eliminated:
        duration = state["config"].get(
            "elimination_announcement_seconds", ELIMINATION_ANNOUNCEMENT_SECONDS,
        )
        starts_at = hand["hand_complete_at"]
        state["elimination_announcement"] = (
            {
                "players": [
                    {
                        "name": item["name"],
                        "place": item["place"],
                        "tied": bool(item.get("tied", False)),
                        "tie_count": item.get("tie_count", 1),
                    }
                    for item in eliminated
                ],
                "starts_at": starts_at,
                "until": starts_at + duration,
            }
            if duration > 0 else None
        )
    else:
        state["elimination_announcement"] = None

    if len(remaining) > 1:
        _apply_due_blinds(state, now, not_before=hand["presentation_until"])
        _refresh_presentation_deadline(state, hand)
    else:
        _set_results(state, remaining[0]["player_id"] if remaining else None, now)
        _refresh_presentation_deadline(state, hand)
    _record_event(
        state, hand, "standings", hand_no=hand.get("number"),
        eliminated=[dict(item) for item in eliminated],
        standings=_standings_rows(state),
    )


def _award_without_showdown(
    state: Dict[str, Any],
    winner_id: Optional[str],
    now: float,
) -> None:
    hand = state["hand"]
    assert hand is not None
    payouts, pot_winnings, pots, returns = _allocate_pots(state, hand)
    pot_total = sum(hand["contrib"].values())
    hand["pot_winnings"] = pot_winnings
    hand["pots"] = pots
    hand["returns"] = returns
    if winner_id is not None:
        seat = _seat_by_id(state, winner_id)
        won = pot_winnings.get(winner_id, 0)
        if won:
            _log(state, "%s wins %d without showdown." % (seat["name"], won), now)
    _record_sweep(state, hand)
    _record_event(
        state,
        hand,
        "payout",
        street=hand.get("street"),
        pot_total=pot_total,
        payouts=dict(payouts),
        pot_winnings=dict(pot_winnings),
        pots=pots,
        winners=_winner_rows(state, pot_winnings),
        returns=returns,
        return_total=sum(item["amount"] for item in returns),
    )
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

    ranks = _showdown_ranks(hand)
    payouts, pot_winnings, pots, returns = _allocate_pots(state, hand, ranks)
    hand["pot_winnings"] = pot_winnings
    hand["pots"] = pots
    hand["returns"] = returns
    returned = {
        item["player_id"]: item["amount"]
        for item in returns
    }
    showdown = []
    for player_id in _hand_live_ids(hand):
        seat = _seat_by_id(state, player_id)
        rank = ranks[player_id]
        showdown.append(
            {
                "player_id": player_id,
                "name": seat["name"] if seat else "Player",
                "cards": list(hand["holes"][player_id]),
                "rank": _rank_description(rank),
                "hand_name": _hand_name(rank),
                "rank_value": list(rank),
                "payout": pot_winnings.get(player_id, 0),
                "returned": returned.get(player_id, 0),
                "total_credited": payouts.get(player_id, 0),
            }
        )
    hand["showdown"] = showdown
    _record_event(
        state,
        hand,
        "showdown_result",
        street=hand.get("street"),
        board=list(hand.get("board", [])),
        pot_total=sum(hand["contrib"].values()),
        payouts=dict(payouts),
        pot_winnings=dict(pot_winnings),
        pots=pots,
        winners=_winner_rows(state, pot_winnings, ranks),
        returns=returns,
        return_total=sum(item["amount"] for item in returns),
        showdown=list(showdown),
    )

    for player_id, amount in pot_winnings.items():
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
        for item in hand.get("revealed", []):
            showdown_cards[item["player_id"]] = list(item["cards"])

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
            "is_bot": bool(seat.get("is_bot", False)),
            "sitting_out": bool(seat.get("sitting_out", False)),
            "in_hand": in_hand,
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
    timestamp = time.time()
    paused = bool(state.get("paused", False))
    paused_at = state.get("paused_at") if paused else None
    frozen_for = max(0.0, timestamp - paused_at) if isinstance(paused_at, (int, float)) else 0.0

    def public_deadline(value):
        return value + frozen_for if value is not None else None

    next_level = blinds.get("next_level_at")
    next_level_view = public_deadline(next_level)
    seconds_to_next = max(0, int(math.ceil(next_level_view - timestamp))) if next_level_view is not None else None

    def public_announcement(key):
        announcement = state.get(key)
        if not isinstance(announcement, dict) or announcement.get("until") is None:
            return None
        until = public_deadline(announcement["until"])
        start_value = announcement.get("starts_at")
        starts_at = public_deadline(start_value) if start_value is not None else timestamp
        if until <= timestamp or starts_at > timestamp:
            return None
        result = dict(announcement)
        result["starts_at"] = starts_at
        result["until"] = until
        return result
    actor_id = hand["to_act"] if hand else None
    can_act = bool(
        hand
        and state["status"] == "playing"
        and not paused
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

    showdown_rows = [dict(item) for item in hand.get("showdown", [])] if hand else []
    hand_ranks = {
        item["player_id"]: {
            "rank": item.get("rank"),
            "hand_name": item.get("hand_name") or (
                item.get("rank", "").split(",", 1)[0] if isinstance(item.get("rank"), str) else None
            ),
        }
        for item in showdown_rows
        if item.get("player_id") and isinstance(item.get("rank"), str)
    }
    pot_winnings = dict(hand.get("pot_winnings", {})) if hand else {}
    winners = []
    for seat in _seats_in_order(state):
        amount = pot_winnings.get(seat["player_id"], 0)
        if type(amount) is not int or amount <= 0:
            continue
        winner = {
            "player_id": seat["player_id"],
            "name": seat["name"],
            "amount": amount,
        }
        rank = hand_ranks.get(seat["player_id"])
        if rank is not None:
            winner.update(rank)
        winners.append(winner)

    view = {
        "id": state["id"],
        "name": state["name"],
        "status": state["status"],
        "paused": paused,
        "paused_at": paused_at,
        "blind_announcement": public_announcement("blind_announcement"),
        "elimination_announcement": public_announcement("elimination_announcement"),
        "host_id": state["host_id"],
        "host_name": state["host_name"],
        "config": {
            "max_seats": state["config"]["max_seats"],
            "starting_stack": state["config"]["starting_stack"],
            "small_blind": state["config"]["small_blind"],
            "big_blind": state["config"]["big_blind"],
            "level_minutes": state["config"]["level_minutes"],
            "turn_seconds": state["config"]["turn_seconds"],
            "runout_seconds": state["config"].get("runout_seconds", RUNOUT_SECONDS),
            "blind_announcement_seconds": state["config"].get("blind_announcement_seconds", BLIND_ANNOUNCEMENT_SECONDS),
            "elimination_announcement_seconds": state["config"].get("elimination_announcement_seconds", ELIMINATION_ANNOUNCEMENT_SECONDS),
            "showdown_seconds": state["config"].get("showdown_seconds", SHOWDOWN_SECONDS),
            "buy_in": state["config"].get("buy_in", DEFAULT_BUY_IN),
            "payout_percentages": list(state["config"].get("payout_percentages", DEFAULT_PAYOUT_PERCENTAGES)),
        },
        "prize": (
            dict(state["prize"], payout_percentages=list(state["prize"].get("payout_percentages", [])))
            if isinstance(state.get("prize"), dict) else None
        ),
        "entrant_count": _prize_summary(state)["entrant_count"],
        "prize_pool_cents": _prize_summary(state)["prize_pool_cents"],
        "blinds": {
            "level": blinds["level"],
            "small": blinds["small"],
            "big": blinds["big"],
            "next_level_at": next_level_view,
            "seconds_to_next": seconds_to_next,
            "waiting_for_hand": state.get("status") == "playing" and next_level is None,
            "pending": bool(
                state.get("status") == "playing"
                and hand is not None
                and hand.get("street") != "showdown"
                and next_level_view is not None
                and timestamp >= next_level_view
            ),
        },
        "hand_blinds": (
            {
                "small": hand.get("small_blind", blinds["small"]),
                "big": hand.get("big_blind", blinds["big"]),
            }
            if hand else None
        ),
        "hand_no": state["hand_no"],
        "hand_id": _hand_id(state, hand) if hand else None,
        "event_seq": int(hand.get("event_seq", 0)) if hand else 0,
        "event_base_seq": int(hand.get("event_base_seq", 1)) if hand else 1,
        "events": [dict(event) for event in hand.get("events", [])] if hand else [],
        "street": hand["street"] if hand else "lobby",
        "board": list(hand["board"]) if hand else [],
        "pot": 0 if not hand or hand["street"] == "showdown" else sum(hand["contrib"].values()),
        "current_bet": hand["current_bet"] if hand else 0,
        "min_raise": hand["min_raise"] if hand else blinds["big"],
        "button_id": state["button_id"],
        "actor_id": actor_id,
        "turn_deadline": public_deadline(hand["turn_deadline"]) if hand else None,
        "server_now": timestamp,
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
        "showdown": showdown_rows,
        "hand_ranks": hand_ranks,
        "winners": winners,
        "pots": list(hand.get("pots", [])) if hand else [],
        "pot_winnings": pot_winnings,
        "payouts": dict(hand.get("payouts", {})) if hand else {},
        "returns": list(hand.get("returns", [])) if hand else [],
        "runout_odds": list(hand.get("runout_odds", [])) if hand else [],
        "runout_odds_street": hand.get("runout_odds_street") if hand else None,
        "runout_odds_board": list(hand.get("runout_odds_board", [])) if hand else [],
        "runout_odds_exact": hand.get("runout_odds_exact") if hand else None,
        "runout_odds_samples": hand.get("runout_odds_samples", 0) if hand else 0,
        "standings": _standings_rows(state),
        "next_hand_at": public_deadline(hand.get("next_hand_at")) if hand else None,
        "showdown_until": public_deadline(hand.get("showdown_until")) if hand else None,
        "presentation_until": public_deadline(hand.get("presentation_until")) if hand else None,
        "runout_at": public_deadline(hand.get("runout_at")) if hand else None,
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
        "paused": bool(state.get("paused", False)),
        "host_name": state["host_name"],
        "max_seats": state["config"]["max_seats"],
        "buy_in": state["config"].get("buy_in", DEFAULT_BUY_IN),
        "payout_percentages": list(state["config"].get("payout_percentages", DEFAULT_PAYOUT_PERCENTAGES)),
        "entrant_count": _prize_summary(state)["entrant_count"],
        "prize_pool_cents": _prize_summary(state)["prize_pool_cents"],
        "seated_count": len(state["seats"]),
        "blinds": {
            "level": blinds["level"],
            "small": blinds["small"],
            "big": blinds["big"],
        },
        "hand_no": state["hand_no"],
        "viewer_seated": bool(viewer_id and _seat_by_id(state, viewer_id)),
    }

