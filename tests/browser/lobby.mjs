// Focused coverage for lobby filtering, real table windows, popup recovery, and direct routes.
export default async function lobby([hostPage, loginPage], sleep, roomPassword) {
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
      await evaluate(page, () => document.body.innerText.slice(-1000)));
  }
  async function click(page, selector) {
    await wait(page, query => {
      const node = document.querySelector(query);
      if (!node || !node.offsetWidth || node.hidden || node.disabled) return false;
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
  async function input(page, selector, value) {
    await evaluate(page, (query, next) => {
      const node = document.querySelector(query);
      if (!node) throw Error('Missing input ' + query);
      node.value = String(next);
      for (const type of ['input', 'change']) node.dispatchEvent(new Event(type, {bubbles:true}));
    }, selector, value);
  }

  const stamp = Date.now().toString(36);
  const username = ('Lobby' + stamp).slice(0, 24);
  const password = 'FeltLobby_' + stamp + '_Pass';
  await wait(hostPage, selector => Boolean(document.querySelector(selector)?.offsetWidth), '#auth-switch');
  await click(hostPage, '#auth-switch');
  await input(hostPage, '#login-name', username);
  await input(hostPage, '#login-password', password);
  await input(hostPage, '#room-password', roomPassword);
  await evaluate(hostPage, () => document.querySelector('#login-form').requestSubmit());
  await wait(hostPage, () => document.querySelector('#app-panel')?.hidden === false &&
    location.pathname === '/poker/lobby');

  const initialLobby = await evaluate(hostPage, () => ({
    lobby: document.body.classList.contains('lobby-route'),
    tableHidden: document.querySelector('#table-view').hidden,
    workspace: getComputedStyle(document.querySelector('.workspace')).display,
    emptyState: Boolean(document.querySelector('#empty-state')),
    create: Boolean(document.querySelector('#create-game-tab')?.offsetWidth),
  }));
  assert(initialLobby.lobby && initialLobby.tableHidden && initialLobby.workspace === 'none' &&
    !initialLobby.emptyState && initialLobby.create,
    'The signed-in player did not enter a lobby-only view: ' + JSON.stringify(initialLobby));

  await evaluate(hostPage, () => {
    const originalFetch = window.fetch.bind(window);
    window.completedFixtureSeen = false;
    window.fetch = async function(input, init) {
      const response = await originalFetch(input, init);
      const url = typeof input === 'string' ? input : input.url;
      const method = String((init && init.method) || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
      if (url === '/poker/api/tables' && method === 'GET' && response.ok) {
        const payload = await response.clone().json();
        payload.tables.push(
          {id:'e'.repeat(32), status:'playing', name:'In-progress fixture', host_name:'Test', max_seats:2, seated_count:1, small_blind:10, big_blind:20},
          {id:'f'.repeat(32), status:'completed', name:'Completed fixture must stay hidden', host_name:'Test', max_seats:2, seated_count:2, small_blind:10, big_blind:20}
        );
        window.completedFixtureSeen = true;
        return new Response(JSON.stringify(payload), {status:response.status, headers:{'Content-Type':'application/json'}});
      }
      return response;
    };
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await wait(hostPage, () => window.completedFixtureSeen === true);
  const filteredList = await evaluate(hostPage, () => ({
    statuses: [...document.querySelectorAll('[data-open-table]')].map(node => node.dataset.tableStatus),
    completedCount: [...document.querySelectorAll('[data-open-table]')].filter(node =>
      node.textContent.includes('Completed fixture must stay hidden')).length,
  }));
  assert(filteredList.statuses.includes('playing') && !filteredList.statuses.includes('completed') &&
    filteredList.completedCount === 0,
    'The lobby showed a completed game or hid an in-progress game: ' + JSON.stringify(filteredList));

  await clickTrusted(hostPage, '#create-game-tab');
  const setupPage = await hostPage.waitForPopup();
  await wait(setupPage, () => location.pathname === '/poker/table' &&
    document.querySelector('#table-settings-dialog')?.open === true);
  const setupRoute = await evaluate(setupPage, () => ({
    table: new URLSearchParams(location.search).get('table'),
    setupCleared: !new URLSearchParams(location.search).has('setup'),
    tableVisible: !document.querySelector('#table-view').hidden,
    mode: document.body.classList.contains('table-route'),
    player: document.querySelector('#welcome-name')?.textContent || '',
    sessionProof: JSON.parse(localStorage.getItem('sitngo.poker.session-proof.v1') || '{}').session_proof || '',
  }));
  const setupCookies = await setupPage.cookies(new URL('/poker/api/me', await hostPage.evaluate('location.origin')).toString());
  assert(setupRoute.table && setupRoute.setupCleared && setupRoute.tableVisible && setupRoute.mode &&
    setupRoute.player === username && setupRoute.sessionProof &&
    setupCookies.some(cookie => cookie.name === 'sitngo_session' && cookie.path === '/poker/'),
    'The real table window did not restore the player session through the /poker path: ' +
      JSON.stringify({...setupRoute, cookiePath:setupCookies.find(cookie => cookie.name === 'sitngo_session')?.path || ''}));
  const routeTableId = setupRoute.table;
  const tableName = await evaluate(setupPage, () => document.querySelector('#view-table-name').textContent);
  const sourceAfterNewGame = await evaluate(hostPage, () => ({
    path:location.pathname, lobby:document.body.classList.contains('lobby-route'),
    tableHidden:document.querySelector('#table-view').hidden,
    hasNewGame: [...document.querySelectorAll('[data-open-table]')].some(node => node.textContent.includes('’s table')),
  }));
  assert(sourceAfterNewGame.path === '/poker/lobby' && sourceAfterNewGame.lobby &&
    sourceAfterNewGame.tableHidden,
    'New game replaced the source lobby with inline gameplay: ' + JSON.stringify(sourceAfterNewGame));
  await setupPage.close();
  await wait(hostPage, name => [...document.querySelectorAll('[data-open-table]')]
    .some(node => node.textContent.includes(name)), tableName);

  await clickTrusted(hostPage, '[data-open-table="' + routeTableId + '"]');
  const cardPage = await hostPage.waitForPopup();
  await wait(cardPage, () => location.pathname === '/poker/table' &&
    !document.querySelector('#table-view').hidden);
  const sourceAfterCard = await evaluate(hostPage, () => ({
    path:location.pathname, lobby:document.body.classList.contains('lobby-route'),
    tableHidden:document.querySelector('#table-view').hidden,
  }));
  const cardRoute = await evaluate(cardPage, () => ({
    path:location.pathname, id:new URLSearchParams(location.search).get('table'),
    table:document.querySelector('#view-table-name')?.textContent || '',
    player:document.querySelector('#welcome-name')?.textContent || '',
  }));
  assert(sourceAfterCard.path === '/poker/lobby' && sourceAfterCard.lobby && sourceAfterCard.tableHidden &&
    cardRoute.path === '/poker/table' && cardRoute.id === routeTableId && cardRoute.player === username,
    'Opening a lobby card did not keep gameplay in its own authenticated window: ' +
      JSON.stringify({sourceAfterCard,cardRoute}));
  await cardPage.close();

  await evaluate(hostPage, () => { window.open = function() { return null; }; });
  await clickTrusted(hostPage, '[data-open-table="' + routeTableId + '"]');
  await wait(hostPage, () => document.querySelector('#popup-fallback')?.hidden === false);
  const blockedOpen = await evaluate(hostPage, () => ({
    route:location.pathname, tableHidden:document.querySelector('#table-view').hidden,
    workspace:getComputedStyle(document.querySelector('.workspace')).display,
    button:document.querySelector('#popup-fallback-open').textContent,
  }));
  assert(blockedOpen.route === '/poker/lobby' && blockedOpen.tableHidden &&
    blockedOpen.workspace === 'none' && blockedOpen.button.includes('Open table here'),
    'A blocked popup embedded gameplay instead of offering an explicit route button: ' + JSON.stringify(blockedOpen));
  await clickTrusted(hostPage, '#popup-fallback-open');
  await wait(hostPage, () => location.pathname === '/poker/table' &&
    !document.querySelector('#table-view').hidden);
  await click(hostPage, '#close-table-button');
  await wait(hostPage, () => location.pathname === '/poker/lobby');

  await evaluate(hostPage, () => window.location.assign('/lobby'));
  await wait(hostPage, () => location.pathname === '/lobby' &&
    document.querySelector('#app-panel')?.hidden === false && document.body.classList.contains('lobby-route'));

  await evaluate(loginPage, path => window.location.assign(path), '/table?table=' + encodeURIComponent(routeTableId));
  await wait(loginPage, () => location.pathname === '/table' &&
    Boolean(document.querySelector('#login-name')?.offsetWidth));
  await input(loginPage, '#login-name', username);
  await input(loginPage, '#login-password', password);
  await evaluate(loginPage, () => document.querySelector('#login-form').requestSubmit());
  await wait(loginPage, () => location.pathname === '/table' &&
    document.querySelector('#app-panel')?.hidden === false &&
    !document.querySelector('#table-view')?.hidden);
  const authenticatedDirectTable = await evaluate(loginPage, () => ({
    table:document.querySelector('#view-table-name')?.textContent || '',
    routeId:new URLSearchParams(location.search).get('table'),
    mode:document.body.classList.contains('table-route'),
  }));
  assert(authenticatedDirectTable.mode && authenticatedDirectTable.routeId === routeTableId &&
    authenticatedDirectTable.table.includes(username),
    'Authentication did not preserve the direct table route: ' + JSON.stringify(authenticatedDirectTable));

  console.log('Lobby filters completed games, keeps the source open while real table windows restore auth, and handles popup blocks.');
}
