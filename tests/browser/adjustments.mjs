// Focused headless checks for account bet presets, mobile actions/chat, pause controls and announcements.
import {seedAvatar} from './avatar-fixture.mjs';

export default async function adjustments([one, two], sleep, roomPassword) {
  const evaluate = (page, fn, ...args) =>
    page.evaluate('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')');
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  const layoutFailures = [];
  const visible = selector => {
    const node = document.querySelector(selector);
    if (!node) return false;
    const details = node.closest('details');
    if (details) details.open = true;
    return Boolean(node.offsetWidth);
  };

  async function wait(page, predicate, ...args) {
    for (let attempt = 0; attempt < 120; attempt++) {
      const value = await evaluate(page, predicate, ...args);
      if (value) return value;
      await sleep(100);
    }
    throw Error('Timed out: ' + predicate + ' ' + args + ' | ' +
      await evaluate(page, () => document.body.innerText.slice(-1200)));
  }
  async function waitLong(page, predicate, ...args) {
    for (let attempt = 0; attempt < 350; attempt++) {
      const value = await evaluate(page, predicate, ...args);
      if (value) return value;
      await sleep(100);
    }
    throw Error('Timed out after 35 seconds: ' + predicate + ' ' + args + ' | ' +
      await evaluate(page, () => document.body.innerText.slice(-1200)));
  }
  async function click(page, selector) {
    await wait(page, query => {
      const node = document.querySelector(query);
      if (!node) return false;
      const details = node.tagName === 'SUMMARY' ? null : node.closest('details');
      const wasOpen = Boolean(details?.open);
      if (details) details.open = true;
      if (!node.offsetWidth || node.disabled || node.hidden) {
        if (details && !wasOpen) details.open = false;
        return false;
      }
      node.click();
      if (details && !wasOpen) details.open = false;
      return true;
    }, selector);
  }

  async function input(page, selector, value) {
    await evaluate(page, (query, next) => {
      const node = document.querySelector(query);
      if (!node) throw Error('Missing input ' + query);
      node.value = String(next);
      for (const type of ['input', 'change']) node.dispatchEvent(new Event(type, {bubbles: true}));
    }, selector, value);
  }
  const origin = await one.evaluate('location.origin');
  const api = origin + '/poker/api';
  async function request(path, session, data, method) {
    const headers = {Origin: origin};
    if (session) Object.assign(headers, {
      Cookie: session.cookie,
      'X-SitNgo-Session': session.session_proof,
      'X-SitNgo-CSRF': session.csrf,
    });
    if (data !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(api + path, {
      method: method || (data === undefined ? 'GET' : 'POST'),
      headers,
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    let body = {};
    try { body = await response.json(); } catch (_) {}
    if (!response.ok) throw Error(path + ' ' + response.status + ' ' + JSON.stringify(body));
    if (path === '/register' || path === '/login') {
      const cookie = response.headers.get('set-cookie')?.split(';')[0];
      if (!cookie) throw Error(path + ' did not issue a session cookie');
      return {...body, cookie};
    }
    return body.table || body;
  }
  async function signIn(page, user) {
    await wait(page, visible, '#login-name');
    await input(page, '#login-name', user.username);
    await input(page, '#login-password', user.password);
    await evaluate(page, () => document.querySelector('#login-form').requestSubmit());
    await wait(page, visible, '#app-panel');
  }
  async function switchUser(page, from, to) {
    if (from) {
      const logoutSelector = await evaluate(page, () =>
        document.querySelector('#table-view')?.hidden ? '#logout-button' : '#table-logout-button');
      await click(page, logoutSelector);
      await wait(page, visible, '#login-name');
    }
    await signIn(page, to);
  }
  async function openTable(page, name) {
    const alreadyOpen = await evaluate(page, () => Boolean(document.querySelector('#close-table-button')?.offsetWidth));
    if (alreadyOpen) {
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
    await wait(page, tableName => document.querySelector('#view-table-name')?.textContent === tableName, name);
  }
  const stamp = Date.now().toString(36);
  async function register(label) {
    const username = ('Adj' + stamp + label).slice(0, 24);
    const password = 'FeltAdj_' + stamp + '_' + label + '_Pass';
    const account = {...await request('/register', null, {
      username, password, room_password: roomPassword,
    }), username, password};
    await seedAvatar(request, account);
    return account;
  }
  const host = await register('Host');
  const guest = await register('Guest');
  const third = await register('Third');
  const admin = await request('/login', null, {username:'admin', password:''});
  const presetValues = {
    preflop_bb:[2,2.5,3,3.5,4],
    postflop_percent:[30,50,75,100,150],
  };
  await request('/admin/config', admin, {
    runout_seconds:1, showdown_seconds:0,
    blind_announcement_seconds:0, elimination_announcement_seconds:0,
    bet_presets:presetValues,
  });
  const hostShared = await request('/config', host);
  const guestShared = await request('/config', guest);
  assert(JSON.stringify(hostShared.config?.bet_presets) === JSON.stringify(presetValues) &&
    JSON.stringify(guestShared.config?.bet_presets) === JSON.stringify(presetValues),
  'Shared bet presets did not load identically for normal users: ' +
    JSON.stringify({host:hostShared.config?.bet_presets,guest:guestShared.config?.bet_presets}));
  console.log('Admin-managed bet presets are shared through GET /config for every normal account.');
  async function waitForConfig(path, key, expected) {
    for (let attempt = 0; attempt < 120; attempt++) {
      const table = await request(path, host);
      if (table.config && Number(table.config[key]) === Number(expected)) return table;
      await sleep(100);
    }
    const table = await request(path, host);
    throw Error('Timed out waiting for saved table config ' + key + '=' + expected +
      ': ' + JSON.stringify(table.config));
  }
  await Promise.all([signIn(one, host), signIn(two, guest)]);

  const presetConfig = {
    name: 'Adjustments presets ' + stamp,
    starting_stack: 1000,
    small_blind: 5,
    big_blind: 10,
    level_minutes: 79,
    turn_seconds: 3600,
    buy_in: 10,
    payout_percentages: [60, 25, 15],
  };
  const created = await request('/tables', host, presetConfig);
  const presetPath = '/tables/' + created.id;
  await request(presetPath + '/seat', guest, {seat_no: 1});
  const started = await request(presetPath + '/start', host, {});
  await Promise.all([openTable(one, presetConfig.name), openTable(two, presetConfig.name)]);
  const actorUser = [host, guest].find(user => user.player.id === started.actor_id);
  assert(actorUser, 'Heads-up game began with an unexpected actor.');
  const actorPage = actorUser === host ? one : two;
  const otherPage = actorPage === one ? two : one;
  await actorPage.resize(320, 568);
  await otherPage.resize(390, 844);
  await wait(actorPage, visible, '#action-panel:not([hidden]) #raise-amount:enabled');
  const fivePresets = await evaluate(actorPage, () => {
    const buttons = [...document.querySelectorAll('#action-panel [data-raise-preset]')];
    return {
      count: buttons.length,
      visible: buttons.filter(node => node.offsetWidth && !node.hidden).length,
      labels: buttons.map(node => node.textContent.trim()),
      targets: buttons.map(node => Number(node.dataset.target)),
      boxes: buttons.map(node => {
        const r = node.getBoundingClientRect();
        return [r.left, r.top, r.right, r.bottom];
      }),
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      scrollY:window.scrollY,
      verticalOverflow:document.documentElement.scrollHeight > innerHeight + 1,
      viewport: [innerWidth, innerHeight],
    };
  });
  assert(fivePresets.count === 5 && fivePresets.visible === 5,
    'Five raise presets are not visible at 320px: ' + JSON.stringify(fivePresets));
  const expectedPresetTargets = [20, 25, 30, 35, 40];
  assert(JSON.stringify(fivePresets.targets) === JSON.stringify(expectedPresetTargets),
    'Five preflop preset targets do not reflect the shared admin settings: ' + JSON.stringify(fivePresets));
  assert(!fivePresets.overflow && fivePresets.boxes.every(([left, top, right, bottom]) =>
    left >= -1 && top >= -1 && right <= 321 && bottom <= 569),
  'Preset buttons are clipped or cause page overflow at 320px: ' + JSON.stringify(fivePresets));
  assert(fivePresets.scrollY <= 1 && !fivePresets.verticalOverflow,
    'Gameplay page scrolled or overflowed vertically at 320px: ' + JSON.stringify(fivePresets));
  await actorPage.screenshot('presets-320x568');

  // Desktop mouse-wheel input is exercised separately from the 320px mobile preset layout.
  await actorPage.resize(1280, 900);
  await sleep(180);
  await input(actorPage, '#raise-amount', 50);
  await evaluate(actorPage, () => {
    window.adjustmentActionPosts = 0;
    const original = window.fetch.bind(window);
    window.fetch = function(url, options) {
      if (String(url).includes('/poker/api/tables/') && /\/action(?:\?|$)/.test(String(url)) &&
          String(options?.method || 'GET').toUpperCase() === 'POST') window.adjustmentActionPosts += 1;
      return original(url, options);
    };
    document.activeElement?.blur();
  });
  const feltPoint = await evaluate(actorPage, () => {
    const r = document.querySelector('#felt').getBoundingClientRect();
    const x=r.left + r.width * .5, y=r.top + r.height * .42;
    const target=document.elementFromPoint(x,y);
    return {x,y,viewport:[innerWidth,innerHeight],felt:[r.left,r.top,r.right,r.bottom],
      focused:document.hasFocus(),visibility:document.visibilityState,
      hit:target ? {tag:target.tagName,id:target.id,className:String(target.className||'')} : null};
  });
  await evaluate(actorPage, () => {
    window.adjustmentsWheelEvents = 0;
    window.addEventListener('wheel', () => window.adjustmentsWheelEvents++, {capture:true,once:true});
  });
  await actorPage.wheelAt(feltPoint.x, feltPoint.y, -120);
  const wheelResult = await evaluate(actorPage, () => {
    const input = document.querySelector('#raise-amount');
    return {
      before: 50,
      after: Number(input.value),
      min: Number(input.min),
      max: Number(input.max),
      inputFocused: document.activeElement === input,
      posts: window.adjustmentActionPosts,
      wheelEvents: window.adjustmentsWheelEvents,
      responsive: true,
      visible:document.visibilityState === 'visible',
      pageFocused:document.hasFocus(),
      focusedElement: document.activeElement?.id || document.activeElement?.tagName || '',
    };
  });
  assert(wheelResult.after > wheelResult.before && wheelResult.after >= wheelResult.min &&
    wheelResult.after <= wheelResult.max && !wheelResult.inputFocused && wheelResult.posts === 0 &&
    wheelResult.wheelEvents === 1 && wheelResult.responsive && wheelResult.visible && wheelResult.pageFocused,
  'A real desktop wheel over the felt must step the legal raise amount without focus or submission: ' + JSON.stringify(wheelResult));
  await actorPage.resize(320, 568);
  await sleep(180);
  await click(actorPage, '#chat-button');
  await wait(actorPage, visible, '#chat-panel:not([hidden]) #chat-input');
  await request(presetPath + '/chat', host, {text:'drawer-first-' + stamp});
  await request(presetPath + '/chat', guest, {text:'drawer-second-' + stamp});
  await request(presetPath + '/chat', third, {text:'drawer-latest-' + stamp});
  await wait(actorPage, text => document.querySelector('#chat-messages')?.textContent.includes(text),
    'drawer-latest-' + stamp);
  const chatLayout = await evaluate(actorPage, () => {
    const hidden = selector => {
      const node = document.querySelector(selector);
      return !node || node.hidden || getComputedStyle(node).display === 'none' ||
        getComputedStyle(node).visibility === 'hidden' || node.getClientRects().length === 0;
    };
    return {
      inlineChatAbsent:!document.querySelector('#chat-topline,#chat-preview,#chat-quick-form,#chat-quick-input'),
      chatButtonInMenu:document.querySelector('#chat-button')?.closest('#table-menu')===document.querySelector('#table-menu'),
      panelVisible:!document.querySelector('#chat-panel').hidden,
      latest:document.querySelector('#chat-messages').textContent,
    };
  });
  assert(chatLayout.inlineChatAbsent && chatLayout.chatButtonInMenu &&
    chatLayout.panelVisible && chatLayout.latest.includes('drawer-latest-' + stamp),
  'Menu-only chat must keep the complete live drawer available without an inline preview/composer: ' + JSON.stringify(chatLayout));
  const chatMessage = 'drawer-enter-' + stamp;
  await evaluate(actorPage, text => {
    window.adjustmentsChatPosts = [];
    const field = document.querySelector('#chat-input');
    field.value = text;
    field.dispatchEvent(new Event('input', {bubbles:true}));
    field.focus({preventScroll:true});
    const original = window.fetch.bind(window);
    window.fetch = async function(url, options) {
      if (String(url).includes('/poker/api/tables/') && /\/chat(?:\?|$)/.test(String(url)) &&
          String(options?.method || 'GET').toUpperCase() === 'POST') {
        window.adjustmentsChatPosts.push(options?.body || '');
      }
      return original(url, options);
    };
  }, chatMessage);
  await actorPage.pressEnter();
  await wait(actorPage, text =>
    document.querySelector('#chat-messages')?.textContent.includes(text) &&
      document.querySelector('#chat-input')?.value === '',
  chatMessage);
  assert(await evaluate(actorPage, text =>
    window.adjustmentsChatPosts.length === 1 && window.adjustmentsChatPosts[0].includes(text),
  chatMessage),'Chat drawer Enter did not send exactly one message.');
  await actorPage.pressEscape();
  await wait(actorPage, () => document.querySelector('#chat-panel')?.hidden === true);
  await actorPage.screenshot('chat-drawer-320x568');

  const beforeAllIn = await evaluate(actorPage, () => {
    const rect = selector => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const r = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        bounds: [r.left, r.top, r.right, r.bottom],
        hidden: Boolean(node.hidden),
        display: style.display,
        position: style.position,
        zIndex: style.zIndex,
        className: String(node.className || ''),
      };
    };
    const seat = document.querySelector('#seat-grid .seat-card:not(.is-me)[data-player-id]');
    const r = seat.getBoundingClientRect();
    const cards = seat.querySelector('.seat-cards').getBoundingClientRect();
    const relativeIndex = Number(seat.dataset.relativeSeat);
    const seatCount = Number(document.querySelector('#felt').dataset.seatCount);
    return {
      playerId: seat.dataset.playerId,
      seatNo: seat.dataset.seatNo,
      seatDomIndex: [...document.querySelectorAll('#seat-grid .seat-card')].indexOf(seat),
      relativeIndex,
      idealAngleDegrees: ((90 + relativeIndex * 360 / seatCount) % 360 + 360) % 360,
      seatCount,
      seat: [r.left, r.top, r.right, r.bottom],
      cards: [cards.left, cards.top, cards.right, cards.bottom],
      miniCards: [...seat.querySelectorAll('.seat-cards .mini-card')].map(node => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {left:box.left,top:box.top,width:box.width,height:box.height,
          centerX:box.left+box.width/2,centerY:box.top+box.height/2,
          visible:style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0,
          back:node.classList.contains('back')};
      }),
      centerX: r.left + r.width / 2,
      cardsCenterX: cards.left + cards.width / 2,
      viewport: [innerWidth, innerHeight],
      geometry: {
        tableSurface: rect('#table-surface') || rect('.table-surface'),
        felt: rect('#felt'),
        seatGrid: rect('#seat-grid'),
        boardCenter: rect('#board-center') || rect('.board-center'),
        boardCaption: rect('#board-caption'),
        boardCards: rect('#board-cards'),
        pot: rect('#pot-display'),
        blindStrip: rect('#blind-strip'),
        street: rect('#street-label'),
        actionPanel: rect('#action-panel'),
        chatPanel: rect('#chat-panel'),
        pauseButton: rect('#pause-button'),
        runtimeSettingsButton: rect('#runtime-settings-button'),
        pausedBanner: rect('#paused-banner'),
        announcementBanner: rect('#announcement-banner'),
        blindAnnouncement: rect('#blind-announcement'),
      },
    };
  });
  assert(beforeAllIn.miniCards.length === 2 && beforeAllIn.miniCards.every(card => card.visible && card.back),
    'Opponent must show two visible card backs before all-in exposure: ' + JSON.stringify(beforeAllIn.miniCards));
  await actorPage.screenshot('top-opponent-before-allin-320');
  await otherPage.screenshot('top-opponent-before-allin-390');
  const raiseMax = await evaluate(actorPage, () => Number(document.querySelector('#raise-amount').max));
  await input(actorPage, '#raise-amount', raiseMax);
  await click(actorPage, '#action-controls [data-poker-action="raise_to"]');
  await wait(otherPage, () => {
    const button = document.querySelector('#action-controls [data-poker-action="call"]');
    return button?.offsetWidth && !button.disabled;
  });
  await click(otherPage, '#action-controls [data-poker-action="call"]');
  for (const page of [actorPage, otherPage]) await waitLong(page, visible, '#seat-grid .seat-card:not(.is-me) .seat-equity:not(.is-empty)');
  for (const [index, page] of [actorPage, otherPage].entries()) {
    await page.screenshot(index === 0 ? 'top-opponent-allin-odds-320' : 'top-opponent-allin-odds-390');
  }
  const afterAllIn = await evaluate(actorPage, () => {
    const rect = selector => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const r = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        bounds: [r.left, r.top, r.right, r.bottom],
        hidden: Boolean(node.hidden),
        display: style.display,
        position: style.position,
        zIndex: style.zIndex,
        className: String(node.className || ''),
      };
    };
    const seat = document.querySelector('#seat-grid .seat-card:not(.is-me)[data-player-id]');
    const r = seat.getBoundingClientRect();
    const cards = seat.querySelector('.seat-cards').getBoundingClientRect();
    const odds = seat.querySelector('.seat-equity:not(.is-empty)').getBoundingClientRect();
    const felt = document.querySelector('#felt').getBoundingClientRect();
    const relativeIndex = Number(seat.dataset.relativeSeat);
    const seatCount = Number(document.querySelector('#felt').dataset.seatCount);
    const point = (x, y) => {
      const hit = document.elementFromPoint(x, y);
      const chain = [];
      for (let node = hit; node && chain.length < 5; node = node.parentElement) {
        chain.push({
          tag: node.tagName.toLowerCase(),
          id: node.id || '',
          className: String(node.className || ''),
        });
      }
      return chain;
    };
    return {
      playerId: seat.dataset.playerId,
      seatNo: seat.dataset.seatNo,
      seatDomIndex: [...document.querySelectorAll('#seat-grid .seat-card')].indexOf(seat),
      relativeIndex,
      idealAngleDegrees: ((90 + relativeIndex * 360 / seatCount) % 360 + 360) % 360,
      seatCount,
      seat: [r.left, r.top, r.right, r.bottom],
      centerX: r.left + r.width / 2,
      cards: [cards.left, cards.top, cards.right, cards.bottom],
      miniCards: [...seat.querySelectorAll('.seat-cards .mini-card')].map(node => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {left:box.left,top:box.top,width:box.width,height:box.height,
          centerX:box.left+box.width/2,centerY:box.top+box.height/2,
          visible:style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0,
          back:node.classList.contains('back')};
      }),
      cardsCenterX: cards.left + cards.width / 2,
      odds: [odds.left, odds.top, odds.right, odds.bottom],
      felt: [felt.left, felt.top, felt.right, felt.bottom],
      viewport: [innerWidth, innerHeight],
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      scrollY:window.scrollY,
      verticalOverflow:document.documentElement.scrollHeight > innerHeight + 1,
      geometry: {
        tableSurface: rect('#table-surface') || rect('.table-surface'),
        felt: rect('#felt'),
        seatGrid: rect('#seat-grid'),
        boardCenter: rect('#board-center') || rect('.board-center'),
        boardCaption: rect('#board-caption'),
        boardCards: rect('#board-cards'),
        pot: rect('#pot-display'),
        blindStrip: rect('#blind-strip'),
        street: rect('#street-label'),
        actionPanel: rect('#action-panel'),
        chatPanel: rect('#chat-panel'),
        pauseButton: rect('#pause-button'),
        runtimeSettingsButton: rect('#runtime-settings-button'),
        pausedBanner: rect('#paused-banner'),
        announcementBanner: rect('#announcement-banner'),
        blindAnnouncement: rect('#blind-announcement'),
      },
      visibleSeats: [...document.querySelectorAll('#seat-grid .seat-card')].map(node => {
        const bounds = element => {
          if (!element) return null;
          const r = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return style.display === 'none' || r.width <= 0 || r.height <= 0
            ? null
            : [r.left, r.top, r.right, r.bottom];
        };
        return {
          playerId: node.dataset.playerId,
          seatNo: node.dataset.seatNo,
          relativeIndex: Number(node.dataset.relativeSeat),
          hero: node.classList.contains('is-me'),
          seat: bounds(node),
          cards: bounds(node.querySelector('.seat-cards')),
          odds: bounds(node.querySelector('.seat-equity:not(.is-empty)')),
        };
      }),
      seatBlockerOverlaps: (() => {
        const asBox = node => {
          if (!node) return null;
          const r = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          if (style.display === 'none' || r.width <= 0 || r.height <= 0) return null;
          return [r.left, r.top, r.right, r.bottom];
        };
        const blockers = [
          ['board-cards', document.querySelector('#board-cards')],
          ['pot', document.querySelector('#pot-display')],
          ['blind-strip', document.querySelector('#blind-strip')],
          ['street', document.querySelector('#street-label')],
        ].map(([name, node]) => ({name, box: asBox(node)})).filter(item => item.box);
        const overlaps = [];
        const seats = [...document.querySelectorAll('#seat-grid .seat-card')];
        for (const node of seats) {
          const components = [
            ['seat', node],
            ['cards', node.querySelector('.seat-cards')],
            ['equity', node.querySelector('.seat-equity:not(.is-empty)')],
            ...[...node.querySelectorAll('.seat-local-markers .seat-action, .seat-local-markers .seat-turn-clock, .seat-local-markers .seat-wager')]
              .map((marker,index) => ['marker ' + index, marker]),
          ];
          const dealerChip = node.querySelector(':scope > .dealer-marker');
          if (dealerChip) components.push(['dealer chip', dealerChip]);
          for (const [part, element] of components) {
            const box = asBox(element);
            if (!box) continue;
            for (const blocker of blockers) {
              if (box[0] < blocker.box[2] && box[2] > blocker.box[0] &&
                  box[1] < blocker.box[3] && box[3] > blocker.box[1]) {
                overlaps.push({
                  playerId: node.dataset.playerId,
                  seatNo: node.dataset.seatNo,
                  relativeIndex: node.dataset.relativeSeat,
                  hero: node.classList.contains('is-me'),
                  part,
                  blocker: blocker.name,
                  box,
                  blockerBox: blocker.box,
                });
              }
            }
          }
        }
        return overlaps;
      })(),
      markerAssociationIssues: (() => {
        const issues=[];
        for (const marker of document.querySelectorAll('#seat-grid .seat-local-markers .seat-action, #seat-grid .seat-local-markers .seat-turn-clock, #seat-grid .seat-local-markers .seat-wager')) {
          const owner=marker.closest('.seat-card[data-seat-no]'), lane=marker.closest('.seat-local-markers');
          if (!owner || !lane?.contains(marker)) issues.push({type:String(marker.className),reason:'outside owner lane'});
          const declared=marker.getAttribute('data-seat-no') || marker.getAttribute('data-action-seat') || marker.getAttribute('data-marker-seat');
          if (declared && owner?.dataset.seatNo !== declared) issues.push({type:String(marker.className),reason:'owner seat mismatch',declared,actual:owner?.dataset.seatNo});
          const box=node=>{if(!node)return null;const style=getComputedStyle(node),r=node.getBoundingClientRect();if(style.display==='none'||style.visibility==='hidden'||r.width<=0||r.height<=0)return null;return [r.left,r.top,r.right,r.bottom];};
          const markerBox=box(marker), ownerBox=box(owner), cardsBox=box(owner?.querySelector('.seat-cards'));
          if (markerBox && ownerBox && (markerBox[0]<ownerBox[0]-1 || markerBox[1]<ownerBox[1]-1 || markerBox[2]>ownerBox[2]+1 || markerBox[3]>ownerBox[3]+1)) issues.push({type:String(marker.className),reason:'outside seat bounds'});
          if (markerBox && cardsBox && markerBox[0]<cardsBox[2] && markerBox[2]>cardsBox[0] && markerBox[1]<cardsBox[3] && markerBox[3]>cardsBox[1]) issues.push({type:String(marker.className),reason:'overlaps hole cards'});
        }
        return issues;
      })(),
      oddsHitAtCenter: point(odds.left + odds.width / 2, odds.top + odds.height / 2),
      oddsHitNearBottom: point(odds.left + odds.width / 2, Math.min(innerHeight - 1, odds.bottom - 1)),
    };
  });
  const shifted = Math.abs(beforeAllIn.centerX - afterAllIn.centerX) > 1 ||
    Math.abs(beforeAllIn.seat[1] - afterAllIn.seat[1]) > 1 ||
    Math.abs(beforeAllIn.cardsCenterX - afterAllIn.cardsCenterX) > 1 ||
    Math.abs(beforeAllIn.cards[1] - afterAllIn.cards[1]) > 1;
  const internalCardShift = beforeAllIn.miniCards.length !== 2 || afterAllIn.miniCards.length !== 2 ||
    beforeAllIn.miniCards.some(card => !card.visible || !card.back) ||
    afterAllIn.miniCards.some((card, index) => !card.visible || card.back ||
      Math.abs(card.centerX - beforeAllIn.miniCards[index].centerX) > 1 ||
      Math.abs(card.centerY - beforeAllIn.miniCards[index].centerY) > 1);
  const escaped = afterAllIn.odds[0] < afterAllIn.felt[0] - 1 ||
    afterAllIn.odds[2] > afterAllIn.felt[2] + 1 ||
    afterAllIn.odds[1] < afterAllIn.felt[1] - 1 ||
    afterAllIn.odds[3] > afterAllIn.felt[3] + 1 ||
    afterAllIn.overflow || afterAllIn.scrollY > 1 || afterAllIn.verticalOverflow;
  if (shifted || internalCardShift) layoutFailures.push(
    'Heads-up opponent card bounds or card faces moved when all-in odds appeared: ' +
    JSON.stringify({beforeAllIn, afterAllIn}));
  if (escaped) layoutFailures.push(
    'All-in odds escaped the felt bounds or caused page overflow: ' +
    JSON.stringify({beforeAllIn, afterAllIn}));
  if (afterAllIn.seatBlockerOverlaps.length || afterAllIn.markerAssociationIssues.length) layoutFailures.push(
    'Seat content or local markers overlap blockers or leave their associated seat: ' +
    JSON.stringify({overlaps:afterAllIn.seatBlockerOverlaps,markerAssociationIssues:afterAllIn.markerAssociationIssues}));
  console.log('320px all-in geometry diagnostics: ' +
    JSON.stringify({before: beforeAllIn, after: afterAllIn}));
  console.log('320px shared presets and chat drawer, plus desktop focus-free wheel, pass; strict odds geometry is deferred to the suite end.');
  await actorPage.screenshot('heads-up-full-320');
  const pauseConfig = {
    name: 'Adjustments pause ' + stamp,
    starting_stack: 1000,
    small_blind: 5,
    big_blind: 10,
    level_minutes: 79,
    turn_seconds: 3,
    buy_in: 10,
    payout_percentages: [100],
  };
  const pauseCreated = await request('/tables', host, pauseConfig);
  const pausePath = '/tables/' + pauseCreated.id;
  await request(pausePath + '/bots', admin, {seat_no: 1});
  await Promise.all([openTable(one, pauseConfig.name), openTable(two, pauseConfig.name)]);
  await evaluate(one, () => {
    window.adjustmentsPauseTimer = window.setInterval(() => {
      const actorId = document.querySelector('#seat-grid .seat-card.is-acting')?.dataset.playerId || '';
      if (actorId.startsWith('bot:')) {
        const pause = document.querySelector('#pause-button');
        if (pause && !pause.hidden && !pause.disabled) {
          window.clearInterval(window.adjustmentsPauseTimer);
          window.adjustmentsPauseTimer = 0;
          pause.click();
        }
        return;
      }
      const action = document.querySelector(
        '#action-controls [data-poker-action="call"]:not([disabled]), ' +
        '#action-controls [data-poker-action="check"]:not([disabled])'
      );
      if (action && !window.adjustmentsActed) {
        window.adjustmentsActed = true;
        action.click();
        window.setTimeout(() => { window.adjustmentsActed = false; }, 200);
      }
    }, 20);
  });
  await click(one, '#start-button');
  await waitLong(one, () => document.querySelector('#pause-button')?.textContent === 'Resume game');
  await openTable(two, pauseConfig.name);
  const guestPauseControl = await evaluate(two, () => document.querySelector('#pause-button')?.hidden === true);
  assert(guestPauseControl, 'A non-host can see the host pause control.');
  await wait(one, visible, '#runtime-settings-button:not([hidden])');
  await click(one, '#runtime-settings-button');
  await wait(one, visible, '#table-settings-form:not([hidden])');
  const runtimeControls = await evaluate(one, () => ({
    mode: document.querySelector('#table-settings-form').dataset.mode,
    economicsHidden: ['#settings-buy-in', '#settings-payout', '#settings-max-seats',
      '#settings-starting-stack', '#settings-small-blind', '#settings-big-blind']
      .every(selector => {
        const node = document.querySelector(selector);
        return !node || node.closest('[data-lobby-only]')?.hidden || node.disabled;
      }),
    timingEnabled: ['#settings-level-minutes', '#settings-turn-seconds']
      .every(selector => document.querySelector(selector) && !document.querySelector(selector).disabled),
  }));
  assert(runtimeControls.mode === 'runtime' && runtimeControls.economicsHidden && runtimeControls.timingEnabled,
    'Paused runtime settings must expose timing only: ' + JSON.stringify(runtimeControls));

  async function saveRuntimeAt(width, height, selector, value, screenshot, settingKey) {
    await one.resize(width, height);
    const formOpen = await evaluate(one, () =>
      !document.querySelector('#table-settings-form').hidden);
    if (!formOpen) {
      await click(one, '#runtime-settings-button');
      await wait(one, visible, '#table-settings-form:not([hidden])');
    }
    await waitLong(one, query => {
      const field = document.querySelector(query);
      return field && !field.disabled;
    }, selector);
    await input(one, selector, value);
    await evaluate(one, () => document.querySelector('#save-settings-button').scrollIntoView({block: 'center'}));
    await sleep(120);
    const control = await evaluate(one, query => {
      const node = document.querySelector('#save-settings-button');
      const r = node.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        disabled: node.disabled,
        fieldDisabled: document.querySelector(query).disabled,
        targetValue: document.querySelector(query).value,
        formHidden: document.querySelector('#table-settings-form').hidden,
        lockNote: document.querySelector('#settings-lock-note').textContent,
        pauseLabel: document.querySelector('#pause-button').textContent,
        rect: [r.left, r.top, r.right, r.bottom],
        viewport: [innerWidth, innerHeight],
        reachable: r.width > 0 && r.height > 0 && r.left >= -1 && r.top >= -1 &&
          r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 &&
          (hit === node || node.contains(hit)),
      };
    }, selector);
    assert(!control.disabled && !control.fieldDisabled && control.reachable,
      'Save settings is not reachable at ' + width + 'x' + height + ': ' + JSON.stringify(control));
    await one.screenshot(screenshot);
    await click(one, '#save-settings-button');
    await waitForConfig(pausePath, settingKey, value);
  }
  await saveRuntimeAt(320, 568, '#settings-turn-seconds', 4, 'runtime-save-320x568', 'turn_seconds');
  await saveRuntimeAt(390, 844, '#settings-level-minutes', 0.5,
    'runtime-save-390x844', 'level_minutes');
  let pausedView = await request(pausePath, host);
  assert(pausedView.paused && pausedView.config.turn_seconds === 4 &&
    pausedView.config.level_minutes === 0.5,
  'Paused pacing changes did not save to the active table: ' + JSON.stringify(pausedView.config));
  const pausedSnapshot = {
    hand: pausedView.hand_no,
    actor: pausedView.actor_id,
    turn: pausedView.turn_version,
    log: pausedView.action_log.length,
    stacks: pausedView.seats.map(seat => seat.stack),
    timer: pausedView.turn_deadline - pausedView.server_now,
  };
  const pausedBlindCountdown = await wait(one, () => {
    const value=document.querySelector('#blind-level-countdown')?.textContent.trim() || '';
    return /^\d{1,3}:\d{2}$/.test(value) ? value : false;
  });
  await sleep(4200);
  pausedView = await request(pausePath, host);
  assert(pausedView.paused && pausedView.hand_no === pausedSnapshot.hand &&
    pausedView.actor_id === pausedSnapshot.actor && pausedView.turn_version === pausedSnapshot.turn &&
    pausedView.action_log.length === pausedSnapshot.log &&
    JSON.stringify(pausedView.seats.map(seat => seat.stack)) === JSON.stringify(pausedSnapshot.stacks) &&
    Math.abs((pausedView.turn_deadline - pausedView.server_now) - pausedSnapshot.timer) < 0.35,
  'Bot/action/shot-clock state advanced while the host pause was active: ' + JSON.stringify({pausedSnapshot, pausedView}));
  const pausedBlindCountdownAfter = await evaluate(one, () => document.querySelector('#blind-level-countdown')?.textContent.trim() || '');
  assert(pausedBlindCountdownAfter === pausedBlindCountdown,
    'Blind-level countdown moved while the game was paused: ' + pausedBlindCountdown + ' to ' + pausedBlindCountdownAfter);
  assert(pausedView.actor_id && String(pausedView.actor_id).startsWith('bot:'),
    'Pause fixture did not stop on the bot turn.');
  console.log('Host pause stopped the bot turn and shot clock; mobile runtime Save worked at 320x568 and 390x844.');

  const blindConfig = {
    name: 'Adjustments blind announcement ' + stamp,
    starting_stack: 1000,
    small_blind: 5,
    big_blind: 10,
    level_minutes: 0.1,
    turn_seconds: 3600,
    buy_in: 10,
    payout_percentages: [60, 25, 15],
  };
  await request('/admin/config', admin, {
    runout_seconds:1, showdown_seconds:0,
    blind_announcement_seconds:8, elimination_announcement_seconds:5,
  });
  const blindCreated = await request('/tables', host, blindConfig);
  const blindPath = '/tables/' + blindCreated.id;
  await request(blindPath + '/seat', guest, {seat_no: 1});
  await request(blindPath + '/seat', third, {seat_no: 2});
  await request(blindPath + '/start', host, {});
  await Promise.all([openTable(one, blindConfig.name), openTable(two, blindConfig.name)]);
  let blindView = await request(blindPath, host);
  const untilBlindDeadline = blindView.blinds.next_level_at * 1000 - Date.now();
  if (untilBlindDeadline > 0) await sleep(untilBlindDeadline + 150);
  blindView = await request(blindPath, host);
  assert(blindView.blinds.level === 1 && blindView.street !== 'showdown',
    'The short blind fixture did not wait out level 1 during its live hand: ' + JSON.stringify({
      level:blindView.blinds.level,street:blindView.street,nextLevel:blindView.blinds.next_level_at
    }));
  let folds = 0;
  while (blindView.street !== 'showdown' && folds < 3) {
    const actor = [host, guest, third].find(user => user.player.id === blindView.actor_id);
    assert(actor, 'Blind announcement hand has an unknown actor: ' + blindView.actor_id);
    blindView = await request(blindPath + '/action', actor, {
      action: 'fold',
      expected_hand: blindView.hand_no,
      expected_turn_version: blindView.turn_version,
    });
    folds += 1;
  }
  assert(blindView.street === 'showdown',
    'The blind-boundary hand did not reach showdown: ' + JSON.stringify({
      street:blindView.street,hand:blindView.hand_no,blind:blindView.blinds
    }));
  const boundaryHand = blindView.hand_no;
  const boundaryDeadline = blindView.next_hand_at;
  for (let attempt = 0; attempt < 80 && !blindView.blind_announcement; attempt++) {
    await sleep(100);
    blindView = await request(blindPath, host);
    assert(blindView.hand_no === boundaryHand && blindView.street === 'showdown',
      'A new hand started before the blind announcement became active: ' + JSON.stringify({
        before:boundaryHand,after:blindView.hand_no,street:blindView.street
      }));
  }
  assert(blindView.blind_announcement,
    'The queued blind boundary announcement never became active: ' + JSON.stringify(blindView));
  assert(blindView.next_hand_at >= boundaryDeadline &&
    blindView.config.blind_announcement_seconds === 8 &&
    blindView.next_hand_at >= blindView.blind_announcement.until,
  'Blind announcement duration did not hold the next deal: ' + JSON.stringify({
    config: blindView.config,
    next_hand_at: blindView.next_hand_at,
    announcement: blindView.blind_announcement,
  }));
  await waitLong(one, visible, '#blind-announcement:not([hidden])');
  await one.reload();
  await waitLong(one, visible, '#app-panel');
  const blindReconnected = await evaluate(one, name =>
    document.querySelector('#view-table-name')?.textContent === name &&
      !document.querySelector('#blind-announcement')?.hidden,
  blindConfig.name);
  if (!blindReconnected) await openTable(one, blindConfig.name);
  await waitLong(one, () => document.querySelector('#blind-announcement')?.offsetWidth > 0);
  await one.screenshot('blind-announcement-after-reload');
  const restoredBlind = await request(blindPath, host);
  assert(restoredBlind.blind_announcement && restoredBlind.blind_announcement.until > restoredBlind.server_now,
    'Blind announcement did not persist through the reconnect window.');
  console.log('Short blind level held its next hand and restored the configured announcement after reload.');

  const finalConfig = {
    name: 'Adjustments final announcement ' + stamp,
    starting_stack: 100,
    small_blind: 5,
    big_blind: 10,
    level_minutes: 79,
    turn_seconds: 3600,
    buy_in: 10,
    payout_percentages: [60, 40],
  };
  await request('/admin/config', admin, {
    runout_seconds:1, showdown_seconds:0,
    blind_announcement_seconds:0, elimination_announcement_seconds:12,
  });
  const finalCreated = await request('/tables', host, finalConfig);
  const finalPath = '/tables/' + finalCreated.id;
  await request(finalPath + '/seat', guest, {seat_no: 1});
  const finalStarted = await request(finalPath + '/start', host, {});
  await Promise.all([openTable(one, finalConfig.name), openTable(two, finalConfig.name)]);
  const finalActorUser = [host, guest].find(user => user.player.id === finalStarted.actor_id);
  assert(finalActorUser, 'Final all-in began with an unknown actor.');
  const finalActorPage = finalActorUser === host ? one : two;
  const finalOtherPage = finalActorPage === one ? two : one;
  await Promise.all([one.resize(390, 844), two.resize(390, 844)]);
  await wait(finalActorPage, visible, '#action-panel:not([hidden]) #raise-amount:enabled');
  const allInAmount = await evaluate(finalActorPage, () => Number(document.querySelector('#raise-amount').max));
  await input(finalActorPage, '#raise-amount', allInAmount);
  await click(finalActorPage, '#action-controls [data-poker-action="raise_to"]');
  await wait(finalOtherPage, () => {
    const button = document.querySelector('#action-controls [data-poker-action="call"]');
    return button?.offsetWidth && !button.disabled;
  });
  await click(finalOtherPage, '#action-controls [data-poker-action="call"]');
  await waitLong(one, visible, '#announcement-banner:not([hidden])');
  await waitLong(two, visible, '#announcement-banner:not([hidden])');
  const finalView = await request(finalPath, host);
  assert(finalView.status === 'completed' && finalView.elimination_announcement &&
    finalView.config.elimination_announcement_seconds === 12 &&
    finalView.elimination_announcement.until - finalView.server_now > 7,
  'Final elimination announcement did not retain the configured delay: ' + JSON.stringify({
    status: finalView.status,
    config: finalView.config,
    announcement: finalView.elimination_announcement,
    server_now: finalView.server_now,
  }));
  const heldResults = await evaluate(one, () => ({
    banner: !document.querySelector('#announcement-banner').hidden,
    panelHidden: document.querySelector('#results-panel').hidden,
    reopenHidden: document.querySelector('#reopen-results-button').hidden,
  }));
  assert(heldResults.banner && heldResults.panelHidden && heldResults.reopenHidden,
    'Final standings appeared before the elimination announcement ended: ' + JSON.stringify(heldResults));
  await one.reload();
  await waitLong(one, visible, '#app-panel');
  const finalReconnected = await evaluate(one, name =>
    document.querySelector('#view-table-name')?.textContent === name &&
      !document.querySelector('#announcement-banner')?.hidden,
  finalConfig.name);
  if (!finalReconnected) await openTable(one, finalConfig.name);
  await waitLong(one, visible, '#announcement-banner:not([hidden])');
  await one.screenshot('final-elimination-after-reload');
  const reloadedResults = await evaluate(one, () => ({
    banner: !document.querySelector('#announcement-banner').hidden,
    panelHidden: document.querySelector('#results-panel').hidden,
    reopenHidden: document.querySelector('#reopen-results-button').hidden,
  }));
  assert(reloadedResults.banner && reloadedResults.panelHidden && reloadedResults.reopenHidden,
    'Final announcement or standings hold did not survive reload: ' + JSON.stringify(reloadedResults));
  await waitLong(one, () => {
    const panel = document.querySelector('#results-panel');
    const reopen = document.querySelector('#reopen-results-button');
    return (panel && !panel.hidden) || (reopen && !reopen.hidden);
  });
  await one.screenshot('final-standings-after-announcement');
  console.log('Blind and elimination announcements persisted through reconnect; final standings waited for the configured hold.');
  if (layoutFailures.length) throw Error('Strict heads-up geometry gate failed:\n' + layoutFailures.join('\n'));
}
