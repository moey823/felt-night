(function () {
  "use strict";

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
    polling: false,
    refreshBusy: false,
    refreshTimer: 0,
    refreshPending: false,
    inviteCopiedFor: "",
    inviteResetTimer: 0,
    noticeTimer: 0,
    settingsTableId: "",
    settingsDirty: false,
    settingsSaving: false,
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
      revealed: {},
      awards: [],
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

  function clearNotice() {
    showNotice("", "info", true);
  }

  function setLoggedOut(message) {
    state.player = null;
    clearAuth();
    state.tableView = null;
    state.tables = [];
    state.activeTableId = "";
    state.skipAutoResume = false;
    state.polling = false;
    state.refreshPending = false;
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

    if (response.status === 401 && path !== "/login") {
      setLoggedOut("Your room session has expired. Enter the room password to continue.");
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
    } else if (event.type === "reveal") {
      (Array.isArray(event.hands) ? event.hands : []).forEach(function (hand) {
        var id = String(hand && hand.player_id || "");
        if (id && Array.isArray(hand.cards)) fx.revealed[id] = hand.cards;
      });
    } else if (event.type === "showdown_result" || event.type === "payout") {
      fx.awards = Array.isArray(event.winners) ? event.winners : [];
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
    fx.revealed = {};
    fx.awards = [];
    fx.displayWagers = {};
    fx.wagerPositions = {};
    fx.eventAware = Array.isArray(events);
    fx.lastSeq = 0;
    (events || []).forEach(function (event) {
      rememberTableEvent(event);
      fx.lastSeq = Math.max(fx.lastSeq, number(event && event.seq, -1));
    });
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
      fx.lastSeq = 0;
      var replayNewHand = handChanged && Boolean(handId) && Array.isArray(events) && baseSeq <= 1;
      if (replayNewHand) {
        fx.generation += 1;
        fx.actions = {};
        fx.revealed = {};
        fx.awards = [];
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
      } else {
        snapshotTableEffects(view, events);
      }
      return;
    }

    if (!events) return;
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

  function motionAllowed() {
    if (document.hidden) return false;
    return !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function animateChip(layer, start, end, amount, duration) {
    if (!motionAllowed() || !layer || !start || !end || typeof layer.animate !== "function") return Promise.resolve();
    var bounds = layer.getBoundingClientRect();
    var chip = document.createElement("span");
    chip.className = "chip-flight";
    chip.textContent = chips(amount);
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
      if (stillCurrent() && state.tableView) renderSeats(state.tableView);
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
    var actorId = String(view.actor_id || view.to_act_id || "");
    var buttonId = String(view.button_id || "");
    var currentHand = view.status === "playing";
    var fx = state.tableFx;
    var pendingWagers = queuedWagerAmounts(fx);
    var html = "";

    for (var i = 0; i < max; i += 1) {
      var seat = bySeat[i];
      var relativeIndex = (i - anchorSeatNo + max) % max;
      if (!seat) {
        html += '<div class="seat-card seat-empty" data-seat-no="' + i + '" data-relative-seat="' + relativeIndex + '" data-seat-empty="true"><span>Seat ' + (i + 1) + '</span><span>Open</span></div>';
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

      var cardHtml = "";
      if (cards.length) {
        cardHtml = '<div class="seat-cards' + (exposed ? ' is-exposed' : ' is-viewer-cards') + '">' + cards.map(function (card) { return playingCardHTML(card, true); }).join("") + '</div>';
      } else if (currentHand && !folded && (stack > 0 || allIn)) {
        cardHtml = '<div class="seat-cards">' + hiddenCardHTML(true, false) + hiddenCardHTML(true, false) + '</div>';
      }

      var tags = (hostId === id ? '<span class="seat-label">HOST</span>' : '') +
        (isMe ? '<span class="seat-label">YOU</span>' : '') +
        (bot ? '<span class="seat-label bot-label">TEST BOT</span>' : '');
      html += '<div class="' + classes + '" data-seat-no="' + esc(seatNo) + '" data-relative-seat="' + relativeIndex + '" data-is-bot="' + (bot ? 'true' : 'false') + '">' +
        '<div class="seat-top"><span class="seat-name-wrap"><span class="seat-name">' + esc(seat.name || (bot ? "Test bot" : "Player")) + '</span><span class="seat-number">#' + (i + 1) + '</span></span></div>' +
        '<div class="seat-tags">' + tags + '</div>' +
        '<div class="seat-stack">' + chips(stack) + ' <span class="seat-number">chips</span></div>' +
        '<div class="seat-detail"><span>' + esc(label) + '</span></div>' +
        cardHtml +
      '</div>';
      if (dealer) html += '<span class="dealer-marker" data-marker-seat="' + esc(seatNo) + '" aria-label="Dealer button">D</span>';
      if (actionState) html += '<span class="seat-action kind-' + esc(actionState.kind || "action") + '" data-action-seat="' + esc(seatNo) + '" aria-label="' + esc((seat.name || "Player") + ": " + actionState.label) + '"><span class="seat-action-full">' + esc(actionState.label) + '</span><span class="seat-action-short">' + esc(actionState.compactLabel || actionState.label) + '</span></span>';
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
    var portraitSeats = {
      2: [[50, 91], [50, 9]],
      3: [[50, 91], [8, 18], [92, 18]],
      4: [[50, 91], [7, 74], [50, 10], [93, 74]],
      5: [[50, 91], [28, 73], [6, 24], [94, 24], [72, 73]],
      6: [[50, 91], [31, 73], [5, 24], [50, 10], [95, 24], [69, 73]],
      7: [[50, 91], [30, 73], [0, 90], [0, 28], [50, 10], [100, 28], [70, 73]],
      8: [[50, 91], [30, 73], [0, 90], [0, 28], [28, 10], [72, 10], [100, 28], [70, 73]],
      9: [[50, 91], [30, 73], [0, 90], [0, 28], [28, 10], [72, 10], [100, 28], [100, 90], [70, 73]]
    };
    felt.dataset.compactLayout = compact ? "true" : "false";
    felt.classList.toggle("is-crowded", max >= 7);
    grid.querySelectorAll(".seat-card").forEach(function (node) {
      var relativeIndex = number(node.getAttribute("data-relative-seat"), 0);
      var x;
      var y;
      if (compact && portraitSeats[max]) {
        x = portraitSeats[max][relativeIndex][0];
        y = portraitSeats[max][relativeIndex][1];
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
    grid.querySelectorAll(".seat-card").forEach(function (node) {
      var box = boxForNode(node, gridRect);
      if (box) blockers.push(box);
    });
    ["board-caption", "board-cards", "pot-display", "street-label", "hand-result"].forEach(function (id) {
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
    var pot = number(view.pot, view.hand && view.hand.pot);
    byId("pot-amount").textContent = chips(pot);
    byId("pot-label").textContent = "Pot";
    byId("street-label").textContent = view.street && view.street !== "lobby" ? String(view.street).replace(/_/g, " ").toUpperCase() : "";
    var awards = Array.isArray(state.tableFx.awards) ? state.tableFx.awards : [];
    byId("pot-display").hidden = Boolean(awards.length && pot === 0);
    var resultNode = byId("hand-result");
    if (awards.length) {
      resultNode.hidden = false;
      resultNode.innerHTML = '<span class="hand-result-title">HAND PAYOUT</span>' + awards.map(function (award) {
        var name = String(award.actor_label || award.name || "Player");
        return '<span class="hand-result-winner"><strong>' + esc(name) + '</strong><span>+' + chips(award.amount) + '</span></span>';
      }).join("");
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
    var results = Array.isArray(view.results) ? view.results : [];
    if (view.status !== "completed" || !results.length) {
      panel.hidden = view.status !== "completed";
      byId("results-list").innerHTML = "";
      return;
    }
    panel.hidden = false;
    byId("results-list").innerHTML = results.map(function (row, index) {
      var place = number(row.place != null ? row.place : row.rank, index + 1);
      var name = row.name || row.player_name || "Player";
      var stack = row.stack != null ? row.stack : row.final_stack;
      var detail = row.detail || (place === 1 ? "Tournament winner" : (row.eliminated_at ? "Eliminated" : "Final result"));
      return '<div class="result-row"><span class="result-place ' + (place === 1 ? "first" : "") + '">' + place + '</span>' +
        '<span><span class="result-name">' + esc(name) + '</span><span class="result-detail">' + esc(detail) + '</span></span>' +
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
      if (intent.trigger && intent.trigger.isConnected && panel && !panel.hidden && !intent.trigger.disabled) {
        intent.trigger.focus();
      } else if (panel && !panel.hidden) {
        var first = byId("action-controls").querySelector("button:not(:disabled)");
        if (first) first.focus();
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
    var projection = byId("raise-projection");
    var button = byId("action-controls").querySelector('[data-poker-action="raise_to"]');
    if (projection) {
      projection.textContent = valid
        ? "Adds " + chips(paid) + " chips to reach " + chips(target) + " total on this street."
        : "Choose a whole-chip total from " + chips(min) + " to " + chips(max) + ".";
    }
    if (button) {
      var actionName = number(view.current_bet, 0) > 0 ? "Raise" : "Bet";
      button.textContent = valid
        ? actionName + " to " + chips(target) + (target === max ? " · all-in" : "")
        : actionName + " amount";
      button.disabled = Boolean(state.actionPending || state.actionConfirmation || !valid);
    }
  }

  function renderActions(view) {
    var panel = byId("action-panel");
    var waitPanel = byId("wait-panel");
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
    waitPanel.hidden = !playing || canAct;
    var actorId = String(view.actor_id || view.to_act_id || "");
    var actor = (view.seats || []).find(function (seat) {
      return String(seat.id || seat.player_id || "") === actorId;
    });
    if (!playing) {
      state.actionRenderKey = "";
      return;
    }
    if (!canAct) {
      state.actionRenderKey = "";
      if (actor) {
        byId("wait-title").textContent = esc(actor.name || "Another player") + " is acting";
        var waitDeadline = number(view.turn_deadline, 0);
        var waitSeconds = -1;
        if (waitDeadline > 0) {
          var waitStamp = waitDeadline < 100000000000 ? waitDeadline * 1000 : waitDeadline;
          waitSeconds = Math.max(0, Math.floor((waitStamp - Date.now()) / 1000));
        }
        byId("wait-description").textContent = waitSeconds >= 0 ? "The turn clock has " + formatClock(waitSeconds) + " left." : "The table will update as play continues.";
      } else if (viewer.seated) {
        byId("wait-title").textContent = "Waiting for the next hand";
        byId("wait-description").textContent = "Your seat stays at the table while the tournament continues.";
      } else {
        byId("wait-title").textContent = "Watching the table";
        byId("wait-description").textContent = "Join during the lobby phase to take a seat.";
      }
      return;
    }
    byId("action-title").textContent = "Choose an action";
    var deadline = number(view.turn_deadline, 0);
    var seconds = -1;
    if (deadline > 0) {
      var stamp = deadline < 100000000000 ? deadline * 1000 : deadline;
      seconds = Math.max(0, Math.floor((stamp - Date.now()) / 1000));
    }
    byId("turn-clock").textContent = seconds >= 0 ? "Auto-action in " + formatClock(seconds) : "";

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
    var maxRaise = number(viewer.max_raise_to, ownBet + stack);
    var minRaise = number(viewer.min_raise_to, currentBet + number(view.min_raise, 0));
    var raising = canRaise && maxRaise > currentBet && minRaise > 0 && maxRaise >= minRaise;
    var draftKey = actionTokenKey(view);
    if (state.raiseDraftKey !== draftKey) {
      state.raiseDraftKey = draftKey;
      state.raiseDraftValue = null;
    }

    var summary = toCall > 0
      ? "You owe " + chips(toCall) + " chips. " + (callIsAllIn
        ? "Calling puts all " + chips(stack) + " chips left in your stack into the pot."
        : "Your remaining stack is " + chips(stack) + " chips.")
      : "No bet to call. Check is free. Your remaining stack is " + chips(stack) + " chips.";
    byId("action-guidance").textContent = summary;

    var actionKey = JSON.stringify([
      state.activeTableId, number(view.hand_no, 0), number(view.turn_version, 0),
      toCall, callAmount, callIsAllIn, stack, ownBet, currentBet, canRaise,
      minRaise, maxRaise, raising
    ]);
    var controls = "";
    if (toCall > 0) {
      var callLabel = "Call " + chips(callAmount) + " chips" + (callIsAllIn ? " · all-in" : "");
      controls += '<button class="button button-outline call-button" type="button" data-poker-action="call" aria-label="' + esc(callLabel) + '">' + esc(callLabel) + '</button>';
      controls += '<button class="button button-quiet" type="button" data-poker-action="fold">Fold</button>';
    } else {
      controls += '<button class="button button-outline call-button" type="button" data-poker-action="check">Check</button>';
    }

    var allInRaises = stack > 0 && canRaise && maxRaise > currentBet;
    if (allInRaises && !callIsAllIn) {
      controls += '<button class="button button-quiet all-in-button" type="button" data-poker-action="all_in" aria-label="All in with ' + chips(stack) + ' chips">All-in · ' + chips(stack) + ' chips</button>';
    }

    if (raising) {
      var isRaise = currentBet > 0;
      var raiseLabel = isRaise ? "Raise to" : "Bet to";
      var suggested = Math.min(maxRaise, Math.max(minRaise, number(viewer.suggested_raise_to, minRaise)));
      var inputValue = state.raiseDraftValue !== null ? state.raiseDraftValue : String(suggested);
      controls += '<div class="raise-control"><label for="raise-amount">' + raiseLabel + ' (total)</label>' +
        '<input id="raise-amount" type="number" inputmode="numeric" min="' + minRaise + '" max="' + maxRaise + '" step="1" value="' + esc(inputValue) + '" aria-label="' + raiseLabel + ' total street contribution" aria-describedby="raise-range raise-projection">' +
        '<button class="button button-primary" type="button" data-poker-action="raise_to">' + raiseLabel + ' ' + chips(number(inputValue, suggested)) + '</button>' +
        '<span class="raise-range" id="raise-range">Min ' + chips(minRaise) + ' · max ' + chips(maxRaise) + ' total</span>' +
        '<span class="raise-projection" id="raise-projection"></span></div>';
    } else if (!canRaise && toCall > 0) {
      controls += '<span class="action-disabled-note">Raising is closed after a short all-in.</span>';
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
    byId("action-controls").querySelectorAll("button[data-poker-action]").forEach(function (button) {
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
    byId("settings-table-name").value = view.name || "";
    byId("settings-max-seats").value = String(number(config.max_seats, number(view.max_seats, 6)));
    byId("settings-starting-stack").value = String(number(config.starting_stack, number(view.starting_stack, 1000)));
    byId("settings-small-blind").value = String(number(config.small_blind, number(view.small_blind, 10)));
    byId("settings-big-blind").value = String(number(config.big_blind, number(view.big_blind, 20)));
    byId("settings-level-minutes").value = String(number(config.level_minutes, number(view.level_minutes, 5)));
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
      byId("lobby-seat-panel").hidden = true;
      byId("host-panel").hidden = true;
      byId("table-settings-form").hidden = true;
      return;
    }

    consumeTableEvents(view);
    var status = view.status || "lobby";
    var statusNode = byId("view-status");
    statusNode.textContent = statusName(status);
    statusNode.className = "status-pill" + (status === "playing" ? " playing" : (status === "completed" ? " completed" : ""));
    byId("view-table-name").textContent = view.name || "Sit-and-go";
    var layout = seatLayout(view);
    var seats = layout.seats;
    var max = layout.max;
    var hostName = view.host_name || "Host";
    byId("view-table-subtitle").textContent = "Hosted by " + hostName + " · " + seats.length + " of " + max + " seats";
    byId("hand-number").textContent = number(view.hand_no, 0) > 0 ? "HAND " + number(view.hand_no, 0) : "NO HAND DEALT";
    byId("hand-status-label").textContent = status === "playing" ? "HAND IN PROGRESS" : (status === "completed" ? "TOURNAMENT COMPLETE" : "TABLE LOBBY");
    byId("table-player-count").textContent = seats.length + " seated · " + seats.filter(function (s) { return number(s.stack, 0) > 0; }).length + " still in";
    byId("button-caption").textContent = view.status === "playing" ? "Dealer button moves each hand" : "Play chips · No rebuys";

    renderBlindStrip(view);
    renderBoard(view);
    renderSeats(view);
    renderLog(view);
    renderResults(view);
    renderActions(view);
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
      if (data.authenticated && state.sessionProof && data.csrf) {
        state.activeTableId = hashTableId();
        enterApp(data.player, data.csrf, state.sessionProof);
      } else if (data.authenticated || state.sessionProof) {
        setLoggedOut("Your room session could not be restored. Enter the room password again.");
      } else {
        setLoggedOut("");
      }
    } catch (err) {
      if (err.status !== 401) showNotice(err.message, "error", true);
      byId("login-panel").hidden = false;
      byId("app-panel").hidden = true;
    }
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

      if (state.activeTableId) {
        try {
          var detail = await request("/tables/" + encodeURIComponent(state.activeTableId));
          state.tableView = detail.table || detail;
          renderTable();
        } catch (err) {
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
      var delay = state.refreshPending ? 0 : (document.hidden ? 8000 : (activeHand ? 900 : 2800));
      state.refreshPending = false;
      scheduleRefresh(delay);
    }
  }

  async function mutate(path, body, method) {
    return request(path, { method: method || "POST", body: body, mutate: true });
  }

  function settingsPayload() {
    return {
      name: byId("settings-table-name").value.trim(),
      max_seats: number(byId("settings-max-seats").value, 0),
      starting_stack: number(byId("settings-starting-stack").value, 0),
      small_blind: number(byId("settings-small-blind").value, 0),
      big_blind: number(byId("settings-big-blind").value, 0),
      level_minutes: number(byId("settings-level-minutes").value, 0)
    };
  }

  async function saveSettings() {
    if (!state.activeTableId || !state.tableView || state.settingsSaving) return;
    var payload = settingsPayload();
    var form = byId("table-settings-form");
    if (!form.checkValidity() || !payload.name || payload.max_seats < 2 || payload.max_seats > 9 ||
        payload.starting_stack < 100 || payload.small_blind < 1 || payload.big_blind <= payload.small_blind ||
        [3, 5, 8, 10, 15].indexOf(payload.level_minutes) === -1) {
      showNotice("Check the table name, seat count, stack, blinds, and level length.", "error", false);
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
    var data = await request("/tables/" + encodeURIComponent(state.activeTableId));
    state.tableView = data.table || data;
    renderTable();
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
        showNotice("Choose a whole-chip bet or raise total within the displayed range.", "error", false);
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
    showNotice(intent.pendingMessage, "info", true);
    try {
      await mutate("/tables/" + encodeURIComponent(intent.tableId) + "/action", intent.payload);
      intent.accepted = true;
      showNotice(intent.successMessage, "success", false);
      try {
        await refreshSelected();
      } catch (refreshError) {
        if (refreshError.status !== 401) {
          showNotice(intent.successMessage + " The table is waiting for its next refresh.", "success", true);
        }
      }
      try { await refreshAll(true); } catch (refreshError) {}
    } catch (err) {
      if (err.status === 409) {
        showNotice("The hand or turn changed before that action arrived. Review the refreshed table.", "info", false);
      } else {
        showNotice(err.message, "error", false);
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
      showNotice("Enter your table name and the room password.", "error", false);
      return;
    }
    var submit = event.currentTarget.querySelector('button[type="submit"]');
    submit.disabled = true;
    submit.querySelector("span").textContent = "Opening room…";
    try {
      var data = await request("/login", { method: "POST", body: { name: name, password: password } });
      byId("login-password").value = "";
      state.activeTableId = hashTableId();
      if (!data.session_proof || !data.csrf) throw new apiError("The room did not issue complete session credentials. Try signing in again.", 500, "missing_session_proof");
      enterApp(data.player, data.csrf, data.session_proof);
    } catch (err) {
      byId("login-password").value = "";
      showNotice(err.message, "error", false);
    } finally {
      submit.disabled = false;
      submit.querySelector("span").textContent = "Enter the room";
    }
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
        name: byId("table-name").value.trim(),
        max_seats: number(byId("max-seats").value, 6),
        starting_stack: number(byId("starting-stack").value, 1000),
        small_blind: small,
        big_blind: big,
        level_minutes: number(byId("level-minutes").value, 5)
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

  byId("close-table-button").addEventListener("click", function () {
    state.activeTableId = "";
    state.skipAutoResume = true;
    state.tableView = null;
    setHashTable("");
    renderTables();
    renderTable();
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

