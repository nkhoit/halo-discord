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
     Halo's own lobby or over a match's results; in a match (and while
     booting) neither. After a match the host's lobby is a panel again: the
     next match's picker. */
  var PANEL_VIEWS = ["checking", "pick", "joining", "joining-match", "wait-match", "wait-retry", "host-starting"];
  var BAR_VIEWS = ["hosting", "joined", "postgame"];

  function surfaceFor(view, playedMatch) {
    if (view === "hosting" && playedMatch) return "panel";
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

  /* Chrome refuses a new pointer lock for about a second after the player
     left one (Escape): "Pointer lock cannot be acquired immediately after
     the user has exited the lock." That is no refusal to tell anyone about. */
  function isLockCooldown(error) {
    return !!error && error.name === "SecurityError" && /immediately after/i.test(String(error.message || ""));
  }

  /* ---------- Settings: the mouse and the controls

     The page keeps them (localStorage) and sets them in the game as its
     settings input.mouse_sensitivity, input.invert_mouse and input.bindings
     (port/linux/src/xinput_sdl.c): the same the desktop builds read from
     config.toml. Inputs are the game's codes: an SDL scancode (the USB HID
     usage KeyboardEvent.code names), 0x1000 + an SDL mouse button, or
     0x2000 the wheel. */

  var INPUT_STORAGE = "halo-hosted-input";
  var MOUSE_BUTTON = 0x1000;
  var WHEEL = 0x2000;
  var MAXIMUM_BINDINGS = 4;
  var SENSITIVITY = { minimum: 0.1, maximum: 5, fallback: 1 };
  /* in xinput_sdl.c's order (enum input_control), with the web build's
     defaults (input_default_bindings) */
  var CONTROLS = [
    ["move_forward", "Move forward", [26]],
    ["move_back", "Move back", [22]],
    ["move_left", "Strafe left", [4]],
    ["move_right", "Strafe right", [7]],
    ["jump", "Jump", [44, 40, 88]],
    ["melee", "Melee", [9, 42, MOUSE_BUTTON + 4]],
    ["action", "Action / reload", [8, 21]],
    ["switch_weapon", "Switch weapon", [43, WHEEL]],
    ["flashlight", "Flashlight", [20]],
    ["switch_grenade", "Switch grenade", [27]],
    ["grenade", "Throw grenade", [10, MOUSE_BUTTON + 3]],
    ["fire", "Fire", [MOUSE_BUTTON + 1]],
    ["crouch", "Crouch", [6]],
    ["zoom", "Zoom", [29, MOUSE_BUTTON + 2]],
    ["pause", "Pause", [41]],
    ["back", "Back", [58]],
    ["dpad_up", "D-pad up", [82]],
    ["dpad_down", "D-pad down", [81]],
    ["dpad_left", "D-pad left", [80]],
    ["dpad_right", "D-pad right", [79]],
  ].map(function(entry, index) {
    return { id: entry[0], label: entry[1], defaults: entry[2], index: index };
  });

  /* KeyboardEvent.code -> SDL scancode, and what the page calls the key */
  var KEYS = {};
  (function() {
    function key(code, scancode, label) { KEYS[code] = { scancode: scancode, label: label }; }
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").forEach(function(letter, index) { key("Key" + letter, 4 + index, letter); });
    "1234567890".split("").forEach(function(digit, index) { key("Digit" + digit, 30 + index, digit); });
    [["Enter", 40, "Enter"], ["Escape", 41, "Esc"], ["Backspace", 42, "Backspace"], ["Tab", 43, "Tab"],
      ["Space", 44, "Space"], ["Minus", 45, "-"], ["Equal", 46, "="], ["BracketLeft", 47, "["],
      ["BracketRight", 48, "]"], ["Backslash", 49, "\\"], ["Semicolon", 51, ";"], ["Quote", 52, "'"],
      ["Backquote", 53, "`"], ["Comma", 54, ","], ["Period", 55, "."], ["Slash", 56, "/"],
      ["CapsLock", 57, "Caps Lock"], ["PrintScreen", 70, "Print Screen"], ["ScrollLock", 71, "Scroll Lock"],
      ["Pause", 72, "Pause"], ["Insert", 73, "Insert"], ["Home", 74, "Home"], ["PageUp", 75, "Page Up"],
      ["Delete", 76, "Delete"], ["End", 77, "End"], ["PageDown", 78, "Page Down"], ["ArrowRight", 79, "Right"],
      ["ArrowLeft", 80, "Left"], ["ArrowDown", 81, "Down"], ["ArrowUp", 82, "Up"], ["NumLock", 83, "Num Lock"],
      ["NumpadDivide", 84, "Num /"], ["NumpadMultiply", 85, "Num *"], ["NumpadSubtract", 86, "Num -"],
      ["NumpadAdd", 87, "Num +"], ["NumpadEnter", 88, "Num Enter"], ["NumpadDecimal", 99, "Num ."],
      ["IntlBackslash", 100, "\\ (ISO)"], ["ContextMenu", 101, "Menu"],
      ["ControlLeft", 224, "Left Ctrl"], ["ShiftLeft", 225, "Left Shift"], ["AltLeft", 226, "Left Alt"],
      ["MetaLeft", 227, "Left Meta"], ["ControlRight", 228, "Right Ctrl"], ["ShiftRight", 229, "Right Shift"],
      ["AltRight", 230, "Right Alt"], ["MetaRight", 231, "Right Meta"]].forEach(function(entry) {
      key(entry[0], entry[1], entry[2]);
    });
    for (var f = 1; f <= 12; f++) key("F" + f, 57 + f, "F" + f);
    for (var n = 1; n <= 9; n++) key("Numpad" + n, 88 + n, "Num " + n);
    key("Numpad0", 98, "Num 0");
  })();
  var KEY_LABELS = {};
  Object.keys(KEYS).forEach(function(code) { KEY_LABELS[KEYS[code].scancode] = KEYS[code].label; });
  var MOUSE_LABELS = { 1: "Left click", 2: "Middle click", 3: "Right click", 4: "Mouse 4", 5: "Mouse 5" };

  /* Keys the page, the browser or Discord keep: Escape always releases the
     mouse (and opens this menu), F8/F11/F12 are the page's (frame cap, full
     screen, devtools), F5 reloads, backquote opens the game's console, and
     with Ctrl, Alt or Cmd down a key is a browser shortcut (Ctrl+W closes
     the tab, Ctrl+S and Ctrl+D open Save and bookmarks). */
  var RESERVED_KEYS = {
    Escape: "Esc opens this menu", F5: "F5 reloads the page", F8: "F8 is the frame cap",
    F11: "F11 is full screen", F12: "F12 is the page's", Backquote: "` opens the game's console",
    ControlLeft: "Ctrl makes browser shortcuts (Ctrl+W closes the tab)",
    ControlRight: "Ctrl makes browser shortcuts (Ctrl+W closes the tab)",
    MetaLeft: "Cmd/Windows keys belong to the system", MetaRight: "Cmd/Windows keys belong to the system",
    AltLeft: "Alt makes browser shortcuts", AltRight: "Alt makes browser shortcuts",
  };

  function inputLabel(code) {
    if (code === WHEEL) return "Wheel";
    if (code > MOUSE_BUTTON && code <= MOUSE_BUTTON + 5) return MOUSE_LABELS[code - MOUSE_BUTTON];
    return KEY_LABELS[code] || "Key " + code;
  }

  /* what a key, button or wheel turn would bind: { input } or { refused } */
  function inputFromEvent(event) {
    if (!event) return { refused: "Nothing pressed" };
    if (event.type === "wheel") return { input: WHEEL };
    if (event.type === "mousedown" || event.type === "pointerdown") {
      var button = Number(event.button);
      return button >= 0 && button <= 4 ? { input: MOUSE_BUTTON + button + 1 } : { refused: "That button is not supported" };
    }
    var code = String(event.code || "");
    if (RESERVED_KEYS[code]) return { refused: RESERVED_KEYS[code] };
    if (event.ctrlKey || event.metaKey || event.altKey) return { refused: "Combinations with Ctrl, Alt or Cmd belong to the browser" };
    if (!KEYS[code]) return { refused: "That key is not supported" };
    return { input: KEYS[code].scancode };
  }

  function validInput(code) {
    return code === WHEEL || (code > MOUSE_BUTTON && code <= MOUSE_BUTTON + 5) || !!KEY_LABELS[code];
  }

  function clampSensitivity(value) {
    value = Number(value);
    if (!isFinite(value) || value <= 0) return SENSITIVITY.fallback;
    return Math.max(SENSITIVITY.minimum, Math.min(SENSITIVITY.maximum, value));
  }

  /* the slider's 0-1000, logarithmic: 0.1x at the left, 5x at the right */
  function sensitivityFromSlider(position) {
    var t = Math.max(0, Math.min(1000, Number(position) || 0)) / 1000;
    return clampSensitivity(SENSITIVITY.minimum * Math.pow(SENSITIVITY.maximum / SENSITIVITY.minimum, t));
  }
  function sliderFromSensitivity(value) {
    return Math.round(1000 * Math.log(clampSensitivity(value) / SENSITIVITY.minimum) /
      Math.log(SENSITIVITY.maximum / SENSITIVITY.minimum));
  }

  /* The settings, without the DOM (tests drive it). environment: storage,
     and module(name) for the game's exports (none while it loads). */
  function createInputSettings(environment) {
    var settings = { sensitivity: SENSITIVITY.fallback, invert: false, bindings: {} };
    try {
      var saved = JSON.parse(environment.storage.getItem(INPUT_STORAGE));
      if (saved && typeof saved === "object") {
        settings.sensitivity = clampSensitivity(saved.sensitivity);
        settings.invert = saved.invert === true;
        if (saved.bindings && typeof saved.bindings === "object") {
          CONTROLS.forEach(function(control) {
            var inputs = saved.bindings[control.id];
            if (Array.isArray(inputs)) {
              settings.bindings[control.id] = inputs.filter(validInput).slice(0, MAXIMUM_BINDINGS);
            }
          });
        }
      }
    } catch (error) {
      /* first visit, or storage refused: the defaults */
    }

    function save() {
      try {
        environment.storage.setItem(INPUT_STORAGE, JSON.stringify(settings));
      } catch (error) {
        /* (the choice lasts this visit) */
      }
    }

    function inputsOf(id) {
      var control = CONTROLS.filter(function(entry) { return entry.id === id; })[0];
      if (!control) return [];
      return (settings.bindings[id] || control.defaults).slice();
    }

    /* the controls an input drives */
    function controlsOf(input) {
      return CONTROLS.filter(function(control) { return inputsOf(control.id).indexOf(input) >= 0; })
        .map(function(control) { return control.id; });
    }

    function setInputs(id, inputs) {
      var control = CONTROLS.filter(function(entry) { return entry.id === id; })[0];
      if (!control) return;
      var same = inputs.length === control.defaults.length &&
        inputs.every(function(input, index) { return input === control.defaults[index]; });
      if (same) delete settings.bindings[id];
      else settings.bindings[id] = inputs.slice(0, MAXIMUM_BINDINGS);
    }

    function applyBindings() {
      var bind = environment.module("platform_web_bind_input");
      var apply = environment.module("platform_web_apply_input_bindings");
      if (!bind || !apply) return false;
      CONTROLS.forEach(function(control) {
        if (!settings.bindings[control.id]) return;
        var inputs = settings.bindings[control.id].concat([0, 0, 0, 0]);
        bind(control.index, inputs[0], inputs[1], inputs[2], inputs[3]);
      });
      return !!apply();
    }

    function applyMouse() {
      var sensitivity = environment.module("platform_web_set_mouse_sensitivity");
      var invert = environment.module("platform_web_set_invert_mouse");
      if (!sensitivity || !invert) return false;
      sensitivity(settings.sensitivity);
      invert(settings.invert ? 1 : 0);
      return true;
    }

    return {
      settings: settings,
      controls: CONTROLS,
      inputsOf: inputsOf,
      controlsOf: controlsOf,
      /* the inputs that drive more than one control, each with those controls */
      conflicts: function() {
        var seen = {};
        CONTROLS.forEach(function(control) {
          inputsOf(control.id).forEach(function(input) {
            (seen[input] = seen[input] || []).push(control.id);
          });
        });
        var result = {};
        Object.keys(seen).forEach(function(input) { if (seen[input].length > 1) result[input] = seen[input]; });
        return result;
      },
      /* adds an input to a control: { ok, also: the other controls it drives } or { refused } */
      bind: function(id, input) {
        if (!validInput(input)) return { refused: "That input is not supported" };
        var inputs = inputsOf(id);
        if (inputs.indexOf(input) >= 0) return { ok: true, also: [] };
        if (inputs.length >= MAXIMUM_BINDINGS) return { refused: "A control takes up to " + MAXIMUM_BINDINGS + " inputs" };
        var also = controlsOf(input);
        inputs.push(input);
        setInputs(id, inputs);
        save();
        applyBindings();
        return { ok: true, also: also };
      },
      unbind: function(id, input) {
        setInputs(id, inputsOf(id).filter(function(other) { return other !== input; }));
        save();
        applyBindings();
      },
      resetControls: function() {
        settings.bindings = {};
        save();
        /* (nothing staged: every control at its default) */
        applyBindings();
      },
      setSensitivity: function(value) {
        settings.sensitivity = clampSensitivity(value);
        save();
        applyMouse();
      },
      setInvert: function(invert) {
        settings.invert = !!invert;
        save();
        applyMouse();
      },
      resetMouse: function() {
        settings.sensitivity = SENSITIVITY.fallback;
        settings.invert = false;
        save();
        applyMouse();
      },
      /* into the game, once it runs: true when it took them */
      apply: function() { return applyMouse() && applyBindings(); },
    };
  }

  global.HaloHostedUI = { createController: createController, surfaceFor: surfaceFor, MAPS: MAPS, MODES: MODES,
    isLockCooldown: isLockCooldown, pointerLock: null, createInputSettings: createInputSettings,
    inputFromEvent: inputFromEvent, inputLabel: inputLabel, sensitivityFromSlider: sensitivityFromSlider,
    sliderFromSensitivity: sliderFromSensitivity, CONTROLS: CONTROLS };

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

  var inputSettings = global.HaloHostedUI.inputSettings = createInputSettings({
    storage: global.localStorage,
    module: module,
  });
  var DEFAULT_NOTICE = "Click + to add a key or mouse button to a control, or a key to remove it.";
  /* open: the overlay shows Settings; capturing: the control taking the next
     key, mouse button or wheel turn */
  var settingsUi = { open: false, capturing: null, notice: DEFAULT_NOTICE, warning: false, dirty: true,
    swallowClick: false };

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
    element("button", { type: "button", id: "hosted-next", class: "primary", hidden: true, text: "Next match" }),
    element("button", { type: "button", id: "hosted-bar-share", hidden: true, text: "Copy invite link" }),
    element("button", { type: "button", id: "hosted-bar-leave", text: "Leave" }),
  ]);
  var overlay = element("section", { id: "hosted-overlay", hidden: true, role: "dialog", "aria-modal": "false",
    "aria-labelledby": "hosted-overlay-title" }, [
    element("div", { class: "hosted-overlay-card", id: "hosted-overlay-main" }, [
      element("h2", { id: "hosted-overlay-title", text: "Click to play" }),
      element("button", { type: "button", id: "hosted-resume", class: "primary", text: "Play" }),
      element("div", { class: "hosted-audio" }, [
        element("button", { type: "button", id: "hosted-mute", "aria-pressed": "false", text: "Sound on" }),
        element("input", { type: "range", id: "hosted-volume", min: "0", max: "100", step: "5", "aria-label": "Volume" }),
      ]),
      element("div", { class: "hosted-overlay-actions" }, [
        element("button", { type: "button", id: "hosted-menu", text: "Game menu" }),
        element("button", { type: "button", id: "hosted-settings-open", text: "Settings" }),
        element("button", { type: "button", id: "hosted-leave", text: "Leave game" }),
      ]),
      element("p", { class: "hosted-hint", text: "Esc releases the mouse · F11 full screen · F8 frame cap" }),
    ]),
    element("div", { class: "hosted-overlay-card hosted-settings", id: "hosted-settings", hidden: true,
      role: "group", "aria-labelledby": "hosted-settings-title" }, [
      element("h2", { id: "hosted-settings-title", text: "Settings" }),
      element("h3", { text: "Mouse" }),
      element("div", { class: "hosted-sensitivity" }, [
        element("label", { for: "hosted-sensitivity", text: "Sensitivity" }),
        element("input", { type: "range", id: "hosted-sensitivity", min: "0", max: "1000", step: "1" }),
        element("output", { id: "hosted-sensitivity-value", for: "hosted-sensitivity" }),
      ]),
      element("div", { class: "hosted-overlay-actions" }, [
        element("button", { type: "button", id: "hosted-invert", "aria-pressed": "false", text: "Invert look: off" }),
        element("button", { type: "button", id: "hosted-mouse-reset", text: "Reset mouse" }),
      ]),
      element("h3", { text: "Controls" }),
      element("p", { id: "hosted-capture-notice", class: "hosted-capture-notice", role: "status",
        text: "Click + to add a key or mouse button to a control, or a key to remove it." }),
      element("div", { id: "hosted-controls", class: "hosted-controls" }),
      element("div", { class: "hosted-overlay-actions" }, [
        element("button", { type: "button", id: "hosted-controls-reset", text: "Reset controls" }),
        element("button", { type: "button", id: "hosted-settings-back", class: "primary", text: "Back" }),
      ]),
    ]),
  ]);
  var mapLoading = element("div", { id: "hosted-map-loading", hidden: true, role: "status" }, [
    element("span", { id: "hosted-map-loading-label" }),
    element("progress", { id: "hosted-map-loading-progress", max: "100", value: "0" }),
  ]);
  var lockNotice = element("div", { id: "hosted-lock-notice", hidden: true, role: "status" }, [
    element("span", { text: global.HaloActivity || /[?&]frame_id=/.test(String(global.location && global.location.search)) ?
      "Mouse capture was blocked by this Discord client; fully restart Discord (Quit from the tray) " +
        "and relaunch. Playing without mouse look." :
      "The browser refused mouse capture. Playing without mouse look." }),
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
      if (settingsUi.capturing && !event.repeat) {
        stopCapture(DEFAULT_NOTICE, false);
        render();
      } else if (settingsUi.open && !event.repeat) {
        settingsUi.open = false;
        render();
      } else if (controller.state.blocked && !event.repeat) {
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

  /* ---------- Settings: taking a key, mouse button or wheel turn */

  function controlLabel(id) {
    return CONTROLS.filter(function(control) { return control.id === id; })[0].label;
  }

  function stopCapture(notice, warning) {
    settingsUi.capturing = null;
    settingsUi.notice = notice;
    settingsUi.warning = !!warning;
    settingsUi.dirty = true;
  }

  function startCapture(id) {
    settingsUi.capturing = id;
    settingsUi.notice = "Press a key or a mouse button, or turn the wheel, for " + controlLabel(id) + " (Esc cancels)";
    settingsUi.warning = false;
    settingsUi.dirty = true;
    render();
  }

  function captured(event) {
    var id = settingsUi.capturing;
    var result = inputFromEvent(event);
    if (result.refused) {
      settingsUi.notice = result.refused + ". Pick another for " + controlLabel(id) + " (Esc cancels)";
      settingsUi.warning = true;
      render();
      return;
    }
    var bound = inputSettings.bind(id, result.input);
    if (bound.refused) {
      stopCapture(bound.refused + ".", true);
    } else {
      var others = bound.also.filter(function(other) { return other !== id; }).map(controlLabel);
      stopCapture(others.length ?
        inputLabel(result.input) + " now also does " + others.join(", ") + ": both happen when you press it." :
        inputLabel(result.input) + " added to " + controlLabel(id) + ".", others.length > 0);
    }
    render();
  }

  global.addEventListener("keydown", function(event) {
    if (!settingsUi.capturing || event.repeat) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    captured(event);
  }, true);
  global.addEventListener("keyup", function(event) {
    if (settingsUi.capturing) event.stopImmediatePropagation();
  }, true);
  global.addEventListener("mousedown", function(event) {
    if (!settingsUi.capturing) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    /* (a left button's click follows: it must not press what is under it) */
    settingsUi.swallowClick = event.button === 0;
    captured(event);
  }, true);
  global.addEventListener("click", function(event) {
    if (!settingsUi.swallowClick) return;
    settingsUi.swallowClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  global.addEventListener("contextmenu", function(event) {
    if (settingsUi.capturing || settingsUi.swallowClick) event.preventDefault();
  }, true);
  global.addEventListener("wheel", function(event) {
    if (!settingsUi.capturing) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    captured(event);
  }, { capture: true, passive: false });

  function renderControls() {
    var list = byId("hosted-controls");
    if (!list) return;
    var conflicts = inputSettings.conflicts();
    while (list.firstChild) list.removeChild(list.firstChild);
    CONTROLS.forEach(function(control) {
      var inputs = inputSettings.inputsOf(control.id);
      var chips = inputs.map(function(input) {
        var others = (conflicts[input] || []).filter(function(other) { return other !== control.id; });
        var chip = element("button", { type: "button", class: "hosted-chip" + (others.length ? " conflict" : ""),
          "data-control": control.id, "data-input": String(input),
          title: others.length ? "Also " + others.map(controlLabel).join(", ") + " · click to remove" : "Click to remove",
          "aria-label": "Remove " + inputLabel(input) + " from " + control.label, text: inputLabel(input) });
        chip.addEventListener("click", function() {
          inputSettings.unbind(control.id, input);
          stopCapture(inputLabel(input) + " removed from " + control.label + ".", false);
          render();
        });
        return chip;
      });
      var add = element("button", { type: "button", class: "hosted-add" + (settingsUi.capturing === control.id ? " capturing" : ""),
        "data-control": control.id, "aria-label": "Add a key to " + control.label,
        text: settingsUi.capturing === control.id ? "Press…" : "+" });
      add.addEventListener("click", function() { startCapture(control.id); });
      list.appendChild(element("div", { class: "hosted-control", "data-control": control.id }, [
        element("span", { class: "hosted-control-label", text: control.label }),
        element("span", { class: "hosted-chips" }, inputs.length ? chips : [
          element("span", { class: "hosted-unbound", text: "Unbound" })]),
        add,
      ]));
    });
  }

  function renderSettings() {
    var slider = byId("hosted-sensitivity");
    var position = String(sliderFromSensitivity(inputSettings.settings.sensitivity));
    if (slider.value !== position && document.activeElement !== slider) slider.value = position;
    text("hosted-sensitivity-value", inputSettings.settings.sensitivity.toFixed(2) + "×");
    var invert = byId("hosted-invert");
    invert.setAttribute("aria-pressed", String(inputSettings.settings.invert));
    text("hosted-invert", "Invert look: " + (inputSettings.settings.invert ? "on" : "off"));
    var notice = byId("hosted-capture-notice");
    text("hosted-capture-notice", settingsUi.notice);
    notice.classList.toggle("warning", settingsUi.warning);
    if (settingsUi.dirty) {
      settingsUi.dirty = false;
      renderControls();
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
  var lockAttempt = { pending: false, timer: 0, reported: false, retried: false, retryTimer: 0 };
  var LOCK_COOLDOWN_RETRY_MILLISECONDS = 1200;

  function lockFailed(error) {
    if (!lockAttempt.pending) return;
    lockAttempt.pending = false;
    global.clearTimeout(lockAttempt.timer);
    /* (the cooldown after Escape: once more when it is over, still within
    the click's activation; the overlay stays meanwhile) */
    if (isLockCooldown(error) && !lockAttempt.retried) {
      lockAttempt.retried = true;
      global.clearTimeout(lockAttempt.retryTimer);
      lockAttempt.retryTimer = global.setTimeout(requestLock, LOCK_COOLDOWN_RETRY_MILLISECONDS);
      return;
    }
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
    lockAttempt.retried = false;
    global.clearTimeout(lockAttempt.retryTimer);
    requestLock();
    controller.applyAudio();
    if (!controller.audio.muted && typeof global.resumeBrowserAudio === "function") global.resumeBrowserAudio();
  }

  /* (the host) the match starts: Halo's own start request, whatever its lobby
     shows (an older page build without it: A, as on the lobby) */
  function startMatch() {
    if (!global.HaloOnline || typeof global.HaloOnline.startMatch !== "function" || !global.HaloOnline.startMatch()) {
      press(BUTTON.A);
    }
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

  /* (this lobby has played a match: the host picks the next one here) */
  var lobby = { playedMatch: false };

  function wire() {
    byId("hosted-host").addEventListener("click", function() {
      if (!global.HaloOnline) return;
      var settings = { mapIndex: selected.map, modeIndex: selected.mode };
      if (status.view !== "hosting") {
        global.HaloOnline.host(settings);
        return;
      }
      /* the next match: the lobby takes the map and game type, then starts
      (a moment later, once the game has applied them) */
      var current = status.settings || {};
      var changed = current.mapIndex !== settings.mapIndex || current.modeIndex !== settings.modeIndex;
      if (changed && typeof global.HaloOnline.configure === "function") global.HaloOnline.configure(settings);
      lobby.playedMatch = false;
      play();
      startMatch();
      render();
    });
    byId("hosted-next").addEventListener("click", function() { press(BUTTON.A); });
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
      startMatch();
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
    byId("hosted-settings-open").addEventListener("click", function() {
      settingsUi.open = true;
      settingsUi.dirty = true;
      render();
    });
    byId("hosted-settings-back").addEventListener("click", function() {
      settingsUi.open = false;
      stopCapture(DEFAULT_NOTICE, false);
      render();
    });
    byId("hosted-sensitivity").addEventListener("input", function(event) {
      inputSettings.setSensitivity(sensitivityFromSlider(event.target.value));
      render();
    });
    byId("hosted-invert").addEventListener("click", function() {
      inputSettings.setInvert(!inputSettings.settings.invert);
      render();
    });
    byId("hosted-mouse-reset").addEventListener("click", function() {
      inputSettings.resetMouse();
      render();
    });
    byId("hosted-controls-reset").addEventListener("click", function() {
      inputSettings.resetControls();
      stopCapture("Every control is back on its default keys.", false);
      render();
    });
    byId("hosted-lock-menu").addEventListener("click", function() {
      controller.showMenu();
      render();
    });
  }

  /* ---------- drawing the state */

  var status = { view: "booting" };
  var audioApplied = false;
  var inputApplied = false;

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
    if (status.view !== "booting" && !inputApplied && module("platform_web_bind_input")) inputApplied = inputSettings.apply();
    controller.update(presented, status.view);
    if (status.view === "match") lobby.playedMatch = true;
    else if (!status.role) lobby.playedMatch = false;
    var surface = presented ? surfaceFor(status.view, lobby.playedMatch) : "none";
    var host = status.host || "The host";
    var nextMatch = status.view === "hosting" && surface === "panel";
    var picking = status.view === "pick" || nextMatch;

    show(panel, surface === "panel");
    show(picker, picking);
    panel.classList.toggle("picking", picking);
    text("hosted-host", nextMatch ? "Start match" : "Host game");
    show(byId("hosted-share"), surface === "panel" && picking && !!status.shareUrl);
    var title = "", body = "";
    switch (status.view) {
      case "checking": title = "Halo"; body = "Checking who's here…"; break;
      case "pick": title = "Host a game"; body = "Nobody is hosting yet. Pick a map and game type."; break;
      case "joining": title = "Joining " + host + "…"; body = "Connecting to " + host + "'s lobby."; break;
      case "joining-match": title = "Joining " + host + "'s match…"; body = "Loading the match in progress."; break;
      case "wait-match": title = host + " is in a match"; body = "You'll join as soon as it lets you in."; break;
      case "wait-retry": title = "Couldn't join " + host + " yet"; body = "Trying again shortly."; break;
      case "host-starting": title = "Opening your lobby…"; body = settingsLabel(status.settings); break;
      case "hosting":
        title = "Next match";
        body = "Pick a map and game type for everyone in your lobby (" + players(status.playerCount || 1) + ").";
        break;
    }
    text("hosted-title", title);
    text("hosted-text", body);
    var notice = byId("hosted-notice");
    show(notice, surface === "panel" && !!status.notice);
    text("hosted-notice", status.notice || "");
    /* (the last choice preselected: on first showing, and for each next match) */
    var pickerKey = picking ? status.view : "";
    if (picking && status.settings && picker.dataset.restored !== pickerKey) {
      select("map", status.settings.mapIndex || 0);
      select("mode", status.settings.modeIndex || 0);
    }
    picker.dataset.restored = pickerKey;

    show(bar, surface === "bar");
    if (status.view === "hosting") {
      text("hosted-bar-text", "Your lobby · " + settingsLabel(status.settings) + " · " + players(status.playerCount || 1));
    } else if (status.view === "joined") {
      text("hosted-bar-text", lobby.playedMatch ? "Waiting for " + host + " to pick the next match…" :
        "In " + host + "'s lobby · waiting for " + host + " to start");
    } else if (status.view === "postgame") {
      text("hosted-bar-text", status.role === "host" ? "Match over" : "Match over · waiting for " + host);
    }
    show(byId("hosted-start"), status.view === "hosting");
    show(byId("hosted-next"), status.view === "postgame" && status.role === "host");
    show(byId("hosted-bar-share"), status.view === "hosting" && !!status.shareUrl);
    text("hosted-bar-leave", status.view === "hosting" ? "Close lobby" : "Leave");

    var mode = controller.overlay();
    show(overlay, mode !== "none");
    if (mode === "none" && (settingsUi.open || settingsUi.capturing)) {
      settingsUi.open = false;
      stopCapture(DEFAULT_NOTICE, false);
    }
    show(byId("hosted-overlay-main"), !settingsUi.open);
    show(byId("hosted-settings"), settingsUi.open);
    if (settingsUi.open) renderSettings();
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
