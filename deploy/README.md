# Mini deployment

This installation uses a dedicated launchd user agent, an immutable-by-the-service release directory, a loopback backend on 18943 and a Tailscale Funnel HTTPS listener on 8443. The game entry point is `/poker/`. The signed-in mini desktop user must have a running launchd GUI session. Tailscale and the Homebrew Python 3 runtime must be available.

## Install or update

Run on the mini as its desktop user. Review and test the intended main commit first. The service directory should contain only this application's release. Install application files from that commit, then restart the agent. Preserve the runtime directory across releases.

```sh
set -eu
umask 077
runtime="$HOME/Library/Application Support/SitNGo"
service="$HOME/services/sitngo"
mkdir -p "$runtime/data" "$service" "$HOME/Library/LaunchAgents"
git archive main | tar -xf - -C "$service"
install -m 600 deploy/service.sb "$runtime/service.sb"
install -m 600 deploy/net.personal.sitngo.plist "$HOME/Library/LaunchAgents/net.personal.sitngo.plist"
domain="gui/$(id -u)"
if launchctl print "$domain/net.personal.sitngo" >/dev/null 2>&1; then
  launchctl bootout "$domain/net.personal.sitngo"
fi
launchctl bootstrap "$domain" "$HOME/Library/LaunchAgents/net.personal.sitngo.plist"
```

Inspect Serve and Funnel status before publishing. Port 8443 must be free or already dedicated to this app. After checking the local service, publish with the mini Tailscale binary.

```sh
ts=/Applications/Tailscale.app/Contents/MacOS/Tailscale
"$ts" serve status
"$ts" funnel --bg --https=8443 http://127.0.0.1:18943
"$ts" funnel status
```

To take just poker offline, run `"$ts" funnel --https=8443 off` and `launchctl bootout "$domain/net.personal.sitngo"`. A Funnel reset would also affect other routes. Restore a previous reviewed commit by extracting it into a fresh release directory, retaining the runtime database only if its schema is compatible.

## Exposure and access

Registration requires the room invite password and creates a persistent, password-protected account. The invite password alone cannot recover an account or seat. A valid legacy session can secure its own player identity. Accounts do not prevent collusion or multiple accounts. Treat the SQLite database as private because it contains game state including undealt cards.

The service process can read the deployed code, game data and system runtime files. Its sandbox limits file writes to its data directory and blocks outgoing socket connections, including to the mini's other loopback web apps. The agent starts in the logged-in user's context. The sandbox, OS, Tailscale and Python runtime are part of the security boundary.

Cookies are scoped by hostname and path, independent of port. Other services on this same hostname can receive the poker cookie if a player visits a matching path on those services. Poker therefore also requires a secret obtained at login and held in the browser's origin-scoped storage. A sibling service receiving the cookie alone cannot use it to read hands or control a seat. Other apps' own broadly scoped cookies can still arrive at poker; the poker service ignores those values and does not log request headers. A dedicated hostname or node would isolate cookies in both directions. A public listener can also consume bandwidth and request capacity before authentication. Tailscale Funnel routing and local listeners are separate surfaces; host firewall rules and tailnet ACLs can further restrict direct listeners.
