# Table UX

The table is the primary workspace. A player needs their cards, opponents and stacks, current bets, board, pot, and a stable action area. Room configuration and testing do not belong in that workspace.

## Interaction model

- New game creates a lobby and opens one host setup dialog. Hosts own the name, buy-in, starting stack, blinds, level duration, shot clock, and payouts.
- Payout sliders redistribute the remaining shares so their total stays at 100%. The number of occupied seats determines the tournament size at Start.
- The dedicated admin account configures shared bet presets, all-in pacing, announcement durations, result holds, and test bots.
- Host End game requires two deliberate confirmations. An ended game has no invented winner or payout.
- Gameplay announcements use the header title area without changing the felt or card positions.
- The betting dock reserves three equal, stationary primary-action slots for Fold, Check or Call, and Bet or Raise. Presets and the sizing slider use separate rows, so changing the action label or amount does not move a primary button.
- The blind-level strip shows a live countdown. A paused clock stays frozen, and a pending level change reads “Next hand.”
- Showdown winners get a compact Won + amount badge beside their seat, with a brief gold pulse that respects reduced-motion preferences. Eliminated players retain an OUT label in the stack row.
- Table controls live in a compact menu. Settings use a native modal dialog with a visible close control and scrolling content.
- Gameplay stays inside a fixed viewport without document scrolling: a compact, readable chat preview and quick-send rail stays visible, and the full original seat ring keeps stable positions as players leave. Dealer, turn clock, action, and wager markers stay beside their owning seat. Short landscape places actions in a side dock; portrait keeps the dock below the felt. Modal content scrolls internally with its close control kept reachable.
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
