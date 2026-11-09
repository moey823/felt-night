// Focused presentation checks for poker results, queued announcements, chat, and felt geometry.
import {seedAvatar} from './avatar-fixture.mjs';

export default async function presentation([one, two], sleep, roomPassword) {
  const evaluate = (page, fn, ...args) =>
    page.evaluate('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')');
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  const layoutFailures = [];
  const cardBaselines = new Map();
  const seatBaselines = new Map();
  const presetBaselines = new Map();
  const visible = selector => {
    const node = document.querySelector(selector);
    if (!node) return false;
    const details = node.closest('details');
    if (details) details.open = true;
    return Boolean(node.offsetWidth);
  };

  async function wait(page, predicate, ...args) {
    for (let attempt = 0; attempt < 180; attempt++) {
      const value = await evaluate(page, predicate, ...args);
      if (value) return value;
      await sleep(100);
    }
    throw Error('Timed out: ' + predicate + ' ' + args + ' | ' +
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
      for (const type of ['input', 'change']) node.dispatchEvent(new Event(type, {bubbles:true}));
    }, selector, value);
  }

  const origin = await one.evaluate('location.origin');
  const apiRoot = origin + '/poker/api';
  async function request(path, account, data, method) {
    const headers = {Origin:origin};
    if (account) Object.assign(headers, {
      Cookie:account.cookie,
      'X-SitNgo-Session':account.session_proof,
      'X-SitNgo-CSRF':account.csrf,
    });
    if (data !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(apiRoot + path, {
      method:method || (data === undefined ? 'GET' : 'POST'),
      headers,
      body:data === undefined ? undefined : JSON.stringify(data),
    });
    let body = {};
    try { body = await response.json(); } catch (_) {}
    if (!response.ok) throw Error(path + ' returned ' + response.status + ': ' + JSON.stringify(body));
    if (path === '/register' || path === '/login') {
      const cookie = response.headers.get('set-cookie')?.split(';')[0];
      if (!cookie) throw Error('Registration did not issue a session cookie.');
      return {...body, cookie};
    }
    return body.table || body;
  }
  async function register(label, stamp) {
    const username = ('Pres' + stamp + label).slice(0, 24);
    const password = 'FeltPres_' + stamp + '_' + label + '_Pass';
    const account = {...await request('/register', null, {
      username, password, room_password:roomPassword,
    }), username, password};
    await seedAvatar(request, account);
    return account;
  }
  async function signIn(page, account) {
    await wait(page, visible, '#login-name');
    await input(page, '#login-name', account.username);
    await input(page, '#login-password', account.password);
    await evaluate(page, () => document.querySelector('#login-form').requestSubmit());
    await wait(page, visible, '#app-panel');
  }
  async function openTable(page, name) {
    const active = await evaluate(page, () =>
      Boolean(document.querySelector('#close-table-button')?.offsetWidth));
    if (active) {
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
  function tableName(label, stamp) { return 'Presentation ' + label + ' ' + stamp; }

  async function recordGeometry(page, label) {
    try {
      await evaluate(page, () => new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 250)))));
      const data = await evaluate(page, () => {
        const box = node => {
          if (!node) return null;
          const style = getComputedStyle(node);
          const r = node.getBoundingClientRect();
          if (style.display === 'none' || style.visibility === 'hidden' ||
              r.width <= 0 || r.height <= 0) return null;
          return [r.left, r.top, r.right, r.bottom];
        };
        const overlaps = (a, b) => a && b &&
          Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > 1 &&
          Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > 1;
        const within = (a, b) => a && b &&
          a[0] >= b[0] - 1 && a[1] >= b[1] - 1 &&
          a[2] <= b[2] + 1 && a[3] <= b[3] + 1;
        const felt = box(document.querySelector('#felt'));
        const issues = [];
        const viewport = [0, 0, innerWidth, innerHeight];
        const presetGroup=document.querySelector('#action-panel .raise-presets');
        const presetButtons=[...(presetGroup?.querySelectorAll('[data-raise-preset]') || [])];
        const presetSlots=Number.parseInt(getComputedStyle(presetGroup || document.body)
          .getPropertyValue('--preset-slots'),10) || 0;
        const presetRects=presetButtons.map(box);
        const boardCardCount=[...document.querySelectorAll('#board-cards .playing-card')]
          .filter(node=>!node.classList.contains('placeholder')).length;
        if (presetGroup && presetSlots !== 5) issues.push('preset grid did not reserve the max five slots: ' + presetSlots);
        if (boardCardCount >= 3 && presetButtons.length !== 5) issues.push('postflop preset count changed: ' + presetButtons.length);
        if (window.scrollY > 1) issues.push('gameplay page scrolled vertically');
        if (document.documentElement.scrollHeight > innerHeight + 1) issues.push('gameplay page has vertical overflow');
        if (!felt) return {issues:['felt is not visible', ...issues], felt, viewport};
        const parts = [];
        for (const node of document.querySelectorAll('#seat-grid .seat-card')) {
          parts.push(['seat ' + (node.dataset.seatNo || '?'), node]);
          const cards = node.querySelector('.seat-cards');
          if (cards) parts.push(['seat cards ' + (node.dataset.seatNo || '?'), cards]);
          const equity = node.querySelector('.seat-equity:not(.is-empty)');
          if (equity) parts.push(['equity ' + (node.dataset.seatNo || '?'), equity]);
          const result = node.querySelector('.seat-result.is-winner');
          if (result) parts.push(['winner result ' + (node.dataset.seatNo || '?'), result]);
          for (const marker of node.querySelectorAll('.seat-local-markers .seat-action, .seat-local-markers .seat-turn-clock, .seat-local-markers .seat-wager')) {
            parts.push(['local marker ' + (node.dataset.seatNo || '?'), marker]);
          }
          const dealer = node.querySelector(':scope > .dealer-marker');
          if (dealer) parts.push(['dealer chip ' + (node.dataset.seatNo || '?'), dealer]);
        }
        for (const [index, node] of [...document.querySelectorAll(
          '#board-cards .playing-card, #seat-grid .mini-card'
        )].entries()) parts.push(['card ' + index, node]);
        const blockers = ['#board-cards','#pot-display','#blind-strip','#street-label']
          .map(selector => [selector, box(document.querySelector(selector))])
          .filter(item => item[1]);
        for (const [name, node] of parts) {
          const rect = box(node);
          if (!rect) continue;
          if (!within(rect, felt)) issues.push(name + ' escaped felt: ' + JSON.stringify(rect));
          if (!within(rect, viewport)) issues.push(name + ' escaped viewport: ' + JSON.stringify(rect));
          for (const [blockerName, blocker] of blockers) {
            const isOwnBoard = blockerName === '#board-cards' &&
              node.closest('#board-cards');
            if (!isOwnBoard && overlaps(rect, blocker)) {
              issues.push(name + ' overlaps ' + blockerName + ': ' +
                JSON.stringify({part:rect,blocker}));
            }
          }
        }
        const feltNode = document.querySelector('#felt');
        for (const selector of ['#showdown-summary','#announcement-banner','#blind-announcement']) {
          const node = document.querySelector(selector);
          const rect = box(node);
          if (!rect) continue;
          if (feltNode?.contains(node) || document.querySelector('#table-surface')?.contains(node)) {
            issues.push(selector + ' is inside the felt/table surface');
          }
          if (overlaps(rect, felt)) issues.push(selector + ' overlaps the felt');
          if (!within(rect, viewport)) issues.push(selector + ' escaped viewport');
        }
        const seatNodes = [...document.querySelectorAll('#seat-grid .seat-card[data-seat-no]')];
        const seatRows = seatNodes.map(node => ({
          seatNo:node.dataset.seatNo || '',playerId:node.dataset.playerId || '',
          relativeIndex:node.dataset.relativeSeat || '',rect:box(node),
        }));
        const markerRows = [...document.querySelectorAll('#seat-grid .seat-local-markers .seat-action, #seat-grid .seat-local-markers .seat-turn-clock, #seat-grid .seat-local-markers .seat-wager')].map(node => {
          const owner=node.closest('.seat-card[data-seat-no]'), local=node.closest('.seat-local-markers');
          const marker=box(node), ownerBox=box(owner), cards=box(owner?.querySelector('.seat-cards'));
          const markerSeat=node.getAttribute('data-seat-no') || node.getAttribute('data-action-seat') || node.getAttribute('data-marker-seat') || '';
          if (marker && (!owner || !local?.contains(node) || !within(marker,ownerBox))) issues.push('marker escaped its associated seat lane');
          if (marker && markerSeat && owner?.dataset.seatNo !== markerSeat) issues.push('marker seat id differs from its containing seat');
          if (marker && overlaps(marker,cards)) issues.push('seat-local marker overlaps its own cards');
          return {seatNo:owner?.dataset.seatNo || '',type:String(node.className),rect:marker};
        });
        const cardRows = seatNodes.map(node => ({
          playerId:node.dataset.playerId || '',
          seatNo:node.dataset.seatNo || '',
          cards:[...node.querySelectorAll('.mini-card')].map(box).filter(Boolean),
        })).filter(row => row.cards.length);
        return {
          issues, felt, viewport, blockers, cardRows, seatRows, markerRows,
          presetLayout:{slots:presetSlots,rects:presetRects,boardCardCount},
          viewerId:document.querySelector('#seat-grid .seat-card.is-me')?.dataset.playerId || '',
          tableName:document.querySelector('#view-table-name')?.textContent || '',
          seatIds:seatNodes.map(node => node.dataset.playerId || '').filter(Boolean).sort(),
        };
      });
      for (const issue of data.issues) layoutFailures.push(label + ': ' + issue);
      const stabilityKey = [
        data.tableName, data.viewport[2], data.viewport[3], data.viewerId,
        data.seatIds.join(','),
      ].join('|');
      const previousPresets = presetBaselines.get(stabilityKey);
      if (!previousPresets) {
        presetBaselines.set(stabilityKey, data.presetLayout);
      } else {
        if (previousPresets.slots !== data.presetLayout.slots) {
          layoutFailures.push(label + ': reserved preset column count changed from ' +
            previousPresets.slots + ' to ' + data.presetLayout.slots);
        }
        const stableCount=Math.min(previousPresets.rects.length,data.presetLayout.rects.length);
        for (let index=0; index<stableCount; index++) {
          const before=previousPresets.rects[index], after=data.presetLayout.rects[index];
          if (!before || !after || before.some((value,axis)=>Math.abs(value-after[axis])>1)) {
            layoutFailures.push(label + ': preset slot ' + index + ' moved across streets: ' +
              JSON.stringify({before,after}));
          }
        }
      }
      const previousSeats = seatBaselines.get(stabilityKey);
      if (!previousSeats) {
        seatBaselines.set(stabilityKey, data.seatRows);
      } else {
        const beforeBySeat = new Map(previousSeats.map(row => [row.seatNo,row]));
        for (const row of data.seatRows) {
          const before=beforeBySeat.get(row.seatNo);
          if (!before || before.playerId !== row.playerId || before.relativeIndex !== row.relativeIndex ||
              !before.rect || !row.rect || before.rect.some((value,index) => Math.abs(value-row.rect[index])>1)) {
            layoutFailures.push(label + ': original seat ring changed at seat ' + row.seatNo +
              ' before=' + JSON.stringify(before) + ' after=' + JSON.stringify(row));
          }
        }
      }
      const previous = cardBaselines.get(stabilityKey);
      if (!previous) {
        cardBaselines.set(stabilityKey, data.cardRows);
      } else {
        const previousByPlayer = new Map(previous.map(row => [row.playerId, row]));
        for (const row of data.cardRows) {
          const before = previousByPlayer.get(row.playerId);
          if (!before) continue;
          if (before.cards.length !== row.cards.length) {
            layoutFailures.push(label + ': ' + row.playerId + ' changed visible hole-card count from ' +
              before.cards.length + ' to ' + row.cards.length);
            continue;
          }
          for (let index=0; index<row.cards.length; index++) {
            const a=before.cards[index], b=row.cards[index];
            const center = rect => [(rect[0]+rect[2])/2,(rect[1]+rect[3])/2];
            const ac=center(a), bc=center(b);
            const delta=[Math.abs(ac[0]-bc[0]),Math.abs(ac[1]-bc[1]),
              Math.abs((a[2]-a[0])-(b[2]-b[0])),Math.abs((a[3]-a[1])-(b[3]-b[1]))];
            if (delta.some(value => value > 1)) {
              layoutFailures.push(label + ': ' + row.playerId + ' hole card ' + index +
                ' moved/resized beyond 1px (center x/y, size w/h): ' + JSON.stringify(delta) +
                ' key=' + stabilityKey + ' before=' + JSON.stringify(a) +
                ' after=' + JSON.stringify(b));
            }
          }
        }
      }
      console.log('Presentation geometry ' + label + ': ' + JSON.stringify({
        issues:data.issues, felt:data.felt, viewport:data.viewport,
        cardCounts:data.cardRows.map(row => ({playerId:row.playerId,count:row.cards.length})),
      }));
    } catch (error) {
      layoutFailures.push(label + ': geometry inspection failed: ' + error.message);
    }
  }

  async function waitForRenderedView(page, view) {
    return wait(page, expected => {
      const streetNode = document.querySelector('#street-label');
      const street = (streetNode?.textContent || '').trim().toLowerCase();
      const streetExpected = expected.street.toLowerCase();
      const handStatus = (document.querySelector('#hand-status-label')?.textContent || '').trim();
      const handNumber = (document.querySelector('#hand-number')?.textContent || '').trim();
      const boardCount = [...document.querySelectorAll('#board-cards .playing-card')]
        .filter(node => !node.classList.contains('placeholder')).length;
      const liveStatusExpected = expected.paused ? 'GAME PAUSED' :
        expected.status === 'playing' ? 'HAND IN PROGRESS' :
        expected.status === 'completed' ? 'TOURNAMENT COMPLETE' :
        expected.status === 'ended' ? 'ENDED BY HOST' : 'TABLE LOBBY';
      const streetRendered = !streetNode || streetNode.hidden || !street ||
        streetExpected === 'preflop' || streetExpected === 'lobby' || street.includes(streetExpected);
      return document.querySelector('#view-table-name')?.textContent === expected.name &&
        handStatus === liveStatusExpected &&
        (expected.handNo <= 0 || handNumber.includes(String(expected.handNo))) &&
        streetRendered && boardCount === expected.boardLength;
    }, {
      name:view.name,
      street:String(view.street || ''),
      status:String(view.status || 'lobby'),
      paused:Boolean(view.paused),
      handNo:Number(view.hand_no || 0),
      boardLength:(view.board || []).length,
    });
  }

  const stamp = Date.now().toString(36);
  const admin = await request('/login', null, {username:'admin', password:'test-admin-password'});
  async function setGlobalConfig(values) {
    return request('/admin/config', admin, values);
  }
  await setGlobalConfig({
    runout_seconds:1, showdown_seconds:3,
    blind_announcement_seconds:0, elimination_announcement_seconds:0,
    bet_presets:{preflop_bb:[2.5,3,4],postflop_percent:[50,60,75,90,100]},
  });
  const host = await register('Host', stamp);
  const guest = await register('Guest', stamp);
  const folded = await register('Folded', stamp);
  await Promise.all([signIn(one, host), signIn(two, guest)]);
  await Promise.all([one.resize(1280, 900), two.resize(390, 844)]);
  const users = [host, guest, folded];
  const pageFor = account => account === host ? one : account === guest ? two : null;
  async function getView(path, account = host) { return request(path, account); }
  async function createTable(label, config) {
    const name = tableName(label, stamp);
    const created = await request('/tables', host, {name, ...config});
    const path = '/tables/' + created.id;
    return {name, path, id:created.id, config:created.config};
  }
  async function seat(path, account, seatNo) {
    await request(path + '/seat', account, {seat_no:seatNo});
  }
  async function start(path) { return request(path + '/start', host, {}); }
  async function act(path, account, action) {
    const current = await getView(path, account);
    assert(current.actor_id === account.player.id,
      'Action seat mismatch: actor=' + current.actor_id + ' user=' + account.player.id);
    return request(path + '/action', account, {
      action,
      expected_hand:current.hand_no,
      expected_turn_version:current.turn_version,
    });
  }

  async function playCheckCallToShowdown(path, accounts) {
    let last = await getView(path, accounts[0]);
    for (let count = 0; count < 24; count++) {
      if (last.street === 'showdown') return last;
      if (!last.actor_id) {
        await sleep(100);
        last = await getView(path, accounts[0]);
        continue;
      }
      const actor = accounts.find(user => user.player.id === last.actor_id);
      assert(actor, 'Unexpected actor while checking through streets: ' + last.actor_id);
      const actorView = await getView(path, actor);
      const action = Number(actorView.viewer?.to_call || 0) > 0 ? 'call' : 'check';
      await act(path, actor, action);
      await sleep(80);
      last = await getView(path, accounts[0]);
    }
    throw Error('Check/call hand did not reach showdown: ' + JSON.stringify({
      street:last.street, actor:last.actor_id, hand:last.hand_no, board:last.board,
    }));
  }
  async function waitFor(page, predicate, description, timeout = 12000) {
    const limit = Math.ceil(timeout / 100);
    for (let attempt = 0; attempt < limit; attempt++) {
      const value = await evaluate(page, predicate);
      if (value) return value;
      await sleep(100);
    }
    throw Error('Timed out waiting for ' + description + ': ' +
      await evaluate(page, () => document.body.innerText.slice(-1400)));
  }
  async function assertPrivacy(path, accounts, expectedExposed) {
    for (const account of accounts) {
      const view = await getView(path, account);
      const hiddenOpponents = view.seats.filter(seat =>
        seat.id !== account.player.id && seat.in_hand && !seat.folded &&
        !expectedExposed.includes(seat.id));
      assert(hiddenOpponents.every(seat => seat.cards === undefined),
        'A hidden opponent card leaked before public exposure: ' + JSON.stringify(hiddenOpponents));
    }
  }
  async function assertPublicFaceCards(page, view, label) {
    const expectedIds=(view.showdown || []).map(row=>row.player_id).filter(Boolean);
    const rows=await evaluate(page, ids => {
      const viewerId=document.querySelector('#seat-grid .seat-card.is-me')?.dataset.playerId || '';
      return ids.map(id => {
        const seat=[...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')]
          .find(node=>node.dataset.playerId===id);
        const row=seat?.querySelector('.seat-cards');
        const cards=[...(row?.querySelectorAll('.mini-card') || [])];
        const visible=element=>Boolean(element && getComputedStyle(element).display!=='none' &&
          getComputedStyle(element).visibility!=='hidden' && element.getBoundingClientRect().width>0 &&
          element.getBoundingClientRect().height>0);
        return {id,seatFound:Boolean(seat),rowFound:Boolean(row),rowVisible:visible(row),
          correctClass:id===viewerId ? Boolean(row?.classList.contains('is-viewer-cards')) :
            Boolean(row?.classList.contains('is-exposed')),
          cardCount:cards.length,visibleCards:cards.filter(visible).length,
          backs:cards.filter(card=>card.classList.contains('back')).length};
      });
    }, expectedIds);
    assert(expectedIds.length>0 && rows.length===expectedIds.length &&
      rows.every(row=>row.seatFound && row.rowFound && row.rowVisible && row.correctClass &&
        row.cardCount===2 && row.visibleCards===2 && row.backs===0),
    label + ' did not keep every public face-up hand visible: ' + JSON.stringify(rows));
  }

  // Normal check/call hand: verify actual Enter chat, polling/reconnect, ranks, and replay.
  const normalConfig = {
    starting_stack:1000, small_blind:5, big_blind:10,
    level_minutes:79, turn_seconds:3600,
    buy_in:10, payout_percentages:[60,40],
  };
  const normal = await createTable('normal', normalConfig);
  await seat(normal.path, guest, 1);
  await Promise.all([openTable(one, normal.name), openTable(two, normal.name)]);
  const normalStarted = await start(normal.path);
  assert(normal.config?.showdown_seconds === 3 && normal.config.runout_seconds === 1,
    'New table did not inherit the shared admin timing config: ' + JSON.stringify(normal.config));
  assert(normalStarted.config?.max_seats === 2 &&
    normalStarted.seats.map(seat => seat.seat_no).join(',') === '0,1',
    'Starting a two-player table did not lock capacity and compact seat numbers: ' +
      JSON.stringify({max_seats:normalStarted.config?.max_seats,seats:normalStarted.seats}));
  const firstNormalActor = [host,guest].find(user => user.player.id === normalStarted.actor_id);
  await wait(pageFor(firstNormalActor), visible, '#action-panel:not([hidden]) #action-controls [data-poker-action]:not([disabled])');
  const liveStart = await getView(normal.path, host);
  await assertPrivacy(normal.path, [host,guest], []);
  await Promise.all([waitForRenderedView(one, liveStart), waitForRenderedView(two, liveStart)]);
  await recordGeometry(one, 'normal preflop / turn clock desktop');
  await recordGeometry(two, 'normal preflop / turn clock mobile');

  // An actual trusted CDP wheel over felt changes only the legal draft.
  const normalActor = [host,guest].find(user => user.player.id === liveStart.actor_id);
  const normalActorPage = pageFor(normalActor);
  const otherNormalPage = normalActorPage === one ? two : one;
  await wait(normalActorPage, visible, '#action-panel:not([hidden]) #raise-amount:enabled');
  const initialDraft = await evaluate(normalActorPage, () => {
    const input = document.querySelector('#raise-amount');
    window.presentationActionPosts = 0;
    const original = window.fetch.bind(window);
    window.fetch = function(url, options) {
      if (String(url).includes('/poker/api/tables/') && /\/action(?:\?|$)/.test(String(url)) &&
          String(options?.method || 'GET').toUpperCase() === 'POST') {
        window.presentationActionPosts += 1;
      }
      return original(url, options);
    };
    input.value = input.min;
    input.dispatchEvent(new Event('input', {bubbles:true}));
    input.blur();
    const r = document.querySelector('#felt').getBoundingClientRect();
    return {
      value:Number(input.value), min:Number(input.min), max:Number(input.max),
      point:{x:r.left+r.width*.5,y:r.top+r.height*.42},
      focused:document.activeElement === input,
    };
  });
  assert(initialDraft.max > initialDraft.min && !initialDraft.focused,
    'The wheel test has no legal raise range or the input is focused: ' + JSON.stringify(initialDraft));
  await normalActorPage.wheelAt(initialDraft.point.x, initialDraft.point.y, -120);
  const wheelDraft = await evaluate(normalActorPage, () => ({
    value:Number(document.querySelector('#raise-amount').value),
    min:Number(document.querySelector('#raise-amount').min),
    max:Number(document.querySelector('#raise-amount').max),
    focused:document.activeElement === document.querySelector('#raise-amount'),
    posts:window.presentationActionPosts,
  }));
  assert(wheelDraft.value > initialDraft.value && wheelDraft.value >= wheelDraft.min &&
    wheelDraft.value <= wheelDraft.max && !wheelDraft.focused && wheelDraft.posts === 0,
  'Trusted wheel over felt did not change the legal draft without focus or action: ' +
    JSON.stringify({initialDraft,wheelDraft}));
  await normalActorPage.wheelAt(initialDraft.point.x, initialDraft.point.y, -120, 2);
  const ctrlWheelDraft = await evaluate(normalActorPage, () => ({
    value:Number(document.querySelector('#raise-amount').value),
    posts:window.presentationActionPosts,
  }));
  assert(ctrlWheelDraft.value === wheelDraft.value && ctrlWheelDraft.posts === 0,
    'Ctrl+wheel over felt must keep its browser zoom behavior and leave the raise draft unchanged: ' +
      JSON.stringify({wheelDraft,ctrlWheelDraft}));
  await click(normalActorPage, '#chat-button');
  await wait(normalActorPage, visible, '#chat-panel:not([hidden]) #chat-input');
  const chatPoint = await evaluate(normalActorPage, () => {
    const r=document.querySelector('#chat-input').getBoundingClientRect();
    return {x:r.left+r.width*.5,y:r.top+r.height*.5};
  });
  await normalActorPage.wheelAt(chatPoint.x, chatPoint.y, -120);
  const fullChatWheelDraft = await evaluate(normalActorPage, () => ({
    value:Number(document.querySelector('#raise-amount').value),
    posts:window.presentationActionPosts,
  }));
  assert(fullChatWheelDraft.value === wheelDraft.value && fullChatWheelDraft.posts === 0,
    'Wheel over full chat must leave the betting draft and action stream unchanged.');
  await normalActorPage.pressEscape();
  await wait(normalActorPage, () => document.querySelector('#chat-panel')?.hidden === true,
    'Escape closes full chat');
  await recordGeometry(normalActorPage, 'trusted felt wheel / legal bet draft');

  await click(normalActorPage, '#chat-button');
  await wait(normalActorPage, visible, '#chat-panel:not([hidden]) #chat-input');
  const chatMessage = 'drawer-enter-' + stamp;
  await request(normal.path + '/chat', host, {text:'drawer-first-' + stamp});
  await request(normal.path + '/chat', guest, {text:'drawer-second-' + stamp});
  await request(normal.path + '/chat', folded, {text:'drawer-latest-' + stamp});
  await wait(normalActorPage, text =>
    document.querySelector('#chat-messages')?.textContent.includes(text),
  'drawer-latest-' + stamp);
  const collapsedChat = await evaluate(normalActorPage, () => {
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
  assert(collapsedChat.inlineChatAbsent && collapsedChat.chatButtonInMenu &&
    collapsedChat.panelVisible && collapsedChat.latest.includes('drawer-latest-' + stamp),
  'Menu-only chat must keep the full drawer and latest message without an inline preview/composer: ' +
    JSON.stringify(collapsedChat));
  await evaluate(normalActorPage, text => {
    window.presentationEnter = {keys:0, submits:0, posts:[], response:null};
    const field = document.querySelector('#chat-input');
    field.value = text;
    field.dispatchEvent(new Event('input', {bubbles:true}));
    field.focus({preventScroll:true});
    field.addEventListener('keydown', event => {
      if (event.key === 'Enter') window.presentationEnter.keys++;
    });
    document.querySelector('#chat-form').addEventListener('submit', () => {
      window.presentationEnter.submits++;
    });
    const original = window.fetch.bind(window);
    window.fetch = async function(url, options) {
      const isPost = String(url).includes('/poker/api/tables/') &&
        /\/chat(?:\?|$)/.test(String(url)) &&
        String(options?.method || 'GET').toUpperCase() === 'POST';
      if (!isPost) return original(url, options);
      window.presentationEnter.posts.push({body:options?.body || ''});
      const response = await original(url, options);
      window.presentationEnter.response = {status:response.status,ok:response.ok};
      return response;
    };
  }, chatMessage);
  await normalActorPage.pressEnter();
  await wait(normalActorPage, text =>
    document.querySelector('#chat-messages')?.textContent.includes(text) &&
      document.querySelector('#chat-input')?.value === '',
  chatMessage);
  const enterResult = await evaluate(normalActorPage, () => ({...window.presentationEnter}));
  assert(enterResult.keys === 1 && enterResult.submits === 1 &&
    enterResult.posts.length === 1 && enterResult.posts[0].body.includes(chatMessage) &&
    enterResult.response?.ok,
  'Enter in the chat drawer must post once and clear the sent draft: ' + JSON.stringify(enterResult));
  const guardedEnter = await evaluate(normalActorPage, () => {
    const input = document.querySelector('#chat-input');
    const form = document.querySelector('#chat-form');
    const before = {
      posts:window.presentationEnter.posts.length,
      submits:window.presentationEnter.submits,
      value:input.value,
    };
    const cases = [
      ['shift', {shiftKey:true}],
      ['control', {ctrlKey:true}],
      ['meta', {metaKey:true}],
      ['alt', {altKey:true}],
      ['composition', {isComposing:true}],
      ['ime-229', {keyCode:229}],
    ];
    const results = cases.map(([name, modifiers]) => {
      const event = new KeyboardEvent('keydown', {
        key:'Enter', bubbles:true, cancelable:true, ...modifiers,
      });
      if (name === 'ime-229' && event.keyCode !== 229) {
        Object.defineProperty(event, 'keyCode', {value:229});
      }
      input.dispatchEvent(event);
      return {name, prevented:event.defaultPrevented};
    });
    return {
      results,
      before,
      after:{
        posts:window.presentationEnter.posts.length,
        submits:window.presentationEnter.submits,
        value:input.value,
        formBusy:form.getAttribute('aria-busy'),
      },
    };
  });
  assert(guardedEnter.results.every(result => !result.prevented) &&
    guardedEnter.after.posts === guardedEnter.before.posts &&
    guardedEnter.after.submits === guardedEnter.before.submits &&
    guardedEnter.after.value === guardedEnter.before.value,
  'Modified Enter, Shift+Enter, and IME Enter must not submit or suppress their native behavior: ' +
    JSON.stringify(guardedEnter));
  const sentMessages = await request(normal.path + '/chat', host);
  assert(sentMessages.messages.filter(item => item.text === chatMessage).length === 1,
    'Chat drawer Enter did not create exactly one message.');
  await normalActorPage.pressEscape();
  await wait(normalActorPage, () => document.querySelector('#chat-panel')?.hidden === true,
    'Escape closes chat drawer');
  await normalActorPage.reload();
  await wait(normalActorPage, visible, '#app-panel');
  await wait(normalActorPage, expected => document.querySelector('#view-table-name')?.textContent === expected,
    normal.name);
  await click(normalActorPage, '#chat-button');
  await wait(normalActorPage, text =>
    document.querySelector('#chat-messages')?.textContent.includes(text),
  'drawer-enter-' + stamp);
  const reconnectedChat = await evaluate(normalActorPage, () => ({
    visible:!document.querySelector('#chat-panel').hidden,
    message:document.querySelector('#chat-messages').textContent,
    inlineChatAbsent:!document.querySelector('#chat-topline,#chat-preview,#chat-quick-form,#chat-quick-input'),
    chatButtonInMenu:document.querySelector('#chat-button')?.closest('#table-menu')===document.querySelector('#table-menu'),
  }));
  assert(reconnectedChat.visible && reconnectedChat.message.includes(chatMessage) &&
    reconnectedChat.inlineChatAbsent && reconnectedChat.chatButtonInMenu,
  'Reconnected chat drawer must restore the message from the menu without an inline composer: ' +
    JSON.stringify(reconnectedChat));
  console.log('Full chat drawer receives shared messages, submits on Enter once, and reconnects without quick-entry clutter.');

  const normalShowdown = await (async () => {
    let view = await getView(normal.path, host);
    for (let count = 0; count < 24 && view.street !== 'showdown'; count++) {
      if (!view.actor_id) {
        await sleep(100);
        view = await getView(normal.path, host);
        continue;
      }
      const actor = [host,guest].find(user => user.player.id === view.actor_id);
      assert(actor, 'Unexpected normal-hand actor: ' + view.actor_id);
      const actorView = await getView(normal.path, actor);
      const action = Number(actorView.viewer?.to_call || 0) > 0 ? 'call' : 'check';
      await act(normal.path, actor, action);
      await sleep(100);
      view = await getView(normal.path, host);
      await Promise.all([waitForRenderedView(one, view), waitForRenderedView(two, view)]);
      await recordGeometry(one, 'normal ' + view.street + ' desktop');
      await recordGeometry(two, 'normal ' + view.street + ' mobile');
    }
    return view;
  })();
  assert(normalShowdown.street === 'showdown' && normalShowdown.board.length === 5,
    'The normal check/call hand did not reach a five-card showdown: ' +
    JSON.stringify({street:normalShowdown.street,board:normalShowdown.board}));
  const showdownRemaining = Number(normalShowdown.showdown_until) - Number(normalShowdown.server_now);
  assert(showdownRemaining > 0 && Number(normalShowdown.presentation_until) >
    Number(normalShowdown.server_now) && Number(normalShowdown.next_hand_at) >=
    Number(normalShowdown.showdown_until),
  'Normal showdown hold or next-hand gate is not active: ' + JSON.stringify({
    showdown_until:normalShowdown.showdown_until,
    presentation_until:normalShowdown.presentation_until,
    next_hand_at:normalShowdown.next_hand_at,
    server_now:normalShowdown.server_now,
  }));
  assert(normalShowdown.showdown.length === 2 &&
    normalShowdown.showdown.every(row => row.hand_name && row.cards?.length === 2),
  'Every exposed normal hand needs two cards and a named rank: ' +
    JSON.stringify(normalShowdown.showdown));
  assert(normalShowdown.winners.length >= 1 &&
    normalShowdown.winners.every(winner =>
      Number(normalShowdown.pot_winnings[winner.player_id]) === Number(winner.amount) &&
      Boolean(winner.hand_name)),
  'Paid winners must use pot_winnings and expose a hand name: ' +
    JSON.stringify({winners:normalShowdown.winners,pot_winnings:normalShowdown.pot_winnings}));
  await Promise.all([waitForRenderedView(one, normalShowdown), waitForRenderedView(two, normalShowdown)]);
  await recordGeometry(one, 'normal showdown result desktop');
  await recordGeometry(two, 'normal showdown result mobile');
  await assertPublicFaceCards(one, normalShowdown, 'Normal showdown');

  const summary = await waitFor(one, () => {
    const node = document.querySelector('#showdown-summary');
    return node && !node.hidden && node.querySelectorAll('.showdown-rank-line').length === 2;
  }, 'both exposed live showdown ranks');
  const summaryText = await evaluate(one, () =>
    document.querySelector('#showdown-summary')?.innerText || '');
  for (const row of normalShowdown.showdown) {
    assert(summaryText.includes(row.name) && summaryText.includes(row.hand_name) &&
      (!row.rank || summaryText.includes(row.rank)),
      'Live showdown summary omitted an exposed hand rank: ' + row.name + ' / ' +
      row.rank + ' in ' + summaryText);
  }
  for (const winner of normalShowdown.winners) {
    assert(summaryText.includes(winner.name) && summaryText.includes('wins') &&
      summaryText.includes(winner.hand_name) && (!winner.rank || summaryText.includes(winner.rank)),
    'Live showdown summary omitted a winner name, payout, or rank: ' +
      JSON.stringify({winner,summaryText}));
  }
  await one.resize(1280, 900);
  await two.resize(390, 844);
  await wait(one, () => !document.querySelector('#showdown-summary')?.hidden,
    'desktop live result');
  await wait(two, () => !document.querySelector('#showdown-summary')?.hidden,
    'mobile live result');
  await one.screenshot('normal-showdown-desktop');
  await two.screenshot('normal-showdown-mobile');

  const replayResponse = await request(normal.path + '/last-hand', host);
  const replay = replayResponse.hand;
  assert(replay && replay.showdown?.length === normalShowdown.showdown.length &&
    replay.winners?.length === normalShowdown.winners.length,
  'Last-hand replay omitted its public result rows: ' + JSON.stringify(replayResponse));
  for (const row of replay.showdown) {
    assert(row.hand_name && replay.hand_ranks[row.player_id]?.hand_name === row.hand_name &&
      replay.hand_ranks[row.player_id]?.rank === row.rank,
      'Replay is missing the exposed player rank: ' + JSON.stringify(row));
  }
  for (const winner of replay.winners) {
    assert(winner.name && winner.hand_name && winner.rank &&
      Number(replay.pot_winnings[winner.player_id]) === Number(winner.amount),
    'Replay winner must carry name, full rank, and pot winnings: ' + JSON.stringify(winner));
  }
  await click(one, '#last-hand-button');
  await waitFor(one, () => {
    const dialog = document.querySelector('#last-hand-dialog');
    return dialog?.open && dialog.querySelectorAll('.replay-rank-line').length > 0 &&
      dialog.querySelectorAll('.replay-winner-line').length > 0;
  }, 'last-hand replay winner and rank rows');
  const replayText = await evaluate(one, () =>
    document.querySelector('#last-hand-dialog')?.innerText || '');
  for (const row of replay.showdown) {
    assert(replayText.includes(row.name) && replayText.includes(row.hand_name) &&
      replayText.includes(row.rank),
      'Replay UI omitted an exposed name or full rank: ' + JSON.stringify({row,replayText}));
  }
  for (const winner of replay.winners) {
    assert(replayText.includes(winner.name) && replayText.includes(winner.hand_name) &&
      replayText.includes(winner.rank),
      'Replay UI omitted a winner name or full rank: ' + JSON.stringify({winner,replayText}));
  }
  await one.screenshot('normal-last-hand-replay-desktop');
  await recordGeometry(one, 'normal replay desktop');
  await evaluate(one, () => {
    window.presentationModalActionPosts = 0;
    const original = window.fetch.bind(window);
    window.fetch = function(url, options) {
      if (String(url).includes('/poker/api/tables/') && /\/action(?:\?|$)/.test(String(url)) &&
          String(options?.method || 'GET').toUpperCase() === 'POST') {
        window.presentationModalActionPosts++;
      }
      return original(url, options);
    };
  });
  const modalPoint = await evaluate(one, () => {
    const r=document.querySelector('#last-hand-dialog').getBoundingClientRect();
    return {x:r.left+r.width*.5,y:r.top+r.height*.5};
  });
  await one.wheelAt(modalPoint.x, modalPoint.y, -120);
  const modalWheel = await evaluate(one, () => ({
    posts:window.presentationModalActionPosts,
    draft:document.querySelector('#raise-amount')?.value ?? null,
  }));
  assert(modalWheel.posts === 0,
    'Wheel over the replay modal unexpectedly submitted a betting action: ' + JSON.stringify(modalWheel));
  await evaluate(one, () => document.querySelector('#last-hand-close').click());
  await wait(one, () => !document.querySelector('#last-hand-dialog')?.open, 'close replay dialog');
  console.log('Normal check/call showdown, exposed ranks, winner pot payouts, and replay pass.');


  // River all-in: the result must not append another card, and final standings wait for the full presentation.
  const riverConfig = {
    starting_stack:100, small_blind:5, big_blind:10,
    level_minutes:79, turn_seconds:3600,
    buy_in:10, payout_percentages:[100],
  };
  await setGlobalConfig({
    runout_seconds:1, showdown_seconds:2.5,
    blind_announcement_seconds:0, elimination_announcement_seconds:1.5,
  });
  const riverTable = await createTable('river-all-in', riverConfig);
  await seat(riverTable.path, guest, 1);
  await Promise.all([openTable(one, riverTable.name), openTable(two, riverTable.name)]);
  await start(riverTable.path);
  async function reachRiver(path) {
    let view = await getView(path, host);
    for (let count = 0; count < 24 && view.board.length < 5; count++) {
      assert(view.street !== 'showdown' && view.status !== 'completed',
        'River hand ended before five board cards were dealt: ' + JSON.stringify(view));
      if (!view.actor_id) {
        await sleep(80);
        view = await getView(path, host);
        continue;
      }
      const actor = [host,guest].find(user => user.player.id === view.actor_id);
      assert(actor, 'Unexpected actor while reaching the river: ' + view.actor_id);
      const actorView = await getView(path, actor);
      const action = Number(actorView.viewer?.to_call || 0) > 0 ? 'call' : 'check';
      await act(path, actor, action);
      await sleep(70);
      view = await getView(path, host);
      await Promise.all([waitForRenderedView(one, view), waitForRenderedView(two, view)]);
      await recordGeometry(one, 'river pre-all-in ' + view.street + ' desktop');
      await recordGeometry(two, 'river pre-all-in ' + view.street + ' mobile');
    }
    assert(view.board.length === 5 && view.street === 'river',
      'Could not reach the river for the all-in result: ' + JSON.stringify({
        street:view.street, board:view.board,
      }));
    return view;
  }
  let riverResult = null;
  let riverBoard = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const atRiver = await reachRiver(riverTable.path);
    riverBoard = [...atRiver.board];
    const shover = [host,guest].find(user => user.player.id === atRiver.actor_id);
    assert(shover, 'River all-in actor is not a seated player.');
    await act(riverTable.path, shover, 'all_in');
    const afterShove = await getView(riverTable.path, host);
    assert(afterShove.actor_id && afterShove.actor_id !== shover.player.id,
      'River all-in did not pass action to the opponent: ' + JSON.stringify(afterShove));
    const caller = [host,guest].find(user => user.player.id === afterShove.actor_id);
    const callerView = await getView(riverTable.path, caller);
    assert(Number(callerView.viewer?.to_call) > 0,
      'The river all-in must leave a real call decision.');
    await act(riverTable.path, caller, 'call');
    riverResult = await getView(riverTable.path, host);
    assert(riverResult.street === 'showdown' && riverResult.board.length === 5 &&
      JSON.stringify(riverResult.board) === JSON.stringify(riverBoard) &&
      riverResult.runout_at == null,
    'A river all-in call must settle on the existing five-card board: ' + JSON.stringify({
      street:riverResult.street, board:riverResult.board, before:riverBoard,
      runout_at:riverResult.runout_at,
    }));
    assert(Number(riverResult.showdown_until) > Number(riverResult.server_now) &&
      Number(riverResult.presentation_until) > Number(riverResult.server_now),
    'River all-in result did not receive a positive presentation hold: ' +
      JSON.stringify({showdown_until:riverResult.showdown_until,
        presentation_until:riverResult.presentation_until,server_now:riverResult.server_now}));
    assert(riverResult.showdown.length === 2 &&
      riverResult.showdown.every(row => row.hand_name && row.cards?.length === 2) &&
      riverResult.winners.some(row => row.amount > 0 && row.hand_name),
    'River all-in did not expose a clear winner and both player ranks: ' +
      JSON.stringify({showdown:riverResult.showdown,winners:riverResult.winners}));
    await Promise.all([waitForRenderedView(one, riverResult), waitForRenderedView(two, riverResult)]);
    await recordGeometry(one, 'river all-in result desktop');
    await recordGeometry(two, 'river all-in result mobile');
    if (riverResult.street === 'showdown') await assertPublicFaceCards(one, riverResult, 'River all-in showdown');
    if (riverResult.status === 'completed') break;
    const previousHand = Number(riverResult.hand_no);
    let nextView = riverResult;
    for (let waitNo = 0; waitNo < 100 && Number(nextView.hand_no) <= previousHand; waitNo++) {
      await sleep(100);
      nextView = await getView(riverTable.path, host);
    }
    assert(Number(nextView.hand_no) > previousHand,
      'A tied river result did not start its next hand after the presentation gate.');
  }
  assert(riverResult?.status === 'completed',
    'Bounded river all-in retries did not produce final standings.');
  assert(riverResult.next_hand_at == null &&
    Number(riverResult.presentation_until) > Number(riverResult.server_now),
  'Completed river result must retain presentation_until without next_hand_at: ' +
    JSON.stringify({status:riverResult.status,next_hand_at:riverResult.next_hand_at,
      presentation_until:riverResult.presentation_until}));
  const finalWinner = riverResult.winners.find(row => row.amount > 0);
  assert(finalWinner && finalWinner.hand_name,
    'Completed river result lacks a named winner rank.');
  await waitFor(one, () =>
    document.querySelector('#showdown-summary') &&
    !document.querySelector('#showdown-summary').hidden &&
    document.querySelector('#results-panel')?.hidden === true,
  'river result hold before final standings');
  await wait(one, () => document.querySelector('#blind-level-countdown')?.textContent.trim() === 'Final',
    'terminal blind countdown');
  const riverSummary = await evaluate(one, () => document.querySelector('#showdown-summary').innerText);
  assert(riverSummary.includes(finalWinner.name) && riverSummary.includes(finalWinner.hand_name),
    'River all-in result UI omitted the winner or hand rank: ' +
      JSON.stringify({finalWinner,riverSummary}));
  const boundedWinner = await evaluate(one, playerId => {
    const seat=[...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')].find(node => node.dataset.playerId===playerId);
    const result=seat?.querySelector('.seat-result.is-winner');
    const label=result?.querySelector('.seat-result-label'), amount=result?.querySelector('.seat-result-amount');
    const rect=node=>{if(!node)return null;const r=node.getBoundingClientRect();return [r.left,r.top,r.right,r.bottom];};
    const clipped=node=>Boolean(node && (node.scrollWidth>node.clientWidth+1 || node.scrollHeight>node.clientHeight+1));
    return {found:Boolean(result),label:label?.textContent.trim()||'',amount:amount?.textContent.trim()||'',
      aria:result?.getAttribute('aria-label')||'',title:result?.getAttribute('title')||'',
      seat:rect(seat),result:rect(result),labelClipped:clipped(label),amountClipped:clipped(amount)};
  }, finalWinner.player_id);
  const visualMatch=boundedWinner.amount.match(/^\+([\d,.]+)([kKmMbB]?)$/);
  const visualNumber=visualMatch ? Number(visualMatch[1].replace(/,/g,'')) : NaN;
  const visualSuffix=(visualMatch?.[2]||'').toLowerCase();
  const visualMultiplier=visualSuffix==='k' ? 1000 : visualSuffix==='m' ? 1000000 : visualSuffix==='b' ? 1000000000 : 1;
  const visualWinnerAmount=visualNumber*visualMultiplier;
  const visualDigits=(visualMatch?.[1].split('.')[1]||'').length;
  const visualTolerance=visualMultiplier/(2*Math.pow(10,visualDigits)) + 0.5;
  const accessibleWinnerAmount=Number(boundedWinner.aria.replace(/,/g,'').match(/plus\s+([\d.]+)/i)?.[1]);
  const titleWinnerAmount=Number(boundedWinner.title.replace(/,/g,'').match(/\+([\d.]+)\s+chips/i)?.[1]);
  assert(boundedWinner.found && boundedWinner.label==='Won' &&
    Math.abs(visualWinnerAmount-Number(finalWinner.amount))<=visualTolerance &&
    (Number(finalWinner.amount)<1000 || Boolean(visualSuffix)) &&
    boundedWinner.aria.toLowerCase().startsWith('winner ') && boundedWinner.aria.toLowerCase().includes('chips') &&
    accessibleWinnerAmount===Number(finalWinner.amount) && titleWinnerAmount===Number(finalWinner.amount) &&
    !boundedWinner.labelClipped && !boundedWinner.amountClipped &&
    boundedWinner.result[0]>=boundedWinner.seat[0]-1 && boundedWinner.result[2]<=boundedWinner.seat[2]+1,
  'Winner amount is clipped, not compacted, or its exact chip value is missing from title/accessible label: ' +
    JSON.stringify({winner:finalWinner,boundedWinner,visualWinnerAmount,visualTolerance}));
  await sleep(1200);
  const winnerMotionAfterPoll = await evaluate(one, playerId => {
    const result=[...document.querySelectorAll('#seat-grid .seat-result.is-winner')]
      .find(node=>node.dataset.playerId===playerId);
    const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
    return {reduced,active:result?.getAnimations().some(animation => animation.playState==='running' &&
      (animation.effect?.getComputedTiming().progress ?? 1)<1) || false,
      className:String(result?.className||''),delay:result ? getComputedStyle(result).animationDelay : ''};
  }, finalWinner.player_id);
  assert(winnerMotionAfterPoll.reduced || !winnerMotionAfterPoll.active,
    'Winner pulse restarted during later table renders for the same hand: ' + JSON.stringify(winnerMotionAfterPoll));
  await one.screenshot('river-allin-result-desktop');
  await two.screenshot('river-allin-result-mobile');
  await recordGeometry(one, 'river completed result hold desktop');
  await recordGeometry(two, 'river completed result hold mobile');

  let finalStandings = await getView(riverTable.path, host);
  for (let tick = 0; tick < 80 &&
    Number(finalStandings.server_now) < Number(finalStandings.presentation_until); tick++) {
    await sleep(100);
    finalStandings = await getView(riverTable.path, host);
  }
  assert(Number(finalStandings.server_now) >= Number(finalStandings.presentation_until),
    'River presentation deadline did not elapse in the test window.');
  await wait(one, visible, '#results-panel:not([hidden])');
  assert(await evaluate(one, () => document.querySelector('#results-panel')?.hidden === false),
    'Final standings did not appear after presentation_until.');
  console.log('River all-in settles without extra cards; completed standings stay gated through presentation_until.');

  // Three-player runout fixture: blind clock is due while the called all-in runs out.
  const queueConfig = {
    starting_stack:100, small_blind:5, big_blind:10,
    level_minutes:0.1, turn_seconds:3600,
    buy_in:10, payout_percentages:[60,25,15],
  };
  await setGlobalConfig({
    runout_seconds:2, showdown_seconds:2,
    blind_announcement_seconds:2, elimination_announcement_seconds:2,
  });
  let queueTable = null;
  let queueResult = null;
  let queueFoldedPlayer = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    queueTable = await createTable('queued-phases-' + attempt, queueConfig);
    await seat(queueTable.path, guest, 1);
    await seat(queueTable.path, folded, 2);
    await Promise.all([openTable(one, queueTable.name), openTable(two, queueTable.name)]);
    assert(Number(queueTable.config?.level_minutes) === queueConfig.level_minutes,
      'The short blind-level value did not persist in the queue fixture: ' +
        JSON.stringify(queueTable.config));
    const started = await start(queueTable.path);
    const first = users.find(user => user.player.id === started.actor_id);
    assert(first, 'Three-player fixture started with an unknown actor.');
    await act(queueTable.path, first, 'all_in');
    let view = await getView(queueTable.path, host);
    const second = users.find(user => user.player.id === view.actor_id);
    assert(second && second !== first, 'Three-player all-in did not pass action to seat two.');
    const secondView = await getView(queueTable.path, second);
    assert(Number(secondView.viewer?.to_call) > 0,
      'Second player must have a legal fold decision after the first all-in.');
    await act(queueTable.path, second, 'fold');
    queueFoldedPlayer = second;

    view = await getView(queueTable.path, host);
    const caller = users.find(user => user.player.id === view.actor_id);
    assert(caller && caller !== first && caller !== second,
      'The remaining big blind did not receive the all-in call decision: ' +
        JSON.stringify({actor:view.actor_id,first:first.player.id,second:second.player.id}));
    let callerView = await getView(queueTable.path, caller);
    assert(Number(callerView.viewer?.to_call) > 0,
      'The remaining player must have a real call decision.');
    const firstBlindDeadline = Number(callerView.blinds?.next_level_at);
    for (let tick = 0; tick < 150 &&
      Number(callerView.server_now) < firstBlindDeadline + 0.1; tick++) {
      await sleep(100);
      callerView = await getView(queueTable.path, caller);
    }
    assert(callerView.blinds?.pending,
      'Short blind level did not become due while the all-in was still active: ' +
        JSON.stringify(callerView.blinds));
    await act(queueTable.path, caller, 'call');
    let runoutView = await getView(queueTable.path, host);
    assert(runoutView.runout_at && runoutView.runout_odds?.length > 0 &&
      runoutView.blinds?.pending,
    'Called all-in must expose odds while the overdue blind is held for showdown: ' +
      JSON.stringify({street:runoutView.street,runout_at:runoutView.runout_at,
        odds:runoutView.runout_odds?.length,blinds:runoutView.blinds}));
    for (const account of users) {
      const privateView = await getView(queueTable.path, account);
      const foldedSeat = privateView.seats.find(seat => seat.id === second.player.id);
      assert(foldedSeat?.folded && (account === second || foldedSeat.cards === undefined),
        'The folded hand was exposed to another player during all-in odds.');
    }
    await waitFor(one, () =>
      document.querySelectorAll('.seat-equity:not(.is-empty)').length > 0,
    'real all-in odds in the felt view');
    await Promise.all([waitForRenderedView(one, runoutView), waitForRenderedView(two, runoutView)]);
    await recordGeometry(one, 'three-player live runout odds desktop');
    await recordGeometry(two, 'three-player live runout odds mobile');
    await one.screenshot('three-player-runout-odds-desktop');
    await two.screenshot('three-player-runout-odds-mobile');

    for (let tick = 0; tick < 50 && runoutView.street !== 'showdown'; tick++) {
      await sleep(100);
      runoutView = await getView(queueTable.path, host);
    }
    assert(runoutView.street === 'showdown' && runoutView.board.length === 5 &&
      runoutView.showdown.length === 2,
    'The called all-in runout did not reach a two-player five-card showdown: ' +
      JSON.stringify({street:runoutView.street,board:runoutView.board,
        rows:runoutView.showdown?.length}));
    for (const account of users) {
      const publicView = await getView(queueTable.path, account);
      const foldedSeat = publicView.seats.find(seat => seat.id === second.player.id);
      assert(foldedSeat?.folded && (account === second || foldedSeat.cards === undefined),
        'Folded opponent cards leaked after showdown.');
    }
    assert(!runoutView.showdown.some(row => row.player_id === second.player.id) &&
      runoutView.showdown.every(row => row.hand_name && row.cards?.length === 2),
    'Only live all-in hands should be exposed with named ranks: ' +
      JSON.stringify(runoutView.showdown));
    assert(runoutView.winners.some(row => row.amount > 0 && row.hand_name) &&
      Number(runoutView.showdown_until) > Number(runoutView.server_now) &&
      Number(runoutView.presentation_until) > Number(runoutView.showdown_until),
    'All-in showdown result or sequential presentation deadline is missing.');
    await Promise.all([waitForRenderedView(one, runoutView), waitForRenderedView(two, runoutView)]);
    await recordGeometry(one, 'three-player showdown result desktop');
    await recordGeometry(two, 'three-player showdown result mobile');
    await assertPublicFaceCards(one, runoutView, 'Three-player all-in showdown');

    const busted = runoutView.seats.filter(seat => Number(seat.stack) === 0);
    const survivors = runoutView.seats.filter(seat => Number(seat.stack) > 0);
    if (busted.length === 1 && survivors.length === 2) {
      queueResult = runoutView;
      break;
    }
    console.log('Three-player board tie left no bust; retrying an isolated table (' +
      attempt + '/5).');
  }
  assert(queueResult,
    'Five bounded all-in boards did not produce one eliminated player for the queue fixture.');
  assert(queueResult.status === 'playing' && queueResult.hand_no > 0 &&
    Number(queueResult.next_hand_at) >= Number(queueResult.presentation_until),
  'Queued result must hold the same active hand through the final announcement window: ' +
    JSON.stringify({status:queueResult.status,hand_no:queueResult.hand_no,
      next_hand_at:queueResult.next_hand_at,presentation_until:queueResult.presentation_until}));
  assert(queueResult.elimination_announcement == null && queueResult.blind_announcement == null,
    'Future elimination/blind windows must not be exposed as active during the showdown hold.');
  const showdownEnd = Number(queueResult.showdown_until);
  const originalHandNo = Number(queueResult.hand_no);
  await wait(two, () =>
    document.querySelector('#showdown-summary') &&
    !document.querySelector('#showdown-summary').hidden,
  'three-player live showdown result');
  await two.screenshot('three-player-showdown-mobile');
  await Promise.all([waitForRenderedView(one, queueResult), waitForRenderedView(two, queueResult)]);
  await recordGeometry(one, 'queued showdown hold desktop');
  await recordGeometry(two, 'queued showdown hold mobile');

  async function waitForActiveAnnouncement(key, label) {
    for (let tick = 0; tick < 100; tick++) {
      const view = await getView(queueTable.path, host);
      if (view[key] && Number(view[key].until) > Number(view.server_now)) return view;
      await sleep(100);
    }
    throw Error('Timed out waiting for ' + label + ' phase.');
  }
  let eliminationView = await waitForActiveAnnouncement(
    'elimination_announcement', 'elimination announcement',
  );
  const eliminationWindow = eliminationView.elimination_announcement;
  assert(Number(eliminationWindow.starts_at) >= showdownEnd - 0.03 &&
    Number(eliminationWindow.until) - Number(eliminationWindow.starts_at) >= 1.95 &&
    Number(eliminationView.hand_no) === originalHandNo &&
    eliminationView.blind_announcement == null &&
    Number(eliminationView.next_hand_at) >= Number(eliminationWindow.until),
  'Elimination announcement must start after showdown, last its full window, and block the blind/deal: ' +
    JSON.stringify({showdownEnd,eliminationWindow,blind:eliminationView.blind_announcement,
      hand_no:eliminationView.hand_no,next_hand_at:eliminationView.next_hand_at}));
  await wait(one, () =>
    document.querySelector('#announcement-banner') &&
    !document.querySelector('#announcement-banner').hidden &&
    document.querySelector('#blind-announcement')?.hidden === true,
  'elimination banner without overlapping blind notice');
  const eliminationText = await evaluate(one, () =>
    document.querySelector('#announcement-banner')?.innerText || '');
  assert(eliminationText.includes(queueFoldedPlayer.player.name) === false,
    'The player who folded before the showdown should not be announced as eliminated.');
  const eliminatedName = eliminationView.elimination_announcement.players[0]?.name;
  assert(eliminatedName && eliminationText.includes(eliminatedName),
    'Elimination banner omitted the player who lost the all-in: ' +
      JSON.stringify({eliminationText,players:eliminationView.elimination_announcement.players}));
  await one.screenshot('three-player-elimination-banner-desktop');
  await two.screenshot('three-player-elimination-banner-mobile');
  await recordGeometry(one, 'elimination announcement desktop');
  await recordGeometry(two, 'elimination announcement mobile');

  const eliminationSnapshot = {
    starts_at:eliminationWindow.starts_at,
    until:eliminationWindow.until,
    presentation_until:eliminationView.presentation_until,
  };
  await one.reload();
  await wait(one, visible, '#app-panel');
  await wait(one, expected => document.querySelector('#view-table-name')?.textContent === expected,
    queueTable.name);
  await wait(one, () => !document.querySelector('#announcement-banner')?.hidden,
    'reconnected elimination banner');
  const afterEliminationReconnect = await getView(queueTable.path, host);
  assert(afterEliminationReconnect.elimination_announcement?.starts_at === eliminationSnapshot.starts_at &&
    afterEliminationReconnect.elimination_announcement?.until === eliminationSnapshot.until &&
    afterEliminationReconnect.presentation_until === eliminationSnapshot.presentation_until &&
    Number(afterEliminationReconnect.hand_no) === originalHandNo,
  'Reconnect restarted or shortened the active elimination window: ' +
    JSON.stringify({eliminationSnapshot,actual:afterEliminationReconnect.elimination_announcement,
      presentation_until:afterEliminationReconnect.presentation_until,
      hand_no:afterEliminationReconnect.hand_no}));
  await recordGeometry(one, 'elimination reconnect desktop');

  const blindView = await waitForActiveAnnouncement('blind_announcement','blind announcement');
  const blindWindow = blindView.blind_announcement;
  assert(blindView.elimination_announcement == null &&
    Number(blindWindow.starts_at) >= Number(eliminationWindow.until) - 0.03 &&
    Number(blindWindow.until) - Number(blindWindow.starts_at) >= 1.95 &&
    Number(blindView.hand_no) === originalHandNo &&
    Number(blindView.next_hand_at) >= Number(blindWindow.until) &&
    Number(blindView.presentation_until) >= Number(blindWindow.until),
  'Blind announcement must follow elimination without overlap and block the next deal: ' +
    JSON.stringify({eliminationWindow,blindWindow,elim:blindView.elimination_announcement,
      hand_no:blindView.hand_no,next_hand_at:blindView.next_hand_at,
      presentation_until:blindView.presentation_until}));
  await wait(two, () =>
    document.querySelector('#blind-announcement') &&
    !document.querySelector('#blind-announcement').hidden &&
    document.querySelector('#announcement-banner')?.hidden === true,
  'blind banner after elimination banner');
  await one.screenshot('three-player-blind-banner-desktop');
  await two.screenshot('three-player-blind-banner-mobile');
  await recordGeometry(one, 'blind announcement desktop');
  await recordGeometry(two, 'blind announcement mobile');

  const blindSnapshot = {
    starts_at:blindWindow.starts_at,
    until:blindWindow.until,
    presentation_until:blindView.presentation_until,
  };
  await two.reload();
  await wait(two, visible, '#app-panel');
  await wait(two, expected => document.querySelector('#view-table-name')?.textContent === expected,
    queueTable.name);
  await wait(two, () => !document.querySelector('#blind-announcement')?.hidden,
    'reconnected blind banner');
  const afterBlindReconnect = await getView(queueTable.path, guest);
  assert(afterBlindReconnect.blind_announcement?.starts_at === blindSnapshot.starts_at &&
    afterBlindReconnect.blind_announcement?.until === blindSnapshot.until &&
    afterBlindReconnect.presentation_until === blindSnapshot.presentation_until &&
    Number(afterBlindReconnect.hand_no) === originalHandNo &&
    afterBlindReconnect.elimination_announcement == null,
  'Reconnect restarted, overlapped, or changed the active blind window: ' +
    JSON.stringify({blindSnapshot,actual:afterBlindReconnect.blind_announcement,
      presentation_until:afterBlindReconnect.presentation_until,
      hand_no:afterBlindReconnect.hand_no,elimination:afterBlindReconnect.elimination_announcement}));
  await recordGeometry(two, 'blind reconnect mobile');

  let nextSequenceView = afterBlindReconnect;
  for (let tick=0;tick<120 && Number(nextSequenceView.hand_no) === originalHandNo;tick++) {
    await sleep(100);
    nextSequenceView=await getView(queueTable.path,host);
  }
  const activeNextHand = new Set(nextSequenceView.seats
    .filter(seat => seat.in_hand).map(seat => seat.id));
  const positiveStacks = new Set(nextSequenceView.seats
    .filter(seat => Number(seat.stack) > 0).map(seat => seat.id));
  assert(Number(nextSequenceView.hand_no) === originalHandNo + 1 &&
    nextSequenceView.status === 'playing' && nextSequenceView.street === 'preflop' &&
    activeNextHand.size === 2 && [...activeNextHand].every(id => positiveStacks.has(id)),
  'The overdue blind level starved or looped instead of dealing one next hand: ' +
    JSON.stringify({oldHand:originalHandNo,newHand:nextSequenceView.hand_no,
      status:nextSequenceView.status,street:nextSequenceView.street,
      active:[...activeNextHand],positive:[...positiveStacks],blinds:nextSequenceView.blinds}));
  await wait(one, expected => document.querySelector('#hand-number')?.textContent.includes(expected),
    String(originalHandNo + 1));
  await Promise.all([waitForRenderedView(one, nextSequenceView), waitForRenderedView(two, nextSequenceView)]);
  await recordGeometry(one, 'next hand after sequential announcements desktop');
  await recordGeometry(two, 'next hand after sequential announcements mobile');
  await one.screenshot('three-player-next-hand-desktop');
  await two.screenshot('three-player-next-hand-mobile');
  console.log('Showdown then elimination then blind announcements remain sequential, reconnect-stable, and deal only after the final deadline.');
  if (layoutFailures.length) {
    throw Error('Strict felt/card layout checks failed after feature assertions:\n - ' +
      layoutFailures.join('\n - '));
  }
  console.log('Focused result presentation behavior and strict felt/card geometry pass.');
}
