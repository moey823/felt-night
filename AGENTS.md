# Felt Night

Read README.md and deploy/README.md before changing server startup or ingress.

## Accounts and administration

- Admin is a persistent role on an ordinary password-authenticated account. Admins can play, edit their own profiles, and open the Admin screen from the app.
- The first successful account registration in a fresh database becomes admin atomically. Existing deployments with accounts must receive an explicit owner-authorized role migration; never grant an arbitrary new registrant admin because the admin count is zero.
- Role changes require an authenticated admin and CSRF. Recheck the acting admin and the last-admin constraint in the same serialized transaction. Never permit removal of the last admin, including concurrent self-demotions.
- Account deletion requires admin authorization and explicit confirmation. Protect all admin accounts and accounts involved in active games; revoke deleted accounts' sessions and remove their credentials/profile images while retaining saved game records.
- Bot-game purge requires a count-confirmed selection of terminal games with recorded bot participation. Preserve active games and games without bots; recheck the selection within the deletion transaction.
- Read roles from the database for every authenticated request so demotion applies to existing sessions immediately. Do not trust caller-supplied role or proxy headers.
- Retire the old passwordless synthetic admin identity and its sessions. FELT_NIGHT_ADMIN_USERNAME no longer grants privileges or reserves a username.
- Deploy one loopback listener for both players and role-based administration. The legacy separate admin listener and its ingress are retired; do not reintroduce --admin-port / --admin-origin in the deployed service. Preserve the room invite and external data directory.
- Preserve public player access. Change only this application's ingress routes; never reset Tailscale Serve or Funnel globally.
- After deployment verify primary health, account roles, deployed source, and ingress. Confirm the retired admin listener and route remain absent. A blank-password admin login must fail.
- Run python3 -m unittest discover -s tests for server changes. Use disposable data for registration, login, role changes, gameplay, and startup tests. Do not create test players or games in the live room.

## Payouts and rebuys

- Display currency in whole dollars. Final awards must be whole-dollar amounts summing exactly to the prize pool, including every accepted rebuy. Allocate rounding remainders by largest fractional share, then finish order; never overpay the pool. Preserve original historical records when normalizing saved-game views.
- Rebuys are available only when enabled by the host, at or below the optional last rebuy level, and when more than two players started that hand. Determine eligibility from the stable hand-start field, not surviving stacks; simultaneous busts must each receive their eligible offer before finalizing the tournament. Hosts set the policy before the first hand; admin defaults apply only to new games. Preserve unlimited rebuys in existing rebuy-enabled games and the disabled policy of legacy freezeouts. Bots decide once, by fair coin flip, five seconds after the showdown hold; host pause freezes that decision timer. Reuse the normal rebuy accounting and table/blind hold.
- Keep table event overlays off the cards during the full showdown hold. Persist shared rebuy decisions for a four-second presentation before the next deal; reconnects and host pause must preserve that hold. An explicit host pause replaces the whole play area for all viewers, including during showdown; resume restores the remaining viewing time.

- Persist host setup defaults in room configuration. Apply them only when creating a new game; preserve host overrides and existing game settings. Validate default blinds, stack, payout total, and timers against the host form limits.

## Diagnostics

- Preserve bounded, owner-only diagnostics in the external data directory. Log normalized requests and error context without credentials, tokens, raw bodies/queries, names, private cards, or raw exception messages. Diagnostic failures must never block requests or game progression. Log viewing requires a current admin role; search only the fixed retained diagnostic files, never caller-supplied paths.

## Delivery

Deploy committed source while preserving credentials and stored room data. Check the actual launch service and OS sandbox permit only the configured primary loopback listener. Keep deployment configuration persistent across restarts.
