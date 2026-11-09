# Felt Night

Read README.md and deploy/README.md before changing server startup or ingress.

## Accounts and administration

- Admin is a persistent role on an ordinary password-authenticated account. Admins can play, edit their own profiles, and open the Admin screen from the app.
- The first successful account registration in a fresh database becomes admin atomically. Existing deployments with accounts must receive an explicit owner-authorized role migration; never grant an arbitrary new registrant admin because the admin count is zero.
- Role changes require an authenticated admin and CSRF. Recheck the acting admin and the last-admin constraint in the same serialized transaction. Never permit removal of the last admin, including concurrent self-demotions.
- Read roles from the database for every authenticated request so demotion applies to existing sessions immediately. Do not trust caller-supplied role or proxy headers.
- Retire the old passwordless synthetic admin identity and its sessions. FELT_NIGHT_ADMIN_USERNAME no longer grants privileges or reserves a username.
- The optional second listener shares the same account roles and password requirements. Preserve the deployed paired --admin-port / --admin-origin arguments, room invite, and external data directory unless explicitly changing deployment topology.
- Keep the existing second ingress tailnet-only and preserve public player access. Change only this application's ingress routes; never reset Tailscale Serve or Funnel globally.
- After deployment verify both health endpoints, role migration, deployed source, and ingress. A blank-password admin login must fail on both origins.
- Run python3 -m unittest discover -s tests for server changes. Use disposable data for registration, login, role changes, gameplay, and startup tests. Do not create test players or games in the live room.

## Delivery

Deploy committed source while preserving credentials and stored room data. Check the actual launch service and OS sandbox permit both loopback listeners. Keep deployment configuration persistent across restarts.
