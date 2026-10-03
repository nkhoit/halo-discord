/* The hosted page's own UI (the Discord Activity and the browser page this
   server serves; upstream's shell stays as it is for local development).
   The game fills the frame. Over it: a loading screen, the lobby (the host
   picks a map and mode; everyone else joins the host by themselves), a bar
   in Halo's own lobby, and an overlay whenever the game does not have the
   mouse: click to play, sound, Halo's menu, leave.

   Escape belongs to the page: browsers always release the mouse on Escape,
   so it shows the overlay, and Halo's Start (its pause menu) moves to the
   overlay's "Game menu" button. Upstream's shell keeps running underneath
   (Module, input, audio, loading); this script drives its controls and
   reads HaloOnline.status() (online_client.js). */
(function installHostedUi(global) {
  "use strict";

  var MAPS = [
    ["battle-creek", "Battle Creek"], ["sidewinder", "Sidewinder"], ["damnation", "Damnation"],
    ["rat-race", "Rat Race"], ["prisoner", "Prisoner"], ["hang-em-high", "Hang 'Em High"],
    ["chill-out", "Chill Out"], ["derelict", "Derelict"], ["boarding-action", "Boarding Action"],
    ["blood-gulch", "Blood Gulch"], ["wizard", "Wizard"], ["chiron-tl-34", "Chiron TL-34"],
    ["longest", "Longest"],
  ];
  var MODES = [
    ["slayer", "Slayer"], ["team-slayer", "Team Slayer"], ["capture-the-flag", "Capture the Flag"],
    ["oddball", "Oddball"], ["king-of-the-hill", "King of the Hill"], ["race", "Race"],
  ];
  /* platform_web_map_load_index(): web_platform.c's map_files order */
  var MAP_FILES = {
    10: "Battle Creek", 11: "Blood Gulch", 12: "Boarding Action", 13: "Derelict", 14: "Chill Out",
    15: "Damnation", 16: "Hang 'Em High", 17: "Longest", 18: "Prisoner", 19: "Chiron TL-34",
    20: "Rat Race", 21: "Sidewinder", 23: "Wizard",
  };
  var AUDIO_STORAGE = "halo-hosted-audio";
  var BUTTON = { START: 0, A: 1 };

  /* Lobby views drawn as a panel over the game, and those drawn as a bar in
     Halo's own lobby; in a match (and while booting) neither. */
  var PANEL_VIEWS = ["checking", "pick", "joining", "wait-match", "wait-retry", "host-starting"];
  var BAR_VIEWS = ["hosting", "joined"];

  function surfaceFor(view) {
    if (PANEL_VIEWS.indexOf(view) >= 0) return "panel";
    if (BAR_VIEWS.indexOf(view) >= 0) return "bar";
    return "none";
  }

  /* The page's state, without the DOM (tests drive it): the overlay, and the
     sound, kept in the browser. */
  function createController(environment) {
    var storage = environment.storage;
    var audio = { muted: false, volume: 1 };
    try {
      var saved = JSON.parse(storage.getItem(AUDIO_STORAGE));
      if (saved && typeof saved.muted === "boolean") audio.muted = saved.muted;
      if (saved && typeof saved.volume === "number" && saved.volume >= 0 && saved.volume <= 1) audio.volume = saved.volume;
    } catch (error) {
      /* first visit, or storage refused: full volume, sound on */
    }
    /* blocked: the browser refused the mouse (some Discord clients do);
       play goes on without mouse look rather than behind the overlay */
    var state = { presented: false, view: "booting", locked: false, everLocked: false, blocked: false };
    var lock = { requests: 0, successes: 0, failures: 0 };

    function saveAudio() {
      try {
        storage.setItem(AUDIO_STORAGE, JSON.stringify(audio));
      } catch (error) {
        /* (the choice lasts this visit) */
      }
      environment.applyAudio(audio.muted, audio.volume);
    }

    return {
      state: state,
      audio: audio,
      /* In a match: "none", "play" (the mouse never taken yet) or "paused"
         (released: Escape, a switch to another window, a dialog). In Halo's
         lobby the bar is the UI and a click on the game takes the mouse. */
      overlay: function() {
        if (!state.presented || state.view !== "match" || state.locked || state.blocked) return "none";
        return state.everLocked ? "paused" : "play";
      },
      lock: lock,
      lockRequested: function() { lock.requests++; },
      lockFailed: function() {
        lock.failures++;
        state.blocked = true;
        state.everLocked = true;
      },
      /* the overlay again (Escape or the notice's Menu while blocked) */
      showMenu: function() { state.blocked = false; },
      update: function(presented, view) {
        state.presented = !!presented;
        state.view = view;
      },
      pointerLock: function(locked) {
        if (locked && !state.locked) lock.successes++;
        state.locked = !!locked;
        if (locked) {
          state.everLocked = true;
          state.blocked = false;
        }
      },
      setMuted: function(muted) {
        audio.muted = !!muted;
        saveAudio();
      },
      setVolume: function(volume) {
        audio.volume = Math.max(0, Math.min(1, Number(volume) || 0));
        if (audio.volume > 0 && audio.muted) audio.muted = false;
        saveAudio();
      },
      applyAudio: function() { environment.applyAudio(audio.muted, audio.volume); },
    };
  }

  global.HaloHostedUI = { createController: createController, surfaceFor: surfaceFor, MAPS: MAPS, MODES: MODES,
    pointerLock: null };

  var document = global.document;
  if (!document || typeof document.createElement !== "function" || !document.documentElement ||
      !document.documentElement.classList || !document.documentElement.classList.contains("halo-hosted")) {
    return;
  }

  function element(tag, attributes, children) {
    var node = document.createElement(tag);
    Object.keys(attributes || {}).forEach(function(name) {
      if (name === "text") node.textContent = attributes[name];
      else if (name === "hidden") node.hidden = attributes[name];
      else node.setAttribute(name, attributes[name]);
    });
    (children || []).forEach(function(child) { node.appendChild(child); });
    return node;
  }

  function module(name) {
    var fn = global.Module && global.Module["_" + name];
    return typeof fn === "function" ? fn : null;
  }

  var controller = global.HaloHostedUI.controller = createController({
    storage: global.localStorage,
    applyAudio: function(muted, volume) {
      var setVolume = module("platform_web_set_volume");
      if (setVolume) setVolume(volume);
      /* The shell's own state (its script's audioMuted and applyMute), which
         also decides when it resumes the browser's audio. */
      try {
        audioMuted = muted; // eslint-disable-line no-undef
        if (typeof global.applyMute === "function") global.applyMute();
      } catch (error) {
        var set = module("platform_web_set_muted");
        if (set) set(muted ? 1 : 0);
      }
    },
  });

  /* ---------- the DOM */

  var images = {};
  function picture(kind, slug, label) {
    var card = element("span", { class: "hosted-card-label", text: label });
    var image = element("img", { src: "game-ui/" + kind + "/" + slug + ".png", alt: "", draggable: "false" });
    image.addEventListener("error", function() { image.remove(); });
    images[kind + slug] = image;
    return [image, card];
  }

  var mapButtons = MAPS.map(function(map, index) {
    return element("button", { type: "button", class: "hosted-map", "data-index": String(index) },
      picture("maps", map[0], map[1]));
  });
  var modeButtons = MODES.map(function(mode, index) {
    return element("button", { type: "button", class: "hosted-mode", "data-index": String(index) },
      picture("modes", mode[0], mode[1]));
  });
  var picker = element("div", { id: "hosted-picker", hidden: true }, [
    element("div", { class: "hosted-modes", role: "radiogroup", "aria-label": "Game type" }, modeButtons),
    element("div", { class: "hosted-maps", role: "radiogroup", "aria-label": "Map" }, mapButtons),
    element("div", { class: "hosted-actions" }, [
      element("button", { type: "button", id: "hosted-host", class: "primary", text: "Host game" }),
    ]),
  ]);
  var panel = element("section", { id: "hosted-panel", hidden: true, "aria-live": "polite" }, [
    element("h1", { id: "hosted-title" }),
    element("p", { id: "hosted-text" }),
    element("p", { id: "hosted-notice", role: "alert", hidden: true }),
    picker,
    element("button", { type: "button", id: "hosted-share", class: "hosted-link", hidden: true, text: "Copy invite link" }),
  ]);
  var bar = element("div", { id: "hosted-bar", hidden: true }, [
    element("span", { id: "hosted-bar-text" }),
    element("button", { type: "button", id: "hosted-start", class: "primary", hidden: true, text: "Start match" }),
    element("button", { type: "button", id: "hosted-bar-share", hidden: true, text: "Copy invite link" }),
    element("button", { type: "button", id: "hosted-bar-leave", text: "Leave" }),
  ]);
  var overlay = element("section", { id: "hosted-overlay", hidden: true, role: "dialog", "aria-modal": "false",
    "aria-labelledby": "hosted-overlay-title" }, [
    element("div", { class: "hosted-overlay-card" }, [
      element("h2", { id: "hosted-overlay-title", text: "Click to play" }),
      element("button", { type: "button", id: "hosted-resume", class: "primary", text: "Play" }),
      element("div", { class: "hosted-audio" }, [
        element("button", { type: "button", id: "hosted-mute", "aria-pressed": "false", text: "Sound on" }),
        element("input", { type: "range", id: "hosted-volume", min: "0", max: "100", step: "5", "aria-label": "Volume" }),
      ]),
      element("div", { class: "hosted-overlay-actions" }, [
        element("button", { type: "button", id: "hosted-menu", text: "Game menu" }),
        element("button", { type: "button", id: "hosted-leave", text: "Leave game" }),
      ]),
      element("p", { class: "hosted-hint", text: "Esc releases the mouse · F11 full screen · F8 frame cap" }),
    ]),
  ]);
  var mapLoading = element("div", { id: "hosted-map-loading", hidden: true, role: "status" }, [
    element("span", { id: "hosted-map-loading-label" }),
    element("progress", { id: "hosted-map-loading-progress", max: "100", value: "0" }),
  ]);
  var lockNotice = element("div", { id: "hosted-lock-notice", hidden: true, role: "status" }, [
    element("span", { text: "Mouse capture was blocked by this Discord client; fully restart Discord (Quit from the tray) " +
      "and relaunch. Playing without mouse look." }),
    element("button", { type: "button", id: "hosted-lock-retry", text: "Retry" }),
    element("button", { type: "button", id: "hosted-lock-menu", text: "Menu" }),
  ]);
  var root = element("div", { id: "hosted-ui" }, [panel, bar, overlay, mapLoading, lockNotice]);

  function byId(id) { return document.getElementById(id); }

  /* The page's controls keep their keys from the game (SDL listens on window). */
  ["keydown", "keyup", "keypress"].forEach(function(type) {
    root.addEventListener(type, function(event) {
      if (event.key !== "F8" && event.key !== "F11") event.stopPropagation();
    });
  });

  /* Escape is the page's (the browser releases the mouse on it anyway); F11
     is full screen for the frame, which works inside the Activity too. */
  global.addEventListener("keydown", function(event) {
    if (event.key === "Escape" || event.code === "Escape") {
      event.stopImmediatePropagation();
      if (controller.state.blocked && !event.repeat) {
        controller.showMenu();
        render();
      }
    } else if (event.key === "F11" && !event.repeat) {
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleFullscreen();
    }
  }, true);
  global.addEventListener("keyup", function(event) {
    if (event.key === "Escape" || event.code === "Escape" || event.key === "F11") event.stopImmediatePropagation();
  }, true);

  function toggleFullscreen() {
    try {
      var request = document.fullscreenElement ? document.exitFullscreen() :
        document.documentElement.requestFullscreen();
      if (request && typeof request.catch === "function") request.catch(function() {});
    } catch (error) {
      /* not allowed here */
    }
  }

  function reportError(kind, error) {
    try {
      fetch("v1/client-errors", {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: kind,
          name: String(error && error.name || "Error").slice(0, 100),
          message: String(error && error.message || error).slice(0, 300),
          userAgent: String(global.navigator.userAgent || "").slice(0, 400),
          at: new Date().toISOString(),
        }),
      }).catch(function() {});
    } catch (failure) {
      /* best effort */
    }
  }

  /* Takes the mouse. A refusal (the promise, pointerlockerror, or nothing
     within 1.5 s) never leaves the player behind the overlay: it goes, the
     game keeps the keyboard, and a notice explains and offers a retry. */
  var lockAttempt = { pending: false, timer: 0, reported: false };

  function lockFailed(error) {
    if (!lockAttempt.pending) return;
    lockAttempt.pending = false;
    global.clearTimeout(lockAttempt.timer);
    controller.lockFailed();
    if (!lockAttempt.reported) {
      lockAttempt.reported = true;
      reportError("pointer-lock", error);
    }
    focusGame();
    render();
  }

  function focusGame() {
    var canvas = byId("canvas");
    if (!canvas) return;
    try {
      canvas.focus({ preventScroll: true });
    } catch (error) {
      canvas.focus();
    }
  }

  function requestLock() {
    var canvas = byId("canvas");
    focusGame();
    if (!canvas || document.pointerLockElement === canvas) return;
    controller.lockRequested();
    lockAttempt.pending = true;
    global.clearTimeout(lockAttempt.timer);
    lockAttempt.timer = global.setTimeout(function() {
      if (document.pointerLockElement !== canvas) lockFailed(new Error("no pointer lock within 1.5 s"));
    }, 1500);
    try {
      if (typeof canvas.requestPointerLock !== "function") throw new Error("requestPointerLock is unavailable");
      var request = canvas.requestPointerLock();
      if (request && typeof request.then === "function") request.then(null, lockFailed);
    } catch (error) {
      lockFailed(error);
    }
  }

  function play() {
    requestLock();
    controller.applyAudio();
    if (!controller.audio.muted && typeof global.resumeBrowserAudio === "function") global.resumeBrowserAudio();
  }

  function press(button) {
    var fn = module("platform_web_press_button");
    if (fn) fn(button);
  }

  var selected = { map: 0, mode: 0 };
  function select(kind, index) {
    selected[kind] = index;
    (kind === "map" ? mapButtons : modeButtons).forEach(function(button, other) {
      button.setAttribute("aria-checked", String(other === index));
      button.classList.toggle("selected", other === index);
    });
  }
  mapButtons.forEach(function(button, index) {
    button.setAttribute("role", "radio");
    button.addEventListener("click", function() { select("map", index); });
  });
  modeButtons.forEach(function(button, index) {
    button.setAttribute("role", "radio");
    button.addEventListener("click", function() { select("mode", index); });
  });

  function share(url, button) {
    if (!url || !global.navigator.clipboard) return;
    global.navigator.clipboard.writeText(url).then(function() {
      var label = button.textContent;
      button.textContent = "Link copied";
      global.setTimeout(function() { button.textContent = label; }, 1500);
    }, function() {});
  }

  function wire() {
    byId("hosted-host").addEventListener("click", function() {
      if (!global.HaloOnline) return;
      global.HaloOnline.host({ mapIndex: selected.map, modeIndex: selected.mode });
    });
    byId("hosted-resume").addEventListener("click", play);
    byId("hosted-menu").addEventListener("click", function() {
      play();
      global.setTimeout(function() { press(BUTTON.START); }, 100);
    });
    byId("hosted-leave").addEventListener("click", function() {
      if (global.HaloOnline) global.HaloOnline.leave();
    });
    byId("hosted-bar-leave").addEventListener("click", function() {
      if (global.HaloOnline) global.HaloOnline.leave();
    });
    byId("hosted-start").addEventListener("click", function() {
      play();
      press(BUTTON.A);
    });
    byId("hosted-mute").addEventListener("click", function() {
      controller.setMuted(!controller.audio.muted);
      if (!controller.audio.muted && typeof global.resumeBrowserAudio === "function") global.resumeBrowserAudio();
      render();
    });
    byId("hosted-volume").addEventListener("input", function(event) {
      controller.setVolume(Number(event.target.value) / 100);
      render();
    });
    byId("hosted-share").addEventListener("click", function(event) { share(status.shareUrl, event.currentTarget); });
    byId("hosted-bar-share").addEventListener("click", function(event) { share(status.shareUrl, event.currentTarget); });
    var canvas = byId("canvas");
    if (canvas) canvas.addEventListener("click", function() { if (!document.pointerLockElement) play(); });
    document.addEventListener("pointerlockchange", function() {
      var locked = document.pointerLockElement === canvas;
      if (locked) {
        lockAttempt.pending = false;
        global.clearTimeout(lockAttempt.timer);
      }
      controller.pointerLock(locked);
      render();
    });
    document.addEventListener("pointerlockerror", function() {
      lockFailed(new Error("pointerlockerror"));
    });
    byId("hosted-lock-retry").addEventListener("click", play);
    byId("hosted-lock-menu").addEventListener("click", function() {
      controller.showMenu();
      render();
    });
  }

  /* ---------- drawing the state */

  var status = { view: "booting" };
  var audioApplied = false;

  function text(id, value) {
    var node = byId(id);
    if (node && node.textContent !== value) node.textContent = value;
  }

  function show(node, visible) {
    if (node.hidden === visible) node.hidden = !visible;
  }

  function settingsLabel(settings) {
    if (!settings) return "";
    return (MAPS[settings.mapIndex] ? MAPS[settings.mapIndex][1] : "") + " · " +
      (MODES[settings.modeIndex] ? MODES[settings.modeIndex][1] : "");
  }

  function players(count) {
    return count === 1 ? "1 player" : count + " players";
  }

  function render() {
    var gameArea = byId("game-area");
    var presented = !!gameArea && gameArea.dataset.presented === "true";
    status = global.HaloOnline && typeof global.HaloOnline.status === "function" ?
      global.HaloOnline.status() : { view: "booting" };
    if (status.view !== "booting" && !audioApplied && module("platform_web_set_volume")) {
      audioApplied = true;
      controller.applyAudio();
    }
    controller.update(presented, status.view);
    var surface = presented ? surfaceFor(status.view) : "none";
    var host = status.host || "The host";

    show(panel, surface === "panel");
    show(picker, status.view === "pick");
    panel.classList.toggle("picking", status.view === "pick");
    show(byId("hosted-share"), surface === "panel" && status.view === "pick" && !!status.shareUrl);
    var title = "", body = "";
    switch (status.view) {
      case "checking": title = "Halo"; body = "Checking who's here…"; break;
      case "pick": title = "Host a game"; body = "Nobody is hosting yet. Pick a map and game type."; break;
      case "joining": title = "Joining " + host + "…"; body = "Connecting to " + host + "'s lobby."; break;
      case "wait-match": title = host + " is in a match"; body = "You'll join when it ends."; break;
      case "wait-retry": title = "Couldn't join " + host + " yet"; body = "Trying again shortly."; break;
      case "host-starting": title = "Opening your lobby…"; body = settingsLabel(status.settings); break;
    }
    text("hosted-title", title);
    text("hosted-text", body);
    var notice = byId("hosted-notice");
    show(notice, surface === "panel" && !!status.notice);
    text("hosted-notice", status.notice || "");
    if (status.view === "pick" && status.settings && !picker.dataset.restored) {
      picker.dataset.restored = "true";
      select("map", status.settings.mapIndex || 0);
      select("mode", status.settings.modeIndex || 0);
    }

    show(bar, surface === "bar");
    if (status.view === "hosting") {
      text("hosted-bar-text", "Your lobby · " + settingsLabel(status.settings) + " · " + players(status.playerCount || 1));
    } else if (status.view === "joined") {
      text("hosted-bar-text", "In " + host + "'s lobby · waiting for " + host + " to start");
    }
    show(byId("hosted-start"), status.view === "hosting");
    show(byId("hosted-bar-share"), status.view === "hosting" && !!status.shareUrl);
    text("hosted-bar-leave", status.view === "hosting" ? "Close lobby" : "Leave");

    var mode = controller.overlay();
    show(overlay, mode !== "none");
    show(lockNotice, controller.state.blocked && status.view === "match");
    text("hosted-overlay-title", mode === "paused" ? "Paused" : "Click to play");
    text("hosted-resume", mode === "paused" ? "Resume" : "Play");
    show(byId("hosted-menu"), status.view === "match");
    show(byId("hosted-leave"), status.role === "host" || status.role === "guest");
    text("hosted-leave", status.role === "host" ? "End game" : "Leave game");
    var mute = byId("hosted-mute");
    mute.setAttribute("aria-pressed", String(controller.audio.muted));
    text("hosted-mute", controller.audio.muted ? "Sound off" : "Sound on");
    var volume = byId("hosted-volume");
    var percent = String(Math.round(controller.audio.volume * 100));
    if (volume.value !== percent && document.activeElement !== volume) volume.value = percent;

    var progress = module("platform_web_map_load_progress");
    var index = module("platform_web_map_load_index");
    var loading = progress ? progress() : -1;
    var name = index ? MAP_FILES[index()] : null;
    show(mapLoading, presented && loading >= 0 && !!name);
    if (loading >= 0 && name) {
      text("hosted-map-loading-label", "Loading " + name + "…");
      byId("hosted-map-loading-progress").value = Math.round(loading * 100);
    }
  }

  /* (netstats: library_web_transport.js) */
  global.HaloHostedUI.pointerLock = controller.lock;

  function install() {
    document.body.appendChild(root);
    wire();
    select("map", 0);
    select("mode", 0);
    render();
    global.setInterval(render, 200);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})(typeof window !== "undefined" ? window : globalThis);
