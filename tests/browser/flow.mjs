import {openAdminFixture} from './admin-fixture.mjs';
// End-to-end coverage for the focused lobby, shared admin controls, payout sliders and terminal flow.
import {seedAvatar} from './avatar-fixture.mjs';

export default async function flow([hostPage, guestPage], sleep, roomPassword) {
  const evaluate = (page, fn, ...args) =>
    page.evaluate('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')');
  const assert = (condition, message) => { if (!condition) throw Error(message); };

  async function wait(page, predicate, ...args) {
    for (let attempt = 0; attempt < 220; attempt++) {
      const value = await evaluate(page, predicate, ...args);
      if (value) return value;
      await sleep(100);
    }
    throw Error('Timed out: ' + predicate + ' ' + args + ' | ' +
      await evaluate(page, () => document.body.innerText.slice(-1600)));
  }
  async function visible(page, selector) {
    return evaluate(page, query => {
      const node = document.querySelector(query);
      return Boolean(node && node.offsetWidth && !node.hidden);
    }, selector);
  }
  async function click(page, selector) {
    await wait(page, query => {
      const node = document.querySelector(query);
      if (!node || !node.offsetWidth || node.hidden || node.disabled) return false;
      node.click();
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
  async function waitText(page, selector, text) {
    return wait(page, (query, expected) => document.querySelector(query)?.textContent.includes(expected), selector, text);
  }

  const origin = await hostPage.evaluate('location.origin');
  const apiRoot = origin + '/poker/api';
  async function api(path, session, body, method) {
    const headers = {Origin: origin};
    if (session) Object.assign(headers, {
      Cookie: session.cookie,
      'X-SitNgo-Session': session.session_proof,
      'X-SitNgo-CSRF': session.csrf,
    });
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(apiRoot + path, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) throw Error(path + ' ' + response.status + ' ' + JSON.stringify(data));
    if (path === '/register' || path === '/login') {
      const cookie = response.headers.get('set-cookie')?.split(';')[0];
      if (!cookie) throw Error(path + ' did not issue a session cookie');
      return {...data, cookie};
    }
    return data;
  }
  async function register(tag) {
    const stamp = Date.now().toString(36);
    const username = ('Flow' + tag + stamp).slice(0, 24);
    const password = 'FeltFlow_' + stamp + '_' + tag + '_Pass';
    const session = {...await api('/register', null, {username, password, room_password: roomPassword}), username, password};
    await seedAvatar(api, session);
    return session;
  }
  async function signIn(page, user) {
    await wait(page, query => Boolean(document.querySelector(query)?.offsetWidth), '#login-name');
    await input(page, '#login-name', user.username);
    await input(page, '#login-password', user.password);
    await evaluate(page, () => document.querySelector('#login-form').requestSubmit());
    await wait(page, () => Boolean(document.querySelector('#app-panel')?.offsetWidth));
  }
  async function signOut(page) {
    const visibleLogout = await evaluate(page, () => {
      const candidates = ['#table-logout-button', '#logout-button', '#admin-logout-button'];
      return candidates.find(id => {
        const node = document.querySelector(id);
        return node && node.offsetWidth && !node.hidden;
      }) || '';
    });
    if (visibleLogout) await click(page, visibleLogout);
    await wait(page, () => Boolean(document.querySelector('#login-name')?.offsetWidth));
  }
  async function openTable(page, name) {
    const active = await evaluate(page, () => !document.querySelector('#table-view')?.hidden);
    if (active) {
      await click(page, '#close-table-button');
      await wait(page, () => document.querySelector('#table-view')?.hidden === true);
    }
    await wait(page, tableName => {
      const card = [...document.querySelectorAll('[data-open-table]')]
        .find(node => node.textContent.includes(tableName));
      if (!card) return false;
      card.click();
      return true;
    }, name);
    await wait(page, tableName => document.querySelector('#view-table-name')?.textContent === tableName, name);
  }
  async function openSettingsFromMenu(page) {
    const menuOpen = await evaluate(page, () => document.querySelector('#table-menu')?.open === true);
    if (!menuOpen) await click(page, '#table-menu > summary');
    await click(page, '#runtime-settings-button');
    await wait(page, () => document.querySelector('#table-settings-dialog')?.open === true &&
      Boolean(document.querySelector('#save-settings-button')?.offsetWidth));
  }
  async function actualCloseSettings(page, width, height, screenshotName) {
    await page.resize(width, height);
    const info = await evaluate(page, () => {
      const dialog = document.querySelector('#table-settings-dialog');
      const form = document.querySelector('#table-settings-form');
      dialog.scrollTop = dialog.scrollHeight;
      form.scrollTop = form.scrollHeight;
      window.scrollTo(0, document.body.scrollHeight);
      const close = document.querySelector('#settings-dialog-close');
      const rect = close.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      const hit = document.elementFromPoint(x, y);
      return {
        open: dialog.open,
        closeVisible: Boolean(close.offsetWidth && rect.top >= -1 && rect.bottom <= innerHeight + 1),
        hitId: hit?.closest('#settings-dialog-close')?.id || hit?.id || '',
        x, y, viewport: [innerWidth, innerHeight],
      };
    });
    assert(info.open && info.closeVisible && info.hitId === 'settings-dialog-close',
      'Settings Close is not the actual topmost visible target at ' + width + 'x' + height + ': ' + JSON.stringify(info));
    await page.screenshot(screenshotName);
    await page.clickAt(info.x, info.y);
    await wait(page, () => document.querySelector('#table-settings-dialog')?.open === false);
  }

  const host = await register('Host');
  const guest = await register('Guest');
  await Promise.all([signIn(hostPage, host), signIn(guestPage, guest)]);

  await click(hostPage, '#create-game-tab');
  await wait(hostPage, () => document.querySelector('#table-settings-dialog')?.open === true &&
    Boolean(document.querySelector('#settings-table-name')?.offsetWidth));
  const tableName = await evaluate(hostPage, () => document.querySelector('#settings-table-name').value);
  const tableId = await evaluate(hostPage, () =>
    new URLSearchParams(location.search).get('table') ||
    new URLSearchParams(location.hash.slice(1)).get('table'));
  assert(tableId && tableName, 'New game did not open its host setup dialog immediately.');
  assert(await visible(hostPage, '#settings-buy-in') && await visible(hostPage, '#settings-small-blind') &&
    await visible(hostPage, '#settings-big-blind') && await visible(hostPage, '#settings-starting-stack'),
    'Host setup is missing the buy-in, blinds or starting stack.');
  assert(!(await evaluate(hostPage, () => Boolean(document.querySelector('#settings-max-seats')))),
    'The host still has a configurable seat-capacity selector.');

  // Drag a real range input and verify the editor preserves the active DOM node and exact total.
  const beforeDrag = await evaluate(hostPage, () => {
    const node = document.querySelector('#payout-share-0');
    window.flowPayoutNode = node;
    const rect = node.getBoundingClientRect();
    const min = Number(node.min), max = Number(node.max), value = Number(node.value);
    return {
      value,
      min,
      max,
      startX: Math.round(rect.left + 8 + (rect.width - 16) * (value - min) / (max - min)),
      endX: Math.round(rect.left + 8 + (rect.width - 16) * 0.82),
      y: Math.round(rect.top + rect.height / 2),
      visible: Boolean(node.offsetWidth && rect.top >= 0 && rect.bottom <= innerHeight),
    };
  });
  assert(beforeDrag.visible && beforeDrag.max > beforeDrag.min, 'First payout slider is not visible and interactive.');
  await hostPage.screenshot('flow-settings-payouts');
  await hostPage.dragAt(beforeDrag.startX, beforeDrag.y, beforeDrag.endX, beforeDrag.y);
  const afterDrag = await wait(hostPage, initial => {
    const shares = document.querySelector('#settings-payout').value.split(',').map(Number);
    return shares.reduce((sum, value) => sum + value, 0) === 100 && Number(document.querySelector('#payout-share-0').value) !== initial
      ? {shares, sameNode: window.flowPayoutNode === document.querySelector('#payout-share-0'), current: Number(document.querySelector('#payout-share-0').value)}
      : false;
  }, beforeDrag.value);
  assert(afterDrag.sameNode && Math.abs(afterDrag.current - beforeDrag.value) >= 8,
    'Dragging recreated the active range input or barely changed it: ' + JSON.stringify({beforeDrag, afterDrag}));
  assert(afterDrag.shares.reduce((sum, value) => sum + value, 0) === 100,
    'Payout sliders do not total 100 after dragging: ' + JSON.stringify(afterDrag));

  await input(hostPage, '#payout-place-count', 1);
  const onePlace = await evaluate(hostPage, () => ({
    shares: document.querySelector('#settings-payout').value,
    value: document.querySelector('#payout-share-0')?.value,
    disabled: document.querySelector('#payout-share-0')?.disabled,
  }));
  assert(onePlace.shares === '100' && onePlace.value === '100' && onePlace.disabled,
    'One paid place is not locked to 100%: ' + JSON.stringify(onePlace));
  await input(hostPage, '#payout-place-count', 3);
  await click(hostPage, '#save-settings-button');
  await waitText(hostPage, '#settings-lock-note', 'adjust this lobby');
  await actualCloseSettings(hostPage, 320, 568, 'flow-settings-320x568');
  await openSettingsFromMenu(hostPage);
  await actualCloseSettings(hostPage, 844, 390, 'flow-settings-844x390');

  // Admin roles open settings explicitly while preserving their player account.
  await signOut(guestPage);
  await openAdminFixture(guestPage);
  await waitText(guestPage, '#admin-config-status', 'Pacing changes apply');
  await guestPage.screenshot('flow-admin-config');
  await input(guestPage, '#admin-runout-seconds', 3.5);
  await input(guestPage, '#admin-preflop-bb', '2.5, 3, 4.5');
  await input(guestPage, '#admin-postflop-percent', '40, 75, 110');
  await click(guestPage, '#admin-config-save');
  await waitText(guestPage, '#admin-config-status', 'Saved.');
  const adminSession = await api('/login', null, {username: 'admin', password: 'test-admin-password'});
  const savedConfig = await api('/admin/config', adminSession);
  assert(Number(savedConfig.config.runout_seconds) === 3.5 &&
    JSON.stringify(savedConfig.config.bet_presets.preflop_bb) === JSON.stringify([2.5, 3, 4.5]) &&
    JSON.stringify(savedConfig.config.bet_presets.postflop_percent) === JSON.stringify([40, 75, 110]),
    'Admin settings did not persist as shared room configuration: ' + JSON.stringify(savedConfig.config));
  const publicConfig = await api('/config', guest);
  assert(JSON.stringify(publicConfig.config.bet_presets.preflop_bb) === JSON.stringify([2.5, 3, 4.5]),
    'Players do not receive the shared admin bet presets.');

  const detailsOpen = await evaluate(guestPage, () => {
    const details = document.querySelector('#admin-tables-details');
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    return details.open;
  });
  assert(detailsOpen, 'Admin table tools did not open.');
  await wait(guestPage, id => Boolean(document.querySelector('[data-admin-inspect="' + id + '"]')), tableId);
  await guestPage.screenshot('flow-admin-tables');
  await click(guestPage, '[data-admin-inspect="' + tableId + '"]');
  await wait(guestPage, id => Boolean(document.querySelector('[data-admin-table-id="' + id + '"] [data-admin-add-bot="8"]')), tableId);
  await click(guestPage, '[data-admin-table-id="' + tableId + '"] [data-admin-add-bot="8"]');
  await wait(guestPage, id => Boolean(document.querySelector('[data-admin-table-id="' + id + '"] [data-admin-remove-bot="8"]')), tableId);
  await click(guestPage, '[data-admin-table-id="' + tableId + '"] [data-admin-remove-bot="8"]');
  await wait(guestPage, id => Boolean(document.querySelector('[data-admin-table-id="' + id + '"] [data-admin-add-bot="8"]')), tableId);

  // Return to the player account, seat two entrants, normalize 3-place payouts, then confirm end twice.
  await signOut(guestPage);
  await signIn(guestPage, guest);
  await openTable(guestPage, tableName);
  const hostHasSeat = await evaluate(hostPage, () => Boolean(document.querySelector('#seat-grid .seat-card.is-me')));
  if (!hostHasSeat) {
    const hostSeat = await evaluate(hostPage, () => document.querySelector('[data-take-seat]')?.getAttribute('data-take-seat'));
    assert(hostSeat != null, 'Host has no seat and no open seat control.');
    await click(hostPage, '[data-take-seat="' + hostSeat + '"]');
  }
  await wait(guestPage, () => Boolean(document.querySelector('[data-take-seat="1"]')));
  await click(guestPage, '[data-take-seat="1"]');
  await wait(hostPage, () => document.querySelector('#start-button')?.disabled === false);
  const beforeStart = await api('/tables/' + encodeURIComponent(tableId), host);
  assert(beforeStart.table.seats.length === 2, 'The lobby did not keep capacity independent of its two occupied seats.');
  await click(hostPage, '#start-button');
  await wait(hostPage, () => document.querySelector('#view-status')?.textContent === 'In progress');
  const started = await api('/tables/' + encodeURIComponent(tableId), host);
  const finalPayouts = started.table.config.payout_percentages;
  assert(finalPayouts.length === 2 && finalPayouts.reduce((sum, value) => sum + value, 0) === 100,
    'Start did not visibly save a valid two-place payout split: ' + JSON.stringify(finalPayouts));

  await evaluate(hostPage, () => {
    window.flowEndPosts = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = function(url, options) {
      if (String(url).includes('/poker/api/tables/') && /\/end(?:\?|$)/.test(String(url)) &&
          String(options?.method || 'GET').toUpperCase() === 'POST') {
        window.flowEndPosts.push(JSON.parse(options?.body || '{}'));
      }
      return originalFetch(url, options);
    };
  });
  await click(hostPage, '#table-menu > summary');
  await click(hostPage, '#end-game-button');
  await wait(hostPage, () => document.querySelector('#end-game-dialog')?.open === true);
  await click(hostPage, '#end-game-cancel');
  const cancelled = await evaluate(hostPage, () => ({open: document.querySelector('#end-game-dialog').open, posts: window.flowEndPosts.length}));
  assert(!cancelled.open && cancelled.posts === 0, 'Canceling the first end prompt sent a server confirmation.');

  await click(hostPage, '#table-menu > summary');
  await click(hostPage, '#end-game-button');
  await click(hostPage, '#end-game-confirm');
  await sleep(900);
  const firstConfirm = await evaluate(hostPage, () => ({
    posts: window.flowEndPosts.length,
    status: document.querySelector('#view-status')?.textContent,
    dialogOpen: document.querySelector('#end-game-dialog')?.open,
  }));
  const firstStepText = await evaluate(hostPage, () => document.querySelector('#end-game-step')?.textContent || '');
  const firstNoticeText = await evaluate(hostPage, () => document.querySelector('#notice')?.textContent || '');
  assert(firstConfirm.posts === 1 && firstConfirm.status === 'In progress' && firstConfirm.dialogOpen &&
    firstStepText.includes('Confirm once more'),
    'The first end confirmation did not advance to the second prompt: ' + JSON.stringify({...firstConfirm, step: firstStepText, notice: firstNoticeText}));
  await click(hostPage, '#end-game-cancel');
  assert(await evaluate(hostPage, () => window.flowEndPosts.length === 1), 'Canceling the second end prompt posted another confirmation.');

  await click(hostPage, '#table-menu > summary');
  await click(hostPage, '#end-game-button');
  await click(hostPage, '#end-game-confirm');
  await wait(hostPage, () => document.querySelector('#end-game-step')?.textContent.includes('Confirm once more'));
  await hostPage.screenshot('flow-end-confirmation');
  const finalConfirmPoint = await evaluate(hostPage, () => {
    const rect = document.querySelector('#end-game-confirm').getBoundingClientRect();
    return {x:Math.round(rect.left + rect.width / 2), y:Math.round(rect.top + rect.height / 2)};
  });
  await hostPage.clickAt(finalConfirmPoint.x, finalConfirmPoint.y, 2);
  const doubleClickBlocked = await evaluate(hostPage, () => ({
    posts:window.flowEndPosts.length,
    status:document.querySelector('#view-status')?.textContent,
    dialogOpen:document.querySelector('#end-game-dialog')?.open,
    step:document.querySelector('#end-game-step')?.textContent || '',
  }));
  assert(doubleClickBlocked.posts === 2 && doubleClickBlocked.status === 'In progress' &&
    doubleClickBlocked.dialogOpen && doubleClickBlocked.step.includes('Confirm once more'),
    'A trusted clickCount 2 consumed both end confirmations: ' + JSON.stringify(doubleClickBlocked));
  await hostPage.clickAt(finalConfirmPoint.x, finalConfirmPoint.y, 1);
  await wait(hostPage, () => document.querySelector('#view-status')?.textContent === 'Ended by host');
  const ended = await evaluate(hostPage, () => ({
    posts: window.flowEndPosts.length,
    status: document.querySelector('#view-status')?.textContent,
    resultHidden: document.querySelector('#results-panel')?.hidden,
    endedCaption: document.querySelector('#button-caption')?.textContent,
  }));
  assert(ended.posts === 3 && ended.status === 'Ended by host' && ended.resultHidden && ended.endedCaption === 'Ended by host',
    'End game did not leave a terminal public table without fabricated standings: ' + JSON.stringify(ended));

  await evaluate(hostPage, () => {
    sessionStorage.removeItem('flowOpenArgs');
    window.open = function(url, target, features) {
      sessionStorage.setItem('flowOpenArgs', JSON.stringify({url, target, features}));
      return window.__FELT_NIGHT_TEST_OPEN__(url, target, features);
    };
  });

  // A legacy zero-share tail is removed without changing the positive percentages on the next save.
  const zeroName = 'Zero ' + Date.now().toString(36);
  const zeroTable = await api('/tables', host, {
    name: zeroName, buy_in: 10, payout_percentages: [100, 0, 0], starting_stack: 1000,
    small_blind: 10, big_blind: 20, level_minutes: 5, turn_seconds: 30,
  });
  const zeroId = String((zeroTable.table || zeroTable).id);
  await openTable(hostPage, zeroName);
  const popupRequest = await evaluate(hostPage, () => JSON.parse(sessionStorage.getItem('flowOpenArgs') || 'null'));
  assert(popupRequest && popupRequest.target === '_blank' && popupRequest.url.includes('/poker/table?table=') &&
    popupRequest.url.includes(zeroId) && popupRequest.features.includes('popup=yes') && popupRequest.features.includes('resizable=yes'),
    'Opening a lobby card did not request the dedicated table window: ' + JSON.stringify(popupRequest));
  await openSettingsFromMenu(hostPage);
  const zeroUi = await evaluate(hostPage, () => ({
    count: document.querySelector('#payout-place-count').value,
    shares: document.querySelector('#settings-payout').value,
    value: document.querySelector('#payout-share-0')?.value,
  }));
  assert(zeroUi.count === '1' && zeroUi.shares === '100' && zeroUi.value === '100',
    'A valid zero-share tail changed the actual payout vector: ' + JSON.stringify(zeroUi));
  await input(hostPage, '#settings-table-name', zeroName + ' v2');
  await click(hostPage, '#save-settings-button');
  await waitText(hostPage, '#settings-lock-note', 'adjust this lobby');
  const zeroSaved = await api('/tables/' + encodeURIComponent(zeroId), host);
  assert(JSON.stringify(zeroSaved.table.config.payout_percentages) === JSON.stringify([100]),
    'Saving an unrelated setup field changed the valid first-place-only economics: ' + JSON.stringify(zeroSaved.table.config.payout_percentages));

  console.log('New game opens one setup dialog; payouts stay at 100%, admin roles open room settings, mobile close works, and ending requires two confirmations.');
}
