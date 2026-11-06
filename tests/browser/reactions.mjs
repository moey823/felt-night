// Two-client regression for private shortcuts, local favorites, delivery, and compact nine-seat layout.
export default async function reactions([one,two], sleep, roomPassword) {
  const evaluate=(page,fn,...args)=>page.evaluate('('+fn.toString()+')(...'+JSON.stringify(args)+')');
  const assert=(ok,message)=>{if(!ok) throw Error(message)};
  async function wait(page,fn,...args) {
    for(let n=0;n<150;n++) { const result=await evaluate(page,fn,...args); if(result) return result; await sleep(100); }
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
  const stamp=Date.now().toString(36), users=[];
  for(let i=0;i<2;i++) {
    const username=('React'+stamp+i).slice(0,24),password='Felt_'+stamp+'_'+i+'_Test';
    users.push({...await request('/register',null,{username,password,room_password:roomPassword}),username,password});
  }
  async function signIn(page,user) {
    await wait(page,()=>document.querySelector('#login-name')?.offsetWidth);
    await input(page,'#login-name',user.username);
    await input(page,'#login-password',user.password);
    await evaluate(page,()=>document.querySelector('#login-form').requestSubmit());
    await wait(page,()=>document.querySelector('#app-panel')?.offsetWidth);
  }
  const config={name:'Table reactions '+stamp,starting_stack:1200,small_blind:10,big_blind:20,level_minutes:79,turn_seconds:3600};
  const {table}=await request('/tables',users[0],config),path='/tables/'+table.id;
  await Promise.all([signIn(one,users[0]),signIn(two,users[1])]);
  async function open(page,name) {
    await wait(page,n=>{const b=[...document.querySelectorAll('[data-open-table]')].find(b=>b.innerText.includes(n));if(!b)return false;b.click();return true},name);
    await wait(page,n=>document.querySelector('#view-table-name')?.textContent===n,name);
  }
  await Promise.all([open(one,config.name),open(two,config.name)]);
  for(const page of [one,two]) {
    await wait(page,()=>document.querySelector('#hero-seat')?.offsetWidth ||
      document.querySelector('#seat-grid [data-take-seat]')?.offsetWidth);
    if(!await evaluate(page,()=>Boolean(document.querySelector('#hero-seat')))) {
      await click(page,'#seat-grid [data-take-seat]');
      await wait(page,()=>document.querySelector('#hero-seat')?.offsetWidth);
    }
  }
  await wait(one,()=>document.querySelectorAll('#seat-grid .seat-card[data-player-id]').length===2);
  await wait(two,()=>document.querySelectorAll('#seat-grid .seat-card[data-player-id]').length===2);
  const defaults=await evaluate(one,()=>[...document.querySelectorAll('#hero-seat [data-send-reaction]')].map(n=>n.textContent));
  assert(defaults.length===3,'The seated player did not receive exactly three reaction shortcuts.');
  assert(await evaluate(one,()=>!document.querySelector('.seat-card:not(.is-me) [data-send-reaction]')),
    'A player can see shortcuts on another seat.');
  assert(await evaluate(two,()=>!document.querySelector('.seat-card:not(.is-me) [data-send-reaction]')),
    'The second player can see shortcuts on another seat.');

  await click(one,'#table-menu > summary');
  await click(one,'#reaction-settings-button');
  await wait(one,()=>document.querySelector('#reaction-settings-dialog')?.open);
  await evaluate(one,()=>{
    const values=['🔥','❤️','🦈'];
    values.forEach((value,index)=>{
      const select=document.querySelector('#reaction-shortcut-'+(index+1));
      select.value=value;
      select.dispatchEvent(new Event('change',{bubbles:true}));
    });
    document.querySelector('#reaction-settings-form').requestSubmit();
  });
  await wait(one,()=>!document.querySelector('#reaction-settings-dialog')?.open);
  await wait(one,()=>[...document.querySelectorAll('#hero-seat [data-send-reaction]')].map(n=>n.textContent).join('')==='🔥❤️🦈');
  const saved=await evaluate(one,id=>JSON.parse(localStorage.getItem('felt-night.reaction-favorites.v1.'+id)||'null'),users[0].player.id);
  assert(JSON.stringify(saved)===JSON.stringify(['🔥','❤️','🦈']),'Favorite shortcuts were not saved for this account in the browser.');
  assert(await evaluate(two,()=>[...document.querySelectorAll('#hero-seat [data-send-reaction]')].map(n=>n.textContent).join('')==='👏❤️😂'),
    'Changing one account’s favorites changed the other account’s shortcuts.');

  const admin=await request('/login',null,{username:'admin',password:''});
  const tableNow=(await request(path,users[0])).table;
  const occupied=new Set(tableNow.seats.map(seat=>seat.seat_no));
  for(let seatNo=0;seatNo<9;seatNo++) {
    if(!occupied.has(seatNo)) await request(path+'/bots',admin,{seat_no:seatNo});
  }
  await request(path+'/start',users[0],{});
  await Promise.all([one.resize(390,844),two.resize(390,844)]);
  await wait(one,()=>document.querySelectorAll('#seat-grid .seat-card[data-player-id]').length===9 && document.body.classList.contains('gameplay-active'));
  await wait(two,()=>document.querySelectorAll('#seat-grid .seat-card[data-player-id]').length===9 && document.body.classList.contains('gameplay-active'));
  await sleep(350);
  const layout=await evaluate(one,()=>{
    const rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
    const overlaps=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
    const shortcuts=rect(document.querySelector('#hero-seat .reaction-shortcuts'));
    const hero=rect(document.querySelector('#hero-seat'));
    const others=[...document.querySelectorAll('#seat-grid .seat-card:not(.is-me)')].filter(n=>overlaps(shortcuts,rect(n))).length;
    const markers=[...document.querySelectorAll('#hero-seat .seat-action,#hero-seat .seat-wager,#hero-seat .dealer-marker,#hero-seat .seat-turn-clock')].filter(n=>overlaps(shortcuts,rect(n))).length;
    const action=document.querySelector('#action-panel');
    return {width:innerWidth,shortcutCount:document.querySelectorAll('#hero-seat [data-send-reaction]').length,
      intersectsHero:overlaps(shortcuts,hero),intersectsOtherSeat:others>0,intersectsMarker:markers>0,
      intersectsAction:!action.hidden&&overlaps(shortcuts,rect(action)),shortcuts,hero};
  });
  assert(layout.width===390,'Mobile viewport was not applied.');
  assert(layout.shortcutCount===3,'The three shortcuts disappeared on the crowded mobile table.');
  assert(!layout.intersectsHero&&!layout.intersectsOtherSeat&&!layout.intersectsMarker&&!layout.intersectsAction,
    'Reaction shortcuts overlap a seat, marker, or action control at nine seats on mobile: '+JSON.stringify(layout));
  await one.screenshot('reactions-mobile-nine-seat');
  for (const [width,height] of [[1440,900],[1024,768],[390,844],[320,568],[844,390],[667,375]]) {
    await one.resize(width,height);
    await sleep(150);
    const result=await evaluate(one,()=>{
      const summary=document.querySelector('#last-action-summary');
      const hidden=summary.hidden, content=summary.innerHTML;
      summary.hidden=false;
      summary.innerHTML='<span class="last-action-actor">ReactionPlayer</span><strong class="last-action-detail">ALL IN · 1,200 chips</strong>';
      const r=summary.getBoundingClientRect(),felt=document.querySelector('#felt').getBoundingClientRect();
      const overlap=n=>{const b=n.getBoundingClientRect();return b.width>0&&b.height>0&&r.left<b.right&&r.right>b.left&&r.top<b.bottom&&r.bottom>b.top;};
      const blocked=[...document.querySelectorAll('#seat-grid .seat-card, #board-cards, #pot-display, .reaction-shortcuts')].filter(overlap).map(n=>n.className);
      const onFelt=r.left>=felt.left&&r.right<=felt.right&&r.top>=felt.top&&r.bottom<=felt.bottom;
      summary.hidden=hidden;summary.innerHTML=content;
      return {board:document.querySelector(".board-center").getBoundingClientRect().toJSON(),blind:document.querySelector("#blind-strip").getBoundingClientRect().toJSON(),blocked,onFelt,summary:{x:r.x,y:r.y,width:r.width,height:r.height},seats:[...document.querySelectorAll('#seat-grid .seat-card')].map(n=>{const b=n.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height};})};
    });
    assert(result.onFelt&&!result.blocked.length,'Nine-seat felt announcement '+width+'x'+height+': '+JSON.stringify(result));
    await one.screenshot('felt-nine-seat-'+width+'x'+height);
  }
  await one.resize(390,844);


  await click(one,'#hero-seat [data-send-reaction="🔥"]');
  await wait(two,()=>document.querySelectorAll('#reaction-burst-layer .reaction-particle').length>=12);
  const burst=await evaluate(two,()=>({count:document.querySelectorAll('#reaction-burst-layer .reaction-particle').length,
    emoji:document.querySelector('#reaction-burst-layer .reaction-particle')?.textContent}));
  assert(burst.count>=12&&burst.emoji==='🔥','The other client did not render the reaction burst.');
  await sleep(1300);
  const held=await evaluate(two,()=>[...document.querySelectorAll('#reaction-burst-layer .reaction-particle')].filter(n=>
    parseFloat(getComputedStyle(n).opacity)>.9 && parseFloat(getComputedStyle(n).fontSize)>=30).length);
  assert(held>=12,'The reaction faded or stayed too small before viewers could notice it.');
  await two.screenshot('reactions-burst-on-recipient');
  await sleep(2200);
  assert(await evaluate(two,()=>!document.querySelector('#reaction-burst-layer .reaction-particle')),
    'Reaction particles were not cleaned up after the burst.');

  await one.reload();
  await wait(one,()=>document.querySelector('#hero-seat [data-send-reaction]')?.offsetWidth);
  await wait(one,()=>[...document.querySelectorAll('#hero-seat [data-send-reaction]')].map(n=>n.textContent).join('')==='🔥❤️🦈');
  await two.reload();
  await wait(two,()=>document.querySelector('#hero-seat [data-send-reaction]')?.offsetWidth);
  await sleep(1300);
  assert(await evaluate(two,()=>document.querySelectorAll('#reaction-burst-layer .reaction-particle').length===0),
    'A reconnect replayed an earlier reaction burst.');
  console.log('Private three-choice shortcuts, local favorites, two-client burst delivery, reconnect behavior, and nine-seat mobile layout passed.');
}
