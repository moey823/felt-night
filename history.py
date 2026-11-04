"""Durable, participant-private tournament and hand history storage."""
from __future__ import annotations

import json


PAGE_SIZE = 20
MAX_PAGE_SIZE = 50


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
            standings_json TEXT NOT NULL DEFAULT '[]'
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


def backfill_tournaments(conn):
    """Create history envelopes for pre-migration tables without changing them."""
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


def record_table_created(conn, state, owner_id, now):
    conn.execute(
        """INSERT INTO tournament_history
           (table_id,owner_id,name,status,created,started,completed,results_json,standings_json)
           VALUES(?,?,?,?,?,?,NULL,'[]','[]')""",
        (state["id"], owner_id, state["name"], state["status"], now, state.get("started_at")),
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
           (table_id,owner_id,name,status,created,started,completed,results_json,standings_json)
           VALUES(?,?,?,?,?,?,?,?,?)
           ON CONFLICT(table_id) DO UPDATE SET
             name=excluded.name,
             status=excluded.status,
             started=COALESCE(tournament_history.started,excluded.started),
             completed=COALESCE(tournament_history.completed,excluded.completed),
             results_json=excluded.results_json,
             standings_json=excluded.standings_json""",
        (
            table_id, state.get("host_id", ""), str(state.get("name") or "Tournament"),
            str(state.get("status") or "lobby"), created, started, completed,
            _dumps(state.get("results") or []),
            _dumps(_standings(state)),
        ),
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
           (hand_id,table_id,number,started,ended,street,board_json,result_json)
           VALUES(?,?,?,?,?,?,?,?)
           ON CONFLICT(hand_id) DO UPDATE SET
             ended=COALESCE(hand_history.ended,excluded.ended),
             street=excluded.street,
             board_json=excluded.board_json,
             result_json=excluded.result_json""",
        (
            hand_id, table_id, number,
            float(hand.get("started_at") or now), ended,
            str(hand.get("street") or "preflop"), _dumps(board),
            _dumps(_hand_result(hand, state)),
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
        _record_participant(conn, table_id, str(player_id), name, is_bot, number, now)
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
                 stack_after=COALESCE(excluded.stack_after,hand_history_players.stack_after)""",
            (
                hand_id, str(player_id), name, seat_no, is_bot, _dumps(cards),
                revealed_json, before, after,
            ),
        )
    for item in state.get("elimination_order", []):
        if not isinstance(item, dict) or not item.get("player_id"):
            continue
        seat = seats.get(item["player_id"], {})
        _record_participant(
            conn, table_id, str(item["player_id"]),
            str(item.get("name") or seat.get("name") or "Player"),
            bool(seat.get("is_bot", False)),
            int(item.get("hand_no") or number), now,
            place=item.get("place"),
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
        _record_participant(
            conn, table_id, str(item["player_id"]),
            str(item.get("name") or seat.get("name") or "Player"),
            bool(seat.get("is_bot", False)),
            int(eliminated.get("hand_no") or number), now,
            place=item.get("place"), award_cents=item.get("award_cents"),
        )


def _record_participant(conn, table_id, player_id, name, is_bot, hand_no, now,
                        place=None, award_cents=None):
    conn.execute(
        """INSERT INTO tournament_participants
           (table_id,player_id,name,is_bot,first_hand,last_hand,place,award_cents)
           VALUES(?,?,?,?,?,?,?,?)
           ON CONFLICT(table_id,player_id) DO UPDATE SET
             name=excluded.name,
             is_bot=excluded.is_bot,
             first_hand=MIN(tournament_participants.first_hand,excluded.first_hand),
             last_hand=MAX(tournament_participants.last_hand,excluded.last_hand),
             place=COALESCE(excluded.place,tournament_participants.place),
             award_cents=COALESCE(excluded.award_cents,tournament_participants.award_cents)""",
        (table_id, player_id, name, int(bool(is_bot)), hand_no, hand_no,
         place, award_cents),
    )


def _standings(state):
    try:
        import engine
        return engine._standings_rows(state)
    except (AttributeError, KeyError, TypeError):
        return state.get("results", []) or []


def _participants(conn, table_id):
    rows = conn.execute(
        """SELECT player_id,name,is_bot,first_hand,last_hand,place,award_cents
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
    } for row in rows]


def _summary(conn, row):
    table_id = row["table_id"]
    hand_count = conn.execute(
        "SELECT COUNT(*) AS n FROM hand_history WHERE table_id=?", (table_id,),
    ).fetchone()["n"]
    return {
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
    }


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


def get_for_player(conn, table_id, player_id, offset=0, limit=PAGE_SIZE):
    limit = min(MAX_PAGE_SIZE, max(1, int(limit)))
    offset = max(0, int(offset))
    access = conn.execute(
        """SELECT 1 FROM tournament_participants p
           WHERE p.table_id=? AND p.player_id=? AND p.is_bot=0 LIMIT 1""",
        (table_id, player_id),
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
    hands = []
    for row in rows:
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
            cards = (_loads(item["cards_json"], []) if item["player_id"] == player_id
                     else _loads(item["revealed_cards_json"], None) if revealed else None)
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
        hands.append({
            "hand_id": hand_id,
            "number": row["number"],
            "started": row["started"],
            "ended": row["ended"],
            "street": row["street"],
            "board": _loads(row["board_json"], []),
            "events": [_loads(event["payload_json"], {}) for event in events],
            "events_complete": bool(row["events_complete"]),
            "events_coverage_start_seq": row["events_coverage_start_seq"],
            "events_end_seq": max((_loads(event["payload_json"], {}).get("seq", 0) for event in events), default=0),
            "players": players,
            "result": _loads(row["result_json"], {}),
        })
    end = offset + len(hands)
    return {
        "tournament": _summary(conn, tournament_row),
        "hands": hands,
        "next_offset": end if end < total else None,
    }
