#!/usr/bin/env python3
"""Felt Night is a server-authoritative, loopback-only poker service."""
from __future__ import annotations

import argparse
import copy
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import sqlite3
import stat
import sys
sys.dont_write_bytecode = True
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import engine
import history as tournament_history


BASE_PATH = "/poker/"
COOKIE_NAME = "sitngo_session"
SESSION_TTL = 30 * 24 * 60 * 60
LOGIN_WINDOW = 15 * 60
LOGIN_LIMIT = 5
MAX_BODY = 16 * 1024
CHAT_MAX_LENGTH = 500
CHAT_READ_LIMIT = 50
CHAT_TABLE_LIMIT = 100
CHAT_RATE_SECONDS = 1.0
MAX_ACTIVE_TABLES = 32
MAX_SESSIONS = 256
GLOBAL_LOGIN_LIMIT = 50
MAX_WORKERS = 32
ROOM_PASSWORD_ENV = "FELT_NIGHT_ROOM_PASSWORD"
ROOM_PASSWORD_FILE_ENV = "FELT_NIGHT_ROOM_PASSWORD_FILE"
MAX_ROOM_PASSWORD_LENGTH = 4096


class AppError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _parse_origin(value):
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise RuntimeError("public origin is invalid") from exc
    if (parsed.scheme not in ("http", "https") or not parsed.hostname or
            parsed.username is not None or parsed.password is not None or
            parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise RuntimeError("public origin must contain only scheme, host, and optional port")
    host = parsed.hostname.lower()
    if port is None:
        port = 443 if parsed.scheme == "https" else 80
    if not (1 <= port <= 65535):
        raise RuntimeError("public origin port is invalid")
    netloc = ("%s:%d" % (host, port))
    origin = "%s://%s" % (parsed.scheme, netloc)
    return origin, netloc, parsed.scheme == "https"


def _validate_room_password(value):
    if (not isinstance(value, str) or not value or
            len(value) > MAX_ROOM_PASSWORD_LENGTH or
            "\n" in value or "\r" in value or "\x00" in value):
        raise RuntimeError("room invite password must be a non-empty single line of at most 4096 characters")
    return value


def _read_room_password_file(path):
    if not path:
        raise RuntimeError("FELT_NIGHT_ROOM_PASSWORD_FILE must name a private file")
    descriptor = None
    try:
        flags = (os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) |
                 getattr(os, "O_NONBLOCK", 0))
        no_follow = getattr(os, "O_NOFOLLOW", 0)
        if no_follow:
            flags |= no_follow
        elif os.path.islink(path):
            raise RuntimeError("FELT_NIGHT_ROOM_PASSWORD_FILE must not be a symlink")
        descriptor = os.open(path, flags)
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise RuntimeError("FELT_NIGHT_ROOM_PASSWORD_FILE must be a regular file")
        if stat.S_IMODE(info.st_mode) & 0o077:
            raise RuntimeError("FELT_NIGHT_ROOM_PASSWORD_FILE must not be accessible by group or others")
        stream = os.fdopen(descriptor, "r", encoding="utf-8", newline="")
        descriptor = None
        with stream:
            value = stream.read(MAX_ROOM_PASSWORD_LENGTH + 3)
        if len(value) > MAX_ROOM_PASSWORD_LENGTH + 2:
            raise RuntimeError("FELT_NIGHT_ROOM_PASSWORD_FILE contents are too long")
    except RuntimeError:
        raise
    except (OSError, UnicodeError, TypeError, ValueError):
        raise RuntimeError("FELT_NIGHT_ROOM_PASSWORD_FILE could not be read") from None
    finally:
        if descriptor is not None:
            os.close(descriptor)

    if value.endswith("\n"):
        value = value[:-1]
        if value.endswith("\r"):
            value = value[:-1]
    return _validate_room_password(value)


def _load_room_password(environ=None):
    config = os.environ if environ is None else environ
    file_path = config.get(ROOM_PASSWORD_FILE_ENV)
    direct_password = config.get(ROOM_PASSWORD_ENV)
    if file_path is None and direct_password is None:
        raise RuntimeError("set FELT_NIGHT_ROOM_PASSWORD_FILE or FELT_NIGHT_ROOM_PASSWORD")
    if file_path is not None and direct_password is not None:
        raise RuntimeError("configure only one room invite password source")
    if file_path is not None:
        return _read_room_password_file(file_path)
    return _validate_room_password(direct_password)


def _json_dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


class Store:
    def __init__(self, data_dir, room_password):
        self.data_dir = os.path.abspath(data_dir)
        if os.path.lexists(self.data_dir) and os.path.islink(self.data_dir):
            raise RuntimeError("data directory may not be a symlink")
        os.makedirs(self.data_dir, mode=0o700, exist_ok=True)
        if not os.path.isdir(self.data_dir):
            raise RuntimeError("data directory is not a directory")
        os.chmod(self.data_dir, 0o700)
        self.db_path = os.path.join(self.data_dir, "sitngo.sqlite3")
        self._initialize(room_password)

    def connect(self):
        conn = sqlite3.connect(self.db_path, timeout=4.0, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=4000")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    @staticmethod
    def _password_verifier(password, salt):
        return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 300000).hex()

    def _initialize(self, room_password):
        existed = os.path.exists(self.db_path)
        conn = self.connect()
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS players (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    created REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS accounts (
                    username TEXT PRIMARY KEY,
                    display_name TEXT NOT NULL,
                    player_id TEXT NOT NULL UNIQUE REFERENCES players(id),
                    password_salt TEXT NOT NULL,
                    password_verifier TEXT NOT NULL,
                    created REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    player_id TEXT NOT NULL REFERENCES players(id),
                    created REAL NOT NULL,
                    expires REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);
                CREATE TABLE IF NOT EXISTS tables (
                    id TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL REFERENCES players(id),
                    state TEXT NOT NULL,
                    created REAL NOT NULL,
                    updated REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS tables_updated ON tables(updated);
                CREATE TABLE IF NOT EXISTS chat_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
                    player_id TEXT NOT NULL REFERENCES players(id),
                    name TEXT NOT NULL,
                    text TEXT NOT NULL,
                    created_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS chat_messages_table_order
                    ON chat_messages(table_id, id DESC);
                CREATE INDEX IF NOT EXISTS chat_messages_player_order
                    ON chat_messages(player_id, id DESC);
                CREATE TABLE IF NOT EXISTS login_attempts (
                    client_key TEXT NOT NULL,
                    attempted REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS login_attempts_recent
                    ON login_attempts(client_key, attempted);
            """)
            tournament_history.create_schema(conn)
            history_marker = conn.execute(
                "SELECT value FROM meta WHERE key='history_backfill_v1'"
            ).fetchone()
            if history_marker is None:
                conn.execute("BEGIN IMMEDIATE")
                try:
                    history_marker = conn.execute(
                        "SELECT value FROM meta WHERE key='history_backfill_v1'"
                    ).fetchone()
                    if history_marker is None:
                        tournament_history.backfill_tournaments(conn)
                        conn.execute(
                            "INSERT INTO meta(key,value) VALUES('history_backfill_v1','1')"
                        )
                    conn.commit()
                except Exception:
                    if conn.in_transaction:
                        conn.rollback()
                    raise
            row = conn.execute("SELECT value FROM meta WHERE key='csrf_secret'").fetchone()
            if row is None:
                conn.execute(
                    "INSERT INTO meta(key,value) VALUES('csrf_secret',?)",
                    (secrets.token_hex(32),),
                )
            row = conn.execute("SELECT value FROM meta WHERE key='csrf_secret'").fetchone()
            self.csrf_secret = bytes.fromhex(row["value"])

            salt_row = conn.execute("SELECT value FROM meta WHERE key='password_salt'").fetchone()
            verifier_row = conn.execute("SELECT value FROM meta WHERE key='password_verifier'").fetchone()
            if salt_row is None or verifier_row is None:
                salt = secrets.token_bytes(16)
                conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('password_salt',?)",
                             (salt.hex(),))
                conn.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('password_verifier',?)",
                             (self._password_verifier(room_password, salt),))
            else:
                old_salt = bytes.fromhex(salt_row["value"])
                old_verifier = verifier_row["value"]
                current_verifier = self._password_verifier(room_password, old_salt)
                if not hmac.compare_digest(current_verifier, old_verifier):
                    # Changing the configured invite and restarting revokes all sessions.
                    conn.execute("DELETE FROM sessions")
                    new_salt = secrets.token_bytes(16)
                    conn.execute("UPDATE meta SET value=? WHERE key='password_salt'",
                                 (new_salt.hex(),))
                    conn.execute("UPDATE meta SET value=? WHERE key='password_verifier'",
                                 (self._password_verifier(room_password, new_salt),))
        finally:
            conn.close()
        try:
            os.chmod(self.db_path, 0o600)
        except OSError:
            pass
        if not existed:
            for suffix in ("-wal", "-shm"):
                candidate = self.db_path + suffix
                if os.path.exists(candidate):
                    try:
                        os.chmod(candidate, 0o600)
                    except OSError:
                        pass

    def csrf_token(self, raw_token):
        message = b"csrf\x00" + raw_token.encode("ascii")
        return hmac.new(self.csrf_secret, message, hashlib.sha256).hexdigest()

    def session_proof(self, raw_token):
        message = b"session-proof\x00" + raw_token.encode("ascii")
        return hmac.new(self.csrf_secret, message, hashlib.sha256).hexdigest()

    @staticmethod
    def hash_token(token):
        return hashlib.sha256(token.encode("ascii")).hexdigest()

    def authenticate(self, raw_token, now=None):
        if now is None:
            now = time.time()
        if not raw_token or not re.fullmatch(r"[A-Za-z0-9_-]{40,64}", raw_token):
            return None
        conn = self.connect()
        try:
            row = conn.execute(
                """SELECT s.token_hash,s.player_id,s.expires,p.name,a.display_name AS account_name
                   FROM sessions s JOIN players p ON p.id=s.player_id
                   LEFT JOIN accounts a ON a.player_id=p.id
                   WHERE s.token_hash=?""",
                (self.hash_token(raw_token),),
            ).fetchone()
            if row is None:
                return None
            if row["expires"] <= now:
                conn.execute("DELETE FROM sessions WHERE token_hash=?", (row["token_hash"],))
                return None
            has_account = row["account_name"] is not None
            return {
                "id": row["player_id"],
                "name": row["name"],
                "username": row["account_name"],
                "account": has_account,
                "needs_claim": not has_account,
            }
        finally:
            conn.close()

    def login_allowed(self, client_key, now):
        conn = self.connect()
        try:
            conn.execute("DELETE FROM login_attempts WHERE attempted < ?", (now - 24 * 60 * 60,))
            retry_after = 0
            for key, limit in ((client_key, LOGIN_LIMIT), ("!global", GLOBAL_LOGIN_LIMIT)):
                row = conn.execute(
                    """SELECT COUNT(*) AS n, MIN(attempted) AS first
                       FROM login_attempts WHERE client_key=? AND attempted >= ?""",
                    (key, now - LOGIN_WINDOW),
                ).fetchone()
                if row["n"] >= limit:
                    retry_after = max(retry_after, int(row["first"] + LOGIN_WINDOW - now))
            return max(1, retry_after) if retry_after else 0
        finally:
            conn.close()

    def record_failed_login(self, client_key, now):
        conn = self.connect()
        try:
            conn.executemany("INSERT INTO login_attempts(client_key,attempted) VALUES(?,?)",
                             ((client_key, now), ("!global", now)))
        finally:
            conn.close()

    def clear_failed_logins(self, client_key):
        conn = self.connect()
        try:
            conn.execute("DELETE FROM login_attempts WHERE client_key=?", (client_key,))
        finally:
            conn.close()

    def verify_room_password(self, password):
        if not isinstance(password, str) or len(password) > 4096:
            return False
        conn = self.connect()
        try:
            salt_row = conn.execute(
                "SELECT value FROM meta WHERE key='password_salt'"
            ).fetchone()
            verifier_row = conn.execute(
                "SELECT value FROM meta WHERE key='password_verifier'"
            ).fetchone()
            if salt_row is None or verifier_row is None:
                return False
            try:
                salt = bytes.fromhex(salt_row["value"])
            except ValueError:
                return False
            candidate = self._password_verifier(password, salt)
            return hmac.compare_digest(candidate, verifier_row["value"])
        finally:
            conn.close()

    @staticmethod
    def _account_player(player_id, display_name):
        return {
            "id": player_id,
            "name": display_name,
            "username": display_name,
            "account": True,
            "needs_claim": False,
        }

    def _issue_session(self, conn, player_id, now):
        conn.execute("DELETE FROM sessions WHERE expires <= ?", (now,))
        active = conn.execute(
            "SELECT COUNT(*) AS n FROM sessions WHERE expires > ?", (now,),
        ).fetchone()["n"]
        if active >= MAX_SESSIONS:
            raise AppError(503, "capacity", "The app is at its session limit. Try again later.")
        token = secrets.token_urlsafe(32)
        conn.execute(
            "INSERT INTO sessions(token_hash,player_id,created,expires) VALUES(?,?,?,?)",
            (self.hash_token(token), player_id, now, now + SESSION_TTL),
        )
        return token

    def create_account(self, username, display_name, password, now, legacy_player_id=None):
        salt = secrets.token_bytes(16)
        verifier = self._password_verifier(password, salt)
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            if conn.execute(
                "SELECT 1 FROM accounts WHERE username=?", (username,),
            ).fetchone():
                raise AppError(409, "username_taken", "That username is already registered.")
            if legacy_player_id is None:
                player_id = uuid.uuid4().hex
                conn.execute(
                    "INSERT INTO players(id,name,created) VALUES(?,?,?)",
                    (player_id, display_name, now),
                )
            else:
                player_id = legacy_player_id
                legacy = conn.execute(
                    "SELECT id FROM players WHERE id=?", (player_id,),
                ).fetchone()
                if legacy is None:
                    raise AppError(409, "legacy_identity_missing", "This old seat can no longer be claimed.")
                if conn.execute(
                    "SELECT 1 FROM accounts WHERE player_id=?", (player_id,),
                ).fetchone():
                    raise AppError(409, "account_exists", "This seat already has an account.")
                conn.execute("UPDATE players SET name=? WHERE id=?", (display_name, player_id))
            conn.execute(
                """INSERT INTO accounts
                   (username,display_name,player_id,password_salt,password_verifier,created)
                   VALUES(?,?,?,?,?,?)""",
                (username, display_name, player_id, salt.hex(), verifier, now),
            )
            token = None if legacy_player_id is not None else self._issue_session(conn, player_id, now)
            conn.commit()
            return self._account_player(player_id, display_name), token
        except Exception:
            if conn.in_transaction:
                conn.rollback()
            raise
        finally:
            conn.close()

    def login_account(self, username, password, now):
        if not isinstance(password, str) or len(password) > 256:
            password = ""
        conn = self.connect()
        try:
            row = conn.execute(
                """SELECT a.player_id,a.display_name,a.password_salt,a.password_verifier
                   FROM accounts a WHERE a.username=?""",
                (username,),
            ).fetchone()
            if row is None:
                salt = bytes(16)
                expected = "0" * 64
            else:
                try:
                    salt = bytes.fromhex(row["password_salt"])
                except ValueError:
                    salt = bytes(16)
                expected = row["password_verifier"]
            candidate = self._password_verifier(password, salt)
            if row is None or not hmac.compare_digest(candidate, expected):
                return None
            conn.execute("BEGIN IMMEDIATE")
            player_id = row["player_id"]
            player = self._account_player(player_id, row["display_name"])
            token = self._issue_session(conn, player_id, now)
            conn.commit()
            return player, token
        except Exception:
            if conn.in_transaction:
                conn.rollback()
            raise
        finally:
            conn.close()

    def logout(self, raw_token):
        if not raw_token:
            return
        conn = self.connect()
        try:
            conn.execute("DELETE FROM sessions WHERE token_hash=?", (self.hash_token(raw_token),))
        finally:
            conn.close()

    def create_table(self, owner, owner_name, table_name, config, now):
        table_id = uuid.uuid4().hex
        state = engine.create_lobby(table_id, owner["id"], owner_name, config, now)
        state["name"] = table_name
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            count = conn.execute(
                "SELECT COUNT(*) AS n FROM tables WHERE json_extract(state,'$.status') IN ('lobby','playing')"
            ).fetchone()["n"]
            if count >= MAX_ACTIVE_TABLES:
                conn.rollback()
                raise AppError(503, "capacity", "The app is at its active table limit.")
            conn.execute(
                "INSERT INTO tables(id,owner_id,state,created,updated) VALUES(?,?,?,?,?)",
                (table_id, owner["id"], _json_dumps(state), now, now),
            )
            tournament_history.record_table_created(conn, state, owner["id"], now)
            conn.commit()
        except Exception:
            if conn.in_transaction:
                conn.rollback()
            raise
        finally:
            conn.close()
        return state

    def list_tables(self, now, viewer_id):
        conn = self.connect()
        try:
            rows = conn.execute("SELECT id,state FROM tables ORDER BY created DESC LIMIT 64").fetchall()
            states = [json.loads(row["state"]) for row in rows]
            summaries = []
            for state in states:
                summary = engine.summary(state)
                summary["viewer_seated"] = any(
                    seat.get("player_id") == viewer_id for seat in state.get("seats", [])
                )
                summaries.append(summary)
            return summaries
        finally:
            conn.close()

    def list_chat_messages(self, table_id):
        conn = self.connect()
        try:
            exists = conn.execute("SELECT 1 FROM tables WHERE id=?", (table_id,)).fetchone()
            if exists is None:
                raise AppError(404, "table_not_found", "Table not found.")
            rows = conn.execute(
                """SELECT id, player_id, name, text, created_at
                   FROM chat_messages WHERE table_id=?
                   ORDER BY id DESC LIMIT ?""",
                (table_id, CHAT_READ_LIMIT),
            ).fetchall()
            return [
                {
                    "id": row["id"],
                    "player_id": row["player_id"],
                    "name": row["name"],
                    "text": row["text"],
                    "created_at": row["created_at"],
                }
                for row in reversed(rows)
            ]
        finally:
            conn.close()

    def add_chat_message(self, table_id, player_id, name, message_text, now):
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            exists = conn.execute("SELECT 1 FROM tables WHERE id=?", (table_id,)).fetchone()
            if exists is None:
                conn.rollback()
                raise AppError(404, "table_not_found", "Table not found.")

            previous = conn.execute(
                """SELECT created_at FROM chat_messages WHERE player_id=?
                   ORDER BY id DESC LIMIT 1""",
                (player_id,),
            ).fetchone()
            if previous is not None and now - previous["created_at"] < CHAT_RATE_SECONDS:
                conn.rollback()
                raise AppError(429, "chat_rate_limited", "Please wait before sending another message.")

            cursor = conn.execute(
                """INSERT INTO chat_messages(table_id,player_id,name,text,created_at)
                   VALUES(?,?,?,?,?)""",
                (table_id, player_id, name, message_text, now),
            )
            message_id = cursor.lastrowid
            conn.execute(
                """DELETE FROM chat_messages
                   WHERE table_id=? AND id NOT IN (
                       SELECT id FROM chat_messages
                       WHERE table_id=? ORDER BY id DESC LIMIT ?
                   )""",
                (table_id, table_id, CHAT_TABLE_LIMIT),
            )
            conn.commit()
            return {
                "id": message_id,
                "player_id": player_id,
                "name": name,
                "text": message_text,
                "created_at": now,
            }
        except Exception:
            if conn.in_transaction:
                conn.rollback()
            raise
        finally:
            conn.close()

    def mutate_table(self, table_id, mutate, now):
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT state FROM tables WHERE id=?", (table_id,)).fetchone()
            if row is None:
                conn.rollback()
                raise AppError(404, "table_not_found", "Table not found.")
            original = json.loads(row["state"])
            previous = copy.deepcopy(original)
            advanced = engine.advance(original, now)
            advanced_json = _json_dumps(advanced)
            try:
                state = mutate(copy.deepcopy(advanced))
            except engine.GameError:
                # Keep independent timer progress, but discard any partial attempted action.
                if advanced_json != row["state"]:
                    conn.execute("UPDATE tables SET state=?,updated=? WHERE id=?",
                                 (advanced_json, now, table_id))
                    tournament_history.sync_state(conn, previous, now)
                    tournament_history.sync_state(conn, advanced, now)
                    conn.commit()
                else:
                    conn.rollback()
                raise
            final_json = _json_dumps(state)
            if final_json != row["state"]:
                conn.execute("UPDATE tables SET state=?,updated=? WHERE id=?",
                             (final_json, now, table_id))
            if final_json != row["state"] or advanced_json != row["state"]:
                tournament_history.sync_state(conn, previous, now)
                if advanced_json != row["state"]:
                    tournament_history.sync_state(conn, advanced, now)
                tournament_history.sync_state(conn, state, now)
            conn.commit()
            return state
        except Exception:
            if conn.in_transaction:
                conn.rollback()
            raise
        finally:
            conn.close()

    def list_history(self, player_id, offset=0):
        conn = self.connect()
        try:
            return tournament_history.list_for_player(conn, player_id, offset)
        finally:
            conn.close()

    def get_history(self, table_id, player_id, offset=0):
        conn = self.connect()
        try:
            return tournament_history.get_for_player(conn, table_id, player_id, offset)
        finally:
            conn.close()

    def get_last_hand(self, table_id, player_id):
        conn = self.connect()
        try:
            exists = conn.execute("SELECT 1 FROM tables WHERE id=?", (table_id,)).fetchone()
            if exists is None:
                raise AppError(404, "table_not_found", "Table not found.")
            return tournament_history.last_completed_hand(conn, table_id, player_id)
        finally:
            conn.close()

    def tick_all(self, now):
        conn = self.connect()
        try:
            rows = conn.execute(
                "SELECT id FROM tables WHERE json_extract(state,'$.status') IN ('lobby','playing')"
            ).fetchall()
        finally:
            conn.close()
        for row in rows:
            try:
                self.mutate_table(row["id"], lambda state: state, now)
            except Exception:
                continue


class LimitedThreadingHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 32

    def __init__(self, server_address, handler_class, app):
        self.app = app
        self._slots = threading.BoundedSemaphore(MAX_WORKERS)
        super().__init__(server_address, handler_class)

    def process_request(self, request, client_address):
        if not self._slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self._slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            request.settimeout(10.0)
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "SitNGo"
    sys_version = ""
    protocol_version = "HTTP/1.0"

    @property
    def app(self):
        return self.server.app

    def log_message(self, fmt, *args):
        # Do not log request paths, origins, cookies, player names, or bodies.
        return

    def _headers(self):
        parsed = urlsplit(self.path)
        if not parsed.path.startswith(BASE_PATH):
            raise AppError(404, "not_found", "Not found.")
        if parsed.fragment:
            raise AppError(400, "invalid_url", "Fragments are not supported.")
        self.request_offset = 0
        if parsed.query:
            history_route = (
                parsed.path == "/poker/api/history"
                or re.fullmatch(r"/poker/api/history/[a-f0-9]{32}", parsed.path)
            )
            if self.command != "GET" or not history_route:
                raise AppError(400, "invalid_url", "Query strings are not supported here.")
            try:
                query = parse_qs(parsed.query, strict_parsing=True, keep_blank_values=True)
            except ValueError as exc:
                raise AppError(400, "invalid_url", "Invalid history pagination.") from exc
            if set(query) != {"offset"} or len(query["offset"]) != 1:
                raise AppError(400, "invalid_url", "Use one numeric history offset.")
            raw_offset = query["offset"][0]
            if not re.fullmatch(r"[0-9]{1,9}", raw_offset):
                raise AppError(400, "invalid_url", "Invalid history offset.")
            self.request_offset = int(raw_offset)
        host = self.headers.get("Host", "").strip().lower()
        if host != self.app.public_netloc:
            raise AppError(421, "misdirected_request", "Request host is not configured.")
        return parsed.path

    def _send(self, status, body=b"", content_type="application/json; charset=utf-8",
              headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _json(self, status, payload, headers=None):
        self._send(status, _json_dumps(payload).encode("utf-8"), headers=headers)

    def _error(self, status, code, message):
        self._json(status, {"error": {"code": code, "message": message}})

    def _cookie_token(self):
        raw = self.headers.get("Cookie", "")
        if len(raw) > 8192:
            return None
        found = []
        for part in raw.split(";"):
            name, sep, value = part.strip().partition("=")
            if sep and name.strip() == COOKIE_NAME:
                found.append(value.strip().strip('"'))
        if len(found) != 1:
            return None
        token = found[0]
        if not re.fullmatch(r"[A-Za-z0-9_-]{40,64}", token):
            return None
        return token

    def _player(self):
        cookie_token = self._cookie_token()
        proof = self.headers.get("X-SitNgo-Session", "")
        if (not cookie_token or not proof or
                not re.fullmatch(r"[0-9a-f]{64}", proof) or
                not hmac.compare_digest(proof, self.app.store.session_proof(cookie_token))):
            return None
        return self.app.store.authenticate(cookie_token), cookie_token

    def _require_player(self, require_account=True):
        session = self._player()
        if not session or not session[0]:
            raise AppError(401, "authentication_required", "Please sign in.")
        if require_account and not session[0].get("account"):
            raise AppError(403, "account_required", "Create or claim a personal account to continue.")
        return session[0], session[1]

    def _require_csrf(self, token):
        received = self.headers.get("X-SitNgo-CSRF", "")
        expected = self.app.store.csrf_token(token)
        if not received or not hmac.compare_digest(received, expected):
            raise AppError(403, "csrf_failed", "Security token expired. Refresh and try again.")

    def _require_origin(self):
        origin = self.headers.get("Origin", "")
        if origin != self.app.public_origin:
            raise AppError(403, "origin_rejected", "Request origin is not allowed.")

    def _body(self):
        transfer = self.headers.get("Transfer-Encoding")
        if transfer:
            raise AppError(400, "invalid_body", "Chunked request bodies are not accepted.")
        length = self.headers.get("Content-Length")
        try:
            size = int(length) if length is not None else 0
        except ValueError:
            raise AppError(400, "invalid_body", "Invalid content length.")
        if size < 0 or size > MAX_BODY:
            raise AppError(413, "body_too_large", "Request body is too large.")
        if size and self.headers.get_content_type() != "application/json":
            raise AppError(415, "content_type", "Use application/json.")
        raw = self.rfile.read(size) if size else b"{}"
        if len(raw) != size:
            raise AppError(400, "invalid_body", "Incomplete request body.")
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeError, ValueError):
            raise AppError(400, "invalid_json", "Request body must be valid JSON.")
        if not isinstance(value, dict):
            raise AppError(400, "invalid_json", "Request body must be a JSON object.")
        return value

    @staticmethod
    def _integer(value, field, minimum, maximum):
        if type(value) is not int or not minimum <= value <= maximum:
            raise AppError(400, "invalid_" + field, "Invalid " + field + ".")
        return value

    @staticmethod
    def _username(value, error_code="invalid_username"):
        if not isinstance(value, str):
            raise AppError(400, error_code, "Choose a username.")
        display = value.strip()
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{2,23}", display):
            raise AppError(
                400, error_code,
                "Usernames must be 3 to 24 letters, numbers, periods, underscores, or hyphens.",
            )
        return display.lower(), display

    @staticmethod
    def _password(value, registration=False):
        if not isinstance(value, str):
            raise AppError(400, "invalid_password", "Enter your account password.")
        if registration and not 10 <= len(value) <= 256:
            raise AppError(400, "invalid_password", "Passwords must be 10 to 256 characters.")
        if not registration and len(value) > 256:
            raise AppError(400, "invalid_password", "Passwords must be 256 characters or fewer.")
        return value

    @staticmethod
    def _payout_percentages(value):
        if not isinstance(value, (list, tuple)) or not 1 <= len(value) <= 9:
            raise AppError(400, "invalid_payout_percentages",
                           "Choose 1 to 9 whole-number payout percentages.")
        return [
            Handler._integer(item, "payout_percentages", 0, 100)
            for item in value
        ]

    def _session_response(self, status, player, token, set_cookie=True):
        payload = {
            "authenticated": True,
            "csrf": self.app.store.csrf_token(token),
            "session_proof": self.app.store.session_proof(token),
            "player": player,
        }
        headers = None
        if set_cookie:
            cookie = ("%s=%s; Path=/poker/; HttpOnly; SameSite=Strict; Max-Age=%d" %
                      (COOKIE_NAME, token, SESSION_TTL))
            if self.app.secure_cookie:
                cookie += "; Secure"
            headers = {"Set-Cookie": cookie}
        self._json(status, payload, headers)

    @staticmethod
    def _display_name(value):
        if not isinstance(value, str):
            raise AppError(400, "invalid_name", "Choose a display name.")
        name = " ".join(value.strip().split())
        if not name or len(name) > 32 or any(not ch.isprintable() for ch in name):
            raise AppError(400, "invalid_name", "Display names must be 1 to 32 printable characters.")
        if any(ch in "<>" for ch in name):
            raise AppError(400, "invalid_name", "Display name contains an unsupported character.")
        return name

    def _client_key(self):
        remote = self.client_address[0]
        forwarded = self.headers.get("X-Forwarded-For", "")
        if forwarded:
            # The HTTPS ingress appends the connected client address at the end
            # of this chain. Never trust a caller-selected earlier value.
            for candidate in reversed(forwarded.split(",")):
                try:
                    return str(ipaddress.ip_address(candidate.strip()))
                except ValueError:
                    continue
        try:
            return str(ipaddress.ip_address(remote))
        except ValueError:
            return remote[:64]

    def do_GET(self):
        try:
            path = self._headers()
            if path == "/poker/healthz":
                self._json(200, {"status": "ok"})
                return
            if path == "/poker/":
                file_path = Path(__file__).parent / "static" / "index.html"
                body = file_path.read_bytes()
                csp = ("default-src 'self'; script-src 'self'; style-src 'self'; "
                       "img-src 'self' data:; connect-src 'self'; base-uri 'none'; "
                       "form-action 'self'; frame-ancestors 'none'")
                self._send(200, body, "text/html; charset=utf-8",
                           {"Content-Security-Policy": csp})
                return
            assets = {
                "/poker/seat-layout.js": ("seat-layout.js", "text/javascript; charset=utf-8"),
                "/poker/app.js": ("app.js", "text/javascript; charset=utf-8"),
                "/poker/style.css": ("style.css", "text/css; charset=utf-8"),
                "/poker/room.css": ("room.css", "text/css; charset=utf-8"),
                "/poker/ace.svg": ("ace.svg", "image/svg+xml"),
                "/poker/security.html": ("security.html", "text/html; charset=utf-8"),
            }
            if path in assets:
                name, content_type = assets[path]
                body = (Path(__file__).parent / "static" / name).read_bytes()
                headers = {}
                if name in ("security.html",):
                    headers["Content-Security-Policy"] = (
                        "default-src 'self'; script-src 'self'; style-src 'self'; "
                        "img-src 'self' data:; connect-src 'self'; base-uri 'none'; "
                        "form-action 'self'; frame-ancestors 'none'"
                    )
                self._send(200, body, content_type, headers)
                return
            if path == "/poker/api/me":
                session = self._player()
                if not session or not session[0]:
                    self._json(200, {"authenticated": False, "csrf": None, "player": None})
                    return
                player, token = session
                self._json(200, {
                    "authenticated": True,
                    "needs_claim": player.get("needs_claim", False),
                    "csrf": self.app.store.csrf_token(token),
                    "player": player,
                })
                return
            if path == "/poker/api/history":
                player, _ = self._require_player()
                history_page = self.app.store.list_history(player["id"], self.request_offset)
                self._json(200, history_page)
                return
            match = re.fullmatch(r"/poker/api/history/([a-f0-9]{32})", path)
            if match:
                player, _ = self._require_player()
                history_page = self.app.store.get_history(
                    match.group(1), player["id"], self.request_offset,
                )
                if history_page is None:
                    raise AppError(404, "history_not_found", "Tournament history not found.")
                self._json(200, history_page)
                return
            if path == "/poker/api/tables":
                player, _ = self._require_player()
                self._json(200, {"tables": self.app.store.list_tables(time.time(), player["id"])})
                return
            match = re.fullmatch(r"/poker/api/tables/([a-f0-9]{32})/chat", path)
            if match:
                self._require_player()
                messages = self.app.store.list_chat_messages(match.group(1))
                self._json(200, {"messages": messages, "server_now": time.time()})
                return
            match = re.fullmatch(r"/poker/api/tables/([a-f0-9]{32})/last-hand", path)
            if match:
                player, _ = self._require_player()
                hand = self.app.store.get_last_hand(match.group(1), player["id"])
                self._json(200, {"hand": hand})
                return
            match = re.fullmatch(r"/poker/api/tables/([a-f0-9]{32})", path)
            if match:
                player, _ = self._require_player()
                table_id = match.group(1)
                state = self.app.store.mutate_table(table_id, lambda value: value, time.time())
                self._json(200, {"table": engine.public_view(state, player["id"])})
                return
            self._error(404, "not_found", "Not found.")
        except AppError as exc:
            self._error(exc.status, exc.code, exc.message)
        except engine.GameError as exc:
            self._error(exc.status, exc.code, exc.message)
        except (FileNotFoundError, OSError):
            self._error(503, "unavailable", "The requested resource is unavailable.")
        except Exception:
            self._error(500, "internal_error", "The request could not be completed.")

    def do_POST(self):
        try:
            path = self._headers()
            self._require_origin()
            body = self._body()
            now = time.time()

            if path == "/poker/api/register":
                client_key = self._client_key()
                retry = self.app.store.login_allowed(client_key, now)
                if retry:
                    self._json(429, {"error": {"code": "login_throttled",
                                               "message": "Too many sign-in attempts. Try again later."}},
                               {"Retry-After": str(retry)})
                    return
                current = self._player()
                if current and current[0]:
                    code = "claim_required" if current[0].get("needs_claim") else "account_exists"
                    message = ("Claim this existing seat to keep its history." if code == "claim_required"
                               else "Sign out before registering another account.")
                    raise AppError(409, code, message)
                if not self.app.store.verify_room_password(body.get("room_password")):
                    self.app.store.record_failed_login(client_key, now)
                    self._error(401, "invalid_credentials", "Sign-in failed.")
                    return
                username, display_name = self._username(body.get("username"))
                password = self._password(body.get("password"), registration=True)
                player, token = self.app.store.create_account(
                    username, display_name, password, now,
                )
                self.app.store.clear_failed_logins(client_key)
                self._session_response(201, player, token)
                return

            if path == "/poker/api/login":
                client_key = self._client_key()
                retry = self.app.store.login_allowed(client_key, now)
                if retry:
                    self._json(429, {"error": {"code": "login_throttled",
                                               "message": "Too many sign-in attempts. Try again later."}},
                               {"Retry-After": str(retry)})
                    return
                raw_username = body.get("username")
                username = (
                    raw_username.lower()
                    if isinstance(raw_username, str)
                    and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{2,23}", raw_username.strip())
                    else ""
                )
                password = body.get("password")
                if not isinstance(password, str) or len(password) > 256:
                    password = ""
                result = self.app.store.login_account(username, password, now)
                if result is None:
                    self.app.store.record_failed_login(client_key, now)
                    self._error(401, "invalid_credentials", "Sign-in failed.")
                    return
                self.app.store.clear_failed_logins(client_key)
                self._session_response(200, result[0], result[1])
                return

            if path == "/poker/api/claim":
                player, token = self._require_player(require_account=False)
                self._require_csrf(token)
                if player.get("account"):
                    raise AppError(409, "account_exists", "This seat already has an account.")
                client_key = self._client_key()
                retry = self.app.store.login_allowed(client_key, now)
                if retry:
                    self._json(429, {"error": {"code": "login_throttled",
                                               "message": "Too many sign-in attempts. Try again later."}},
                               {"Retry-After": str(retry)})
                    return
                if not self.app.store.verify_room_password(body.get("room_password")):
                    self.app.store.record_failed_login(client_key, now)
                    self._error(401, "invalid_credentials", "Sign-in failed.")
                    return
                username, display_name = self._username(body.get("username"))
                password = self._password(body.get("password"), registration=True)
                claimed, _ = self.app.store.create_account(
                    username, display_name, password, now, legacy_player_id=player["id"],
                )
                self.app.store.clear_failed_logins(client_key)
                self._session_response(200, claimed, token, set_cookie=False)
                return

            player, token = self._require_player(require_account=False)
            self._require_csrf(token)

            if path == "/poker/api/logout":
                self.app.store.logout(token)
                self._json(200, {"ok": True},
                           {"Set-Cookie": COOKIE_NAME +
                            "=; Path=/poker/; HttpOnly; SameSite=Strict; Max-Age=0" +
                            ("; Secure" if self.app.secure_cookie else "")})
                return

            if not player.get("account"):
                raise AppError(403, "account_required",
                               "Claim this legacy seat or sign in with a personal account.")

            chat_match = re.fullmatch(
                r"/poker/api/tables/([a-f0-9]{32})/chat", path,
            )
            if chat_match:
                raw_text = body.get("text")
                if not isinstance(raw_text, str):
                    raise AppError(400, "invalid_chat_message", "Enter a message.")
                message_text = raw_text.replace("\r\n", "\n").replace("\r", "\n").strip()
                if (
                    not message_text
                    or len(message_text) > CHAT_MAX_LENGTH
                    or any(not char.isprintable() and char != "\n" for char in message_text)
                ):
                    raise AppError(
                        400, "invalid_chat_message",
                        "Messages must be 1 to 500 printable characters.",
                    )
                message = self.app.store.add_chat_message(
                    chat_match.group(1), player["id"], player["name"], message_text, now,
                )
                self._json(201, {"message": message})
                return

            sit_out_match = re.fullmatch(
                r"/poker/api/tables/([a-f0-9]{32})/sit-out", path,
            )
            if sit_out_match:
                sitting_out = body.get("sitting_out")
                if type(sitting_out) is not bool:
                    raise AppError(400, "invalid_sitting_out", "Choose whether to sit out.")
                table_id = sit_out_match.group(1)
                state = self.app.store.mutate_table(
                    table_id,
                    lambda value: engine.set_sitting_out(
                        value, player["id"], sitting_out, now,
                    ),
                    now,
                )
                self._json(200, {"table": engine.public_view(state, player["id"])})
                return

            if path == "/poker/api/tables":
                name = body.get("name")
                if not isinstance(name, str):
                    raise AppError(400, "invalid_table_name", "Choose a table name.")
                name = " ".join(name.strip().split())
                if not name or len(name) > 48 or any(not ch.isprintable() for ch in name):
                    raise AppError(400, "invalid_table_name", "Table names must be 1 to 48 printable characters.")
                if any(ch in "<>" for ch in name):
                    raise AppError(400, "invalid_table_name", "Table name contains an unsupported character.")
                config = {
                    "max_seats": self._integer(body.get("max_seats"), "max_seats", 2, 9),
                    "starting_stack": self._integer(body.get("starting_stack"), "starting_stack", 100, 1_000_000_000),
                    "small_blind": self._integer(body.get("small_blind"), "small_blind", 1, 1_000_000_000),
                    "big_blind": self._integer(body.get("big_blind"), "big_blind", 2, 1_000_000_000),
                    "level_minutes": body.get("level_minutes"),
                    "turn_seconds": self._integer(body.get("turn_seconds", engine.TURN_SECONDS), "turn_seconds", 1, engine.MAX_TIMER_SECONDS),
                    "runout_seconds": body.get("runout_seconds", engine.RUNOUT_SECONDS),
                    "blind_announcement_seconds": body.get(
                        "blind_announcement_seconds", engine.BLIND_ANNOUNCEMENT_SECONDS,
                    ),
                    "elimination_announcement_seconds": body.get(
                        "elimination_announcement_seconds", engine.ELIMINATION_ANNOUNCEMENT_SECONDS,
                    ),
                    "buy_in": self._integer(
                        body.get("buy_in", engine.DEFAULT_BUY_IN),
                        "buy_in", 0, engine.MAX_CHIPS,
                    ),
                    "payout_percentages": self._payout_percentages(
                        body.get("payout_percentages", list(engine.DEFAULT_PAYOUT_PERCENTAGES)),
                    ),
                }
                if config["small_blind"] >= config["big_blind"] or config["big_blind"] > config["starting_stack"]:
                    raise AppError(400, "invalid_blinds", "Blinds must increase and the big blind must fit the starting stack.")
                state = self.app.store.create_table(player, player["name"], name, config, now)
                self._json(201, {"table": engine.public_view(state, player["id"])})
                return

            match = re.fullmatch(
                r"/poker/api/tables/([a-f0-9]{32})/(join|seat|stand|start|action|leave|cancel|settings|bots|pause)",
                path,
            )
            if not match:
                self._error(404, "not_found", "Not found.")
                return
            table_id, operation = match.groups()
            if operation == "join":
                state = self.app.store.mutate_table(
                    table_id, lambda value: engine.join(value, player["id"], player["name"], now), now)
            elif operation == "seat":
                seat_no = self._integer(body.get("seat_no"), "seat_no", 0, 8)
                state = self.app.store.mutate_table(
                    table_id,
                    lambda value: engine.join(
                        value, player["id"], player["name"], now, seat_no=seat_no),
                    now,
                )
            elif operation == "stand":
                state = self.app.store.mutate_table(
                    table_id, lambda value: engine.stand(value, player["id"], now), now)
            elif operation == "settings":
                supported_settings = {
                    "max_seats", "starting_stack", "small_blind", "big_blind",
                    "buy_in", "turn_seconds", "level_minutes", "runout_seconds",
                    "blind_announcement_seconds", "elimination_announcement_seconds",
                    "payout_percentages", "name",
                }
                unknown_settings = set(body) - supported_settings
                if unknown_settings:
                    raise AppError(400, "invalid_settings", "Unknown table setting.")
                field_ranges = {
                    "max_seats": (2, 9),
                    "starting_stack": (100, 1_000_000_000),
                    "small_blind": (1, 1_000_000_000),
                    "big_blind": (2, 1_000_000_000),
                    "buy_in": (0, engine.MAX_CHIPS),
                    "turn_seconds": (1, engine.MAX_TIMER_SECONDS),
                }
                settings = {
                    field: self._integer(body[field], field, minimum, maximum)
                    for field, (minimum, maximum) in field_ranges.items()
                    if field in body
                }
                for duration in (
                    "level_minutes", "runout_seconds", "blind_announcement_seconds",
                    "elimination_announcement_seconds",
                ):
                    if duration in body:
                        settings[duration] = body[duration]  # Numeric ranges are validated by the engine.
                if "payout_percentages" in body:
                    settings["payout_percentages"] = self._payout_percentages(
                        body["payout_percentages"],
                    )
                table_name = None
                if "name" in body:
                    table_name = body["name"]
                    if not isinstance(table_name, str):
                        raise AppError(400, "invalid_table_name", "Choose a table name.")
                    table_name = " ".join(table_name.strip().split())
                    if (not table_name or len(table_name) > 48 or
                            any(not ch.isprintable() for ch in table_name) or
                            any(ch in "<>" for ch in table_name)):
                        raise AppError(400, "invalid_table_name",
                                       "Table names must be 1 to 48 printable characters.")
                if not settings and table_name is None:
                    raise AppError(400, "invalid_settings",
                                   "Choose at least one table setting to update.")
                def update_table_settings(value):
                    if value.get("status") == "playing":
                        if table_name is not None:
                            raise engine.GameError(
                                "table_started", "Table name cannot change after the tournament starts.", 409,
                            )
                        return engine.update_runtime_settings(
                            value, player["id"], settings, now,
                        )
                    return engine.update_settings(
                        value, player["id"], settings, now, name=table_name,
                    )

                state = self.app.store.mutate_table(
                    table_id, update_table_settings, now,
                )
            elif operation == "pause":
                paused = body.get("paused")
                if type(paused) is not bool:
                    raise AppError(400, "invalid_pause", "Choose whether the tournament is paused.")
                state = self.app.store.mutate_table(
                    table_id,
                    lambda value: engine.pause_table(value, player["id"], paused, now),
                    now,
                )
            elif operation == "bots":
                seat_no = self._integer(body.get("seat_no"), "seat_no", 0, 8)
                state = self.app.store.mutate_table(
                    table_id,
                    lambda value: engine.add_bot(value, player["id"], seat_no, now),
                    now,
                )
            elif operation == "start":
                state = self.app.store.mutate_table(
                    table_id, lambda value: engine.start(value, player["id"], now), now)
            elif operation == "leave":
                state = self.app.store.mutate_table(
                    table_id, lambda value: engine.leave(value, player["id"], now), now)
            elif operation == "cancel":
                state = self.app.store.mutate_table(
                    table_id, lambda value: engine.cancel(value, player["id"], now), now)
            else:
                action = body.get("action")
                if not isinstance(action, str):
                    raise AppError(400, "invalid_action", "Choose a poker action.")
                amount = body.get("amount")
                if amount is not None:
                    amount = self._integer(amount, "amount", 1, 1_000_000_000)
                expected_hand = self._integer(body.get("expected_hand"), "expected_hand", 0, 1_000_000_000)
                expected_turn_version = self._integer(body.get("expected_turn_version"), "expected_turn_version", 0, 2**63 - 1)
                state = self.app.store.mutate_table(
                    table_id,
                    lambda value: engine.apply_action(
                        value, player["id"], action, amount, expected_hand,
                        expected_turn_version, now),
                    now,
                )
            self._json(200, {"table": engine.public_view(state, player["id"])})
        except AppError as exc:
            self._error(exc.status, exc.code, exc.message)
        except engine.GameError as exc:
            self._error(exc.status, exc.code, exc.message)
        except (FileNotFoundError, OSError):
            self._error(503, "unavailable", "The requested resource is unavailable.")
        except Exception:
            self._error(500, "internal_error", "The request could not be completed.")

    def do_OPTIONS(self):
        self._error(405, "method_not_allowed", "Method not allowed.")

    def do_PUT(self):
        self._error(405, "method_not_allowed", "Method not allowed.")

    def do_DELETE(self):
        try:
            path = self._headers()
            self._require_origin()
            player, token = self._require_player()
            self._require_csrf(token)
            match = re.fullmatch(
                r"/poker/api/tables/([a-f0-9]{32})/bots/(\d+)", path)
            if not match:
                self._error(404, "not_found", "Not found.")
                return
            table_id, raw_seat_no = match.groups()
            try:
                seat_no = int(raw_seat_no)
            except ValueError:
                raise AppError(400, "invalid_seat_no", "Invalid seat number.")
            if not 0 <= seat_no <= 8:
                raise AppError(400, "invalid_seat_no", "Invalid seat number.")
            now = time.time()
            state = self.app.store.mutate_table(
                table_id,
                lambda value: engine.remove_bot(value, player["id"], seat_no, now),
                now,
            )
            self._json(200, {"table": engine.public_view(state, player["id"])})
        except AppError as exc:
            self._error(exc.status, exc.code, exc.message)
        except engine.GameError as exc:
            self._error(exc.status, exc.code, exc.message)
        except (FileNotFoundError, OSError):
            self._error(503, "unavailable", "The requested resource is unavailable.")
        except Exception:
            self._error(500, "internal_error", "The request could not be completed.")

    def do_PATCH(self):
        self._error(405, "method_not_allowed", "Method not allowed.")


class App:
    def __init__(self, args, room_password=None):
        self.room_password = (
            _load_room_password() if room_password is None
            else _validate_room_password(room_password)
        )
        self.public_origin, self.public_netloc, self.secure_cookie = _parse_origin(args.public_origin)
        self.store = Store(args.data_dir, self.room_password)


def _background_ticks(store, stop_event):
    while not stop_event.wait(1.0):
        try:
            store.tick_all(time.time())
        except Exception:
            continue


def main(argv=None):
    parser = argparse.ArgumentParser(description="Felt Night play-money Texas Hold'em sit-and-go server")
    parser.add_argument("--host", default="127.0.0.1", help="listen address (must be loopback)")
    parser.add_argument("--port", type=int, default=18943)
    parser.add_argument("--public-origin", required=True,
                        help="exact browser origin, e.g. https://host:8443")
    parser.add_argument("--data-dir", required=True,
                        help="protected runtime data directory for SQLite")
    args = parser.parse_args(argv)
    try:
        if not ipaddress.ip_address(args.host).is_loopback:
            parser.error("--host must be a loopback address")
    except ValueError:
        parser.error("--host must be a numeric loopback address")
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")
    os.umask(0o077)
    try:
        app = App(args)
        server = LimitedThreadingHTTPServer((args.host, args.port), Handler, app)
    except Exception as exc:
        print("Felt Night startup failed: %s" % exc, file=sys.stderr)
        return 1

    stop_event = threading.Event()
    ticker = threading.Thread(target=_background_ticks, args=(app.store, stop_event), daemon=True)
    ticker.start()
    print("Felt Night listening on %s:%d for %s" %
          (args.host, args.port, app.public_origin), flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        stop_event.set()
        server.server_close()
        ticker.join(timeout=2.0)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

