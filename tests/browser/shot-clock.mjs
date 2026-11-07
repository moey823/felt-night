import {seedAvatar} from './avatar-fixture.mjs';

// Deterministic coverage for the final five seconds, pause/resume, inactive actors,
// reduced-motion styling, and the 320px shot-clock lane.
export default async function shotClock([hostPage, guestPage], sleep, roomPassword) {
  const evaluate = (page, fn, ...args) => page.evaluate('(' + fn.toString() + ')(' + JSON.stringify(args).slice(1, -1) + ')');
  const assert = (condition, message) => { if (!condition) throw Error(message); };

  async function wait(page, predicate, ...args) {
    for (let attempt = 0; attempt < 240; attempt++) {
      const value = await evaluate(page, predicate, ...args);
      if (value) return value;
      await sleep(100);
    }
    throw Error('Timed out: ' + predicate + ' ' + args + ' | ' +
      await evaluate(page, () => document.body?.innerText.slice(-1200) || 'document loading'));
  }

  async function input(page, selector, value) {
    await evaluate(page, (query, next) => {
      const node = document.querySelector(query);
      if (!node) throw Error('Missing input ' + query + ' at ' + location.href);
      node.value = String(next);
      node.dispatchEvent(new Event('input', {bubbles:true}));
      node.dispatchEvent(new Event('change', {bubbles:true}));
    }, selector, value);
  }

  async function signIn(page, username, password, path) {
    await evaluate(page, next => { window.__shotClockNavigating=true; window.location.assign(next); }, path);
    await wait(page, next => {
      const target = new URL(next, location.origin);
      const login = document.querySelector('#login-name');
      return !window.__shotClockNavigating && location.pathname === target.pathname &&
        location.search === target.search && document.readyState === 'complete' &&
        document.querySelector('#login-panel')?.hidden === false && Boolean(login?.offsetWidth);
    }, path);
    await input(page, '#login-name', username);
    await input(page, '#login-password', password);
    await input(page, '#room-password', roomPassword);
    await evaluate(page, () => document.querySelector('#login-form').requestSubmit());
    await wait(page, () => document.querySelector('#app-panel')?.hidden === false);
  }

  const origin = await hostPage.evaluate('location.origin');
  const api = origin + '/poker/api';
  async function apiRequest(path, session, body) {
    const headers = {Origin:origin};
    if (session) Object.assign(headers, {
      Cookie:session.cookie,
      'X-SitNgo-Session':session.session_proof,
      'X-SitNgo-CSRF':session.csrf
    });
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(api + path, {
      method:body === undefined ? 'GET' : 'POST',
      headers,
      body:body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) throw Error(path + ' failed: ' + JSON.stringify(data));
    if (path === '/register') {
      const cookie = response.headers.get('set-cookie')?.split(';')[0];
      if (!cookie) throw Error('Registration did not issue a session cookie');
      return {...data,cookie};
    }
    return data.table || data;
  }

  const stamp = Date.now().toString(36);
  const hostName = ('ClockHost' + stamp).slice(0,24);
  const guestName = ('ClockGuest' + stamp).slice(0,24);
  const hostPassword = 'ClockHost_' + stamp + '_Pass';
  const guestPassword = 'ClockGuest_' + stamp + '_Pass';
  const host = await apiRequest('/register', null, {
    room_password:roomPassword,username:hostName,password:hostPassword
  });
  const guest = await apiRequest('/register', null, {
    room_password:roomPassword,username:guestName,password:guestPassword
  });
  await seedAvatar(apiRequest, host, 'fish');
  await seedAvatar(apiRequest, guest, 'whale');

  const table = await apiRequest('/tables', host, {
    name:'Shot clock QA ' + stamp,
    max_seats:9,
    starting_stack:1000,
    small_blind:10,
    big_blind:20,
    level_minutes:5,
    turn_seconds:30,
    buy_in:10,
    payout_percentages:[60,40]
  });
  for (let seatNo=1; seatNo<=7; seatNo += 1) {
    await apiRequest('/tables/' + table.id + '/bots', host, {seat_no:seatNo});
  }
  await apiRequest('/tables/' + table.id + '/seat', guest, {seat_no:8});
  const tablePath = '/poker/table?table=' + encodeURIComponent(table.id);
  await signIn(hostPage, hostName, hostPassword, tablePath);
  await wait(hostPage, () => !document.querySelector('#table-view')?.hidden &&
    document.querySelectorAll('#seat-grid .seat-card').length === 9);

  await evaluate(hostPage, (tableId, actorId) => {
    window.__shotClockFrame = null;
    window.__shotClockAppliedRevision = 0;
    window.__shotClockAppliedFrames = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = async function(input, init) {
      const url = typeof input === 'string' ? input : input.url;
      const method = String((init && init.method) || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
      const response = await originalFetch(input, init);
      const path = new URL(url, location.origin).pathname;
      if (method !== 'GET' || path !== '/poker/api/tables/' + tableId || !response.ok || !window.__shotClockFrame) {
        return response;
      }
      const payload = await response.clone().json();
      const view = payload.table || payload;
      const frame = window.__shotClockFrame;
      const serverNow = Date.now() / 1000 + frame.revision;
      view.status = 'playing';
      view.paused = Boolean(frame.paused);
      view.actor_id = frame.active ? actorId : '';
      view.to_act_id = frame.active ? actorId : '';
      view.hand_no = 1;
      view.hand_id = 'shot-clock-fixture';
      view.turn_version = frame.revision;
      view.version = Math.max(Number(view.version) || 0, 10000 + frame.revision);
      view.server_now = serverNow;
      view.turn_deadline = frame.paused ? serverNow + frame.seconds : frame.startedAt + frame.seconds;
      view.street = 'flop';
      view.board = [
        {rank:'K',suit:'hearts'},
        {rank:'7',suit:'clubs'},
        {rank:'2',suit:'diamonds'}
      ];
      view.pot = 90;
      view.current_bet = 20;
      view.min_raise = 40;
      view.seats = (view.seats || []).map(seat => Object.assign({}, seat, {
        in_hand:true,
        folded:false,
        is_folded:false,
        all_in:false,
        is_all_in:false,
        stack:Math.max(1000, Number(seat.stack) || 0),
        cards:undefined,
        revealed_cards:undefined
      }));
      view.viewer = Object.assign({}, view.viewer, {
        player_id:actorId,
        seated:true,
        can_act:Boolean(frame.active && !frame.paused),
        raise_rights:true,
        hole_cards:[{rank:'A',suit:'spades'},{rank:'Q',suit:'clubs'}]
      });
      view.showdown = [];
      view.winners = [];
      view.runout_odds = [];
      window.__shotClockAppliedRevision = frame.revision;
      window.__shotClockAppliedFrames.push({
        revision:frame.revision,seconds:frame.seconds,paused:Boolean(frame.paused),active:Boolean(frame.active)
      });
      return new Response(JSON.stringify(payload), {
        status:response.status,
        headers:{'Content-Type':'application/json'}
      });
    };
  }, String(table.id), String(host.player.id));

  await hostPage.bringToFront();
  let revision = 0;
  async function applyFrame(seconds, paused, active) {
    revision += 1;
    const frame = {revision,seconds,paused,active,startedAt:Date.now()/1000+revision};
    await evaluate(hostPage, value => {
      window.__shotClockFrame = value;
      document.dispatchEvent(new Event('visibilitychange'));
    }, frame);
    await wait(hostPage, (rev, value, isPaused, hasActor) => {
      if (window.__shotClockAppliedRevision < rev) return false;
      const alert = document.querySelector('#shot-clock-alert');
      if (!hasActor) return Boolean(alert?.hidden);
      return Boolean(alert && !alert.hidden &&
        document.querySelector('#shot-clock-number')?.textContent.trim() === String(value) &&
        alert.dataset.paused === String(isPaused));
    }, revision, seconds, Boolean(paused), Boolean(active));
    return evaluate(hostPage, () => ({
      hidden:document.querySelector('#shot-clock-alert').hidden,
      number:document.querySelector('#shot-clock-number').textContent.trim(),
      copy:document.querySelector('#shot-clock-copy').textContent.trim(),
      label:document.querySelector('#shot-clock-alert').getAttribute('aria-label'),
      paused:document.querySelector('#shot-clock-alert').dataset.paused
    }));
  }

  const displayed = [];
  for (const seconds of [5,4,3,2,1]) {
    const state = await applyFrame(seconds, false, true);
    const expectedCopy = seconds === 1 ? 'SECOND LEFT TO ACT' : 'SECONDS LEFT TO ACT';
    assert(!state.hidden && state.number === String(seconds) && state.copy === expectedCopy &&
      state.label.includes(String(seconds) + (seconds === 1 ? ' second ' : ' seconds ')),
      'Shot-clock display is wrong at ' + seconds + ' seconds: ' + JSON.stringify(state));
    displayed.push(state.number);
  }
  assert(displayed.join(',') === '5,4,3,2,1',
    'Shot-clock snapshots did not display the full final countdown: ' + displayed.join(','));

  const paused = await applyFrame(4, true, true);
  await sleep(1300);
  const frozen = await evaluate(hostPage, () => ({
    number:document.querySelector('#shot-clock-number').textContent.trim(),
    paused:document.querySelector('#shot-clock-alert').dataset.paused,
    animation:getComputedStyle(document.querySelector('#shot-clock-alert')).animationName
  }));
  assert(paused.number === '4' && paused.paused === 'true' && frozen.number === '4' &&
    frozen.paused === 'true' && frozen.animation === 'none',
    'Pausing did not freeze the visible shot clock and stop its animation: ' + JSON.stringify({paused,frozen}));

  await applyFrame(4, false, true);
  await wait(hostPage, () => document.querySelector('#shot-clock-number')?.textContent.trim() === '3' &&
    document.querySelector('#shot-clock-alert')?.dataset.paused === 'false');
  const resumed = await evaluate(hostPage, () => ({
    number:document.querySelector('#shot-clock-number').textContent.trim(),
    paused:document.querySelector('#shot-clock-alert').dataset.paused
  }));
  assert(resumed.number === '3' && resumed.paused === 'false',
    'The shot clock did not resume counting after unpause: ' + JSON.stringify(resumed));

  const noActor = await applyFrame(0, false, false);
  assert(noActor.hidden,
    'The shot-clock alert remained visible without an active actor: ' + JSON.stringify(noActor));

  await applyFrame(5, false, true);
  await hostPage.resize(320,568);
  await wait(hostPage, () => !document.querySelector('#shot-clock-alert')?.hidden);
  const reducedMotion = await evaluate(hostPage, () => ({
    requested:matchMedia('(prefers-reduced-motion: reduce)').matches,
    animation:getComputedStyle(document.querySelector('#shot-clock-alert')).animationName
  }));
  assert(reducedMotion.requested && reducedMotion.animation === 'none',
    'Reduced-motion preference did not disable the shot-clock animation: ' + JSON.stringify(reducedMotion));

  const mobile = await evaluate(hostPage, () => {
    function box(node) {
      if (!node) return null;
      const rect=node.getBoundingClientRect();
      return {left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,
        width:rect.width,height:rect.height};
    }
    function overlap(a,b) {
      return Boolean(a && b && a.left < b.right-1 && a.right > b.left+1 &&
        a.top < b.bottom-1 && a.bottom > b.top+1);
    }
    function contains(outer,inner) {
      return Boolean(outer && inner && inner.left >= outer.left-1 && inner.top >= outer.top-1 &&
        inner.right <= outer.right+1 && inner.bottom <= outer.bottom+1);
    }
    const table=box(document.querySelector('#table-view'));
    const felt=box(document.querySelector('#felt'));
    const alert=box(document.querySelector('#shot-clock-alert'));
    const board=box(document.querySelector('#board-cards'));
    const action=box(document.querySelector('#action-panel'));
    const seats=[...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')].map(box);
    return {
      viewport:{width:innerWidth,height:innerHeight},
      document:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight},
      table,felt,alert,board,action,seats,
      actionVisible:!document.querySelector('#action-panel').hidden,
      heroCards:document.querySelectorAll('#hero-seat .mini-card:not(.back)').length,
      boardCards:document.querySelectorAll('#board-cards .playing-card').length,
      alertInsideTable:contains(table,alert),
      boardInsideFelt:contains(felt,board),
      seatsInsideFelt:seats.every(seat=>contains(felt,seat)),
      actionInsideTable:contains(table,action),
      alertOverlapsBoard:overlap(alert,board),
      alertOverlapsAction:overlap(alert,action),
      alertOverlapsSeat:seats.some(seat=>overlap(alert,seat)),
      boardOverlapsSeat:seats.some(seat=>overlap(board,seat))
    };
  });
  assert(mobile.viewport.width === 320 && mobile.viewport.height === 568 &&
    mobile.document.width <= mobile.viewport.width+1 && mobile.document.height <= mobile.viewport.height+1 &&
    mobile.actionVisible && mobile.heroCards === 2 && mobile.boardCards === 3 &&
    mobile.alertInsideTable && mobile.boardInsideFelt && mobile.seatsInsideFelt && mobile.actionInsideTable &&
    !mobile.alertOverlapsBoard && !mobile.alertOverlapsAction && !mobile.alertOverlapsSeat && !mobile.boardOverlapsSeat,
    'The 320x568 shot-clock layout overflowed or collided with seats, cards, or actions: ' + JSON.stringify(mobile));

  console.log('Shot clock displayed 5, 4, 3, 2, 1; froze and resumed across pause snapshots; hid without an actor; honored reduced motion; and fit the 320x568 table without overflow or overlap.');
}
