// Headless UX regressions against the isolated game server.
export default async function ux([one, two], sleep, roomPassword) {
  const pages = [one, two];
  const evaluate = (page, fn, ...args) =>
    page.evaluate('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')');
  const visible = selector => {
    const node = document.querySelector(selector);
    if (!node) return false;
    const details = node.closest('details');
    if (details) details.open = true;
    return Boolean(node.offsetWidth);
  };

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
      if (!node) return false;
      const details = node.tagName === 'SUMMARY' ? null : node.closest('details');
      const wasOpen = Boolean(details?.open);
      if (details) details.open = true;
      if (!node.offsetWidth || node.disabled) {
        if (details && !wasOpen) details.open = false;
        return false;
      }
      node.click();
      if (details && !wasOpen) details.open = false;
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
      Boolean(document.querySelector('#login-panel')?.hidden));
    if (loggedIn) {
      const logoutSelector = await evaluate(page, () => {
        if (!document.querySelector('#admin-panel')?.hidden) return '#admin-logout-button';
        if (!document.querySelector('#table-view')?.hidden) return '#table-logout-button';
        return '#logout-button';
      });
      await click(page, logoutSelector);
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
    if (path.endsWith('/last-hand') || path === '/config' || path === '/admin/config') return json;
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

  const admin = await request('/login', null, {username:'admin', password:''});
  async function setAdminTiming(runoutSeconds, blindSeconds = 0, eliminationSeconds = 0, showdownSeconds = 0) {
    return request('/admin/config', admin, {
      runout_seconds:runoutSeconds, blind_announcement_seconds:blindSeconds,
      elimination_announcement_seconds:eliminationSeconds, showdown_seconds:showdownSeconds,
      bet_presets:{preflop_bb:[2.5,3,4],postflop_percent:[50,60,75,90,100]},
    });
  }
  await setAdminTiming(1);
  const sharedConfig = await request('/config', users[0]);
  assert(sharedConfig.config?.bet_presets?.preflop_bb?.join(',') === '2.5,3,4',
    'Normal users could not read the shared bet presets: ' + JSON.stringify(sharedConfig));
  const findUser = (group, playerId) =>
    group.find(user => user.player.id === playerId);

  async function createTable(name, entrants, overrides = {}) {
    const config = {
      starting_stack: 1000,
      small_blind: 10,
      big_blind: 20,
      level_minutes: 79,
      turn_seconds: 3600,
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
    const overlap = (a, b) => {
      const width=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left));
      const height=Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
      return width>1 && height>1 ? width*height : 0;
    };

    const header = document.querySelector('.table-shell-header');
    const surface = document.querySelector('.table-surface');
    const blindStrip = document.querySelector('#blind-strip');
    const felt = document.querySelector('#felt');
    const seatGrid = document.querySelector('#seat-grid');
    const panel = document.querySelector('#action-panel');
    const board = document.querySelector('#board-cards');
    const boardCards = [...document.querySelectorAll('#board-cards .playing-card:not(.placeholder)')];
    const heroPair = document.querySelector('.seat-card.is-me .seat-cards.is-viewer-cards');
    const actionButtons = [...document.querySelectorAll('#action-panel .action-buttons [data-poker-action]')];
    const primarySlots = [...document.querySelectorAll('#action-panel .action-buttons [data-action-slot]')];
    const seats = [...document.querySelectorAll('#seat-grid .seat-card[data-seat-no]')];
    const markers = [...document.querySelectorAll(
      '#seat-grid .seat-action[data-action-seat], ' +
      '#seat-grid .seat-turn-indicator, ' +
      '#seat-grid .seat-turn-clock, ' +
      '#seat-grid .seat-wager, ' +
      '#seat-grid .seat-card > .dealer-marker'
    )].filter(marker => marker.offsetWidth && marker.offsetHeight);
    const blindNumbers = [...(blindStrip?.querySelectorAll('.blind-tile strong') || [])];
    const turnMarker = document.querySelector('#seat-grid .seat-turn-indicator[data-turn-seat]');
    const turnClock = document.querySelector('#seat-grid .seat-turn-clock');
    const heroSeat = document.querySelector('#seat-grid .seat-card.is-me');
    const heroCards = [...document.querySelectorAll(
      '.seat-card.is-me .seat-cards.is-viewer-cards .mini-card'
    )];
    const liveSeatCardRows = [...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')]
      .filter(seat => !seat.classList.contains('is-folded') && !seat.classList.contains('is-eliminated'))
      .map(seat => {
        const row=seat.querySelector('.seat-cards');
        const cards=[...(row?.querySelectorAll('.mini-card') || [])];
        const visible=card=>Boolean(getComputedStyle(card).display!=='none' &&
          getComputedStyle(card).visibility!=='hidden' && card.getBoundingClientRect().width>0 &&
          card.getBoundingClientRect().height>0);
        return {seatNo:seat.dataset.seatNo,rowVisible:Boolean(row?.offsetWidth && row?.offsetHeight),
          count:cards.length,visible:cards.filter(visible).length,backs:cards.filter(card=>card.classList.contains('back')).length};
      });
    const controls = [...document.querySelectorAll(
      '#action-panel button:not([disabled]), #action-panel input:not([disabled])'
    )];
    const errors = [];
    const normalPhoneViewport =
      (innerWidth === 390 && innerHeight === 844) ||
      (innerWidth === 360 && innerHeight === 740);

    if (!header || !header.offsetWidth) errors.push('active table shell header is not visible');
    if (header && header.getBoundingClientRect().height > (innerWidth < 800 ? 64 : 90)) {
      errors.push('header is too tall');
    }
    if (!surface?.contains(blindStrip)) errors.push('blind strip is outside the table surface');
    if (!surface?.contains(panel) || !panel || panel.hidden) {
      errors.push('action panel is not visible inside the table surface');
    }
    if (felt?.contains(panel)) errors.push('action panel is inside the felt');
    if (actionButtons.length !== 3) errors.push('expected three persistent primary actions, saw ' + actionButtons.length);
    if (primarySlots.map(button => button.dataset.actionSlot).join(',') !== 'fold,call,raise') {
      errors.push('primary action slots are missing or reordered: ' + primarySlots.map(button => button.dataset.actionSlot).join(','));
    }
    if (!canAct && actionButtons.some(button => !button.disabled)) errors.push('an off-turn primary action is enabled');
    if (document.querySelector('[data-preaction], #allInConfirm, [data-action="confirm-all-in"], #hand-result')) {
      errors.push('removed gameplay control or payout box remains in the DOM');
    }
    if (/uncalled/i.test(document.body.innerText)) errors.push('uncalled-bet UI remains');
    if (boardCards.length && (!board?.offsetWidth || boardCards.some(card => !card.offsetWidth || !card.offsetHeight))) {
      errors.push('dealt community cards are not visible');
    }
    if (seats.length !== expectedSeats) errors.push('expected ' + expectedSeats + ' seats, saw ' + seats.length);
    if (document.querySelector('#seat-grid .seat-empty')) errors.push('empty seat placeholders remain');
    if (heroCards.length !== 2) errors.push('expected two visible hero cards, saw ' + heroCards.length);
    if (liveSeatCardRows.some(row => !row.rowVisible || row.count !== 2 || row.visible !== 2)) {
      errors.push('every live un-folded seat must retain two visible faces or card backs: ' + JSON.stringify(liveSeatCardRows));
    }
    if (document.documentElement.scrollWidth > innerWidth + 1) errors.push('horizontal page overflow');
    if (window.scrollY > 1) errors.push('gameplay page scrolled vertically');
    if (document.documentElement.scrollHeight > innerHeight + 1) errors.push('gameplay page has vertical overflow');
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
    const touchButtons = actionButtons;
    const undersizedButtons = touchButtons.map(button => ({
      label: (button.textContent || button.getAttribute('aria-label') || button.id || '').trim(),
      height: rect(button).height,
    })).filter(button => button.height < 44);
    if (undersizedButtons.length) {
      errors.push('primary action buttons are below 44px: ' + JSON.stringify(undersizedButtons));
    }
    const presetMinHeight = innerWidth <= 320 || innerHeight <= 390 ? 28 : 30;
    const undersizedPresets = [...(panel?.querySelectorAll('[data-raise-preset]') || [])]
      .map(button => ({label:button.textContent.trim(), height:rect(button).height}))
      .filter(button => button.height < presetMinHeight);
    if (undersizedPresets.length) errors.push('secondary raise presets are below ' + presetMinHeight + 'px: ' + JSON.stringify(undersizedPresets));
    if (normalPhoneViewport && heroPairBox && panelBox &&
      (heroPairBox.top < -1 || heroPairBox.bottom > innerHeight + 1 ||
       panelBox.top < -1 || panelBox.bottom > innerHeight + 1 ||
       overlap(heroPairBox, panelBox) > 1)) {
      errors.push('hero cards and action dock do not fit together in the normal phone viewport');
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
    if (heroBottomGap != null && heroBottomGap < -1) {
      errors.push('hero pair escapes the felt bottom: ' + heroBottomGap + 'px');
    }
    const gridBox = seatGrid && rect(seatGrid);
    const stripBox = blindStrip && rect(blindStrip);
    const blindTextBoxes = blindStrip ? (() => {
      const walker=document.createTreeWalker(blindStrip,NodeFilter.SHOW_TEXT),boxes=[];
      for(let text=walker.nextNode();text;text=walker.nextNode()){
        if(!text.textContent.trim())continue;
        const style=text.parentElement&&getComputedStyle(text.parentElement);
        if(style&&(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0))continue;
        const range=document.createRange();range.selectNodeContents(text);
        for(const value of range.getClientRects())if(value.width>0&&value.height>0)
          boxes.push({left:value.left,top:value.top,right:value.right,bottom:value.bottom,
            width:value.width,height:value.height,text:text.textContent.trim()});
      }
      return boxes;
    })() : [];
    const potBox = document.querySelector('#pot-display') && rect(document.querySelector('#pot-display'));
    const seatBoxes = seats.map(seat => ({
      seatNo: seat.dataset.seatNo,
      name: seat.querySelector('.seat-name')?.innerText || '',
      ...rect(seat),
    }));
    if (stripBox) {
      for (const seatBox of seatBoxes) {
        if (overlap(stripBox, seatBox) > 1) errors.push('blind strip overlaps seat ' + seatBox.seatNo);
      }
    }
    const markerBoxes = markers.map(marker => ({
      type: marker.classList.contains('seat-turn-clock') ? 'clock' :
        marker.classList.contains('seat-turn-indicator') ? 'turn' :
        marker.classList.contains('seat-action') ? 'action' :
        marker.classList.contains('seat-wager') ? 'wager' : 'dealer',
      seatNo: marker.getAttribute('data-seat-no') ||
        marker.getAttribute('data-action-seat') ||
        marker.getAttribute('data-turn-seat') ||
        marker.getAttribute('data-turn-clock-seat') ||
        marker.getAttribute('data-marker-seat') || '',
      ownerSeatNo: marker.closest('.seat-card[data-seat-no]')?.dataset.seatNo || '',
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
    if (boardBox && feltBox && (
      boardBox.left < feltBox.left - 1 || boardBox.right > feltBox.right + 1 ||
      boardBox.top < feltBox.top - 1 || boardBox.bottom > feltBox.bottom + 1
    )) errors.push('community card area escapes felt');
    if (boardBox && stripBox && overlap(boardBox, stripBox) > 1) {
      errors.push('community cards overlap blind strip');
    }
    for (const [label, markerBox] of [['TO ACT', turnMarkerBox], ['seat turn clock', turnClockBox]]) {
      if (!markerBox) continue;
      if (feltBox && (
        markerBox.left < feltBox.left - 1 || markerBox.right > feltBox.right + 1 ||
        markerBox.top < feltBox.top - 1 || markerBox.bottom > feltBox.bottom + 1
      )) errors.push(label + ' escapes felt bounds');
      if ((
        markerBox.left < -1 || markerBox.right > innerWidth + 1 ||
        markerBox.top < -1 || markerBox.bottom > innerHeight + 1
      )) errors.push(label + ' is clipped by viewport');
    }
    for (let index = 0; index < markers.length; index++) {
      const marker = markers[index];
      const markerBox = markerBoxes[index];
      const ownerSeat = marker.closest('.seat-card[data-seat-no]');
      const localLane = marker.closest('.seat-local-markers') || marker.closest('.seat-footer') ||
        marker.closest('.seat-top') || marker.closest('.seat-turn-indicator');
      const turnMarker = marker.classList.contains('seat-turn-indicator') || marker.classList.contains('seat-turn-clock');
      const ownerBox = ownerSeat && rect(ownerSeat);
      const laneBox = localLane && rect(localLane);
      if (!ownerSeat || (marker.classList.contains('dealer-marker') ? marker.parentElement !== ownerSeat :
          turnMarker ? !ownerSeat.contains(marker) : !localLane?.contains(marker))) errors.push(markerBox.type + ' marker is not attached to its owner seat');
      if (ownerSeat && markerBox.seatNo && markerBox.seatNo !== ownerSeat.dataset.seatNo) {
        errors.push(markerBox.type + ' marker seat id does not match its containing seat');
      }
      const dealerChip = marker.classList.contains('dealer-marker');
      if (!dealerChip && ownerBox && (markerBox.left < ownerBox.left - 1 || markerBox.right > ownerBox.right + 1 ||
          markerBox.top < ownerBox.top - 1 || markerBox.bottom > ownerBox.bottom + 1)) {
        errors.push(markerBox.type + ' marker escaped its seat ' + ownerSeat.dataset.seatNo);
      }
      if (!dealerChip && !turnMarker && laneBox && (markerBox.left < laneBox.left - 1 || markerBox.right > laneBox.right + 1 ||
          markerBox.top < laneBox.top - 1 || markerBox.bottom > laneBox.bottom + 1)) {
        errors.push(markerBox.type + ' marker escaped its fixed local lane');
      }
      if (dealerChip) {
        const cornerDistance = ownerBox ? Math.hypot((markerBox.left + markerBox.right) / 2 - ownerBox.right,
          (markerBox.top + markerBox.bottom) / 2 - ownerBox.top) : Infinity;
        if (markerBox.width < 30 || markerBox.height < 30 || cornerDistance > 18) {
          errors.push('dealer chip is not prominent at the seat corner');
        }
        if ((marker.getAttribute('aria-label') || '') !== 'Dealer button') {
          errors.push('dealer chip lacks an accessible label');
        }
        const otherSeatOverlap = [...document.querySelectorAll('#seat-grid .seat-card')].some(seat =>
          seat !== ownerSeat && overlap(markerBox, rect(seat)) > 1);
        if (otherSeatOverlap) errors.push('dealer chip overlaps another seat');
        const nameNode = ownerSeat?.querySelector('.seat-name');
        if (nameNode?.firstChild) {
          const range = document.createRange();
          range.selectNodeContents(nameNode);
          const textRect = range.getBoundingClientRect(), clipRect = rect(nameNode);
          const visibleText = {left:Math.max(textRect.left,clipRect.left),top:Math.max(textRect.top,clipRect.top),
            right:Math.min(textRect.right,clipRect.right),bottom:Math.min(textRect.bottom,clipRect.bottom)};
          if (overlap(markerBox, visibleText) > 1) errors.push('dealer chip overlaps the visible seat name');
        }
        if (ownerSeat?.querySelector('.seat-stack') && overlap(markerBox, rect(ownerSeat.querySelector('.seat-stack'))) > 1) {
          errors.push('dealer chip overlaps the chip stack');
        }
      }
      if (marker.classList.contains('seat-action')) {
        if (!(marker.getAttribute('aria-label') || '').trim()) errors.push('action marker lacks an accessible label');
      } else {
        const markerText = [marker, ...marker.querySelectorAll('strong,.wager-unit,.seat-turn-clock')]
          .filter(node => node.textContent.trim() && getComputedStyle(node).display !== 'none' &&
            getComputedStyle(node).visibility !== 'hidden' && node.getClientRects().length);
        for (const node of markerText) {
          if (node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1) {
            errors.push(markerBox.type + ' marker text is clipped: ' + node.textContent.trim());
          }
        }
      }
      const ownerCards = ownerSeat ? [...ownerSeat.querySelectorAll('.seat-cards .mini-card')].filter(card => {
        const style=getComputedStyle(card);
        return style.display!=='none'&&style.visibility!=='hidden'&&card.getClientRects().length>0;
      }) : [];
      if (turnMarker) {
        const rankSuitText = ownerSeat ? [...ownerSeat.querySelectorAll(
          '.seat-cards .mini-card:not(.back) .mini-rank, .seat-cards .mini-card:not(.back) .mini-suit'
        )].filter(node => {
          const style=getComputedStyle(node);
          return style.display!=='none'&&style.visibility!=='hidden'&&node.getClientRects().length>0;
        }) : [];
        if (rankSuitText.some(node=>overlap(markerBox,rect(node))>1))
          errors.push(markerBox.type+' marker overlaps card rank/suit text in seat '+ownerSeat.dataset.seatNo);
      } else if (ownerCards.some(card=>overlap(markerBox,rect(card))>1)) {
        errors.push(markerBox.type+' marker overlaps an actual card in seat '+ownerSeat.dataset.seatNo);
      }
      // The original 837201f dealer chip sits at top:-10/right:-4 and may touch only
      // the blind strip's blank lower/right padding at 320px; guard its visible text instead.
      const markerBlockers = [['board',boardBox],['pot',potBox]]
        .filter(([,blocker]) => blocker && overlap(markerBox, blocker) > 1)
        .map(([name,blocker]) => ({name,rect:blocker}));
      if(dealerChip){
        markerBlockers.push(...blindTextBoxes.filter(textBox=>overlap(markerBox,textBox)>1)
          .map(textBox=>({name:'blind strip text: '+textBox.text,rect:textBox})));
      }else if(stripBox&&overlap(markerBox,stripBox)>1){
        markerBlockers.push({name:'blind strip',rect:stripBox});
      }
      if (markerBlockers.length) errors.push(markerBox.type + ' marker overlaps blockers: ' +
        JSON.stringify({marker:markerBox,blockers:markerBlockers}));
      if (!markerBox.width || !markerBox.height) {
        errors.push(markerBox.type + ' marker for seat ' + markerBox.seatNo + ' has no visible bounds');
      }
      if (feltBox && (
        markerBox.left < feltBox.left - 1 || markerBox.right > feltBox.right + 1 ||
        markerBox.top < feltBox.top - 1 || markerBox.bottom > feltBox.bottom + 1
      )) errors.push(markerBox.type + ' marker for seat ' + markerBox.seatNo + ' escapes felt bounds');
      if ((
        markerBox.left < -1 || markerBox.right > innerWidth + 1 ||
        markerBox.top < -1 || markerBox.bottom > innerHeight + 1
      )) errors.push(markerBox.type + ' marker for seat ' + markerBox.seatNo + ' is clipped by viewport');
      for (let previous = 0; previous < index; previous++) {
        const other=markers[previous];
        if (marker.contains(other) || other.contains(marker)) continue;
        if (overlap(markerBox,markerBoxes[previous]) > 1) {
          errors.push(markerBox.type + ' marker intersects another seat-local marker');
        }
      }
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
      if ((
        cardBox.left < -1 || cardBox.right > innerWidth + 1 ||
        cardBox.top < -1 || cardBox.bottom > innerHeight + 1
      )) errors.push('hero card is clipped');
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
      touchButtons: undersizedButtons,
      undersizedPresets,
      actionButtons: actionButtons.length,
      heroPair: heroPairBox,
      heroCenterOffset,
      heroBottomGap,
      cards: heroCards.map(rect),
      liveSeatCardRows,
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
    await wait(page, visible, '#seat-grid .seat-turn-indicator[data-turn-seat]');
    await wait(page, visible, '#seat-grid .seat-turn-clock:not(.is-unplaced)');
    const viewports = [
      {width: 320, height: 740},
      {width: 320, height: 568},
      {width: 360, height: 740},
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

  const countdownBefore = await wait(one, () => {
    const value = document.querySelector('#blind-level-countdown')?.textContent.trim() || '';
    return /^\d{1,3}:\d{2}$/.test(value) ? value : false;
  });
  const countdownSeconds = value => {
    const [minutes, seconds] = value.split(':').map(Number);
    return minutes * 60 + seconds;
  };
  await sleep(1250);
  const countdownAfter = await evaluate(one, () => document.querySelector('#blind-level-countdown')?.textContent.trim() || '');
  assert(countdownAfter && countdownSeconds(countdownAfter) < countdownSeconds(countdownBefore) &&
    countdownSeconds(countdownBefore) - countdownSeconds(countdownAfter) <= 2,
  'Blind-level countdown did not tick between table polls: ' + countdownBefore + ' to ' + countdownAfter);

  const initialView = await request(headsUp.path, headsUpActor);
  const hero = initialView.seats.find(seat => seat.id === headsUpActor.player.id);
  const bigBlind = initialView.blinds?.big || headsUp.config.big_blind;
  const expectedBb = Number((hero.stack / bigBlind).toFixed(1));
  await checkViewports(one, 2, 'heads-up', true);

  const initialStackText = await evaluate(one, () =>
    document.querySelector('.seat-card.is-me .seat-stack[data-chip-display-toggle]')?.innerText.trim()
  );
  assert(initialStackText, 'Hero stack toggle is missing');
  await click(one, '.seat-card.is-me .seat-stack[data-chip-display-toggle]');
  await wait(one, () =>
    document.querySelector('.seat-card.is-me .seat-stack[data-chip-display-toggle]')
      ?.getAttribute('aria-pressed') === 'true'
  );
  const bbStack = await evaluate(one, () => {
    const button=document.querySelector('.seat-card.is-me .seat-stack[data-chip-display-toggle]');
    return {text:button.innerText.trim(),aria:button.getAttribute('aria-label'),
      pressed:button.getAttribute('aria-pressed')};
  });
  const bbAmount = bbStack.aria.match(/Your stack:\s*([\d,]+(?:\.\d+)?)\s*BB/i);
  assert(
    bbStack.pressed === 'true' && bbAmount && bbStack.text.includes(bbAmount[1]) &&
      /\.\d$/.test(bbAmount[1]) && Number(bbAmount[1].replace(/,/g, '')) === expectedBb,
    'Wrong accessible BB display/rounding: ' + JSON.stringify(bbStack) + ' from ' + hero.stack + ' chips'
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
  const actionSlotBefore = await evaluate(one, () => {
    const nodes = [...document.querySelectorAll('#action-panel .action-buttons [data-action-slot]')];
    window.uxActionSlotRefs = nodes.map(node => ({node, slot:node.dataset.actionSlot}));
    return nodes.map(node => {
      const r = node.getBoundingClientRect();
      return {slot:node.dataset.actionSlot, rect:[r.left,r.top,r.right,r.bottom]};
    });
  });
  await click(one, '[data-poker-action="raise_to"]');
  await wait(one, () => Boolean(window.uxActionPayload));
  await wait(one, () => {
    const buttons = [...document.querySelectorAll('#action-panel .action-buttons [data-action-slot]')];
    return buttons.length === 3 && buttons.every(button => button.disabled);
  });
  const actionSlotAfter = await evaluate(one, () => {
    const nodes = [...document.querySelectorAll('#action-panel .action-buttons [data-action-slot]')];
    return {
      sameNodes: nodes.length === window.uxActionSlotRefs?.length && nodes.every((node,index) => node === window.uxActionSlotRefs[index].node),
      slots:nodes.map(node => node.dataset.actionSlot),
      disabled:nodes.map(node => node.disabled),
      rects:nodes.map(node => {const r=node.getBoundingClientRect(); return [r.left,r.top,r.right,r.bottom];}),
    };
  });
  assert(actionSlotAfter.sameNodes && actionSlotAfter.slots.join(',') === 'fold,call,raise' &&
    actionSlotAfter.disabled.every(Boolean) && actionSlotAfter.rects.every((rect,index) =>
      rect.every((value,axis) => Math.abs(value - actionSlotBefore[index].rect[axis]) <= 1)),
  'Primary action nodes or fixed slots moved when the actor became a waiting player: ' +
    JSON.stringify({before:actionSlotBefore,after:actionSlotAfter}));
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
  const displayAfterRaise = await evaluate(one, () => {
    const button=document.querySelector('.seat-card.is-me .seat-stack[data-chip-display-toggle]');
    return {text:button?.innerText||'',aria:button?.getAttribute('aria-label')||''};
  });
  assert(/BB/i.test(displayAfterRaise.aria), 'BB mode reset after an action: ' + JSON.stringify(displayAfterRaise));
  await click(one, '.seat-card.is-me .seat-stack[data-chip-display-toggle]');
  await wait(one, () =>
    /chips/i.test(document.querySelector('.seat-card.is-me .seat-stack[data-chip-display-toggle]')
      ?.getAttribute('aria-label') || '')
  );
  const restoredStack = await evaluate(one, () => {
    const button=document.querySelector('.seat-card.is-me .seat-stack[data-chip-display-toggle]');
    return {text:button.innerText.trim(),aria:button.getAttribute('aria-label')||''};
  });
  assert(restoredStack.text.includes(String(updatedStack)) && /chips/i.test(restoredStack.aria),
    'Chip stack did not restore: ' + JSON.stringify(restoredStack));
  console.log('Hero stack toggles to one-decimal BB, restores chips, and sends chip payloads.');

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
    document.querySelector('.seat-card.is-me .seat-stack[data-chip-display-toggle]')
      ?.getAttribute('aria-pressed') === 'true'
  );
  const fractionalDisplay = await evaluate(one, () => {
    const button=document.querySelector('.seat-card.is-me .seat-stack[data-chip-display-toggle]');
    return {text:button.innerText.trim(),aria:button.getAttribute('aria-label')||'',
      pressed:button.getAttribute('aria-pressed')};
  });
  const fractionalAmount = fractionalDisplay.aria.match(/Your stack:\s*([\d,]+(?:\.\d+)?)\s*BB/i);
  assert(
    fractionalDisplay.pressed === 'true' && fractionalAmount &&
      fractionalDisplay.text.includes(fractionalAmount[1]) &&
      Number(fractionalAmount[1].replace(/,/g, '')) === Number((fractionalStack / 100).toFixed(1)),
    'Sub-BB value did not use one decimal: ' + JSON.stringify(fractionalDisplay)
  );

  // Hold the first all-in street long enough to inspect it; restore fast pacing after the snapshot.
  await setAdminTiming(5);
  const multiway = await createTable('UX Multiway ' + stamp, users.slice(4, 7), {
    starting_stack: 100,
    small_blind: 1,
    big_blind: 2,
  });
  const multiwayActor = tableActor(multiway);
  const multiwayOther = multiway.entrants.find(user => user !== multiwayActor);
  await switchUser(one, multiwayActor);
  await switchUser(two, multiwayOther);
  await openTable(one, multiway.name);
  await openTable(two, multiway.name);
  await wait(one, visible, '#action-panel:not([hidden]) #action-controls [data-poker-action]');
  const multiwayRingBaselines = await Promise.all(pages.map(page => evaluate(page, () => ({
    seats:[...document.querySelectorAll('#seat-grid .seat-card[data-seat-no]')].map(node => {
      const r=node.getBoundingClientRect();
      return {seatNo:node.dataset.seatNo,playerId:node.dataset.playerId || '',
        relativeIndex:node.dataset.relativeSeat,left:r.left,top:r.top,right:r.right,bottom:r.bottom};
    }),
    scrollY:window.scrollY,scrollHeight:document.documentElement.scrollHeight,
  }))));

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
  const runoutAction = await wait(livePage, () => {
    const button=document.querySelector('#action-controls [data-poker-action="raise_to"]');
    if (!button) return false;
    const state={
      disabled:button.disabled,
      label:button.textContent.trim(),
      aria:button.getAttribute('aria-label') || '',
      amount:document.querySelector('#raise-amount')?.value,
      min:document.querySelector('#raise-amount')?.min,
      max:document.querySelector('#raise-amount')?.max,
    };
    return state.disabled && ['Bet','Raise'].includes(state.label) ? state : false;
  });
  assert(runoutAction.disabled && ['Bet','Raise'].includes(runoutAction.label) &&
    !/to\s*0\s*chips/i.test(runoutAction.label + ' ' + runoutAction.aria),
  'No-legal-range runout action must stay disabled with a neutral label: ' + JSON.stringify(runoutAction));
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
  await setAdminTiming(1);

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
    const seats = [...document.querySelectorAll('#seat-grid .seat-card[data-seat-no]')].map(node => {
      const bounds = node.getBoundingClientRect();
      return {id:node.dataset.playerId || '',seatNo:node.dataset.seatNo,
        relativeIndex:Number(node.dataset.relativeSeat),left:bounds.left,top:bounds.top,right:bounds.right,bottom:bounds.bottom};
    });
    return {seats,empty:document.querySelectorAll('#seat-grid .seat-empty').length,
      felt:{left:felt.left,top:felt.top,right:felt.right,bottom:felt.bottom},
      scrollY:window.scrollY,scrollHeight:document.documentElement.scrollHeight,viewportHeight:innerHeight};
  });
  const ringBaseline = multiwayRingBaselines[pages.indexOf(livePage)];
  const finalBySeat = new Map(finalLayout.seats.map(seat => [seat.seatNo, seat]));
  const ringStable = ringBaseline.seats.length === finalLayout.seats.length && ringBaseline.seats.every(before => {
    const after=finalBySeat.get(before.seatNo);
    return after && after.id===before.playerId && after.relativeIndex===Number(before.relativeIndex) &&
      ['left','top','right','bottom'].every(key => Math.abs(after[key]-before[key])<=1);
  });
  assert(finalLayout.seats.length === current.seats.length && finalLayout.empty === 0 && ringStable &&
    finalLayout.scrollY <= 1 && finalLayout.scrollHeight <= finalLayout.viewportHeight + 1,
  'Elimination/completion changed the original seat ring or caused page scroll: ' +
    JSON.stringify({finalLayout,ringBaseline,ringStable,apiSeats:current.seats.length}));
  const survivor = finalLayout.seats.find(seat => seat.id === current.seats.find(row => row.stack > 0).id);
  assert(
    survivor.left >= finalLayout.felt.left - 1 && survivor.right <= finalLayout.felt.right + 1 &&
    survivor.top >= finalLayout.felt.top - 1 && survivor.bottom <= finalLayout.felt.bottom + 1,
    'Survivor is outside the felt after reflow: ' + JSON.stringify(finalLayout)
  );
  console.log('Zero-stack all-ins retained the original seat ring through completion without page scroll.');

  const losingUser = findUser(multiway.entrants, current.seats.find(seat => seat.in_hand && seat.stack === 0).id);
  await switchUser(one, losingUser);
  await evaluate(one, tableId => window.location.assign('/poker/table?table=' + encodeURIComponent(tableId)), multiway.id);
  await wait(one, tableName => !document.querySelector('#table-view')?.hidden &&
    document.querySelector('#view-table-name')?.textContent === tableName, multiway.name);
  await one.resize(390, 844);
  await wait(one, () => /complete/i.test(document.querySelector('#view-status')?.innerText || ''));
  const expectedParticipantIds=multiway.entrants.map(entrant=>entrant.player.id).sort();
  const finalLoser = await evaluate(one, expectedLoserId => {
    const felt = document.querySelector('#felt').getBoundingClientRect();
    const heroNode = document.querySelector('.seat-card.is-me');
    const hero = heroNode?.getBoundingClientRect();
    const cardRow=document.querySelector('.seat-card.is-me .seat-cards.is-viewer-cards');
    const cards=[...(cardRow?.querySelectorAll('.mini-card:not(.back)')||[])];
    const visibleCards=cards.filter(card=>{
      const style=getComputedStyle(card),box=card.getBoundingClientRect();
      return style.display!=='none'&&style.visibility!=='hidden'&&box.width>0&&box.height>0;
    });
    return {
      board: document.querySelector('#board-cards')?.innerText,
      cards: cardRow?.innerText.trim()||'',
      cardCount:visibleCards.length,
      heroId:heroNode?.dataset.playerId||'',expectedLoserId,
      x: hero ? (hero.left + hero.right - felt.left - felt.right) / 2 : null,
      bottom: hero ? felt.bottom - hero.bottom : null,
      participantIds:[...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')]
        .map(node=>node.dataset.playerId).sort(),
    };
  },losingUser.player.id);
  assert(finalLoser.x !== null && Math.abs(finalLoser.x) <= 2 && finalLoser.bottom >= 0 && finalLoser.bottom < 40,
    'Eliminated viewer lost their six oclock position: ' + JSON.stringify(finalLoser));
  assert(finalLoser.heroId===losingUser.player.id&&finalLoser.expectedLoserId===losingUser.player.id&&
    finalLoser.cardCount===2&&finalLoser.cards&&finalLoser.participantIds.length===expectedParticipantIds.length&&
    finalLoser.participantIds.every((id,index)=>id===expectedParticipantIds[index]),
    'Completed table did not preserve the original participant ID set or the losing viewer cards: ' +
      JSON.stringify({expectedParticipantIds,finalLoser}));
  await one.screenshot('completed-losing-viewer-390x844');


  // A completed all-in hand is replayable while the next hand is live.
  const replayUsers = users.slice(4, 7);
  const replayTable = await createTable('UX Last Hand ' + stamp, replayUsers, {
    starting_stack: 100,
    small_blind: 10,
    big_blind: 20,
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
  const replayEscapeState = await evaluate(one, () => {
    const opener=document.querySelector('#last-hand-button');
    const active=document.activeElement;
    return {focused:active===opener,activeId:active?.id||'',activeTag:active?.tagName||'',
      expanded:opener?.getAttribute('aria-expanded'),dialogOpen:document.querySelector('#last-hand-dialog')?.open,
      openerVisible:Boolean(opener?.getClientRects().length),
      menuOpen:Boolean(opener?.closest('details')?.open),
      menuSummaryFocused:active===opener?.closest('details')?.querySelector('summary')};
  });
  assert(
    (replayEscapeState.menuOpen ? replayEscapeState.focused : replayEscapeState.menuSummaryFocused) &&
      replayEscapeState.expanded === 'false',
    'Empty replay Escape did not restore focus to the visible opener or menu summary: ' +
      JSON.stringify(replayEscapeState)
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
  assert(showdown.liveNote.includes('Replay of this completed hand.'),
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
  const replayCloseFocus = await evaluate(one, () => {
    const opener=document.querySelector('#last-hand-button');
    const details=opener?.closest('details');
    return {focused:document.activeElement === (details?.open ? opener : details?.querySelector('summary')),
      expanded:opener?.getAttribute('aria-expanded'),menuOpen:Boolean(details?.open)};
  });
  assert(
    replayCloseFocus.focused && replayCloseFocus.expanded === 'false',
    'Replay Escape did not restore focus to the visible opener or menu summary: ' +
      JSON.stringify(replayCloseFocus)
  );
  console.log('Last-hand replay navigated both directions, showed final exposed cards, and left the live hand unchanged.');

  // Nine live seats cover phone, short-landscape, and desktop viewports.
  await request('/admin/config', admin, {
    runout_seconds:1, blind_announcement_seconds:3,
    elimination_announcement_seconds:0, showdown_seconds:0,
  });
  const nineSeats = await createTable('UX Nine Seats ' + stamp, users.slice(7, 16), {
    level_minutes: 0.25,
  });
  const nineActor = tableActor(nineSeats);
  const nineOther = nineSeats.entrants.find(user => user !== nineActor);
  await switchUser(one, nineActor);
  await switchUser(two, nineOther);
  await openTable(one, nineSeats.name);
  const readNineSeatGeometry = () => evaluate(one, () => {
    const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
    const area=(a,b)=>{const w=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left)),h=Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));return w>1&&h>1?w*h:0;};
    const felt=document.querySelector('#felt'), seats=[...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')];
    const board=rect(document.querySelector('#board-cards')), panel=rect(document.querySelector('#action-panel'));
    const seatRects=seats.map(node=>({seatNo:node.dataset.seatNo,rect:rect(node)})), errors=[];
    if(seats.length!==9) errors.push('seat count '+seats.length);
    for(let i=0;i<seats.length;i++) {
      if(area(board,rect(seats[i]))>5) errors.push('board overlaps seat '+seats[i].dataset.seatNo);
      if(area(panel,rect(seats[i]))>5) errors.push('dock overlaps seat '+seats[i].dataset.seatNo);
      for(let j=0;j<i;j++) if(area(rect(seats[i]),rect(seats[j]))>5) errors.push('seats overlap '+seats[j].dataset.seatNo+'/'+seats[i].dataset.seatNo);
    }
    return {errors,seatCount:seats.length,scrollY:window.scrollY,
      scrollHeight:document.documentElement.scrollHeight,viewportHeight:innerHeight,
      feltClass:felt?.className||'',seatCountData:felt?.dataset.seatCount||'',
      felt:rect(felt),grid:rect(document.querySelector('#seat-grid')),board,panel,seatRects};
  });
  const geometryOnOpen = await readNineSeatGeometry();
  await wait(one, visible, '#action-panel:not([hidden]) #action-controls [data-poker-action]');
  await one.bringToFront();
  await evaluate(one, () => new Promise(resolve => requestAnimationFrame(() =>
    requestAnimationFrame(() => resolve(true)))));
  const geometryAfterFrames = await readNineSeatGeometry();
  await sleep(950);
  const geometryAfterPoll = await readNineSeatGeometry();
  for (const [label, snapshot] of [
    ['immediate after switch', geometryOnOpen],
    ['after two frames', geometryAfterFrames],
    ['after one polling interval', geometryAfterPoll],
  ]) {
    assert(snapshot.seatCount === 9 && !snapshot.errors.length && snapshot.scrollY <= 1 &&
      snapshot.scrollHeight <= snapshot.viewportHeight + 1,
      '2-to-9 seat geometry was unstable or scrolled ' + label + ': ' + JSON.stringify(snapshot));
  }
  await one.resize(1366, 768);
  await sleep(900);
  await checkViewports(one, 9, 'nine-seat', true);

  await one.bringToFront();
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
  // Passing the deadline must not change the level during a live hand.
  const untilDeadline = nineSeats.started.blinds.next_level_at * 1000 - Date.now();
  if (untilDeadline > 0) await sleep(untilDeadline + 200);
  let boundaryState = await request(nineSeats.path, nineActor);
  assert(boundaryState.blinds.level === 1 && boundaryState.street !== 'showdown',
    'Blinds advanced during a live hand: ' + JSON.stringify(boundaryState.blinds));
  await wait(one, () => document.querySelector('#blind-level-countdown')?.textContent.trim() === 'Next hand',
    'pending blind countdown label');
  assert(await evaluate(one, () => window.uxBlindTransitions.length === 0),
    'A blind announcement appeared during the hand');
  while (boundaryState.actor_id && boundaryState.street !== 'showdown') {
    boundaryState = await request(nineSeats.path + '/action',
      findUser(nineSeats.entrants, boundaryState.actor_id), {
        action: 'fold', expected_hand: boundaryState.hand_no,
        expected_turn_version: boundaryState.turn_version,
      });
  }
  assert(boundaryState.street === 'showdown' && boundaryState.blinds.level === 2,
    'Pending blind level was not applied between hands');
  await waitLong(one, () => {
    const node = document.querySelector('#blind-announcement');
    return Boolean(
      node && !node.hidden && getComputedStyle(node).display !== 'none' && node.getClientRects().length
    );
  });
  const announcement = await evaluate(one, () => document.querySelector('#blind-announcement').innerText.trim());
  const blindStrip = await evaluate(one, () => document.querySelector('#blind-strip')?.innerText || '');
  const announcementGeometry = await evaluate(one, () => {
    const node = document.querySelector('#blind-announcement');
    const felt = document.querySelector('#felt');
    const box = element => {
      if(!element)return null;
      const r=element.getBoundingClientRect();
      return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};
    };
    const overlaps = (a,b) => a&&b&&a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const visible = element => {
      if(!element)return false;
      const style=getComputedStyle(element),r=element.getBoundingClientRect();
      return style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)!==0&&r.width>0&&r.height>0;
    };
    const n=box(node), f=box(felt);
    const controls=[...document.querySelectorAll('#action-panel button,#chat-button,#pause-button,.reaction-shortcuts')]
      .filter(visible).map(box);
    const chat=[...document.querySelectorAll('#chat-topline,#chat-preview,#chat-quick-form')]
      .filter(visible).map(box);
    return {
      directChild:Boolean(node&&node.parentElement===felt),
      centered:Boolean(n&&f&&Math.abs((n.left+n.right-f.left-f.right)/2)<=4&&
        Math.abs((n.top+n.bottom-f.top-f.bottom)/2)<=4),
      inViewport:Boolean(n&&n.left>=0&&n.top>=0&&n.right<=innerWidth&&n.bottom<=innerHeight),
      controlOverlaps:controls.some(control=>overlaps(n,control)),
      chatOverlaps:chat.some(row=>overlaps(n,row)),
      announcement:n,felt:f,controls,chat
    };
  });
  const announcementLines=announcement.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  assert(announcementLines.length===3&&announcementLines[0]==='Blinds going up'&&
    announcementLines[1]==='Small: 20'&&announcementLines[2]==='Big: 40',
    'Blind announcement did not use the requested three lines: '+JSON.stringify(announcementLines));
  assert(announcementGeometry.directChild&&announcementGeometry.centered&&announcementGeometry.inViewport&&
    !announcementGeometry.controlOverlaps&&!announcementGeometry.chatOverlaps,
    'Blind announcement must be centered in the felt, in view, and clear of controls/chat: '+
      JSON.stringify(announcementGeometry));
  assert(
    /level\s*2/i.test(blindStrip) && /20/.test(blindStrip) && /40/.test(blindStrip) &&
    !/players left|starting stack/i.test(blindStrip),
    'Blind strip did not update to level 2 and 20/40: ' + blindStrip
  );

  const activeAnnouncement = await request(nineSeats.path, nineActor);
  const activeBlindAnnouncement = activeAnnouncement.blind_announcement;
  const initialRemaining = activeBlindAnnouncement
    ? activeBlindAnnouncement.until - activeAnnouncement.server_now
    : 0;
  assert(initialRemaining > 0 && initialRemaining <= 3.2,
    'Blind announcement did not use its configured three-second hold: ' + JSON.stringify(activeBlindAnnouncement));

  await openTable(two, nineSeats.name);
  await sleep(300);
  const visibleOnReconnect = await evaluate(two, () => {
    const node = document.querySelector('#blind-announcement');
    return Boolean(
      node && !node.hidden && getComputedStyle(node).display !== 'none' && node.getClientRects().length
    );
  });
  assert(visibleOnReconnect, 'Reconnecting during the blind hold did not show the active announcement');
  const reconnectView = await request(nineSeats.path, nineOther);
  const reconnectAnnouncement = reconnectView.blind_announcement;
  const reconnectRemaining = reconnectAnnouncement
    ? reconnectAnnouncement.until - reconnectView.server_now
    : 0;
  assert(
    reconnectAnnouncement && Math.abs(reconnectAnnouncement.until - activeBlindAnnouncement.until) < 0.01 &&
      reconnectRemaining > 0 && reconnectRemaining < initialRemaining,
    'Reconnect restarted or extended the server blind hold: ' +
      JSON.stringify({initialRemaining,reconnectRemaining,activeBlindAnnouncement,reconnectAnnouncement})
  );

  await sleep(Math.ceil(reconnectRemaining * 1000) + 250);
  const announcementClosedOnOne = await waitLong(one, () => {
    const node = document.querySelector('#blind-announcement');
    return !node || node.hidden || getComputedStyle(node).display === 'none' || !node.getClientRects().length;
  });
  const announcementClosedOnTwo = await waitLong(two, () => {
    const node = document.querySelector('#blind-announcement');
    return !node || node.hidden || getComputedStyle(node).display === 'none' || !node.getClientRects().length;
  });
  const expiredAnnouncement = await request(nineSeats.path, nineActor);
  await sleep(400);
  const announcementCount = await evaluate(one, () => window.uxBlindTransitions.length);
  assert(
    announcementClosedOnOne && announcementClosedOnTwo && !expiredAnnouncement.blind_announcement &&
      announcementCount === 1,
    'Blind announcement failed to expire once without replay: ' +
      JSON.stringify({announcementCount,expired:expiredAnnouncement.blind_announcement})
  );
  const dealt = await request(nineSeats.path, nineActor);
  assert(dealt.street !== 'showdown' && dealt.blinds.level === 2, 'New level was not used for the next hand');
  console.log('Blinds stayed fixed during play, announced once between hands, and cleared before the next deal.');

  if (layoutFailures.length) {
    throw Error('Responsive layout regressions: ' + layoutFailures.join(' || '));
  }
}

