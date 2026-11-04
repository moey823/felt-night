# SitNGo

A private, server-authoritative No-Limit Texas Hold'em sit-and-go for play chips. It supports simultaneous host-created tables, reconnecting browser sessions, tournament blind levels, turn timeouts, side pots, ties, and finish results. There are no deposits, cash-outs, prizes, or rebuy options.

The application uses only Python's standard library and SQLite. The web process binds to loopback and is intended to sit behind the existing HTTPS ingress. Every page and API route is under `/poker/`.

## Run

Python 3.9 or newer is sufficient:

```sh
/usr/bin/python3 server.py \
  --host 127.0.0.1 \
  --port 18943 \
  --public-origin https://poker.example.com:8443 \
  --data-dir "/home/poker/Library/Application Support/SitNGo/data"
```

The shared app gate is hardcoded as `example-room-invite` in `server.py`. Changing that constant and restarting revokes existing sessions. The data directory and SQLite database are kept outside the repository. The server tightens the data directory and database permissions on startup.

For loopback browser QA, set `--public-origin http://localhost:18943` and open `http://localhost:18943/poker/`. Production must use the exact HTTPS origin configured on the ingress. The service rejects requests with a different Host or mutation Origin.

## Play

Sign in with the shared `example-room-invite` app gate and choose a display name. Create a table, then share the private site with the other players. The host is seated automatically, and players can choose an open seat or stand while the table is still a lobby. The host keeps control of the table while standing. Tables have 2–9 seats and can start with at least two seated players. Defaults are a 1,000-chip stack, 10/20 blinds, and 5-minute blind levels. The host can edit table settings and add or remove test bots in specific seats before starting, including while people are seated. Starting the tournament draws seats and the first dealer at random. Each seated player sees their own seat at six o’clock. Bots take their turns automatically. Blinds double at each level. The tournament continues until one player remains; players who run out of chips are eliminated.

An unstarted lobby expires after four hours without activity. Players may leave a lobby; its host may cancel it. The action deadline is 30 seconds. If a player times out, the server checks when possible and otherwise folds. Bet and raise amounts are target street contributions (raise-to values). Each action carries the current hand and turn version so retries cannot act on a later turn.

## Routes

- `GET /poker/api/me`: current session and CSRF token.
- `POST /poker/api/login`: `{ "name": "...", "password": "..." }`.
- `POST /poker/api/logout`.
- `GET /poker/api/tables`: table summaries.
- `POST /poker/api/tables`: creates a table and seats its host.
- `GET /poker/api/tables/{id}`: table state scoped to the current player.
- `POST /poker/api/tables/{id}/join`, `/seat` with `{ "seat_no": n }`, `/stand`, and `/start`.
- `POST /poker/api/tables/{id}/settings`: optional `name` and any of `max_seats`, `starting_stack`, `small_blind`, `big_blind`, and `level_minutes`. The host may update settings only before the tournament starts; changes to the starting stack also update seated stacks.
- `POST /poker/api/tables/{id}/bots`: `{ "seat_no": n }`; `DELETE /poker/api/tables/{id}/bots/{seat_no}`. Only the host may add or remove test bots in an unstarted lobby.
- `POST /poker/api/tables/{id}/action`: `{ "expected_hand": n, "expected_turn_version": n, "action": "...", "amount": n }`.

Seat numbers in requests are zero-based. After login, every mutation needs the `X-SitNgo-CSRF` header returned by `/poker/api/me` or the login response, including bot deletion. Lobby settings and bot management are host-only. Errors use `{ "error": { "code": "...", "message": "..." } }`; stale actions return HTTP 409.

## Security and data

The browser receives a random, opaque session cookie scoped to `/poker/`; the database stores only its SHA-256 hash. The cookie is HttpOnly and SameSite Strict, and Secure for HTTPS origins. A session lasts 30 days. The server derives a per-session CSRF token and validates the configured public Origin for mutations. Login attempts are rate-limited to 5 failures per source address and 50 failures in aggregate per 15 minutes. The rightmost valid X-Forwarded-For address is used when present; the direct peer address is the fallback. Changing the fixed gate in `server.py` and restarting the service revokes all existing sessions. Request bodies, request workers, and active table count are capped.

Each player's hole cards stay private while betting is possible. When an all-in is called and nobody can bet further, all live hands turn face up before the remaining board is dealt. Folded cards stay private. Deck order and all hidden cards remain server-side.

SQLite is stored at `<data-dir>/sitngo.sqlite3`. Do not copy the runtime directory into the repository or expose port 18943 outside loopback.

## Tests

```sh
/usr/bin/python3 -m unittest discover -s tests
```
Deployment and runtime operations are documented in [deploy/README.md](deploy/README.md).
