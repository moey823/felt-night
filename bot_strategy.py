"""PokerForBots-inspired no-limit Hold'em strategy for Felt Night.

A compact Python adaptation of the complex bot's range tables and decision
rules, not a GTO solver or a port of its runtime. It only receives the acting
player's cards and public table information; unknown cards are sampled without
access to the engine deck or opponents' hole cards.
"""
from __future__ import annotations

from functools import lru_cache
import random
from typing import Callable, Dict, Mapping, Optional, Sequence, Tuple

# Fixed sampling budget keeps decision cost predictable, even nine-way.
EQUITY_SAMPLES = 128

POSITION_BUTTON = 0
POSITION_CUTOFF = 1
POSITION_MIDDLE = 2
POSITION_EARLY = 3
POSITION_ANY = -1

_RANKS = "23456789TJQKA"
_RANK_VALUE = {rank: index + 2 for index, rank in enumerate(_RANKS)}
_SUITS = "shdc"
_DECK = tuple(rank + suit for rank in _RANKS for suit in _SUITS)
_STREETS = {"preflop": 0, "flop": 3, "turn": 4, "river": 5}
_CONTEXT_KEYS = frozenset({
    "street", "hole_cards", "board", "hero_seat", "button_seat", "players",
    "small_blind", "big_blind", "pot", "current_bet", "min_raise",
    "raise_allowed",
})
_PLAYER_KEYS = frozenset({"seat", "stack", "street_bet", "folded", "all_in"})

# Adapted range specifications from PokerForBots sdk/bots/complex/strategy.go.
_PREFLOP_RANGES = {
    (POSITION_BUTTON, "open_headsup"):
        "22+,A2+,K2+,Q2+,J4o+,T6o+,96o+,86o+,76o+,65o+,54o+,J2s+,T2s+,"
        "92s+,82s+,72s+,62s+,52s+,42s+,32s",
    (POSITION_CUTOFF, "defend_headsup"):
        "22+,A2+,K2+,Q5o+,J7o+,T7o+,97o+,87o+,Q2s+,J2s+,T4s+,95s+,"
        "85s+,74s+,64s+,53s+,43s",
    (POSITION_EARLY, "open"): "77+,AJo+,KQo,A5s+,KTs+,QTs+,JTs,T9s",
    (POSITION_MIDDLE, "open"):
        "55+,ATo+,KJo+,A2s+,K9s+,Q9s+,J9s+,T9s,98s,87s,76s",
    (POSITION_CUTOFF, "open"):
        "22+,A2+,K8o+,Q9o+,J9o+,T9o,K2s+,Q4s+,J7s+,T7s+,97s+,86s+,"
        "75s+,65s,54s",
    (POSITION_BUTTON, "open"):
        "22+,A2+,K5o+,Q8o+,J8o+,T8o+,98o,K2s+,Q2s+,J4s+,T6s+,96s+,"
        "85s+,74s+,64s+,53s+,43s",
    (POSITION_ANY, "3bet_value"): "TT+,AQs+,AKo",
    (POSITION_BUTTON, "3bet_bluff"):
        "A5s-A2s,K9s,K8s,QTs,JTs,T9s,98s,87s,76s,65s",
    (POSITION_CUTOFF, "3bet_bluff"): "A5s-A2s,KTs,K9s,QTs,JTs",
    (POSITION_ANY, "defend"): "99-22,AJs,KQs,QJs,JTs,T9s,98s,87s,76s",
    (POSITION_ANY, "4bet"): "QQ+,AK",
    (POSITION_ANY, "flat_trap"): "TT,JJ",
}


def _expand_token(token: str, hands: set) -> None:
    suffix = token[-1] if token and token[-1] in "so" else ""
    body = token[:-1] if suffix else token
    if len(body) != 2 or body[0] not in _RANK_VALUE or body[1] not in _RANK_VALUE:
        raise ValueError("invalid preflop range token")
    first, second = _RANK_VALUE[body[0]], _RANK_VALUE[body[1]]
    if first == second:
        if suffix:
            raise ValueError("paired range cannot have a suit suffix")
        hands.add((first, first, "p"))
    else:
        high, low = max(first, second), min(first, second)
        for kind in (suffix,) if suffix else ("s", "o"):
            hands.add((high, low, kind))


@lru_cache(maxsize=128)
def _expand_range(spec: str) -> frozenset:
    hands = set()
    for raw in spec.split(","):
        token = raw.strip()
        if not token:
            continue
        if "-" in token:
            start, end = token.split("-", 1)
            ss = start[-1] if start[-1] in "so" else ""
            es = end[-1] if end[-1] in "so" else ""
            sb, eb = (start[:-1] if ss else start), (end[:-1] if es else end)
            if len(sb) != 2 or len(eb) != 2 or ss != es:
                raise ValueError("invalid preflop range interval")
            if any(rank not in _RANK_VALUE for rank in sb + eb):
                raise ValueError("invalid preflop range interval")
            if sb[0] == sb[1] and eb[0] == eb[1] and not ss:
                lower = min(_RANK_VALUE[sb[0]], _RANK_VALUE[eb[0]])
                upper = max(_RANK_VALUE[sb[0]], _RANK_VALUE[eb[0]])
                hands.update((rank, rank, "p") for rank in range(lower, upper + 1))
                continue
            if sb[0] != eb[0]:
                raise ValueError("invalid preflop range interval")
            high = _RANK_VALUE[sb[0]]
            lo = min(_RANK_VALUE[sb[1]], _RANK_VALUE[eb[1]])
            hi = max(_RANK_VALUE[sb[1]], _RANK_VALUE[eb[1]])
            for low in range(lo, hi + 1):
                if low < high:
                    for kind in (ss,) if ss else ("s", "o"):
                        hands.add((high, low, kind))
        elif token.endswith("+"):
            base = token[:-1]
            suffix = base[-1] if base[-1] in "so" else ""
            body = base[:-1] if suffix else base
            if len(body) != 2 or body[0] not in _RANK_VALUE or body[1] not in _RANK_VALUE:
                raise ValueError("invalid preflop plus range")
            first, second = _RANK_VALUE[body[0]], _RANK_VALUE[body[1]]
            if first == second:
                if suffix:
                    raise ValueError("paired range cannot have a suit suffix")
                hands.update((rank, rank, "p") for rank in range(first, 15))
            else:
                high, low = max(first, second), min(first, second)
                for kicker in range(low, high):
                    for kind in (suffix,) if suffix else ("s", "o"):
                        hands.add((high, kicker, kind))
        else:
            _expand_token(token, hands)
    return frozenset(hands)


def _holding_class(hole: Sequence[str]) -> Tuple[int, int, str]:
    a, b = (_RANK_VALUE[card[0]] for card in hole)
    if a == b:
        return a, b, "p"
    return max(a, b), min(a, b), "s" if hole[0][1] == hole[1][1] else "o"


def _in_range(hole: Sequence[str], spec: Optional[str]) -> bool:
    return bool(spec) and _holding_class(hole) in _expand_range(spec)


def _int(value: object, label: str, minimum: int = 0, maximum: int = 9_000_000_000) -> int:
    if type(value) is not int or value < minimum or value > maximum:
        raise ValueError("%s must be a whole number in range" % label)
    return value


def _valid_card(card: object) -> bool:
    return isinstance(card, str) and len(card) == 2 and card[0] in _RANK_VALUE and card[1] in _SUITS


def _validate_context(context: object) -> Dict[str, object]:
    """Reject unknown/private fields so callers must pass the narrow contract."""
    if not isinstance(context, Mapping):
        raise ValueError("bot context must be a sanitized mapping")
    keys = set(context)
    if keys != _CONTEXT_KEYS:
        extra, missing = keys - _CONTEXT_KEYS, _CONTEXT_KEYS - keys
        field = sorted(extra or missing)[0]
        raise ValueError("unsupported or missing bot context field: %s" % field)
    street = context["street"]
    if street not in _STREETS:
        raise ValueError("invalid street")
    hole, board = context["hole_cards"], context["board"]
    if not isinstance(hole, (list, tuple)) or len(hole) != 2 or not all(_valid_card(c) for c in hole):
        raise ValueError("hole_cards must contain only the acting player's two cards")
    if (not isinstance(board, (list, tuple)) or len(board) != _STREETS[street] or
            not all(_valid_card(c) for c in board)):
        raise ValueError("board must match the public street")
    if len(set(hole) | set(board)) != len(hole) + len(board):
        raise ValueError("known cards must be unique")
    hero = _int(context["hero_seat"], "hero_seat")
    button = _int(context["button_seat"], "button_seat")
    if hero > 8 or button > 8:
        raise ValueError("seat number is out of range")
    raw_players = context["players"]
    if not isinstance(raw_players, (list, tuple)) or not 2 <= len(raw_players) <= 9:
        raise ValueError("players must contain two to nine dealt-in seats")
    players, seats = [], set()
    for row in raw_players:
        if not isinstance(row, Mapping) or set(row) != _PLAYER_KEYS:
            raise ValueError("player rows must contain only public seat summaries")
        seat = _int(row["seat"], "player seat")
        if seat > 8 or seat in seats:
            raise ValueError("player seats must be unique and in range")
        seats.add(seat)
        if type(row["folded"]) is not bool or type(row["all_in"]) is not bool:
            raise ValueError("folded and all_in must be booleans")
        players.append({
            "seat": seat, "stack": _int(row["stack"], "player stack"),
            "street_bet": _int(row["street_bet"], "street bet"),
            "folded": row["folded"], "all_in": row["all_in"],
        })
    if hero not in seats or button not in seats:
        raise ValueError("hero and button must be dealt-in seats")
    hero_row = next(p for p in players if p["seat"] == hero)
    if hero_row["folded"] or hero_row["stack"] <= 0:
        raise ValueError("acting seat must be live with chips")
    small = _int(context["small_blind"], "small_blind", 1, 1_000_000_000)
    _int(context["big_blind"], "big_blind", small, 1_000_000_000)
    current = _int(context["current_bet"], "current_bet")
    if any(p["street_bet"] > current for p in players):
        raise ValueError("street bets cannot exceed current_bet")
    if type(context["raise_allowed"]) is not bool:
        raise ValueError("raise_allowed must be boolean")
    return {
        "street": street, "hole_cards": tuple(hole), "board": tuple(board),
        "hero_seat": hero, "button_seat": button, "players": tuple(players),
        "small_blind": small, "big_blind": context["big_blind"],
        "pot": _int(context["pot"], "pot"), "current_bet": current,
        "min_raise": _int(context["min_raise"], "min_raise", 1),
        "raise_allowed": context["raise_allowed"],
    }


def _hero(ctx: Mapping[str, object]) -> Mapping[str, object]:
    return next(p for p in ctx["players"] if p["seat"] == ctx["hero_seat"])


def _live_count(ctx: Mapping[str, object]) -> int:
    return sum(not p["folded"] for p in ctx["players"])


def _position(ctx: Mapping[str, object], live_count: int) -> int:
    players = sorted(ctx["players"], key=lambda p: p["seat"])
    hero, button = ctx["hero_seat"], ctx["button_seat"]
    if live_count <= 2:
        return POSITION_BUTTON if hero == button else POSITION_CUTOFF
    seats = [p["seat"] for p in players]
    distance = (seats.index(hero) - seats.index(button)) % len(seats)
    count = len(seats)
    if distance == 0:
        return POSITION_BUTTON
    if distance == count - 1:
        return POSITION_CUTOFF
    if count <= 6 or distance >= count - 4:
        return POSITION_MIDDLE
    return POSITION_EARLY


def _range_for(position: int, action: str) -> Optional[str]:
    selected = POSITION_EARLY if position >= POSITION_EARLY else position
    return _PREFLOP_RANGES.get(
        (selected, action), _PREFLOP_RANGES.get((POSITION_ANY, action))
    )


def _to_call(ctx: Mapping[str, object]) -> int:
    return max(0, ctx["current_bet"] - _hero(ctx)["street_bet"])


def _max_total(ctx: Mapping[str, object]) -> int:
    hero = _hero(ctx)
    return hero["street_bet"] + hero["stack"]


def _raise_to(ctx: Mapping[str, object], desired: int) -> Optional[Tuple[str, Optional[int]]]:
    current, maximum = ctx["current_bet"], _max_total(ctx)
    if not ctx["raise_allowed"] or maximum <= current:
        return None
    minimum = current + ctx["min_raise"] if current else ctx["min_raise"]
    if maximum < minimum:
        return "all_in", None
    target = min(max(minimum, desired), maximum)
    if target <= current:
        return None
    if target == maximum:
        return "all_in", None
    return ("raise" if current else "bet"), target


def _preflop(ctx: Mapping[str, object], rng: random.Random) -> Tuple[str, Optional[int]]:
    hole, blind, to_call = ctx["hole_cards"], ctx["big_blind"], _to_call(ctx)
    position = _position(ctx, _live_count(ctx))
    heads_up = _live_count(ctx) <= 2
    open_range = _range_for(position, "open_headsup" if heads_up else "open")
    defend = _range_for(position, "defend_headsup" if heads_up else "defend")
    value_3bet = _range_for(position, "3bet_value")
    bluff_3bet = _range_for(position, "3bet_bluff")
    four_bet = _range_for(position, "4bet")
    minimum = ctx["current_bet"] + ctx["min_raise"] if ctx["current_bet"] else ctx["min_raise"]
    open_size = max(minimum, int(2.5 * blind))

    if to_call == 0:
        if ctx["raise_allowed"] and _in_range(hole, open_range):
            action = _raise_to(ctx, open_size)
            if action:
                return action
        return "check", None
    if to_call <= blind:
        if _in_range(hole, open_range):
            if ctx["raise_allowed"]:
                action = _raise_to(ctx, open_size)
                if action:
                    return action
            return "call", None
        return "fold", None

    in_position = position <= POSITION_CUTOFF
    if to_call <= 3 * blind:
        if _in_range(hole, value_3bet):
            if not ctx["raise_allowed"]:
                return "call", None
            desired = max(ctx["current_bet"] + ctx["min_raise"],
                          int((8.5 if in_position else 10.0) * blind))
            action = _raise_to(ctx, desired)
            if action:
                return action
            return "call", None
        if ctx["raise_allowed"] and _in_range(hole, bluff_3bet) and rng.random() < 0.25:
            desired = max(ctx["current_bet"] + ctx["min_raise"],
                          int((8.5 if in_position else 10.0) * blind))
            action = _raise_to(ctx, desired)
            if action:
                return action
        if _in_range(hole, defend):
            return "call", None
        return "fold", None

    if _in_range(hole, four_bet):
        if not ctx["raise_allowed"]:
            return "call", None
        spr = _hero(ctx)["stack"] / float(max(1, ctx["pot"]))
        if spr < 4.0 and _max_total(ctx) > ctx["current_bet"]:
            return "all_in", None
        desired = max(ctx["current_bet"] + ctx["min_raise"], int(22.0 * blind))
        action = _raise_to(ctx, desired)
        if action:
            return action
        return "call", None
    if in_position and _in_range(hole, _range_for(position, "flat_trap")):
        return "call", None
    return "fold", None


def _rank_counts(cards: Sequence[str]) -> Dict[int, int]:
    counts = {}
    for card in cards:
        rank = _RANK_VALUE[card[0]]
        counts[rank] = counts.get(rank, 0) + 1
    return counts


def _draw_profile(hole: Sequence[str], board: Sequence[str]) -> Tuple[bool, int]:
    if len(board) >= 5:
        return False, 0
    known = set(hole) | set(board)
    suited = {}
    for card in known:
        suited[card[1]] = suited.get(card[1], 0) + 1
    flush_outs = 0
    for suit, count in suited.items():
        if count == 4 and any(card[1] == suit for card in hole):
            flush_outs = sum(card not in known and card[1] == suit for card in _DECK)
            break
    hole_ranks = {_RANK_VALUE[c[0]] for c in hole}
    ranks = hole_ranks | {_RANK_VALUE[c[0]] for c in board}
    windows = [set(range(start, start + 5)) for start in range(2, 11)]
    windows.append({14, 2, 3, 4, 5})
    straight_ranks = set()
    for window in windows:
        missing = window - ranks
        if len(missing) == 1 and window & hole_ranks:
            straight_ranks.update(missing)
    straight_outs = sum(
        card not in known and _RANK_VALUE[card[0]] in straight_ranks for card in _DECK
    )
    return flush_outs >= 8 and straight_outs >= 4, max(flush_outs, straight_outs)


def _board_texture(board: Sequence[str]) -> str:
    suits = {}
    ranks = {_RANK_VALUE[c[0]] for c in board}
    for card in board:
        suits[card[1]] = suits.get(card[1], 0) + 1
    if 14 in ranks:
        ranks.add(1)
    suited = max(suits.values(), default=0)
    connected = max(
        (sum(start <= rank <= start + 4 for rank in ranks) for start in range(1, 11)),
        default=0,
    )
    if suited >= 3 or connected >= 4:
        return "very wet"
    if suited >= 2 and connected >= 3:
        return "wet"
    if suited >= 2 or connected >= 3:
        return "semi-wet"
    return "dry"


def _postflop_class(
    hole: Sequence[str], board: Sequence[str],
    rank_hand: Callable[[Sequence[str]], Tuple[int, ...]],
) -> str:
    rank = rank_hand(tuple(hole) + tuple(board))
    category = rank[0]
    board_rank = rank_hand(tuple(board)) if len(board) == 5 else None
    if board_rank is not None and rank <= board_rank:
        category = 0
    combo, outs = _draw_profile(hole, board)
    board_counts = _rank_counts(board)
    hole_ranks = {_RANK_VALUE[c[0]] for c in hole}
    if category >= 3:
        if category == 3 and board_counts.get(rank[1], 0) >= 3 and rank[1] not in hole_ranks:
            return "WeakPair"
        return "TripsPlus"
    if category == 2:
        board_pairs = sorted((r for r, n in board_counts.items() if n >= 2), reverse=True)
        if len(board_pairs) >= 2 and not hole_ranks.intersection(board_pairs[:2]):
            return "WeakPair"
        return "TwoPair"
    if category == 1:
        pair = rank[1]
        if board_counts.get(pair, 0) >= 2 and pair not in hole_ranks:
            return "WeakPair"
        top = max(_RANK_VALUE[c[0]] for c in board)
        if pair > top:
            return "TPTK"
        if pair == top and pair in hole_ranks:
            kicker = max((r for r in hole_ranks if r != pair), default=0)
            other_board = max(
                (_RANK_VALUE[c[0]] for c in board if _RANK_VALUE[c[0]] != pair),
                default=0,
            )
            top_kicker = 13 if pair == 14 else 14
            return "TPTK" if kicker >= top_kicker else "TopPair"
        return "WeakPair"
    if combo:
        return "ComboDraw"
    if outs >= 8:
        return "StrongDraw"
    if outs >= 4:
        return "WeakDraw"
    return "Air"


def _estimate_equity(
    ctx: Mapping[str, object],
    rank_hand: Callable[[Sequence[str]], Tuple[int, ...]],
    rng: random.Random,
) -> float:
    """Sample unseen opponent cards and runouts; ties receive fractional shares."""
    hero = ctx["hero_seat"]
    opponents = [p for p in ctx["players"] if p["seat"] != hero and not p["folded"]]
    if not opponents:
        return 1.0
    hole, board = ctx["hole_cards"], ctx["board"]
    known = set(hole) | set(board)
    deck = [card for card in _DECK if card not in known]
    runout_count = 5 - len(board)
    draw_count = runout_count + 2 * len(opponents)
    if draw_count > len(deck):
        return 1.0 / (len(opponents) + 1)
    share = 0.0
    for _ in range(EQUITY_SAMPLES):
        drawn = rng.sample(deck, draw_count)
        final_board = tuple(board) + tuple(drawn[:runout_count])
        ranks = [rank_hand(tuple(hole) + final_board)]
        offset = runout_count
        for _opponent in opponents:
            ranks.append(rank_hand(tuple(drawn[offset:offset + 2]) + final_board))
            offset += 2
        best = max(ranks)
        if ranks[0] == best:
            share += 1.0 / ranks.count(best)
    return share / EQUITY_SAMPLES


def _fold_threshold(street: str, bet_fraction: float) -> float:
    if street == "flop":
        return 0.15 if bet_fraction <= 0.33 else 0.35 if bet_fraction <= 0.66 else 0.50
    if street == "turn":
        return 0.30 if bet_fraction <= 0.50 else 0.50 if bet_fraction <= 1.0 else 0.60
    return 0.30 if bet_fraction <= 0.25 else 0.45 if bet_fraction <= 0.50 else 0.60


def _strength(equity: float) -> str:
    return "strong" if equity >= 0.75 else "medium" if equity >= 0.50 else "draw"


def _bet_fraction(street: str, texture: str, strength: str) -> float:
    if street == "flop":
        return {"dry": 0.33, "semi-wet": 0.50, "wet": 0.66, "very wet": 0.75}[texture]
    if street == "turn":
        return 0.66 if strength == "strong" else 0.50
    return {"strong": 1.00, "medium": 0.50, "draw": 0.75}[strength]


def _aggression(ctx: Mapping[str, object], fraction: float, raise_action: bool):
    pot, current = max(1, ctx["pot"]), ctx["current_bet"]
    desired = (
        current + max(ctx["min_raise"], int(pot * fraction))
        if raise_action and current
        else max(ctx["min_raise"], int(pot * fraction))
    )
    return _raise_to(ctx, desired)


def _unbeatable_board(board: Sequence[str], rank_hand: Callable[[Sequence[str]], Tuple[int, ...]]) -> bool:
    if len(board) != 5:
        return False
    rank = rank_hand(tuple(board))
    # A board royal flush is unbeatable. Board quads with an ace kicker also
    # fixes the best possible hand, so all live players share that rank.
    return (rank[0] == 8 and rank[1] == 14) or (rank[0] == 7 and rank[2] == 14)


def _postflop(
    ctx: Mapping[str, object], rank_hand: Callable[[Sequence[str]], Tuple[int, ...]],
    rng: random.Random,
) -> Tuple[str, Optional[int]]:
    to_call = _to_call(ctx)
    hero_stack = _hero(ctx)["stack"]
    call_cost = min(to_call, hero_stack)
    pot = max(1, ctx["pot"])
    equity = _estimate_equity(ctx, rank_hand, rng)
    if to_call:
        actual_odds = call_cost / float(pot + call_cost)
        if _unbeatable_board(ctx["board"], rank_hand):
            return ("call", None) if equity >= actual_odds else ("fold", None)
        required = max(actual_odds, _fold_threshold(ctx["street"], call_cost / float(pot)))
        if equity < required:
            return "fold", None

    multiway = _live_count(ctx) > 2
    spr = hero_stack / float(pot)
    hand_class = _postflop_class(ctx["hole_cards"], ctx["board"], rank_hand)
    if spr < 2.0 and equity > 0.60 and ctx["raise_allowed"] and _max_total(ctx) > ctx["current_bet"]:
        return "all_in", None

    if to_call == 0:
        if hand_class == "TripsPlus":
            fraction = 0.75 if multiway else 0.50
        elif hand_class == "TwoPair":
            if multiway:
                return "check", None
            fraction = 0.50
        elif hand_class == "TPTK":
            if spr > 8.0:
                return "check", None
            fraction = _bet_fraction(ctx["street"], _board_texture(ctx["board"]), _strength(equity))
        elif hand_class == "TopPair":
            if spr > 5.0:
                return "check", None
            fraction = _bet_fraction(ctx["street"], _board_texture(ctx["board"]), _strength(equity))
        elif hand_class == "ComboDraw":
            if multiway or spr > 8.0:
                return "check", None
            fraction = _bet_fraction(ctx["street"], _board_texture(ctx["board"]), "draw")
        elif hand_class == "StrongDraw":
            if multiway or spr > 5.0:
                return "check", None
            fraction = _bet_fraction(ctx["street"], _board_texture(ctx["board"]), "draw")
        else:
            return "check", None
        action = _aggression(ctx, fraction, False)
        return action if action else ("check", None)

    if hand_class == "TripsPlus":
        if multiway:
            return "call", None
        action = _aggression(ctx, 0.50, True)
        return action if action else ("call", None)
    if hand_class in ("TwoPair", "ComboDraw"):
        return "call", None
    if hand_class in ("TPTK", "TopPair"):
        return ("fold", None) if multiway else ("call", None)
    if hand_class == "StrongDraw":
        return ("fold", None) if multiway else ("call", None)
    if hand_class == "WeakPair":
        if call_cost <= pot * 0.12 and equity >= 1.25 * call_cost / float(pot + call_cost):
            return "call", None
    return "fold", None


def choose_action(
    context: Mapping[str, object],
    rank_hand: Callable[[Sequence[str]], Tuple[int, ...]],
    rng: Optional[random.Random] = None,
) -> Tuple[str, Optional[int]]:
    """Return engine action and amount; bet/raise amounts are raise-to totals."""
    if not callable(rank_hand):
        raise ValueError("rank_hand must be callable")
    ctx = _validate_context(context)
    generator = rng if rng is not None else random.Random()
    if ctx["street"] == "preflop":
        return _preflop(ctx, generator)
    return _postflop(ctx, rank_hand, generator)
