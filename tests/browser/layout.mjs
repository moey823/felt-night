// Geometry and readability checks for the reserved poker table layout.
export default async function layout([activePage, spectatorPage], sleep, roomPassword) {
  const ev = (page, fn, ...args) => page.evaluate('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')');
  async function wait(page, fn, ...args) {
    for (let i = 0; i < 160; i++) {
      const value = await ev(page, fn, ...args);
      if (value) return value;
      await sleep(100);
    }
    throw Error('Timed out: ' + fn + ' ' + args);
  }
  const visible = selector => Boolean(document.querySelector(selector)?.offsetWidth);
  async function click(page, selector) {
    await wait(page, query => {
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
      for (const type of ['input', 'change']) node.dispatchEvent(new Event(type, {bubbles:true}));
    }, selector, value);
  }
  async function signIn(page, user) {
    await wait(page, visible, '#login-name');
    await setInput(page, '#login-name', user.username);
    await setInput(page, '#login-password', user.password || '');
    await ev(page, () => document.querySelector('#login-form').requestSubmit());
    if (user.username === 'admin') await wait(page, visible, '#admin-panel');
    else await wait(page, visible, '#app-panel');
  }
  async function openTable(page, name, tableId) {
    await wait(page, (tableName, id) => {
      const list = document.querySelector('#table-list');
      let button = [...document.querySelectorAll('[data-open-table]')].find(node => node.innerText.includes(tableName));
      if (!button && id && list) {
        button = document.createElement('button');
        button.type = 'button';
        button.dataset.openTable = id;
        button.textContent = tableName;
        list.append(button);
      }
      if (!button) return false;
      button.click();
      return true;
    }, name, tableId);
    await wait(page, tableName => document.querySelector('#view-table-name')?.textContent === tableName, name);
  }
  async function logout(page) {
    await ev(page, () => {
      const menu = document.querySelector('#table-menu');
      if (menu && !menu.open) menu.querySelector('summary')?.click();
    });
    await click(page, '#table-logout-button');
    await wait(page, visible, '#login-name');
  }

  await wait(activePage, visible, '#login-name');
  const origin = await activePage.evaluate('location.origin');
  const api = origin + '/poker/api';
  const req = async (path, session, data) => {
    const headers = {Origin:origin};
    if (session) Object.assign(headers, {
      Cookie:session.cookie,
      'X-SitNgo-Session':session.session_proof,
      'X-SitNgo-CSRF':session.csrf,
    });
    if (data) headers['Content-Type'] = 'application/json';
    const response = await fetch(api + path, {
      method:data ? 'POST' : 'GET',
      headers,
      body:data ? JSON.stringify(data) : undefined,
    });
    const json = await response.json();
    if (!response.ok) throw Error(path + ' ' + JSON.stringify(json));
    if (path === '/register' || path === '/login') {
      const cookie = response.headers.get('set-cookie')?.split(';')[0];
      if (!cookie) throw Error(path + ' did not issue a session cookie');
      return {...json,cookie};
    }
    return json.table || json;
  };

  const stamp = Date.now().toString(36);
  async function register(username, suffix) {
    const password = 'LayoutPass_' + suffix + '_' + stamp;
    const session = await req('/register', null, {room_password:roomPassword,username,password});
    return {...session,username,password};
  }
  const names = ['Alex','Sam','Jordan','Riley','Morgan','Casey','Taylor','Avery','Jamie'];
  const players = [];
  for (let i=0;i<names.length;i++) players.push(await register(names[i],String(i)));
  const spectator = await register('LayoutObserver','observer');
  const admin = await req('/login',null,{username:'admin',password:''});
  await req('/admin/config',admin,{
    runout_seconds:1,blind_announcement_seconds:0,elimination_announcement_seconds:0,
    showdown_seconds:60,bet_presets:{preflop_bb:[2.5,3,4],postflop_percent:[50,75,100]},
  });

  const host = players[0];
  const tableName = 'Layout QA ' + stamp;
  const table = await req('/tables',host,{
    name:tableName,max_seats:9,starting_stack:100,small_blind:10,big_blind:20,
    level_minutes:54,turn_seconds:3600,buy_in:10,payout_percentages:[60,25,15],
  });
  const tablePath = '/tables/' + table.id;
  for (let i=1;i<players.length;i++) await req(tablePath + '/seat',players[i],{seat_no:i});

  await signIn(activePage,host);
  await openTable(activePage,tableName,table.id);
  await wait(activePage,() => ['waiting','lobby'].some(word => (document.querySelector('#view-status')?.textContent || '').toLowerCase().includes(word)));
  await activePage.resize(360,740);
  await click(activePage,'#table-menu > summary');
  await click(activePage,'#runtime-settings-button');
  await wait(activePage,() => document.querySelector('#table-settings-dialog')?.open === true);
  await ev(activePage,() => {
    const dialog=document.querySelector('#table-settings-dialog');
    dialog.scrollTop=dialog.scrollHeight;
  });
  await sleep(80);
  const closeMetrics = await ev(activePage,() => {
    const dialog=document.querySelector('#table-settings-dialog');
    const button=document.querySelector('#settings-dialog-close');
    const d=dialog.getBoundingClientRect(),b=button.getBoundingClientRect();
    const hit=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);
    return {inView:b.top>=d.top-1&&b.bottom<=d.bottom+1,height:b.height,
      hit:Boolean(hit&&(hit===button||button.contains(hit)))};
  });
  if (!closeMetrics.inView || closeMetrics.height<44 || !closeMetrics.hit) {
    throw Error('Settings dialog close is not reachable: '+JSON.stringify(closeMetrics));
  }
  await click(activePage,'#settings-dialog-close');
  await wait(activePage,() => document.querySelector('#table-settings-dialog')?.open === false);

  let view = await req(tablePath+'/start',host,{});
  const actor = players.find(session => session.player.id === view.actor_id);
  if (!actor) throw Error('No active player after the table started');
  if (actor.player.id !== host.player.id) {
    await logout(activePage);
    await signIn(activePage,actor);
    await openTable(activePage,tableName,table.id);
  }
  await wait(activePage,visible,'.table-surface > #action-panel #action-controls [data-raise-preset]');
  await signIn(spectatorPage,spectator);
  await openTable(spectatorPage,tableName,table.id);

  const viewports=[
    {width:390,height:844,together:true},
    {width:360,height:740,together:true},
    {width:768,height:1024,together:true},
    {width:1366,height:768,together:false},
    {width:844,height:390,together:false},
    {width:320,height:568,together:false},
  ];
  const failures=[];
  function geometry(expected,active,together) {
    const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
    const area=(a,b)=>Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*
      Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
    const seats=[...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')];
    const heroPair=document.querySelector('.seat-card.is-me .seat-cards.is-viewer-cards');
    const cards=[...document.querySelectorAll('.seat-card.is-me .seat-cards.is-viewer-cards .mini-card')];
    const board=document.querySelector('#felt .board-center');
    const panel=document.querySelector('#action-panel'),felt=document.querySelector('#felt');
    const errors=[];
    if(seats.length!==expected) errors.push('seat count '+seats.length);
    if(!board||!board.offsetWidth) errors.push('center board missing');
    if(document.documentElement.scrollWidth>innerWidth+1) errors.push('horizontal overflow');
    if(document.querySelectorAll('#board-cards .playing-card.placeholder').length) errors.push('empty board ghosts');
    for(let i=0;i<seats.length;i++) {
      const seat=seats[i],name=seat.querySelector('.seat-name'),font=parseFloat(getComputedStyle(name).fontSize||'0');
      if(font<(innerWidth>820?12:11)) errors.push('seat label too small '+i+':'+font);
      if(name.scrollWidth>name.clientWidth+1) errors.push('seat label clipped '+i);
      if(area(rect(seat),rect(board))>5) errors.push('board overlaps seat '+i);
      for(let j=0;j<i;j++) if(area(rect(seat),rect(seats[j]))>5) errors.push('seats overlap '+j+'/'+i);
      const stack=seat.querySelector('.seat-stack'),row=seat.querySelector('.seat-cards');
      if(stack&&row&&area(rect(stack),rect(row))>1) errors.push('stack overlaps cards '+i);
      if(!row||row.getBoundingClientRect().height<1) errors.push('card row collapsed '+i);
      if(getComputedStyle(row).overflow==='hidden'&&row.scrollHeight>row.clientHeight+1) errors.push('card row clips content '+i);
      for(const card of seat.querySelectorAll('.mini-card')) {
        const b=rect(card),parent=rect(seat);
        if(b.width<17||b.height<25||b.left<parent.left-1||b.right>parent.right+1||b.top<parent.top-1||b.bottom>parent.bottom+1) {
          errors.push('card clipped in seat '+i);
        }
      }
    }
    for(const wager of document.querySelectorAll('#seat-grid .seat-wager:not(.is-unplaced)')) {
      for(let i=0;i<seats.length;i++) if(area(rect(wager),rect(seats[i]))>5) errors.push('wager overlaps seat '+i);
    }
    if(active) {
      if(!panel||panel.hidden||felt.contains(panel)) errors.push('action dock missing or inside felt');
      if(panel&&panel.parentElement!==document.querySelector('#table-surface')) errors.push('action dock outside table surface');
      if(panel&&area(rect(panel),rect(felt))>1) errors.push('dock overlaps felt');
      const buttons=[...document.querySelectorAll('#action-panel .action-buttons [data-poker-action]')];
      const presets=[...document.querySelectorAll('#action-panel [data-raise-preset]')];
      const range=document.querySelector('#action-panel input[type=range]');
      if(buttons.length!==3||buttons.some(button=>button.disabled)) errors.push('primary actions unavailable');
      if(presets.length!==3) errors.push('bet presets missing');
      for(const control of [...buttons,...presets,range].filter(Boolean)) {
        const b=rect(control),hit=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);
        if(b.height<44) errors.push('touch target below 44px '+(control.textContent||control.id));
        if(b.left>=0&&b.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight&&(!hit||!(hit===control||control.contains(hit)))) errors.push('touch target covered '+(control.textContent||control.id));
      }
      if(together&&heroPair) {
        const h=rect(heroPair),p=rect(panel),b=rect(board);
        if(h.top<0||h.bottom>innerHeight||p.bottom>innerHeight||b.top<0||b.bottom>innerHeight) {
          errors.push('board, hero cards, and actions do not fit together');
        }
      }
      if(cards.length!==2) errors.push('hero cards missing');
      for(const card of cards) {
        const b=rect(card);
        if(b.width<27||b.height<38||b.left<0||b.right>innerWidth+1) errors.push('hero card clipped or too small');
      }
    } else if(panel&&!panel.hidden&&!document.querySelector(".seat-card.is-me")) {
      errors.push("spectator action dock visible");
    } else if(panel&&!panel.hidden&&document.querySelector(".seat-card.is-me")) {
      const controls=[...panel.querySelectorAll(".action-buttons [data-poker-action]")];
      if(controls.some(button=>!button.disabled)) errors.push("all-in action buttons should be disabled");
    }
    return {errors,viewport:[innerWidth,innerHeight],grid:rect(document.querySelector("#seat-grid")),felt:rect(felt),board:rect(board),
      hero:heroPair?rect(heroPair):null,action:panel&&!panel.hidden?rect(panel):null,seatCount:seats.length};
  }

  for(const {width,height,together} of viewports) {
    await activePage.resize(width,height);
    await spectatorPage.resize(width,height);
    await sleep(180);
    await ev(activePage,()=>window.scrollTo(0,0));
    await ev(spectatorPage,()=>window.scrollTo(0,0));
    await sleep(60);
    const active=await ev(activePage,geometry,9,true,together);
    const observer=await ev(spectatorPage,geometry,9,false,false);
    console.log('Preflop '+width+'x'+height,JSON.stringify(active));
    if(width===390&&height===844) {
      const structure=await ev(activePage,()=>{
        const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
        const summary=node=>{const s=getComputedStyle(node);return {id:node.id,className:node.className,hidden:node.hidden,rect:rect(node),display:s.display,position:s.position,marginTop:s.marginTop,marginBottom:s.marginBottom,paddingTop:s.paddingTop,gridRow:s.gridRow,flex:s.flex,minHeight:s.minHeight,height:s.height};};
        const view=document.querySelector('#table-view');
        return {scrollY,view:summary(view),children:[...view.children].map(summary),
          app:summary(document.querySelector('#app-panel')),shell:summary(document.querySelector('.app-shell')),
          seats:[...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')].map(node=>({index:node.dataset.relativeSeat,name:node.querySelector('.seat-name')?.textContent,seat:rect(node),label:rect(node.querySelector('.seat-name')),labelWidth:node.querySelector('.seat-name')?.clientWidth,labelScrollWidth:node.querySelector('.seat-name')?.scrollWidth}))};
      });
      console.log('Structure 390x844',JSON.stringify(structure));
    }
    console.log('Observer '+width+'x'+height,JSON.stringify(observer));
    if((width===320&&height===568)||(width===360&&height===740)||(width===844&&height===390)) {
      const seats=await ev(activePage,()=>{
        const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
        return [...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')].map(node=>({relative:node.dataset.relativeSeat,name:node.querySelector('.seat-name')?.textContent,rect:rect(node),stack:rect(node.querySelector('.seat-stack')),cards:rect(node.querySelector('.seat-cards'))}));
      });
      console.log('SeatRects '+width+'x'+height,JSON.stringify(seats));
    }
    if(active.errors.length) failures.push('Preflop '+width+'x'+height+': '+active.errors.join(', '));
    if(observer.errors.length) failures.push('Observer '+width+'x'+height+': '+observer.errors.join(', '));
    await activePage.screenshot('preflop-'+width+'x'+height);
  }

  const selectPreset=()=> {
    const button=document.querySelector('#action-panel [data-raise-preset]');
    const b=button.getBoundingClientRect(),hit=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);
    if(!hit||!(hit===button||button.contains(hit))) throw Error('Raise preset is obstructed');
    button.click();
    return Number(button.dataset.target);
  };
  await activePage.resize(1366,900);
  await ev(activePage,()=>window.scrollTo(0,0));
  const selected=await ev(activePage,selectPreset);
  await wait(activePage,target=>Number(document.querySelector('#raise-amount')?.value)===target,selected);

  for(let i=0;i<players.length+2&&view.actor_id;i++) {
    const acting=players.find(session=>session.player.id===view.actor_id);
    if(!acting) throw Error('Unknown active player '+view.actor_id);
    view=await req(tablePath+'/action',acting,{
      action:'all_in',expected_hand:view.hand_no,expected_turn_version:view.turn_version,
    });
  }
  if(view.actor_id) throw Error('All-in round did not close');
  if(view.runout_odds?.length!==players.length) throw Error('All-in did not expose every live hand');
  await wait(activePage,count=>document.querySelectorAll('#seat-grid .seat-equity:not(.is-empty)').length===count,players.length);
  await wait(spectatorPage,count=>document.querySelectorAll('#seat-grid .seat-equity:not(.is-empty)').length===count,players.length);

  for(const {width,height} of [{width:390,height:844},{width:360,height:740},{width:320,height:568},{width:1366,height:768}]) {
    await activePage.resize(width,height);
    await spectatorPage.resize(width,height);
    await sleep(180);
    await ev(activePage,()=>window.scrollTo(0,0));
    await ev(spectatorPage,()=>window.scrollTo(0,0));
    const active=await ev(activePage,geometry,9,false,false);
    const observer=await ev(spectatorPage,geometry,9,false,false);
    console.log('All-in '+width+'x'+height,JSON.stringify(active));
    if(active.errors.length) failures.push('All-in '+width+'x'+height+': '+active.errors.join(', '));
    if(observer.errors.length) failures.push('All-in observer '+width+'x'+height+': '+observer.errors.join(', '));
    await activePage.screenshot('all-in-'+width+'x'+height);
  }

  await wait(activePage,()=>((document.querySelector('#street-label')?.textContent||'').toLowerCase().includes('showdown')));
  const announcementMetrics=await ev(activePage,()=>{
    const region=document.querySelector("#table-announcements");
    const banner=document.querySelector("#announcement-banner");
    const summary=document.querySelector("#showdown-summary");
    const felt=document.querySelector("#felt");
    const heroCards=document.querySelector(".seat-card.is-me .seat-cards");
    const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
    const area=(a,b)=>Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*
      Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
    const hidden={region:region.hidden,banner:banner.hidden,summary:summary.hidden};
    const text=banner.textContent;
    const before=rect(heroCards);
    const beforePage=scrollY;
    const beforeView=rect(document.querySelector("#table-view"));
    const beforeHeader=rect(document.querySelector(".table-shell-header"));
    const beforeRegion=rect(region);
    const beforeSurface=rect(document.querySelector("#table-surface"));
    const beforeFelt=rect(felt);
    const beforeGrid=rect(document.querySelector("#seat-grid"));
    const beforeSeat=rect(document.querySelector(".seat-card.is-me"));
    summary.hidden=true;
    banner.textContent="A table announcement";
    banner.hidden=false;
    region.hidden=false;
    const visible=rect(banner),feltRect=rect(felt),after=rect(heroCards);
    const titleVisibility=getComputedStyle(document.querySelector(".table-shell-title")).visibility;
    const regionRect=rect(region);
    const result={overlap:area(visible,feltRect),regionOverlap:area(regionRect,feltRect),
      cardShift:Math.abs((before.top+before.bottom-after.top-after.bottom)/2),
      titleVisibility,position:getComputedStyle(region).position,scrollYBefore:beforePage,scrollYAfter:scrollY,
      announcement:visible,region:regionRect,felt:feltRect,before,after,
      beforeView,beforeHeader,beforeRegion,beforeSurface,beforeFelt,beforeGrid,beforeSeat,
      view:rect(document.querySelector("#table-view")),header:rect(document.querySelector(".table-shell-header")),
      surface:rect(document.querySelector("#table-surface")),grid:rect(document.querySelector("#seat-grid")),
      seat:rect(document.querySelector(".seat-card.is-me"))};
    region.hidden=hidden.region;
    banner.hidden=hidden.banner;
    summary.hidden=hidden.summary;
    banner.textContent=text;
    return result;
  });
  console.log("Announcement rail",JSON.stringify(announcementMetrics));
  if(announcementMetrics.overlap>1||announcementMetrics.regionOverlap>1) failures.push("announcement overlaps felt");
  if(announcementMetrics.cardShift>1) failures.push("announcement moves seat cards");
  if(announcementMetrics.titleVisibility!=="hidden") failures.push("announcement does not replace header title");
  const finalMetrics=await ev(activePage,geometry,9,false,false);
  if(finalMetrics.errors.length) failures.push('Showdown: '+finalMetrics.errors.join(', '));
  await activePage.screenshot('showdown');

  await logout(spectatorPage);
  await signIn(spectatorPage,{username:'admin',password:''});
  await spectatorPage.resize(390,844);
  const adminMetrics=await ev(spectatorPage,()=>{
    const fields=[...document.querySelectorAll('#admin-config-form input')];
    const clipped=fields.filter(node=>{const r=node.getBoundingClientRect();return r.left<0||r.right>innerWidth+1||r.width<180;}).map(node=>node.id);
    return {count:fields.length,clipped};
  });
  if(adminMetrics.clipped.length) failures.push('Admin form fields clipped on phone: '+adminMetrics.clipped.join(', '));
  if(failures.length) throw Error('Table layout failures:\n - '+failures.join('\n - '));
}
