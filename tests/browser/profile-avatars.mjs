// Focused coverage for profile photo upload, authenticated seat images, and card backs.
export default async function profileAvatars([hostPage, guestPage], sleep, roomPassword) {
  const evaluate = (page, fn, ...args) => page.evaluate('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')');
  const assert = (condition, message) => { if (!condition) throw Error(message); };

  async function wait(page, predicate, ...args) {
    for (let attempt = 0; attempt < 240; attempt++) {
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
      if (!node || node.hidden || node.disabled) return false;
      const details = node.closest('details');
      if (details && !details.open) details.open = true;
      if (!node.offsetWidth) return false;
      node.click();
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
  async function signIn(page, username, password, path) {
    await evaluate(page, next => window.location.assign(next), path);
    await wait(page, () => Boolean(document.querySelector('#login-name')?.offsetWidth));
    await input(page, '#login-name', username);
    await input(page, '#login-password', password);
    await input(page, '#room-password', roomPassword);
    await evaluate(page, () => document.querySelector('#login-form').requestSubmit());
    await wait(page, () => document.querySelector('#app-panel')?.hidden === false);
  }
  function installNetworkRecorder(page) {
    return evaluate(page, () => {
      window.__avatarCalls = {posts:[], gets:[]};
      window.__cardFixtureMode = '';
      window.__cardFixtureRevision = 0;
      window.__cardFixtureIds = null;
      const originalFetch = window.fetch.bind(window);
      window.fetch = async function(input, init) {
        const url = typeof input === 'string' ? input : input.url;
        const method = String((init && init.method) || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
        const headers = new Headers((init && init.headers) || (typeof input === 'object' && input.headers) || {});
        const avatarPost = url.includes('/poker/api/profile/avatar') && method === 'POST';
        const avatarGet = /\/poker\/api\/players\/[^/]+\/avatar(?:\?|$)/.test(url) && method === 'GET';
        let postRecord = null;
        if (avatarPost) {
          postRecord = {body:JSON.parse(init.body || '{}'), session:headers.get('X-SitNgo-Session') || '', csrf:headers.get('X-SitNgo-CSRF') || '', held:false};
          window.__avatarCalls.posts.push(postRecord);
        }
        let getRecord = null;
        if (avatarGet) {
          getRecord = {url,session:headers.get('X-SitNgo-Session') || '',status:0};
          window.__avatarCalls.gets.push(getRecord);
        }
        let response = await originalFetch(input, init);
        if (avatarPost && window.__holdNextAvatarSave) {
          window.__holdNextAvatarSave = false;
          postRecord.held = true;
          window.__releaseAvatarSave = null;
          const completedResponse = response;
          response = await new Promise(resolve => { window.__releaseAvatarSave = () => resolve(completedResponse); });
        }
        if (avatarGet && getRecord) getRecord.status = response.status;
        if (postRecord) {
          try { postRecord.response = await response.clone().json(); } catch (_) { postRecord.response = {}; }
        }
        if (window.__cardFixtureMode && window.__cardFixtureIds && method === 'GET' &&
            new URL(url, location.origin).pathname === '/poker/api/tables/' + window.__cardFixtureIds.tableId) {
          const payload = await response.clone().json();
          const view = payload.table || payload;
          const mode = window.__cardFixtureMode;
          window.__cardFixtureRevision += 1;
          view.version = 10000 + window.__cardFixtureRevision;
          view.server_now = Date.now() / 1000;
          view.status = mode === 'showdown' ? 'completed' : 'playing';
          view.street = mode === 'showdown' ? 'showdown' : 'flop';
          view.hand_no = 1;
          view.hand_id = 'profile-avatar-fixture';
          view.actor_id = '';
          view.to_act_id = '';
          view.viewer = Object.assign({}, view.viewer, {
            player_id:window.__cardFixtureIds.hostId,
            seated:true,
            can_act:false,
            hole_cards:[{rank:'A',suit:'spades'},{rank:'K',suit:'clubs'}]
          });
          view.seats = (view.seats || []).map(seat => {
            const item = Object.assign({}, seat);
            const id = String(item.id || item.player_id || '');
            item.in_hand = id === window.__cardFixtureIds.hostId ||
              (id === window.__cardFixtureIds.guestId && ['dealt','showdown'].includes(mode));
            item.folded = id === window.__cardFixtureIds.guestId && mode === 'folded';
            item.is_folded = item.folded;
            item.eliminated = id === window.__cardFixtureIds.guestId && mode === 'busted';
            item.sitting_out = id === window.__cardFixtureIds.guestId && mode === 'waiting';
            if (id === window.__cardFixtureIds.guestId) {
              item.status = mode === 'folded' ? 'folded' : mode === 'waiting' ? 'waiting' : mode === 'busted' ? 'busted' : 'playing';
              item.stack = mode === 'busted' ? 0 : 1000;
              delete item.cards;
              delete item.revealed_cards;
              if (mode === 'showdown') item.cards = [{rank:'Q',suit:'hearts'},{rank:'J',suit:'hearts'}];
            }
            return item;
          });
          view.runout_odds = [];
          view.showdown = mode === 'showdown' ? [{player_id:window.__cardFixtureIds.guestId,name:'Avatar guest',hand_name:'Pair'}] : [];
          view.winners = mode === 'showdown' ? [{player_id:window.__cardFixtureIds.guestId,name:'Avatar guest',amount:20,rank:'Pair'}] : [];
          view.showdown_until = Date.now() / 1000 + 30;
          window.__cardFixtureApplied = mode;
          return new Response(JSON.stringify(payload), {status:response.status, headers:response.headers});
        }
        return response;
      };
    });
  }

  const origin = await hostPage.evaluate('location.origin');
  const api = origin + '/poker/api';
  const stamp = Date.now().toString(36);
  async function apiRequest(path, session, body) {
    const headers = {Origin:origin};
    if (session) Object.assign(headers, {Cookie:session.cookie,'X-SitNgo-Session':session.session_proof,'X-SitNgo-CSRF':session.csrf});
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(api + path, {method:body === undefined ? 'GET' : 'POST',headers,
      body:body === undefined ? undefined : JSON.stringify(body)});
    const data = await response.json();
    if (!response.ok) throw Error(path + ' failed: ' + JSON.stringify(data));
    if (path === '/register') {
      const cookie = response.headers.get('set-cookie')?.split(';')[0];
      if (!cookie) throw Error('Registration did not issue a session cookie');
      return {...data,cookie};
    }
    return data.table || data;
  }

  const hostName = ('Portrait' + stamp).slice(0, 24);
  const guestName = ('Picture' + stamp).slice(0, 24);
  const hostPassword = 'AvatarHost_' + stamp + '_Pass';
  const guestPassword = 'AvatarGuest_' + stamp + '_Pass';
  const host = await apiRequest('/register', null, {room_password:roomPassword,username:hostName,password:hostPassword});
  const guest = await apiRequest('/register', null, {room_password:roomPassword,username:guestName,password:guestPassword});
  const table = await apiRequest('/tables', host, {name:'Profile avatar QA',max_seats:2,starting_stack:1000,
    small_blind:10,big_blind:20,level_minutes:5,turn_seconds:3600,buy_in:10,payout_percentages:[60,40]});
  await apiRequest('/tables/' + table.id + '/seat', guest, {seat_no:1});

  await signIn(hostPage, hostName, hostPassword, '/poker/lobby');
  await installNetworkRecorder(hostPage);
  await wait(hostPage, () => Boolean(document.querySelector('#profile-photo-button')?.offsetWidth));
  await click(hostPage, '#profile-photo-button');
  await wait(hostPage, () => document.querySelector('#profile-photo-dialog')?.open === true);
  const lobbyDialogMetrics = await evaluate(hostPage, () => {
    const dialog = document.querySelector('#profile-photo-dialog');
    const close = document.querySelector('#profile-photo-close');
    const choose = document.querySelector('#profile-photo-choose');
    return {width:dialog.getBoundingClientRect().width,height:dialog.getBoundingClientRect().height,
      closeHeight:close.getBoundingClientRect().height,chooseHeight:choose.getBoundingClientRect().height,
      fileAccept:document.querySelector('#profile-photo-file').accept};
  });
  assert(lobbyDialogMetrics.closeHeight >= 44 && lobbyDialogMetrics.chooseHeight >= 44 &&
    lobbyDialogMetrics.fileAccept.includes('image/jpeg') && lobbyDialogMetrics.fileAccept.includes('image/png'),
    'The profile dialog controls or image type bounds are missing: ' + JSON.stringify(lobbyDialogMetrics));
  await hostPage.screenshot('profile-photo-dialog-lobby');

  // Closing during decode invalidates that crop; it cannot overwrite a reopened dialog.
  await evaluate(hostPage, async () => {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 256;
    const context = canvas.getContext('2d'); context.fillStyle = '#c84242'; context.fillRect(0,0,256,256);
    context.fillStyle = '#356dcc'; context.fillRect(256,0,256,256);
    const blob = await new Promise(resolve => canvas.toBlob(resolve,'image/png'));
    const file = new File([blob],'portrait.png',{type:'image/png'});
    const original = window.createImageBitmap.bind(window);
    window.__restoreAvatarBitmap = () => { window.createImageBitmap = original; };
    window.createImageBitmap = (source, options) => new Promise(resolve => {
      window.__releaseAvatarCrop = async () => resolve(await original(source, options));
    });
    const transfer = new DataTransfer(); transfer.items.add(file);
    const input = document.querySelector('#profile-photo-file'); input.files = transfer.files;
    input.dispatchEvent(new Event('change',{bubbles:true}));
  });
  await wait(hostPage, () => typeof window.__releaseAvatarCrop === 'function');
  await click(hostPage, '#profile-photo-close');
  await wait(hostPage, () => document.querySelector('#profile-photo-dialog')?.open === false);
  await click(hostPage, '#profile-photo-button');
  await wait(hostPage, () => document.querySelector('#profile-photo-dialog')?.open === true);
  await evaluate(hostPage, async () => { await window.__releaseAvatarCrop(); window.__restoreAvatarBitmap(); });
  await sleep(150);
  const staleCropIgnored = await evaluate(hostPage, () => ({saveDisabled:document.querySelector('#profile-photo-save').disabled,
    preview:document.querySelector('#profile-photo-preview').classList.contains('has-avatar')}));
  assert(staleCropIgnored.saveDisabled && !staleCropIgnored.preview,
    'A crop started before closing overwrote the reopened profile dialog: ' + JSON.stringify(staleCropIgnored));

  // Make a wide source image; the app must center-crop it and save a bounded square JPEG.
  await evaluate(hostPage, async () => {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 256;
    const context = canvas.getContext('2d'); context.fillStyle = '#c84242'; context.fillRect(0,0,256,256);
    context.fillStyle = '#356dcc'; context.fillRect(256,0,256,256);
    const blob = await new Promise(resolve => canvas.toBlob(resolve,'image/png'));
    const file = new File([blob],'portrait.png',{type:'image/png'});
    const transfer = new DataTransfer(); transfer.items.add(file);
    const input = document.querySelector('#profile-photo-file'); input.files = transfer.files;
    input.dispatchEvent(new Event('change',{bubbles:true}));
  });
  await wait(hostPage, () => document.querySelector('#profile-photo-status')?.textContent.includes('ready to save'));
  const staged = await evaluate(hostPage, () => {
    const image = document.querySelector('#profile-photo-preview img');
    const parts = image.src.split(',');
    return {width:image.naturalWidth,height:image.naturalHeight,
      type:(parts[0].match(/^data:([^;]+)/) || [])[1] || '',
      size:atob(parts[1] || '').length,dataLength:image.src.length};
  });
  assert(staged.width === 256 && staged.height === 256 && staged.type === 'image/jpeg' &&
    staged.size <= 256 * 1024 && staged.dataLength < 360000,
    'The selected photo was not center-cropped/resized to a bounded square JPEG: ' + JSON.stringify(staged));
  await hostPage.screenshot('profile-photo-preview');

  // Hold the response after the server accepts it; Close remains usable, and the late response is ignored.
  await evaluate(hostPage, () => { window.__holdNextAvatarSave = true; });
  await click(hostPage, '#profile-photo-save');
  await wait(hostPage, () => window.__avatarCalls.posts.some(post => post.held));
  const profilePost = await evaluate(hostPage, () => window.__avatarCalls.posts[window.__avatarCalls.posts.length - 1]);
  assert(profilePost.body.image_data.startsWith('data:image/jpeg;base64,') &&
    profilePost.body.image_data.length < 360000 && profilePost.session && profilePost.csrf,
    'The avatar POST did not carry the prepared JPEG and authenticated mutation headers.');
  await click(hostPage, '#profile-photo-close');
  await wait(hostPage, () => document.querySelector('#profile-photo-dialog')?.open === false);
  await click(hostPage, '#profile-photo-button');
  await wait(hostPage, () => document.querySelector('#profile-photo-dialog')?.open === true);
  await evaluate(hostPage, () => { if (window.__releaseAvatarSave) window.__releaseAvatarSave(); });
  await sleep(250);
  const staleSaveIgnored = await evaluate(hostPage, () => ({open:document.querySelector('#profile-photo-dialog').open,
    saveDisabled:document.querySelector('#profile-photo-save').disabled,posts:window.__avatarCalls.posts.length}));
  assert(staleSaveIgnored.open && staleSaveIgnored.saveDisabled && staleSaveIgnored.posts === 1,
    'A delayed save response changed the newly opened profile dialog: ' + JSON.stringify(staleSaveIgnored));

  // Reconnection restores the committed profile from the server and loads its protected bytes with session proof.
  await hostPage.reload();
  await wait(hostPage, () => document.querySelector('#app-panel')?.hidden === false &&
    document.querySelector('#identity-avatar')?.classList.contains('has-avatar'));
  const persisted = await evaluate(hostPage, () => ({url:document.querySelector('#identity-avatar').dataset.avatarUrl,
    imageWidth:document.querySelector('#identity-avatar img').naturalWidth}));
  assert(persisted.url.includes('/poker/api/players/') && persisted.url.includes('/avatar?v=') &&
    persisted.imageWidth === 256,
    'The saved avatar did not persist or its protected image did not load after reconnect: ' + JSON.stringify(persisted));

  // Open the real table route for both users. Host portrait must appear on the guest's opponent seat.
  const tableUrl = '/poker/table?table=' + encodeURIComponent(table.id);
  await evaluate(hostPage, path => window.location.assign(path), tableUrl);
  await wait(hostPage, () => !document.querySelector('#table-view')?.hidden &&
    document.querySelectorAll('#seat-grid .seat-card[data-player-id]').length === 2);
  await signIn(guestPage, guestName, guestPassword, tableUrl);
  await wait(guestPage, () => !document.querySelector('#table-view')?.hidden &&
    document.querySelectorAll('#seat-grid .seat-card[data-player-id]').length === 2);
  await wait(guestPage, id => {
    const seat = document.querySelector('.seat-card[data-player-id="' + id + '"] .seat-avatar');
    return Boolean(seat?.classList.contains('has-avatar') && seat.querySelector('img')?.naturalWidth === 256);
  }, host.player.id);
  const guestOpponentPortrait = await evaluate(guestPage, id => {
    const wrapper = document.querySelector('.seat-card[data-player-id="' + id + '"] .seat-avatar');
    return {loaded:wrapper.classList.contains('has-avatar'),width:wrapper.getBoundingClientRect().width,
      height:wrapper.getBoundingClientRect().height,src:wrapper.querySelector('img').src.startsWith('data:image/jpeg')};
  }, host.player.id);
  assert(guestOpponentPortrait.loaded && guestOpponentPortrait.width >= 22 && guestOpponentPortrait.height >= 22 &&
    guestOpponentPortrait.src,
    'The guest did not fetch and display the host avatar on the opponent seat: ' + JSON.stringify(guestOpponentPortrait));
  await guestPage.screenshot('profile-photo-opponent-seat');

  // Table menu offers the same dialog to seated players.
  await click(guestPage, '#table-menu > summary');
  await click(guestPage, '#profile-photo-menu-button');
  await wait(guestPage, () => document.querySelector('#profile-photo-dialog')?.open === true);
  await guestPage.screenshot('profile-photo-dialog-table-menu');
  await click(guestPage, '#profile-photo-close');
  await wait(guestPage, () => document.querySelector('#profile-photo-dialog')?.open === false);

  // A refresh/reconnect still displays the same persistent image on the opponent seat.
  await guestPage.reload();
  await wait(guestPage, id => !document.querySelector('#table-view')?.hidden &&
    document.querySelector('.seat-card[data-player-id="' + id + '"] .seat-avatar')?.classList.contains('has-avatar'), host.player.id);
  const guestAfterReload = await evaluate(guestPage, id => ({
    width:document.querySelector('.seat-card[data-player-id="' + id + '"] .seat-avatar img').naturalWidth
  }), host.player.id);
  assert(guestAfterReload.width === 256,
    'The opponent avatar did not survive a browser reconnect: ' + JSON.stringify(guestAfterReload));

  // Use isolated table snapshot fixtures to exercise dealt, folded, no-card, busted, and exposed showdown states.
  await installNetworkRecorder(hostPage);
  await evaluate(hostPage, (tableId, hostId, guestId) => {
    window.__cardFixtureIds = {tableId,hostId,guestId};
    window.__cardFixtureMode = 'dealt';
    window.__cardFixtureApplied = '';
  }, table.id, host.player.id, guest.player.id);
  await wait(hostPage, (mode, guestId) => window.__cardFixtureApplied === mode &&
    document.querySelector('.seat-card[data-player-id="' + guestId + '"] .mini-card.back'), 'dealt', guest.player.id);
  const dealtCards = await evaluate(hostPage, guestId => ({
    opponentBacks:document.querySelectorAll('.seat-card[data-player-id="' + guestId + '"] .mini-card.back').length,
    ownFaces:document.querySelectorAll('#hero-seat .mini-card:not(.back)').length,
    redBack:getComputedStyle(document.querySelector('.seat-card[data-player-id="' + guestId + '"] .mini-card.back')).backgroundImage.includes('rgb(199, 72, 70)'),
    portrait:document.querySelector('#hero-seat .seat-avatar').getBoundingClientRect().width
  }), guest.player.id);
  assert(dealtCards.opponentBacks === 2 && dealtCards.ownFaces === 2 && dealtCards.redBack && dealtCards.portrait >= 22,
    'A dealt hidden hand, own faces, red back, or 24px profile slot rendered incorrectly: ' + JSON.stringify(dealtCards));
  await hostPage.resize(390,844);
  await hostPage.screenshot('profile-table-dealt-390x844');

  async function setFixture(mode, selector, expectedCount) {
    await evaluate(hostPage, next => { window.__cardFixtureMode = next; window.__cardFixtureApplied = ''; document.dispatchEvent(new Event('visibilitychange')); }, mode);
    await wait(hostPage, current => window.__cardFixtureApplied === current, mode);
    if (selector) await wait(hostPage, (query, count) => document.querySelectorAll(query).length === count, selector, expectedCount);
  }
  await setFixture('folded', '.seat-card[data-player-id="' + guest.player.id + '"] .mini-card.back', 0);
  const foldedCards = await evaluate(hostPage, id => document.querySelector('.seat-card[data-player-id="' + id + '"] .seat-cards').classList.contains('is-empty'), guest.player.id);
  assert(foldedCards, 'Folded players retained hidden card backs.');
  await setFixture('waiting', '.seat-card[data-player-id="' + guest.player.id + '"] .mini-card.back', 0);
  const waitingCards = await evaluate(hostPage, id => document.querySelector('.seat-card[data-player-id="' + id + '"] .seat-cards').classList.contains('is-empty'), guest.player.id);
  assert(waitingCards, 'A waiting player without dealt cards was given card backs.');
  await setFixture('busted', '.seat-card[data-player-id="' + guest.player.id + '"] .mini-card.back', 0);
  const bustedCards = await evaluate(hostPage, id => document.querySelector('.seat-card[data-player-id="' + id + '"] .seat-cards').classList.contains('is-empty'), guest.player.id);
  assert(bustedCards, 'A busted player without cards was given card backs.');
  await setFixture('showdown', '.seat-card[data-player-id="' + guest.player.id + '"] .mini-card:not(.back)', 2);
  const showdownCards = await evaluate(hostPage, id => ({opponentFaces:document.querySelectorAll('.seat-card[data-player-id="' + id + '"] .mini-card:not(.back)').length,
    opponentBacks:document.querySelectorAll('.seat-card[data-player-id="' + id + '"] .mini-card.back').length,
    ownFaces:document.querySelectorAll('#hero-seat .mini-card:not(.back)').length}), guest.player.id);
  assert(showdownCards.opponentFaces === 2 && showdownCards.opponentBacks === 0 && showdownCards.ownFaces === 2,
    'Exposed showdown cards or the viewer hand were hidden or replaced by backs: ' + JSON.stringify(showdownCards));
  await hostPage.screenshot('profile-table-showdown');

  // Profile removal is persisted by the same authenticated mutation and clears the other player's seat image.
  await click(hostPage, '#table-menu > summary');
  await click(hostPage, '#profile-photo-menu-button');
  await wait(hostPage, () => document.querySelector('#profile-photo-dialog')?.open === true);
  await click(hostPage, '#profile-photo-remove');
  await click(hostPage, '#profile-photo-save');
  await wait(hostPage, () => document.querySelector('#profile-photo-dialog')?.open === false);
  const removal = await evaluate(hostPage, () => window.__avatarCalls.posts.at(-1));
  assert(removal.body.image_data === '' && removal.response?.player?.avatar_url === '',
    'Removing a photo did not send an empty image and receive an empty avatar URL.');
  await hostPage.reload();
  await wait(hostPage, () => document.querySelector('#app-panel')?.hidden === false &&
    !document.querySelector('#identity-avatar')?.classList.contains('has-avatar'));
  const removedIdentity = await evaluate(hostPage, () => ({url:document.querySelector('#identity-avatar').dataset.avatarUrl,
    fallback:document.querySelector('#identity-avatar .avatar-fallback-text').textContent}));
  assert(!removedIdentity.url && removedIdentity.fallback === hostName[0].toUpperCase(),
    'The removed profile photo reappeared after refresh: ' + JSON.stringify(removedIdentity));

  await guestPage.reload();
  await wait(guestPage, id => !document.querySelector('#table-view')?.hidden &&
    Boolean(document.querySelector('.seat-card[data-player-id="' + id + '"]')), host.player.id);
  await sleep(350);
  const guestNoAvatar = await evaluate(guestPage, id => {
    const wrapper = document.querySelector('.seat-card[data-player-id="' + id + '"] .seat-avatar');
    return {loaded:wrapper.classList.contains('has-avatar'),url:wrapper.dataset.avatarUrl,
      fallback:wrapper.querySelector('.avatar-fallback-text').textContent};
  }, host.player.id);
  assert(!guestNoAvatar.loaded && !guestNoAvatar.url && guestNoAvatar.fallback === hostName[0].toUpperCase(),
    'The removed photo persisted on the opponent seat: ' + JSON.stringify(guestNoAvatar));
  await guestPage.screenshot('profile-photo-removed-seat');

  console.log('Profile photos crop to bounded JPEGs, persist across reloads, load through authenticated avatar requests, render on seats, and cleanly fall back after removal; dealt/folded/waiting/busted/showdown card states passed.');
}
