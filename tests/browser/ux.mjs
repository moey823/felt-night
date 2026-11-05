// Headless UX regressions against the isolated game server.
export default async function ux([one, two], sleep, roomPassword) {
  const pages = [one, two];
  const evaluate = (page, fn, ...args) =>
    page.evaluate('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')');
  const visible = selector => Boolean(document.querySelector(selector)?.offsetWidth);

  function assert(condition, message) {
    if (!condition) throw Error(message);
  }

  async function wait(page, predicate, ...args) {
    for (let attempt = 0; attempt < 120; attempt++) {
      const result = await evaluate(page, predicate, ...args);
      if (result) return result;
      await sleep(100);
    }
    const detail = await evaluate(page, () => document.body.innerText.slice(-1000));
    throw Error('Timed out: ' + predicate + ' ' + args + ' | ' + detail);
  }

  async function waitLong(page, predicate, ...args) {
    for (let attempt = 0; attempt < 300; attempt++) {
      const result = await evaluate(page, predicate, ...args);
      if (result) return result;
      await sleep(100);
    }
    throw Error('Timed out after 30 seconds: ' + predicate + ' ' + args);
  }

  async function click(page, selector) {
    await wait(page, query => {
      const node = document.querySelector(query);
      if (!node?.offsetWidth || node.disabled) return false;
      node.click();
      return true;
    }, selector);
  }

  async function setInput(page, selector, value) {
    await evaluate(page, (query, nextValue) => {
      const node = document.querySelector(query);
      if (!node) throw Error('Missing input ' + query);
      node.value = String(nextValue);
      for (const type of ['input', 'change']) {
        node.dispatchEvent(new Event(type, {bubbles: true}));
      }
    }, selector, value);
  }

  async function signIn(page, user) {
    await wait(page, visible, '#login-name');
    await setInput(page, '#login-name', user.username);
    await setInput(page, '#login-password', user.password);
    await evaluate(page, () => document.querySelector('#login-form').requestSubmit());
    await wait(page, visible, '#app-panel');
  }

  async function switchUser(page, user) {
    const loggedIn = await evaluate(page, () =>
      Boolean(document.querySelector('#logout-button')?.offsetWidth));
    if (loggedIn) {
      await click(page, '#logout-button');
      await wait(page, visible, '#login-name');
    }
    await signIn(page, user);
  }

  async function openTable(page, name) {
    const hasOpenTable = await evaluate(page, () =>
      Boolean(document.querySelector('#close-table-button')?.offsetWidth));
    if (hasOpenTable) {
      await click(page, '#close-table-button');
      await wait(page, visible, '#table-list');
    }

    await wait(page, tableName => {
      const button = [...document.querySelectorAll('[data-open-table]')]
        .find(node => node.innerText.includes(tableName));
      if (!button) return false;
      button.click();
      return true;
    }, name);
    await wait(page, tableName =>
      document.querySelector('#view-table-name')?.textContent === tableName, name);
  }

  const origin = await one.evaluate('location.origin');
  const api = origin + '/poker/api';

  async function request(path, session, data) {
    const headers = {Origin: origin};
    if (session) {
      Object.assign(headers, {
        Cookie: session.cookie,
        'X-SitNgo-Session': session.session_proof,
        'X-SitNgo-CSRF': session.csrf,
      });
    }
    if (data !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(api + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers,
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const json = await response.json();
    if (!response.ok) throw Error(path + ' ' + JSON.stringify(json));

    if (path === '/register' || path === '/login') {
      const cookie = response.headers.get('set-cookie')?.split(';')[0];
      if (!cookie) throw Error(path + ' did not issue a session cookie');
      return {...json, cookie};
    }
    if (path.endsWith('/last-hand')) return json;
    return json.table;
  }

  const stamp = Date.now().toString(36);
  const users = [];
  for (let index = 0; index < 16; index++) {
    const username = ('UX' + stamp + 'P' + index).slice(0, 24);
    const password = 'FeltQA_' + stamp + '_' + index + '_Pass';
    const session = await request('/register', null, {
      room_password: roomPassword,
      username,
      password,
    });
    users.push({...session, username, password});
  }

  const findUser = (group, playerId) =>
    group.find(user => user.player.id === playerId);

  async function createTable(name, entrants, overrides = {}) {
    const config = {
      max_seats: entrants.length,
      starting_stack: 1000,
      small_blind: 10,
      big_blind: 20,
      level_minutes: 79,
      turn_seconds: 3600,
      runout_seconds: 1,
      buy_in: 10,
      payout_percentages: [60, 25, 15],
      ...overrides,
    };
    const created = await request('/tables', entrants[0], {name, ...config});
    const path = '/tables/' + created.id;
    for (let index = 1; index < entrants.length; index++) {
      await request(path + '/seat', entrants[index], {seat_no: index});
    }
    const started = await request(path + '/start', entrants[0], {});
    return {id: created.id, name, path, entrants, config, started};
  }

  const tableActor = table => findUser(table.entrants, table.started.actor_id);
  const layoutFailures = [];

  function layoutSnapshot(expectedSeats, canAct) {
    const rect = node => {
      const value = node.getBoundingClientRect();
      return {
        left: value.left,
        top: value.top,
        right: value.right,
        bottom: value.bottom,
        width: value.width,
        height: value.height,
      };
    };
    const overlap = (a, b) =>
      Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
      Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

    const header = document.querySelector('.topbar');
    const surface = document.querySelector('.table-surface');
    const blindStrip = document.querySelector('#blind-strip');
    const felt = document.querySelector('#felt');
    const seatGrid = document.querySelector('#seat-grid');
    const panel = document.querySelector('#action-panel');
    const board = document.querySelector('#board-cards');
    const heroPair = document.querySelector('.seat-card.is-me .seat-cards.is-viewer-cards');
    const actionButtons = [...document.querySelectorAll('#action-panel .action-buttons [data-poker-action]')];
    const seats = [...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')];
    const markers = [...document.querySelectorAll(
      '#seat-grid .seat-action:not(.is-unplaced), ' +
      '#seat-grid .seat-wager:not(.is-unplaced), ' +
      '#seat-grid .dealer-marker:not(.is-unplaced)'
    )];
    const blindNumbers = [...(blindStrip?.querySelectorAll('.blind-tile strong') || [])];
    const turnMarker = document.querySelector('#seat-grid .seat-action.kind-turn');
    const turnClock = document.querySelector('#seat-grid .seat-turn-clock');
    const heroSeat = document.querySelector('#seat-grid .seat-card.is-me');
    const heroCards = [...document.querySelectorAll(
      '.seat-card.is-me .seat-cards.is-viewer-cards .mini-card'
    )];
    const controls = [...document.querySelectorAll(
      '#action-panel button:not([disabled]), #action-panel input:not([disabled])'
    )];
    const errors = [];

    if (!header || !['sticky', 'fixed'].includes(getComputedStyle(header).position)) {
      errors.push('header is not sticky');
    }
    if (header && header.getBoundingClientRect().height > (innerWidth < 800 ? 64 : 90)) {
      errors.push('header is too tall');
    }
    if (!surface?.contains(blindStrip)) errors.push('blind strip is outside the table surface');
    if (!surface?.contains(panel) || !panel || panel.hidden) {
      errors.push('action panel is not visible inside the table surface');
    }
    if (felt?.contains(panel)) errors.push('action panel is inside the felt');
    if (actionButtons.length !== 3) errors.push('expected three persistent primary actions, saw ' + actionButtons.length);
    if (!canAct && actionButtons.some(button => !button.disabled)) errors.push('an off-turn primary action is enabled');
    if (document.querySelector('[data-preaction], #allInConfirm, [data-action="confirm-all-in"], #hand-result')) {
      errors.push('removed gameplay control or payout box remains in the DOM');
    }
    if (/uncalled/i.test(document.body.innerText)) errors.push('uncalled-bet UI remains');
    if (!board?.offsetWidth) errors.push('community card area is not visible');
    if (seats.length !== expectedSeats) errors.push('expected ' + expectedSeats + ' seats, saw ' + seats.length);
    if (document.querySelector('#seat-grid .seat-empty')) errors.push('empty seat placeholders remain');
    if (heroCards.length !== 2) errors.push('expected two visible hero cards, saw ' + heroCards.length);
    if (document.documentElement.scrollWidth > innerWidth + 1) errors.push('horizontal page overflow');
    if (window.scrollY > 1) errors.push('page was scrolled to fit the table');
    if (!blindNumbers.length) errors.push('blind strip has no numeric HUD values');
    if (!turnMarker || turnMarker.classList.contains('is-unplaced') || !turnMarker.offsetWidth) {
      errors.push('TO ACT marker is missing or unplaced');
    }
    if (!turnClock || turnClock.classList.contains('is-unplaced') || !turnClock.offsetWidth) {
      errors.push('seat turn clock is missing or unplaced');
    }

    const feltBox = felt && rect(felt);
    const panelBox = panel && rect(panel);
    const heroPairBox = heroPair && rect(heroPair);
    const boardBox = board && rect(board);
    const footerLimit = innerWidth > innerHeight ? 72 : 80;
    if (panelBox && panelBox.height > footerLimit + 1) {
      errors.push('action footer exceeds ' + footerLimit + 'px: ' + panelBox.height.toFixed(1));
    }
    if (panelBox && surface && (
      panelBox.left < surface.getBoundingClientRect().left - 1 ||
      panelBox.right > surface.getBoundingClientRect().right + 1 ||
      panelBox.top < surface.getBoundingClientRect().top - 1 ||
      panelBox.bottom > surface.getBoundingClientRect().bottom + 1
    )) errors.push('action footer escapes table surface');
    const heroCenterOffset = heroPairBox && feltBox ? {
      x: +(((heroPairBox.left + heroPairBox.right) - (feltBox.left + feltBox.right)) / 2).toFixed(1),
      y: +(((heroPairBox.top + heroPairBox.bottom) - (feltBox.top + feltBox.bottom)) / 2).toFixed(1),
    } : null;
    const heroBottomGap = heroPairBox && feltBox ? +(feltBox.bottom - heroPairBox.bottom).toFixed(1) : null;
    if (heroCards.length && (!heroCenterOffset || Math.abs(heroCenterOffset.x) > 2)) {
      errors.push('hero pair is not horizontally centered: ' + JSON.stringify(heroCenterOffset));
    }
    if (heroCenterOffset && heroCenterOffset.y < 0) errors.push('hero pair is not in the lower half of the felt');
    if (heroBottomGap != null && (heroBottomGap < -1 || heroBottomGap > 24)) {
      errors.push('hero pair is too far from the felt bottom: ' + heroBottomGap + 'px');
    }
    const gridBox = seatGrid && rect(seatGrid);
    const stripBox = blindStrip && rect(blindStrip);
    const seatBoxes = seats.map(seat => ({
      seatNo: seat.dataset.seatNo,
      name: seat.querySelector('.seat-name')?.innerText || '',
      ...rect(seat),
    }));
    const markerBoxes = markers.map(marker => ({
      type: marker.classList.contains('seat-action') ? 'action' :
        marker.classList.contains('seat-wager') ? 'wager' : 'dealer',
      seatNo: marker.getAttribute('data-seat-no') ||
        marker.getAttribute('data-action-seat') ||
        marker.getAttribute('data-marker-seat') || '',
      ...rect(marker),
    }));
    const blindNumberBoxes = blindNumbers.map(value => ({
      text: value.innerText,
      ...rect(value),
      clientWidth: value.clientWidth,
      scrollWidth: value.scrollWidth,
      clientHeight: value.clientHeight,
      scrollHeight: value.scrollHeight,
    }));
    const heroSeatBox = heroSeat && rect(heroSeat);
    const turnMarkerBox = turnMarker && rect(turnMarker);
    const turnClockBox = turnClock && rect(turnClock);

    if (feltBox && (feltBox.top < -1 || feltBox.bottom > innerHeight + 1)) {
      errors.push('felt is clipped by the viewport');
    }
    if (panelBox && (
      panelBox.left < -1 || panelBox.right > innerWidth + 1 ||
      panelBox.top < -1 || panelBox.bottom > innerHeight + 1
    )) errors.push('action panel is clipped by the viewport');
    if (boardBox && boardBox.width && (
      boardBox.left < -1 || boardBox.right > innerWidth + 1 ||
      boardBox.top < -1 || boardBox.bottom > innerHeight + 1
    )) errors.push('community card area is clipped');
    if (stripBox && gridBox && stripBox.bottom > gridBox.top + 1) {
      errors.push('blind strip is not above the seat area');
    }
    for (const [label, markerBox] of [['TO ACT', turnMarkerBox], ['seat turn clock', turnClockBox]]) {
      if (!markerBox) continue;
      if (feltBox && (
        markerBox.left < feltBox.left - 1 || markerBox.right > feltBox.right + 1 ||
        markerBox.top < feltBox.top - 1 || markerBox.bottom > feltBox.bottom + 1
      )) errors.push(label + ' escapes felt bounds');
      if (
        markerBox.left < -1 || markerBox.right > innerWidth + 1 ||
        markerBox.top < -1 || markerBox.bottom > innerHeight + 1
      ) errors.push(label + ' is clipped by viewport');
    }
    for (let index = 0; index < markers.length; index++) {
      const markerBox = markerBoxes[index];
      if (!markerBox.width || !markerBox.height) {
        errors.push(markerBox.type + ' marker for seat ' + markerBox.seatNo + ' has no visible bounds');
      }
      if (feltBox && (
        markerBox.left < feltBox.left - 1 || markerBox.right > feltBox.right + 1 ||
        markerBox.top < feltBox.top - 1 || markerBox.bottom > feltBox.bottom + 1
      )) errors.push(markerBox.type + ' marker for seat ' + markerBox.seatNo + ' escapes felt bounds');
      if (
        markerBox.left < -1 || markerBox.right > innerWidth + 1 ||
        markerBox.top < -1 || markerBox.bottom > innerHeight + 1
      ) errors.push(markerBox.type + ' marker for seat ' + markerBox.seatNo + ' is clipped by viewport');
    }
    for (const value of blindNumbers) {
      if (value.scrollWidth > value.clientWidth + 1 || value.scrollHeight > value.clientHeight + 1) {
        errors.push('blind HUD value is truncated: ' + value.innerText);
      }
    }
    if (expectedSeats >= 7 && innerWidth === 320 && innerHeight === 568 && heroSeatBox &&
        heroSeatBox.top + heroSeatBox.height / 2 < innerHeight / 2) {
      errors.push('hero seat is not in the lower half at 320x568');
    }

    const notice = document.querySelector('#notice');
    if (notice && felt) {
      const wasHidden = notice.hidden;
      const previousText = notice.textContent;
      const beforeNotice = rect(felt).top;
      notice.hidden = false;
      notice.textContent = 'UX layout notice';
      const afterNotice = rect(felt).top;
      notice.textContent = previousText;
      notice.hidden = wasHidden;
      if (Math.abs(afterNotice - beforeNotice) > 1) errors.push('notice pushed the felt down');
    }

    for (const card of heroCards) {
      const cardBox = rect(card);
      if (
        cardBox.left < -1 || cardBox.right > innerWidth + 1 ||
        cardBox.top < -1 || cardBox.bottom > innerHeight + 1
      ) errors.push('hero card is clipped');
      if (panelBox && overlap(cardBox, panelBox) > 1) errors.push('hero card overlaps action panel');
    }

    for (let index = 0; index < seats.length; index++) {
      const seat = seats[index];
      const seatBox = rect(seat);
      if (feltBox && (
        seatBox.left < feltBox.left - 1 || seatBox.right > feltBox.right + 1 ||
        seatBox.top < feltBox.top - 1 || seatBox.bottom > feltBox.bottom + 1
      )) errors.push('seat ' + seat.dataset.seatNo + ' escapes felt bounds');
      if (boardBox && overlap(seatBox, boardBox) > 5) {
        errors.push('seat ' + seat.dataset.seatNo + ' overlaps community cards');
      }
      if (panelBox && overlap(seatBox, panelBox) > 5) {
        errors.push('seat ' + seat.dataset.seatNo + ' overlaps the action panel');
      }
      for (let previous = 0; previous < index; previous++) {
        if (overlap(seatBox, rect(seats[previous])) > 5) {
          errors.push('seat ' + seat.dataset.seatNo + ' overlaps seat ' + seats[previous].dataset.seatNo);
        }
      }
    }
    if (boardBox && panelBox && overlap(boardBox, panelBox) > 5) {
      errors.push('community cards overlap the action panel');
    }

    for (const control of controls) {
      const controlBox = rect(control);
      const hit = document.elementFromPoint(
        controlBox.left + controlBox.width / 2,
        controlBox.top + controlBox.height / 2
      );
      if (
        !controlBox.width || !controlBox.height ||
        controlBox.left < -1 || controlBox.right > innerWidth + 1 ||
        controlBox.top < -1 || controlBox.bottom > innerHeight + 1 ||
        !(hit === control || control.contains(hit))
      ) errors.push('control hit test failed: ' +
        (control.textContent || control.id || control.tagName).trim());
    }

    return {
      errors,
      viewport: [innerWidth, innerHeight],
      header: header && rect(header),
      felt: feltBox,
      action: panelBox,
      footerLimit,
      actionButtons: actionButtons.length,
      heroPair: heroPairBox,
      heroCenterOffset,
      heroBottomGap,
      cards: heroCards.map(rect),
      board: boardBox,
      strip: stripBox,
      seats: seatBoxes,
      markers: markerBoxes,
      blindNumbers: blindNumberBoxes,
      heroSeat: heroSeatBox,
      turnMarker: turnMarkerBox,
      turnClock: turnClockBox,
      controls: controls.length,
      scrollY: window.scrollY,
    };
  }

  async function checkViewports(page, seatCount, label, canAct = true) {
    await wait(page, visible, '#seat-grid .seat-action.kind-turn:not(.is-unplaced)');
    await wait(page, visible, '#seat-grid .seat-turn-clock:not(.is-unplaced)');
    const viewports = [
      {width: 320, height: 740},
      {width: 320, height: 568},
      {width: 390, height: 844},
      {width: 667, height: 375},
      {width: 844, height: 390},
      {width: 1366, height: 768},
    ];
    const failures = [];
    for (const viewport of viewports) {
      await page.resize(viewport.width, viewport.height);
      await sleep(950); // Let the normal live-table refresh run after each resize.
      const report = await evaluate(page, layoutSnapshot, seatCount, canAct);
      const name = label + '-' + viewport.width + 'x' + viewport.height;
      await page.screenshot(name);
      console.log(name, JSON.stringify(report));
      if (report.errors.length) {
        failures.push(viewport.width + 'x' + viewport.height + ': ' + report.errors.join(', '));
      }
    }
    if (failures.length) layoutFailures.push(label + ': ' + failures.join(' | '));
  }

  // Verify the persistent action footer for the actor and the waiting player.
  const headsUp = await createTable('UX Heads Up ' + stamp, users.slice(0, 2));
  const headsUpActor = tableActor(headsUp);
  const headsUpOther = headsUp.entrants.find(user => user !== headsUpActor);
  await switchUser(one, headsUpActor);
  await switchUser(two, headsUpOther);
  await openTable(one, headsUp.name);
  await openTable(two, headsUp.name);
  await wait(one, visible, '#action-panel:not([hidden]) #action-controls [data-poker-action]');

  const headsUpChecks = await Promise.all(pages.map(page => evaluate(page, () => {
    const buttons = [...document.querySelectorAll('#action-panel .action-buttons [data-poker-action]')];
    const panel = document.querySelector('#action-panel');
    const felt = document.querySelector('#felt');
    const surface = document.querySelector('.table-surface');
    return {
      count: buttons.length,
      disabled: buttons.map(button => button.disabled),
      panelVisible: Boolean(panel && !panel.hidden),
      panelOutsideFelt: Boolean(panel && felt && !felt.contains(panel)),
      panelInsideSurface: Boolean(panel && surface && surface.contains(panel)),
      removedControls: Boolean(document.querySelector('[data-preaction], #allInConfirm, [data-action="confirm-all-in"], #hand-result')),
      blindStrip: document.querySelector('#blind-strip')?.innerText || '',
      stripInsideSurface: surface?.contains(document.querySelector('#blind-strip')),
    };
  })));
  assert(headsUpChecks.every(result => result.count === 3), 'The action footer did not keep three primary buttons');
  assert(headsUpChecks.every(result => result.panelVisible && result.panelOutsideFelt && result.panelInsideSurface),
    'Action footer is not visible outside the felt and inside the table surface');
  assert(headsUpChecks.every(result => !result.removedControls), 'A removed preaction, confirmation, or payout box remains');
  assert(headsUpChecks.every(result =>
    result.stripInsideSurface && !/players left|starting stack/i.test(result.blindStrip)
  ), 'Blind strip is outside the surface or includes gameplay tiles');
  assert(headsUpChecks[1].disabled.every(Boolean), 'An off-turn primary action is enabled');

  await wait(one, visible, '#recent-action-button');
  await click(one, '#recent-action-button');
  await wait(one, () => document.querySelector('#recent-action-dialog')?.open === true);
  assert(
    await evaluate(one, () => document.querySelector('#recent-action-button')?.getAttribute('aria-expanded') === 'true'),
    'Recent action button did not expose its open state'
  );
  await click(one, '#recent-action-close');
  await wait(one, () => !document.querySelector('#recent-action-dialog')?.open);
  assert(
    await evaluate(one, () => document.querySelector('#recent-action-button')?.getAttribute('aria-expanded') === 'false'),
    'Recent action button did not clear its open state'
  );
  await click(one, '#recent-action-button');
  await wait(one, () => document.querySelector('#recent-action-dialog')?.open === true);
  await one.pressEscape();
  await wait(one, () => !document.querySelector('#recent-action-dialog')?.open);
  assert(
    await evaluate(one, () => document.querySelector('#recent-action-button')?.getAttribute('aria-expanded') === 'false'),
    'Escape did not clear modal aria-expanded'
  );
  console.log('Recent action dialog closes by button and Escape with synchronized aria-expanded.');

  const initialView = await request(headsUp.path, headsUpActor);
  const hero = initialView.seats.find(seat => seat.id === headsUpActor.player.id);
  const bigBlind = initialView.blinds?.big || headsUp.config.big_blind;
  const expectedBb = hero.stack / bigBlind >= 1
    ? Math.floor(hero.stack / bigBlind)
    : Number((hero.stack / bigBlind).toFixed(1));
  await checkViewports(one, 2, 'heads-up', true);

  const initialStackText = await evaluate(one, () =>
    document.querySelector('.seat-card.is-me .seat-stack[data-chip-display-toggle]')?.innerText.trim()
  );
  assert(initialStackText, 'Hero stack toggle is missing');
  await click(one, '.seat-card.is-me .seat-stack[data-chip-display-toggle]');
  await wait(one, () =>
    /BB/i.test(document.querySelector('.seat-card.is-me .seat-stack[data-chip-display-toggle]')?.innerText || '')
  );
  const bbStackText = await evaluate(one, () =>
    document.querySelector('.seat-card.is-me .seat-stack[data-chip-display-toggle]').innerText.trim()
  );
  const bbAmount = bbStackText.match(/([\d,]+(?:\.\d+)?)\s*BB/i);
  assert(
    bbAmount && Number(bbAmount[1].replace(/,/g, '')) === expectedBb,
    'Wrong BB rounding: ' + bbStackText + ' from ' + hero.stack + ' chips'
  );

  await evaluate(one, () =>
    document.querySelector('.seat-card.is-me .seat-stack[data-chip-display-toggle]').focus()
  );
  await sleep(2200);
  assert(
    await evaluate(one, () =>
      document.activeElement === document.querySelector('.seat-card.is-me .seat-stack[data-chip-display-toggle]')
    ),
    'BB toggle lost keyboard focus during polling'
  );

  await evaluate(one, () => {
    window.uxActionPayload = null;
    const originalFetch = window.fetch;
    window.fetch = async function(url, options) {
      const response = await originalFetch.apply(this, arguments);
      if (String(url).endsWith('/action') && options?.body) {
        window.uxActionPayload = JSON.parse(options.body);
      }
      return response;
    };
  });
  await click(one, '[data-raise-preset][data-target="50"]');
  await wait(one, () => Number(document.querySelector('#raise-amount')?.value) === 50);
  await click(one, '[data-poker-action="raise_to"]');
  await wait(one, () => Boolean(window.uxActionPayload));
  const payload = await evaluate(one, () => window.uxActionPayload);
  assert(
    payload.amount === 50 && ['raise', 'bet'].includes(payload.action),
    'Raise payload was not in chips: ' + JSON.stringify(payload)
  );
  const actionBadge = await evaluate(one, () =>
    [...document.querySelectorAll('.seat-action')].map(node => node.innerText).join(' ')
  );
  assert(/BB/i.test(actionBadge), 'Action badge did not reformat raw chip data in BB mode: ' + actionBadge);

  const afterRaise = await request(headsUp.path, headsUpActor);
  const updatedStack = afterRaise.seats.find(seat => seat.id === headsUpActor.player.id).stack;
  const displayAfterRaise = await evaluate(one, () =>
    document.querySelector('.seat-card.is-me .seat-stack[data-chip-display-toggle]')?.innerText || ''
  );
  assert(/BB/i.test(displayAfterRaise), 'BB mode reset after an action');
  await click(one, '.seat-card.is-me .seat-stack[data-chip-display-toggle]');
  await wait(one, () =>
    /chips/i.test(document.querySelector('.seat-card.is-me .seat-stack[data-chip-display-toggle]')?.innerText || '')
  );
  const restoredStack = await evaluate(one, () =>
    document.querySelector('.seat-card.is-me .seat-stack[data-chip-display-toggle]').innerText.trim()
  );
  assert(restoredStack.includes(String(updatedStack)), 'Chip stack did not restore: ' + restoredStack);
  console.log('Hero stack toggles to BB, rounds down, restores chips, and sends chip payloads.');

  // A sub-big-blind stack displays one decimal place.
  const fractional = await createTable('UX Fractional BB ' + stamp, users.slice(2, 4), {
    starting_stack: 100,
    small_blind: 50,
    big_blind: 100,
  });
  const fractionalActor = tableActor(fractional);
  const fractionalOther = fractional.entrants.find(user => user !== fractionalActor);
  await switchUser(one, fractionalActor);
  await switchUser(two, fractionalOther);
  await openTable(one, fractional.name);
  await openTable(two, fractional.name);
  await wait(one, visible, '#action-panel:not([hidden]) #action-controls [data-poker-action]');
  const fractionalView = await request(fractional.path, fractionalActor);
  const fractionalStack = fractionalView.seats.find(seat => seat.id === fractionalActor.player.id).stack;
  assert(fractionalStack > 0 && fractionalStack < 100, 'Expected a positive sub-BB hero stack');
  await click(one, '.seat-card.is-me .seat-stack[data-chip-display-toggle]');
  await wait(one, () =>
    /BB/i.test(document.querySelector('.seat-card.is-me .seat-stack[data-chip-display-toggle]')?.innerText || '')
  );
  const fractionalText = await evaluate(one, () =>
    document.querySelector('.seat-card.is-me .seat-stack[data-chip-display-toggle]').innerText.trim()
  );
  const fractionalAmount = fractionalText.match(/([\d,]+(?:\.\d+)?)\s*BB/i);
  assert(
    fractionalAmount && Number(fractionalAmount[1]) === Number((fractionalStack / 100).toFixed(1)),
    'Sub-BB value did not use one decimal: ' + fractionalText
  );

  // Three players retain Check/Fold; zero-stack all-ins stay visible until settlement.
  const multiway = await createTable('UX Multiway ' + stamp, users.slice(4, 7), {
    starting_stack: 100,
    small_blind: 1,
    big_blind: 2,
    runout_seconds: 1,
  });
  const multiwayActor = tableActor(multiway);
  const multiwayOther = multiway.entrants.find(user => user !== multiwayActor);
  await switchUser(one, multiwayActor);
  await switchUser(two, multiwayOther);
  await openTable(one, multiway.name);
  await openTable(two, multiway.name);
  await wait(one, visible, '#action-panel:not([hidden]) #action-controls [data-poker-action]');

  // Off-turn players keep all three actions visible but disabled; no preaction control exists.
  let waitingPage = null;
  const mappedPlayers = [
    {page: one, user: multiwayActor},
    {page: two, user: multiwayOther},
  ];
  for (const entry of mappedPlayers) {
    const view = await request(multiway.path, entry.user);
    if (!view.viewer?.can_act && view.viewer?.seated) {
      waitingPage = entry.page;
      break;
    }
  }
  assert(waitingPage, 'No waiting browser was available for the off-turn action check');
  await wait(waitingPage, visible, '#action-panel:not([hidden])');
  const waitingActions = await evaluate(waitingPage, () => ({
    buttons: [...document.querySelectorAll('#action-panel .action-buttons [data-poker-action]')]
      .map(button => ({action: button.dataset.pokerAction, disabled: button.disabled})),
    preaction: Boolean(document.querySelector('[data-preaction]')),
    confirm: Boolean(document.querySelector('#allInConfirm, [data-action="confirm-all-in"]')),
  }));
  assert(waitingActions.buttons.length === 3, 'Off-turn player lost the persistent action buttons');
  assert(waitingActions.buttons.every(button => button.disabled), 'An off-turn primary action is enabled');
  assert(!waitingActions.preaction && !waitingActions.confirm, 'A removed preaction/confirmation control remains');
  console.log('Off-turn player sees three disabled actions; preaction and all-in confirmation controls are absent.');

  let current = await request(multiway.path, multiwayActor);
  let actions = 0;
  while (current.status === 'playing' && current.actor_id && current.street !== 'showdown' && actions < 10) {
    const actingUser = findUser(multiway.entrants, current.actor_id);
    current = await request(multiway.path + '/action', actingUser, {
      action: 'all_in',
      expected_hand: current.hand_no,
      expected_turn_version: current.turn_version,
    });
    actions++;
  }
  const zeroStackSeat = current.seats.find(seat =>
    seat.stack === 0 && (seat.all_in || seat.is_all_in)
  );
  assert(zeroStackSeat && current.street !== 'showdown', 'First all-in did not leave a live zero-stack seat');

  const zeroStackId = zeroStackSeat.id || zeroStackSeat.player_id;
  const livePage = mappedPlayers.find(entry => entry.user.player.id !== zeroStackId)?.page || one;
  await wait(livePage, playerId => {
    const seat = [...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')]
      .find(node => node.dataset.playerId === playerId);
    return Boolean(seat && /all.?in/i.test(seat.innerText));
  }, zeroStackId);
  const liveZeroStack = await evaluate(livePage, playerId => {
    const seat = [...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')]
      .find(node => node.dataset.playerId === playerId);
    return {present: Boolean(seat), text: seat?.innerText || ''};
  }, zeroStackId);
  assert(
    liveZeroStack.present && /all.?in/i.test(liveZeroStack.text),
    'Live zero-stack all-in vanished: ' + JSON.stringify(liveZeroStack)
  );

  // Resolve tied runouts as well: if more than one player survives, force
  // another all-in hand until the tournament has one winner.
  for (let hand = 0; hand < 6 && current.status !== 'completed'; hand++) {
    let handActions = 0;
    while (
      current.status === 'playing' && current.actor_id &&
      current.street !== 'showdown' && handActions < 10
    ) {
      const actingUser = findUser(multiway.entrants, current.actor_id);
      current = await request(multiway.path + '/action', actingUser, {
        action: 'all_in',
        expected_hand: current.hand_no,
        expected_turn_version: current.turn_version,
      });
      handActions++;
    }
    for (let tick = 0; tick < 12 && current.status === 'playing' && !current.actor_id; tick++) {
      await sleep(1050);
      current = await request(multiway.path, multiway.entrants[0]);
    }
  }

  assert(
    current.status === 'completed' && current.seats.filter(seat => seat.stack > 0).length === 1,
    'All-in hands did not settle to one survivor: ' + current.status + '/' + current.street
  );
  await wait(livePage, () =>
    document.querySelector('#hand-result')?.offsetWidth ||
    /complete/i.test(document.querySelector('#view-status')?.innerText || '')
  );
  const finalLayout = await evaluate(livePage, () => {
    const felt = document.querySelector('#felt').getBoundingClientRect();
    const seats = [...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')].map(node => {
      const bounds = node.getBoundingClientRect();
      return {
        id: node.dataset.playerId,
        left: bounds.left,
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
      };
    });
    return {
      seats,
      empty: document.querySelectorAll('#seat-grid .seat-empty').length,
      felt: {left: felt.left, top: felt.top, right: felt.right, bottom: felt.bottom},
    };
  });
  assert(
    finalLayout.seats.length === 1 && finalLayout.empty === 0,
    'Eliminated seats did not reflow: ' + JSON.stringify(finalLayout)
  );
  const survivor = finalLayout.seats[0];
  assert(
    survivor.left >= finalLayout.felt.left - 1 && survivor.right <= finalLayout.felt.right + 1 &&
    survivor.top >= finalLayout.felt.top - 1 && survivor.bottom <= finalLayout.felt.bottom + 1,
    'Survivor is outside the felt after reflow: ' + JSON.stringify(finalLayout)
  );
  console.log('Zero-stack all-in stayed visible; eliminated seats reflowed without empty seats.');

  // A completed all-in hand is replayable while the next hand is live.
  const replayUsers = users.slice(4, 7);
  const replayTable = await createTable('UX Last Hand ' + stamp, replayUsers, {
    starting_stack: 100,
    small_blind: 10,
    big_blind: 20,
    runout_seconds: 1,
  });
  const replayActor = findUser(replayUsers, replayTable.started.actor_id);
  const replaySpectator = users[10];
  await switchUser(one, replaySpectator);
  await switchUser(two, replayActor);
  await openTable(one, replayTable.name);
  await openTable(two, replayTable.name);
  await wait(one, visible, '#last-hand-button');

  await click(one, '#last-hand-button');
  await wait(one, () => document.querySelector('#last-hand-dialog')?.open === true);
  await wait(one, () => document.querySelector('#last-hand-content')?.innerText
    .includes('No completed hand is available yet.'));
  await one.pressEscape();
  await wait(one, () => !document.querySelector('#last-hand-dialog')?.open);
  assert(
    await evaluate(one, () =>
      document.activeElement === document.querySelector('#last-hand-button') &&
      document.querySelector('#last-hand-button')?.getAttribute('aria-expanded') === 'false'
    ),
    'Empty replay Escape did not restore focus to its opener'
  );

  let replayState = replayTable.started;
  const allInUser = findUser(replayUsers, replayState.actor_id);
  replayState = await request(replayTable.path + '/action', allInUser, {
    action: 'all_in',
    expected_hand: replayState.hand_no,
    expected_turn_version: replayState.turn_version,
  });
  const foldedUser = findUser(replayUsers, replayState.actor_id);
  replayState = await request(replayTable.path + '/action', foldedUser, {
    action: 'fold',
    expected_hand: replayState.hand_no,
    expected_turn_version: replayState.turn_version,
  });
  const calledUser = findUser(replayUsers, replayState.actor_id);
  replayState = await request(replayTable.path + '/action', calledUser, {
    action: 'call',
    expected_hand: replayState.hand_no,
    expected_turn_version: replayState.turn_version,
  });
  assert(replayState.runout_at, 'All-in replay scenario did not start its board runout');

  let live = replayState;
  for (let attempt = 0; attempt < 70 && live.hand_no === 1; attempt++) {
    await sleep(100);
    live = await request(replayTable.path, replaySpectator);
  }
  assert(live.hand_no === 2 && live.street === 'preflop',
    'Completed hand did not remain available after the next hand started: ' + live.hand_no + '/' + live.street);
  await wait(one, visible, '#last-hand-button');

  await wait(one, () => /HAND 2/i.test(document.querySelector('#hand-number')?.innerText || ''));
  const liveBoardBefore = await evaluate(one, () => ({
    hand: document.querySelector('#hand-number')?.innerText || '',
    street: document.querySelector('#street-label')?.innerText || '',
    board: document.querySelector('#board-cards')?.innerText || '',
  }));
  await click(one, '#last-hand-button');
  await wait(one, () => document.querySelector('#last-hand-dialog')?.open === true);
  await wait(one, () => document.querySelectorAll('#last-hand-content .replay-player').length === 3);
  const showdown = await evaluate(one, () => ({
    label: document.querySelector('#last-hand-street')?.innerText || '',
    previousDisabled: document.querySelector('#last-hand-prev')?.disabled,
    nextDisabled: document.querySelector('#last-hand-next')?.disabled,
    boardCards: document.querySelectorAll('#last-hand-content .replay-board-cards .mini-card').length,
    exposedCards: document.querySelectorAll('#last-hand-content .replay-player-cards .mini-card').length,
    liveNote: document.querySelector('.replay-live-note')?.innerText || '',
  }));
  assert(/showdown/i.test(showdown.label) && !showdown.previousDisabled && showdown.nextDisabled,
    'Replay did not open at the bounded final street: ' + JSON.stringify(showdown));
  assert(showdown.boardCards === 5 && showdown.exposedCards === 4,
    'Showdown replay did not show five board cards and two exposed hands: ' + JSON.stringify(showdown));
  assert(showdown.liveNote.includes('Live hand continues'),
    'Replay omitted the live-hand note');
  await one.screenshot('last-hand-showdown');
  for (const {width, height} of [{width:320,height:568},{width:667,height:375}]) {
    await one.resize(width, height);
    await sleep(150);
    const modal = await evaluate(one, () => {
      const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
      const dialog=document.querySelector('#last-hand-dialog'), shell=dialog?.querySelector('.last-hand-shell');
      const content=document.querySelector('#last-hand-content'), nav=dialog?.querySelector('.last-hand-nav');
      const previous=document.querySelector('#last-hand-prev'), next=document.querySelector('#last-hand-next');
      const close=document.querySelector('#last-hand-close'), box=dialog?rect(dialog):null, navBox=nav?rect(nav):null;
      const errors=[];
      if(!dialog?.open || !box) errors.push('dialog is not open');
      if(box && (box.left<0 || box.right>innerWidth+1 || box.top<0 || box.bottom>innerHeight+1)) errors.push('dialog is clipped by viewport');
      if(!shell?.offsetWidth || !content?.offsetWidth || !navBox?.height || !close?.offsetWidth) errors.push('modal section or close button is hidden');
      if(navBox && (navBox.left<0 || navBox.right>innerWidth+1 || navBox.top<0 || navBox.bottom>innerHeight+1)) errors.push('street navigation is clipped');
      if(navBox && previous && next) {
        const a=rect(previous), b=rect(next);
        if(a.left<0 || a.right>innerWidth+1 || a.top<0 || a.bottom>innerHeight+1 ||
           b.left<0 || b.right>innerWidth+1 || b.top<0 || b.bottom>innerHeight+1) errors.push('street button is clipped');
        if(Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))>1 &&
           Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top))>1) errors.push('street buttons overlap');
        if(content && content.getBoundingClientRect().bottom>navBox.top+1) errors.push('street navigation overlaps replay content');
      }
      return {errors,viewport:[innerWidth,innerHeight],dialog:box,nav:navBox,content:content?rect(content):null,
        cardsVisible:document.querySelectorAll('#last-hand-content .replay-board-cards .mini-card').length,
        scrollable:Boolean(content && content.scrollHeight>content.clientHeight+1)};
    });
    assert(!modal.errors.length, 'Replay modal does not fit at '+width+'x'+height+': '+JSON.stringify(modal));
    assert(modal.cardsVisible===5, 'Five-card board not available in replay at '+width+'x'+height);
    console.log('Replay modal at', width, 'x', height, JSON.stringify(modal));
    await one.screenshot('last-hand-showdown-'+width+'x'+height);
  }

  const reverseStreets = [
    {name: 'river', cards: 5},
    {name: 'turn', cards: 4},
    {name: 'flop', cards: 3},
    {name: 'preflop', cards: 0},
  ];
  for (const [index, expected] of reverseStreets.entries()) {
    await click(one, '#last-hand-prev');
    await wait(one, street => (document.querySelector('#last-hand-street')?.innerText || '').toLowerCase().includes(street), expected.name);
    const stage = await evaluate(one, () => ({
      label: document.querySelector('#last-hand-street')?.innerText || '',
      boardCards: document.querySelectorAll('#last-hand-content .replay-board-cards .mini-card').length,
      exposedCards: document.querySelectorAll('#last-hand-content .replay-player-cards .mini-card').length,
      previousDisabled: document.querySelector('#last-hand-prev')?.disabled,
      nextDisabled: document.querySelector('#last-hand-next')?.disabled,
    }));
    assert(stage.boardCards === expected.cards && stage.exposedCards === 4,
      'Wrong replay cards at ' + stage.label + ': ' + JSON.stringify(stage));
    assert(stage.previousDisabled === (index === reverseStreets.length - 1) && !stage.nextDisabled,
      'Replay previous navigation bounds failed at ' + stage.label);
  }

  const forwardStreets = [
    {name: 'flop', cards: 3},
    {name: 'turn', cards: 4},
    {name: 'river', cards: 5},
    {name: 'showdown', cards: 5},
  ];
  for (const [index, expected] of forwardStreets.entries()) {
    await click(one, '#last-hand-next');
    await wait(one, street => (document.querySelector('#last-hand-street')?.innerText || '').toLowerCase().includes(street), expected.name);
    const stage = await evaluate(one, () => ({
      label: document.querySelector('#last-hand-street')?.innerText || '',
      boardCards: document.querySelectorAll('#last-hand-content .replay-board-cards .mini-card').length,
      exposedCards: document.querySelectorAll('#last-hand-content .replay-player-cards .mini-card').length,
      previousDisabled: document.querySelector('#last-hand-prev')?.disabled,
      nextDisabled: document.querySelector('#last-hand-next')?.disabled,
    }));
    assert(stage.boardCards === expected.cards && stage.exposedCards === 4,
      'Wrong replay cards at ' + stage.label + ': ' + JSON.stringify(stage));
    assert(!stage.previousDisabled && stage.nextDisabled === (index === forwardStreets.length - 1),
      'Replay next navigation bounds failed at ' + stage.label);
    if (index === forwardStreets.length - 1) {
      await one.screenshot('last-hand-showdown');
    }
  }

  const liveNote = await evaluate(one, () => ({
    hand: document.querySelector('#hand-number')?.innerText || '',
    street: document.querySelector('#street-label')?.innerText || '',
    board: document.querySelector('#board-cards')?.innerText || '',
  }));
  await sleep(1100);
  const liveBoardAfterPoll = await evaluate(one, () => ({
    hand: document.querySelector('#hand-number')?.innerText || '',
    street: document.querySelector('#street-label')?.innerText || '',
    board: document.querySelector('#board-cards')?.innerText || '',
  }));
  assert(JSON.stringify(liveBoardAfterPoll) === JSON.stringify(liveNote) &&
    JSON.stringify(liveNote) === JSON.stringify(liveBoardBefore),
    'Opening the replay changed the live board during polling');

  await one.pressEscape();
  await wait(one, () => !document.querySelector('#last-hand-dialog')?.open);
  assert(
    await evaluate(one, () =>
      document.activeElement === document.querySelector('#last-hand-button') &&
      document.querySelector('#last-hand-button')?.getAttribute('aria-expanded') === 'false'
    ),
    'Replay Escape did not restore focus to its opener'
  );
  console.log('Last-hand replay navigated both directions, showed final exposed cards, and left the live hand unchanged.');

  // Nine live seats cover phone, short-landscape, and desktop viewports.
  const nineSeats = await createTable('UX Nine Seats ' + stamp, users.slice(7, 16), {
    level_minutes: 0.25,
  });
  const nineActor = tableActor(nineSeats);
  const nineOther = nineSeats.entrants.find(user => user !== nineActor);
  await switchUser(one, nineActor);
  await switchUser(two, nineOther);
  await openTable(one, nineSeats.name);
  await wait(one, visible, '#action-panel:not([hidden]) #action-controls [data-poker-action]');
  await checkViewports(one, 9, 'nine-seat', true);

  await evaluate(one, () => {
    window.uxBlindTransitions = [];
    let wasVisible = false;
    window.setInterval(() => {
      const node = document.querySelector('#blind-announcement');
      const isVisible = Boolean(
        node && !node.hidden && getComputedStyle(node).display !== 'none' && node.getClientRects().length
      );
      if (isVisible && !wasVisible) window.uxBlindTransitions.push(node.innerText.trim());
      wasVisible = isVisible;
    }, 80);
  });
  await waitLong(one, () => {
    const node = document.querySelector('#blind-announcement');
    return Boolean(
      node && !node.hidden && getComputedStyle(node).display !== 'none' && node.getClientRects().length
    );
  });
  const announcement = await evaluate(one, () => document.querySelector('#blind-announcement').innerText.trim());
  const announcementCenter = await evaluate(one, () => {
    const node=document.querySelector('#blind-announcement').getBoundingClientRect();
    const felt=document.querySelector('#felt').getBoundingClientRect();
    return {
      x:+(((node.left+node.right)-(felt.left+felt.right))/2).toFixed(1),
      y:+(((node.top+node.bottom)-(felt.top+felt.bottom))/2).toFixed(1),
    };
  });
  const blindStrip = await evaluate(one, () => document.querySelector('#blind-strip')?.innerText || '');
  assert(
    /level\s*2/i.test(announcement) && /20/.test(announcement) && /40/.test(announcement),
    'Blind announcement missed level 2 and new 20/40 blinds: ' + announcement
  );
  assert(Math.abs(announcementCenter.x)<=2 && Math.abs(announcementCenter.y)<=2,
    'Blind announcement is not centered on the felt: ' + JSON.stringify(announcementCenter));
  assert(
    /level\s*2/i.test(blindStrip) && /20/.test(blindStrip) && /40/.test(blindStrip) &&
    !/players left|starting stack/i.test(blindStrip),
    'Blind strip did not update to level 2 and 20/40: ' + blindStrip
  );

  await openTable(two, nineSeats.name);
  await sleep(300);
  const replayedOnOpen = await evaluate(two, () => {
    const node = document.querySelector('#blind-announcement');
    return Boolean(
      node && !node.hidden && getComputedStyle(node).display !== 'none' && node.getClientRects().length
    );
  });
  assert(!replayedOnOpen, 'Opening a table replayed its blind announcement');

  await sleep(3300);
  const announcementClosed = await evaluate(one, () => {
    const node = document.querySelector('#blind-announcement');
    return !node || node.hidden || getComputedStyle(node).display === 'none' || !node.getClientRects().length;
  });
  await sleep(1000);
  const announcementCount = await evaluate(one, () => window.uxBlindTransitions.length);
  assert(
    announcementClosed && announcementCount === 1,
    'Blind announcement failed to close or replayed during polling: ' + announcementCount
  );
  console.log('Blind level 2 announced 20/40 once, auto-closed, and did not replay on table open or poll.');

  if (layoutFailures.length) {
    throw Error('Responsive layout regressions: ' + layoutFailures.join(' || '));
  }
}

