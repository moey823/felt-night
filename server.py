#!/usr/bin/env python3
"""Felt Night is a server-authoritative, loopback-only poker service."""
from __future__ import annotations

import argparse
import base64
import binascii
import copy
import hashlib
import hmac
import ipaddress
import json
import math
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
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import engine
import history as tournament_history


BASE_PATH = "/poker/"
PAGE_ROUTES = frozenset({
    "/poker/", "/poker/lobby", "/poker/lobby/", "/poker/table", "/poker/table/",
    "/lobby", "/lobby/", "/table", "/table/",
})
ROOT_PAGE_ROUTES = frozenset({"/lobby", "/lobby/", "/table", "/table/"})
COOKIE_NAME = "sitngo_session"
SESSION_TTL = 30 * 24 * 60 * 60
LOGIN_WINDOW = 15 * 60
LOGIN_LIMIT = 5
MAX_BODY = 16 * 1024
MAX_AVATAR_BYTES = 256 * 1024
MAX_FULL_AVATAR_BYTES = 1024 * 1024
MAX_AVATAR_BASE64 = 4 * ((MAX_AVATAR_BYTES + 2) // 3)
MAX_FULL_AVATAR_BASE64 = 4 * ((MAX_FULL_AVATAR_BYTES + 2) // 3)
MAX_AVATAR_BODY = MAX_AVATAR_BASE64 + MAX_FULL_AVATAR_BASE64 + 512
MAX_AVATAR_DIMENSION = 1024
MAX_AVATAR_PRESET_NAME = 32
CHAT_MAX_LENGTH = 500
CHAT_READ_LIMIT = 50
CHAT_TABLE_LIMIT = 100
CHAT_RATE_SECONDS = 1.0
REACTION_EMOJI_ALLOWLIST = (
    "👏", "❤️", "😂", "🔥", "😍", "😮", "🎉", "🙌", "♠️", "💎", "🦈", "🤝",
    "💩", "🤦", "👀", "😬", "🤔", "😎", "🙏", "💪", "🍀",
)
MAX_ADMIN_HISTORY_DELETE_IDS = 400
REACTION_RATE_SECONDS = 0.8
REACTION_LIFETIME_SECONDS = 8.0
REACTION_TABLE_LIMIT = 32
REACTION_READ_LIMIT = 32
MAX_ACTIVE_TABLES = 32
MAX_SESSIONS = 256
GLOBAL_LOGIN_LIMIT = 50
MAX_WORKERS = 32
ROOM_PASSWORD_ENV = "FELT_NIGHT_ROOM_PASSWORD"
ROOM_PASSWORD_FILE_ENV = "FELT_NIGHT_ROOM_PASSWORD_FILE"
ADMIN_USERNAME_ENV = "FELT_NIGHT_ADMIN_USERNAME"
MAX_ROOM_PASSWORD_LENGTH = 4096
ADMIN_END_CONFIRM_SECONDS = 60
ADMIN_PLAYER_PREFIX = "admin:"
DEFAULT_GLOBAL_CONFIG = {
    "runout_seconds": engine.RUNOUT_SECONDS,
    "blind_announcement_seconds": engine.BLIND_ANNOUNCEMENT_SECONDS,
    "elimination_announcement_seconds": engine.ELIMINATION_ANNOUNCEMENT_SECONDS,
    "showdown_seconds": engine.SHOWDOWN_SECONDS,
    "uncontested_seconds": engine.HAND_COMPLETE_PAUSE_SECONDS,
    "bet_presets": {
        "preflop_bb": [2.5, 3, 4],
        "postflop_percent": [50, 75, 100],
    },
}
_ADMIN_USERNAME_FROM_ENV = object()


class AppError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _invalid_avatar():
    raise AppError(
        400, "invalid_avatar",
        "Choose a PNG or JPEG image no larger than 256 KiB for its thumbnail or 1 MiB for its full image, with dimensions up to 1024 pixels per side.",
    )


def _check_avatar_dimensions(width, height):
    if (width < 1 or height < 1 or width > MAX_AVATAR_DIMENSION or
            height > MAX_AVATAR_DIMENSION or width * height > MAX_AVATAR_DIMENSION ** 2):
        _invalid_avatar()
    return width, height


def _png_avatar_dimensions(data):
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        _invalid_avatar()
    position = 8
    width = height = None
    saw_idat = False
    while position < len(data):
        if position + 12 > len(data):
            _invalid_avatar()
        chunk_length = int.from_bytes(data[position:position + 4], "big")
        chunk_end = position + 12 + chunk_length
        if chunk_end > len(data):
            _invalid_avatar()
        chunk_type = data[position + 4:position + 8]
        crc_start = position + 8 + chunk_length
        expected_crc = int.from_bytes(data[crc_start:chunk_end], "big")
        actual_crc = zlib.crc32(data[position + 4:crc_start]) & 0xffffffff
        if actual_crc != expected_crc:
            _invalid_avatar()

        if width is None:
            if chunk_type != b"IHDR" or chunk_length != 13:
                _invalid_avatar()
            chunk_data = data[position + 8:crc_start]
            width = int.from_bytes(chunk_data[0:4], "big")
            height = int.from_bytes(chunk_data[4:8], "big")
            bit_depth = chunk_data[8]
            color_type = chunk_data[9]
            allowed_depths = {
                0: (1, 2, 4, 8, 16),
                2: (8, 16),
                3: (1, 2, 4, 8),
                4: (8, 16),
                6: (8, 16),
            }
            if (color_type not in allowed_depths or
                    bit_depth not in allowed_depths[color_type] or
                    chunk_data[10] != 0 or chunk_data[11] != 0 or
                    chunk_data[12] not in (0, 1)):
                _invalid_avatar()
            _check_avatar_dimensions(width, height)
        elif chunk_type == b"IHDR":
            _invalid_avatar()

        if chunk_type == b"IDAT":
            saw_idat = True
        if chunk_type == b"IEND":
            if chunk_length != 0 or not saw_idat or chunk_end != len(data):
                _invalid_avatar()
            return _check_avatar_dimensions(width, height)
        position = chunk_end
    _invalid_avatar()


def _jpeg_avatar_dimensions(data):
    if (len(data) < 12 or not data.startswith(b"\xff\xd8\xff") or
            not data.endswith(b"\xff\xd9")):
        _invalid_avatar()
    sof_markers = {
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
        0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
    }
    position = 2
    dimensions = None
    while position < len(data) - 2:
        if data[position] != 0xff:
            _invalid_avatar()
        while position < len(data) and data[position] == 0xff:
            position += 1
        if position >= len(data) - 2:
            _invalid_avatar()
        marker = data[position]
        position += 1
        if marker == 0x00 or marker in (0xd8, 0xd9):
            _invalid_avatar()
        if marker == 0x01 or 0xd0 <= marker <= 0xd7:
            continue
        if position + 2 > len(data):
            _invalid_avatar()
        segment_length = int.from_bytes(data[position:position + 2], "big")
        segment_end = position + segment_length
        if segment_length < 2 or segment_end > len(data) - 2:
            _invalid_avatar()
        if marker in sof_markers:
            if segment_length < 8:
                _invalid_avatar()
            height = int.from_bytes(data[position + 3:position + 5], "big")
            width = int.from_bytes(data[position + 5:position + 7], "big")
            dimensions = _check_avatar_dimensions(width, height)
        if marker == 0xda:
            if dimensions is None or segment_length < 6 or segment_end >= len(data) - 2:
                _invalid_avatar()
            return dimensions
        position = segment_end
    _invalid_avatar()


def _validate_avatar_bytes(content_type, data, max_bytes=MAX_AVATAR_BYTES):
    if (content_type not in ("image/png", "image/jpeg") or
            not isinstance(data, bytes) or not data or len(data) > max_bytes):
        _invalid_avatar()
    if content_type == "image/png":
        _png_avatar_dimensions(data)
    else:
        _jpeg_avatar_dimensions(data)
    return content_type, data


def _decode_avatar_data_uri(value, max_bytes=MAX_AVATAR_BYTES):
    if value == "":
        return None, None
    if not isinstance(value, str):
        _invalid_avatar()
    prefixes = (
        ("image/png", "data:image/png;base64,"),
        ("image/jpeg", "data:image/jpeg;base64,"),
    )
    content_type = None
    encoded = None
    for candidate_type, prefix in prefixes:
        if value.startswith(prefix):
            content_type = candidate_type
            encoded = value[len(prefix):]
            break
    max_base64 = 4 * ((max_bytes + 2) // 3)
    if content_type is None or not encoded or len(encoded) > max_base64:
        _invalid_avatar()
    if len(encoded) % 4:
        _invalid_avatar()
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        _invalid_avatar()
    if base64.b64encode(data).decode("ascii") != encoded:
        _invalid_avatar()
    return _validate_avatar_bytes(content_type, data, max_bytes)


AVATAR_PRESET_MANIFEST = Path(__file__).parent / "static" / "avatar-presets.json"
AVATAR_PRESET_ID = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")


def _builtin_avatar_presets():
    try:
        manifest = json.loads(AVATAR_PRESET_MANIFEST.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        raise AppError(503, "avatar_presets_unavailable", "Avatar choices are temporarily unavailable.")
    rows = manifest.get("avatars") if isinstance(manifest, dict) else None
    if not isinstance(rows, list) or len(rows) > 100:
        raise AppError(503, "avatar_presets_unavailable", "Avatar choices are temporarily unavailable.")
    result = []
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            raise AppError(503, "avatar_presets_unavailable", "Avatar choices are temporarily unavailable.")
        preset_id = row.get("id")
        name = row.get("name")
        extension = "jpg" if isinstance(row.get("url"), str) and row["url"].endswith(".jpg") else "png"
        expected_url = "/poker/avatars/%s.%s" % (preset_id, extension)
        expected_full = "/poker/avatars/full/%s.%s" % (preset_id, extension)
        if (not isinstance(preset_id, str) or not AVATAR_PRESET_ID.fullmatch(preset_id)
                or preset_id in seen or not isinstance(name, str) or not name.strip()
                or row.get("url") != expected_url or row.get("full_url") != expected_full):
            raise AppError(503, "avatar_presets_unavailable", "Avatar choices are temporarily unavailable.")
        seen.add(preset_id)
        result.append({
            "id": preset_id, "name": name.strip(), "url": expected_url,
            "full_url": expected_full, "custom": False,
        })
    return result


def _builtin_avatar_path(preset_id, full=False):
    preset = next((item for item in _builtin_avatar_presets() if item["id"] == preset_id), None)
    if preset is None:
        raise AppError(404, "avatar_preset_not_found", "Avatar preset not found.")
    url = preset["full_url"] if full else preset["url"]
    relative = url.removeprefix("/poker/")
    static_root = (Path(__file__).parent / "static").resolve()
    candidate = (static_root / relative).resolve()
    try:
        candidate.relative_to(static_root)
    except ValueError:
        raise AppError(404, "avatar_preset_not_found", "Avatar preset not found.")
    if not candidate.is_file():
        raise AppError(404, "avatar_preset_not_found", "Avatar preset not found.")
    return candidate


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


def _validate_admin_username(value):
    if not isinstance(value, str):
        raise RuntimeError("admin username must be 3 to 24 letters, numbers, periods, underscores, or hyphens")
    username = value.strip().lower()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{2,23}", username):
        raise RuntimeError("admin username must be 3 to 24 letters, numbers, periods, underscores, or hyphens")
    return username


def _load_admin_username(environ=None):
    config = os.environ if environ is None else environ
    value = config.get(ADMIN_USERNAME_ENV)
    return None if value is None else _validate_admin_username(value)


def _validate_global_config(value, base=None):
    if not isinstance(value, dict):
        raise AppError(400, "invalid_admin_config", "Admin settings must be a JSON object.")
    allowed = {
        "runout_seconds", "blind_announcement_seconds",
        "elimination_announcement_seconds", "showdown_seconds", "uncontested_seconds", "bet_presets",
    }
    unknown = set(value) - allowed
    if unknown:
        raise AppError(400, "invalid_admin_config", "Unknown global setting.")
    result = copy.deepcopy(base if base is not None else DEFAULT_GLOBAL_CONFIG)
    for key, low, high in (
        ("runout_seconds", 1, engine.MAX_TIMER_SECONDS),
        ("blind_announcement_seconds", 0, 60),
        ("elimination_announcement_seconds", 0, 60),
        ("showdown_seconds", 0, 60),
        ("uncontested_seconds", 0, 60),
    ):
        if key not in value:
            continue
        setting = value[key]
        if (type(setting) not in (int, float) or not low <= setting <= high or
                not math.isfinite(setting)):
            raise AppError(400, "invalid_admin_config", "Invalid " + key + ".")
        result[key] = setting
    if "bet_presets" in value:
        presets = value["bet_presets"]
        if not isinstance(presets, dict) or set(presets) - {"preflop_bb", "postflop_percent"}:
            raise AppError(400, "invalid_admin_config", "Invalid shared bet presets.")
        updated = copy.deepcopy(result["bet_presets"])
        for key, minimum, maximum in (
            ("preflop_bb", 1, 200), ("postflop_percent", 1, 1000),
        ):
            if key not in presets:
                continue
            values = presets[key]
            if (not isinstance(values, (list, tuple)) or not 1 <= len(values) <= 5 or
                    any(type(item) not in (int, float) or not minimum <= item <= maximum or
                        not math.isfinite(item) for item in values) or
                    any(values[index] >= values[index + 1] for index in range(len(values) - 1))):
                raise AppError(400, "invalid_admin_config", "Invalid " + key + " presets.")
            updated[key] = list(values)
        result["bet_presets"] = updated
    return result


def _json_dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


class Store:
    def __init__(self, data_dir, room_password, admin_username=None):
        self.admin_username = admin_username
        self.admin_player_id = (
            ADMIN_PLAYER_PREFIX + admin_username if admin_username is not None else None
        )
        self.data_dir = os.path.abspath(data_dir)
        if os.path.lexists(self.data_dir) and os.path.islink(self.data_dir):
            raise RuntimeError("data directory may not be a symlink")
        os.makedirs(self.data_dir, mode=0o700, exist_ok=True)
        if not os.path.isdir(self.data_dir):
            raise RuntimeError("data directory is not a directory")
        os.chmod(self.data_dir, 0o700)
        self.db_path = os.path.join(self.data_dir, "sitngo.sqlite3")
        self._reaction_prune_lock = threading.Lock()
        self._last_reaction_prune = 0.0
        self._initialize(room_password)

    def connect(self):
        conn = sqlite3.connect(self.db_path, timeout=4.0, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=4000")
        # The service sandbox only permits writes inside data_dir; keep SQLite temp spills in memory.
        conn.execute("PRAGMA temp_store=MEMORY")
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
                CREATE TABLE IF NOT EXISTS player_avatars (
                    player_id TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
                    content_type TEXT NOT NULL CHECK(content_type IN ('image/png','image/jpeg')),
                    image_data BLOB NOT NULL CHECK(length(image_data) BETWEEN 1 AND 262144),
                    sha256 TEXT NOT NULL CHECK(length(sha256)=64),
                    updated REAL NOT NULL,
                    full_content_type TEXT CHECK(full_content_type IN ('image/png','image/jpeg')),
                    full_image_data BLOB CHECK(full_image_data IS NULL OR length(full_image_data) BETWEEN 1 AND 1048576),
                    full_sha256 TEXT CHECK(full_sha256 IS NULL OR length(full_sha256)=64)
                );
                CREATE TABLE IF NOT EXISTS custom_avatar_presets (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    content_type TEXT NOT NULL CHECK(content_type IN ('image/png','image/jpeg')),
                    image_data BLOB NOT NULL CHECK(length(image_data) BETWEEN 1 AND 262144),
                    sha256 TEXT NOT NULL CHECK(length(sha256)=64),
                    full_content_type TEXT NOT NULL CHECK(full_content_type IN ('image/png','image/jpeg')),
                    full_image_data BLOB NOT NULL CHECK(length(full_image_data) BETWEEN 1 AND 1048576),
                    full_sha256 TEXT NOT NULL CHECK(length(full_sha256)=64),
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
                CREATE TABLE IF NOT EXISTS end_confirmations (
                    token_hash TEXT PRIMARY KEY,
                    table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
                    host_id TEXT NOT NULL,
                    expires REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS end_confirmations_expiry ON end_confirmations(expires);
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
                CREATE TABLE IF NOT EXISTS table_reactions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
                    player_id TEXT NOT NULL REFERENCES players(id),
                    seat_no INTEGER NOT NULL CHECK (seat_no BETWEEN 0 AND 8),
                    emoji TEXT NOT NULL,
                    created_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS table_reactions_table_order
                    ON table_reactions(table_id, id DESC);
                CREATE INDEX IF NOT EXISTS table_reactions_player_order
                    ON table_reactions(player_id, id DESC);
                CREATE TABLE IF NOT EXISTS login_attempts (
                    client_key TEXT NOT NULL,
                    attempted REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS login_attempts_recent
                    ON login_attempts(client_key, attempted);
            """)
            avatar_columns = {row["name"] for row in conn.execute("PRAGMA table_info(player_avatars)")}
            for column, declaration in (
                ("full_content_type", "TEXT"),
                ("full_image_data", "BLOB"),
                ("full_sha256", "TEXT"),
            ):
                if column not in avatar_columns:
                    conn.execute("ALTER TABLE player_avatars ADD COLUMN %s %s" % (column, declaration))
            tournament_history.create_schema(conn)
            global_row = conn.execute(
                "SELECT value FROM meta WHERE key='global_config'"
            ).fetchone()
            if global_row is None:
                conn.execute(
                    "INSERT INTO meta(key,value) VALUES('global_config',?)",
                    (_json_dumps(DEFAULT_GLOBAL_CONFIG),),
                )
            else:
                try:
                    stored_global_config = json.loads(global_row["value"])
                    _validate_global_config(stored_global_config)
                except (ValueError, TypeError, AppError) as exc:
                    raise RuntimeError("stored global settings are invalid") from exc
            if self.admin_username is None:
                conn.execute(
                    "DELETE FROM sessions WHERE player_id LIKE ?",
                    (ADMIN_PLAYER_PREFIX + "%",),
                )
            else:
                if conn.execute(
                    "SELECT 1 FROM accounts WHERE username=?", (self.admin_username,),
                ).fetchone():
                    raise RuntimeError("configured admin username is already registered")
                conn.execute(
                    "DELETE FROM sessions WHERE player_id LIKE ? AND player_id<>?",
                    (ADMIN_PLAYER_PREFIX + "%", self.admin_player_id),
                )
                conn.execute(
                    "INSERT OR IGNORE INTO players(id,name,created) VALUES(?,?,?)",
                    (self.admin_player_id, self.admin_username, time.time()),
                )
                conn.execute(
                    "UPDATE players SET name=? WHERE id=?",
                    (self.admin_username, self.admin_player_id),
                )
            history_marker = conn.execute(
                "SELECT value FROM meta WHERE key='history_backfill_v1'"
            ).fetchone()
            history_text_marker = conn.execute(
                "SELECT value FROM meta WHERE key='history_text_metadata_v1'"
            ).fetchone()
            if history_marker is None or history_text_marker is None:
                conn.execute("BEGIN IMMEDIATE")
                try:
                    history_marker = conn.execute(
                        "SELECT value FROM meta WHERE key='history_backfill_v1'"
                    ).fetchone()
                    history_text_marker = conn.execute(
                        "SELECT value FROM meta WHERE key='history_text_metadata_v1'"
                    ).fetchone()
                    if history_marker is None or history_text_marker is None:
                        # Refresh from retained table snapshots to fill additive history
                        # metadata even when the original backfill already ran.
                        tournament_history.backfill_tournaments(conn)
                        if history_marker is None:
                            conn.execute(
                                "INSERT INTO meta(key,value) VALUES('history_backfill_v1','1')"
                            )
                        if history_text_marker is None:
                            conn.execute(
                                "INSERT INTO meta(key,value) VALUES('history_text_metadata_v1','1')"
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
                """SELECT s.token_hash,s.player_id,s.expires,p.name,
                          a.username AS account_username,a.display_name AS account_name
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
            is_admin = self.admin_player_id is not None and row["player_id"] == self.admin_player_id
            has_account = row["account_name"] is not None or is_admin
            return {
                "id": row["player_id"],
                "name": self.admin_username if is_admin else row["name"],
                "username": self.admin_username if is_admin else row["account_username"],
                "display_name": self.admin_username if is_admin else row["account_name"],
                "account": has_account,
                "needs_claim": not has_account,
                "is_admin": is_admin,
            }
        finally:
            conn.close()

    def avatar_urls(self, player_ids):
        requested = [player_id for player_id in player_ids if isinstance(player_id, str)]
        urls = {player_id: "" for player_id in requested}
        valid_ids = [player_id for player_id in dict.fromkeys(requested)
                     if re.fullmatch(r"[a-f0-9]{32}", player_id)]
        if not valid_ids:
            return urls
        placeholders = ",".join("?" for _ in valid_ids)
        conn = self.connect()
        try:
            rows = conn.execute(
                "SELECT player_id,sha256 FROM player_avatars WHERE player_id IN (%s)" % placeholders,
                tuple(valid_ids),
            ).fetchall()
            for row in rows:
                urls[row["player_id"]] = (
                    "/poker/api/players/%s/avatar?v=%s" %
                    (row["player_id"], row["sha256"])
                )
            return urls
        finally:
            conn.close()

    def avatar_full_urls(self, player_ids):
        requested = [player_id for player_id in player_ids if isinstance(player_id, str)]
        urls = {player_id: "" for player_id in requested}
        valid_ids = [player_id for player_id in dict.fromkeys(requested)
                     if re.fullmatch(r"[a-f0-9]{32}", player_id)]
        if not valid_ids:
            return urls
        placeholders = ",".join("?" for _ in valid_ids)
        conn = self.connect()
        try:
            rows = conn.execute(
                "SELECT player_id,full_sha256 FROM player_avatars WHERE player_id IN (%s)" % placeholders,
                tuple(valid_ids),
            ).fetchall()
            for row in rows:
                if row["full_sha256"]:
                    urls[row["player_id"]] = (
                        "/poker/api/players/%s/avatar/full?v=%s" %
                        (row["player_id"], row["full_sha256"])
                    )
            return urls
        finally:
            conn.close()

    def has_player_avatar(self, player_id):
        conn = self.connect()
        try:
            return conn.execute(
                "SELECT 1 FROM player_avatars WHERE player_id=?", (player_id,),
            ).fetchone() is not None
        finally:
            conn.close()

    def get_player_avatar(self, player_id, full=False):
        conn = self.connect()
        try:
            if full:
                row = conn.execute(
                    """SELECT full_content_type AS content_type,
                              full_image_data AS image_data,full_sha256 AS sha256
                       FROM player_avatars WHERE player_id=?""",
                    (player_id,),
                ).fetchone()
            else:
                row = conn.execute(
                    "SELECT content_type,image_data,sha256 FROM player_avatars WHERE player_id=?",
                    (player_id,),
                ).fetchone()
            if row is None or row["image_data"] is None:
                return None
            return {
                "content_type": row["content_type"],
                "image_data": bytes(row["image_data"]),
                "sha256": row["sha256"],
            }
        finally:
            conn.close()

    def set_player_avatar(self, player_id, content_type, image_data,
                          full_content_type, full_image_data, now):
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            if conn.execute("SELECT 1 FROM players WHERE id=?", (player_id,)).fetchone() is None:
                raise AppError(404, "player_not_found", "Player not found.")
            if not image_data:
                raise AppError(409, "profile_photo_required",
                               "Choose a replacement profile photo. Photos cannot be removed.")
            digest = hashlib.sha256(image_data).hexdigest()
            full_digest = hashlib.sha256(full_image_data).hexdigest() if full_image_data else None
            conn.execute(
                """INSERT INTO player_avatars
                   (player_id,content_type,image_data,sha256,updated,
                    full_content_type,full_image_data,full_sha256)
                   VALUES(?,?,?,?,?,?,?,?)
                   ON CONFLICT(player_id) DO UPDATE SET
                       content_type=excluded.content_type,
                       image_data=excluded.image_data,
                       sha256=excluded.sha256,
                       updated=excluded.updated,
                       full_content_type=excluded.full_content_type,
                       full_image_data=excluded.full_image_data,
                       full_sha256=excluded.full_sha256""",
                (player_id, content_type, sqlite3.Binary(image_data), digest, now,
                 full_content_type,
                 sqlite3.Binary(full_image_data) if full_image_data else None,
                 full_digest),
            )
            avatar_url = "/poker/api/players/%s/avatar?v=%s" % (player_id, digest)
            avatar_full_url = (
                "/poker/api/players/%s/avatar/full?v=%s" % (player_id, full_digest)
                if full_digest else ""
            )
            conn.commit()
            return avatar_url, avatar_full_url
        except Exception:
            if conn.in_transaction:
                conn.rollback()
            raise
        finally:
            conn.close()

    def add_custom_avatar_preset(self, name, content_type, image_data,
                                 full_content_type, full_image_data, now):
        preset_id = uuid.uuid4().hex
        digest = hashlib.sha256(image_data).hexdigest()
        full_digest = hashlib.sha256(full_image_data).hexdigest()
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.execute(
                    """INSERT INTO custom_avatar_presets
                       (id,name,content_type,image_data,sha256,full_content_type,
                        full_image_data,full_sha256,created)
                       VALUES(?,?,?,?,?,?,?,?,?)""",
                    (preset_id, name, content_type, sqlite3.Binary(image_data), digest,
                     full_content_type, sqlite3.Binary(full_image_data), full_digest, now),
                )
            except sqlite3.IntegrityError as exc:
                if conn.execute(
                    "SELECT 1 FROM custom_avatar_presets WHERE name=? COLLATE NOCASE",
                    (name,),
                ).fetchone():
                    raise AppError(409, "avatar_preset_name_taken",
                                   "That avatar choice name is already in use.") from exc
                raise
            conn.commit()
            return {
                "id": preset_id, "name": name,
                "url": "/poker/api/avatar-presets/%s/thumbnail?v=%s" % (preset_id, digest),
                "full_url": "/poker/api/avatar-presets/%s/full?v=%s" % (preset_id, full_digest),
                "custom": True,
            }
        except Exception:
            if conn.in_transaction:
                conn.rollback()
            raise
        finally:
            conn.close()

    def avatar_preset_catalog(self):
        catalog = _builtin_avatar_presets()
        conn = self.connect()
        try:
            rows = conn.execute(
                """SELECT id,name,sha256,full_sha256 FROM custom_avatar_presets
                   ORDER BY created,id""",
            ).fetchall()
            catalog.extend({
                "id": row["id"],
                "name": row["name"],
                "url": "/poker/api/avatar-presets/%s/thumbnail?v=%s" %
                       (row["id"], row["sha256"]),
                "full_url": "/poker/api/avatar-presets/%s/full?v=%s" %
                            (row["id"], row["full_sha256"]),
                "custom": True,
            } for row in rows)
            return catalog
        finally:
            conn.close()

    def get_custom_avatar_preset(self, preset_id, full=False):
        conn = self.connect()
        try:
            if full:
                row = conn.execute(
                    """SELECT full_content_type AS content_type,
                              full_image_data AS image_data,full_sha256 AS sha256
                       FROM custom_avatar_presets WHERE id=?""",
                    (preset_id,),
                ).fetchone()
            else:
                row = conn.execute(
                    "SELECT content_type,image_data,sha256 FROM custom_avatar_presets WHERE id=?",
                    (preset_id,),
                ).fetchone()
            if row is None:
                return None
            return {
                "content_type": row["content_type"],
                "image_data": bytes(row["image_data"]),
                "sha256": row["sha256"],
            }
        finally:
            conn.close()

    def get_avatar_preset_image(self, preset_id, full=False):
        builtin = next((item for item in _builtin_avatar_presets()
                        if item["id"] == preset_id), None)
        if builtin is not None:
            path = _builtin_avatar_path(preset_id, full=full)
            content_type = "image/jpeg" if path.suffix.lower() in (".jpg", ".jpeg") else "image/png"
            image_data = path.read_bytes()
            max_bytes = MAX_FULL_AVATAR_BYTES if full else MAX_AVATAR_BYTES
            content_type, image_data = _validate_avatar_bytes(
                content_type, image_data, max_bytes,
            )
            return {"content_type": content_type, "image_data": image_data}
        stored = self.get_custom_avatar_preset(preset_id, full=full)
        if stored is None:
            return None
        content_type, image_data = _validate_avatar_bytes(
            stored["content_type"], stored["image_data"],
            MAX_FULL_AVATAR_BYTES if full else MAX_AVATAR_BYTES,
        )
        return {"content_type": content_type, "image_data": image_data}

    def has_avatar_preset(self, preset_id):
        if not isinstance(preset_id, str) or not AVATAR_PRESET_ID.fullmatch(preset_id):
            return False
        if any(item["id"] == preset_id for item in _builtin_avatar_presets()):
            return True
        conn = self.connect()
        try:
            return conn.execute(
                "SELECT 1 FROM custom_avatar_presets WHERE id=?", (preset_id,),
            ).fetchone() is not None
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
    def _account_player(player_id, username, display_name):
        return {
            "id": player_id,
            "name": display_name,
            "display_name": display_name,
            "username": username,
            "account": True,
            "needs_claim": False,
            "is_admin": False,
        }

    def _admin_player(self):
        return {
            "id": self.admin_player_id,
            "name": self.admin_username,
            "display_name": self.admin_username,
            "username": self.admin_username,
            "account": True,
            "needs_claim": False,
            "is_admin": True,
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
        if self.admin_username is not None and username == self.admin_username:
            raise AppError(409, "username_reserved", "That username is reserved for the room admin.")
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
            return self._account_player(player_id, username, display_name), token
        except Exception:
            if conn.in_transaction:
                conn.rollback()
            raise
        finally:
            conn.close()

    def update_account_profile(self, player_id, username, display_name,
                               new_password, current_password, now):
        if (username is not None or new_password is not None) and current_password is None:
            raise AppError(400, "current_password_required",
                           "Enter your current password to change account credentials.")
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                """SELECT username,display_name,password_salt,password_verifier
                   FROM accounts WHERE player_id=?""",
                (player_id,),
            ).fetchone()
            if row is None:
                raise AppError(403, "account_required", "Create or claim a personal account first.")
            if current_password is not None:
                try:
                    salt = bytes.fromhex(row["password_salt"])
                except ValueError:
                    salt = bytes(16)
                candidate = self._password_verifier(current_password, salt)
                if not hmac.compare_digest(candidate, row["password_verifier"]):
                    raise AppError(403, "invalid_current_password", "Current password is incorrect.")
            target_username = row["username"] if username is None else username
            target_display = row["display_name"] if display_name is None else display_name
            if self.admin_username is not None and target_username == self.admin_username:
                raise AppError(409, "username_reserved", "That username is reserved for the room admin.")
            if target_username != row["username"] and conn.execute(
                "SELECT 1 FROM accounts WHERE username=?", (target_username,),
            ).fetchone():
                raise AppError(409, "username_taken", "That username is already registered.")
            if new_password is None:
                conn.execute(
                    "UPDATE accounts SET username=?,display_name=? WHERE player_id=?",
                    (target_username, target_display, player_id),
                )
            else:
                salt = secrets.token_bytes(16)
                verifier = self._password_verifier(new_password, salt)
                conn.execute(
                    """UPDATE accounts SET username=?,display_name=?,
                              password_salt=?,password_verifier=? WHERE player_id=?""",
                    (target_username, target_display, salt.hex(), verifier, player_id),
                )
            conn.execute("UPDATE players SET name=? WHERE id=?", (target_display, player_id))
            conn.commit()
            return self._account_player(player_id, target_username, target_display)
        except Exception:
            if conn.in_transaction:
                conn.rollback()
            raise
        finally:
            conn.close()

    def login_admin(self, now):
        if self.admin_username is None or self.admin_player_id is None:
            return None
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            player = conn.execute(
                "SELECT 1 FROM players WHERE id=?", (self.admin_player_id,),
            ).fetchone()
            if player is None:
                return None
            token = self._issue_session(conn, self.admin_player_id, now)
            conn.commit()
            return self._admin_player(), token
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
                """SELECT a.player_id,a.username,a.display_name,a.password_salt,a.password_verifier
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
            player = self._account_player(player_id, row["username"], row["display_name"])
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

    @staticmethod
    def _global_config_from_conn(conn):
        row = conn.execute(
            "SELECT value FROM meta WHERE key='global_config'",
        ).fetchone()
        if row is None:
            return copy.deepcopy(DEFAULT_GLOBAL_CONFIG)
        try:
            return _validate_global_config(json.loads(row["value"]))
        except (TypeError, ValueError, AppError) as exc:
            raise RuntimeError("stored global settings are invalid") from exc

    def get_global_config(self):
        conn = self.connect()
        try:
            return self._global_config_from_conn(conn)
        finally:
            conn.close()

    def update_global_config(self, changes, now):
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            current = self._global_config_from_conn(conn)
            updated = _validate_global_config(changes, current)
            conn.execute(
                "INSERT OR REPLACE INTO meta(key,value) VALUES('global_config',?)",
                (_json_dumps(updated),),
            )
            timings = {
                key: updated[key] for key in (
                    "runout_seconds", "blind_announcement_seconds",
                    "elimination_announcement_seconds", "showdown_seconds", "uncontested_seconds",
                )
            }
            rows = conn.execute(
                "SELECT id,state FROM tables WHERE json_extract(state,'$.status') IN ('lobby','playing')"
            ).fetchall()
            for row in rows:
                state = json.loads(row["state"])
                table_config = state.setdefault("config", {})
                table_config.update(timings)
                conn.execute(
                    "UPDATE tables SET state=?,updated=? WHERE id=?",
                    (_json_dumps(state), now, row["id"]),
                )
            conn.commit()
            return updated
        except Exception:
            if conn.in_transaction:
                conn.rollback()
            raise
        finally:
            conn.close()

    def create_table(self, owner, owner_name, table_name, config, now):
        table_id = uuid.uuid4().hex
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            if not owner.get("is_admin") and conn.execute(
                "SELECT 1 FROM player_avatars WHERE player_id=?", (owner["id"],),
            ).fetchone() is None:
                raise AppError(409, "profile_photo_required",
                               "Add a profile photo before creating a table.")
            global_config = self._global_config_from_conn(conn)
            table_config = dict(config)
            table_config["max_seats"] = engine.MAX_SEATS
            for key in (
                "runout_seconds", "blind_announcement_seconds",
                "elimination_announcement_seconds", "showdown_seconds", "uncontested_seconds",
            ):
                table_config[key] = global_config[key]
            state = engine.create_lobby(table_id, owner["id"], owner_name, table_config, now)
            state["name"] = table_name
            count = conn.execute(
                "SELECT COUNT(*) AS n FROM tables WHERE json_extract(state,'$.status') IN ('lobby','playing')"
            ).fetchone()["n"]
            if count >= MAX_ACTIVE_TABLES:
                raise AppError(503, "capacity", "The app is at its active table limit.")
            conn.execute(
                "INSERT INTO tables(id,owner_id,state,created,updated) VALUES(?,?,?,?,?)",
                (table_id, owner["id"], _json_dumps(state), now, now),
            )
            tournament_history.record_table_created(conn, state, owner["id"], now)
            conn.commit()
            return state
        except Exception:
            if conn.in_transaction:
                conn.rollback()
            raise
        finally:
            conn.close()

    def request_end_confirmation(self, table_id, host_id, now):
        token = secrets.token_urlsafe(32)
        expires = now + ADMIN_END_CONFIRM_SECONDS
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT state FROM tables WHERE id=?", (table_id,)).fetchone()
            if row is None:
                raise AppError(404, "table_not_found", "Table not found.")
            state = json.loads(row["state"])
            if state.get("host_id") != host_id:
                raise engine.GameError("host_only", "Only the table host can end this tournament.", 403)
            if state.get("status") not in ("lobby", "playing"):
                raise engine.GameError("table_not_active", "Only an active lobby or tournament can be ended.", 409)
            conn.execute("DELETE FROM end_confirmations WHERE expires<=?", (now,))
            conn.execute("DELETE FROM end_confirmations WHERE table_id=?", (table_id,))
            conn.execute(
                "INSERT INTO end_confirmations(token_hash,table_id,host_id,expires) VALUES(?,?,?,?)",
                (self.hash_token(token), table_id, host_id, expires),
            )
            conn.commit()
            return token, expires
        except Exception:
            if conn.in_transaction:
                conn.rollback()
            raise
        finally:
            conn.close()

    def end_table_with_confirmation(self, table_id, host_id, token, now):
        if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{40,64}", token):
            raise AppError(400, "invalid_confirmation", "Confirm this table end again.")
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT state FROM tables WHERE id=?", (table_id,)).fetchone()
            if row is None:
                raise AppError(404, "table_not_found", "Table not found.")
            confirmation = conn.execute(
                "SELECT table_id,host_id,expires FROM end_confirmations WHERE token_hash=?",
                (self.hash_token(token),),
            ).fetchone()
            if (confirmation is None or confirmation["table_id"] != table_id or
                    confirmation["host_id"] != host_id or confirmation["expires"] <= now):
                raise AppError(403, "invalid_confirmation", "Confirm this table end again.")
            original = json.loads(row["state"])
            if original.get("host_id") != host_id:
                raise engine.GameError("host_only", "Only the table host can end this tournament.", 403)
            previous = copy.deepcopy(original)
            advanced = engine.advance(original, now)
            advanced_snapshot = copy.deepcopy(advanced)
            state = engine.end_tournament(copy.deepcopy(advanced), host_id, now)
            conn.execute("DELETE FROM end_confirmations WHERE table_id=?", (table_id,))
            final_json = _json_dumps(state)
            if final_json != row["state"]:
                conn.execute(
                    "UPDATE tables SET state=?,updated=? WHERE id=?",
                    (final_json, now, table_id),
                )
            tournament_history.sync_state(conn, previous, now)
            if _json_dumps(advanced_snapshot) != row["state"]:
                tournament_history.sync_state(conn, advanced_snapshot, now)
            tournament_history.sync_state(conn, state, now)
            conn.commit()
            return state
        except Exception:
            if conn.in_transaction:
                conn.rollback()
            raise
        finally:
            conn.close()

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

    def add_table_reaction(self, table_id, player_id, emoji, now):
        if emoji not in REACTION_EMOJI_ALLOWLIST:
            raise AppError(400, "invalid_reaction", "Choose a table reaction.")
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT state FROM tables WHERE id=?", (table_id,)).fetchone()
            if row is None:
                conn.rollback()
                raise AppError(404, "table_not_found", "Table not found.")
            state = json.loads(row["state"])
            seat = next(
                (item for item in state.get("seats", [])
                 if item.get("player_id") == player_id),
                None,
            )
            if seat is None:
                conn.rollback()
                raise AppError(403, "not_seated", "Take a seat before sending a reaction.")

            previous = conn.execute(
                "SELECT created_at FROM table_reactions WHERE player_id=? ORDER BY id DESC LIMIT 1",
                (player_id,),
            ).fetchone()
            if previous is not None and now - previous["created_at"] < REACTION_RATE_SECONDS:
                conn.rollback()
                raise AppError(429, "reaction_rate_limited", "Please wait before sending another reaction.")

            seat_no = seat.get("seat_no")
            if type(seat_no) is not int or not 0 <= seat_no < 9:
                conn.rollback()
                raise AppError(409, "seat_unavailable", "Your table seat is no longer available.")
            cursor = conn.execute(
                "INSERT INTO table_reactions(table_id,player_id,seat_no,emoji,created_at) VALUES(?,?,?,?,?)",
                (table_id, player_id, seat_no, emoji, now),
            )
            reaction_id = cursor.lastrowid
            conn.execute(
                "DELETE FROM table_reactions WHERE created_at < ?",
                (now - REACTION_LIFETIME_SECONDS,),
            )
            conn.execute(
                """DELETE FROM table_reactions
                   WHERE table_id=? AND id NOT IN (
                       SELECT id FROM table_reactions
                       WHERE table_id=? ORDER BY id DESC LIMIT ?
                   )""",
                (table_id, table_id, REACTION_TABLE_LIMIT),
            )
            conn.commit()
            return {
                "id": reaction_id,
                "player_id": player_id,
                "seat_no": seat_no,
                "emoji": emoji,
                "created_at": now,
            }
        except Exception:
            if conn.in_transaction:
                conn.rollback()
            raise
        finally:
            conn.close()

    def list_table_reactions(self, table_id, after, now):
        conn = self.connect()
        try:
            exists = conn.execute("SELECT 1 FROM tables WHERE id=?", (table_id,)).fetchone()
            if exists is None:
                raise AppError(404, "table_not_found", "Table not found.")
            current = conn.execute(
                "SELECT COALESCE(MAX(id), 0) AS cursor FROM table_reactions WHERE table_id=?",
                (table_id,),
            ).fetchone()["cursor"]
            if after is None:
                rows = []
            else:
                rows = conn.execute(
                    """SELECT id, player_id, seat_no, emoji, created_at FROM table_reactions
                       WHERE table_id=? AND id>? AND created_at>=?
                       ORDER BY id ASC LIMIT ?""",
                    (table_id, after, now - REACTION_LIFETIME_SECONDS, REACTION_READ_LIMIT),
                ).fetchall()
            return {
                "reactions": [
                    {"id": row["id"], "player_id": row["player_id"],
                     "seat_no": row["seat_no"], "emoji": row["emoji"],
                     "created_at": row["created_at"]}
                    for row in rows
                ],
                "cursor": current,
            }
        finally:
            conn.close()

    def prune_expired_table_reactions(self, now):
        with self._reaction_prune_lock:
            if now - self._last_reaction_prune < REACTION_LIFETIME_SECONDS:
                return
            conn = self.connect()
            try:
                conn.execute(
                    "DELETE FROM table_reactions WHERE created_at < ?",
                    (now - REACTION_LIFETIME_SECONDS,),
                )
                self._last_reaction_prune = now
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

    def list_admin_history(self, offset=0):
        conn = self.connect()
        try:
            return tournament_history.list_for_admin(conn, offset)
        finally:
            conn.close()

    def get_admin_history(self, table_id, offset=0):
        conn = self.connect()
        try:
            detail = tournament_history.get_for_admin(conn, table_id, offset)
            if detail is not None and detail["tournament"]["status"] not in tournament_history.TERMINAL_STATUSES:
                raise AppError(409, "game_active", "Only terminal saved games are in admin history.")
            return detail
        finally:
            conn.close()

    def delete_admin_history(self, table_id):
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            table_row = conn.execute(
                "SELECT state FROM tables WHERE id=?", (table_id,),
            ).fetchone()
            history_row = conn.execute(
                "SELECT name,status FROM tournament_history WHERE table_id=?",
                (table_id,),
            ).fetchone()
            if table_row is None and history_row is None:
                raise AppError(404, "history_not_found", "Past game not found.")
            if table_row is not None:
                state = json.loads(table_row["state"])
                status = state.get("status")
                name = str(state.get("name") or (
                    history_row["name"] if history_row is not None else "Tournament"
                ))
            else:
                state = None
                status = history_row["status"]
                name = history_row["name"]
            if status not in tournament_history.TERMINAL_STATUSES:
                raise AppError(
                    409, "game_active",
                    "Only completed, ended, cancelled, or expired games can be deleted.",
                )
            conn.execute("DELETE FROM chat_messages WHERE table_id=?", (table_id,))
            conn.execute("DELETE FROM table_reactions WHERE table_id=?", (table_id,))
            conn.execute("DELETE FROM end_confirmations WHERE table_id=?", (table_id,))
            tournament_history.delete_tournament_history(conn, table_id)
            conn.execute("DELETE FROM tables WHERE id=?", (table_id,))
            conn.commit()
            return {"deleted": True, "id": table_id, "name": name, "status": status}
        except Exception:
            if conn.in_transaction:
                conn.rollback()
            raise
        finally:
            conn.close()

    def delete_admin_history_bulk(self, table_ids):
        if (
            not isinstance(table_ids, list)
            or not table_ids
            or len(table_ids) > MAX_ADMIN_HISTORY_DELETE_IDS
            or any(not isinstance(table_id, str) or not re.fullmatch(r"[a-f0-9]{32}", table_id)
                   for table_id in table_ids)
            or len(set(table_ids)) != len(table_ids)
        ):
            raise AppError(
                400, "invalid_history_ids",
                "Choose between 1 and %d unique past games." % MAX_ADMIN_HISTORY_DELETE_IDS,
            )

        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            targets = []
            for table_id in table_ids:
                table_row = conn.execute(
                    "SELECT state FROM tables WHERE id=?", (table_id,),
                ).fetchone()
                history_row = conn.execute(
                    "SELECT name,status FROM tournament_history WHERE table_id=?",
                    (table_id,),
                ).fetchone()
                if table_row is None and history_row is None:
                    raise AppError(404, "history_not_found", "One or more selected past games were not found.")
                if table_row is not None:
                    state = json.loads(table_row["state"])
                    status = state.get("status")
                    name = str(state.get("name") or (
                        history_row["name"] if history_row is not None else "Tournament"
                    ))
                else:
                    status = history_row["status"]
                    name = history_row["name"]
                if status not in tournament_history.TERMINAL_STATUSES:
                    raise AppError(
                        409, "game_active",
                        "Only completed, ended, cancelled, or expired games can be deleted.",
                    )
                targets.append((table_id, name, status))

            for table_id, _name, _status in targets:
                conn.execute("DELETE FROM chat_messages WHERE table_id=?", (table_id,))
                conn.execute("DELETE FROM table_reactions WHERE table_id=?", (table_id,))
                conn.execute("DELETE FROM end_confirmations WHERE table_id=?", (table_id,))
                tournament_history.delete_tournament_history(conn, table_id)
                conn.execute("DELETE FROM tables WHERE id=?", (table_id,))
            conn.commit()
            ids = [item[0] for item in targets]
            return {"deleted": True, "deleted_count": len(ids), "ids": ids}
        except Exception:
            if conn.in_transaction:
                conn.rollback()
            raise
        finally:
            conn.close()

    def get_last_hand(self, table_id, player_id, hand_number=None):
        conn = self.connect()
        try:
            exists = conn.execute("SELECT 1 FROM tables WHERE id=?", (table_id,)).fetchone()
            if exists is None:
                raise AppError(404, "table_not_found", "Table not found.")
            return tournament_history.last_completed_hand(
                conn, table_id, player_id, hand_number,
            )
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
        if not parsed.path.startswith(BASE_PATH) and parsed.path not in ROOT_PAGE_ROUTES:
            raise AppError(404, "not_found", "Not found.")
        if parsed.fragment:
            raise AppError(400, "invalid_url", "Fragments are not supported.")
        self.request_offset = 0
        self.request_hand_number = None
        self.reaction_after = None
        self.avatar_version = None
        avatar_route = re.fullmatch(
            r"/poker/api/players/([a-f0-9]{32})/avatar(?:/(full))?", parsed.path,
        )
        preset_image_route = re.fullmatch(
            r"/poker/api/avatar-presets/([a-f0-9]{32})/(thumbnail|full)", parsed.path,
        )
        if parsed.query:
            page_route = self.command == "GET" and parsed.path in PAGE_ROUTES
            history_route = (
                parsed.path == "/poker/api/history"
                or re.fullmatch(r"/poker/api/history/[a-f0-9]{32}", parsed.path)
                or parsed.path == "/poker/api/admin/history"
                or re.fullmatch(r"/poker/api/admin/history/[a-f0-9]{32}", parsed.path)
            )
            reaction_route = re.fullmatch(
                r"/poker/api/tables/[a-f0-9]{32}/reactions", parsed.path,
            )
            last_hand_route = re.fullmatch(
                r"/poker/api/tables/[a-f0-9]{32}/last-hand", parsed.path,
            )
            if self.command != "GET" or not (
                page_route or history_route or reaction_route or last_hand_route
                or avatar_route or preset_image_route
            ):
                raise AppError(400, "invalid_url", "Query strings are not supported here.")
            if not page_route:
                try:
                    query = parse_qs(parsed.query, strict_parsing=True, keep_blank_values=True)
                except ValueError as exc:
                    raise AppError(400, "invalid_url", "Invalid request cursor.") from exc
                if reaction_route:
                    if set(query) != {"after"} or len(query["after"]) != 1:
                        raise AppError(400, "invalid_url", "Use one numeric reaction cursor.")
                    raw_after = query["after"][0]
                    if not re.fullmatch(r"[0-9]{1,12}", raw_after):
                        raise AppError(400, "invalid_url", "Invalid reaction cursor.")
                    self.reaction_after = int(raw_after)
                elif last_hand_route:
                    if set(query) != {"number"} or len(query["number"]) != 1:
                        raise AppError(400, "invalid_url", "Use one positive hand number.")
                    raw_number = query["number"][0]
                    if not re.fullmatch(r"[1-9][0-9]{0,8}", raw_number):
                        raise AppError(400, "invalid_url", "Invalid hand number.")
                    self.request_hand_number = int(raw_number)
                elif avatar_route or preset_image_route:
                    if set(query) != {"v"} or len(query["v"]) != 1:
                        raise AppError(400, "invalid_url", "Use one avatar version.")
                    version = query["v"][0]
                    if not re.fullmatch(r"[a-f0-9]{64}", version):
                        raise AppError(400, "invalid_url", "Invalid avatar version.")
                    self.avatar_version = version
                else:
                    if set(query) != {"offset"} or len(query["offset"]) != 1:
                        raise AppError(400, "invalid_url", "Use one numeric history offset.")
                    raw_offset = query["offset"][0]
                    if not re.fullmatch(r"[0-9]{1,9}", raw_offset):
                        raise AppError(400, "invalid_url", "Invalid history offset.")
                    self.request_offset = int(raw_offset)
        elif avatar_route or preset_image_route:
            raise AppError(400, "invalid_url", "Avatar URLs require a version.")
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
            if sep and name.strip() == self.app.cookie_name:
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
        player = self.app.store.authenticate(cookie_token)
        if player and player.get("is_admin") and not self.app.allow_admin:
            return None
        return player, cookie_token

    def _require_player(self, require_account=True):
        session = self._player()
        if not session or not session[0]:
            raise AppError(401, "authentication_required", "Please sign in.")
        if require_account and not session[0].get("account"):
            raise AppError(403, "account_required", "Create or claim a personal account to continue.")
        return session[0], session[1]

    def _require_admin(self):
        player, token = self._require_player()
        if not player.get("is_admin"):
            raise AppError(403, "admin_required", "Room admin access is required.")
        return player, token

    def _require_csrf(self, token):
        received = self.headers.get("X-SitNgo-CSRF", "")
        expected = self.app.store.csrf_token(token)
        if not received or not hmac.compare_digest(received, expected):
            raise AppError(403, "csrf_failed", "Security token expired. Refresh and try again.")

    def _player_payload(self, player):
        payload = dict(player)
        player_id = payload.get("id")
        payload["avatar_url"] = self.app.store.avatar_urls([player_id]).get(player_id, "")
        payload["avatar_full_url"] = self.app.store.avatar_full_urls([player_id]).get(player_id, "")
        payload.setdefault("display_name", payload.get("name", ""))
        return payload

    def _public_table(self, state, viewer_id):
        view = engine.public_view(state, viewer_id)
        seats = view.get("seats", [])
        avatar_urls = self.app.store.avatar_urls(
            seat.get("id") for seat in seats
        )
        avatar_full_urls = self.app.store.avatar_full_urls(
            seat.get("id") for seat in seats
        )
        bot_avatars = {
            seat["player_id"]: seat.get("bot_avatar", {})
            for seat in state.get("seats", []) if seat.get("is_bot")
        }
        for seat in seats:
            avatar = bot_avatars.get(seat.get("id"), {})
            seat["avatar_url"] = avatar.get("url", avatar_urls.get(seat.get("id"), ""))
            seat["avatar_full_url"] = avatar.get("full_url", avatar_full_urls.get(seat.get("id"), ""))
        return view

    def _require_origin(self):
        origin = self.headers.get("Origin", "")
        if origin != self.app.public_origin:
            raise AppError(403, "origin_rejected", "Request origin is not allowed.")

    def _body(self, max_size=MAX_BODY):
        transfer = self.headers.get("Transfer-Encoding")
        if transfer:
            raise AppError(400, "invalid_body", "Chunked request bodies are not accepted.")
        length = self.headers.get("Content-Length")
        try:
            size = int(length) if length is not None else 0
        except ValueError:
            raise AppError(400, "invalid_body", "Invalid content length.")
        if size < 0 or size > max_size:
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
        if registration and not 1 <= len(value) <= 256:
            raise AppError(400, "invalid_password", "Passwords must be 1 to 256 characters.")
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
            "player": self._player_payload(player),
        }
        headers = None
        if set_cookie:
            cookie = ("%s=%s; Path=/poker/; HttpOnly; SameSite=Strict; Max-Age=%d" %
                      (self.app.cookie_name, token, SESSION_TTL))
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
            if path in PAGE_ROUTES:
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
                "/poker/manifest.webmanifest": (
                    "manifest.webmanifest", "application/manifest+json; charset=utf-8",
                ),
                "/poker/avatar-presets.json": (
                    "avatar-presets.json", "application/json; charset=utf-8",
                ),
                "/poker/service-worker.js": ("service-worker.js", "text/javascript; charset=utf-8"),
                "/poker/icon.svg": ("icon.svg", "image/svg+xml"),
                "/poker/icon-192.png": ("icon-192.png", "image/png"),
                "/poker/icon-512.png": ("icon-512.png", "image/png"),
                "/poker/apple-touch-icon.png": ("apple-touch-icon.png", "image/png"),
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
            if path == "/poker/api/avatar-presets":
                self._require_player()
                self._json(200, {"avatars": self.app.store.avatar_preset_catalog()})
                return
            builtin_avatar_match = re.fullmatch(
                r"/poker/avatars/(full/)?([a-z0-9]+(?:-[a-z0-9]+)*)\.(png|jpg)", path,
            )
            if builtin_avatar_match:
                is_full, preset_id, extension = builtin_avatar_match.groups()
                asset = _builtin_avatar_path(preset_id, full=bool(is_full))
                if asset.suffix.lower() != "." + extension:
                    raise AppError(404, "avatar_preset_not_found", "Avatar preset not found.")
                content_type = "image/jpeg" if extension == "jpg" else "image/png"
                self._send(200, asset.read_bytes(), content_type)
                return
            custom_preset_match = re.fullmatch(
                r"/poker/api/avatar-presets/([a-f0-9]{32})/(thumbnail|full)", path,
            )
            if custom_preset_match:
                self._require_player(require_account=False)
                preset_id, variant = custom_preset_match.groups()
                preset = self.app.store.get_custom_avatar_preset(
                    preset_id, full=(variant == "full"),
                )
                if (preset is None or self.avatar_version is None or
                        not hmac.compare_digest(preset["sha256"], self.avatar_version)):
                    raise AppError(404, "avatar_preset_not_found", "Avatar preset not found.")
                self._send(200, preset["image_data"], preset["content_type"])
                return
            avatar_match = re.fullmatch(
                r"/poker/api/players/([a-f0-9]{32})/avatar(?:/(full))?", path,
            )
            if avatar_match:
                self._require_player(require_account=False)
                avatar = self.app.store.get_player_avatar(
                    avatar_match.group(1), full=bool(avatar_match.group(2)),
                )
                if (avatar is None or self.avatar_version is None or
                        not hmac.compare_digest(avatar["sha256"], self.avatar_version)):
                    raise AppError(404, "avatar_not_found", "Avatar not found.")
                self._send(200, avatar["image_data"], avatar["content_type"])
                return
            if path == "/poker/api/config":
                self._require_player()
                self._json(200, {"config": self.app.store.get_global_config()})
                return
            if path == "/poker/api/admin/config":
                self._require_admin()
                self._json(200, {"config": self.app.store.get_global_config()})
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
                    "player": self._player_payload(player),
                })
                return
            if path == "/poker/api/admin/history":
                self._require_admin()
                self._json(200, self.app.store.list_admin_history(self.request_offset))
                return
            admin_history_match = re.fullmatch(
                r"/poker/api/admin/history/([a-f0-9]{32})", path,
            )
            if admin_history_match:
                self._require_admin()
                history_page = self.app.store.get_admin_history(
                    admin_history_match.group(1), self.request_offset,
                )
                if history_page is None:
                    raise AppError(404, "history_not_found", "Past game not found.")
                self._json(200, history_page)
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
            match = re.fullmatch(r"/poker/api/tables/([a-f0-9]{32})/reactions", path)
            if match:
                self._require_player()
                reactions = self.app.store.list_table_reactions(
                    match.group(1), self.reaction_after, time.time(),
                )
                self._json(200, reactions)
                return
            match = re.fullmatch(r"/poker/api/tables/([a-f0-9]{32})/last-hand", path)
            if match:
                player, _ = self._require_player()
                hand = self.app.store.get_last_hand(
                    match.group(1), player["id"], self.request_hand_number,
                )
                self._json(200, {"hand": hand})
                return
            match = re.fullmatch(r"/poker/api/tables/([a-f0-9]{32})", path)
            if match:
                player, _ = self._require_player()
                table_id = match.group(1)
                state = self.app.store.mutate_table(table_id, lambda value: value, time.time())
                view = self._public_table(state, player["id"])
                view["reaction_cursor"] = self.app.store.list_table_reactions(
                    table_id, None, time.time(),
                )["cursor"]
                self._json(200, {"table": view})
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
            body = self._body(
                MAX_AVATAR_BODY
                if path in ("/poker/api/profile/avatar", "/poker/api/admin/avatar-presets")
                else MAX_BODY
            )
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
                if (self.app.admin_username is not None and
                        username == self.app.admin_username and password == "" and
                        self.app.allow_admin):
                    result = self.app.store.login_admin(now)
                elif username == self.app.admin_username:
                    result = None
                else:
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
                           {"Set-Cookie": self.app.cookie_name +
                            "=; Path=/poker/; HttpOnly; SameSite=Strict; Max-Age=0" +
                            ("; Secure" if self.app.secure_cookie else "")})
                return

            if path == "/poker/api/profile":
                if player.get("is_admin"):
                    raise AppError(403, "admin_read_only", "Room admins cannot change player profiles.")
                if not player.get("account"):
                    raise AppError(403, "account_required", "Create or claim a personal account first.")
                allowed = {"username", "display_name", "new_password", "current_password"}
                if set(body) - allowed:
                    raise AppError(400, "invalid_profile", "Unknown profile setting.")
                if not ({"username", "display_name", "new_password"} & set(body)):
                    raise AppError(400, "invalid_profile", "Choose a profile setting to update.")
                username = self._username(body["username"])[0] if "username" in body else None
                display_name = self._display_name(body["display_name"]) if "display_name" in body else None
                new_password = self._password(body["new_password"], registration=True) if "new_password" in body else None
                current_password = self._password(body["current_password"]) if "current_password" in body else None
                updated = self.app.store.update_account_profile(
                    player["id"], username, display_name, new_password,
                    current_password, now,
                )
                self._json(200, {"player": self._player_payload(updated)})
                return

            if path == "/poker/api/profile/avatar":
                if player.get("is_admin"):
                    raise AppError(403, "admin_read_only", "Room admins cannot change player profiles.")
                if not player.get("account"):
                    raise AppError(403, "account_required", "Create or claim a personal account first.")
                allowed = {"image_data", "full_image_data", "preset_id"}
                if set(body) - allowed:
                    raise AppError(400, "invalid_avatar", "Choose a PNG or JPEG image.")
                preset_id = body.get("preset_id")
                if preset_id is not None and not self.app.store.has_avatar_preset(preset_id):
                    raise AppError(400, "invalid_avatar_preset", "Choose an available avatar.")
                full_content_type = None
                full_image_data = None
                if "image_data" not in body:
                    if preset_id is None or "full_image_data" in body:
                        raise AppError(400, "invalid_avatar", "Choose a PNG or JPEG image.")
                    thumbnail = self.app.store.get_avatar_preset_image(preset_id)
                    full = self.app.store.get_avatar_preset_image(preset_id, full=True)
                    if thumbnail is None or full is None:
                        raise AppError(400, "invalid_avatar_preset", "Choose an available avatar.")
                    content_type, image_data = thumbnail["content_type"], thumbnail["image_data"]
                    full_content_type, full_image_data = full["content_type"], full["image_data"]
                else:
                    content_type, image_data = _decode_avatar_data_uri(body["image_data"])
                    if "full_image_data" in body:
                        full_content_type, full_image_data = _decode_avatar_data_uri(
                            body["full_image_data"], MAX_FULL_AVATAR_BYTES,
                        )
                if image_data is None:
                    raise AppError(409, "profile_photo_required",
                                   "Choose a replacement profile photo. Photos cannot be removed.")
                if (image_data is not None and full_image_data is not None
                        and content_type != full_content_type):
                    raise AppError(400, "invalid_avatar", "Use the same image format for both sizes.")
                self.app.store.set_player_avatar(
                    player["id"], content_type, image_data,
                    full_content_type, full_image_data, now,
                )
                self._json(200, {"player": self._player_payload(player)})
                return

            if path == "/poker/api/admin/avatar-presets":
                if not player.get("is_admin"):
                    raise AppError(403, "admin_required", "Room admin access is required.")
                if set(body) != {"name", "image_data", "full_image_data"}:
                    raise AppError(400, "invalid_avatar_preset", "Name and both image sizes are required.")
                name = self._display_name(body["name"])
                content_type, image_data = _decode_avatar_data_uri(body["image_data"])
                full_content_type, full_image_data = _decode_avatar_data_uri(
                    body["full_image_data"], MAX_FULL_AVATAR_BYTES,
                )
                if image_data is None or full_image_data is None:
                    raise AppError(400, "invalid_avatar", "Both avatar image sizes must be nonempty.")
                if content_type != full_content_type:
                    raise AppError(400, "invalid_avatar", "Use the same image format for both sizes.")
                avatar = self.app.store.add_custom_avatar_preset(
                    name, content_type, image_data,
                    full_content_type, full_image_data, now,
                )
                self._json(201, {
                    "avatar": avatar,
                    "avatars": self.app.store.avatar_preset_catalog(),
                })
                return

            if path == "/poker/api/admin/config":
                if not player.get("is_admin"):
                    raise AppError(403, "admin_required", "Room admin access is required.")
                config = self.app.store.update_global_config(body, now)
                self._json(200, {"config": config})
                return

            if path == "/poker/api/admin/history/delete":
                if not player.get("is_admin"):
                    raise AppError(403, "admin_required", "Room admin access is required.")
                if body.get("confirm_delete") is not True:
                    raise AppError(
                        400, "confirmation_required",
                        "Confirm permanent deletion of the selected past games.",
                    )
                result = self.app.store.delete_admin_history_bulk(body.get("ids"))
                self._json(200, result)
                return

            admin_history_delete = re.fullmatch(
                r"/poker/api/admin/history/([a-f0-9]{32})/delete", path,
            )
            if admin_history_delete:
                if not player.get("is_admin"):
                    raise AppError(403, "admin_required", "Room admin access is required.")
                if body.get("confirm_delete") is not True:
                    raise AppError(
                        400, "confirmation_required",
                        "Confirm permanent deletion of this past game.",
                    )
                result = self.app.store.delete_admin_history(admin_history_delete.group(1))
                self._json(200, result)
                return

            admin_bot_match = re.fullmatch(
                r"/poker/api/tables/([a-f0-9]{32})/bots", path,
            )
            if player.get("is_admin") and admin_bot_match:
                table_id = admin_bot_match.group(1)
                seat_no = self._integer(body.get("seat_no"), "seat_no", 0, 8)
                state = self.app.store.mutate_table(
                    table_id,
                    lambda value: engine.add_bot(
                        value, player["id"], seat_no, now, is_admin=True,
                    ),
                    now,
                )
                self._json(200, {"table": self._public_table(state, player["id"])})
                return

            if not player.get("account"):
                raise AppError(403, "account_required",
                               "Claim this legacy seat or sign in with a personal account.")
            if player.get("is_admin"):
                raise AppError(403, "admin_read_only",
                               "Room admins can only change global settings or lobby bots.")

            rebuy_match = re.fullmatch(
                r"/poker/api/tables/([a-f0-9]{32})/rebuy(/decline)?", path,
            )
            if rebuy_match:
                table_id, decline_suffix = rebuy_match.groups()
                offer_id = body.get("offer_id")
                if decline_suffix:
                    if set(body) != {"offer_id"}:
                        raise AppError(400, "invalid_rebuy_offer", "Choose a rebuy offer to decline.")
                    state = self.app.store.mutate_table(
                        table_id,
                        lambda value: engine.decline_rebuy(value, player["id"], offer_id, now),
                        now,
                    )
                else:
                    if set(body) != {"offer_id", "confirm"} or body.get("confirm") is not True:
                        raise AppError(400, "confirmation_required", "Confirm the rebuy before accepting.")
                    state = self.app.store.mutate_table(
                        table_id,
                        lambda value: engine.accept_rebuy(value, player["id"], offer_id, now),
                        now,
                    )
                self._json(200, {"table": self._public_table(state, player["id"])})
                return

            reaction_match = re.fullmatch(
                r"/poker/api/tables/([a-f0-9]{32})/reactions", path,
            )
            if reaction_match:
                emoji = body.get("emoji")
                if not isinstance(emoji, str) or emoji not in REACTION_EMOJI_ALLOWLIST:
                    raise AppError(400, "invalid_reaction", "Choose a table reaction.")
                reaction = self.app.store.add_table_reaction(
                    reaction_match.group(1), player["id"], emoji, now,
                )
                self._json(201, {"reaction": reaction})
                return

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
                self._json(200, {"table": self._public_table(state, player["id"])})
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
                    "max_seats": engine.MAX_SEATS,
                    "starting_stack": self._integer(body.get("starting_stack"), "starting_stack", 100, 1_000_000_000),
                    "small_blind": self._integer(body.get("small_blind"), "small_blind", 1, 1_000_000_000),
                    "big_blind": self._integer(body.get("big_blind"), "big_blind", 2, 1_000_000_000),
                    "level_minutes": body.get("level_minutes"),
                    "turn_seconds": self._integer(body.get("turn_seconds", engine.TURN_SECONDS), "turn_seconds", 1, engine.MAX_TIMER_SECONDS),
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
                self._json(201, {"table": self._public_table(state, player["id"])})
                return

            end_match = re.fullmatch(r"/poker/api/tables/([a-f0-9]{32})/end", path)
            if end_match:
                table_id = end_match.group(1)
                if body.get("confirm") is True and "confirmation_token" not in body:
                    confirmation_token, expires_at = self.app.store.request_end_confirmation(
                        table_id, player["id"], now,
                    )
                    self._json(200, {
                        "confirmation_token": confirmation_token,
                        "expires_at": expires_at,
                    })
                    return
                if "confirmation_token" in body and "confirm" not in body:
                    state = self.app.store.end_table_with_confirmation(
                        table_id, player["id"], body["confirmation_token"], now,
                    )
                    self._json(200, {"table": self._public_table(state, player["id"])})
                    return
                raise AppError(400, "invalid_confirmation", "Confirm this table end again.")

            match = re.fullmatch(
                r"/poker/api/tables/([a-f0-9]{32})/(join|seat|stand|start|action|leave|cancel|settings|bots|pause)",
                path,
            )
            if not match:
                self._error(404, "not_found", "Not found.")
                return
            table_id, operation = match.groups()
            if operation == "join":
                def join_player(value):
                    if (not player.get("is_admin")
                            and not self.app.store.has_player_avatar(player["id"])):
                        raise AppError(409, "profile_photo_required",
                                       "Add a profile photo before joining a game.")
                    return engine.join(value, player["id"], player["name"], now)
                state = self.app.store.mutate_table(table_id, join_player, now)
            elif operation == "seat":
                seat_no = self._integer(body.get("seat_no"), "seat_no", 0, 8)
                def move_player(value):
                    if (not player.get("is_admin")
                            and not self.app.store.has_player_avatar(player["id"])):
                        raise AppError(409, "profile_photo_required",
                                       "Add a profile photo before joining a game.")
                    return engine.join(
                        value, player["id"], player["name"], now, seat_no=seat_no)
                state = self.app.store.mutate_table(table_id, move_player, now)
            elif operation == "stand":
                state = self.app.store.mutate_table(
                    table_id, lambda value: engine.stand(value, player["id"], now), now)
            elif operation == "settings":
                supported_settings = {
                    "starting_stack", "small_blind", "big_blind",
                    "buy_in", "turn_seconds", "level_minutes",
                    "payout_percentages", "name",
                }
                unknown_settings = set(body) - supported_settings
                if unknown_settings:
                    raise AppError(400, "invalid_settings", "Unknown table setting.")
                field_ranges = {
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
                for duration in ("level_minutes",):
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
                if not self.app.store.has_player_avatar(player["id"]):
                    raise AppError(409, "profile_photo_required",
                                   "Add a profile photo before starting a game.")
                def start_with_bot_avatars(value):
                    started = engine.start(value, player["id"], now)
                    bots = [seat for seat in started.get("seats", []) if seat.get("is_bot")]
                    if bots:
                        choices = self.app.store.avatar_preset_catalog()
                        for seat in bots:
                            preset = secrets.choice(choices)
                            seat["bot_avatar"] = {
                                "preset_id": preset["id"], "url": preset["url"],
                                "full_url": preset["full_url"],
                            }
                    return started

                state = self.app.store.mutate_table(table_id, start_with_bot_avatars, now)
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
            self._json(200, {"table": self._public_table(state, player["id"])})
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
                lambda value: engine.remove_bot(
                    value, player["id"], seat_no, now, is_admin=player.get("is_admin", False),
                ),
                now,
            )
            self._json(200, {"table": self._public_table(state, player["id"])})
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
    def __init__(self, args, room_password=None, admin_username=_ADMIN_USERNAME_FROM_ENV):
        self.room_password = (
            _load_room_password() if room_password is None
            else _validate_room_password(room_password)
        )
        self.admin_username = (
            _load_admin_username() if admin_username is _ADMIN_USERNAME_FROM_ENV
            else (None if admin_username is None else _validate_admin_username(admin_username))
        )
        self.public_origin, self.public_netloc, self.secure_cookie = _parse_origin(args.public_origin)
        self.store = Store(args.data_dir, self.room_password, self.admin_username)
        self.allow_admin = True
        self.cookie_name = COOKIE_NAME

    def private_admin_app(self, origin):
        """Share one store and ticker; enforce privileges by listener, never headers."""
        if self.admin_username is None:
            raise RuntimeError("--admin-origin requires FELT_NIGHT_ADMIN_USERNAME")
        private = copy.copy(self)
        private.public_origin, private.public_netloc, private.secure_cookie = _parse_origin(origin)
        if private.public_netloc == self.public_netloc:
            raise RuntimeError("admin and player origins must use different hosts or ports")
        private.allow_admin = True
        private.cookie_name = COOKIE_NAME + "_admin"
        self.allow_admin = False
        return private


def _background_ticks(store, stop_event):
    while not stop_event.wait(1.0):
        try:
            now = time.time()
            store.tick_all(now)
            store.prune_expired_table_reactions(now)
        except Exception:
            continue


def main(argv=None):
    parser = argparse.ArgumentParser(description="Felt Night play-money Texas Hold'em sit-and-go server")
    parser.add_argument("--host", default="127.0.0.1", help="listen address (must be loopback)")
    parser.add_argument("--port", type=int, default=18943)
    parser.add_argument("--public-origin", required=True,
                        help="exact browser origin, e.g. https://host:8443")
    parser.add_argument("--admin-port", type=int,
                        help="separate loopback listener for private room administration")
    parser.add_argument("--admin-origin",
                        help="exact private HTTPS origin; never expose this listener publicly")
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
    if (args.admin_port is None) != (args.admin_origin is None):
        parser.error("--admin-port and --admin-origin must be supplied together")
    if args.admin_port is not None and (
            not 1 <= args.admin_port <= 65535 or args.admin_port == args.port):
        parser.error("--admin-port must be a distinct port between 1 and 65535")
    os.umask(0o077)
    servers = []
    try:
        app = App(args)
        server = LimitedThreadingHTTPServer((args.host, args.port), Handler, app)
        servers.append(server)
        if args.admin_port is not None:
            private = app.private_admin_app(args.admin_origin)
            servers.append(LimitedThreadingHTTPServer(
                (args.host, args.admin_port), Handler, private))
    except Exception as exc:
        for listener in servers:
            listener.server_close()
        print("Felt Night startup failed: %s" % exc, file=sys.stderr)
        return 1

    stop_event = threading.Event()
    ticker = threading.Thread(target=_background_ticks, args=(app.store, stop_event), daemon=True)
    ticker.start()
    private_threads = []
    for listener in servers[1:]:
        thread = threading.Thread(target=listener.serve_forever, daemon=True)
        thread.start()
        private_threads.append(thread)
    print("Felt Night listening on %s:%d for %s" %
          (args.host, args.port, app.public_origin), flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        stop_event.set()
        for listener in servers[1:]:
            listener.shutdown()
        for listener in servers:
            listener.server_close()
        for thread in private_threads:
            thread.join(timeout=2.0)
        ticker.join(timeout=2.0)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

