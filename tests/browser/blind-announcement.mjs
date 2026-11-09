import {seedAvatar} from './avatar-fixture.mjs';

// Verify blind-level announcements wait for winner/showdown holds, sit over the felt,
// and keep the next hand queued until their authoritative end time.
export default async function blindAnnouncement([desktop, mobile], sleep, roomPassword) {
  const evaluate = (page, fn, ...args) =>
    page.evaluate("(" + fn.toString() + ")(..." + JSON.stringify(args) + ")");
  const assert = (condition, message) => {
    if (!condition) throw Error(message);
  };

  async function wait(page, predicate, description, timeoutMs = 15000, ...args) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await evaluate(page, predicate, ...args);
      if (value) return value;
      await sleep(100);
    }
    throw Error("Timed out waiting for " + description + ": " +
      await evaluate(page, () => document.body.innerText.slice(-1000)));
  }

  const origin = await desktop.evaluate("location.origin");
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
    return { status: response.status, ok: response.ok, data,
      cookie: response.headers.get("set-cookie")?.split(";")[0] };
  }

  async function request(path, session, payload, method) {
    const result = await rawApi(path, session, payload, method);
    if (!result.ok) {
      throw Error(path + " returned " + result.status + ": " + JSON.stringify(result.data));
    }
    return result.data.table || result.data;
  }

  async function newSession(path, payload) {
    const result = await rawApi(path, null, payload);
    if (!result.ok) throw Error(path + " returned " + result.status + ": " + JSON.stringify(result.data));
    const cookie = result.cookie || result.data.cookie || result.data.session_cookie;
    if (!cookie) throw Error(path + " did not issue a session cookie");
    return { ...result.data, cookie };
  }

  async function register(label, stamp) {
    const username = ("Blind" + label + stamp).slice(0, 24);
    const password = "BlindPass_" + stamp + "_" + label + "!";
    const account = { ...await newSession("/register", {
      username, password, room_password: roomPassword,
    }), username, password };
    await seedAvatar(request, account);
    return account;
  }

  async function signIn(page, account) {
    await wait(page, () => Boolean(document.querySelector("#login-name")?.offsetWidth), "#login-name");
    await evaluate(page, (username, password) => {
      document.querySelector("#login-name").value = username;
      document.querySelector("#login-password").value = password;
      document.querySelector("#login-name").dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#login-password").dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#login-form").requestSubmit();
    }, account.username, account.password);
    await wait(page, () => Boolean(document.querySelector("#app-panel")?.offsetWidth), "signed-in app panel");
  }

  async function openTable(page, name) {
    if (await evaluate(page, () => Boolean(document.querySelector("#close-table-button")?.offsetWidth))) {
      await evaluate(page, () => document.querySelector("#close-table-button").click());
      await wait(page, () => Boolean(document.querySelector("#table-list")?.offsetWidth), "table list");
    }
    await wait(page, tableName => {
      const button = [...document.querySelectorAll("[data-open-table]")]
        .find(node => node.innerText.includes(tableName));
      if (!button) return false;
      button.click();
      return true;
    }, "open table " + name, 15000, name);
    await wait(page, tableName =>
      document.querySelector("#view-table-name")?.textContent === tableName,
    "table view " + name, 15000, name);
  }

  async function act(path, account, action) {
    const current = await request(path, account);
    return request(path + "/action", account, {
      action,
      expected_hand: current.hand_no,
      expected_turn_version: current.turn_version,
    });
  }

  async function waitForBlindAnnouncement(path, account, handNo) {
    let view = await request(path, account);
    for (let attempt = 0; attempt < 20 && !view.blind_announcement; attempt++) {
      await sleep(100);
      view = await request(path, account);
    }
    assert(view.hand_no === handNo && view.street === "showdown",
      "The result hand changed before its blind announcement was queued: " +
        JSON.stringify({ hand: view.hand_no, street: view.street, expectedHand: handNo }));
    assert(view.blind_announcement, "The due blind level did not create a queued announcement.");
    return view;
  }

  async function assertOverlay(page, expected, label) {
    const layout = await evaluate(page, expectedValues => {
      const node = document.querySelector("#blind-announcement");
      const felt = document.querySelector("#felt");
      const rect = element => {
        if (!element) return null;
        const value = element.getBoundingClientRect();
        return { left: value.left, top: value.top, right: value.right, bottom: value.bottom,
          width: value.width, height: value.height };
      };
      const box = rect(node);
      const feltBox = rect(felt);
      const style = node ? getComputedStyle(node) : null;
      const visible = Boolean(node && !node.hidden && style.display !== "none" &&
        style.visibility !== "hidden" && box?.width > 0 && box?.height > 0);
      const overlaps = (a, b) => a && b &&
        Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
        Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
      const controls = [...document.querySelectorAll(
        "#action-panel button, #chat-button, #pause-button, .reaction-shortcuts"
      )].filter(element => {
        const controlStyle = getComputedStyle(element);
        const controlBox = rect(element);
        return controlBox?.width > 0 && controlBox?.height > 0 &&
          controlStyle.display !== "none" && controlStyle.visibility !== "hidden";
      });
      const lines = (node?.innerText || "").trim().split(/\n/).map(line => line.trim());
      const textNode = node?.firstChild;
      const renderedRows = new Set();
      if (textNode?.nodeType === Node.TEXT_NODE) {
        const range = document.createRange();
        let offset = 0;
        for (const line of (textNode.textContent || "").split("\n")) {
          range.setStart(textNode, offset);
          range.setEnd(textNode, offset + line.length);
          for (const rect of range.getClientRects()) {
            if (rect.width > 0 && rect.height > 0) renderedRows.add(Math.round(rect.top));
          }
          offset += line.length + 1;
        }
      }
      const visualLineCount = renderedRows.size;
      const formatChips = value => new Intl.NumberFormat("en-US", {
        maximumFractionDigits: 0,
      }).format(Number(value));
      const minWidth = innerWidth < 800 ? 250 : 320;
      return {
        visible,
        directChild: Boolean(node && node.parentElement === felt),
        centered: Boolean(box && feltBox &&
          Math.abs((box.left + box.right) / 2 - (feltBox.left + feltBox.right) / 2) <= 4 &&
          Math.abs((box.top + box.bottom) / 2 - (feltBox.top + feltBox.bottom) / 2) <= 4),
        inViewport: Boolean(box && box.left >= 0 && box.top >= 0 &&
          box.right <= innerWidth && box.bottom <= innerHeight),
        width: box?.width || 0,
        readableWidth: Boolean(box && box.width >= minWidth),
        fontSize: Number.parseFloat(style?.fontSize || "0"),
        readableFont: Number.parseFloat(style?.fontSize || "0") >= 16,
        unclipped: Boolean(node && node.scrollWidth <= node.clientWidth + 1 &&
          node.scrollHeight <= node.clientHeight + 1),
        pointerEvents: style?.pointerEvents || "",
        whiteSpace: style?.whiteSpace || "",
        lines,
        visualLineCount,
        expectedText: style?.whiteSpace === "pre-line" && visualLineCount === 3 &&
          lines.length === 3 && lines[0] === "Blinds going up" &&
          lines[1] === "Small: " + formatChips(expectedValues.small) &&
          lines[2] === "Big: " + formatChips(expectedValues.big),
        controlOverlaps: controls.some(element => overlaps(box, rect(element))),
      };
    }, expected);
    assert(layout.visible && layout.directChild && layout.centered && layout.inViewport &&
      layout.readableWidth && layout.readableFont && layout.unclipped &&
      layout.pointerEvents === "none" && layout.expectedText && !layout.controlOverlaps,
    label + " blind announcement geometry/content failed: " + JSON.stringify(layout));
    await page.screenshot("blind-announcement-" + label);
    return layout;
  }

  const stamp = Date.now().toString(36);
  const admin = await newSession("/login", { username: "admin", password: 'test-admin-password' });
  await request("/admin/config", admin, {
    runout_seconds: 1,
    showdown_seconds: 5,
    uncontested_seconds: 5,
    blind_announcement_seconds: 2,
    elimination_announcement_seconds: 0,
  });
  const host = await register("Host", stamp);
  const guest = await register("Guest", stamp);
  await Promise.all([signIn(desktop, host), signIn(mobile, guest)]);
  await Promise.all([desktop.resize(1280, 900), mobile.resize(390, 844)]);

  async function runScenario(kind) {
    const name = "Blind announcement " + kind + " " + stamp;
    const created = await request("/tables", host, {
      name,
      starting_stack: 1000,
      small_blind: 5,
      big_blind: 10,
      level_minutes: 0.01,
      turn_seconds: 3600,
      buy_in: 0,
    });
    const path = "/tables/" + created.id;
    await request(path + "/seat", guest, { seat_no: 1 });
    await Promise.all([openTable(desktop, name), openTable(mobile, name)]);

    const started = await request(path + "/start", host, {});
    const firstDeadline = Number(started.blinds?.next_level_at);
    assert(firstDeadline > 0, "The short blind-level fixture did not start its level clock.");
    await sleep(Math.max(0, firstDeadline * 1000 - Date.now() + 120));

    let dueView = await request(path, host);
    assert(Number(dueView.blinds?.next_level_at) <= Number(dueView.server_now) + 0.1 ||
      dueView.blinds?.pending,
    "The blind clock did not become due during the live hand: " + JSON.stringify(dueView.blinds));

    let result;
    if (kind === "uncontested") {
      const actor = [host, guest].find(account => account.player.id === dueView.actor_id);
      assert(actor, "The uncontested fixture has an unknown acting player.");
      result = await act(path, actor, "fold");
      assert(result.street === "showdown" && result.showdown.length === 0 &&
        result.winners?.some(winner => Number(winner.amount) > 0),
      "The uncontested fixture did not produce a winner without showdown: " +
        JSON.stringify({ street: result.street, rows: result.showdown?.length, winners: result.winners }));
    } else {
      let view = dueView;
      for (let count = 0; count < 20 && view.street !== "showdown"; count++) {
        const actor = [host, guest].find(account => account.player.id === view.actor_id);
        assert(actor, "The showdown fixture has an unknown acting player: " + view.actor_id);
        const actorView = await request(path, actor);
        const action = Number(actorView.viewer?.to_call || 0) > 0 ? "call" : "check";
        view = await request(path + "/action", actor, {
          action,
          expected_hand: view.hand_no,
          expected_turn_version: view.turn_version,
        });
      }
      result = view;
      assert(result.street === "showdown" && result.showdown?.length === 2 &&
        result.board?.length === 5,
      "The contested fixture did not reach a real two-player showdown: " +
        JSON.stringify({ street: result.street, board: result.board, rows: result.showdown?.length }));
    }

    const resultHand = Number(result.hand_no);
    const resultHoldUntil = Number(kind === "showdown"
      ? (result.showdown_until || result.hand?.showdown_until)
      : (result.hand_complete_at || result.hand?.hand_complete_at));
    const resultHoldRemaining = resultHoldUntil - Number(result.server_now);
    assert(Number.isFinite(resultHoldUntil) && resultHoldRemaining >= 4.5,
      kind + " result response did not preserve its five-second hold: " +
        JSON.stringify({ hold: resultHoldUntil, now: result.server_now, remaining: resultHoldRemaining }));
    await Promise.all([
      wait(desktop, () => {
        const node = document.querySelector("#showdown-summary");
        return Boolean(node && !node.hidden);
      }, kind + " winner/showdown hold"),
      wait(mobile, () => {
        const node = document.querySelector("#showdown-summary");
        return Boolean(node && !node.hidden);
      }, kind + " mobile winner/showdown hold"),
    ]);
    const preHold = await Promise.all([
      evaluate(desktop, () => ({
        summary: !document.querySelector("#showdown-summary")?.hidden,
        blind: !document.querySelector("#blind-announcement")?.hidden,
      })),
      evaluate(mobile, () => ({
        summary: !document.querySelector("#showdown-summary")?.hidden,
        blind: !document.querySelector("#blind-announcement")?.hidden,
      })),
    ]);
    assert(preHold.every(state => state.summary && !state.blind),
      kind + " blind announcement appeared during the winner/showdown hold: " +
        JSON.stringify(preHold));

    const holdWaitMs = resultHoldUntil * 1000 - Date.now();
    assert(holdWaitMs > 0,
      kind + " result hold elapsed before the UI had a chance to show it.");
    await sleep(holdWaitMs + 100);
    const queued = await waitForBlindAnnouncement(path, host, resultHand);
    const announcement = queued.blind_announcement;
    assert(Number(announcement.starts_at) >= resultHoldUntil - 0.05 &&
      Number(announcement.until) > Number(announcement.starts_at) &&
      Number(queued.next_hand_at) >= Number(announcement.until) - 0.05,
    kind + " blind announcement did not follow and hold the result hand: " +
      JSON.stringify({ resultHoldUntil, announcement, nextHand: queued.next_hand_at }));

    const expected = {
      level: announcement.level,
      small: announcement.small,
      big: announcement.big,
    };
    await wait(desktop, () => {
      const node = document.querySelector("#blind-announcement");
      return Boolean(node && !node.hidden);
    }, kind + " desktop blind announcement");
    await wait(mobile, () => {
      const node = document.querySelector("#blind-announcement");
      return Boolean(node && !node.hidden);
    }, kind + " mobile blind announcement");
    await assertOverlay(desktop, expected, kind + "-desktop");
    await assertOverlay(mobile, expected, kind + "-mobile");

    const duringAnnouncement = await request(path, host);
    assert(Number(duringAnnouncement.hand_no) === resultHand &&
      Number(duringAnnouncement.server_now) < Number(announcement.until) &&
      Number(duringAnnouncement.next_hand_at) >= Number(announcement.until) - 0.05,
    kind + " dealt before its blind announcement ended: " +
      JSON.stringify({ hand: duringAnnouncement.hand_no, now: duringAnnouncement.server_now,
        until: announcement.until, next: duringAnnouncement.next_hand_at }));
    const stillQueued = await request(path, host);
    assert(Number(stillQueued.hand_no) === resultHand &&
      Math.abs(Number(stillQueued.blind_announcement?.until) - Number(announcement.until)) < 0.01,
    kind + " advanced early or reset the authoritative blind announcement deadline on poll: " +
      JSON.stringify({ hand: stillQueued.hand_no, announcement: stillQueued.blind_announcement,
        originalUntil: announcement.until }));

    await sleep(Math.max(0, Number(announcement.until) * 1000 - Date.now() + 120));
    let nextHand = await request(path, host);
    for (let attempt = 0; attempt < 80 && Number(nextHand.hand_no) === resultHand; attempt++) {
      await sleep(100);
      nextHand = await request(path, host);
    }
    assert(Number(nextHand.hand_no) === resultHand + 1 &&
      Number(nextHand.server_now) >= Number(announcement.until) - 0.05 &&
      !nextHand.blind_announcement,
    kind + " next hand did not wait until the blind announcement ended: " +
      JSON.stringify({ resultHand, nextHand: nextHand.hand_no, now: nextHand.server_now,
        until: announcement.until, announcement: nextHand.blind_announcement }));

    await wait(desktop, () => document.querySelector("#blind-announcement")?.hidden === true,
      kind + " desktop announcement dismissal");
    await wait(mobile, () => document.querySelector("#blind-announcement")?.hidden === true,
      kind + " mobile announcement dismissal");
    console.log(kind + " winner hold, centered desktop/mobile blind overlay, and announcement-gated next deal passed.");
  }

  await runScenario("uncontested");
  await runScenario("showdown");
}
