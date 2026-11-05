(function () {
  "use strict";

  var authMode = "login";
  function setAuthMode(mode) {
    authMode = mode;
    var newAccount = mode !== "login", claim = mode === "claim";
    var sw = byId("auth-switch");
    sw.hidden = false;
    sw.textContent = claim ? "Sign out of this legacy seat" : newAccount ? "Already registered? Sign in" : "Create an account";
    byId("auth-room").hidden = !newAccount;
    if (!newAccount) byId("room-password").value = "";
    byId("room-password").required = newAccount;
    var nameInput = byId("login-name");
    nameInput.pattern = "[A-Za-z0-9][A-Za-z0-9._\\x2d]{2,23}";
    nameInput.title = "3–24 characters: letters, numbers, dots, underscores or hyphens. Start with a letter or number.";
    byId("login-password").maxLength = 256;
    byId("login-password").minLength = newAccount ? 10 : 1;
    byId("login-password").autocomplete = newAccount ? "new-password" : "current-password";
    byId("login-form").querySelector('button[type=submit] span').textContent = claim ? "Secure my seat" : newAccount ? "Create account" : "Sign in";
    document.querySelector(".login-card h2").textContent = claim ? "Keep your seat" : newAccount ? "Create an account" : "Welcome back";
    document.querySelector(".login-card p.muted").textContent = claim ? "Choose a username and personal password to keep this browser’s seat and available history." : newAccount ? "Use the room invite password once. Choose a personal password of at least 10 characters." : "Sign in to return to your seat and view your tournament history.";
  }
  byId("auth-switch").addEventListener("click", async function () {
    if (authMode === "claim") {
      try {await mutate("/logout",{}); setLoggedOut("");} catch (err) {showNotice(err.message,"error",false);}
    } else {
      setAuthMode(authMode === "login" ? "register" : "login");
      byId("login-password").value = ""; byId("room-password").value = ""; clearNotice();
    }
  });
  var API_ROOT = "/poker/api";
  var AUTH_STORAGE_KEY = "sitngo.poker.session-proof.v1";
  var PLAYER_PREFS_STORAGE_PREFIX = "felt-night.bet-presets.v1:";
  var DEFAULT_PLAYER_PREFS = { preflop_bb: [2.5, 3, 4], postflop_percent: [50, 75, 100] };
  var state = {
    csrf: "",
    sessionProof: "",
    player: null,
    tables: [],
    activeTableId: "",
    skipAutoResume: false,
    tableView: null,
    standingsDismissedFor: "",
    polling: false,
    refreshBusy: false,
    refreshTimer: 0,
    refreshPending: false,
    inviteCopiedFor: "",
    inviteResetTimer: 0,
    noticeTimer: 0,
    actionFeedbackTimer: 0,
    settingsTableId: "",
    settingsDirty: false,
    settingsSaving: false,
    runtimeSettingsOpen: false,
    seatTurnClockKey: "",
    seatTurnRemainingMs: 0,
    seatTurnClockUpdatedAt: 0,
    seatTurnClockTimer: 0,
    seatTurnClockPaused: false,
    blindAnnouncementTimer: 0,
    eliminationAnnouncementTimer: 0,
    pausePending: false,
    blindLevelTableId: "",
    blindLevelValue: null,
    blindHandId: "",
    showBigBlinds: false,
    sitOutRequestId: 0,
    sitOutPending: false,
    chat: {
      requestId: 0,
      fetchRequestId: 0,
      tableId: "",
      playerId: "",
      open: false,
      trigger: null,
      messages: [],
      loaded: false,
      sending: false,
      postInFlight: false,
      postRequestSerial: 0,
      activePostId: 0,
      error: "",
      timer: 0
    },
    actionPending: null,
    actionSubmittedKey: "",
    lastHandReplay: {
      requestId: 0,
      tableId: "",
      playerId: "",
      hand: null,
      streetIndex: 0,
      loading: false,
      error: "",
      trigger: null
    },
    raiseDraftKey: "",
    raiseDraftValue: null,
    tableFx: {
      handId: null,
      lastSeq: -1,
      generation: 0,
      eventAware: false,
      actions: {},
      street: "",
      revealed: {},
      displayWagers: {},
      wagerPositions: {},
      queue: [],
      currentItem: null,
      running: false
    }
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function loadAuth() {
    try {
      var saved = JSON.parse(window.localStorage.getItem(AUTH_STORAGE_KEY) || "{}");
      state.sessionProof = typeof saved.session_proof === "string" ? saved.session_proof : "";
      state.csrf = "";
    } catch (err) {
      state.sessionProof = "";
      state.csrf = "";
    }
  }

  function persistAuth() {
    try {
      if (state.sessionProof) {
        window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({
          session_proof: state.sessionProof
        }));
      }
    } catch (err) {}
  }

  function clearAuth() {
    state.sessionProof = "";
    state.csrf = "";
    try { window.localStorage.removeItem(AUTH_STORAGE_KEY); } catch (err) {}
  }

  function hashTableId() {
    try {
      var params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      var id = params.get("table") || "";
      return id.length <= 100 ? id : "";
    } catch (err) {
      return "";
    }
  }

  function setHashTable(id) {
    var hash = id ? "#table=" + encodeURIComponent(id) : "";
    window.history.replaceState(null, "", window.location.pathname + hash);
  }

  function scheduleRefresh(delay) {
    if (!state.polling) return;
    if (state.refreshTimer) window.clearTimeout(state.refreshTimer);
    state.refreshTimer = window.setTimeout(function () {
      state.refreshTimer = 0;
      refreshAll(false);
    }, delay);
  }

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function number(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? n : (fallback || 0);
  }

  function chips(value) {
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(number(value, 0));
  }

  function tableUsesBigBlinds(view) {
    var source = view || state.tableView;
    return Boolean(state.showBigBlinds && source && blindParts(source).big > 0);
  }

  function tableChipValue(value, view) {
    if (!tableUsesBigBlinds(view)) return chips(value);
    var bigBlind = blindParts(view || state.tableView).big;
    var units = number(value, 0) / bigBlind;
    return new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(units);
  }

  function tableChips(value, view) {
    return tableChipValue(value, view) + (tableUsesBigBlinds(view) ? " BB" : " chips");
  }

  function actionChips(value, view) {
    if (!tableUsesBigBlinds(view)) return chips(value) + " chips";
    var bigBlind = Math.max(1, blindParts(view || state.tableView).big);
    var rawAmount = number(value, 0);
    var units = rawAmount / bigBlind;
    var formatted = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(units);
    if (rawAmount > 0 && Number(formatted.replace(/,/g, "")) === 0) return chips(rawAmount) + " chips";
    return formatted + " BB";
  }

  function tableChipUnit(view) {
    return tableUsesBigBlinds(view) ? "BB" : "chips";
  }

  function percent(value) {
    var parsed = Number(value);
    if (!isFinite(parsed)) return "0%";
    return parsed.toFixed(1).replace(/\.0$/, "") + "%";
  }

  function showNotice(message, kind, persistent) {
    var node = byId("notice");
    node.textContent = message || "";
    node.dataset.kind = kind || "error";
    node.hidden = !message;
    if (state.noticeTimer) {
      window.clearTimeout(state.noticeTimer);
      state.noticeTimer = 0;
    }
    if (message && !persistent) {
      state.noticeTimer = window.setTimeout(function () {
        node.hidden = true;
      }, 6000);
    }
  }

  function showActionFeedback(message, kind, persistent) {
    var node = byId("action-feedback");
    if (!node) return;
    node.textContent = message || "";
    node.dataset.kind = kind || "info";
    node.hidden = !message;
    if (state.actionFeedbackTimer) {
      window.clearTimeout(state.actionFeedbackTimer);
      state.actionFeedbackTimer = 0;
    }
    if (message && !persistent) {
      state.actionFeedbackTimer = window.setTimeout(function () {
        node.hidden = true;
      }, 6000);
    }
  }

  function clearBlindAnnouncement(resetTracking) {
    if (state.blindAnnouncementTimer) {
      window.clearTimeout(state.blindAnnouncementTimer);
      state.blindAnnouncementTimer = 0;
    }
    var node = byId("blind-announcement");
    if (node) {
      node.hidden = true;
      node.textContent = "";
      delete node.dataset.secondsRemaining;
    }
    if (resetTracking) {
      state.blindLevelTableId = "";
      state.blindLevelValue = null;
      state.blindHandId = "";
    }
  }

  function clearEliminationAnnouncement() {
    if (state.eliminationAnnouncementTimer) {
      window.clearTimeout(state.eliminationAnnouncementTimer);
      state.eliminationAnnouncementTimer = 0;
    }
    var node = byId("announcement-banner");
    if (node) {
      node.hidden = true;
      node.textContent = "";
      delete node.dataset.secondsRemaining;
    }
  }

  function announcementRemainingMs(view, announcement) {
    var until = epochMilliseconds(announcement && announcement.until);
    var serverNow = epochMilliseconds(view && view.server_now) || Date.now();
    return until ? Math.max(0, until - serverNow) : 0;
  }

  function announceBlindLevel(announcement, view) {
    var node = byId("blind-announcement");
    if (!node) return;
    var remainingMs = announcementRemainingMs(view, announcement);
    if (!announcement || remainingMs <= 0) {
      clearBlindAnnouncement(false);
      return;
    }
    if (state.blindAnnouncementTimer) window.clearTimeout(state.blindAnnouncementTimer);
    node.textContent = "Blind level " + number(announcement.level, 1) + ": small blind " +
      chips(announcement.small) + " chips, big blind " + chips(announcement.big) +
      " chips. The next hand waits until this announcement ends.";
    node.dataset.secondsRemaining = String(Math.ceil(remainingMs / 1000));
    node.hidden = false;
    if (state.blindAnnouncementTimer) window.clearTimeout(state.blindAnnouncementTimer);
    state.blindAnnouncementTimer = 0;
    if (!view.paused) {
      var tableId = String(view && view.id || state.activeTableId || "");
      state.blindAnnouncementTimer = window.setTimeout(function () {
        state.blindAnnouncementTimer = 0;
        if (String(state.activeTableId) === tableId) clearBlindAnnouncement(false);
      }, remainingMs + 30);
    }
  }

  function ordinal(place) {
    var n = Math.max(1, Math.floor(number(place, 1)));
    var suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
    return n + suffix;
  }

  function announceEliminations(view) {
    var node = byId("announcement-banner");
    if (!node) return;
    var announcement = view && view.elimination_announcement;
    var remainingMs = announcementRemainingMs(view, announcement);
    if (!announcement || remainingMs <= 0) {
      clearEliminationAnnouncement();
      return;
    }
    if (state.eliminationAnnouncementTimer) window.clearTimeout(state.eliminationAnnouncementTimer);
    state.eliminationAnnouncementTimer = 0;
    var groups = Object.create(null);
    (Array.isArray(announcement.players) ? announcement.players : []).forEach(function (player) {
      if (!player || number(player.place, 0) < 1) return;
      var place = Math.floor(number(player.place, 0));
      if (!groups[place]) groups[place] = [];
      groups[place].push(String(player.name || "Player"));
    });
    var lines = Object.keys(groups).map(function (place) {
      var names = groups[place];
      var nameText = names.length > 1 ? names.slice(0, -1).join(", ") + " and " + names[names.length - 1] : names[0];
      return names.length > 1
        ? nameText + " were eliminated in a tie for " + ordinal(place) + " place."
        : nameText + " was eliminated in " + ordinal(place) + " place.";
    });
    node.textContent = lines.length ? lines.join(" ") : "A player was eliminated.";
    node.dataset.secondsRemaining = String(Math.ceil(remainingMs / 1000));
    node.hidden = false;
    var tableId = String(view.id || state.activeTableId || "");
    if (state.eliminationAnnouncementTimer) window.clearTimeout(state.eliminationAnnouncementTimer);
    state.eliminationAnnouncementTimer = 0;
    if (!view.paused) {
      state.eliminationAnnouncementTimer = window.setTimeout(function () {
        state.eliminationAnnouncementTimer = 0;
        if (String(state.activeTableId) !== tableId) return;
        clearEliminationAnnouncement();
        if (state.tableView && String(state.tableView.id || "") === tableId) refreshAll(true);
      }, remainingMs + 30);
    }
  }

  function closeRecentActionDialog() {
    var dialog = byId("recent-action-dialog");
    if (dialog && dialog.open) dialog.close();
    var trigger = byId("recent-action-button");
    if (trigger) trigger.setAttribute("aria-expanded", "false");
  }

  function replayStreets(hand) {
    var streets = Array.isArray(hand && hand.streets) ? hand.streets.filter(function (street) {
      return street && typeof street === "object";
    }) : [];
    if (streets.length) return streets;
    return [{ name: "showdown", board: cardArray(hand && hand.board) }];
  }

  function replayStreetName(value) {
    return String(value || "Street").replace(/[_-]+/g, " ").replace(/\b\w/g, function (letter) {
      return letter.toUpperCase();
    });
  }

  function syncLastHandButton() {
    var trigger = byId("last-hand-button");
    if (!trigger) return;
    var ready = Boolean(state.player && state.activeTableId && state.tableView &&
      number(state.tableView.hand_no, 0) > 0);
    trigger.hidden = !ready;
    trigger.disabled = !ready;
    trigger.setAttribute("aria-expanded", String(Boolean(byId("last-hand-dialog") && byId("last-hand-dialog").open)));
  }

  function renderLastHandReplay() {
    var stateReplay = state.lastHandReplay;
    var content = byId("last-hand-content");
    var streetLabel = byId("last-hand-street");
    var previous = byId("last-hand-prev");
    var next = byId("last-hand-next");
    if (!content || !streetLabel || !previous || !next) return;

    if (stateReplay.loading) {
      streetLabel.textContent = "Loading";
      content.setAttribute("aria-busy", "true");
      content.innerHTML = '<p class="replay-status" role="status">Loading the last hand…</p>';
      previous.disabled = true;
      next.disabled = true;
      return;
    }
    content.setAttribute("aria-busy", "false");
    if (stateReplay.error) {
      streetLabel.textContent = "Unavailable";
      content.innerHTML = '<p class="replay-error" role="alert">' + esc(stateReplay.error) + '</p>';
      previous.disabled = true;
      next.disabled = true;
      return;
    }
    if (!stateReplay.hand) {
      streetLabel.textContent = "No completed hand";
      content.innerHTML = '<p class="replay-empty">No completed hand is available yet.</p>';
      previous.disabled = true;
      next.disabled = true;
      return;
    }

    var hand = stateReplay.hand;
    var streets = replayStreets(hand);
    var index = Math.max(0, Math.min(streets.length - 1, stateReplay.streetIndex));
    stateReplay.streetIndex = index;
    var street = streets[index] || {};
    var board = cardArray(street.board);
    var players = Array.isArray(hand.players) ? hand.players : [];
    streetLabel.textContent = "Hand " + number(hand.number, 0) + " · " + replayStreetName(street.name);
    var boardMarkup = board.length
      ? board.map(function (card) { return playingCardHTML(card, true); }).join("")
      : '<span class="replay-no-cards">No community cards yet</span>';
    var playerMarkup = players.map(function (player) {
      var cards = cardArray(player && player.cards);
      var seatNo = number(player && player.seat_no, -1);
      var isViewer = String(player && player.player_id || "") === String(state.player && state.player.id || "");
      var name = String(player && player.name || "Player") + (isViewer ? " (you)" : "");
      var cardMarkup = cards.length
        ? cards.map(function (card) { return playingCardHTML(card, true); }).join("")
        : '<span class="replay-cards-hidden">Cards not exposed</span>';
      return '<article class="replay-player" role="listitem">' +
        '<h3 class="replay-player-name">' + esc(name) + '</h3>' +
        '<span class="replay-player-stack">' + (seatNo >= 0 ? "Seat " + (seatNo + 1) : "Seated player") + '</span>' +
        '<div class="replay-player-cards" aria-label="' + esc(cards.length ? "Visible cards" : "No visible cards") + '">' + cardMarkup + '</div>' +
      '</article>';
    }).join("");
    content.innerHTML =
      '<p class="replay-live-note">Live hand continues at the table.</p>' +
      '<section class="replay-board" aria-label="Community cards">' +
        '<h3>Community cards</h3><div class="replay-board-cards">' + boardMarkup + '</div>' +
      '</section>' +
      '<div class="replay-players" role="list" aria-label="Players in the hand">' +
        (playerMarkup || '<p class="replay-empty">Player details are unavailable.</p>') +
      '</div>';
    previous.disabled = index <= 0;
    next.disabled = index >= streets.length - 1;
  }

  function lastHandRequestIsCurrent(requestId, tableId, playerId) {
    var replay = state.lastHandReplay;
    var dialog = byId("last-hand-dialog");
    return Boolean(replay.requestId === requestId && replay.tableId === tableId &&
      replay.playerId === playerId && state.activeTableId === tableId &&
      String(state.player && state.player.id || "") === playerId && dialog && dialog.open);
  }

  async function fetchLastHand(requestId, tableId, playerId) {
    try {
      var data = await request("/tables/" + encodeURIComponent(tableId) + "/last-hand");
      if (!lastHandRequestIsCurrent(requestId, tableId, playerId)) return;
      state.lastHandReplay.hand = data && data.hand && typeof data.hand === "object" ? data.hand : null;
      state.lastHandReplay.streetIndex = state.lastHandReplay.hand
        ? replayStreets(state.lastHandReplay.hand).length - 1
        : 0;
      state.lastHandReplay.loading = false;
      state.lastHandReplay.error = "";
      renderLastHandReplay();
    } catch (err) {
      if (!lastHandRequestIsCurrent(requestId, tableId, playerId)) return;
      state.lastHandReplay.loading = false;
      state.lastHandReplay.error = err.message || "The last hand could not be loaded.";
      renderLastHandReplay();
    }
  }

  function openLastHandDialog(trigger) {
    var dialog = byId("last-hand-dialog");
    if (!dialog || dialog.open || !state.player || !state.activeTableId) return;
    var replay = state.lastHandReplay;
    replay.requestId += 1;
    replay.tableId = String(state.activeTableId);
    replay.playerId = String(state.player.id || "");
    replay.hand = null;
    replay.streetIndex = 0;
    replay.loading = true;
    replay.error = "";
    replay.trigger = trigger || byId("last-hand-button");
    dialog.showModal();
    syncLastHandButton();
    renderLastHandReplay();
    fetchLastHand(replay.requestId, replay.tableId, replay.playerId);
  }

  function closeLastHandDialog(restoreFocus) {
    var dialog = byId("last-hand-dialog");
    var replay = state.lastHandReplay;
    var trigger = replay.trigger;
    replay.requestId += 1;
    replay.tableId = "";
    replay.playerId = "";
    replay.hand = null;
    replay.streetIndex = 0;
    replay.loading = false;
    replay.error = "";
    replay.trigger = null;
    if (dialog && dialog.open) dialog.close();
    var content = byId("last-hand-content");
    if (content) {
      content.removeAttribute("aria-busy");
      content.replaceChildren();
    }
    var streetLabel = byId("last-hand-street");
    if (streetLabel) streetLabel.textContent = "Preflop";
    var previous = byId("last-hand-prev");
    var next = byId("last-hand-next");
    if (previous) previous.disabled = true;
    if (next) next.disabled = true;
    syncLastHandButton();
    if (restoreFocus && trigger && trigger.isConnected && trigger.getClientRects().length) {
      trigger.focus({ preventScroll: true });
    }
  }

  function moveLastHandStreet(delta) {
    var replay = state.lastHandReplay;
    if (!replay.hand || replay.loading) return;
    var streets = replayStreets(replay.hand);
    var nextIndex = replay.streetIndex + delta;
    if (nextIndex < 0 || nextIndex >= streets.length) return;
    replay.streetIndex = nextIndex;
    renderLastHandReplay();
  }

  function clearNotice() {
    showNotice("", "info", true);
  }

  function setLoggedOut(message) {
    closeLastHandDialog(false);
    clearChat();
    state.sitOutRequestId += 1;
    state.sitOutPending = false;
    state.player = null;
    state.showBigBlinds = false;
    document.body.classList.remove("gameplay-active");
    clearBlindAnnouncement(true);
    closeRecentActionDialog();
    setAuthMode("login");
    if (byId("history-dialog").open) byId("history-dialog").close();
    byId("history-content").replaceChildren();
    clearAuth();
    state.tableView = null;
    state.tables = [];
    state.activeTableId = "";
    state.skipAutoResume = false;
    state.polling = false;
    state.refreshPending = false;
    clearSeatTurnClock();
    if (state.refreshTimer) {
      window.clearTimeout(state.refreshTimer);
      state.refreshTimer = 0;
    }
    byId("identity").hidden = true;
    byId("app-panel").hidden = true;
    byId("login-panel").hidden = false;
    byId("login-password").value = "";
    if (message) showNotice(message, "error", true);
    else clearNotice();
  }

  function apiError(message, status, code) {
    this.name = "ApiError";
    this.message = message || "The request could not be completed.";
    this.status = status || 0;
    this.code = code || "";
  }
  apiError.prototype = Object.create(Error.prototype);
  apiError.prototype.constructor = apiError;

  async function request(path, options) {
    var opts = options || {};
    var method = opts.method || "GET";
    var headers = { "Accept": "application/json" };
    var init = {
      method: method,
      credentials: "same-origin",
      cache: "no-store",
      headers: headers
    };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    if (state.sessionProof) {
      headers["X-SitNgo-Session"] = state.sessionProof;
    }
    if (opts.mutate) {
      headers["X-SitNgo-CSRF"] = state.csrf;
    }

    var response;
    try {
      response = await fetch(API_ROOT + path, init);
    } catch (err) {
      throw new apiError("Could not reach the poker room. Check your connection and try again.", 0, "network");
    }

    var data;
    try {
      data = await response.json();
    } catch (err) {
      data = {};
    }

    if (response.status === 401 && !["/login", "/register", "/claim"].includes(path)) {
      setLoggedOut("Your session has expired. Sign in again.");
      throw new apiError("Your session has expired.", 401, "unauthorized");
    }

    if (!response.ok) {
      var detail = data && data.error ? data.error : {};
      var message = typeof detail.message === "string" ? detail.message : "The request could not be completed.";
      throw new apiError(message, response.status, detail.code || "");
    }
    return data || {};
  }

  function renderChatButton() {
    var button = byId("chat-button");
    var panel = byId("chat-panel");
    var preview = byId("chat-preview");
    if (!button || !panel) return;
    var available = Boolean(state.player && state.activeTableId && state.tableView);
    button.hidden = !available;
    if (preview) preview.hidden = !available;
    button.setAttribute("aria-expanded", String(Boolean(state.chat.open && !panel.hidden)));
  }

  function setChatPreviewLine(node, text, title, messageId) {
    if (node.textContent !== text) node.textContent = text;
    if (title == null) {
      if (node.hasAttribute("title")) node.removeAttribute("title");
    } else if (node.title !== title) {
      node.title = title;
    }
    if (messageId == null) {
      if (node.hasAttribute("data-message-id")) node.removeAttribute("data-message-id");
    } else if (node.getAttribute("data-message-id") !== messageId) {
      node.setAttribute("data-message-id", messageId);
    }
  }

  function renderChatPreview() {
    var preview = byId("chat-preview");
    if (!preview) return;
    var lines = preview.querySelectorAll(".chat-preview-line");
    if (lines.length !== 2) return;
    var messages = state.chat.messages.slice(-2);
    if (!messages.length) {
      setChatPreviewLine(lines[0], state.chat.error ? "Chat is unavailable." : (state.chat.loaded ? "No messages yet." : "Loading chat…"), null, null);
      setChatPreviewLine(lines[1], "Open chat to start the conversation.", null, null);
      return;
    }
    var offset = 2 - messages.length;
    for (var i = 0; i < offset; i += 1) {
      setChatPreviewLine(lines[i], "No earlier messages.", null, null);
    }
    messages.forEach(function (message, index) {
      var text = String(message.name || "Player") + ": " + String(message.text || "");
      setChatPreviewLine(lines[offset + index], text, text, message.id);
    });
  }

  function setChatError(message) {
    var node = byId("chat-error");
    if (!node) return;
    state.chat.error = message || "";
    node.textContent = state.chat.error;
    node.hidden = !state.chat.error;
  }

  function chatRequestIsCurrent(requestId, tableId, playerId) {
    return Boolean(state.chat.requestId === requestId &&
      state.chat.tableId === tableId && state.chat.playerId === playerId &&
      state.activeTableId === tableId && String(state.player && state.player.id || "") === playerId);
  }

  function ensureChatScope() {
    var tableId = String(state.activeTableId || "");
    var playerId = String(state.player && state.player.id || "");
    var chat = state.chat;
    if (!tableId || !playerId || !state.tableView) {
      if (chat.tableId || chat.messages.length || chat.open) clearChat();
      return;
    }
    if (chat.tableId !== tableId || chat.playerId !== playerId) {
      clearChat();
      chat.tableId = tableId;
      chat.playerId = playerId;
      chat.requestId += 1;
    }
    if (!chat.timer && chat.fetchRequestId !== chat.requestId) {
      fetchChat(chat.requestId, tableId, playerId);
    }
  }

  function clearChat() {
    var chat = state.chat;
    chat.requestId += 1;
    if (chat.timer) window.clearTimeout(chat.timer);
    chat.timer = 0;
    chat.tableId = "";
    chat.playerId = "";
    chat.open = false;
    chat.trigger = null;
    chat.messages = [];
    chat.loaded = false;
    chat.sending = false;
    chat.postRequestSerial += 1;
    chat.activePostId = chat.postRequestSerial;
    chat.postInFlight = false;
    chat.error = "";
    chat.fetchRequestId = 0;
    var panel = byId("chat-panel");
    var button = byId("chat-button");
    var messages = byId("chat-messages");
    var input = byId("chat-input");
    var send = byId("chat-send-button");
    var form = byId("chat-form");
    if (panel) panel.hidden = true;
    if (button) button.setAttribute("aria-expanded", "false");
    if (messages) messages.replaceChildren();
    renderChatPreview();
    if (input) {
      input.value = "";
      input.disabled = false;
    }
    if (send) send.disabled = true;
    if (form) form.setAttribute("aria-busy", "false");
    setChatError("");
    updateChatCharacterCount();
  }

  function closeChat(restoreFocus) {
    var chat = state.chat;
    var trigger = chat.trigger || byId("chat-button");
    chat.open = false;
    var panel = byId("chat-panel");
    var button = byId("chat-button");
    var input = byId("chat-input");
    var form = byId("chat-form");
    if (panel) panel.hidden = true;
    if (button) button.setAttribute("aria-expanded", "false");
    if (input) input.disabled = false;
    if (form) form.setAttribute("aria-busy", "false");
    updateChatCharacterCount();
    if (restoreFocus && trigger && trigger.isConnected) trigger.focus({ preventScroll: true });
  }

  function chatTimestamp(message) {
    var stamp = number(message && message.created_at, 0);
    if (stamp > 0 && stamp < 100000000000) stamp *= 1000;
    return stamp;
  }

  function createChatMessageNode(message) {
    var item = document.createElement("li");
    item.className = "chat-message";
    item.dataset.messageId = message.id;
    var header = document.createElement("div");
    header.className = "chat-message-header";
    var name = document.createElement("span");
    name.className = "chat-message-name";
    name.textContent = message.name || "Player";
    var time = document.createElement("time");
    time.className = "chat-message-time";
    var stamp = chatTimestamp(message);
    if (stamp) {
      var date = new Date(stamp);
      time.dateTime = date.toISOString();
      time.textContent = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    header.append(name, time);
    var body = document.createElement("p");
    body.className = "chat-message-text";
    body.textContent = message.text;
    item.append(header, body);
    return item;
  }

  function renderChatMessages(force, additions) {
    var list = byId("chat-messages");
    if (!list) return;
    var wasAtBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= 28;
    var oldScrollTop = list.scrollTop;
    var anchorId = "";
    var anchorOffset = 0;
    if (!wasAtBottom) {
      var listTop = list.getBoundingClientRect().top;
      Array.prototype.some.call(list.children, function (child) {
        var rect = child.getBoundingClientRect();
        if (rect.bottom <= listTop) return false;
        anchorId = child.getAttribute("data-message-id") || "";
        anchorOffset = rect.top - listTop;
        return true;
      });
    }
    if (force) {
      var fragment = document.createDocumentFragment();
      state.chat.messages.forEach(function (message) {
        fragment.appendChild(createChatMessageNode(message));
      });
      list.replaceChildren(fragment);
      if (wasAtBottom) list.scrollTop = list.scrollHeight;
      else {
        var anchor = anchorId ? Array.prototype.find.call(list.children, function (child) {
          return child.getAttribute("data-message-id") === anchorId;
        }) : null;
        if (anchor) {
          var nextOffset = anchor.getBoundingClientRect().top - list.getBoundingClientRect().top;
          list.scrollTop += nextOffset - anchorOffset;
        } else {
          list.scrollTop = Math.min(oldScrollTop, Math.max(0, list.scrollHeight - list.clientHeight));
        }
      }
      renderChatPreview();
      return;
    }
    (additions || []).forEach(function (message) {
      list.appendChild(createChatMessageNode(message));
    });
    if (wasAtBottom && (additions || []).length) list.scrollTop = list.scrollHeight;
    else list.scrollTop = oldScrollTop;
    if ((additions || []).length) renderChatPreview();
  }

  function mergeChatMessages(incoming, forceRender) {
    var current = state.chat.messages.slice();
    var known = Object.create(null);
    current.forEach(function (message) { known[message.id] = true; });
    var additions = [];
    (Array.isArray(incoming) ? incoming : []).forEach(function (raw) {
      if (!raw || raw.id == null) return;
      var message = {
        id: String(raw.id),
        player_id: String(raw.player_id || ""),
        name: String(raw.name || "Player"),
        text: String(raw.text == null ? "" : raw.text),
        created_at: raw.created_at
      };
      if (!message.id || known[message.id]) return;
      known[message.id] = true;
      additions.push(message);
    });
    var merged = current.concat(additions);
    function compareIds(a, b) {
      var aNumber = Number(a.id);
      var bNumber = Number(b.id);
      if (String(a.id).trim() !== "" && String(b.id).trim() !== "" &&
          Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
      var aTime = chatTimestamp(a);
      var bTime = chatTimestamp(b);
      if (aTime !== bTime) return aTime - bTime;
      return String(a.id).localeCompare(String(b.id));
    }
    var outOfOrder = Boolean(current.length && additions.some(function (message) {
      return compareIds(message, current[current.length - 1]) < 0;
    }));
    merged.sort(compareIds);
    var overflow = Math.max(0, merged.length - 100);
    if (overflow) merged.splice(0, overflow);
    state.chat.messages = merged;
    if (forceRender || overflow || outOfOrder) renderChatMessages(true, []);
    else renderChatMessages(false, additions);
  }

  function updateChatCharacterCount() {
    var input = byId("chat-input");
    var count = byId("chat-character-count");
    if (!input || !count) return;
    count.textContent = input.value.length + " / 500";
    var send = byId("chat-send-button");
    if (send) send.disabled = state.chat.sending || state.chat.postInFlight || !String(input.value || "").trim() ||
      !state.chat.open || !state.activeTableId || !state.player;
  }

  function showChat() {
    var tableId = String(state.activeTableId || "");
    var playerId = String(state.player && state.player.id || "");
    if (!tableId || !playerId || !state.tableView) return;
    if (state.chat.tableId !== tableId || state.chat.playerId !== playerId) clearChat();
    var chat = state.chat;
    chat.requestId += 1;
    chat.tableId = tableId;
    chat.playerId = playerId;
    chat.open = true;
    chat.trigger = byId("chat-button");
    var panel = byId("chat-panel");
    panel.hidden = false;
    byId("chat-button").setAttribute("aria-expanded", "true");
    setChatError("");
    updateChatCharacterCount();
    byId("chat-input").disabled = false;
    byId("chat-form").setAttribute("aria-busy", String(chat.postInFlight));
    byId("chat-input").focus({ preventScroll: true });
    fetchChat(chat.requestId, tableId, playerId);
  }

  function scheduleChatPoll(requestId, tableId, playerId) {
    var chat = state.chat;
    if (!chatRequestIsCurrent(requestId, tableId, playerId)) return;
    if (chat.timer) window.clearTimeout(chat.timer);
    chat.timer = window.setTimeout(function () {
      chat.timer = 0;
      fetchChat(requestId, tableId, playerId);
    }, 2000);
  }

  async function fetchChat(requestId, tableId, playerId) {
    var chat = state.chat;
    if (!chatRequestIsCurrent(requestId, tableId, playerId) || chat.fetchRequestId === requestId) return;
    chat.fetchRequestId = requestId;
    try {
      var data = await request("/tables/" + encodeURIComponent(tableId) + "/chat");
      if (!chatRequestIsCurrent(requestId, tableId, playerId)) return;
      var firstLoad = !chat.loaded;
      chat.loaded = true;
      mergeChatMessages(data.messages, firstLoad);
      setChatError("");
    } catch (err) {
      if (!chatRequestIsCurrent(requestId, tableId, playerId)) return;
      var message = err.message || "Chat could not be loaded.";
      if (chat.open) setChatError(message);
      else {
        chat.error = message;
        renderChatPreview();
      }
    } finally {
      if (chat.fetchRequestId === requestId) chat.fetchRequestId = 0;
      if (chatRequestIsCurrent(requestId, tableId, playerId)) scheduleChatPoll(requestId, tableId, playerId);
    }
  }

  async function sendChatMessage() {
    var chat = state.chat;
    var input = byId("chat-input");
    var text = String(input && input.value || "").trim();
    if (!text || chat.sending || chat.postInFlight || !chat.open || !state.activeTableId || !state.player) return;
    var requestId = chat.requestId;
    var tableId = chat.tableId;
    var playerId = chat.playerId;
    var postId = ++chat.postRequestSerial;
    chat.activePostId = postId;
    chat.postInFlight = true;
    chat.sending = true;
    setChatError("");
    byId("chat-form").setAttribute("aria-busy", "true");
    input.disabled = true;
    updateChatCharacterCount();
    try {
      var data = await mutate("/tables/" + encodeURIComponent(tableId) + "/chat", { text: text });
      if (!chatRequestIsCurrent(requestId, tableId, playerId)) return;
      mergeChatMessages(data && data.message ? [data.message] : [], false);
      input.value = "";
    } catch (err) {
      if (chatRequestIsCurrent(requestId, tableId, playerId)) setChatError(err.message || "Your message could not be sent.");
    } finally {
      if (chat.activePostId === postId && chat.tableId === tableId && chat.playerId === playerId &&
          state.activeTableId === tableId && String(state.player && state.player.id || "") === playerId) {
        chat.postInFlight = false;
        chat.sending = false;
        input.disabled = false;
        byId("chat-form").setAttribute("aria-busy", "false");
        updateChatCharacterCount();
      }
    }
  }

  function renderSitOutButton(view, seat) {
    var button = byId("sit-out-button");
    if (!button) return;
    var viewer = view && view.viewer || {};
    var canToggle = Boolean(state.player && state.activeTableId && view && seat &&
      (view.status === "lobby" || view.status === "playing") &&
      !isBotSeat(seat) && seat.connected !== false && !seat.disconnected &&
      viewer.disconnected !== true && viewer.seated !== false);
    button.hidden = !canToggle;
    if (!canToggle) {
      button.setAttribute("aria-pressed", "false");
      button.disabled = true;
      button.removeAttribute("aria-busy");
      return;
    }
    var sittingOut = Boolean(seat.sitting_out);
    button.textContent = sittingOut ? "Return to play" : "Sit out";
    button.setAttribute("aria-label", sittingOut ? "Return to play" : "Sit out");
    button.setAttribute("aria-pressed", String(sittingOut));
    button.disabled = state.sitOutPending;
    button.setAttribute("aria-busy", String(state.sitOutPending));
  }

  function sitOutRequestIsCurrent(requestId, tableId, playerId) {
    return Boolean(state.sitOutRequestId === requestId && state.activeTableId === tableId &&
      String(state.player && state.player.id || "") === playerId);
  }

  async function toggleSitOut() {
    var view = state.tableView;
    var seat = viewerSeat(view);
    if (!view || !seat || state.sitOutPending) return;
    var tableId = String(state.activeTableId || "");
    var playerId = String(state.player && state.player.id || "");
    if (!tableId || !playerId || isBotSeat(seat)) return;
    var requestId = ++state.sitOutRequestId;
    state.sitOutPending = true;
    renderSitOutButton(view, seat);
    try {
      var data = await mutate("/tables/" + encodeURIComponent(tableId) + "/sit-out", {
        sitting_out: !Boolean(seat.sitting_out)
      });
      if (!sitOutRequestIsCurrent(requestId, tableId, playerId)) return;
      var updated = data && data.table ? data.table : data;
      if (adoptSnapshot(updated, tableId)) renderTable();
      refreshAll(true);
    } catch (err) {
      if (sitOutRequestIsCurrent(requestId, tableId, playerId)) showNotice(err.message, "error", false);
    } finally {
      if (sitOutRequestIsCurrent(requestId, tableId, playerId)) {
        state.sitOutPending = false;
        if (state.tableView) renderSitOutButton(state.tableView, viewerSeat(state.tableView));
      }
    }
  }

  function statusName(status) {
    if (status === "playing") return "In progress";
    if (status === "completed") return "Complete";
    return "Waiting";
  }

  function blindParts(source) {
    var b = source && source.blinds ? source.blinds : {};
    return {
      small: number(b.small != null ? b.small : (b.small_blind != null ? b.small_blind : (source && source.small_blind)), 0),
      big: number(b.big != null ? b.big : (b.big_blind != null ? b.big_blind : (source && source.big_blind)), 0),
      level: number(b.level != null ? b.level : (source && source.level), 1),
      seconds: number(b.seconds_to_next != null ? b.seconds_to_next : (source && source.seconds_to_next), -1),
      pending: Boolean(b.pending != null ? b.pending : (source && source.blinds_pending)),
      nextAt: b.next_level_at || b.level_ends_at || (source && (source.next_level_at || source.level_ends_at)) || ""
    };
  }

  function formatClock(seconds) {
    var s = Math.max(0, Math.floor(number(seconds, 0)));
    var mins = Math.floor(s / 60);
    var secs = s % 60;
    return String(mins).padStart(2, "0") + ":" + String(secs).padStart(2, "0");
  }

  function clockRemaining(blinds, view) {
    if (blinds.nextAt) {
      var nextAt = epochMilliseconds(blinds.nextAt);
      var serverNow = epochMilliseconds(view && view.server_now) || Date.now();
      if (nextAt) return Math.max(0, Math.floor((nextAt - serverNow) / 1000));
    }
    if (blinds.seconds >= 0) return blinds.seconds;
    return -1;
  }

  function renderTables() {
    var list = byId("table-list");
    var tables = state.tables || [];
    byId("table-count").textContent = String(tables.length);
    if (!tables.length) {
      list.innerHTML = '<div class="list-empty">No open tables yet.<br>Start one for your group.</div>';
      return;
    }

    list.innerHTML = tables.map(function (table) {
      var active = String(table.id) === String(state.activeTableId);
      var b = blindParts(table);
      var count = number(table.seated_count != null ? table.seated_count : table.players, 0);
      var max = number(table.max_seats, 0);
      var status = table.status || "lobby";
      var dot = status === "playing" ? "playing" : (status === "completed" ? "completed" : "");
      var label = statusName(status);
      var host = table.host_name ? "Host " + esc(table.host_name) : "Private table";
      return '<button type="button" class="table-card" data-open-table="' + esc(table.id) + '" aria-current="' + (active ? "true" : "false") + '">' +
        '<span class="table-card-top"><span class="table-card-name">' + esc(table.name || "Sit-and-go") + '</span>' +
        '<span class="table-card-status"><i class="status-dot ' + dot + '"></i>' + label + '</span></span>' +
        '<span class="table-card-bottom"><span>' + host + '</span><span>' + count + (max ? " / " + max : "") + ' seats</span></span>' +
        '<span class="table-card-bottom"><span>Blinds ' + chips(b.small) + ' / ' + chips(b.big) + '</span><span>Open table ↗</span></span>' +
      '</button>';
    }).join("");
  }

  function cardInfo(card) {
    if (card == null) return null;
    if (typeof card === "object") {
      var rank = String(card.rank || card.value || "");
      var suit = String(card.suit || "");
      return { rank: rank, suit: suit };
    }
    var code = String(card);
    if (code.length < 2) return { rank: code, suit: "" };
    return { rank: code.slice(0, -1), suit: code.slice(-1) };
  }

  function cardSuit(rawSuit) {
    var s = String(rawSuit || "").toLowerCase();
    if (s === "s" || s === "spades" || s === "♠") return { symbol: "♠", red: false };
    if (s === "h" || s === "hearts" || s === "♥") return { symbol: "♥", red: true };
    if (s === "d" || s === "diamonds" || s === "♦") return { symbol: "♦", red: true };
    if (s === "c" || s === "clubs" || s === "♣") return { symbol: "♣", red: false };
    return { symbol: "", red: false };
  }

  function playingCardHTML(card, small) {
    var info = cardInfo(card);
    if (!info) return '<span class="' + (small ? "mini-card" : "playing-card") + ' placeholder" aria-hidden="true"></span>';
    var suit = cardSuit(info.suit);
    var rank = String(info.rank || "").toUpperCase();
    var cls = small ? "mini-card" : "playing-card";
    if (suit.red) cls += " red";
    if (small) return '<span class="' + cls + '" aria-label="' + esc(rank + " " + suit.symbol) + '"><b class="mini-rank">' + esc(rank) + '</b><span class="mini-suit">' + esc(suit.symbol) + '</span></span>';
    return '<span class="' + cls + '" aria-label="' + esc(rank + " " + suit.symbol) + '"><b class="rank">' + esc(rank) + '</b><span class="suit">' + esc(suit.symbol) + '</span></span>';
  }

  function hiddenCardHTML(small, folded) {
    var cls = small ? "mini-card back" : "playing-card placeholder";
    if (folded) cls += " folded-back";
    return '<span class="' + cls + '" aria-hidden="true"></span>';
  }

  function cardArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function seatLayout(view) {
    var seats = Array.isArray(view.seats) ? view.seats : [];
    var configuredMax = number(view.config && view.config.max_seats, number(view.max_seats, seats.length || 2));
    var max = Math.max(2, Math.min(9, Math.floor(configuredMax)));
    var bySeat = {};
    seats.forEach(function (seat, index) {
      var rawSeatNo = seat.seat_no != null ? seat.seat_no : index;
      var seatNo = Math.floor(number(rawSeatNo, index));
      bySeat[seatNo] = seat;
    });
    return { seats: seats, max: max, bySeat: bySeat };
  }

  function isBotSeat(seat) {
    if (!seat) return false;
    var id = String(seat.id || seat.player_id || "");
    return Boolean(seat.is_bot || seat.bot || seat.kind === "bot" || id.indexOf("bot:") === 0);
  }

  function seatCountsAsTournamentRemaining(view, seat) {
    if (!seat) return false;
    var stack = number(seat.stack, 0);
    if (stack > 0) return true;
    var folded = Boolean(seat.folded || seat.is_folded);
    var allIn = Boolean(seat.all_in || seat.is_all_in);
    return Boolean(view && view.status === "playing" && allIn && !folded);
  }

  function tournamentPlayerCount(view) {
    return (Array.isArray(view && view.seats) ? view.seats : []).filter(function (seat) {
      return seatCountsAsTournamentRemaining(view, seat);
    }).length;
  }

  function eventSeatNo(event) {
    var raw = event && (event.seat_no != null ? event.seat_no : event.seat);
    return raw == null ? null : String(Math.floor(number(raw, -1)));
  }

  function eventActorId(event) {
    var actor = event && (event.actor_id || event.player_id || event.actor);
    if (actor && typeof actor === "object") actor = actor.player_id || actor.id || "";
    return actor == null ? "" : String(actor);
  }

  function eventActionText(event) {
    var action = String(event && event.action || "action").toLowerCase().replace(/[ -]+/g, "_");
    var paid = number(event && event.amount, 0);
    var streetTotal = number(event && event.street_contribution, paid);
    var actionTotal = action === "bet" || action === "raise" || action === "raise_to" || action === "all_in" || action === "allin" ? streetTotal : paid;
    var value = actionTotal > 0 ? " · " + tableChips(actionTotal) : "";
    var names = {
      fold: ["FOLDED", "FOLD"],
      check: ["CHECKED", "CHECK"],
      call: ["CALL" + value, "CALL" + value],
      bet: ["BET" + value, "BET" + value],
      raise: ["RAISE TO" + value, "RAISE" + value],
      raise_to: ["RAISE TO" + value, "RAISE" + value],
      all_in: ["ALL-IN" + value, "ALL-IN" + value],
      allin: ["ALL-IN" + value, "ALL-IN" + value],
      small_blind: ["SMALL BLIND" + value, "SB" + value],
      big_blind: ["BIG BLIND" + value, "BB" + value],
      ante: ["ANTE" + value, "ANTE" + value]
    };
    return names[action] || [action.toUpperCase() + value, action.toUpperCase() + value];
  }

  function rememberTableEvent(event) {
    var fx = state.tableFx;
    if (!event || typeof event !== "object") return;
    if (event.type === "action") {
      var text = eventActionText(event);
      var actionStreet = String(event.street || "");
      if (actionStreet && fx.street && actionStreet !== fx.street) fx.actions = {};
      if (actionStreet) fx.street = actionStreet;
      var actionState = {
        label: text[0],
        compactLabel: text[1],
        kind: String(event.action || "").toLowerCase().replace(/[ -]+/g, "_"),
        seatNo: eventSeatNo(event),
        actorLabel: String(event.actor_label || ""),
        rawEvent: { action: event.action, amount: event.amount, street_contribution: event.street_contribution }
      };
      var id = eventActorId(event);
      if (id) fx.actions[id] = actionState;
      if (actionState.seatNo != null) fx.actions["seat:" + actionState.seatNo] = actionState;
      if (actionState.actorLabel) fx.actions["name:" + actionState.actorLabel.toLowerCase()] = actionState;
    } else if (event.type === "street") {
      fx.actions = {};
      fx.street = String(event.street || "");
    } else if (event.type === "reveal") {
      (Array.isArray(event.hands) ? event.hands : []).forEach(function (hand) {
        var id = String(hand && hand.player_id || "");
        if (id && Array.isArray(hand.cards)) fx.revealed[id] = hand.cards;
      });
    } else if (event.type === "showdown_result" || event.type === "payout") {
      (Array.isArray(event.showdown) ? event.showdown : []).forEach(function (hand) {
        var id = String(hand && hand.player_id || "");
        if (id && Array.isArray(hand.cards)) fx.revealed[id] = hand.cards;
      });
    }
  }
  function snapshotTableEffects(view, events) {
    var fx = state.tableFx;
    fx.generation += 1;
    fx.queue = [];
    fx.currentItem = null;
    fx.actions = {};
    fx.street = "";
    fx.revealed = {};
    fx.displayWagers = {};
    fx.wagerPositions = {};
    fx.eventAware = Array.isArray(events);
    fx.lastSeq = 0;
    (events || []).forEach(function (event) {
      rememberTableEvent(event);
      fx.lastSeq = Math.max(fx.lastSeq, number(event && event.seq, -1));
    });
    var snapshotStreet = String(view.street || "");
    if (fx.street && snapshotStreet && fx.street !== snapshotStreet) fx.actions = {};
    fx.street = snapshotStreet;
    (Array.isArray(view.seats) ? view.seats : []).forEach(function (seat, index) {
      var rawSeatNo = seat.seat_no != null ? seat.seat_no : index;
      var amount = number(seat.bet != null ? seat.bet : seat.street_bet, 0);
      if (amount > 0) fx.displayWagers[String(Math.floor(number(rawSeatNo, index)))] = amount;
    });
  }

  function consumeTableEvents(view) {
    var fx = state.tableFx;
    var handId = String(view.hand_id || (number(view.hand_no, 0) ? "hand:" + number(view.hand_no, 0) : ""));
    var events = Array.isArray(view.events) ? view.events : null;
    var baseSeq = number(view.event_base_seq, 0);
    var firstView = fx.handId === null;
    var handChanged = !firstView && handId !== fx.handId;

    if (firstView || handChanged) {
      fx.handId = handId;
      fx.street = "";
      fx.lastSeq = 0;
      var replayNewHand = handChanged && Boolean(handId) && Array.isArray(events) && baseSeq <= 1;
      if (replayNewHand) {
        fx.generation += 1;
        fx.actions = {};
        fx.revealed = {};
        fx.displayWagers = {};
        fx.wagerPositions = {};
        fx.queue = [];
        fx.currentItem = null;
        fx.eventAware = true;
        events.slice().sort(function (a, b) { return number(a.seq, 0) - number(b.seq, 0); }).forEach(function (event) {
          var seq = number(event && event.seq, -1);
          rememberTableEvent(event);
          if (event && event.type === "action" && number(event.amount, 0) > 0) fx.queue.push({ type: "action", event: event });
          else if (event && event.type === "sweep") fx.queue.push({ type: "sweep", event: event });
          fx.lastSeq = Math.max(fx.lastSeq, seq);
        });
        fx.street = String(view.street || fx.street || "");
      } else {
        snapshotTableEffects(view, events);
      }
      return;
    }

    var visibleStreet = String(view.street || "");
    if (visibleStreet && fx.street && visibleStreet !== fx.street) fx.actions = {};
    if (!events) {
      fx.street = visibleStreet || fx.street;
      return;
    }
    fx.eventAware = true;
    if (baseSeq > fx.lastSeq + 1) {
      snapshotTableEffects(view, events);
      return;
    }
    var ordered = events.slice().sort(function (a, b) { return number(a.seq, 0) - number(b.seq, 0); });
    var unseen = ordered.filter(function (event) { return number(event && event.seq, -1) > fx.lastSeq; });
    if (unseen.length && number(unseen[0].seq, -1) > fx.lastSeq + 1) {
      snapshotTableEffects(view, events);
      return;
    }
    unseen.forEach(function (event) {
      var seq = number(event && event.seq, -1);
      rememberTableEvent(event);
      if (event && event.type === "action" && number(event.amount, 0) > 0) fx.queue.push({ type: "action", event: event });
      else if (event && event.type === "sweep") fx.queue.push({ type: "sweep", event: event });
      fx.lastSeq = Math.max(fx.lastSeq, seq);
    });
    fx.street = visibleStreet || fx.street;
  }

  function actionForSeat(seat, seatNo) {
    var fx = state.tableFx;
    var id = String(seat.id || seat.player_id || "");
    var name = String(seat.name || "").toLowerCase();
    var action = fx.actions[id] || fx.actions["seat:" + seatNo] || (name ? fx.actions["name:" + name] : null) || null;
    if (action && action.rawEvent) {
      var text = eventActionText(action.rawEvent);
      action.label = text[0];
      action.compactLabel = text[1];
    }
    return action;
  }

  function addLayerPoint(node, gridRect, x, y) {
    if (!node || !gridRect.width || !gridRect.height) return;
    node.style.left = (x / gridRect.width * 100).toFixed(2) + "%";
    node.style.top = (y / gridRect.height * 100).toFixed(2) + "%";
  }

  function boxForNode(node, gridRect) {
    if (!node || node.hidden) return null;
    var rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return { left: rect.left - gridRect.left, top: rect.top - gridRect.top, right: rect.right - gridRect.left, bottom: rect.bottom - gridRect.top };
  }

  function boxesOverlap(a, b, gap) {
    var pad = gap || 0;
    return a.left < b.right + pad && a.right + pad > b.left && a.top < b.bottom + pad && a.bottom + pad > b.top;
  }

  function findBadgeSpot(node, seatNode, gridRect, blockers) {
    var seatRect = boxForNode(seatNode, gridRect);
    if (!seatRect) return null;
    var width = node.offsetWidth || 20;
    var height = node.offsetHeight || 20;
    var seatWidth = seatRect.right - seatRect.left;
    var seatHeight = seatRect.bottom - seatRect.top;
    var cx = (seatRect.left + seatRect.right) / 2;
    var cy = (seatRect.top + seatRect.bottom) / 2;
    var baseAngle = Math.atan2(gridRect.height / 2 - cy, gridRect.width / 2 - cx);
    var offsets = [0, 36, -36, 72, -72, 108, -108, 144, -144, 180];
    var steps = [0, 14, 28, 42, 56, 70, 84, 98];

    function valid(x, y) {
      var box = { left: x - width / 2, right: x + width / 2, top: y - height / 2, bottom: y + height / 2 };
      if (box.left < 4 || box.top < 4 || box.right > gridRect.width - 4 || box.bottom > gridRect.height - 4) return null;
      for (var i = 0; i < blockers.length; i += 1) {
        if (boxesOverlap(box, blockers[i], 4)) return null;
      }
      return { x: x, y: y, box: box };
    }

    for (var a = 0; a < offsets.length; a += 1) {
      var angle = baseAngle + offsets[a] * Math.PI / 180;
      var ux = Math.cos(angle);
      var uy = Math.sin(angle);
      var xClear = Math.abs(ux) > .001 ? ((seatWidth + width) / 2 + 7) / Math.abs(ux) : Infinity;
      var yClear = Math.abs(uy) > .001 ? ((seatHeight + height) / 2 + 7) / Math.abs(uy) : Infinity;
      var distance = Math.min(xClear, yClear);
      for (var step = 0; step < steps.length; step += 1) {
        var found = valid(cx + ux * (distance + steps[step]), cy + uy * (distance + steps[step]));
        if (found) return found;
      }
    }

    var fallback = null;
    var fallbackScore = Infinity;
    for (var y = height / 2 + 5; y <= gridRect.height - height / 2 - 5; y += 14) {
      for (var x = width / 2 + 5; x <= gridRect.width - width / 2 - 5; x += 14) {
        var candidate = valid(x, y);
        if (!candidate) continue;
        var distanceToSeat = Math.hypot(x - cx, y - cy);
        if (distanceToSeat < fallbackScore) {
          fallback = candidate;
          fallbackScore = distanceToSeat;
        }
      }
    }
    return fallback;
  }

  function queuedWagerAmounts(fx) {
    var amounts = {};
    var pending = [];
    if (fx.currentItem) pending.push(fx.currentItem);
    (fx.queue || []).some(function (item) {
      if (item.type === "sweep") return true;
      pending.push(item);
      return false;
    });
    pending.forEach(function (item) {
      if (item.type !== "action" || number(item.event && item.event.amount, 0) <= 0) return;
      var seatNo = eventSeatNo(item.event);
      if (seatNo == null) return;
      amounts[seatNo] = number(item.event.street_contribution, number(item.event.amount, 0));
    });
    return amounts;
  }

  function epochMilliseconds(value) {
    var stamp = number(value, 0);
    if (stamp > 0 && stamp < 100000000000) stamp *= 1000;
    return stamp;
  }

  function monotonicNow() {
    return window.performance && typeof window.performance.now === "function" ? window.performance.now() : Date.now();
  }

  function turnClockSecondsRemaining() {
    if (!state.seatTurnClockKey) return -1;
    if (state.seatTurnClockPaused) return Math.max(0, Math.ceil(state.seatTurnRemainingMs / 1000));
    var elapsed = monotonicNow() - state.seatTurnClockUpdatedAt;
    return Math.max(0, Math.ceil((state.seatTurnRemainingMs - elapsed) / 1000));
  }

  function turnClockLabel() {
    var seconds = turnClockSecondsRemaining();
    return seconds >= 0 ? formatClock(seconds) : "";
  }

  function updateSeatTurnClockNodes() {
    var label = turnClockLabel();
    document.querySelectorAll(".seat-turn-clock").forEach(function (node) {
      node.textContent = label;
    });
  }

  function clearSeatTurnClock() {
    if (state.seatTurnClockTimer) window.clearInterval(state.seatTurnClockTimer);
    state.seatTurnClockTimer = 0;
    state.seatTurnClockKey = "";
    state.seatTurnRemainingMs = 0;
    state.seatTurnClockUpdatedAt = 0;
    state.seatTurnClockPaused = false;
  }

  function syncSeatTurnClock(view) {
    var actorId = String(view && (view.actor_id || view.to_act_id) || "");
    var deadline = epochMilliseconds(view && view.turn_deadline);
    var serverNow = epochMilliseconds(view && view.server_now);
    if (!serverNow) serverNow = Date.now();
    var paused = Boolean(view && view.paused);
    var valid = Boolean(view && view.status === "playing" && actorId && deadline);
    if (!valid) {
      clearSeatTurnClock();
      return;
    }
    var key = [view.id || "", view.hand_id || view.hand_no || "", view.street || "", actorId, view.turn_version || "", deadline, paused ? "paused" : "live"].join("|");
    if (key !== state.seatTurnClockKey) {
      if (state.seatTurnClockTimer) window.clearInterval(state.seatTurnClockTimer);
      state.seatTurnClockKey = key;
      state.seatTurnClockTimer = window.setInterval(updateSeatTurnClockNodes, 250);
    }
    state.seatTurnRemainingMs = Math.max(0, deadline - serverNow);
    state.seatTurnClockUpdatedAt = monotonicNow();
    state.seatTurnClockPaused = paused;
    updateSeatTurnClockNodes();
  }

  function motionAllowed() {
    if (document.hidden) return false;
    return !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function animateChip(layer, start, end, amount, duration, label, kind) {
    if (!motionAllowed() || !layer || !start || !end || typeof layer.animate !== "function") return Promise.resolve();
    var bounds = layer.getBoundingClientRect();
    var chip = document.createElement("span");
    chip.className = "chip-flight" + (kind ? " chip-flight-" + kind : "");
    chip.textContent = label == null ? tableChips(amount) : String(label);
    chip.style.left = (start.x - bounds.left) + "px";
    chip.style.top = (start.y - bounds.top) + "px";
    layer.appendChild(chip);
    var dx = end.x - start.x;
    var dy = end.y - start.y;
    var animation = chip.animate([
      { transform: "translate(-50%, -50%) scale(.82)", opacity: .96 },
      { transform: "translate(calc(-50% + " + dx + "px), calc(-50% + " + dy + "px)) scale(.65)", opacity: .84 }
    ], { duration: duration || 430, easing: "cubic-bezier(.18,.74,.32,1)", fill: "forwards" });
    return animation.finished.catch(function () {}).then(function () { chip.remove(); });
  }
  function playTableEffects() {
    var fx = state.tableFx;
    if (fx.running || !fx.queue.length) return;
    var item = fx.queue.shift();
    var generation = fx.generation;
    fx.currentItem = item;
    var view = state.tableView;
    fx.running = true;

    function stillCurrent() { return generation === fx.generation; }
    function complete() {
      fx.running = false;
      if (fx.currentItem === item) fx.currentItem = null;
      if (stillCurrent() && state.tableView) {
        renderBoard(state.tableView);
        renderSeats(state.tableView);
        renderResults(state.tableView);
      }
      playTableEffects();
    }

    if (item.type === "action") {
      var event = item.event || {};
      var seatNo = eventSeatNo(event);
      var seat = (view && Array.isArray(view.seats) ? view.seats : []).find(function (candidate, index) {
        var rawSeatNo = candidate.seat_no != null ? candidate.seat_no : index;
        return String(Math.floor(number(rawSeatNo, index))) === seatNo;
      });
      var sourceNode = seat && byId("seat-grid").querySelector('.seat-card[data-seat-no="' + seatNo + '"]');
      var layer = byId("chip-layer");
      var sourceRect = sourceNode && sourceNode.getBoundingClientRect();
      var target = fx.wagerPositions[seatNo];
      var start = sourceRect ? { x: sourceRect.left + sourceRect.width / 2, y: sourceRect.top + sourceRect.height / 2 } : null;
      var contribution = number(event.street_contribution, number(event.amount, 0));
      animateChip(layer, start, target, event.amount, 430).then(function () {
        if (stillCurrent() && seatNo != null) fx.displayWagers[seatNo] = contribution;
        complete();
      });
      return;
    }

    if (item.type === "sweep") {
      var layerNode = byId("chip-layer");
      var potNode = byId("pot-amount");
      var potRect = potNode && potNode.getBoundingClientRect();
      var center = potRect ? { x: potRect.left + potRect.width / 2, y: potRect.top + potRect.height / 2 } : null;
      var motions = [];
      byId("seat-grid").querySelectorAll(".seat-wager:not(.is-reserved)").forEach(function (node) {
        var rect = node.getBoundingClientRect();
        var raw = node.getAttribute("data-seat-no");
        var amount = fx.displayWagers[String(raw)] || 0;
        motions.push(animateChip(layerNode, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, center, amount, 470));
      });
      Promise.all(motions).then(function () {
        if (stillCurrent()) fx.displayWagers = {};
        complete();
      });
      return;
    }

    complete();
  }
  function renderSeats(view) {
    var layout = seatLayout(view);
    var max = layout.max;
    var ringOnlySeated = view.status === "playing" || view.status === "completed";
    var hasInHandFlags = layout.seats.some(function (seat) { return typeof (seat && seat.in_hand) === "boolean"; });
    var feltSeats = view.status === "completed" && hasInHandFlags
      ? layout.seats.filter(function (seat) { return seat.in_hand === true; })
      : (ringOnlySeated
        ? layout.seats.filter(function (seat) { return seatCountsAsTournamentRemaining(view, seat); })
        : layout.seats);
    var bySeat = Object.create(null);
    feltSeats.forEach(function (seat, index) {
      var rawSeatNo = seat.seat_no != null ? seat.seat_no : index;
      bySeat[Math.floor(number(rawSeatNo, index))] = seat;
    });
    var viewer = view.viewer || {};
    var viewerId = String(viewer.player_id || (state.player && state.player.id) || "");
    var ownSeat = feltSeats.find(function (seat) {
      return String(seat.id || seat.player_id || "") === viewerId;
    });
    var viewerHasSeat = layout.seats.some(function (seat) {
      return String(seat.id || seat.player_id || "") === viewerId;
    });
    var hostId = String(view.host_id || "");
    var isHost = Boolean(viewerId && viewerId === hostId);
    var anchorSeat = ownSeat || feltSeats.find(function (seat) {
      return String(seat.id || seat.player_id || "") === hostId;
    }) || feltSeats[0] || null;
    var anchorRawSeatNo = anchorSeat && anchorSeat.seat_no != null ? anchorSeat.seat_no : layout.seats.indexOf(anchorSeat);
    var anchorSeatNo = anchorSeat ? Math.floor(number(anchorRawSeatNo, 0)) : 0;
    var clockwiseSeats = feltSeats.map(function (seat, index) {
      var raw = seat.seat_no != null ? seat.seat_no : index;
      var seatNo = Math.floor(number(raw, index));
      return { seatNo: seatNo, offset: (seatNo - anchorSeatNo + max) % max };
    }).sort(function (a, b) { return a.offset - b.offset; });
    var relativeBySeatNo = Object.create(null);
    clockwiseSeats.forEach(function (entry, index) { relativeBySeatNo[entry.seatNo] = index; });
    var positionCount = ringOnlySeated ? Math.max(2, Math.min(max, clockwiseSeats.length)) : max;
    var actorId = String(view.actor_id || view.to_act_id || "");
    var buttonId = String(view.button_id || "");
    var currentHand = view.status === "playing";
    var fx = state.tableFx;
    var pendingWagers = queuedWagerAmounts(fx);
    var oddsByPlayer = Object.create(null);
    (Array.isArray(view.runout_odds) ? view.runout_odds : []).forEach(function (row) {
      var oddsId = String(row && row.player_id || "");
      if (oddsId) oddsByPlayer[oddsId] = row;
    });
    var html = "";

    for (var i = 0; i < max; i += 1) {
      var seat = bySeat[i];
      var relativeIndex = ringOnlySeated
        ? number(relativeBySeatNo[i], (i - anchorSeatNo + max) % max)
        : (i - anchorSeatNo + max) % max;
      if (!seat) {
        if (!ringOnlySeated) {
          var emptySeatNo = i + 1;
          var emptyActions = "";
          if (!viewerHasSeat) {
            emptyActions += '<button class="seat-empty-join" type="button" data-take-seat="' + i + '" aria-label="Take seat ' + emptySeatNo + '"><span>Take seat</span></button>';
          } else {
            emptyActions += '<span class="seat-empty-open">Open</span>';
          }
          var botAction = isHost
            ? '<button class="seat-empty-bot" type="button" data-add-bot-seat="' + i + '" aria-label="Add test bot to seat ' + emptySeatNo + '">Add bot</button>'
            : "";
          html += '<div class="seat-card seat-empty' + (botAction ? ' has-secondary-action' : '') + '" data-seat-no="' + i + '" data-relative-seat="' + relativeIndex + '" data-seat-empty="true">' + emptyActions + botAction + '</div>';
        }
        continue;
      }

      var id = String(seat.id || seat.player_id || "");
      var isMe = id && id === viewerId;
      var bot = isBotSeat(seat);
      var folded = Boolean(seat.folded || seat.is_folded);
      var allIn = Boolean(seat.all_in || seat.is_all_in);
      var sittingOut = Boolean(seat.sitting_out);
      var acting = actorId && id === actorId;
      var dealer = buttonId && id === buttonId;
      var classes = "seat-card" + (isMe ? " is-me" : "") + (acting ? " is-acting" : "") + (folded ? " is-folded" : "") + (bot ? " is-bot" : "");
      var label = sittingOut ? "Sitting out" : (folded ? "Folded" : (allIn ? "All in" : ""));
      var stack = number(seat.stack, 0);
      var rawSeatNo = seat.seat_no != null ? seat.seat_no : i;
      var seatNo = String(Math.floor(number(rawSeatNo, i)));
      var actionState = actionForSeat(seat, seatNo);
      if (acting) actionState = { label: "TO ACT", compactLabel: "TO ACT", kind: "turn" };
      else if (!actionState && allIn) actionState = { label: "ALL-IN", compactLabel: "ALL-IN", kind: "all_in" };
      var cards = [];
      if (isMe) {
        cards = cardArray(viewer.hole_cards);
        if (!cards.length) cards = cardArray(seat.hole_cards);
      } else {
        cards = fx.revealed[id] || cardArray(seat.cards);
        if (!cards.length) cards = cardArray(seat.revealed_cards);
      }
      var exposed = Boolean(cards.length && !isMe && (fx.revealed[id] || seat.cards || seat.revealed_cards));
      var oddsRow = oddsByPlayer[id];
      if (oddsRow && cards.length && !folded && stack <= 0) { allIn = true; label = "All in"; }
      if (allIn && stack <= 0) classes += " is-all-in is-zero-stack-all-in";
      var equityHtml = "";
      if (oddsRow && cards.length && (isMe || exposed)) {
        var winPct = number(oddsRow.win_pct, 0);
        var tiePct = number(oddsRow.tie_pct, 0);
        var equityPct = number(oddsRow.equity_pct, 0);
        var sampleCount = number(oddsRow.samples, 0);
        var exactness = oddsRow.exact === true
          ? "Exact enumeration of remaining runouts."
          : (sampleCount > 0 ? "Simulation estimate from " + chips(sampleCount) + " sampled runouts." : "Simulation estimate; sample count unavailable.");
        var oddsLabel = "Outright win chance " + percent(winPct) + ". Tied-best chance " + percent(tiePct) +
          ". Equity is expected share of a hypothetical shared pot: " + percent(equityPct) +
          ". Compared with all live hands; side pots can have different eligible players. " + exactness;
        equityHtml = '<div class="seat-equity" data-player-id="' + esc(id) + '" role="group" tabindex="0" aria-label="' + esc(oddsLabel) + '" title="' + esc(oddsLabel) + '">' +
          '<span class="seat-equity-win"><span>Win alone</span><strong>' + percent(winPct) + '</strong></span>' +
          (tiePct >= 0.5 ? '<span class="seat-equity-tie">Tie ' + percent(tiePct) + '</span>' : '') + '</div>';
      }

      var compactRunoutSeat = Boolean(equityHtml && !folded && stack <= 0);
      var stackContents = '<span class="seat-stack-amount">' + esc(tableChipValue(stack)) + '</span> <span class="seat-number">' + esc(tableChipUnit()) + '</span>';
      var stackHtml = "";
      if (isMe) {
        var nextChipDisplay = tableUsesBigBlinds() ? "chips" : "big blinds";
        var stackLabel = "Your stack: " + tableChips(stack) + ". Activate to display all table chip amounts in " + nextChipDisplay + ".";
        stackHtml = '<button class="seat-stack" type="button" data-chip-display-toggle aria-pressed="' +
          String(tableUsesBigBlinds()) + '" aria-label="' + esc(stackLabel) + '">' + stackContents + '</button>';
      } else if (!compactRunoutSeat) {
        stackHtml = '<div class="seat-stack">' + stackContents + '</div>';
      }
      var cardHtml = "";
      if (cards.length) {
        cardHtml = '<div class="seat-cards' + (exposed ? ' is-exposed' : ' is-viewer-cards') + '">' + cards.map(function (card) { return playingCardHTML(card, true); }).join("") + '</div>';
      } else if (currentHand && !folded && (stack > 0 || allIn)) {
        cardHtml = '<div class="seat-cards">' + hiddenCardHTML(true, false) + hiddenCardHTML(true, false) + '</div>';
      }

      var tags = (bot ? '<span class="seat-label bot-label">TEST BOT</span>' : '') +
        (sittingOut ? '<span class="seat-label sit-out-label">SITTING OUT</span>' : '');
      var tagsMarkup = tags ? '<div class="seat-tags">' + tags + '</div>' : '';
      var seatName = String(seat.name || (bot ? "Test bot" : "Player"));
      html += '<div ' + (isMe ? 'id="hero-seat" ' : '') + 'class="' + classes + '" aria-label="Seat ' + esc(i + 1) + ', ' + esc(seatName) + '" data-seat-no="' + esc(seatNo) + '" data-player-id="' + esc(id) + '" data-relative-seat="' + relativeIndex + '" data-is-bot="' + (bot ? 'true' : 'false') + '">' +
        '<div class="seat-top"><span class="seat-name-wrap"><span class="seat-name">' + esc(seatName) + '</span></span></div>' +
        tagsMarkup +
        stackHtml +
        '<div class="seat-detail"><span>' + esc(label) + '</span></div>' +
        (isMe ? equityHtml + cardHtml : cardHtml + equityHtml) +
      '</div>';
      if (dealer) html += '<span class="dealer-marker" data-marker-seat="' + esc(seatNo) + '" aria-label="Dealer button">D</span>';
      if (actionState) {
        var turnClockMarkup = acting && state.seatTurnClockKey
          ? '<span class="seat-turn-clock" data-turn-clock-seat="' + esc(seatNo) + '" aria-label="Time left">' + esc(turnClockLabel()) + '</span>'
          : '';
        html += '<span class="seat-action kind-' + esc(actionState.kind || "action") + '" data-action-seat="' + esc(seatNo) + '" aria-label="' + esc((seat.name || "Player") + ": " + actionState.label) + '"><span class="seat-action-full">' + esc(actionState.label) + '</span><span class="seat-action-short">' + esc(actionState.compactLabel || actionState.label) + '</span>' + turnClockMarkup + '</span>';
      }
      var wager = number(fx.displayWagers[seatNo], 0);
      if (!fx.eventAware && !wager) wager = number(seat.bet != null ? seat.bet : seat.street_bet, 0);
      if (wager > 0) {
        html += '<span class="seat-wager" data-seat-no="' + esc(seatNo) + '" aria-label="Street wager ' + esc(tableChips(wager)) + '"><span class="wager-stack" aria-hidden="true"><i></i><i></i><i></i></span><strong>' + esc(tableChips(wager)) + '</strong></span>';
      } else if (number(pendingWagers[seatNo], 0) > 0) {
        html += '<span class="seat-wager is-reserved" data-seat-no="' + esc(seatNo) + '" aria-hidden="true"><span class="wager-stack"><i></i><i></i><i></i></span><strong>' + esc(tableChips(pendingWagers[seatNo])) + '</strong></span>';
      }
    }

    var grid = byId("seat-grid");
    var felt = byId("felt");
    var restoreChipToggleFocus = Boolean(document.activeElement && document.activeElement.matches &&
      document.activeElement.matches("[data-chip-display-toggle]"));
    grid.innerHTML = html;
    if (restoreChipToggleFocus) {
      var replacementToggle = grid.querySelector("[data-chip-display-toggle]");
      if (replacementToggle) replacementToggle.focus({ preventScroll: true });
    }
    var compact = window.innerWidth <= 820 || grid.clientWidth < 500;
    var gridRect = grid.getBoundingClientRect();
    felt.classList.toggle("exposed-ring", positionCount >= 5 && Boolean((view.runout_odds || []).length));
    felt.dataset.compactLayout = compact ? "true" : "false";
    felt.classList.toggle("is-crowded", positionCount >= 7);
    felt.classList.toggle("is-playing", currentHand || view.status === "completed");
    felt.dataset.seatCount = String(positionCount);
    grid.querySelectorAll(".seat-card").forEach(function (node) {
      var relativeIndex = number(node.getAttribute("data-relative-seat"), 0);
      if (node.classList.contains("is-me")) {
        // The hero seat is anchored by CSS at six o’clock; collision fitting may not move it.
        node.style.removeProperty("left");
        node.style.removeProperty("top");
        return;
      }
      var angle = Math.PI / 2 + relativeIndex * Math.PI * 2 / positionCount;
      var x = 50 + 43 * Math.cos(angle);
      var y = 50 + 36 * Math.sin(angle);
      var halfWidth = node.offsetWidth / 2;
      var insetPercent = gridRect.width ? halfWidth / gridRect.width * 100 : 0;
      x = Math.max(insetPercent + 1, Math.min(99 - insetPercent, x));
      var halfHeightPercent = grid.clientHeight ? (node.offsetHeight / 2) / grid.clientHeight * 100 : 0;
      y = Math.max(halfHeightPercent + 1, Math.min(98 - halfHeightPercent, y));
      node.style.left = x.toFixed(2) + "%";
      node.style.top = y.toFixed(2) + "%";
    });
    var blockers = [];
    if ((currentHand || view.status === "completed" || view.status === "lobby") && window.SitNgoLayout && gridRect.width && gridRect.height) {
      var avoid = ["board-cards", "board-caption", "pot-display", "street-label", "blind-strip"].map(function (id) {
        return boxForNode(byId(id), gridRect);
      }).filter(Boolean).concat(blockers);
      var nodes = Array.from(grid.querySelectorAll(".seat-card"));
      var seatsToFit = nodes.map(function (node,i) {
        var b = boxForNode(node, gridRect);
        return {id:i,x:(b.left+b.right)/2,y:(b.top+b.bottom)/2,
          width:b.right-b.left,height:b.bottom-b.top,hero:node.classList.contains("is-me")};
      });
      var fitted = window.SitNgoLayout.fit({width:gridRect.width,height:gridRect.height,seats:seatsToFit,blockers:avoid});
      fitted.forEach(function (p,i) {
        if (nodes[i].classList.contains("is-me")) return;
        nodes[i].style.left = (p.x/gridRect.width*100).toFixed(3) + "%";
        nodes[i].style.top = (p.y/gridRect.height*100).toFixed(3) + "%";
      });
    }
    grid.querySelectorAll(".seat-card").forEach(function (node) {
      var box = boxForNode(node, gridRect);
      if (box) blockers.push(box);
    });
    ["board-caption", "board-cards", "pot-display", "street-label", "blind-strip"].forEach(function (id) {
      var box = boxForNode(byId(id), gridRect);
      if (box) blockers.push(box);
    });
    grid.querySelectorAll(".seat-equity").forEach(function (node) {
      var box = boxForNode(node, gridRect);
      if (box) blockers.push(box);
    });

    var seatNodeFor = function (seatNo) {
      return grid.querySelector('.seat-card[data-seat-no="' + seatNo + '"]');
    };
    var seatActionNodes = Array.prototype.slice.call(grid.querySelectorAll(".seat-action"));
    function placeActionBadge(node) {
      var seatNo = String(node.getAttribute("data-action-seat"));
      var spot = findBadgeSpot(node, seatNodeFor(seatNo), gridRect, blockers);
      if (!spot) {
        node.classList.add("is-unplaced");
        return false;
      }
      addLayerPoint(node, gridRect, spot.x, spot.y);
      blockers.push(spot.box);
      return true;
    }
    seatActionNodes.filter(function (node) { return node.classList.contains("kind-turn"); }).forEach(placeActionBadge);

    grid.querySelectorAll(".dealer-marker").forEach(function (node) {
      var seatNo = String(node.getAttribute("data-marker-seat"));
      var spot = findBadgeSpot(node, seatNodeFor(seatNo), gridRect, blockers);
      if (!spot) {
        node.classList.add("is-unplaced");
        return;
      }
      addLayerPoint(node, gridRect, spot.x, spot.y);
      blockers.push(spot.box);
    });

    fx.wagerPositions = {};
    Array.prototype.slice.call(grid.querySelectorAll(".seat-wager")).sort(function (a, b) {
      return number(a.getAttribute("data-seat-no"), 0) - number(b.getAttribute("data-seat-no"), 0);
    }).forEach(function (node) {
      var seatNo = String(node.getAttribute("data-seat-no"));
      var spot = findBadgeSpot(node, seatNodeFor(seatNo), gridRect, blockers);
      if (!spot) {
        node.classList.add("is-unplaced");
        return;
      }
      addLayerPoint(node, gridRect, spot.x, spot.y);
      fx.wagerPositions[seatNo] = { x: gridRect.left + spot.x, y: gridRect.top + spot.y };
      blockers.push(spot.box);
    });

    seatActionNodes.filter(function (node) { return !node.classList.contains("kind-turn"); })
      .sort(function (a, b) {
        return Number(b.classList.contains("kind-turn")) - Number(a.classList.contains("kind-turn"));
      }).forEach(placeActionBadge);
  }

  function renderBoard(view) {
    var cards = cardArray(view.board);
    if (!cards.length && view.hand && Array.isArray(view.hand.board)) cards = view.hand.board;
    var inProgress = view.status === "playing";
    var showBoard = inProgress || cards.length > 0;
    byId("board-caption").textContent = showBoard ? "COMMUNITY CARDS" : "TABLE";
    var slots = [];
    if (inProgress) {
      for (var i = 0; i < 5; i += 1) {
        slots.push(playingCardHTML(cards[i] || null, false));
      }
    } else {
      slots = cards.map(function (card) { return playingCardHTML(card, false); });
    }
    byId("board-cards").innerHTML = slots.join("");

    var pot = number(view.pot, view.hand && view.hand.pot);
    byId("pot-amount").textContent = tableChips(pot);
    byId("pot-label").textContent = "Pot";
    byId("pot-display").hidden = !(inProgress && pot > 0);
    byId("street-label").textContent = view.street && view.street !== "lobby" ? String(view.street).replace(/_/g, " ").toUpperCase() : "";
  }

  function renderBlindStrip(view) {
    var b = blindParts(view);
    var remaining = clockRemaining(b, view);
    var street = String(view.street || "").toLowerCase();
    announceBlindLevel(view.blind_announcement, view);
    var blindUnit = tableChipUnit(view);
    var blindsLabel = tableChipValue(b.small, view) + " / " + tableChipValue(b.big, view) + " " + blindUnit;
    var handBlinds = view.status === "playing" && street !== "showdown" &&
      view.hand_blinds && typeof view.hand_blinds === "object"
      ? view.hand_blinds
      : null;
    if (handBlinds) {
      var handSmall = number(handBlinds.small, b.small);
      var handBig = number(handBlinds.big, b.big);
      blindsLabel = tableChipValue(handSmall, view) + " / " + tableChipValue(handBig, view) + " " + blindUnit;
    }
    var levelNote = view.paused ? "Paused" : (b.pending ? "Next hand" : (remaining >= 0 ? "Next in " + formatClock(remaining) : "Countdown unavailable"));
    var entries = [
      { label: "Level", value: String(b.level), note: levelNote },
      { label: "Blinds", value: blindsLabel, note: tableUsesBigBlinds(view) ? "Small / big · BB" : "Small / big" }
    ];
    byId("blind-strip").innerHTML = entries.map(function (entry) {
      return '<div class="blind-tile"><span>' + esc(entry.label) + '</span><strong>' + esc(entry.value) + '</strong><em>' + esc(entry.note) + '</em></div>';
    }).join("");
  }

  function renderLog(view) {
    var rows = Array.isArray(view.action_log) ? view.action_log.slice(-12).reverse() : [];
    if (!rows.length) {
      byId("action-log").innerHTML = '<div class="log-empty">The table is quiet. The first hand will show here.</div>';
      return;
    }
    byId("action-log").innerHTML = rows.map(function (row) {
      var message = typeof row === "string" ? row : (row.text || row.message || row.action || "");
      var time = typeof row === "object" ? (row.time || row.created_at || row.at || "") : "";
      var displayTime = "";
      if (time) {
        var stamp = typeof time === "number" ? time : Date.parse(time);
        if (Number.isFinite(stamp)) {
          if (stamp < 100000000000) stamp *= 1000;
          displayTime = new Date(stamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        }
      }
      return '<div class="log-row"><span class="log-time">' + esc(displayTime) + '</span><span>' + esc(message) + '</span></div>';
    }).join("");
  }

  function renderResults(view) {
    var panel = byId("results-panel");
    var reopen = byId("reopen-results-button");
    var results = Array.isArray(view.standings) && view.standings.length
      ? view.standings.slice()
      : (Array.isArray(view.results) ? view.results.slice() : []);
    if (view.status !== "completed" || !results.length || announcementRemainingMs(view, view.elimination_announcement) > 0) {
      panel.hidden = true;
      reopen.hidden = true;
      reopen.setAttribute("aria-expanded", "false");
      byId("results-list").innerHTML = "";
      return;
    }

    var fx = state.tableFx;
    var effectsPending = Boolean(fx.running || (fx.queue || []).length);
    var tableId = String(state.activeTableId || view.id || "");
    var dismissed = state.standingsDismissedFor === tableId;
    var showPanel = !effectsPending && !dismissed;
    panel.hidden = !showPanel;
    reopen.hidden = effectsPending || showPanel;
    reopen.setAttribute("aria-expanded", String(showPanel));
    results.sort(function (a, b) {
      return number(a && (a.place != null ? a.place : a.rank), 0) -
        number(b && (b.place != null ? b.place : b.rank), 0);
    });
    var placeCounts = Object.create(null);
    results.forEach(function (row, index) {
      var place = number(row && (row.place != null ? row.place : row.rank), index + 1);
      placeCounts[place] = number(placeCounts[place], 0) + 1;
    });
    var champions = results.filter(function (row, index) {
      return number(row && (row.place != null ? row.place : row.rank), index + 1) === 1;
    });
    var title = byId("results-title");
    if (champions.length > 1) {
      title.textContent = "Tied at 1st place";
    } else {
      var championName = champions.length ? (champions[0].name || champions[0].player_name || "The winner") : "Tournament";
      title.textContent = championName + " wins";
    }
    var pool = results.reduce(function (sum,row) {return sum + number(row.award_cents,0);}, 0);
    byId("results-description").textContent = results.some(function(row) {return row.award_cents != null;}) ? credits(pool) + " play credits awarded · Buy-in " + credits(view.config.buy_in * 100) + " · " + view.config.payout_percentages.join(" / ") + "%" : "Final standings for this freezeout.";
    byId("results-list").innerHTML = results.map(function (row, index) {
      var place = number(row.place != null ? row.place : row.rank, index + 1);
      var suffix = place % 100 >= 11 && place % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[place % 10] || "th");
      var placeLabel = (placeCounts[place] > 1 ? "T-" : "") + place + suffix;
      var placeAria = (placeCounts[place] > 1 ? "Tied for " : "") + place + suffix + " place";
      var name = row.name || row.player_name || "Player";
      var rowStatus = String(row.status || "").toLowerCase();
      var detail = row.detail || (place === 1 ? "Tournament winner" : (row.eliminated_at || rowStatus === "eliminated" ? "Eliminated" : (row.status || "Final result")));
      var awardRecorded = row.award_cents != null;
      var awardLabel = awardRecorded ? credits(row.award_cents) + " credits" : "Not recorded";
      return '<div class="result-row" role="listitem"><span class="result-place ' + (place === 1 ? "first" : "") + '" aria-label="' + esc(placeAria) + '">' + placeLabel + '</span>' +
        '<span><span class="result-name">' + esc(name) + '</span><span class="result-detail">' + esc(detail) + '</span></span>' +
        '<span class="result-award ' + (awardRecorded ? "is-recorded" : "is-unrecorded") + '" aria-label="Award: ' + esc(awardLabel) + '">' + esc(awardLabel) + '</span></div>';
    }).join("");
  }
  function actionTokenKey(view) {
    return [state.activeTableId, number(view.hand_no, 0), number(view.turn_version, 0)].join(":");
  }

  function viewerSeat(view) {
    var viewer = view && view.viewer || {};
    var playerId = String(viewer.player_id || (state.player && state.player.id) || "");
    if (!playerId) return null;
    return (Array.isArray(view && view.seats) ? view.seats : []).find(function (seat) {
      return String(seat.id || seat.player_id || "") === playerId;
    }) || null;
  }

  function viewerCanAct(view) {
    var viewer = view && view.viewer || {};
    var seat = viewerSeat(view);
    var street = String(view && view.street || "").toLowerCase();
    return Boolean(view && view.status === "playing" && !view.paused && street !== "showdown" &&
      viewer.can_act && seat && !seat.folded && !seat.is_folded &&
      !seat.all_in && !seat.is_all_in && number(seat.stack, 0) > 0);
  }

  function actionIntentIsCurrent(intent) {
    var view = state.tableView;
    return Boolean(intent && String(state.activeTableId) === intent.tableId && view &&
      viewerCanAct(view) &&
      number(view.hand_no, 0) === intent.payload.expected_hand &&
      number(view.turn_version, 0) === intent.payload.expected_turn_version);
  }

  function playerPrefsStorageKey() {
    var playerId = String(state.player && state.player.id || "");
    return playerId ? PLAYER_PREFS_STORAGE_PREFIX + encodeURIComponent(playerId) : "";
  }

  function validStoredPresetArray(value, min, max) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 5) return null;
    var result = [];
    for (var i = 0; i < value.length; i += 1) {
      var amount = Number(value[i]);
      if (!Number.isFinite(amount) || amount < min || amount > max || (i && amount <= result[i - 1])) return null;
      result.push(amount);
    }
    return result;
  }

  function playerBetPreferences() {
    var key = playerPrefsStorageKey();
    if (!key) return { preflop_bb: DEFAULT_PLAYER_PREFS.preflop_bb.slice(), postflop_percent: DEFAULT_PLAYER_PREFS.postflop_percent.slice() };
    try {
      var saved = JSON.parse(window.localStorage.getItem(key) || "{}");
      return {
        preflop_bb: validStoredPresetArray(saved.preflop_bb, 1, 200) || DEFAULT_PLAYER_PREFS.preflop_bb.slice(),
        postflop_percent: validStoredPresetArray(saved.postflop_percent, 1, 1000) || DEFAULT_PLAYER_PREFS.postflop_percent.slice()
      };
    } catch (err) {
      return { preflop_bb: DEFAULT_PLAYER_PREFS.preflop_bb.slice(), postflop_percent: DEFAULT_PLAYER_PREFS.postflop_percent.slice() };
    }
  }

  function parsePlayerPresetInput(id, min, max) {
    var parts = String(byId(id).value || "").trim().split(",").map(function (part) { return part.trim(); });
    if (parts.length < 1 || parts.length > 5 || parts.some(function (part) { return !/^\d+(?:\.\d{1,2})?$/.test(part); })) {
      throw Error("Enter 1 to 5 increasing values separated by commas.");
    }
    var values = parts.map(Number);
    if (values.some(function (value, index) {
      return !Number.isFinite(value) || value < min || value > max || (index > 0 && value <= values[index - 1]);
    })) throw Error("Preset values must increase from " + min + " to " + max + ".");
    return values;
  }

  function openPlayerPreferences() {
    var dialog = byId("player-settings-dialog");
    if (!dialog || !state.player) return;
    var prefs = playerBetPreferences();
    byId("prefs-preflop-bb").value = prefs.preflop_bb.join(", ");
    byId("prefs-postflop-percent").value = prefs.postflop_percent.join(", ");
    byId("player-prefs-error").hidden = true;
    byId("player-prefs-error").textContent = "";
    byId("player-settings-button").setAttribute("aria-expanded", "true");
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function closePlayerPreferences() {
    var dialog = byId("player-settings-dialog");
    if (dialog && dialog.open) dialog.close();
    else if (dialog) dialog.removeAttribute("open");
    var button = byId("player-settings-button");
    if (button) button.setAttribute("aria-expanded", "false");
  }

  function ensureActionControls() {
    var controls = byId("action-controls");
    if (!controls || controls.dataset.initialized === "true") return;
    controls.innerHTML =
      '<div class="action-buttons" role="group" aria-label="Poker actions">' +
        '<button class="button button-quiet" type="button" data-poker-action="fold">Fold</button>' +
        '<button class="button button-outline call-button" type="button" data-poker-action="check">Check</button>' +
        '<button class="button button-primary" type="button" data-poker-action="raise_to">Bet</button>' +
      '</div>' +
      '<div class="raise-control" role="group" aria-labelledby="raise-label">' +
        '<label id="raise-label" for="raise-amount">Bet or raise amount</label>' +
        '<div class="raise-presets" role="group" aria-label="Bet size presets">' +
          '<button class="button button-quiet raise-preset" type="button" data-raise-preset="true">½ pot</button>' +
          '<button class="button button-quiet raise-preset" type="button" data-raise-preset="true">¾ pot</button>' +
          '<button class="button button-quiet raise-preset" type="button" data-raise-preset="true">Pot</button>' +
        '</div>' +
        '<input id="raise-amount" type="range" min="0" max="0" step="1" value="0" aria-describedby="raise-range">' +
        '<span class="raise-range" id="raise-range"></span>' +
      '</div>';
    controls.dataset.initialized = "true";
  }

  function updateRaisePreview() {
    var input = byId("raise-amount");
    var view = state.tableView;
    if (!input || !view) return;
    var target = Number(input.value);
    var min = number(input.min, 0);
    var max = number(input.max, 0);
    var viewer = view.viewer || {};
    var seat = viewerSeat(view);
    var stack = number(seat && seat.stack, 0);
    var ownBet = number(seat && seat.bet, 0);
    var currentBet = number(view.current_bet, 0);
    var actionName = currentBet > 0 ? "Raise" : "Bet";
    var valid = Number.isInteger(target) && target >= min && target <= max;
    var button = byId("action-controls").querySelector('[data-poker-action="raise_to"]');
    var actionAllowed = viewerCanAct(view) && viewer.raise_rights !== false && stack > 0 &&
      max > currentBet && min <= max;
    input.setAttribute("aria-valuetext", valid
      ? actionName + " to " + actionChips(target) + " total; adds " + actionChips(Math.max(0, target - ownBet))
      : "Choose an amount from " + actionChips(min) + " to " + actionChips(max));
    if (button) {
      var label = valid ? actionName + " to " + actionChips(target) : actionName;
      button.textContent = label;
      button.setAttribute("aria-label", label);
      button.disabled = Boolean(state.actionPending || state.actionSubmittedKey === actionTokenKey(view) ||
        !actionAllowed || !valid);
    }
    byId("action-controls").querySelectorAll("[data-raise-preset]").forEach(function (preset) {
      preset.setAttribute("aria-pressed", String(number(preset.getAttribute("data-target"), -1) === target));
      preset.disabled = Boolean(state.actionPending || state.actionSubmittedKey === actionTokenKey(view) || !actionAllowed);
    });
  }

  function renderActions(view) {
    var panel = byId("action-panel");
    var controls = byId("action-controls");
    if (!panel || !controls) return;
    ensureActionControls();

    var viewer = view.viewer || {};
    var seat = viewerSeat(view);
    var playing = view.status === "playing";
    var seated = Boolean(seat);
    var panelVisible = playing && seated;
    var canAct = viewerCanAct(view);
    var currentKey = actionTokenKey(view);
    if (state.actionSubmittedKey && state.actionSubmittedKey !== currentKey) state.actionSubmittedKey = "";
    if (state.actionPending && state.actionPending.tableId !== String(state.activeTableId)) state.actionPending = null;

    if (state.actionPending && state.actionPending.accepted && !actionIntentIsCurrent(state.actionPending)) {
      state.actionPending = null;
    }
    panel.hidden = !panelVisible;
    panel.setAttribute("aria-busy", String(Boolean(state.actionPending || state.actionSubmittedKey === currentKey)));
    if (!playing || !panelVisible) return;

    var stack = number(seat && seat.stack, 0);
    var ownBet = number(seat && seat.bet, 0);
    var toCall = Math.max(0, number(viewer.to_call, 0));
    var callAmount = Math.min(stack, toCall);
    var currentBet = number(view.current_bet, 0);
    var maxRaise = viewer.max_raise_to == null ? ownBet + stack : number(viewer.max_raise_to, ownBet + stack);
    var minRaise = viewer.min_raise_to == null
      ? currentBet + Math.max(1, number(view.min_raise, 1))
      : number(viewer.min_raise_to, currentBet + Math.max(1, number(view.min_raise, 1)));
    var rangeMax = Math.max(0, Math.floor(maxRaise));
    var shortAllInRaise = minRaise > maxRaise;
    var rangeMin = shortAllInRaise ? rangeMax : Math.max(currentBet + 1, Math.floor(minRaise));
    if (rangeMin > rangeMax) rangeMin = rangeMax;
    var raiseAllowed = canAct && viewer.raise_rights !== false && stack > 0 &&
      maxRaise > currentBet && rangeMax >= currentBet + 1;
    var draftKey = actionTokenKey(view);
    if (state.raiseDraftKey !== draftKey) {
      state.raiseDraftKey = draftKey;
      state.raiseDraftValue = null;
    }

    var street = String(view.street || "").toLowerCase();
    var preflop = street ? street === "preflop" : cardArray(view.board).length === 0;
    var bigBlind = Math.max(1, number(blindParts(view).big, number(view.config && view.config.big_blind, 1)));
    var potAfterCall = Math.max(0, number(view.pot, 0) + callAmount);
    var playerPrefs = playerBetPreferences();
    var presetSpecs = preflop
      ? playerPrefs.preflop_bb.map(function (bb) {
        return { label: Number.isInteger(bb) ? bb.toFixed(1) + " BB" : String(bb) + " BB", bb: bb };
      })
      : playerPrefs.postflop_percent.map(function (fraction) {
        var label = fraction === 50 ? "½ pot" : (fraction === 75 ? "¾ pot" : (fraction === 100 ? "Pot" : String(fraction) + "% pot"));
        return { label: label, fraction: fraction / 100 };
      });
    presetSpecs = presetSpecs.map(function (preset) {
      var rawTarget = preflop
        ? Math.round(bigBlind * preset.bb)
        : currentBet + Math.round(potAfterCall * preset.fraction);
      var target = Math.max(rangeMin, Math.min(rangeMax, rawTarget));
      var adjusted = target !== rawTarget;
      return {
        label: preset.label,
        target: target,
        ariaLabel: "Set raise-to amount to " + actionChips(target) + " with the " + preset.label + " preset" +
          (preflop ? "" : " after calling") + (adjusted ? "; adjusted to the legal range" : "")
      };
    });
    var presetGroup = controls.querySelector(".raise-presets");
    while (presetGroup.children.length < presetSpecs.length) {
      var presetButton = document.createElement("button");
      presetButton.type = "button";
      presetButton.className = "button button-quiet raise-preset";
      presetButton.setAttribute("data-raise-preset", "true");
      presetGroup.appendChild(presetButton);
    }
    while (presetGroup.children.length > presetSpecs.length) presetGroup.lastElementChild.remove();

    var suggested = Math.min(rangeMax, Math.max(rangeMin, number(viewer.suggested_raise_to, rangeMin)));
    if (!Number.isInteger(suggested)) suggested = Math.round(suggested);
    var draft = state.raiseDraftValue === null ? suggested : Number(state.raiseDraftValue);
    if (!Number.isInteger(draft) || draft < rangeMin || draft > rangeMax) draft = suggested;
    if (state.raiseDraftValue !== null && String(draft) !== state.raiseDraftValue) state.raiseDraftValue = String(draft);

    var callButton = controls.querySelector('[data-poker-action="check"], [data-poker-action="call"]');
    var foldButton = controls.querySelector('[data-poker-action="fold"]');
    var raiseButton = controls.querySelector('[data-poker-action="raise_to"]');
    var input = byId("raise-amount");
    var blocked = Boolean(state.actionPending || state.actionSubmittedKey === currentKey);
    if (foldButton) foldButton.disabled = blocked || !canAct || toCall <= 0;
    if (callButton) {
      callButton.setAttribute("data-poker-action", toCall > 0 ? "call" : "check");
      callButton.textContent = toCall > 0 ? "Call " + actionChips(callAmount) : "Check";
      callButton.setAttribute("aria-label", toCall > 0 ? "Call " + actionChips(callAmount) : "Check");
      callButton.disabled = blocked || !canAct;
    }

    input.min = String(rangeMin);
    input.max = String(rangeMax);
    if (document.activeElement !== input || Number(input.value) < rangeMin || Number(input.value) > rangeMax) {
      input.value = String(draft);
    }
    input.disabled = blocked || !raiseAllowed;
    input.setAttribute("aria-valuetext", "Bet or raise to " + actionChips(draft));
    if (raiseButton) raiseButton.textContent = (currentBet > 0 ? "Raise" : "Bet") + " to " + actionChips(draft);

    controls.querySelectorAll("[data-raise-preset]").forEach(function (preset, index) {
      var spec = presetSpecs[index];
      if (!spec) return;
      preset.textContent = spec.label;
      preset.setAttribute("data-target", String(spec.target));
      preset.setAttribute("aria-label", spec.ariaLabel);
      preset.setAttribute("title", spec.ariaLabel);
      preset.setAttribute("aria-pressed", String(spec.target === draft));
      preset.disabled = blocked || !raiseAllowed;
    });

    var rangeText = shortAllInRaise
      ? "Short all-in · max " + actionChips(rangeMax)
      : "Min " + actionChips(rangeMin) + "–" + actionChips(rangeMax);
    byId("raise-range").textContent = rangeText;
    byId("raise-label").textContent = (currentBet > 0 ? "Raise" : "Bet") + " amount";
    if (raiseButton) {
      raiseButton.setAttribute("aria-label", (currentBet > 0 ? "Raise" : "Bet") + " to " + actionChips(draft));
      raiseButton.disabled = blocked || !raiseAllowed || draft < rangeMin || draft > rangeMax;
    }
    updateRaisePreview();
  }

  function renderLobbyControls(view, host, ownSeat, isSeated, layout) {
    var panel = byId("lobby-seat-panel");
    var controls = byId("seat-controls");
    var standButton = byId("stand-button");
    var statusTitle = byId("seat-status-title");
    var statusDescription = byId("seat-status-description");
    var visible = view.status === "lobby" && isSeated;
    panel.hidden = !visible;
    if (!visible) return;

    var viewer = view.viewer || {};
    if (isSeated) {
      statusTitle.textContent = host ? "You’re seated and hosting." : "You’re seated at the table.";
      statusDescription.textContent = host ? "Add test bots from an open felt seat, or stand up to watch." : "Stand up any time to watch without a seat.";
    }

    standButton.hidden = !isSeated;
    var rows = [];
    for (var i = 0; i < layout.max; i += 1) {
      var occupant = layout.bySeat[i];
      var actions = "";
      if (host && occupant && isBotSeat(occupant)) {
        actions += '<button class="button button-quiet button-small" type="button" id="remove-bot-' + i + '" data-remove-bot-seat="' + i + '">Remove bot</button>';
      }
      if (!actions) continue;
      var label = occupant && isBotSeat(occupant) ? (occupant.name || "Test bot") : (occupant ? occupant.name || "Occupied" : "Open");
      rows.push('<div class="seat-choice' + (occupant ? ' has-bot' : '') + '"><span class="seat-choice-label">' + esc(label) + '</span><span class="seat-choice-actions">' + actions + '</span></div>');
    }
    controls.innerHTML = rows.length ? rows.join("") : '<p class="seat-controls-empty">' + (host ? "Add bots from the open seats on the table." : "Your seat is ready.") + '</p>';
  }

  function loadSettingsForm(view) {
    var config = view.config || {};
    byId("settings-buy-in").value = String(config.buy_in == null ? 10 : config.buy_in);
    byId("settings-payout").value = (config.payout_percentages || [60,25,15]).join(", ");
    byId("settings-table-name").value = view.name || "";
    byId("settings-max-seats").value = String(number(config.max_seats, number(view.max_seats, 6)));
    byId("settings-starting-stack").value = String(number(config.starting_stack, number(view.starting_stack, 1000)));
    byId("settings-small-blind").value = String(number(config.small_blind, number(view.small_blind, 10)));
    byId("settings-big-blind").value = String(number(config.big_blind, number(view.big_blind, 20)));
    byId("settings-level-minutes").value = String(number(config.level_minutes, number(view.level_minutes, 5)));
    byId("settings-turn-seconds").value = String(number(config.turn_seconds, 30));
    byId("settings-runout-seconds").value = String(number(config.runout_seconds, 2.5));
    byId("settings-blind-announcement-seconds").value = String(number(config.blind_announcement_seconds, 5));
    byId("settings-elimination-announcement-seconds").value = String(number(config.elimination_announcement_seconds, 5));
  }

  function renderSettingsPanel(view, host) {
    var panel = byId("table-settings-form");
    var lobby = view.status === "lobby";
    var inGame = view.status === "playing";
    var settingsButton = byId("runtime-settings-button");
    if (settingsButton) {
      settingsButton.hidden = !(host && inGame);
      settingsButton.setAttribute("aria-expanded", String(Boolean(host && inGame && state.runtimeSettingsOpen)));
      if (!host || !inGame) state.runtimeSettingsOpen = false;
    }
    var visible = host && (lobby || (inGame && state.runtimeSettingsOpen));
    panel.hidden = !visible;
    if (!host || !(lobby || inGame)) return;

    var tableId = String(view.id || state.activeTableId || "");
    if (state.settingsTableId !== tableId) {
      state.settingsTableId = tableId;
      state.settingsDirty = false;
      loadSettingsForm(view);
    } else if (!state.settingsDirty) {
      loadSettingsForm(view);
    }

    panel.dataset.mode = inGame ? "runtime" : "lobby";
    byId("table-settings-title").textContent = inGame ? "Game timing" : "Before you deal";
    panel.querySelectorAll("[data-lobby-only]").forEach(function (field) {
      field.hidden = inGame;
      field.querySelectorAll("input, select").forEach(function (input) {
        input.disabled = inGame || state.settingsSaving;
      });
    });
    panel.querySelectorAll("[data-runtime-only]").forEach(function (field) {
      field.hidden = false;
      field.querySelectorAll("input, select").forEach(function (input) {
        input.disabled = state.settingsSaving || (inGame && !view.paused);
      });
    });
    byId("save-settings-button").disabled = state.settingsSaving || !state.settingsDirty || (inGame && !view.paused);
    var note = lobby
      ? (state.settingsSaving ? "Saving table settings…" : (state.settingsDirty ? "Save changes before starting the freezeout." : "You can adjust this lobby until the first hand starts."))
      : (state.settingsSaving ? "Saving game settings…" : (view.paused
        ? (state.settingsDirty ? "Save timing changes before resuming." : "Adjust timing, then resume when ready.")
        : "Pause the game before changing timing settings."));
    byId("settings-lock-note").textContent = note;
  }
  function updateHostReadiness(view, host) {
    var hostPanel = byId("host-panel");
    var visible = host && view.status === "lobby";
    hostPanel.hidden = !visible;
    if (!visible) return;

    var count = Array.isArray(view.seats) ? view.seats.length : 0;
    var startButton = byId("start-button");
    startButton.disabled = count < 2 || state.settingsDirty || state.settingsSaving;
    if (count < 2) {
      byId("host-hint").textContent = "Add or invite one more player before dealing.";
    } else if (state.settingsDirty || state.settingsSaving) {
      byId("host-hint").textContent = "Save your settings before dealing.";
    } else {
      byId("host-hint").textContent = "Everyone is seated. Start the freezeout when you’re ready.";
    }
  }

  function renderPauseControls(view, host) {
    var button = byId("pause-button");
    var banner = byId("paused-banner");
    var playing = Boolean(view && view.status === "playing");
    if (button) {
      button.hidden = !(host && playing);
      button.disabled = state.pausePending;
      button.textContent = view && view.paused ? "Resume game" : "Pause game";
      button.setAttribute("aria-pressed", String(Boolean(view && view.paused)));
      button.setAttribute("aria-busy", String(state.pausePending));
    }
    if (!banner) return;
    var paused = Boolean(view && view.paused && playing);
    banner.hidden = !paused;
    banner.dataset.paused = String(paused);
    if (paused) {
      var started = epochMilliseconds(view.paused_at);
      var now = epochMilliseconds(view.server_now) || Date.now();
      var elapsed = started ? Math.max(0, Math.floor((now - started) / 1000)) : 0;
      banner.textContent = "Game paused by host" + (started ? " · Paused for " + formatClock(elapsed) : "") + ".";
    } else {
      banner.textContent = "";
    }
  }

  function renderTableAnnouncements(view) {
    announceEliminations(view);
  }

  function renderTable() {
    var view = state.tableView;
    var hasTable = Boolean(view);
    byId("empty-state").hidden = hasTable;
    byId("table-view").hidden = !hasTable;
    byId("app-panel").classList.toggle("has-active-table", hasTable);
    if (!view) {
      clearChat();
      state.sitOutRequestId += 1;
      state.sitOutPending = false;
      renderSitOutButton(null, null);
      syncLastHandButton();
      state.actionSubmittedKey = "";
      byId("results-panel").hidden = true;
      byId("reopen-results-button").hidden = true;
      clearSeatTurnClock();
      document.body.classList.remove("gameplay-active");
      clearBlindAnnouncement(true);
      clearEliminationAnnouncement();
      byId("pause-button").hidden = true;
      byId("runtime-settings-button").hidden = true;
      byId("paused-banner").hidden = true;
      byId("announcement-banner").hidden = true;
      closeRecentActionDialog();
      byId("lobby-seat-panel").hidden = true;
      byId("host-panel").hidden = true;
      byId("table-settings-form").hidden = true;
      return;
    }

    syncLastHandButton();
    consumeTableEvents(view);
    syncSeatTurnClock(view);
    var status = view.status || "lobby";
    document.body.classList.toggle("gameplay-active", status === "playing" || status === "completed");
    var statusNode = byId("view-status");
    statusNode.textContent = view.paused ? "Paused" : statusName(status);
    statusNode.className = "status-pill" + (view.paused ? " paused" : (status === "playing" ? " playing" : (status === "completed" ? " completed" : "")));
    byId("view-table-name").textContent = view.name || "Sit-and-go";
    var layout = seatLayout(view);
    var seats = layout.seats;
    var max = layout.max;
    byId("view-table-subtitle").textContent = seats.length + " of " + max + " seats" + (view.prize_pool_cents == null ? "" : " · " + credits(view.prize_pool_cents) + " play credits in the pool") + (status === "lobby" && view.config ? " · Buy-in " + view.config.buy_in + " · " + view.config.payout_percentages.join(" / ") + "%" : "");
    byId("hand-number").textContent = number(view.hand_no, 0) > 0 ? "HAND " + number(view.hand_no, 0) : "NO HAND DEALT";
    byId("hand-status-label").textContent = view.paused ? "GAME PAUSED" : (status === "playing" ? "HAND IN PROGRESS" : (status === "completed" ? "TOURNAMENT COMPLETE" : "TABLE LOBBY"));
    renderTableAnnouncements(view);
    byId("table-player-count").textContent = seats.length + " seated";
    byId("button-caption").textContent = view.status === "playing" ? "" : "Play chips · No rebuys";

    renderBlindStrip(view);
    renderBoard(view);
    renderActions(view);
    renderSeats(view);
    renderLog(view);
    renderResults(view);
    playTableEffects();

    var viewer = view.viewer || {};
    var playerId = String(viewer.player_id || (state.player && state.player.id) || "");
    var ownSeat = seats.find(function (seat) {
      return String(seat.id || seat.player_id || "") === playerId;
    }) || null;
    var seated = Boolean(viewer.seated || ownSeat);
    var host = String(view.host_id || "") === playerId;
    renderSitOutButton(view, ownSeat);
    ensureChatScope();
    renderChatButton();
    renderPauseControls(view, host);
    renderLobbyControls(view, host, ownSeat, seated, layout);
    renderSettingsPanel(view, host);
    updateHostReadiness(view, host);
  }

  function enterApp(player, csrf, sessionProof) {
    var previousPlayerId = String(state.player && state.player.id || "");
    var nextPlayerId = String(player && player.id || "");
    if (previousPlayerId !== nextPlayerId) {
      closeLastHandDialog(false);
      clearChat();
      state.sitOutRequestId += 1;
      state.sitOutPending = false;
    }
    state.player = player || null;
    if (typeof sessionProof === "string" && sessionProof) state.sessionProof = sessionProof;
    if (typeof csrf === "string" && csrf) state.csrf = csrf;
    persistAuth();
    if (!state.activeTableId) state.activeTableId = hashTableId();
    state.polling = true;
    byId("login-panel").hidden = true;
    byId("app-panel").hidden = false;
    byId("identity").hidden = false;
    byId("welcome-name").textContent = state.player ? state.player.name : "";
    byId("identity-avatar").textContent = state.player && state.player.name ? state.player.name.charAt(0).toUpperCase() : "♠";
    clearNotice();
    renderTables();
    renderTable();
    refreshAll(true);
  }

  async function boot() {
    try {
      var data = await request("/me");
      if (data.authenticated && (data.needs_claim || data.player?.needs_claim) && state.sessionProof && data.csrf) {
        state.csrf = data.csrf;
        byId("login-panel").hidden = false;
        setAuthMode("claim");
      } else if (data.authenticated && state.sessionProof && data.csrf) {
        state.activeTableId = hashTableId();
        enterApp(data.player, data.csrf, state.sessionProof);
      } else if (data.authenticated || state.sessionProof) {
        setLoggedOut("Your session could not be restored. Sign in again.");
      } else {
        setLoggedOut("");
      }
    } catch (err) {
      if (err.status !== 401) showNotice(err.message, "error", true);
      byId("login-panel").hidden = false;
      byId("app-panel").hidden = true;
    }
  }

  function adoptSnapshot(view, tableId) {
    if (!view || view.id !== tableId || state.activeTableId !== tableId) return false;
    if ((state.chat.tableId && state.chat.tableId !== tableId) ||
        (state.chat.playerId && state.chat.playerId !== String(state.player && state.player.id || ""))) clearChat();
    var previous = state.tableView;
    if (previous && String(previous.id || "") !== tableId) {
      state.sitOutRequestId += 1;
      state.sitOutPending = false;
    }
    if (previous && previous.id === tableId) {
      var previousViewer = previous.viewer || {};
      var incomingViewer = view.viewer || {};
      // A poll sent before an action can arrive after its response. Never
      // rewind the board, odds, action controls, private preference, or countdown.
      if (number(view.version, 0) < number(previous.version, 0) ||
          (number(view.version, 0) === number(previous.version, 0) &&
            number(view.server_now, 0) < number(previous.server_now, 0))) return false;
    }
    state.tableView = view;
    return true;
  }

  async function refreshAll(force) {
    if (!state.polling) return;
    if (state.refreshBusy) {
      if (force) state.refreshPending = true;
      return;
    }
    if (state.refreshTimer) {
      window.clearTimeout(state.refreshTimer);
      state.refreshTimer = 0;
    }
    state.refreshBusy = true;
    try {
      if (!state.activeTableId) {
        var result = await request("/tables");
        state.tables = Array.isArray(result.tables) ? result.tables : [];
        if (!state.activeTableId && !state.skipAutoResume) {
          var resume = state.tables.find(function (table) {
            return table.viewer_seated && table.status === "playing";
          }) || state.tables.find(function (table) {
            return table.viewer_seated;
          });
          if (resume) {
            closeLastHandDialog(false);
            state.activeTableId = String(resume.id || "");
            if (state.activeTableId) setHashTable(state.activeTableId);
          }
        }
        renderTables();
      }

      if (state.activeTableId) {
        var selectedTableId = String(state.activeTableId);
        try {
          var detail = await request("/tables/" + encodeURIComponent(selectedTableId));
          if (state.activeTableId !== selectedTableId) return;
          if (adoptSnapshot(detail.table || detail, selectedTableId)) renderTable();
        } catch (err) {
          if (state.activeTableId !== selectedTableId) return;
          if (err.status === 404) {
            clearBlindAnnouncement(true);
            closeRecentActionDialog();
            closeLastHandDialog(false);
            state.activeTableId = "";
            state.tableView = null;
            setHashTable("");
            renderTable();
          } else if (err.status !== 401) {
            showNotice(err.message, "error", false);
          }
        }
      }
    } catch (err) {
      if (err.status !== 401) showNotice(err.message, "error", false);
    } finally {
      state.refreshBusy = false;
      var activeHand = Boolean(state.tableView && state.tableView.status === "playing");
      var visibleDelay = activeHand ? 900 : 2800;
      if (activeHand) {
        var liveView = state.tableView;
        var street = String(liveView.street || "").toLowerCase();
        var dueAt = street === "showdown"
          ? (liveView.next_hand_at || (liveView.hand && liveView.hand.next_hand_at))
          : (liveView.runout_at || (liveView.hand && liveView.hand.runout_at));
        if (dueAt) {
          // Fetch just after the next deal/runout, including the short hand-complete pause.
          var untilDeal = epochMilliseconds(dueAt) - (epochMilliseconds(liveView.server_now) || Date.now());
          visibleDelay = Math.max(40, Math.min(visibleDelay, untilDeal + 35));
        }
      }
      var delay = state.refreshPending ? 0 : (document.hidden ? 8000 : visibleDelay);
      state.refreshPending = false;
      scheduleRefresh(delay);
    }
  }

  async function mutate(path, body, method) {
    return request(path, { method: method || "POST", body: body, mutate: true });
  }

  function payouts(id) {
    var parts = byId(id).value.split(",").map(function (x) {return x.trim();});
    if (parts.length > 9 || parts.some(function (x) {return !/^\d{1,3}$/.test(x);}) || parts.reduce(function (sum,x) {return sum + Number(x);},0) !== 100) {
      throw Error("Enter one to nine whole-number payout percentages totaling 100, separated by commas.");
    }
    return parts.map(Number);
  }
  function credits(cents) {return new Intl.NumberFormat("en-US",{maximumFractionDigits:2}).format(cents/100);}
  function settingsPayload() {
    var view = state.tableView || {};
    var timing = {
      level_minutes: number(byId("settings-level-minutes").value, 0),
      turn_seconds: number(byId("settings-turn-seconds").value, 0),
      runout_seconds: number(byId("settings-runout-seconds").value, 0),
      blind_announcement_seconds: number(byId("settings-blind-announcement-seconds").value, -1),
      elimination_announcement_seconds: number(byId("settings-elimination-announcement-seconds").value, -1)
    };
    if (view.status === "playing") return timing;
    return {
      buy_in: number(byId("settings-buy-in").value, 0),
      payout_percentages: payouts("settings-payout"),
      name: byId("settings-table-name").value.trim(),
      max_seats: number(byId("settings-max-seats").value, 0),
      starting_stack: number(byId("settings-starting-stack").value, 0),
      small_blind: number(byId("settings-small-blind").value, 0),
      big_blind: number(byId("settings-big-blind").value, 0),
      level_minutes: timing.level_minutes,
      turn_seconds: timing.turn_seconds,
      runout_seconds: timing.runout_seconds,
      blind_announcement_seconds: timing.blind_announcement_seconds,
      elimination_announcement_seconds: timing.elimination_announcement_seconds
    };
  }

  async function saveSettings() {
    if (!state.activeTableId || !state.tableView || state.settingsSaving) return;
    var payload;
    try { payload = settingsPayload(); } catch (err) { showNotice(err.message, "error", false); return; }
    var form = byId("table-settings-form");
    var inGame = state.tableView.status === "playing";
    if (inGame && !state.tableView.paused) {
      showNotice("Pause the game before changing timing settings.", "error", false);
      return;
    }
    var timingInvalid = payload.level_minutes < 0.01 || payload.turn_seconds < 1 ||
      payload.runout_seconds < 1 || payload.blind_announcement_seconds < 0 ||
      payload.blind_announcement_seconds > 60 || payload.elimination_announcement_seconds < 0 ||
      payload.elimination_announcement_seconds > 60;
    if (!form.checkValidity() || timingInvalid || (!inGame &&
        (!payload.name || payload.max_seats < 2 || payload.max_seats > 9 ||
        payload.starting_stack < 100 || payload.small_blind < 1 || payload.big_blind <= payload.small_blind))) {
      showNotice(inGame ? "Check the game timing values." : "Check the table name, seats, stack, blinds, and timers.", "error", false);
      return;
    }
    var currentSeats = Array.isArray(state.tableView.seats) ? state.tableView.seats.length : 0;
    if (!inGame && payload.max_seats < currentSeats) {
      showNotice("The table needs at least as many seats as the players already seated.", "error", false);
      return;
    }

    state.settingsSaving = true;
    renderSettingsPanel(state.tableView, true);
    updateHostReadiness(state.tableView, true);
    try {
      var data = await mutate("/tables/" + encodeURIComponent(state.activeTableId) + "/settings", payload);
      state.settingsDirty = false;
      state.tableView = data.table || data;
      await refreshSelected();
      await refreshAll(true);
      showNotice(inGame ? "Game timing settings saved." : "Table settings saved.", "success", false);
    } catch (err) {
      showNotice(err.message, "error", false);
    } finally {
      state.settingsSaving = false;
      renderTable();
    }
  }

  async function refreshSelected() {
    if (!state.activeTableId) {
      state.tableView = null;
      renderTable();
      return;
    }
    var selectedTableId = String(state.activeTableId);
    var data;
    try {
      data = await request("/tables/" + encodeURIComponent(selectedTableId));
    } catch (err) {
      if (state.activeTableId !== selectedTableId) return;
      throw err;
    }
    if (state.activeTableId !== selectedTableId) return;
    if (adoptSnapshot(data.table || data, selectedTableId)) renderTable();
  }

  function actionIntentFor(action, view) {
    var viewer = view.viewer || {};
    var seat = viewerSeat(view);
    var stack = number(seat && seat.stack, 0);
    var ownBet = number(seat && seat.bet, 0);
    var currentBet = number(view.current_bet, 0);
    var toCall = number(viewer.to_call, 0);
    var payload = {
      expected_hand: number(view.hand_no, 0),
      expected_turn_version: number(view.turn_version, 0)
    };
    var paid = 0;
    var target = ownBet;

    if (action === "raise_to") {
      var input = byId("raise-amount");
      var amount = Number(input && input.value);
      var min = number(input && input.min, 0);
      var max = number(input && input.max, 0);
      if (!Number.isInteger(amount) || amount < min || amount > max) {
        showActionFeedback("Choose a whole-chip bet or raise total within the displayed range.", "error", false);
        return null;
      }
      payload.action = currentBet > 0 ? "raise" : "bet";
      payload.amount = amount;
      paid = amount - ownBet;
      target = amount;
    } else {
      payload.action = action;
      if (action === "call") {
        paid = Math.min(toCall, stack);
        target = ownBet + paid;
      } else if (action === "all_in") {
        paid = stack;
        target = ownBet + stack;
      }
    }

    var description;
    var successMessage;
    if (action === "fold") {
      description = "fold";
      successMessage = "Fold recorded.";
    } else if (action === "check") {
      description = "check";
      successMessage = "Check recorded.";
    } else if (action === "call") {
      var allInCall = stack > 0 && paid === stack;
      description = "call for " + actionChips(paid) + (allInCall ? " · all-in" : "");
      successMessage = "Call recorded: " + actionChips(paid) + (allInCall ? " · all-in." : ".");
    } else if (action === "all_in") {
      if (target > currentBet) {
        var allInVerb = currentBet > 0 ? "raise" : "bet";
        description = "all-in " + allInVerb + " to " + actionChips(target);
        successMessage = "All-in " + allInVerb + " recorded: " + actionChips(paid) + " added to reach " + actionChips(target) + " total.";
      } else {
        description = "all-in call for " + actionChips(paid);
        successMessage = "All-in call recorded: " + actionChips(paid) + ".";
      }
    } else {
      var raiseVerb = payload.action === "raise" ? "raise" : "bet";
      description = raiseVerb + " to " + actionChips(target) + " total (adds " + actionChips(paid) + ")";
      successMessage = (payload.action === "raise" ? "Raise" : "Bet") + " recorded: " + actionChips(paid) + " added to reach " + actionChips(target) + " total.";
    }

    return {
      tableId: String(state.activeTableId),
      key: actionTokenKey(view),
      payload: payload,
      pendingMessage: "Submitting " + description + "…",
      successMessage: successMessage
    };
  }

  async function submitActionIntent(intent) {
    if (state.actionPending) return;
    if (!actionIntentIsCurrent(intent)) {
      showNotice("That turn changed before the action was sent. Review the refreshed table.", "info", false);
      try { await refreshSelected(); } catch (err) {}
      return;
    }

    state.actionPending = intent;
    renderActions(state.tableView);
    try {
      await mutate("/tables/" + encodeURIComponent(intent.tableId) + "/action", intent.payload);
      intent.accepted = true;
      state.actionSubmittedKey = intent.key;
      try {
        await refreshSelected();
      } catch (refreshError) {
        if (refreshError.status !== 401) {
          showActionFeedback("Your action was sent, but the table could not refresh. " + refreshError.message, "error", true);
        }
      }
      try { await refreshAll(true); } catch (refreshError) {}
    } catch (err) {
      if (err.status === 409) {
        showActionFeedback("", "info", true);
        showNotice("The hand or turn changed before that action arrived. Review the refreshed table.", "info", false);
      } else {
        showActionFeedback(err.message, "error", false);
      }
      try { await refreshSelected(); } catch (refreshError) {}
      try { await refreshAll(true); } catch (refreshError) {}
    } finally {
      if (state.actionPending === intent) {
        state.actionPending = null;
        if (state.tableView) renderActions(state.tableView);
      }
    }
  }

  function beginActionIntent(intent) {
    if (!intent || state.actionPending || state.actionSubmittedKey === intent.key) return;
    if (!actionIntentIsCurrent(intent)) {
      showNotice("That turn changed before the action was sent. Review the refreshed table.", "info", false);
      refreshSelected().catch(function () {});
      return;
    }
    submitActionIntent(intent);
  }

  byId("login-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var name = byId("login-name").value.trim();
    var password = byId("login-password").value;
    if (!name || !password) {
      showNotice("Enter your username and password.", "error", false);
      return;
    }
    var submit = event.currentTarget.querySelector('button[type="submit"]');
    submit.disabled = true;
    submit.querySelector("span").textContent = "Opening room…";
    try {
      var body = {username:name,password:password};
      if (authMode !== "login") body.room_password = byId("room-password").value;
      var data = await request("/" + authMode, {method:"POST", body:body, mutate:authMode === "claim"});
      byId("room-password").value = "";
      byId("login-password").value = "";
      state.activeTableId = hashTableId();
      if (!data.session_proof || !data.csrf) throw new apiError("The room did not issue complete session credentials. Try signing in again.", 500, "missing_session_proof");
      enterApp(data.player, data.csrf, data.session_proof);
    } catch (err) {
      byId("login-password").value = "";
      showNotice(err.message, "error", false);
    } finally {
      submit.disabled = false;
      setAuthMode(authMode);
    }
  });

  var historyGeneration = 0;
  function historyCards(cards) {
    return (cards || []).map(function (c) {var x=cardInfo(c); return x ? x.rank + cardSuit(x.suit).symbol : "";}).join(" ");
  }
  function historyEvent(e) {
    var who = e.actor_label || "Player", street = e.street || "";
    if (e.type === "action") {
      var label = String(e.action || "").replace(/_/g," ");
      return [street, who + ": " + label, e.target && /raise|bet/.test(label) ? "to " + chips(e.target) : e.amount ? chips(e.amount) : "", e.timed_out ? "(timeout)" : ""].filter(Boolean).join(" ");
    }
    if (e.type === "street") return street + ": " + historyCards(e.board);
    if (e.type === "reveal") return "Cards shown: " + (e.hands || []).map(function (h) {return h.actor_label + " " + historyCards(h.cards);}).join(" · ");
    if (e.type === "payout" || e.type === "showdown_result") {
      var lines=(e.winners || []).map(function (w) {return w.actor_label + " won " + chips(w.amount) + (w.rank ? " (" + w.rank + ")" : "");});
      return lines.join(" · ");
    }
    return "";
  }
  function historyResults(results) {
    return (results || []).map(function (r) {
      return esc((r.tied ? "T-" : "") + r.place + ". " + r.name + (r.award_cents == null ? "" : " · " + credits(r.award_cents) + " credits"));
    }).join("<br>");
  }
  function historyHand(h) {
    var seats = (h.players || []).map(function (p) {
      return '<li>' + esc(p.name) + (p.player_id === state.player?.id ? " (you)" : "") + (p.cards?.length ? " · " + esc(historyCards(p.cards)) : "") + (p.stack_before != null ? " · " + chips(p.stack_before) + " chips" : "") + '</li>';
    }).join("");
    var pots = (h.result?.pots || []).map(function (p,i) {
      return (i ? "Side pot "+i : "Main pot") + ": " + (p.recipients || []).map(function (r) {return r.actor_label + " +" + chips(r.amount);}).join(", ");
    });
    var actions = (h.events || []).map(historyEvent).filter(Boolean);
    return '<details class="history-entry"><summary>Hand ' + esc(h.number) + ' · ' + esc(historyCards(h.board) || "Preflop") + '</summary>' +
      (seats ? '<ul>' + seats + '</ul>' : '') +
      (pots.length ? '<p>' + esc(pots.join(" · ")) + '</p>' : '') +
      (h.events_complete === false ? '<p>Earlier actions in this hand were not retained.</p>' : '') +
      '<ol>' + actions.map(function (line) {return '<li>' + esc(line) + '</li>';}).join("") + '</ol></details>';
  }
  async function loadHistory(id, offset) {
    var gen = ++historyGeneration, el = byId("history-content");
    el.textContent = "Loading history…";
    try {
      var data = await request(id ? "/history/" + encodeURIComponent(id) + (offset ? "?offset="+offset : "") : "/history" + (offset ? "?offset="+offset : ""));
      if (gen !== historyGeneration || !byId("history-dialog").open) return;
      if (id) {
        var t = data.tournament;
        var partial = t.partial_history || (!offset && data.hands?.length && data.hands[0].number > 1);
        var legacyNote = partial ? "<p>Only the hands the room still had when history tracking began are available for this tournament.</p>" : "";
        el.innerHTML = '<button class="button button-quiet history-back" data-history-list>← All tournaments</button><h3>' + esc(t.name) + '</h3><p>' + historyResults(t.results) + '</p>' + legacyNote +
          (data.hands || []).map(historyHand).join("") + (data.hands?.length ? '' : '<p>No saved hands for this tournament.</p>');
      } else {
        el.innerHTML = (data.tournaments || []).map(function (t) {
          var mine = (t.results || []).find(function (row) {return row.player_id === state.player?.id;});
          return '<div class="history-entry"><h3>' + esc(t.name) + '</h3><p>' + esc(new Date((t.started || t.created)*1000).toLocaleDateString()) + ' · ' + esc(statusName(t.status)) + ' · ' + esc(t.hand_count) + ' saved hands' + (mine ? ' · Place ' + esc(mine.place) + (mine.award_cents == null ? "" : ' · ' + credits(mine.award_cents) + ' credits') : '') + '</p><button class="button button-outline button-small" data-history-table="' + esc(t.id) + '">View hands &amp; results</button></div>';
        }).join("") || "<p>You haven’t played a tournament yet.</p>";
      }
      if (offset || data.next_offset != null) {
        el.insertAdjacentHTML("beforeend", '<div class="history-pages">' + (offset ? '<button class="button button-quiet" data-history-offset="0">First page</button>' : '') + (data.next_offset != null ? '<button class="button button-outline" data-history-offset="'+esc(data.next_offset)+'">Next page</button>' : '') + '</div>');
      }
      el.dataset.table = id || "";
    } catch (err) { if (gen === historyGeneration) el.textContent = err.message; }
  }
  byId("last-hand-button").addEventListener("click", function (event) {
    openLastHandDialog(event.currentTarget);
  });
  byId("last-hand-close").addEventListener("click", function () {
    closeLastHandDialog(true);
  });
  byId("last-hand-dialog").addEventListener("cancel", function (event) {
    event.preventDefault();
    closeLastHandDialog(true);
  });
  byId("last-hand-prev").addEventListener("click", function () {
    moveLastHandStreet(-1);
  });
  byId("last-hand-next").addEventListener("click", function () {
    moveLastHandStreet(1);
  });

  byId("history-button").addEventListener("click", function () {byId("history-dialog").showModal(); loadHistory("");});
  byId("history-close").addEventListener("click", function () {byId("history-dialog").close();});

  byId("recent-action-button").addEventListener("click", function () {
    var dialog = byId("recent-action-dialog");
    if (dialog && !dialog.open) dialog.showModal();
    if (dialog && dialog.open) byId("recent-action-button").setAttribute("aria-expanded", "true");
  });
  byId("recent-action-close").addEventListener("click", closeRecentActionDialog);
  byId("recent-action-dialog").addEventListener("cancel", function (event) {
    event.preventDefault();
    closeRecentActionDialog();
  });
  byId("recent-action-dialog").addEventListener("close", function () {
    var trigger = byId("recent-action-button");
    if (trigger) trigger.setAttribute("aria-expanded", "false");
    if (trigger && trigger.isConnected && trigger.getClientRects().length) trigger.focus({ preventScroll: true });
  });
  byId("history-dialog").addEventListener("close", function () {historyGeneration++; byId("history-content").replaceChildren();});
  byId("history-content").addEventListener("click", function (e) {
    var btn=e.target.closest("button");
    if (btn?.hasAttribute("data-history-table")) loadHistory(btn.dataset.historyTable);
    else if (btn?.hasAttribute("data-history-list")) loadHistory("");
    else if (btn?.hasAttribute("data-history-offset")) loadHistory(byId("history-content").dataset.table, Number(btn.dataset.historyOffset));
  });
  byId("player-settings-button").addEventListener("click", openPlayerPreferences);
  byId("player-settings-close").addEventListener("click", closePlayerPreferences);
  byId("player-prefs-cancel").addEventListener("click", closePlayerPreferences);
  byId("player-settings-dialog").addEventListener("close", function () {
    byId("player-settings-button").setAttribute("aria-expanded", "false");
  });
  byId("player-prefs-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var error = byId("player-prefs-error");
    var key = playerPrefsStorageKey();
    if (!key) return;
    try {
      var prefs = {
        preflop_bb: parsePlayerPresetInput("prefs-preflop-bb", 1, 200),
        postflop_percent: parsePlayerPresetInput("prefs-postflop-percent", 1, 1000)
      };
      window.localStorage.setItem(key, JSON.stringify(prefs));
      error.hidden = true;
      error.textContent = "";
      closePlayerPreferences();
      if (state.tableView) renderActions(state.tableView);
      showNotice("Your bet presets were saved on this device.", "success", false);
    } catch (err) {
      error.textContent = err.message || "Could not save these preferences.";
      error.hidden = false;
      error.setAttribute("tabindex", "-1");
      error.focus();
    }
  });

  byId("runtime-settings-button").addEventListener("click", function () {
    var view = state.tableView;
    if (!view || view.status !== "playing") return;
    state.runtimeSettingsOpen = !state.runtimeSettingsOpen;
    if (state.runtimeSettingsOpen) clearNotice();
    var playerId = String(state.player && state.player.id || "");
    var host = String(view.host_id || "") === playerId;
    renderSettingsPanel(view, host);
  });

  byId("logout-button").addEventListener("click", async function () {
    try {
      await mutate("/logout", {});
    } catch (err) {
      if (err.status !== 401) showNotice(err.message, "error", false);
    }
    setLoggedOut("");
  });

  byId("create-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var form = event.currentTarget;
    var small = number(byId("small-blind").value, 0);
    var big = number(byId("big-blind").value, 0);
    if (small < 1 || big <= small) {
      showNotice("The big blind must be greater than the small blind.", "error", false);
      return;
    }
    var button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      var data = await mutate("/tables", {
        buy_in: number(byId("buy-in").value,0),
        payout_percentages: payouts("payout"),
        name: byId("table-name").value.trim(),
        max_seats: number(byId("max-seats").value, 6),
        starting_stack: number(byId("starting-stack").value, 1000),
        small_blind: small,
        big_blind: big,
        level_minutes: number(byId("level-minutes").value, 5),
        turn_seconds: number(byId("turn-seconds").value, 30),
        runout_seconds: number(byId("runout-seconds").value, 2.5),
        blind_announcement_seconds: number(byId("blind-announcement-seconds").value, 5),
        elimination_announcement_seconds: number(byId("elimination-announcement-seconds").value, 5)
      });
      var table = data.table || data;
      closeLastHandDialog(false);
      state.activeTableId = String(table.id || "");
      state.tableView = table.id ? table : null;
      if (state.activeTableId) setHashTable(state.activeTableId);
      clearNotice();
      await refreshAll(true);
    } catch (err) {
      showNotice(err.message, "error", false);
    } finally {
      button.disabled = false;
    }
  });

  async function handleSeatControlClick(event) {
    var button = event.target.closest("[data-take-seat], [data-add-bot-seat], [data-remove-bot-seat]");
    if (!button || button.disabled || !state.activeTableId) return;
    event.stopPropagation();
    var tableId = String(state.activeTableId);
    var playerId = String(state.player && state.player.id || "");
    var rawSeatNo = button.hasAttribute("data-take-seat") ? button.getAttribute("data-take-seat") :
      (button.hasAttribute("data-add-bot-seat") ? button.getAttribute("data-add-bot-seat") : button.getAttribute("data-remove-bot-seat"));
    var seatNo = number(rawSeatNo, -1);
    if (seatNo < 0) return;
    button.disabled = true;
    try {
      var message;
      if (button.hasAttribute("data-take-seat")) {
        await mutate("/tables/" + encodeURIComponent(tableId) + "/seat", { seat_no: seatNo });
        message = "You took Seat " + (seatNo + 1) + ".";
      } else if (button.hasAttribute("data-add-bot-seat")) {
        await mutate("/tables/" + encodeURIComponent(tableId) + "/bots", { seat_no: seatNo });
        message = "A test bot joined Seat " + (seatNo + 1) + ".";
      } else {
        await mutate("/tables/" + encodeURIComponent(tableId) + "/bots/" + seatNo, undefined, "DELETE");
        message = "The test bot left Seat " + (seatNo + 1) + ".";
      }
      if (state.activeTableId !== tableId || String(state.player && state.player.id || "") !== playerId) return;
      await refreshSelected();
      await refreshAll(true);
      showNotice(message, "success", false);
    } catch (err) {
      if (state.activeTableId === tableId) showNotice(err.message, "error", false);
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  }

  byId("seat-controls").addEventListener("click", handleSeatControlClick);

  byId("stand-button").addEventListener("click", async function () {
    if (!state.activeTableId) return;
    var button = byId("stand-button");
    button.disabled = true;
    try {
      await mutate("/tables/" + encodeURIComponent(state.activeTableId) + "/stand", {});
      await refreshSelected();
      await refreshAll(true);
      showNotice("You stood up and can keep watching as a guest.", "success", false);
    } catch (err) {
      showNotice(err.message, "error", false);
    } finally {
      button.disabled = false;
    }
  });

  byId("table-settings-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    await saveSettings();
  });

  byId("table-settings-form").addEventListener("input", function (event) {
    if (event.target.disabled) return;
    state.settingsDirty = true;
    renderSettingsPanel(state.tableView, true);
    updateHostReadiness(state.tableView, true);
  });

  byId("table-settings-form").addEventListener("change", function (event) {
    if (event.target.disabled) return;
    state.settingsDirty = true;
    renderSettingsPanel(state.tableView, true);
    updateHostReadiness(state.tableView, true);
  });

  byId("cancel-button").addEventListener("click", async function () {
    if (!state.activeTableId || !window.confirm("Cancel this lobby? Everyone seated will be removed.")) return;
    var button = byId("cancel-button");
    button.disabled = true;
    try {
      await mutate("/tables/" + encodeURIComponent(state.activeTableId) + "/cancel", {});
      clearBlindAnnouncement(true);
      closeRecentActionDialog();
      closeLastHandDialog(false);
      state.activeTableId = "";
      state.skipAutoResume = true;
      state.tableView = null;
      setHashTable("");
      renderTables();
      renderTable();
      await refreshAll(true);
      showNotice("The lobby was cancelled.", "success", false);
    } catch (err) {
      showNotice(err.message, "error", false);
    } finally {
      button.disabled = false;
    }
  });

  byId("pause-button").addEventListener("click", async function () {
    var view = state.tableView;
    if (!view || view.status !== "playing" || state.pausePending) return;
    var playerId = String(state.player && state.player.id || "");
    if (String(view.host_id || "") !== playerId) return;
    var tableId = String(state.activeTableId);
    var paused = !Boolean(view.paused);
    state.pausePending = true;
    renderPauseControls(view, true);
    try {
      var data = await mutate("/tables/" + encodeURIComponent(tableId) + "/pause", { paused: paused });
      if (state.activeTableId !== tableId) return;
      state.tableView = data.table || data;
      renderTable();
      await refreshAll(true);
      if (!state.runtimeSettingsOpen) showNotice(paused ? "Game paused." : "Game resumed.", "success", false);
    } catch (err) {
      if (state.activeTableId === tableId) showNotice(err.message, "error", false);
    } finally {
      state.pausePending = false;
      if (state.tableView) renderTable();
    }
  });

  byId("start-button").addEventListener("click", async function () {
    if (!state.activeTableId) return;
    var button = byId("start-button");
    button.disabled = true;
    try {
      await mutate("/tables/" + encodeURIComponent(state.activeTableId) + "/start", {});
      await refreshSelected();
      await refreshAll(true);
      showNotice("The freezeout is underway. Good luck.", "success", false);
    } catch (err) {
      showNotice(err.message, "error", false);
    } finally {
      button.disabled = false;
    }
  });

  function lobbyPane(which) {
    byId("app-panel").dataset.pane = which;
    byId("open-games-tab").setAttribute("aria-pressed", String(which !== "create"));
    byId("create-game-tab").setAttribute("aria-pressed", String(which === "create"));
  }
  byId("open-games-tab").addEventListener("click",function () {lobbyPane("games");});
  byId("create-game-tab").addEventListener("click",function () {lobbyPane("create");});
  byId("close-table-button").addEventListener("click", function () {
    lobbyPane("games");
    clearBlindAnnouncement(true);
    closeRecentActionDialog();
    closeLastHandDialog(false);
    state.activeTableId = "";
    state.skipAutoResume = true;
    state.tableView = null;
    setHashTable("");
    renderTables();
    renderTable();
    refreshAll(true);
  });

  byId("copy-invite-button").addEventListener("click", async function () {
    if (!state.activeTableId) return;
    var link = window.location.origin + window.location.pathname + "#table=" + encodeURIComponent(state.activeTableId);
    var copied = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(link);
        copied = true;
      }
    } catch (err) {}
    if (!copied) {
      var field = document.createElement("textarea");
      field.value = link;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      try { copied = document.execCommand("copy"); } catch (err) {}
      field.remove();
    }
    if (copied) {
      var button = byId("copy-invite-button");
      button.textContent = "Copied!";
      if (state.inviteResetTimer) window.clearTimeout(state.inviteResetTimer);
      state.inviteCopiedFor = state.activeTableId;
      state.inviteResetTimer = window.setTimeout(function () {
        if (state.inviteCopiedFor === state.activeTableId) button.textContent = "Copy invite link";
      }, 2200);
      showNotice("Invite link copied. Guests will still need the room password.", "success", false);
    } else {
      window.prompt("Copy this table invite link:", link);
    }
  });

  byId("table-list").addEventListener("click", async function (event) {
    var button = event.target.closest("[data-open-table]");
    if (!button) return;
    clearBlindAnnouncement(true);
    closeRecentActionDialog();
    closeLastHandDialog(false);
    state.activeTableId = button.getAttribute("data-open-table") || "";
    state.skipAutoResume = false;
    state.tableView = null;
    setHashTable(state.activeTableId);
    renderTables();
    renderTable();
    try {
      await refreshSelected();
    } catch (err) {
      if (err.status !== 401) showNotice(err.message, "error", false);
    }
  });

  byId("reopen-results-button").addEventListener("click", function () {
    state.standingsDismissedFor = "";
    if (state.tableView) renderResults(state.tableView);
    byId("dismiss-results-button").focus();
  });

  byId("dismiss-results-button").addEventListener("click", function () {
    var tableId = String(state.activeTableId || (state.tableView && state.tableView.id) || "");
    state.standingsDismissedFor = tableId;
    if (state.tableView) renderResults(state.tableView);
    byId("reopen-results-button").focus();
  });

  byId("results-panel").addEventListener("keydown", function (event) {
    if (event.key === "Escape" && !byId("results-panel").hidden) {
      event.preventDefault();
      byId("dismiss-results-button").click();
    }
  });

  byId("seat-grid").addEventListener("click", function (event) {
    var seatAction = event.target.closest("[data-take-seat], [data-add-bot-seat]");
    if (seatAction) {
      handleSeatControlClick(event);
      return;
    }
    var toggle = event.target.closest("[data-chip-display-toggle]");
    if (!toggle) return;
    state.showBigBlinds = !state.showBigBlinds;
    renderTable();
    var nextToggle = byId("seat-grid").querySelector("[data-chip-display-toggle]");
    if (nextToggle) nextToggle.focus({ preventScroll: true });
  });

  byId("chat-button").addEventListener("click", function () {
    if (state.chat.open) closeChat(true);
    else showChat();
  });
  byId("chat-close-button").addEventListener("click", function () { closeChat(true); });
  byId("chat-input").addEventListener("input", function () {
    setChatError("");
    updateChatCharacterCount();
  });
  byId("chat-form").addEventListener("submit", function (event) {
    event.preventDefault();
    sendChatMessage();
  });
  byId("sit-out-button").addEventListener("click", toggleSitOut);

  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape" || !state.chat.open || document.querySelector("dialog[open]")) return;
    event.preventDefault();
    closeChat(true);
  });

  byId("action-controls").addEventListener("input", function (event) {
    if (event.target && event.target.id === "raise-amount") {
      state.raiseDraftKey = actionTokenKey(state.tableView || {});
      state.raiseDraftValue = event.target.value;
      updateRaisePreview();
    }
  });

  byId("action-controls").addEventListener("wheel", function (event) {
    if (!event.target.closest(".raise-control")) return;
    var input = byId("raise-amount");
    var view = state.tableView;
    if (!input || input.disabled || !view || !viewerCanAct(view) || state.actionPending ||
        state.actionSubmittedKey === actionTokenKey(view) || !Number.isFinite(event.deltaY) || event.deltaY === 0) return;
    var min = number(input.min, 0);
    var max = number(input.max, 0);
    if (max <= min) return;
    event.preventDefault();
    var bigBlind = Math.max(1, number(blindParts(view).big, 1));
    var step = Math.max(1, Math.floor(bigBlind / 2));
    var next = Math.max(min, Math.min(max, number(input.value, min) + (event.deltaY < 0 ? step : -step)));
    state.raiseDraftKey = actionTokenKey(view);
    state.raiseDraftValue = String(next);
    input.value = String(next);
    updateRaisePreview();
  }, { passive: false });

  byId("action-controls").addEventListener("keydown", function (event) {
    if (event.key === "Enter" && event.target && event.target.id === "raise-amount") {
      event.preventDefault();
      var raiseButton = byId("action-controls").querySelector('[data-poker-action="raise_to"]');
      if (raiseButton && !raiseButton.disabled) raiseButton.click();
    }
  });

  byId("action-controls").addEventListener("click", function (event) {
    var preset = event.target.closest("[data-raise-preset]");
    if (preset) {
      var presetView = state.tableView;
      var raiseInput = byId("raise-amount");
      var presetTarget = Number(preset.getAttribute("data-target"));
      if (preset.disabled || !presetView || !viewerCanAct(presetView) ||
          state.actionPending || state.actionSubmittedKey === actionTokenKey(presetView) ||
          !raiseInput || !Number.isInteger(presetTarget)) return;
      state.raiseDraftKey = actionTokenKey(presetView);
      state.raiseDraftValue = String(presetTarget);
      raiseInput.value = String(presetTarget);
      updateRaisePreview();
      return;
    }
    var button = event.target.closest("[data-poker-action]");
    if (!button || button.disabled || state.actionPending) return;
    var view = state.tableView;
    if (!viewerCanAct(view) || state.actionSubmittedKey === actionTokenKey(view)) return;
    var intent = actionIntentFor(button.getAttribute("data-poker-action"), view);
    if (intent) beginActionIntent(intent);
  });

  window.addEventListener("resize", function () {
    if (state.tableView) renderSeats(state.tableView);
  });

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && state.polling) refreshAll(true);
  });

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && state.chat.open) {
      var chat = state.chat;
      fetchChat(chat.requestId, chat.tableId, chat.playerId);
    }
  });

  loadAuth();
  boot();
}());

