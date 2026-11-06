# Self-host deployment example

These examples show Felt Night behind Caddy on a Linux host with systemd. Replace `poker.example.com` with the hostname players will use. The app listens on loopback; Caddy provides HTTPS and forwards `/poker/` without stripping the path.

1. Install the checked-out application files in `/opt/felt-night` and create a dedicated `felt-night` service account.
2. Create `/etc/felt-night/room-invite` as a UTF-8 one-line invite file. Set its owner to `felt-night` and its mode to `0600`. Keep `/var/lib/felt-night` owned by that account for the SQLite database.
3. Copy `felt-night.service.example` to `/etc/systemd/system/felt-night.service`. Review the Python path, install path, hostname, and invite-file location, then enable and start it with systemd.
4. Add the `Caddyfile.example` site block to the Caddy configuration and reload Caddy. Point the hostname at this host and allow the HTTP/HTTPS ports Caddy needs for certificates.

The configured `--public-origin` must be the public HTTPS origin exactly, such as `https://poker.example.com` (no path). Keep the backend bound to `127.0.0.1` and preserve the `/poker/` prefix in the reverse proxy. Any compatible HTTPS reverse proxy can replace Caddy. Tailscale is optional and not required by the application.

The service requires exactly one of `FELT_NIGHT_ROOM_PASSWORD_FILE` or `FELT_NIGHT_ROOM_PASSWORD`; the example uses the file setting. The secret file must be a regular file readable by the service user with no group or other permissions. Rotating the invite and restarting invalidates active sessions; accounts and history remain in the data directory.

## Public players with private admin

Run one process with two loopback listeners against the existing data directory:

```sh
FELT_NIGHT_ADMIN_USERNAME=admin \
FELT_NIGHT_ROOM_PASSWORD_FILE="$HOME/.config/felt-night/room-invite" \
python3 server.py --host 127.0.0.1 --port 18943 \
  --public-origin "https://$ROOM_HOST:8443" \
  --admin-port 18944 --admin-origin "https://$ROOM_HOST:9465" \
  --data-dir "$HOME/.local/share/felt-night/data"
```

Here `ROOM_HOST` is your Tailscale HTTPS hostname. Configure the two ingress routes
individually, preserving all unrelated routes:

```sh
tailscale serve --bg --https=9465 http://127.0.0.1:18944
tailscale funnel --bg --https=8443 http://127.0.0.1:18943
```

Players use `https://$ROOM_HOST:8443/poker/`; admin uses
`https://$ROOM_HOST:9465/poker/` while connected to the tailnet.
Never enable Funnel on the private admin port. If using a process sandbox,
allow loopback inbound connections on both backend ports. Keep credentials and
runtime data outside the source deployment, and persist both listener arguments
in the service definition so restarts preserve the separation.

Before enabling public ingress, verify that the deployed player listener rejects
blank-password admin login with 401 and rejects replayed admin sessions, while
the private listener permits admin login. After deployment, check both health
endpoints and the Funnel status: only the player port should be public. Test
registration, account login, and joining against disposable development data;
do not create test accounts or games in the live room.
