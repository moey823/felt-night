# Table UX

The table is the primary workspace. A player needs their cards, opponents and stacks, current bets, board, pot, and a stable action area. Room configuration and testing do not belong in that workspace.

## Interaction model

- New game creates a lobby and opens one host setup dialog. Hosts own the name, buy-in, starting stack, blinds, level duration, shot clock, and payouts.
- Payout sliders redistribute the remaining shares so their total stays at 100%. The number of occupied seats determines the tournament size at Start.
- Accounts with the admin role use the Admin button to configure shared bet presets, all-in pacing, announcement durations, result holds, and test bots. Admins keep their normal player account and can manage admin roles; the last admin cannot be removed.
- Host End game requires two deliberate confirmations. An ended game has no invented winner or payout.
- Each player’s latest action stays in their seat footer through the betting round. Their cumulative street contribution appears as a visible chip stack and amount outside their container, fitted onto the felt clear of seats, the board, and other contributions; those chips collect into the pot between streets. Hole cards and board cards devote the top half to a large centered rank and the bottom half to a matching suit. Visible glyph bounds determine centering so different ranks and suits align consistently; both complete hole-card faces remain visible, including on phones; the turn ring and timer remain separate, and the accessible play-by-play announcer stays visually hidden so it does not cover the felt. Reactions use larger emoji bursts that stay visible for about three seconds; reduced-motion viewers see a static burst.
- The betting dock reserves three equal, stationary primary-action slots for Fold, Check or Call, and Bet or Raise. Presets and the sizing slider use separate rows, so changing the action label or amount does not move a primary button.
- The blind-level strip shows a live countdown. A paused clock stays frozen, and a pending level change reads “Next hand.”
- Showdown winners get a compact Won + amount badge in the seat footer, with a brief gold pulse that respects reduced-motion preferences. Exposed hand values appear in prominent badges outside each player box, fitted clear of seats and the board; winning hands use gold. Eliminated players retain an Out status beside their stack.
- Table controls live in a compact menu, with Full screen and Sit out beside Menu. Settings use a native modal dialog with a visible close control and scrolling content. An acting player’s final five shot-clock seconds appear as a large table alert; it freezes during pauses, clears when the actor changes or the deadline expires, and remains prominent without flashing for reduced-motion users. Once betting is locked by an all-in, live runout odds take priority over a prior action badge; while betting remains open, the full action badge stays visible.
- Gameplay stays inside a fixed viewport without document scrolling. Chat opens from the table menu and the table surface reclaims the former preview/composer row; the full original seat ring keeps stable positions as players leave. Dealer, turn clock, action, and wager markers stay beside their owning seat. Short landscape places actions in a side dock; portrait keeps the dock below the felt. Modal content scrolls internally with its close control kept reachable.
- In a waiting lobby, the host can add a bot directly to an empty seat; the control disappears once play begins or the seat is filled. Players can enlarge an occupied seat’s profile photo in an authenticated, dismissible overlay. Rebuy offers show a server-timed 60-second window, original buy-in/stack, explicit confirmation and decline controls, plus buy-in, rebuy, pool, and payout accounting in dollars. Showdown finishes before offers open; play and the blind-level clock wait until every offer resolves, and other players see “Waiting for [name] to rebuy.” Chip stacks and wagers remain chip counts.
- Admins can inspect archived finished games and delete them through a separate confirmation step.
- Fullscreen and a requested pop-out are optional. Installed mobile use requests standalone presentation; browser chrome remains browser-controlled.

## Reference observations

PokerStars documents separate table appearance settings, preferred seats, and bet shortcuts above the sizing slider. Classic table screenshots use a seat ring, board and pot in the center, and betting controls outside the playing surface. Felt Night adopts those functional relationships without copying branded assets.

- [PokerStars table appearance](https://www.pokerstars.com/help/articles/table-appearance-feature/232136/)
- [PokerStars bet slider](https://www.pokerstars.com/help/articles/bet-slider-options/)
- [Classic table screenshot comparison](https://f5poker.com/poker-news/2019/4/24/and-after-comparing-pokerstars-legacy-engine-and-aurora-which-do-you-prefer-some-side-side-compariso/)
- [MDN window.open](https://developer.mozilla.org/en-US/docs/Web/API/Window/open)
- [MDN standalone web apps](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Create_a_standalone_app)

## Regression priorities

Previous geometry tests passed while seat names were truncated to fragments and actions were squeezed into a 74-pixel footer. Passing a non-overlap test alone does not establish a usable layout.

Verify readable names, stable seat positions, primary touch target sizes, card visibility, no board/seat/wager intersections, reachable mobile modal controls, and spectator/all-in states. Use isolated development data for browser tests. Review actual screenshots as well as geometry assertions.
