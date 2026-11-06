// Check full five-card showdowns in the compact 667x375 and 844x390 table layouts.
export default async function actionPacing([tablePage, adminPage], sleep, roomPassword) {
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
  async function until(fn, label, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await fn();
      if (value) return value;
      await sleep(100);
    }
    throw Error("Timed out waiting for " + label);
  }

  const origin = await tablePage.evaluate("location.origin");
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
  async function signIn(page, user) {
    await wait(page, () => Boolean(document.querySelector("#login-name")?.offsetWidth), "#login-name");
    await ev(page, (username, secret) => {
      const name = document.querySelector("#login-name");
      const password = document.querySelector("#login-password");
      name.value = username;
      password.value = secret;
      name.dispatchEvent(new Event("input", { bubbles: true }));
      password.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#login-form").requestSubmit();
    }, user.username, user.password);
    await wait(page, () => Boolean(document.querySelector("#app-panel")?.offsetWidth));
  }
  async function openTable(page, name, tableId) {
    await wait(page, (tableName, id) => {
      const list = document.querySelector("#table-list");
      let button = [...document.querySelectorAll("[data-open-table]")]
        .find(node => node.innerText.includes(tableName));
      if (!button && id && list) {
        button = document.createElement("button");
        button.type = "button";
        button.dataset.openTable = id;
        button.textContent = tableName;
        list.append(button);
      }
      if (!button) return false;
      button.click();
      return true;
    }, name, tableId);
    await wait(page, tableName => !document.querySelector("#table-view")?.hidden &&
      document.querySelector("#view-table-name")?.textContent === tableName, name);
  }


  const stamp = Date.now().toString(36);
  const players = [];
  for (let index = 0; index < 2; index++) {
    const username = ("ActionPlayer" + stamp + index).slice(0,24);
    const password = "ActionPass_" + stamp + "_" + index;
    const session = await newSession("/register", {username,password,room_password:roomPassword});
    players.push({...session,username,password});
  }
  await wait(adminPage, () => Boolean(document.querySelector("#login-name")?.offsetWidth));
  await ev(adminPage, () => {
    document.querySelector("#admin-login-button").click();
    document.querySelector("#login-name").value = "admin";
    document.querySelector("#login-password").value = "";
    document.querySelector("#login-form").requestSubmit();
  });
  await wait(adminPage, () => !document.querySelector("#admin-panel")?.hidden &&
    Boolean(document.querySelector("#admin-uncontested-seconds")?.offsetWidth));
  await ev(adminPage, () => {
    document.querySelector("#admin-uncontested-seconds").value = "8.25";
    document.querySelector("#admin-config-form").requestSubmit();
  });
  await wait(adminPage, () => /saved/i.test(document.querySelector("#admin-config-status")?.textContent || ""));
  await adminPage.reload();
  await wait(adminPage, () => document.querySelector("#admin-uncontested-seconds")?.value === "8.25");

  const host = players[0], guest = players[1];
  const table = await request("/tables", host, {
    name:"Action clarity "+stamp, starting_stack:1000, small_blind:10, big_blind:20,
    level_minutes:60, turn_seconds:3600, buy_in:0,
  });
  const path="/tables/"+table.id;
  await request(path+"/join",guest,{});
  await signIn(tablePage,host);
  await openTable(tablePage,table.name,table.id);
  let current=await request(path+"/start",host,{});
  const byId=new Map(players.map(p=>[p.player.id,p]));
  const actor=byId.get(current.actor_id);
  current=await request(path+"/action",actor,{action:"raise",amount:80,
    expected_hand:current.hand_no,expected_turn_version:current.turn_version});
  await wait(tablePage, (name,id) => {
    const summary=document.querySelector("#last-action-summary");
    const turn=document.querySelector(".seat-card.is-acting");
    return !summary?.hidden && summary.textContent.includes(name) &&
      summary.textContent.includes("80") && turn?.dataset.playerId===id;
  },actor.player.name || actor.username,current.actor_id);
  for (const [width,height] of [[1440,900],[1024,768],[390,844],[320,568],[844,390],[667,375]]) {
    await tablePage.resize(width,height);
    await sleep(150);
    const layout=await ev(tablePage,()=>{
      const summary=document.querySelector("#last-action-summary");
      const detail=summary.querySelector(".last-action-detail");
      const turn=document.querySelector(".seat-card.is-acting");
      const sr=summary.getBoundingClientRect(),dr=detail.getBoundingClientRect();
      const style=getComputedStyle(turn);
      const felt=document.querySelector("#felt").getBoundingClientRect();
      const overlap=r=>sr.left<r.right && sr.right>r.left && sr.top<r.bottom && sr.bottom>r.top;
      const blocked=[...document.querySelectorAll("#seat-grid .seat-card, #board-cards, #pot-display, .reaction-shortcuts")].some(n=>overlap(n.getBoundingClientRect()));
      const onFelt=Boolean(summary.closest("#felt")) && sr.left>=felt.left && sr.right<=felt.right && sr.top>=felt.top && sr.bottom<=felt.bottom;
      return {onFelt,blocked,summary:summary.textContent,visible:sr.height>0 && getComputedStyle(summary).visibility==="visible",
        fits:dr.left>=sr.left-1 && dr.right<=sr.right+1 && dr.bottom<=sr.bottom+1,
        outline:style.outlineWidth,glow:style.boxShadow,scroll:document.documentElement.scrollWidth<=innerWidth};
    });
    assert(layout.onFelt && !layout.blocked && layout.visible && layout.fits && layout.scroll && layout.outline==="3px" && layout.glow!=="none",
      "Last-action/turn layout "+width+"x"+height+" "+JSON.stringify(layout));
    await tablePage.screenshot("action-"+width+"x"+height);
  }
  current=await request(path,host);
  const folding=byId.get(current.actor_id);
  current=await request(path+"/action",folding,{action:"fold",
    expected_hand:current.hand_no,expected_turn_version:current.turn_version});
  assert(current.showdown.length===0 && current.winners.length===1,"Expected uncontested winner");
  assert(Math.abs(current.hand_complete_at-current.server_now-8.25)<.3,"Admin hold not applied");
  const winnerId=current.winners[0].player_id;
  await wait(tablePage,id=>{
    const winner=document.querySelector(".seat-card.is-hand-winner");
    const summary=document.querySelector("#showdown-summary");
    return winner?.dataset.playerId===id && !summary.hidden && /without showdown/.test(summary.textContent);
  },winnerId);
  const winner=await ev(tablePage,()=>{
    const seat=document.querySelector(".seat-card.is-hand-winner");
    return {outline:getComputedStyle(seat).outlineColor,amount:seat.querySelector(".seat-result")?.textContent,
      turn:document.querySelectorAll(".seat-card.is-acting").length};
  });
  assert(winner.outline==="rgb(255, 217, 121)" && winner.amount.includes("Won") && winner.turn===0,
    "Winner highlight failed "+JSON.stringify(winner));
  await tablePage.screenshot("uncontested-winner");
  // Changing the global setting must not shorten the hold already in progress.
  const admin=await newSession("/login",{username:"admin",password:""});
  await request("/admin/config",admin,{uncontested_seconds:0});
  assert((await request(path,host)).hand_no===current.hand_no,"Dealt before winner hold finished");
  await until(async()=> (await request(path,host)).hand_no===current.hand_no+1,"next deal after winner hold",12000);
  await wait(tablePage,()=> !document.querySelector(".seat-card.is-hand-winner") &&
    document.querySelector("#last-action-summary")?.hidden);
  console.log("Action clarity, six viewport layouts, turn/winner rings, admin persistence and exact winner-hold redeal passed.");
}
