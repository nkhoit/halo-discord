/* Private-room signalling and the browser "Play online" experience.

   Gameplay never passes through the room service.  It only exchanges room
   membership and WebRTC descriptions/candidates, then Halo's normal system-
   link packets travel through HaloWebTransport's DataChannels. */

;(function installHaloOnline(global) {
  "use strict";

  if (!global || global.HaloOnline) return;

  var PROTOCOL_VERSION = 1;
  var ROOM_CAPACITY = 128;
  /* a relay room's machines with players (server/src/protocol.ts MAXIMUM_ROOM_PLAYERS) */
  var RELAY_ROOM_CAPACITY = 32;
  var MAX_PENDING_SIGNALING_MESSAGES = ROOM_CAPACITY * 128;
  var HEARTBEAT_MILLISECONDS = 40000;
  var GAME_POLL_MILLISECONDS = 200;
  var TURNSTILE_RENDER_ATTEMPTS = 80;
  var HOST_SETTINGS_STORAGE_KEY = "halo.web.host-settings.v1";
  var PLAYER_PROFILE_STORAGE_KEY = "halo.web.player-profile.v1";
  var PLAYER_NAME_MAXIMUM_LENGTH = 11;
  var LAST_MAP_INDEX = 12;
  var LAST_MODE_INDEX = 5;
  var PLAYER_STYLES = Object.freeze([
    "white", "black", "red", "blue", "sage", "yellow", "lime", "pink", "purple",
    "cyan", "cornflower", "orange", "teal", "forest", "brown", "tan", "maroon", "rose",
  ]);
  var PLAYER_STYLE_COLORS = Object.freeze({
    white: 0,
    black: 1,
    red: 2,
    blue: 3,
    sage: 4,
    yellow: 5,
    lime: 6,
    pink: 7,
    purple: 8,
    cyan: 9,
    cornflower: 10,
    orange: 11,
    teal: 12,
    forest: 13,
    brown: 14,
    tan: 15,
    maroon: 16,
    rose: 17,
  });

  var COMMAND = Object.freeze({ HOST: 1, JOIN: 2, CANCEL: 3 });
  var GAME_STATE = Object.freeze({
    IDLE: 0,
    WAITING: 1,
    HOST_STARTING: 2,
    HOSTING: 3,
    JOIN_SEARCHING: 4,
    JOIN_CONNECTING: 5,
    JOINED: 6,
    ERROR: 7,
  });
  var TRANSPORT_STATE = Object.freeze({
    DISCONNECTED: 0,
    CONNECTING: 1,
    CONNECTED: 2,
    FAILED: 3,
  });
  var GAME_ERRORS = Object.freeze({
    1: "Halo could not open the host lobby.",
    2: "Halo could not start its multiplayer client.",
    3: "Halo could not open the pregame lobby.",
    4: "The host rejected or ended the join.",
    5: "The host lobby did not answer within 90 seconds.",
  });

  var elements = {};
  var humanVerification = {
    action: null,
    busy: false,
    generation: 0,
    renderAttempts: 0,
    renderTimer: 0,
    state: "idle",
    token: null,
    widgetId: null,
  };
  var session = {
    runtimeReady: false,
    active: false,
    closing: false,
    role: null,
    room: null,
    roomTicket: null,
    inviteCode: null,
    inviteUrl: null,
    selfPeerId: null,
    iceServers: [],
    socket: null,
    socketGeneration: 0,
    operationGeneration: 0,
    heartbeatTimer: 0,
    reconnectTimer: 0,
    reconnectAttempts: 0,
    gamePollTimer: 0,
    gameCommandIssued: false,
    transportConnected: false,
    connectedPeerCount: 0,
    connectionPath: null,
    peerPromises: new Map(),
    peerIdentifiers: new Map(),
    peerStates: new Map(),
    peerAliases: new Map(),
    peerSignalTargets: new Map(),
    roster: new Map(),
    messageChain: Promise.resolve(),
    pendingInvite: null,
    profile: null,
    hostWasReady: false,
    hostSettings: null,
    guestWasJoined: false,
    inMatch: false,
    inPostgame: false,
    leavePromise: null,
    wizardStep: "map",
  };

  var RELAY_TOKEN_REFRESH_MILLISECONDS = 5 * 60 * 1000;
  var relayAuth = { token: null, user: null, expiresAt: 0, refreshTimer: 0 };

  function byId(id) {
    return document.getElementById(id);
  }

  function syncTelemetryContext() {
    if (!global.HaloTelemetry || typeof global.HaloTelemetry.setContext !== "function") return;
    global.HaloTelemetry.setContext({
      role: session.role === "host" ? "host" : (session.role === "guest" ? "guest" : "offline"),
      connection: session.connectionPath || "unknown",
    });
  }

  function telemetry(event, stage) {
    if (global.HaloTelemetry && typeof global.HaloTelemetry.event === "function") {
      global.HaloTelemetry.event(event, stage);
    }
  }

  function collectElements() {
    elements.button = byId("online");
    elements.dialog = byId("online-dialog");
    elements.close = byId("online-close");
    elements.status = byId("online-status");
    elements.description = byId("online-description");
    elements.setup = byId("online-setup");
    elements.hostForm = byId("online-host-form");
    elements.host = byId("online-host");
    elements.map = byId("online-map");
    elements.mode = byId("online-mode");
    elements.mapOptions = byId("online-map-options");
    elements.modeOptions = byId("online-mode-options");
    elements.joinForm = byId("online-join-form");
    elements.code = byId("online-code");
    elements.join = byId("online-join");
    elements.invite = byId("online-invite");
    elements.inviteLink = byId("invite-link");
    elements.copy = byId("invite-copy");
    elements.copyStatus = byId("invite-copy-status");
    elements.leaveHost = byId("online-leave-host");
    elements.progress = byId("online-progress");
    elements.cancel = byId("online-cancel");
    elements.detail = byId("online-detail");
    elements.wizard = byId("online-wizard");
    elements.wizardSteps = byId("online-wizard-steps");
    elements.wizardMap = byId("online-wizard-map");
    elements.wizardMode = byId("online-wizard-mode");
    elements.wizardLink = byId("online-wizard-link");
    elements.stepMap = byId("online-step-map");
    elements.stepMode = byId("online-step-mode");
    elements.stepLink = byId("online-step-link");
    elements.mapNext = byId("online-map-next");
    elements.modeBack = byId("online-mode-back");
    elements.profile = byId("online-profile");
    elements.playerName = byId("online-player-name");
    elements.styleOptions = byId("online-style-options");
    elements.profilePreview = byId("online-profile-preview");
    elements.profilePreviewName = byId("online-profile-preview-name");
    elements.spartanImage = byId("online-spartan-image");
    elements.joinConfirm = byId("online-join-confirm");
    elements.joinProfile = byId("online-join-profile");
    elements.joinSummary = byId("online-join-summary");
    elements.joinStatus = byId("online-join-status");
    elements.verification = byId("online-human-verification");
    elements.verificationStatus = byId("online-verification-status");
    elements.verificationRetry = byId("online-verification-retry");
    elements.turnstile = byId("online-turnstile");
    elements.playerSidebar = byId("player-sidebar");
    elements.playerList = byId("player-list");
    elements.playerCount = byId("player-count");
    elements.playerEmpty = byId("player-empty");
    elements.playerSidebarToggle = byId("player-sidebar-toggle");
  }

  function buildId() {
    var page = new URL(global.location.href);
    var meta = document.querySelector('meta[name="halo-build-id"]');
    var value = meta && meta.content;
    var pageIsLoopback = page.hostname === "127.0.0.1" || page.hostname === "localhost";
    /* A query override is useful while testing two local builds, but a public
       invite must not be able to opt an incompatible client into a room. */
    if (pageIsLoopback && page.searchParams.get("build")) {
      value = page.searchParams.get("build");
    }
    return value && /^[A-Za-z0-9._-]{1,96}$/.test(value) ? value : "development";
  }

  function apiBase() {
    var page = new URL(global.location.href);
    var query = page.searchParams.get("signal");
    var meta = document.querySelector('meta[name="halo-signaling-url"]');
    var pageIsLoopback = page.hostname === "127.0.0.1" || page.hostname === "localhost";
    if (query) {
      var override = new URL(query, global.location.href);
      var overrideIsLoopback = override.hostname === "127.0.0.1" ||
        override.hostname === "localhost";
      if (!pageIsLoopback || !overrideIsLoopback) {
        throw new Error("Custom room services are allowed only for loopback development.");
      }
    }
    var configured = query || (meta && meta.content);
    if (configured) {
      var parsed = new URL(configured, global.location.href);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("The room service URL must use HTTP or HTTPS.");
      }
      return parsed.href.replace(/\/$/, "");
    }
    if ((page.hostname === "127.0.0.1" || page.hostname === "localhost") &&
        page.port !== "8787") {
      return page.protocol + "//" + page.hostname + ":8787";
    }
    return page.origin;
  }

  function turnstileSiteKey() {
    var meta = document.querySelector('meta[name="halo-turnstile-sitekey"]');
    var value = meta && meta.content;
    return value && /^0x[A-Za-z0-9_-]{20,120}$/.test(value) ? value : null;
  }

  /* Relay mode sends gameplay through the self-hosted WebSocket relay
     (server/) instead of WebRTC; the relay also owns room membership, so the
     signaling service is not used. Hosted pages opt in with
     <meta name="halo-transport" content="relay-rooms">; loopback pages may
     opt in with ?transport=relay (?relay= overrides the relay URL and
     ?relaySockets=2 splits reliable and unreliable traffic). On any relay
     page, ?relayBatch=0 sends every frame as its own message, for
     measurement. Login is a session cookie on the relay's origin, which must
     be the page's origin. */
  function relaySettings() {
    var page = new URL(global.location.href);
    var pageIsLoopback = page.hostname === "127.0.0.1" || page.hostname === "localhost";
    var mode = document.querySelector('meta[name="halo-transport"]');
    var hosted = !!(mode && mode.content === "relay-rooms");
    if (!hosted && !(pageIsLoopback && page.searchParams.get("transport") === "relay")) return null;
    var meta = document.querySelector('meta[name="halo-relay-url"]');
    var configured = (pageIsLoopback && page.searchParams.get("relay")) ||
      (meta && meta.content) || new URL(".", page.href).href;
    var parsed = new URL(configured, global.location.href);
    if (["http:", "https:", "ws:", "wss:"].indexOf(parsed.protocol) < 0) {
      throw new Error("The WebSocket relay URL must use HTTP(S) or WS(S).");
    }
    return {
      url: parsed.href.replace(/\/$/, ""),
      sockets: pageIsLoopback && page.searchParams.get("relaySockets") === "2" ? 2 : 1,
      batch: page.searchParams.get("relayBatch") !== "0",
    };
  }

  function relayEndpoint(path) {
    var relay = relaySettings();
    if (!relay) throw new Error("This invite needs the Halo relay; open it on the hosted page.");
    var url = new URL(path, relay.url + "/");
    if (url.protocol === "wss:") url.protocol = "https:";
    else if (url.protocol === "ws:") url.protocol = "http:";
    return url.href;
  }

  /* The relay token travels only in the WebSocket's first message, never in a
     URL. It is renewed from the HttpOnly session cookie, which also
     authorizes map downloads. Without a session, log in with Discord and
     come back to the same room. */
  async function relaySession(returnHash, retried) {
    if (relayAuth.token && relayAuth.expiresAt - Date.now() > RELAY_TOKEN_REFRESH_MILLISECONDS) {
      return relayAuth;
    }
    var response;
    try {
      response = await fetch(relayEndpoint("auth/session"), { credentials: "include", cache: "no-store" });
    } catch (error) {
      throw new Error("The Halo relay is unreachable.");
    }
    if (response.status === 401 && activity()) {
      if (retried) throw new Error("Discord sign-in failed. Relaunch the Activity.");
      await activity().signIn();
      return relaySession(returnHash, true);
    }
    if (response.status === 401) {
      var back = new URL(global.location.href);
      back.hash = returnHash || "";
      global.location.assign(relayEndpoint("auth/login") + "?return=" +
        encodeURIComponent(back.pathname + back.search + back.hash));
      var redirecting = new Error("Signing in with Discord…");
      redirecting.haloCanceled = true;
      throw redirecting;
    }
    if (!response.ok) throw new Error("The Halo relay refused the session.");
    var body = await response.json();
    if (!body || typeof body.token !== "string" || typeof body.expiresAt !== "number") {
      throw new Error("The Halo relay returned an invalid session.");
    }
    relayAuth.token = body.token;
    relayAuth.user = body.user || null;
    relayAuth.expiresAt = body.expiresAt * 1000;
    return relayAuth;
  }

  function scheduleRelayRefresh() {
    if (relayAuth.refreshTimer) global.clearTimeout(relayAuth.refreshTimer);
    var delay = Math.max(60000, relayAuth.expiresAt - Date.now() - RELAY_TOKEN_REFRESH_MILLISECONDS + 1000);
    relayAuth.refreshTimer = global.setTimeout(function() {
      relayAuth.refreshTimer = 0;
      if (!session.active || !relaySettings()) return;
      relaySession(session.room ? "room=" + session.room.id : "")
        .then(scheduleRelayRefresh)
        .catch(function() { if (session.active) scheduleRelayRefresh(); });
    }, delay);
  }

  function randomRoomId() {
    var bytes = new Uint8Array(16);
    global.crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode.apply(null, bytes))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function startRelayRoom(roomId, operation) {
    await relaySession("room=" + roomId);
    requireCurrentOperation(operation);
    session.room = { id: roomId };
    session.selfPeerId = "relay-" + localIdentifier();
    updateLocalRoster();
    configureTransport([]);
    transport().openRelay();
    scheduleRelayRefresh();
  }

  function registerRelayPeer(peer) {
    if (!session.active || session.closing || !peer || peer.role === session.role) return;
    session.peerPromises.set(peer.peerId, Promise.resolve(null));
    session.peerIdentifiers.set(peer.peerId, peer.identifier);
    session.peerAliases.set(peer.peerId, peer.peerId);
    session.roster.set(peer.peerId, {
      peerId: peer.peerId,
      role: peer.role,
      profile: { name: peer.name || (peer.role === "host" ? "Host" : "Friend"), style: "sage" },
    });
    renderRoster();
  }

  /* Discord Activity: activity.js signs in through the Discord SDK and sets
     HaloActivity before the game loads. */
  function activity() {
    var value = global.HaloActivity;
    return value && typeof value.roomId === "string" ? value : null;
  }

  /* The hosted page (this server's, in a browser or as the Discord
     Activity): its own UI (server/client/hosted.js) replaces the shell's
     dialogs and reads status(). The room is the Activity instance's or, in a
     browser, the page address's #room= (made up when missing, so the address
     is the link to share). The lobby polls the room: nobody hosting offers
     hosting; a host in its lobby is joined at once, under the Discord name;
     a host in a match is waited for (Halo cannot join a match in progress). */
  var LOBBY_POLL_MILLISECONDS = 2000;
  var JOIN_RETRY_MILLISECONDS = 10000;
  var NOTICE_MILLISECONDS = 15000;
  var CLIENT_STATE = Object.freeze({ PREGAME: 2, INGAME: 3, POSTGAME: 4 });
  /* web_online_ui.h's game modes: team slayer and capture the flag have teams.
     The engine's variant is authoritative once it has arrived; until then the
     host's own choice is enough to show the picker. */
  var TEAM_MODE = { 1: true, 2: true };
  var hostedLobby = { timer: 0, view: null, summary: null, roomId: null, retryAt: 0, notice: null, noticeAt: 0,
    joiningMatch: false, pendingJoin: false, spectateNext: false };
  /* last consistent copy of the engine roster (a read that crosses a publish
     keeps this instead of flashing an empty board) */
  var engineRosterCache = null;
  /* (a guest) it watches the match without a player of its own (#52): the
     game's word (web_online_ui.c), which the room's relay is told too */
  var spectating = { page: false };

  function callModule(name) {
    var fn = global.Module && global.Module[name];
    if (typeof fn !== "function") return undefined;
    try {
      return fn.apply(null, Array.prototype.slice.call(arguments, 1));
    } catch (error) {
      return undefined;
    }
  }

  /* (before joining) whether to watch the match: a running match is watched
     by default, a lobby is joined to play */
  function setSpectating(spectate) {
    spectating.page = !!spectate;
    callModule("_platform_web_online_set_spectate", spectate ? 1 : 0);
  }

  function gameSpectating() {
    return session.active && session.role === "guest" && callModule("_platform_web_online_spectating") === 1;
  }

  /* the watched player's name, for the page's label */
  function spectatedName() {
    var characters = [];
    for (var index = 0; index < 12; index++) {
      var character = callModule("_platform_web_spectate_target_name", index);
      if (!character) break;
      characters.push(character);
    }
    return characters.length ? String.fromCharCode.apply(null, characters) : null;
  }

  /* (a spectator) add its player to the match, as a late joiner's is (or to
     the lobby's next match): from then on it plays as everyone does */
  function spectatorJoin() {
    if (!session.active || session.role !== "guest" || !spectating.page) return false;
    spectating.page = false;
    callModule("_platform_web_online_set_spectate", 0);
    if (global.HaloWebTransport && typeof global.HaloWebTransport.setRelaySpectating === "function") {
      global.HaloWebTransport.setRelaySpectating(false);
    }
    return true;
  }

  /* (a spectator) watch the next (+1) or previous (-1) player */
  function spectateCycle(direction) {
    if (!gameSpectating()) return false;
    callModule("_platform_web_spectate_cycle", direction < 0 ? -1 : 1);
    return true;
  }

  function hostedPage() {
    var mode = typeof document.querySelector === "function" &&
      document.querySelector('meta[name="halo-transport"]');
    return !!(mode && mode.content === "relay-rooms");
  }

  function pageRoomId() {
    if (activity()) return activity().roomId;
    if (!hostedPage()) return null;
    var fragment = new URLSearchParams(String(global.location.hash || "").replace(/^#/, ""));
    var id = fragment.get("room");
    if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
      id = randomRoomId();
      fragment.set("room", id);
      global.history.replaceState(null, "", "#" + fragment.toString());
    }
    return id;
  }

  function setNotice(message) {
    hostedLobby.notice = message || null;
    hostedLobby.noticeAt = Date.now();
  }

  function stopHostedLobby() {
    if (hostedLobby.timer) global.clearTimeout(hostedLobby.timer);
    hostedLobby.timer = 0;
  }

  function startHostedLobby(delay) {
    if (!hostedPage() || session.active || hostedLobby.timer || !session.runtimeReady ||
        hostedLobby.pendingJoin) return;
    hostedLobby.roomId = pageRoomId();
    hostedLobby.timer = global.setTimeout(pollHostedLobby, delay || 0);
  }

  function discordUser() {
    return activity() ? activity().user : (global.HaloHostedUser || relayAuth.user);
  }

  /* Halo stores eleven basic characters. The same cleaning the profile uses,
     so a lobby name can be matched back to the engine's player. */
  function haloLegalName(value) {
    var name = String(value || "").replace(/[^A-Za-z0-9 ._'-]/g, "").replace(/\s+/g, " ").trim()
      .slice(0, PLAYER_NAME_MAXIMUM_LENGTH).trim();
    return /^[A-Za-z0-9]/.test(name) ? name : "";
  }

  /* The Discord display name, when it fits Halo's rules (eleven basic
     characters). */
  function discordPlayerName() {
    return haloLegalName(discordUser() && discordUser().name) || null;
  }

  /* The name to show in the lobby: the Discord display name, not only the
     eleven characters Halo keeps. */
  function discordDisplayName() {
    var name = String(discordUser() && discordUser().name || "").replace(/[\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim();
    return name ? name.slice(0, 32) : null;
  }

  async function pollHostedLobby() {
    hostedLobby.timer = 0;
    if (!hostedPage() || session.active) return;
    var summary = null;
    try {
      var response = await fetch(relayEndpoint("v1/rooms/" + hostedLobby.roomId),
        { credentials: "include", cache: "no-store" });
      if (response.status === 401) {
        if (activity()) await activity().signIn();
        else await relaySession("room=" + hostedLobby.roomId);
      } else if (response.ok) {
        summary = await response.json();
      }
    } catch (error) {
      /* Try again on the next poll. */
    }
    if (session.active) return;
    if (summary) showHostedLobby(summary);
    hostedLobby.timer = global.setTimeout(pollHostedLobby, LOBBY_POLL_MILLISECONDS);
  }

  function showHostedLobby(summary) {
    hostedLobby.summary = summary;
    if (!summary.host) {
      hostedLobby.view = "pick";
    } else if (summary.inMatch && !summary.joinable && !summary.watchable) {
      hostedLobby.view = "wait-match";
    } else if (Date.now() < hostedLobby.retryAt) {
      hostedLobby.view = "wait-retry";
    } else {
      /* (if this join fails, the next waits a while) */
      hostedLobby.view = summary.inMatch ? "joining-match" : "joining";
      hostedLobby.joiningMatch = !!summary.inMatch;
      hostedLobby.retryAt = Date.now() + JOIN_RETRY_MILLISECONDS;
      /* (a running match is watched first: Join adds the player) */
      hostedLobby.spectateNext = !!summary.inMatch;
      join("room:" + hostedLobby.roomId);
    }
  }

  /* (Discord Activity) the matches hosted from this Discord server's other
     voice channels (the server's GET /v1/guild-rooms), for the lobby's list */
  async function guildRooms() {
    if (!activity() || !hostedPage()) return [];
    try {
      var response = await fetch(relayEndpoint("v1/guild-rooms?build=" + encodeURIComponent(buildId())),
        { credentials: "include", cache: "no-store" });
      if (!response.ok) return [];
      var body = await response.json();
      return body && Array.isArray(body.rooms) ? body.rooms : [];
    } catch (error) {
      return [];
    }
  }

  /* (Discord Activity, nobody hosting here) joins a room from that list: its
     lobby, or its match as it runs. Leaving it, or its host leaving, brings
     the player back to this channel's lobby. */
  function joinGuildRoom(room) {
    if (!activity() || !hostedPage() || session.active || !session.runtimeReady || !room ||
        !/^[A-Za-z0-9_-]{16,64}$/.test(String(room.roomId)) || room.roomId === pageRoomId()) return false;
    stopHostedLobby();
    hostedLobby.roomId = room.roomId;
    hostedLobby.joiningMatch = room.state === "match";
    hostedLobby.summary = { host: typeof room.host === "string" ? room.host : null, players: room.players || 0,
      inMatch: hostedLobby.joiningMatch, joinable: !!room.joinable, watchable: !!room.watchable };
    hostedLobby.view = hostedLobby.joiningMatch ? "joining-match" : "joining";
    /* (join() leaves first, which would restart this channel's lobby) */
    hostedLobby.pendingJoin = true;
    hostedLobby.spectateNext = hostedLobby.joiningMatch;
    join("room:" + room.roomId);
    return true;
  }

  /* (the host) what its room's server-wide listing shows */
  function hostListingDetails(clientState, phase) {
    var settings = session.hostSettings || readHostSettings();
    var details = {
      state: clientState === CLIENT_STATE.INGAME ? "match" : clientState === CLIENT_STATE.POSTGAME ? "postgame" :
        phase.inMatch ? "starting" : "lobby",
      map: settings.mapIndex,
      mode: settings.modeIndex,
      watchable: !!phase.watchable,
    };
    var channel = activity() && typeof activity().channelName === "function" ? activity().channelName() : null;
    if (typeof channel === "string" && channel) details.channel = channel.slice(0, 64);
    return details;
  }

  /* (the host, in its lobby) the next match's map and game type, applied to
     the lobby everyone is in (web_online_ui.c platform_web_online_configure) */
  function configureNextMatch(value) {
    if (!session.active || session.role !== "host") return false;
    var settings = normalizeHostSettings(value);
    var configure = global.Module && global.Module._platform_web_online_configure;
    if (typeof configure !== "function" || !configure(settings.mapIndex, settings.modeIndex)) return false;
    session.hostSettings = settings;
    saveHostSettings(settings);
    return true;
  }

  /* (the host, in its lobby) starts the match */
  function startMatch() {
    var start = global.Module && global.Module._platform_web_online_start_match;
    if (!session.active || session.role !== "host" || typeof start !== "function") return false;
    return !!start();
  }

  /* (the host, in a match) ends it the way a score or time limit does:
     results, then the lobby. The room stays up. Guests have no control. */
  function endMatch() {
    var end = global.Module && global.Module._platform_web_online_end_match;
    if (!session.active || session.role !== "host" || typeof end !== "function") return false;
    return !!end();
  }

  function clientGameState() {
    var get = global.Module && global.Module._platform_web_online_get_client_state;
    try {
      return typeof get === "function" ? get() : -1;
    } catch (error) {
      return -1;
    }
  }

  /* (hosting through the relay) players may join the match while it runs
     (network.join_in_progress) */
  function setJoinInProgress(enabled) {
    var set = global.Module && global.Module._platform_web_online_set_join_in_progress;
    if (typeof set === "function") set(enabled ? 1 : 0);
  }

  /* (the host) its match as the room's status has it: past the lobby (the
     match loading or running), and whether a player can join it now */
  function hostMatchPhase(clientState) {
    var call = function(name) {
      var fn = global.Module && global.Module[name];
      try { return typeof fn === "function" ? !!fn() : false; } catch (error) { return false; }
    };
    var joinable = clientState === CLIENT_STATE.INGAME && call("_platform_web_online_match_joinable");
    return {
      inMatch: clientState === CLIENT_STATE.INGAME || call("_platform_web_online_match_starting"),
      joinable: joinable,
      watchable: clientState === CLIENT_STATE.INGAME && call("_platform_web_online_match_watchable"),
    };
  }

  /* The engine's players and teams (published each frame on the game thread).
     null when this build has no roster export. A read that crosses a publish
     keeps the previous snapshot. */
  function readEngineRoster() {
    var sequenceFn = global.Module && global.Module._platform_web_online_roster_sequence;
    if (typeof sequenceFn !== "function") return null;
    var sequence = sequenceFn();
    if (sequence & 1) return engineRosterCache;
    var count = callModule("_platform_web_online_roster_count");
    if (typeof count !== "number" || count < 0) return engineRosterCache;
    if (count > 32) count = 32;
    var players = [];
    var index;
    for (index = 0; index < count; index++) {
      var name = "";
      var unit;
      for (unit = 0; unit < 12; unit++) {
        var code = callModule("_platform_web_online_roster_name", index, unit);
        if (!code) break;
        name += String.fromCharCode(code);
      }
      players.push({
        name: name,
        team: callModule("_platform_web_online_roster_team", index),
        local: callModule("_platform_web_online_roster_local", index) === 1,
      });
    }
    var teams = callModule("_platform_web_online_roster_teams") === 1;
    if (sequenceFn() !== sequence) return engineRosterCache;
    engineRosterCache = { teams: teams, players: players };
    return engineRosterCache;
  }

  /* Discord display name for an engine player, when the Halo name is that
     display name trimmed to eleven characters. */
  function teamDisplayName(player) {
    var display = discordDisplayName();
    var found = null;
    if (player.local && display && haloLegalName(display) === player.name) return display;
    session.roster.forEach(function(entry) {
      if (found) return;
      var profileName = entry.profile && entry.profile.name;
      if (!profileName) return;
      if (profileName === player.name || haloLegalName(profileName) === player.name) found = profileName;
    });
    return found || player.name || "Player";
  }

  /* Red/blue for the lobby and mid-match Esc overlay (#16). Names are
     Discord display names. canSwitch is true in a running team match when
     this machine has a player (not spectating). allowed[team] is the
     balance gate (refuse a strictly larger team). */
  function lobbyTeams() {
    var engine = readEngineRoster();
    var hostMode = session.role === "host" && session.hostSettings ? session.hostSettings.modeIndex : -1;
    var state = clientGameState();
    var players = [];
    var allowed = { 0: false, 1: false };
    var canSwitch = false;
    var allowFn = global.Module && global.Module._platform_web_online_team_switch_allowed;
    if (engine && engine.players) {
      engine.players.forEach(function(player) {
        players.push({
          name: teamDisplayName(player),
          team: player.team === 0 || player.team === 1 ? player.team : -1,
          self: !!player.local,
        });
      });
    }
    if (state === CLIENT_STATE.INGAME && engine && engine.teams && typeof allowFn === "function") {
      canSwitch = true;
      try {
        allowed[0] = !!allowFn(0);
        allowed[1] = !!allowFn(1);
      } catch (error) { canSwitch = false; }
    }
    return {
      enabled: !!(engine && engine.teams) || !!TEAM_MODE[hostMode],
      pregame: state === CLIENT_STATE.PREGAME,
      canSwitch: canSwitch,
      allowed: allowed,
      players: players,
    };
  }

  /* Pregame uses set_team; mid-match uses switch_team (host-authoritative). */
  function setTeam(teamIndex) {
    if (!session.active || (teamIndex !== 0 && teamIndex !== 1) || !global.Module) return false;
    var state = clientGameState();
    var set = state === CLIENT_STATE.INGAME ?
      global.Module._platform_web_online_switch_team :
      global.Module._platform_web_online_set_team;
    if (typeof set !== "function") return false;
    try {
      return !!set(teamIndex);
    } catch (error) {
      return false;
    }
  }

  /* What the hosted page's UI shows. view: "booting", "checking" (the room
     not yet polled), "pick" (nobody hosts: choose and host), "joining",
     "joining-match" (joining the host's match as it runs), "wait-match"
     (the host's match is loading, over or full), "wait-retry" (a join
     failed), "host-starting", "hosting" (the host's Halo lobby), "joined" (a
     guest in the host's lobby), "match", "spectating" (a guest watching the
     match without a player, #52) or "postgame" (a match's results, until the
     host goes back to the lobby). */
  function hostedStatus() {
    var state = -1;
    try { state = session.runtimeReady ? gameState() : -1; } catch (error) { /* starting */ }
    var view;
    if (!session.runtimeReady) view = "booting";
    else if (session.active && session.role === "host") {
      view = state === GAME_STATE.HOSTING ?
        (session.inMatch ? "match" : session.inPostgame ? "postgame" : "hosting") : "host-starting";
    } else if (session.active) {
      view = state === GAME_STATE.JOINED ?
        (session.inMatch ? (gameSpectating() ? "spectating" : "match") : session.inPostgame ? "postgame" : "joined") :
        (hostedLobby.joiningMatch ? "joining-match" : "joining");
    } else view = hostedLobby.view || "checking";
    if (hostedLobby.notice && Date.now() - hostedLobby.noticeAt > NOTICE_MILLISECONDS) hostedLobby.notice = null;
    var summary = hostedLobby.summary || {};
    var players = Array.from(session.roster.values()).map(function(player) {
      return player && player.profile ? player.profile.name : null;
    }).filter(Boolean);
    return {
      view: view,
      role: session.role,
      roomId: hostedLobby.roomId,
      host: session.role === "host" ? (discordPlayerName() || "You") : (summary.host || null),
      players: session.active ? players : [],
      playerCount: session.active ? players.length : (summary.players || 0),
      notice: hostedLobby.notice,
      settings: session.hostSettings || readHostSettings(),
      shareUrl: activity() || !hostedPage() ? null : global.location.href,
      spectating: gameSpectating(),
      /* (Join pressed: the game adds the player in a moment) */
      spectatorJoining: gameSpectating() && !spectating.page,
      spectated: gameSpectating() ? spectatedName() : null,
      spectators: session.active ? 0 : (summary.spectators || 0),
      teams: lobbyTeams(),
    };
  }

  function clearTurnstileTimer() {
    if (humanVerification.renderTimer) global.clearTimeout(humanVerification.renderTimer);
    humanVerification.renderTimer = 0;
  }

  function turnstileReady(action) {
    return !turnstileSiteKey() ||
      (humanVerification.action === action && !!humanVerification.token);
  }

  function syncVerificationButtons() {
    if (elements.host) {
      elements.host.disabled = humanVerification.busy || !session.runtimeReady ||
        !turnstileReady("create_room");
    }
    if (elements.joinProfile) {
      elements.joinProfile.disabled = humanVerification.busy || !session.runtimeReady ||
        !turnstileReady("join_room");
    }
  }

  function setVerificationState(state, message) {
    humanVerification.state = state;
    if (elements.verification) {
      elements.verification.hidden = !turnstileSiteKey();
      elements.verification.dataset.state = state;
    }
    if (elements.verificationStatus) {
      elements.verificationStatus.textContent = message || "";
      elements.verificationStatus.hidden = !message;
    }
    if (elements.verificationRetry) {
      elements.verificationRetry.hidden = state !== "error";
    }
    syncVerificationButtons();
  }

  function resetTurnstile() {
    humanVerification.token = null;
    if (turnstileSiteKey()) {
      setVerificationState("loading", "Checking that you're human…");
    }
    if (global.turnstile && humanVerification.widgetId !== null) {
      try { global.turnstile.reset(humanVerification.widgetId); } catch (error) { /* not rendered */ }
    }
  }

  function renderTurnstile(action, force) {
    var sitekey = turnstileSiteKey();
    if (!sitekey || !elements.turnstile) {
      setVerificationState("ready", "");
      return;
    }
    if (!force && humanVerification.action === action &&
        humanVerification.widgetId !== null) return;
    clearTurnstileTimer();
    var changedAction = humanVerification.action !== action;
    humanVerification.action = action;
    humanVerification.token = null;
    if (changedAction || force) {
      humanVerification.generation++;
      humanVerification.renderAttempts = 0;
      setVerificationState("loading", "Checking that you're human…");
    }
    if (!global.turnstile || typeof global.turnstile.render !== "function") {
      humanVerification.renderAttempts++;
      if (humanVerification.renderAttempts >= TURNSTILE_RENDER_ATTEMPTS) {
        setVerificationState(
          "error",
          "Human verification is taking longer than expected. Try it again.");
        return;
      }
      humanVerification.renderTimer = global.setTimeout(function() {
        renderTurnstile(action);
      }, 150);
      return;
    }
    if (humanVerification.widgetId !== null) {
      try { global.turnstile.remove(humanVerification.widgetId); } catch (error) { /* stale widget */ }
      humanVerification.widgetId = null;
    }
    elements.turnstile.replaceChildren();
    var generation = humanVerification.generation;
    try {
      humanVerification.widgetId = global.turnstile.render(elements.turnstile, {
        action: action,
        appearance: "interaction-only",
        callback: function(token) {
          if (generation !== humanVerification.generation || humanVerification.action !== action) return;
          humanVerification.token = token;
          setVerificationState(
            "ready",
            action === "join_room" ? "Verified — ready to join." : "Verified — ready to create your link.");
          setStatus("");
        },
        "error-callback": function() {
          if (generation !== humanVerification.generation) return;
          humanVerification.token = null;
          setVerificationState(
            "error",
            "We couldn't verify you this time. Check your connection and try again.");
        },
        "expired-callback": function() {
          if (generation !== humanVerification.generation) return;
          humanVerification.token = null;
          setVerificationState("loading", "Verification expired — checking again…");
          try {
            global.turnstile.reset(humanVerification.widgetId);
          } catch (error) {
            setVerificationState("error", "Verification expired. Try it again.");
          }
        },
        "timeout-callback": function() {
          if (generation !== humanVerification.generation) return;
          humanVerification.token = null;
          setVerificationState("error", "Human verification timed out. Try it again.");
        },
        sitekey: sitekey,
        size: "flexible",
        theme: "dark",
      });
    } catch (error) {
      humanVerification.widgetId = null;
      setVerificationState("error", "Human verification could not start. Try it again.");
    }
  }

  function consumeTurnstile(action) {
    if (!turnstileSiteKey()) return null;
    if (humanVerification.action !== action || !humanVerification.token) {
      renderTurnstile(action);
      throw new Error(humanVerification.state === "error" ?
        "Use Try again to restart human verification." :
        "One moment — human verification is still finishing.");
    }
    var token = humanVerification.token;
    humanVerification.token = null;
    return token;
  }

  function showDialog() {
    /* (the hosted page has its own UI; a modal would make it inert) */
    if (hostedPage()) return;
    if (!elements.dialog.open) elements.dialog.showModal();
  }

  /* SDL listens for keyboard events on window so the game keeps receiving
     input when its canvas has focus. Keyboard events from modal and sidebar
     controls bubble there too unless their surfaces contain them. Do not
     prevent the default: text editing, control activation, and Escape's
     native dialog behavior must keep working. */
  function containDialogKeyboardEvent(event) {
    event.stopPropagation();
  }

  function setHeader(text, state) {
    elements.button.textContent = text;
    elements.button.dataset.state = state || "offline";
  }

  function setStatus(text, tone) {
    var message = String(text || "").trim();
    elements.status.textContent = message;
    elements.status.hidden = !message;
    if (tone) elements.status.dataset.tone = tone;
    else delete elements.status.dataset.tone;
    if (elements.joinStatus) {
      var joinView = elements.dialog && elements.dialog.dataset.view === "join";
      elements.joinStatus.textContent = message;
      elements.joinStatus.hidden = !message || !joinView;
      if (tone) elements.joinStatus.dataset.tone = tone;
      else delete elements.joinStatus.dataset.tone;
    }
  }

  function setBusy(busy) {
    humanVerification.busy = !!busy;
    elements.map.disabled = !!busy;
    elements.mode.disabled = !!busy;
    setPickerLocked(elements.mapOptions, "halo-map-choice", !!busy);
    setPickerLocked(elements.modeOptions, "halo-mode-choice", !!busy);
    elements.join.disabled = !!busy || !session.runtimeReady;
    elements.code.disabled = !!busy;
    if (elements.mapNext) elements.mapNext.disabled = !!busy;
    if (elements.modeBack) elements.modeBack.disabled = !!busy;
    syncVerificationButtons();
    setProfileLocked(!!busy || session.active);
  }

  function pickerInputs(container, name) {
    if (!container || typeof container.querySelectorAll !== "function") return [];
    return Array.prototype.slice.call(
      container.querySelectorAll('input[name="' + name + '"]'));
  }

  function setPickerLocked(container, name, locked) {
    pickerInputs(container, name).forEach(function(input) {
      input.disabled = !!locked;
    });
  }

  function syncPickerCards(container, name, select) {
    if (!select) return;
    pickerInputs(container, name).forEach(function(input) {
      var selected = input.value === select.value;
      input.checked = selected;
      input.setAttribute("aria-checked", selected ? "true" : "false");
      if (typeof input.closest === "function") {
        var card = input.closest("[data-picker-option], label");
        if (card && card.dataset) card.dataset.selected = selected ? "true" : "false";
      }
    });
  }

  function syncHostPickerCards() {
    syncPickerCards(elements.mapOptions, "halo-map-choice", elements.map);
    syncPickerCards(elements.modeOptions, "halo-mode-choice", elements.mode);
  }

  function attachPickerEvents(container, name, select) {
    if (!container || !select) return;
    container.addEventListener("change", function(event) {
      var input = event.target;
      if (!input || input.name !== name || input.disabled) return;
      select.value = input.value;
      syncPickerCards(container, name, select);
    });
    select.addEventListener("change", function() {
      syncPickerCards(container, name, select);
    });
  }

  function profileStyleInputs() {
    if (!elements.styleOptions || typeof elements.styleOptions.querySelectorAll !== "function") {
      return [];
    }
    return Array.prototype.slice.call(
      elements.styleOptions.querySelectorAll('input[name="player-style"]'));
  }

  function setProfileLocked(locked) {
    if (elements.playerName) elements.playerName.disabled = !!locked;
    profileStyleInputs().forEach(function(input) { input.disabled = !!locked; });
  }

  function generatedPlayerName() {
    var value = Math.floor(Math.random() * 900) + 100;
    try {
      if (global.crypto && typeof global.crypto.getRandomValues === "function") {
        var random = new Uint16Array(1);
        global.crypto.getRandomValues(random);
        value = 100 + (random[0] % 900);
      }
    } catch (error) {
      /* A friendly fallback does not require cryptographic randomness. */
    }
    return "Spartan " + value;
  }

  function normalizePlayerProfile(value) {
    var source = value || {};
    var name = String(source.name || "").replace(/\s+/g, " ").trim();
    var style = String(source.style || "sage").toLowerCase();
    if (name.length < 1 || name.length > PLAYER_NAME_MAXIMUM_LENGTH ||
        !/^[A-Za-z0-9][A-Za-z0-9 ._'-]*$/.test(name)) {
      throw new Error("Use 1–11 basic letters or numbers for your player name.");
    }
    if (PLAYER_STYLES.indexOf(style) < 0) {
      throw new Error("Choose a valid player style.");
    }
    return { name: name, style: style };
  }

  function selectedPlayerStyle() {
    var inputs = profileStyleInputs();
    var selected = inputs.find(function(input) { return input.checked; });
    return selected ? selected.value : "sage";
  }

  function renderPlayerProfilePreview(profile) {
    if (elements.profilePreview) elements.profilePreview.dataset.style = profile.style;
    if (elements.profilePreviewName) elements.profilePreviewName.textContent = profile.name;
    if (elements.spartanImage) {
      if (elements.spartanImage.dataset.style !== profile.style) {
        elements.spartanImage.src = "assets/ui/spartan/" + profile.style + ".png";
        elements.spartanImage.dataset.style = profile.style;
      }
      elements.spartanImage.alt = profile.name + " in " + profile.style + " armor";
    }
  }

  function writePlayerProfile(profile) {
    if (elements.playerName) elements.playerName.value = profile.name;
    profileStyleInputs().forEach(function(input) {
      input.checked = input.value === profile.style;
    });
    renderPlayerProfilePreview(profile);
  }

  function readPlayerProfile() {
    return normalizePlayerProfile({
      name: (hostedPage() && discordPlayerName()) || (elements.playerName ? elements.playerName.value :
        (session.profile && session.profile.name)),
      style: selectedPlayerStyle(),
    });
  }

  function savePlayerProfile(profile) {
    session.profile = profile;
    writePlayerProfile(profile);
    try {
      global.localStorage.setItem(PLAYER_PROFILE_STORAGE_KEY, JSON.stringify(profile));
    } catch (error) {
      /* A blocked store should never prevent joining a game. */
    }
    updateLocalRoster();
  }

  function restorePlayerProfile() {
    var profile = { name: generatedPlayerName(), style: "sage" };
    try {
      var saved = JSON.parse(global.localStorage.getItem(PLAYER_PROFILE_STORAGE_KEY));
      profile = normalizePlayerProfile(saved);
    } catch (error) {
      /* First-time and stale profiles get a friendly, editable default. */
    }
    savePlayerProfile(profile);
  }

  function applyPlayerCustomization(profile) {
    var fn = global.Module && global.Module._platform_web_online_set_player_customization;
    if (typeof fn !== "function") return;
    var args = [PLAYER_STYLE_COLORS[profile.style]];
    for (var index = 0; index < PLAYER_NAME_MAXIMUM_LENGTH; index++) {
      args.push(index < profile.name.length ? profile.name.charCodeAt(index) : 0);
    }
    if (!fn.apply(null, args)) {
      throw new Error("Halo could not apply your player customization.");
    }
  }

  function setWizardStep(step) {
    session.wizardStep = step;
    if (elements.wizard) elements.wizard.dataset.step = step;
    if (elements.stepMap) elements.stepMap.hidden = step !== "map";
    if (elements.stepMode) elements.stepMode.hidden = step !== "mode";
    /* The invite lives in the persistent player sidebar once hosting starts;
       it is not a third wizard step. Keep these guards for stale shells while
       allowing the Link markup to be removed entirely. */
    if (elements.stepLink) elements.stepLink.hidden = true;
    if (elements.wizardLink) elements.wizardLink.hidden = true;
    var order = ["map", "mode"];
    var current = order.indexOf(step);
    [elements.wizardMap, elements.wizardMode]
      .forEach(function(indicator, index) {
        if (!indicator) return;
        if (index === current) indicator.setAttribute("aria-current", "step");
        else indicator.removeAttribute("aria-current");
        indicator.dataset.complete = index < current ? "true" : "false";
      });
  }

  function playerFallbackName(player) {
    if (player.peerId === session.selfPeerId && session.profile) return session.profile.name;
    return player.role === "host" ? "Host" : "Joining…";
  }

  function normalizedRosterPlayer(value) {
    if (!value || typeof value.peerId !== "string" ||
        !/^[hg]_[A-Za-z0-9_-]{16}$/.test(value.peerId) ||
        (value.role !== "host" && value.role !== "guest")) return null;
    var profile = null;
    if (value.profile !== null && value.profile !== undefined) {
      try { profile = normalizePlayerProfile(value.profile); } catch (error) { return null; }
    }
    return { peerId: value.peerId, role: value.role, profile: profile };
  }

  function renderRoster() {
    if (!elements.playerSidebar) return;
    elements.playerSidebar.hidden = false;
    elements.playerSidebar.dataset.onlineActive = session.active ? "true" : "false";
    if (!session.active && elements.playerSidebar.dataset.collapsed === "true") {
      delete elements.playerSidebar.dataset.collapsed;
      if (elements.playerSidebarToggle) {
        elements.playerSidebarToggle.setAttribute("aria-expanded", "true");
        elements.playerSidebarToggle.setAttribute("aria-label", "Collapse player list");
        elements.playerSidebarToggle.textContent = "⌃";
      }
    }
    var players = Array.from(session.roster.values());
    players.sort(function(left, right) {
      if (left.role !== right.role) return left.role === "host" ? -1 : 1;
      var leftName = left.profile ? left.profile.name : playerFallbackName(left);
      var rightName = right.profile ? right.profile.name : playerFallbackName(right);
      return leftName.localeCompare(rightName);
    });
    if (elements.playerCount) {
      var capacity = ROOM_CAPACITY;
      try {
        if (relaySettings()) capacity = RELAY_ROOM_CAPACITY;
      } catch (error) {
        /* (a relay misconfigured: the room says so elsewhere) */
      }
      elements.playerCount.textContent = players.length + "/" + capacity;
      elements.playerCount.setAttribute(
        "aria-label",
        "Players in room: " + players.length + " of " + capacity);
    }
    if (elements.playerEmpty) elements.playerEmpty.hidden = players.length !== 0;
    if (elements.playerList && typeof document.createElement === "function") {
      while (elements.playerList.firstChild) elements.playerList.removeChild(elements.playerList.firstChild);
      players.forEach(function(player) {
        var profile = player.profile || {
          name: playerFallbackName(player),
          style: player.peerId === session.selfPeerId && session.profile ?
            session.profile.style : "sage",
        };
        var row = document.createElement("li");
        row.className = "player-row";
        row.dataset.style = profile.style;
        row.dataset.role = player.role;
        row.dataset.self = player.peerId === session.selfPeerId ? "true" : "false";
        var swatch = document.createElement("span");
        swatch.className = "player-swatch";
        swatch.setAttribute("aria-hidden", "true");
        var label = document.createElement("span");
        label.className = "player-name";
        label.textContent = profile.name;
        var role = document.createElement("span");
        role.className = "player-role";
        role.textContent = player.peerId === session.selfPeerId ? "You" :
          (player.role === "host" ? "Host" : "Player");
        row.appendChild(swatch);
        row.appendChild(label);
        row.appendChild(role);
        elements.playerList.appendChild(row);
      });
    }
  }

  function replaceRoster(players) {
    if (!Array.isArray(players) || players.length > ROOM_CAPACITY) return;
    var next = new Map();
    players.forEach(function(value) {
      var player = normalizedRosterPlayer(value);
      if (player) next.set(player.peerId, player);
    });
    session.roster = next;
    updateLocalRoster();
    renderRoster();
  }

  function updateLocalRoster() {
    if (!session.selfPeerId || !session.profile || !session.role) return;
    session.roster.set(session.selfPeerId, {
      peerId: session.selfPeerId,
      profile: session.profile,
      role: session.role,
    });
    renderRoster();
  }

  function selectHasIndex(select, index) {
    return Array.prototype.some.call(select.options, function(option) {
      return option.value === String(index);
    });
  }

  function validatedIndex(value, maximum, select, label) {
    if (value === null || value === undefined || String(value).trim() === "") {
      throw new Error("Choose a " + label + ".");
    }
    var index = Number(value);
    if (!Number.isInteger(index) || index < 0 || index > maximum ||
        !selectHasIndex(select, index)) {
      throw new Error("Choose a valid " + label + ".");
    }
    return index;
  }

  function selectedLabel(select, index) {
    var option = Array.prototype.find.call(select.options, function(candidate) {
      return candidate.value === String(index);
    });
    return option ? option.textContent.trim() : "";
  }

  function normalizeHostSettings(value) {
    var source = value || {
      mapIndex: elements.map.value,
      modeIndex: elements.mode.value,
    };
    var mapIndex = validatedIndex(source.mapIndex, LAST_MAP_INDEX, elements.map, "map");
    var modeIndex = validatedIndex(source.modeIndex, LAST_MODE_INDEX, elements.mode, "mode");
    return {
      mapIndex: mapIndex,
      modeIndex: modeIndex,
      mapName: selectedLabel(elements.map, mapIndex),
      modeName: selectedLabel(elements.mode, modeIndex),
    };
  }

  /* The last map and mode chosen (restored into the shell's selects). */
  function readHostSettings() {
    try {
      return normalizeHostSettings(null);
    } catch (error) {
      return null;
    }
  }

  function restoreHostSettings() {
    elements.map.value = "0";
    elements.mode.value = "0";
    try {
      var saved = JSON.parse(global.localStorage.getItem(HOST_SETTINGS_STORAGE_KEY));
      var settings = normalizeHostSettings(saved);
      elements.map.value = String(settings.mapIndex);
      elements.mode.value = String(settings.modeIndex);
    } catch (error) {
      /* Missing, blocked, or stale storage falls back to Battle Creek + Slayer. */
    }
    syncHostPickerCards();
  }

  function saveHostSettings(settings) {
    try {
      global.localStorage.setItem(HOST_SETTINGS_STORAGE_KEY, JSON.stringify({
        mapIndex: settings.mapIndex,
        modeIndex: settings.modeIndex,
      }));
    } catch (error) {
      /* Private browsing may make local storage unavailable; hosting still works. */
    }
  }

  function hostSettingsLabel() {
    return session.hostSettings ?
      session.hostSettings.mapName + " · " + session.hostSettings.modeName :
      "Your game";
  }

  function connectedFriendsLabel(count) {
    return count === 1 ? "1 friend connected" : count + " friends connected";
  }

  function requireCurrentOperation(generation) {
    if (generation !== session.operationGeneration || !session.active || session.closing) {
      var error = new Error("Online operation was canceled.");
      error.haloCanceled = true;
      throw error;
    }
  }

  function isCurrentSocketOperation(socketGeneration, operationGeneration) {
    return socketGeneration === session.socketGeneration &&
      operationGeneration === session.operationGeneration &&
      session.active && !session.closing;
  }

  function showSetup() {
    if (elements.dialog) elements.dialog.dataset.view = "setup";
    if (elements.wizardSteps) elements.wizardSteps.hidden = false;
    elements.setup.hidden = false;
    elements.invite.hidden = true;
    elements.progress.hidden = true;
    if (elements.joinConfirm) elements.joinConfirm.hidden = true;
    setWizardStep("map");
    setProfileLocked(false);
    renderTurnstile("create_room");
    setStatus("");
    elements.description.textContent =
      "Pick a map and mode, then send the invite link to your friends.";
  }

  function showProgress() {
    if (elements.dialog) elements.dialog.dataset.view = "progress";
    if (elements.wizardSteps) elements.wizardSteps.hidden = session.role === "guest";
    elements.setup.hidden = true;
    elements.invite.hidden = true;
    elements.progress.hidden = false;
    if (elements.joinConfirm) elements.joinConfirm.hidden = true;
  }

  function showInvite() {
    if (elements.wizardSteps) elements.wizardSteps.hidden = true;
    elements.setup.hidden = true;
    elements.progress.hidden = true;
    elements.invite.hidden = false;
    if (elements.joinConfirm) elements.joinConfirm.hidden = true;
    if (elements.playerSidebar) elements.playerSidebar.hidden = false;
    elements.inviteLink.value = activity() ? "Everyone in this Activity can join" : (session.inviteUrl || "");
    if (elements.copy) elements.copy.hidden = !!activity();
    /* Hosting setup is complete. The invite remains visible beside the game,
       so dismiss the wizard instead of replacing it with a third screen. */
    if (elements.dialog.open) elements.dialog.close();
  }

  function showJoinConfirmation(invite) {
    session.pendingInvite = invite;
    if (elements.dialog) elements.dialog.dataset.view = "join";
    if (elements.wizardSteps) elements.wizardSteps.hidden = true;
    elements.setup.hidden = true;
    elements.invite.hidden = true;
    elements.progress.hidden = true;
    if (elements.joinConfirm) elements.joinConfirm.hidden = false;
    if (elements.joinSummary) elements.joinSummary.textContent =
      "Choose your name and color, then join your friend's game.";
    elements.description.textContent = "You're invited.";
    setHeader("Ready to join", "waiting");
    setStatus(session.runtimeReady ? "" : "Loading Halo…");
    setProfileLocked(false);
    renderTurnstile("join_room");
    setBusy(false);
  }

  function parseInvite(value) {
    var text = String(value || "").trim();
    if (!text || text.length > 1024) throw new Error("Paste a valid invite link.");
    if (!/^room:/.test(text)) {
      try {
        var url = new URL(text);
        var fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
        text = fragment.get("room") ? "room:" + fragment.get("room") : (fragment.get("join") || "");
      } catch (error) {
        /* A room code is expected not to be a URL. */
      }
    }
    var relayRoom = /^room:([A-Za-z0-9_-]{16,64})$/.exec(text);
    if (relayRoom) return { code: text, roomId: relayRoom[1], ticket: null, relay: true };
    try {
      text = decodeURIComponent(text);
    } catch (error) {
      throw new Error("That invite link is malformed.");
    }
    var separator = text.indexOf(".");
    if (separator <= 0 || separator === text.length - 1) {
      throw new Error("That invite link is incomplete.");
    }
    var roomId = text.slice(0, separator);
    var ticket = text.slice(separator + 1);
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(roomId) ||
        !/^[A-Za-z0-9_-]{16,256}$/.test(ticket)) {
      throw new Error("That invite link is not valid.");
    }
    return { code: text, roomId: roomId, ticket: ticket };
  }

  function takeInviteFromLocation() {
    var fragment = new URLSearchParams(global.location.hash.replace(/^#/, ""));
    var invite = fragment.get("join") || (fragment.get("room") ? "room:" + fragment.get("room") : null);
    if (!invite) return null;
    /* Capabilities in fragments do not reach the server.  Remove it from the
       address bar as soon as this page has copied it into memory. */
    var sanitized = new URL(global.location.href);
    sanitized.hash = "";
    sanitized.searchParams.delete("signal");
    history.replaceState(null, "", sanitized.pathname + sanitized.search);
    return invite;
  }

  function makeInviteUrl(code) {
    var url = new URL(global.location.href);
    url.searchParams.delete("signal");
    url.hash = /^room:/.test(code) ? "room=" + code.slice(5) : "join=" + encodeURIComponent(code);
    return url.href;
  }

  async function fetchJson(path, options) {
    var response;
    try {
      response = await fetch(apiBase() + path, Object.assign({
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
      }, options || {}));
    } catch (error) {
      throw new Error("The private-room service is unreachable.");
    }
    var result = null;
    try {
      result = await response.json();
    } catch (error) {
      /* A proxy error page is not useful to the player. */
    }
    if (!response.ok) {
      var message = result && result.error &&
        (result.error.message || (typeof result.error === "string" && result.error));
      if (response.status === 404) message = "That invite expired or is not valid.";
      if (response.status === 409 && !message) message = "That room is full or no longer available.";
      var requestError = new Error(message || "The private-room service rejected the request.");
      requestError.haloCode = result && result.error && result.error.code;
      requestError.haloStatus = response.status;
      throw requestError;
    }
    return result;
  }

  function wasmFunction(name) {
    var fn = global.Module && global.Module["_" + name];
    if (typeof fn !== "function") throw new Error("Halo is still starting.");
    return fn;
  }

  function requestGame(command) {
    if (!wasmFunction("platform_web_online_request")(command)) {
      throw new Error("Halo could not accept the online-play request.");
    }
  }

  function requestConfiguredHost(settings) {
    if (!wasmFunction("platform_web_online_host_configured")(
      settings.mapIndex, settings.modeIndex)) {
      throw new Error("Halo could not accept those host settings.");
    }
  }

  function gameState() {
    return wasmFunction("platform_web_online_get_state")();
  }

  function gameError() {
    return wasmFunction("platform_web_online_get_error")();
  }

  function setGameTransportState(value) {
    if (!session.runtimeReady) return;
    wasmFunction("platform_web_online_set_transport_state")(value);
  }

  /* Relay pages (the hosted page, the Discord Activity) need only WebSocket;
     Discord's Activity frame has no RTCPeerConnection at all. */
  function transport() {
    var relay = !!relaySettings();
    if (!global.HaloWebTransport || !global.HaloWebTransport.isSupported(relay ? "relay" : "webrtc")) {
      throw new Error(relay ? "This browser does not support WebSocket multiplayer." :
        "This browser does not support WebRTC multiplayer.");
    }
    return global.HaloWebTransport;
  }

  function localIdentifier() {
    return transport().getLocalIdentifier();
  }

  function wireSignal(signal) {
    if (signal && signal.description) {
      return { kind: "description", description: signal.description };
    }
    if (signal && Object.prototype.hasOwnProperty.call(signal, "candidate")) {
      return { kind: "candidate", candidate: signal.candidate };
    }
    throw new Error("WebRTC produced an unsupported signal.");
  }

  function transportSignal(signal) {
    if (!signal || typeof signal !== "object") throw new Error("The host sent an invalid signal.");
    if (signal.kind === "description") return { description: signal.description };
    if (signal.kind === "candidate") return { candidate: signal.candidate };
    /* Accept the direct transport shape for local/older signalling servers. */
    if (signal.description || Object.prototype.hasOwnProperty.call(signal, "candidate")) return signal;
    throw new Error("The host sent an unsupported signal.");
  }

  function sendSocket(message) {
    if (!session.socket || session.socket.readyState !== WebSocket.OPEN) {
      throw new Error("The room connection is temporarily unavailable.");
    }
    session.socket.send(JSON.stringify(message));
  }

  function configureTransport(iceServers) {
    var relay = relaySettings();
    transport().configure({
      iceServers: iceServers || [],
      transport: relay ? "relay" : "webrtc",
      relay: relay ? {
        url: relay.url,
        sockets: relay.sockets,
        batch: relay.batch,
        roomId: session.room && session.room.id,
        role: session.role,
        rooms: true,
        auth: {
          getToken: function() { return relayAuth.token; },
          build: buildId(),
          spectator: function() { return session.role === "guest" && spectating.page; },
        },
      } : null,
      onRelayPeer: registerRelayPeer,
      onSignal: function(event) {
        if (!session.active || session.closing || !event ||
            !session.peerPromises.has(event.peerId)) return;
        sendSocket({
          v: PROTOCOL_VERSION,
          type: "signal",
          to: session.peerSignalTargets.get(event.peerId) || event.peerId,
          signal: wireSignal(event.signal),
        });
      },
      onStateChange: function(event) {
        handleTransportState(event);
      },
      onError: function(event) {
        var message = event && event.error && event.error.message ?
          event.error.message : "The browser connection failed.";
        if (session.active) setStatus(message, "error");
      },
    });
  }

  function ensurePeer(peer, socketGeneration, operationGeneration) {
    if (!isCurrentSocketOperation(socketGeneration, operationGeneration)) {
      return Promise.resolve(null);
    }
    if (!peer || typeof peer.peerId !== "string" ||
        typeof peer.identifier !== "string" ||
        (peer.role !== "host" && peer.role !== "guest")) {
      return Promise.reject(new Error("The room returned an invalid peer."));
    }
    if (peer.peerId === session.selfPeerId) return Promise.resolve(null);
    /* Halo uses a host-client star. Guests never need guest-to-guest browser
       transports, even though older room services may announce every member. */
    if (peer.role === session.role) return Promise.resolve(null);
    var existing = session.peerPromises.get(peer.peerId);
    if (existing) return existing;
    var normalizedIdentifier = peer.identifier.toLowerCase();
    var connectedDuplicate = null;
    session.peerIdentifiers.forEach(function(identifier, peerId) {
      if (peerId !== peer.peerId && identifier === normalizedIdentifier) {
        if (session.peerStates.get(peerId) === "connected") {
          connectedDuplicate = peerId;
          return;
        }
        /* A refreshed browser receives a new signaling peer ID but retains its
           Halo network identifier. Replace the stale WebRTC transport before
           registering the new one so both cannot share one virtual address. */
        removePeer(peerId);
      }
    });
    if (connectedDuplicate) {
      session.peerAliases.set(peer.peerId, connectedDuplicate);
      session.peerSignalTargets.set(connectedDuplicate, peer.peerId);
      return session.peerPromises.get(connectedDuplicate) || Promise.resolve(null);
    }
    var rawAdding = transport().addPeer({
      peerId: peer.peerId,
      remoteIdentifier: normalizedIdentifier,
      initiator: session.role === "host",
      polite: session.role !== "host",
      iceServers: session.iceServers,
    });
    var adding = rawAdding.then(function(result) {
      if (!isCurrentSocketOperation(socketGeneration, operationGeneration)) {
        if (session.peerPromises.get(peer.peerId) === adding) removePeer(peer.peerId);
        var error = new Error("Peer registration was canceled.");
        error.haloCanceled = true;
        throw error;
      }
      return result;
    });
    session.peerIdentifiers.set(peer.peerId, normalizedIdentifier);
    session.peerPromises.set(peer.peerId, adding);
    session.peerAliases.set(peer.peerId, peer.peerId);
    session.peerSignalTargets.set(peer.peerId, peer.peerId);
    adding.catch(function() {
      if (session.peerPromises.get(peer.peerId) === adding) {
        session.peerPromises.delete(peer.peerId);
        session.peerIdentifiers.delete(peer.peerId);
        session.peerAliases.delete(peer.peerId);
        session.peerSignalTargets.delete(peer.peerId);
      }
    });
    return adding;
  }

  function removePeer(peerId) {
    var transportPeerId = session.peerAliases.get(peerId) || peerId;
    session.peerAliases.forEach(function(mappedPeerId, signalingPeerId) {
      if (mappedPeerId === transportPeerId) session.peerAliases.delete(signalingPeerId);
    });
    session.peerSignalTargets.delete(transportPeerId);
    session.peerPromises.delete(transportPeerId);
    session.peerIdentifiers.delete(transportPeerId);
    session.peerStates.delete(transportPeerId);
    transport().removePeer(transportPeerId);
    updateAggregateTransportState();
  }

  function updateAggregateTransportState() {
    var values = Array.from(session.peerStates.values());
    var connected = values.filter(function(value) { return value === "connected"; }).length;
    var connecting = values.some(function(value) { return value === "connecting"; });
    var failed = values.some(function(value) { return value === "failed"; });
    session.connectedPeerCount = connected;
    session.transportConnected = connected > 0;
    if (session.transportConnected) setGameTransportState(TRANSPORT_STATE.CONNECTED);
    else if (connecting) setGameTransportState(TRANSPORT_STATE.CONNECTING);
    else if (failed) setGameTransportState(TRANSPORT_STATE.FAILED);
    else setGameTransportState(TRANSPORT_STATE.DISCONNECTED);

    if (session.role === "host") {
      if (connected) {
        setHeader(connectedFriendsLabel(connected), "connected");
        setStatus(connected === 1 ?
          "Your friend is connected. Press Start Game in Halo when ready." :
          connected + " friends are connected. Press Start Game in Halo when ready.");
      } else if (session.active) {
        setHeader("Waiting for friends", "waiting");
      }
    }
  }

  function handleTransportState(event) {
    if (!session.active || !event || !event.peerId ||
        !session.peerPromises.has(event.peerId)) return;
    session.peerStates.set(event.peerId, event.state);
    updateAggregateTransportState();
    if (event.state === "connected") {
      determineConnectionPath(event.peerId);
      if (session.role === "guest" && !session.gameCommandIssued) {
        try {
          applyPlayerCustomization(session.profile);
          requestGame(COMMAND.JOIN);
          session.gameCommandIssued = true;
          startGamePolling();
          setStatus("Connected. Finding your friend's Halo lobby…");
        } catch (error) {
          fail(error);
        }
      } else if (session.role === "host") {
        global.setTimeout(function() {
          if (elements.dialog.open && session.active) elements.dialog.close();
          var canvas = byId("canvas");
          if (canvas) canvas.focus();
        }, 700);
      }
    } else if (event.state === "connecting" && session.role === "guest") {
      setStatus("Connecting directly to your friend…");
    } else if (event.state === "failed" && session.role === "guest") {
      fail(new Error(relaySettings() ? "The host left the game, or the connection to it was lost." :
        (event.detail || "Could not connect to the host.")));
    } else if (event.state === "failed" && relaySettings()) {
      /* A relay guest that stayed away past the resume grace is gone; forget
         it so the relay can announce it again if it rejoins. */
      transport().removePeer(event.peerId);
      session.peerPromises.delete(event.peerId);
      session.peerIdentifiers.delete(event.peerId);
      session.peerStates.delete(event.peerId);
      session.peerAliases.delete(event.peerId);
      session.roster.delete(event.peerId);
      updateAggregateTransportState();
      renderRoster();
    }
  }

  async function determineConnectionPath(peerId) {
    try {
      if (relaySettings()) {
        session.connectionPath = "relay-ws";
        syncTelemetryContext();
        telemetry("transport_connected", session.connectionPath);
        elements.detail.textContent = "Connected through the WebSocket relay";
        return;
      }
      await new Promise(function(resolve) { setTimeout(resolve, 500); });
      var reports = await transport().getStats(peerId);
      var selected = null;
      reports.forEach(function(report) {
        if (report.type === "candidate-pair" &&
            (report.selected || (report.nominated && report.state === "succeeded"))) {
          selected = report;
        }
      });
      if (!selected) return;
      var local = reports.get(selected.localCandidateId);
      var remote = reports.get(selected.remoteCandidateId);
      session.connectionPath =
        (local && local.candidateType === "relay") ||
        (remote && remote.candidateType === "relay") ? "relay" : "direct";
      syncTelemetryContext();
      telemetry("transport_connected", session.connectionPath);
      elements.detail.textContent = session.connectionPath === "relay" ?
        "Connected through a privacy-compatible relay" :
        "Connected directly peer-to-peer";
    } catch (error) {
      /* Connection-path reporting is diagnostic and never blocks play. */
    }
  }

  async function handleRoomMessage(message, generation, operation) {
    if (!isCurrentSocketOperation(generation, operation)) return;
    if (!message || message.v !== PROTOCOL_VERSION || typeof message.type !== "string") {
      throw new Error("The room service sent an incompatible message.");
    }
    if (message.type === "welcome") {
      session.selfPeerId = message.self && message.self.peerId;
      session.role = message.self && message.self.role;
      syncTelemetryContext();
      updateLocalRoster();
      var peers = Array.isArray(message.peers) ? message.peers : [];
      await Promise.all(peers.map(function(peer) {
        return ensurePeer(peer, generation, operation);
      }));
      return;
    }
    if (message.type === "peer-joined") {
      var joined = normalizedRosterPlayer(message.peer);
      if (joined) {
        session.roster.set(joined.peerId, joined);
        renderRoster();
      }
      await ensurePeer(message.peer, generation, operation);
      return;
    }
    if (message.type === "peer-left") {
      session.roster.delete(message.peerId);
      renderRoster();
      var departedTransportPeerId = session.peerAliases.get(message.peerId) || message.peerId;
      if (session.peerStates.get(departedTransportPeerId) === "connected") {
        session.peerAliases.delete(message.peerId);
        if (session.peerSignalTargets.get(departedTransportPeerId) === message.peerId) {
          session.peerSignalTargets.delete(departedTransportPeerId);
        }
        elements.detail.textContent =
          "Gameplay is still connected directly; the room link closed.";
        return;
      }
      removePeer(departedTransportPeerId);
      if (session.role === "guest" && message.reason === "host-disconnected") {
        fail(new Error("The host closed the room."));
      }
      return;
    }
    if (message.type === "roster") {
      replaceRoster(message.players);
      return;
    }
    if (message.type === "signal") {
      var transportPeerId = session.peerAliases.get(message.from) || message.from;
      var peerPromise = session.peerPromises.get(transportPeerId);
      if (!peerPromise) {
        /* A rejected guest can have another frame already in flight. It must
           not turn a peer-scoped failure into destruction of the host room. */
        if (session.role === "host") return;
        throw new Error("A signal arrived from an unknown host.");
      }
      try {
        await peerPromise;
        if (!isCurrentSocketOperation(generation, operation)) return;
        await transport().handleSignal(transportPeerId, transportSignal(message.signal));
      } catch (error) {
        if (!isCurrentSocketOperation(generation, operation)) return;
        removePeer(transportPeerId);
        if (session.role === "guest") throw error;
        setStatus("A guest sent invalid connection data and was disconnected.", "error");
      }
      return;
    }
    if (message.type === "error") {
      if (session.role === "host" &&
          (message.code === "PEER_NOT_FOUND" ||
           message.code === "SIGNAL_ROUTE_FORBIDDEN" ||
           message.code === "SIGNAL_DIRECTION_INVALID")) {
        /* A late or rejected guest signal is peer-scoped. The private host
           lobby remains usable for a fresh connection. */
        return;
      }
      throw new Error(message.message || "The private room reported an error.");
    }
    /* pong and future optional messages need no action. */
  }

  function websocketUrl(value) {
    var service = new URL(apiBase());
    var url = new URL(value, service);
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";
    var expectedProtocol = service.protocol === "https:" ? "wss:" : "ws:";
    if (url.protocol !== expectedProtocol || url.host !== service.host) {
      throw new Error("The room returned an invalid WebSocket URL.");
    }
    return url.href;
  }

  function stopHeartbeat() {
    if (session.heartbeatTimer) global.clearInterval(session.heartbeatTimer);
    session.heartbeatTimer = 0;
  }

  function startHeartbeat(generation) {
    stopHeartbeat();
    session.heartbeatTimer = global.setInterval(function() {
      if (generation !== session.socketGeneration || !session.active) return;
      try {
        sendSocket({ v: PROTOCOL_VERSION, type: "ping", nonce: String(Date.now()) });
      } catch (error) {
        /* The close event owns reconnect behavior. */
      }
    }, HEARTBEAT_MILLISECONDS);
  }

  function openSocket(socketUrl, operation) {
    return new Promise(function(resolve, reject) {
      var generation = ++session.socketGeneration;
      var socket;
      try {
        socket = new WebSocket(websocketUrl(socketUrl));
      } catch (error) {
        reject(error);
        return;
      }
      session.socket = socket;
      var settled = false;
      var pendingMessageCount = 0;
      var messageChain = Promise.resolve();
      session.messageChain = messageChain;
      var timeout = global.setTimeout(function() {
        if (!settled) {
          settled = true;
          socket.close();
          reject(new Error("The private room took too long to connect."));
        }
      }, 12000);
      socket.onopen = function() {
        if (!isCurrentSocketOperation(generation, operation)) {
          global.clearTimeout(timeout);
          if (!settled) {
            settled = true;
            reject(new Error("The room connection was canceled."));
          }
          socket.close();
          return;
        }
        global.clearTimeout(timeout);
        try {
          sendSocket({
            v: PROTOCOL_VERSION,
            type: "profile",
            profile: session.profile,
          });
        } catch (error) {
          settled = true;
          socket.close();
          reject(error);
          return;
        }
        settled = true;
        session.reconnectAttempts = 0;
        startHeartbeat(generation);
        resolve();
      };
      socket.onmessage = function(event) {
        if (!isCurrentSocketOperation(generation, operation) || typeof event.data !== "string") return;
        pendingMessageCount++;
        if (pendingMessageCount > MAX_PENDING_SIGNALING_MESSAGES) {
          socket.close(1008, "Too many pending signaling messages");
          fail(new Error("The room sent too many connection messages."));
          return;
        }
        var message;
        try {
          message = JSON.parse(event.data);
        } catch (error) {
          pendingMessageCount--;
          if (isCurrentSocketOperation(generation, operation)) {
            fail(new Error("The private room sent malformed data."));
          }
          return;
        }
        messageChain = messageChain.then(function() {
          return handleRoomMessage(message, generation, operation);
        }).catch(function(error) {
          if (isCurrentSocketOperation(generation, operation)) fail(error);
        }).finally(function() {
          pendingMessageCount--;
        });
        session.messageChain = messageChain;
      };
      socket.onerror = function() {
        if (!settled) {
          global.clearTimeout(timeout);
          settled = true;
          reject(new Error("The private room WebSocket could not connect."));
        }
      };
      socket.onclose = function() {
        if (!settled) {
          global.clearTimeout(timeout);
          settled = true;
          reject(new Error("The room connection closed before it was ready."));
          return;
        }
        if (generation !== session.socketGeneration ||
            operation !== session.operationGeneration) return;
        stopHeartbeat();
        if (session.transportConnected && session.role !== "host") {
          elements.detail.textContent =
            "Gameplay is still connected directly; restoring the room link…";
        }
        if (session.active && !session.closing) scheduleReconnect();
      };
    });
  }

  async function createSession(ticket, turnstileToken) {
    var body = {
      protocolVersion: PROTOCOL_VERSION,
      buildId: buildId(),
      identifier: localIdentifier(),
      ticket: ticket,
    };
    if (turnstileToken) body.turnstileToken = turnstileToken;
    return fetchJson("/v1/rooms/" + encodeURIComponent(session.room.id) + "/sessions", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  function scheduleReconnect() {
    if (!session.active || session.closing || session.reconnectTimer) return;
    var operation = session.operationGeneration;
    var delay = Math.min(8000, 500 * Math.pow(2, session.reconnectAttempts++));
    session.reconnectTimer = global.setTimeout(function() {
      session.reconnectTimer = 0;
      if (operation !== session.operationGeneration || !session.active) return;
      reconnect(operation).catch(function(error) {
        if (operation !== session.operationGeneration) return;
        if (session.transportConnected) {
          elements.detail.textContent = "Gameplay is connected; room recovery is still retrying.";
          scheduleReconnect();
        /* A failed WebSocket upgrade can leave its 30-second server-side
           reservation in place. Keep retrying long enough to outlive it. */
        } else if (session.reconnectAttempts < 7) {
          scheduleReconnect();
        } else {
          fail(error);
        }
      });
    }, delay);
  }

  async function reconnect(operation) {
    if (!session.transportConnected) {
      /* The replacement signaling session gets a new peer ID. Any WebRTC
         negotiation that never connected belongs to the old identity and
         must be rebuilt so the host produces a fresh offer. */
      Array.from(session.peerPromises.keys()).forEach(removePeer);
    }
    var result = await createSession(session.roomTicket);
    requireCurrentOperation(operation);
    if (Array.isArray(result.iceServers)) session.iceServers = result.iceServers;
    configureTransport(session.iceServers);
    await openSocket(result.session.websocketUrl, operation);
    requireCurrentOperation(operation);
    elements.detail.textContent = session.connectionPath === "relay" ?
      "Connected through a relay" : "Connected peer-to-peer";
  }

  function validateRoomResponse(result) {
    if (!result || result.v !== PROTOCOL_VERSION || !result.room ||
        !result.session || !result.session.websocketUrl ||
        !result.session.peerId) {
      throw new Error("The room service returned an incomplete response.");
    }
  }

  function isTurnstileRejection(error) {
    return error && error.haloStatus === 403 && error.haloCode === "TURNSTILE_REJECTED";
  }

  async function recoverTurnstile(action, invite) {
    resetTurnstile();
    await leave(false);
    showDialog();
    if (action === "join_room") showJoinConfirmation(invite);
    else showSetup();
    setVerificationState(
      "error",
      "We couldn't verify you this time. Try again — you won't need to refresh.");
    setBusy(false);
  }

  async function openSignalingRoom(operation, turnstileToken) {
    var roomRequest = {
      protocolVersion: PROTOCOL_VERSION,
      buildId: buildId(),
      capacity: ROOM_CAPACITY,
      identifier: localIdentifier(),
    };
    if (turnstileToken) roomRequest.turnstileToken = turnstileToken;
    var result = await fetchJson("/v1/rooms", {
      method: "POST",
      body: JSON.stringify(roomRequest),
    });
    requireCurrentOperation(operation);
    var normalized = {
      v: result.v,
      room: result.room,
      session: result.host && result.host.session,
    };
    validateRoomResponse(normalized);
    session.room = result.room;
    session.roomTicket = result.host.ticket;
    session.selfPeerId = result.host.session.peerId;
    updateLocalRoster();
    session.inviteCode = result.invite && result.invite.code;
    if (!session.inviteCode) throw new Error("The room did not return an invite.");
    /* Keep the visible host and path that the player opened. This lets the
       same signaling service support a staged origin without leaking its
       canonical production URL into preview invites. */
    session.inviteUrl = makeInviteUrl(session.inviteCode);
    showInvite();
    session.iceServers = Array.isArray(result.iceServers) ? result.iceServers : [];
    configureTransport(session.iceServers);
    await openSocket(result.host.session.websocketUrl, operation);
  }

  async function host(value, turnstileToken) {
    if (!session.runtimeReady) throw new Error("Halo is still starting.");
    var settings = normalizeHostSettings(value);
    var profile = readPlayerProfile();
    saveHostSettings(settings);
    savePlayerProfile(profile);
    await leave(false);
    setSpectating(false);
    var operation = ++session.operationGeneration;
    session.active = true;
    session.role = "host";
    syncTelemetryContext();
    session.hostSettings = settings;
    session.closing = false;
    renderRoster();
    showDialog();
    showProgress();
    setBusy(true);
    setHeader("Opening room…", "waiting");
    setStatus("Preparing " + hostSettingsLabel() + "…");
    var recoveredVerification = false;
    try {
      if (relaySettings()) {
        stopHostedLobby();
        var roomId = pageRoomId() || randomRoomId();
        await startRelayRoom(roomId, operation);
        session.inviteCode = "room:" + session.room.id;
        session.inviteUrl = activity() ? "" : (hostedPage() ? global.location.href : makeInviteUrl(session.inviteCode));
        showInvite();
      } else {
        await openSignalingRoom(operation, turnstileToken);
      }
      requireCurrentOperation(operation);
      applyPlayerCustomization(profile);
      setJoinInProgress(!!relaySettings());
      requestConfiguredHost(settings);
      session.gameCommandIssued = true;
      startGamePolling();
      setHeader("Preparing lobby…", "waiting");
      setStatus("Opening Halo's lobby with " + hostSettingsLabel() + "…");
    } catch (error) {
      if (operation === session.operationGeneration && (!error || !error.haloCanceled)) {
        if (isTurnstileRejection(error)) {
          recoveredVerification = true;
          await recoverTurnstile("create_room");
        } else {
          fail(error);
        }
      }
    } finally {
      if (!recoveredVerification) resetTurnstile();
      if (operation === session.operationGeneration) setBusy(false);
    }
  }

  async function join(value, turnstileToken) {
    if (!session.runtimeReady) {
      showDialog();
      showJoinConfirmation(value);
      return;
    }
    var profile = readPlayerProfile();
    savePlayerProfile(profile);
    await leave(false);
    hostedLobby.pendingJoin = false;
    /* (hosted pages: a running match is watched first, a lobby is joined) */
    setSpectating(hostedPage() && hostedLobby.spectateNext);
    hostedLobby.spectateNext = false;
    var operation = ++session.operationGeneration;
    var invite;
    var recoveredVerification = false;
    try {
      invite = parseInvite(value);
    } catch (error) {
      fail(error);
      return;
    }
    session.active = true;
    session.role = "guest";
    syncTelemetryContext();
    session.closing = false;
    session.room = { id: invite.roomId };
    session.roomTicket = invite.ticket;
    session.profile = profile;
    writePlayerProfile(profile);
    showDialog();
    showProgress();
    setBusy(true);
    setHeader("Joining friend…", "waiting");
    setStatus("Opening your friend's private room…");
    try {
      if (invite.relay) {
        stopHostedLobby();
        await startRelayRoom(invite.roomId, operation);
        requireCurrentOperation(operation);
        setGameTransportState(TRANSPORT_STATE.CONNECTING);
        setStatus("Room found. Connecting to your friend through the relay…");
        return;
      }
      var result = await createSession(invite.ticket, turnstileToken);
      requireCurrentOperation(operation);
      validateRoomResponse(result);
      session.room = result.room;
      session.selfPeerId = result.session.peerId;
      updateLocalRoster();
      session.iceServers = Array.isArray(result.iceServers) ? result.iceServers : [];
      configureTransport(session.iceServers);
      await openSocket(result.session.websocketUrl, operation);
      requireCurrentOperation(operation);
      setGameTransportState(TRANSPORT_STATE.CONNECTING);
      setStatus("Room found. Connecting directly to your friend…");
    } catch (error) {
      if (operation === session.operationGeneration && (!error || !error.haloCanceled)) {
        if (isTurnstileRejection(error)) {
          recoveredVerification = true;
          await recoverTurnstile("join_room", value);
        } else {
          fail(error);
        }
      }
    } finally {
      if (!recoveredVerification) resetTurnstile();
      if (operation === session.operationGeneration) setBusy(false);
    }
  }

  function startGamePolling() {
    if (session.gamePollTimer) return;
    session.gamePollTimer = global.setInterval(pollGame, GAME_POLL_MILLISECONDS);
  }

  function stopGamePolling() {
    if (session.gamePollTimer) global.clearInterval(session.gamePollTimer);
    session.gamePollTimer = 0;
  }

  function pollGame() {
    if (!session.active || !session.runtimeReady || !session.gameCommandIssued) return;
    var state;
    try {
      state = gameState();
    } catch (error) {
      return;
    }
    elements.dialog.dataset.gameState = String(state);
    var clientState = clientGameState();
    /* (the room is joinable again from the postgame on: Halo returns
    everyone to its lobby from there, and a late joiner waits in it) */
    session.inMatch = clientState === CLIENT_STATE.INGAME;
    session.inPostgame = clientState === CLIENT_STATE.POSTGAME;
    if (session.role === "host" && global.HaloWebTransport && typeof global.HaloWebTransport.setRelayPhase === "function") {
      var phase = hostMatchPhase(clientState);
      global.HaloWebTransport.setRelayPhase(phase.inMatch, phase.joinable, hostListingDetails(clientState, phase));
    }
    if (state === GAME_STATE.ERROR) {
      fail(new Error(GAME_ERRORS[gameError()] || "Halo could not enter the online lobby."));
      return;
    }
    if (session.role === "host") {
      if (state === GAME_STATE.HOSTING) {
        if (!session.hostWasReady) showInvite();
        session.hostWasReady = true;
        setHeader(session.connectedPeerCount ?
          connectedFriendsLabel(session.connectedPeerCount) : "Waiting for friends",
          session.connectedPeerCount ? "connected" : "waiting");
        setStatus(session.connectedPeerCount ?
          connectedFriendsLabel(session.connectedPeerCount) + ". " + hostSettingsLabel() +
            " is ready — press Start Game in Halo." :
          hostSettingsLabel() + (activity() ? " is ready — others in this Activity can join now." :
            " is ready — send the invite link to your friends."));
      } else if (state === GAME_STATE.WAITING) {
        setStatus("Waiting for Halo's main menu…");
      } else if (state === GAME_STATE.HOST_STARTING) {
        setStatus("Opening Halo's multiplayer lobby…");
      } else if (session.hostWasReady && state === GAME_STATE.IDLE) {
        leave(true);
      }
      return;
    }
    if (state === GAME_STATE.WAITING) {
      setStatus("Waiting for Halo's main menu…");
    } else if (state === GAME_STATE.JOIN_SEARCHING) {
      setStatus("Connected. Finding your friend's Halo lobby…");
    } else if (state === GAME_STATE.JOIN_CONNECTING) {
      setStatus("Halo found the lobby. Joining…");
    } else if (state === GAME_STATE.JOINED) {
      session.guestWasJoined = true;
      hostedLobby.retryAt = 0;
      setNotice(null);
      setHeader("Connected to friend", "connected");
      setStatus("You're in the lobby.");
      global.setTimeout(function() {
        if (elements.dialog.open && session.active) elements.dialog.close();
        var canvas = byId("canvas");
        if (canvas) canvas.focus();
      }, 700);
    } else if (session.guestWasJoined && state === GAME_STATE.IDLE) {
      /* Halo returns to its menu when the guest quits or when the host is
         gone; the relay room tells the two apart. */
      session.guestWasJoined = false;
      relayRoomHasHost(session.room && session.room.id).then(function(hasHost) {
        var message = hasHost === false ? "The host left or ended the game." : null;
        if (message && hostedPage()) setNotice(message);
        return leave(true).then(function() {
          if (message && !hostedPage()) setStatus(message, "error");
        });
      });
    }
  }

  /* Whether a relay room still has a host; null when unknown. */
  async function relayRoomHasHost(roomId) {
    if (!roomId || !relaySettings()) return null;
    try {
      var response = await fetch(relayEndpoint("v1/rooms/" + roomId), { credentials: "include", cache: "no-store" });
      if (!response.ok) return null;
      return !!(await response.json()).host;
    } catch (error) {
      return null;
    }
  }

  function resetSessionState() {
    session.active = false;
    session.role = null;
    session.room = null;
    session.roomTicket = null;
    session.inviteCode = null;
    session.inviteUrl = null;
    session.selfPeerId = null;
    session.iceServers = [];
    session.socket = null;
    session.reconnectAttempts = 0;
    session.gameCommandIssued = false;
    session.transportConnected = false;
    session.connectedPeerCount = 0;
    session.connectionPath = null;
    session.peerPromises.clear();
    session.peerIdentifiers.clear();
    session.peerStates.clear();
    session.peerAliases.clear();
    session.peerSignalTargets.clear();
    session.roster.clear();
    engineRosterCache = null;
    session.messageChain = Promise.resolve();
    session.hostWasReady = false;
    session.hostSettings = null;
    session.guestWasJoined = false;
    session.inMatch = false;
    session.inPostgame = false;
    session.pendingInvite = null;
    session.wizardStep = "map";
    if (relayAuth.refreshTimer) global.clearTimeout(relayAuth.refreshTimer);
    relayAuth.refreshTimer = 0;
    syncTelemetryContext();
    renderRoster();
  }

  async function leave(returnToSetup) {
    session.operationGeneration++;
    if (session.leavePromise) return session.leavePromise;
    session.leavePromise = (async function() {
      /* (a host that just left still shows in its room's status until the
         relay has seen its socket close; polling at once would join itself) */
      var wasHost = session.role === "host";
      session.closing = true;
      var pendingWork = [session.messageChain].concat(Array.from(session.peerPromises.values()));
      if (session.role === "host" && session.room && session.roomTicket) {
        fetchJson("/v1/rooms/" + encodeURIComponent(session.room.id), {
          method: "DELETE",
          body: JSON.stringify({ ticket: session.roomTicket }),
        }).catch(function() {
          /* The room expires automatically if revocation cannot reach the service. */
        });
      }
      stopHeartbeat();
      stopGamePolling();
      if (session.reconnectTimer) global.clearTimeout(session.reconnectTimer);
      session.reconnectTimer = 0;
      session.socketGeneration++;
      if (session.socket) {
        try { session.socket.close(1000, "left room"); } catch (error) { /* closed */ }
      }
      if (global.HaloWebTransport) global.HaloWebTransport.disconnectAll();
      await Promise.allSettled(pendingWork);
      /* A peer registration can finish after the first disconnectAll(). Clear
         it before a replacement room is allowed to start. */
      if (global.HaloWebTransport) global.HaloWebTransport.disconnectAll();
      if (session.runtimeReady && session.gameCommandIssued) {
        try { requestGame(COMMAND.CANCEL); } catch (error) { /* runtime shutting down */ }
      }
      try { setGameTransportState(TRANSPORT_STATE.DISCONNECTED); } catch (error) { /* runtime unavailable */ }
      resetSessionState();
      setHeader("Play online", "offline");
      elements.detail.textContent = "Private invite room · gameplay connects peer-to-peer when possible";
      if (returnToSetup !== false) {
        showSetup();
        setBusy(false);
      }
      if (hostedPage()) startHostedLobby(wasHost ? LOBBY_POLL_MILLISECONDS : 0);
    })();
    try {
      await session.leavePromise;
    } finally {
      session.leavePromise = null;
      session.closing = false;
    }
  }

  function fail(error) {
    var message = error && error.message ? error.message : "Online play failed.";
    telemetry("online_error", "online");
    var wasActive = session.active;
    if (hostedPage()) {
      /* The hosted lobby reopens after leaving and shows the message. */
      setNotice(message);
      leave(false).then(function() { setBusy(false); });
      return;
    }
    leave(false).then(function() {
      showDialog();
      showSetup();
      setStatus(message, "error");
      setBusy(false);
    });
    if (!wasActive) {
      showDialog();
      showSetup();
      setStatus(message, "error");
    }
  }

  async function copyInvite() {
    var value = session.inviteUrl;
    if (!value) return;
    var copied = false;
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(value);
      copied = true;
    } catch (error) {
      elements.inviteLink.focus();
      elements.inviteLink.select();
      try {
        copied = typeof document.execCommand === "function" &&
          document.execCommand("copy") === true;
      } catch (fallbackError) {
        copied = false;
      }
    }
    if (!copied) {
      elements.copy.textContent = "Copy link";
      if (elements.copyStatus) {
        elements.copyStatus.textContent = "Link selected — press ⌘/Ctrl+C to copy.";
        elements.copyStatus.hidden = false;
      }
      return;
    }
    if (elements.copyStatus) elements.copyStatus.hidden = true;
    elements.copy.textContent = "Copied!";
    global.setTimeout(function() { elements.copy.textContent = "Copy link"; }, 1400);
  }

  function attachEvents() {
    ["keydown", "keyup", "keypress"].forEach(function(type) {
      elements.dialog.addEventListener(type, containDialogKeyboardEvent);
      elements.playerSidebar.addEventListener(type, containDialogKeyboardEvent);
    });
    attachPickerEvents(elements.mapOptions, "halo-map-choice", elements.map);
    attachPickerEvents(elements.modeOptions, "halo-mode-choice", elements.mode);
    elements.button.addEventListener("click", function() {
      if (session.active && session.role === "host" && session.hostWasReady) {
        showInvite();
        if (elements.inviteLink) elements.inviteLink.focus();
        return;
      }
      showDialog();
      if (!session.active && session.pendingInvite) showJoinConfirmation(session.pendingInvite);
      else if (!session.active) showSetup();
      else showProgress();
    });
    elements.close.addEventListener("click", function() { elements.dialog.close(); });
    elements.dialog.addEventListener("cancel", function(event) {
      event.preventDefault();
      elements.dialog.close();
    });
    elements.hostForm.addEventListener("submit", function(event) {
      event.preventDefault();
      if (session.wizardStep === "map" && elements.stepMap) {
        try {
          validatedIndex(elements.map.value, LAST_MAP_INDEX, elements.map, "map");
          setWizardStep("mode");
          setStatus("");
        } catch (error) {
          setStatus(error.message, "error");
        }
        return;
      }
      try {
        host(undefined, consumeTurnstile("create_room")).catch(fail);
      } catch (error) {
        setStatus(error.message, "error");
      }
    });
    if (elements.mapNext) {
      elements.mapNext.addEventListener("click", function() {
        try {
          validatedIndex(elements.map.value, LAST_MAP_INDEX, elements.map, "map");
          setWizardStep("mode");
          setStatus("");
        } catch (error) {
          setStatus(error.message, "error");
        }
      });
    }
    if (elements.modeBack) {
      elements.modeBack.addEventListener("click", function() {
        setWizardStep("map");
        setStatus("");
      });
    }
    elements.joinForm.addEventListener("submit", function(event) {
      event.preventDefault();
      try {
        var invite = parseInvite(elements.code.value);
        showDialog();
        showJoinConfirmation(invite.code);
      } catch (error) {
        setStatus(error.message, "error");
      }
    });
    if (elements.joinProfile) {
      elements.joinProfile.addEventListener("click", function() {
        var invite = session.pendingInvite;
        if (!invite) {
          setStatus("That invite is no longer available.", "error");
          return;
        }
        try {
          readPlayerProfile();
        } catch (error) {
          setStatus(error.message, "error");
          return;
        }
        try {
          join(invite, consumeTurnstile("join_room")).catch(fail);
        } catch (error) {
          setStatus(error.message, "error");
        }
      });
    }
    if (elements.verificationRetry) {
      elements.verificationRetry.addEventListener("click", function() {
        var action = elements.dialog && elements.dialog.dataset.view === "join" ?
          "join_room" : "create_room";
        setStatus("");
        renderTurnstile(action, true);
      });
    }
    var updateProfilePreview = function() {
      try {
        var profile = readPlayerProfile();
        session.profile = profile;
        renderPlayerProfilePreview(profile);
        try {
          global.localStorage.setItem(PLAYER_PROFILE_STORAGE_KEY, JSON.stringify(profile));
        } catch (error) { /* Persistence is optional. */ }
      } catch (error) {
        if (elements.profilePreviewName && elements.playerName) {
          elements.profilePreviewName.textContent = elements.playerName.value || "Player";
        }
      }
    };
    if (elements.playerName) elements.playerName.addEventListener("input", updateProfilePreview);
    if (elements.playerName) {
      elements.playerName.addEventListener("keydown", function(event) {
        if (event.key !== "Enter" || !elements.dialog || elements.dialog.dataset.view !== "join" ||
            !elements.joinProfile || elements.joinProfile.disabled) return;
        event.preventDefault();
        elements.joinProfile.click();
      });
    }
    if (elements.styleOptions) elements.styleOptions.addEventListener("change", updateProfilePreview);
    elements.copy.addEventListener("click", function() {
      copyInvite().catch(function() {
        elements.inviteLink.focus();
        elements.inviteLink.select();
        if (elements.copyStatus) {
          elements.copyStatus.textContent = "Link selected — press ⌘/Ctrl+C to copy.";
          elements.copyStatus.hidden = false;
        }
      });
    });
    elements.leaveHost.addEventListener("click", function() { leave(true).catch(fail); });
    elements.cancel.addEventListener("click", function() { leave(true).catch(fail); });
  }

  function initialize() {
    collectElements();
    restoreHostSettings();
    restorePlayerProfile();
    attachEvents();
    renderRoster();
    setBusy(false);
    /* (the hosted page's room stays in its address) */
    session.pendingInvite = hostedPage() ? null : takeInviteFromLocation();
    if (session.pendingInvite) {
      showDialog();
      showJoinConfirmation(session.pendingInvite);
    }
    /* A page kept in the back/forward cache would otherwise hold its relay
       socket open, leaving a host that no longer plays. */
    if (typeof global.addEventListener === "function") {
      global.addEventListener("pagehide", function() {
        if (session.active) leave(false);
      });
    }
  }

  /* The render cap (the simulation stays at 30 ticks). A browser rendering
     well past 120 frames a second misses whole frames now and then (Chrome
     at 240 Hz: 60 ms gaps a few times a minute, none at 120), so by default
     a display faster than 165 Hz renders every second (or third) frame:
     the largest whole fraction of its rate at most 120. The cap can only
     skip display frames, so a 144 Hz display stays uncapped rather than
     dropping to 72. F8 cycles off, 120 and 60 anywhere, including the
     Activity, and the choice is kept in this browser; ?fpsCap=N sets it on
     a page for one visit. */
  var FRAME_CAPS = [0, 120, 60];
  var FRAME_CAP_STORAGE = "halo-frame-cap";
  var frameCapAuto = { active: false, refresh: 0 };

  function defaultFrameCap(refreshHz) {
    if (!(refreshHz > 165)) return 0;
    /* (an estimate a hair over 240 Hz still halves) */
    return Math.round(refreshHz / Math.ceil(refreshHz / 120 - 0.05));
  }

  function frameCap() {
    var get = global.Module && global.Module._platform_web_frame_cap;
    return typeof get === "function" ? get() : 0;
  }

  function storedFrameCap() {
    try {
      var value = global.localStorage && global.localStorage.getItem(FRAME_CAP_STORAGE);
      return value !== null && value !== undefined && FRAME_CAPS.indexOf(Number(value)) >= 0 ? Number(value) : null;
    } catch (error) {
      return null;
    }
  }

  function setFrameCap(cap, how) {
    var set = global.Module && global.Module._platform_web_set_frame_cap;
    if (typeof set !== "function") return;
    set(cap);
    frameCapAuto.active = how === "auto";
    if (how === "chosen") {
      try {
        if (global.localStorage) global.localStorage.setItem(FRAME_CAP_STORAGE, String(cap));
      } catch (error) {
        /* (storage refused: the choice lasts this visit) */
      }
    }
    if (how === "auto" || typeof document.createElement !== "function" || !document.body) return;
    var notice = byId("frame-cap-notice");
    if (!notice) {
      notice = document.createElement("div");
      notice.id = "frame-cap-notice";
      notice.setAttribute("role", "status");
      Object.assign(notice.style, { position: "fixed", top: "1rem", left: "50%", transform: "translateX(-50%)",
        zIndex: "30", padding: ".4rem .8rem", borderRadius: ".4rem", background: "rgba(0, 0, 0, .75)",
        color: "#fff", font: "14px system-ui, sans-serif", pointerEvents: "none" });
      document.body.appendChild(notice);
    }
    notice.textContent = cap ? "Frame cap: " + cap + " fps" : "Frame cap: off (display rate)";
    notice.hidden = false;
    global.clearTimeout(notice.hideTimer);
    notice.hideTimer = global.setTimeout(function() { notice.hidden = true; }, 2000);
  }

  /* the display's refresh rate from 120 animation frames, then the default
     cap unless one was chosen. A busy page misses frames, which only
     lengthens intervals (the game loading at start-up made most of them
     two frames long), so the rate is the 10th percentile's, and the faster
     of this and any earlier estimate. */
  function estimateFrameCap() {
    if (typeof global.requestAnimationFrame !== "function") return;
    var times = [];
    var sample = function(time) {
      times.push(time);
      if (times.length < 121) {
        global.requestAnimationFrame(sample);
        return;
      }
      var intervals = [];
      for (var i = 1; i < times.length; i++) intervals.push(times[i] - times[i - 1]);
      intervals.sort(function(x, y) { return x - y; });
      var short = intervals[Math.floor(intervals.length / 10)];
      if (!(short > 0)) return;
      frameCapAuto.refresh = Math.max(frameCapAuto.refresh, 1000 / short);
      if (storedFrameCap() === null && (frameCapAuto.active || frameCap() === 0)) {
        setFrameCap(defaultFrameCap(frameCapAuto.refresh), "auto");
      }
    };
    global.requestAnimationFrame(sample);
  }

  var frameCapInitialized = false;

  function initializeFrameCap() {
    if (frameCapInitialized) return;
    frameCapInitialized = true;
    var requested = Number(new URL(global.location.href).searchParams.get("fpsCap"));
    var stored = storedFrameCap();
    if (requested > 0) setFrameCap(requested, "page");
    else if (stored !== null) setFrameCap(stored, "stored");
    else {
      estimateFrameCap();
      /* (again once start-up's work is done) */
      global.setTimeout(estimateFrameCap, 15000);
    }
    if (typeof global.addEventListener === "function") {
      global.addEventListener("keydown", function(event) {
        if (event.key !== "F8" || event.repeat) return;
        var index = FRAME_CAPS.indexOf(frameCap());
        setFrameCap(FRAME_CAPS[(index + 1) % FRAME_CAPS.length], "chosen");
      }, true);
      /* (a window moved to another display usually resizes too) */
      var resizeTimer = null;
      global.addEventListener("resize", function() {
        if (!frameCapAuto.active) return;
        global.clearTimeout(resizeTimer);
        resizeTimer = global.setTimeout(estimateFrameCap, 1000);
      });
    }
  }

  global.HaloOnline = Object.freeze({
    runtimeReady: function() {
      session.runtimeReady = true;
      setBusy(false);
      initializeFrameCap();
      try {
        transport();
      } catch (error) {
        fail(error);
        return;
      }
      if (session.pendingInvite) {
        showJoinConfirmation(session.pendingInvite);
      }
      startHostedLobby();
    },
    host: host,
    join: join,
    leave: function() { return leave(true); },
    defaultFrameCap: defaultFrameCap,
    status: hostedStatus,
    configure: configureNextMatch,
    spectatorJoin: spectatorJoin,
    spectateCycle: spectateCycle,
    startMatch: startMatch,
    endMatch: endMatch,
    setTeam: setTeam,
    guildRooms: guildRooms,
    joinGuildRoom: joinGuildRoom,
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})(typeof window !== "undefined" ? window : null);
