// Nine accounts fill one table. One seated browser checks live controls before
// any action is submitted; a separate spectator browser checks exposed hands.
export default async function crowded([activePage, spectatorPage], sleep, roomPassword) {
  const ev = (page, fn, ...args) => page.evaluate('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')');
  async function wait(page, fn, ...args) {
    for (let i = 0; i < 120; i++) {
      const value = await ev(page, fn, ...args);
      if (value) return value;
      await sleep(100);
    }
    throw Error('Timed out: ' + fn + ' ' + args + ' | ' + await ev(page, () => document.body.innerText.slice(-1000)));
  }
  const visible = selector => {
    const node = document.querySelector(selector);
    if (!node) return false;
    const details = node.closest('details');
    if (details) details.open = true;
    return Boolean(node.offsetWidth);
  };
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
    await ev(page, (query, next) => {
      const node = document.querySelector(query);
      if (!node) throw Error('Missing input ' + query);
      node.value = String(next);
      for (const type of ['input', 'change']) node.dispatchEvent(new Event(type, { bubbles: true }));
    }, selector, value);
  }
  async function signIn(page, user) {
    await wait(page, visible, '#login-name');
    await setInput(page, '#login-name', user.username);
    await setInput(page, '#login-password', user.password);
    await ev(page, () => document.querySelector('#login-form').requestSubmit());
    await wait(page, visible, '#app-panel');
  }
  async function openTable(page, name) {
    await wait(page, (tableName) => {
      const button = [...document.querySelectorAll('[data-open-table]')]
        .find(node => node.innerText.includes(tableName));
      if (!button) return false;
      button.click();
      return true;
    }, name);
    await wait(page, tableName => document.querySelector('#view-table-name')?.textContent === tableName, name);
  }

  await wait(activePage, visible, '#login-name');
  await wait(spectatorPage, visible, '#login-name');
  const seatsCount = Number(process.env.QA_SEATS || 9);
  if (!Number.isInteger(seatsCount) || seatsCount < 2 || seatsCount > 9) throw Error('QA_SEATS must be 2–9');
  const origin = await activePage.evaluate('location.origin');
  const api = origin + '/poker/api';
  const req = async (path, session, data) => {
    const headers = { Origin: origin };
    if (session) Object.assign(headers, {
      Cookie: session.cookie,
      'X-SitNgo-Session': session.session_proof,
      'X-SitNgo-CSRF': session.csrf,
    });
    if (data) headers['Content-Type'] = 'application/json';
    const response = await fetch(api + path, {
      method: data ? 'POST' : 'GET',
      headers,
      body: data ? JSON.stringify(data) : undefined,
    });
    const json = await response.json();
    if (!response.ok) throw Error(path + ' ' + JSON.stringify(json));
    if (path === '/register' || path === '/login') {
      const cookie = response.headers.get('set-cookie')?.split(';')[0];
      if (!cookie) throw Error(path + ' did not issue a session cookie');
      return { ...json, cookie };
    }
    if (path === '/config' || path === '/admin/config') return json;
    return json.table;
  };

  const admin = await req('/login', null, {username:'admin', password:''});
  await req('/admin/config', admin, {
    runout_seconds: 40,
    blind_announcement_seconds: 0,
    elimination_announcement_seconds: 0,
    showdown_seconds: 0,
    bet_presets: {preflop_bb:[2.5,3,4], postflop_percent:[50,75,100]},
  });
  const stamp = Date.now().toString(36);
  async function register(username, suffix) {
    const password = 'CrowdedPass_' + suffix + '_' + stamp;
    const session = await req('/register', null, {
      room_password: roomPassword, username, password,
    });
    return { ...session, username, password };
  }
  const playerNames = ['Alex','Sam','Jordan','Riley','Morgan','Casey','Taylor','Avery','Jamie'];
  const players = [];
  for (let i = 0; i < seatsCount; i++) players.push(await register(playerNames[i], String(i)));
  const spectator = await register('Spectator', 'spectator');
  const host = players[0];
  const tableName = 'Friday Night';
  const table = await req('/tables', host, {
    name: tableName,
    starting_stack: 100,
    small_blind: 10,
    big_blind: 20,
    level_minutes: 54,
    turn_seconds: 3600,
    buy_in: 10,
    payout_percentages: [60, 25, 15],
  });
  const tablePath = '/tables/' + table.id;
  for (let i = 1; i < seatsCount; i++) {
    await req(tablePath + '/seat', players[i], { seat_no: i });
  }

  let view = await req(tablePath + '/start', host, {});
  const actingPlayer = players.find(session => session.player.id === view.actor_id);
  if (!actingPlayer) throw Error('The live hand has no seated actor');
  await signIn(activePage, actingPlayer);
  await openTable(activePage, tableName);
  await wait(activePage, visible, '.table-surface > #action-panel #action-controls [data-raise-preset]');

  const before = await req(tablePath, actingPlayer);
  if (before.actor_id !== actingPlayer.player.id || !before.viewer?.can_act) throw Error('Seated browser did not receive the active turn');
  const beforeAction = {
    actor_id: before.actor_id,
    hand_no: before.hand_no,
    turn_version: before.turn_version,
    event_seq: before.event_seq,
  };
  const activeViewports = [
    {width: 320, height: 740},
    {width: 320, height: 568},
    {width: 390, height: 844},
    {width: 360, height: 740},
    {width: 667, height: 375},
    {width: 844, height: 390},
    {width: 1366, height: 768},
  ];
  const failures = [];
  for (const {width, height} of activeViewports) {
    await activePage.resize(width, height);
    await sleep(220);
    await ev(activePage, () => document.querySelector('#felt').scrollIntoView({ block: 'center' }));
    if (width <= 340 || (width > height && height < 400)) {
      await ev(activePage, () => document.querySelector('#action-panel').scrollIntoView({block:'end'}));
    }
    await sleep(80);
    const metrics = await activePage.evaluate(`(() => {
      const expected = ${seatsCount};
      const rect = node => { const r=node.getBoundingClientRect(); return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}; };
      const area = (a,b) => { const w=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left)),h=Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)); return w>1 && h>1 ? w*h : 0; };
      const surface=document.querySelector('.table-surface'), felt=document.querySelector('#felt');
      const boardNode=document.querySelector('#board-cards'), panel=document.querySelector('#action-panel');
      const heroPair=document.querySelector('.seat-card.is-me .seat-cards.is-viewer-cards');
      const seats=[...document.querySelectorAll('.seat-card[data-player-id]')], heroes=[...document.querySelectorAll('.seat-card.is-me .seat-cards.is-viewer-cards .mini-card')];
      const actionButtons=[...document.querySelectorAll('#action-panel .action-buttons [data-poker-action]')];
      const presets=[...document.querySelectorAll('#action-panel [data-raise-preset]')], controls=[...document.querySelectorAll('#action-panel button:not([disabled]),#action-panel input:not([disabled])')];
      const errors=[], boardOverlapSeats=[], seatOverlaps=[], panelOverlapSeats=[];
      if(seats.length!==expected) errors.push('active seat count '+seats.length);
      if(heroes.length!==2) errors.push('hero hole-card count '+heroes.length);
      if(!surface?.contains(panel) || !panel || panel.hidden) errors.push('action panel not visible inside table surface');
      if(felt?.contains(panel)) errors.push('action panel is inside the felt');
      if(actionButtons.length!==3) errors.push('primary action button count '+actionButtons.length);
      if(actionButtons.some(button=>button.disabled)) errors.push('active player has a disabled primary action');
      if(presets.length!==3) errors.push('preset count '+presets.length);
      if(document.querySelector('#allInConfirm,[data-action="confirm-all-in"],#hand-result')) errors.push('obsolete confirmation or payout box remains');
      if(/uncalled/i.test(document.body.innerText)) errors.push('uncalled-bet UI remains');
      if(document.documentElement.scrollWidth>innerWidth+1) errors.push('page overflow');
      const board=rect(boardNode), panelBox=panel?rect(panel):null, surfaceBox=surface?rect(surface):null;
      const centerNodes=["#board-caption","#pot-display","#street-label"].map(id=>[id,document.querySelector(id)])
        .filter(([,node])=>node && !node.hidden && node.offsetWidth);
      const centerLabelOverlaps=[];
      for(const [label,node] of centerNodes) for(let i=0;i<seats.length;i++) {
        if(area(rect(node),rect(seats[i]))>5) {
          errors.push(label+' overlaps seat '+i);
          centerLabelOverlaps.push({label,index:i,seatNo:seats[i].dataset.seatNo,labelRect:rect(node),seatRect:rect(seats[i])});
        }
      }
      const heroPairBox=heroPair?rect(heroPair):null;
      const normalPhone=(innerWidth===390 && innerHeight===844) || (innerWidth===360 && innerHeight===740);
      const feltBox=felt?rect(felt):null;
      if(panelBox && surfaceBox && (
        panelBox.left<surfaceBox.left-1 || panelBox.right>surfaceBox.right+1 ||
        panelBox.top<surfaceBox.top-1 || panelBox.bottom>surfaceBox.bottom+1
      )) errors.push('action footer escapes table surface');
      const heroCenterOffset=heroPairBox&&feltBox?{
        x:+(((heroPairBox.left+heroPairBox.right)-(feltBox.left+feltBox.right))/2).toFixed(1),
        y:+(((heroPairBox.top+heroPairBox.bottom)-(feltBox.top+feltBox.bottom))/2).toFixed(1),
      }:null;
      const heroBottomGap=heroPairBox&&feltBox?+(feltBox.bottom-heroPairBox.bottom).toFixed(1):null;
      if(heroCenterOffset && Math.abs(heroCenterOffset.x)>2) errors.push('hero card pair is not horizontally centered on felt: '+heroCenterOffset.x+'px');
      if(heroCenterOffset && heroCenterOffset.y<0) errors.push('hero card pair is not in the lower half of the felt: '+heroCenterOffset.y+'px');
      if(heroPairBox && feltBox && (
        heroPairBox.left<feltBox.left-1 || heroPairBox.right>feltBox.right+1 ||
        heroPairBox.top<feltBox.top-1 || heroPairBox.bottom>feltBox.bottom+1
      )) errors.push('hero card pair escapes felt bounds');
      if(normalPhone && panelBox && heroPairBox && area(panelBox,heroPairBox)>5) {
        errors.push('action dock overlaps hero cards on normal phone');
      }
      if(normalPhone && panelBox && heroPairBox && (
        panelBox.top<0 || panelBox.bottom>innerHeight || heroPairBox.top<0 || heroPairBox.bottom>innerHeight
      )) errors.push('action dock and hero cards are not both visible on normal phone');
      for(let i=0;i<seats.length;i++) {
        const seat=rect(seats[i]);
        const seatRef={index:i,seatNo:seats[i].dataset.seatNo,relativeSeat:seats[i].dataset.relativeSeat,rect:seat};
        if(area(board,seat)>5) { errors.push('board overlaps seat '+i); boardOverlapSeats.push(seatRef); }
        if(panelBox && area(panelBox,seat)>5) { errors.push('action panel overlaps seat '+i); panelOverlapSeats.push(seatRef); }
        for(let j=0;j<i;j++) if(area(seat,rect(seats[j]))>5) {
          errors.push('seat overlap '+i+' and '+j);
          seatOverlaps.push({a:{index:j,seatNo:seats[j].dataset.seatNo,relativeSeat:seats[j].dataset.relativeSeat,rect:rect(seats[j])},b:seatRef});
        }
      }
      for(let i=0;i<heroes.length;i++) {
        const hero=rect(heroes[i]);
        if(feltBox && (hero.left<feltBox.left-1 || hero.right>feltBox.right+1 ||
          hero.top<feltBox.top-1 || hero.bottom>feltBox.bottom+1)) errors.push('hero card clipped by felt '+i);
        if(normalPhone && (hero.left<0 || hero.right>innerWidth+1 || hero.top<0 || hero.bottom>innerHeight+1)) {
          errors.push('hero card clipped by viewport '+i);
        }
        if(panelBox && area(hero,panelBox)>5) errors.push('hero card overlaps action panel '+i);
      }
      const hits=controls.map(node=>{
        const r=rect(node), x=r.left+r.width/2, y=r.top+r.height/2, top=document.elementFromPoint(x,y);
        const hit=Boolean(top && (top===node || node.contains(top)));
        const minimumTarget=node.matches('[data-raise-preset]')?28:(node.matches('input[type="range"]')?32:44);
        if(normalPhone && (node.tagName==='BUTTON'||node.matches('input[type="range"]')) && r.height<minimumTarget) {
          errors.push('tap target below '+minimumTarget+'px '+(node.textContent||node.id||node.tagName).trim()+': '+r.height.toFixed(1));
        }
        if(!r.width || !r.height || r.left<0 || r.right>innerWidth+1 || r.top<0 || r.bottom>innerHeight+1 || !hit) errors.push('control hit test failed '+(node.textContent||node.id||node.tagName).trim());
        return {label:(node.textContent||node.id||node.tagName).trim(),hit};
      });
      return {
        errors,
        actionDock:panelBox?{
          left:+panelBox.left.toFixed(1),top:+panelBox.top.toFixed(1),
          width:+panelBox.width.toFixed(1),height:+panelBox.height.toFixed(1),
          normalPhone,
        }:null,
        heroPair:heroPairBox,
        heroCenterOffset,
        heroBottomGap,
        board,
        boardOverlapSeats,
        centerLabelOverlaps,
        seatOverlaps,
        panelOverlapSeats,
        heroCards:heroes.length,
        actionButtons:actionButtons.length,
        presetHits:hits.filter(item=>item.label),
        seatCount:seats.length,
      };
    })()`);
    console.log('Active', seatsCount, 'seat layout at', width, 'x', height, ':', JSON.stringify(metrics));
    if (metrics.errors.length) failures.push('Active layout at ' + width + 'px: ' + metrics.errors.join(', '));

    const selected = await activePage.evaluate(`(() => {
      const button=document.querySelector('#action-panel [data-raise-preset]');
      const r=button.getBoundingClientRect(), hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
      if(!hit || !(hit===button || button.contains(hit))) throw Error('Raise preset center is obstructed');
      hit.click();
      return Number(button.dataset.target);
    })()`);
    await wait(activePage, target => {
      const input=document.querySelector('#raise-amount'), pressed=document.querySelector('#action-panel [data-raise-preset][aria-pressed="true"]');
      return Number(input?.value)===target && Number(pressed?.dataset.target)===target;
    }, selected);
    const after = await req(tablePath, actingPlayer);
    if (after.actor_id!==beforeAction.actor_id || after.hand_no!==beforeAction.hand_no ||
        after.turn_version!==beforeAction.turn_version || after.event_seq!==beforeAction.event_seq) {
      throw Error('Raise preset submitted or changed the active turn');
    }
    console.log('Preset', selected, 'selected at', width, 'px without submitting');
    await activePage.screenshot('active-' + width + 'x' + height);
  }


  await activePage.resize(320, 568);
  await sleep(180);
  await ev(activePage, () => document.querySelector('#felt').scrollIntoView({ block: 'center' }));
  const topOpponentBefore = await ev(activePage, () => {
    const rect = node => {
      const r = node.getBoundingClientRect();
      return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,
        centerX:r.left+r.width/2,centerY:r.top+r.height/2};
    };
    const felt=rect(document.querySelector('#felt'));
    const seats = [...document.querySelectorAll('#seat-grid .seat-card[data-player-id]:not(.is-me)')];
    const seat = seats.sort((a,b) => rect(a).top - rect(b).top)[0];
    if (!seat) return null;
    const seatBox=rect(seat), cards = seat.querySelector('.seat-cards'), cardsBox=rect(cards);
    const miniCards = [...(cards?.querySelectorAll('.mini-card') || [])].map(node => {
      const box = rect(node), style = getComputedStyle(node);
      return {...box,visible:style.display !== 'none' && style.visibility !== 'hidden' &&
        box.width > 0 && box.height > 0,back:node.classList.contains('back')};
    });
    return {playerId:seat.dataset.playerId,felt,scrollY:window.scrollY,seat:seatBox,cards:cardsBox,miniCards,
      seatInFelt:{x:seatBox.left-felt.left,y:seatBox.top-felt.top},
      cardsInSeat:{x:cardsBox.left-seatBox.left,y:cardsBox.top-seatBox.top},
      relativeSeat:Number(seat.dataset.relativeSeat)};
  });
  if (!topOpponentBefore || topOpponentBefore.miniCards.length !== 2 ||
      !topOpponentBefore.miniCards.every(card => card.visible && card.back)) {
    throw Error('Top opponent must show two visible card backs before nine-seat runout: ' +
      JSON.stringify(topOpponentBefore));
  }
  for (let i = 0; i < seatsCount + 2 && view.actor_id; i++) {
    const actor = players.find(session => session.player.id === view.actor_id);
    if (!actor) throw Error('Unknown active player ' + view.actor_id);
    view = await req(tablePath + '/action', actor, {
      action: 'all_in', expected_hand: view.hand_no, expected_turn_version: view.turn_version,
    });
  }
  if (view.actor_id) throw Error('The forced all-in round did not close');
  if (view.runout_odds?.length !== seatsCount) throw Error('All live hands were not exposed');

  await wait(activePage, count => document.querySelectorAll('.seat-equity:not(.is-empty)').length === count, seatsCount);
  const topOpponentAfter = await ev(activePage, playerId => {
    const rect = node => {
      const r = node.getBoundingClientRect();
      return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,
        centerX:r.left+r.width/2,centerY:r.top+r.height/2};
    };
    const felt=rect(document.querySelector('#felt'));
    const seat = [...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')]
      .find(node => node.dataset.playerId === playerId);
    if (!seat) return null;
    const seatBox=rect(seat), cards = seat.querySelector('.seat-cards'), cardsBox=rect(cards);
    const miniCards = [...(cards?.querySelectorAll('.mini-card') || [])].map(node => {
      const box = rect(node), style = getComputedStyle(node);
      return {...box,visible:style.display !== 'none' && style.visibility !== 'hidden' &&
        box.width > 0 && box.height > 0,back:node.classList.contains('back')};
    });
    return {playerId:seat.dataset.playerId,felt,scrollY:window.scrollY,seat:seatBox,cards:cardsBox,miniCards,
      seatInFelt:{x:seatBox.left-felt.left,y:seatBox.top-felt.top},
      cardsInSeat:{x:cardsBox.left-seatBox.left,y:cardsBox.top-seatBox.top},
      equity:rect(seat.querySelector('.seat-equity:not(.is-empty)'))};
  }, topOpponentBefore.playerId);
  if (!topOpponentAfter || topOpponentAfter.miniCards.length !== 2 ||
      topOpponentAfter.miniCards.some((card,index) => !card.visible || card.back ||
        Math.abs((card.centerX-topOpponentAfter.seat.left) -
          (topOpponentBefore.miniCards[index].centerX-topOpponentBefore.seat.left))>1 ||
        Math.abs((card.centerY-topOpponentAfter.seat.top) -
          (topOpponentBefore.miniCards[index].centerY-topOpponentBefore.seat.top))>1) ||
      Math.abs(topOpponentAfter.scrollY-topOpponentBefore.scrollY)>1 ||
      Math.abs(topOpponentAfter.felt.left-topOpponentBefore.felt.left)>1 ||
      Math.abs(topOpponentAfter.felt.top-topOpponentBefore.felt.top)>1 ||
      Math.abs(topOpponentAfter.felt.width-topOpponentBefore.felt.width)>1 ||
      Math.abs(topOpponentAfter.felt.height-topOpponentBefore.felt.height)>1 ||
      Math.abs(topOpponentAfter.seat.centerX-topOpponentBefore.seat.centerX)>1 ||
      Math.abs(topOpponentAfter.seat.centerY-topOpponentBefore.seat.centerY)>1 ||
      Math.abs(topOpponentAfter.cards.centerX-topOpponentBefore.cards.centerX)>1 ||
      Math.abs(topOpponentAfter.cards.centerY-topOpponentBefore.cards.centerY)>1 ||
      Math.abs(topOpponentAfter.seatInFelt.x-topOpponentBefore.seatInFelt.x)>1 ||
      Math.abs(topOpponentAfter.seatInFelt.y-topOpponentBefore.seatInFelt.y)>1 ||
      Math.abs(topOpponentAfter.cardsInSeat.x-topOpponentBefore.cardsInSeat.x)>1 ||
      Math.abs(topOpponentAfter.cardsInSeat.y-topOpponentBefore.cardsInSeat.y)>1 ||
      Math.abs(topOpponentAfter.seat.width-topOpponentBefore.seat.width)>1 ||
      Math.abs(topOpponentAfter.seat.height-topOpponentBefore.seat.height)>1 ||
      Math.abs(topOpponentAfter.cards.width-topOpponentBefore.cards.width)>1 ||
      Math.abs(topOpponentAfter.cards.height-topOpponentBefore.cards.height)>1) {
    throw Error('Nine-seat top opponent cards moved from backs to exposed faces: ' +
      JSON.stringify({before:topOpponentBefore,after:topOpponentAfter}));
  }

  for (const {width, height} of [{width:320,height:568},{width:667,height:375},{width:844,height:390}]) {
    await activePage.resize(width, height);
    await sleep(240);
    await ev(activePage, () => document.querySelector('#action-panel').scrollIntoView({ block: 'end' }));
    await sleep(80);
    const runout = await ev(activePage, (expected) => {
      const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
      const area=(a,b)=>{const w=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left)),h=Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));return w>1&&h>1?w*h:0;};
      const surface=document.querySelector('.table-surface'), felt=document.querySelector('#felt'), panel=document.querySelector('#action-panel');
      const hero=document.querySelector('.seat-card.is-me'), pair=document.querySelector('.seat-card.is-me .seat-cards.is-viewer-cards');
      const equity=hero?.querySelector('.seat-equity:not(.is-empty)'), heroes=[...document.querySelectorAll('.seat-card.is-me .seat-cards.is-viewer-cards .mini-card')];
      const seats=[...document.querySelectorAll('.seat-card[data-player-id]')];
      const actions=[...document.querySelectorAll('#action-panel .action-buttons [data-poker-action]')];
      const touchButtons=[...document.querySelectorAll('#action-panel button')].map(button=>({
        label:(button.textContent||button.getAttribute('aria-label')||button.id||'').trim(),
        rect:rect(button),
        minimum:button.matches('[data-raise-preset]')?28:44,
        hit:(()=>{const r=button.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
          return hit===button||button.contains(hit);})(),
      }));
      const labels=["#board-caption","#pot-display","#street-label"].map(id=>[id,document.querySelector(id)])
        .filter(([,node])=>node && !node.hidden && node.offsetWidth);
      const errors=[], labelOverlaps=[], seatContentOverflows=[];
      if(seats.length!==expected) errors.push('runout seat count '+seats.length);
      if(heroes.length!==2) errors.push('runout hero card count '+heroes.length);
      if(!surface?.contains(panel) || !panel || panel.hidden || felt?.contains(panel)) errors.push('runout action footer missing/outside surface');
      if(actions.length!==3 || actions.some(button=>!button.disabled)) errors.push('runout footer is not three disabled actions');
      if(!equity?.offsetWidth) errors.push('hero equity badge missing during runout');
      const footer=panel?rect(panel):null, surfaceBox=surface?rect(surface):null, feltBox=felt?rect(felt):null, pairBox=pair?rect(pair):null;
      if(footer && (footer.top< -1 || footer.bottom>innerHeight+1)) errors.push('runout action dock is clipped after scrolling into view');
      if(footer && surfaceBox && (footer.left<surfaceBox.left-1 || footer.right>surfaceBox.right+1 || footer.top<surfaceBox.top-1 || footer.bottom>surfaceBox.bottom+1)) errors.push('runout footer escapes surface');
      if(touchButtons.some(button=>button.rect.height<button.minimum || !button.hit)) {
        errors.push('runout action buttons are undersized or obstructed: '+JSON.stringify(touchButtons));
      }
      const center=pairBox&&feltBox?{
        x:+(((pairBox.left+pairBox.right)-(feltBox.left+feltBox.right))/2).toFixed(1),
        y:+(((pairBox.top+pairBox.bottom)-(feltBox.top+feltBox.bottom))/2).toFixed(1),
        bottomGap:+(feltBox.bottom-pairBox.bottom).toFixed(1),
      }:null;
      if(center && (Math.abs(center.x)>2 || center.y<0 || center.bottomGap< -1)) errors.push('runout hero is not at six o clock '+JSON.stringify(center));
      for(const [label,node] of labels) for(let i=0;i<seats.length;i++) {
        if(area(rect(node),rect(seats[i]))>5) {
          errors.push(label+' overlaps runout seat '+i);
          labelOverlaps.push({label,index:i,seatNo:seats[i].dataset.seatNo,labelRect:rect(node),seatRect:rect(seats[i])});
        }
      }
      for(let i=0;i<seats.length;i++) {
        const parent=rect(seats[i]);
        for(const child of seats[i].querySelectorAll('.mini-card,.seat-equity strong')) {
          if(!child.offsetWidth) continue;
          const box=rect(child);
          if(box.left<parent.left-1 || box.right>parent.right+1 || box.top<parent.top-1 || box.bottom>parent.bottom+1) {
            errors.push(child.matches('.mini-card')?'hole card escapes seat '+i:'equity value escapes seat '+i);
            seatContentOverflows.push({index:i,seatNo:seats[i].dataset.seatNo,child:child.matches('.mini-card')?'mini-card':'equity-value',parent,box});
          }
        }
      }
      return {errors,viewport:[innerWidth,innerHeight],footer,touchButtons,hero:center,equity:equity?rect(equity):null,labelOverlaps,seatContentOverflows};
    }, seatsCount);
    console.log('Active all-in runout at', width, 'x', height, JSON.stringify(runout));
    if(runout.errors.length) failures.push('Active runout at '+width+'x'+height+': '+runout.errors.join(', '));
    await activePage.screenshot('runout-'+width+'x'+height);
  }

  await signIn(spectatorPage, spectator);
  const spectatorView = await req(tablePath, spectator);
  if (spectatorView.viewer?.seated) throw Error('All-in observer unexpectedly occupies a seat');
  await openTable(spectatorPage, tableName);
  await wait(spectatorPage, count => document.querySelectorAll('.seat-equity:not(.is-empty)').length === count, seatsCount);

  for (const width of [320, 390, 768, 1366]) {
    await spectatorPage.resize(width, 850);
    await sleep(220);
    await ev(spectatorPage, () => document.querySelector('#felt').scrollIntoView({ block: 'center' }));
    await sleep(80);
    const errors = await spectatorPage.evaluate(`(() => {
      const expected=${seatsCount};
      const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
      const area=(a,b)=>{const w=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left)),h=Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));return w>1&&h>1?w*h:0;};
      const seats=[...document.querySelectorAll('.seat-card')], badges=[...document.querySelectorAll('.seat-equity:not(.is-empty)')], board=rect(document.querySelector('#board-cards')), problems=[], boardOverlaps=[], seatOverlaps=[];
      if(badges.length!==expected) problems.push('missing odds');
      if(seats.length!==expected) problems.push('seat count '+seats.length);
      for(let i=0;i<seats.length;i++) {
        const seat=rect(seats[i]);
        const seatRef={index:i,seatNo:seats[i].dataset.seatNo,relativeSeat:seats[i].dataset.relativeSeat,rect:seat};
        if(area(board,seat)>5) { problems.push('board overlaps '+i); boardOverlaps.push(seatRef); }
        for(let j=0;j<i;j++) if(area(seat,rect(seats[j]))>5) {
          problems.push('seat overlap '+i+' and '+j);
          seatOverlaps.push({a:{index:j,seatNo:seats[j].dataset.seatNo,relativeSeat:seats[j].dataset.relativeSeat,rect:rect(seats[j])},b:seatRef});
        }
      }
      for(let i=0;i<badges.length;i++) {
        const badge=badges[i], b=rect(badge);
        if(!badge.offsetWidth || b.left<0 || b.right>innerWidth+1) problems.push('badge clipped '+i);
      }
      if(document.documentElement.scrollWidth>innerWidth+1) problems.push('page overflow');
      return {errors:problems,board,boardOverlaps,seatOverlaps};
    })()`);
    console.log(seatsCount, 'exposed hands at', width, 'px:', JSON.stringify(errors));
    if(errors.errors.length) failures.push('Exposed layout at ' + width + 'px: ' + errors.errors.join(', '));
  }
  if (failures.length) throw Error(failures.join('\n'));
}
