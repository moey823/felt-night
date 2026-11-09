import {openAdminFixture} from './admin-fixture.mjs';
import {seedAvatar} from './avatar-fixture.mjs';

// Exercise a real nine-player game across phone, landscape, and desktop viewports.
export default async function stability([playerPage, secondPage], sleep, roomPassword) {
  const ev = (page, fn, ...args) =>
    page.evaluate("(" + fn.toString() + ")(..." + JSON.stringify(args) + ")");
  const assert = (condition, message) => {
    if (!condition) throw Error(message);
  };
  async function wait(page, fn, ...args) {
    for (let attempt = 0; attempt < 150; attempt++) {
      const value = await ev(page, fn, ...args);
      if (value) return value;
      await sleep(100);
    }
    throw Error("Timed out: " + fn + " " + args + " | " +
      await ev(page, () => document.body.innerText.slice(-1200)));
  }
  async function until(fn, label, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await fn();
      if (value) return value;
      await sleep(100);
    }
    throw Error("Timed out waiting for " + label);
  }
  const origin = await playerPage.evaluate("location.origin");
  const apiRoot = origin + "/poker/api";
  async function rawApi(path, session, payload, method) {
    const headers = { Origin: origin };
    if (session) Object.assign(headers, {
      Cookie: session.cookie,
      "X-SitNgo-Session": session.session_proof,
      "X-SitNgo-CSRF": session.csrf,
    });
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(apiRoot + path, {
      method: method || (payload === undefined ? "GET" : "POST"),
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    return { status: response.status, ok: response.ok, data };
  }
  async function request(path, session, payload, method) {
    const result = await rawApi(path, session, payload, method);
    if (!result.ok) throw Error(path + " " + result.status + " " + JSON.stringify(result.data));
    return result.data.table || result.data;
  }
  async function newSession(path, payload) {
    const response = await fetch(apiRoot + path, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw Error(path + " " + response.status + " " + JSON.stringify(data));
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw Error(path + " did not issue a session cookie");
    return { ...data, cookie };
  }
  async function setValue(page, selector, value) {
    await ev(page, (query, next) => {
      const node = document.querySelector(query);
      if (!node) throw Error("Missing " + query);
      node.value = String(next);
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    }, selector, value);
  }
  async function signIn(page, user) {
    await wait(page, query => Boolean(document.querySelector(query)?.offsetWidth), "#login-name");
    await setValue(page, "#login-name", user.username);
    await setValue(page, "#login-password", user.password);
    await ev(page, () => document.querySelector("#login-form").requestSubmit());
    await wait(page, () => Boolean(document.querySelector("#app-panel")?.offsetWidth));
  }
  async function openTable(page, name) {
    await wait(page, tableName => {
      const button = [...document.querySelectorAll("[data-open-table]")]
        .find(node => node.innerText.includes(tableName));
      if (!button) return false;
      button.click();
      return true;
    }, name);
    await wait(page, tableName =>
      !document.querySelector("#table-view")?.hidden &&
      document.querySelector("#view-table-name")?.textContent === tableName,
    name);
  }
  async function clickAt(page, selector) {
    const point = await wait(page, query => {
      const node = document.querySelector(query);
      if (!node) return false;
      const details = node.tagName === "SUMMARY" ? null : node.closest("details");
      if (details && !details.open) details.open = true;
      if (!document.body.classList.contains("gameplay-active")) {
        node.scrollIntoView({ block: "center", inline: "nearest" });
      }
      if (!node.offsetWidth || node.hidden || node.disabled) return false;
      const rect = node.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      if (rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight) return false;
      const hit = document.elementFromPoint(x, y);
      return hit && (hit === node || node.contains(hit)) ? { x, y } : false;
    }, selector);
    await page.bringToFront();
    await page.clickAt(point.x, point.y);
  }
  async function clickInDialog(page, selector) {
    await ev(page, query => {
      document.querySelector(query)?.scrollIntoView({ block: "center", inline: "nearest" });
    }, selector);
    await sleep(80);
    await clickAt(page, selector);
  }
  async function actionRects(page) {
    return wait(page, () => {
      const nodes = [...document.querySelectorAll("#action-controls .action-buttons [data-poker-action]")];
      if (nodes.length !== 3 || nodes.some(node => !node.offsetWidth)) return false;
      return nodes.map(node => {
        const r = node.getBoundingClientRect();
        return { slot: node.dataset.actionSlot, action: node.dataset.pokerAction,
          left: r.left, top: r.top, width: r.width, height: r.height };
      });
    });
  }
  function actionRectDifference(before, after) {
    if (before.length !== 3 || after.length !== 3) return "expected three action buttons";
    for (const first of before) {
      const next = after.find(item => item.slot === first.slot);
      if (!next) return "missing slot " + first.slot;
      for (const key of ["left", "top", "width", "height"]) {
        if (Math.abs(first[key] - next[key]) > 1) {
          return first.slot + " " + key + ": " + first[key] + " -> " + next[key];
        }
      }
    }
    return "";
  }
  async function seatSnapshot(page) {
    return ev(page, () => {
      const rect = node => {
        const r = node.getBoundingClientRect();
        return { left:r.left, top:r.top, width:r.width, height:r.height };
      };
      return [...document.querySelectorAll(".seat-card[data-player-id]")].map(node => ({
        id:node.dataset.playerId, seatNo:node.dataset.seatNo, rect:rect(node),
        eliminated:node.classList.contains("is-eliminated"),
        reserved:node.classList.contains("seat-reserved")
      }));
    });
  }
  async function markerSnapshot(page) {
    return ev(page, () => {
      const rect = node => {
        const r=node.getBoundingClientRect();
        return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};
      };
      const felt=rect(document.querySelector("#felt"));
      const center={x:(felt.left+felt.right)/2,y:(felt.top+felt.bottom)/2};
      const selector=".seat-card > .dealer-marker,.seat-action[data-action-seat],.seat-turn-indicator[data-turn-seat],.seat-turn-clock[data-turn-clock-seat],.seat-local-markers .seat-wager";
      const rows=[...document.querySelectorAll(selector)].filter(node=>node.offsetWidth).map(node=>{
        const seat=node.closest(".seat-card"), mr=rect(node), sr=rect(seat);
        const own=node.classList.contains("dealer-marker")?node.dataset.markerSeat:
          node.classList.contains("seat-wager")?node.dataset.seatNo:
          node.classList.contains("seat-turn-indicator")?node.dataset.turnSeat:
          node.classList.contains("seat-turn-clock")?node.dataset.turnClockSeat:node.dataset.actionSeat;
        const mx=(mr.left+mr.right)/2,my=(mr.top+mr.bottom)/2;
        const sx=(sr.left+sr.right)/2,sy=(sr.top+sr.bottom)/2;
        return {kind:node.className,own,seatNo:seat?.dataset.seatNo||"",
          lane:node.classList.contains("dealer-marker")?node.parentElement===seat:
            node.classList.contains("seat-action")?Boolean(seat?.querySelector(".seat-footer")?.contains(node)):
            node.classList.contains("seat-turn-indicator")?Boolean(seat?.contains(node)):
            node.classList.contains("seat-turn-clock")?Boolean(seat?.contains(node)):
            Boolean(seat?.querySelector(".seat-local-markers")?.contains(node)),
          mr,sr,seatDistance:Math.hypot(mx-sx,my-sy),
          cornerDistance:Math.hypot(mx-sr.right,my-sr.top),
          centerDistance:Math.hypot(mx-center.x,my-center.y)};
      });
      return {
        rows,
        dealers:rows.filter(row=>row.kind.includes("dealer-marker")).length,
        wagers:rows.filter(row=>row.kind.includes("seat-wager")).length,
        turns:rows.filter(row=>row.kind.includes("seat-turn-indicator")).length,
      };
    });
  }

  const admin = await newSession("/login", { username:"admin", password:'test-admin-password' });
  await request("/admin/config", admin, {
    runout_seconds:1, blind_announcement_seconds:0,
    elimination_announcement_seconds:0, showdown_seconds:2,
    bet_presets:{preflop_bb:[2.5,3,4],postflop_percent:[50,75,100]}
  });
  const stamp=Date.now().toString(36), players=[];
  for (let i=0;i<9;i++) {
    const username="Stab"+stamp+"P"+i, password="StabilityPass_"+stamp+"_"+i;
    const session={...await newSession("/register",{username,password,room_password:roomPassword}),username,password};
    await seedAvatar(request,session);
    players.push(session);
  }
  const host=players[0], name=("Stability "+stamp).slice(0,48);
  const table=await request("/tables",host,{
    name,starting_stack:1000,small_blind:10,big_blind:20,
    level_minutes:1,turn_seconds:3600
  });
  const tablePath="/tables/"+table.id;
  for(let i=1;i<players.length;i++) {
    await request(tablePath+"/seat",players[i],{seat_no:i});
  }
  const started=await request(tablePath+"/start",host,{});
  assert(started.status==="playing" && started.seats?.length===9,
    "Could not start a real nine-player table: "+JSON.stringify(started));
  const playersById=new Map(players.map(player=>[player.player.id,player]));
  const firstActor=playersById.get(started.actor_id);
  assert(firstActor,"Initial actor is not one of the nine registered players.");

  await playerPage.resize(1366,768);
  await secondPage.resize(1366,768);
  await signIn(playerPage,firstActor);
  await openTable(playerPage,name);
  await wait(playerPage,()=>!document.querySelector("#action-panel")?.hidden &&
    document.querySelector("#blind-level-countdown")?.offsetWidth);

  const initialClock=await ev(playerPage,()=>document.querySelector("#blind-level-countdown")?.textContent.trim()||"");
  const parseClock=value=>{
    const match=/^([0-9]+):([0-9]{2})$/.exec(String(value||""));
    return match?Number(match[1])*60+Number(match[2]):-1;
  };
  const initialSeconds=parseClock(initialClock);
  assert(initialSeconds>0,"Blind timer is not displayed: "+initialClock);
  await wait(playerPage,previous=>{
    const text=document.querySelector("#blind-level-countdown")?.textContent.trim()||"";
    const match=/^([0-9]+):([0-9]{2})$/.exec(text);
    const current=match?Number(match[1])*60+Number(match[2]):-1;
    return current>=0&&current<previous;
  },initialSeconds);
  await request(tablePath+"/pause",host,{paused:true});
  const frozen=await wait(playerPage,()=>{
    const node=document.querySelector("#blind-level-countdown");
    const label=node?.getAttribute("aria-label")||"";
    return label.toLowerCase().includes("paused at")?
      {text:node.textContent.trim(),label}:false;
  });
  await sleep(1800);
  const frozenAgain=await ev(playerPage,()=>{
    const node=document.querySelector("#blind-level-countdown");
    return {text:node?.textContent.trim()||"",label:node?.getAttribute("aria-label")||""};
  });
  assert(frozenAgain.text===frozen.text&&frozenAgain.label.toLowerCase().includes("paused at"),
    "Blind countdown moved while paused: "+JSON.stringify({frozen,frozenAgain}));
  await request(tablePath+"/pause",host,{paused:false});
  await wait(playerPage,()=>{
    const label=document.querySelector("#blind-level-countdown")?.getAttribute("aria-label")||"";
    return !label.toLowerCase().includes("paused at");
  });
  await wait(playerPage,()=>!document.querySelector("#action-panel")?.hidden);

  const chatText="Stability chat "+stamp;
  const compactChat=await ev(playerPage,()=>({
    inlineAbsent:!document.querySelector("#chat-topline,#chat-preview,#chat-quick-form,#chat-quick-input"),
    buttonInMenu:document.querySelector("#chat-button")?.closest("#table-menu")===document.querySelector("#table-menu"),
    drawerHidden:document.querySelector("#chat-panel")?.hidden,
    menuClosed:!document.querySelector("#table-menu")?.open
  }));
  assert(compactChat.inlineAbsent&&compactChat.buttonInMenu&&compactChat.drawerHidden&&compactChat.menuClosed,
    "Chat must stay in the menu until opened, without an inline preview or composer: "+JSON.stringify(compactChat));
  await clickAt(playerPage,"#chat-button");
  await wait(playerPage,()=>!document.querySelector("#chat-panel")?.hidden);
  await ev(playerPage,message=>{
    const input=document.querySelector("#chat-input");
    if(!input)throw Error("Missing full chat input");
    input.value=message;
    input.dispatchEvent(new Event("input",{bubbles:true}));
  },chatText);
  await clickAt(playerPage,"#chat-send-button");
  await wait(playerPage,message=>
    document.querySelector("#chat-messages")?.textContent.includes(message),chatText);
  const persisted=await request(tablePath+"/chat",firstActor);
  assert(persisted.messages?.some(row=>row.text===chatText),"Full chat did not persist.");
  await ev(playerPage,()=>{
    const input=document.querySelector("#chat-input");
    input.value="Layout target";
    input.dispatchEvent(new Event("input",{bubbles:true}));
    input.blur();
    window.scrollTo(0,0);
  });
  await playerPage.pressEscape();
  await wait(playerPage,()=>document.querySelector("#chat-panel")?.hidden);

  await wait(playerPage,()=>document.querySelectorAll(".seat-card[data-player-id]").length===9&&
    document.querySelectorAll(".seat-card > .dealer-marker").length===1&&
    document.querySelectorAll(".seat-local-markers .seat-wager").length>=2&&
    document.querySelector(".seat-turn-indicator[data-turn-seat]"));
  const markerData=await markerSnapshot(playerPage), markerErrors=[];
  if(markerData.dealers!==1)markerErrors.push("dealer count "+markerData.dealers);
  if(markerData.wagers<2)markerErrors.push("wager count "+markerData.wagers);
  if(markerData.turns!==1)markerErrors.push("turn count "+markerData.turns);
  for(const marker of markerData.rows) {
    if(!marker.lane||marker.own!==marker.seatNo)markerErrors.push("wrong marker seat "+JSON.stringify(marker));
    if(marker.kind.includes("dealer-marker")) {
      if(marker.mr.width<30||marker.mr.height<30||marker.cornerDistance>18)
        markerErrors.push("dealer chip is not prominent at the seat corner "+JSON.stringify(marker));
    } else if(marker.centerDistance<24||marker.seatDistance>=marker.centerDistance) {
      markerErrors.push("marker is centered away from its player "+JSON.stringify(marker));
    }
  }
  assert(!markerErrors.length,"Seat-local marker placement failed: "+markerErrors.join("; "));

  const firstRects=await actionRects(playerPage);
  const firstView=await request(tablePath,firstActor);
  assert(firstView.actor_id===firstActor.player.id&&firstView.viewer?.can_act,
    "Initial UI account is not acting.");
  await clickAt(playerPage,'#action-controls [data-poker-action="call"]');
  const nextView=await until(async()=>{
    const view=await request(tablePath,host);
    return view.actor_id&&view.actor_id!==firstActor.player.id?view:false;
  },"next player turn");
  const samePlayerAfterTurn=await wait(playerPage,()=>{
    const panel=document.querySelector("#action-panel");
    const buttons=[...document.querySelectorAll("#action-controls .action-buttons [data-poker-action]")];
    return panel&&!panel.hidden&&buttons.length===3&&buttons.every(button=>button.disabled);
  });
  const samePlayerRects=await actionRects(playerPage);
  const actionDiff=actionRectDifference(firstRects,samePlayerRects);
  const actionLayoutFailures=[];
  if(actionDiff) {
    const failure="Three action buttons shifted for the same player after turn change: "+actionDiff+
      " | "+JSON.stringify({firstRects,samePlayerRects});
    actionLayoutFailures.push(failure);
    console.log("Stability action button geometry",failure);
  }
  const nextActor=playersById.get(nextView.actor_id);
  assert(nextActor,"Next actor was not a registered player.");
  const nextActorView=await request(tablePath,nextActor);
  const concealedOpponentIds=(nextActorView.seats||[])
    .filter(seat=>seat.id!==nextActor.player.id&&seat.in_hand&&!seat.folded&&
      !(Array.isArray(seat.cards)&&seat.cards.length===2))
    .map(seat=>String(seat.id));
  assert(concealedOpponentIds.length>0,
    "Initial active view did not contain concealed opponents.");
  await signIn(secondPage,nextActor);
  await openTable(secondPage,name);
  await wait(secondPage,()=>!document.querySelector("#action-panel")?.hidden&&
    document.querySelectorAll("#action-controls .action-buttons [data-poker-action]").length===3);
  await ev(secondPage,()=>{
    const input=document.querySelector("#chat-quick-input");
    input.value="Layout target";
    input.dispatchEvent(new Event("input",{bubbles:true}));
    input.blur();
  });

  const viewportList=[
    {width:320,height:568},{width:360,height:740},{width:390,height:844},
    {width:667,height:375},{width:844,height:390},{width:1366,height:768}
  ];
  const layoutFailures=actionLayoutFailures;
  for(const viewport of viewportList) {
    const {width,height}=viewport;
    await secondPage.resize(width,height);
    await ev(secondPage,()=>{document.activeElement?.blur?.();window.scrollTo(0,0);});
    await sleep(180);
    const wheelPoint=await ev(secondPage,()=>{
      const r=document.querySelector("#felt").getBoundingClientRect();
      return {x:r.left+r.width*0.5,y:r.top+r.height*0.42};
    });
    await secondPage.wheelAt(wheelPoint.x,wheelPoint.y,120);
    await ev(secondPage,()=>document.querySelector("#action-panel").scrollIntoView({block:"nearest",inline:"nearest"}));
    await sleep(80);
    const metrics=await ev(secondPage,()=>{
      const rect=node=>{const r=node.getBoundingClientRect();return {
        left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height
      };};
      const errors=[];
      const actions=[...document.querySelectorAll("#action-controls .action-buttons [data-poker-action]")];
      const presets=[...document.querySelectorAll("#action-panel [data-raise-preset]")];
      const wagers=[...document.querySelectorAll(".seat-local-markers > .seat-wager")];
      const targets=[
        ...actions,...presets,document.querySelector("#raise-amount"),
        document.querySelector("#chat-quick-input"),document.querySelector("#chat-quick-send"),
        document.querySelector("#table-menu > summary")
      ].filter(Boolean);
      if(actions.length!==3)errors.push("primary actions "+actions.length);
      if(presets.length!==3)errors.push("shared presets "+presets.length);
      if(wagers.length<2)errors.push("expected visible local blind wager values, found "+wagers.length);
      for(const wager of wagers) {
        const lane=wager.closest(".seat-local-markers"),value=wager.querySelector("strong");
        const wr=rect(wager),lr=lane&&rect(lane),vr=value&&rect(value);
        const style=value&&getComputedStyle(value);
        const valueVisible=Boolean(value?.getClientRects().length&&style?.display!=="none"&&
          style?.visibility!=="hidden"&&Number(style?.opacity||1)>0&&vr?.width>1&&vr?.height>1);
        const inside=(child,parent)=>child&&parent&&child.left>=parent.left-1&&
          child.right<=parent.right+1&&child.top>=parent.top-1&&child.bottom<=parent.bottom+1;
        if(!lane||!value||!value.textContent.trim()||!valueVisible||
          !inside(wr,lr)||!inside(vr,wr)||!inside(vr,lr)||
          (value.clientWidth>0&&value.scrollWidth>value.clientWidth+1))
          errors.push("wager value is not readable inside its seat marker lane "+JSON.stringify({
            text:value?.textContent.trim()||"",wager:wr,lane:lr,value:vr,
            scrollWidth:value?.scrollWidth,clientWidth:value?.clientWidth
          }));
      }
      if(document.querySelector("#table-menu")?.open)errors.push("menu unexpectedly open");
      if(!document.querySelector("#chat-panel")?.hidden)errors.push("chat drawer unexpectedly open");
      for(const selector of ["#table-header-actions","#fullscreen-button","#table-menu > summary","#blind-level-countdown"]) {
        const node=document.querySelector(selector),r=node&&rect(node);
        if(!node||node.hidden||!node.offsetWidth||!r?.width||!r?.height)errors.push(selector+" not visible");
        else if(r.left<0||r.right>innerWidth+1||r.top<0||r.bottom>innerHeight+1)errors.push(selector+" outside viewport");
      }
      for(const node of targets) {
        const r=rect(node),label=node.id||node.dataset.pokerAction||node.dataset.raisePreset||node.textContent.trim();
        if(node.hidden||!node.offsetWidth||!r.width||!r.height)errors.push(label+" not visible");
        if(node.disabled)errors.push(label+" disabled on active turn");
        if(r.left<0||r.top<0||r.right>innerWidth+1||r.bottom>innerHeight+1)errors.push(label+" outside viewport");
        const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
        if(!hit||!(hit===node||node.contains(hit)))errors.push(label+" center obstructed");
      }
      const doc=document.documentElement,body=document.body,scroller=document.scrollingElement;
      if(doc.scrollWidth>innerWidth+1||body.scrollWidth>innerWidth+1)errors.push("horizontal document scroll");
      if(doc.scrollHeight>innerHeight+1||body.scrollHeight>innerHeight+1)errors.push("vertical document scroll");
      if(scroller&&scroller.scrollTop>1)errors.push("document is scrolled");
      return {errors,viewport:{width:innerWidth,height:innerHeight},
        document:{width:doc.scrollWidth,height:doc.scrollHeight,scrollTop:scroller?.scrollTop||0},
        actionPanel:rect(document.querySelector("#action-panel")),
        headerActions:rect(document.querySelector("#table-header-actions")),
        wagerRects:wagers.map(node=>({rect:rect(node),value:node.querySelector("strong")?.textContent.trim()||"",
          lane:node.closest(".seat-local-markers")&&rect(node.closest(".seat-local-markers"))})),
        actionRects:actions.map(rect),presetRects:presets.map(rect),
        targetRects:targets.map(node=>({
          label:node.id||node.dataset.pokerAction||node.dataset.raisePreset||node.textContent.trim(),
          rect:rect(node),disabled:node.disabled,
          scrollWidth:node.scrollWidth,clientWidth:node.clientWidth
        }))};
    });
    if(width===320) {
      const concealedCards=await ev(secondPage,ids=>ids.map(id=>{
        const seat=[...document.querySelectorAll(".seat-card[data-player-id]")]
          .find(node=>node.dataset.playerId===id);
        const row=seat?.querySelector(".seat-cards");
        const backs=row?[...row.querySelectorAll(".mini-card.back")]:[];
        const seatRect=seat?.getBoundingClientRect();
        const visible=node=>{
          if(!node||!node.getClientRects().length)return false;
          for(let ancestor=node;ancestor;ancestor=ancestor.parentElement) {
            const style=getComputedStyle(ancestor);
            if(style.display==="none"||style.visibility==="hidden"||Number(style.opacity)===0)return false;
          }
          const r=node.getBoundingClientRect();
          return r.width>1&&r.height>1&&r.left>=seatRect.left-1&&r.right<=seatRect.right+1&&
            r.top>=seatRect.top-1&&r.bottom<=seatRect.bottom+1&&
            r.left<innerWidth&&r.right>0&&r.top<innerHeight&&r.bottom>0;
        };
        return {id,seatExists:Boolean(seat),rowVisible:Boolean(row&&!row.classList.contains("is-empty")),
          backs:backs.map(node=>({visible:visible(node),width:node.getBoundingClientRect().width,
            height:node.getBoundingClientRect().height}))};
      }),concealedOpponentIds);
      for(const opponent of concealedCards) {
        if(!opponent.seatExists||!opponent.rowVisible||opponent.backs.length!==2||
          opponent.backs.some(card=>!card.visible))
          metrics.errors.push("concealed opponent backs missing or clipped "+JSON.stringify(opponent));
      }
      console.log("Stability concealed cards 320x568",JSON.stringify(concealedCards));
    }
    console.log("Stability viewport",width+"x"+height,JSON.stringify(metrics));
    if(metrics.errors.length)layoutFailures.push(width+"x"+height+": "+metrics.errors.join(", "));
    await secondPage.screenshot("stability-"+width+"x"+height);
  }

  await secondPage.resize(1366,768);
  await ev(secondPage,()=>{window.scrollTo(0,0);document.activeElement?.blur?.();});
  await sleep(200);
  const originalSeats=await seatSnapshot(secondPage);
  assert(originalSeats.length===9,"Expected nine original seat IDs before showdown.");
  const originalIds=new Set(originalSeats.map(row=>row.id));
  assert(originalIds.size===9,"Starting seat IDs are not unique.");
  const deadline=Date.now()+105000;
  let actionsTaken=0,finalView=null;
  while(Date.now()<deadline&&actionsTaken<160) {
    const current=await request(tablePath,host);
    if(current.status==="completed"){finalView=current;break;}
    if(current.status!=="playing"||current.street==="showdown"||!current.actor_id){
      await sleep(150);continue;
    }
    const actor=playersById.get(current.actor_id);
    assert(actor,"Unknown actor during all-in runout: "+current.actor_id);
    const own=await request(tablePath,actor);
    assert(own.viewer?.can_act,"Current actor lacks a legal turn.");
    const action=own.viewer.max_raise_to!=null?"all_in":
      (Number(own.viewer.to_call)>0?"call":"check");
    const next=await request(tablePath+"/action",actor,{
      action,expected_hand:own.hand_no,expected_turn_version:own.turn_version
    });
    actionsTaken++;
    if(next.status!=="playing"&&next.status!=="completed")
      throw Error("Unexpected status after "+action+": "+next.status);
  }
  if(!finalView) {
    const latest=await request(tablePath,host);
    throw Error("Nine-seat runout did not complete: "+JSON.stringify({
      actionsTaken,status:latest.status,hand:latest.hand_no,street:latest.street
    }));
  }
  await wait(secondPage,()=>document.querySelectorAll(".seat-result.is-winner[data-winner-hand]").length>0&&
    document.querySelector("#view-status")?.textContent.toLowerCase().includes("complete"));
  const finalSeats=await seatSnapshot(secondPage),finalIds=new Set(finalSeats.map(row=>row.id));
  assert(finalSeats.length===9&&finalIds.size===9&&[...originalIds].every(id=>finalIds.has(id)),
    "Original nine player IDs did not persist through elimination.");
  const seatChanges=[];
  for(const before of originalSeats) {
    const after=finalSeats.find(row=>row.id===before.id);
    if(!after||after.seatNo!==before.seatNo||after.reserved) {
      seatChanges.push({before,after,reason:"seat identity or reservation changed"});continue;
    }
    for(const key of ["left","top","width","height"])if(Math.abs(before.rect[key]-after.rect[key])>1)
      seatChanges.push({id:before.id,seatNo:before.seatNo,key,before:before.rect[key],after:after.rect[key]});
  }
  assert(!seatChanges.length,"Seat IDs/rects shifted after showdown: "+JSON.stringify(seatChanges));
  const winnerBadges=await ev(secondPage,()=>{
    const rect=node=>{const r=node.getBoundingClientRect();return {
      left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height
    };};
    const inside=(child,parent)=>{
      const c=rect(child),p=rect(parent);
      return c.left>=p.left-1&&c.right<=p.right+1&&c.top>=p.top-1&&c.bottom<=p.bottom+1;
    };
    const fit=node=>!node.clientWidth||node.scrollWidth<=node.clientWidth+1;
    return [...document.querySelectorAll(".seat-result.is-winner[data-winner-hand]")].map(node=>{
      const seat=node.closest(".seat-card"),labelNode=node.querySelector(".seat-result-label");
      const amountNode=node.querySelector(".seat-result-amount");
      return {hand:node.dataset.winnerHand,playerId:node.dataset.playerId,
        seatPlayerId:seat?.dataset.playerId||"",
        label:labelNode?.textContent.trim()||"",amount:amountNode?.textContent.trim()||"",
        accessible:node.getAttribute("aria-label")||node.getAttribute("title")||"",
        text:node.textContent.trim(),insideSeat:inside(node,seat),
        labelInside:labelNode&&inside(labelNode,node)&&inside(labelNode,seat),
        amountInside:amountNode&&inside(amountNode,node)&&inside(amountNode,seat),
        badgeFits:fit(node),labelFits:labelNode&&fit(labelNode),amountFits:amountNode&&fit(amountNode)};
    });
  });
  assert(winnerBadges.length>0,"No visible all-in winner badge remained.");
  for(const badge of winnerBadges)assert(badge.hand&&badge.playerId===badge.seatPlayerId&&
    /^(winner|won)$/i.test(badge.label)&&badge.accessible.toLowerCase().includes("winner")&&
    badge.amount.startsWith("+")&&badge.insideSeat&&
    badge.labelInside&&badge.amountInside&&badge.badgeFits&&badge.labelFits&&badge.amountFits,
    "Winner label or amount is clipped outside its seat: "+JSON.stringify(badge));
  const finalViewerView=await request(tablePath,nextActor);
  const exposedOpponentIds=(finalViewerView.seats||[])
    .filter(seat=>seat.id!==nextActor.player.id&&Array.isArray(seat.cards)&&seat.cards.length===2)
    .map(seat=>String(seat.id));
  assert(exposedOpponentIds.length>0,
    "Final public view did not expose any opponents’ showdown cards.");
  const winnerViewportFailures=[];
  for(const viewport of [
    {width:320,height:568},{width:390,height:844},
    {width:667,height:375},{width:1366,height:768}
  ]) {
    await secondPage.resize(viewport.width,viewport.height);
    await ev(secondPage,()=>window.scrollTo(0,0));
    await sleep(180);
    const atSize=await ev(secondPage,()=>{
      const rect=node=>{const r=node.getBoundingClientRect();return {
        left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height
      };};
      const inside=(child,parent)=>{
        if(!child||!parent)return false;
        const c=rect(child),p=rect(parent);
        return c.left>=p.left-1&&c.right<=p.right+1&&c.top>=p.top-1&&c.bottom<=p.bottom+1;
      };
      const fit=node=>Boolean(node&&(!node.clientWidth||node.scrollWidth<=node.clientWidth+1));
      return [...document.querySelectorAll(".seat-result.is-winner[data-winner-hand]")].map(node=>{
        const seat=node.closest(".seat-card"),label=node.querySelector(".seat-result-label");
        const amount=node.querySelector(".seat-result-amount");
        return {playerId:node.dataset.playerId,seatPlayerId:seat?.dataset.playerId||"",
          label:label?.textContent.trim()||"",amount:amount?.textContent.trim()||"",
          accessible:node.getAttribute("aria-label")||node.getAttribute("title")||"",
          inside:inside(node,seat)&&inside(label,node)&&inside(label,seat)&&
            inside(amount,node)&&inside(amount,seat),
          fits:fit(node)&&fit(label)&&fit(amount),
          badgeRect:rect(node),seatRect:rect(seat)};
      });
    });
    const errors=[];
    if(!atSize.length)errors.push("winner badge missing");
    for(const badge of atSize) {
      if(badge.playerId!==badge.seatPlayerId||! /^(winner|won)$/i.test(badge.label)||
        !badge.accessible.toLowerCase().includes("winner")||
        !badge.amount.startsWith("+")||!badge.inside||!badge.fits)
        errors.push(JSON.stringify(badge));
    }
    if(viewport.width===320) {
      const exposedCards=await ev(secondPage,ids=>ids.map(id=>{
        const seat=[...document.querySelectorAll(".seat-card[data-player-id]")]
          .find(node=>node.dataset.playerId===id);
        const row=seat?.querySelector(".seat-cards.is-exposed");
        const cards=row?[...row.querySelectorAll(".mini-card:not(.back)")]:[];
        const seatRect=seat?.getBoundingClientRect();
        const visible=node=>{
          if(!node||!node.getClientRects().length)return false;
          for(let ancestor=node;ancestor;ancestor=ancestor.parentElement) {
            const style=getComputedStyle(ancestor);
            if(style.display==="none"||style.visibility==="hidden"||Number(style.opacity)===0)return false;
          }
          const r=node.getBoundingClientRect();
          return r.width>1&&r.height>1&&r.left>=seatRect.left-1&&r.right<=seatRect.right+1&&
            r.top>=seatRect.top-1&&r.bottom<=seatRect.bottom+1&&
            r.left<innerWidth&&r.right>0&&r.top<innerHeight&&r.bottom>0;
        };
        return {id,seatExists:Boolean(seat),exposed:Boolean(row),
          cards:cards.map(node=>({text:node.textContent.trim(),visible:visible(node),
            width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height}))};
      }),exposedOpponentIds);
      for(const opponent of exposedCards) {
        if(!opponent.seatExists||!opponent.exposed||opponent.cards.length!==2||
          opponent.cards.some(card=>!card.visible))
          errors.push("exposed opponent cards missing or clipped "+JSON.stringify(opponent));
      }
      console.log("Stability exposed cards 320x568",JSON.stringify(exposedCards));
    }
    console.log("Stability winner",viewport.width+"x"+viewport.height,JSON.stringify({errors,badges:atSize}));
    if(errors.length)winnerViewportFailures.push(viewport.width+"x"+viewport.height+": "+errors.join(", "));
  }
  if(winnerViewportFailures.length)layoutFailures.push("Winner badge clipping: "+winnerViewportFailures.join(" | "));
  await secondPage.resize(1366,768);
  await ev(secondPage,()=>window.scrollTo(0,0));
  await sleep(150);
  console.log("Stability all-in",JSON.stringify({actionsTaken,status:finalView.status,
    hand:finalView.hand_no,originalSeats,finalSeats,winnerBadges}));

  await clickAt(secondPage,"#table-logout-button");
  await wait(secondPage,()=>Boolean(document.querySelector("#login-name")?.offsetWidth));
  await openAdminFixture(secondPage);
  await clickAt(secondPage,"#admin-history-details > summary");
  await wait(secondPage,id=>Boolean(document.querySelector('[data-admin-history-id="'+id+'"]')),table.id);
  const historyEntry=await ev(secondPage,id=>{
    const node=document.querySelector('[data-admin-history-id="'+id+'"]');
    return node?{id:node.dataset.adminHistoryId,text:node.textContent}:null;
  },table.id);
  assert(historyEntry?.id===table.id&&historyEntry.text.includes(name),
    "Completed game is missing from admin past games.");
  await clickAt(secondPage,'[data-admin-history-view="'+table.id+'"]');
  await wait(secondPage,gameName=>document.querySelector("#admin-history-dialog")?.open&&
    document.querySelector("#admin-history-title")?.textContent===gameName,name);
  await wait(secondPage,()=>Boolean(document.querySelector("#admin-history-content .admin-history-game-meta")));
  await clickInDialog(secondPage,'[data-admin-history-delete="'+table.id+'"]');
  await wait(secondPage,gameName=>!document.querySelector("#admin-history-delete-step")?.hidden&&
    document.querySelector("#admin-history-delete-name")?.textContent===gameName,name);
  await clickInDialog(secondPage,"#admin-history-delete-cancel");
  await wait(secondPage,()=>document.querySelector("#admin-history-dialog")?.open&&
    document.querySelector("#admin-history-delete-step")?.hidden);
  const preserved=await rawApi("/admin/history/"+table.id,admin);
  assert(preserved.status===200,"Canceling deletion removed the archived game.");
  await clickInDialog(secondPage,'[data-admin-history-delete="'+table.id+'"]');
  await wait(secondPage,()=>!document.querySelector("#admin-history-delete-step")?.hidden);
  await clickInDialog(secondPage,"#admin-history-delete-confirm");
  await wait(secondPage,()=>!document.querySelector("#admin-history-dialog")?.open);
  await wait(secondPage,id=>!document.querySelector('[data-admin-history-id="'+id+'"]'),table.id);
  const deleted=await rawApi("/admin/history/"+table.id,admin);
  assert(deleted.status===404&&deleted.data?.error?.code==="history_not_found",
    "Confirmed UI deletion did not remove the archived game: "+JSON.stringify(deleted));
  console.log("Stability admin history",JSON.stringify({
    viewed:historyEntry.id,cancelPreserved:preserved.status===200,deleted:deleted.status
  }));
  if(layoutFailures.length)throw Error("Stability layout failures: "+layoutFailures.join(" | "));
}
