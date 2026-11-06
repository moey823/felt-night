# Felt Night

Read README.md and deploy/README.md before changing server startup or ingress.

## Public players and private administration

- Keep player access and passwordless room administration on separate loopback listeners when public access is enabled. Both listeners share one store and one game ticker.
- The player listener must reject admin login and every admin session, including an admin token replayed under the player cookie name. Do not use caller-supplied headers to grant admin access.
- Preserve the deployed service's paired --admin-port and --admin-origin arguments, its room invite, and its external data directory.
- Keep the admin ingress tailnet-only. Publish only the player listener through Funnel. Do not turn the entire room tailnet-only to protect admin; preserve the separate listener boundary.
- Change only this application's ingress routes. Never reset Tailscale Serve or Funnel globally.
- Verify public health and rejected admin login through the public Funnel relay, plus private admin health and private-only ingress status, after deployment.
- Run python3 -m unittest discover -s tests for server changes. Use disposable data for registration, login, lobby creation/joining, admin-session replay, and startup tests. Do not create test players or games in the live room.

## Delivery

Deploy committed source while preserving credentials and stored room data. Check the actual launch service and OS sandbox permit both loopback listeners. Keep deployment configuration persistent across restarts.
