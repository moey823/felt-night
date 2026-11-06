# Felt Night

Felt Night is a self-hosted, play-chip No-Limit Texas Hold’em room for private sit-and-go games. It uses Python 3.9+, the standard library, and SQLite.

![Felt Night table on desktop](docs/screenshots/table-desktop.png)

Players create private accounts, return to a seat after reconnecting, and review tournament results and hand histories. Hosts can run 2–9 player freezeouts with configurable stacks, blinds, blind levels, clocks, buy-ins, and payouts. The server validates actions and keeps the deck and opponents’ hidden cards private. Play credits have no cash value; there are no deposits, cash-outs, prizes, or rebuys.

Players join at an empty seat on the felt; hosts can add bots there too. Each table has live chat for players and spectators, with the three newest messages and an Enter-to-send input always visible above the table. Sit-out persists until switched off and immediately checks when free or folds facing a bet. Blind levels change only between hands. Hosts can pause and resume play, freezing game clocks, and adjust the shot clock, blind-level duration, all-in pacing, showdown result holds, and announcement delays while paused. Buy-ins, payouts, starting stacks, and blind amounts stay locked after play begins. Showdown results, elimination announcements, and blind-level announcements each have a configurable hold from 0 to 60 seconds (5 seconds by default), available when creating the table or changing its pacing. Results show each exposed hand’s rank and the pot winners; elimination messages finish before the next blind-level message begins. Players can save their own preflop and postflop bet presets and use the mouse wheel over the felt or betting controls to adjust the raise amount without focusing the slider. The completed table keeps the final board and participants visible, and the last-hand viewer steps through each street and shows the winners and exposed hand ranks. Chip counts can toggle to big blinds, always shown to one decimal place.

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

## Tests

Run the Python suite with `python3 -m unittest discover -s tests`. With a Chromium headless shell installed, run `BROWSER_BIN=/path/to/chrome-headless-shell node tests/browser/run.mjs`; append `crowded` to check the active player and spectator layouts, `ux` for gameplay/replay/blind-boundary checks, `interactions` for felt seating, live chat, and sit-out, or `adjustments` for personal presets, mouse-wheel sizing, compact chat, pause controls, and configurable announcement delays. Use `presentation` for top-chat Enter sending, focus-free felt-wheel sizing, sequential result announcements, and showdown/replay hand ranks. The suites use isolated test data and a dummy invite.

## License

Released under the [MIT License](LICENSE).
