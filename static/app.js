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
    var adminLogin = !newAccount && String(nameInput.value || "").trim().toLowerCase() === "admin";
    var passwordInput = byId("login-password");
    var passwordLabel = document.querySelector('label[for="login-password"]');
    passwordInput.required = newAccount || !adminLogin;
    passwordInput.maxLength = 256;
    passwordInput.minLength = newAccount ? 1 : (adminLogin ? 0 : 1);
    passwordInput.autocomplete = newAccount ? "new-password" : "current-password";
    passwordLabel.hidden = adminLogin;
    passwordInput.hidden = adminLogin;
    if (adminLogin) passwordInput.value = "";
    sw.hidden = adminLogin;
    byId("admin-login-button").hidden = claim || adminLogin;
    byId("login-form").querySelector('button[type=submit] span').textContent = claim ? "Secure my seat" : newAccount ? "Create account" : (adminLogin ? "Sign in as admin" : "Sign in");
    document.querySelector(".login-card h2").textContent = claim ? "Keep your seat" : newAccount ? "Create an account" : (adminLogin ? "Room administration" : "Welcome back");
    document.querySelector(".login-card p.muted").textContent = claim ? "Choose a username and personal password to keep this browser’s seat and available history." : newAccount ? "Use the room invite password once. Choose a personal password with at least one character." : (adminLogin ? "Use the reserved room administrator account." : "Sign in to return to your seat and view your tournament history.");
  }
  byId("auth-switch").addEventListener("click", async function () {
    if (authMode === "claim") {
      try {await mutate("/logout",{}); setLoggedOut("");} catch (err) {showNotice(err.message,"error",false);}
    } else {
      setAuthMode(authMode === "login" ? "register" : "login");
      byId("login-password").value = ""; byId("room-password").value = ""; clearNotice();
    }
  });
  byId("admin-login-button").addEventListener("click", function () {
    setAuthMode("login");
    byId("login-name").value = "admin";
    setAuthMode("login");
    byId("login-password").value = "";
    byId("login-form").querySelector('button[type=submit]').focus();
    clearNotice();
  });
  byId("login-name").addEventListener("input", function () { setAuthMode(authMode); });

  var API_ROOT = "/poker/api";
  var AUTH_STORAGE_KEY = "sitngo.poker.session-proof.v1";
  var REACTION_FAVORITES_STORAGE_PREFIX = "felt-night.reaction-favorites.v1.";
  var REACTION_EMOJI_LABELS = {
    "👏": "Clap", "❤️": "Heart", "😂": "Laugh", "🔥": "Fire",
    "😍": "Love", "😮": "Wow", "🎉": "Celebrate", "🙌": "Praise",
    "♠️": "Spade", "💎": "Diamond", "🦈": "Shark", "🤝": "Handshake",
    "💩": "Poop", "🤦": "Facepalm", "👀": "Eyes", "😬": "Yikes",
    "🤔": "Thinking", "😎": "Cool", "🙏": "Pray", "💪": "Strong",
    "🍀": "Lucky"
  };
  var REACTION_EMOJIS = Object.keys(REACTION_EMOJI_LABELS);
  var DEFAULT_REACTION_FAVORITES = ["👏", "❤️", "😂"];
  var MAX_ADMIN_HISTORY_DELETE_IDS = 400;
  var DEFAULT_GLOBAL_CONFIG = {
    runout_seconds: 2.5,
    blind_announcement_seconds: 5,
    elimination_announcement_seconds: 5,
    showdown_seconds: 5,
    uncontested_seconds: 1.5,
    bet_presets: { preflop_bb: [2.5, 3, 4], postflop_percent: [50, 75, 100] }
  };
  var state = {
    csrf: "",
    sessionProof: "",
    player: null,
    isAdmin: false,
    globalConfig: JSON.parse(JSON.stringify(DEFAULT_GLOBAL_CONFIG)),
    adminTables: [],
    adminConfigSaving: false,
    adminTablesLoading: false,
    adminHistory: [],
    adminHistorySelectedIds: [],
    adminHistorySelectionMessage: "",
    adminHistoryLoading: false,
    adminHistoryNextOffset: null,
    adminHistoryError: "",
    adminHistoryListGeneration: 0,
    adminHistoryDetailGeneration: 0,
    adminHistoryDetailLoading: false,
    adminHistoryDetail: null,
    adminHistoryDetailError: "",
    adminHistoryDetailId: "",
    adminHistoryTrigger: null,
    adminHistoryDeleteTarget: null,
    adminHistoryDeleting: false,
    adminConfigLoaded: false,
    adminConfigRefreshAt: 0,
    restoreTableId: "",
    endConfirmation: { tableId: "", token: "", step: 0, busy: false },
    tables: [],
    activeTableId: "",
    skipAutoResume: false,
    tableView: null,
    reactionFavorites: DEFAULT_REACTION_FAVORITES.slice(),
    reactionSending: false,
    reactionLastSentAt: 0,
    reactions: { tableId: "", cursor: null, pending: [], loading: false, requestId: 0 },
    standingsDismissedFor: "",
    polling: false,
    refreshBusy: false,
    refreshTimer: 0,
    refreshPending: false,
    pendingTableUrl: "",
    openTableSetupOnLoad: false,
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
    blindLevelClockKey: "",
    blindLevelRemainingMs: 0,
    blindLevelClockUpdatedAt: 0,
    blindLevelClockTimer: 0,
    blindLevelClockPaused: false,
    winnerAnimationKey: "",
    winnerAnimationStartedAt: 0,
    winnerAnimationDurationMs: 0,
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
      errorSource: "",
      status: "",
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

  function isDialogBackdropClick(dialog, event) {
    if (!dialog || event.target !== dialog) return false;
    var rect = dialog.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right ||
      event.clientY < rect.top || event.clientY > rect.bottom;
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

  function requestedTableId() {
    try {
      var params = new URLSearchParams(window.location.search);
      var id = params.get("table") || hashTableId();
      return id.length <= 100 ? id : "";
    } catch (err) {
      return "";
    }
  }

  var routeRootFamily = /^\/(?:lobby|table)\/?$/.test(window.location.pathname);
  var routePrefix = routeRootFamily ? "" : "/poker";
  var initialRouteTableId = requestedTableId();
  var initialRouteParams = new URLSearchParams(window.location.search);
  var initialRouteSetup = Boolean(initialRouteTableId && initialRouteParams.get("setup") === "1");
  var pageMode = (/^\/(?:poker\/)?table\/?$/.test(window.location.pathname) || Boolean(initialRouteTableId))
    ? "table" : "lobby";

  function routePath(mode) {
    return routePrefix + "/" + (mode === "table" ? "table" : "lobby");
  }

  function tableWindowUrl(id, setup) {
    var params = new URLSearchParams();
    params.set("table", String(id || ""));
    if (setup) params.set("setup", "1");
    return window.location.origin + routePath("table") + "?" + params.toString();
  }

  function syncPageModeClasses() {
    document.body.classList.toggle("lobby-route", pageMode === "lobby");
    document.body.classList.toggle("table-route", pageMode === "table");
  }

  function setHashTable(id, setup) {
    var tableId = String(id || "");
    pageMode = tableId ? "table" : "lobby";
    var url = tableId ? tableWindowUrl(tableId, setup) : window.location.origin + routePath("lobby");
    window.history.replaceState(null, "", url);
    syncPageModeClasses();
  }

  function tableWindowFeatures() {
    var screenWidth = Number(window.screen && window.screen.availWidth) || 1180;
    var screenHeight = Number(window.screen && window.screen.availHeight) || 880;
    var width = Math.min(1400, Math.max(320, screenWidth - 80));
    var height = Math.min(1050, Math.max(320, screenHeight - 100));
    var left = Math.max(0, Math.round((screenWidth - width) / 2));
    var top = Math.max(0, Math.round((screenHeight - height) / 2));
    return "popup=yes,width=" + width + ",height=" + height + ",left=" + left + ",top=" + top + ",resizable=yes,scrollbars=yes";
  }

  function reserveTableWindow() {
    if (!state.player || (!state.isAdmin && !state.player.avatar_url) || isStandaloneApp()) return null;
    try { return window.open("about:blank", "_blank", tableWindowFeatures()); }
    catch (err) { return null; }
  }

  function openTableWindow(tableId, setup, reservedWindow) {
    if (!tableId || !state.player) return false;
    if (!state.isAdmin && !state.player.avatar_url) {
      openProfilePhotoDialog(null, function () { openTableWindow(tableId, setup); });
      return false;
    }
    var url = tableWindowUrl(tableId, setup);
    if (isStandaloneApp()) {
      try { if (reservedWindow && !reservedWindow.closed) reservedWindow.close(); } catch (closeError) {}
      state.pendingTableUrl = "";
      byId("popup-fallback").hidden = true;
      window.location.assign(url);
      return true;
    }
    var popup = reservedWindow;
    var opened = false;
    try {
      if (reservedWindow === undefined) popup = window.open(url, "_blank", tableWindowFeatures());
      else if (popup && !popup.closed) popup.location = url;
      opened = Boolean(popup && !popup.closed);
    } catch (err) {
      opened = false;
    }
    if (opened) {
      state.pendingTableUrl = "";
      byId("popup-fallback").hidden = true;
      return true;
    }
    state.pendingTableUrl = url;
    byId("popup-fallback").hidden = false;
    return false;
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

  var avatarDataCache = Object.create(null);
  var avatarCacheOrder = [];
  var avatarCacheGeneration = 0;
  var profilePhotoDraft = "";
  var profilePhotoFullDraft = "";
  var profilePhotoPresetId = "";
  var profilePhotoAfterSave = null;
  var profilePhotoAfterCancel = null;
  var avatarPresets = [];
  var avatarPresetsPromise = null;
  var profileAccountBusy = false;
  var profileAccountGeneration = 0;
  var profileAccountTrigger = null;
  var adminAvatarBusy = false;
  var profilePhotoBusy = false;
  var profilePhotoTriggerId = "";
  var profilePhotoGeneration = 0;
  var profileAvatarOverride = null;
  var profilePhotoSource = null;
  var profilePhotoCrop = { zoom:1, x:0.5, y:0.5 };
  var profilePhotoCropRevision = 0;
  var profilePhotoEncodeTimer = null;
  var profilePhotoEncoding = false;
  var profilePhotoDrag = null;
  var MAX_AVATAR_INPUT_BYTES = 12 * 1024 * 1024;
  var MAX_AVATAR_OUTPUT_BYTES = 256 * 1024;
  var MAX_AVATAR_FULL_OUTPUT_BYTES = 1024 * 1024;
  var MAX_AVATAR_PRESET_BYTES = 2 * 1024 * 1024;
  var MAX_AVATAR_SOURCE_PIXELS = 64 * 1000 * 1000;

  function safeAvatarPath(value) {
    if (typeof value !== "string" || !value) return "";
    try {
      var parsed = new URL(value, window.location.origin);
      if (parsed.origin !== window.location.origin || parsed.hash) return "";
      var versioned = /^\?v=[a-f0-9]{64}$/i.test(parsed.search);
      if (/^\/poker\/api\/players\/[A-Za-z0-9_-]+\/avatar$/.test(parsed.pathname) && versioned) {
        return parsed.pathname + parsed.search;
      }
      if (/^\/poker\/api\/players\/[A-Za-z0-9_-]+\/avatar\/full$/.test(parsed.pathname) && versioned) {
        return parsed.pathname + parsed.search;
      }
      if (/^\/poker\/api\/avatar-presets\/[a-f0-9]{32}\/(?:thumbnail|full)$/.test(parsed.pathname) && versioned) {
        return parsed.pathname + parsed.search;
      }
      if (/^\/poker\/avatars\/(?:full\/)?[a-z0-9-]+\.(?:jpg|png)$/i.test(parsed.pathname) && !parsed.search) {
        return parsed.pathname;
      }
      return "";
    } catch (err) {
      return "";
    }
  }

  function clearAvatarCache() {
    avatarCacheGeneration += 1;
    avatarDataCache = Object.create(null);
    avatarCacheOrder = [];
    document.querySelectorAll("[data-avatar-url]").forEach(function (wrapper) {
      wrapper.classList.remove("has-avatar");
      var image = wrapper.querySelector(".avatar-image");
      if (image) image.removeAttribute("src");
    });
  }

  function rememberAvatarPath(path) {
    var oldIndex = avatarCacheOrder.indexOf(path);
    if (oldIndex >= 0) avatarCacheOrder.splice(oldIndex, 1);
    avatarCacheOrder.push(path);
    while (avatarCacheOrder.length > 36) {
      var expired = avatarCacheOrder.shift();
      delete avatarDataCache[expired];
    }
  }

  function blobAsDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(typeof reader.result === "string" ? reader.result : ""); };
      reader.onerror = function () { reject(Error("The photo could not be read.")); };
      reader.readAsDataURL(blob);
    });
  }

  function fetchAvatarData(value) {
    var path = safeAvatarPath(value);
    if (!path) return Promise.resolve("");
    var pathOnly = path.split("?")[0];
    var isPublic = pathOnly.indexOf("/poker/avatars/") === 0;
    var isFull = pathOnly.indexOf("/poker/avatars/full/") === 0 || /(?:\/full|\/avatar\/full)$/.test(pathOnly);
    if (!isPublic && !state.sessionProof) return Promise.resolve("");
    var entry = avatarDataCache[path];
    if (entry && entry.data) {
      rememberAvatarPath(path);
      return Promise.resolve(entry.data);
    }
    if (entry && entry.promise) return entry.promise;
    if (entry && entry.retryAt > Date.now()) return Promise.resolve("");
    if (!entry) entry = avatarDataCache[path] = { data: "", promise: null, retryAt: 0 };
    var proof = state.sessionProof;
    var generation = avatarCacheGeneration;
    var headers = { "Accept": "image/jpeg,image/png" };
    if (!isPublic) headers["X-SitNgo-Session"] = proof;
    entry.promise = fetch(path, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: headers
    }).then(function (response) {
      if (!response.ok) throw Error("Avatar request failed.");
      var contentType = String(response.headers.get("Content-Type") || "").split(";")[0].toLowerCase();
      if (contentType !== "image/jpeg" && contentType !== "image/png") throw Error("Unsupported avatar image.");
      return response.blob();
    }).then(function (blob) {
      var limit = isFull ? MAX_AVATAR_FULL_OUTPUT_BYTES : (isPublic ? MAX_AVATAR_PRESET_BYTES : MAX_AVATAR_OUTPUT_BYTES);
      if (blob.size > limit) throw Error("Avatar image is too large.");
      return blobAsDataUrl(blob);
    }).then(function (dataUrl) {
      if ((!isPublic && proof !== state.sessionProof) || generation !== avatarCacheGeneration) return "";
      entry.data = dataUrl;
      entry.retryAt = 0;
      entry.promise = null;
      rememberAvatarPath(path);
      return dataUrl;
    }).catch(function () {
      entry.promise = null;
      entry.retryAt = Date.now() + 30000;
      return "";
    });
    return entry.promise;
  }

  function hydrateAvatarNodes(root) {
    if (!root) return;
    var nodes = [];
    if (root.matches && root.matches("[data-avatar-url]")) nodes.push(root);
    if (root.querySelectorAll) nodes = nodes.concat(Array.prototype.slice.call(root.querySelectorAll("[data-avatar-url]")));
    nodes.forEach(function (wrapper) {
      if (wrapper.getAttribute("data-avatar-local") === "true") return;
      var url = wrapper.getAttribute("data-avatar-url") || "";
      var image = wrapper.querySelector(".avatar-image");
      if (!url || !image) return;
      image.onload = function () { wrapper.classList.add("has-avatar"); };
      image.onerror = function () {
        wrapper.classList.remove("has-avatar");
        image.removeAttribute("src");
      };
      fetchAvatarData(url).then(function (dataUrl) {
        if (dataUrl && wrapper.isConnected && wrapper.getAttribute("data-avatar-url") === url && image.getAttribute("src") !== dataUrl) {
          image.src = dataUrl;
        }
      });
    });
  }

  function avatarMarkup(url, name, className, options) {
    var initial = String(name || "").trim().charAt(0).toUpperCase() || "♠";
    var safeUrl = safeAvatarPath(url) || "";
    var inner = '<span class="avatar-fallback-text">' + esc(initial) + '</span><img class="avatar-image" alt="">';
    if (options && options.interactive && safeUrl) {
      var fullUrl = safeAvatarPath(options.fullUrl || url) || safeUrl;
      return '<button type="button" class="' + className + ' avatar-photo-trigger" data-avatar-url="' + esc(safeUrl) +
        '" data-avatar-full-url="' + esc(fullUrl) + '" aria-label="View ' + esc(String(name || "Player")) + ' profile photo">' +
        inner + '</button>';
    }
    return '<span class="' + className + '" data-avatar-url="' + esc(safeUrl) + '" aria-hidden="true">' + inner + '</span>';
  }

  function safeAvatarPreset(preset) {
    if (!preset || typeof preset.id !== "string" ||
        !/^(?:[a-z0-9-]{1,40}|[a-f0-9]{32})$/i.test(preset.id) ||
        typeof preset.name !== "string" || !preset.name.trim() || typeof preset.url !== "string") return null;
    var path = safeAvatarPath(preset.url);
    var fullUrl = safeAvatarPath(preset.full_url || preset.url);
    var isCustom = Boolean(preset.custom);
    if (isCustom) {
      if (!new RegExp("^/poker/api/avatar-presets/" + preset.id + "/thumbnail\\?v=[a-f0-9]{64}$", "i").test(path) ||
          !new RegExp("^/poker/api/avatar-presets/" + preset.id + "/full\\?v=[a-f0-9]{64}$", "i").test(fullUrl)) return null;
    } else {
      if (!new RegExp("^/poker/avatars/" + preset.id + "\\.(?:jpg|png)$", "i").test(path) ||
          !new RegExp("^/poker/avatars/full/" + preset.id + "\\.(?:jpg|png)$", "i").test(fullUrl)) return null;
    }
    return { id:preset.id, name:preset.name.trim(), url:path, fullUrl:fullUrl, custom:isCustom };
  }

  function renderAvatarPresets() {
    var grid = byId("profile-photo-presets");
    if (!grid) return;
    grid.innerHTML = avatarPresets.map(function (preset) {
      var initial = preset.name.trim().charAt(0).toUpperCase() || "♠";
      return '<button type="button" class="avatar-preset" data-avatar-preset-id="' + esc(preset.id) +
        '" aria-pressed="' + String(profilePhotoPresetId === preset.id) + '" aria-label="Choose ' + esc(preset.name) + ' avatar">' +
        '<span class="avatar-preset-image" data-avatar-url="' + esc(preset.url) + '" aria-hidden="true">' +
        '<span class="avatar-fallback-text">' + esc(initial) + '</span><img class="avatar-image" alt="" loading="lazy"></span>' +
        '<span class="avatar-preset-name">' + esc(preset.name) + '</span></button>';
    }).join("");
    hydrateAvatarNodes(grid);
    if (grid.querySelectorAll) grid.querySelectorAll(".avatar-preset").forEach(function (button) {
      button.disabled = profilePhotoBusy;
    });
  }

  function loadAvatarPresets(force) {
    if (avatarPresets.length && !force) {
      renderAvatarPresets();
      return Promise.resolve(avatarPresets);
    }
    if (avatarPresetsPromise) return avatarPresetsPromise;
    var status = byId("profile-photo-presets-status");
    if (status) status.textContent = "Loading avatar choices…";
    avatarPresetsPromise = request("/avatar-presets").then(function (data) {
      var seen = Object.create(null);
      var choices = (Array.isArray(data.avatars) ? data.avatars : []).map(safeAvatarPreset).filter(function (preset) {
        if (!preset || seen[preset.id]) return false;
        seen[preset.id] = true;
        return true;
      });
      if (!choices.length) throw Error("No avatar choices are available.");
      avatarPresets = choices;
      renderAvatarPresets();
      if (status) status.textContent = "Choose a cartoon portrait, or upload your own photo.";
      renderAdminAvatarCatalog();
      return avatarPresets;
    }).catch(function () {
      if (status) status.textContent = "Avatar choices could not be loaded. You can still upload a photo.";
      renderAdminAvatarCatalog("Shared avatar choices could not be loaded.");
      return avatarPresets;
    }).finally(function () {
      avatarPresetsPromise = null;
    });
    return avatarPresetsPromise;
  }

  function setAdminAvatarError(message) {
    var node = byId("admin-avatar-preset-error");
    node.textContent = message || "";
    node.hidden = !message;
  }

  function renderAdminAvatarCatalog(message) {
    var list = byId("admin-avatar-catalog-list");
    if (!list) return;
    if (message) {
      list.innerHTML = '<p class="profile-photo-error" role="alert">' + esc(message) + '</p>';
      return;
    }
    if (!avatarPresets.length) {
      list.innerHTML = '<p class="muted">No shared portraits are available.</p>';
      return;
    }
    list.innerHTML = '<p class="muted">' + avatarPresets.length + ' shared portraits available to players.</p>' +
      '<div class="admin-avatar-catalog-grid">' + avatarPresets.map(function (preset) {
        return '<div class="admin-avatar-catalog-item"><span class="avatar-preset-image" data-avatar-url="' +
          esc(preset.url) + '" aria-hidden="true"><span class="avatar-fallback-text">' +
          esc(preset.name.charAt(0).toUpperCase()) + '</span><img class="avatar-image" alt=""></span>' +
          '<span>' + esc(preset.name) + '</span></div>';
      }).join("") + '</div>';
    hydrateAvatarNodes(list);
  }

  async function encodeAvatarCanvas(canvas, maxBytes, errorMessage) {
    var qualities = [0.9, 0.82, 0.74, 0.66, 0.58, 0.5, 0.42, 0.34];
    for (var i = 0; i < qualities.length; i += 1) {
      var blob = await canvasBlob(canvas, qualities[i]);
      if (blob && blob.size <= maxBytes) return blobAsDataUrl(blob);
    }
    throw Error(errorMessage);
  }

  function drawCenteredAvatar(source, size) {
    var canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    var context = canvas.getContext("2d");
    if (!context) throw Error("Image editing is unavailable in this browser.");
    var side = Math.min(source.width, source.height);
    var x = (source.width - side) / 2;
    var y = (source.height - side) / 2;
    context.fillStyle = "#17251e";
    context.fillRect(0, 0, size, size);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, x, y, side, side, 0, 0, size, size);
    return canvas;
  }

  function adminAvatarFormBusy(busy) {
    adminAvatarBusy = busy;
    byId("admin-avatar-preset-name").disabled = busy;
    byId("admin-avatar-preset-file").disabled = busy;
    byId("admin-avatar-preset-save").disabled = busy;
    byId("admin-avatar-preset-save").setAttribute("aria-busy", String(busy));
  }

  async function saveAdminAvatarPreset(event) {
    event.preventDefault();
    if (!state.isAdmin || adminAvatarBusy) return;
    var form = byId("admin-avatar-preset-form");
    var name = byId("admin-avatar-preset-name").value.trim();
    var file = byId("admin-avatar-preset-file").files && byId("admin-avatar-preset-file").files[0];
    setAdminAvatarError("");
    if (!form.checkValidity() || !name || !file) {
      form.reportValidity();
      return;
    }
    adminAvatarFormBusy(true);
    byId("admin-avatar-preset-status").textContent = "Preparing shared portrait…";
    var source = null;
    try {
      source = await loadAvatarFile(file);
      var thumbCanvas = drawCenteredAvatar(source, 256);
      var fullCanvas = drawCenteredAvatar(source, 1024);
      var imageData = await encodeAvatarCanvas(thumbCanvas, MAX_AVATAR_OUTPUT_BYTES,
        "This image could not be compressed below 256 KB. Choose another image.");
      var fullImageData = await encodeAvatarCanvas(fullCanvas, MAX_AVATAR_FULL_OUTPUT_BYTES,
        "This image could not be compressed below 1 MB. Choose another image.");
      var preview = byId("admin-avatar-preset-preview");
      preview.src = imageData;
      byId("admin-avatar-preset-preview-name").textContent = name;
      byId("admin-avatar-preset-preview-wrap").hidden = false;
      byId("admin-avatar-preset-status").textContent = "Saving shared portrait…";
      var data = await mutate("/admin/avatar-presets", {
        name:name, image_data:imageData, full_image_data:fullImageData
      });
      if (!Array.isArray(data.avatars)) throw Error("The saved shared portrait list could not be loaded.");
      avatarPresets = data.avatars.map(safeAvatarPreset).filter(Boolean);
      renderAvatarPresets();
      renderAdminAvatarCatalog();
      byId("admin-avatar-preset-form").reset();
      byId("admin-avatar-preset-preview-wrap").hidden = true;
      byId("admin-avatar-preset-status").textContent = name + " is now available to every player.";
    } catch (err) {
      byId("admin-avatar-preset-status").textContent = "";
      setAdminAvatarError(err.message || "Could not add the shared portrait. Try again.");
    } finally {
      if (source && source.close) source.close();
      adminAvatarFormBusy(false);
    }
  }

  async function selectAvatarPreset(id) {
    if (profilePhotoBusy) return;
    var preset = avatarPresets.filter(function (item) { return item.id === id; })[0];
    if (!preset) return;
    invalidateProfilePhotoWork();
    profilePhotoPresetId = preset.id;
    renderAvatarPresets();
    profilePhotoBusy = true;
    setProfilePhotoError("");
    setProfilePhotoPreview(String(state.player && state.player.avatar_url || ""), false);
    byId("profile-photo-status").textContent = "Preparing " + preset.name + " avatar…";
    updateProfilePhotoButtons();
    var generation = profilePhotoGeneration;
    var playerId = String(state.player && state.player.id || "");
    try {
      var sourceUrl = preset.fullUrl || preset.url;
      var headers = { "Accept":"image/jpeg,image/png" };
      if (preset.custom) headers["X-SitNgo-Session"] = state.sessionProof;
      var response = await fetch(sourceUrl, { credentials:"same-origin", cache:preset.custom ? "no-store" : "force-cache", headers:headers });
      if (!response.ok) throw Error("That avatar could not be loaded.");
      var blob = await response.blob();
      var contentType = String(blob.type || "").split(";")[0].toLowerCase();
      if (blob.size <= 0 || blob.size > MAX_AVATAR_FULL_OUTPUT_BYTES ||
          (contentType !== "image/jpeg" && contentType !== "image/png")) {
        throw Error("That avatar image is invalid.");
      }
      var file = new File([blob], preset.id + (contentType === "image/png" ? ".png" : ".jpg"), { type:contentType });
      var imageSource = await loadAvatarFile(file);
      if (generation !== profilePhotoGeneration || playerId !== String(state.player && state.player.id || "") ||
          !byId("profile-photo-dialog").open) {
        if (imageSource.close) imageSource.close();
        return;
      }
      profilePhotoSource = imageSource;
      profilePhotoCrop = { zoom:1, x:0.5, y:0.5 };
      byId("profile-photo-editor").hidden = false;
      drawProfilePhotoCrop();
      await prepareProfilePhotoCrop(++profilePhotoCropRevision);
      if (generation === profilePhotoGeneration && playerId === String(state.player && state.player.id || "")) {
        byId("profile-photo-status").textContent = preset.name + " avatar ready to save.";
      }
    } catch (err) {
      if (generation === profilePhotoGeneration && playerId === String(state.player && state.player.id || "")) {
        byId("profile-photo-status").textContent = "";
        setProfilePhotoError(err.message || "Could not prepare that avatar.");
      }
    } finally {
      if (generation === profilePhotoGeneration && playerId === String(state.player && state.player.id || "")) {
        profilePhotoBusy = false;
        updateProfilePhotoButtons();
      }
    }
  }

  function renderIdentityAvatar() {
    var wrapper = byId("identity-avatar");
    if (!wrapper) return;
    var initial = state.player && state.player.name ? state.player.name.charAt(0).toUpperCase() : "♠";
    var fallback = wrapper.querySelector(".avatar-fallback-text");
    var image = wrapper.querySelector(".avatar-image");
    var url = String(state.player && state.player.avatar_url || "");
    if (wrapper.getAttribute("data-avatar-url") === url) {
      if (fallback) fallback.textContent = initial;
      hydrateAvatarNodes(wrapper);
      return;
    }
    wrapper.setAttribute("data-avatar-url", url);
    wrapper.classList.remove("has-avatar");
    if (fallback) fallback.textContent = initial;
    if (image) image.removeAttribute("src");
    hydrateAvatarNodes(wrapper);
  }

  function setProfilePhotoPreview(value, localData) {
    var wrapper = byId("profile-photo-preview");
    if (!wrapper) return;
    var fallback = wrapper.querySelector(".avatar-fallback-text");
    var image = wrapper.querySelector(".avatar-image");
    var initial = state.player && state.player.name ? state.player.name.charAt(0).toUpperCase() : "♠";
    wrapper.classList.remove("has-avatar");
    wrapper.removeAttribute("data-avatar-local");
    wrapper.setAttribute("data-avatar-url", localData ? "" : String(value || ""));
    if (fallback) fallback.textContent = initial;
    if (image) {
      image.onload = function () { wrapper.classList.add("has-avatar"); };
      image.onerror = function () { wrapper.classList.remove("has-avatar"); image.removeAttribute("src"); };
      image.removeAttribute("src");
      if (localData && value) {
        wrapper.setAttribute("data-avatar-local", "true");
        image.src = value;
      }
    }
    if (!localData) hydrateAvatarNodes(wrapper);
  }

  function setProfilePhotoError(message) {
    var node = byId("profile-photo-error");
    node.textContent = message || "";
    node.hidden = !message;
  }

  function updateProfilePhotoButtons() {
    byId("profile-photo-save").disabled = profilePhotoBusy || profilePhotoEncoding || !profilePhotoDraft;
    byId("profile-photo-save").setAttribute("aria-busy", String(profilePhotoBusy || profilePhotoEncoding));
    ["profile-photo-zoom", "profile-photo-x", "profile-photo-y", "profile-photo-reset"].forEach(function (id) {
      byId(id).disabled = profilePhotoBusy || !profilePhotoSource;
    });
    byId("profile-photo-canvas").setAttribute("aria-disabled", String(profilePhotoBusy || !profilePhotoSource));
    byId("profile-photo-choose").disabled = profilePhotoBusy;
    byId("profile-photo-file").disabled = profilePhotoBusy;
  }

  function invalidateProfilePhotoWork() {
    profilePhotoGeneration += 1;
    resetProfilePhotoEditor();
    profilePhotoDraft = "";
    profilePhotoFullDraft = "";
    profilePhotoPresetId = "";
    profilePhotoBusy = false;
    if (byId("profile-photo-presets")) renderAvatarPresets();
    var file = byId("profile-photo-file");
    if (file) file.value = "";
  }

  function openProfilePhotoDialog(event, afterSave, afterCancel) {
    if (!state.player || state.isAdmin) return false;
    if (typeof afterSave === "function" && state.player.avatar_url) return false;
    invalidateProfilePhotoWork();
    profilePhotoTriggerId = event && event.currentTarget ? event.currentTarget.id : "profile-photo-button";
    profilePhotoAfterSave = typeof afterSave === "function" ? afterSave : null;
    profilePhotoAfterCancel = typeof afterCancel === "function" ? afterCancel : null;
    profilePhotoDraft = "";
    profilePhotoFullDraft = "";
    profilePhotoPresetId = "";
    profilePhotoBusy = false;
    byId("profile-photo-file").value = "";
    byId("profile-photo-status").textContent = "";
    setProfilePhotoError("");
    setProfilePhotoPreview(String(state.player.avatar_url || ""), false);
    renderAvatarPresets();
    loadAvatarPresets(true);
    updateProfilePhotoButtons();
    var dialog = byId("profile-photo-dialog");
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    return true;
  }

  function closeProfilePhotoDialog(restoreFocus, saved) {
    invalidateProfilePhotoWork();
    var dialog = byId("profile-photo-dialog");
    if (dialog && dialog.open) dialog.close();
    byId("profile-photo-status").textContent = "";
    setProfilePhotoError("");
    var triggerId = profilePhotoTriggerId || "profile-photo-button";
    var callback = saved ? profilePhotoAfterSave : profilePhotoAfterCancel;
    profilePhotoAfterSave = null;
    profilePhotoAfterCancel = null;
    profilePhotoTriggerId = "";
    if (restoreFocus) focusTableControl(triggerId);
    if (callback) callback();
  }

  function readImageDimensions(file) {
    return file.slice(0, Math.min(file.size, 1024 * 1024)).arrayBuffer().then(function (buffer) {
      var bytes = new Uint8Array(buffer);
      if (bytes.length >= 24 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) {
        return { type: "image/png", width: bytes[16] * 16777216 + bytes[17] * 65536 + bytes[18] * 256 + bytes[19],
          height: bytes[20] * 16777216 + bytes[21] * 65536 + bytes[22] * 256 + bytes[23] };
      }
      if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
        var position = 2;
        while (position + 4 < bytes.length) {
          while (position < bytes.length && bytes[position] !== 255) position += 1;
          while (position < bytes.length && bytes[position] === 255) position += 1;
          var marker = bytes[position++];
          if (marker === 217 || marker === 218) break;
          if (marker === 0 || marker === 1 || (marker >= 208 && marker <= 215)) continue;
          if (position + 1 >= bytes.length) break;
          var length = bytes[position] * 256 + bytes[position + 1];
          if (length < 2 || position + length > bytes.length) break;
          if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].indexOf(marker) >= 0) {
            return { type: "image/jpeg", height: bytes[position + 3] * 256 + bytes[position + 4],
              width: bytes[position + 5] * 256 + bytes[position + 6] };
          }
          position += length;
        }
      }
      throw Error("That file is not a readable JPEG or PNG image.");
    });
  }

  function loadImageForAvatar(file, dimensions) {
    if (window.createImageBitmap) {
      var scale = Math.min(1, 1200 / Math.max(dimensions.width, dimensions.height));
      return createImageBitmap(file, { resizeWidth: Math.max(1, Math.round(dimensions.width * scale)),
        resizeHeight: Math.max(1, Math.round(dimensions.height * scale)), resizeQuality: "high" });
    }
    if (dimensions.width * dimensions.height > 24 * 1000 * 1000) {
      return Promise.reject(Error("This browser cannot resize a photo of that size. Choose a smaller image."));
    }
    return blobAsDataUrl(file).then(function (dataUrl) {
      return new Promise(function (resolve, reject) {
        var image = new Image();
        image.onload = function () { resolve(image); };
        image.onerror = function () { reject(Error("The photo could not be decoded.")); };
        image.src = dataUrl;
      });
    });
  }

  function canvasBlob(canvas, quality) {
    return new Promise(function (resolve) {
      canvas.toBlob(resolve, "image/jpeg", quality);
    });
  }

  async function loadAvatarFile(file) {
    if (!file || !/^image\/(jpeg|png)$/i.test(file.type || "")) throw Error("Choose a JPEG or PNG image.");
    if (file.size <= 0 || file.size > MAX_AVATAR_INPUT_BYTES) throw Error("Choose an image smaller than 12 MB.");
    var dimensions = await readImageDimensions(file);
    if (dimensions.width < 1 || dimensions.height < 1 || dimensions.width > 20000 || dimensions.height > 20000 ||
        dimensions.width * dimensions.height > MAX_AVATAR_SOURCE_PIXELS) {
      throw Error("This photo is too large to resize safely. Choose a smaller image.");
    }
    if ((file.type || "").toLowerCase() !== dimensions.type) throw Error("The file contents do not match its image type.");
    return loadImageForAvatar(file, dimensions);
  }

  function resetProfilePhotoEditor() {
    profilePhotoCropRevision += 1;
    window.clearTimeout(profilePhotoEncodeTimer);
    profilePhotoEncodeTimer = null;
    profilePhotoEncoding = false;
    var canvas = byId("profile-photo-canvas");
    if (profilePhotoDrag && canvas.hasPointerCapture(profilePhotoDrag.id)) canvas.releasePointerCapture(profilePhotoDrag.id);
    profilePhotoDrag = null;
    if (profilePhotoSource && profilePhotoSource.close) profilePhotoSource.close();
    profilePhotoSource = null;
    profilePhotoCrop = { zoom:1, x:0.5, y:0.5 };
    byId("profile-photo-editor").hidden = true;
    var context = canvas.getContext("2d");
    if (context) context.clearRect(0, 0, 256, 256);
  }

  function drawProfilePhotoToCanvas(canvas) {
    if (!profilePhotoSource) return;
    var source = profilePhotoSource, context = canvas.getContext("2d"), size = canvas.width;
    if (!context) throw Error("Photo editing is unavailable in this browser.");
    var side = Math.min(source.width, source.height) / profilePhotoCrop.zoom;
    context.fillStyle = "#17251e";
    context.fillRect(0, 0, size, size);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, (source.width - side) * profilePhotoCrop.x,
      (source.height - side) * profilePhotoCrop.y, side, side, 0, 0, size, size);
  }

  function drawProfilePhotoCrop() {
    if (!profilePhotoSource) return;
    drawProfilePhotoToCanvas(byId("profile-photo-canvas"));
    byId("profile-photo-zoom").value = String(profilePhotoCrop.zoom);
    byId("profile-photo-zoom-value").value = profilePhotoCrop.zoom.toFixed(2) + "×";
    byId("profile-photo-x").value = String(profilePhotoCrop.x * 100);
    byId("profile-photo-y").value = String(profilePhotoCrop.y * 100);
  }

  async function prepareProfilePhotoCrop(revision) {
    var generation = profilePhotoGeneration;
    profilePhotoEncoding = true;
    updateProfilePhotoButtons();
    try {
      var canvas = byId("profile-photo-canvas");
      var qualities = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.32], dataUrl = "", fullDataUrl = "";
      for (var i = 0; i < qualities.length; i += 1) {
        var blob = await canvasBlob(canvas, qualities[i]);
        if (revision !== profilePhotoCropRevision || generation !== profilePhotoGeneration) return;
        if (blob && blob.size <= MAX_AVATAR_OUTPUT_BYTES) { dataUrl = await blobAsDataUrl(blob); break; }
      }
      if (revision !== profilePhotoCropRevision || generation !== profilePhotoGeneration) return;
      if (!dataUrl) throw Error("This photo could not be compressed below 256 KB. Choose another image.");
      var masterCanvas = document.createElement("canvas");
      masterCanvas.width = 1024;
      masterCanvas.height = 1024;
      drawProfilePhotoToCanvas(masterCanvas);
      for (var j = 0; j < qualities.length; j += 1) {
        var fullBlob = await canvasBlob(masterCanvas, qualities[j]);
        if (revision !== profilePhotoCropRevision || generation !== profilePhotoGeneration) return;
        if (fullBlob && fullBlob.size <= MAX_AVATAR_FULL_OUTPUT_BYTES) { fullDataUrl = await blobAsDataUrl(fullBlob); break; }
      }
      if (revision !== profilePhotoCropRevision || generation !== profilePhotoGeneration) return;
      if (!fullDataUrl) throw Error("This photo could not be compressed below 1 MB. Choose another image.");
      profilePhotoDraft = dataUrl;
      profilePhotoFullDraft = fullDataUrl;
      setProfilePhotoPreview(dataUrl, true);
      byId("profile-photo-status").textContent = "Photo ready to save.";
    } catch (err) {
      if (revision === profilePhotoCropRevision && generation === profilePhotoGeneration) {
        setProfilePhotoError(err.message || "Could not prepare that crop.");
      }
    } finally {
      if (revision === profilePhotoCropRevision && generation === profilePhotoGeneration) {
        profilePhotoEncoding = false;
        updateProfilePhotoButtons();
      }
    }
  }

  function changeProfilePhotoCrop() {
    if (!profilePhotoSource || profilePhotoBusy) return;
    profilePhotoCrop.x = Math.max(0, Math.min(1, profilePhotoCrop.x));
    profilePhotoCrop.y = Math.max(0, Math.min(1, profilePhotoCrop.y));
    profilePhotoDraft = "";
    profilePhotoEncoding = true;
    setProfilePhotoError("");
    byId("profile-photo-status").textContent = "Preparing crop…";
    drawProfilePhotoCrop();
    updateProfilePhotoButtons();
    var revision = ++profilePhotoCropRevision;
    window.clearTimeout(profilePhotoEncodeTimer);
    profilePhotoEncodeTimer = window.setTimeout(function () { prepareProfilePhotoCrop(revision); }, 80);
  }

  async function saveProfilePhoto() {
    if (profilePhotoBusy || profilePhotoEncoding || !profilePhotoDraft) return;
    var generation = profilePhotoGeneration;
    var playerId = String(state.player && state.player.id || "");
    profilePhotoBusy = true;
    setProfilePhotoError("");
    byId("profile-photo-status").textContent = "Saving profile photo…";
    updateProfilePhotoButtons();
    try {
      var photoPayload = {
        image_data: profilePhotoDraft,
        full_image_data: profilePhotoFullDraft
      };
      if (profilePhotoPresetId) photoPayload.preset_id = profilePhotoPresetId;
      var data = await mutate("/profile/avatar", photoPayload);
      if (generation !== profilePhotoGeneration || playerId !== String(state.player && state.player.id || "")) {
        refreshAll(true);
        return;
      }
      if (!data.player) throw Error("The saved profile could not be loaded. Try again.");
      state.player = data.player;
      profileAvatarOverride = {
        playerId: String(data.player.id || ""),
        url: String(data.player.avatar_url || ""),
        fullUrl: String(data.player.avatar_full_url || data.player.avatar_url || ""),
        expiresAt: Date.now() + 20000
      };
      renderIdentityAvatar();
      if (byId("welcome-name")) byId("welcome-name").textContent = state.player.name || "";
      refreshAll(true);
      profilePhotoBusy = false;
      closeProfilePhotoDialog(false, true);
    } catch (err) {
      if (generation !== profilePhotoGeneration || playerId !== String(state.player && state.player.id || "")) return;
      profilePhotoBusy = false;
      byId("profile-photo-status").textContent = "";
      setProfilePhotoError(err.message || "Could not save the profile photo. Try again.");
      updateProfilePhotoButtons();
    }
  }

  function setProfileAccountError(message) {
    var node = byId("profile-account-error");
    node.textContent = message || "";
    node.hidden = !message;
  }

  function updateProfileAccountForm() {
    var player = state.player || {};
    var usernameChanged = byId("profile-account-username").value.trim() !== String(player.username || "");
    var newPassword = byId("profile-account-new-password").value;
    var credentialsChanged = usernameChanged || Boolean(newPassword);
    var displayNameChanged = byId("profile-account-display-name").value.trim() !== String(player.display_name || player.name || "");
    byId("profile-account-current-password").required = credentialsChanged;
    byId("profile-account-save").disabled = profileAccountBusy || !(usernameChanged || displayNameChanged || newPassword);
    ["profile-account-username", "profile-account-display-name", "profile-account-current-password",
      "profile-account-new-password"].forEach(function (id) {
      byId(id).disabled = profileAccountBusy;
    });
    byId("profile-account-close").disabled = profileAccountBusy;
  }

  function openProfileAccountDialog(event) {
    if (!state.player || state.isAdmin) return;
    profileAccountGeneration += 1;
    profileAccountBusy = false;
    profileAccountTrigger = event && event.currentTarget ? event.currentTarget : byId("profile-account-button");
    byId("profile-account-username").value = String(state.player.username || "");
    byId("profile-account-display-name").value = String(state.player.display_name || state.player.name || "");
    byId("profile-account-current-password").value = "";
    byId("profile-account-new-password").value = "";
    byId("profile-account-status").textContent = "";
    setProfileAccountError("");
    updateProfileAccountForm();
    var dialog = byId("profile-account-dialog");
    if (!dialog.open) dialog.showModal();
    byId("profile-account-username").focus();
  }

  function closeProfileAccountDialog(restoreFocus) {
    profileAccountGeneration += 1;
    profileAccountBusy = false;
    var dialog = byId("profile-account-dialog");
    if (dialog && dialog.open) dialog.close();
    ["profile-account-current-password", "profile-account-new-password"].forEach(function (id) {
      var input = byId(id);
      if (input) input.value = "";
    });
    byId("profile-account-status").textContent = "";
    setProfileAccountError("");
    updateProfileAccountForm();
    var trigger = profileAccountTrigger;
    profileAccountTrigger = null;
    if (restoreFocus && trigger && trigger.isConnected) trigger.focus({ preventScroll:true });
  }

  async function saveProfileAccount(event) {
    event.preventDefault();
    if (profileAccountBusy || !state.player) return;
    var username = byId("profile-account-username").value.trim();
    var displayName = byId("profile-account-display-name").value.trim();
    var newPassword = byId("profile-account-new-password").value;
    var currentPassword = byId("profile-account-current-password").value;
    var payload = {};
    if (username !== String(state.player.username || "")) payload.username = username;
    if (displayName !== String(state.player.display_name || state.player.name || "")) payload.display_name = displayName;
    if (newPassword) payload.new_password = newPassword;
    if (payload.username || payload.new_password) {
      if (!currentPassword) {
        setProfileAccountError("Enter your current password to change your username or password.");
        byId("profile-account-current-password").focus();
        return;
      }
      payload.current_password = currentPassword;
    }
    if (!Object.keys(payload).length) {
      closeProfileAccountDialog(true);
      return;
    }
    if (!byId("profile-account-form").checkValidity()) {
      byId("profile-account-form").reportValidity();
      return;
    }
    var generation = profileAccountGeneration;
    var playerId = String(state.player.id || "");
    profileAccountBusy = true;
    setProfileAccountError("");
    byId("profile-account-status").textContent = "Saving account changes…";
    updateProfileAccountForm();
    try {
      var data = await mutate("/profile", payload);
      if (generation !== profileAccountGeneration || playerId !== String(state.player && state.player.id || "")) return;
      if (!data.player || String(data.player.id || "") !== playerId) throw Error("The saved account could not be loaded. Try again.");
      state.player = data.player;
      if (typeof data.session_proof === "string" && data.session_proof) state.sessionProof = data.session_proof;
      if (typeof data.csrf === "string" && data.csrf) state.csrf = data.csrf;
      if (data.session_proof || data.csrf) persistAuth();
      renderIdentityAvatar();
      byId("welcome-name").textContent = state.player.display_name || state.player.name || state.player.username || "";
      refreshAll(true);
      profileAccountBusy = false;
      closeProfileAccountDialog(true);
    } catch (err) {
      if (generation !== profileAccountGeneration || playerId !== String(state.player && state.player.id || "")) return;
      profileAccountBusy = false;
      byId("profile-account-status").textContent = "";
      setProfileAccountError(err.message || "Could not save the account changes. Try again.");
      updateProfileAccountForm();
    }
  }

  function reactionFavoritesKey(player) {
    var id = String(player && player.id || "");
    return id ? REACTION_FAVORITES_STORAGE_PREFIX + id : "";
  }

  function normalizedReactionFavorites(value) {
    var selected = [];
    (Array.isArray(value) ? value : []).forEach(function (emoji) {
      if (REACTION_EMOJIS.indexOf(emoji) >= 0 && selected.indexOf(emoji) < 0 && selected.length < 3) {
        selected.push(emoji);
      }
    });
    DEFAULT_REACTION_FAVORITES.concat(REACTION_EMOJIS).forEach(function (emoji) {
      if (selected.length < 3 && selected.indexOf(emoji) < 0) selected.push(emoji);
    });
    return selected.slice(0, 3);
  }

  function loadReactionFavorites(player) {
    var key = reactionFavoritesKey(player || state.player);
    if (!key) {
      state.reactionFavorites = DEFAULT_REACTION_FAVORITES.slice();
      return;
    }
    try {
      state.reactionFavorites = normalizedReactionFavorites(
        JSON.parse(window.localStorage.getItem(key) || "null"),
      );
    } catch (err) {
      state.reactionFavorites = DEFAULT_REACTION_FAVORITES.slice();
    }
  }

  function saveReactionFavorites(favorites) {
    state.reactionFavorites = normalizedReactionFavorites(favorites);
    var key = reactionFavoritesKey(state.player);
    if (!key) return;
    try { window.localStorage.setItem(key, JSON.stringify(state.reactionFavorites)); } catch (err) {}
  }

  function resetReactionStream() {
    state.reactions = { tableId: "", cursor: null, pending: [], loading: false, requestId: 0 };
    state.reactionSending = false;
    state.reactionLastSentAt = 0;
    var layer = byId("reaction-burst-layer");
    if (layer) layer.replaceChildren();
  }

  function setActiveTableId(value) {
    var next = String(value || "");
    if (next !== String(state.activeTableId || "")) resetReactionStream();
    state.activeTableId = next;
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

  function winnerChipValue(value, view) {
    var amount = number(value, 0);
    var displayValue = tableChipValue(amount, view);
    var unitValue = amount;
    if (tableUsesBigBlinds(view)) {
      unitValue = amount / Math.max(1, blindParts(view || state.tableView).big);
    }
    if (unitValue < 1000) return displayValue;
    var divisor = 1000;
    var suffix = "k";
    if (unitValue >= 1000000000) {
      divisor = 1000000000;
      suffix = "B";
    } else if (unitValue >= 1000000) {
      divisor = 1000000;
      suffix = "M";
    }
    var scaled = unitValue / divisor;
    var digits = scaled < 10 ? 2 : (scaled < 100 ? 1 : 0);
    var formatted = new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(scaled);
    return formatted + suffix;
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

  function syncTableAnnouncementRegion() {
    var region = byId("table-announcements");
    if (!region) return;
    region.hidden = !Array.prototype.some.call(region.children, function (child) {
      return !child.hidden;
    });
  }

  function routeNoticeForTable() {
    var node = byId("notice");
    var region = byId("table-announcements");
    var main = document.querySelector("main");
    if (!node || !main) return;
    if (state.player && state.activeTableId && state.tableView && region) {
      if (node.parentNode !== region) region.insertBefore(node, region.firstChild);
    } else {
      var historyDialog = byId("history-dialog");
      if (node.parentNode !== main) main.insertBefore(node, historyDialog || null);
    }
    syncTableAnnouncementRegion();
  }

  function showNotice(message, kind, persistent) {
    var node = byId("notice");
    routeNoticeForTable();
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
        syncTableAnnouncementRegion();
      }, 6000);
    }
    syncTableAnnouncementRegion();
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
        syncTableAnnouncementRegion();
      }, 6000);
    }
    syncTableAnnouncementRegion();
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
    syncTableAnnouncementRegion();
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
    syncTableAnnouncementRegion();
  }

  function deadlineRemainingMs(view, deadline) {
    var until = epochMilliseconds(deadline);
    var serverNow = epochMilliseconds(view && view.server_now) || Date.now();
    return until ? Math.max(0, until - serverNow) : 0;
  }

  function announcementRemainingMs(view, announcement) {
    var serverNow = epochMilliseconds(view && view.server_now) || Date.now();
    var starts = epochMilliseconds(announcement && announcement.starts_at);
    if (starts && starts > serverNow) return 0;
    return deadlineRemainingMs(view, announcement && announcement.until);
  }

  function showdownRemainingMs(view) {
    if (!view) return 0;
    var deadline = view.showdown_until || (view.hand && view.hand.showdown_until);
    return deadline != null
      ? deadlineRemainingMs(view, deadline)
      : (String(view.street || "").toLowerCase() === "showdown" ? 1 : 0);
  }

  function presentationRemainingMs(view) {
    if (!view) return 0;
    var deadline = view.presentation_until || (view.hand && view.hand.presentation_until);
    return Math.max(
      deadline == null ? 0 : deadlineRemainingMs(view, deadline),
      showdownRemainingMs(view),
      announcementRemainingMs(view, view.elimination_announcement),
      announcementRemainingMs(view, view.blind_announcement)
    );
  }

  function nextAuthoritativeBoundaryDelay(view) {
    if (!view || view.paused) return 0;
    var hand = view.hand || {};
    var serverNow = epochMilliseconds(view.server_now) || Date.now();
    var deadlines = [
      view.showdown_until || hand.showdown_until,
      view.elimination_announcement && view.elimination_announcement.until,
      view.blind_announcement && view.blind_announcement.until,
      view.presentation_until || hand.presentation_until,
      view.next_hand_at || hand.next_hand_at,
      view.runout_at || hand.runout_at
    ];
    var earliest = 0;
    deadlines.forEach(function (deadline) {
      var until = epochMilliseconds(deadline);
      if (until > serverNow && (!earliest || until < earliest)) earliest = until;
    });
    return earliest ? Math.max(40, earliest - serverNow + 35) : 0;
  }

  function blindAnnouncementHoldRemainingMs(view) {
    if (!view || String(view.street || "").toLowerCase() !== "showdown") return 0;
    var rows = Array.isArray(view.showdown) ? view.showdown : [];
    var deadline = null;
    if (rows.length) {
      var hand = view.hand || {};
      deadline = view.showdown_until || hand.showdown_until;
    } else {
      var winners = Array.isArray(view.winners) ? view.winners : [];
      var hasUncontestedWinner = winners.some(function (winner) {
        return number(winner && winner.amount, 0) > 0;
      });
      if (hasUncontestedWinner) {
        var completedHand = view.hand || {};
        deadline = view.hand_complete_at || completedHand.hand_complete_at;
      }
    }
    return deadline == null ? 0 : deadlineRemainingMs(view, deadline);
  }

  function announceBlindLevel(announcement, view) {
    var node = byId("blind-announcement");
    if (!node) return;
    var remainingMs = announcementRemainingMs(view, announcement);
    var winnerHoldMs = blindAnnouncementHoldRemainingMs(view);
    if (!announcement || remainingMs <= 0 || winnerHoldMs > 0) {
      clearBlindAnnouncement(false);
      return;
    }
    if (state.blindAnnouncementTimer) window.clearTimeout(state.blindAnnouncementTimer);
    var blindText = "Blinds going up\nSmall: " + chips(announcement.small) +
      "\nBig: " + chips(announcement.big);
    if (node.textContent !== blindText) node.textContent = blindText;
    node.dataset.secondsRemaining = String(Math.ceil(remainingMs / 1000));
    node.hidden = false;
    syncTableAnnouncementRegion();
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
    var eliminationText = lines.length ? lines.join(" ") : "A player was eliminated.";
    if (node.textContent !== eliminationText) node.textContent = eliminationText;
    node.dataset.secondsRemaining = String(Math.ceil(remainingMs / 1000));
    node.hidden = false;
    syncTableAnnouncementRegion();
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

  function focusTableControl(id) {
    var control = byId(id);
    if (control && control.isConnected && !control.hidden && !control.disabled &&
        control.getClientRects().length) {
      var details = control.closest("details");
      if (!details || details.open) {
        control.focus({ preventScroll: true });
        return;
      }
    }
    var menuSummary = byId("table-menu") && byId("table-menu").querySelector(":scope > summary");
    if (menuSummary && menuSummary.isConnected && menuSummary.getClientRects().length) {
      menuSummary.focus({ preventScroll: true });
    }
  }

  function renderReactionSettingsDialog() {
    var selects = Array.from(document.querySelectorAll("[data-reaction-select]"));
    selects.forEach(function (select, index) {
      var selected = state.reactionFavorites[index];
      select.replaceChildren();
      REACTION_EMOJIS.forEach(function (emoji) {
        var option = document.createElement("option");
        option.value = emoji;
        option.textContent = emoji + "  " + REACTION_EMOJI_LABELS[emoji];
        select.appendChild(option);
      });
      select.value = selected;
    });
    syncReactionSelectOptions();
    byId("reaction-settings-error").hidden = true;
    byId("reaction-settings-error").textContent = "";
  }

  function syncReactionSelectOptions() {
    var selects = Array.from(document.querySelectorAll("[data-reaction-select]"));
    var values = selects.map(function (select) { return select.value; });
    selects.forEach(function (select) {
      Array.from(select.options).forEach(function (option) {
        option.disabled = option.value !== select.value && values.indexOf(option.value) >= 0;
      });
    });
  }

  var reactionSettingsReturnFocus = null;
  var reactionTouchHoldTimer = 0;
  var reactionTouchHoldButton = null;
  var reactionTouchHoldPointerId = null;
  var reactionTouchHoldStart = null;
  var reactionTouchHoldFired = false;
  var avatarPreviewRequestSerial = 0;
  var avatarPreviewTrigger = null;
  var rebuyOfferCurrentId = "";
  var rebuyOfferDeadlineMs = 0;
  var rebuyOfferRemainingMs = 0;
  var rebuyOfferUpdatedAt = 0;
  var rebuyOfferTimer = 0;
  var rebuyActionPending = false;
  var pendingPhotoGateSeat = "";
  var reactionTouchSuppressClickButton = null;

  function openReactionSettingsDialog(slotIndex, trigger) {
    if (state.isAdmin) return;
    var dialog = byId("reaction-settings-dialog");
    if (!dialog) return;
    renderReactionSettingsDialog();
    reactionSettingsReturnFocus = trigger || byId("reaction-settings-button");
    byId("reaction-settings-button").setAttribute("aria-expanded", "true");
    if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
    else dialog.setAttribute("open", "");
    var selects = Array.from(document.querySelectorAll("[data-reaction-select]"));
    var selected = Number(slotIndex);
    if (Number.isInteger(selected) && selected >= 0 && selected < selects.length) {
      selects[selected].focus({ preventScroll: true });
    }
  }

  function closeReactionSettingsDialog(restoreFocus) {
    var dialog = byId("reaction-settings-dialog");
    if (dialog && dialog.open) dialog.close();
    byId("reaction-settings-button").setAttribute("aria-expanded", "false");
    var trigger = reactionSettingsReturnFocus;
    reactionSettingsReturnFocus = null;
    if (restoreFocus) {
      if (trigger && trigger.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true });
      else focusTableControl("reaction-settings-button");
    }
  }

  function closeRecentActionDialog(restoreFocus) {
    var dialog = byId("recent-action-dialog");
    if (dialog && dialog.open) dialog.close();
    var trigger = byId("recent-action-button");
    if (trigger) trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) focusTableControl("recent-action-button");
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
    var olderHand = byId("last-hand-older");
    var newerHand = byId("last-hand-newer");
    var historyPosition = byId("last-hand-history-position");
    if (!content || !streetLabel || !previous || !next || !olderHand || !newerHand || !historyPosition) return;

    if (stateReplay.loading) {
      streetLabel.textContent = "Loading";
      content.setAttribute("aria-busy", "true");
      content.innerHTML = '<p class="replay-status" role="status">Loading the last hand…</p>';
      previous.disabled = true;
      next.disabled = true;
      olderHand.disabled = true;
      newerHand.disabled = true;
      historyPosition.textContent = "";
      return;
    }
    content.setAttribute("aria-busy", "false");
    if (stateReplay.error) {
      streetLabel.textContent = "Unavailable";
      content.innerHTML = '<p class="replay-error" role="alert">' + esc(stateReplay.error) + '</p>';
      previous.disabled = true;
      next.disabled = true;
      olderHand.disabled = true;
      newerHand.disabled = true;
      historyPosition.textContent = "";
      return;
    }
    if (!stateReplay.hand) {
      streetLabel.textContent = "No completed hand";
      content.innerHTML = '<p class="replay-empty">No completed hand is available yet.</p>';
      previous.disabled = true;
      next.disabled = true;
      olderHand.disabled = true;
      newerHand.disabled = true;
      historyPosition.textContent = "";
      return;
    }

    var hand = stateReplay.hand;
    var streets = replayStreets(hand);
    var index = Math.max(0, Math.min(streets.length - 1, stateReplay.streetIndex));
    stateReplay.streetIndex = index;
    var street = streets[index] || {};
    var board = cardArray(street.board);
    var players = Array.isArray(hand.players) ? hand.players : [];
    var showdownRows = Array.isArray(hand.showdown) ? hand.showdown : [];
    var rankMap = hand.hand_ranks && typeof hand.hand_ranks === "object" ? hand.hand_ranks : {};
    var winnerRows = Array.isArray(hand.winners) ? hand.winners : [];
    var handNumber = number(hand.number, 0);
    var historyCount = Math.max(1, number(hand.history_count, 1));
    streetLabel.textContent = "Hand " + handNumber + (historyCount > 1 ? " · " + historyCount + " saved hands" : "") + " · " + replayStreetName(street.name);
    historyPosition.textContent = historyCount > 1 ? "Hand " + handNumber + " · " + historyCount + " saved hands" : "Only saved hand";
    var boardMarkup = board.length
      ? board.map(function (card) { return playingCardHTML(card, true); }).join("")
      : '<span class="replay-no-cards">No community cards yet</span>';
    var showdownByPlayer = Object.create(null);
    showdownRows.forEach(function (row) {
      var id = String(row && row.player_id || "");
      if (id) showdownByPlayer[id] = row;
    });
    var hasShowdownInfo = showdownRows.length > 0 || Object.keys(rankMap).length > 0;
    var winnerMarkup = winnerRows.map(function (winner) {
      var id = String(winner && winner.player_id || "");
      var row = showdownByPlayer[id] || {};
      var amount = number(winner && winner.amount,
        number(hand.pot_winnings && hand.pot_winnings[id], number(row.payout, 0)));
      if (amount <= 0) return "";
      var name = String(winner && winner.name || row.name || "Player");
      var rank = handRankName(row, rankMap, winner);
      return '<li class="replay-winner-line"><strong>' + esc(name) + ' won ' +
        esc(chips(amount)) + ' chips' + (rank ? ' with ' + esc(rank) : (hasShowdownInfo ? '' : ' without showdown')) + '.</strong></li>';
    }).filter(Boolean).join("");
    var exposedRows = showdownRows.slice();
    if (!exposedRows.length) {
      Object.keys(rankMap).forEach(function (id) {
        var rank = rankMap[id];
        var player = players.find(function (candidate) {
          return String(candidate && candidate.player_id || "") === id;
        }) || {};
        exposedRows.push({
          player_id: id,
          name: player.name || "Player",
          hand_name: rank && rank.hand_name || ""
        });
      });
    }
    var rankMarkup = exposedRows.map(function (row) {
      var rank = handRankName(row, rankMap);
      if (!rank) return "";
      return '<li class="replay-rank-line"><span>' + esc(row.name || "Player") +
        '</span><strong>' + esc(rank) + '</strong></li>';
    }).filter(Boolean).join("");
    var outcomeMarkup = winnerMarkup || rankMarkup
      ? '<section class="replay-outcome" aria-label="Hand result">' +
        (winnerMarkup ? '<div class="replay-winners"><h3>Winners</h3><ul>' + winnerMarkup + '</ul></div>' : '') +
        (rankMarkup ? '<div class="replay-ranks"><h3>Exposed hand ranks</h3><ul>' + rankMarkup + '</ul></div>' : '') +
        '</section>'
      : '';
    var playerMarkup = players.map(function (player) {
      var cards = cardArray(player && player.cards);
      var seatNo = number(player && player.seat_no, -1);
      var playerId = String(player && player.player_id || "");
      var isViewer = playerId === String(state.player && state.player.id || "");
      var name = String(player && player.name || "Player") + (isViewer ? " (you)" : "");
      var rank = handRankName(showdownByPlayer[playerId] || {}, rankMap);
      var cardMarkup = cards.length
        ? cards.map(function (card) { return playingCardHTML(card, true); }).join("")
        : '<span class="replay-cards-hidden">Cards not exposed</span>';
      return '<article class="replay-player" role="listitem">' +
        '<h3 class="replay-player-name">' + esc(name) + '</h3>' +
        '<span class="replay-player-stack">' + (seatNo >= 0 ? "Seat " + (seatNo + 1) : "Seated player") + '</span>' +
        (rank ? '<span class="replay-player-rank">' + esc(rank) + '</span>' : '') +
        '<div class="replay-player-cards" aria-label="' + esc(cards.length ? "Visible cards" : "No visible cards") + '">' + cardMarkup + '</div>' +
      '</article>';
    }).join("");
    var transcript = hand.history_text
      ? '<details class="replay-transcript"><summary>Hand history text</summary><pre>' + esc(hand.history_text) + '</pre></details>'
      : '';
    content.innerHTML =
      '<p class="replay-live-note">Replay of this completed hand.</p>' +
      outcomeMarkup +
      '<section class="replay-board" aria-label="Community cards">' +
        '<h3>Community cards</h3><div class="replay-board-cards">' + boardMarkup + '</div>' +
      '</section>' +
      '<div class="replay-players" role="list" aria-label="Players in the hand">' +
        (playerMarkup || '<p class="replay-empty">Player details are unavailable.</p>') +
      '</div>' + transcript;
    previous.disabled = index <= 0;
    next.disabled = index >= streets.length - 1;
    olderHand.disabled = !Number.isInteger(hand.previous_hand_number);
    newerHand.disabled = !Number.isInteger(hand.next_hand_number);
  }

  function lastHandRequestIsCurrent(requestId, tableId, playerId) {
    var replay = state.lastHandReplay;
    var dialog = byId("last-hand-dialog");
    return Boolean(replay.requestId === requestId && replay.tableId === tableId &&
      replay.playerId === playerId && state.activeTableId === tableId &&
      String(state.player && state.player.id || "") === playerId && dialog && dialog.open);
  }

  async function fetchLastHand(requestId, tableId, playerId, handNumber) {
    try {
      var path = "/tables/" + encodeURIComponent(tableId) + "/last-hand";
      if (Number.isInteger(handNumber)) path += "?number=" + encodeURIComponent(handNumber);
      var data = await request(path);
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
    fetchLastHand(replay.requestId, replay.tableId, replay.playerId, null);
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
    var olderHand = byId("last-hand-older");
    var newerHand = byId("last-hand-newer");
    var historyPosition = byId("last-hand-history-position");
    if (previous) previous.disabled = true;
    if (next) next.disabled = true;
    if (olderHand) olderHand.disabled = true;
    if (newerHand) newerHand.disabled = true;
    if (historyPosition) historyPosition.textContent = "";
    syncLastHandButton();
    if (restoreFocus) focusTableControl(trigger && trigger.id || "last-hand-button");
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

  function moveLastHandRecord(delta) {
    var replay = state.lastHandReplay;
    if (!replay.hand || replay.loading) return;
    var handNumber = delta < 0
      ? replay.hand.previous_hand_number
      : replay.hand.next_hand_number;
    if (!Number.isInteger(handNumber)) return;
    replay.requestId += 1;
    replay.hand = null;
    replay.streetIndex = 0;
    replay.loading = true;
    replay.error = "";
    renderLastHandReplay();
    fetchLastHand(replay.requestId, replay.tableId, replay.playerId, handNumber);
  }

  function clearNotice() {
    showNotice("", "info", true);
  }

  function setLoggedOut(message) {
    closeLastHandDialog(false);
    clearChat();
    state.sitOutRequestId += 1;
    state.sitOutPending = false;
    closeProfilePhotoDialog(false);
    closeProfileAccountDialog(false);
    clearAvatarCache();
    state.player = null;
    renderIdentityAvatar();
    state.reactionFavorites = DEFAULT_REACTION_FAVORITES.slice();
    resetReactionStream();
    state.isAdmin = false;
    document.body.classList.remove("admin-active");
    byId("admin-panel").hidden = true;
    state.showBigBlinds = false;
    document.body.classList.remove("gameplay-active");
    clearBlindAnnouncement(true);
    closeRecentActionDialog();
    setAuthMode("login");
    if (byId("history-dialog").open) byId("history-dialog").close();
    byId("history-content").replaceChildren();
    closeAdminHistoryDialog(false);
    state.adminHistoryListGeneration += 1;
    state.adminHistoryDetailGeneration += 1;
    state.adminHistoryLoading = false;
    state.adminHistoryDetailLoading = false;
    state.adminHistory = [];
    state.adminHistorySelectedIds = [];
    state.adminHistorySelectionMessage = "";
    state.adminHistoryNextOffset = null;
    state.adminHistoryError = "";
    renderAdminHistory();
    state.adminHistoryDetail = null;
    state.adminHistoryDetailError = "";
    state.adminHistoryDetailId = "";
    state.adminHistoryTrigger = null;
    state.adminHistoryDeleteTarget = null;
    clearAuth();
    state.tableView = null;
    state.tables = [];
    setActiveTableId("");
    state.skipAutoResume = false;
    state.polling = false;
    state.refreshPending = false;
    clearSeatTurnClock();
    clearBlindLevelClock();
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
    var topline = byId("chat-topline");
    var preview = byId("chat-preview");
    var quickForm = byId("chat-quick-form");
    if (!button || !panel) return;
    var available = Boolean(state.player && !state.isAdmin && state.activeTableId && state.tableView);
    button.hidden = !available;
    if (topline) {
      topline.hidden = !available;
      topline.classList.toggle("is-chat-active", available);
    }
    if (preview) preview.hidden = !available;
    if (quickForm) quickForm.hidden = !available;
    button.setAttribute("aria-expanded", String(Boolean(state.chat.open && !panel.hidden)));
    updateChatCharacterCount();
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
    if (lines.length !== 3) return;
    var latest = state.chat.messages[state.chat.messages.length - 1];
    if (!latest) {
      setChatPreviewLine(lines[0], state.chat.error ? "Chat is unavailable." : (state.chat.loaded ? "No messages yet." : "Loading chat…"), null, null);
    } else {
      var text = String(latest.name || "Player") + ": " + String(latest.text || "");
      setChatPreviewLine(lines[0], text, text, latest.id);
    }
    for (var i = 1; i < lines.length; i += 1) {
      lines[i].textContent = "";
      lines[i].hidden = true;
      if (lines[i].hasAttribute("title")) lines[i].removeAttribute("title");
      if (lines[i].hasAttribute("data-message-id")) lines[i].removeAttribute("data-message-id");
    }
    lines[0].hidden = false;
  }

  function setChatError(message, source) {
    state.chat.error = message || "";
    state.chat.errorSource = state.chat.error ? (source || "") : "";
    if (state.chat.error) state.chat.status = "";
    var node = byId("chat-error");
    if (node) {
      node.textContent = state.chat.error;
      node.hidden = !state.chat.error;
    }
    var quickError = byId("chat-quick-error");
    if (quickError) {
      quickError.textContent = state.chat.error;
      quickError.hidden = !state.chat.error;
    }
    var quickStatus = byId("chat-quick-status");
    if (quickStatus && quickStatus.textContent !== (state.chat.status || "")) {
      quickStatus.textContent = state.chat.status || "";
    }
    renderChatPreview();
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
    chat.errorSource = "";
    chat.status = "";
    chat.fetchRequestId = 0;
    var panel = byId("chat-panel");
    var button = byId("chat-button");
    var messages = byId("chat-messages");
    var input = byId("chat-input");
    var quickInput = byId("chat-quick-input");
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
    if (quickInput) {
      quickInput.value = "";
      quickInput.disabled = false;
    }
    if (send) send.disabled = true;
    if (form) form.setAttribute("aria-busy", "false");
    var quickForm = byId("chat-quick-form");
    if (quickForm) quickForm.setAttribute("aria-busy", "false");
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
    var send = byId("chat-send-button");
    var quickInput = byId("chat-quick-input");
    var quickSend = byId("chat-quick-send");
    var quickStatus = byId("chat-quick-status");
    var sending = state.chat.sending || state.chat.postInFlight;
    var available = Boolean(state.activeTableId && state.player && state.tableView &&
      state.chat.tableId === String(state.activeTableId) &&
      state.chat.playerId === String(state.player.id || ""));
    if (input && count) {
      count.textContent = input.value.length + " / 500";
      if (send) send.disabled = sending || !String(input.value || "").trim() ||
        !state.chat.open || !available;
    }
    if (quickSend) quickSend.disabled = sending || !quickInput ||
      !String(quickInput.value || "").trim() || !available;
    if (quickStatus && quickStatus.textContent !== (state.chat.status || "")) {
      quickStatus.textContent = state.chat.status || "";
    }
    var form = byId("chat-form");
    var quickForm = byId("chat-quick-form");
    if (form) form.setAttribute("aria-busy", String(Boolean(sending)));
    if (quickForm) quickForm.setAttribute("aria-busy", String(Boolean(sending)));
  }

  function showChat() {
    var tableId = String(state.activeTableId || "");
    var playerId = String(state.player && state.player.id || "");
    if (!tableId || !playerId || !state.tableView) return;
    if (state.chat.tableId !== tableId || state.chat.playerId !== playerId) clearChat();
    var chat = state.chat;
    if (chat.timer) {
      window.clearTimeout(chat.timer);
      chat.timer = 0;
    }
    chat.tableId = tableId;
    chat.playerId = playerId;
    chat.open = true;
    chat.trigger = byId("chat-button");
    var panel = byId("chat-panel");
    panel.hidden = false;
    byId("chat-button").setAttribute("aria-expanded", "true");
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
      if (chat.errorSource === "fetch") setChatError("");
    } catch (err) {
      if (!chatRequestIsCurrent(requestId, tableId, playerId)) return;
      var message = err.message || "Chat could not be loaded.";
      if (chat.errorSource !== "send") setChatError(message, "fetch");
    } finally {
      if (chat.fetchRequestId === requestId) chat.fetchRequestId = 0;
      if (chatRequestIsCurrent(requestId, tableId, playerId)) scheduleChatPoll(requestId, tableId, playerId);
    }
  }

  async function sendChatMessage(input) {
    var chat = state.chat;
    input = input || byId("chat-input");
    var submittedValue = String(input && input.value || "");
    var submittedRevision = number(input && input.dataset.chatEditVersion, 0);
    var text = submittedValue.trim();
    if (!text || chat.sending || chat.postInFlight || !state.activeTableId || !state.player || !state.tableView) return;
    ensureChatScope();
    var tableId = String(state.activeTableId);
    var playerId = String(state.player.id || "");
    if (chat.tableId !== tableId || chat.playerId !== playerId) return;
    var requestId = chat.requestId;
    var postId = ++chat.postRequestSerial;
    chat.activePostId = postId;
    chat.postInFlight = true;
    chat.sending = true;
    setChatError("");
    chat.status = "Sending message…";
    input.disabled = true;
    updateChatCharacterCount();
    try {
      var data = await mutate("/tables/" + encodeURIComponent(tableId) + "/chat", { text: text });
      if (!chatRequestIsCurrent(requestId, tableId, playerId)) return;
      mergeChatMessages(data && data.message ? [data.message] : [], false);
      if (number(input.dataset.chatEditVersion, 0) === submittedRevision && input.value === submittedValue) {
        input.value = "";
      }
      chat.status = "Message sent.";
    } catch (err) {
      if (chatRequestIsCurrent(requestId, tableId, playerId)) {
        setChatError(err.message || "Your message could not be sent.", "send");
      }
    } finally {
      if (chat.activePostId === postId && chat.tableId === tableId && chat.playerId === playerId &&
          state.activeTableId === tableId && String(state.player && state.player.id || "") === playerId) {
        chat.postInFlight = false;
        chat.sending = false;
        input.disabled = false;
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
    if (status === "ended") return "Ended by host";
    if (status === "cancelled") return "Cancelled";
    if (status === "expired") return "Expired";
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

  function blindLevelSecondsRemaining() {
    if (!state.blindLevelClockKey) return -1;
    if (state.blindLevelClockPaused) return Math.max(0, Math.ceil(state.blindLevelRemainingMs / 1000));
    var elapsed = monotonicNow() - state.blindLevelClockUpdatedAt;
    return Math.max(0, Math.ceil((state.blindLevelRemainingMs - elapsed) / 1000));
  }

  function updateBlindLevelCountdownNode() {
    var node = byId("blind-level-countdown");
    if (!node) return;
    var seconds = blindLevelSecondsRemaining();
    var label = seconds >= 0 ? formatClock(seconds) : "—:—";
    if (node.textContent !== label) node.textContent = label;
    node.setAttribute("aria-label", seconds < 0
      ? "Blind level countdown unavailable"
      : (state.blindLevelClockPaused ? "Blind level countdown paused at " : "Next blind level in ") + label);
  }

  function clearBlindLevelClock() {
    if (state.blindLevelClockTimer) window.clearInterval(state.blindLevelClockTimer);
    state.blindLevelClockTimer = 0;
    state.blindLevelClockKey = "";
    state.blindLevelRemainingMs = 0;
    state.blindLevelClockUpdatedAt = 0;
    state.blindLevelClockPaused = false;
    updateBlindLevelCountdownNode();
  }

  function syncBlindLevelClock(view, blinds) {
    var node = byId("blind-level-countdown");
    if (!node || !view) return;
    if (["completed", "ended", "cancelled", "expired"].indexOf(String(view.status || "")) >= 0) {
      clearBlindLevelClock();
      node.textContent = "Final";
      node.setAttribute("aria-label", "Final blind level");
      return;
    }
    if (blinds.pending && !view.paused) {
      clearBlindLevelClock();
      node.textContent = "Next hand";
      node.setAttribute("aria-label", "Next blind level starts after this hand");
      return;
    }
    if (view.blinds && view.blinds.waiting_for_hand) {
      clearBlindLevelClock();
      node.textContent = "Next hand";
      node.setAttribute("aria-label", "Blind level countdown starts when the next hand begins");
      return;
    }
    var deadline = epochMilliseconds(blinds.nextAt);
    var serverNow = epochMilliseconds(view.server_now) || Date.now();
    var paused = Boolean(view.paused);
    var seconds = deadline > 0
      ? Math.max(0, (deadline - serverNow) / 1000)
      : number(blinds.seconds, -1);
    if (seconds < 0) {
      clearBlindLevelClock();
      return;
    }
    var tableId = String(view.id || state.activeTableId || "");
    state.blindLevelClockKey = [tableId, blinds.level, deadline || "relative", paused ? "paused" : "live"].join("|");
    state.blindLevelRemainingMs = Math.max(0, seconds * 1000);
    state.blindLevelClockUpdatedAt = monotonicNow();
    state.blindLevelClockPaused = paused;
    if (!state.blindLevelClockTimer) {
      state.blindLevelClockTimer = window.setInterval(updateBlindLevelCountdownNode, 250);
    }
    updateBlindLevelCountdownNode();
  }

  function renderTables() {
    var list = byId("table-list");
    var tables = (state.tables || []).filter(function (table) {
      return table && (table.status === "lobby" || table.status === "playing");
    });
    byId("table-count").textContent = String(tables.length);
    if (!tables.length) {
      list.innerHTML = '<div class="list-empty">No waiting or in-progress games.</div>';
      return;
    }

    list.innerHTML = tables.map(function (table) {
      var b = blindParts(table);
      var count = number(table.seated_count != null ? table.seated_count : table.players, 0);
      var max = number(table.max_seats, 0);
      var status = table.status || "lobby";
      var dot = status === "playing" ? "playing" : (status === "completed" ? "completed" : "");
      var label = statusName(status);
      var host = table.host_name ? "Host " + esc(table.host_name) : "Private table";
      return '<button type="button" class="table-card" data-open-table="' + esc(table.id) + '" data-table-status="' + esc(status) + '" aria-current="false">' +
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
    if (s === "s" || s === "spades" || s === "♠") return { symbol: "♠", name: "spades" };
    if (s === "h" || s === "hearts" || s === "♥") return { symbol: "♥", name: "hearts" };
    if (s === "d" || s === "diamonds" || s === "♦") return { symbol: "♦", name: "diamonds" };
    if (s === "c" || s === "clubs" || s === "♣") return { symbol: "♣", name: "clubs" };
    return { symbol: "", name: "" };
  }

  var cardGlyphCanvas = null;
  var cardGlyphCache = Object.create(null);
  function cardGlyphHTML(symbol) {
    if (cardGlyphCache[symbol]) return cardGlyphCache[symbol];
    if (!cardGlyphCanvas) cardGlyphCanvas = document.createElement("canvas");
    var context = cardGlyphCanvas.getContext("2d");
    if (!context) return esc(symbol);
    context.font = "900 100px Georgia, serif";
    var metrics = context.measureText(symbol);
    var left = number(metrics.actualBoundingBoxLeft, 0);
    var right = number(metrics.actualBoundingBoxRight, metrics.width);
    var ascent = number(metrics.actualBoundingBoxAscent, 75);
    var descent = number(metrics.actualBoundingBoxDescent, 0);
    // Font line boxes include unequal side bearings and baseline padding.
    // Fit the actual ink bounds into a shared centered viewport instead.
    var box = [-left, -ascent, Math.max(1, left + right), Math.max(1, ascent + descent)];
    var glyph = '<svg class="card-glyph" viewBox="' + box.join(" ") +
      '" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">' +
      '<text x="0" y="0" fill="currentColor" font-family="Georgia,serif" font-size="100" font-weight="900">' +
      esc(symbol) + '</text></svg>';
    cardGlyphCache[symbol] = glyph;
    return glyph;
  }

  function playingCardHTML(card, small) {
    var info = cardInfo(card);
    if (!info) return '<span class="' + (small ? "mini-card" : "playing-card") + ' placeholder" aria-hidden="true"></span>';
    var suit = cardSuit(info.suit);
    var rank = String(info.rank || "").toUpperCase();
    var cls = small ? "mini-card" : "playing-card";
    if (suit.name) cls += " suit-" + suit.name;
    if (small) return '<span class="' + cls + '" aria-label="' + esc(rank + " " + suit.symbol) + '"><b class="mini-rank">' + cardGlyphHTML(rank) + '</b><span class="mini-suit">' + cardGlyphHTML(suit.symbol) + '</span></span>';
    return '<span class="' + cls + '" aria-label="' + esc(rank + " " + suit.symbol) + '"><b class="rank">' + cardGlyphHTML(rank) + '</b><span class="suit">' + cardGlyphHTML(suit.symbol) + '</span></span>';
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

  function actionBadgeParts(actionState) {
    var event = actionState && actionState.rawEvent;
    if (!event) return { verb: String(actionState && (actionState.compactLabel || actionState.label) || ""), amount: "" };
    var action = String(event.action || "action").toLowerCase().replace(/[ -]+/g, "_");
    var paid = number(event.amount, 0);
    var streetTotal = number(event.street_contribution, paid);
    var actionTotal = action === "bet" || action === "raise" || action === "raise_to" || action === "all_in" || action === "allin" ? streetTotal : paid;
    var verbs = {
      fold: "FOLD",
      check: "CHECK",
      call: "CALL",
      bet: "BET",
      raise: "RAISE",
      raise_to: "RAISE",
      all_in: "ALL-IN",
      allin: "ALL-IN",
      small_blind: "SB",
      big_blind: "BB",
      ante: "ANTE"
    };
    var amount = actionTotal > 0 ? tableChipValue(actionTotal, state.tableView) : "";
    if (amount.length > 4 && !tableUsesBigBlinds(state.tableView)) amount = winnerChipValue(actionTotal, state.tableView);
    return { verb: verbs[action] || action.toUpperCase(), amount: amount };
  }

  function lastPlayerAction(view) {
    return (Array.isArray(view && view.events) ? view.events : []).slice().reverse().find(function (event) {
      return event.type === "action" && /^(fold|check|call|bet|raise|raise_to|all_in|allin)$/.test(String(event.action || ""));
    }) || null;
  }

  function renderLastAction(view) {
    var node = byId("last-action-summary");
    var event = lastPlayerAction(view);
    node.hidden = !event || view.status === "ended";
    if (node.hidden) { node.replaceChildren(); return; }
    var actor = String(event.actor_label || "Player");
    var action = eventActionText(event)[0] + (event.timed_out ? " (timed out)" : "");
    var markup = '<span class="last-action-actor">' + esc(actor) + '</span><strong class="last-action-detail">' + esc(action) + '</strong>';
    if (node.innerHTML !== markup) node.innerHTML = markup;
    node.title = "Last action: " + actor + " · " + action;
    node.setAttribute("aria-label", node.title);
  }

  // Only the announcement moves: keep the established card and seat geometry.
  function positionLastAction() {
    var node = byId("last-action-summary"), felt = byId("felt");
    var board = felt.querySelector(".board-center");
    var bounds = felt.getBoundingClientRect();
    if (!bounds.width || !bounds.height || !board) return;
    var style = window.getComputedStyle(node);
    var width = parseFloat(style.width), height = parseFloat(style.height);
    var b = board.getBoundingClientRect();
    var centerX = (b.left + b.right) / 2, centerY = (b.top + b.bottom) / 2;
    var blockers = Array.from(felt.querySelectorAll(".seat-card, .reaction-shortcuts, .board-center, #blind-strip")).map(function (n) {
      return n.getBoundingClientRect();
    }).filter(function (r) { return r.width && r.height; });
    function fits(point) {
      var x = point[0], y = point[1];
      return x >= bounds.left + 4 && x + width <= bounds.right - 4 &&
        y >= bounds.top + 4 && y + height <= bounds.bottom - 4 &&
        !blockers.some(function (r) {
          return x < r.right + .5 && x + width > r.left - .5 && y < r.bottom + .5 && y + height > r.top - .5;
        });
    }
    var candidates = [
      [centerX - width / 2, b.bottom + 5],
      [centerX - width / 2, b.top - height - 1],
      [b.right + 8, centerY - height / 2],
      [b.left - width - 8, centerY - height / 2]
    ];
    var point = candidates.find(fits);
    if (!point) {
      // Short mobile viewports can leave a gap offset from the board center.
      var gaps = [];
      for (var y = bounds.top + 4; y + height < bounds.bottom - 4; y += 4) {
        for (var x = bounds.left + 4; x + width < bounds.right - 4; x += 4) {
          if (fits([x, y])) gaps.push([x, y]);
        }
      }
      gaps.sort(function (a, c) {
        function distance(p) { return Math.pow(p[0] + width / 2 - centerX, 2) + Math.pow(p[1] + height / 2 - centerY, 2); }
        return distance(a) - distance(c);
      });
      point = gaps[0] || candidates[0];
    }
    node.style.left = (point[0] - bounds.left - felt.clientLeft) + "px";
    node.style.top = (point[1] - bounds.top - felt.clientTop) + "px";
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


  function boxForNode(node, gridRect) {
    if (!node || node.hidden) return null;
    var rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      left: rect.left - gridRect.left,
      top: rect.top - gridRect.top,
      right: rect.right - gridRect.left,
      bottom: rect.bottom - gridRect.top
    };
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
    updateShotClockAlert();
  }

  function updateShotClockAlert() {
    var node = byId("shot-clock-alert");
    var count = byId("shot-clock-number");
    var copy = byId("shot-clock-copy");
    if (!node || !count || !copy) return;
    var seconds = turnClockSecondsRemaining();
    var active = Boolean(state.seatTurnClockKey && seconds > 0 && seconds <= 5);
    node.hidden = !active;
    node.dataset.paused = String(Boolean(state.seatTurnClockPaused));
    if (!active) {
      node.removeAttribute("aria-label");
      return;
    }
    var value = String(seconds);
    if (count.textContent !== value) count.textContent = value;
    var label = seconds === 1 ? "SECOND LEFT TO ACT" : "SECONDS LEFT TO ACT";
    if (copy.textContent !== label) copy.textContent = label;
    node.setAttribute("aria-label", "Shot clock: " + seconds + " " + (seconds === 1 ? "second" : "seconds") + " left to act" +
      (state.seatTurnClockPaused ? ", paused" : ""));
  }

  function clearSeatTurnClock() {
    if (state.seatTurnClockTimer) window.clearInterval(state.seatTurnClockTimer);
    state.seatTurnClockTimer = 0;
    state.seatTurnClockKey = "";
    state.seatTurnRemainingMs = 0;
    state.seatTurnClockUpdatedAt = 0;
    state.seatTurnClockPaused = false;
    updateShotClockAlert();
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

  function renderReactionBursts() {
    var stream = state.reactions;
    if (!stream || stream.tableId !== String(state.activeTableId || "") || !stream.pending.length) return;
    var layer = byId("reaction-burst-layer");
    if (!layer) {
      stream.pending = [];
      return;
    }
    var layerRect = layer.getBoundingClientRect();
    var queue = stream.pending.splice(0, 32);
    queue.forEach(function (reaction) {
      var senderId = String(reaction && reaction.player_id || "");
      if (!senderId) return;
      var seat = Array.from(byId("seat-grid").querySelectorAll(".seat-card[data-player-id]")).find(function (node) {
        return node.getAttribute("data-player-id") === senderId;
      });
      if (!seat) return;
      var seatRect = seat.getBoundingClientRect();
      var startX = seatRect.left + seatRect.width / 2 - layerRect.left;
      var startY = seatRect.top + seatRect.height / 2 - layerRect.top;
      var moving = motionAllowed() && typeof Element.prototype.animate === "function";
      var count = moving ? 16 : 8;
      for (var i = 0; i < count; i += 1) {
        var angle = Math.PI * 2 * i / count + Math.PI / 8;
        var distance = moving ? 58 + (i % 4) * 12 : 38;
        var particle = document.createElement("span");
        particle.className = "reaction-particle";
        particle.textContent = String(reaction.emoji || "");
        particle.setAttribute("aria-hidden", "true");
        particle.style.left = (startX + (moving ? 0 : Math.cos(angle) * distance)) + "px";
        particle.style.top = (startY + (moving ? 0 : Math.sin(angle) * distance)) + "px";
        layer.appendChild(particle);
        if (!moving) {
          particle.classList.add("reaction-particle-static");
          window.setTimeout(function (node) { return function () { node.remove(); }; }(particle), 2600);
          continue;
        }
        var endX = Math.max(20, Math.min(layerRect.width - 20, startX + Math.cos(angle) * distance));
        var endY = Math.max(20, Math.min(layerRect.height - 20, startY + Math.sin(angle) * distance));
        var dx = endX - startX;
        var dy = endY - startY;
        var rotation = (i % 2 ? 1 : -1) * (20 + (i % 5) * 8);
        var animation = particle.animate([
          { transform: "translate(-50%, -50%) scale(.7) rotate(0deg)", opacity: 1, offset: 0 },
          { transform: "translate(calc(-50% + " + dx * .8 + "px), calc(-50% + " + dy * .8 + "px)) scale(1.12) rotate(" + rotation * .8 + "deg)", opacity: 1, offset: .35 },
          { transform: "translate(calc(-50% + " + dx + "px), calc(-50% + " + dy + "px)) scale(1.08) rotate(" + rotation + "deg)", opacity: 1, offset: .75 },
          { transform: "translate(calc(-50% + " + dx + "px), calc(-50% + " + (dy - 12) + "px)) scale(.95) rotate(" + rotation + "deg)", opacity: 0, offset: 1 }
        ], { duration: 2800 + (i % 4) * 120, easing: "ease-out", fill: "forwards" });
        animation.finished.catch(function () {}).then(function (node) { return function () { node.remove(); }; }(particle));
      }
    });
  }

  async function sendTableReaction(emoji) {
    var tableId = String(state.activeTableId || "");
    if (!tableId || !state.player || state.isAdmin || state.reactionSending ||
        REACTION_EMOJIS.indexOf(emoji) < 0 || Date.now() - state.reactionLastSentAt < 800) return;
    state.reactionSending = true;
    state.reactionLastSentAt = Date.now();
    try {
      await mutate("/tables/" + encodeURIComponent(tableId) + "/reactions", { emoji: emoji });
    } catch (err) {
      if (state.activeTableId === tableId && err.status !== 401) {
        showNotice(err.message, err.status === 429 ? "info" : "error", false);
      }
    } finally {
      if (state.activeTableId === tableId) state.reactionSending = false;
    }
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
    var ringOnlySeated = view.status === "playing" || view.status === "completed" || view.status === "ended";
    var bySeat = layout.bySeat;
    var viewer = view.viewer || {};
    var viewerId = String(viewer.player_id || (state.player && state.player.id) || "");
    var ownSeat = layout.seats.find(function (seat) {
      return String(seat.id || seat.player_id || "") === viewerId;
    });
    var viewerHasSeat = Boolean(ownSeat);
    var hostId = String(view.host_id || "");
    var isHost = Boolean(viewerId && viewerId === hostId);
    var anchorSeat = ownSeat || layout.seats.find(function (seat) {
      return String(seat.id || seat.player_id || "") === hostId;
    }) || layout.seats[0] || null;
    var anchorRawSeatNo = anchorSeat && anchorSeat.seat_no != null ? anchorSeat.seat_no : layout.seats.indexOf(anchorSeat);
    var anchorSeatNo = anchorSeat ? Math.floor(number(anchorRawSeatNo, 0)) : 0;
    var relativeBySeatNo = Object.create(null);
    for (var slot = 0; slot < max; slot += 1) {
      relativeBySeatNo[slot] = (slot - anchorSeatNo + max) % max;
    }
    var positionCount = max;
    var actorId = String(view.actor_id || view.to_act_id || "");
    var lastAction = lastPlayerAction(view);
    var lastActorId = eventActorId(lastAction);
    var buttonId = String(view.button_id || "");
    var currentHand = view.status === "playing";
    var fx = state.tableFx;
    var pendingWagers = queuedWagerAmounts(fx);
    var oddsByPlayer = Object.create(null);
    (Array.isArray(view.runout_odds) ? view.runout_odds : []).forEach(function (row) {
      var oddsId = String(row && row.player_id || "");
      if (oddsId) oddsByPlayer[oddsId] = row;
    });
    var showdown = String(view.street || "").toLowerCase() === "showdown";
    var winnerHand = String(view.hand_id || view.hand_no || (view.hand && view.hand.number) || "");
    var winnerAnimationKey = String(view.id || state.activeTableId || "") + "|" + winnerHand;
    var winnerAnimationElapsed = state.winnerAnimationKey === winnerAnimationKey && state.winnerAnimationStartedAt
      ? Math.max(0, monotonicNow() - state.winnerAnimationStartedAt) : 0;
    var winnerAnimationDuration = state.winnerAnimationDurationMs || 720;
    var animateWinners = Boolean(showdown && winnerHand && motionAllowed() && winnerAnimationElapsed < winnerAnimationDuration);
    var winnerAnimationDelay = animateWinners ? -Math.floor(winnerAnimationElapsed) : 0;
    var winnerFound = false;
    var html = "";

    for (var i = 0; i < max; i += 1) {
      var seat = bySeat[i];
      var relativeIndex = relativeBySeatNo[i];
      if (!seat) {
        if (ringOnlySeated) {
          html += '<div class="seat-card seat-reserved" data-seat-no="' + i + '" data-relative-seat="' + relativeIndex + '" data-seat-reserved="true" aria-label="Seat ' + (i + 1) + ' reserved"><div class="seat-local-markers" aria-hidden="true"></div></div>';
        } else {
          var emptySeatNo = i + 1;
          var emptyActions = "";
          var canAddBot = Boolean(isHost && view.status === "lobby");
          if (!viewerHasSeat) {
            emptyActions += '<button class="seat-empty-join" type="button" data-take-seat="' + i + '" aria-label="Take seat ' + emptySeatNo + '"><span>Take seat</span></button>';
          }
          if (canAddBot) {
            emptyActions += '<button class="seat-empty-bot" type="button" data-table-add-bot="' + i + '" aria-label="Add bot to seat ' + emptySeatNo + '">Add bot</button>';
          }
          if (!emptyActions) emptyActions = '<span class="seat-empty-open">Open</span>';
          var emptyClass = "seat-card seat-empty" + (!viewerHasSeat && canAddBot ? " has-secondary-action" : "");
          html += '<div class="' + emptyClass + '" data-seat-no="' + i + '" data-relative-seat="' + relativeIndex + '" data-seat-empty="true">' + emptyActions + '</div>';
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
      var statusText = String(seat.status || seat.state || "").toLowerCase();
      var explicitEliminated = Boolean(seat.eliminated || seat.is_eliminated || seat.eliminated_at ||
        /^(eliminated|out|busted)$/i.test(statusText));
      var finalRows = Array.isArray(view.standings) && view.standings.length
        ? view.standings : (Array.isArray(view.results) ? view.results : []);
      var finalRow = finalRows.find(function (row) {
        return String(row && row.player_id || "") === id;
      });
      var finalPlace = number(finalRow && (finalRow.place != null ? finalRow.place : finalRow.rank), 0);
      var finalWinner = (Array.isArray(view.winners) && view.winners.some(function (row) {
        return String(row && row.player_id || "") === id;
      })) || finalPlace === 1;
      var zeroStack = number(seat.stack, 0) <= 0;
      var terminalBust = zeroStack && seat.in_hand === false &&
        (view.status === "completed" || view.status === "ended") &&
        !(view.status === "completed" && finalWinner);
      var completedBust = view.status === "completed" && zeroStack && finalPlace > 1;
      var eliminated = explicitEliminated ||
        (view.status === "playing" && !seatCountsAsTournamentRemaining(view, seat)) ||
        terminalBust || completedBust;
      var classes = "seat-card seat-readable" + (isMe ? " is-me" : "") + (acting ? " is-acting" : "") +
        (folded ? " is-folded" : "") + (bot ? " is-bot" : "") + (eliminated ? " is-eliminated" : "") +
        (dealer ? " has-dealer" : "") + (id === lastActorId ? " is-last-actor" : "");
      if (relativeIndex > max / 2) classes += " is-right-seat";
      var sideSlots = max === 7 ? [2, 5] : (max >= 8 ? [2, 3, 6, 7] : []);
      if (sideSlots.indexOf(relativeIndex) >= 0) classes += " is-side-seat";
      var label = eliminated ? "Out" : (sittingOut ? "Sitting out" : (folded ? "Folded" : (allIn ? "All in" : "")));
      var stack = number(seat.stack, 0);
      var rawSeatNo = seat.seat_no != null ? seat.seat_no : i;
      var seatNo = String(Math.floor(number(rawSeatNo, i)));
      var actionState = currentHand && !showdown ? actionForSeat(seat, seatNo) : null;
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
      if (oddsRow && cards.length && !folded && stack <= 0) { allIn = true; label = eliminated ? "Out" : "All in"; }
      if (allIn && stack <= 0 && !eliminated) classes += " is-all-in is-zero-stack-all-in";
      var showdownRow = Array.isArray(view.showdown) ? view.showdown.find(function (row) {
        return String(row && row.player_id || "") === id;
      }) : null;
      var equityHtml = "";
      if (showdown) {
        var winner = Array.isArray(view.winners) ? view.winners.find(function (row) {
          return String(row && row.player_id || "") === id;
        }) : null;
        var winnings = number(winner && winner.amount,
          number(view.pot_winnings && view.pot_winnings[id], number(showdownRow && showdownRow.payout, 0)));
        if (winnings > 0) {
          winnerFound = true;
          classes += " is-hand-winner";
          var exactAmount = tableChips(winnings, view);
          var winnerName = String(winner && winner.name || seat.name || "Player");
          var winnerRank = String(winner && (winner.rank || winner.hand_name) || "");
          equityHtml = '<div class="seat-result is-winner' + (animateWinners ? ' winner-arrive' : '') + '"' +
            (animateWinners ? ' style="animation-delay:' + winnerAnimationDelay + 'ms"' : '') +
            ' data-winner-hand="' + esc(winnerHand) + '" data-player-id="' + esc(id) + '" aria-label="' + esc("Winner " + winnerName + ", plus " + exactAmount + (winnerRank ? ", " + winnerRank : "")) + '" title="' + esc("Winner · +" + exactAmount + (winnerRank ? " · " + winnerRank : "")) + '">' +
            '<span class="seat-result-label">Won</span><strong class="seat-result-amount">+' + esc(winnerChipValue(winnings, view)) + '</strong></div>';
        }
      } else if (oddsRow && cards.length && (isMe || exposed)) {
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
      if (!equityHtml) equityHtml = '<div class="seat-equity is-empty" aria-hidden="true"></div>';

      var stackDisplayValue = tableChipValue(stack, view);
      if (stackDisplayValue.length > 4) stackDisplayValue = winnerChipValue(stack, view);
      var stackExactLabel = "Stack: " + tableChips(stack, view);
      var stackContents = '<span class="seat-stack-amount">' + esc(stackDisplayValue) + '</span> <span class="seat-number">' + esc(tableChipUnit(view)) + '</span>';
      var stackHtml = "";
      if (isMe) {
        var nextChipDisplay = tableUsesBigBlinds() ? "chips" : "big blinds";
        var stackLabel = "Your stack: " + tableChips(stack) + ". Activate to display all table chip amounts in " + nextChipDisplay + ".";
        stackHtml = '<button class="seat-stack" type="button" data-chip-display-toggle aria-pressed="' +
          String(tableUsesBigBlinds(view)) + '" aria-label="' + esc(stackLabel) + '" title="' + esc(stackExactLabel) + '">' + stackContents + '</button>';
      } else {
        stackHtml = '<div class="seat-stack" aria-label="' + esc(stackExactLabel) + '" title="' + esc(stackExactLabel) + '">' + stackContents + '</div>';
      }
      var cardContents = "";
      var cardRowClass = "seat-cards";
      if (cards.length) {
        cardRowClass += exposed ? " is-exposed" : " is-viewer-cards";
        cardContents = cards.map(function (card) { return playingCardHTML(card, true); }).join("");
      } else if (currentHand && !isMe && seat.in_hand === true && !folded && !eliminated) {
        cardContents = hiddenCardHTML(true, false) + hiddenCardHTML(true, false);
      } else {
        cardRowClass += " is-empty";
        cardContents = "";
      }
      var cardHtml = '<div class="' + cardRowClass + '"' + (cardRowClass.indexOf("is-empty") >= 0 ? ' aria-hidden="true"' : '') + '>' + cardContents + '</div>';

      var seatName = String(seat.name || (bot ? "Test bot" : "Player"));
      var seatAvatarUrl = Object.prototype.hasOwnProperty.call(seat, "avatar_url")
        ? String(seat.avatar_url || "") : (isMe && state.player ? String(state.player.avatar_url || "") : "");
      var seatAvatarFullUrl = String(seat.avatar_full_url || seatAvatarUrl || "");
      if (isMe && profileAvatarOverride && profileAvatarOverride.playerId === id && Date.now() < profileAvatarOverride.expiresAt) {
        seatAvatarUrl = profileAvatarOverride.url;
        seatAvatarFullUrl = String(profileAvatarOverride.fullUrl || profileAvatarOverride.url || "");
      }
      var seatAvatar = avatarMarkup(seatAvatarUrl, seatName, "seat-avatar", {
        interactive: Boolean(seatAvatarUrl),
        fullUrl: seatAvatarFullUrl || seatAvatarUrl
      });
      // Blind position belongs to the hand, independently of the latest action.
      var blindRole = currentHand && String(view.street || "").toLowerCase() === "preflop"
        ? (id === String(view.small_blind_id || "") ? "Small blind" :
          (id === String(view.big_blind_id || "") ? "Big blind" : "")) : "";
      var blindMarkup = '<div class="seat-blind-position">' + (blindRole
        ? '<span class="seat-blind-badge" aria-label="' + esc(seatName + ": " + blindRole) + '">' + esc(blindRole) + '</span>' : "") + '</div>';
      var dealerChip = dealer
        ? '<span class="dealer-marker" data-marker-seat="' + esc(seatNo) + '" aria-label="Dealer button">D</span>'
        : "";
      var markerHtml = "";
      var actionMarkup = "";
      var statusText = label === "Sitting out" ? "Sit out" : label;
      var statusAccessible = label + (bot ? (label ? ", " : "") + "Test bot" : "");
      if (bot) statusText += (statusText ? " · " : "") + "BOT";
      if (statusText) markerHtml = '<span class="seat-status" aria-label="' + esc(statusAccessible || statusText) + '" title="' + esc(statusAccessible || statusText) + '">' + esc(statusText) + '</span>';
      var turnMarkup = "";
      if (actionState) {
        var badge = actionBadgeParts(actionState);
        var badgeText = badge.verb + (badge.amount ? " " + badge.amount : "");
        var actionDescription = String(actionState.label || actionState.compactLabel || badgeText);
        actionMarkup = '<span class="seat-action kind-' + esc(actionState.kind || "action") + '" data-action-seat="' + esc(seatNo) + '" aria-label="' + esc((seat.name || "Player") + ": " + actionDescription) + '" title="' + esc(actionDescription) + '">' +
          '<span class="seat-action-verb">' + esc(badge.verb) + '</span>' +
          (badge.amount ? '<span class="seat-action-value">' + esc(badge.amount) + '</span>' : '') + '</span>';
      }
      if (acting) {
        var turnClockMarkup = state.seatTurnClockKey
          ? '<span class="seat-turn-clock" data-turn-clock-seat="' + esc(seatNo) + '" aria-label="Time left">' + esc(turnClockLabel()) + '</span>'
          : '';
        turnMarkup = '<span class="seat-turn-indicator' + (turnClockMarkup ? ' has-clock' : '') + '" data-turn-seat="' + esc(seatNo) + '" aria-label="' + esc((seat.name || "Player") + " to act") + '">' +
          '<span class="seat-turn-label">TO ACT</span>' + turnClockMarkup + '</span>';
      }
      var wagerMarkup = "";
      var wager = number(fx.displayWagers[seatNo], 0);
      if (!fx.eventAware && !wager) wager = number(seat.bet != null ? seat.bet : seat.street_bet, 0);
      if (wager > 0) {
        wagerMarkup += '<span class="seat-wager seat-contribution" data-contribution="' + esc(wager) + '" data-seat-no="' + esc(seatNo) + '" aria-label="Street wager ' + esc(tableChips(wager)) + '" title="Street wager ' + esc(tableChips(wager)) + '"><span class="wager-stack" aria-hidden="true"><i></i><i></i><i></i></span><strong>' + esc(winnerChipValue(wager, view)) + '</strong><span class="wager-unit">' + esc(tableChipUnit(view)) + '</span></span>';
      } else if (number(pendingWagers[seatNo], 0) > 0) {
        var pendingWager = number(pendingWagers[seatNo], 0);
        wagerMarkup += '<span class="seat-wager seat-contribution is-reserved" data-contribution="' + esc(pendingWager) + '" data-seat-no="' + esc(seatNo) + '" aria-label="Pending street wager ' + esc(tableChips(pendingWager, view)) + '" title="Pending street wager ' + esc(tableChips(pendingWager, view)) + '"><span class="wager-stack" aria-hidden="true"><i></i><i></i><i></i></span><strong>' + esc(winnerChipValue(pendingWager, view)) + '</strong><span class="wager-unit">' + esc(tableChipUnit(view)) + '</span></span>';
      }
      var shownRank = showdown && showdownRow && cards.length
        ? handRankName(showdownRow, view.hand_ranks || {}) : "";
      if (shownRank && !statusText) {
        markerHtml = '<span class="seat-hand-strength" data-hand-strength="' + esc(id) +
          '" aria-label="' + esc(seatName + ": " + shownRank) + '"><span>' + esc(shownRank) + '</span></span>';
      }
      var markerLane = '<div class="seat-local-markers">' + markerHtml + '</div>';
      var playerInfo = '<div class="seat-player-info">' + seatAvatar +
        '<div class="seat-player-meta">' + stackHtml + markerLane + '</div></div>';
      // Once all-in odds exist, betting is locked. Show the equity instead of
      // letting a retained last-action badge hide the preflop runout estimate.
      var footerContent = oddsRow && !showdown ? equityHtml : (actionMarkup || equityHtml);
      var playerFooter = '<div class="seat-footer' + (actionMarkup ? ' has-action' : '') + '">' + footerContent + '</div>';
      html += '<div ' + (isMe ? 'id="hero-seat" ' : '') + 'class="' + classes + '" aria-label="Seat ' + esc(seatNo * 1 + 1) + ', ' + esc(seatName) + (eliminated ? ', out' : '') + '" data-seat-no="' + esc(seatNo) + '" data-player-id="' + esc(id) + '" data-relative-seat="' + relativeIndex + '" data-is-bot="' + (bot ? 'true' : 'false') + '">' +
        cardHtml +
        '<div class="seat-top' + (acting ? ' has-turn' : '') + '"><span class="seat-name-wrap"><span class="seat-name">' + esc(seatName) + '</span></span>' + turnMarkup + '</div>' + dealerChip +
        playerInfo + playerFooter + blindMarkup + wagerMarkup +
      '</div>';
    }

    var grid = byId("seat-grid");
    var felt = byId("felt");
    var restoreChipToggleFocus = Boolean(document.activeElement && document.activeElement.matches &&
      document.activeElement.matches("[data-chip-display-toggle]"));
    var previousAvatars = Object.create(null);
    grid.querySelectorAll(".seat-card[data-player-id] .seat-avatar").forEach(function (avatar) {
      var playerId = avatar.closest(".seat-card").getAttribute("data-player-id");
      if (avatar.getAttribute("data-avatar-url")) previousAvatars[playerId] = avatar;
    });
    grid.innerHTML = html;
    grid.querySelectorAll(".seat-card[data-player-id] .seat-avatar").forEach(function (avatar) {
      var playerId = avatar.closest(".seat-card").getAttribute("data-player-id");
      var previous = previousAvatars[playerId];
      if (previous && previous.getAttribute("data-avatar-url") === avatar.getAttribute("data-avatar-url")) {
        var previousFallback = previous.querySelector(".avatar-fallback-text");
        var nextFallback = avatar.querySelector(".avatar-fallback-text");
        if (previousFallback && nextFallback) previousFallback.textContent = nextFallback.textContent;
        ["data-avatar-full-url", "aria-label"].forEach(function (attribute) {
          var value = avatar.getAttribute(attribute);
          if (value == null) previous.removeAttribute(attribute);
          else previous.setAttribute(attribute, value);
        });
        avatar.replaceWith(previous);
      }
    });
    hydrateAvatarNodes(grid);
    if (restoreChipToggleFocus) {
      var replacementToggle = grid.querySelector("[data-chip-display-toggle]");
      if (replacementToggle) replacementToggle.focus({ preventScroll: true });
    }
    if (winnerFound && state.winnerAnimationKey !== winnerAnimationKey) {
      state.winnerAnimationKey = winnerAnimationKey;
      state.winnerAnimationStartedAt = monotonicNow();
      state.winnerAnimationDurationMs = 720;
      var animatedWinner = grid.querySelector(".seat-result.winner-arrive");
      if (animatedWinner && window.getComputedStyle) {
        var durationValue = String(window.getComputedStyle(animatedWinner).animationDuration || "").split(",")[0].trim();
        var durationNumber = parseFloat(durationValue);
        if (Number.isFinite(durationNumber) && durationNumber > 0) {
          state.winnerAnimationDurationMs = durationValue.endsWith("ms") ? durationNumber : durationNumber * 1000;
        }
      }
    }
    var compact = window.innerWidth <= 820 || grid.clientWidth < 500;
    felt.classList.toggle("exposed-ring", max >= 5 && Boolean((view.runout_odds || []).length));
    felt.dataset.compactLayout = compact ? "true" : "false";
    felt.classList.toggle("is-crowded", max >= 7);
    felt.classList.toggle("is-playing", currentHand || view.status === "completed" || view.status === "ended");
    felt.dataset.seatCount = String(max);
    var gridRect = grid.getBoundingClientRect();
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
    if ((currentHand || view.status === "completed" || view.status === "ended" || view.status === "lobby") &&
        window.SitNgoLayout && gridRect.width && gridRect.height) {
      var avoid = ["board-cards", "board-caption", "pot-display", "street-label", "blind-strip"].map(function (id) {
        return boxForNode(byId(id), gridRect);
      }).filter(Boolean);
      var nodes = Array.from(grid.querySelectorAll(".seat-card"));
      var seatsToFit = nodes.map(function (node, i) {
        var b = boxForNode(node, gridRect);
        var stableIndex = number(node.getAttribute("data-relative-seat"), i);
        return { id: i, index: stableIndex, relativeIndex: stableIndex, x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2,
          width: b.right - b.left, height: b.bottom - b.top, hero: node.classList.contains("is-me") };
      });
      var fitted = window.SitNgoLayout.fit({ width: gridRect.width, height: gridRect.height, seats: seatsToFit, blockers: avoid });
      fitted.forEach(function (point, i) {
        if (nodes[i].classList.contains("is-me")) return;
        nodes[i].style.left = (point.x / gridRect.width * 100).toFixed(3) + "%";
        nodes[i].style.top = (point.y / gridRect.height * 100).toFixed(3) + "%";
      });
    }

    // Fit the dealer chip beside its owner without covering enlarged faces.
    var dealerNode = grid.querySelector(".dealer-marker");
    if (dealerNode) {
      var owner = dealerNode.closest(".seat-card"), ownerBox = owner.getBoundingClientRect();
      var feltBox = felt.getBoundingClientRect();
      var markerSize = window.innerWidth <= 380 || window.innerHeight <= 450 ? 20 : 30;
      var blockedNodes = Array.from(grid.querySelectorAll(".seat-card")).filter(function (node) { return node !== owner; })
        .concat(Array.from(owner.querySelectorAll(".seat-name,.mini-card,.seat-avatar,.seat-stack,.seat-status,.seat-action,.seat-wager,.seat-equity,.seat-result,.seat-turn-indicator")))
        .concat(Array.from(felt.querySelectorAll(".board-center,#pot-display,#street-label,#blind-strip")));
      var blocked = blockedNodes.filter(function (node) {
        var style = window.getComputedStyle(node), rect = node.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      }).map(function (node) { return node.getBoundingClientRect(); });
      var preferred = { x:ownerBox.right - markerSize + 5, y:ownerBox.top - markerSize + 2 };
      var best = null, bestDistance = Infinity;
      function considerDealer(x, y) {
        var right = x + markerSize, bottom = y + markerSize;
        if (x < feltBox.left || right > feltBox.right || y < feltBox.top || bottom > feltBox.bottom) return;
        if (blocked.some(function (box) {
          return x < box.right + 1 && right > box.left - 1 && y < box.bottom + 1 && bottom > box.top - 1;
        })) return;
        var distance = Math.pow(x - preferred.x, 2) + Math.pow(y - preferred.y, 2);
        if (distance < bestDistance) { best = { x:x, y:y }; bestDistance = distance; }
      }
      considerDealer(preferred.x, preferred.y);
      if (!best) {
        for (var markerY = ownerBox.top - markerSize - 2; markerY <= ownerBox.bottom + 2; markerY += 2) {
          for (var markerX = ownerBox.left - markerSize - 2; markerX <= ownerBox.right + 2; markerX += 2) {
            considerDealer(markerX, markerY);
          }
        }
      }
      if (best) {
        ["width","min-width","max-width","height","min-height","max-height"].forEach(function (property) {
          dealerNode.style.setProperty(property, markerSize + "px", "important");
        });
        dealerNode.style.setProperty("left", (best.x - ownerBox.left - owner.clientLeft) + "px", "important");
        dealerNode.style.setProperty("top", (best.y - ownerBox.top - owner.clientTop) + "px", "important");
        dealerNode.style.setProperty("right", "auto", "important");
      }
    }

    placeSeatContributions(grid, felt);

    fx.wagerPositions = {};
    grid.querySelectorAll(".seat-wager").forEach(function (node) {
      var seatNo = String(node.getAttribute("data-seat-no"));
      var rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        fx.wagerPositions[seatNo] = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
    });
  }

  // Keep each street's chips on the felt, near their owner and clear of
  // every seat, the board, and other stacks. Positions feed the existing
  // bet-to-seat and sweep-to-pot animations.
  function placeSeatContributions(grid, felt) {
    var bounds = felt.getBoundingClientRect();
    var seats = Array.from(grid.querySelectorAll(".seat-card"));
    var obstacles = seats.concat(Array.from(felt.querySelectorAll(
      ".board-center, #blind-strip, .dealer-marker"
    ))).filter(function (node) {
      var style = window.getComputedStyle(node), box = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    }).map(function (node) { return node.getBoundingClientRect(); });
    var gap = window.innerWidth <= 340 ? 1 : 2;
    var center = { x:(bounds.left + bounds.right) / 2, y:(bounds.top + bounds.bottom) / 2 };
    grid.querySelectorAll(".seat-contribution").forEach(function (node) {
      var owner = node.closest(".seat-card"), box = owner.getBoundingClientRect();
      var width = node.offsetWidth, height = node.offsetHeight;
      var ox = (box.left + box.right) / 2, oy = (box.top + box.bottom) / 2;
      var dx = center.x - ox, dy = center.y - oy;
      var horizontal = Math.abs(dx) / Math.max(1, bounds.width) > Math.abs(dy) / Math.max(1, bounds.height);
      var preferred = horizontal
        ? { x:dx > 0 ? box.right + 5 : box.left - width - 5, y:oy - height / 2 }
        : { x:ox - width / 2, y:dy > 0 ? box.bottom + 5 : box.top - height - 5 };
      var best = null, bestScore = Infinity;
      function consider(x, y) {
        var right = x + width, bottom = y + height;
        if (x < bounds.left + 2 || right > bounds.right - 2 ||
            y < bounds.top + 2 || bottom > bounds.bottom - 2) return;
        if (obstacles.some(function (other) {
          return x < other.right + gap && right > other.left - gap &&
            y < other.bottom + gap && bottom > other.top - gap;
        })) return;
        var score = Math.pow(x - preferred.x, 2) + Math.pow(y - preferred.y, 2);
        if (score < bestScore) { bestScore = score; best = { x:x, y:y }; }
      }
      consider(preferred.x, preferred.y);
      // Search only the owner's neighborhood first; a crowded small screen can
      // need a corner or outward-facing stack instead of the inward edge.
      for (var y = box.top - height - 28; y <= box.bottom + 28; y += 3) {
        for (var x = box.left - width - 28; x <= box.right + 28; x += 3) consider(x, y);
      }
      if (!best) {
        for (var fy = bounds.top + 2; fy < bounds.bottom - height; fy += 4) {
          for (var fx = bounds.left + 2; fx < bounds.right - width; fx += 4) consider(fx, fy);
        }
      }
      if (best) {
        node.style.left = (best.x - box.left - owner.clientLeft) + "px";
        node.style.top = (best.y - box.top - owner.clientTop) + "px";
        obstacles.push({ left:best.x, top:best.y, right:best.x + width, bottom:best.y + height });
      }
    });
  }

  function renderBoard(view) {
    var cards = cardArray(view.board);
    if (!cards.length && view.hand && Array.isArray(view.hand.board)) cards = view.hand.board;
    var inProgress = view.status === "playing";
    var showBoard = inProgress || cards.length > 0;
    byId("board-caption").textContent = "";
    byId("board-caption").hidden = true;
    var slots = cards.map(function (card) { return playingCardHTML(card, false); });
    byId("board-cards").innerHTML = slots.join("");

    var pot = number(view.pot, view.hand && view.hand.pot);
    byId("pot-amount").textContent = tableChips(pot);
    byId("pot-label").textContent = "Pot";
    var potDisplay = byId("pot-display");
    potDisplay.hidden = !(inProgress || view.status === "completed");
    potDisplay.classList.toggle("is-empty", pot <= 0);
    var currentStreet = String(view.street || "").toLowerCase();
    byId("street-label").textContent = currentStreet && currentStreet !== "lobby" && currentStreet !== "preflop"
      ? currentStreet.replace(/_/g, " ").toUpperCase() : "";
    byId("street-label").hidden = !byId("street-label").textContent;
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
    var terminal = ["completed", "ended", "cancelled", "expired"].indexOf(String(view.status || "")) >= 0;
    var levelNote = terminal ? "Final level" : (view.paused ? "Paused" : (b.pending ? "Next hand" : (remaining >= 0 ? "Next level" : "Countdown unavailable")));
    var entries = [
      { label: "Level", value: String(b.level), note: levelNote },
      { label: "Blinds", value: blindsLabel, note: tableUsesBigBlinds(view) ? "Small / big · BB" : "Small / big" }
    ];
    byId("blind-strip").innerHTML = entries.map(function (entry) {
      if (entry.label === "Level") {
        return '<div class="blind-tile blind-level-tile"><span>Level</span><strong>' + esc(entry.value) +
          '</strong><em>' + esc(entry.note) + '</em><span id="blind-level-countdown" class="blind-level-countdown" role="timer" aria-live="off">--:--</span></div>';
      }
      return '<div class="blind-tile"><span>' + esc(entry.label) + '</span><strong>' + esc(entry.value) + '</strong><em>' + esc(entry.note) + '</em></div>';
    }).join("");
    syncBlindLevelClock(view, b);
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
    if (view.status !== "completed" || !results.length || presentationRemainingMs(view) > 0) {
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
    var prizePool = view.prize_pool_cents == null ? pool : number(view.prize_pool_cents, pool);
    var buyInCents = number(view.config && view.config.buy_in, 0) * 100;
    var totalBuyIns = results.reduce(function (sum,row) {return sum + number(row.buy_in_count, 0);}, 0);
    var totalRebuys = results.reduce(function (sum,row) {return sum + number(row.rebuy_count, 0);}, 0);
    var totalContributions = results.length && results.every(function (row) { return row.total_buy_in_cents != null; })
      ? results.reduce(function (sum,row) {return sum + number(row.total_buy_in_cents, 0);}, 0) : null;
    var resultCopy = results.some(function(row) {return row.award_cents != null;})
      ? "Prize pool " + dollars(prizePool) + " · Total buy-ins " + (totalContributions == null ? "Not recorded" : dollars(totalContributions)) +
        " (" + totalBuyIns + " entries, " + totalRebuys + " rebuys) · Buy-in " + dollars(buyInCents) +
        " · Payout shares " + (view.config && view.config.payout_percentages || []).join(" / ") + "%"
      : "Final standings for this freezeout.";
    byId("results-description").textContent = resultCopy;
    byId("results-list").innerHTML = results.map(function (row, index) {
      var place = number(row.place != null ? row.place : row.rank, index + 1);
      var suffix = place % 100 >= 11 && place % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[place % 10] || "th");
      var placeLabel = (placeCounts[place] > 1 ? "T-" : "") + place + suffix;
      var placeAria = (placeCounts[place] > 1 ? "Tied for " : "") + place + suffix + " place";
      var name = row.name || row.player_name || "Player";
      var rowStatus = String(row.status || "").toLowerCase();
      var detail = row.detail || (place === 1 ? "Tournament winner" : (row.eliminated_at || rowStatus === "eliminated" ? "Eliminated" : (row.status || "Final result")));
      detail += buyInAccountingCopy(row);
      if (row.award_is_estimate) detail += " · Estimated award";
      var awardRecorded = row.award_cents != null;
      var awardLabel = awardRecorded
        ? (row.award_is_estimate ? "Estimated " : "") + dollars(row.award_cents)
        : "Not recorded";
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

  function validPresetArray(value, min, max) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 5) return null;
    var result = [];
    for (var i = 0; i < value.length; i += 1) {
      var amount = Number(value[i]);
      if (!Number.isFinite(amount) || amount < min || amount > max || (i && amount <= result[i - 1])) return null;
      result.push(amount);
    }
    return result;
  }

  function globalBetPreferences() {
    var source = state.globalConfig && state.globalConfig.bet_presets || DEFAULT_GLOBAL_CONFIG.bet_presets;
    return {
      preflop_bb: validPresetArray(source.preflop_bb, 1, 200) || DEFAULT_GLOBAL_CONFIG.bet_presets.preflop_bb.slice(),
      postflop_percent: validPresetArray(source.postflop_percent, 1, 1000) || DEFAULT_GLOBAL_CONFIG.bet_presets.postflop_percent.slice()
    };
  }

  function parsePresetInput(id, min, max) {
    var parts = String(byId(id).value || "").trim().split(",").map(function (part) { return part.trim(); });
    if (parts.length < 1 || parts.length > 5 || parts.some(function (part) { return !/^\d+(?:\.\d{1,2})?$/.test(part); })) {
      throw Error("Enter 1 to 5 increasing values separated by commas.");
    }
    var values = parts.map(Number);
    if (values.some(function (value, index) {
      return !Number.isFinite(value) || value < min || value > max || (index > 0 && value <= values[index - 1]);
    })) throw Error("Values must increase from " + min + " to " + max + ".");
    return values;
  }

  function applyGlobalConfig(config) {
    if (!config || typeof config !== "object") return;
    var presets = config.bet_presets || {};
    var previous = state.globalConfig || DEFAULT_GLOBAL_CONFIG;
    state.globalConfig = {
      runout_seconds: number(config.runout_seconds, previous.runout_seconds),
      blind_announcement_seconds: number(config.blind_announcement_seconds, previous.blind_announcement_seconds),
      elimination_announcement_seconds: number(config.elimination_announcement_seconds, previous.elimination_announcement_seconds),
      showdown_seconds: number(config.showdown_seconds, previous.showdown_seconds),
      uncontested_seconds: number(config.uncontested_seconds, previous.uncontested_seconds),
      bet_presets: {
        preflop_bb: validPresetArray(presets.preflop_bb, 1, 200) || previous.bet_presets.preflop_bb.slice(),
        postflop_percent: validPresetArray(presets.postflop_percent, 1, 1000) || previous.bet_presets.postflop_percent.slice()
      }
    };
    state.adminConfigRefreshAt = Date.now();
    if (state.tableView) renderActions(state.tableView);
  }

  async function loadGlobalConfig() {
    var data = await request("/config");
    applyGlobalConfig(data.config || data);
  }

  function writeAdminConfigForm(config) {
    var presets = config.bet_presets || DEFAULT_GLOBAL_CONFIG.bet_presets;
    byId("admin-runout-seconds").value = String(config.runout_seconds);
    byId("admin-blind-announcement-seconds").value = String(config.blind_announcement_seconds);
    byId("admin-elimination-announcement-seconds").value = String(config.elimination_announcement_seconds);
    byId("admin-showdown-seconds").value = String(config.showdown_seconds);
    byId("admin-uncontested-seconds").value = String(config.uncontested_seconds);
    byId("admin-preflop-bb").value = presets.preflop_bb.join(", ");
    byId("admin-postflop-percent").value = presets.postflop_percent.join(", ");
  }

  async function loadAdminConfig() {
    if (!state.isAdmin) return;
    var status = byId("admin-config-status");
    status.textContent = "Loading room settings…";
    try {
      var data = await request("/admin/config");
      applyGlobalConfig(data.config || data);
      writeAdminConfigForm(state.globalConfig);
      byId("admin-config-error").hidden = true;
      state.adminConfigLoaded = true;
      status.textContent = "Pacing changes apply to upcoming transitions; active timers continue.";
    } catch (err) {
      status.textContent = "Could not load room settings.";
      byId("admin-config-error").textContent = err.message;
      byId("admin-config-error").hidden = false;
    }
  }

  async function saveAdminConfig(event) {
    event.preventDefault();
    if (!state.isAdmin || state.adminConfigSaving) return;
    var form = byId("admin-config-form");
    var error = byId("admin-config-error");
    error.hidden = true;
    var payload;
    try {
      payload = {
        runout_seconds: number(byId("admin-runout-seconds").value, 0),
        blind_announcement_seconds: number(byId("admin-blind-announcement-seconds").value, -1),
        elimination_announcement_seconds: number(byId("admin-elimination-announcement-seconds").value, -1),
        showdown_seconds: number(byId("admin-showdown-seconds").value, -1),
        uncontested_seconds: number(byId("admin-uncontested-seconds").value, -1),
        bet_presets: {
          preflop_bb: parsePresetInput("admin-preflop-bb", 1, 200),
          postflop_percent: parsePresetInput("admin-postflop-percent", 1, 1000)
        }
      };
      if (!form.checkValidity() || payload.runout_seconds < 1 || payload.runout_seconds > 3600 ||
          payload.blind_announcement_seconds < 0 || payload.blind_announcement_seconds > 60 ||
          payload.elimination_announcement_seconds < 0 || payload.elimination_announcement_seconds > 60 ||
          payload.showdown_seconds < 0 || payload.showdown_seconds > 60 ||
          payload.uncontested_seconds < 0 || payload.uncontested_seconds > 60) throw Error("Check the pacing values and preset ranges.");
    } catch (err) {
      error.textContent = err.message || "Check the room settings.";
      error.hidden = false;
      return;
    }
    state.adminConfigSaving = true;
    byId("admin-config-save").disabled = true;
    byId("admin-config-status").textContent = "Saving room settings…";
    try {
      var data = await mutate("/admin/config", payload);
      applyGlobalConfig(data.config || data);
      writeAdminConfigForm(state.globalConfig);
      byId("admin-config-status").textContent = "Saved. Existing scheduled timers will finish as planned.";
    } catch (err) {
      error.textContent = err.message || "Could not save room settings.";
      error.hidden = false;
      byId("admin-config-status").textContent = "Room settings were not saved.";
    } finally {
      state.adminConfigSaving = false;
      byId("admin-config-save").disabled = false;
    }
  }

  function renderAdminTables() {
    var list = byId("admin-tables-list");
    if (!state.adminTables.length) {
      list.innerHTML = '<p class="muted">No tables are open.</p>';
      return;
    }
    list.innerHTML = state.adminTables.map(function (table) {
      var seats = Array.isArray(table.seats) ? table.seats.length : number(table.seated_count, number(table.player_count, 0));
      return '<article class="admin-table-card" data-admin-table-id="' + esc(table.id) + '">' +
        '<div class="admin-table-card-heading"><div><h3>' + esc(table.name || "Table") + '</h3><p class="muted">' + esc(statusName(table.status)) + ' · ' + seats + ' seated</p></div>' +
        '<button class="button button-outline button-small" type="button" data-admin-inspect="' + esc(table.id) + '">Inspect</button></div>' +
        '<div class="admin-table-detail" data-admin-detail hidden></div></article>';
    }).join("");
  }

  async function loadAdminTables() {
    if (!state.isAdmin || state.adminTablesLoading) return;
    state.adminTablesLoading = true;
    var list = byId("admin-tables-list");
    list.setAttribute("aria-busy", "true");
    try {
      var data = await request("/tables");
      state.adminTables = Array.isArray(data.tables) ? data.tables : [];
      renderAdminTables();
    } catch (err) {
      list.innerHTML = '<p class="muted">Could not load tables: ' + esc(err.message) + '</p>';
    } finally {
      state.adminTablesLoading = false;
      list.removeAttribute("aria-busy");
    }
  }

  function renderAdminTableDetail(card, table) {
    var target = card.querySelector("[data-admin-detail]");
    var seats = Array.isArray(table.seats) ? table.seats : [];
    var status = String(table.status || "lobby");
    var max = Math.max(1, Math.min(9, number(table.max_seats, number(table.config && table.config.max_seats, 9))));
    var bySeat = Object.create(null);
    seats.forEach(function (seat, index) { bySeat[number(seat.seat_no, index)] = seat; });
    var seatRows = [];
    for (var i = 0; i < max; i += 1) {
      var seat = bySeat[i];
      if (seat) {
        var bot = isBotSeat(seat);
        seatRows.push('<div class="admin-seat-row"><span>Seat ' + (i + 1) + ' · ' + esc(seat.name || (bot ? "Test bot" : "Player")) + '</span>' +
          (bot && status === "lobby" ? '<button class="button button-quiet button-small" type="button" data-admin-remove-bot="' + i + '">Remove bot</button>' : '') + '</div>');
      } else if (status === "lobby") {
        seatRows.push('<div class="admin-seat-row"><span>Seat ' + (i + 1) + ' · Open</span><button class="button button-quiet button-small" type="button" data-admin-add-bot="' + i + '">Add test bot</button></div>');
      }
    }
    target.innerHTML = '<p class="muted">' + esc(statusName(status)) + ' · ' + seats.length + ' of ' + max + ' occupied</p>' +
      '<div class="admin-seat-list">' + seatRows.join("") + '</div>';
    target.hidden = false;
  }

  async function inspectAdminTable(card) {
    var id = String(card && card.getAttribute("data-admin-table-id") || "");
    if (!id || !state.isAdmin) return;
    var target = card.querySelector("[data-admin-detail]");
    target.hidden = false;
    target.textContent = "Loading table…";
    try {
      var data = await request("/tables/" + encodeURIComponent(id));
      renderAdminTableDetail(card, data.table || data);
    } catch (err) {
      target.textContent = err.message || "Could not inspect this table.";
    }
  }

  async function mutateAdminBot(button, add) {
    var card = button.closest("[data-admin-table-id]");
    var id = String(card && card.getAttribute("data-admin-table-id") || "");
    var seatNo = number(button.getAttribute(add ? "data-admin-add-bot" : "data-admin-remove-bot"), -1);
    if (!id || seatNo < 0 || !state.isAdmin) return;
    button.disabled = true;
    try {
      if (add) await mutate("/tables/" + encodeURIComponent(id) + "/bots", { seat_no: seatNo });
      else await mutate("/tables/" + encodeURIComponent(id) + "/bots/" + seatNo, undefined, "DELETE");
      await loadAdminTables();
      var refreshed = byId("admin-tables-list").querySelector('[data-admin-table-id="' + CSS.escape(id) + '"]');
      if (refreshed) await inspectAdminTable(refreshed);
    } catch (err) {
      showNotice(err.message, "error", false);
      button.disabled = false;
    }
  }


  function adminHistoryDate(value) {
    if (value == null || value === "") return "Date unavailable";
    var stamp = typeof value === "number" ? value : Date.parse(value);
    if (!Number.isFinite(stamp)) return "Date unavailable";
    if (stamp > 0 && stamp < 100000000000) stamp *= 1000;
    return new Date(stamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }

  function renderAdminHistory() {
    var list = byId("admin-history-list");
    if (!list) return;
    var selected = Object.create(null);
    state.adminHistorySelectedIds.forEach(function (id) { selected[String(id)] = true; });
    var selectedLoadedCount = state.adminHistory.reduce(function (count, game) {
      return count + (selected[String(game.id)] ? 1 : 0);
    }, 0);
    var allLoadedSelected = state.adminHistory.length > 0 && selectedLoadedCount === state.adminHistory.length;
    var someLoadedSelected = selectedLoadedCount > 0 && !allLoadedSelected;
    var selectedCount = state.adminHistorySelectedIds.length;
    var toolbar = '<div class="admin-history-toolbar"><span class="muted">' +
      esc(state.adminHistory.length + (state.adminHistory.length === 1 ? " archived game loaded" : " archived games loaded")) +
      '</span><button class="button button-outline button-small" type="button" data-admin-history-refresh>Refresh</button></div>';
    var selectionToolbar = '<div class="admin-history-bulk-toolbar"><label class="admin-history-select-all"><input type="checkbox" data-admin-history-select-all' +
      (allLoadedSelected ? ' checked' : '') + (state.adminHistory.length ? '' : ' disabled') +
      ' aria-label="Select loaded games">Select loaded games</label>' +
      '<span class="muted admin-history-selection-count" aria-live="polite">' + esc(selectedCount) + ' selected</span>' +
      '<div class="admin-history-bulk-actions"><button class="button button-quiet button-small" type="button" data-admin-history-clear-selection' +
      (selectedCount ? '' : ' disabled') + '>Clear selection</button><button class="button button-danger button-small" type="button" data-admin-history-delete-selected' +
      (selectedCount && !state.adminHistoryLoading && !state.adminHistoryDeleting ? '' : ' disabled') + '>Delete selected (' + esc(selectedCount) + ')</button></div>' +
      (state.adminHistorySelectionMessage ? '<p class="muted admin-history-selection-message" role="status">' + esc(state.adminHistorySelectionMessage) + '</p>' : '') +
      '</div>';
    var entries = state.adminHistory.map(function (game) {
      var gameId = String(game.id || "");
      var gameName = String(game.name || "Past game");
      var participants = Array.isArray(game.participants) ? game.participants.length :
        (Array.isArray(game.results) ? game.results.length : (Array.isArray(game.standings) ? game.standings.length : 0));
      var hands = number(game.hand_count, 0);
      var date = adminHistoryDate(game.started || game.created);
      return '<article class="admin-history-entry" data-admin-history-id="' + esc(gameId) + '">' +
        '<label class="admin-history-entry-select"><input type="checkbox" data-admin-history-select="' + esc(gameId) + '"' +
        (selected[gameId] ? ' checked' : '') + ' aria-label="Select ' + esc(gameName) + ' for deletion"></label>' +
        '<div class="admin-history-entry-copy"><h3>' + esc(gameName) + '</h3>' +
        '<p class="muted">' + esc(statusName(game.status)) + ' · ' + esc(date) + ' · ' +
        esc(participants) + (participants === 1 ? ' player · ' : ' players · ') + esc(hands) +
        (hands === 1 ? ' saved hand' : ' saved hands') + '</p></div>' +
        '<button class="button button-outline button-small" type="button" data-admin-history-view="' +
        esc(gameId) + '">Inspect</button></article>';
    }).join("");
    var empty = state.adminHistory.length ? "" : '<p class="muted">No past games are archived yet.</p>';
    var error = state.adminHistoryError ? '<p class="muted admin-history-error" role="alert">' + esc(state.adminHistoryError) + '</p>' : "";
    var more = state.adminHistoryNextOffset == null ? "" :
      '<button class="button button-quiet button-small" type="button" data-admin-history-more="' +
      esc(state.adminHistoryNextOffset) + '">Load older games</button>';
    var loading = state.adminHistoryLoading ? '<p class="muted admin-history-loading" role="status">Loading past games…</p>' : "";
    list.innerHTML = toolbar + selectionToolbar + entries + empty + error + more + loading;
    var selectAll = list.querySelector("[data-admin-history-select-all]");
    if (selectAll) selectAll.indeterminate = someLoadedSelected;
  }

  function updateAdminHistorySelection(id, isSelected) {
    var gameId = String(id || "");
    var selected = state.adminHistorySelectedIds.slice();
    var index = selected.indexOf(gameId);
    if (isSelected && index < 0) {
      if (selected.length >= MAX_ADMIN_HISTORY_DELETE_IDS) {
        state.adminHistorySelectionMessage = "Select up to " + MAX_ADMIN_HISTORY_DELETE_IDS + " games at a time. Clear the selection to start another batch.";
        renderAdminHistory();
        return false;
      }
      selected.push(gameId);
    } else if (!isSelected && index >= 0) {
      selected.splice(index, 1);
    }
    state.adminHistorySelectedIds = selected;
    state.adminHistorySelectionMessage = "";
    renderAdminHistory();
    return true;
  }

  function updateAdminHistoryLoadedSelection(isSelected) {
    var loaded = state.adminHistory.map(function (game) { return String(game.id || ""); });
    var loadedSet = Object.create(null);
    loaded.forEach(function (id) { loadedSet[id] = true; });
    var selected = state.adminHistorySelectedIds.filter(function (id) { return !loadedSet[String(id)]; });
    var omitted = 0;
    if (isSelected) {
      loaded.forEach(function (id) {
        if (selected.indexOf(id) >= 0) return;
        if (selected.length >= MAX_ADMIN_HISTORY_DELETE_IDS) {
          omitted += 1;
          return;
        }
        selected.push(id);
      });
    }
    state.adminHistorySelectedIds = selected;
    state.adminHistorySelectionMessage = omitted
      ? "Selected up to " + MAX_ADMIN_HISTORY_DELETE_IDS + " games. Clear the selection to choose another batch."
      : "";
    renderAdminHistory();
  }

  function clearAdminHistorySelection() {
    state.adminHistorySelectedIds = [];
    state.adminHistorySelectionMessage = "";
    renderAdminHistory();
  }

  async function loadAdminHistory(offset, append) {
    if (!state.isAdmin || state.adminHistoryLoading) return;
    var pageOffset = Math.max(0, Math.floor(number(offset, 0)));
    var shouldAppend = Boolean(append && pageOffset > 0);
    var generation = ++state.adminHistoryListGeneration;
    state.adminHistoryLoading = true;
    state.adminHistoryError = "";
    var list = byId("admin-history-list");
    list.setAttribute("aria-busy", "true");
    if (!shouldAppend) {
      state.adminHistory = [];
      state.adminHistoryNextOffset = null;
      state.adminHistoryError = "";
      renderAdminHistory();
    } else {
      renderAdminHistory();
    }
    try {
      var data = await request("/admin/history" + (pageOffset ? "?offset=" + encodeURIComponent(pageOffset) : ""));
      if (generation !== state.adminHistoryListGeneration || !state.isAdmin) return;
      var rows = Array.isArray(data.tournaments) ? data.tournaments : [];
      if (shouldAppend) {
        var known = Object.create(null);
        state.adminHistory.forEach(function (game) { known[String(game.id)] = true; });
        rows.forEach(function (game) {
          if (!known[String(game.id)]) state.adminHistory.push(game);
        });
      } else {
        state.adminHistory = rows;
      }
      state.adminHistoryNextOffset = data.next_offset == null ? null : Math.max(0, Math.floor(number(data.next_offset, 0)));
      renderAdminHistory();
    } catch (err) {
      if (generation === state.adminHistoryListGeneration) {
        state.adminHistoryError = err.message || (shouldAppend ? "Could not load more past games." : "Could not load past games.");
      }
    } finally {
      if (generation === state.adminHistoryListGeneration) {
        state.adminHistoryLoading = false;
        list.removeAttribute("aria-busy");
        renderAdminHistory();
      }
    }
  }

  function renderAdminHistoryDetail() {
    var detail = state.adminHistoryDetail;
    if (!detail) return;
    var tournament = detail.tournament || {};
    var content = byId("admin-history-content");
    var status = statusName(tournament.status);
    var date = adminHistoryDate(tournament.started || tournament.created);
    var results = Array.isArray(tournament.results) && tournament.results.length
      ? tournament.results
      : (Array.isArray(tournament.standings) ? tournament.standings : []);
    var participants = Array.isArray(tournament.participants) ? tournament.participants : [];
    var participantNames = participants.map(function (participant) {
      return String(participant && (participant.name || participant.player_name) || participant || "");
    }).filter(Boolean);
    var hands = Array.isArray(detail.hands) ? detail.hands : [];
    var tournamentId = String(tournament.id || state.adminHistoryDetailId);
    byId("admin-history-title").textContent = tournament.name || "Past game";
    var meta = '<div class="admin-history-game-meta"><p>' + esc(status) + ' · ' + esc(date) + ' · ' +
      esc(number(tournament.hand_count, hands.length)) + ' saved hands</p>' +
      (participantNames.length ? '<p>Players: ' + esc(participantNames.join(", ")) + '</p>' : '') +
      (results.length ? '<section class="admin-history-results"><h3>Final standings</h3><p>' + historyResults(results) + '</p></section>' :
        '<p class="muted">No final standings were recorded for this game.</p>') +
      '<button class="button button-danger button-small" type="button" data-admin-history-delete="' +
      esc(tournamentId) + '">Delete past game</button></div>';
    var summaryText = historySummaryText(tournament);
    var handMarkup = hands.map(historyHand).join("");
    var noHands = hands.length ? "" : '<p class="muted">No saved hands for this game.</p>';
    var more = detail.nextOffset == null ? "" :
      '<button class="button button-outline button-small" type="button" data-admin-history-hand-more="' +
      esc(detail.nextOffset) + '">Load more hands</button>';
    var error = state.adminHistoryDetailError ? '<p class="muted admin-history-detail-error" role="alert">' + esc(state.adminHistoryDetailError) + '</p>' : "";
    var loading = state.adminHistoryDetailLoading ? '<p class="muted" role="status">Loading hands…</p>' : "";
    content.innerHTML = summaryText + meta + handMarkup + noHands + error + more + loading;
  }

  async function loadAdminHistoryDetail(id, offset, append) {
    if (!state.isAdmin || state.adminHistoryDetailLoading || !id) return;
    var gameId = String(id);
    var pageOffset = Math.max(0, Math.floor(number(offset, 0)));
    var shouldAppend = Boolean(append && pageOffset > 0 && state.adminHistoryDetail);
    var generation = ++state.adminHistoryDetailGeneration;
    state.adminHistoryDetailLoading = true;
    state.adminHistoryDetailError = "";
    var content = byId("admin-history-content");
    content.setAttribute("aria-busy", "true");
    if (!shouldAppend) content.innerHTML = '<p class="muted" role="status">Loading past game…</p>';
    try {
      var path = "/admin/history/" + encodeURIComponent(gameId) +
        (pageOffset ? "?offset=" + encodeURIComponent(pageOffset) : "");
      var data = await request(path);
      if (generation !== state.adminHistoryDetailGeneration || !state.isAdmin ||
          !byId("admin-history-dialog").open || state.adminHistoryDetailId !== gameId) return;
      var tournament = data.tournament || {};
      var fetchedHands = Array.isArray(data.hands) ? data.hands : [];
      var previousHands = shouldAppend && state.adminHistoryDetail ? state.adminHistoryDetail.hands : [];
      state.adminHistoryDetail = {
        tournament: tournament,
        hands: previousHands.concat(fetchedHands),
        nextOffset: data.next_offset == null ? null : Math.max(0, Math.floor(number(data.next_offset, 0)))
      };
      renderAdminHistoryDetail();
    } catch (err) {
      if (generation === state.adminHistoryDetailGeneration) {
        state.adminHistoryDetailError = err.message || "Could not inspect this past game.";
        if (!state.adminHistoryDetail) content.textContent = state.adminHistoryDetailError;
      }
    } finally {
      if (generation === state.adminHistoryDetailGeneration) {
        state.adminHistoryDetailLoading = false;
        content.removeAttribute("aria-busy");
        if (state.adminHistoryDetail) renderAdminHistoryDetail();
      }
    }
  }

  function inspectAdminHistory(id, trigger) {
    if (!state.isAdmin || !id) return;
    state.adminHistoryDetailId = String(id);
    state.adminHistoryDetail = null;
    state.adminHistoryTrigger = trigger || null;
    state.adminHistoryDeleteTarget = null;
    byId("admin-history-title").textContent = "Loading past game";
    byId("admin-history-content").hidden = false;
    byId("admin-history-content").textContent = "Loading past game…";
    byId("admin-history-delete-step").hidden = true;
    var dialog = byId("admin-history-dialog");
    if (!dialog.open) dialog.showModal();
    byId("admin-history-close").focus();
    loadAdminHistoryDetail(state.adminHistoryDetailId, 0, false);
  }

  function closeAdminHistoryDialog(restoreFocus) {
    var dialog = byId("admin-history-dialog");
    var trigger = state.adminHistoryTrigger;
    state.adminHistoryDetailGeneration += 1;
    state.adminHistoryDetailLoading = false;
    state.adminHistoryDetail = null;
    state.adminHistoryDetailError = "";
    state.adminHistoryDetailId = "";
    state.adminHistoryDeleteTarget = null;
    if (dialog && dialog.open) dialog.close();
    if (byId("admin-history-content")) {
      byId("admin-history-content").hidden = false;
      byId("admin-history-content").replaceChildren();
      byId("admin-history-content").removeAttribute("aria-busy");
    }
    if (byId("admin-history-delete-step")) byId("admin-history-delete-step").hidden = true;
    if (restoreFocus) {
      var focusTarget = trigger && trigger.isConnected ? trigger : byId("admin-history-details").querySelector("summary");
      if (focusTarget) focusTarget.focus({ preventScroll: true });
    }
    state.adminHistoryTrigger = null;
  }

  function beginAdminHistoryDelete(id) {
    if (!state.isAdmin || !state.adminHistoryDetail) return;
    var tournament = state.adminHistoryDetail.tournament || {};
    var gameId = String(tournament.id || state.adminHistoryDetailId);
    if (id && String(id) !== gameId) return;
    state.adminHistoryDeleteTarget = {
      id: gameId,
      name: String(tournament.name || "Past game"),
      status: String(tournament.status || "")
    };
    byId("admin-history-title").textContent = "Confirm past-game deletion";
    byId("admin-history-delete-title").textContent = "Delete this past game?";
    byId("admin-history-delete-description").textContent = "This permanently removes the archived game:";
    byId("admin-history-delete-confirm").textContent = "Delete game";
    byId("admin-history-content").hidden = true;
    byId("admin-history-delete-name").textContent = state.adminHistoryDeleteTarget.name;
    var error = byId("admin-history-delete-step").querySelector(".admin-history-delete-error");
    if (error) error.remove();
    byId("admin-history-delete-step").hidden = false;
    byId("admin-history-delete-cancel").focus();
  }

  function beginAdminHistoryBulkDelete(trigger) {
    if (!state.isAdmin || state.adminHistoryDeleting || !state.adminHistorySelectedIds.length) return;
    var ids = state.adminHistorySelectedIds.slice();
    var count = ids.length;
    state.adminHistoryDetailGeneration += 1;
    state.adminHistoryDetailLoading = false;
    state.adminHistoryDetail = null;
    state.adminHistoryDetailId = "";
    state.adminHistoryTrigger = trigger || null;
    state.adminHistoryDeleteTarget = { bulk: true, ids: ids, count: count };
    byId("admin-history-title").textContent = "Confirm past-game deletion";
    byId("admin-history-content").hidden = true;
    byId("admin-history-content").replaceChildren();
    byId("admin-history-delete-title").textContent = "Delete " + count + (count === 1 ? " past game?" : " past games?");
    byId("admin-history-delete-description").textContent = "This permanently removes the selected games and their saved history.";
    byId("admin-history-delete-name").textContent = count + (count === 1 ? " game selected" : " games selected");
    byId("admin-history-delete-confirm").textContent = "Delete " + count + (count === 1 ? " game" : " games");
    var error = byId("admin-history-delete-step").querySelector(".admin-history-delete-error");
    if (error) error.remove();
    byId("admin-history-delete-step").hidden = false;
    var dialog = byId("admin-history-dialog");
    if (!dialog.open) dialog.showModal();
    byId("admin-history-delete-cancel").focus();
  }

  function cancelAdminHistoryDelete() {
    if (state.adminHistoryDeleting) return;
    if (state.adminHistoryDeleteTarget && state.adminHistoryDeleteTarget.bulk) {
      closeAdminHistoryDialog(true);
      return;
    }
    state.adminHistoryDeleteTarget = null;
    byId("admin-history-delete-step").hidden = true;
    byId("admin-history-content").hidden = false;
    byId("admin-history-delete-title").textContent = "Delete this past game?";
    byId("admin-history-delete-description").textContent = "This permanently removes the archived game:";
    byId("admin-history-delete-confirm").textContent = "Delete game";
    var deleteButton = byId("admin-history-content").querySelector("[data-admin-history-delete]");
    if (deleteButton) deleteButton.focus();
  }

  async function confirmAdminHistoryDelete() {
    var target = state.adminHistoryDeleteTarget;
    if (!state.isAdmin || !target || state.adminHistoryDeleting) return;
    if (target.bulk) {
      confirmAdminHistoryBulkDelete(target);
      return;
    }
    var targetId = String(target.id);
    var detailGeneration = state.adminHistoryDetailGeneration;
    var adminId = String(state.player && state.player.id || "");
    var authProof = String(state.sessionProof || "");
    state.adminHistoryDeleting = true;
    var button = byId("admin-history-delete-confirm");
    button.disabled = true;
    byId("admin-history-close").disabled = true;
    byId("admin-history-delete-cancel").disabled = true;
    var step = byId("admin-history-delete-step");
    var error = step.querySelector(".admin-history-delete-error");
    if (error) error.remove();
    try {
      await mutate("/admin/history/" + encodeURIComponent(targetId) + "/delete", { confirm_delete: true });
      if (!state.isAdmin || String(state.player && state.player.id || "") !== adminId ||
          String(state.sessionProof || "") !== authProof) return;
      state.adminHistory = state.adminHistory.filter(function (game) {
        return String(game.id) !== targetId;
      });
      state.adminHistorySelectedIds = state.adminHistorySelectedIds.filter(function (id) {
        return String(id) !== targetId;
      });
      state.adminHistoryNextOffset = null;
      state.adminTables = state.adminTables.filter(function (table) {
        return String(table.id) !== targetId;
      });
      renderAdminTables();
      var sameConfirmation = state.adminHistoryDetailId === targetId &&
        state.adminHistoryDetailGeneration === detailGeneration &&
        String(state.adminHistoryDeleteTarget && state.adminHistoryDeleteTarget.id || "") === targetId;
      if (sameConfirmation) {
        state.adminHistoryTrigger = null;
        closeAdminHistoryDialog(false);
      }
      await loadAdminHistory(0, false);
      if (sameConfirmation) {
        var summary = byId("admin-history-details").querySelector("summary");
        if (summary) summary.focus({ preventScroll: true });
      }
    } catch (err) {
      var sameConfirmation = state.adminHistoryDetailId === targetId &&
        state.adminHistoryDetailGeneration === detailGeneration &&
        String(state.adminHistoryDeleteTarget && state.adminHistoryDeleteTarget.id || "") === targetId;
      if (sameConfirmation) {
        var message = document.createElement("p");
        message.className = "muted admin-history-delete-error";
        message.setAttribute("role", "alert");
        message.textContent = err.message || "Could not delete this past game.";
        step.insertBefore(message, step.querySelector(".admin-history-delete-actions"));
      }
    } finally {
      state.adminHistoryDeleting = false;
      if (button.isConnected) button.disabled = false;
      byId("admin-history-close").disabled = false;
      byId("admin-history-delete-cancel").disabled = false;
      renderAdminHistory();
    }
  }

  async function confirmAdminHistoryBulkDelete(target) {
    if (!state.isAdmin || !target || !Array.isArray(target.ids) || state.adminHistoryDeleting) return;
    var ids = target.ids.slice();
    var adminId = String(state.player && state.player.id || "");
    var authProof = String(state.sessionProof || "");
    state.adminHistoryDeleting = true;
    var button = byId("admin-history-delete-confirm");
    button.disabled = true;
    byId("admin-history-close").disabled = true;
    byId("admin-history-delete-cancel").disabled = true;
    var step = byId("admin-history-delete-step");
    var error = step.querySelector(".admin-history-delete-error");
    if (error) error.remove();
    try {
      var result = await mutate("/admin/history/delete", { ids: ids, confirm_delete: true });
      var deletedIds = Array.isArray(result.ids) ? result.ids.map(String) : [];
      if (result.deleted_count !== ids.length || deletedIds.length !== ids.length ||
          ids.some(function (id) { return deletedIds.indexOf(String(id)) < 0; })) {
        throw Error("The room returned an unexpected deletion result. Refresh past games and review the selection.");
      }
      if (!state.isAdmin || String(state.player && state.player.id || "") !== adminId ||
          String(state.sessionProof || "") !== authProof || state.adminHistoryDeleteTarget !== target) return;
      var deleted = Object.create(null);
      deletedIds.forEach(function (id) { deleted[id] = true; });
      state.adminHistory = state.adminHistory.filter(function (game) { return !deleted[String(game.id)]; });
      state.adminHistorySelectedIds = state.adminHistorySelectedIds.filter(function (id) { return !deleted[String(id)]; });
      state.adminHistorySelectionMessage = "";
      state.adminHistoryNextOffset = null;
      state.adminTables = state.adminTables.filter(function (table) { return !deleted[String(table.id)]; });
      renderAdminTables();
      state.adminHistoryTrigger = null;
      closeAdminHistoryDialog(false);
      await loadAdminHistory(0, false);
      var summary = byId("admin-history-details").querySelector("summary");
      if (summary) summary.focus({ preventScroll: true });
    } catch (err) {
      if (state.adminHistoryDeleteTarget === target) {
        var message = document.createElement("p");
        message.className = "muted admin-history-delete-error";
        message.setAttribute("role", "alert");
        message.textContent = (err.message || "Could not delete the selected past games.") +
          " Refresh the list to check which games remain and review the selection.";
        step.insertBefore(message, step.querySelector(".admin-history-delete-actions"));
      }
    } finally {
      state.adminHistoryDeleting = false;
      if (button.isConnected) button.disabled = false;
      byId("admin-history-close").disabled = false;
      byId("admin-history-delete-cancel").disabled = false;
    }
  }

  function ensureActionControls() {
    var controls = byId("action-controls");
    if (!controls || controls.dataset.initialized === "true") return;
    controls.innerHTML =
      '<div class="action-buttons" role="group" aria-label="Poker actions">' +
        '<button class="button button-quiet" type="button" data-action-slot="fold" data-poker-action="fold"><span class="action-button-label">Fold</span><span class="action-button-value" hidden><strong class="action-button-amount"></strong><span class="action-button-unit is-compact-unit"></span></span></button>' +
        '<button class="button button-outline call-button" type="button" data-action-slot="call" data-poker-action="check"><span class="action-button-label">Check</span><span class="action-button-value" hidden><strong class="action-button-amount"></strong><span class="action-button-unit is-compact-unit"></span></span></button>' +
        '<button class="button button-primary" type="button" data-action-slot="raise" data-poker-action="raise_to"><span class="action-button-label">Bet</span><span class="action-button-value" hidden><strong class="action-button-amount"></strong><span class="action-button-unit is-compact-unit"></span></span></button>' +
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

  function setPrimaryActionContent(button, label, amount, view, ariaLabel) {
    if (!button) return;
    var labelNode = button.querySelector(".action-button-label");
    var valueNode = button.querySelector(".action-button-value");
    var amountNode = button.querySelector(".action-button-amount");
    var unitNode = button.querySelector(".action-button-unit");
    if (labelNode) labelNode.textContent = label;
    if (amount == null || !Number.isFinite(Number(amount))) {
      if (valueNode) valueNode.hidden = true;
      if (amountNode) amountNode.textContent = "";
      if (unitNode) unitNode.textContent = "";
      button.classList.add("is-no-amount");
    } else {
      if (valueNode) valueNode.hidden = false;
      if (amountNode) amountNode.textContent = tableChipValue(Number(amount), view);
      if (unitNode) {
        unitNode.textContent = tableChipUnit(view);
        unitNode.classList.toggle("is-compact-unit", !tableUsesBigBlinds(view));
      }
      button.classList.remove("is-no-amount");
    }
    button.setAttribute("aria-label", ariaLabel);
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
    var rangeAvailable = viewer.raise_rights !== false && stack > 0 &&
      max > currentBet && min <= max;
    var valid = rangeAvailable && Number.isInteger(target) && target >= min && target <= max;
    var button = byId("action-controls").querySelector('[data-action-slot="raise"]');
    var actionAllowed = viewerCanAct(view) && rangeAvailable;
    input.setAttribute("aria-valuetext", !rangeAvailable
      ? "No legal bet or raise is available"
      : valid
        ? actionName + " to " + actionChips(target) + " total; adds " + actionChips(Math.max(0, target - ownBet))
        : "Choose an amount from " + actionChips(min) + " to " + actionChips(max));
    if (button) {
      var allInTarget = rangeAvailable && valid && Math.floor(ownBet + stack) <= target;
      var visibleLabel = allInTarget ? "All in" : actionName;
      var exactLabel = rangeAvailable && valid
        ? actionName + " to " + actionChips(target) + (allInTarget ? ", all in" : "")
        : actionName + " unavailable";
      setPrimaryActionContent(button, visibleLabel, rangeAvailable && valid ? target : null, view, exactLabel);
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
    var playerPrefs = globalBetPreferences();
    var presetGroup = controls.querySelector(".raise-presets");
    var reservedPresetSlots = Math.max(1,
      Array.isArray(playerPrefs.preflop_bb) ? playerPrefs.preflop_bb.length : 0,
      Array.isArray(playerPrefs.postflop_percent) ? playerPrefs.postflop_percent.length : 0);
    if (presetGroup) presetGroup.style.setProperty("--preset-slots", String(reservedPresetSlots));

    var viewer = view.viewer || {};
    var seat = viewerSeat(view);
    var playing = view.status === "playing";
    var completed = view.status === "completed";
    var seated = Boolean(seat);
    var controlsVisible = seated && (playing || completed);
    var reactionVisible = Boolean(seat && state.player && !state.isAdmin);
    var panelVisible = controlsVisible || reactionVisible;
    var shortcuts = byId("reaction-shortcuts");
    if (shortcuts) {
      var reactionTableId = String(view.id || state.activeTableId || "");
      var reactionPlayerId = String(viewer.player_id || (state.player && state.player.id) || "");
      var reactionSeatNo = String(seat && seat.seat_no != null ? seat.seat_no : "");
      var shortcutMarkup = reactionVisible ? normalizedReactionFavorites(state.reactionFavorites).map(function (emoji, index) {
        var label = REACTION_EMOJI_LABELS[emoji] || "table";
        var changeHint = "Right-click, press Shift+F10, or hold to change shortcut " + (index + 1);
        return '<button class="reaction-shortcut" type="button" data-send-reaction="' + esc(emoji) +
          '" data-reaction-slot="' + index + '" data-send-hint="' + esc(changeHint) +
          '" data-reaction-table-id="' + esc(reactionTableId) + '" data-reaction-player-id="' + esc(reactionPlayerId) +
          '" data-reaction-seat-no="' + esc(reactionSeatNo) + '" aria-haspopup="dialog" aria-label="Send ' + esc(label) +
          ' reaction. ' + esc(changeHint) + '." title="Send ' + esc(label) + '. ' + esc(changeHint) + '">' +
          esc(emoji) + '</button>';
      }).join("") : "";
      if (shortcuts.innerHTML !== shortcutMarkup) shortcuts.innerHTML = shortcutMarkup;
      shortcuts.hidden = !reactionVisible;
    }
    panel.dataset.reactionsOnly = String(reactionVisible && !controlsVisible);
    var finishedStatus = byId("action-finished-status");
    var canAct = viewerCanAct(view);
    var currentKey = actionTokenKey(view);
    if (state.actionSubmittedKey && state.actionSubmittedKey !== currentKey) state.actionSubmittedKey = "";
    if (state.actionPending && state.actionPending.tableId !== String(state.activeTableId)) state.actionPending = null;

    if (state.actionPending && state.actionPending.accepted && !actionIntentIsCurrent(state.actionPending)) {
      state.actionPending = null;
    }
    panel.hidden = !panelVisible;
    controls.hidden = !controlsVisible;
    if (finishedStatus) {
      finishedStatus.hidden = !completed || !controlsVisible;
      finishedStatus.textContent = completed && controlsVisible
        ? (presentationRemainingMs(view) > 0
          ? "Tournament complete. Final standings appear after the hand result presentation."
          : "Tournament complete. Review the final standings and last hand.")
        : "";
    }
    panel.setAttribute("aria-busy", String(Boolean(state.actionPending || state.actionSubmittedKey === currentKey)));
    if (!playing || !controlsVisible) {
      setPrimaryActionContent(controls.querySelector('[data-action-slot="fold"]'), "Fold", null, view, "Fold unavailable");
      setPrimaryActionContent(controls.querySelector('[data-action-slot="call"]'), "Check", null, view, "Check unavailable");
      setPrimaryActionContent(controls.querySelector('[data-action-slot="raise"]'), "Bet", null, view, "Bet unavailable");
      controls.querySelectorAll("button, input").forEach(function (control) { control.disabled = true; });
      return;
    }

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
    var rangeAvailable = viewer.raise_rights !== false && stack > 0 &&
      maxRaise > currentBet && rangeMax >= currentBet + 1 && rangeMin <= rangeMax;
    var raiseAllowed = canAct && rangeAvailable;
    var draftKey = actionTokenKey(view);
    if (state.raiseDraftKey !== draftKey) {
      state.raiseDraftKey = draftKey;
      state.raiseDraftValue = null;
    }

    var street = String(view.street || "").toLowerCase();
    var preflop = street ? street === "preflop" : cardArray(view.board).length === 0;
    var bigBlind = Math.max(1, number(blindParts(view).big, number(view.config && view.config.big_blind, 1)));
    var potAfterCall = Math.max(0, number(view.pot, 0) + callAmount);
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

    var callButton = controls.querySelector('[data-action-slot="call"]');
    var foldButton = controls.querySelector('[data-action-slot="fold"]');
    var raiseButton = controls.querySelector('[data-action-slot="raise"]');
    var input = byId("raise-amount");
    var blocked = Boolean(state.actionPending || state.actionSubmittedKey === currentKey);
    if (foldButton) foldButton.disabled = blocked || !canAct || toCall <= 0;
    if (callButton) {
      callButton.setAttribute("data-poker-action", toCall > 0 ? "call" : "check");
      var callLabel = toCall > 0 ? "Call" : "Check";
      var callAria = toCall > 0
        ? "Call " + actionChips(callAmount) + (callAmount >= stack && stack > 0 ? ", all in" : "")
        : "Check";
      setPrimaryActionContent(callButton, callLabel, toCall > 0 ? callAmount : null, view, callAria);
      callButton.disabled = blocked || !canAct;
    }

    input.min = String(rangeMin);
    input.max = String(rangeMax);
    if (document.activeElement !== input || Number(input.value) < rangeMin || Number(input.value) > rangeMax) {
      input.value = String(draft);
    }
    input.disabled = blocked || !raiseAllowed;
    input.setAttribute("aria-valuetext", rangeAvailable
      ? "Bet or raise to " + actionChips(draft)
      : "No legal bet or raise is available");
    if (raiseButton) {
      var raiseActionName = currentBet > 0 ? "Raise" : "Bet";
      var raiseAllIn = rangeAvailable && Math.floor(ownBet + stack) <= draft;
      setPrimaryActionContent(raiseButton, raiseAllIn ? "All in" : raiseActionName,
        rangeAvailable ? draft : null, view,
        rangeAvailable
          ? raiseActionName + " to " + actionChips(draft) + (raiseAllIn ? ", all in" : "")
          : raiseActionName + " unavailable");
    }

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

    var rangeText = !rangeAvailable
      ? "No legal bet or raise is available"
      : shortAllInRaise
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

  function renderLobbyControls(view, host, ownSeat, isSeated) {
    var panel = byId("lobby-seat-panel");
    var controls = byId("seat-controls");
    var standButton = byId("stand-button");
    var statusTitle = byId("seat-status-title");
    var statusDescription = byId("seat-status-description");
    var visible = view.status === "lobby" && isSeated;
    panel.hidden = !visible;
    controls.replaceChildren();
    if (!visible) return;
    statusTitle.textContent = host ? "You’re seated and hosting." : "You’re seated at the table.";
    statusDescription.textContent = "Stand up any time to watch without a seat.";
    standButton.hidden = !isSeated;
  }

  function payoutOrdinal(index) {
    var place = index + 1;
    var suffix = place % 100 >= 11 && place % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[place % 10] || "th");
    return place + suffix;
  }

  function allocatePayoutShares(weights, total) {
    var count = weights.length;
    if (!count) return [];
    if (count > total) throw Error("There cannot be more paid places than percentage points.");
    if (count === 1) return [total];
    var extra = total - count;
    var normalized = weights.map(function (value) { return Math.max(0, number(value, 0) - 1); });
    var weightTotal = normalized.reduce(function (sum, value) { return sum + value; }, 0);
    if (weightTotal <= 0) {
      normalized = weights.map(function () { return 1; });
      weightTotal = count;
    }
    var shares = normalized.map(function (weight) { return 1 + Math.floor(extra * weight / weightTotal); });
    var assigned = shares.reduce(function (sum, value) { return sum + value; }, 0);
    var remainders = normalized.map(function (weight, index) {
      return { index: index, fraction: extra * weight / weightTotal - Math.floor(extra * weight / weightTotal) };
    }).sort(function (a, b) { return b.fraction - a.fraction || a.index - b.index; });
    for (var i = 0; i < total - assigned; i += 1) shares[remainders[i].index] += 1;
    return shares;
  }

  function readPayoutShares() {
    var raw = String(byId("settings-payout").value || "").split(",");
    var values = raw.map(function (value) { return Number(value.trim()); });
    if (!values.length || values.length > 9 || values.some(function (value) { return !Number.isInteger(value) || value < 1; }) || values.reduce(function (sum, value) { return sum + value; }, 0) !== 100) {
      return [60, 25, 15];
    }
    return values;
  }

  function cleanPayoutShares(shares) {
    if (!Array.isArray(shares) || shares.length < 1 || shares.length > 9 ||
        shares.some(function (value) { return !Number.isInteger(Number(value)) || Number(value) < 0; }) ||
        shares.reduce(function (sum, value) { return sum + Number(value); }, 0) !== 100) return [60, 25, 15];
    var positive = shares.map(Number).filter(function (value) { return value > 0; });
    return positive.length ? positive : [100];
  }

  function writePayoutShares(shares) {
    var values = cleanPayoutShares(shares);
    var container = byId("payout-sliders");
    var existing = Array.from(container.querySelectorAll(".payout-slider"));
    if (existing.length !== values.length) {
      container.innerHTML = values.map(function (share, index) {
        var place = payoutOrdinal(index);
        return '<div class="payout-slider-row"><label for="payout-share-' + index + '">' + place + ' place</label>' +
          '<input id="payout-share-' + index + '" class="payout-slider" type="range" min="1" step="1" data-payout-index="' + index + '">' +
          '<output for="payout-share-' + index + '" class="payout-slider-value">' + share + '%</output></div>';
      }).join("");
      existing = Array.from(container.querySelectorAll(".payout-slider"));
    }
    byId("payout-place-count").value = String(values.length);
    byId("settings-payout").value = values.join(",");
    existing.forEach(function (input, index) {
      var share = values[index];
      var place = payoutOrdinal(index);
      input.max = String(100 - values.length + 1);
      input.value = String(share);
      input.disabled = values.length === 1;
      input.setAttribute("aria-label", place + " place payout");
      input.setAttribute("aria-valuetext", place + " place receives " + share + " percent");
      var output = input.parentNode.querySelector("output");
      if (output) output.textContent = share + "%";
    });
    byId("settings-payout-summary").textContent = values.map(function (share, index) { return payoutOrdinal(index) + " " + share + "%"; }).join(" · ") + " · Total 100%";
  }

  function rebalanceEditedPayout(index, requested) {
    var current = readPayoutShares();
    if (index < 0 || index >= current.length) return current;
    if (current.length === 1) return [100];
    var max = 100 - current.length + 1;
    var target = Math.max(1, Math.min(max, Math.round(number(requested, current[index]))));
    var otherIndexes = current.map(function (_, i) { return i; }).filter(function (i) { return i !== index; });
    var others = allocatePayoutShares(otherIndexes.map(function (i) { return current[i]; }), 100 - target);
    var result = current.slice();
    result[index] = target;
    otherIndexes.forEach(function (i, position) { result[i] = others[position]; });
    return result;
  }

  function resizePayoutPlaces(count) {
    var requested = Math.max(1, Math.min(9, Math.floor(number(count, 3))));
    var current = readPayoutShares();
    var weights = current.slice(0, requested);
    while (weights.length < requested) weights.push(1);
    return allocatePayoutShares(weights, 100);
  }

  function loadSettingsForm(view) {
    var config = view.config || {};
    byId("settings-buy-in").value = String(config.buy_in == null ? 10 : config.buy_in);
    writePayoutShares(Array.isArray(config.payout_percentages) ? config.payout_percentages : [60, 25, 15]);
    byId("settings-table-name").value = view.name || "";
    byId("settings-starting-stack").value = String(number(config.starting_stack, number(view.starting_stack, 1000)));
    byId("settings-small-blind").value = String(number(config.small_blind, number(view.small_blind, 10)));
    byId("settings-big-blind").value = String(number(config.big_blind, number(view.big_blind, 20)));
    byId("settings-level-minutes").value = String(number(config.level_minutes, number(view.level_minutes, 5)));
    byId("settings-turn-seconds").value = String(number(config.turn_seconds, 30));
  }

  function renderSettingsPanel(view, host) {
    var form = byId("table-settings-form");
    var dialog = byId("table-settings-dialog");
    var lobby = view.status === "lobby";
    var inGame = view.status === "playing";
    var button = byId("runtime-settings-button");
    if (button) {
      button.hidden = !(host && (lobby || inGame));
      button.textContent = lobby ? "Game setup" : "Game timing";
      button.setAttribute("aria-expanded", String(Boolean(dialog.open)));
    }
    if (!host || !(lobby || inGame)) {
      if (dialog.open) dialog.close();
      state.runtimeSettingsOpen = false;
      return;
    }

    var tableId = String(view.id || state.activeTableId || "");
    if (state.settingsTableId !== tableId) {
      state.settingsTableId = tableId;
      state.settingsDirty = false;
      loadSettingsForm(view);
    } else if (!state.settingsDirty) {
      loadSettingsForm(view);
    }

    form.hidden = false;
    form.dataset.mode = inGame ? "runtime" : "lobby";
    byId("table-settings-title").textContent = lobby ? "Before you deal" : "Game timing";
    form.querySelectorAll("[data-lobby-only]").forEach(function (field) {
      field.hidden = inGame;
      field.querySelectorAll("input, select").forEach(function (input) {
        input.disabled = inGame || state.settingsSaving || (input.classList.contains("payout-slider") && number(byId("payout-place-count").value, 3) === 1);
      });
    });
    form.querySelectorAll("[data-runtime-only]").forEach(function (field) {
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
    state.runtimeSettingsOpen = dialog.open;
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
    syncTableAnnouncementRegion();
  }

  function liveShowdownRows(view) {
    return Array.isArray(view && view.showdown) ? view.showdown : [];
  }

  function handRankName(row, rankMap, winnerRow) {
    var id = String(row && row.player_id || "");
    var mapped = rankMap && rankMap[id];
    var label = (winnerRow && winnerRow.rank) || (row && row.rank) || (mapped && mapped.rank) ||
      (winnerRow && winnerRow.hand_name) || (row && row.hand_name) || (mapped && mapped.hand_name) || "";
    return String(label || "");
  }

  function renderShowdownSummary(view) {
    var node = byId("showdown-summary");
    if (!node) return;
    var rows = liveShowdownRows(view);
    var deadline = view && (view.showdown_until || (view.hand && view.hand.showdown_until));
    var uncontested = !rows.length && String(view.street || "").toLowerCase() === "showdown" &&
      (view.winners || []).some(function (winner) { return number(winner.amount, 0) > 0; });
    if (uncontested) deadline = view.hand_complete_at;
    var active = Boolean((rows.length || uncontested) &&
      (deadline != null ? (uncontested ? epochMilliseconds(deadline) > epochMilliseconds(view.server_now) : showdownRemainingMs(view) > 0) :
        String(view.street || "").toLowerCase() === "showdown"));
    if (!active) {
      node.hidden = true;
      node.replaceChildren();
      syncTableAnnouncementRegion();
      return;
    }

    var byPlayer = Object.create(null);
    rows.forEach(function (row) {
      var id = String(row && row.player_id || "");
      if (id) byPlayer[id] = row;
    });
    var rankMap = view.hand_ranks && typeof view.hand_ranks === "object" ? view.hand_ranks : {};
    var winners = Array.isArray(view.winners) ? view.winners : [];
    var winnerMarkup = winners.map(function (winner) {
      var id = String(winner && winner.player_id || "");
      var row = byPlayer[id] || {};
      var amount = number(winner && winner.amount, number(view.pot_winnings && view.pot_winnings[id], number(row.payout, 0)));
      if (amount <= 0) return "";
      var name = String(winner && winner.name || row.name || "Player");
      var rank = handRankName(row, rankMap, winner);
      return '<p class="showdown-winner-line"><strong>' + esc(name) + ' wins ' +
        esc(tableChips(amount, view)) + (uncontested ? ' without showdown' : (rank ? ' with ' + esc(rank) : '')) + '.</strong></p>';
    }).filter(Boolean).join("");
    var rankRows = rows.map(function (row) {
      var name = String(row && row.name || "Player");
      var rank = handRankName(row, rankMap);
      if (!rank) return "";
      return '<li class="showdown-rank-line"><span>' + esc(name) + '</span><strong>' + esc(rank) + '</strong></li>';
    }).filter(Boolean).join("");
    var summaryMarkup =
      (winnerMarkup ? '<div class="showdown-winners" aria-label="Hand winners">' + winnerMarkup + '</div>' : '') +
      (rankRows ? '<div class="showdown-ranks" aria-label="Exposed hand ranks"><span class="showdown-ranks-label">Exposed hands</span><ul>' + rankRows + '</ul></div>' : '');
    if (node.innerHTML !== summaryMarkup) node.innerHTML = summaryMarkup;
    node.hidden = !winnerMarkup && !rankRows;
    syncTableAnnouncementRegion();
  }

  function renderTableAnnouncements(view) {
    if (view.status === "ended") {
      clearEliminationAnnouncement();
      clearBlindAnnouncement(false);
      byId("showdown-summary").hidden = true;
      byId("showdown-summary").replaceChildren();
      syncTableAnnouncementRegion();
      return;
    }
    announceEliminations(view);
    renderShowdownSummary(view);
    syncTableAnnouncementRegion();
  }

  function safeAvatarViewerUrl(value) {
    var safePath = safeAvatarPath(value);
    if (!safePath) return null;
    var url = new URL(safePath, window.location.origin);
    var path = url.pathname;
    var isPlayer = /^\/poker\/api\/players\/[A-Za-z0-9_-]+\/avatar(?:\/full)?$/.test(path);
    var isCustomPreset = /^\/poker\/api\/avatar-presets\/[a-f0-9]{32}\/(?:thumbnail|full)$/i.test(path);
    var isBuiltin = /^\/poker\/avatars\/(?:full\/)?[a-z0-9-]+\.(?:jpg|png)$/i.test(path);
    if (!isPlayer && !isCustomPreset && !isBuiltin) return null;
    var privateImage = isPlayer || isCustomPreset;
    var fullImage = /\/full$/.test(path);
    return {
      path:safePath,
      privateImage:privateImage,
      maxBytes:fullImage ? 1024 * 1024 : (privateImage ? 256 * 1024 : 2 * 1024 * 1024)
    };
  }

  async function openAvatarViewer(trigger) {
    var dialog = byId("avatar-view-dialog");
    var image = byId("avatar-view-image");
    var status = byId("avatar-view-status");
    if (!dialog || !image || !status || !trigger) return;
    var source = String(trigger.getAttribute("data-avatar-full-url") || trigger.getAttribute("data-avatar-url") || "");
    var safeSource = safeAvatarViewerUrl(source);
    if (!safeSource) return;
    if (safeSource.privateImage && !state.sessionProof) return;
    var requestId = ++avatarPreviewRequestSerial;
    var proof = state.sessionProof;
    avatarPreviewTrigger = trigger;
    image.hidden = true;
    image.removeAttribute("src");
    image.alt = "";
    status.textContent = "Loading profile photo…";
    status.hidden = false;
    if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
    else dialog.setAttribute("open", "");
    byId("avatar-view-close").focus({ preventScroll:true });
    var seatName = trigger.closest(".seat-card")?.querySelector(".seat-name")?.textContent || "Player";
    image.alt = seatName + " profile photo";
    try {
      var headers = { "Accept":"image/jpeg,image/png" };
      if (safeSource.privateImage) headers["X-SitNgo-Session"] = proof;
      var response = await fetch(safeSource.path, {
        method:"GET", credentials:"same-origin", cache:"no-store", headers:headers
      });
      if (!response.ok) throw Error("Profile photo request failed.");
      var blob = await response.blob();
      var type = String(blob.type || "").split(";")[0].toLowerCase();
      if ((type !== "image/jpeg" && type !== "image/png") || blob.size <= 0 || blob.size > safeSource.maxBytes) {
        throw Error("Profile photo is invalid or too large.");
      }
      if (requestId !== avatarPreviewRequestSerial || proof !== state.sessionProof || !dialog.open) return;
      var dataUrl = await blobAsDataUrl(blob);
      if (requestId !== avatarPreviewRequestSerial || proof !== state.sessionProof || !dialog.open) return;
      image.src = dataUrl;
      await image.decode();
      if (requestId !== avatarPreviewRequestSerial || proof !== state.sessionProof || !dialog.open) return;
      image.hidden = false;
      status.hidden = true;
      status.textContent = "";
    } catch (err) {
      if (requestId !== avatarPreviewRequestSerial || !dialog.open) return;
      status.textContent = "This profile photo is unavailable.";
      image.hidden = true;
      image.removeAttribute("src");
    }
  }

  function closeAvatarViewer(restoreFocus) {
    avatarPreviewRequestSerial += 1;
    var dialog = byId("avatar-view-dialog");
    if (dialog && dialog.open) dialog.close();
    var image = byId("avatar-view-image");
    var status = byId("avatar-view-status");
    if (image) {
      image.hidden = true;
      image.removeAttribute("src");
      image.alt = "";
    }
    if (status) {
      status.textContent = "";
      status.hidden = true;
    }
    var trigger = avatarPreviewTrigger;
    avatarPreviewTrigger = null;
    if (restoreFocus && trigger && trigger.isConnected) trigger.focus({ preventScroll:true });
  }

  function rebuyOfferSecondsRemaining() {
    if (!rebuyOfferCurrentId) return -1;
    var elapsed = state.tableView && state.tableView.paused ? 0 : monotonicNow() - rebuyOfferUpdatedAt;
    return Math.max(0, Math.ceil((rebuyOfferRemainingMs - elapsed) / 1000));
  }

  function updateRebuyOfferControls() {
    var button = byId("rebuy-offer-button");
    var countdown = byId("rebuy-offer-countdown");
    var accept = byId("rebuy-offer-accept");
    var decline = byId("rebuy-offer-decline");
    var status = byId("rebuy-offer-status");
    if (!button || !countdown || !accept || !decline || !status) return;
    var seconds = rebuyOfferSecondsRemaining();
    var active = Boolean(rebuyOfferCurrentId && seconds >= 0);
    button.hidden = !rebuyOfferCurrentId;
    button.textContent = active ? "Rebuy offer · " + formatClock(seconds) : "Rebuy offer";
    countdown.textContent = active ? formatClock(seconds) : "Expired";
    countdown.setAttribute("aria-label", active ? seconds + " seconds left on rebuy offer" : "Rebuy offer expired");
    var expired = !active || seconds <= 0;
    accept.disabled = rebuyActionPending || expired;
    decline.disabled = rebuyActionPending || expired;
    if (expired) status.textContent = "This offer has expired. The table will refresh its final state.";
    else if (!rebuyActionPending) status.textContent = "Accept or decline before the timer ends.";
    if (!rebuyOfferCurrentId && byId("rebuy-offer-dialog")?.open) byId("rebuy-offer-dialog").close();
  }

  function clearRebuyOffer() {
    if (rebuyOfferTimer) window.clearInterval(rebuyOfferTimer);
    rebuyOfferTimer = 0;
    rebuyOfferCurrentId = "";
    rebuyOfferDeadlineMs = 0;
    rebuyOfferRemainingMs = 0;
    rebuyOfferUpdatedAt = 0;
    rebuyActionPending = false;
    updateRebuyOfferControls();
  }

  function syncRebuyOffer(view) {
    var offer = view && view.viewer && view.viewer.rebuy_offer;
    var offerId = String(offer && offer.id || "");
    if (!offerId || !state.activeTableId || !state.player || state.isAdmin) {
      clearRebuyOffer();
      return;
    }
    var newOffer = offerId !== rebuyOfferCurrentId;
    rebuyOfferCurrentId = offerId;
    rebuyOfferDeadlineMs = epochMilliseconds(offer.expires_at);
    var serverNow = epochMilliseconds(view.server_now) || Date.now();
    rebuyOfferRemainingMs = Math.max(0, rebuyOfferDeadlineMs - serverNow);
    rebuyOfferUpdatedAt = monotonicNow();
    var dialog = byId("rebuy-offer-dialog");
    var summary = byId("rebuy-offer-summary");
    var buyInCents = number(view.config && view.config.buy_in, 0) * 100;
    var startingStack = number(view.config && view.config.starting_stack, 0);
    if (summary) {
      summary.textContent = "Re-enter with the original starting stack of " + chips(startingStack) +
        " chips and original buy-in " + dollars(buyInCents) +
        ". This updates the table ledger only; no external payment is taken or settled here.";
    }
    if (newOffer && dialog && typeof dialog.showModal === "function" && !dialog.open) {
      dialog.showModal();
      byId("rebuy-offer-accept").focus({ preventScroll:true });
    }
    if (!rebuyOfferTimer) rebuyOfferTimer = window.setInterval(updateRebuyOfferControls, 250);
    updateRebuyOfferControls();
  }

  function openRebuyOfferDialog() {
    if (!rebuyOfferCurrentId) return;
    var dialog = byId("rebuy-offer-dialog");
    if (!dialog) return;
    if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
    else dialog.setAttribute("open", "");
    byId("rebuy-offer-accept").focus({ preventScroll:true });
  }

  async function submitRebuy(acceptOffer) {
    var view = state.tableView;
    var tableId = String(state.activeTableId || "");
    var offerId = rebuyOfferCurrentId;
    if (rebuyActionPending || !offerId || !tableId || !view || rebuyOfferSecondsRemaining() <= 0) return;
    rebuyActionPending = true;
    updateRebuyOfferControls();
    try {
      var path = "/tables/" + encodeURIComponent(tableId) + "/rebuy" + (acceptOffer ? "" : "/decline");
      var response = await mutate(path, acceptOffer ? { offer_id:offerId, confirm:true } : { offer_id:offerId });
      if (state.activeTableId !== tableId || rebuyOfferCurrentId !== offerId) return;
      var table = response.table || response;
      rebuyActionPending = false;
      state.tableView = table;
      renderTable();
      await refreshSelected();
      await refreshAll(true);
      showNotice(acceptOffer
        ? "Rebuy confirmed. Table totals updated; no external payment was processed."
        : "Rebuy declined. The table will continue.", "success", false);
    } catch (err) {
      if (state.activeTableId === tableId && rebuyOfferCurrentId === offerId) {
        rebuyActionPending = false;
        updateRebuyOfferControls();
        showNotice(err.message || "The rebuy offer could not be updated.", "error", false);
        try { await refreshSelected(); } catch (refreshError) {}
      }
    }
  }

  function renderTable() {
    var view = pageMode === "table" ? state.tableView : null;
    var hasTable = Boolean(view);
    byId("table-loading").hidden = hasTable || pageMode !== "table";
    byId("table-view").hidden = !hasTable;
    byId("app-panel").classList.toggle("has-active-table", hasTable);
    if (!view) {
      clearRebuyOffer();
      closeAvatarViewer(false);
      clearChat();
      routeNoticeForTable();
      renderChatButton();
      var announcements = byId("table-announcements");
      if (announcements) announcements.hidden = true;
      state.sitOutRequestId += 1;
      state.sitOutPending = false;
      renderSitOutButton(null, null);
      syncLastHandButton();
      state.actionSubmittedKey = "";
      byId("results-panel").hidden = true;
      byId("reopen-results-button").hidden = true;
      clearSeatTurnClock();
      clearBlindLevelClock();
      document.body.classList.toggle("gameplay-active", pageMode === "table");
      clearBlindAnnouncement(true);
      clearEliminationAnnouncement();
      byId("pause-button").hidden = true;
      byId("runtime-settings-button").hidden = true;
      byId("paused-banner").hidden = true;
      byId("announcement-banner").hidden = true;
      showActionFeedback("", "info", true);
      closeRecentActionDialog();
      byId("lobby-seat-panel").hidden = true;
      byId("host-panel").hidden = true;
      var setupDialog = byId("table-settings-dialog");
      if (setupDialog.open) setupDialog.close();
      state.runtimeSettingsOpen = false;
      state.settingsDirty = false;
      var tableMenu = byId("table-menu");
      if (tableMenu) tableMenu.open = false;
      byId("cancel-button").hidden = true;
      byId("end-game-button").hidden = true;
      return;
    }

    syncLastHandButton();
    consumeTableEvents(view);
    syncSeatTurnClock(view);
    var status = view.status || "lobby";
    document.body.classList.toggle("gameplay-active", pageMode === "table" || status === "playing" || status === "completed" || status === "ended");
    var statusNode = byId("view-status");
    statusNode.textContent = view.paused ? "Paused" : statusName(status);
    statusNode.className = "status-pill" + (view.paused ? " paused" : (status === "playing" ? " playing" : (status === "completed" ? " completed" : (status === "ended" ? " ended" : ""))));
    byId("view-table-name").textContent = view.name || "Sit-and-go";
    var layout = seatLayout(view);
    var seats = layout.seats;
    var max = layout.max;
    var viewer = view.viewer || {};
    var seatBuyInCount = seats.reduce(function (sum, seat) { return sum + number(seat.buy_in_count, 0); }, 0);
    var totalRebuys = seats.reduce(function (sum, seat) { return sum + number(seat.rebuy_count, 0); }, 0);
    var totalBuyInCents = seats.length && seats.every(function (seat) { return seat.total_buy_in_cents != null; })
      ? seats.reduce(function (sum, seat) { return sum + number(seat.total_buy_in_cents, 0); }, 0) : null;
    var subtitle = seats.length + " of " + max + " seats";
    if (view.prize_pool_cents != null) subtitle += " · Prize pool " + dollars(view.prize_pool_cents);
    if (status === "lobby" && view.config) subtitle += " · Buy-in " + dollars(number(view.config.buy_in, 0) * 100) + " · " + view.config.payout_percentages.join(" / ") + "%";
    if (viewer.total_buy_in_cents != null) {
      subtitle += " · Your buy-ins " + dollars(viewer.total_buy_in_cents) + " (" +
        number(viewer.buy_in_count, 0) + " total, " + number(viewer.rebuy_count, 0) + " rebuys)";
    }
    byId("view-table-subtitle").textContent = subtitle;
    byId("hand-number").textContent = number(view.hand_no, 0) > 0 ? "HAND " + number(view.hand_no, 0) : "NO HAND DEALT";
    byId("hand-status-label").textContent = view.paused ? "GAME PAUSED" : (status === "playing" ? "HAND IN PROGRESS" : (status === "completed" ? "TOURNAMENT COMPLETE" : (status === "ended" ? "ENDED BY HOST" : "TABLE LOBBY")));
    routeNoticeForTable();
    byId("table-player-count").textContent = seats.length + " seated" +
      (seatBuyInCount ? " · " + seatBuyInCount + " buy-ins · " + totalRebuys + " rebuys · " +
        (totalBuyInCents == null ? "total amounts not recorded" : dollars(totalBuyInCents)) : "");
    byId("button-caption").textContent = status === "ended" ? "Ended by host" :
      (status === "playing" || status === "completed" ? "" : "Game ledger only · no external payment");

    syncRebuyOffer(view);
    renderBlindStrip(view);
    renderBoard(view);
    renderActions(view);
    renderLog(view);
    renderLastAction(view);
    renderResults(view);

    var viewer = view.viewer || {};
    var playerId = String(viewer.player_id || (state.player && state.player.id) || "");
    var ownSeat = seats.find(function (seat) {
      return String(seat.id || seat.player_id || "") === playerId;
    }) || null;
    if (ownSeat && state.player && Object.prototype.hasOwnProperty.call(ownSeat, "avatar_url")) {
      var snapshotAvatarUrl = String(ownSeat.avatar_url || "");
      if (profileAvatarOverride && profileAvatarOverride.playerId === playerId) {
        if (snapshotAvatarUrl === profileAvatarOverride.url) profileAvatarOverride = null;
        else if (Date.now() < profileAvatarOverride.expiresAt) snapshotAvatarUrl = profileAvatarOverride.url;
        else profileAvatarOverride = null;
      }
      if (String(state.player.avatar_url || "") !== snapshotAvatarUrl) {
        state.player.avatar_url = snapshotAvatarUrl;
        renderIdentityAvatar();
      }
    }
    var seated = Boolean(viewer.seated || ownSeat);
    var host = String(view.host_id || "") === playerId;
    byId("cancel-button").hidden = !(host && status === "lobby");
    byId("end-game-button").hidden = !(host && status === "playing");
    byId("history-button").hidden = state.isAdmin;
    byId("profile-photo-menu-button").hidden = state.isAdmin;
    byId("table-logout-button").hidden = state.isAdmin;
    byId("reaction-settings-button").hidden = state.isAdmin;
    var menu = byId("table-menu");
    if (menu && !hasTable) menu.open = false;
    renderSitOutButton(view, ownSeat);
    ensureChatScope();
    renderChatButton();
    renderPauseControls(view, host);
    renderTableAnnouncements(view);
    renderLobbyControls(view, host, ownSeat, seated, layout);
    renderSettingsPanel(view, host);
    updateHostReadiness(view, host);
    renderSeats(view);
    renderReactionBursts();
    playTableEffects();
    if (state.openTableSetupOnLoad) {
      state.openTableSetupOnLoad = false;
      setHashTable(state.activeTableId);
      if (host && status === "lobby") window.setTimeout(openTableSettingsDialog, 0);
    }
  }

  function enterApp(player, csrf, sessionProof) {
    var previousPlayerId = String(state.player && state.player.id || "");
    var nextPlayerId = String(player && player.id || "");
    if (previousPlayerId !== nextPlayerId) {
      closeProfilePhotoDialog(false);
      clearAvatarCache();
      resetReactionStream();
      closeLastHandDialog(false);
      clearChat();
      state.sitOutRequestId += 1;
      state.sitOutPending = false;
    }
    state.player = player || null;
    loadReactionFavorites(state.player);
    if (typeof sessionProof === "string" && sessionProof) state.sessionProof = sessionProof;
    if (typeof csrf === "string" && csrf) state.csrf = csrf;
    persistAuth();
    state.isAdmin = Boolean(player && player.is_admin);
    if (!state.activeTableId) setActiveTableId(requestedTableId());
    var photoGatedTableId = !state.isAdmin && !player.avatar_url ? String(state.activeTableId || "") : "";
    if (photoGatedTableId) {
      setActiveTableId("");
      state.tableView = null;
      setHashTable("");
    }
    state.restoreTableId = state.activeTableId ? String(state.activeTableId) : "";
    state.polling = !state.isAdmin;
    byId("login-panel").hidden = true;
    byId("app-panel").hidden = state.isAdmin;
    byId("admin-panel").hidden = !state.isAdmin;
    byId("identity").hidden = false;
    byId("profile-photo-button").hidden = state.isAdmin;
    byId("profile-account-button").hidden = state.isAdmin;
    byId("profile-photo-menu-button").hidden = state.isAdmin;
    byId("lobby-history-button").hidden = state.isAdmin;
    byId("logout-button").hidden = state.isAdmin;
    byId("admin-logout-button").hidden = !state.isAdmin;
    byId("history-button").hidden = state.isAdmin;
    byId("table-logout-button").hidden = state.isAdmin;
    byId("reaction-settings-button").hidden = state.isAdmin;
    document.body.classList.toggle("admin-active", state.isAdmin);
    byId("welcome-name").textContent = state.player
      ? (state.player.display_name || state.player.name || state.player.username || "") : "";
    renderIdentityAvatar();
    clearNotice();
    loadGlobalConfig().catch(function () {});
    if (state.isAdmin) {
      setActiveTableId("");
      state.tableView = null;
      setHashTable("");
      renderTable();
      loadAvatarPresets(true).then(function () { renderAdminAvatarCatalog(); });
      loadAdminConfig();
      if (byId("admin-tables-details").open) loadAdminTables();
      if (byId("admin-history-details").open) loadAdminHistory(0, false);
    } else {
      document.body.classList.remove("admin-active");
      renderTables();
      renderTable();
      refreshAll(true);
      if (photoGatedTableId) {
        openProfilePhotoDialog(null, function () {
          window.location.assign(tableWindowUrl(photoGatedTableId, false));
        });
      }
    }
  }

  async function boot() {
    try {
      var data = await request("/me");
      if (data.authenticated && (data.needs_claim || data.player?.needs_claim) && state.sessionProof && data.csrf) {
        state.csrf = data.csrf;
        byId("login-panel").hidden = false;
        setAuthMode("claim");
      } else if (data.authenticated && state.sessionProof && data.csrf) {
        setActiveTableId(requestedTableId());
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
    if (state.reactions.tableId !== tableId) {
      state.reactions = {
        tableId: tableId,
        cursor: number(view.reaction_cursor, 0),
        pending: [],
        loading: false,
        requestId: 0
      };
    } else if (state.reactions.cursor == null) {
      state.reactions.cursor = number(view.reaction_cursor, 0);
    }
    state.tableView = view;
    return true;
  }

  async function refreshTableReactions(tableId) {
    if (!tableId || state.activeTableId !== tableId) return;
    var stream = state.reactions;
    if (stream.tableId !== tableId) {
      stream = {
        tableId: tableId,
        cursor: null,
        pending: [],
        loading: false,
        requestId: 0
      };
      state.reactions = stream;
    }
    if (stream.loading) return;
    var after = stream.cursor;
    var requestId = ++stream.requestId;
    stream.loading = true;
    var path = "/tables/" + encodeURIComponent(tableId) + "/reactions";
    if (after != null) path += "?after=" + encodeURIComponent(String(after));
    try {
      var data = await request(path);
      if (state.activeTableId !== tableId || state.reactions !== stream || stream.requestId !== requestId) return;
      if (after == null) {
        stream.cursor = number(data.cursor, 0);
        return;
      }
      var cursor = number(stream.cursor, 0);
      var nextCursor = number(data.cursor, cursor);
      (Array.isArray(data.reactions) ? data.reactions : []).forEach(function (reaction) {
        var id = number(reaction && reaction.id, 0);
        if (id > cursor && id <= nextCursor) stream.pending.push(reaction);
      });
      stream.pending = stream.pending.slice(-32);
      stream.cursor = Math.max(cursor, nextCursor);
      renderReactionBursts();
    } finally {
      if (state.reactions === stream && stream.requestId === requestId) stream.loading = false;
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
      if (!state.isAdmin && Date.now() - state.adminConfigRefreshAt > 15000) loadGlobalConfig().catch(function () {});
      if (!state.activeTableId) {
        var result = await request("/tables");
        state.tables = Array.isArray(result.tables) ? result.tables : [];
        renderTables();
      }

      if (state.activeTableId) {
        var selectedTableId = String(state.activeTableId);
        try {
          var detail = await request("/tables/" + encodeURIComponent(selectedTableId));
          if (state.activeTableId !== selectedTableId) return;
          var incoming = detail.table || detail;
          if (state.restoreTableId === selectedTableId) {
            state.restoreTableId = "";
            if (incoming.status === "ended" || incoming.status === "cancelled") {
              setActiveTableId("");
              state.tableView = null;
              state.skipAutoResume = true;
              setHashTable("");
              renderTables();
              renderTable();
            }
          }
          if (state.activeTableId === selectedTableId && adoptSnapshot(incoming, selectedTableId)) {
            renderTable();
            refreshTableReactions(selectedTableId).catch(function (reactionError) {
              if (reactionError.status === 401) return;
            });
          }
        } catch (err) {
          if (state.activeTableId !== selectedTableId) return;
          if (err.status === 404) {
            clearBlindAnnouncement(true);
            closeRecentActionDialog();
            closeLastHandDialog(false);
            setActiveTableId("");
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
      var boundaryDelay = nextAuthoritativeBoundaryDelay(state.tableView);
      if (boundaryDelay > 0) visibleDelay = Math.max(40, Math.min(visibleDelay, boundaryDelay));
      var delay = state.refreshPending ? 0 : (document.hidden ? 8000 : visibleDelay);
      state.refreshPending = false;
      scheduleRefresh(delay);
    }
  }

  async function mutate(path, body, method) {
    return request(path, { method: method || "POST", body: body, mutate: true });
  }

  function payouts(id) {
    var parts = String(byId(id).value || "").split(",").map(function (x) { return x.trim(); });
    if (parts.length < 1 || parts.length > 9 || parts.some(function (x) { return !/^\d{1,3}$/.test(x); }) || parts.reduce(function (sum, x) { return sum + Number(x); }, 0) !== 100) {
      throw Error("Payout shares must be whole percentages totaling 100%.");
    }
    return parts.map(Number);
  }
  function dollars(cents) {
    return "$" + new Intl.NumberFormat("en-US", { minimumFractionDigits:2, maximumFractionDigits:2 })
      .format(number(cents, 0) / 100);
  }
  function buyInAccountingCopy(row) {
    if (!row || row.buy_in_count == null) return "";
    var count = number(row.buy_in_count, 0);
    var rebuys = number(row.rebuy_count, Math.max(0, count - 1));
    var total = row.total_buy_in_cents == null ? null : number(row.total_buy_in_cents, 0);
    var text = count + " buy-in" + (count === 1 ? "" : "s");
    if (rebuys) text += ", " + rebuys + " rebuy" + (rebuys === 1 ? "" : "s");
    if (total != null) text += " · " + dollars(total) + " total";
    return " · " + text;
  }
  function settingsPayload() {
    var view = state.tableView || {};
    var payload = {
      level_minutes: number(byId("settings-level-minutes").value, 0),
      turn_seconds: number(byId("settings-turn-seconds").value, 0)
    };
    if (view.status === "playing") return payload;
    payload.buy_in = number(byId("settings-buy-in").value, -1);
    payload.payout_percentages = payouts("settings-payout");
    payload.name = byId("settings-table-name").value.trim();
    payload.starting_stack = number(byId("settings-starting-stack").value, 0);
    payload.small_blind = number(byId("settings-small-blind").value, 0);
    payload.big_blind = number(byId("settings-big-blind").value, 0);
    return payload;
  }

  async function saveSettings() {
    if (!state.activeTableId || !state.tableView || state.settingsSaving) return false;
    var payload;
    try { payload = settingsPayload(); } catch (err) { showNotice(err.message, "error", false); return false; }
    var form = byId("table-settings-form");
    var inGame = state.tableView.status === "playing";
    if (inGame && !state.tableView.paused) {
      showNotice("Pause the game before changing its timing.", "error", false);
      return false;
    }
    var timingInvalid = payload.level_minutes < 0.01 || payload.level_minutes > 2147483647 || payload.turn_seconds < 1 || payload.turn_seconds > 3600;
    if (!form.checkValidity() || timingInvalid || (!inGame &&
        (!payload.name || payload.buy_in < 0 || payload.starting_stack < 100 || payload.small_blind < 1 || payload.big_blind <= payload.small_blind))) {
      showNotice(inGame ? "Check the timing values." : "Check the table name, buy-in, stack, blinds, and payouts.", "error", false);
      return false;
    }

    state.settingsSaving = true;
    renderSettingsPanel(state.tableView, true);
    updateHostReadiness(state.tableView, true);
    var saved = false;
    try {
      var data = await mutate("/tables/" + encodeURIComponent(state.activeTableId) + "/settings", payload);
      state.settingsDirty = false;
      state.tableView = data.table || data;
      await refreshSelected();
      await refreshAll(true);
      showNotice(inGame ? "Game timing settings saved." : "Table settings saved.", "success", false);
      saved = true;
    } catch (err) {
      showNotice(err.message, "error", false);
    } finally {
      state.settingsSaving = false;
      renderTable();
    }
    return saved;
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
    if (!name || (!password && name.toLowerCase() !== "admin")) {
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
      setActiveTableId(requestedTableId());
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
  var historyTrigger = null;
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
      return esc((r.tied ? "T-" : "") + r.place + ". " + r.name +
        (r.award_cents == null ? "" : " · " + (r.award_is_estimate ? "Estimated " : "") + dollars(r.award_cents)) +
        buyInAccountingCopy(r));
    }).join("<br>");
  }
  function historySummaryText(tournament) {
    var text = String(tournament && tournament.summary_text || "");
    return text ? '<details class="history-text-panel"><summary>Felt Night tournament summary</summary><pre>' + esc(text) + '</pre></details>' : "";
  }
  function historyHand(h) {
    var text = String(h && h.history_text || "");
    if (text) {
      return '<details class="history-entry"><summary>Hand ' + esc(h.number) + ' · ' + esc(historyCards(h.board) || "Preflop") + '</summary><pre class="history-text">' + esc(text) + '</pre></details>';
    }
    var seats = (h.players || []).map(function (p) {
      return '<li>' + esc(p.name) + (p.player_id === state.player?.id ? " (you)" : "") + (p.cards?.length ? " · " + esc(historyCards(p.cards)) : "") + (p.stack_before != null ? " · " + chips(p.stack_before) + " chips" : "") + '</li>';
    }).join("");
    var pots = (h.result?.pots || []).map(function (p, i) {
      return (i ? "Side pot " + i : "Main pot") + ": " + (p.recipients || []).map(function (r) {
        return r.actor_label + " +" + chips(r.amount);
      }).join(", ");
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
        el.innerHTML = '<button class="button button-quiet history-back" data-history-list>← All tournaments</button><h3>' + esc(t.name) + '</h3><p>' + historyResults(t.results) + '</p>' + historySummaryText(t) + legacyNote +
          (data.hands || []).map(historyHand).join("") + (data.hands?.length ? '' : '<p>No saved hands for this tournament.</p>');
      } else {
        el.innerHTML = (data.tournaments || []).map(function (t) {
          var mine = (t.results || []).find(function (row) {return row.player_id === state.player?.id;});
          return '<div class="history-entry"><h3>' + esc(t.name) + '</h3><p>' + esc(new Date((t.started || t.created)*1000).toLocaleDateString()) + ' · ' + esc(statusName(t.status)) + ' · ' + esc(t.hand_count) + ' saved hands' + (mine ? ' · Place ' + esc(mine.place) + (mine.award_cents == null ? "" : ' · ' + (mine.award_is_estimate ? 'Estimated ' : '') + dollars(mine.award_cents)) + esc(buyInAccountingCopy(mine)) : '') + '</p><button class="button button-outline button-small" data-history-table="' + esc(t.id) + '">View hands &amp; results</button></div>';
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
  byId("last-hand-dialog").addEventListener("click", function (event) {
    if (isDialogBackdropClick(byId("last-hand-dialog"), event)) closeLastHandDialog(true);
  });
  byId("last-hand-prev").addEventListener("click", function () {
    moveLastHandStreet(-1);
  });
  byId("last-hand-next").addEventListener("click", function () {
    moveLastHandStreet(1);
  });
  byId("last-hand-older").addEventListener("click", function () {
    moveLastHandRecord(-1);
  });
  byId("last-hand-newer").addEventListener("click", function () {
    moveLastHandRecord(1);
  });

  byId("recent-action-button").addEventListener("click", function () {
    var dialog = byId("recent-action-dialog");
    if (!dialog.open) dialog.showModal();
    byId("recent-action-button").setAttribute("aria-expanded", "true");
    var close = byId("recent-action-close");
    if (close) close.focus();
  });
  byId("recent-action-close").addEventListener("click", function () {
    closeRecentActionDialog(true);
  });
  byId("recent-action-dialog").addEventListener("cancel", function (event) {
    event.preventDefault();
    closeRecentActionDialog(true);
  });
  byId("recent-action-dialog").addEventListener("click", function (event) {
    if (isDialogBackdropClick(byId("recent-action-dialog"), event)) closeRecentActionDialog(true);
  });
  byId("recent-action-dialog").addEventListener("close", function () {
    byId("recent-action-button").setAttribute("aria-expanded", "false");
  });

  function openHistoryDialog(event) {
    historyTrigger = event && event.currentTarget || byId("history-button");
    byId("history-dialog").showModal();
    loadHistory("");
  }
  function closeHistoryDialog(restoreFocus) {
    var dialog = byId("history-dialog");
    var triggerId = historyTrigger && historyTrigger.id || "history-button";
    if (dialog.open) dialog.close();
    historyTrigger = null;
    if (restoreFocus) focusTableControl(triggerId);
  }
  byId("history-button").addEventListener("click", openHistoryDialog);
  byId("lobby-history-button").addEventListener("click", openHistoryDialog);
  byId("profile-photo-button").addEventListener("click", openProfilePhotoDialog);
  byId("profile-photo-menu-button").addEventListener("click", openProfilePhotoDialog);
  byId("profile-photo-presets").addEventListener("click", function (event) {
    var button = event.target.closest("[data-avatar-preset-id]");
    if (button) selectAvatarPreset(button.getAttribute("data-avatar-preset-id"));
  });
  byId("profile-account-button").addEventListener("click", openProfileAccountDialog);
  byId("admin-avatar-preset-form").addEventListener("submit", saveAdminAvatarPreset);
  byId("admin-avatar-preset-name").addEventListener("input", function () { setAdminAvatarError(""); });
  byId("admin-avatar-preset-file").addEventListener("change", function () {
    setAdminAvatarError("");
    byId("admin-avatar-preset-preview-wrap").hidden = true;
    byId("admin-avatar-preset-status").textContent = "";
  });
  byId("profile-account-close").addEventListener("click", function () { closeProfileAccountDialog(true); });
  byId("profile-account-dialog").addEventListener("cancel", function (event) {
    event.preventDefault();
    if (!profileAccountBusy) closeProfileAccountDialog(true);
  });
  byId("profile-account-dialog").addEventListener("click", function (event) {
    if (!profileAccountBusy && isDialogBackdropClick(byId("profile-account-dialog"), event)) closeProfileAccountDialog(true);
  });
  byId("profile-account-form").addEventListener("submit", saveProfileAccount);
  ["profile-account-username", "profile-account-display-name", "profile-account-current-password",
    "profile-account-new-password"].forEach(function (id) {
    byId(id).addEventListener("input", function () {
      setProfileAccountError("");
      updateProfileAccountForm();
    });
  });
  byId("profile-photo-close").addEventListener("click", function () { closeProfilePhotoDialog(true); });
  byId("profile-photo-dialog").addEventListener("cancel", function (event) {
    event.preventDefault();
    closeProfilePhotoDialog(true);
  });
  byId("profile-photo-dialog").addEventListener("click", function (event) {
    if (isDialogBackdropClick(byId("profile-photo-dialog"), event)) closeProfilePhotoDialog(true);
  });
  byId("profile-photo-choose").addEventListener("click", function () { byId("profile-photo-file").click(); });
  byId("profile-photo-file").addEventListener("change", async function () {
    var file = byId("profile-photo-file").files && byId("profile-photo-file").files[0];
    if (!file) return;
    invalidateProfilePhotoWork();
    profilePhotoPresetId = "";
    renderAvatarPresets();
    setProfilePhotoPreview(String(state.player && state.player.avatar_url || ""), false);
    setProfilePhotoError("");
    profilePhotoBusy = true;
    byId("profile-photo-status").textContent = "Preparing photo…";
    updateProfilePhotoButtons();
    var generation = profilePhotoGeneration;
    var playerId = String(state.player && state.player.id || "");
    try {
      var source = await loadAvatarFile(file);
      if (generation !== profilePhotoGeneration || playerId !== String(state.player && state.player.id || "") || !byId("profile-photo-dialog").open) {
        if (source.close) source.close();
        return;
      }
      profilePhotoSource = source;
      byId("profile-photo-editor").hidden = false;
      drawProfilePhotoCrop();
      await prepareProfilePhotoCrop(++profilePhotoCropRevision);
    } catch (err) {
      if (generation !== profilePhotoGeneration || playerId !== String(state.player && state.player.id || "")) return;
      byId("profile-photo-status").textContent = "";
      setProfilePhotoError(err.message || "Could not prepare that photo.");
      byId("profile-photo-file").value = "";
    } finally {
      if (generation === profilePhotoGeneration && playerId === String(state.player && state.player.id || "")) {
        profilePhotoBusy = false;
        updateProfilePhotoButtons();
      }
    }
  });
  ["zoom", "x", "y"].forEach(function (field) {
    byId("profile-photo-" + field).addEventListener("input", function (event) {
      if (profilePhotoBusy || !profilePhotoSource) return;
      profilePhotoCrop[field] = Number(event.target.value) / (field === "zoom" ? 1 : 100);
      changeProfilePhotoCrop();
    });
  });
  byId("profile-photo-reset").addEventListener("click", function () {
    if (profilePhotoBusy || !profilePhotoSource) return;
    profilePhotoCrop = { zoom:1, x:0.5, y:0.5 };
    changeProfilePhotoCrop();
  });
  var cropCanvas = byId("profile-photo-canvas");
  cropCanvas.addEventListener("pointerdown", function (event) {
    if (profilePhotoBusy || !profilePhotoSource || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    cropCanvas.focus({ preventScroll:true });
    cropCanvas.setPointerCapture(event.pointerId);
    profilePhotoDrag = { id:event.pointerId, x:event.clientX, y:event.clientY,
      cropX:profilePhotoCrop.x, cropY:profilePhotoCrop.y };
  });
  cropCanvas.addEventListener("pointermove", function (event) {
    if (!profilePhotoDrag || profilePhotoDrag.id !== event.pointerId || profilePhotoBusy || !profilePhotoSource) return;
    var side = Math.min(profilePhotoSource.width, profilePhotoSource.height) / profilePhotoCrop.zoom;
    var box = cropCanvas.getBoundingClientRect();
    var availableX = profilePhotoSource.width - side, availableY = profilePhotoSource.height - side;
    if (availableX > 0) profilePhotoCrop.x = profilePhotoDrag.cropX - (event.clientX - profilePhotoDrag.x) / box.width * side / availableX;
    if (availableY > 0) profilePhotoCrop.y = profilePhotoDrag.cropY - (event.clientY - profilePhotoDrag.y) / box.height * side / availableY;
    changeProfilePhotoCrop();
  });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach(function (type) {
    cropCanvas.addEventListener(type, function (event) {
      if (profilePhotoDrag && profilePhotoDrag.id === event.pointerId) profilePhotoDrag = null;
    });
  });
  cropCanvas.addEventListener("keydown", function (event) {
    if (profilePhotoBusy || !profilePhotoSource || !/^Arrow(Left|Right|Up|Down)$/.test(event.key)) return;
    event.preventDefault();
    var step = event.shiftKey ? 0.1 : 0.025;
    if (event.key === "ArrowLeft") profilePhotoCrop.x += step;
    if (event.key === "ArrowRight") profilePhotoCrop.x -= step;
    if (event.key === "ArrowUp") profilePhotoCrop.y += step;
    if (event.key === "ArrowDown") profilePhotoCrop.y -= step;
    changeProfilePhotoCrop();
  });
  byId("profile-photo-save").addEventListener("click", saveProfilePhoto);
  byId("history-close").addEventListener("click", function () {
    closeHistoryDialog(true);
  });
  byId("history-dialog").addEventListener("cancel", function (event) {
    event.preventDefault();
    closeHistoryDialog(true);
  });
  byId("history-dialog").addEventListener("click", function (event) {
    if (isDialogBackdropClick(byId("history-dialog"), event)) closeHistoryDialog(true);
  });
  byId("history-dialog").addEventListener("close", function () {
    if (byId("history-dialog").open) return;
    historyGeneration += 1;
    historyTrigger = null;
    byId("history-content").replaceChildren();
  });
  byId("history-content").addEventListener("click", function (event) {
    var button = event.target.closest("button");
    if (!button) return;
    if (button.hasAttribute("data-history-table")) loadHistory(button.dataset.historyTable);
    else if (button.hasAttribute("data-history-list")) loadHistory("");
    else if (button.hasAttribute("data-history-offset")) {
      loadHistory(byId("history-content").dataset.table, Number(button.dataset.historyOffset));
    }
  });
  byId("admin-config-form").addEventListener("submit", saveAdminConfig);
  byId("admin-tables-details").addEventListener("toggle", function () {
    if (byId("admin-tables-details").open) loadAdminTables();
  });
  byId("admin-tables-refresh").addEventListener("click", function (event) {
    event.preventDefault();
    event.stopPropagation();
    loadAdminTables();
  });
  byId("admin-tables-list").addEventListener("click", function (event) {
    var button = event.target.closest("button");
    if (!button) return;
    if (button.hasAttribute("data-admin-inspect")) inspectAdminTable(button.closest("[data-admin-table-id]"));
    else if (button.hasAttribute("data-admin-add-bot")) mutateAdminBot(button, true);
    else if (button.hasAttribute("data-admin-remove-bot")) mutateAdminBot(button, false);
  });
  byId("admin-history-details").addEventListener("toggle", function () {
    if (byId("admin-history-details").open && state.isAdmin) loadAdminHistory(0, false);
  });
  byId("admin-history-list").addEventListener("click", function (event) {
    var button = event.target.closest("button");
    if (!button) return;
    if (button.hasAttribute("data-admin-history-refresh")) loadAdminHistory(0, false);
    else if (button.hasAttribute("data-admin-history-more")) {
      loadAdminHistory(number(button.getAttribute("data-admin-history-more"), 0), true);
    } else if (button.hasAttribute("data-admin-history-view")) {
      inspectAdminHistory(button.getAttribute("data-admin-history-view"), button);
    } else if (button.hasAttribute("data-admin-history-clear-selection")) {
      clearAdminHistorySelection();
      var selectAll = byId("admin-history-list").querySelector("[data-admin-history-select-all]");
      if (selectAll) selectAll.focus({ preventScroll: true });
    } else if (button.hasAttribute("data-admin-history-delete-selected")) {
      beginAdminHistoryBulkDelete(button);
    }
  });
  byId("admin-history-list").addEventListener("change", function (event) {
    var input = event.target.closest("input[type=checkbox]");
    if (!input) return;
    if (input.hasAttribute("data-admin-history-select-all")) {
      updateAdminHistoryLoadedSelection(input.checked);
      var updatedSelectAll = byId("admin-history-list").querySelector("[data-admin-history-select-all]");
      if (updatedSelectAll) updatedSelectAll.focus({ preventScroll: true });
    } else if (input.hasAttribute("data-admin-history-select")) {
      var gameId = input.getAttribute("data-admin-history-select");
      updateAdminHistorySelection(gameId, input.checked);
      var updatedSelection = byId("admin-history-list").querySelector(
        '[data-admin-history-select="' + CSS.escape(gameId) + '"]',
      );
      if (updatedSelection) updatedSelection.focus({ preventScroll: true });
    }
  });
  byId("admin-history-content").addEventListener("click", function (event) {
    var button = event.target.closest("button");
    if (!button) return;
    if (button.hasAttribute("data-admin-history-delete")) {
      beginAdminHistoryDelete(button.getAttribute("data-admin-history-delete"));
    } else if (button.hasAttribute("data-admin-history-hand-more")) {
      loadAdminHistoryDetail(state.adminHistoryDetailId,
        number(button.getAttribute("data-admin-history-hand-more"), 0), true);
    }
  });
  byId("admin-history-close").addEventListener("click", function () {
    closeAdminHistoryDialog(true);
  });
  byId("admin-history-dialog").addEventListener("cancel", function (event) {
    event.preventDefault();
    if (!state.adminHistoryDeleting) closeAdminHistoryDialog(true);
  });
  byId("admin-history-dialog").addEventListener("click", function (event) {
    if (isDialogBackdropClick(byId("admin-history-dialog"), event) && !state.adminHistoryDeleting) {
      closeAdminHistoryDialog(true);
    }
  });
  byId("admin-history-delete-cancel").addEventListener("click", cancelAdminHistoryDelete);
  byId("admin-history-delete-confirm").addEventListener("click", confirmAdminHistoryDelete);

  function openTableSettingsDialog() {
    var view = state.tableView;
    if (!view || state.isAdmin) return;
    var playerId = String(state.player && state.player.id || "");
    if (String(view.host_id || "") !== playerId) return;
    var dialog = byId("table-settings-dialog");
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    byId("runtime-settings-button").setAttribute("aria-expanded", "true");
    if (state.tableView) renderSettingsPanel(state.tableView, true);
  }

  byId("runtime-settings-button").addEventListener("click", function () {
    var menu = byId("table-menu");
    if (menu) menu.open = false;
    openTableSettingsDialog();
  });
  byId("reaction-settings-button").addEventListener("click", function () {
    var menu = byId("table-menu");
    if (menu) menu.open = false;
    openReactionSettingsDialog();
  });
  byId("reaction-settings-close").addEventListener("click", function () {
    closeReactionSettingsDialog(true);
  });
  byId("reaction-settings-cancel").addEventListener("click", function () {
    closeReactionSettingsDialog(true);
  });
  byId("reaction-settings-dialog").addEventListener("cancel", function (event) {
    event.preventDefault();
    closeReactionSettingsDialog(true);
  });
  byId("reaction-settings-dialog").addEventListener("close", function () {
    byId("reaction-settings-button").setAttribute("aria-expanded", "false");
  });
  byId("reaction-settings-dialog").addEventListener("click", function (event) {
    if (isDialogBackdropClick(byId("reaction-settings-dialog"), event)) closeReactionSettingsDialog(true);
  });
  document.querySelectorAll("[data-reaction-select]").forEach(function (select) {
    select.addEventListener("change", syncReactionSelectOptions);
  });
  byId("reaction-settings-form").addEventListener("submit", function (event) {
    event.preventDefault();
    var favorites = Array.from(document.querySelectorAll("[data-reaction-select]")).map(function (select) {
      return select.value;
    });
    if (favorites.length !== 3 || new Set(favorites).size !== 3 ||
        favorites.some(function (emoji) { return REACTION_EMOJIS.indexOf(emoji) < 0; })) {
      byId("reaction-settings-error").textContent = "Choose three different reactions.";
      byId("reaction-settings-error").hidden = false;
      return;
    }
    saveReactionFavorites(favorites);
    closeReactionSettingsDialog(false);
    renderTable();
    var firstShortcut = byId("reaction-shortcuts") && byId("reaction-shortcuts").querySelector("[data-send-reaction]");
    if (firstShortcut) firstShortcut.focus({ preventScroll: true });
  });
  byId("table-menu").addEventListener("click", function (event) {
    var button = event.target.closest("button");
    if (!button || button.disabled) return;
    var menu = byId("table-menu");
    if (menu && menu.open) menu.open = false;
  });
  function closeTableSettingsDialog(restoreFocus) {
    var dialog = byId("table-settings-dialog");
    if (dialog && dialog.open) dialog.close();
    state.runtimeSettingsOpen = false;
    byId("runtime-settings-button").setAttribute("aria-expanded", "false");
    if (restoreFocus) focusTableControl("runtime-settings-button");
  }
  byId("settings-dialog-close").addEventListener("click", function () {
    closeTableSettingsDialog(true);
  });
  byId("table-settings-dialog").addEventListener("cancel", function (event) {
    event.preventDefault();
    closeTableSettingsDialog(true);
  });
  byId("table-settings-dialog").addEventListener("close", function () {
    state.runtimeSettingsOpen = false;
    byId("runtime-settings-button").setAttribute("aria-expanded", "false");
  });
  byId("table-settings-dialog").addEventListener("click", function (event) {
    if (isDialogBackdropClick(byId("table-settings-dialog"), event) && !state.settingsSaving) closeTableSettingsDialog(true);
  });
  byId("payout-place-count").addEventListener("change", function (event) {
    if (event.target.disabled) return;
    writePayoutShares(resizePayoutPlaces(event.target.value));
    state.settingsDirty = true;
    renderSettingsPanel(state.tableView, true);
    updateHostReadiness(state.tableView, true);
  });
  byId("payout-sliders").addEventListener("input", function (event) {
    var input = event.target.closest(".payout-slider");
    if (!input || input.disabled) return;
    var index = number(input.getAttribute("data-payout-index"), -1);
    writePayoutShares(rebalanceEditedPayout(index, input.value));
  });

  function updateEndGameConfirmation() {
    var confirmation = state.endConfirmation;
    var busy = Boolean(confirmation.busy);
    byId("end-game-confirm").disabled = busy;
    byId("end-game-cancel").disabled = busy;
    byId("end-game-close").disabled = busy;
    if (confirmation.step === 1) {
      byId("end-game-step").textContent = "The game will stop now. Confirm once more to end “" + (state.tableView && state.tableView.name || "this table") + "” with no final standings.";
      byId("end-game-confirm").textContent = "End game";
    } else {
      byId("end-game-step").textContent = "You’ll confirm twice before the game ends.";
      byId("end-game-confirm").textContent = "Continue";
    }
  }

  function openEndGameDialog() {
    var view = state.tableView;
    if (!view || view.status !== "playing" || state.isAdmin) return;
    var playerId = String(state.player && state.player.id || "");
    if (String(view.host_id || "") !== playerId) return;
    state.endConfirmation = { tableId: String(state.activeTableId), token: "", step: 0, busy: false };
    byId("end-game-title").textContent = "End “" + (view.name || "this game") + "”?";
    updateEndGameConfirmation();
    var menu = byId("table-menu");
    if (menu) menu.open = false;
    var dialog = byId("end-game-dialog");
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    byId("end-game-confirm").focus();
  }

  function closeEndGameDialog(restoreFocus) {
    var dialog = byId("end-game-dialog");
    if (dialog && dialog.open) dialog.close();
    state.endConfirmation = { tableId: "", token: "", step: 0, busy: false };
    if (restoreFocus !== false) focusTableControl("end-game-button");
  }

  async function confirmEndGame() {
    var confirmation = state.endConfirmation;
    var tableId = confirmation.tableId;
    var view = state.tableView;
    var playerId = String(state.player && state.player.id || "");
    if (confirmation.busy || !tableId || state.activeTableId !== tableId || !view ||
        String(view.host_id || "") !== playerId || view.status !== "playing") {
      closeEndGameDialog();
      return;
    }
    confirmation.busy = true;
    updateEndGameConfirmation();
    try {
      if (confirmation.step === 0) {
        var first = await mutate("/tables/" + encodeURIComponent(tableId) + "/end", { confirm: true });
        if (state.activeTableId !== tableId || state.endConfirmation.tableId !== tableId) return;
        var token = String(first.confirmation_token || "");
        if (!token) throw Error("The room did not issue an end-game confirmation token. Try again.");
        state.endConfirmation.token = token;
        state.endConfirmation.step = 1;
        state.endConfirmation.busy = false;
        updateEndGameConfirmation();
        byId("end-game-confirm").focus();
        return;
      }
      var token = confirmation.token;
      if (!token) throw Error("This confirmation expired. Start again to end the game.");
      var second = await mutate("/tables/" + encodeURIComponent(tableId) + "/end", { confirmation_token: token });
      if (state.activeTableId !== tableId || state.endConfirmation.tableId !== tableId) return;
      var table = second.table || second;
      state.tableView = table;
      state.settingsDirty = false;
      closeEndGameDialog();
      renderTable();
      await refreshAll(true);
      showNotice("The game ended. No final standings were created.", "success", false);
    } catch (err) {
      if (state.endConfirmation.tableId === tableId) {
        state.endConfirmation.busy = false;
        if (state.endConfirmation.step === 1) {
          state.endConfirmation = { tableId: tableId, token: "", step: 0, busy: false };
        }
        updateEndGameConfirmation();
      }
      showNotice(err.message || "The game could not be ended.", "error", false);
    }
  }

  byId("end-game-button").addEventListener("click", openEndGameDialog);
  byId("end-game-confirm").addEventListener("click", function (event) {
    if (event.detail > 1) return;
    confirmEndGame();
  });
  byId("end-game-cancel").addEventListener("click", function () {
    closeEndGameDialog(true);
  });
  byId("end-game-close").addEventListener("click", function () {
    closeEndGameDialog(true);
  });
  byId("end-game-dialog").addEventListener("cancel", function (event) {
    event.preventDefault();
    closeEndGameDialog(true);
  });
  byId("end-game-dialog").addEventListener("close", function () {
    if (byId("end-game-dialog").open) return;
    state.endConfirmation = { tableId: "", token: "", step: 0, busy: false };
  });
  byId("end-game-dialog").addEventListener("click", function (event) {
    if (isDialogBackdropClick(byId("end-game-dialog"), event) && !state.endConfirmation.busy) closeEndGameDialog(true);
  });

  async function logoutFromRoom() {
    try {
      await mutate("/logout", {});
    } catch (err) {
      if (err.status !== 401) showNotice(err.message, "error", false);
    }
    setLoggedOut("");
  }
  ["logout-button", "table-logout-button", "admin-logout-button"].forEach(function (id) {
    byId(id).addEventListener("click", logoutFromRoom);
  });

  async function createNewGame(event, reservedWindow) {
    var button = byId("create-game-tab");
    if (!state.player || state.isAdmin || button.disabled) return;
    if (!state.player.avatar_url) {
      openProfilePhotoDialog({ currentTarget: button }, function () {
        createNewGame();
      });
      return;
    }
    var tableWindow = reservedWindow === undefined ? reserveTableWindow() : reservedWindow;
    button.disabled = true;
    try {
      var tableName = String(state.player.name || "Friends") + "’s table";
      var data = await mutate("/tables", {
        buy_in: 10,
        payout_percentages: [60, 25, 15],
        name: tableName,
        starting_stack: 1000,
        small_blind: 10,
        big_blind: 20,
        level_minutes: 5,
        turn_seconds: 30
      });
      var table = data.table || data;
      if (!table.id) throw new Error("The room did not return the new table.");
      closeLastHandDialog(false);
      state.settingsTableId = "";
      state.settingsDirty = false;
      state.skipAutoResume = false;
      clearNotice();
      openTableWindow(String(table.id), true, tableWindow);
      await refreshAll(true);
    } catch (err) {
      try { if (tableWindow && !tableWindow.closed) tableWindow.close(); } catch (closeError) {}
      showNotice(err.message, "error", false);
    } finally {
      button.disabled = false;
    }
  }
  byId("create-game-tab").addEventListener("click", createNewGame);

  async function postTakeSeat(tableId, playerId, seatNo) {
    var seatSelector = '[data-take-seat="' + String(seatNo) + '"]';
    var button = byId("seat-grid").querySelector(seatSelector);
    if (button) button.disabled = true;
    try {
      await mutate("/tables/" + encodeURIComponent(tableId) + "/seat", { seat_no: seatNo });
      if (state.activeTableId !== tableId || String(state.player && state.player.id || "") !== playerId) return;
      await refreshSelected();
      await refreshAll(true);
    } catch (err) {
      if (state.activeTableId === tableId) showNotice(err.message, "error", false);
    } finally {
      var current = byId("seat-grid").querySelector(seatSelector);
      if (current) current.disabled = false;
    }
  }

  async function addBotToTableSeat(button, seatNo) {
    var view = state.tableView;
    var tableId = String(state.activeTableId || "");
    var playerId = String(state.player && state.player.id || "");
    if (!view || view.status !== "lobby" || !tableId || !playerId ||
        String(view.host_id || "") !== playerId || seatNo < 0 ||
        (Array.isArray(view.seats) && view.seats.some(function (seat) {
          return number(seat.seat_no, -1) === seatNo;
        }))) return;
    button.disabled = true;
    try {
      var response = await mutate("/tables/" + encodeURIComponent(tableId) + "/bots", { seat_no: seatNo });
      if (state.activeTableId !== tableId || String(state.player && state.player.id || "") !== playerId) return;
      var updated = response.table || response;
      if (adoptSnapshot(updated, tableId)) renderTable();
      await refreshSelected();
      await refreshAll(true);
    } catch (err) {
      if (state.activeTableId === tableId) showNotice(err.message || "The bot could not be added.", "error", false);
    } finally {
      var current = byId("seat-grid").querySelector('[data-table-add-bot="' + String(seatNo) + '"]');
      if (current) current.disabled = false;
    }
  }

  async function handleSeatControlClick(event, photoReady) {
    var botButton = event.target.closest("[data-table-add-bot]");
    if (botButton) {
      if (botButton.disabled) return;
      event.stopPropagation();
      await addBotToTableSeat(botButton, number(botButton.getAttribute("data-table-add-bot"), -1));
      return;
    }
    var button = event.target.closest("[data-take-seat]");
    if (!button || button.disabled || !state.activeTableId || state.isAdmin) return;
    event.stopPropagation();
    var tableId = String(state.activeTableId);
    var playerId = String(state.player && state.player.id || "");
    var seatNo = number(button.getAttribute("data-take-seat"), -1);
    if (seatNo < 0 || !playerId) return;
    if (!state.player.avatar_url) {
      var gateKey = playerId + "|" + tableId + "|" + seatNo;
      if (pendingPhotoGateSeat) return;
      pendingPhotoGateSeat = gateKey;
      button.id = "take-seat-photo-gate-" + seatNo;
      var openedPhotoGate = openProfilePhotoDialog({ currentTarget: button }, function () {
        pendingPhotoGateSeat = "";
        if (state.activeTableId === tableId && String(state.player && state.player.id || "") === playerId) {
          postTakeSeat(tableId, playerId, seatNo);
        }
      }, function () {
        pendingPhotoGateSeat = "";
      });
      if (!openedPhotoGate) pendingPhotoGateSeat = "";
      return;
    }
    await postTakeSeat(tableId, playerId, seatNo);
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
      setActiveTableId("");
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
      clearNotice();
    } catch (err) {
      if (state.activeTableId === tableId) showNotice(err.message, "error", false);
    } finally {
      state.pausePending = false;
      if (state.tableView) renderTable();
    }
  });

  byId("start-button").addEventListener("click", async function () {
    if (state.player && !state.player.avatar_url) {
      openProfilePhotoDialog(null, function () { byId("start-button").click(); });
      return;
    }
    var view = state.tableView;
    if (!state.activeTableId || !view || view.status !== "lobby") return;
    var tableId = String(state.activeTableId);
    var playerId = String(state.player && state.player.id || "");
    if (String(view.host_id || "") !== playerId) return;
    var entrants = Array.isArray(view.seats) ? view.seats.length : 0;
    if (entrants < 2) {
      showNotice("Invite or seat one more player before dealing.", "info", false);
      return;
    }
    var button = byId("start-button");
    button.disabled = true;
    var adjustedPayouts = null;
    try {
      var currentPayouts = readPayoutShares();
      if (currentPayouts.length > entrants) {
        adjustedPayouts = allocatePayoutShares(currentPayouts.slice(0, entrants), 100);
        writePayoutShares(adjustedPayouts);
        state.settingsDirty = true;
        updateHostReadiness(view, true);
        var saved = await saveSettings();
        if (!saved || state.activeTableId !== tableId || !state.tableView || state.tableView.status !== "lobby") return;
      }
      var data = await mutate("/tables/" + encodeURIComponent(tableId) + "/start", {});
      if (state.activeTableId !== tableId) return;
      state.tableView = data.table || data;
      await refreshSelected();
      await refreshAll(true);
      if (adjustedPayouts) {
        showNotice("Payouts adjusted for " + adjustedPayouts.length + " seated players: " + adjustedPayouts.join(" / ") + "%.", "info", false);
      } else {
        clearNotice();
      }
    } catch (err) {
      showNotice(err.message, "error", false);
    } finally {
      button.disabled = false;
    }
  });

  byId("close-table-button").addEventListener("click", function () {
    clearBlindAnnouncement(true);
    closeRecentActionDialog();
    closeLastHandDialog(false);
    var settingsDialog = byId("table-settings-dialog");
    if (settingsDialog.open) settingsDialog.close();
    var endDialog = byId("end-game-dialog");
    if (endDialog.open) endDialog.close();
    state.endConfirmation = { tableId: "", token: "", step: 0, busy: false };
    var menu = byId("table-menu");
    if (menu) menu.open = false;
    setActiveTableId("");
    state.skipAutoResume = true;
    state.restoreTableId = "";
    state.tableView = null;
    setHashTable("");
    renderTables();
    renderTable();
    refreshAll(true);
  });

  byId("popup-fallback-open").addEventListener("click", function () {
    var url = state.pendingTableUrl;
    if (!url) return;
    state.pendingTableUrl = "";
    byId("popup-fallback").hidden = true;
    window.location.assign(url);
  });
  byId("popup-fallback-dismiss").addEventListener("click", function () {
    state.pendingTableUrl = "";
    byId("popup-fallback").hidden = true;
  });

  byId("table-list").addEventListener("click", function (event) {
    var button = event.target.closest("[data-open-table]");
    if (!button) return;
    openTableWindow(button.getAttribute("data-open-table"), false);
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

  byId("action-panel").addEventListener("click", function (event) {
    var reactionButton = event.target.closest("[data-send-reaction]");
    if (!reactionButton || reactionButton.disabled || state.isAdmin) return;
    if (reactionTouchSuppressClickButton === reactionButton) {
      event.preventDefault();
      reactionTouchSuppressClickButton = null;
      return;
    }
    var view = state.tableView;
    var seat = view && viewerSeat(view);
    var viewer = view && view.viewer || {};
    var playerId = String(viewer.player_id || (state.player && state.player.id) || "");
    var seatNo = String(seat && seat.seat_no != null ? seat.seat_no : "");
    if (!view || reactionButton.getAttribute("data-reaction-table-id") !== String(state.activeTableId || "") ||
        reactionButton.getAttribute("data-reaction-player-id") !== playerId ||
        reactionButton.getAttribute("data-reaction-seat-no") !== seatNo) return;
    sendTableReaction(reactionButton.getAttribute("data-send-reaction"));
  });

  byId("seat-grid").addEventListener("click", function (event) {
    var avatarButton = event.target.closest(".avatar-photo-trigger");
    if (avatarButton) {
      event.preventDefault();
      event.stopPropagation();
      openAvatarViewer(avatarButton);
      return;
    }
    var seatAction = event.target.closest("[data-take-seat], [data-table-add-bot]");
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

  byId("avatar-view-dialog").addEventListener("click", function () {
    closeAvatarViewer(true);
  });
  byId("avatar-view-dialog").addEventListener("cancel", function (event) {
    event.preventDefault();
    closeAvatarViewer(true);
  });
  byId("avatar-view-close").addEventListener("click", function () {
    closeAvatarViewer(true);
  });

  byId("rebuy-offer-button").addEventListener("click", openRebuyOfferDialog);
  byId("rebuy-offer-accept").addEventListener("click", function () { submitRebuy(true); });
  byId("rebuy-offer-decline").addEventListener("click", function () { submitRebuy(false); });
  byId("rebuy-offer-close").addEventListener("click", function () {
    var dialog = byId("rebuy-offer-dialog");
    if (dialog.open) dialog.close();
  });
  byId("rebuy-offer-dialog").addEventListener("cancel", function (event) {
    event.preventDefault();
    byId("rebuy-offer-dialog").close();
  });
  byId("rebuy-offer-dialog").addEventListener("click", function (event) {
    if (isDialogBackdropClick(byId("rebuy-offer-dialog"), event)) byId("rebuy-offer-dialog").close();
  });

  byId("reaction-shortcuts").addEventListener("contextmenu", function (event) {
    var button = event.target.closest("[data-reaction-slot]");
    if (!button || state.isAdmin) return;
    event.preventDefault();
    openReactionSettingsDialog(number(button.getAttribute("data-reaction-slot"), -1), button);
  });
  byId("reaction-shortcuts").addEventListener("keydown", function (event) {
    if (!((event.key === "ContextMenu") || (event.shiftKey && event.key === "F10"))) return;
    var button = event.target.closest("[data-reaction-slot]");
    if (!button || state.isAdmin) return;
    event.preventDefault();
    openReactionSettingsDialog(number(button.getAttribute("data-reaction-slot"), -1), button);
  });
  byId("reaction-shortcuts").addEventListener("pointerdown", function (event) {
    var button = event.target.closest("[data-reaction-slot]");
    if (!button || event.pointerType !== "touch" || state.isAdmin) return;
    if (reactionTouchHoldTimer) window.clearTimeout(reactionTouchHoldTimer);
    reactionTouchHoldButton = button;
    reactionTouchHoldPointerId = event.pointerId;
    reactionTouchHoldStart = { x:event.clientX, y:event.clientY };
    reactionTouchHoldFired = false;
    reactionTouchHoldTimer = window.setTimeout(function () {
      if (reactionTouchHoldButton !== button) return;
      reactionTouchHoldFired = true;
      reactionTouchSuppressClickButton = button;
      window.setTimeout(function () {
        if (reactionTouchSuppressClickButton === button) reactionTouchSuppressClickButton = null;
      }, 1200);
      openReactionSettingsDialog(number(button.getAttribute("data-reaction-slot"), -1), button);
    }, 650);
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach(function (name) {
    byId("reaction-shortcuts").addEventListener(name, function (event) {
      if (!reactionTouchHoldButton || (reactionTouchHoldPointerId != null && event.pointerId !== reactionTouchHoldPointerId)) return;
      if (reactionTouchHoldTimer) window.clearTimeout(reactionTouchHoldTimer);
      reactionTouchHoldTimer = 0;
      reactionTouchHoldButton = null;
      reactionTouchHoldPointerId = null;
      reactionTouchHoldStart = null;
      reactionTouchHoldFired = false;
    });
  });
  byId("reaction-shortcuts").addEventListener("pointermove", function (event) {
    if (!reactionTouchHoldButton || reactionTouchHoldPointerId !== event.pointerId || !reactionTouchHoldStart) return;
    var dx = event.clientX - reactionTouchHoldStart.x;
    var dy = event.clientY - reactionTouchHoldStart.y;
    if (Math.hypot(dx, dy) > 12) {
      if (reactionTouchHoldTimer) window.clearTimeout(reactionTouchHoldTimer);
      reactionTouchHoldTimer = 0;
      reactionTouchHoldButton = null;
      reactionTouchHoldPointerId = null;
      reactionTouchHoldStart = null;
    }
  });

  byId("chat-button").addEventListener("click", function () {
    if (state.chat.open) closeChat(true);
    else showChat();
  });
  byId("chat-close-button").addEventListener("click", function () { closeChat(true); });
  byId("chat-input").addEventListener("input", function () {
    this.dataset.chatEditVersion = String(number(this.dataset.chatEditVersion, 0) + 1);
    setChatError("");
    updateChatCharacterCount();
  });
  byId("chat-input").addEventListener("keydown", function (event) {
    if (event.key !== "Enter" || event.isComposing || event.keyCode === 229 ||
        event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    if (state.chat.sending || state.chat.postInFlight) return;
    byId("chat-form").requestSubmit();
  });
  byId("chat-form").addEventListener("submit", function (event) {
    event.preventDefault();
    sendChatMessage(byId("chat-input"));
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

  byId("table-surface").addEventListener("wheel", function (event) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.deltaX !== 0 ||
        !Number.isFinite(event.deltaY) || event.deltaY === 0 ||
        event.target.closest("button, a, textarea, select, [contenteditable='true'], input:not(#raise-amount), .chat-panel, .table-settings")) return;
    var input = byId("raise-amount");
    var view = state.tableView;
    if (!input || input.disabled || !view || !viewerCanAct(view) || state.actionPending ||
        state.actionSubmittedKey === actionTokenKey(view)) return;
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

  var deferredInstallPrompt = null;

  function isStandaloneApp() {
    return Boolean((window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone);
  }

  function canShowManualInstall() {
    return /iPhone|iPad|iPod/i.test(window.navigator.userAgent || "") && !isStandaloneApp();
  }

  function syncInstallControls() {
    var available = !isStandaloneApp() && Boolean(deferredInstallPrompt || canShowManualInstall());
    ["install-app-button", "table-install-button"].forEach(function (id) {
      var button = byId(id);
      if (button) button.hidden = !available;
    });
  }

  function openInstallDialog() {
    var dialog = byId("install-dialog");
    var ios = canShowManualInstall();
    byId("install-copy").textContent = ios
      ? "In Safari, tap Share, then choose Add to Home Screen. The live table still needs a network connection."
      : "Add this room to your device for a focused table. Live games require a network connection.";
    byId("install-confirm").hidden = !deferredInstallPrompt;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  async function promptInstallApp() {
    if (!deferredInstallPrompt) {
      openInstallDialog();
      return;
    }
    var prompt = deferredInstallPrompt;
    deferredInstallPrompt = null;
    syncInstallControls();
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } catch (err) {}
    syncInstallControls();
  }

  ["install-app-button", "table-install-button"].forEach(function (id) {
    byId(id).addEventListener("click", promptInstallApp);
  });
  byId("install-close").addEventListener("click", function () {
    var dialog = byId("install-dialog");
    if (dialog.open) dialog.close();
  });
  byId("install-dialog").addEventListener("click", function (event) {
    if (isDialogBackdropClick(byId("install-dialog"), event)) byId("install-dialog").close();
  });
  byId("install-confirm").addEventListener("click", promptInstallApp);
  window.addEventListener("beforeinstallprompt", function (event) {
    event.preventDefault();
    deferredInstallPrompt = event;
    syncInstallControls();
  });
  window.addEventListener("appinstalled", function () {
    deferredInstallPrompt = null;
    syncInstallControls();
  });
  syncInstallControls();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/poker/service-worker.js", { scope: "/poker/" }).catch(function () {});

  function syncFullscreenButton() {
    var button = byId("fullscreen-button");
    var supported = Boolean(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
    button.hidden = !supported;
    button.textContent = document.fullscreenElement || document.webkitFullscreenElement ? "Exit full screen" : "Full screen";
  }
  byId("fullscreen-button").addEventListener("click", async function () {
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      } else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      else if (document.documentElement.webkitRequestFullscreen) document.documentElement.webkitRequestFullscreen();
    } catch (err) {
      showNotice("Full screen is unavailable in this browser.", "info", false);
    }
    syncFullscreenButton();
  });
  document.addEventListener("fullscreenchange", syncFullscreenButton);
  document.addEventListener("webkitfullscreenchange", syncFullscreenButton);
  syncFullscreenButton();

  state.openTableSetupOnLoad = initialRouteSetup;
  setHashTable(initialRouteTableId, initialRouteSetup);

  loadAuth();
  boot();
}());

