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
  const visible = selector => Boolean(document.querySelector(selector)?.offsetWidth);
  async function click(page, selector) {
    await wait(page, (query) => {
      const node = document.querySelector(query);
      if (!node?.offsetWidth || node.disabled) return false;
      node.click();
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
    return json.table;
  };

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
    max_seats: seatsCount,
    starting_stack: 100,
    small_blind: 10,
    big_blind: 20,
    level_minutes: 54,
    turn_seconds: 3600,
    runout_seconds: 40,
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
  await wait(activePage, visible, '#felt > #action-panel #action-controls [data-raise-preset]');

  const before = await req(tablePath, actingPlayer);
  if (before.actor_id !== actingPlayer.player.id || !before.viewer?.can_act) throw Error('Seated browser did not receive the active turn');
  const beforeAction = {
    actor_id: before.actor_id,
    hand_no: before.hand_no,
    turn_version: before.turn_version,
    event_seq: before.event_seq,
  };
  const activeWidths = [320, 390, 1366];
  const failures = [];
  for (const width of activeWidths) {
    await activePage.resize(width, 850);
    await sleep(220);
    await ev(activePage, () => document.querySelector('#felt').scrollIntoView({ block: 'center' }));
    await sleep(80);
    const metrics = await activePage.evaluate(`(() => {
      const expected = ${seatsCount};
      const rect = node => { const r=node.getBoundingClientRect(); return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height}; };
      const area = (a,b) => Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left)) * Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
      const felt=document.querySelector('#felt'), boardNode=document.querySelector('#board-cards'), panel=document.querySelector('#action-panel');
      const seats=[...document.querySelectorAll('.seat-card[data-player-id]')], heroes=[...document.querySelectorAll('.seat-card.is-me .seat-cards.is-viewer-cards .mini-card')];
      const presets=[...document.querySelectorAll('#action-panel [data-raise-preset]')], controls=[...document.querySelectorAll('#action-panel button:not([disabled]),#action-panel input:not([disabled])')];
      const errors=[], boardOverlapSeats=[], seatOverlaps=[], panelOverlapSeats=[];
      if(seats.length!==expected) errors.push('active seat count '+seats.length);
      if(heroes.length!==2) errors.push('hero hole-card count '+heroes.length);
      if(!panel || panel.hidden || !felt?.contains(panel)) errors.push('action panel not visible inside felt');
      if(presets.length!==3) errors.push('preset count '+presets.length);
      if(document.documentElement.scrollWidth>innerWidth+1) errors.push('page overflow');
      const board=rect(boardNode), panelBox=panel?rect(panel):null;
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
        if(hero.left<0 || hero.right>innerWidth+1 || hero.top<0 || hero.bottom>innerHeight+1) errors.push('hero card clipped '+i);
        if(panelBox && area(hero,panelBox)>5) errors.push('hero card overlaps action panel '+i);
      }
      const hits=controls.map(node=>{
        const r=rect(node), x=r.left+r.width/2, y=r.top+r.height/2, top=document.elementFromPoint(x,y);
        const hit=Boolean(top && (top===node || node.contains(top)));
        if(!r.width || !r.height || r.left<0 || r.right>innerWidth+1 || r.top<0 || r.bottom>innerHeight+1 || !hit) errors.push('control hit test failed '+(node.textContent||node.id||node.tagName).trim());
        return {label:(node.textContent||node.id||node.tagName).trim(),hit};
      });
      return {errors, actionDock:panel?{
        left:+panelBox.left.toFixed(1),top:+panelBox.top.toFixed(1),width:+panelBox.width.toFixed(1),height:+panelBox.height.toFixed(1)
      }:null, board, boardOverlapSeats, seatOverlaps, panelOverlapSeats, heroCards:heroes.length, presetHits:hits.filter(item=>item.label), seatCount:seats.length};
    })()`);
    console.log('Active', seatsCount, 'seat layout at', width, 'px:', JSON.stringify(metrics));
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
    await activePage.screenshot('active-' + width);
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

  await signIn(spectatorPage, spectator);
  const spectatorView = await req(tablePath, spectator);
  if (spectatorView.viewer?.seated) throw Error('All-in observer unexpectedly occupies a seat');
  await openTable(spectatorPage, tableName);
  await wait(spectatorPage, count => document.querySelectorAll('.seat-equity').length === count, seatsCount);

  for (const width of [320, 390, 768, 1366]) {
    await spectatorPage.resize(width, 850);
    await sleep(220);
    await ev(spectatorPage, () => document.querySelector('#felt').scrollIntoView({ block: 'center' }));
    await sleep(80);
    const errors = await spectatorPage.evaluate(`(() => {
      const expected=${seatsCount};
      const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
      const area=(a,b)=>Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
      const seats=[...document.querySelectorAll('.seat-card')], badges=[...document.querySelectorAll('.seat-equity')], board=rect(document.querySelector('#board-cards')), problems=[], boardOverlaps=[], seatOverlaps=[];
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
