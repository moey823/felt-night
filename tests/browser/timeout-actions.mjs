import {seedAvatar} from './avatar-fixture.mjs';

// Real shot-clock races for timeout badges, quiet stale refreshes, and error references.
export default async function timeoutActions([one,two], sleep, roomPassword) {
  const ev=(page,fn,...args)=>page.evaluate('('+fn.toString()+')(...'+JSON.stringify(args)+')');
  const assert=(ok,message)=>{if(!ok)throw Error(message);};
  async function wait(page,fn,...args) {
    for(let n=0;n<300;n++){const value=await ev(page,fn,...args);if(value)return value;await sleep(100);}
    throw Error('Timed out: '+fn+' '+await ev(page,()=>document.body?.innerText.slice(-900)));
  }
  const origin=await one.evaluate('location.origin'),api=origin+'/poker/api';
  async function request(path,user,body,method) {
    const headers={Origin:origin};
    if(user)Object.assign(headers,{Cookie:user.cookie,'X-SitNgo-Session':user.session_proof,'X-SitNgo-CSRF':user.csrf});
    if(body!==undefined)headers['Content-Type']='application/json';
    const response=await fetch(api+path,{method:method||(body===undefined?'GET':'POST'),headers,
      body:body===undefined?undefined:JSON.stringify(body)});
    const data=await response.json();
    if(!response.ok)throw Error(path+' '+JSON.stringify(data));
    if(path==='/register'||path==='/login'){
      const cookie=response.headers.get('set-cookie')?.split(';')[0];
      if(!cookie)throw Error('Registration did not issue a session cookie');
      return {...data,cookie};
    }
    return data.table||data;
  }
  async function signIn(page,user,table) {
    const route='/poker/table?table='+encodeURIComponent(table.id);
    await ev(page,next=>window.location.assign(next),route);
    await wait(page,next=>location.pathname==='/poker/table'&&location.search===new URL(next,location.origin).search&&
      document.querySelector('#login-panel')?.hidden===false&&Boolean(document.querySelector('#login-name')?.offsetWidth),route);
    await ev(page,(name,password,invite)=>{
      for(const [selector,value] of [['#login-name',name],['#login-password',password],['#room-password',invite]]){
        const input=document.querySelector(selector);input.value=value;
        input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
      }
      document.querySelector('#login-form').requestSubmit();
    },user.username,user.password,roomPassword);
    await wait(page,()=>document.querySelector('#app-panel')?.hidden===false);
    await wait(page,name=>!document.querySelector('#table-view')?.hidden&&document.querySelector('#view-table-name')?.textContent===name,table.name);
  }
  async function goTable(page,table) {
    await ev(page,id=>window.location.assign('/poker/table?table='+encodeURIComponent(id)),table.id);
    await wait(page,name=>!document.querySelector('#table-view')?.hidden&&document.querySelector('#view-table-name')?.textContent===name,table.name);
  }
  async function newTable(host,guest,name,seconds=12) {
    const table=await request('/tables',host,{name,starting_stack:1000,small_blind:10,big_blind:20,
      level_minutes:60,turn_seconds:seconds,buy_in:0,payout_percentages:[100]});
    const path='/tables/'+table.id;await request(path+'/join',guest,{});
    return {...table,path};
  }
  const admin=await request('/login',null,{username:'admin',password:'test-admin-password',room_password:roomPassword});
  await request('/admin/config',admin,{uncontested_seconds:8});
  const stamp=Date.now().toString(36);
  const hostName=('TimeoutHost'+stamp).slice(0,24),guestName=('TimeoutGuest'+stamp).slice(0,24);
  const hostPass='TimeoutHost_'+stamp+'_Pass',guestPass='TimeoutGuest_'+stamp+'_Pass';
  const host={...await request('/register',null,{room_password:roomPassword,username:hostName,password:hostPass}),username:hostName,password:hostPass};
  const guest={...await request('/register',null,{room_password:roomPassword,username:guestName,password:guestPass}),username:guestName,password:guestPass};
  await seedAvatar(request,host,'fish');await seedAvatar(request,guest,'whale');
  const userById=new Map([[host.player.id,host],[guest.player.id,guest]]);
  const pageById=new Map([[host.player.id,one],[guest.player.id,two]]);

  // Hold a fold in transit until the server auto-folds and advances the hand.
  const foldTable=await newTable(host,guest,'Timeout fold '+stamp);
  await Promise.all([signIn(one,host,foldTable),signIn(two,guest,foldTable)]);
  const started=await request(foldTable.path+'/start',host,{});
  const actor=userById.get(started.actor_id),actorPage=pageById.get(started.actor_id);
  const actorView=await request(foldTable.path,actor);
  assert(actorView.viewer?.can_act&&actorView.viewer?.to_call>0,'Expected the preflop actor to owe chips.');
  await wait(actorPage,()=>{const b=document.querySelector('#action-controls [data-action-slot="fold"]');return b&&!b.disabled;});
  await ev(actorPage,()=>{
    const original=window.fetch.bind(window);window.__timeoutGate={used:false,pending:false,response:null};
    window.fetch=async function(input,init){
      const url=typeof input==='string'?input:input.url,method=String((init&&init.method)||'GET').toUpperCase();
      if(method==='POST'&&new URL(url,location.origin).pathname.endsWith('/action')&&!window.__timeoutGate.used){
        const gate=window.__timeoutGate;gate.used=true;gate.pending=true;await new Promise(resolve=>{gate.release=resolve;});
        const response=await original(input,init);gate.response={status:response.status,body:await response.clone().json()};return response;
      }
      return original(input,init);
    };
    document.querySelector('#action-controls [data-action-slot="fold"]').click();
  });
  await wait(actorPage,()=>window.__timeoutGate?.pending);
  await wait(actorPage,()=>document.querySelector('#last-action-summary .last-action-detail')?.textContent.trim()==='Fold \u00b7 TIMEOUT');
  const timedFold=await request(foldTable.path,actor);
  const foldEvent=(timedFold.events||[]).slice().reverse().find(e=>e.type==='action'&&e.timed_out);
  const seatBadge=await ev(actorPage,id=>{
    const seat=[...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')].find(n=>n.dataset.playerId===id);
    return seat?.querySelector('.seat-action.kind-fold')?.textContent.replace(/\s+/g,' ').trim()||'';
  },actor.player.id);
  assert(foldEvent?.action==='fold'&&timedFold.hand_no===started.hand_no,'Timeout fold missing from public events.');
  assert(seatBadge==='FOLD \u00b7 TIMEOUT','Seat timeout badge missing: '+seatBadge);
  await actorPage.resize(1440,900);
  await sleep(150);
  await actorPage.screenshot('timeout-fold-desktop');
  await actorPage.resize(320,568);
  await sleep(150);
  await actorPage.screenshot('timeout-fold-320');
  const mobileBadge=await ev(actorPage,id=>{
    const center=document.querySelector('#last-action-summary'), detail=center?.querySelector('.last-action-detail');
    const style=center&&getComputedStyle(center), centerRect=center?.getBoundingClientRect();
    const seat=[...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')].find(n=>n.dataset.playerId===id);
    const badge=seat?.querySelector('.seat-action.kind-fold'), r=badge?.getBoundingClientRect();
    const centerVisible=Boolean(center&&!center.hidden&&style.display!=='none'&&style.visibility!=='hidden'&&
      Number(style.opacity)!==0&&centerRect.width>1&&centerRect.height>1);
    return {viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,centerVisible,
      centerText:detail?.textContent.trim()||'',centerBounds:centerRect&&[centerRect.left,centerRect.top,centerRect.right,centerRect.bottom],
      seatText:badge?.textContent.replace(/\s+/g,' ').trim()||'',
      seatWidth:r?.width||0,seatScroll:badge?.scrollWidth||0,seatClient:badge?.clientWidth||0};
  },actor.player.id);
  console.log('Timeout badge mobile geometry: '+JSON.stringify(mobileBadge));
  assert(mobileBadge.viewport===320&&mobileBadge.scrollWidth<=321&&mobileBadge.seatWidth>30&&mobileBadge.seatScroll<=mobileBadge.seatClient+1&&
    mobileBadge.centerText==='Fold \u00b7 TIMEOUT'&&mobileBadge.seatText==='FOLD \u00b7 TIMEOUT',
    'Timeout badges overflowed or disappeared at 320px: '+JSON.stringify(mobileBadge));
  await actorPage.resize(1440,900);
  await ev(actorPage,()=>window.__timeoutGate.release());
  await wait(actorPage,()=>window.__timeoutGate?.response&&document.querySelector('#action-panel')?.getAttribute('aria-busy')==='false'&&
    document.querySelector('#action-feedback')?.hidden&&document.querySelector('#notice')?.hidden);
  const stale=await ev(actorPage,()=>window.__timeoutGate.response);
  assert(stale.status===409&&['stale_hand','stale_turn','hand_not_active'].includes(stale.body?.error?.code),'Expected a stale action response: '+JSON.stringify(stale));

  // A free timeout remains a check; its visible seat badge survives the street change and reload.
  const checkTable=await newTable(host,guest,'Timeout check '+stamp);
  await Promise.all([goTable(one,checkTable),goTable(two,checkTable)]);
  const begun=await request(checkTable.path+'/start',host,{});
  const small=userById.get(begun.actor_id),smallView=await request(checkTable.path,small);
  assert(smallView.viewer?.can_act&&smallView.viewer?.to_call>0,'Expected a preflop call.');
  const afterCall=await request(checkTable.path+'/action',small,{
    action:'call',expected_hand:smallView.hand_no,expected_turn_version:smallView.turn_version
  });
  const big=userById.get(afterCall.actor_id),bigPage=pageById.get(afterCall.actor_id);
  const bigView=await request(checkTable.path,big);
  assert(bigPage&&bigView.viewer?.can_act&&bigView.viewer?.to_call===0,'Expected a free big blind check.');
  await wait(bigPage,()=>{const b=document.querySelector('#action-controls [data-action-slot="call"]');return b&&!b.disabled;});
  await wait(bigPage,id=>{
    const seat=document.querySelector('[data-player-id="'+id+'"] .seat-action.kind-check');
    const rect=seat?.getBoundingClientRect(), style=seat&&getComputedStyle(seat);
    return seat?.textContent.trim()==='CHECK \u00b7 TIMEOUT'&&rect.width>30&&rect.height>5&&
      style.display!=='none'&&style.visibility!=='hidden'&&style.clipPath==='none';
  },big.player.id);
  const checked=await request(checkTable.path,big);
  const checkEvent=(checked.events||[]).slice().reverse().find(e=>e.type==='action'&&e.timed_out);
  assert(checkEvent?.action==='check'&&checked.street==='flop','Free timeout did not check and advance streets.');
  await bigPage.reload();
  await wait(bigPage,id=>{
    const seat=document.querySelector('[data-player-id="'+id+'"] .seat-action.kind-check');
    const rect=seat?.getBoundingClientRect(), style=seat&&getComputedStyle(seat);
    return seat?.textContent.trim()==='CHECK \u00b7 TIMEOUT'&&rect.width>30&&rect.height>5&&
      style.display!=='none'&&style.visibility!=='hidden'&&style.clipPath==='none';
  },big.player.id);

  // Use a long shot clock so concrete API errors can be inspected without another timeout.
  const errorTable=await newTable(host,guest,'Timeout error '+stamp,3600);
  await Promise.all([goTable(one,errorTable),goTable(two,errorTable)]);
  const errorStarted=await request(errorTable.path+'/start',host,{});
  const errorActor=userById.get(errorStarted.actor_id),errorPage=pageById.get(errorStarted.actor_id);
  const errorView=await request(errorTable.path,errorActor);
  assert(errorPage&&errorView.viewer?.can_act,'Could not find the active player for 409 coverage.');
  await wait(errorPage,()=>{const b=document.querySelector('#action-controls [data-action-slot="call"]');return b&&!b.disabled;});
  const reason='Player actions are unavailable while the tournament is paused.';
  await ev(errorPage,message=>{
    const original=window.fetch.bind(window);window.__fake409Used=false;
    window.fetch=async function(input,init){
      const url=typeof input==='string'?input:input.url;
      if(String((init&&init.method)||'GET').toUpperCase()==='POST'&&new URL(url,location.origin).pathname.endsWith('/action')&&!window.__fake409Used){
        window.__fake409Used=true;return new Response(JSON.stringify({error:{code:'table_paused',message}}),{status:409,headers:{'Content-Type':'application/json'}});
      }
      return original(input,init);
    };
    document.querySelector('#action-controls [data-action-slot="call"]').click();
  },reason);
  await wait(errorPage,message=>!document.querySelector('#action-feedback')?.hidden&&
    document.querySelector('#action-feedback')?.textContent===message,reason);
  await wait(errorPage,()=>document.querySelector('#action-panel')?.getAttribute('aria-busy')==='false'&&
    !document.querySelector('#action-controls [data-action-slot="call"]')?.disabled);
  const internal='The action failed unexpectedly.';
  await ev(errorPage,message=>{
    const original=window.fetch.bind(window);window.__fake500Used=false;
    window.fetch=async function(input,init){
      const url=typeof input==='string'?input:input.url;
      if(String((init&&init.method)||'GET').toUpperCase()==='POST'&&new URL(url,location.origin).pathname.endsWith('/action')&&!window.__fake500Used){
        window.__fake500Used=true;
        return new Response(JSON.stringify({error:{code:'internal_error',message}}),{status:500,
          headers:{'Content-Type':'application/json','X-Request-ID':'cafebabedeadbeef'}});
      }
      return original(input,init);
    };
    document.querySelector('#action-controls [data-action-slot="call"]').click();
  },internal);
  await wait(errorPage,message=>!document.querySelector('#action-feedback')?.hidden&&
    document.querySelector('#action-feedback')?.textContent===message+' Reference cafebabe.',internal);
  console.log('Timeout fold/check badges, quiet stale refresh, concrete 409 reasons, and internal-error references pass.');
}
