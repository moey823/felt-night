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
    seatTurnClockKey: "",
    seatTurnRemainingMs: 0,
    seatTurnClockUpdatedAt: 0,
    seatTurnClockTimer: 0,
    actionPending: null,
    actionConfirmation: null,
    actionRenderKey: "",
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
      awards: [],
      pots: [],
      returns: [],
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

  function clearNotice() {
    showNotice("", "info", true);
  }

  function setLoggedOut(message) {
    state.player = null;
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
      nextAt: b.next_level_at || b.level_ends_at || (source && (source.next_level_at || source.level_ends_at)) || ""
    };
  }

  function formatClock(seconds) {
    var s = Math.max(0, Math.floor(number(seconds, 0)));
    var mins = Math.floor(s / 60);
    var secs = s % 60;
    return String(mins).padStart(2, "0") + ":" + String(secs).padStart(2, "0");
  }

  function clockRemaining(blinds) {
    if (blinds.seconds >= 0) return blinds.seconds;
    if (blinds.nextAt) {
      var stamp = typeof blinds.nextAt === "number" ? blinds.nextAt : Date.parse(blinds.nextAt);
      if (Number.isFinite(stamp)) {
        if (stamp < 100000000000) stamp *= 1000;
        return Math.max(0, Math.floor((stamp - Date.now()) / 1000));
      }
    }
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
    var value = actionTotal > 0 ? " · " + chips(actionTotal) : "";
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
        actorLabel: String(event.actor_label || "")
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
      fx.awards = Array.isArray(event.winners) ? event.winners : [];
      fx.pots = Array.isArray(event.pots) ? event.pots : [];
      fx.returns = Array.isArray(event.returns) ? event.returns : [];
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
    fx.awards = [];
    fx.pots = [];
    fx.returns = [];
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
    if (Array.isArray(view.returns)) fx.returns = view.returns;
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
        fx.awards = [];
        fx.pots = [];
        fx.returns = [];
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
          else if (event && (event.type === "showdown_result" || event.type === "payout")) fx.queue.push({ type: "payout", event: event });
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
      else if (event && (event.type === "showdown_result" || event.type === "payout")) fx.queue.push({ type: "payout", event: event });
      fx.lastSeq = Math.max(fx.lastSeq, seq);
    });
    fx.street = visibleStreet || fx.street;
  }

  function actionForSeat(seat, seatNo) {
    var fx = state.tableFx;
    var id = String(seat.id || seat.player_id || "");
    var name = String(seat.name || "").toLowerCase();
    return fx.actions[id] || fx.actions["seat:" + seatNo] || (name ? fx.actions["name:" + name] : null) || null;
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
  }

  function syncSeatTurnClock(view) {
    var actorId = String(view && (view.actor_id || view.to_act_id) || "");
    var deadline = epochMilliseconds(view && view.turn_deadline);
    var serverNow = epochMilliseconds(view && view.server_now);
    if (!serverNow) serverNow = Date.now();
    var valid = Boolean(view && view.status === "playing" && actorId && deadline);
    if (!valid) {
      clearSeatTurnClock();
      return;
    }
    var key = [view.id || "", view.hand_id || view.hand_no || "", view.street || "", actorId, view.turn_version || "", deadline].join("|");
    if (key !== state.seatTurnClockKey) {
      if (state.seatTurnClockTimer) window.clearInterval(state.seatTurnClockTimer);
      state.seatTurnClockKey = key;
      state.seatTurnClockTimer = window.setInterval(updateSeatTurnClockNodes, 250);
    }
    state.seatTurnRemainingMs = Math.max(0, deadline - serverNow);
    state.seatTurnClockUpdatedAt = monotonicNow();
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
    chip.textContent = label == null ? chips(amount) : String(label);
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

    if (item.type === "payout") {
      var payoutEvent = item.event || {};
      var payoutLayer = byId("chip-layer");
      var payoutSourceNode = byId("pot-amount");
      var payoutSourceRect = payoutSourceNode && payoutSourceNode.getBoundingClientRect();
      var payoutStart = payoutSourceRect
        ? { x: payoutSourceRect.left + payoutSourceRect.width / 2, y: payoutSourceRect.top + payoutSourceRect.height / 2 }
        : null;
      var seatNodes = Array.prototype.slice.call(byId("seat-grid").querySelectorAll(".seat-card[data-player-id]"));
      function recipientNode(recipient) {
        var recipientId = String(recipient && recipient.player_id || "");
        if (!recipientId) return null;
        return seatNodes.find(function (node) {
          return String(node.getAttribute("data-player-id") || "") === recipientId;
        }) || null;
      }
      var transferCount = (payoutEvent.pots || []).length + ((payoutEvent.returns || []).length ? 1 : 0);
      var flightMs = Math.min(570, 2100 / Math.max(1, transferCount));
      function transferStep(recipients, isReturn) {
        if (!stillCurrent() || state.tableView !== view && (!state.tableView || state.tableView.hand_id !== view.hand_id)) return Promise.resolve();
        var motions = [];
        (recipients || []).forEach(function (recipient) {
          var amount = number(recipient && recipient.amount, 0);
          var targetNode = recipientNode(recipient);
          var targetRect = targetNode && targetNode.getBoundingClientRect();
          if (amount <= 0 || !targetRect) return;
          var target = { x: targetRect.left + targetRect.width / 2, y: targetRect.top + targetRect.height / 2 };
          var label = (isReturn ? "RETURN +" : "+") + chips(amount);
          motions.push(animateChip(payoutLayer, payoutStart, target, amount, flightMs, label, isReturn ? "return" : "payout"));
        });
        return Promise.all(motions);
      }
      var pots = Array.isArray(payoutEvent.pots) ? payoutEvent.pots.slice() : [];
      if (!pots.length && Array.isArray(payoutEvent.winners) && payoutEvent.winners.length) {
        pots.push({ recipients: payoutEvent.winners });
      }
      pots.sort(function (a, b) { return number(a && a.pot_index, 0) - number(b && b.pot_index, 0); });
      var sequence = Promise.resolve();
      pots.forEach(function (pot) {
        var recipients = Array.isArray(pot && pot.recipients) ? pot.recipients : [];
        sequence = sequence.then(function () { return transferStep(recipients, false); });
      });
      var returns = Array.isArray(payoutEvent.returns) ? payoutEvent.returns : [];
      sequence.then(function () { return transferStep(returns, true); }).then(complete);
      return;
    }
    complete();
  }
  function renderSeats(view) {
    var layout = seatLayout(view);
    var max = layout.max;
    var bySeat = layout.bySeat;
    var viewer = view.viewer || {};
    var viewerId = String(viewer.player_id || (state.player && state.player.id) || "");
    var ownSeat = layout.seats.find(function (seat) {
      return String(seat.id || seat.player_id || "") === viewerId;
    });
    var hostId = String(view.host_id || "");
    var anchorSeat = ownSeat || layout.seats.find(function (seat) {
      return String(seat.id || seat.player_id || "") === hostId;
    }) || layout.seats[0] || null;
    var anchorRawSeatNo = anchorSeat && anchorSeat.seat_no != null ? anchorSeat.seat_no : layout.seats.indexOf(anchorSeat);
    var anchorSeatNo = anchorSeat ? Math.floor(number(anchorRawSeatNo, 0)) : 0;
    var ringOnlySeated = view.status === "playing" || view.status === "completed";
    var clockwiseSeats = layout.seats.map(function (seat, index) {
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
          html += '<div class="seat-card seat-empty" data-seat-no="' + i + '" data-relative-seat="' + relativeIndex + '" data-seat-empty="true"><span>Seat ' + (i + 1) + '</span><span>Open</span></div>';
        }
        continue;
      }

      var id = String(seat.id || seat.player_id || "");
      var isMe = id && id === viewerId;
      var bot = isBotSeat(seat);
      var folded = Boolean(seat.folded || seat.is_folded);
      var allIn = Boolean(seat.all_in || seat.is_all_in);
      var acting = actorId && id === actorId;
      var dealer = buttonId && id === buttonId;
      var classes = "seat-card" + (isMe ? " is-me" : "") + (acting ? " is-acting" : "") + (folded ? " is-folded" : "") + (bot ? " is-bot" : "");
      var label = folded ? "Folded" : (allIn ? "All in" : "");
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
      var stackHtml = compactRunoutSeat ? "" : '<div class="seat-stack">' + chips(stack) + ' <span class="seat-number">chips</span></div>';
      var cardHtml = "";
      if (cards.length) {
        cardHtml = '<div class="seat-cards' + (exposed ? ' is-exposed' : ' is-viewer-cards') + '">' + cards.map(function (card) { return playingCardHTML(card, true); }).join("") + '</div>';
      } else if (currentHand && !folded && (stack > 0 || allIn)) {
        cardHtml = '<div class="seat-cards">' + hiddenCardHTML(true, false) + hiddenCardHTML(true, false) + '</div>';
      }

      var tags = bot ? '<span class="seat-label bot-label">TEST BOT</span>' : '';
      var tagsMarkup = tags ? '<div class="seat-tags">' + tags + '</div>' : '';
      html += '<div class="' + classes + '" data-seat-no="' + esc(seatNo) + '" data-player-id="' + esc(id) + '" data-relative-seat="' + relativeIndex + '" data-is-bot="' + (bot ? 'true' : 'false') + '">' +
        '<div class="seat-top"><span class="seat-name-wrap"><span class="seat-name">' + esc(seat.name || (bot ? "Test bot" : "Player")) + '</span><span class="seat-number">#' + (i + 1) + '</span></span></div>' +
        tagsMarkup +
        stackHtml +
        '<div class="seat-detail"><span>' + esc(label) + '</span></div>' +
        cardHtml + equityHtml +
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
        html += '<span class="seat-wager" data-seat-no="' + esc(seatNo) + '" aria-label="Street wager ' + chips(wager) + '"><span class="wager-stack" aria-hidden="true"><i></i><i></i><i></i></span><strong>' + chips(wager) + '</strong></span>';
      } else if (number(pendingWagers[seatNo], 0) > 0) {
        html += '<span class="seat-wager is-reserved" data-seat-no="' + esc(seatNo) + '" aria-hidden="true"><span class="wager-stack"><i></i><i></i><i></i></span><strong>' + chips(pendingWagers[seatNo]) + '</strong></span>';
      }
    }

    var grid = byId("seat-grid");
    var felt = byId("felt");
    grid.innerHTML = html;
    var compact = window.innerWidth <= 820 || grid.clientWidth < 500;
    var heroHasActionSpace = currentHand && Boolean(ownSeat);
    var portraitSeats = {
      2: [[50, 91], [50, 9]],
      3: [[50, 91], [8, 18], [92, 18]],
      4: [[50, 91], [7, 74], [50, 10], [93, 74]],
      5: [[50, 91], [30, 68], [0, 32], [100, 32], [70, 68]],
      6: [[50, 91], [30, 68], [0, 32], [50, 10], [100, 32], [70, 68]],
      7: [[50, 91], [30, 68], [0, 32], [15, 10], [85, 10], [100, 32], [70, 68]],
      8: [[50, 91], [30, 68], [0, 32], [15, 10], [50, 10], [85, 10], [100, 32], [70, 68]],
      9: [[50, 90], [30, 61], [5, 84], [5, 31], [27, 10], [73, 10], [95, 31], [95, 84], [70, 61]]
    };
    var actionSeats = {
      2: [[50, 52], [50, 9]],
      3: [[50, 52], [8, 18], [92, 18]],
      4: [[50, 62], [15, 44], [50, 8], [85, 44]],
      5: [[50, 62], [15, 44], [20, 8], [80, 8], [85, 44]],
      6: [[50, 62], [15, 44], [14, 8], [50, 8], [86, 8], [85, 44]],
      7: [[50, 52], [14, 31], [0, 14], [15, 8], [85, 8], [100, 14], [86, 31]],
      8: [[50, 52], [14, 31], [0, 14], [15, 8], [50, 8], [85, 8], [100, 14], [86, 31]],
      9: [[50, 64], [16, 48], [5, 35], [12, 8], [38, 8], [62, 8], [88, 8], [95, 35], [84, 48]]
    };
    var phoneActionSeats = {
      2: [[15, 78], [96, 8]],
      3: [[15, 78], [50, 10], [92, 43]],
      4: [[15, 78], [5, 48], [50, 8], [95, 48]],
      5: [[15, 78], [5, 48], [25, 8], [75, 8], [95, 48]],
      6: [[15, 78], [5, 48], [15, 8], [50, 8], [85, 8], [95, 48]],
      7: [[15, 78], [5, 45], [15, 20], [38, 8], [62, 8], [85, 20], [95, 45]],
      8: [[15, 78], [5, 44], [15, 20], [32, 8], [50, 8], [68, 8], [85, 20], [95, 44]],
      9: [[15, 84], [10, 64], [10, 44], [10, 20], [35, 8], [60, 8], [85, 8], [95, 44], [95, 64]]
    };
    var desktopActionSeats = {
      2: [[24, 78], [76, 18]],
      3: [[24, 78], [50, 12], [88, 54]],
      4: [[24, 78], [8, 46], [50, 12], [92, 46]],
      5: [[24, 78], [7, 53], [26, 12], [70, 12], [92, 48]],
      6: [[24, 78], [7, 55], [18, 21], [50, 10], [82, 21], [93, 55]],
      7: [[24, 78], [7, 56], [17, 28], [38, 10], [66, 10], [85, 28], [93, 56]],
      8: [[24, 78], [7, 56], [16, 34], [31, 10], [50, 8], [69, 10], [84, 34], [93, 56]],
      9: [[20, 78], [5, 58], [5, 38], [15, 8], [38, 8], [62, 8], [85, 8], [95, 18], [95, 38]]
    };
    felt.classList.toggle("exposed-ring", positionCount >= 5 && Boolean((view.runout_odds || []).length));
    felt.dataset.compactLayout = compact ? "true" : "false";
    felt.classList.toggle("is-crowded", positionCount >= 7);
    felt.classList.toggle("has-action-space", heroHasActionSpace);
    felt.classList.toggle("is-playing", currentHand);
    felt.dataset.seatCount = String(positionCount);
    grid.querySelectorAll(".seat-card").forEach(function (node) {
      var relativeIndex = number(node.getAttribute("data-relative-seat"), 0);
      var x;
      var y;
      var viewportActionSeats = compact
        ? (window.innerWidth >= 381 && window.innerWidth <= 640 ? phoneActionSeats : actionSeats)
        : desktopActionSeats;
      if (heroHasActionSpace && viewportActionSeats[positionCount]) {
        x = viewportActionSeats[positionCount][relativeIndex][0];
        y = viewportActionSeats[positionCount][relativeIndex][1];
      } else if (compact && portraitSeats[positionCount]) {
        x = portraitSeats[positionCount][relativeIndex][0];
        y = portraitSeats[positionCount][relativeIndex][1];
      } else {
        var angle = (90 + relativeIndex * 360 / max) * Math.PI / 180;
        x = 50 + 50 * Math.cos(angle);
        y = 50 + 40 * Math.sin(angle);
      }
      var gridRect = grid.getBoundingClientRect();
      var halfWidth = node.offsetWidth / 2;
      var insetPercent = gridRect.width ? halfWidth / gridRect.width * 100 : 0;
      x = Math.max(insetPercent + 1, Math.min(99 - insetPercent, x));
      var halfHeightPercent = grid.clientHeight ? (node.offsetHeight / 2) / grid.clientHeight * 100 : 0;
      y = Math.max(halfHeightPercent + 1, Math.min(99 - halfHeightPercent, y));
      node.style.left = x.toFixed(2) + "%";
      node.style.top = y.toFixed(2) + "%";
    });

    var gridRect = grid.getBoundingClientRect();
    var blockers = [];
    var dock = boxForNode(byId("action-panel"), gridRect);
    var dockKey = view.id + ":" + Math.round(gridRect.width) + ":" + Math.round(gridRect.height);
    if (dock) state.seatDock = {key:dockKey, box:dock};
    else if (heroHasActionSpace && state.seatDock?.key === dockKey) dock = state.seatDock.box;
    if (dock) blockers.push(dock);
    if (currentHand && window.SitNgoLayout && gridRect.width && gridRect.height) {
      var avoid = ["board-cards", "board-caption", "pot-display", "street-label"].map(function (id) {
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
        nodes[i].style.left = (p.x/gridRect.width*100).toFixed(3) + "%";
        nodes[i].style.top = (p.y/gridRect.height*100).toFixed(3) + "%";
      });
    }
    grid.querySelectorAll(".seat-card").forEach(function (node) {
      var box = boxForNode(node, gridRect);
      if (box) blockers.push(box);
    });
    ["board-caption", "board-cards", "pot-display", "street-label"].forEach(function (id) {
      var box = boxForNode(byId(id), gridRect);
      if (box) blockers.push(box);
    });

    var seatNodeFor = function (seatNo) {
      return grid.querySelector('.seat-card[data-seat-no="' + seatNo + '"]');
    };
    grid.querySelectorAll(".dealer-marker").forEach(function (node) {
      var seatNo = String(node.getAttribute("data-marker-seat"));
      var spot = findBadgeSpot(node, seatNodeFor(seatNo), gridRect, blockers);
      if (!spot) return;
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

    Array.prototype.slice.call(grid.querySelectorAll(".seat-action")).sort(function (a, b) {
      return Number(b.classList.contains("kind-turn")) - Number(a.classList.contains("kind-turn"));
    }).forEach(function (node) {
      var seatNo = String(node.getAttribute("data-action-seat"));
      var spot = findBadgeSpot(node, seatNodeFor(seatNo), gridRect, blockers);
      if (!spot) {
        node.classList.add("is-unplaced");
        return;
      }
      addLayerPoint(node, gridRect, spot.x, spot.y);
      blockers.push(spot.box);
    });
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

    var fx = state.tableFx;
    var pot = number(view.pot, view.hand && view.hand.pot);
    var awards = Array.isArray(fx.awards) ? fx.awards : [];
    var pots = Array.isArray(fx.pots) ? fx.pots : [];
    var returns = Array.isArray(fx.returns) ? fx.returns : [];
    var hasSettlement = awards.length > 0 || pots.length > 0 || returns.length > 0;
    var payoutPending = Boolean((fx.currentItem && fx.currentItem.type === "payout") ||
      (fx.queue || []).some(function (item) { return item && item.type === "payout"; }));
    var payoutAmount = pots.reduce(function (sum, row) { return sum + number(row && row.amount, 0); }, 0) +
      returns.reduce(function (sum, row) { return sum + number(row && row.amount, 0); }, 0);
    if (!payoutAmount) {
      payoutAmount = awards.reduce(function (sum, row) { return sum + number(row && row.amount, 0); }, 0) +
        returns.reduce(function (sum, row) { return sum + number(row && row.amount, 0); }, 0);
    }
    byId("pot-amount").textContent = chips(payoutPending && pot === 0 ? payoutAmount : pot);
    byId("pot-label").textContent = "Pot";
    byId("pot-display").hidden = Boolean(hasSettlement && pot === 0 && !payoutPending);
    byId("street-label").textContent = view.street && view.street !== "lobby" ? String(view.street).replace(/_/g, " ").toUpperCase() : "";

    var resultNode = byId("hand-result");
    if (hasSettlement) {
      function nameFor(record) {
        var id = String(record && record.player_id || "");
        var seat = (Array.isArray(view.seats) ? view.seats : []).find(function (candidate) {
          return String(candidate.id || candidate.player_id || "") === id;
        });
        return String(record && (record.actor_label || record.name) || (seat && seat.name) || "Player");
      }
      function recipientMarkup(record, isReturn) {
        var amount = number(record && record.amount, 0);
        var id = String(record && record.player_id || "");
        var rank = String(record && record.rank || "");
        return '<span class="hand-result-recipient' + (isReturn ? ' is-return' : '') + '\"' +
          (id ? ' data-player-id=\"' + esc(id) + '\"' : '') + '><strong>' + esc(nameFor(record)) + '</strong><b>' +
          (isReturn ? 'Returned ' : '+') + chips(amount) + (isReturn ? '' : '') + '</b>' +
          (rank ? '<small>' + esc(rank) + '</small>' : '') + '</span>';
      }

      var resultParts = ['<span class="hand-result-title">HAND PAYOUT</span>'];
      if (pots.length) {
        pots.forEach(function (potRow, index) {
          var recipients = Array.isArray(potRow && potRow.recipients) ? potRow.recipients : [];
          var potIndex = number(potRow && potRow.pot_index, index);
          var title = potIndex === 0 ? "Main pot" : "Side pot " + (potIndex + 1);
          var amount = number(potRow && potRow.amount, recipients.reduce(function (sum, recipient) {
            return sum + number(recipient && recipient.amount, 0);
          }, 0));
          resultParts.push('<div class="hand-result-pot"><span class="hand-result-pot-title"><strong>' + esc(title) +
            '</strong><b>' + chips(amount) + ' chips</b></span><span class="hand-result-recipients">' +
            recipients.map(function (recipient) { return recipientMarkup(recipient, false); }).join("") + '</span></div>');
        });
      } else if (awards.length) {
        var fallbackAmount = awards.reduce(function (sum, award) { return sum + number(award && award.amount, 0); }, 0);
        resultParts.push('<div class="hand-result-pot"><span class="hand-result-pot-title"><strong>Pot payout</strong><b>' +
          chips(fallbackAmount) + ' chips</b></span><span class="hand-result-recipients">' +
          awards.map(function (award) { return recipientMarkup(award, false); }).join("") + '</span></div>');
      }
      if (returns.length) {
        resultParts.push('<div class="hand-result-returns"><span class="hand-result-returns-title">Uncalled chips returned</span><span class="hand-result-recipients">' +
          returns.map(function (record) { return recipientMarkup(record, true); }).join("") + '</span></div>');
      }
      resultNode.hidden = false;
      resultNode.innerHTML = resultParts.join("");
    } else {
      resultNode.hidden = true;
      resultNode.innerHTML = "";
    }
  }
  function renderBlindStrip(view) {
    var b = blindParts(view);
    var remaining = clockRemaining(b);
    var levelLength = number(view.config && view.config.level_minutes, number(view.level_minutes, 0));
    var seats = Array.isArray(view.seats) ? view.seats : [];
    var live = seats.filter(function (seat) { return number(seat.stack, 0) > 0; }).length;
    var entries = [
      { label: "Blinds", value: chips(b.small) + " / " + chips(b.big), note: "Small / big" },
      { label: "Level", value: String(b.level), note: remaining >= 0 ? "Next in " + formatClock(remaining) : (levelLength ? levelLength + " min levels" : "Blind level") },
      { label: "Players", value: String(live), note: "Still in" },
      { label: "Starting stack", value: chips(view.config && view.config.starting_stack), note: "Play chips" }
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
    if (view.status !== "completed" || !results.length) {
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
      var stack = row.chips != null ? row.chips : (row.stack != null ? row.stack : row.final_stack);
      var rowStatus = String(row.status || "").toLowerCase();
      var detail = row.detail || (place === 1 ? "Tournament winner" : (row.eliminated_at || rowStatus === "eliminated" ? "Eliminated" : (row.status || "Final result")));
      return '<div class="result-row" role="listitem"><span class="result-place ' + (place === 1 ? "first" : "") + '" aria-label="' + esc(placeAria) + '">' + placeLabel + '</span>' +
        '<span><span class="result-name">' + esc(name) + '</span><span class="result-detail">' + esc(row.award_cents == null ? detail : credits(row.award_cents) + ' play credits') + '</span></span>' +
        '<span class="result-stack">' + (stack == null ? "" : chips(stack) + " chips") + '</span></div>';
    }).join("");
  }
  function actionTokenKey(view) {
    return [state.activeTableId, number(view.hand_no, 0), number(view.turn_version, 0)].join(":");
  }

  function actionIntentIsCurrent(intent) {
    var view = state.tableView;
    var viewer = view && view.viewer || {};
    return Boolean(intent && state.activeTableId === intent.tableId && view &&
      view.status === "playing" && viewer.can_act &&
      number(view.hand_no, 0) === intent.payload.expected_hand &&
      number(view.turn_version, 0) === intent.payload.expected_turn_version);
  }

  function dismissAllInConfirmation(restoreFocus) {
    var intent = state.actionConfirmation;
    if (!intent) return;
    state.actionConfirmation = null;
    var dialog = byId("allInConfirm");
    if (dialog && dialog.open) dialog.close();
    if (!restoreFocus) return;
    window.setTimeout(function () {
      var panel = byId("action-panel");
      if (actionIntentIsCurrent(intent) && intent.trigger && intent.trigger.isConnected && panel && !panel.hidden && !intent.trigger.disabled) {
        intent.trigger.focus({ preventScroll: true });
      } else if (panel && !panel.hidden && panel.getClientRects().length) {
        var first = byId("action-controls").querySelector("button:not(:disabled), input:not(:disabled)");
        if (first) first.focus({ preventScroll: true });
      } else if (intent.trigger && intent.trigger.isConnected && document.activeElement === intent.trigger) {
        intent.trigger.blur();
      }
    }, 0);
  }

  function updateRaisePreview() {
    var input = byId("raise-amount");
    var view = state.tableView;
    if (!input || !view) return;
    var target = Number(input.value);
    var min = number(input.min, 0);
    var max = number(input.max, 0);
    var viewer = view.viewer || {};
    var playerId = String(viewer.player_id || (state.player && state.player.id) || "");
    var seat = (view.seats || []).find(function (item) {
      return String(item.id || item.player_id || "") === playerId;
    });
    var stack = number(seat && seat.stack, 0);
    var ownBet = number(seat && seat.bet, 0);
    var valid = Number.isInteger(target) && target >= min && target <= max;
    var paid = Math.min(stack, Math.max(0, target - ownBet));
    var actionName = number(view.current_bet, 0) > 0 ? "Raise" : "Bet";
    var isAllInTarget = stack > 0 && target === max && max === ownBet + stack;
    var button = byId("action-controls").querySelector('[data-poker-action="raise_to"]');
    input.setAttribute("aria-valuetext", valid
      ? actionName + " to " + chips(target) + " chips total; adds " + chips(paid) + (isAllInTarget ? "; all-in" : "")
      : "Choose a whole-chip total from " + chips(min) + " to " + chips(max));
    if (button) {
      var label = valid
        ? actionName + " to " + chips(target) + (isAllInTarget ? " · all-in" : "")
        : actionName + " amount";
      button.textContent = label;
      button.setAttribute("aria-label", valid ? label.replace(" · all-in", "") + " chips" + (isAllInTarget ? ", all-in" : "") : label);
      button.disabled = Boolean(state.actionPending || state.actionConfirmation || !valid);
    }
    byId("action-controls").querySelectorAll("[data-raise-preset]").forEach(function (preset) {
      preset.setAttribute("aria-pressed", String(number(preset.getAttribute("data-target"), -1) === target));
    });
  }

  function renderActions(view) {
    var panel = byId("action-panel");
    var viewer = view.viewer || {};
    var playing = view.status === "playing";
    var canAct = playing && Boolean(viewer.can_act);

    if (state.actionPending && state.actionPending.accepted && !actionIntentIsCurrent(state.actionPending)) {
      state.actionPending = null;
    }
    if (state.actionConfirmation && !actionIntentIsCurrent(state.actionConfirmation)) {
      dismissAllInConfirmation(true);
      showNotice("That turn changed, so the all-in confirmation was canceled. Review the updated action.", "info", false);
    }

    panel.hidden = !canAct;
    panel.setAttribute("aria-busy", String(Boolean(state.actionPending)));
    if (!playing || !canAct) {
      state.actionRenderKey = "";
      return;
    }

    var toCall = number(viewer.to_call, 0);
    var playerId = String(viewer.player_id || (state.player && state.player.id) || "");
    var seat = (view.seats || []).find(function (item) {
      return String(item.id || item.player_id || "") === playerId;
    });
    var stack = number(seat && seat.stack, 0);
    var ownBet = number(seat && seat.bet, 0);
    var currentBet = number(view.current_bet, 0);
    var callAmount = Math.min(stack, toCall);
    var callIsAllIn = stack > 0 && callAmount === stack && toCall > 0;
    var canRaise = viewer.raise_rights !== false;
    var maxRaise = viewer.max_raise_to == null ? ownBet + stack : number(viewer.max_raise_to, ownBet + stack);
    var minRaise = viewer.min_raise_to == null
      ? currentBet + number(view.min_raise, 0)
      : number(viewer.min_raise_to, currentBet + number(view.min_raise, 0));
    var hasRaiseSlider = stack > 0 && canRaise && maxRaise > currentBet;
    var shortAllInRaise = hasRaiseSlider && minRaise > maxRaise;
    var rangeMin = shortAllInRaise ? maxRaise : Math.max(currentBet + 1, minRaise);
    var draftKey = actionTokenKey(view);
    if (state.raiseDraftKey !== draftKey) {
      state.raiseDraftKey = draftKey;
      state.raiseDraftValue = null;
    }

    var suggested = Math.min(maxRaise, Math.max(rangeMin, number(viewer.suggested_raise_to, rangeMin)));
    if (!Number.isInteger(suggested)) suggested = Math.round(suggested);
    var draft = state.raiseDraftValue === null ? suggested : Number(state.raiseDraftValue);
    if (!Number.isInteger(draft) || draft < rangeMin || draft > maxRaise) draft = suggested;
    if (state.raiseDraftValue !== null && String(draft) !== state.raiseDraftValue) state.raiseDraftValue = String(draft);

    var street = String(view.street || "").toLowerCase();
    var preflop = street ? street === "preflop" : cardArray(view.board).length === 0;
    var bigBlind = Math.max(1, number(blindParts(view).big, number(view.config && view.config.big_blind, 1)));
    var potAfterCall = Math.max(0, number(view.pot, 0) + callAmount);
    var presetSpecs = preflop
      ? [{ label: "2.5 BB", bb: 2.5 }, { label: "3 BB", bb: 3 }, { label: "4 BB", bb: 4 }]
      : [{ label: "1/2 pot", fraction: 0.5 }, { label: "3/4 pot", fraction: 0.75 }, { label: "Pot", fraction: 1 }];
    presetSpecs = presetSpecs.map(function (preset) {
      var rawTarget = preflop
        ? Math.round(bigBlind * preset.bb)
        : currentBet + Math.round(potAfterCall * preset.fraction);
      var target = Math.max(rangeMin, Math.min(maxRaise, rawTarget));
      var adjusted = target !== rawTarget;
      return {
        label: preset.label,
        target: target,
        ariaLabel: "Set raise-to amount to " + chips(target) + " chips with the " + preset.label + " preset" +
          (preflop ? "" : " after calling") + (adjusted ? "; adjusted to the legal range" : "")
      };
    });
    var actionKey = JSON.stringify([
      state.activeTableId, number(view.hand_no, 0), number(view.turn_version, 0),
      street, number(view.pot, 0), bigBlind, presetSpecs.map(function (preset) { return preset.target; }),
      toCall, callAmount, callIsAllIn, stack, ownBet, currentBet, canRaise,
      minRaise, maxRaise, hasRaiseSlider, shortAllInRaise, rangeMin, suggested
    ]);
    var controls = "";
    if (toCall > 0) {
      var callLabel = "Call " + chips(callAmount) + " chips" + (callIsAllIn ? " · all-in" : "");
      controls += '<button class="button button-outline call-button" type="button" data-poker-action="call" aria-label="' + esc(callLabel) + '">' + esc(callLabel) + '</button>';
      controls += '<button class="button button-quiet" type="button" data-poker-action="fold">Fold</button>';
    } else {
      controls += '<button class="button button-outline call-button" type="button" data-poker-action="check">Check</button>';
    }

    if (hasRaiseSlider) {
      var actionName = currentBet > 0 ? "Raise" : "Bet";
      var maxIsAllIn = stack > 0 && maxRaise === ownBet + stack;
      var rangeText = shortAllInRaise
        ? "Short all-in · max " + chips(maxRaise)
        : "Min " + chips(rangeMin) + "–" + chips(maxRaise) + (maxIsAllIn ? " · all-in" : "");
      var presetMarkup = '<div class="raise-presets" role="group" aria-label="' +
        (preflop ? "Preflop raise sizes in big blinds" : "Postflop pot-size raises") + '">' +
        presetSpecs.map(function (preset) {
          return '<button class="button button-quiet raise-preset" type="button" data-raise-preset="true" data-target="' +
            preset.target + '" aria-pressed="false" aria-label="' + esc(preset.ariaLabel) + '" title="' +
            esc(preset.ariaLabel) + '">' + esc(preset.label) + '</button>';
        }).join("") + '</div>';
      controls += '<div class="raise-control" role="group" aria-labelledby="raise-label">' +
        '<label id="raise-label" for="raise-amount">' + actionName + ' amount</label>' +
        presetMarkup +
        '<input id="raise-amount" type="range" min="' + rangeMin + '" max="' + maxRaise + '" step="1" value="' + draft + '" aria-describedby="raise-range">' +
        '<span class="raise-range" id="raise-range">' + esc(rangeText) + '</span>' +
        '<button class="button button-primary" type="button" data-poker-action="raise_to" aria-label="' + actionName + ' to ' + chips(draft) + ' chips">' + actionName + ' to ' + chips(draft) + '</button></div>';
    }

    if (state.actionRenderKey !== actionKey) {
      var keepRaiseFocus = document.activeElement && document.activeElement.id === "raise-amount";
      byId("action-controls").innerHTML = controls;
      state.actionRenderKey = actionKey;
      if (keepRaiseFocus) {
        var newInput = byId("raise-amount");
        if (newInput) newInput.focus({ preventScroll: true });
      }
    }
    var blocked = Boolean(state.actionPending || state.actionConfirmation);
    byId("action-controls").querySelectorAll("button[data-poker-action], button[data-raise-preset]").forEach(function (button) {
      if (button.getAttribute("data-poker-action") !== "raise_to") button.disabled = blocked;
    });
    var raiseInput = byId("raise-amount");
    if (raiseInput) raiseInput.disabled = blocked;
    updateRaisePreview();
  }

  function renderLobbyControls(view, host, ownSeat, isSeated, layout) {
    var panel = byId("lobby-seat-panel");
    var controls = byId("seat-controls");
    var standButton = byId("stand-button");
    var statusTitle = byId("seat-status-title");
    var statusDescription = byId("seat-status-description");
    var visible = view.status === "lobby";
    panel.hidden = !visible;
    if (!visible) return;

    var viewer = view.viewer || {};
    if (isSeated) {
      statusTitle.textContent = host ? "You’re seated and hosting." : "You’re seated at the table.";
      statusDescription.textContent = host ? "Your host controls stay with you if you stand up." : "Stand up any time to watch without a seat.";
    } else if (host) {
      statusTitle.textContent = "You’re hosting from the rail.";
      statusDescription.textContent = "Your host controls stay yours. Choose a seat, or let guests watch.";
    } else {
      statusTitle.textContent = "You’re watching the table.";
      statusDescription.textContent = "Choose an open seat to join, or keep watching as a guest.";
    }

    standButton.hidden = !isSeated;
    var rows = [];
    for (var i = 0; i < layout.max; i += 1) {
      var occupant = layout.bySeat[i];
      var actions = "";
      if (!occupant && !isSeated) {
        actions += '<button class="button button-outline button-small" type="button" id="take-seat-' + i + '" data-take-seat="' + i + '">Take seat</button>';
      }
      if (host && !occupant) {
        actions += '<button class="button button-quiet button-small" type="button" id="add-bot-' + i + '" data-add-bot-seat="' + i + '">Add test bot</button>';
      } else if (host && occupant && isBotSeat(occupant)) {
        actions += '<button class="button button-quiet button-small" type="button" id="remove-bot-' + i + '" data-remove-bot-seat="' + i + '">Remove bot</button>';
      }
      if (!actions) continue;
      var label = occupant && isBotSeat(occupant) ? (occupant.name || "Test bot") : (occupant ? occupant.name || "Occupied" : "Open");
      rows.push('<div class="seat-choice' + (occupant ? ' has-bot' : '') + '"><span class="seat-choice-label">Seat ' + (i + 1) + (occupant ? ' · ' + esc(label) : ' · Open') + '</span><span class="seat-choice-actions">' + actions + '</span></div>');
    }
    controls.innerHTML = rows.length ? rows.join("") : '<p class="seat-controls-empty">' + (isSeated ? "No host seat changes are available right now." : "All seats are occupied. You can keep watching as a guest.") + '</p>';
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
  }

  function renderSettingsPanel(view, host) {
    var panel = byId("table-settings-form");
    var visible = host && view.status === "lobby";
    panel.hidden = !visible;
    if (!host || !visible) return;

    var tableId = String(view.id || state.activeTableId || "");
    if (state.settingsTableId !== tableId) {
      state.settingsTableId = tableId;
      state.settingsDirty = false;
      loadSettingsForm(view);
    } else if (!state.settingsDirty) {
      loadSettingsForm(view);
    }

    var locked = view.status !== "lobby";
    var inputs = panel.querySelectorAll("input, select");
    inputs.forEach(function (input) {
      input.disabled = locked || state.settingsSaving;
    });
    byId("save-settings-button").disabled = locked || state.settingsSaving || !state.settingsDirty;
    byId("settings-lock-note").textContent = locked ? "Settings lock when the first hand starts." : (state.settingsSaving ? "Saving table settings…" : (state.settingsDirty ? "Save changes before starting the freezeout." : "You can adjust this lobby until the first hand starts."));
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

  function renderTable() {
    var view = state.tableView;
    var hasTable = Boolean(view);
    byId("empty-state").hidden = hasTable;
    byId("table-view").hidden = !hasTable;
    byId("app-panel").classList.toggle("has-active-table", hasTable);
    if (!view) {
      if (state.actionConfirmation) dismissAllInConfirmation(true);
      state.actionRenderKey = "";
      byId("results-panel").hidden = true;
      byId("reopen-results-button").hidden = true;
      clearSeatTurnClock();
      byId("lobby-seat-panel").hidden = true;
      byId("host-panel").hidden = true;
      byId("table-settings-form").hidden = true;
      return;
    }

    consumeTableEvents(view);
    syncSeatTurnClock(view);
    var status = view.status || "lobby";
    var statusNode = byId("view-status");
    statusNode.textContent = statusName(status);
    statusNode.className = "status-pill" + (status === "playing" ? " playing" : (status === "completed" ? " completed" : ""));
    byId("view-table-name").textContent = view.name || "Sit-and-go";
    var layout = seatLayout(view);
    var seats = layout.seats;
    var max = layout.max;
    byId("view-table-subtitle").textContent = seats.length + " of " + max + " seats" + (view.prize_pool_cents == null ? "" : " · " + credits(view.prize_pool_cents) + " play credits in the pool") + (status === "lobby" && view.config ? " · Buy-in " + view.config.buy_in + " · " + view.config.payout_percentages.join(" / ") + "%" : "");
    byId("hand-number").textContent = number(view.hand_no, 0) > 0 ? "HAND " + number(view.hand_no, 0) : "NO HAND DEALT";
    byId("hand-status-label").textContent = status === "playing" ? "HAND IN PROGRESS" : (status === "completed" ? "TOURNAMENT COMPLETE" : "TABLE LOBBY");
    byId("table-player-count").textContent = seats.length + " seated · " + seats.filter(function (s) { return number(s.stack, 0) > 0; }).length + " still in";
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
    renderLobbyControls(view, host, ownSeat, seated, layout);
    renderSettingsPanel(view, host);
    updateHostReadiness(view, host);
  }

  function enterApp(player, csrf, sessionProof) {
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
    var previous = state.tableView;
    if (previous && previous.id === tableId) {
      // A poll sent before an action can arrive after its response. Never
      // rewind the board, odds, action controls, or countdown on a late poll.
      if (view.version < previous.version ||
          (view.version === previous.version && view.server_now < previous.server_now)) return false;
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
      if (activeHand && state.tableView.runout_at) {
        // Fetch just after the next deal, even at a one-second card pace.
        var untilDeal = (state.tableView.runout_at - state.tableView.server_now) * 1000;
        visibleDelay = Math.max(120, Math.min(visibleDelay, untilDeal + 35));
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
    return {
      buy_in: number(byId("settings-buy-in").value, 0),
      payout_percentages: payouts("settings-payout"),
      name: byId("settings-table-name").value.trim(),
      max_seats: number(byId("settings-max-seats").value, 0),
      starting_stack: number(byId("settings-starting-stack").value, 0),
      small_blind: number(byId("settings-small-blind").value, 0),
      big_blind: number(byId("settings-big-blind").value, 0),
      level_minutes: number(byId("settings-level-minutes").value, 0),
      turn_seconds: number(byId("settings-turn-seconds").value, 0),
      runout_seconds: number(byId("settings-runout-seconds").value, 0)
    };
  }

  async function saveSettings() {
    if (!state.activeTableId || !state.tableView || state.settingsSaving) return;
    var payload;
    try { payload = settingsPayload(); } catch (err) { showNotice(err.message, "error", false); return; }
    var form = byId("table-settings-form");
    if (!form.checkValidity() || !payload.name || payload.max_seats < 2 || payload.max_seats > 9 ||
        payload.starting_stack < 100 || payload.small_blind < 1 || payload.big_blind <= payload.small_blind ||
        payload.level_minutes < 0.01 || payload.turn_seconds < 1 || payload.runout_seconds < 1) {
      showNotice("Check the table name, seats, stack, blinds, and timers.", "error", false);
      return;
    }
    var currentSeats = Array.isArray(state.tableView.seats) ? state.tableView.seats.length : 0;
    if (payload.max_seats < currentSeats) {
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
      showNotice("Table settings saved.", "success", false);
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

  function actionIntentFor(action, view, trigger) {
    var viewer = view.viewer || {};
    var playerId = String(viewer.player_id || (state.player && state.player.id) || "");
    var seat = (view.seats || []).find(function (item) {
      return String(item.id || item.player_id || "") === playerId;
    });
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
    var usesWholeStack = false;

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
      usesWholeStack = stack > 0 && paid === stack && amount === number(viewer.max_raise_to, ownBet + stack);
    } else {
      payload.action = action;
      if (action === "call") {
        paid = Math.min(toCall, stack);
        target = ownBet + paid;
        usesWholeStack = stack > 0 && paid === stack;
      } else if (action === "all_in") {
        paid = stack;
        target = ownBet + stack;
        usesWholeStack = stack > 0;
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
      description = "call for " + chips(paid) + " chips" + (usesWholeStack ? " · all-in" : "");
      successMessage = "Call recorded: " + chips(paid) + " chips" + (usesWholeStack ? " · all-in." : ".");
    } else if (action === "all_in") {
      if (target > currentBet) {
        var allInVerb = currentBet > 0 ? "raise" : "bet";
        description = "all-in " + allInVerb + " to " + chips(target) + " chips";
        successMessage = "All-in " + allInVerb + " recorded: " + chips(paid) + " chips added to reach " + chips(target) + " total.";
      } else {
        description = "all-in call for " + chips(paid) + " chips";
        successMessage = "All-in call recorded: " + chips(paid) + " chips.";
      }
    } else {
      var raiseVerb = payload.action === "raise" ? "raise" : "bet";
      description = raiseVerb + " to " + chips(target) + " total (adds " + chips(paid) + " chips)";
      successMessage = (payload.action === "raise" ? "Raise" : "Bet") + " recorded: " + chips(paid) + " chips added to reach " + chips(target) + " total.";
    }

    var confirmationMessage = "";
    if (usesWholeStack) {
      if (action === "call") {
        confirmationMessage = "Calling " + chips(paid) + " chips uses your entire remaining stack. Continue with the all-in call?";
      } else if (action === "all_in" && target > currentBet) {
        confirmationMessage = "This all-in " + (currentBet > 0 ? "raise" : "bet") + " adds " + chips(paid) + " chips to reach " + chips(target) + " total on this street. It uses your entire remaining stack. Continue?";
      } else if (action === "all_in") {
        confirmationMessage = "This call puts all " + chips(paid) + " chips left in your stack into the pot. Continue with the all-in call?";
      } else {
        confirmationMessage = "This " + (payload.action === "raise" ? "raise" : "bet") + " adds " + chips(paid) + " chips to reach " + chips(target) + " total on this street. It uses your entire remaining stack. Continue with the all-in?";
      }
    }

    return {
      tableId: state.activeTableId,
      payload: payload,
      action: action,
      paid: paid,
      target: target,
      wholeStackAmount: stack,
      usesWholeStack: usesWholeStack,
      confirmationMessage: confirmationMessage,
      pendingMessage: "Submitting " + description + "…",
      successMessage: successMessage,
      trigger: trigger
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
    showActionFeedback(intent.pendingMessage, "info", true);
    try {
      await mutate("/tables/" + encodeURIComponent(intent.tableId) + "/action", intent.payload);
      intent.accepted = true;
      showActionFeedback(intent.successMessage, "success", false);
      try {
        await refreshSelected();
      } catch (refreshError) {
        if (refreshError.status !== 401) {
          showActionFeedback(intent.successMessage + " The table is waiting for its next refresh.", "success", true);
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
    if (!intent || state.actionPending || state.actionConfirmation) return;
    if (!actionIntentIsCurrent(intent)) {
      showNotice("That turn changed before the action was sent. Review the refreshed table.", "info", false);
      refreshSelected().catch(function () {});
      return;
    }
    if (!intent.usesWholeStack) {
      submitActionIntent(intent);
      return;
    }
    state.actionConfirmation = intent;
    byId("allInConfirmDescription").textContent = intent.confirmationMessage;
    byId("confirm-all-in-button").textContent = "Commit " + chips(intent.wholeStackAmount) + " chips";
    var dialog = byId("allInConfirm");
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    renderActions(state.tableView);
    byId("cancel-all-in-button").focus();
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
      (e.returns || []).forEach(function (w) {lines.push("Uncalled: " + chips(w.amount) + " returned to " + (w.actor_label || "player"));});
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
  byId("history-button").addEventListener("click", function () {byId("history-dialog").showModal(); loadHistory("");});
  byId("history-close").addEventListener("click", function () {byId("history-dialog").close();});
  byId("history-dialog").addEventListener("close", function () {historyGeneration++; byId("history-content").replaceChildren();});
  byId("history-content").addEventListener("click", function (e) {
    var btn=e.target.closest("button");
    if (btn?.hasAttribute("data-history-table")) loadHistory(btn.dataset.historyTable);
    else if (btn?.hasAttribute("data-history-list")) loadHistory("");
    else if (btn?.hasAttribute("data-history-offset")) loadHistory(byId("history-content").dataset.table, Number(btn.dataset.historyOffset));
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
        runout_seconds: number(byId("runout-seconds").value, 2.5)
      });
      var table = data.table || data;
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

  byId("seat-controls").addEventListener("click", async function (event) {
    var button = event.target.closest("[data-take-seat], [data-add-bot-seat], [data-remove-bot-seat]");
    if (!button || button.disabled || !state.activeTableId) return;
    var rawSeatNo = button.hasAttribute("data-take-seat") ? button.getAttribute("data-take-seat") :
      (button.hasAttribute("data-add-bot-seat") ? button.getAttribute("data-add-bot-seat") : button.getAttribute("data-remove-bot-seat"));
    var seatNo = number(rawSeatNo, -1);
    if (seatNo < 0) return;
    button.disabled = true;
    try {
      var message;
      if (button.hasAttribute("data-take-seat")) {
        await mutate("/tables/" + encodeURIComponent(state.activeTableId) + "/seat", { seat_no: seatNo });
        message = "You took Seat " + (seatNo + 1) + ".";
      } else if (button.hasAttribute("data-add-bot-seat")) {
        await mutate("/tables/" + encodeURIComponent(state.activeTableId) + "/bots", { seat_no: seatNo });
        message = "A test bot joined Seat " + (seatNo + 1) + ".";
      } else {
        await mutate("/tables/" + encodeURIComponent(state.activeTableId) + "/bots/" + seatNo, undefined, "DELETE");
        message = "The test bot left Seat " + (seatNo + 1) + ".";
      }
      await refreshSelected();
      await refreshAll(true);
      showNotice(message, "success", false);
    } catch (err) {
      showNotice(err.message, "error", false);
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  });

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

  byId("action-controls").addEventListener("input", function (event) {
    if (event.target && event.target.id === "raise-amount") {
      state.raiseDraftKey = actionTokenKey(state.tableView || {});
      state.raiseDraftValue = event.target.value;
      updateRaisePreview();
    }
  });

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
      if (preset.disabled || state.actionPending || state.actionConfirmation) return;
      var presetView = state.tableView;
      var raiseInput = byId("raise-amount");
      var presetTarget = Number(preset.getAttribute("data-target"));
      if (!presetView || !presetView.viewer || !presetView.viewer.can_act || !raiseInput || !Number.isInteger(presetTarget)) return;
      state.raiseDraftKey = actionTokenKey(presetView);
      state.raiseDraftValue = String(presetTarget);
      raiseInput.value = String(presetTarget);
      updateRaisePreview();
      return;
    }
    var button = event.target.closest("[data-poker-action]");
    if (!button || button.disabled || state.actionPending || state.actionConfirmation) return;
    var view = state.tableView;
    if (!view || !view.viewer || !view.viewer.can_act) return;
    var intent = actionIntentFor(button.getAttribute("data-poker-action"), view, button);
    if (intent) beginActionIntent(intent);
  });

  byId("allInConfirm").addEventListener("click", function (event) {
    var button = event.target.closest("[data-action]");
    if (!button) return;
    var action = button.getAttribute("data-action");
    var intent = state.actionConfirmation;
    if (action === "cancel-all-in") {
      dismissAllInConfirmation(false);
      if (state.tableView) renderActions(state.tableView);
      if (intent && intent.trigger && intent.trigger.isConnected && !intent.trigger.disabled) intent.trigger.focus();
      return;
    }
    if (action !== "confirm-all-in" || !intent || state.actionPending) return;
    if (!actionIntentIsCurrent(intent)) {
      dismissAllInConfirmation(true);
      showNotice("That turn changed, so the all-in was canceled. Review the refreshed action.", "info", false);
      refreshSelected().catch(function () {});
      return;
    }
    dismissAllInConfirmation(false);
    submitActionIntent(intent);
  });

  byId("allInConfirm").addEventListener("cancel", function () {
    var intent = state.actionConfirmation;
    state.actionConfirmation = null;
    if (state.tableView) renderActions(state.tableView);
    if (intent && intent.trigger && intent.trigger.isConnected && !intent.trigger.disabled) intent.trigger.focus();
  });

  window.addEventListener("resize", function () {
    if (state.tableView) renderSeats(state.tableView);
  });

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && state.polling) refreshAll(true);
  });

  loadAuth();
  boot();
}());

