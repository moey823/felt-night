// Real browser/API regressions for table seating, persistent sit-out and live chat.
export default async function interactions([one,two], sleep, roomPassword) {
  const evaluate=(page,fn,...args)=>page.evaluate('('+fn.toString()+')(...'+JSON.stringify(args)+')');
  const assert=(ok,message)=>{if(!ok) throw Error(message)};
  async function wait(page,fn,...args) {
    for(let n=0;n<120;n++) { const result=await evaluate(page,fn,...args); if(result) return result; await sleep(100); }
    throw Error('Timed out '+fn+' '+await evaluate(page,()=>document.body.innerText.slice(-800)));
  }
  async function click(page,selector) {
    await wait(page,q=>{const n=document.querySelector(q); if(!n?.offsetWidth||n.disabled)return false; n.click();return true},selector);
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
    if(path==='/register')return {...json,cookie:r.headers.get('set-cookie').split(';')[0]};
    return json;
  }
  const stamp=Date.now().toString(36), users=[];
  for(let i=0;i<3;i++) {
    const username=('Chat'+stamp+i).slice(0,24),password='Felt_'+stamp+'_'+i+'_Test';
    users.push({...await request('/register',null,{username,password,room_password:roomPassword}),username,password});
  }
  async function signIn(page,user) {
    await wait(page,()=>document.querySelector('#login-name')?.offsetWidth);
    await input(page,'#login-name',user.username);await input(page,'#login-password',user.password);
    await evaluate(page,()=>document.querySelector('#login-form').requestSubmit());
    await wait(page,()=>document.querySelector('#app-panel')?.offsetWidth);
  }
  const config={name:'Table interactions '+stamp,max_seats:3,starting_stack:1000,small_blind:10,big_blind:20,level_minutes:79,turn_seconds:3600,runout_seconds:1,showdown_seconds:0,blind_announcement_seconds:0,elimination_announcement_seconds:0};
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
  const botSelector='#seat-grid [data-add-bot-seat]';
  await click(one,botSelector);
  await wait(one,()=>document.querySelectorAll('#seat-grid .seat-card[data-player-id]').length===3);
  const lobby=(await request(path,users[0])).table;
  assert(lobby.seats.some(s=>s.is_bot),'Table-seat Add bot did not add a bot');
  console.log('Phone user seated directly on felt; host added a bot at an empty seat.');
  await request(path+'/bots/'+lobby.seats.find(s=>s.is_bot).seat_no,users[0],undefined,'DELETE');

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
  const chatVersion=started.turn_version;
  await request(path+'/chat',users[1],{text:'Good luck!'});
  const unchanged=(await request(path,users[0])).table;
  assert(unchanged.turn_version===chatVersion,'Chat changed poker turn version');
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
}
