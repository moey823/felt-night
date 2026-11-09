# Felt Night

Felt Night is a self-hosted, play-chip No-Limit Texas Hold’em room for private sit-and-go games. It uses Python 3.9+, the standard library, and SQLite.

![Felt Night table on desktop](docs/screenshots/table-desktop.png)

Players enter through /lobby after signing in. The lobby lists waiting and in-progress games and opens each game in its dedicated table window. Players create private accounts, return to a seat after reconnecting, and review tournament summaries and poker-style hand histories. The last-hand viewer can navigate older and newer saved hands as well as streets. Hosts can run 2–9 player sit-and-go tournaments with configurable stacks, blinds, blind levels, clocks, buy-ins, and payouts. After elimination, the showdown stays visible for its configured hold before a player gets one 60-second offer to re-enter for the original buy-in and starting stack. Play and the blind-level clock pause from elimination until all rebuy offers are accepted, declined, or expire. Other players see who the table is waiting for. Rebuys increase the tracked prize pool and each player's total buy-ins. Rebuys apply to newly created tables; saved games created before this feature remain freezeouts. New tournament awards split to cents, while saved completed awards stay unchanged. The server validates actions and keeps the deck and opponents’ hidden cards private.

New game opens a lobby and its single host setup dialog. Hosts choose the game name, buy-in, starting stack, blinds, blind-level duration, shot clock, and payout shares. Payout sliders keep the total at 100%; the occupied seats determine the field size when the host starts. Hosts can pause/resume play and end a game with two confirmations. Ending early preserves the game record without declaring a winner or inventing a payout.

The table uses a dedicated gameplay view with a seat ring, centered board and a prominent gold pot total, and betting controls below the felt. A separate live “Bet to” or “Raise to” total beside the sizing slider shows the selected street total before submission, including big-blind units when enabled. Players can choose three private reaction shortcuts from the table menu; favorites stay in that browser for that account, while sent reactions briefly burst around the sender’s current seat for table viewers. Chat, history, replay, and host controls are also available from the table menu. The settings dialogs keep their close controls reachable on mobile. Fullscreen and a separate table window are optional, and the mobile web app can be installed in standalone mode. Live game requests always require the server; the app does not offer offline play.

Room admins can select loaded past games for bulk deletion with a count-specific confirmation; active games and accounts are preserved. Clicking outside a dialog dismisses it. Reaction choices include poop and facepalm.

Players can edit their username, display name, and password from their profile; credential changes require the current password, and passwords may contain 1–256 characters. Players choose from built-in avatar presets or upload and crop a photo; new crops save a 256-pixel thumbnail and a protected 1024-pixel master; older thumbnail-only photos continue to work. An explicitly enabled room admin can add persistent shared avatar choices. A profile photo is required before opening, joining, creating, or starting a game, including reconnecting with an older account. Players can replace their photo but cannot remove it. Loaded seat portraits stay in place through gameplay refreshes and appear beside the card faces at occupied seats. Exposed hole cards and board cards split the complete face equally between a large rank on top and a matching suit below; their visible shapes stay centered consistently across combinations. Posted blinds, bets, calls, and raises show chip stacks and cumulative street amounts outside each player’s container; they collect into the pot between streets. Small blind and big blind positions have separate, spelled-out badges throughout preflop, including after those players act; the badges disappear on later streets. Bet, raise, and all-in action badges use a high-contrast gold background with a clear amount.

A separate, explicitly enabled room admin configures shared preflop/postflop bet presets, all-in street delay, blind/elimination announcements, showdown result holds, and the winner hold after everyone else folds. The no-showdown hold accepts 0–60 seconds and defaults to 1.5 seconds; blind and elimination announcements follow it. Admin changes apply to future pacing transitions without resetting an active deadline. Hosts can add bots to empty seats while a game is still in its lobby. When the game starts, each bot receives a random avatar from the built-in and admin-shared collection, saved for the duration of that game. Room admins can add or remove bots in a lobby. The admin account cannot create a game, take a seat, or submit poker actions. Normal players retain their personal accounts, reconnectable seats, and private tournament histories.

Sit-out persists until switched off and immediately checks when free or folds facing a bet. Blind levels change only between hands, one level at a time. Each level’s timer starts when its first hand is dealt, after any showdown or announcements. The original buy-in, starting stack, payout shares, and blind amounts stay locked after play begins. Accepted rebuys add the original entry amount to the pool; standings and saved history track entry counts and player totals, while unfinished awards are marked as estimates. The completed table keeps the final board and participants visible; the last-hand viewer steps through each street and shows winners and exposed hand ranks. Chip counts can toggle to big blinds. Each seat keeps that player's latest action and amount until the betting round ends or they act again; a separate turn marker and timer identify the current actor, and a gold ring marks each hand winner.

Bots use an adapted [PokerForBots complex strategy](https://github.com/lox/pokerforbots/tree/main/sdk/bots/complex): position ranges, hand and draw categories, pot odds, and stack-aware sizing. Decisions use only the bot’s own cards and public information; no service or model calls are involved. See [third-party notices](THIRD_PARTY_NOTICES.md) for attribution.

A modified browser cannot choose cards or bypass server rules, but no online room can prevent collusion, shared credentials, or dishonest operation. Felt Night has no public shuffle proof or independent fairness certification. See the [fair play and security guide](static/security.html).

## Run locally

Clone the repository and check that Python is 3.9 or newer:

```sh
git clone https://github.com/moey823/felt-night.git felt-night
cd felt-night
python3 --version
```

Create a private invite file and an external data directory. The file must contain one UTF-8 line and be readable only by the account running the server:

```sh
mkdir -p "$HOME/.config/felt-night" "$HOME/.local/share/felt-night/data"
chmod 700 "$HOME/.config/felt-night" "$HOME/.local/share/felt-night" "$HOME/.local/share/felt-night/data"
umask 077
vi "$HOME/.config/felt-night/room-invite"
chmod 600 "$HOME/.config/felt-night/room-invite"
```

Start the room on loopback, then open <http://localhost:18943/poker/>:

```sh
FELT_NIGHT_ROOM_PASSWORD_FILE="$HOME/.config/felt-night/room-invite" python3 server.py --host 127.0.0.1 --port 18943 --public-origin http://localhost:18943 --data-dir "$HOME/.local/share/felt-night/data"
```

Normal startup requires exactly one of `FELT_NIGHT_ROOM_PASSWORD_FILE` or `FELT_NIGHT_ROOM_PASSWORD`. The file setting is recommended: use a regular file owned by the service account with mode `0600`; group and other permission bits are rejected. One trailing newline is accepted. The direct environment value is an alternative, but do not commit it or put it in a shared shell profile. Do not set both. The SQLite database stays under the external data directory at `sitngo.sqlite3`.

Changing the room invite and restarting invalidates existing sessions. Player accounts and tournament history remain in the database. For a public HTTPS setup, see the [Linux systemd and Caddy examples](deploy/README.md). Tailscale is optional; the app has no Tailscale runtime dependency.

## Private-room admin

Set `FELT_NIGHT_ADMIN_USERNAME=admin` only behind a trusted private network such as tailnet-only Tailscale Serve. Sign in as `admin` with an empty password. This is a configuration account, not a player account. For a public player deployment, either leave the variable unset or configure the separate private admin listener below. Never expose an admin-enabled listener through Tailscale Funnel. An existing player account with the configured admin username causes startup to fail rather than changing that player's permissions.

For public players and private admin in the same room, add both
`--admin-port 18944 --admin-origin https://room.example.com:9465` to the server command.
Keep `--port 18943 --public-origin https://room.example.com:8443` for players.
The primary listener then rejects admin login and admin sessions, including sessions
copied from the private listener. The second listener shares the same room store and
uses a separate session cookie. Publish only the player listener; route the admin
listener exclusively through your private network. See [the deployment guide](deploy/README.md)
for a Tailscale example.

Global configuration is stored with the room database. Normal players cannot change it. Removing the environment setting disables admin access and revokes its sessions.

Admins can open **Past games** to inspect completed, ended, cancelled, and expired games, including saved hands. Deleting a game requires an explicit confirmation and permanently removes that game's table, chat, and saved history; player accounts and sessions remain.

## Tests

Run `python3 -m unittest discover -s tests` for the engine, authentication, permissions, persistence, and HTTP contracts. Browser tests use isolated data, a dummy invite, and a test-only enabled admin:

```sh
BROWSER_BIN=/path/to/chrome-headless-shell node tests/browser/run.mjs
BROWSER_BIN=/path/to/chrome-headless-shell node tests/browser/run.mjs flow
BROWSER_BIN=/path/to/chrome-headless-shell node tests/browser/run.mjs layout
BROWSER_BIN=/path/to/chrome-headless-shell node tests/browser/run.mjs compact
BROWSER_BIN=/path/to/chrome-headless-shell node tests/browser/run.mjs betting-display
BROWSER_BIN=/path/to/chrome-headless-shell node tests/browser/run.mjs stability
BROWSER_BIN=/path/to/chrome-headless-shell node tests/browser/run.mjs reactions
BROWSER_BIN=/path/to/chrome-headless-shell node tests/browser/run.mjs profile-avatars
```

The reactions suite checks private shortcuts, local favorites, live burst delivery, reconnect behavior, and nine-seat mobile layout. The profile-avatars suite checks photo upload/crop/save/replace, authenticated loading and refresh persistence, seat/fold/no-card/showdown display, and retry/failure fallback.

Set `QA_SCREEN_DIR` to a directory on the development machine to retain screenshots. The default suite plays real hands and checks action submission, reconnects, and history. The flow suite covers host setup, payouts, admin separation, mobile dialogs, and ending a game. The layout suite checks crowded tables across screen sizes. The stability suite checks a nine-player game, timer pause/resume, compact chat, viewport controls, seat markers, winner badges, and the admin past-game flow. See [the design and verification priorities](docs/ux-design.md).

## License

Released under the [MIT License](LICENSE).
