// Check full five-card showdowns in the compact 667x375 and 844x390 table layouts.
export default async function compact([tablePage], sleep, roomPassword) {
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
  for (let index = 0; index < 9; index++) {
    const username = "Compact" + stamp + "P" + index;
    const password = "CompactPass_" + stamp + "_" + index;
    const session = await newSession("/register", {
      username, password, room_password: roomPassword,
    });
    players.push({ ...session, username, password });
  }
  const playersById = new Map(players.map(player => [player.player.id, player]));
  const admin = await newSession("/login", { username: "admin", password: "" });
  await request("/admin/config", admin, {
    runout_seconds: 1,
    blind_announcement_seconds: 0,
    elimination_announcement_seconds: 0,
    showdown_seconds: 60,
    bet_presets: { preflop_bb: [2.5, 3, 4], postflop_percent: [50, 75, 100] },
  });
  const host = players[0];
  await signIn(tablePage, host);

  const viewportCases = [
    { width: 320, height: 568 },
    { width: 360, height: 740 },
    { width: 667, height: 375 },
    { width: 844, height: 390 },
  ];
  const failures = [];
  const completedCases = [];

  for (let playerCount = 2; playerCount <= 6; playerCount++) {
    const tableName = "Compact " + stamp + " " + playerCount + "p";
    const table = await request("/tables", host, {
      name: tableName,
      starting_stack: 1000,
      small_blind: 10,
      big_blind: 20,
      level_minutes: 60,
      turn_seconds: 3600,
      buy_in: 0,
    });
    const tablePath = "/tables/" + table.id;
    for (let index = 1; index < playerCount; index++) {
      await request(tablePath + "/seat", players[index], { seat_no: index });
    }

    if (playerCount > 2) {
      await tablePage.reload();
      await wait(tablePage, () => Boolean(document.querySelector("#app-panel")?.offsetWidth));
    }
    await openTable(tablePage, tableName, table.id);

    const started = await request(tablePath + "/start", host, {});
    assert(started.status === "playing" && started.seats?.length === playerCount,
      "Could not start " + playerCount + "-player table: " + JSON.stringify(started));
    let actionsTaken = 0;
    const finalView = await until(async () => {
      const current = await request(tablePath, host);
      if (current.status === "completed" && current.street === "showdown" &&
          current.board?.length === 5 && (current.showdown?.length || 0) >= 2) {
        return current;
      }
      if (current.status !== "playing") {
        if (current.status === "completed" && current.board?.length === 5 &&
            (current.showdown?.length || 0) >= 2) return current;
        throw Error("Unexpected status during " + playerCount + "-player showdown: " +
          JSON.stringify({ status: current.status, street: current.street, board: current.board }));
      }
      if (current.street === "showdown" && current.board?.length === 5 &&
          (current.showdown?.length || 0) >= 2) {
        if (!current.paused) await request(tablePath + "/pause", host, { paused: true });
        return request(tablePath, host);
      }
      if (current.actor_id) {
        const actor = playersById.get(current.actor_id);
        if (!actor) throw Error("Unknown actor in compact game: " + current.actor_id);
        const own = await request(tablePath, actor);
        if (!own.viewer?.can_act) {
          await sleep(50);
          return false;
        }
        const action = own.viewer.max_raise_to != null
          ? "all_in"
          : (Number(own.viewer.to_call) > 0 ? "call" : "check");
        const next = await request(tablePath + "/action", actor, {
          action,
          expected_hand: own.hand_no,
          expected_turn_version: own.turn_version,
        });
        actionsTaken++;
        if (next.status !== "playing" && next.status !== "completed") {
          throw Error("Unexpected status after " + action + ": " + next.status);
        }
      } else {
        await sleep(80);
      }
      return false;
    }, playerCount + "-player five-card showdown");

    assert(finalView.board?.length === 5 && finalView.street === "showdown" &&
      (finalView.showdown?.length || 0) >= 2,
      playerCount + "-player game did not reach a full showdown: " + JSON.stringify({
        status: finalView.status, street: finalView.street,
        board: finalView.board, showdown: finalView.showdown,
      }));
    assert(finalView.seats?.length === playerCount,
      "Starting seat count changed in " + playerCount + "-player showdown.");

    if (finalView.status === "playing" && !finalView.paused) {
      await request(tablePath + "/pause", host, { paused: true });
    }
    if (playerCount > 2) {
      await tablePage.reload();
      await wait(tablePage, () => Boolean(document.querySelector("#app-panel")?.offsetWidth));
      await openTable(tablePage, tableName, table.id);
    }
    await wait(tablePage, (expectedName, count) => {
      const cards = [...document.querySelectorAll("#board-cards .playing-card:not(.placeholder)")];
      return document.querySelector("#view-table-name")?.textContent === expectedName &&
        document.querySelectorAll("#seat-grid .seat-card[data-player-id]").length === count &&
        cards.length === 5;
    }, tableName, playerCount);
    await sleep(120);

    for (const viewport of viewportCases) {
      await tablePage.resize(viewport.width, viewport.height);
      await ev(tablePage, () => {
        document.activeElement?.blur?.();
        window.scrollTo(0, 0);
      });
      await sleep(180);
      const metrics = await ev(tablePage, (expectedSeats, expectedRanks) => {
        const rect = node => {
          if (!node) return null;
          const r = node.getBoundingClientRect();
          return {
            left: r.left, top: r.top, right: r.right, bottom: r.bottom,
            width: r.width, height: r.height,
          };
        };
        const area = (a, b) => {
          if (!a || !b) return 0;
          return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
            Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        };
        const visible = node => {
          if (!node || !node.getClientRects().length) return false;
          for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor);
            if (style.display === "none" || style.visibility === "hidden" ||
                Number(style.opacity) === 0) return false;
          }
          const r = rect(node);
          return r.width > 1 && r.height > 1 && r.left >= -1 && r.top >= -1 &&
            r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
        };
        const seats = [...document.querySelectorAll("#seat-grid .seat-card[data-player-id]")];
        const cards = [...document.querySelectorAll("#board-cards .playing-card:not(.placeholder)")];
        const boardRow = document.querySelector("#board-cards");
        const pot = document.querySelector("#pot-display");
        const potAmount = document.querySelector("#pot-amount");
        const errors = [];
        const collisions = [];
        if (seats.length !== expectedSeats) errors.push("seat count " + seats.length);
        if (cards.length !== 5) errors.push("board card count " + cards.length);
        if (!boardRow || !boardRow.offsetWidth) errors.push("board row missing");
        if (!pot) errors.push("pot display missing");
        const doc = document.documentElement;
        const scroller = document.scrollingElement;
        if (scrollX !== 0 || scrollY !== 0 || (scroller?.scrollTop || 0) > 1 ||
            doc.scrollHeight > innerHeight + 1) {
          errors.push("vertical document scroll " + JSON.stringify({
            scrollX, scrollY, scrollTop: scroller?.scrollTop || 0,
            scrollHeight: doc.scrollHeight, viewportHeight: innerHeight,
          }));
        }
        if (doc.scrollWidth > innerWidth + 1) {
          errors.push("horizontal document scroll " + JSON.stringify({
            scrollWidth: doc.scrollWidth, viewportWidth: innerWidth,
          }));
        }

        const inside = (child, parent) => child && parent &&
          child.left >= parent.left - 1 && child.right <= parent.right + 1 &&
          child.top >= parent.top - 1 && child.bottom <= parent.bottom + 1;
        const textFits = node => !node?.clientWidth || node.scrollWidth <= node.clientWidth + 1;
        const cardRects = cards.map((node, index) => {
          const r = rect(node);
          const style = getComputedStyle(node);
          const rank = node.querySelector(".rank"), suit = node.querySelector(".suit");
          const rankRect = rect(rank), suitRect = rect(suit);
          if (!visible(node) || node.hidden || style.display === "none" ||
              !node.getAttribute("aria-label")) {
            errors.push("board card " + index + " not visible");
          }
          if (!rank?.textContent.trim() || !suit?.textContent.trim() ||
              !visible(rank) || !visible(suit) || !inside(rankRect, r) || !inside(suitRect, r) ||
              !textFits(rank) || !textFits(suit)) {
            errors.push("board card " + index + " rank/suit label is not readable " +
              JSON.stringify({ label: node.getAttribute("aria-label"), card: r, rank: rankRect, suit: suitRect }));
          }
          const parent = rect(boardRow);
          if (area(r, parent) < r.width * r.height - 1) {
            errors.push("board card " + index + " clipped outside its row");
          }
          return { index, label: node.getAttribute("aria-label"),
            visibleLabel: (rank?.textContent.trim() || "") + (suit?.textContent.trim() || ""),
            rect: r };
        });
        const potRect = rect(pot);
        const potStyle = pot && getComputedStyle(pot);
        const potVisible = Boolean(pot && !pot.hidden && pot.offsetWidth &&
          potStyle.display !== "none" && potStyle.visibility !== "hidden" &&
          Number(potStyle.opacity) > 0);
        if (potVisible && (!visible(pot) || !potAmount?.textContent.trim())) {
          errors.push("visible pot is not readable");
        }

        for (const seat of seats) {
          const seatRect = rect(seat);
          const name = seat.querySelector(".seat-name")?.textContent || seat.dataset.seatNo;
          for (const card of cardRects) {
            const overlap = area(seatRect, card.rect);
            if (overlap > 1) collisions.push({
              kind: "seat-board", seat: name, seatNo: seat.dataset.seatNo,
              boardCard: card.index, boardLabel: card.label, overlap,
              seatRect, cardRect: card.rect,
            });
          }
          if (potRect && potRect.width > 1 && potRect.height > 1) {
            const overlap = area(seatRect, potRect);
            if (overlap > 1) collisions.push({
              kind: "seat-pot", seat: name, seatNo: seat.dataset.seatNo,
              overlap, seatRect, potRect, potVisible,
            });
          }
          const strength = seat.querySelector(".seat-hand-strength");
          const expectedRank = expectedRanks[seat.dataset.playerId];
          if (expectedRank && (!visible(strength) || strength.textContent.trim() !== expectedRank ||
              strength.scrollHeight > strength.clientHeight + 1 || !inside(rect(strength), seatRect))) {
            errors.push("seat " + seat.dataset.seatNo + " shown hand strength is not readable: " +
              JSON.stringify({expectedRank, actual:strength?.textContent, rect:rect(strength)}));
          }
          if (strength) {
            const text = strength.querySelector("span");
            const actualRank = text.textContent;
            for (const longestRank of ["Pair of jacks", "Two pair, aces and kings",
              "Aces full of kings", "Ace-high straight flush"]) {
              text.textContent = longestRank;
              if (strength.scrollHeight > strength.clientHeight + 1 ||
                  strength.scrollWidth > strength.clientWidth + 1) {
                errors.push("seat " + seat.dataset.seatNo + " rank text clips: " + longestRank);
              }
            }
            text.textContent = actualRank;
          }
          const row = seat.querySelector(".seat-cards");
          const miniCards = [...(row?.querySelectorAll(".mini-card") || [])];
          if (!row || getComputedStyle(row).display === "none") {
            errors.push("seat " + seat.dataset.seatNo + " card row hidden");
          }
          if (seat.classList.contains("is-me") || row?.classList.contains("is-exposed")) {
            const faces = miniCards.filter(card => !card.classList.contains("back"));
            if (faces.length !== 2 || faces.some(card => !visible(card))) {
              errors.push("seat " + seat.dataset.seatNo + " visible hole-card pair missing");
            }
          }
        }
        for (let first = 0; first < seats.length; first++) {
          const firstRect = rect(seats[first]);
          for (let second = 0; second < first; second++) {
            const secondRect = rect(seats[second]);
            const overlap = area(firstRect, secondRect);
            if (overlap > 1) collisions.push({
              kind: "seat-seat",
              first: { seatNo: seats[first].dataset.seatNo,
                name: seats[first].querySelector(".seat-name")?.textContent || "" },
              second: { seatNo: seats[second].dataset.seatNo,
                name: seats[second].querySelector(".seat-name")?.textContent || "" },
              overlap, firstRect, secondRect,
            });
          }
        }
        for (const card of cardRects) {
          if (potRect && area(card.rect, potRect) > 1) collisions.push({
            kind: "board-pot", boardCard: card.index, boardLabel: card.label,
            overlap: area(card.rect, potRect), cardRect: card.rect, potRect,
          });
        }
        return {
          errors, collisions,
          viewport: { width: innerWidth, height: innerHeight },
          scroll: { x: scrollX, y: scrollY, width: doc.scrollWidth, height: doc.scrollHeight },
          table: rect(document.querySelector("#table-view")),
          felt: rect(document.querySelector("#felt")),
          boardRow: rect(boardRow),
          boardCards: cardRects,
          pot: { rect: potRect, visible: potVisible, amount: potAmount?.textContent.trim() || "" },
          seats: seats.map(seat => ({
            seatNo: seat.dataset.seatNo,
            playerId: seat.dataset.playerId,
            rect: rect(seat),
          })),
        };
      }, playerCount, Object.fromEntries(finalView.showdown.map(row => [row.player_id,row.rank])));
      const label = playerCount + "p " + viewport.width + "x" + viewport.height;
      console.log("Compact showdown", label, JSON.stringify(metrics));
      if (metrics.errors.length) failures.push(label + ": " + metrics.errors.join("; "));
      if (metrics.collisions.length) failures.push(label + " collisions: " +
        JSON.stringify(metrics.collisions));
      await tablePage.screenshot("compact-" + playerCount + "-" +
        viewport.width + "x" + viewport.height);
    }

    completedCases.push({
      playerCount,
      tableId: table.id,
      handNo: finalView.hand_no,
      board: finalView.board,
      actionCount: actionsTaken,
      status: finalView.status,
    });

    if (finalView.status === "playing") {
      const confirmation = await rawApi(tablePath + "/end", host, { confirm: true });
      assert(confirmation.ok && confirmation.data.confirmation_token,
        "Could not get end confirmation for " + playerCount + "-player fixture.");
      const ended = await rawApi(tablePath + "/end", host, {
        confirmation_token: confirmation.data.confirmation_token,
      });
      assert(ended.ok && ended.data.table?.status === "ended",
        "Could not end paused " + playerCount + "-player fixture: " +
        JSON.stringify(ended.data));
    }
  }

  console.log("Compact showdown summary", JSON.stringify(completedCases));
  if (failures.length) throw Error("Compact showdown layout failures:\n - " + failures.join("\n - "));
}
