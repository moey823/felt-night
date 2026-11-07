// Focused player-display acceptance: original geometry, protected photos, persistent actions, and readable cards.
import {readFileSync, writeFileSync} from 'node:fs';
import {seedAvatar} from './avatar-fixture.mjs';

const viewports = [[1366,768],[390,844],[360,740],[320,568],[768,1024],[667,375],[844,390]];

export default async function playerDisplays([playerPage, secondPage], sleep, roomPassword) {
  const ev = (page, fn, ...args) => page.evaluate('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')');
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  async function wait(page, predicate, ...args) {
    for (let attempt = 0; attempt < 300; attempt++) {
      const value = await ev(page, predicate, ...args);
      if (value) return value;
      await sleep(100);
    }
    throw Error('Timed out: ' + predicate + ' ' + args + ' | ' + await ev(page, () => document.body.innerText.slice(-1200)));
  }
  async function until(predicate, label, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await sleep(100);
    }
    throw Error('Timed out waiting for ' + label);
  }

  const origin = await playerPage.evaluate('location.origin');
  const apiRoot = origin + '/poker/api';
  async function rawApi(path, session, body) {
    const headers = {Origin:origin};
    if (session) Object.assign(headers, {
      Cookie:session.cookie,
      'X-SitNgo-Session':session.session_proof,
      'X-SitNgo-CSRF':session.csrf,
    });
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(apiRoot + path, {
      method:body === undefined ? 'GET' : 'POST',
      headers,
      body:body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    return {response,status:response.status,ok:response.ok,data};
  }
  async function request(path, session, body) {
    const result = await rawApi(path,session,body);
    if (!result.ok) throw Error(path + ' ' + result.status + ' ' + JSON.stringify(result.data));
    return result.data.table || result.data;
  }
  async function createAccount(username,password) {
    const result = await rawApi('/register',null,{room_password:roomPassword,username,password});
    if (!result.ok) throw Error('/register ' + result.status + ' ' + JSON.stringify(result.data));
    const cookie = result.response.headers.get('set-cookie')?.split(';')[0];
    if (!cookie) throw Error('Registration did not issue a session cookie');
    const account = {...result.data,cookie,username,password};
    await seedAvatar(request,account);
    return account;
  }
  async function signIn(page,user,path) {
    await ev(page,next => window.location.assign(next),path);
    await wait(page,next => location.pathname + location.search === next,path);
    await wait(page,(username,password,invite) => {
      const form=document.querySelector('#login-form');
      const name=document.querySelector('#login-name'),passwordField=document.querySelector('#login-password');
      if(!form?.offsetWidth||!name?.offsetWidth||!passwordField?.offsetWidth)return false;
      name.value=username;
      passwordField.value=password;
      const roomPasswordField=document.querySelector('#room-password');
      if(roomPasswordField)roomPasswordField.value=invite;
      form.requestSubmit();
      return true;
    },user.username,user.password,roomPassword);
    await wait(page,() => document.querySelector('#app-panel')?.hidden === false);
    await wait(page,() => !document.querySelector('#table-view')?.hidden &&
      document.querySelectorAll('#seat-grid .seat-card[data-player-id]').length === 9);
  }
  async function makePortrait(page,seed) {
    return ev(page,value => {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext('2d');
      const hue = (value * 47 + 18) % 360;
      const bg = ctx.createLinearGradient(0,0,256,256);
      bg.addColorStop(0,'hsl(' + hue + ',52%,54%)');
      bg.addColorStop(1,'hsl(' + ((hue + 52) % 360) + ',44%,24%)');
      ctx.fillStyle = bg;
      ctx.fillRect(0,0,256,256);
      ctx.fillStyle = 'rgba(255,255,255,.16)';
      ctx.beginPath();
      ctx.arc(44 + (value * 19) % 170,52 + (value * 13) % 100,70,0,Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'hsl(' + ((hue + 180) % 360) + ',44%,29%)';
      ctx.beginPath();
      ctx.ellipse(128,254,94,79,0,0,Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#e3b58f';
      ctx.fillRect(110,167,36,50);
      ctx.beginPath();
      ctx.ellipse(128,119,62,75,0,0,Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'hsl(' + ((hue + 285) % 360) + ',28%,17%)';
      ctx.beginPath();
      ctx.ellipse(128,82,65,48,0,Math.PI,Math.PI * 2);
      ctx.lineTo(194,119);
      ctx.quadraticCurveTo(182,73,152,60);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#293239';
      ctx.beginPath();
      ctx.ellipse(105,119,5,7,0,0,Math.PI * 2);
      ctx.ellipse(151,119,5,7,0,0,Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#8b483d';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(128,145,18,.15,Math.PI - .15);
      ctx.stroke();
      return canvas.toDataURL('image/jpeg',.9);
    },seed);
  }
  async function uploadAvatar(user,imageData) {
    const saved = await request('/profile/avatar',user,{image_data:imageData});
    assert(saved.player?.avatar_url,'Protected avatar upload returned no URL for ' + user.username);
    return saved.player.avatar_url;
  }
  async function getView(path,user) { return request(path,user); }
  async function act(path,view,playersById,action,amount) {
    const actor = playersById.get(view.actor_id);
    assert(actor,'No session for actor ' + view.actor_id);
    const current = await getView(path,actor);
    assert(current.actor_id === actor.player.id && current.viewer?.can_act,
      'Expected actor ' + actor.player.id + ', got ' + current.actor_id);
    const payload = {action,expected_hand:current.hand_no,expected_turn_version:current.turn_version};
    if (amount !== undefined) payload.amount = amount;
    await request(path + '/action',actor,payload);
    const updated = await getView(path,actor);
    if (!updated.actor_id) return updated;
    const nextActor = playersById.get(updated.actor_id);
    assert(nextActor,'No session for next actor ' + updated.actor_id);
    return getView(path,nextActor);
  }
  async function openState(page,playerId,kind,requireTurn) {
    return wait(page,(id,actionKind,turn) => {
      const seat = [...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')]
        .find(node => node.dataset.playerId === id);
      if (!seat) return false;
      const action = seat.querySelector('.seat-action[data-action-seat]');
      const indicator = seat.querySelector('.seat-turn-indicator[data-turn-seat]');
      const acting = seat.classList.contains('is-acting');
      return action?.classList.contains('kind-' + actionKind) &&
        (!turn || (indicator && acting)) ? {
          action:action.textContent.trim(),
          indicator:indicator?.getAttribute('aria-label') || '',
          acting,centralHidden:(() => {const node=document.querySelector('#last-action-summary'); if(!node)return true; const style=getComputedStyle(node),r=node.getBoundingClientRect(); return node.hidden||style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0||r.width<=1||r.height<=1;})(),
        } : false;
    },playerId,kind,requireTurn);
  }
  async function captureGeometry(page,width,height) {
    await page.resize(width,height);
    await sleep(300);
    return ev(page,() => {
      const rect = node => {
        if (!node) return null;
        const r = node.getBoundingClientRect(), style = getComputedStyle(node);
        return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,
          display:style.display,visibility:style.visibility};
      };
      const selectors = [
        ['topbar','.topbar'],['tableHeading','.table-heading'],
        ['tableView','#table-view'],['tableSurface','#table-surface'],
        ['feltTopline','.felt-topline'],['felt','#felt'],['seatGrid','#seat-grid'],
        ['board','#felt .board-center'],['boardCards','#board-cards'],['pot','#pot-display'],
        ['blindStrip','#blind-strip'],['actionPanel','#action-panel'],['actionControls','#action-controls'],
      ];
      const parts = {};
      for (const [key,selector] of selectors) parts[key] = rect(document.querySelector(selector));
      parts.seats = [...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')]
        .map(node => ({relative:Number(node.dataset.relativeSeat),rect:rect(node)}))
        .sort((a,b) => a.relative - b.relative);
      parts.primaryActions = [...document.querySelectorAll('#action-controls .action-buttons [data-action-slot]')]
        .map(node => ({slot:node.dataset.actionSlot,rect:rect(node)}))
        .sort((a,b) => String(a.slot).localeCompare(String(b.slot)));
      const heroCards = [...document.querySelectorAll('#hero-seat .seat-cards.is-viewer-cards .mini-card')];
      const opponent = [...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')]
        .find(node => !node.classList.contains('is-me'));
      const layoutSize = node => ({width:node.offsetWidth,height:node.offsetHeight});
      parts.cardSizes = {
        hero:heroCards.map(node => layoutSize(node)),
        opponent:[...(opponent?.querySelectorAll('.seat-cards .mini-card') || [])].map(node => layoutSize(node)),
      };
      parts.avatars = [...document.querySelectorAll('#seat-grid .seat-card .seat-avatar')]
        .map(node => ({relative:Number(node.closest('.seat-card')?.dataset.relativeSeat),layout:layoutSize(node),rect:rect(node),
          loaded:node.classList.contains('has-avatar') && node.querySelector('img')?.naturalWidth === 256}))
        .sort((a,b) => a.relative - b.relative);
      const headerActions=rect(document.querySelector('#table-header-actions'));
      const inlineChatPresent=Boolean(document.querySelector('#chat-topline,#chat-preview,#chat-quick-form,#chat-quick-input'));
      const chatMenuButton=document.querySelector('#chat-button');
      const menuButtonRect=rect(document.querySelector('#table-menu > summary'));
      return {viewport:{width:innerWidth,height:innerHeight},scrollY,parts,headerActions,menuButtonRect,inlineChatPresent,
        chatMenuButtonInMenu:chatMenuButton?.closest('#table-menu')===document.querySelector('#table-menu')};
    });
  }
  function compareGeometry(baseline,actual) {
    const errors = [];
    const compareRect = (a,b,path) => {
      if (!a || !b) {
        if (a !== b) errors.push(path + ' missing/visibility mismatch');
        return;
      }
      for (const key of ['left','top','width','height']) {
        if (Math.abs(Number(a[key]) - Number(b[key])) > 1) errors.push(path + '.' + key + ' ' + a[key] + ' -> ' + b[key]);
      }
    };
    if (!baseline || baseline.viewport.width !== actual.viewport.width || baseline.viewport.height !== actual.viewport.height)
      return ['viewport mismatch'];
    // Removing the chat lane expands the felt upward by exactly its old height.
    // Keep horizontal geometry, control sizes, and all unrelated positions strict.
    baseline = JSON.parse(JSON.stringify(baseline));
    const reclaimed = Number(baseline.parts.chatTopline?.height || 0);
    const landscape = actual.viewport.height <= 450 && actual.viewport.width > actual.viewport.height;
    const smallPortrait = actual.viewport.width <= 340 && actual.viewport.height <= 600 && !landscape;
    const boardAnchor = landscape ? .46 : (smallPortrait ? .54 : .48);
    for (const key of ['tableSurface','felt','seatGrid']) {
      baseline.parts[key].top -= reclaimed;
      baseline.parts[key].height += reclaimed;
    }
    baseline.parts.blindStrip.top -= reclaimed;
    for (const key of ['board','boardCards','pot']) baseline.parts[key].top -= reclaimed * (1 - boardAnchor);
    if (landscape) {
      for (const key of ['actionPanel','actionControls']) baseline.parts[key].top -= reclaimed / 2;
      for (const row of baseline.parts.primaryActions || []) row.rect.top -= reclaimed / 2;
    }
    if (actual.scrollY !== 0) errors.push('page scrollY ' + actual.scrollY);
    for (const key of Object.keys(actual.parts)) {
      if (['seats','primaryActions','cardSizes','avatars','chatTopline','chatPreview','chatQuickForm'].includes(key)) continue;
      compareRect(baseline.parts[key],actual.parts[key],'parts.' + key);
    }
    const beforeSeats = baseline.parts.seats || [], afterSeats = actual.parts.seats || [];
    if (beforeSeats.length !== afterSeats.length) errors.push('seat count ' + beforeSeats.length + ' -> ' + afterSeats.length);
    for (const row of afterSeats) {
      const prior = beforeSeats.find(item => item.relative === row.relative);
      if (!prior) errors.push('missing baseline relative seat ' + row.relative);
      // Seat boxes intentionally grow; the board, dock and primary buttons retain their geometry.
    }
    const beforeActions = baseline.parts.primaryActions || [], afterActions = actual.parts.primaryActions || [];
    if (beforeActions.length !== afterActions.length) errors.push('primary action slot count ' + beforeActions.length + ' -> ' + afterActions.length);
    for (const row of afterActions) {
      const prior = beforeActions.find(item => item.slot === row.slot);
      if (!prior) errors.push('missing baseline action slot ' + row.slot);
      else compareRect(prior.rect,row.rect,'action.' + row.slot);
    }
    return errors;
  }
  function firstSize(list) { return (list || []).find(item => item && item.width > 0 && item.height > 0) || null; }
  function cardMetrics(snapshot) {
    return {avatar:firstSize(snapshot.parts.avatars.map(row=>row.layout||row.rect)),
      hero:firstSize((snapshot.parts.cardSizes.hero||[]).map(row=>row.layout||row.rect||row)),
      opponent:firstSize((snapshot.parts.cardSizes.opponent||[]).map(row=>row.layout||row.rect||row))};
  }
  async function checkSeatChildren(page) {
    return ev(page,() => {
      const errors=[];
      const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
      const visible=node=>{const s=getComputedStyle(node),r=node.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.width>0&&r.height>0;};
      const contains=(a,b)=>b.left>=a.left-1&&b.right<=a.right+1&&b.top>=a.top-1&&b.bottom<=a.bottom+1;
      const overlaps=(a,b)=>a.left<b.right-.5&&a.right>b.left+.5&&a.top<b.bottom-.5&&a.bottom>b.top+.5;
      const boardNode=document.querySelector('#felt .board-center'),board=boardNode&&visible(boardNode)?rect(boardNode):null;
      const seats=[...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')];
      for(let i=0;i<seats.length;i++)for(let j=i+1;j<seats.length;j++)
        if(overlaps(rect(seats[i]),rect(seats[j])))errors.push('seat boxes overlap: '+seats[i].dataset.seatNo+' / '+seats[j].dataset.seatNo);
      for(const seat of seats){
        const outer=rect(seat),seatNo=seat.dataset.seatNo||'';
        const children=[...seat.querySelectorAll('.seat-avatar,.seat-avatar img,.seat-cards .mini-card,.seat-action[data-action-seat],.seat-turn-indicator[data-turn-seat],.seat-turn-clock[data-turn-clock-seat],.seat-wager,.seat-blind-badge')].filter(visible);
        for(const child of children){
          const childBox=rect(child),label=child.className||child.tagName;
          if(!contains(outer,childBox)){
            const footer=seat.querySelector('.seat-footer');
            const overflow=[childBox.left<outer.left-1?'left':'',childBox.right>outer.right+1?'right':'',
              childBox.top<outer.top-1?'top':'',childBox.bottom>outer.bottom+1?'bottom':''].filter(Boolean).join(',');
            errors.push('seat '+seatNo+' child escaped '+overflow+': '+label+' seat='+JSON.stringify(outer)+
              ' child='+JSON.stringify(childBox)+' footer='+(footer?JSON.stringify(rect(footer)):'null'));
          }
          if(board&&overlaps(board,childBox))errors.push('seat '+seatNo+' child overlaps board: '+label+' '+JSON.stringify({board,child:childBox}));
          for(const other of seats)if(other!==seat&&overlaps(rect(other),childBox))errors.push('seat '+seatNo+' child overlaps another seat: '+label);
          if(child.matches('.mini-card:not(.back)'))for(const text of child.querySelectorAll('.mini-rank,.mini-suit')){
            if(visible(text)&&!contains(childBox,rect(text)))errors.push('seat '+seatNo+' card text escaped its face: '+text.className);
            if(text.clientWidth>0&&text.scrollWidth>text.clientWidth+1)errors.push('seat '+seatNo+' card text clipped: '+text.className);
          }
          if(child.matches('.seat-action[data-action-seat]'))for(const text of child.querySelectorAll('.seat-action-verb,.seat-action-value')){
            if(visible(text)&&!contains(childBox,rect(text)))errors.push('seat '+seatNo+' action text escaped its badge: '+text.className);
            if(text.clientWidth>0&&text.scrollWidth>text.clientWidth+1)errors.push('seat '+seatNo+' action text clipped: '+text.className);
          }
          if(child.matches('.seat-wager')){const value=child.querySelector('strong');if(value&&value.clientWidth>0&&value.scrollWidth>value.clientWidth+1)errors.push('seat '+seatNo+' wager text clipped');}
          if(child.matches('.seat-turn-clock')){
            const clockFont=parseFloat(getComputedStyle(child).fontSize);
            if(clockFont<9)errors.push('seat '+seatNo+' turn clock font below 9px: '+clockFont);
            if(child.clientWidth>0&&child.scrollWidth>child.clientWidth+1)errors.push('seat '+seatNo+' turn clock text clipped');
          }
        }
        const cardRow=seat.querySelector('.seat-cards');
        if(cardRow&&visible(cardRow)){
          const rowBox=rect(cardRow);
          if(!contains(outer,rowBox))errors.push('seat '+seatNo+' card row escaped seat: '+JSON.stringify({seat:outer,row:rowBox}));
          if(board&&overlaps(board,rowBox))errors.push('seat '+seatNo+' card row overlaps board: '+JSON.stringify({row:rowBox,board}));
          for(const other of seats)if(other!==seat&&overlaps(rect(other),rowBox))
            errors.push('seat '+seatNo+' card row overlaps another seat: '+JSON.stringify({row:rowBox,other:rect(other)}));
          for(const selector of ['.seat-top','.seat-player-info','.seat-footer']){
            const sibling=seat.querySelector(selector);
            if(sibling&&visible(sibling)&&overlaps(rowBox,rect(sibling)))
              errors.push('seat '+seatNo+' card row overlaps '+selector+': '+JSON.stringify({row:rowBox,sibling:rect(sibling)}));
          }
        }
        const avatar=seat.querySelector('.seat-avatar'),stack=seat.querySelector('.seat-stack'),name=seat.querySelector('.seat-name');
        if(avatar&&stack&&visible(avatar)&&visible(stack)&&overlaps(rect(avatar),rect(stack)))errors.push('seat '+seatNo+' avatar overlaps stack');
        if(avatar&&name&&visible(avatar)&&visible(name)&&overlaps(rect(avatar),rect(name)))errors.push('seat '+seatNo+' avatar overlaps name');
        const critical=[name,stack,seat.querySelector('.seat-status,.seat-detail-text')].filter(node=>node&&visible(node));
        for(const text of critical)if(board&&overlaps(board,rect(text)))
          errors.push('seat '+seatNo+' text obscures board: '+text.className);
        const markers=[...seat.querySelectorAll('.seat-action[data-action-seat],.seat-turn-indicator[data-turn-seat],.seat-turn-clock[data-turn-clock-seat],.seat-wager')].filter(visible);
        for(const marker of markers)for(const text of critical)if(marker!==text&&overlaps(rect(marker),rect(text)))
          errors.push('seat '+seatNo+' marker obscures '+(text.className||text.tagName));
        if(name&&visible(name)){
          if(name.scrollWidth>name.clientWidth+1)errors.push('seat '+seatNo+' name clipped');
          const compactLandscape=innerHeight<=450&&innerWidth>innerHeight;
          const minNameFont=innerWidth>820&&!compactLandscape?12:11;
          const nameFont=parseFloat(getComputedStyle(name).fontSize);
          if(nameFont<minNameFont)errors.push('seat '+seatNo+' name font below '+minNameFont+'px: '+nameFont);
        }
      }
      return {errors,seats:seats.length};
    });
  }
  async function readableCards(page,ids) {
    return ev(page,playerIds => {
      const suits = String.fromCharCode(9824,9829,9830,9827);
      return playerIds.map(id => {
        const seat = [...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')]
          .find(node => node.dataset.playerId === id);
        if (!seat) return {id,missing:true};
        const cards = [...seat.querySelectorAll('.seat-cards .mini-card:not(.back)')].map(card => {
          const rankNode = card.querySelector('.mini-rank'), suitNode = card.querySelector('.mini-suit');
          const r = card.getBoundingClientRect();
          return {rank:rankNode?.textContent.trim() || '',suit:suitNode?.textContent.trim() || '',
            label:card.getAttribute('aria-label'),width:card.offsetWidth,height:card.offsetHeight,
            rankSize:parseFloat(getComputedStyle(rankNode).fontSize),
            suitSize:parseFloat(getComputedStyle(suitNode).fontSize),
            visible:r.width > 0 && r.height > 0 && Boolean(rankNode?.textContent.trim()) && suits.includes(suitNode?.textContent.trim() || '')};
        });
        return {id,count:cards.length,cards};
      });
    },ids);
  }

  const stamp = Date.now().toString(36).slice(-5);
  const givenNames = ['Ava','Ben','Cleo','Drew','Ezra','Faye','Gray','Hope','Iris'];
  const players = [];
  for (let i = 0; i < 9; i++) {
    const username = givenNames[i];
    players.push(await createAccount(username,'DisplayPass_' + stamp + '_' + i));
  }
  const playersById = new Map(players.map(player => [player.player.id,player]));
  for (let i = 0; i < players.length; i++) {
    const image = await makePortrait(playerPage,i + 1);
    assert(image.startsWith('data:image/jpeg;base64,'),'Generated photo was not JPEG.');
    players[i].avatarUrl = await uploadAvatar(players[i],image);
  }
  const adminLogin=await rawApi('/login',null,{username:'admin',password:''});
  assert(adminLogin.ok,'Disposable test admin login failed: '+JSON.stringify(adminLogin.data));
  const adminCookie=adminLogin.response.headers.get('set-cookie')?.split(';')[0];
  assert(adminCookie,'Disposable test admin did not receive a session cookie.');
  const admin={...adminLogin.data,cookie:adminCookie};
  await request('/admin/config',admin,{runout_seconds:1,showdown_seconds:20});
  const table = await request('/tables',players[0],{
    name:'Display QA ' + stamp,starting_stack:2000,small_blind:10,big_blind:20,
    level_minutes:60,turn_seconds:3600,buy_in:10,payout_percentages:[60,25,15],
  });
  const tablePath = '/tables/' + table.id;
  for (let i = 1; i < players.length; i++) await request(tablePath + '/seat',players[i],{seat_no:i});
  const started = await request(tablePath + '/start',players[0],{});
  assert(started.status === 'playing' && started.seats?.length === 9,
    'Could not start a real nine-player table: ' + JSON.stringify(started));
  const initialActor = playersById.get(started.actor_id);
  assert(initialActor,'Initial actor is not a registered player.');
  const route = '/poker/table?table=' + encodeURIComponent(table.id);
  await signIn(playerPage,initialActor,route);
  await playerPage.resize(1366,768);
  await wait(playerPage,() => !document.querySelector('#action-panel')?.hidden &&
    document.querySelectorAll('#seat-grid .seat-card[data-player-id]').length === 9);
  await wait(playerPage,() => {
    const avatars = [...document.querySelectorAll('#seat-grid .seat-card .seat-avatar')];
    return avatars.length === 9 && avatars.every(node => node.classList.contains('has-avatar') &&
      node.querySelector('img')?.naturalWidth === 256);
  });
  await wait(playerPage,() => {
    const cards = [...document.querySelectorAll('#hero-seat .seat-cards.is-viewer-cards .mini-card')];
    return cards.length === 2 && cards.every(node => /^[2-9TJQKA]+ .$/.test(node.getAttribute('aria-label') || ''));
  });

  async function blindBadges(page, expected) {
    return wait(page, count => {
      const badges=[...document.querySelectorAll('#seat-grid .seat-blind-badge')];
      return badges.length===count ? badges.map(node=>({
        text:node.textContent,player:node.closest('.seat-card').dataset.playerId,
        font:parseFloat(getComputedStyle(node).fontSize),
      })) : false;
    }, expected);
  }
  const positions=await blindBadges(playerPage,2);
  assert(positions.some(row=>row.text==='Small blind'&&row.player===started.small_blind_id)&&
    positions.some(row=>row.text==='Big blind'&&row.player===started.big_blind_id),
    'Preflop blind badges do not identify the actual blind players: '+JSON.stringify(positions));
  const geometry = {};
  for (const [width,height] of viewports) {
    const key=width+'x'+height;
    geometry[key]=await captureGeometry(playerPage,width,height);
    const snapshot=geometry[key], header=snapshot.headerActions, menu=snapshot.menuButtonRect;
    assert(!snapshot.inlineChatPresent && snapshot.chatMenuButtonInMenu &&
      header && header.width>0 && header.left>=0 && header.right<=width+1 &&
      header.top>=0 && header.bottom<=height+1 && menu &&
      menu.left>=header.left-1 && menu.right<=header.right+1 &&
      menu.top>=header.top-1 && menu.bottom<=header.bottom+1,
    'Table controls must stay contained beside Menu, with chat accessible from the menu only, at '+
      key+': '+JSON.stringify({header,menu,inlineChatPresent:snapshot.inlineChatPresent,chatMenuButtonInMenu:snapshot.chatMenuButtonInMenu}));
    if(process.env.PLAYER_DISPLAY_BASELINE_CAPTURE!=='1'){
      if(['1366x768','390x844','320x568','667x375'].includes(key))
        await playerPage.screenshot('player-displays-'+key);
      const containment=await checkSeatChildren(playerPage);

      assert(!containment.errors.length,'Seat child containment failed at '+key+': '+containment.errors.slice(0,12).join('; '));
    }
  }
  const baselinePath = process.env.PLAYER_DISPLAY_BASELINE_FILE || '/private/tmp/felt-player-displays-baseline.json';
  if (process.env.PLAYER_DISPLAY_BASELINE_CAPTURE === '1') {
    writeFileSync(baselinePath,JSON.stringify({revision:'837201f',geometry},null,2) + '\n');
    console.log('Captured original 837201f player/table geometry at ' + baselinePath);
    return;
  }

  const baselineSource = process.env.PLAYER_DISPLAY_BASELINE_FILE || new URL('./fixtures/player-displays-baseline-837201f.json',import.meta.url);
  const baseline = JSON.parse(readFileSync(baselineSource,'utf8'));
  const geometryErrors = [];
  for (const [width,height] of viewports) {
    const key = width + 'x' + height;
    geometryErrors.push(...compareGeometry(baseline.geometry?.[key],geometry[key]).map(error => key + ': ' + error));
  }
  assert(!geometryErrors.length,'Player/table geometry changed beyond the removed chat lane: ' +
    geometryErrors.slice(0,30).join('; '));

  assert(geometry['1366x768'].parts.primaryActions.length === 3 &&
    geometry['1366x768'].parts.primaryActions.every(row => row.rect.width > 0 && row.rect.height > 0),
    'Geometry comparison did not capture all three visible primary action slots.');
  const growth = {};
  for (const viewportKey of ['1366x768','390x844']) {
    const before = cardMetrics(baseline.geometry[viewportKey]);
    const after = cardMetrics(geometry[viewportKey]);
    growth[viewportKey] = {};
    for (const key of ['avatar','hero','opponent']) {
      const areaRatio = before[key] && after[key] ?
        (after[key].width * after[key].height) / (before[key].width * before[key].height) : 0;
      growth[viewportKey][key] = {before:before[key],after:after[key],areaRatio:+areaRatio.toFixed(2)};
      assert(before[key] && after[key] && after[key].width >= before[key].width &&
        after[key].height >= before[key].height && areaRatio >= 1.25,
        key + ' did not materially grow from 837201f at ' + viewportKey + ': ' + JSON.stringify(growth[viewportKey][key]));
    }
  }
  assert(geometry['1366x768'].parts.avatars.length === 9 &&
    geometry['1366x768'].parts.avatars.every(row => row.loaded),
    'The protected JPEG portraits did not render on every seat.');

  const ownCards = await readableCards(playerPage,[initialActor.player.id]);
  assert(ownCards.length === 1 && ownCards[0].count === 2 &&
    ownCards[0].cards.every(card => card.visible && card.label && card.rankSize >= 9 && card.suitSize >= 9),
    'The viewer rank/suit text is not legible: ' + JSON.stringify(ownCards));

  const centralHidden = await ev(playerPage,() => {
    const node = document.querySelector('#last-action-summary');
    if (!node) return true;
    const style = getComputedStyle(node), rect = node.getBoundingClientRect();
    return node.hidden || style.display === 'none' || style.visibility === 'hidden' ||
      Number(style.opacity) === 0 || rect.width <= 1 || rect.height <= 1;
  });
  assert(centralHidden,'The center last-action message is still visible.');

  // Reach a real flop with ordinary player calls and checks.
  let view = await getView(tablePath,initialActor);
  for (let step = 0; view.street === 'preflop' && step < 12; step++) {
    const actor = playersById.get(view.actor_id);
    assert(actor,'No session for preflop actor ' + view.actor_id);
    view = await act(tablePath,view,playersById,Number(view.viewer?.to_call || 0) > 0 ? 'call' : 'check');
    if(actor.player.id===started.small_blind_id && view.street==='preflop'){
      const blindActed=id=>{
        const seat=[...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')].find(node=>node.dataset.playerId===id);
        return seat?.querySelector('.seat-blind-badge')?.textContent==='Small blind'&&
          Boolean(seat.querySelector('.seat-action.kind-call'));
      };
      await wait(playerPage,blindActed,started.small_blind_id);
      await playerPage.reload();
      await wait(playerPage,blindActed,started.small_blind_id);
    }
  }
  await blindBadges(playerPage,0);
  assert(view.street === 'flop','The nine-player hand did not reach a flop: ' +
    JSON.stringify({street:view.street,actor:view.actor_id}));

  await wait(playerPage,()=>[...document.querySelectorAll('#seat-grid .seat-avatar')].every(node=>
    node.classList.contains('has-avatar')&&node.querySelector('img')?.naturalWidth===256));
  await ev(playerPage,()=>{
    const grid=document.querySelector('#seat-grid');
    const originals=new Map([...grid.querySelectorAll('.seat-card[data-player-id]')].map(seat=>
      [seat.dataset.playerId,seat.querySelector('.seat-avatar')]));
    window.__portraitStability={redraws:0,replacements:0,blankPortraits:0};
    window.__portraitObserver=new MutationObserver(()=>{
      const result=window.__portraitStability;result.redraws++;
      for(const seat of grid.querySelectorAll('.seat-card[data-player-id]')){
        const avatar=seat.querySelector('.seat-avatar');
        if(avatar!==originals.get(seat.dataset.playerId))result.replacements++;
        if(!avatar?.classList.contains('has-avatar')||!avatar.querySelector('img')?.naturalWidth)result.blankPortraits++;
      }
    });
    window.__portraitObserver.observe(grid,{childList:true});
  });

  const aId = view.actor_id;
  const afterBet = await act(tablePath,view,playersById,'bet',40);
  const bId = afterBet.actor_id;
  assert(bId && bId !== aId,'Could not identify the next player after Bet.');
  const afterCall = await act(tablePath,afterBet,playersById,'call');
  const cId = afterCall.actor_id;
  assert(cId && cId !== aId && cId !== bId,'Could not identify the next player after Call.');
  const afterRaise = await act(tablePath,afterCall,playersById,'raise',80);
  let returning = afterRaise;
  let folds = 0;
  while (returning.actor_id !== aId && folds < 8) {
    assert(returning.actor_id !== bId && returning.actor_id !== cId,
      'A previous caller came up before the original bettor.');
    returning = await act(tablePath,returning,playersById,'fold');
    folds++;
  }
  assert(returning.actor_id === aId && folds <= 6,'The raise did not return to the original bettor.');

  const actionPage = secondPage;
  await signIn(actionPage,playersById.get(aId),route);
  const aBet = await openState(actionPage,aId,'bet',true);
  assert(aBet.centralHidden && /BET/i.test(aBet.action) && aBet.indicator,
    'Re-raise turn state erased the original Bet badge: ' + JSON.stringify(aBet));
  const cRaise = await wait(actionPage,id => {
    const seat = [...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')]
      .find(node => node.dataset.playerId === id);
    const badge = seat?.querySelector('.seat-action.kind-raise');
    return badge?.textContent.trim() || false;
  },cId);
  assert(/RAISE/i.test(cRaise),'The raiser action is not readable: ' + cRaise);

  await act(tablePath,returning,playersById,'call');
  const aCall = await openState(actionPage,aId,'call',false);
  assert(aCall.centralHidden && /CALL/i.test(aCall.action),
    'The original Bet badge was not replaced by Call: ' + JSON.stringify(aCall));
  const bCall = await wait(actionPage,id => {
    const seat = [...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')]
      .find(node => node.dataset.playerId === id);
    const badge = seat?.querySelector('.seat-action.kind-call');
    const turn = seat?.querySelector('.seat-turn-indicator[data-turn-seat]');
    return badge && turn && seat.classList.contains('is-acting') ? {
      action:badge.textContent.trim(),
      centralHidden:(() => {const node=document.querySelector('#last-action-summary'); if(!node)return true; const style=getComputedStyle(node),r=node.getBoundingClientRect(); return node.hidden||style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0||r.width<=1||r.height<=1;})(),
    } : false;
  },bId);
  assert(bCall.centralHidden && /CALL/i.test(bCall.action),
    'The prior caller action disappeared while that player still owed a response: ' + JSON.stringify(bCall));

  await wait(actionPage,id => {
    const seat = [...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')]
      .find(node => node.dataset.playerId === id);
    return seat?.querySelector('.seat-action.kind-raise') &&
      (() => {const node=document.querySelector('#last-action-summary'); if(!node)return true; const style=getComputedStyle(node),r=node.getBoundingClientRect(); return node.hidden||style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0||r.width<=1||r.height<=1;})();
  },cId);
  await actionPage.reload();
  await wait(actionPage,() => !document.querySelector('#table-view')?.hidden &&
    document.querySelectorAll('#seat-grid .seat-card[data-player-id]').length === 9);
  const restored = await wait(actionPage,(a,b,c) => {
    const seatFor = id => [...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')]
      .find(node => node.dataset.playerId === id);
    const aCallNode = seatFor(a)?.querySelector('.seat-action.kind-call');
    const bCallNode = seatFor(b)?.querySelector('.seat-action.kind-call');
    const cRaiseNode = seatFor(c)?.querySelector('.seat-action.kind-raise');
    if (!aCallNode || !bCallNode || !cRaiseNode) return false;
    return {
      a:aCallNode.textContent.trim(),
      b:bCallNode.textContent.trim(),
      c:cRaiseNode.textContent.trim(),
      centralHidden:(() => {const node=document.querySelector('#last-action-summary'); if(!node)return true; const style=getComputedStyle(node),r=node.getBoundingClientRect(); return node.hidden||style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0||r.width<=1||r.height<=1;})(),
    };
  },aId,bId,cId);
  assert(restored.centralHidden && /CALL/i.test(restored.a) && /CALL/i.test(restored.b) &&
    /RAISE/i.test(restored.c),'Reconnect did not restore latest actions: ' + JSON.stringify(restored));
  await wait(actionPage,() => {
    const avatars=[...document.querySelectorAll('#seat-grid .seat-card .seat-avatar')];
    return avatars.length===9 && avatars.every(node=>node.classList.contains('has-avatar')&&node.querySelector('img')?.naturalWidth===256);
  });
  for(const [w,h] of viewports){
    await actionPage.resize(w,h);await sleep(200);
    const result=await checkSeatChildren(actionPage);
    assert(!result.errors.length,'Action containment at '+w+'x'+h+': '+result.errors.slice(0,12).join('; '));
    const badges=await ev(actionPage,()=>[...document.querySelectorAll('.seat-action.kind-raise,.seat-action.kind-bet')].map(node=>({
      font:parseFloat(getComputedStyle(node).fontSize),background:getComputedStyle(node).backgroundColor,text:node.textContent,
    })));
    assert(badges.length&&badges.every(row=>row.font>=10&&row.background==='rgb(245, 207, 121)'),
      'Aggressive actions lack readable emphasis: '+JSON.stringify(badges));
  }
  await actionPage.resize(1366,768); await sleep(250); await actionPage.screenshot('player-displays-actions-desktop-1366x768');
  await actionPage.resize(390,844); await sleep(250); await actionPage.screenshot('player-displays-actions-phone-390x844');

  const livePortraits=await wait(playerPage,()=>window.__portraitStability?.redraws>=2?window.__portraitStability:false);
  assert(!livePortraits.replacements&&!livePortraits.blankPortraits,
    'Live calls/raises replaced loaded portraits or showed fallbacks: '+JSON.stringify(livePortraits));
  await ev(playerPage,()=>window.__portraitObserver.disconnect());

  const beforeClose = await getView(tablePath,playersById.get(bId));
  assert(beforeClose.actor_id === bId && beforeClose.street === 'flop',
    'The prior caller did not get a chance to respond to the raise.');
  const afterBCall = await act(tablePath,beforeClose,playersById,'call');
  assert(afterBCall.street !== 'flop','The final call did not close the betting round.');
  await wait(actionPage,() => /TURN/i.test(document.querySelector('#street-label')?.textContent || '') &&
    document.querySelectorAll('#seat-grid .seat-action[data-action-seat]').length === 0);
  assert(await ev(actionPage,() => {
    const node = document.querySelector('#last-action-summary');
    if (!node) return true;
    const style = getComputedStyle(node), rect = node.getBoundingClientRect();
    return node.hidden || style.display === 'none' || style.visibility === 'hidden' ||
      Number(style.opacity) === 0 || rect.width <= 1 || rect.height <= 1;
  }),
    'The center action message appeared after street advance.');

  // Give A an actual all-in turn, then one opponent calls and the last opponent folds.
  let turnView=await getView(tablePath,playersById.get(afterBCall.actor_id));
  for(let step=0;turnView.street==='turn'&&turnView.actor_id!==aId&&step<3;step++)
    turnView=await act(tablePath,turnView,playersById,'check');
  assert(turnView.street==='turn'&&turnView.actor_id===aId,'Could not return turn action to the original bettor.');
  const allInActorId=turnView.actor_id;
  const afterAllIn=await act(tablePath,turnView,playersById,'all_in');
  const allInSeatNow=(afterAllIn.seats||[]).find(seat=>[seat.id,seat.player_id].some(id=>String(id)===String(allInActorId)));
  assert(allInSeatNow&&(allInSeatNow.all_in||allInSeatNow.is_all_in)&&Number(allInSeatNow.stack)===0,
    'The actual acting player was not marked all-in immediately after the action: '+JSON.stringify({allInActorId,
      seats:(afterAllIn.seats||[]).map(seat=>({id:seat.id,player_id:seat.player_id,all_in:seat.all_in,
        is_all_in:seat.is_all_in,stack:seat.stack,status:seat.status}))}));
  const allInStatus=await wait(actionPage,id=>{
    const seat=[...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')]
      .find(node=>node.dataset.playerId===id);
    const status=seat?.querySelector('.seat-status,.seat-detail-text');
    return status&&/ALL[\s-]*IN/i.test(status.textContent)?status.textContent.trim():false;
  },allInActorId);
  assert(/ALL[\s-]*IN/i.test(allInStatus),'The ongoing all-in status was not visible on its player seat: '+allInStatus);
  const callerId=afterAllIn.actor_id;
  assert(callerId&&callerId!==allInActorId,'The all-in did not give an opponent a response.');
  let afterAllInCall=await act(tablePath,afterAllIn,playersById,'call');
  let foldResponseId='';
  if(afterAllInCall.actor_id){
    foldResponseId=afterAllInCall.actor_id;
    assert(foldResponseId!==aId&&foldResponseId!==callerId,'Unexpected response to the all-in.');
    afterAllInCall=await act(tablePath,afterAllInCall,playersById,'fold');
  }
  const showdown=await until(async()=>{
    const current=await getView(tablePath,playersById.get(aId));
    return current.street==='showdown'?current:false;
  },'real all-in showdown');
  const showdownIds=(showdown.showdown||[]).map(row=>row.player_id);
  const allInIds=(showdown.seats||[]).filter(seat=>(seat.all_in||seat.is_all_in)&&Number(seat.stack)===0)
    .map(seat=>seat.player_id||seat.id);
  await actionPage.reload();
  await wait(actionPage,() => !document.querySelector('#table-view')?.hidden &&
    document.querySelectorAll('#seat-grid .seat-card[data-player-id]').length === 9);
  await wait(actionPage,(ids,viewerId)=>ids.every(id=>{
    const seat=[...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')]
      .find(node=>node.dataset.playerId===id);
    const cardRow=seat?.querySelector(id===viewerId?'.seat-cards.is-viewer-cards':'.seat-cards.is-exposed');
    return cardRow?.querySelectorAll('.mini-card:not(.back)').length===2;
  }),showdownIds,aId);
  const allInFallback=await wait(actionPage,ids=>ids.map(id=>{
    const seat=[...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')]
      .find(node=>node.dataset.playerId===id);
    const status=seat?.querySelector('.seat-status,.seat-detail-text');
    const style=status&&getComputedStyle(status),box=status&&status.getBoundingClientRect();
    return {id,detail:status?.textContent.trim()||'',
      statusVisible:Boolean(status&&style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)!==0&&box.width>0&&box.height>0),
      badge:Boolean(seat?.querySelector('.seat-action[data-action-seat]'))};
  }),allInIds);
  assert(allInFallback.every(row=>row.detail&&row.statusVisible&&!row.badge),
    'A remaining zero-stack player lost its readable status or retained a stale action at showdown: '+JSON.stringify(allInFallback));
  const showdownErrors=[];
  for(const [w,h] of viewports){
    await actionPage.resize(w,h);await sleep(200);
    const result=await checkSeatChildren(actionPage);
    showdownErrors.push(...result.errors.map(error=>w+'x'+h+': '+error));
    await actionPage.screenshot('player-displays-showdown-'+w+'x'+h);
  }
  assert(!showdownErrors.length,'Showdown cards or markers escaped their seats: '+showdownErrors.slice(0,20).join('; '));
  const exposedCards = await readableCards(actionPage,showdownIds);
  assert(showdownIds.includes(aId)&&showdownIds.includes(callerId)&&
    exposedCards.length===showdownIds.length&&exposedCards.length>=2&&exposedCards.every(row=>row.count===2&&
      row.cards.every(card=>card.visible&&card.label&&card.rankSize>=8&&card.suitSize>=8)),
    'An own/opponent showdown rank or suit is unreadable: '+JSON.stringify({showdownIds,exposedCards}));

  const finishedHand = showdown.hand_no;
  const nextHand = await until(async () => {
    const next = await getView(tablePath,playersById.get(aId));
    return next.hand_no > finishedHand ? next.hand_no : false;
  },'next hand');
  await wait(actionPage,() => !document.querySelector('#table-view')?.hidden &&
    document.querySelectorAll('#seat-grid .seat-card[data-player-id]').length === 9);
  const oldActionIds=[...new Set([aId,bId,cId,callerId,foldResponseId].filter(Boolean))];
  const cleared=await wait(actionPage,(hand,ids)=>{
    const stale=[];
    for(const id of ids){
      const seat=[...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')].find(node=>node.dataset.playerId===id);
      if(seat&&seat.querySelector('.seat-action.kind-bet,.seat-action.kind-call,.seat-action.kind-raise,.seat-action.kind-fold,.seat-action.kind-all_in'))stale.push(id);
    }
    return !stale.length&&(document.querySelector('#hand-number')?.textContent||'').includes(String(hand))?{hand,stale}:false;
  },nextHand,oldActionIds);
  assert(!cleared.stale.length,'The new hand retained a previous Bet/Call/Raise: '+JSON.stringify(cleared));
  console.log('Player displays passed: stable board/dock geometry and contained seats at seven viewports, preflop-only blind positions, larger protected JPEG portraits/cards, per-player Bet/Raise/Call persistence, reconnect recovery, street/new-hand clearing, and readable showdown cards.');
  console.log('Display growth from 837201f: ' + JSON.stringify(growth));
}
