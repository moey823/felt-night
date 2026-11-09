// Focused browser checks for saved text histories and replay navigation.
import {seedAvatar} from './avatar-fixture.mjs';

// Focused browser checks for saved text histories and replay navigation.
export default async function history([one, two], sleep, roomPassword) {
  const evaluate = (page, fn, ...args) =>
    page.evaluate('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')');
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  async function wait(page, predicate, ...args) {
    for (let attempt = 0; attempt < 160; attempt++) {
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
      if (!node || node.disabled || node.hidden) return false;
      const details = node.closest('details');
      if (details && node.tagName !== 'SUMMARY') details.open = true;
      if (!node.offsetWidth) return false;
      node.click();
      return true;
    }, selector);
  }
  async function clickTrusted(page, selector) {
    await page.bringToFront();
    const point = await evaluate(page, query => {
      const node = document.querySelector(query);
      if (!node || !node.offsetWidth || node.hidden || node.disabled) return null;
      const rect = node.getBoundingClientRect();
      return {x:Math.round(rect.left + rect.width / 2), y:Math.round(rect.top + rect.height / 2)};
    }, selector);
    if (!point) throw Error('Cannot click visible control: ' + selector);
    await page.clickAt(point.x, point.y);
  }

  const origin = await one.evaluate('location.origin');
  async function request(path, account, payload) {
    const headers = {Origin:origin};
    if (account) Object.assign(headers, {
      Cookie:account.cookie,
      'X-SitNgo-Session':account.session_proof,
      'X-SitNgo-CSRF':account.csrf,
    });
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(origin + '/poker/api' + path, {
      method:payload === undefined ? 'GET' : 'POST',
      headers,
      body:payload === undefined ? undefined : JSON.stringify(payload),
    });
    let body = {};
    try { body = await response.json(); } catch (_) {}
    if (!response.ok) throw Error(path + ' returned ' + response.status + ': ' + JSON.stringify(body));
    if (path === '/register' || path === '/login') {
      const cookie = response.headers.get('set-cookie')?.split(';')[0];
      if (!cookie) throw Error(path + ' did not issue a session cookie');
      return {...body, cookie};
    }
    return body.table || body;
  }
  async function register(label, stamp) {
    const username = ('Hist' + stamp + label).slice(0, 24);
    const password = 'FeltHist_' + stamp + '_' + label + '_Pass';
    const account = {...await request('/register', null, {
      username, password, room_password:roomPassword,
    }), username, password};
    await seedAvatar(request, account);
    return account;
  }
  async function signIn(page, account) {
    await wait(page, () => Boolean(document.querySelector('#login-name')?.offsetWidth));
    await evaluate(page, (username, password) => {
      document.querySelector('#login-name').value = username;
      document.querySelector('#login-password').value = password;
      document.querySelector('#login-form').requestSubmit();
    }, account.username, account.password);
    await wait(page, () => Boolean(document.querySelector('#app-panel')?.offsetWidth));
  }

  const stamp = Date.now().toString(36);
  const admin = await request('/login', null, {username:'admin', password:'test-admin-password'});
  await request('/admin/config', admin, {
    runout_seconds:1, showdown_seconds:30,
    blind_announcement_seconds:0, elimination_announcement_seconds:0,
  });
  const host = await register('Host', stamp);
  const guest = await register('Guest', stamp);
  await Promise.all([signIn(one, host), signIn(two, guest)]);

  const name = 'History smoke ' + stamp;
  const created = await request('/tables', host, {
    name, max_seats:2, starting_stack:500,
    small_blind:5, big_blind:10, level_minutes:60, turn_seconds:3600,
    buy_in:10, payout_percentages:[100],
  });
  const tableId = created.id;
  const path = '/tables/' + tableId;
  await request(path + '/seat', guest, {seat_no:1});
  await request(path + '/start', host, {});
  await wait(one, id => {
    if (document.querySelector('#view-table-name')?.textContent === name) return true;
    const button = document.querySelector('[data-open-table="' + id + '"]');
    if (!button) return false;
    button.click();
    return true;
  }, tableId);

  let showdown = null;
  for (let turn = 0; turn < 30; turn++) {
    const view = await request(path, host);
    if (view.street === 'showdown') { showdown = view; break; }
    if (!view.actor_id) { await sleep(100); continue; }
    const actor = [host, guest].find(account => account.player.id === view.actor_id);
    assert(actor, 'Unexpected player acting in the disposable history hand.');
    const actorView = await request(path, actor);
    await request(path + '/action', actor, {
      action:Number(actorView.viewer?.to_call || 0) > 0 ? 'call' : 'check',
      expected_hand:actorView.hand_no,
      expected_turn_version:actorView.turn_version,
    });
  }
  assert(showdown, 'The disposable hand did not complete for history review.');

  await click(one, '#lobby-history-button');
  await wait(one, id => Boolean(document.querySelector('#history-dialog')?.open &&
    document.querySelector('[data-history-table="' + id + '"]')), tableId);
  await click(one, '[data-history-table="' + tableId + '"]');
  await wait(one, () => Boolean(document.querySelector('#history-content .history-text-panel') &&
    document.querySelector('#history-content .history-text')));
  await evaluate(one, () => {
    document.querySelector('#history-content .history-text-panel').open = true;
    document.querySelector('#history-content .history-entry').open = true;
  });
  const savedText = await evaluate(one, () => document.querySelector('#history-content')?.innerText || '');
  assert(savedText.includes('Felt Night Tournament Summary') &&
    savedText.includes('Buy-in: $10') && savedText.includes('Prize pool: $20') &&
    savedText.includes('Felt Night Hand #1') && savedText.includes('Blind level 1 (5/10)'),
  'Player history omitted saved tournament facts or hand transcript: ' + savedText);
  await evaluate(one, () => document.querySelector('#history-close').click());
  await wait(one, () => !document.querySelector('#history-dialog')?.open);

  await wait(one, id => {
    const button = document.querySelector('[data-open-table="' + id + '"]');
    return Boolean(button && button.offsetWidth && !button.hidden);
  }, tableId);
  await clickTrusted(one, '[data-open-table="' + tableId + '"]');
  await wait(one, id => location.pathname === '/poker/table' &&
    new URLSearchParams(location.search).get('table') === id, tableId);
  await click(one, '#table-menu > summary');
  await wait(one, () => Boolean(document.querySelector('#last-hand-button')?.offsetWidth &&
    !document.querySelector('#last-hand-button').hidden));

  await evaluate(one, () => {
    window.historyTestOriginalFetch = window.fetch;
    const originalFetch = window.fetch.bind(window);
    window.historyTestFetchUrls = [];
    window.fetch = async function(input, init) {
      const url = String(input);
      if (!url.includes('/poker/api/tables/') || !url.includes('/last-hand')) {
        return originalFetch(input, init);
      }
      const response = await originalFetch(input, init);
      const body = await response.json();
      const requested = new URL(url, location.href).searchParams.get('number');
      if (!requested && body.hand) window.historyTestCachedHand = structuredClone(body.hand);
      if (requested === '2' && !body.hand && window.historyTestCachedHand) {
        body.hand = structuredClone(window.historyTestCachedHand);
      }
      if (body.hand) {
        const number = requested ? Number(requested) : 2;
        body.hand.number = number;
        body.hand.history_count = 2;
        body.hand.previous_hand_number = number > 1 ? 1 : null;
        body.hand.next_hand_number = number < 2 ? 2 : null;
        body.hand.history_text = String(body.hand.history_text || '').replace(/Hand #1/g, 'Hand #' + number);
      }
      window.historyTestFetchUrls.push(url);
      return new Response(JSON.stringify(body), {
        status:response.status, headers:{'Content-Type':'application/json'},
      });
    };
  });
  await click(one, '#last-hand-button');
  await wait(one, () => document.querySelector('#last-hand-dialog')?.open &&
    document.querySelector('#last-hand-history-position')?.textContent === 'Hand 2 · 2 saved hands');
  const current = await evaluate(one, () => {
    const transcript = document.querySelector('#last-hand-content .replay-transcript');
    if (transcript) transcript.open = true;
    return {
      transcript:document.querySelector('#last-hand-content')?.innerText || '',
      olderDisabled:document.querySelector('#last-hand-older')?.disabled,
      nextStreetDisabled:document.querySelector('#last-hand-next')?.disabled,
    };
  });
  assert(current.transcript.includes('Felt Night Hand #2') && current.olderDisabled === false &&
    current.nextStreetDisabled === true,
  'Latest replay did not show text, an earlier hand, and street steps: ' + JSON.stringify(current));
  await click(one, '#last-hand-prev');
  await wait(one, () => document.querySelector('#last-hand-street')?.textContent.includes('River'));
  await click(one, '#last-hand-next');
  await wait(one, () => document.querySelector('#last-hand-street')?.textContent.includes('Showdown'));
  await click(one, '#last-hand-older');
  await wait(one, () => document.querySelector('#last-hand-history-position')?.textContent === 'Hand 1 · 2 saved hands');
  const older = await evaluate(one, () => {
    const transcript = document.querySelector('#last-hand-content .replay-transcript');
    if (transcript) transcript.open = true;
    return {
      olderDisabled:document.querySelector('#last-hand-older')?.disabled,
      newerDisabled:document.querySelector('#last-hand-newer')?.disabled,
      url:window.historyTestFetchUrls?.at(-1) || '',
      text:document.querySelector('#last-hand-content')?.innerText || '',
    };
  });
  assert(older.olderDisabled === true && older.newerDisabled === false &&
    older.url.endsWith('?number=1') && older.text.includes('Felt Night Hand #1'),
  'Previous hand did not load the older saved hand: ' + JSON.stringify(older));
  await click(one, '#last-hand-newer');
  await wait(one, () => document.querySelector('#last-hand-history-position')?.textContent === 'Hand 2 · 2 saved hands');
  const newer = await evaluate(one, () => {
    const transcript = document.querySelector('#last-hand-content .replay-transcript');
    if (transcript) transcript.open = true;
    return {
      url:window.historyTestFetchUrls?.at(-1) || '',
      text:document.querySelector('#last-hand-content')?.innerText || '',
    };
  });
  assert(newer.url.endsWith('?number=2') && newer.text.includes('Felt Night Hand #2'),
    'Next hand did not return to the newer saved hand: ' + JSON.stringify(newer));
  await evaluate(one, () => {
    document.querySelector('#last-hand-close').click();
    window.fetch = window.historyTestOriginalFetch;
    delete window.historyTestOriginalFetch;
  });
  console.log('Saved tournament and hand text, street stepping, and previous/newer replay navigation pass.');
}
