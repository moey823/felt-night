// Focused coverage for profile photos, shared portraits, account editing, seat images, and card backs.
import {seedAvatar} from "./avatar-fixture.mjs";
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
  async function clickTrusted(page, selector) {
    await page.bringToFront();
    const point = await evaluate(page, query => {
      const node = document.querySelector(query);
      if (!node || !node.offsetWidth || node.hidden || node.disabled) return null;
      const rect = node.getBoundingClientRect();
      return {x:Math.round(rect.left + rect.width / 2),y:Math.round(rect.top + rect.height / 2)};
    }, selector);
    if (!point) throw Error('Cannot click visible control: ' + selector);
    await page.clickAt(point.x, point.y);
  }
  async function input(page, selector, value) {
    await evaluate(page, (query, next) => {
      const node = document.querySelector(query);
      if (!node) throw Error('Missing input ' + query + ' at ' + location.href +
        '; login panel=' + String(document.querySelector('#login-panel')?.hidden) +
        '; app panel=' + String(document.querySelector('#app-panel')?.hidden) +
        '; body=' + String(document.body?.innerText || '').slice(-500));
      node.value = String(next);
      for (const type of ['input', 'change']) node.dispatchEvent(new Event(type, {bubbles:true}));
    }, selector, value);
  }
  async function signIn(page, username, password, path) {
    await evaluate(page, next => { window.__photoTestNavigating=true; window.location.assign(next); }, path);
    await wait(page, next => {
      const expected=new URL(next,location.origin);
      const login=document.querySelector('#login-name');
      return !window.__photoTestNavigating &&
        location.pathname === expected.pathname && location.search === expected.search &&
        document.readyState === 'complete' && document.querySelector('#login-panel')?.hidden === false &&
        Boolean(login?.offsetWidth);
    }, path);
    await input(page, '#login-name', username);
    await input(page, '#login-password', password);
    await input(page, '#room-password', roomPassword);
    await evaluate(page, () => document.querySelector('#login-form').requestSubmit());
    await wait(page, () => document.querySelector('#app-panel')?.hidden === false);
  }
  function installNetworkRecorder(page) {
    return evaluate(page, () => {
      window.__avatarCalls = {posts:[], gets:[], tableCreates:[], seats:[], profiles:[], adminPresets:[]};
      window.__cardFixtureMode = '';
      window.__cardFixtureRevision = 0;
      window.__cardFixtureIds = null;
      const originalFetch = window.fetch.bind(window);
      window.fetch = async function(input, init) {
        const url = typeof input === 'string' ? input : input.url;
        const method = String((init && init.method) || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
        const headers = new Headers((init && init.headers) || (typeof input === 'object' && input.headers) || {});
        const avatarPost = url.includes('/poker/api/profile/avatar') && method === 'POST';
        const avatarGet = /\/poker\/api\/(?:players\/[^/]+\/avatar(?:\/full)?|avatar-presets\/[a-f0-9]{32}\/(?:thumbnail|full))(?:\?|$)/.test(url) && method === 'GET';
        const routePath = new URL(url, location.origin).pathname;
        const tableCreate = routePath === '/poker/api/tables' && method === 'POST';
        const seatPost = /\/poker\/api\/tables\/[^/]+\/seat$/.test(routePath) && method === 'POST';
        const profilePost = routePath === '/poker/api/profile' && method === 'POST';
        const adminPresetPost = routePath === '/poker/api/admin/avatar-presets' && method === 'POST';
        let postRecord = null;
        if (avatarPost) {
          postRecord = {body:JSON.parse(init.body || '{}'), session:headers.get('X-SitNgo-Session') || '', csrf:headers.get('X-SitNgo-CSRF') || '', held:false};
          window.__avatarCalls.posts.push(postRecord);
        }
        let actionRecord = null;
        if (tableCreate || seatPost || profilePost || adminPresetPost) {
          actionRecord = {url,body:JSON.parse((init && init.body) || '{}'),session:headers.get('X-SitNgo-Session') || '',status:0,response:null};
          if (tableCreate) window.__avatarCalls.tableCreates.push(actionRecord);
          if (seatPost) window.__avatarCalls.seats.push(actionRecord);
          if (profilePost) window.__avatarCalls.profiles.push(actionRecord);
          if (adminPresetPost) window.__avatarCalls.adminPresets.push(actionRecord);
        }
        let getRecord = null;
        if (avatarGet) {
          getRecord = {url,session:headers.get('X-SitNgo-Session') || '',status:0};
          window.__avatarCalls.gets.push(getRecord);
        }
        let response;
        if (avatarPost && window.__failNextAvatarSave) {
          window.__failNextAvatarSave = false;
          response = new Response(JSON.stringify({error:"The test rejected this avatar save."}), {
            status:400, headers:{"Content-Type":"application/json"}
          });
        } else {
          response = await originalFetch(input, init);
        }
        if (avatarPost && window.__holdNextAvatarSave) {
          window.__holdNextAvatarSave = false;
          postRecord.held = true;
          window.__releaseAvatarSave = null;
          const completedResponse = response;
          response = await new Promise(resolve => { window.__releaseAvatarSave = () => resolve(completedResponse); });
        }
        if (avatarGet && getRecord) {
          getRecord.status = response.status;
          getRecord.contentType = response.headers.get('Content-Type') || '';
          const bytes = new Uint8Array(await response.clone().arrayBuffer());
          getRecord.size = bytes.length;
          getRecord.magic = [...bytes.slice(0,4)];
        }
        if (actionRecord) {
          actionRecord.status = response.status;
          try { actionRecord.response = await response.clone().json(); } catch (_) { actionRecord.response = {}; }
        }
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
  await seedAvatar(apiRequest, host, 'fish');
  await seedAvatar(apiRequest, guest, 'whale');
  const table = await apiRequest('/tables', host, {name:'Profile avatar QA',max_seats:2,starting_stack:1000,
    small_blind:10,big_blind:20,level_minutes:5,turn_seconds:3600,buy_in:10,payout_percentages:[60,40]});
  await apiRequest('/tables/' + table.id + '/seat', guest, {seat_no:1});

  await signIn(hostPage, hostName, hostPassword, '/poker/lobby');
  await installNetworkRecorder(hostPage);
  await wait(hostPage, () => Boolean(document.querySelector('#profile-photo-button')?.offsetWidth));
  const avatarCatalog = await apiRequest('/avatar-presets', host);
  const requiredAvatarIds = ['fish','shark','cowboy','fisherman','whale','crab','octopus','pumpkin','pirate','cowgirl','astronaut','fox'];
  const builtinCatalog = avatarCatalog.avatars.filter(item => !item.custom);
  assert(builtinCatalog.length === 12 && requiredAvatarIds.every(id => builtinCatalog.some(item => item.id === id)),
    'The shared catalog does not contain all 12 required default portraits: ' + builtinCatalog.map(item => item.id).join(','));
  const realAssets = await evaluate(hostPage, async choices => {
    async function size(url) {
      const image = new Image();
      image.src = url;
      await image.decode();
      return {width:image.naturalWidth,height:image.naturalHeight};
    }
    return Promise.all(choices.map(async choice => ({
      id:choice.id,thumb:await size(choice.url),full:await size(choice.full_url)
    })));
  }, builtinCatalog);
  assert(realAssets.length === 12 && realAssets.every(item => item.thumb.width === 256 && item.thumb.height === 256 &&
    item.full.width === 1024 && item.full.height === 1024),
    'Default portraits are missing or not real 256/1024 square images: ' + JSON.stringify(realAssets));
  await click(hostPage, '#profile-photo-button');
  await wait(hostPage, () => document.querySelector('#profile-photo-dialog')?.open === true);
  await wait(hostPage, () => document.querySelectorAll('#profile-photo-presets .avatar-preset').length === 12);
  const galleryChoices = await evaluate(hostPage, () => [...document.querySelectorAll('#profile-photo-presets .avatar-preset')].map(button => ({
    id:button.dataset.avatarPresetId,label:button.getAttribute('aria-label'),pressed:button.getAttribute('aria-pressed')
  })));
  assert(galleryChoices.length === 12 && galleryChoices.some(choice => choice.id === 'cowgirl' && choice.label === 'Choose Cowgirl avatar'),
    'The accessible cartoon portrait chooser did not expose the 12 choices: ' + JSON.stringify(galleryChoices));
  await click(hostPage, '[data-avatar-preset-id="cowgirl"]');
  await wait(hostPage, () => !document.querySelector('#profile-photo-save').disabled &&
    document.querySelector('#profile-photo-status').textContent.includes('ready to save'));
  const selectedPreset = await evaluate(hostPage, () => {
    const selected=document.querySelector('[data-avatar-preset-id="cowgirl"]');
    const image=document.querySelector('#profile-photo-preview img');
    return {pressed:selected.getAttribute('aria-pressed'),width:image.naturalWidth,height:image.naturalHeight};
  });
  assert(selectedPreset.pressed === 'true' && selectedPreset.width === 256 && selectedPreset.height === 256,
    'Selecting a preset did not prepare its JPEG thumbnail: ' + JSON.stringify(selectedPreset));
  await click(hostPage, '#profile-photo-save');
  await wait(hostPage, () => document.querySelector('#profile-photo-dialog')?.open === false);
  const presetPost = await evaluate(hostPage, () => window.__avatarCalls.posts.at(-1));
  const fullMaster = await evaluate(hostPage, body => new Promise((resolve,reject) => {
    const image=new Image(); image.onload=()=>resolve({width:image.naturalWidth,height:image.naturalHeight,
      type:body.full_image_data.split(',')[0],size:atob(body.full_image_data.split(',')[1]).length});
    image.onerror=reject; image.src=body.full_image_data;
  }), presetPost.body);
  assert(presetPost.body.preset_id === 'cowgirl' && presetPost.body.image_data.startsWith('data:image/jpeg;base64,') &&
    presetPost.body.full_image_data.startsWith('data:image/jpeg;base64,') && fullMaster.width === 1024 &&
    fullMaster.height === 1024 && fullMaster.size <= 1024 * 1024 && presetPost.session && presetPost.csrf,
    'Preset selection did not save protected 256/1024 JPEGs with the selected preset id: ' + JSON.stringify(fullMaster));
  await wait(hostPage, () => document.querySelector('#identity-avatar')?.classList.contains('has-avatar'));
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
  await wait(hostPage, () => document.querySelector('#profile-photo-preview')?.classList.contains('has-avatar'));
  const stalePreviewBefore = await evaluate(hostPage, () => {
    const wrapper=document.querySelector('#profile-photo-preview');
    return {url:wrapper.dataset.avatarUrl,local:wrapper.dataset.avatarLocal || '',src:wrapper.querySelector('img').src};
  });
  await evaluate(hostPage, async () => { await window.__releaseAvatarCrop(); window.__restoreAvatarBitmap(); });
  await sleep(150);
  const staleCropIgnored = await evaluate(hostPage, () => {
    const wrapper=document.querySelector('#profile-photo-preview');
    return {saveDisabled:document.querySelector('#profile-photo-save').disabled,
      url:wrapper.dataset.avatarUrl,local:wrapper.dataset.avatarLocal || '',src:wrapper.querySelector('img').src};
  });
  assert(staleCropIgnored.saveDisabled && staleCropIgnored.url === stalePreviewBefore.url &&
    staleCropIgnored.local === stalePreviewBefore.local && staleCropIgnored.src === stalePreviewBefore.src,
    'A crop started before closing overwrote the reopened profile dialog: ' +
      JSON.stringify({before:stalePreviewBefore,after:staleCropIgnored}));

  // Replacing a selected preset with an uploaded image clears the preset id before saving.
  await click(hostPage, '[data-avatar-preset-id="fish"]');
  await wait(hostPage, () => !document.querySelector('#profile-photo-save').disabled &&
    document.querySelector('#profile-photo-status').textContent.includes('ready to save'));
  assert(await evaluate(hostPage, () => document.querySelector('[data-avatar-preset-id="fish"]')?.getAttribute('aria-pressed')) === 'true',
    'Selecting Fish did not mark the preset as selected before uploading a replacement.');

  // Make a wide source image; the app must center-crop it and save a bounded square JPEG.
  await evaluate(hostPage, async () => {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 256;
    const context = canvas.getContext('2d'); context.fillStyle = '#c84242'; context.fillRect(0,0,256,256);
    context.fillStyle = '#356dcc'; context.fillRect(256,0,256,256);
    context.fillStyle = '#36a85d'; context.fillRect(0,128,256,128);
    context.fillStyle = '#e7c34b'; context.fillRect(256,0,256,128);
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
  const presetAfterUpload = await evaluate(hostPage, () => ({
    pressed:[...document.querySelectorAll('#profile-photo-presets .avatar-preset')].some(button => button.getAttribute('aria-pressed') === 'true')
  }));
  assert(staged.width === 256 && staged.height === 256 && staged.type === 'image/jpeg' &&
    staged.size <= 256 * 1024 && staged.dataLength < 360000 && !presetAfterUpload.pressed,
    'The uploaded photo was not bounded or retained a stale preset selection: ' + JSON.stringify({staged,presetAfterUpload}));
  async function cropReady() {
    await wait(hostPage,()=>!document.querySelector('#profile-photo-save').disabled&&
      document.querySelector('#profile-photo-status').textContent.includes('ready to save')&&
      document.querySelector('#profile-photo-preview').classList.contains('has-avatar'));
  }
  async function cropPixel() {
    return evaluate(hostPage,()=>[...document.querySelector('#profile-photo-canvas').getContext('2d').getImageData(128,128,1,1).data]);
  }
  await input(hostPage,'#profile-photo-zoom',2);
  await input(hostPage,'#profile-photo-x',0);
  await input(hostPage,'#profile-photo-y',0);
  await cropReady();
  const redCrop=await cropPixel();
  assert(redCrop[0]>180&&redCrop[1]<90&&redCrop[2]<90,'Zoom/pan did not select the upper-left crop: '+redCrop);
  await input(hostPage,'#profile-photo-x',100);
  await input(hostPage,'#profile-photo-y',100);
  await cropReady();
  const blueCrop=await cropPixel();
  assert(blueCrop[2]>180&&blueCrop[0]<90,'Position controls did not select the lower-right crop: '+blueCrop);
  await evaluate(hostPage,()=>document.querySelector('#profile-photo-canvas').scrollIntoView({block:'center'}));
  await hostPage.bringToFront();
  const cropBox=await evaluate(hostPage,()=>{const r=document.querySelector('#profile-photo-canvas').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};});
  await hostPage.dragAt(cropBox.x,cropBox.y,cropBox.x+25,cropBox.y+25);
  await cropReady();
  const dragged=await evaluate(hostPage,()=>({x:Number(document.querySelector('#profile-photo-x').value),y:Number(document.querySelector('#profile-photo-y').value)}));
  assert(dragged.x<100&&dragged.y<100,'Dragging did not reposition the crop: '+JSON.stringify(dragged));
  await evaluate(hostPage,()=>document.querySelector('#profile-photo-canvas').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})));
  await cropReady();
  assert(await evaluate(hostPage,previous=>Number(document.querySelector('#profile-photo-x').value)<previous,dragged.x),
    'Keyboard repositioning did not move the crop.');
  await click(hostPage,'#profile-photo-reset');await cropReady();
  assert(await evaluate(hostPage,()=>document.querySelector('#profile-photo-zoom').value==='1'&&
    document.querySelector('#profile-photo-x').value==='50'&&document.querySelector('#profile-photo-y').value==='50'),
    'Reset crop did not restore the full centered photo.');
  await input(hostPage,'#profile-photo-zoom',2);
  await input(hostPage,'#profile-photo-x',0);
  await input(hostPage,'#profile-photo-y',0);
  await cropReady();
  await hostPage.resize(320,568);await sleep(150);
  await evaluate(hostPage,()=>document.querySelector('#profile-photo-y').scrollIntoView({block:'center'}));
  const mobileCrop=await evaluate(hostPage,()=>{
    const dialog=document.querySelector('#profile-photo-dialog'),close=document.querySelector('#profile-photo-close');
    const d=dialog.getBoundingClientRect(),c=close.getBoundingClientRect();
    return{overflow:dialog.scrollWidth>dialog.clientWidth+1,closeVisible:c.top>=d.top&&c.bottom<=d.bottom,
      zoom:document.querySelector('#profile-photo-zoom').value};
  });
  assert(!mobileCrop.overflow&&mobileCrop.closeVisible&&mobileCrop.zoom==='2',
    'The mobile crop dialog overflows or hides Close: '+JSON.stringify(mobileCrop));
  await hostPage.screenshot('profile-photo-editor-mobile');
  await hostPage.resize(800,600);await sleep(100);
  await hostPage.screenshot('profile-photo-preview');

  // Hold the response after the server accepts it; Close remains usable, and the late response is ignored.
  const postsBeforeDelayedSave = await evaluate(hostPage, () => window.__avatarCalls.posts.length);
  await evaluate(hostPage, () => { window.__holdNextAvatarSave = true; });
  await click(hostPage, '#profile-photo-save');
  await wait(hostPage, () => window.__avatarCalls.posts.some(post => post.held));
  const profilePost = await evaluate(hostPage, () => window.__avatarCalls.posts[window.__avatarCalls.posts.length - 1]);
  const savedPixel=await evaluate(hostPage,dataUrl=>new Promise((resolve,reject)=>{
    const image=new Image();image.onload=()=>{
      const canvas=document.createElement('canvas');canvas.width=canvas.height=256;
      const context=canvas.getContext('2d');context.drawImage(image,0,0);
      resolve([...context.getImageData(128,128,1,1).data]);
    };image.onerror=reject;image.src=dataUrl;
  }),profilePost.body.image_data);
  assert(savedPixel[0]>180&&savedPixel[1]<90&&savedPixel[2]<90,
    'The uploaded JPEG did not contain the chosen zoomed crop: '+savedPixel);
  const fullUploadMetrics = await evaluate(hostPage, body => new Promise((resolve,reject) => {
    const image=new Image(); image.onload=()=>resolve({width:image.naturalWidth,height:image.naturalHeight,
      type:body.full_image_data.split(',')[0],size:atob(body.full_image_data.split(',')[1]).length});
    image.onerror=reject; image.src=body.full_image_data;
  }), profilePost.body);
  assert(!Object.prototype.hasOwnProperty.call(profilePost.body, 'preset_id') &&
    profilePost.body.image_data.startsWith('data:image/jpeg;base64,') &&
    profilePost.body.image_data.length < 360000 && profilePost.body.full_image_data.startsWith('data:image/jpeg;base64,') &&
    fullUploadMetrics.width === 1024 && fullUploadMetrics.height === 1024 && fullUploadMetrics.size <= 1024 * 1024 &&
    profilePost.session && profilePost.csrf,
    'The avatar POST did not carry the bounded thumbnail/master JPEGs and authenticated mutation headers: ' +
      JSON.stringify(fullUploadMetrics));
  await click(hostPage, '#profile-photo-close');
  await wait(hostPage, () => document.querySelector('#profile-photo-dialog')?.open === false);
  await click(hostPage, '#profile-photo-button');
  await wait(hostPage, () => document.querySelector('#profile-photo-dialog')?.open === true);
  await evaluate(hostPage, () => { if (window.__releaseAvatarSave) window.__releaseAvatarSave(); });
  await sleep(250);
  const staleSaveIgnored = await evaluate(hostPage, () => ({open:document.querySelector('#profile-photo-dialog').open,
    saveDisabled:document.querySelector('#profile-photo-save').disabled,posts:window.__avatarCalls.posts.length}));
  assert(staleSaveIgnored.open && staleSaveIgnored.saveDisabled && staleSaveIgnored.posts === postsBeforeDelayedSave + 1,
    'A delayed save response changed the newly opened profile dialog: ' + JSON.stringify(staleSaveIgnored));

  // Reconnection restores the committed profile from the server and loads its protected bytes with session proof.
  await wait(hostPage, () => Boolean(window.__avatarCalls.posts.at(-1)?.response?.player?.avatar_full_url));
  const committedAvatarPost = await evaluate(hostPage, () => window.__avatarCalls.posts.at(-1));
  await hostPage.reload();
  await wait(hostPage, () => document.querySelector('#app-panel')?.hidden === false &&
    document.querySelector('#identity-avatar')?.classList.contains('has-avatar'));
  const savedFullUrl = String(committedAvatarPost.response?.player?.avatar_full_url || '');
  const persisted = await evaluate(hostPage, fullUrl => ({url:document.querySelector('#identity-avatar').dataset.avatarUrl,
    imageWidth:document.querySelector('#identity-avatar img').naturalWidth,fullUrl}), savedFullUrl);
  assert(persisted.url.includes('/poker/api/players/') && persisted.url.includes('/avatar?v=') &&
    persisted.fullUrl.includes('/avatar/full?v=') && persisted.imageWidth === 256,
    'The saved thumbnail/master did not persist or its protected image did not load after reconnect: ' + JSON.stringify(persisted));
  const unauthenticatedFull = await fetch(origin + persisted.fullUrl);
  assert(unauthenticatedFull.status === 401,
    'An unauthenticated request could read a private full-size player portrait.');

  // Open the real table route for both users. Host portrait must appear on the guest's opponent seat.
  const tableUrl = '/poker/table?table=' + encodeURIComponent(table.id);
  await evaluate(hostPage, path => window.location.assign(path), tableUrl);
  await wait(hostPage, () => !document.querySelector('#table-view')?.hidden &&
    document.querySelectorAll('#seat-grid .seat-card[data-player-id]').length === 2);
  await signIn(guestPage, guestName, guestPassword, tableUrl);
  await wait(guestPage, () => !document.querySelector('#table-view')?.hidden &&
    document.querySelectorAll('#seat-grid .seat-card[data-player-id]').length === 2);
  await installNetworkRecorder(guestPage);
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

  const overlayTriggerInfo = await evaluate(guestPage, id => {
    const trigger=document.querySelector('.seat-card[data-player-id="' + id + '"] .avatar-photo-trigger');
    return trigger && {fullUrl:trigger.dataset.avatarFullUrl,label:trigger.getAttribute('aria-label'),
      tag:trigger.tagName,tabIndex:trigger.tabIndex};
  }, host.player.id);
  assert(overlayTriggerInfo && overlayTriggerInfo.tag === 'BUTTON' && overlayTriggerInfo.tabIndex >= 0 &&
    overlayTriggerInfo.fullUrl.includes('/avatar/full?v=') && overlayTriggerInfo.label.includes(hostName),
    'Seat portrait is not an accessible full-image trigger: ' + JSON.stringify(overlayTriggerInfo));
  await evaluate(guestPage, id => document.querySelector('.seat-card[data-player-id="' + id + '"] .avatar-photo-trigger').focus(), host.player.id);
  await guestPage.pressEnter();
  await wait(guestPage, () => document.querySelector('#avatar-view-dialog')?.open === true);
  await sleep(500);
  const fullImageRequest = await evaluate(guestPage, async () => {
    const image=document.querySelector('#avatar-view-image');
    let imageDecode='';
    try { await image.decode(); } catch (error) { imageDecode=String(error && error.message || error); }
    const trigger=document.querySelector('.seat-card[data-player-id] .avatar-photo-trigger');
    const proof=JSON.parse(localStorage.getItem('sitngo.poker.session-proof.v1') || '{}').session_proof || '';
    const response=await fetch(trigger.dataset.avatarFullUrl,{headers:{'X-SitNgo-Session':proof}});
    const blob=await response.blob();
    let bitmap={};
    try {
      const decoded=await createImageBitmap(blob);
      bitmap={width:decoded.width,height:decoded.height};
      decoded.close();
    } catch (error) { bitmap={error:String(error && error.message || error)}; }
    return {
      dialogOpen:document.querySelector('#avatar-view-dialog').open,
      trigger:trigger.dataset.avatarFullUrl,
      sourceWidth:image.naturalWidth,
      imageHidden:image.hidden,
      imageComplete:image.complete,
      imageSource:image.src,
      imageDecode,
      status:document.querySelector('#avatar-view-status').textContent,
      probe:{status:response.status,type:blob.type,size:blob.size,bitmap},
      request:window.__avatarCalls.gets.find(item => item.url.includes('/avatar/full?v=')) || null
    };
  });
  assert(fullImageRequest.dialogOpen && fullImageRequest.sourceWidth === 1024 &&
    fullImageRequest.request?.status === 200 && fullImageRequest.request?.session &&
    fullImageRequest.request.url === overlayTriggerInfo.fullUrl,
    'The full portrait did not load at 1024px with the authenticated session proof: ' + JSON.stringify(fullImageRequest));
  await guestPage.pressEscape();
  await wait(guestPage, () => document.querySelector('#avatar-view-dialog')?.open === false);
  assert(await evaluate(guestPage, id => document.activeElement === document.querySelector('.seat-card[data-player-id="' + id + '"] .avatar-photo-trigger'), host.player.id),
    'Escape did not return focus to the seat portrait trigger.');
  await click(guestPage, '.seat-card[data-player-id="' + host.player.id + '"] .avatar-photo-trigger');
  await wait(guestPage, () => document.querySelector('#avatar-view-dialog')?.open === true);
  await guestPage.clickAt(1, 1);
  await wait(guestPage, () => document.querySelector('#avatar-view-dialog')?.open === false);
  await click(guestPage, '.seat-card[data-player-id="' + host.player.id + '"] .avatar-photo-trigger');
  await wait(guestPage, () => document.querySelector('#avatar-view-dialog')?.open === true);
  await click(guestPage, '#avatar-view-close');
  await wait(guestPage, () => document.querySelector('#avatar-view-dialog')?.open === false);

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
  await wait(hostPage,id=>document.querySelector('.seat-card[data-player-id="'+id+'"] .seat-avatar')?.classList.contains('has-avatar'),host.player.id);
  await hostPage.bringToFront();
  const stability=await evaluate(hostPage,async id=>{
    const selector='.seat-card[data-player-id="'+id+'"] .seat-avatar';
    const original=document.querySelector(selector),image=original.querySelector('img');
    const result={redraws:0,replacements:0,blankFrames:0};
    for(let n=0;n<24;n++){
      window.dispatchEvent(new Event('resize'));
      const current=document.querySelector(selector);
      result.redraws++;
      if(current!==original||current?.querySelector('img')!==image)result.replacements++;
      if(!current?.classList.contains('has-avatar')||!image.complete||!image.naturalWidth)result.blankFrames++;
      await new Promise(requestAnimationFrame);
    }
    return result;
  },host.player.id);
  assert(stability.redraws===24&&!stability.replacements&&!stability.blankFrames,
    'Gameplay redraws replace the decoded portrait or show fallback frames: '+JSON.stringify(stability));
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

  // Saved portraits are replaceable, with no removal control.
  await click(hostPage, '#table-menu > summary');
  await click(hostPage, '#profile-photo-menu-button');
  await wait(hostPage, () => document.querySelector('#profile-photo-dialog')?.open === true);
  assert(await evaluate(hostPage, () => !document.querySelector('#profile-photo-remove')),
    'A saved profile photo still has a removal control.');
  await click(hostPage, '#profile-photo-close');
  await hostPage.reload();
  await wait(hostPage, () => document.querySelector('#identity-avatar')?.classList.contains('has-avatar'));
  await guestPage.reload();
  await wait(guestPage, id => document.querySelector('.seat-card[data-player-id="' + id + '"] .seat-avatar')?.classList.contains('has-avatar'), host.player.id);

  // Edit login credentials and display name without changing the stable player identity.
  await evaluate(hostPage, path => window.location.assign(path), '/poker/lobby');
  await wait(hostPage, () => document.querySelector('#app-panel')?.hidden === false);
  await installNetworkRecorder(hostPage);
  const updatedUsername = (hostName.slice(0, 22) + 'Z').toLowerCase();
  const updatedDisplayName = ('Table ' + stamp).slice(0, 24);
  await click(hostPage, '#profile-account-button');
  await wait(hostPage, () => document.querySelector('#profile-account-dialog')?.open === true);
  await hostPage.resize(320, 568);
  const accountMobile = await evaluate(hostPage, () => {
    const dialog=document.querySelector('#profile-account-dialog');
    const close=document.querySelector('#profile-account-close');
    const save=document.querySelector('#profile-account-save');
    return {overflow:dialog.scrollWidth>dialog.clientWidth+1,
      closeHeight:close.getBoundingClientRect().height,saveHeight:save.getBoundingClientRect().height};
  });
  assert(!accountMobile.overflow && accountMobile.closeHeight >= 44 && accountMobile.saveHeight >= 44,
    'The account editor is not reachable on a narrow mobile screen: ' + JSON.stringify(accountMobile));
  await input(hostPage, '#profile-account-username', updatedUsername);
  await input(hostPage, '#profile-account-display-name', updatedDisplayName);
  await input(hostPage, '#profile-account-current-password', hostPassword);
  await input(hostPage, '#profile-account-new-password', 'x');
  assert(await evaluate(hostPage, () => document.querySelector('#profile-account-new-password').minLength) === 1,
    'The profile password field does not allow a one-character password.');
  await evaluate(hostPage, () => document.querySelector('#profile-account-form').requestSubmit());
  await wait(hostPage, () => document.querySelector('#profile-account-dialog')?.open === false);
  const accountSave = await evaluate(hostPage, () => window.__avatarCalls.profiles.at(-1));
  assert(accountSave.body.username === updatedUsername && accountSave.body.display_name === updatedDisplayName &&
    accountSave.body.current_password === hostPassword && accountSave.body.new_password === 'x',
    'The account editor did not send username, display name, current password, and one-character replacement.');
  const accountMe = await apiRequest('/me', host);
  assert(accountMe.player?.id === host.player.id && accountMe.player?.username === updatedUsername &&
    accountMe.player?.display_name === updatedDisplayName,
    'Editing account details changed the player identity or failed to persist: ' + JSON.stringify({expected:{
      id:host.player.id,username:updatedUsername,display_name:updatedDisplayName},actual:accountMe}));
  await hostPage.resize(800, 600);

  // A rejected account update keeps the dialog open and does not replace the session identity.
  await click(hostPage, '#profile-account-button');
  await wait(hostPage, () => document.querySelector('#profile-account-dialog')?.open === true);
  await input(hostPage, '#profile-account-username', guestName);
  await input(hostPage, '#profile-account-current-password', 'wrong-password');
  await input(hostPage, '#profile-account-new-password', '');
  await evaluate(hostPage, () => document.querySelector('#profile-account-form').requestSubmit());
  await wait(hostPage, () => !document.querySelector('#profile-account-error')?.hidden);
  const rejectedAccountEdit = await evaluate(hostPage, () => ({
    open:document.querySelector('#profile-account-dialog').open,
    error:document.querySelector('#profile-account-error').textContent,
    save:window.__avatarCalls.profiles.at(-1)
  }));
  assert(rejectedAccountEdit.open && rejectedAccountEdit.error && rejectedAccountEdit.save.response?.player?.username !== guestName,
    'A rejected username/password update did not remain reviewable: ' + JSON.stringify(rejectedAccountEdit));
  await click(hostPage, '#profile-account-close');
  await wait(hostPage, () => document.querySelector('#profile-account-dialog')?.open === false);
  const clearedCredentials = await evaluate(hostPage, () => ({
    current:document.querySelector('#profile-account-current-password').value,
    next:document.querySelector('#profile-account-new-password').value
  }));
  assert(!clearedCredentials.current && !clearedCredentials.next,
    'Closing the account editor retained password text.');

  await click(hostPage, '#logout-button');
  await wait(hostPage, () => document.querySelector('#login-panel')?.hidden === false);
  await signIn(hostPage, updatedUsername, 'x', '/poker/lobby');
  assert(await evaluate(hostPage, name => document.querySelector('#welcome-name').textContent === name, updatedDisplayName),
    'The account could not sign in with its new one-character password and edited username.');
  const regularAdminVisibility = await evaluate(hostPage, () => ({
    adminPanelHidden:document.querySelector('#admin-panel').hidden,
    adminFormHidden:document.querySelector('#admin-avatar-preset-form').closest('#admin-panel').hidden,
    accountVisible:!document.querySelector('#profile-account-button').hidden
  }));
  assert(regularAdminVisibility.adminPanelHidden && regularAdminVisibility.adminFormHidden && regularAdminVisibility.accountVisible,
    'A normal player can see admin portrait tools or cannot reach account editing: ' + JSON.stringify(regularAdminVisibility));
  await click(hostPage, '#logout-button');
  await wait(hostPage, () => document.querySelector('#login-panel')?.hidden === false);

  // A room admin can add a shared portrait; a normal player sees it on their next gallery open.
  await click(hostPage, '#admin-login-button');
  await evaluate(hostPage, () => document.querySelector('#login-form').requestSubmit());
  await wait(hostPage, () => document.querySelector('#admin-panel')?.hidden === false);
  const adminVisibility = await evaluate(hostPage, () => ({
    adminPanelVisible:!document.querySelector('#admin-panel').hidden,
    adminFormVisible:Boolean(document.querySelector('#admin-avatar-preset-form').offsetWidth),
    accountHidden:document.querySelector('#profile-account-button').hidden
  }));
  assert(adminVisibility.adminPanelVisible && adminVisibility.adminFormVisible && adminVisibility.accountHidden,
    'Admin catalog tools are not restricted to the admin room session: ' + JSON.stringify(adminVisibility));
  await installNetworkRecorder(hostPage);
  await wait(hostPage, () => document.querySelectorAll('#admin-avatar-catalog-list .admin-avatar-catalog-item').length >= 12);
  await input(hostPage, '#admin-avatar-preset-name', 'Aurora');
  await evaluate(hostPage, async () => {
    const canvas=document.createElement('canvas'); canvas.width=512; canvas.height=384;
    const context=canvas.getContext('2d');
    context.fillStyle='#375c93'; context.fillRect(0,0,512,384);
    context.fillStyle='#efbd73'; context.beginPath(); context.arc(240,175,92,0,Math.PI*2); context.fill();
    context.fillStyle='#873b61'; context.fillRect(0,280,512,104);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    const file=new File([blob],'aurora.png',{type:'image/png'});
    const transfer=new DataTransfer(); transfer.items.add(file);
    const input=document.querySelector('#admin-avatar-preset-file'); input.files=transfer.files;
    input.dispatchEvent(new Event('change',{bubbles:true}));
  });
  await evaluate(hostPage, () => document.querySelector('#admin-avatar-preset-form').requestSubmit());
  await wait(hostPage, () => window.__avatarCalls.adminPresets.length === 1 &&
    window.__avatarCalls.adminPresets[0].response?.avatar?.custom === true);
  const adminPreset = await evaluate(hostPage, () => window.__avatarCalls.adminPresets[0]);
  const adminImageBounds = await evaluate(hostPage, body => Promise.all([body.image_data,body.full_image_data].map(dataUrl =>
    new Promise((resolve,reject) => {
      const image=new Image(); image.onload=()=>resolve({width:image.naturalWidth,height:image.naturalHeight,
        size:atob(dataUrl.split(',')[1]).length,type:dataUrl.split(',')[0]});
      image.onerror=reject; image.src=dataUrl;
    })
  )), adminPreset.body);
  assert(adminPreset.body.name === 'Aurora' && adminPreset.status >= 200 && adminPreset.status < 300 &&
    adminImageBounds[0].width === 256 && adminImageBounds[0].height === 256 && adminImageBounds[0].size <= 256*1024 &&
    adminImageBounds[1].width === 1024 && adminImageBounds[1].height === 1024 && adminImageBounds[1].size <= 1024*1024,
    'The admin upload did not add a bounded shared thumbnail/master: ' + JSON.stringify(adminImageBounds));
  const customId = adminPreset.response.avatar.id;
  await evaluate(guestPage, path => window.location.assign(path), '/poker/lobby');
  await wait(guestPage, () => document.querySelector('#app-panel')?.hidden === false);
  await installNetworkRecorder(guestPage);
  await click(guestPage, '#profile-photo-button');
  await wait(guestPage, () => document.querySelector('#profile-photo-dialog')?.open === true);
  await wait(guestPage, id => Boolean(document.querySelector('[data-avatar-preset-id="' + id + '"]')), customId);
  const sharedCustom = await evaluate(guestPage, id => {
    const choice=document.querySelector('[data-avatar-preset-id="' + id + '"]');
    const image=choice && choice.querySelector('.avatar-preset-image img');
    return {label:choice?.getAttribute('aria-label'),url:choice?.querySelector('.avatar-preset-image')?.dataset.avatarUrl,
      loaded:Boolean(image?.naturalWidth),adminPanelHidden:document.querySelector('#admin-panel').hidden,
      accountVisible:!document.querySelector('#profile-account-button').hidden};
  }, customId);
  assert(sharedCustom.label === 'Choose Aurora avatar' && sharedCustom.loaded &&
    sharedCustom.adminPanelHidden && sharedCustom.accountVisible &&
    sharedCustom.url.includes('/poker/api/avatar-presets/' + customId + '/thumbnail?v='),
    'The shared admin portrait was not visible to a normal player through the protected catalog: ' + JSON.stringify(sharedCustom));
  await click(guestPage, '#profile-photo-close');

  // A new player without a portrait must save before a new table or seat action is sent.
  const creatorName = ('GateCreate' + stamp).slice(0, 24);
  const creatorPassword = 'FeltGateCreate_' + stamp + '_Pass';
  await apiRequest('/register', null, {room_password:roomPassword,username:creatorName,password:creatorPassword});
  await click(hostPage, '#admin-logout-button');
  await wait(hostPage, () => document.querySelector('#login-panel')?.hidden === false);
  await signIn(hostPage, creatorName, creatorPassword, '/poker/lobby');
  await installNetworkRecorder(hostPage);
  await evaluate(hostPage, () => { window.__photoOpenCalls = 0; window.open = () => { window.__photoOpenCalls++; return null; }; });
  await clickTrusted(hostPage, '#create-game-tab');
  await wait(hostPage, () => document.querySelector('#profile-photo-dialog')?.open === true);
  assert(await evaluate(hostPage, () => window.__avatarCalls.tableCreates.length === 0 && window.__photoOpenCalls === 0),
    'Creating a table opened a window or sent a request before the required portrait was saved.');
  await click(hostPage, '#profile-photo-close');
  await wait(hostPage, () => document.querySelector('#profile-photo-dialog')?.open === false);
  assert(await evaluate(hostPage, () => window.__avatarCalls.tableCreates.length === 0 && window.__photoOpenCalls === 0),
    'Canceling the create-game portrait gate still created a table or opened a window.');

  await clickTrusted(hostPage, '#create-game-tab');
  await wait(hostPage, () => document.querySelector('#profile-photo-dialog')?.open === true);
  await click(hostPage, '[data-avatar-preset-id="fish"]');
  await wait(hostPage, () => !document.querySelector('#profile-photo-save').disabled &&
    document.querySelector('#profile-photo-status').textContent.includes('ready to save'));
  await click(hostPage, '#profile-photo-save');
  await wait(hostPage, () => document.querySelector('#profile-photo-dialog')?.open === false &&
    window.__avatarCalls.tableCreates.length === 1 && window.__avatarCalls.tableCreates[0].status >= 200);
  const gatedCreate = await evaluate(hostPage, () => window.__avatarCalls.tableCreates[0]);
  const createdTableId = gatedCreate.response?.table?.id || gatedCreate.response?.id;
  assert(gatedCreate.body.name && createdTableId && gatedCreate.status < 300,
    'Saving the required portrait did not resume one new-table action: ' + JSON.stringify(gatedCreate));
  await wait(hostPage, () => document.querySelector('#popup-fallback')?.hidden === false);
  await clickTrusted(hostPage, '#popup-fallback-open');
  await wait(hostPage, id => !document.querySelector('#table-view')?.hidden &&
    new URLSearchParams(location.search).get('table') === id, createdTableId);

  const joinerName = ('GateSeat' + stamp).slice(0, 24);
  const joinerPassword = 'FeltGateSeat_' + stamp + '_Pass';
  const joiner = await apiRequest('/register', null, {room_password:roomPassword,username:joinerName,password:joinerPassword});
  await click(guestPage, '#logout-button');
  await wait(guestPage, () => document.querySelector('#login-panel')?.hidden === false);
  const gatedTableUrl = '/poker/table?table=' + encodeURIComponent(createdTableId);
  await signIn(guestPage, joinerName, joinerPassword, '/poker/lobby');
  await installNetworkRecorder(guestPage);
  await evaluate(guestPage, () => { window.__photoOpenCalls = 0; window.open = () => { window.__photoOpenCalls++; return null; }; });
  await click(guestPage, '[data-open-table="' + createdTableId + '"]');
  await wait(guestPage, () => document.querySelector('#profile-photo-dialog')?.open === true);
  assert(await evaluate(guestPage, () => window.__photoOpenCalls === 0 &&
    document.querySelector('#table-view').hidden && window.__avatarCalls.seats.length === 0),
    'A lobby game button opened a window or joined before a photo was saved.');
  await click(guestPage, '#profile-photo-close');
  assert(await evaluate(guestPage, () => window.__photoOpenCalls === 0 && document.querySelector('#table-view').hidden),
    'Canceling game entry opened a window.');
  await evaluate(guestPage, path => window.location.assign(path), gatedTableUrl);
  await wait(guestPage, () => location.pathname === '/poker/lobby' &&
    document.querySelector('#profile-photo-dialog')?.open === true && document.querySelector('#table-view').hidden);
  await installNetworkRecorder(guestPage);
  await evaluate(guestPage, () => { window.__failNextAvatarSave = true; });
  await click(guestPage, '[data-avatar-preset-id="fox"]');
  await wait(guestPage, () => !document.querySelector('#profile-photo-save').disabled &&
    document.querySelector('#profile-photo-status').textContent.includes('ready to save'));
  await click(guestPage, '#profile-photo-save');
  await wait(guestPage, () => !document.querySelector('#profile-photo-error')?.hidden);
  const failedSeatGate = await evaluate(guestPage, () => ({
    dialogOpen:document.querySelector('#profile-photo-dialog').open,
    error:document.querySelector('#profile-photo-error').textContent,
    seats:window.__avatarCalls.seats.length,
    avatarPosts:window.__avatarCalls.posts.length
  }));
  assert(failedSeatGate.dialogOpen && failedSeatGate.error && failedSeatGate.seats === 0 &&
    failedSeatGate.avatarPosts === 1,
    'A failed portrait save dispatched the pending seat action or hid its recoverable error: ' + JSON.stringify(failedSeatGate));
  await click(guestPage, '[data-avatar-preset-id="crab"]');
  await wait(guestPage, () => !document.querySelector('#profile-photo-save').disabled &&
    document.querySelector('#profile-photo-status').textContent.includes('ready to save'));
  await click(guestPage, '#profile-photo-save');
  await wait(guestPage, () => location.pathname === '/poker/table' &&
    !document.querySelector('#table-view')?.hidden && Boolean(document.querySelector('#seat-grid [data-take-seat]')));
  await installNetworkRecorder(guestPage);
  await click(guestPage, '#seat-grid [data-take-seat]');
  await wait(guestPage, () => window.__avatarCalls.seats.length === 1 &&
    window.__avatarCalls.seats[0].status >= 200 && !document.querySelector('#profile-photo-dialog')?.open);
  await wait(guestPage, id => Boolean(document.querySelector('.seat-card[data-player-id="' + id + '"]')), joiner.player.id);
  assert(await evaluate(guestPage, () => window.__avatarCalls.seats.length === 1 &&
    Boolean(document.querySelector('#identity-avatar').dataset.avatarUrl)),
    'The saved photo did not permit exactly one seat action.');

  console.log('12 real default portraits, preset and upload selection, bounded private 256/1024 JPEGs, shared admin portraits, account edits with one-character password, authenticated full-image viewing, stable seat DOM, replacement-only editing, and create/open/direct-link photo gates passed.');
}
