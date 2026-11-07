"""Durable, participant-private tournament and hand history storage."""
from __future__ import annotations

import json
from datetime import datetime, timezone


PAGE_SIZE = 20
MAX_PAGE_SIZE = 50
TERMINAL_STATUSES = frozenset({"completed", "ended", "cancelled", "expired"})


def _dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _loads(value, fallback):
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return fallback


def create_schema(conn):
    """Additive migration: leave all existing player/session/table rows intact."""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS tournament_history (
            table_id TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL,
            name TEXT NOT NULL,
            status TEXT NOT NULL,
            created REAL NOT NULL,
            started REAL,
            completed REAL,
            results_json TEXT NOT NULL DEFAULT '[]',
            standings_json TEXT NOT NULL DEFAULT '[]',
            config_json TEXT NOT NULL DEFAULT '{}',
            prize_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS tournament_history_created
            ON tournament_history(created DESC);
        CREATE TABLE IF NOT EXISTS hand_history (
            hand_id TEXT PRIMARY KEY,
            table_id TEXT NOT NULL REFERENCES tournament_history(table_id),
            number INTEGER NOT NULL,
            started REAL NOT NULL,
            ended REAL,
            street TEXT NOT NULL,
            board_json TEXT NOT NULL DEFAULT '[]',
            result_json TEXT NOT NULL DEFAULT '{}',
            events_complete INTEGER NOT NULL DEFAULT 1,
            events_coverage_start_seq INTEGER NOT NULL DEFAULT 1,
            small_blind INTEGER,
            big_blind INTEGER,
            blind_level INTEGER,
            button_player_id TEXT,
            UNIQUE(table_id, number)
        );
        CREATE INDEX IF NOT EXISTS hand_history_table_number
            ON hand_history(table_id, number);
        CREATE TABLE IF NOT EXISTS hand_history_events (
            hand_id TEXT NOT NULL REFERENCES hand_history(hand_id),
            seq INTEGER NOT NULL,
            payload_json TEXT NOT NULL,
            recorded_at REAL NOT NULL,
            PRIMARY KEY(hand_id, seq)
        );
        CREATE TABLE IF NOT EXISTS hand_history_players (
            hand_id TEXT NOT NULL REFERENCES hand_history(hand_id),
            player_id TEXT NOT NULL,
            name TEXT NOT NULL,
            seat_no INTEGER,
            is_bot INTEGER NOT NULL DEFAULT 0,
            cards_json TEXT NOT NULL DEFAULT '[]',
            revealed_cards_json TEXT,
            stack_before INTEGER,
            stack_after INTEGER,
            PRIMARY KEY(hand_id, player_id)
        );
        CREATE INDEX IF NOT EXISTS hand_history_players_player
            ON hand_history_players(player_id, hand_id);
        CREATE TABLE IF NOT EXISTS tournament_participants (
            table_id TEXT NOT NULL REFERENCES tournament_history(table_id),
            player_id TEXT NOT NULL,
            name TEXT NOT NULL,
            is_bot INTEGER NOT NULL DEFAULT 0,
            first_hand INTEGER NOT NULL,
            last_hand INTEGER NOT NULL,
            place INTEGER,
            award_cents INTEGER,
            rebuy_count INTEGER NOT NULL DEFAULT 0,
            buy_in_count INTEGER NOT NULL DEFAULT 1,
            total_buy_in_cents INTEGER,
            PRIMARY KEY(table_id, player_id)
        );
        CREATE INDEX IF NOT EXISTS tournament_participants_player
            ON tournament_participants(player_id, table_id);
    """)
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(hand_history)")}
    if "events_complete" not in columns:
        conn.execute("ALTER TABLE hand_history ADD COLUMN events_complete INTEGER NOT NULL DEFAULT 1")
    if "events_coverage_start_seq" not in columns:
        conn.execute("ALTER TABLE hand_history ADD COLUMN events_coverage_start_seq INTEGER NOT NULL DEFAULT 1")
    if "small_blind" not in columns:
        conn.execute("ALTER TABLE hand_history ADD COLUMN small_blind INTEGER")
    if "big_blind" not in columns:
        conn.execute("ALTER TABLE hand_history ADD COLUMN big_blind INTEGER")
    if "blind_level" not in columns:
        conn.execute("ALTER TABLE hand_history ADD COLUMN blind_level INTEGER")
    if "button_player_id" not in columns:
        conn.execute("ALTER TABLE hand_history ADD COLUMN button_player_id TEXT")
    tournament_columns = {row["name"] for row in conn.execute("PRAGMA table_info(tournament_history)")}
    if "config_json" not in tournament_columns:
        conn.execute("ALTER TABLE tournament_history ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}'")
    if "prize_json" not in tournament_columns:
        conn.execute("ALTER TABLE tournament_history ADD COLUMN prize_json TEXT NOT NULL DEFAULT '{}'")
    participant_columns = {row["name"] for row in conn.execute("PRAGMA table_info(tournament_participants)")}
    for column, declaration in (
        ("rebuy_count", "INTEGER NOT NULL DEFAULT 0"),
        ("buy_in_count", "INTEGER NOT NULL DEFAULT 1"),
        ("total_buy_in_cents", "INTEGER"),
    ):
        if column not in participant_columns:
            conn.execute("ALTER TABLE tournament_participants ADD COLUMN %s %s" % (column, declaration))


def backfill_tournaments(conn):
    """Create or refresh history snapshots from retained table state."""
    rows = conn.execute("SELECT id,owner_id,state,created,updated FROM tables").fetchall()
    for row in rows:
        try:
            state = json.loads(row["state"])
        except (TypeError, ValueError):
            continue
        conn.execute(
            """INSERT OR IGNORE INTO tournament_history
               (table_id,owner_id,name,status,created,started,completed,results_json,standings_json)
               VALUES(?,?,?,?,?,?,?,?,?)""",
            (
                row["id"], row["owner_id"], str(state.get("name") or "Tournament"),
                str(state.get("status") or "lobby"), float(row["created"]),
                state.get("started_at"), None,
                _dumps(state.get("results") or []), "[]",
            ),
        )
        sync_state(conn, state, float(row["updated"]))
        _backfill_hand_metadata(conn, row["id"], state.get("config") or {})


def _backfill_hand_metadata(conn, table_id, config):
    """Fill additive hand-header columns from saved events for older archives."""
    small = config.get("small_blind") if type(config.get("small_blind")) is int else None
    big = config.get("big_blind") if type(config.get("big_blind")) is int else None
    level = 1
    rows = conn.execute(
        "SELECT * FROM hand_history WHERE table_id=? ORDER BY number",
        (table_id,),
    ).fetchall()
    for row in rows:
        events = conn.execute(
            "SELECT payload_json FROM hand_history_events WHERE hand_id=? ORDER BY seq",
            (row["hand_id"],),
        ).fetchall()
        parsed = [_loads(item["payload_json"], {}) for item in events]
        parsed = [event for event in parsed if isinstance(event, dict)]
        if type(row["small_blind"]) is int:
            small = row["small_blind"]
        if type(row["big_blind"]) is int:
            big = row["big_blind"]
        if type(row["blind_level"]) is int:
            level = row["blind_level"]

        button_id = row["button_player_id"]
        if not button_id:
            small_blind_id = next((
                str(event.get("actor_id") or event.get("actor"))
                for event in parsed
                if event.get("type") == "action" and event.get("blind") == "small"
                and (event.get("actor_id") or event.get("actor"))
            ), None)
            seated = conn.execute(
                """SELECT player_id,seat_no FROM hand_history_players
                   WHERE hand_id=? AND seat_no IS NOT NULL ORDER BY seat_no""",
                (row["hand_id"],),
            ).fetchall()
            if small_blind_id and len(seated) == 2:
                button_id = small_blind_id
            elif small_blind_id and len(seated) > 2:
                small_index = next(
                    (index for index, item in enumerate(seated)
                     if item["player_id"] == small_blind_id),
                    None,
                )
                if small_index is not None:
                    button_id = seated[(small_index - 1) % len(seated)]["player_id"]

        conn.execute(
            """UPDATE hand_history SET
                 small_blind=COALESCE(small_blind,?),
                 big_blind=COALESCE(big_blind,?),
                 blind_level=COALESCE(blind_level,?),
                 button_player_id=COALESCE(button_player_id,?)
               WHERE hand_id=?""",
            (small, big, level, button_id, row["hand_id"]),
        )
        for event in parsed:
            if event.get("type") != "blind_level_updated":
                continue
            if type(event.get("small_blind")) is int:
                small = event["small_blind"]
            if type(event.get("big_blind")) is int:
                big = event["big_blind"]
            if type(event.get("level")) is int:
                level = event["level"]


def record_table_created(conn, state, owner_id, now):
    conn.execute(
        """INSERT INTO tournament_history
           (table_id,owner_id,name,status,created,started,completed,results_json,standings_json,config_json,prize_json)
           VALUES(?,?,?,?,?,?,NULL,'[]','[]',?,?)""",
        (
            state["id"], owner_id, state["name"], state["status"], now,
            state.get("started_at"), _dumps(state.get("config") or {}),
            _dumps(state.get("prize") or {}),
        ),
    )


def _public_reveals(hand):
    revealed = {}
    for item in hand.get("revealed", []):
        player_id = item.get("player_id")
        cards = item.get("cards")
        if player_id and isinstance(cards, list):
            revealed[player_id] = cards
    for event in hand.get("events", []):
        if event.get("type") == "reveal":
            items = event.get("hands", [])
        elif event.get("type") == "showdown_result":
            items = event.get("showdown", [])
        else:
            items = []
        for item in items:
            player_id = item.get("player_id")
            cards = item.get("cards")
            if player_id and isinstance(cards, list):
                revealed[player_id] = cards
    return revealed


def _hand_result(hand, state):
    standings = []
    for event in hand.get("events", []):
        if event.get("type") == "standings" and isinstance(event.get("standings"), list):
            standings = event["standings"]
    return {
        "showdown": hand.get("showdown", []),
        "payouts": hand.get("payouts", {}),
        "pot_winnings": hand.get("pot_winnings", {}),
        "pots": hand.get("pots", []),
        "returns": hand.get("returns", []),
        "standings": standings,
        "tournament_results": state.get("results", []),
    }


def _buyin_accounting(state, seat, result=None):
    seat = seat if isinstance(seat, dict) else {}
    result = result if isinstance(result, dict) else {}
    rebuy_count = result.get("rebuy_count", seat.get("rebuy_count", 0))
    if type(rebuy_count) is not int or rebuy_count < 0:
        rebuy_count = 0
    buy_in_count = result.get("buy_in_count", seat.get("buy_in_count"))
    if type(buy_in_count) is not int or buy_in_count < 0:
        buy_in_count = 0 if state.get("status") == "lobby" else rebuy_count + 1
    total = result.get("total_buy_in_cents")
    if type(total) is not int or total < 0:
        total = seat.get("total_buy_in_cents")
    if type(total) is not int or total < 0:
        if state.get("status") == "lobby":
            total = 0
        else:
            prize = state.get("prize")
            buy_in = prize.get("buy_in") if isinstance(prize, dict) else None
            total = buy_in * 100 * max(1, buy_in_count) if type(buy_in) is int and buy_in >= 0 else None
    return rebuy_count, buy_in_count, total


def sync_state(conn, state, now):
    """Persist the current tournament snapshot and append any new hand events."""
    table_id = state.get("id")
    if not table_id:
        return
    created = float(state.get("created_at") or now)
    started = state.get("started_at")
    completed = now if state.get("status") == "completed" else None
    conn.execute(
        """INSERT INTO tournament_history
           (table_id,owner_id,name,status,created,started,completed,results_json,standings_json,config_json,prize_json)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(table_id) DO UPDATE SET
             name=excluded.name,
             status=excluded.status,
             started=COALESCE(tournament_history.started,excluded.started),
             completed=COALESCE(tournament_history.completed,excluded.completed),
             results_json=excluded.results_json,
             standings_json=excluded.standings_json,
             config_json=excluded.config_json,
             prize_json=excluded.prize_json""",
        (
            table_id, state.get("host_id", ""), str(state.get("name") or "Tournament"),
            str(state.get("status") or "lobby"), created, started, completed,
            _dumps(state.get("results") or []),
            _dumps(_standings(state)), _dumps(state.get("config") or {}),
            _dumps(state.get("prize") or {}),
        ),
    )
    current_hand_no = state.get("hand_no")
    if type(current_hand_no) is int and current_hand_no > 0:
        for seat in state.get("seats", []):
            if not isinstance(seat, dict) or not seat.get("player_id"):
                continue
            rebuy_count, buy_in_count, total_buy_in_cents = _buyin_accounting(state, seat)
            _record_participant(
                conn, table_id, str(seat["player_id"]),
                str(seat.get("name") or "Player"), bool(seat.get("is_bot", False)),
                current_hand_no, now,
                rebuy_count=rebuy_count,
                buy_in_count=buy_in_count,
                total_buy_in_cents=total_buy_in_cents,
            )

    hand = state.get("hand")
    if not isinstance(hand, dict) or not hand.get("number"):
        return
    number = int(hand["number"])
    hand_id = str(hand.get("hand_id") or "%s:%d" % (table_id, number))
    ended = now if hand.get("street") == "showdown" else None
    board = hand.get("board") if isinstance(hand.get("board"), list) else []
    conn.execute(
        """INSERT INTO hand_history
           (hand_id,table_id,number,started,ended,street,board_json,result_json,
            small_blind,big_blind,blind_level,button_player_id)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(hand_id) DO UPDATE SET
             ended=COALESCE(hand_history.ended,excluded.ended),
             street=excluded.street,
             board_json=excluded.board_json,
             result_json=excluded.result_json,
             small_blind=COALESCE(hand_history.small_blind,excluded.small_blind),
             big_blind=COALESCE(hand_history.big_blind,excluded.big_blind),
             blind_level=COALESCE(hand_history.blind_level,excluded.blind_level),
             button_player_id=COALESCE(hand_history.button_player_id,excluded.button_player_id)""",
        (
            hand_id, table_id, number,
            float(hand.get("started_at") or now), ended,
            str(hand.get("street") or "preflop"), _dumps(board),
            _dumps(_hand_result(hand, state)),
            hand.get("small_blind", state.get("blinds", {}).get("small")),
            hand.get("big_blind", state.get("blinds", {}).get("big")),
            hand.get("blind_level"), hand.get("button_id"),
        ),
    )
    events = hand.get("events", [])
    for event in events if isinstance(events, list) else []:
        if not isinstance(event, dict):
            continue
        seq = event.get("seq")
        if type(seq) is not int or seq < 1:
            continue
        conn.execute(
            """INSERT OR IGNORE INTO hand_history_events
               (hand_id,seq,payload_json,recorded_at) VALUES(?,?,?,?)""",
            (hand_id, seq, _dumps(event), now),
        )
    event_seq = max(0, int(hand.get("event_seq", 0)))
    coverage = conn.execute(
        """SELECT COUNT(*) AS n,MIN(seq) AS first,MAX(seq) AS last
           FROM hand_history_events WHERE hand_id=?""",
        (hand_id,),
    ).fetchone()
    events_complete = (
        event_seq == 0 or (
            coverage["n"] == event_seq and coverage["first"] == 1
            and coverage["last"] == event_seq
        )
    )
    coverage_start = coverage["first"]
    if coverage_start is None:
        coverage_start = int(hand.get("event_base_seq", 1) or 1)
    conn.execute(
        """UPDATE hand_history SET events_complete=?,events_coverage_start_seq=?
           WHERE hand_id=?""",
        (int(events_complete), int(coverage_start), hand_id),
    )

    seats = {seat.get("player_id"): seat for seat in state.get("seats", [])
             if isinstance(seat, dict) and seat.get("player_id")}
    holes = hand.get("holes", {})
    if not isinstance(holes, dict):
        holes = {}
    reveals = _public_reveals(hand)
    for player_id, cards in holes.items():
        seat = seats.get(player_id, {})
        name = str(seat.get("name") or "Player")
        seat_no = seat.get("seat_no")
        is_bot = int(bool(seat.get("is_bot", False)))
        before = hand.get("stack_before", {}).get(player_id)
        after = seat.get("stack") if ended is not None else None
        revealed_json = _dumps(reveals[player_id]) if player_id in reveals else None
        rebuy_count, buy_in_count, total_buy_in_cents = _buyin_accounting(state, seat)
        _record_participant(
            conn, table_id, str(player_id), name, is_bot, number, now,
            rebuy_count=rebuy_count,
            buy_in_count=buy_in_count,
            total_buy_in_cents=total_buy_in_cents,
        )
        conn.execute(
            """INSERT INTO hand_history_players
               (hand_id,player_id,name,seat_no,is_bot,cards_json,revealed_cards_json,stack_before,stack_after)
               VALUES(?,?,?,?,?,?,?,?,?)
               ON CONFLICT(hand_id,player_id) DO UPDATE SET
                 name=excluded.name,
                 seat_no=excluded.seat_no,
                 is_bot=excluded.is_bot,
                 cards_json=excluded.cards_json,
                 revealed_cards_json=COALESCE(excluded.revealed_cards_json,hand_history_players.revealed_cards_json),
                 stack_before=COALESCE(hand_history_players.stack_before,excluded.stack_before),
                 stack_after=COALESCE(hand_history_players.stack_after,excluded.stack_after)""",
            (
                hand_id, str(player_id), name, seat_no, is_bot, _dumps(cards),
                revealed_json, before, after,
            ),
        )
    for item in state.get("elimination_order", []):
        if not isinstance(item, dict) or not item.get("player_id"):
            continue
        seat = seats.get(item["player_id"], {})
        rebuy_count, buy_in_count, total_buy_in_cents = _buyin_accounting(state, seat, item)
        _record_participant(
            conn, table_id, str(item["player_id"]),
            str(item.get("name") or seat.get("name") or "Player"),
            bool(seat.get("is_bot", False)),
            int(item.get("hand_no") or number), now,
            place=item.get("place"),
            rebuy_count=rebuy_count,
            buy_in_count=buy_in_count,
            total_buy_in_cents=total_buy_in_cents,
        )
    for item in state.get("results", []):
        if not isinstance(item, dict) or not item.get("player_id"):
            continue
        seat = seats.get(item["player_id"], {})
        eliminated = next(
            (row for row in state.get("elimination_order", [])
             if row.get("player_id") == item["player_id"]),
            {},
        )
        rebuy_count, buy_in_count, total_buy_in_cents = _buyin_accounting(state, seat, item)
        _record_participant(
            conn, table_id, str(item["player_id"]),
            str(item.get("name") or seat.get("name") or "Player"),
            bool(seat.get("is_bot", False)),
            int(eliminated.get("hand_no") or number), now,
            place=item.get("place"), award_cents=item.get("award_cents"),
            rebuy_count=rebuy_count,
            buy_in_count=buy_in_count,
            total_buy_in_cents=total_buy_in_cents,
        )

    if state.get("status") != "completed":
        for seat in state.get("seats", []):
            if (not isinstance(seat, dict) or not seat.get("player_id")
                    or int(seat.get("rebuy_count", 0)) < 1 or seat.get("stack", 0) <= 0):
                continue
            conn.execute(
                """UPDATE tournament_participants
                   SET place=NULL,award_cents=NULL
                   WHERE table_id=? AND player_id=?""",
                (table_id, str(seat["player_id"])),
            )


def _record_participant(conn, table_id, player_id, name, is_bot, hand_no, now,
                        place=None, award_cents=None, rebuy_count=0,
                        buy_in_count=1, total_buy_in_cents=None):
    conn.execute(
        """INSERT INTO tournament_participants
           (table_id,player_id,name,is_bot,first_hand,last_hand,place,award_cents,
            rebuy_count,buy_in_count,total_buy_in_cents)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(table_id,player_id) DO UPDATE SET
             name=excluded.name,
             is_bot=excluded.is_bot,
             first_hand=MIN(tournament_participants.first_hand,excluded.first_hand),
             last_hand=MAX(tournament_participants.last_hand,excluded.last_hand),
             place=COALESCE(excluded.place,tournament_participants.place),
             award_cents=COALESCE(excluded.award_cents,tournament_participants.award_cents),
             rebuy_count=excluded.rebuy_count,
             buy_in_count=excluded.buy_in_count,
             total_buy_in_cents=COALESCE(excluded.total_buy_in_cents,tournament_participants.total_buy_in_cents)""",
        (table_id, player_id, name, int(bool(is_bot)), hand_no, hand_no,
         place, award_cents, rebuy_count, buy_in_count, total_buy_in_cents),
    )


def _standings(state):
    try:
        import engine
        return engine._standings_rows(state)
    except (AttributeError, KeyError, TypeError):
        return state.get("results", []) or []


def _participants(conn, table_id):
    rows = conn.execute(
        """SELECT player_id,name,is_bot,first_hand,last_hand,place,award_cents,
                  rebuy_count,buy_in_count,total_buy_in_cents
           FROM tournament_participants WHERE table_id=?
           ORDER BY first_hand,player_id""",
        (table_id,),
    ).fetchall()
    return [{
        "player_id": row["player_id"],
        "name": row["name"],
        "is_bot": bool(row["is_bot"]),
        "first_hand": row["first_hand"],
        "last_hand": row["last_hand"],
        "place": row["place"],
        "award_cents": row["award_cents"],
        "rebuy_count": row["rebuy_count"],
        "buy_in_count": row["buy_in_count"],
        "total_buy_in_cents": row["total_buy_in_cents"],
    } for row in rows]


def _history_text_atom(value, fallback="Unknown"):
    text = " ".join(str(value if value is not None else "").replace("\r", " ").replace("\n", " ").split())
    return text[:180] or fallback


def _history_timestamp(value):
    if type(value) not in (int, float):
        return "time unavailable"
    try:
        return datetime.fromtimestamp(value, timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    except (OverflowError, OSError, ValueError):
        return "time unavailable"


def _credit_amount(cents):
    if type(cents) is not int or cents < 0:
        return None
    whole, remainder = divmod(cents, 100)
    return str(whole) if remainder == 0 else "%d.%02d" % (whole, remainder)


def format_tournament_summary(tournament):
    """Format saved tournament facts as a plain-text Felt Night summary."""
    tournament = tournament if isinstance(tournament, dict) else {}
    config = tournament.get("config") if isinstance(tournament.get("config"), dict) else {}
    prize = tournament.get("prize") if isinstance(tournament.get("prize"), dict) else {}
    participants = tournament.get("participants") if isinstance(tournament.get("participants"), list) else []
    status = str(tournament.get("status") or "unknown")
    statuses = {
        "completed": "Completed",
        "ended": "Ended early",
        "cancelled": "Cancelled",
        "expired": "Expired",
        "playing": "In progress",
        "lobby": "Lobby",
    }
    lines = [
        "Felt Night Tournament Summary",
        "Tournament: " + _history_text_atom(tournament.get("name"), "Tournament"),
        "Status: " + statuses.get(status, _history_text_atom(status)),
    ]
    started = tournament.get("started")
    if started is not None:
        lines.append("Started: " + _history_timestamp(started))
    elif tournament.get("created") is not None:
        lines.append("Created: " + _history_timestamp(tournament.get("created")))
    if isinstance(config.get("buy_in"), int) and type(config.get("buy_in")) is int:
        lines.append("Buy-in: $%s" % config["buy_in"])
    entrants = prize.get("entrants") if type(prize.get("entrants")) is int else len(participants)
    if entrants > 0:
        lines.append("Entrants: %d" % entrants)
    buy_ins = prize.get("buy_ins")
    rebuys = prize.get("rebuys", 0)
    if type(buy_ins) is int:
        lines.append("Total buy-ins: %d (rebuys: %d)" % (buy_ins, rebuys if type(rebuys) is int else 0))
    if type(prize.get("pool_cents")) is int:
        pool = _credit_amount(prize["pool_cents"])
        if pool is not None:
            lines.append("Prize pool: $%s" % pool)
    small = config.get("small_blind")
    big = config.get("big_blind")
    if type(small) is int and type(big) is int:
        lines.append("Starting blinds: %d/%d" % (small, big))
    if type(config.get("starting_stack")) is int:
        lines.append("Starting stack: %d chips" % config["starting_stack"])
    percentages = config.get("payout_percentages")
    if isinstance(percentages, list) and percentages and all(type(value) is int for value in percentages):
        lines.append("Payout shares: " + " / ".join("%d%%" % value for value in percentages))
    hand_count = tournament.get("hand_count")
    if type(hand_count) is int:
        lines.append("Saved hands: %d" % hand_count)

    results = tournament.get("results") if isinstance(tournament.get("results"), list) else []
    standings = tournament.get("standings") if isinstance(tournament.get("standings"), list) else []
    rows = results or standings
    if rows:
        heading = "Final standings" if status == "completed" and results else (
            "Standings when the game ended" if status in TERMINAL_STATUSES else "Current standings"
        )
        lines.extend(["", heading + ":"])
        for row in rows:
            if not isinstance(row, dict):
                continue
            place = row.get("place")
            if type(place) is int and place > 0:
                prefix = ("T-" if row.get("tied") else "") + str(place) + ". "
            elif row.get("status") == "active":
                prefix = "Active: "
            else:
                prefix = ""
            item = prefix + _history_text_atom(row.get("name"), "Player")
            if type(row.get("chips")) is int and row["chips"] >= 0:
                item += " — %d chips" % row["chips"]
            award = _credit_amount(row.get("award_cents"))
            if award is not None:
                item += " — $%s" % award
            rebuys = row.get("rebuy_count")
            total_buy_in = _credit_amount(row.get("total_buy_in_cents"))
            if type(rebuys) is int:
                item += " — %d rebuys" % rebuys
            if total_buy_in is not None:
                item += " — total buy-in $%s" % total_buy_in
            lines.append(item)
    if status in TERMINAL_STATUSES and status != "completed" and not results:
        lines.extend(["", "No final result was declared."])
    return "\n".join(lines)


def format_hand_history(tournament, hand, viewer_player_id=None):
    """Format a sanitized saved hand as readable, plain-text history."""
    tournament = tournament if isinstance(tournament, dict) else {}
    hand = hand if isinstance(hand, dict) else {}
    players = hand.get("players") if isinstance(hand.get("players"), list) else []
    by_id = {str(player.get("player_id")): player for player in players if isinstance(player, dict)}
    number = hand.get("number") if type(hand.get("number")) is int else "?"
    small, big = hand.get("small_blind"), hand.get("big_blind")
    stake = "%s/%s" % (small, big) if type(small) is int and type(big) is int else "blinds unavailable"
    lines = [
        "Felt Night Hand #%s: No-Limit Texas Hold'em (%s chips) - %s" % (
            number, stake, _history_timestamp(hand.get("started")),
        ),
        "Tournament: " + _history_text_atom(tournament.get("name"), "Tournament"),
    ]
    button_id = hand.get("button_player_id")
    button = by_id.get(str(button_id)) if button_id else None
    if button is not None and type(button.get("seat_no")) is int:
        table_line = "Table: %s — Seat #%d is the button" % (
            _history_text_atom(tournament.get("name"), "Tournament"), button["seat_no"] + 1,
        )
    else:
        table_line = "Table: " + _history_text_atom(tournament.get("name"), "Tournament")
    lines.append(table_line)
    if type(hand.get("blind_level")) is int:
        lines.append("Blind level %d (%s)" % (hand["blind_level"], stake))
    elif stake != "blinds unavailable":
        lines.append("Blinds: %s" % stake)

    action_events = [event for event in hand.get("events", []) if isinstance(event, dict)]
    blind_roles = {}
    for event in action_events:
        if event.get("type") == "action" and event.get("blind") in ("small", "big"):
            actor_id = event.get("actor_id") or event.get("actor")
            if actor_id:
                blind_roles[str(actor_id)] = event.get("blind")
    lines.append("")
    lines.append("*** TABLE SEATS ***")
    for player in sorted(
        players,
        key=lambda item: (item.get("seat_no") is None, item.get("seat_no") if type(item.get("seat_no")) is int else 0, str(item.get("name") or "").casefold()),
    ):
        name = _history_text_atom(player.get("name"), "Player")
        player_id = str(player.get("player_id") or "")
        role = []
        if player_id == str(button_id or ""):
            role.append("button")
        if blind_roles.get(player_id) == "small":
            role.append("small blind")
        elif blind_roles.get(player_id) == "big":
            role.append("big blind")
        seat_no = player.get("seat_no")
        seat = "Seat %d" % (seat_no + 1) if type(seat_no) is int else "Seat unknown"
        role_text = " (" + ", ".join(role) + ")" if role else ""
        stack = player.get("stack_before")
        stack_text = " (%d chips)" % stack if type(stack) is int and stack >= 0 else ""
        lines.append("%s: %s%s%s" % (seat, name, role_text, stack_text))

    lines.extend(["", "*** HOLE CARDS ***"])
    for player in players:
        player_id = str(player.get("player_id") or "")
        cards = _safe_card_list(player.get("cards"), (2,))
        if player_id == str(viewer_player_id or "") and cards:
            lines.append("Dealt to %s %s" % (_history_text_atom(player.get("name"), "Player"), "[" + " ".join(cards) + "]"))

    street_labels = {
        "preflop": "PRE-FLOP",
        "flop": "FLOP",
        "turn": "TURN",
        "river": "RIVER",
        "showdown": "SHOWDOWN",
    }
    current_street = "preflop"
    announced_streets = {"preflop"}
    lines.extend(["", "*** PRE-FLOP ***"])
    for event in sorted(action_events, key=lambda item: item.get("seq") if type(item.get("seq")) is int else 0):
        event_type = event.get("type")
        street = str(event.get("street") or current_street).lower()
        if event_type == "street":
            current_street = street
            if street not in announced_streets:
                board = _safe_card_list(event.get("board"), (0, 3, 4, 5))
                board_text = " [" + " ".join(board) + "]" if board else ""
                lines.extend(["", "*** %s ***%s" % (street_labels.get(street, "STREET"), board_text)])
                announced_streets.add(street)
            continue
        if event_type != "action":
            continue
        current_street = street
        if street not in announced_streets:
            lines.extend(["", "*** %s ***" % street_labels.get(street, "STREET")])
            announced_streets.add(street)
        actor_id = str(event.get("actor_id") or event.get("actor") or "")
        player = by_id.get(actor_id, {})
        name = _history_text_atom(player.get("name") or event.get("actor_label"), "Player")
        amount = event.get("amount") if type(event.get("amount")) is int and event.get("amount") >= 0 else None
        target = event.get("target") if type(event.get("target")) is int and event.get("target") >= 0 else None
        action = str(event.get("action") or "action").lower()
        if event.get("blind") in ("small", "big"):
            label = "small blind" if event["blind"] == "small" else "big blind"
            posted = amount if amount is not None else "amount unavailable"
            line = "%s: posts %s %s" % (name, label, posted)
            nominal = small if event["blind"] == "small" else big
            if type(nominal) is int and type(posted) is int and posted < nominal:
                line += " (all-in)"
        elif action == "fold":
            line = name + ": folds"
        elif action == "check":
            line = name + ": checks"
        elif action == "call":
            line = "%s: calls %s" % (name, amount if amount is not None else "an unavailable amount")
        elif action == "bet":
            line = "%s: bets %s" % (name, target if target is not None else amount if amount is not None else "an unavailable amount")
        elif action == "raise":
            line = "%s: raises to %s" % (name, target if target is not None else "an unavailable amount")
        elif action == "all-in":
            line = "%s: is all-in for %s" % (name, amount if amount is not None else "an unavailable amount")
        else:
            line = name + ": acts"
        if event.get("timed_out"):
            line += " (time-out)"
        elif event.get("sitting_out"):
            line += " (sitting out)"
        lines.append(line)

    result = hand.get("result") if isinstance(hand.get("result"), dict) else {}
    board = _safe_card_list(hand.get("board"), (0, 3, 4, 5))
    lines.extend(["", "*** SUMMARY ***"])
    pots = result.get("pots") if isinstance(result.get("pots"), list) else []
    for index, pot in enumerate(pots):
        if not isinstance(pot, dict) or type(pot.get("amount")) is not int:
            continue
        label = _history_text_atom(pot.get("label"), "Main pot" if index == 0 else "Side pot %d" % index)
        lines.append("%s: %d chips" % (label, pot["amount"]))
    if board and not any(event.get("type") == "street" for event in action_events):
        lines.append("Board: [" + " ".join(board) + "]")
    for player in players:
        if not player.get("revealed"):
            continue
        cards = _safe_card_list(player.get("cards"), (2,))
        if cards:
            lines.append("%s showed [%s]" % (
                _history_text_atom(player.get("name"), "Player"), " ".join(cards),
            ))
    showdown = result.get("showdown") if isinstance(result.get("showdown"), list) else []
    ranks = {
        str(item.get("player_id")): _history_text_atom(item.get("hand_name"), "")
        for item in showdown if isinstance(item, dict) and item.get("player_id") and item.get("hand_name")
    }
    winnings = result.get("pot_winnings") if isinstance(result.get("pot_winnings"), dict) else {}
    winners = [
        (player_id, amount) for player_id, amount in winnings.items()
        if isinstance(player_id, str) and type(amount) is int and amount > 0
    ]
    for player_id, amount in sorted(winners, key=lambda item: by_id.get(item[0], {}).get("name", "").casefold()):
        name = _history_text_atom(by_id.get(player_id, {}).get("name"), "Player")
        line = "%s collected %d chips" % (name, amount)
        if ranks.get(player_id):
            line += " with " + ranks[player_id]
        elif not showdown:
            line += " without showdown"
        lines.append(line)
    returns = result.get("returns") if isinstance(result.get("returns"), list) else []
    for item in returns:
        if not isinstance(item, dict) or type(item.get("amount")) is not int or item["amount"] <= 0:
            continue
        player = by_id.get(str(item.get("player_id") or ""), {})
        lines.append("Uncalled bet of %d chips returned to %s" % (
            item["amount"], _history_text_atom(player.get("name"), "Player"),
        ))
    if not hand.get("events_complete", True):
        lines.append("Some earlier actions were not retained for this hand.")
    if hand.get("ended") is None:
        lines.append("No result recorded; this hand was still active when history was saved.")
    elif not winners and not pots:
        lines.append("No pot result was recorded.")
    return "\n".join(lines)


def _summary(conn, row):
    table_id = row["table_id"]
    hand_count = conn.execute(
        "SELECT COUNT(*) AS n FROM hand_history WHERE table_id=?", (table_id,),
    ).fetchone()["n"]
    summary = {
        "id": table_id,
        "name": row["name"],
        "status": row["status"],
        "created": row["created"],
        "started": row["started"],
        "completed": row["completed"],
        "results": _loads(row["results_json"], []),
        "standings": _loads(row["standings_json"], []),
        "participants": _participants(conn, table_id),
        "hand_count": hand_count,
        "config": _loads(row["config_json"], {}),
        "prize": _loads(row["prize_json"], {}),
    }
    summary["summary_text"] = format_tournament_summary(summary)
    return summary


def list_for_player(conn, player_id, offset=0, limit=PAGE_SIZE):
    limit = min(MAX_PAGE_SIZE, max(1, int(limit)))
    offset = max(0, int(offset))
    total = conn.execute(
        """SELECT COUNT(*) AS n FROM tournament_history t
           WHERE EXISTS (
             SELECT 1 FROM tournament_participants p
             WHERE p.table_id=t.table_id AND p.player_id=? AND p.is_bot=0
           )""",
        (player_id,),
    ).fetchone()["n"]
    rows = conn.execute(
        """SELECT t.* FROM tournament_history t
           WHERE EXISTS (
             SELECT 1 FROM tournament_participants p
             WHERE p.table_id=t.table_id AND p.player_id=? AND p.is_bot=0
           )
           ORDER BY COALESCE(t.completed,t.started,t.created) DESC
           LIMIT ? OFFSET ?""",
        (player_id, limit, offset),
    ).fetchall()
    tournaments = [_summary(conn, row) for row in rows]
    end = offset + len(tournaments)
    return {
        "tournaments": tournaments,
        "next_offset": end if end < total else None,
    }


def list_for_admin(conn, offset=0, limit=PAGE_SIZE):
    """List terminal saved games for the room admin."""
    limit = min(MAX_PAGE_SIZE, max(1, int(limit)))
    offset = max(0, int(offset))
    statuses = tuple(sorted(TERMINAL_STATUSES))
    placeholders = ",".join("?" for _ in statuses)
    where = "status IN (" + placeholders + ")"
    total = conn.execute(
        "SELECT COUNT(*) AS n FROM tournament_history WHERE " + where,
        statuses,
    ).fetchone()["n"]
    rows = conn.execute(
        "SELECT * FROM tournament_history WHERE " + where +
        " ORDER BY COALESCE(completed,started,created) DESC,table_id DESC LIMIT ? OFFSET ?",
        statuses + (limit, offset),
    ).fetchall()
    tournaments = [_summary(conn, row) for row in rows]
    end = offset + len(tournaments)
    return {
        "tournaments": tournaments,
        "next_offset": end if end < total else None,
    }


def get_for_player(conn, table_id, player_id, offset=0, limit=PAGE_SIZE):
    return _history_detail(
        conn, table_id, player_id, offset, limit, require_participant=True,
    )


def get_for_admin(conn, table_id, offset=0, limit=PAGE_SIZE):
    """Read saved hands as an admin without revealing unrevealed hole cards."""
    return _history_detail(
        conn, table_id, None, offset, limit, require_participant=False,
    )


def _history_hand_record(conn, row, viewer_id):
    hand_id = row["hand_id"]
    events = conn.execute(
        "SELECT payload_json FROM hand_history_events WHERE hand_id=? ORDER BY seq",
        (hand_id,),
    ).fetchall()
    player_rows = conn.execute(
        """SELECT * FROM hand_history_players WHERE hand_id=?
           ORDER BY CASE WHEN seat_no IS NULL THEN 1 ELSE 0 END,seat_no,name""",
        (hand_id,),
    ).fetchall()
    players = []
    for item in player_rows:
        revealed = item["revealed_cards_json"] is not None
        raw_cards = (
            _loads(item["cards_json"], [])
            if viewer_id is not None and item["player_id"] == viewer_id
            else _loads(item["revealed_cards_json"], None) if revealed
            else None
        )
        cards = _safe_card_list(raw_cards, (2,)) if raw_cards is not None else None
        players.append({
            "player_id": item["player_id"],
            "name": item["name"],
            "seat_no": item["seat_no"],
            "is_bot": bool(item["is_bot"]),
            "cards": cards,
            "revealed": revealed,
            "stack_before": item["stack_before"],
            "stack_after": item["stack_after"],
        })
    parsed_events = [_loads(event["payload_json"], {}) for event in events]
    return {
        "hand_id": hand_id,
        "number": row["number"],
        "started": row["started"],
        "ended": row["ended"],
        "street": row["street"],
        "board": _safe_card_list(_loads(row["board_json"], []), (0, 3, 4, 5)),
        "small_blind": row["small_blind"],
        "big_blind": row["big_blind"],
        "blind_level": row["blind_level"],
        "button_player_id": row["button_player_id"],
        "events": [event for event in parsed_events if isinstance(event, dict)],
        "events_complete": bool(row["events_complete"]),
        "events_coverage_start_seq": row["events_coverage_start_seq"],
        "events_end_seq": max(
            (event.get("seq", 0) for event in parsed_events if isinstance(event, dict)
             and type(event.get("seq")) is int),
            default=0,
        ),
        "players": players,
        "result": _loads(row["result_json"], {}),
    }


def _history_detail(conn, table_id, viewer_id, offset, limit, require_participant):
    limit = min(MAX_PAGE_SIZE, max(1, int(limit)))
    offset = max(0, int(offset))
    if require_participant:
        access = conn.execute(
            """SELECT 1 FROM tournament_participants p
               WHERE p.table_id=? AND p.player_id=? AND p.is_bot=0 LIMIT 1""",
            (table_id, viewer_id),
        ).fetchone()
        if access is None:
            return None
    tournament_row = conn.execute(
        "SELECT * FROM tournament_history WHERE table_id=?", (table_id,),
    ).fetchone()
    if tournament_row is None:
        return None
    total = conn.execute(
        "SELECT COUNT(*) AS n FROM hand_history WHERE table_id=?", (table_id,),
    ).fetchone()["n"]
    rows = conn.execute(
        """SELECT * FROM hand_history WHERE table_id=?
           ORDER BY number ASC LIMIT ? OFFSET ?""",
        (table_id, limit, offset),
    ).fetchall()
    tournament = _summary(conn, tournament_row)
    hands = []
    for row in rows:
        hand = _history_hand_record(conn, row, viewer_id)
        hand["history_text"] = format_hand_history(tournament, hand, viewer_id)
        hands.append(hand)
    end = offset + len(hands)
    return {
        "tournament": tournament,
        "hands": hands,
        "next_offset": end if end < total else None,
    }


def delete_tournament_history(conn, table_id):
    """Remove a tournament archive and every child history row in the current transaction."""
    conn.execute(
        """DELETE FROM hand_history_events
           WHERE hand_id IN (SELECT hand_id FROM hand_history WHERE table_id=?)""",
        (table_id,),
    )
    conn.execute(
        """DELETE FROM hand_history_players
           WHERE hand_id IN (SELECT hand_id FROM hand_history WHERE table_id=?)""",
        (table_id,),
    )
    conn.execute("DELETE FROM tournament_participants WHERE table_id=?", (table_id,))
    conn.execute("DELETE FROM hand_history WHERE table_id=?", (table_id,))
    conn.execute("DELETE FROM tournament_history WHERE table_id=?", (table_id,))

def _safe_card_list(value, allowed_lengths):
    """Validate card codes before placing stored history in a public response."""
    if not isinstance(value, list) or len(value) not in allowed_lengths:
        return []
    if any(
        not isinstance(card, str) or len(card) != 2
        or card[0] not in "23456789TJQKA" or card[1] not in "shdc"
        for card in value
    ) or len(set(value)) != len(value):
        return []
    return list(value)


def last_completed_hand(conn, table_id, viewer_player_id, hand_number=None):
    """Return a sanitized replay snapshot for a selected completed hand."""
    if hand_number is None:
        row = conn.execute(
            """SELECT * FROM hand_history
               WHERE table_id=? AND ended IS NOT NULL
               ORDER BY number DESC LIMIT 1""",
            (table_id,),
        ).fetchone()
    else:
        row = conn.execute(
            """SELECT * FROM hand_history
               WHERE table_id=? AND number=? AND ended IS NOT NULL LIMIT 1""",
            (table_id, hand_number),
        ).fetchone()
    if row is None:
        return None
    tournament_row = conn.execute(
        "SELECT * FROM tournament_history WHERE table_id=?", (table_id,),
    ).fetchone()
    tournament = _summary(conn, tournament_row) if tournament_row is not None else {
        "name": "Tournament", "status": "unknown", "config": {}, "prize": {},
    }
    older = conn.execute(
        """SELECT MAX(number) AS number FROM hand_history
           WHERE table_id=? AND ended IS NOT NULL AND number<?""",
        (table_id, row["number"]),
    ).fetchone()["number"]
    newer = conn.execute(
        """SELECT MIN(number) AS number FROM hand_history
           WHERE table_id=? AND ended IS NOT NULL AND number>?""",
        (table_id, row["number"]),
    ).fetchone()["number"]
    history_count = conn.execute(
        "SELECT COUNT(*) AS n FROM hand_history WHERE table_id=? AND ended IS NOT NULL",
        (table_id,),
    ).fetchone()["n"]
    history_record = _history_hand_record(conn, row, viewer_player_id)
    history_text = format_hand_history(tournament, history_record, viewer_player_id)

    board = _safe_card_list(_loads(row["board_json"], []), (0, 3, 4, 5))
    result = _loads(row["result_json"], {})
    if not isinstance(result, dict):
        result = {}
    player_rows = conn.execute(
        """SELECT player_id,name,seat_no,cards_json,revealed_cards_json
           FROM hand_history_players WHERE hand_id=?
           ORDER BY CASE WHEN seat_no IS NULL THEN 1 ELSE 0 END,seat_no,name""",
        (row["hand_id"],),
    ).fetchall()
    players = []
    for item in player_rows:
        cards = []
        source = None
        if item["player_id"] == viewer_player_id:
            cards = _safe_card_list(_loads(item["cards_json"], []), (2,))
            if cards:
                source = "own"
        elif item["revealed_cards_json"] is not None:
            cards = _safe_card_list(_loads(item["revealed_cards_json"], []), (2,))
            if cards:
                source = "revealed"
        public_player = {
            "player_id": item["player_id"],
            "name": item["name"],
            "seat_no": item["seat_no"],
            "cards": cards,
        }
        if source is not None:
            public_player["cards_source"] = source
        players.append(public_player)

    public_players = {item["player_id"]: item for item in players}
    showdown_rows = []
    hand_ranks = {}
    for item in result.get("showdown", []) if isinstance(result.get("showdown"), list) else []:
        if not isinstance(item, dict) or not item.get("player_id"):
            continue
        player_id = item["player_id"]
        public_player = public_players.get(player_id, {})
        cards = _safe_card_list(item.get("cards"), (2,))
        source = public_player.get("cards_source")
        if not cards or (player_id != viewer_player_id and source != "revealed"):
            continue
        rank = item.get("rank") if isinstance(item.get("rank"), str) else None
        hand_name = item.get("hand_name")
        if not isinstance(hand_name, str) and rank:
            hand_name = rank.split(",", 1)[0]
        public_row = {
            "player_id": player_id,
            "name": str(item.get("name") or public_player.get("name") or "Player"),
            "cards": cards,
            "rank": rank,
            "hand_name": hand_name,
            "payout": item.get("payout", 0),
            "returned": item.get("returned", 0),
            "total_credited": item.get("total_credited", 0),
        }
        if isinstance(item.get("rank_value"), list):
            public_row["rank_value"] = list(item["rank_value"])
        showdown_rows.append(public_row)
        if rank:
            hand_ranks[player_id] = {"rank": rank, "hand_name": hand_name}

    pot_winnings = result.get("pot_winnings")
    if not isinstance(pot_winnings, dict):
        pot_winnings = {}
    winners = []
    for player_id, amount in pot_winnings.items():
        if type(amount) is not int or amount <= 0:
            continue
        public_player = public_players.get(player_id, {})
        winner = {
            "player_id": player_id,
            "name": str(public_player.get("name") or "Player"),
            "amount": amount,
        }
        rank = hand_ranks.get(player_id)
        if rank is not None:
            winner.update(rank)
        winners.append(winner)
    winners.sort(key=lambda item: (item["name"].casefold(), item["player_id"]))

    streets = [{"name": "preflop", "board": []}]
    if len(board) >= 3:
        streets.append({"name": "flop", "board": board[:3]})
    if len(board) >= 4:
        streets.append({"name": "turn", "board": board[:4]})
    if len(board) >= 5:
        streets.append({"name": "river", "board": board[:5]})
    if showdown_rows:
        streets.append({"name": "showdown", "board": list(board)})

    returns = result.get("returns")
    if not isinstance(returns, list):
        returns = []
    returns = [
        {"player_id": item.get("player_id"), "amount": item.get("amount")}
        for item in returns
        if isinstance(item, dict)
        and isinstance(item.get("player_id"), str)
        and type(item.get("amount")) is int
        and item["amount"] > 0
    ]

    return {
        "id": row["hand_id"],
        "number": row["number"],
        "board": board,
        "players": players,
        "streets": streets,
        "showdown": showdown_rows,
        "hand_ranks": hand_ranks,
        "winners": winners,
        "pot_winnings": {
            player_id: amount for player_id, amount in pot_winnings.items()
            if isinstance(player_id, str) and type(amount) is int and amount >= 0
        },
        "returns": returns,
        "history_text": history_text,
        "previous_hand_number": older,
        "next_hand_number": newer,
        "history_count": history_count,
    }
