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
    settingsSaving: false
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
    if (small) return '<span class="' + cls + '" aria-label="' + esc(rank + " " + suit.symbol) + '">' + esc(rank) + esc(suit.symbol) + '</span>';
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
      var host = hostId === id;
      var classes = "seat-card" + (isMe ? " is-me" : "") + (acting ? " is-acting" : "") + (folded ? " is-folded" : "") + (bot ? " is-bot" : "");
      var label = folded ? "Folded" : (allIn ? "All in" : "");
      var seatBet = number(seat.bet != null ? seat.bet : seat.street_bet, 0);
      var stack = number(seat.stack, 0);
      var cards = [];
      if (isMe) {
        cards = cardArray(viewer.hole_cards);
        if (!cards.length) cards = cardArray(seat.hole_cards);
      } else if (Array.isArray(seat.cards)) {
        cards = seat.cards;
      } else if (Array.isArray(seat.revealed_cards)) {
        cards = seat.revealed_cards;
      }

      var cardHtml = "";
      if (cards.length) {
        cardHtml = '<div class="seat-cards">' + cards.map(function (card) { return playingCardHTML(card, true); }).join("") + '</div>';
      } else if (currentHand && !folded && (stack > 0 || allIn)) {
        cardHtml = '<div class="seat-cards">' + hiddenCardHTML(true, false) + hiddenCardHTML(true, false) + '</div>';
      }

      var tags = (host ? '<span class="seat-label">HOST</span>' : '') +
        (isMe ? '<span class="seat-label">YOU</span>' : '') +
        (bot ? '<span class="seat-label bot-label">TEST BOT</span>' : '') +
        (acting ? '<span class="seat-label">TURN</span>' : '');
      var rawSeatNo = seat.seat_no != null ? seat.seat_no : i;
      html += '<div class="' + classes + '" data-seat-no="' + Math.floor(number(rawSeatNo, i)) + '" data-relative-seat="' + relativeIndex + '" data-is-bot="' + (bot ? 'true' : 'false') + '">' +
        '<div class="seat-top"><span class="seat-name-wrap">' + (dealer ? '<span class="position-chip" title="Dealer button">D</span>' : '') +
        '<span class="seat-name">' + esc(seat.name || (bot ? "Test bot" : "Player")) + '</span><span class="seat-number">#' + (i + 1) + '</span></span></div>' +
        '<div class="seat-tags">' + tags + '</div>' +
        '<div class="seat-stack">' + chips(stack) + ' <span class="seat-number">chips</span></div>' +
        '<div class="seat-detail"><span>' + esc(label) + '</span><span>' + (seatBet ? "Bet " + chips(seatBet) : "") + '</span></div>' +
        cardHtml +
      '</div>';
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
      if (compact && gridRect.width > 0) {
        var insetPercent = halfWidth / gridRect.width * 100;
        x = Math.max(insetPercent, Math.min(100 - insetPercent, x));
      }
      var pageX = gridRect.left + x * gridRect.width / 100;
      var viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      pageX = Math.max(halfWidth, Math.min(viewportWidth - halfWidth, pageX));
      var halfHeightPercent = grid.clientHeight ? (node.offsetHeight / 2) / grid.clientHeight * 100 : 0;
      y = Math.max(halfHeightPercent, Math.min(100 - halfHeightPercent, y));
      node.style.left = ((pageX - gridRect.left) / gridRect.width * 100).toFixed(2) + "%";
      node.style.top = y.toFixed(2) + "%";
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
    byId("pot-label").textContent = pot > 0 ? "Pot" : "Pot";
    byId("street-label").textContent = view.street && view.street !== "lobby" ? String(view.street).replace(/_/g, " ").toUpperCase() : "";
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

  function renderActions(view) {
    var panel = byId("action-panel");
    var waitPanel = byId("wait-panel");
    var viewer = view.viewer || {};
    var playing = view.status === "playing";
    var canAct = playing && Boolean(viewer.can_act);
    panel.hidden = !canAct;
    waitPanel.hidden = !playing || canAct;

    if (!playing) return;

    var actorId = String(view.actor_id || view.to_act_id || "");
    var actor = (view.seats || []).find(function (seat) {
      return String(seat.id || seat.player_id || "") === actorId;
    });
    if (canAct) {
      byId("action-title").textContent = "Choose an action";
      var deadline = number(view.turn_deadline, 0);
      var seconds = -1;
      if (deadline > 0) {
        var stamp = deadline < 100000000000 ? deadline * 1000 : deadline;
        seconds = Math.max(0, Math.floor((stamp - Date.now()) / 1000));
      }
      byId("turn-clock").textContent = seconds >= 0 ? "Auto-action in " + formatClock(seconds) : "";
      var toCall = number(viewer.to_call, 0);
      var seat = (view.seats || []).find(function (s) {
        return String(s.id || s.player_id || "") === String(viewer.player_id || (state.player && state.player.id) || "");
      });
      var stack = number(seat && seat.stack, 0);
      var canRaise = viewer.raise_rights !== false;
      var maxRaise = number(viewer.max_raise_to, number(view.current_bet, 0) + stack);
      var minRaise = number(viewer.min_raise_to, number(view.current_bet, 0) + number(view.min_raise, 0));
      var raising = canRaise && maxRaise > number(view.current_bet, 0);
      var controls = "";

      if (toCall > 0) {
        var callLabel = stack > 0 && stack <= toCall ? "Call all-in · " + chips(stack) : "Call · " + chips(toCall);
        controls += '<button class="button button-outline call-button" type="button" data-poker-action="call">' + esc(callLabel) + '</button>';
      } else {
        controls += '<button class="button button-outline call-button" type="button" data-poker-action="check">Check</button>';
      }
      controls += '<button class="button button-quiet" type="button" data-poker-action="fold">Fold</button>';

      if (stack > 0 && (canRaise || stack <= toCall)) {
        controls += '<button class="button button-quiet" type="button" data-poker-action="all_in">All in · ' + chips(stack) + '</button>';
      }

      if (raising && minRaise > 0 && maxRaise >= minRaise) {
        var raiseLabel = number(view.current_bet, 0) > 0 ? "Raise to" : "Bet";
        var inputValue = Math.min(maxRaise, Math.max(minRaise, number(viewer.suggested_raise_to, minRaise)));
        controls += '<div class="raise-control"><label for="raise-amount">' + raiseLabel + '</label>' +
          '<input id="raise-amount" type="number" inputmode="numeric" min="' + minRaise + '" max="' + maxRaise + '" step="1" value="' + inputValue + '" aria-label="Bet or raise to total">' +
          '<button class="button button-primary" type="button" data-poker-action="raise_to">' + (number(view.current_bet, 0) > 0 ? "Raise" : "Bet") + '</button>' +
          '<span class="raise-range">' + chips(minRaise) + '–' + chips(maxRaise) + '</span></div>';
      } else if (!canRaise && toCall > 0) {
        controls += '<span class="action-disabled-note">Raising is closed after a short all-in.</span>';
      }
      byId("action-controls").innerHTML = controls;
      return;
    }

    if (actor) {
      byId("wait-title").textContent = esc(actor.name || "Another player") + " is acting";
      var deadline = number(view.turn_deadline, 0);
      var seconds = -1;
      if (deadline > 0) {
        var stamp = deadline < 100000000000 ? deadline * 1000 : deadline;
        seconds = Math.max(0, Math.floor((stamp - Date.now()) / 1000));
      }
      byId("wait-description").textContent = seconds >= 0 ? "The turn clock has " + formatClock(seconds) + " left." : "The table will update as play continues.";
    } else if (viewer.seated) {
      byId("wait-title").textContent = "Waiting for the next hand";
      byId("wait-description").textContent = "Your seat stays at the table while the tournament continues.";
    } else {
      byId("wait-title").textContent = "Watching the table";
      byId("wait-description").textContent = "Join during the lobby phase to take a seat.";
    }
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
    renderSeats(view);
    renderBoard(view);
    renderLog(view);
    renderResults(view);
    renderActions(view);

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
      var delay = state.refreshPending ? 0 : (document.hidden ? 8000 : 2000);
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

  byId("action-controls").addEventListener("click", async function (event) {
    var button = event.target.closest("[data-poker-action]");
    if (!button || button.disabled) return;
    var action = button.getAttribute("data-poker-action");
    var view = state.tableView;
    if (!view || !view.viewer) return;
    var payload = {
      expected_hand: number(view.hand_no, 0),
      expected_turn_version: number(view.turn_version, 0)
    };

    if (action === "raise_to") {
      var input = byId("raise-amount");
      var amount = number(input && input.value, 0);
      var min = number(input && input.min, 0);
      var max = number(input && input.max, 0);
      if (!Number.isInteger(amount) || amount < min || amount > max) {
        showNotice("Choose a bet or raise amount within the displayed range.", "error", false);
        return;
      }
      payload.action = number(view.current_bet, 0) > 0 ? "raise" : "bet";
      payload.amount = amount;
    } else {
      payload.action = action;
    }

    var controls = byId("action-controls").querySelectorAll("button");
    controls.forEach(function (control) { control.disabled = true; });
    try {
      await mutate("/tables/" + encodeURIComponent(state.activeTableId) + "/action", payload);
      clearNotice();
      await refreshSelected();
      await refreshAll(true);
    } catch (err) {
      if (err.status === 409) {
        showNotice("The hand moved on before that action arrived. The table has been refreshed.", "info", false);
        try { await refreshSelected(); } catch (refreshError) {}
        try { await refreshAll(true); } catch (refreshError) {}
      } else {
        showNotice(err.message, "error", false);
        try { await refreshSelected(); } catch (refreshError) {}
      }
    } finally {
      controls.forEach(function (control) { control.disabled = false; });
    }
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

