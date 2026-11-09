# Self-host deployment example

These examples show Felt Night behind Caddy on a Linux host with systemd. Replace `poker.example.com` with the hostname players will use. The app listens on loopback; Caddy provides HTTPS and forwards `/poker/` without stripping the path.

1. Install the checked-out application files in `/opt/felt-night` and create a dedicated `felt-night` service account.
2. Create `/etc/felt-night/room-invite` as a UTF-8 one-line invite file. Set its owner to `felt-night` and its mode to `0600`. Keep `/var/lib/felt-night` owned by that account for the SQLite database.
3. Copy `felt-night.service.example` to `/etc/systemd/system/felt-night.service`. Review the Python path, install path, hostname, and invite-file location, then enable and start it with systemd.
4. Add the `Caddyfile.example` site block to the Caddy configuration and reload Caddy. Point the hostname at this host and allow the HTTP/HTTPS ports Caddy needs for certificates.

The configured `--public-origin` must be the public HTTPS origin exactly, such as `https://poker.example.com` (no path). Keep the backend bound to `127.0.0.1` and preserve the `/poker/` prefix in the reverse proxy. Any compatible HTTPS reverse proxy can replace Caddy. Tailscale is optional and not required by the application.

The service requires exactly one of `FELT_NIGHT_ROOM_PASSWORD_FILE` or `FELT_NIGHT_ROOM_PASSWORD`; the example uses the file setting. The secret file must be a regular file readable by the service user with no group or other permissions. Rotating the invite and restarting invalidates active sessions; accounts and history remain in the data directory.

## Admin accounts and an optional private origin

On a fresh database, the first registered account becomes admin. Complete that registration before sharing the room invite. Existing rooms must explicitly grant the intended owner's account admin access during the upgrade; back up the database before changing roles. `FELT_NIGHT_ADMIN_USERNAME` no longer creates an administrator. Remove it from service configuration.

Admins sign in with their normal password, play normally, and open **Admin** to change settings or grant/remove admin roles. The last admin cannot be removed. Non-admin accounts cannot use admin APIs.

Existing deployments may keep a second private origin with the paired arguments `--admin-port 18944 --admin-origin https://ROOM_HOST:9465`, alongside the primary `--port 18943 --public-origin https://ROOM_HOST:8443`. Both listeners share one database, one ticker, and the same account roles; both reject the retired blank-password admin login.

Preserve the existing loopback bindings, external data directory, room invite, and paired listener arguments during an upgrade. If a process sandbox is used, permit loopback inbound connections on both backend ports. Keep the second origin tailnet-only; publish only the primary player port through Funnel. Never reset Tailscale ingress globally.

After deployment verify both health endpoints, rejected blank-password admin login, expected account roles, and the ingress status. Test registration, role management, and gameplay against disposable development data; do not create test accounts or games in the live room.
