import {seedAvatar} from "./avatar-fixture.mjs";
// Real browser/API regressions for table seating, persistent sit-out and live chat.
export default async function interactions([one,two], sleep, roomPassword) {
  const evaluate=(page,fn,...args)=>page.evaluate('('+fn.toString()+')(...'+JSON.stringify(args)+')');
  const assert=(ok,message)=>{if(!ok) throw Error(message)};
  async function wait(page,fn,...args) {
    for(let n=0;n<120;n++) { const result=await evaluate(page,fn,...args); if(result) return result; await sleep(100); }
    throw Error('Timed out '+fn+' '+await evaluate(page,()=>document.body.innerText.slice(-800)));
  }
  async function click(page,selector) {
    await wait(page,q=>{
      const n=document.querySelector(q); if(!n)return false;
      const details=n.tagName==='SUMMARY'?null:n.closest('details'), wasOpen=Boolean(details?.open);
      if(details)details.open=true;
      if(!n.offsetWidth||n.disabled){if(details&&!wasOpen)details.open=false;return false;}
      n.click();
      if(details&&!wasOpen)details.open=false;
      return true;
    },selector);
  }
  async function assertPauseCover(page) {
    await wait(page,()=>!document.querySelector('#paused-banner')?.hidden&&
      document.querySelector('#paused-banner')?.textContent.includes('Wait for the host'));
    const cover=await evaluate(page,()=>{
      const surface=document.querySelector('#table-surface'),banner=document.querySelector('#paused-banner');
      const a=surface.getBoundingClientRect(),b=banner.getBoundingClientRect();
      return {surface:{x:a.x,y:a.y,w:a.width,h:a.height},banner:{x:b.x,y:b.y,w:b.width,h:b.height},covered:Math.abs(a.left-b.left)<3&&Math.abs(a.top-b.top)<3&&Math.abs(a.right-b.right)<3&&Math.abs(a.bottom-b.bottom)<3,
        hidden:[...surface.children].filter(child=>child!==banner).every(child=>getComputedStyle(child).opacity==='0'&&child.inert&&child.getAttribute('aria-hidden')==='true')};
    });
    assert(cover.covered&&cover.hidden,'Pause did not hide and disable the entire play area: '+JSON.stringify(cover));
  }
  async function input(page,selector,value) {
    await evaluate(page,(q,v)=>{const n=document.querySelector(q);n.value=v;n.dispatchEvent(new Event('input',{bubbles:true}));},selector,value);
  }
  const origin=await one.evaluate('location.origin'), api=origin+'/poker/api';
  async function request(path,user,data,method) {
    const headers={Origin:origin};
    if(user) Object.assign(headers,{Cookie:user.cookie,'X-SitNgo-Session':user.session_proof,'X-SitNgo-CSRF':user.csrf});
    if(data!==undefined)headers['Content-Type']='application/json';
    const r=await fetch(api+path,{method:method||(data===undefined?'GET':'POST'),headers,body:data===undefined?undefined:JSON.stringify(data)});
    const json=await r.json();
    if(!r.ok)throw Error(path+' '+JSON.stringify(json));
    if(path==='/register'||path==='/login')return {...json,cookie:r.headers.get('set-cookie').split(';')[0]};
    return json;
  }
  const admin=await request('/login',null,{username:'admin',password:'test-admin-password'});
  await request('/admin/config',admin,{
    runout_seconds:1,blind_announcement_seconds:0,elimination_announcement_seconds:0,
    showdown_seconds:0,bet_presets:{preflop_bb:[2.5,3,4],postflop_percent:[50,75,100]}
  });
  const stamp=Date.now().toString(36), users=[];
  for(let i=0;i<3;i++) {
    const username=('Chat'+stamp+i).slice(0,24),password='Felt_'+stamp+'_'+i+'_Test';
    const user={...await request('/register',null,{username,password,room_password:roomPassword}),username,password};
    await seedAvatar(request,user);
    users.push(user);
  }
  async function signIn(page,user) {
    await wait(page,()=>document.querySelector('#login-name')?.offsetWidth);
    await input(page,'#login-name',user.username);await input(page,'#login-password',user.password);
    await evaluate(page,()=>document.querySelector('#login-form').requestSubmit());
    await wait(page,()=>document.querySelector('#app-panel')?.offsetWidth);
  }
  const config={name:'Table interactions '+stamp,starting_stack:1000,small_blind:10,big_blind:20,level_minutes:79,turn_seconds:3600};
  const {table}=await request('/tables',users[0],config),path='/tables/'+table.id;
  await Promise.all([signIn(one,users[0]),signIn(two,users[1])]);
  async function open(page,name) {
    await wait(page,n=>{const b=[...document.querySelectorAll('[data-open-table]')].find(b=>b.innerText.includes(n));if(!b)return false;b.click();return true},name);
    await wait(page,n=>document.querySelector('#view-table-name')?.textContent===n,name);
  }
  await Promise.all([open(one,config.name),open(two,config.name)]);
  await two.resize(390,844);
  const joinSelector='#seat-grid [data-take-seat]';
  await wait(two,q=>{const n=document.querySelector(q);if(!n)return false;const r=n.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight},joinSelector);
  await click(two,joinSelector);
  await wait(two,()=>document.querySelector('#seat-grid .seat-card.is-me')?.offsetWidth);
  assert(await evaluate(two,()=>![...document.querySelectorAll('#seat-grid .seat-card')].some(n=>/#\d/.test(n.innerText))),'Seat number remains visible');
  await wait(one,()=>document.querySelectorAll('#seat-grid .seat-card[data-player-id]').length===2);
  const botVisibility=await Promise.all([one,two].map(page=>evaluate(page,()=>
    [...document.querySelectorAll('[data-table-add-bot]')].filter(node=>node.offsetWidth&&!node.disabled).map(node=>node.dataset.tableAddBot))));
  assert(botVisibility[0].length>0&&botVisibility[1].length===0,
    'Waiting-table bot actions were not visible to the host only: '+JSON.stringify(botVisibility));
  await click(one,'[data-table-add-bot="2"]');
  await wait(one,()=>document.querySelector('#seat-grid .seat-card[data-seat-no="2"][data-is-bot="true"]')?.offsetWidth);
  let nonHostBotRejected=false;
  try { await request(path+'/bots',users[1],{seat_no:3}); }
  catch(_) { nonHostBotRejected=true; }
  assert(nonHostBotRejected,'A non-host added a bot to an empty lobby seat.');
  for(let seatNo=3;seatNo<9;seatNo++) await request(path+'/bots',users[0],{seat_no:seatNo});
  const fullHostView=(await request(path,users[0])).table;
  assert(fullHostView.seats.filter(seat=>seat.is_bot).length===7,
    'The host could not fill the remaining lobby capacity with bots.');
  await wait(one,()=>!document.querySelector('[data-table-add-bot]'));
  for(let seatNo=2;seatNo<9;seatNo++) await request(path+'/bots/'+seatNo,admin,undefined,'DELETE');
  const afterHostBotRemove=(await request(path,users[0])).table;
  assert(!afterHostBotRemove.seats.some(seat=>seat.is_bot),'Admin bot removal did not clear host-added test bots.');
  await request(path+'/bots',admin,{seat_no:2});
  const adminBotTable=(await request(path,admin)).table;
  const bot=adminBotTable.seats.find(seat=>seat.is_bot);
  assert(bot,'Admin bot endpoint did not add a test bot at an empty seat.');
  await request(path+'/bots/'+bot.seat_no,admin,undefined,'DELETE');
  console.log('Lobby host can fill empty seats with bots; non-host and full-table actions are blocked.');

  await click(one,'#chat-button');await click(two,'#chat-button');
  await wait(one,()=>document.querySelector('#chat-input')?.offsetWidth);
  const message='<img src=x onerror="window.chatXss=true"> hello';
  await input(one,'#chat-input',message);
  await evaluate(one,()=>document.querySelector('#chat-form').requestSubmit());
  await wait(two,text=>document.querySelector('#chat-messages')?.textContent.includes(text),message);
  assert(await evaluate(two,()=>!window.chatXss&&!document.querySelector('#chat-messages img')),'Chat HTML executed or became markup');
  const messages=await request(path+'/chat',users[2]);
  assert(messages.messages.some(m=>m.text===message&&m.player_id===users[0].player.id),'Spectator cannot read attributed chat');
  await request(path+'/chat',users[2],{text:'Watching this table'});
  await wait(one,()=>document.querySelector('#chat-messages')?.textContent.includes('Watching this table'));
  // Closing while a send is pending must not leave the input disabled on reopen.
  await evaluate(one, () => {
    const original = window.fetch.bind(window);
    window.fetch = async function(url, options) {
      if (String(url).endsWith('/chat') && options?.method === 'POST' && !window.chatHeldOnce) {
        window.chatHeldOnce = true;
        await new Promise(resolve => { window.releaseChatSend = resolve; });
      }
      return original(url, options);
    };
  });
  await input(one, '#chat-input', 'Pending message');
  await evaluate(one, () => document.querySelector('#chat-form').requestSubmit());
  await wait(one, () => Boolean(window.releaseChatSend) && document.querySelector('#chat-input').disabled);
  await one.pressEscape();
  await click(one, '#chat-button');
  assert(await evaluate(one, () => !document.querySelector('#chat-input').disabled),
    'Reopened chat stayed disabled after a pending send');
  await input(one, '#chat-input', 'New draft');
  await evaluate(one, () => window.releaseChatSend());
  await sleep(1200);
  assert(await evaluate(one, () => document.querySelector('#chat-input').value === 'New draft'),
    'Stale send response cleared the reopened draft');
  await two.pressEscape();await one.pressEscape();

  const started=(await request(path+'/start',users[0],{})).table;
  let activeBotRejected=false;
  try { await request(path+'/bots',users[0],{seat_no:2}); }
  catch(_) { activeBotRejected=true; }
  assert(activeBotRejected,'The host added a bot after the game started.');
  await wait(one,()=>!document.querySelector('[data-table-add-bot]'));
  await wait(two,()=>!document.querySelector('[data-table-add-bot]'));
  const chatVersion=started.turn_version;
  await request(path+'/chat',users[1],{text:'Good luck!'});
  const unchanged=(await request(path,users[0])).table;
  assert(unchanged.turn_version===chatVersion,'Chat changed poker turn version');
  await click(one,'#pause-button');
  for(const page of [one,two]) await assertPauseCover(page);
  assert((await request(path,users[2])).table.paused,'A spectator did not receive the host pause.');
  assert(await evaluate(two,()=>document.querySelector('#pause-cover-resume').hidden),'Non-host received a resume control.');
  await one.screenshot('host-pause-desktop');
  await two.screenshot('host-pause-phone');
  await click(one,'#pause-cover-resume');
  for(const page of [one,two]) await wait(page,()=>document.querySelector('#paused-banner')?.hidden&&
    !document.querySelector('#felt').inert&&getComputedStyle(document.querySelector('#felt')).opacity!=='0');

  const actorUser=users.find(u=>u.player.id===started.actor_id);
  assert(actorUser,'Fixture started with bot actor unexpectedly');
  const actorPage=actorUser===users[0]?one:two;
  await click(actorPage,'#sit-out-button');
  await wait(actorPage,()=>document.querySelector('#sit-out-button')?.getAttribute('aria-pressed')==='true');
  const sitting=(await request(path,actorUser)).table;
  assert(sitting.seats.find(s=>s.id===actorUser.player.id).sitting_out,'Sit-out did not persist');
  assert(sitting.actor_id!==actorUser.player.id,'Sit-out left actor waiting for shot clock');
  assert(await evaluate(actorPage,()=>!document.body.innerText.match(/(?:call|check|fold) recorded|submitting/i)),'Routine action confirmation remains');
  await click(actorPage,'#sit-out-button');
  await wait(actorPage,()=>document.querySelector('#sit-out-button')?.getAttribute('aria-pressed')==='false');
  assert(!(await request(path,actorUser)).table.seats.find(s=>s.id===actorUser.player.id).sitting_out,'Return to play did not clear sit-out');
  console.log('Plain-text live chat reached players and spectator without changing turn; sit-out acted immediately and toggled off.');
  await click(two,'#chat-button');await wait(two,()=>document.querySelector('#chat-input')?.offsetWidth);
  await two.resize(320,568);
  const box=await evaluate(two,()=>{const n=document.querySelector('#chat-panel').getBoundingClientRect();return {left:n.left,right:n.right,top:n.top,bottom:n.bottom,w:innerWidth,h:innerHeight}});
  assert(box.left>=0&&box.right<=box.w+1&&box.top>=0&&box.bottom<=box.h+1,'Chat exceeds small viewport '+JSON.stringify(box));
  await two.screenshot('chat-320x568');
  await two.pressEscape();
  await one.screenshot('table-interactions');

  await request('/admin/config',admin,{showdown_seconds:5});
  const extraName=('RebuyExtra'+stamp).slice(0,24);
  const extra={...await request('/register',null,{username:extraName,password:'test-extra-password',room_password:roomPassword}),username:extraName,password:'test-extra-password'};
  await seedAvatar(request,extra);users.push(extra);
  const rebuyName='Rebuy acceptance '+stamp;
  const rebuyCreated=await request('/tables',users[0],{
    name:rebuyName,starting_stack:100,small_blind:10,big_blind:20,buy_in:5,
    level_minutes:79,turn_seconds:3600,payout_percentages:[75,25]
  });
  const rebuyTableId=rebuyCreated.table.id,rebuyPath='/tables/'+rebuyTableId;
  for(let index=1;index<4;index++) await request(rebuyPath+'/seat',users[index],{seat_no:index});
  for(const [page,id] of [[one,rebuyTableId],[two,rebuyTableId]]) {
    await evaluate(page,tableId=>window.location.assign('/poker/table?table='+encodeURIComponent(tableId)),id);
    await wait(page,name=>document.querySelector('#view-table-name')?.textContent===name,rebuyName);
  }
  let rebuyState=(await request(rebuyPath+'/start',users[0],{})).table;
  let offerOwner=null,offerView=null,checkedShowdown=false;
  for(let handAttempt=0;handAttempt<4&&!offerOwner;handAttempt++) {
    rebuyState=(await request(rebuyPath,users[0])).table;
    const thisHand=Number(rebuyState.hand_no);
    while(rebuyState.actor_id&&!users.slice(0,2).some(user=>user.player.id===rebuyState.actor_id)) {
      const actor=users.find(user=>user.player.id===rebuyState.actor_id);
      rebuyState=(await request(rebuyPath+'/action',actor,{action:'fold',expected_hand:rebuyState.hand_no,expected_turn_version:rebuyState.turn_version})).table;
    }
    const firstActor=users.find(user=>user.player.id===rebuyState.actor_id);
    if(!firstActor)throw Error('No all-in actor.');
    rebuyState=(await request(rebuyPath+'/action',firstActor,{action:'all_in',expected_hand:rebuyState.hand_no,expected_turn_version:rebuyState.turn_version})).table;
    while(rebuyState.actor_id){
      const actor=users.find(user=>user.player.id===rebuyState.actor_id);
      rebuyState=(await request(rebuyPath+'/action',actor,{action:users.slice(0,2).includes(actor)?'call':'fold',expected_hand:rebuyState.hand_no,expected_turn_version:rebuyState.turn_version})).table;
    }
    for(let attempt=0;attempt<120;attempt++) {
      rebuyState=(await request(rebuyPath,users[0])).table;
      if(rebuyState.street==='showdown'||rebuyState.hand_no>thisHand)break;
      await sleep(100);
    }
    if(rebuyState.blinds?.paused&&rebuyState.street==='showdown') {
      checkedShowdown=true;
      assert(!rebuyState.viewer?.rebuy_offer&&Number(rebuyState.showdown_until)>Number(rebuyState.server_now),
        'Rebuy offer appeared before the showdown hold finished.');
      for(const page of [one,two]) await wait(page,()=>
        document.querySelector('#blind-level-countdown')?.getAttribute('aria-label')?.includes('paused at')&&
        document.querySelectorAll('#seat-grid .seat-cards .mini-card:not(.back)').length>=4&&
        !document.querySelector('#rebuy-offer-dialog')?.open&&
        document.querySelector('#table-announcements')?.hidden&&
        document.querySelector('#street-label')?.dataset.holdLabel?.includes('Hands visible'));
      const frozen=await evaluate(one,()=>document.querySelector('#blind-level-countdown').textContent);
      await one.screenshot('rebuy-showdown-before-offer');
      await click(one,'#pause-button');
      for(const page of [one,two]) await assertPauseCover(page);
      await one.screenshot('host-pause-showdown');
      await sleep(1100);
      await click(one,'#pause-cover-resume');
      for(const page of [one,two]) await wait(page,()=>document.querySelector('#paused-banner')?.hidden);
      assert(await evaluate(one,value=>document.querySelector('#blind-level-countdown')?.textContent===value&&
        !document.querySelector('#rebuy-offer-dialog')?.open&&document.querySelector('#rebuy-waiting')?.hidden,frozen),
        'The blind clock ran or the rebuy UI obscured the showdown.');
    }
    for(let attempt=0;attempt<80&&!offerOwner;attempt++) {
      for(const user of users.slice(0,2)) {
        const current=(await request(rebuyPath,user)).table;
        if(current.viewer?.rebuy_offer) {offerOwner=user;offerView=current;break;}
        if(current.status==='completed') break;
      }
      if(!offerOwner) {
        const current=(await request(rebuyPath,users[0])).table;
        if(current.hand_no>thisHand&&current.actor_id) break;
        if(current.status==='completed') break;
        await sleep(125);
      }
    }
  }
  if(!offerOwner) throw Error('A multiway elimination did not create the expected rebuy offer.');
  assert(checkedShowdown,'The real game did not verify the showdown-before-rebuy phase.');
  const acceptPage=offerOwner===users[0]?one:two,otherPage=acceptPage===one?two:one;
  await wait(acceptPage,()=>document.querySelector('#rebuy-offer-dialog')?.open===true);
  const offerUi=await evaluate(acceptPage,()=>({
    summary:document.querySelector('#rebuy-offer-summary')?.textContent||'',
    countdown:document.querySelector('#rebuy-offer-countdown')?.getAttribute('aria-label')||'',
    confirmText:document.querySelector('#rebuy-offer-accept')?.textContent.trim()||'',
    declineVisible:Boolean(document.querySelector('#rebuy-offer-decline')?.offsetWidth),
  }));
  const secondsLeft=Number(offerUi.countdown.match(/(\d+) seconds left/)?.[1]||0);
  assert(offerUi.summary.includes('$5')&&offerUi.summary.includes('100 chips')&&
    secondsLeft>=1&&secondsLeft<=60&&
    offerUi.confirmText==='Confirm rebuy'&&offerUi.declineVisible,
    'Rebuy offer did not show the locked stack, buy-in, countdown, and explicit choices: '+JSON.stringify(offerUi));
  await wait(otherPage,name=>document.querySelector('#view-table-name')?.textContent===name,rebuyName);
  assert(await evaluate(otherPage,()=>!document.querySelector('#rebuy-offer-dialog')?.open&&
    document.querySelector('#rebuy-offer-button')?.hidden),
    'Another table viewer could see the eliminated player’s private rebuy offer.');
  const rebuyPlayerName=String(offerOwner.player.name||offerOwner.player.display_name||offerOwner.username);
  await wait(otherPage,name=>document.querySelector('#rebuy-waiting')?.textContent.includes('Waiting for '+name+' to rebuy')&&
    !document.querySelector('#rebuy-waiting').hidden,rebuyPlayerName);
  const eventGeometry=await evaluate(otherPage,()=>{
    const event=document.querySelector('#table-announcements').getBoundingClientRect();
    const felt=document.querySelector('#felt').getBoundingClientRect();
    return {dx:Math.abs(event.x+event.width/2-felt.x-felt.width/2),dy:Math.abs(event.y+event.height/2-felt.y-felt.height/2),font:parseFloat(getComputedStyle(document.querySelector('#rebuy-waiting')).fontSize)};
  });
  assert(eventGeometry.dx<2&&eventGeometry.dy<2&&eventGeometry.font>=18,'Rebuy wait was not prominent and centered: '+JSON.stringify(eventGeometry));
  const bustStyle=await evaluate(otherPage,()=>{
    const out=document.querySelector('.seat-card.is-eliminated'),folded=document.querySelector('.seat-card.is-folded:not(.is-eliminated)');
    return {out:Boolean(out),label:out?.querySelector('.seat-status')?.textContent,
      grey:out&&getComputedStyle(out.querySelector('.seat-avatar')).filter,
      border:out&&getComputedStyle(out).borderTopStyle,
      foldedGrey:folded&&getComputedStyle(folded.querySelector('.seat-avatar')).filter};
  });
  assert(bustStyle.out&&bustStyle.label.includes('OUT')&&bustStyle.grey==='grayscale(1)'&&bustStyle.border==='dashed'&&bustStyle.foldedGrey!=='grayscale(1)',
    'Busted seat was not distinct from a folded player: '+JSON.stringify(bustStyle));
  const waitingClock=await evaluate(otherPage,()=>document.querySelector('#blind-level-countdown').textContent);
  await sleep(1100);
  assert(await evaluate(otherPage,value=>document.querySelector('#blind-level-countdown').textContent===value,waitingClock),
    'The blind-level clock ran during the rebuy decision.');
  await otherPage.resize(390,844);await sleep(200);await otherPage.screenshot('rebuy-waiting-phone');
  await otherPage.resize(1366,768);await sleep(200);await otherPage.screenshot('rebuy-waiting-desktop');
  await request(rebuyPath+'/pause',users[0],{paused:true});
  for(const page of [one,two]) {
    await assertPauseCover(page);
    assert(await evaluate(page,()=>!document.querySelector('#rebuy-offer-dialog').open),'Rebuy dialog covered the host pause screen.');
  }
  await click(one,'#pause-cover-resume');
  await wait(acceptPage,()=>document.querySelector('#rebuy-offer-dialog')?.open);
  const offerId=String(offerView.viewer.rebuy_offer.id);
  await evaluate(acceptPage,()=>{
    window.rebuyPostsQA=[];
    window.rebuyResponsesQA=[];
    const original=window.fetch.bind(window);
    window.fetch=async function(input,init) {
      const url=typeof input==='string'?input:input.url;
      const isRebuy=/\/rebuy$/.test(new URL(url,location.origin).pathname)&&String(init?.method||'GET').toUpperCase()==='POST';
      if(isRebuy) window.rebuyPostsQA.push(JSON.parse(init.body||'{}'));
      const response=await original(input,init);
      if(isRebuy) {
        let data={};try{data=await response.clone().json();}catch(_){}
        window.rebuyResponsesQA.push({status:response.status,data});
      }
      return response;
    };
  });
  assert(await evaluate(acceptPage,()=>window.rebuyPostsQA.length===0),
    'The rebuy offer posted before the player confirmed it.');
  await click(acceptPage,'#rebuy-offer-accept');
  await wait(acceptPage,()=>document.querySelector('#rebuy-offer-dialog')?.open===false&&
    document.querySelector('#notice')?.textContent.includes('Rebuy confirmed.')&&window.rebuyResponsesQA?.length===1);
  const rebuyStateAfterPost=await evaluate(acceptPage,()=>({posts:window.rebuyPostsQA,responses:window.rebuyResponsesQA}));
  const rebuyPost=rebuyStateAfterPost.posts;
  assert(rebuyPost.length===1&&rebuyPost[0].offer_id===offerId&&rebuyPost[0].confirm===true&&
    rebuyStateAfterPost.responses.length===1&&rebuyStateAfterPost.responses[0].status===200,
    'Confirm rebuy did not submit exactly one idempotent, confirmed request: '+JSON.stringify(rebuyStateAfterPost));
  await wait(otherPage,name=>!document.querySelector('#rebuy-outcome')?.hidden&&
    document.querySelector('#rebuy-outcome').textContent.includes(name+' rebought'),rebuyPlayerName);
  await otherPage.screenshot('rebuy-outcome-desktop');
  const accepted=(await request(rebuyPath,offerOwner)).table;
  const acceptedSeat=accepted.seats.find(seat=>String(seat.player_id||seat.id)===offerOwner.player.id);
  const offerHandNo=Number(String(offerView.viewer.rebuy_offer.hand_id).split(':').pop());
  const acceptedHandNo=Number(accepted.hand_no);
  const restoredChips=acceptedHandNo===offerHandNo
    ? Number(acceptedSeat?.stack) : Number(acceptedSeat?.stack)+Number(acceptedSeat?.bet||0);
  assert(acceptedSeat&&restoredChips===100&&!accepted.viewer.can_act&&
    Number(acceptedSeat.rebuy_count)===1&&Number(acceptedSeat.total_buy_in_cents)===1000&&
    Number(accepted.prize_pool_cents)===2500&&Number(accepted.viewer.rebuy_count)===1&&
    Number(accepted.viewer.buy_in_count)===2&&Number(accepted.viewer.total_buy_in_cents)===1000,
    'Accepted rebuy did not restore the original stack outside the offer hand and update dollar accounting: '+
      JSON.stringify({acceptedHandNo,offerHandNo,restoredChips,acceptedSeat,viewer:accepted.viewer,pool:accepted.prize_pool_cents}));
  await wait(acceptPage,text=>document.querySelector('#view-table-subtitle')?.textContent.includes('$10'));
  await wait(otherPage,()=>document.querySelector('#rebuy-waiting')?.hidden&&
    !document.querySelector('#blind-level-countdown')?.getAttribute('aria-label')?.includes('paused at'));
  console.log('Confirmed rebuy restored 100 chips, counted a second $5 buy-in, and updated the $25 prize pool with updated totals.');
}
