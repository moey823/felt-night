// Exercise paginated admin selection, count confirmation, safe backdrop dismissal, and atomic bulk deletion.
export default async function adminBulk([playerPage, adminPage], sleep, roomPassword) {
  const evaluate = (page, fn, ...args) => page.evaluate("(" + fn.toString() + ")(..." + JSON.stringify(args) + ")");
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  async function wait(page, fn, ...args) {
    for (let attempt = 0; attempt < 150; attempt++) {
      const value = await evaluate(page, fn, ...args);
      if (value) return value;
      await sleep(100);
    }
    throw Error("Timed out waiting for UI state: " + await evaluate(page, () => document.body.innerText.slice(-900)));
  }
  async function click(page, selector) {
    await wait(page, query => {
      const node = document.querySelector(query);
      if (!node || !node.offsetWidth || node.disabled) return false;
      node.click();
      return true;
    }, selector);
  }
  async function api(page, path, session, payload, method) {
    return evaluate(page, async (route, auth, data, verb) => {
      const headers = {};
      if (auth?.session_proof) headers["X-SitNgo-Session"] = auth.session_proof;
      if (auth?.csrf) headers["X-SitNgo-CSRF"] = auth.csrf;
      if (data !== undefined) headers["Content-Type"] = "application/json";
      const response = await fetch("/poker/api" + route, {
        method: verb || (data === undefined ? "GET" : "POST"),
        credentials: "same-origin",
        headers,
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      let body = {};
      try { body = await response.json(); } catch (_) {}
      return { status: response.status, body };
    }, path, session, payload, method);
  }
  async function setInput(page, selector, value) {
    await evaluate(page, (query, next) => {
      const input = document.querySelector(query);
      input.value = next;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, selector, value);
  }
  async function signInAdmin() {
    await wait(adminPage, () => Boolean(document.querySelector("#login-name")?.offsetWidth));
    await click(adminPage, "#admin-login-button");
    await evaluate(adminPage, () => document.querySelector("#login-form").requestSubmit());
    await wait(adminPage, () => Boolean(document.querySelector("#admin-panel")?.offsetWidth));
  }

  const stamp = Date.now().toString(36);
  const username = ("Bulk" + stamp).slice(0, 24);
  const password = "Felt_" + stamp + "_Bulk_Test";
  const registration = await api(playerPage, "/register", null, {
    username, password, room_password: roomPassword,
  });
  assert(registration.status === 201, "Could not create the disposable test account: " + JSON.stringify(registration.body));
  const host = registration.body;
  const tableIds = [];
  for (let index = 0; index < 21; index++) {
    const created = await api(playerPage, "/tables", host, {
      name: "Bulk history " + stamp + " " + index,
      starting_stack: 1200, small_blind: 10, big_blind: 20,
      level_minutes: 5, turn_seconds: 3600,
    });
    assert(created.status === 201, "Could not create a disposable past game: " + JSON.stringify(created.body));
    const id = created.body.table.id;
    tableIds.push(id);
    const prompt = await api(playerPage, "/tables/" + id + "/end", host, { confirm: true });
    assert(prompt.status === 200, "Could not request the lobby end confirmation.");
    const ended = await api(playerPage, "/tables/" + id + "/end", host, {
      confirmation_token: prompt.body.confirmation_token,
    });
    assert(ended.status === 200 && ended.body.table.status === "cancelled",
      "Could not archive a disposable lobby: " + JSON.stringify(ended.body));
  }

  await wait(playerPage, () => Boolean(document.querySelector("#login-name")?.offsetWidth));
  await setInput(playerPage, "#login-name", username);
  await setInput(playerPage, "#login-password", password);
  await evaluate(playerPage, () => document.querySelector("#login-form").requestSubmit());
  await wait(playerPage, () => Boolean(document.querySelector("#app-panel")?.offsetWidth));
  await click(playerPage, "#lobby-history-button");
  await wait(playerPage, () => document.querySelector("#history-dialog")?.open);
  const historyBlankClickPreserved = await evaluate(playerPage, () => {
    const dialog = document.querySelector("#history-dialog");
    const rect = dialog.getBoundingClientRect();
    dialog.dispatchEvent(new MouseEvent("click", {
      bubbles: true, clientX: rect.left + 2, clientY: rect.top + 2,
    }));
    return dialog.open;
  });
  assert(historyBlankClickPreserved, "Clicking blank space inside player history closed its dialog.");
  await playerPage.bringToFront();
  await playerPage.clickAt(1, 1);
  await wait(playerPage, () => !document.querySelector("#history-dialog")?.open);

  await signInAdmin();
  await click(adminPage, "#admin-history-details > summary");
  await wait(adminPage, () => document.querySelectorAll("#admin-history-list [data-admin-history-id]").length === 20);
  const firstId = await evaluate(adminPage, () =>
    document.querySelector("#admin-history-list [data-admin-history-select]")?.getAttribute("data-admin-history-select"));
  assert(tableIds.includes(firstId), "The first past-games page did not include this test’s games.");
  await evaluate(adminPage, () => {
    const input = document.querySelector("#admin-history-list [data-admin-history-select]");
    input.checked = true;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await wait(adminPage, () => document.querySelector(".admin-history-selection-count")?.textContent === "1 selected");
  await click(adminPage, "[data-admin-history-more]");
  await wait(adminPage, () => document.querySelectorAll("#admin-history-list [data-admin-history-id]").length === 21);
  const retainedSelection = await evaluate(adminPage, id =>
    document.querySelector('[data-admin-history-select="' + id + '"]')?.checked, firstId);
  assert(retainedSelection, "Loading another past-games page dropped an earlier selection.");
  await evaluate(adminPage, () => {
    const input = document.querySelector("[data-admin-history-select-all]");
    input.checked = true;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await wait(adminPage, () => document.querySelector(".admin-history-selection-count")?.textContent === "21 selected");
  await click(adminPage, "[data-admin-history-delete-selected]");
  await wait(adminPage, () => document.querySelector("#admin-history-dialog")?.open &&
    document.querySelector("#admin-history-delete-title")?.textContent === "Delete 21 past games?");
  assert(await evaluate(adminPage, () => document.querySelector("#admin-history-delete-confirm")?.textContent) === "Delete 21 games",
    "Bulk confirmation does not show the selected game count.");
  const adminBlankClickPreserved = await evaluate(adminPage, () => {
    const dialog = document.querySelector("#admin-history-dialog");
    const rect = dialog.getBoundingClientRect();
    dialog.dispatchEvent(new MouseEvent("click", {
      bubbles: true, clientX: rect.left + 2, clientY: rect.top + 2,
    }));
    return dialog.open;
  });
  assert(adminBlankClickPreserved, "Clicking blank space inside the admin confirmation closed its dialog.");
  await adminPage.bringToFront();
  await adminPage.clickAt(1, 1);
  await wait(adminPage, () => !document.querySelector("#admin-history-dialog")?.open);
  await click(adminPage, "[data-admin-history-refresh]");
  await wait(adminPage, id => Boolean(document.querySelector('[data-admin-history-id="' + id + '"]')), firstId);
  assert(await evaluate(adminPage, id => Boolean(document.querySelector('[data-admin-history-select="' + id + '"]')?.checked), firstId),
    "Refreshing after dismissal did not preserve an existing selection.");

  await click(adminPage, "[data-admin-history-delete-selected]");
  await wait(adminPage, () => document.querySelector("#admin-history-dialog")?.open &&
    document.querySelector("#admin-history-delete-title")?.textContent === "Delete 21 past games?");
  await click(adminPage, "#admin-history-delete-confirm");
  await wait(adminPage, () => !document.querySelector("#admin-history-dialog")?.open &&
    document.querySelectorAll("#admin-history-list [data-admin-history-id]").length === 0);
  assert(await evaluate(adminPage, () => document.querySelector(".admin-history-selection-count")?.textContent) === "0 selected",
    "Successful deletion did not clear the selected count.");
  console.log("Paginated admin selection, count confirmation, safe backdrop dismissal, and bulk deletion passed.");
}
