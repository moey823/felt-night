import {seedAvatar} from './avatar-fixture.mjs';

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
    const user={...await request('/register',null,{username,password,room_password:roomPassword}),username,password};
    await seedAvatar(request,user);
    users.push(user);
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
  const defaults=await evaluate(one,()=>[...document.querySelectorAll('#reaction-shortcuts [data-send-reaction]')].map(n=>n.textContent));
  assert(defaults.length===3,'The seated player did not receive exactly three reaction shortcuts.');
  assert(await evaluate(one,()=>!document.querySelector('.seat-card:not(.is-me) [data-send-reaction]')),
    'A player can see shortcuts on another seat.');
  assert(await evaluate(two,()=>!document.querySelector('.seat-card:not(.is-me) [data-send-reaction]')),
    'The second player can see shortcuts on another seat.');

  await click(one,'#table-menu > summary');
  await click(one,'#reaction-settings-button');
  await wait(one,()=>document.querySelector('#reaction-settings-dialog')?.open);
  const settingsBlankClickPreserved=await evaluate(one,()=>{
    const dialog=document.querySelector('#reaction-settings-dialog'),r=dialog.getBoundingClientRect();
    dialog.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.left+2,clientY:r.top+2}));
    return dialog.open;
  });
  assert(settingsBlankClickPreserved,'Clicking blank space inside reaction settings closed the dialog.');
  await one.bringToFront();
  await one.clickAt(1,1);
  await wait(one,()=>!document.querySelector('#reaction-settings-dialog')?.open);
  await click(one,'#table-menu > summary');
  await click(one,'#reaction-settings-button');
  await wait(one,()=>document.querySelector('#reaction-settings-dialog')?.open);
  await evaluate(one,()=>{
    const values=['🔥','💩','🤦'];
    values.forEach((value,index)=>{
      const select=document.querySelector('#reaction-shortcut-'+(index+1));
      select.value=value;
      select.dispatchEvent(new Event('change',{bubbles:true}));
    });
    document.querySelector('#reaction-settings-form').requestSubmit();
  });
  await wait(one,()=>!document.querySelector('#reaction-settings-dialog')?.open);
  await wait(one,()=>[...document.querySelectorAll('#reaction-shortcuts [data-send-reaction]')].map(n=>n.textContent).join('')==='🔥💩🤦');
  const saved=await evaluate(one,id=>JSON.parse(localStorage.getItem('felt-night.reaction-favorites.v1.'+id)||'null'),users[0].player.id);
  assert(JSON.stringify(saved)===JSON.stringify(['🔥','💩','🤦']),'Favorite shortcuts were not saved for this account in the browser.');
  assert(await evaluate(two,()=>[...document.querySelectorAll('#reaction-shortcuts [data-send-reaction]')].map(n=>n.textContent).join('')==='👏❤️😂'),
    'Changing one account’s favorites changed the other account’s shortcuts.');

  const cursorBeforeEdit=Number((await request(path+'/reactions',users[0])).cursor||0);
  await evaluate(one,()=>{
    const button=document.querySelector('#reaction-shortcuts [data-reaction-slot="1"]');
    const event=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2});
    button.dispatchEvent(event);
    return event.defaultPrevented;
  });
  await wait(one,()=>document.querySelector('#reaction-settings-dialog')?.open);
  const rightClickTarget=await evaluate(one,()=>({
    focused:document.activeElement?.id,
    selected:document.querySelector('#reaction-shortcut-2')?.value,
    open:document.querySelector('#reaction-settings-dialog')?.open,
  }));
  assert(rightClickTarget.focused==='reaction-shortcut-2'&&rightClickTarget.selected==='💩'&&rightClickTarget.open,
    'Right-click did not open and focus the matching reaction preset: '+JSON.stringify(rightClickTarget));
  const replacement=await evaluate(one,()=>{
    const selects=[...document.querySelectorAll('[data-reaction-select]')],target=selects[1];
    const option=[...target.options].find(item=>item.value!==target.value&&selects.every((select,index)=>index===1||select.value!==item.value));
    if(!option)throw Error('No unique replacement reaction preset');
    target.value=option.value;target.dispatchEvent(new Event('change',{bubbles:true}));
    document.querySelector('#reaction-settings-form').requestSubmit();
    return option.value;
  });
  await wait(one,emoji=>[...document.querySelectorAll('#reaction-shortcuts [data-send-reaction]')].map(n=>n.textContent).join('')==='🔥'+emoji+'🤦',replacement);
  const updatedFavorites=await evaluate(one,id=>JSON.parse(localStorage.getItem('felt-night.reaction-favorites.v1.'+id)||'null'),users[0].player.id);
  assert(JSON.stringify(updatedFavorites)===JSON.stringify(['🔥',replacement,'🤦']),
    'The right-clicked slot did not update only its saved favorite: '+JSON.stringify(updatedFavorites));

  await evaluate(one,()=>{
    const button=document.querySelector('#reaction-shortcuts [data-reaction-slot="0"]');
    button.focus();
    button.dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true,cancelable:true}));
  });
  await wait(one,()=>document.querySelector('#reaction-settings-dialog')?.open);
  const keyboardSlot=await evaluate(one,()=>document.activeElement?.id);
  assert(keyboardSlot==='reaction-shortcut-1','Shift+F10 did not focus the matching preset selector: '+keyboardSlot);
  await one.pressEscape();
  await wait(one,()=>!document.querySelector('#reaction-settings-dialog')?.open);

  await evaluate(one,async()=>{
    const button=document.querySelector('#reaction-shortcuts [data-reaction-slot="2"]'),rect=button.getBoundingClientRect();
    button.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:73,pointerType:'touch',clientX:rect.left+4,clientY:rect.top+4}));
    await new Promise(resolve=>setTimeout(resolve,700));
    button.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:73,pointerType:'touch',clientX:rect.left+4,clientY:rect.top+4}));
  });
  await wait(one,()=>document.querySelector('#reaction-settings-dialog')?.open);
  const touchSlot=await evaluate(one,()=>document.activeElement?.id);
  assert(touchSlot==='reaction-shortcut-3','Touch-and-hold did not open the corresponding preset: '+touchSlot);
  await one.pressEscape();
  await wait(one,()=>!document.querySelector('#reaction-settings-dialog')?.open);
  const cursorAfterEdit=Number((await request(path+'/reactions',users[0])).cursor||0);
  assert(cursorAfterEdit===cursorBeforeEdit,'Opening or changing reaction shortcuts sent a table reaction.');
  await click(one,'#table-menu > summary');
  await click(one,'#reaction-settings-button');
  await wait(one,()=>document.querySelector('#reaction-settings-dialog')?.open);
  await evaluate(one,()=>{
    const values=['🔥','💩','🤦'];
    values.forEach((value,index)=>{
      const select=document.querySelector('#reaction-shortcut-'+(index+1));
      select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));
    });
    document.querySelector('#reaction-settings-form').requestSubmit();
  });
  await wait(one,()=>!document.querySelector('#reaction-settings-dialog')?.open);
  await wait(one,()=>[...document.querySelectorAll('#reaction-shortcuts [data-send-reaction]')].map(n=>n.textContent).join('')==='🔥💩🤦');

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
    const railNode=document.querySelector('#reaction-shortcuts');
    const controlNode=document.querySelector('#action-controls');
    const buttons=[...railNode.querySelectorAll('[data-send-reaction]')];
    const buttonBoxes=buttons.map(rect);
    const rail=rect(railNode), controls=rect(controlNode), panel=rect(document.querySelector('#action-panel'));
    const felt=rect(document.querySelector('#felt'));
    const dealerNodes=[...document.querySelectorAll('#seat-grid .seat-card > .dealer-marker')];
    const dealer=dealerNodes[0], owner=dealer?.closest('.seat-card');
    const dealerBox=dealer?rect(dealer):null, ownerBox=owner?rect(owner):null;
    const name=owner?.querySelector('.seat-name');
    let nameTextBox=null;
    if(name && name.firstChild) {
      const range=document.createRange();
      range.selectNodeContents(name);
      const r=range.getBoundingClientRect(),clip=rect(name);
      nameTextBox={left:Math.max(r.left,clip.left),top:Math.max(r.top,clip.top),
        right:Math.min(r.right,clip.right),bottom:Math.min(r.bottom,clip.bottom)};
      nameTextBox.width=Math.max(0,nameTextBox.right-nameTextBox.left);
      nameTextBox.height=Math.max(0,nameTextBox.bottom-nameTextBox.top);
    }
    const otherSeats=owner&&dealerBox?[...document.querySelectorAll('#seat-grid .seat-card')].filter(n=>
      n!==owner&&overlaps(dealerBox,rect(n))).length:0;
    const cardBoxes=owner?[...owner.querySelectorAll('.seat-cards .mini-card')].map((n,index)=>['card-'+index,rect(n)]):[];
    const dealerContentBoxes=owner&&dealerBox?[
      ['name',nameTextBox],...cardBoxes,
      ...[['avatar',owner.querySelector('.seat-avatar')],['stack',owner.querySelector('.seat-stack')],
        ['status',owner.querySelector('.seat-status')],['action',owner.querySelector('.seat-action')],
        ['wager',owner.querySelector('.seat-wager')],['clock',owner.querySelector('.seat-turn-clock')]]
        .map(([label,n])=>[label,n?rect(n):null])
    ].filter(([,box])=>box):[];
    const ownContentOverlaps=dealerContentBoxes.filter(([,box])=>overlaps(dealerBox,box)).map(([label])=>label);
    const ordered=buttonBoxes.length===3&&buttonBoxes[0].top<buttonBoxes[1].top&&buttonBoxes[1].top<buttonBoxes[2].top;
    const verticalGaps=buttonBoxes.slice(1).map((box,index)=>box.top-buttonBoxes[index].bottom);
    return {width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,
      clientWidth:document.documentElement.clientWidth,shortcutCount:buttons.length,buttonBoxes,rail,controls,panel,
      leftOfActions:controls.left>=rail.right-1&&controls.left-rail.right<=12,
      verticallyStacked:ordered&&buttonBoxes.every(box=>box.width>=30&&box.height>=30)&&verticalGaps.every(gap=>gap>=0&&gap<=8),
      dealerCount:dealerNodes.length,dealerOwner:owner?.dataset.seatNo||'',dealerDeclared:dealer?.dataset.markerSeat||'',
      dealerAccessible:dealer?.getAttribute('aria-label')==='Dealer button',
      dealerSize:dealerBox?{width:dealerBox.width,height:dealerBox.height}:null,
      dealerAtCorner:dealerBox&&ownerBox?Math.hypot((dealerBox.left+dealerBox.right)/2-ownerBox.right,
        (dealerBox.top+dealerBox.bottom)/2-ownerBox.top)<=24:false,
      dealerContentOverlaps:ownContentOverlaps,dealerContentRects:dealerContentBoxes,dealerOtherSeatOverlap:otherSeats,
      dealerInFelt:dealerBox&&dealerBox.left>=felt.left-1&&dealerBox.right<=felt.right+1&&
        dealerBox.top>=felt.top-1&&dealerBox.bottom<=felt.bottom+1,
      dealerInViewport:dealerBox&&dealerBox.left>=-1&&dealerBox.right<=innerWidth+1&&
        dealerBox.top>=-1&&dealerBox.bottom<=innerHeight+1,
      dealerBox,nameTextBox,ownerBox};
  });
  assert(layout.width===390,'Mobile viewport was not applied.');
  assert(layout.shortcutCount===3&&layout.verticallyStacked,
    'The three reaction shortcuts are not a vertical, usable column on the crowded mobile table: '+JSON.stringify(layout));
  assert(layout.leftOfActions,'The reaction column is not immediately left of the betting controls: '+JSON.stringify(layout));
  assert(layout.documentWidth<=layout.clientWidth+1,'The reaction column caused horizontal page overflow: '+JSON.stringify(layout));
  assert(layout.dealerCount===1&&layout.dealerDeclared===layout.dealerOwner&&layout.dealerAccessible&&
    layout.dealerSize.width>=30&&layout.dealerSize.height>=30&&layout.dealerAtCorner&&
    !layout.dealerContentOverlaps.length&&!layout.dealerOtherSeatOverlap&&layout.dealerInFelt&&layout.dealerInViewport,
    'The prominent dealer chip is missing, misplaced, or collides with seat content: '+JSON.stringify(layout));
  await one.screenshot('reactions-mobile-nine-seat');
  for (const [width,height] of [[1440,900],[1280,800],[1024,768],[390,844],[320,568],[844,390],[667,375]]) {
    await one.resize(width,height);
    await sleep(150);
    const dock=await evaluate(one,()=>{
      const rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
      const rail=document.querySelector('#reaction-shortcuts'),controls=document.querySelector('#action-controls');
      const buttons=[...rail.querySelectorAll('[data-send-reaction]')].map(rect);
      const r=rect(rail),a=rect(controls);
      const dealer=document.querySelector('#seat-grid .seat-card > .dealer-marker'), owner=dealer?.closest('.seat-card');
      const d=dealer?rect(dealer):null,s=owner?rect(owner):null,f=rect(document.querySelector('#felt'));
      const name=owner?.querySelector('.seat-name');
      let text=null;
      if(name&&name.firstChild){const range=document.createRange();range.selectNodeContents(name);const b=range.getBoundingClientRect(),clip=rect(name);text={left:Math.max(b.left,clip.left),top:Math.max(b.top,clip.top),right:Math.min(b.right,clip.right),bottom:Math.min(b.bottom,clip.bottom)};}
      const overlap=(x,y)=>x&&y&&x.left<y.right&&x.right>y.left&&x.top<y.bottom&&x.bottom>y.top;
      const otherSeatRows=owner&&d?[...document.querySelectorAll('#seat-grid .seat-card')].filter(n=>n!==owner&&overlap(d,rect(n))).map(n=>({seatNo:n.dataset.seatNo,box:rect(n)})):[];
      const otherSeats=otherSeatRows.length;
      const cardBoxes=owner?[...owner.querySelectorAll('.seat-cards .mini-card')].map((n,index)=>['card-'+index,rect(n)]):[];
      const dealerContentBoxes=owner&&d?[['name',text],...cardBoxes,...[
        ['avatar',owner.querySelector('.seat-avatar')],['stack',owner.querySelector('.seat-stack')],
        ['status',owner.querySelector('.seat-status')],['action',owner.querySelector('.seat-action')],
        ['wager',owner.querySelector('.seat-wager')],['clock',owner.querySelector('.seat-turn-clock')]
      ].map(([label,n])=>[label,n?rect(n):null])].filter(([,b])=>b):[];
      const ownOverlaps=dealerContentBoxes.filter(([,b])=>overlap(d,b)).map(([label])=>label);
      const gaps=buttons.slice(1).map((b,i)=>b.top-buttons[i].bottom);
      return {width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,
        clientWidth:document.documentElement.clientWidth,count:buttons.length,buttons,rail:r,controls:a,
        leftOfActions:a.left>=r.right-1&&a.left-r.right<=12,
        vertical:buttons.length===3&&buttons[0].top<buttons[1].top&&buttons[1].top<buttons[2].top&&
          buttons.every(b=>b.width>=30&&b.height>=30)&&gaps.every(g=>g>=0&&g<=8),
        dealerCount:document.querySelectorAll('#seat-grid .seat-card > .dealer-marker').length,
        dealerSeat:owner?.dataset.seatNo||'',dealerDeclared:dealer?.dataset.markerSeat||'',
        dealerAccessible:dealer?.getAttribute('aria-label')==='Dealer button',
        dealerSize:d?{width:d.width,height:d.height}:null,
        dealerNearSeat:d&&s?Math.hypot(Math.max(s.left-d.right,d.left-s.right,0),Math.max(s.top-d.bottom,d.top-s.bottom,0))<=22:false,
        dealerCorner:d&&s?Math.hypot((d.left+d.right)/2-s.right,(d.top+d.bottom)/2-s.top)<=24:false,
        dealerInFelt:d&&d.left>=f.left-1&&d.right<=f.right+1&&d.top>=f.top-1&&d.bottom<=f.bottom+1,
        dealerInViewport:d&&d.left>=-1&&d.right<=innerWidth+1&&d.top>=-1&&d.bottom<=innerHeight+1,
        dealerContentOverlaps:ownOverlaps,dealerContentRects:dealerContentBoxes,dealerOtherSeatOverlap:otherSeats,dealerBox:d,ownerBox:s,otherSeatRows};
    });
    assert(dock.count===3&&dock.vertical&&dock.leftOfActions&&dock.documentWidth<=dock.clientWidth+1,
      'Reaction rail geometry failed at '+width+'x'+height+': '+JSON.stringify(dock));
    assert(dock.dealerCount===1&&dock.dealerSeat===dock.dealerDeclared&&dock.dealerAccessible&&
      dock.dealerSize.width>=(width<=380||height<=450?20:30)&&
      dock.dealerSize.height>=(width<=380||height<=450?20:30)&&
      (width<=380||height<=450 ? dock.dealerNearSeat : dock.dealerCorner)&&
      !dock.dealerContentOverlaps.length&&!dock.dealerOtherSeatOverlap&&dock.dealerInFelt&&dock.dealerInViewport,
      'Dealer chip geometry failed at '+width+'x'+height+': '+JSON.stringify(dock));
    const result=await evaluate(one,()=>{
      const center=document.querySelector('#last-action-summary'),style=center&&getComputedStyle(center),cr=center&&center.getBoundingClientRect();
      const centralVisible=Boolean(center&&!center.hidden&&style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)!==0&&cr.width>1&&cr.height>1);
      const rect=n=>{const r=n.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
      const overlaps=(a,b)=>a&&b&&a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
      const board=rect(document.querySelector('.board-center'));
      const seats=[...document.querySelectorAll('#seat-grid .seat-card[data-player-id]')];
      const errors=[];
      const actions=[...document.querySelectorAll('#seat-grid .seat-action[data-action-seat]')].map(badge=>{
        const owner=badge.closest('.seat-card[data-player-id]'),b=rect(badge),s=owner&&rect(owner);
        const inside=Boolean(owner&&b.left>=s.left-1&&b.right<=s.right+1&&b.top>=s.top-1&&b.bottom<=s.bottom+1);
        if(!inside)errors.push('action escaped owner seat');
        if(overlaps(b,board))errors.push('action overlaps board');
        for(const other of seats)if(other!==owner&&overlaps(b,rect(other)))errors.push('action overlaps adjacent seat');
        for(const text of badge.querySelectorAll('.seat-action-verb,.seat-action-value'))if(text.scrollWidth>text.clientWidth+1)errors.push('action text clipped');
        return {seatNo:owner?.dataset.seatNo||'',text:badge.textContent.trim(),inside};
      });
      return {centralVisible,actionCount:actions.length,actions,errors,
        turnVisible:Boolean(document.querySelector('.seat-turn-indicator[data-turn-seat]'))};
    });
    assert(!result.centralVisible&&!result.errors.length,'Per-player action display failed at '+width+'x'+height+': '+JSON.stringify(result));
    await one.screenshot('felt-nine-seat-'+width+'x'+height);
  }
  await one.resize(390,844);


  await one.bringToFront();
  const cursorBefore=Number((await request(path+'/reactions',users[0])).cursor||0);
  const press=await evaluate(one,()=>{
    const grid=document.querySelector('#seat-grid');
    const panel=document.querySelector('#action-panel');
    const button=document.querySelector('#reaction-shortcuts [data-send-reaction="🤦"]');
    const rect=button.getBoundingClientRect();
    window.__heldReactionButton=button;
    window.__reactionPointerDown=false;
    window.__reactionRefreshDuringPress=false;
    panel.addEventListener('pointerdown',event=>{
      if(event.target.closest('[data-send-reaction]')) window.__reactionPointerDown=true;
    },true);
    window.__reactionGridObserver=new MutationObserver(records=>{
      if(window.__reactionPointerDown && records.some(record=>record.type==='childList' && record.target===grid)) {
        window.__reactionRefreshDuringPress=true;
      }
    });
    window.__reactionGridObserver.observe(grid,{childList:true});
    return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};
  });
  await one.pressAt(press.x,press.y);
  await wait(one,()=>window.__reactionRefreshDuringPress);
  const preservedTarget=await evaluate(one,(x,y)=>{
    const hit=document.elementFromPoint(x,y)?.closest('[data-send-reaction]');
    return Boolean(window.__reactionPointerDown && window.__heldReactionButton.isConnected &&
      hit===window.__heldReactionButton && hit.getAttribute('data-send-reaction')==='🤦');
  },press.x,press.y);
  assert(preservedTarget,'A live table refresh replaced the pressed reaction target before pointer release.');
  await one.releaseAt(press.x,press.y);
  await evaluate(one,()=>window.__reactionGridObserver.disconnect());
  for(let n=0;n<40;n++) {
    if(await evaluate(two,()=>document.querySelectorAll('#reaction-burst-layer .reaction-particle').length)) break;
    await sleep(100);
  }
  const burst=await evaluate(two,()=>({count:document.querySelectorAll('#reaction-burst-layer .reaction-particle').length,
    emoji:document.querySelector('#reaction-burst-layer .reaction-particle')?.textContent}));
  assert(burst.count>=12&&burst.emoji==='🤦',
    'The other client did not render the reaction after a real press/release across a live table refresh: '+JSON.stringify(burst));
  const delivered=await request(path+'/reactions?after='+cursorBefore,users[0]);
  assert(Number(delivered.cursor)===cursorBefore+1 && Array.isArray(delivered.reactions) && delivered.reactions.length===1,
    'A real reaction press/release must advance the server stream exactly once: '+JSON.stringify(delivered));
  await sleep(1300);
  const held=await evaluate(two,()=>[...document.querySelectorAll('#reaction-burst-layer .reaction-particle')].filter(n=>
    parseFloat(getComputedStyle(n).opacity)>.9 && parseFloat(getComputedStyle(n).fontSize)>=30).length);
  assert(held>=12,'The reaction faded or stayed too small before viewers could notice it.');
  await two.screenshot('reactions-burst-on-recipient');
  await sleep(2200);
  assert(await evaluate(two,()=>!document.querySelector('#reaction-burst-layer .reaction-particle')),
    'Reaction particles were not cleaned up after the burst.');

  await one.reload();
  await wait(one,()=>document.querySelector('#reaction-shortcuts [data-send-reaction]')?.offsetWidth);
  await wait(one,()=>[...document.querySelectorAll('#reaction-shortcuts [data-send-reaction]')].map(n=>n.textContent).join('')==='🔥💩🤦');
  await two.reload();
  await wait(two,()=>document.querySelector('#reaction-shortcuts [data-send-reaction]')?.offsetWidth);
  await sleep(1300);
  assert(await evaluate(two,()=>document.querySelectorAll('#reaction-burst-layer .reaction-particle').length===0),
    'A reconnect replayed an earlier reaction burst.');
  console.log('Private three-choice shortcuts, local favorites, two-client burst delivery, reconnect behavior, and nine-seat mobile layout passed.');
}
