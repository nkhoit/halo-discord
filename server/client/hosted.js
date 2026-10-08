/* The hosted page's own UI (the Discord Activity and the browser page this
   server serves; upstream's shell stays as it is for local development).
   The game fills the frame. Over it: a loading screen, the lobby (the host
   picks a map and mode; everyone else joins the host by themselves), a bar
   in Halo's own lobby, and an overlay whenever the game does not have the
   mouse: click to play, sound, Halo's menu, and (the host) end the match
   or close the room.

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
  /* Team variants (player_ui.c's team_slayer and ctf). Used only when the
     engine has not said whether this match has teams. */
  var TEAM_MODES = { 1: true, 2: true };
  /* platform_web_map_load_index(): web_platform.c's map_files order */
  var MAP_FILES = {
    10: "Battle Creek", 11: "Blood Gulch", 12: "Boarding Action", 13: "Derelict", 14: "Chill Out",
    15: "Damnation", 16: "Hang 'Em High", 17: "Longest", 18: "Prisoner", 19: "Chiron TL-34",
    20: "Rat Race", 21: "Sidewinder", 23: "Wizard",
  };
  var AUDIO_STORAGE = "halo-hosted-audio";
  /* the sound at first: half volume */
  var DEFAULT_VOLUME = 0.5;
  /* the stored record's form: 2 says whether the player chose the volume */
  var AUDIO_VERSION = 2;
  var BUTTON = { START: 0, A: 1 };

  /* Lobby views drawn as a panel over the game, and those drawn as a bar in
     Halo's own lobby or over a match's results; in a match (and while
     booting) neither. After a match the host's lobby is a panel again: the
     next match's picker. */
  var PANEL_VIEWS = ["checking", "pick", "joining", "joining-match", "wait-match", "wait-retry", "host-starting"];
  var BAR_VIEWS = ["hosting", "joined", "postgame"];
  /* (a spectator stays in the room through these) */
  var WATCHED_VIEWS = ["spectating", "match", "joined", "postgame"];

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
    var audio = { muted: false, volume: DEFAULT_VOLUME };
    /* whether the player set the volume (the slider), rather than only
       muting at the default */
    var volumeChosen = false;
    try {
      var saved = JSON.parse(storage.getItem(AUDIO_STORAGE));
      if (saved && typeof saved.muted === "boolean") audio.muted = saved.muted;
      if (saved && typeof saved.volume === "number" && saved.volume >= 0 && saved.volume <= 1) {
        /* (a record from before the default was halved, saved by the mute
        button, has the old default; only a volume the player chose stays) */
        volumeChosen = saved.version >= AUDIO_VERSION ? saved.volumeChosen === true : saved.volume !== 1;
        if (volumeChosen) audio.volume = saved.volume;
      }
    } catch (error) {
      /* first visit, or storage refused: half volume, sound on */
    }
    /* blocked: the browser refused the mouse (some Discord clients do);
       play goes on without mouse look rather than behind the overlay */
    var state = { presented: false, view: "booting", locked: false, everLocked: false, blocked: false,
      spectateMenu: false, watched: false };
    var lock = { requests: 0, successes: 0, failures: 0 };

    function saveAudio() {
      try {
        storage.setItem(AUDIO_STORAGE, JSON.stringify({
          version: AUDIO_VERSION, muted: audio.muted, volume: audio.volume, volumeChosen: volumeChosen,
        }));
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
        /* (a spectator, #52: the mouse stays free, clicks pick whom to watch;
           its menu offers Join, and comes back on Escape) */
        if (state.view === "spectating") return state.presented && state.spectateMenu ? "spectate" : "none";
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
        /* (first watching a match in this room: its menu, Join or Spectate;
           the next matches only on Escape, the lobby's bar has Join) */
        if (view === "spectating" && !state.watched) {
          state.spectateMenu = true;
          state.watched = true;
        } else if (WATCHED_VIEWS.indexOf(view) < 0) {
          state.watched = false;
        }
        state.view = view;
      },
      spectateMenu: function(open) { state.spectateMenu = !!open; },
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
        volumeChosen = true;
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
  /* The Discord Activity's defaults where they differ: Crouch on Left Ctrl
     too, as in the desktop builds (Discord has no tab for Ctrl+W to close).
     The page sets them through input.bindings; the game keeps its web
     defaults. */
  var ACTIVITY_DEFAULTS = { crouch: [224, 6] };

  function defaultsOf(control, activity) {
    return (activity && ACTIVITY_DEFAULTS[control.id] || control.defaults).slice();
  }

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

  /* what a key, button or wheel turn would bind: { input } or { refused }. In
     the Discord Activity, Ctrl alone binds; combinations never do. */
  function inputFromEvent(event, activity) {
    if (!event) return { refused: "Nothing pressed" };
    if (event.type === "wheel") return { input: WHEEL };
    if (event.type === "mousedown" || event.type === "pointerdown") {
      var button = Number(event.button);
      return button >= 0 && button <= 4 ? { input: MOUSE_BUTTON + button + 1 } : { refused: "That button is not supported" };
    }
    var code = String(event.code || "");
    if (activity && (code === "ControlLeft" || code === "ControlRight") && !event.metaKey && !event.altKey) {
      return { input: KEYS[code].scancode };
    }
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
     module(name) for the game's exports (none while it loads), and
     activity() (true in the Discord Activity: its defaults). A control's
     inputs are stored only while they differ from the page's defaults, so a
     player who never changed one follows the defaults of where they play. */
  function createInputSettings(environment) {
    var settings = { sensitivity: SENSITIVITY.fallback, invert: false, bindings: {} };
    function activity() { return !!(environment.activity && environment.activity()); }
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
      return (settings.bindings[id] || defaultsOf(control, activity())).slice();
    }

    /* the controls an input drives */
    function controlsOf(input) {
      return CONTROLS.filter(function(control) { return inputsOf(control.id).indexOf(input) >= 0; })
        .map(function(control) { return control.id; });
    }

    function setInputs(id, inputs) {
      var control = CONTROLS.filter(function(entry) { return entry.id === id; })[0];
      if (!control) return;
      var defaults = defaultsOf(control, activity());
      var same = inputs.length === defaults.length &&
        inputs.every(function(input, index) { return input === defaults[index]; });
      if (same) delete settings.bindings[id];
      else settings.bindings[id] = inputs.slice(0, MAXIMUM_BINDINGS);
    }

    function applyBindings() {
      var bind = environment.module("platform_web_bind_input");
      var apply = environment.module("platform_web_apply_input_bindings");
      if (!bind || !apply) return false;
      CONTROLS.forEach(function(control) {
        /* (the game has its web defaults: stage what differs from them) */
        var inputs = settings.bindings[control.id] ||
          (activity() && ACTIVITY_DEFAULTS[control.id] ? defaultsOf(control, true) : null);
        if (!inputs) return;
        inputs = inputs.concat([0, 0, 0, 0]);
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

  /* ---------- the start-up report

     When each stage of this page's start-up was reached, in milliseconds from
     the navigation (POST v1/client-boot, logged by the server as "boot"), so
     a launch that hangs or is slow can be read from the server's log. The
     scripts that see a stage queue it on window.HaloBootEvents as [name,
     performance.now(), detail]: the shell (its page_loaded,
     runtime_initialized, renderer_ready and game_presented telemetry, and
     its failures), activity.js and the login script (sdk-ready, signed-in,
     halo-js), storage_lock.js (storage) and the relay transport (relay);
     this page adds menu (Halo's main menu has loaded) and shown (the lobby or
     the room shows, over the game's first frames: the page shows nothing
     before). One report when shown; a "stalled" one when no stage
     has advanced for BOOT_STALL_MILLISECONDS (once a stage, at most
     BOOT_MAXIMUM_STALLS); a "failed" one when start-up gives up; an "unload"
     one, by beacon, if the page goes before any of those. */
  var BOOT_STALL_MILLISECONDS = 30000;
  var BOOT_MAXIMUM_STALLS = 3;
  var BOOT_MAXIMUM_LINES = 6;
  var BOOT_SHOWN_VIEWS = ["pick", "hosting", "joined", "match", "spectating", "postgame"];
  var BOOT_SHELL_STAGES = {
    page_loaded: "page", runtime_initialized: "runtime", renderer_ready: "renderer", game_presented: "presented",
  };
  var BOOT_SHELL_FAILURES = { runtime_error: "runtime-error", runtime_abort: "runtime-abort" };
  var BOOT_STAGE = /^[a-z][a-z0-9-]{0,23}$/;
  var BOOT_LINE = /error|fail|abort|exception|could not|cannot|unable|refused|denied|timed? ?out/i;
  var BOOT_SHADERS = /built (\d+) programs ahead for \S+ in (\d+) ms/;

  /* a console line for a report: no addresses, nothing quoted (player names
     are), no control characters, short */
  function bootLine(text) {
    return String(text).replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
      .replace(/(["'`])[^"'`]{0,120}\1/g, "$1…$1")
      .replace(/\s+/g, " ").trim().slice(0, 200);
  }

  /* environment: now() (milliseconds from the navigation), send(report,
     beacon), context() ("activity" or "page"), build() (the page's asset
     version), resources() (halo.js and halo.wasm: { js, wasm }, each
     { ms, cached, kb }), isolated */
  function createBootRecorder(environment) {
    var stages = {};
    var latest = 0;
    var latestStage = "start";
    var storage = null;
    var shaders = null;
    var lines = [];
    var ended = false;
    var hidden = false;
    var stalls = 0;
    var stalledAt = null;

    function stage(name, at) {
      if (ended || Object.prototype.hasOwnProperty.call(stages, name)) return;
      var time = typeof at === "number" && isFinite(at) ? at : environment.now();
      stages[name] = Math.max(0, Math.round(time));
      if (time >= latest) {
        latest = time;
        latestStage = name;
      }
    }

    function stuck() {
      return { stuck: latestStage, stuckMs: Math.round(Math.max(0, environment.now() - latest)), lines: lines.slice() };
    }

    function report(kind, extra) {
      var body = {
        kind: kind,
        context: environment.context(),
        build: environment.build() || null,
        elapsedMs: Math.round(environment.now()),
        stages: {},
      };
      Object.keys(stages).forEach(function(name) { body.stages[name] = stages[name]; });
      var resources = environment.resources ? environment.resources() : {};
      if (resources.js) body.js = resources.js;
      if (resources.wasm) body.wasm = resources.wasm;
      if (storage) body.storage = storage;
      if (shaders) body.shaders = shaders;
      body.isolated = !!environment.isolated;
      body.hidden = hidden;
      Object.keys(extra || {}).forEach(function(key) { body[key] = extra[key]; });
      environment.send(body, kind === "unload");
    }

    function fail(reason, at) {
      if (ended) return;
      var where = stuck();
      stage("failed", at);
      ended = true;
      where.reason = BOOT_STAGE.test(reason) ? reason : "unknown";
      report("failed", where);
    }

    return {
      /* a queued [name, time, detail] */
      event: function(entry) {
        if (!entry || typeof entry[0] !== "string") return;
        var name = entry[0];
        if (BOOT_SHELL_STAGES[name]) stage(BOOT_SHELL_STAGES[name], entry[1]);
        else if (BOOT_SHELL_FAILURES[name]) fail(BOOT_SHELL_FAILURES[name], entry[1]);
        else if (name === "failed") fail(typeof entry[2] === "string" ? entry[2] : "unknown", entry[1]);
        else if (BOOT_STAGE.test(name)) {
          if (name === "storage" && entry[2] && typeof entry[2] === "object") {
            storage = { mode: entry[2].mode, lock: entry[2].lock };
          }
          stage(name, entry[1]);
        }
      },
      /* Halo's main menu has loaded */
      menu: function() { stage("menu"); },
      /* the page's view (HaloOnline.status()), and whether the game shows:
         the lobby or the room over it ends the start */
      view: function(name, presented) {
        if (ended || !presented || BOOT_SHOWN_VIEWS.indexOf(name) < 0) return;
        stage("shown");
        ended = true;
        report("done", { view: name });
      },
      /* a console warning or error: the shaders built ahead, and lines that
         say something failed (the last few go with a stalled report) */
      line: function(level, text) {
        var built = BOOT_SHADERS.exec(text);
        if (built && !ended) {
          shaders = shaders || { count: 0, ms: 0 };
          shaders.count += Number(built[1]);
          shaders.ms += Number(built[2]);
          return;
        }
        if (ended || (level !== "warn" && level !== "error") || !BOOT_LINE.test(text)) return;
        lines.push(bootLine(text));
        if (lines.length > BOOT_MAXIMUM_LINES) lines.shift();
      },
      hide: function() { hidden = true; },
      /* (every so often) a stage that has not advanced for too long */
      check: function() {
        if (ended || stalls >= BOOT_MAXIMUM_STALLS || stalledAt === latestStage ||
            environment.now() - latest < BOOT_STALL_MILLISECONDS) {
          return;
        }
        stalls++;
        stalledAt = latestStage;
        report("stalled", stuck());
      },
      /* the page goes before the start ended */
      pagehide: function() {
        if (ended) return;
        ended = true;
        report("unload", stuck());
      },
      stages: function() { return Object.assign({}, stages); },
    };
  }
  global.HaloHostedUI = { createController: createController, surfaceFor: surfaceFor, MAPS: MAPS, MODES: MODES,
    isLockCooldown: isLockCooldown, pointerLock: null, createInputSettings: createInputSettings,
    inputFromEvent: inputFromEvent, inputLabel: inputLabel, sensitivityFromSlider: sensitivityFromSlider,
    sliderFromSensitivity: sliderFromSensitivity, CONTROLS: CONTROLS, ACTIVITY_DEFAULTS: ACTIVITY_DEFAULTS,
    createBootRecorder: createBootRecorder };

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

  /* The Discord Activity's page (asked late: its meta follows this script) */
  function activityPage() {
    var location = global.location || {};
    return !!(global.HaloActivity || document.querySelector('meta[name="halo-activity"]') ||
      /[?&]frame_id=/.test(String(location.search || "")) || /^\/activity(\/|$)/.test(String(location.pathname || "")));
  }

  var inputSettings = global.HaloHostedUI.inputSettings = createInputSettings({
    storage: global.localStorage,
    module: module,
    activity: activityPage,
  });
  var DEFAULT_NOTICE = "Click + to add a key or mouse button to a control, or a key to remove it.";
  /* open: the overlay shows Settings; capturing: the control taking the next
     key, mouse button or wheel turn */
  var settingsUi = { open: false, capturing: null, notice: DEFAULT_NOTICE, warning: false, dirty: true,
    swallowClick: false };
  /* (the host) End match asks first: it ends the match for everyone */
  var endConfirm = false;

  /* The pictures need the session cookie, which the Activity only has once
     activity.js has signed in, after this script has run: so they load when
     the picker first shows (after sign-in on both pages). A failed picture
     gets one more try a little later before only its label remains. */
  var PICTURE_RETRY_MILLISECONDS = 3000;
  var images = {};
  var picturesRequested = false;
  function picture(kind, slug, label) {
    var card = element("span", { class: "hosted-card-label", text: label });
    var image = element("img", { alt: "", draggable: "false" });
    var source = "game-ui/" + kind + "/" + slug + ".png";
    var retried = false;
    image.addEventListener("error", function() {
      if (retried) {
        image.remove();
        return;
      }
      retried = true;
      global.setTimeout(function() { image.setAttribute("src", source); }, PICTURE_RETRY_MILLISECONDS);
    });
    images[kind + slug] = { image: image, source: source };
    return [image, card];
  }

  function requestPictures() {
    if (picturesRequested) return;
    picturesRequested = true;
    Object.keys(images).forEach(function(key) { images[key].image.setAttribute("src", images[key].source); });
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
    element("section", { id: "hosted-guild", hidden: true, "aria-labelledby": "hosted-guild-title" }, [
      element("h2", { id: "hosted-guild-title", text: "Matches in this server" }),
      element("ul", { id: "hosted-guild-list" }),
    ]),
    picker,
    element("button", { type: "button", id: "hosted-share", class: "hosted-link", hidden: true, text: "Copy invite link" }),
  ]);
  var bar = element("div", { id: "hosted-bar", hidden: true }, [
    element("span", { id: "hosted-bar-text" }),
    element("button", { type: "button", id: "hosted-start", class: "primary", hidden: true, text: "Start match" }),
    element("button", { type: "button", id: "hosted-next", class: "primary", hidden: true, text: "Next match" }),
    element("button", { type: "button", id: "hosted-bar-join", class: "primary", hidden: true, text: "Join" }),
    element("button", { type: "button", id: "hosted-bar-share", hidden: true, text: "Copy invite link" }),
    element("button", { type: "button", id: "hosted-bar-leave", text: "Leave" }),
  ]);
  /* Red / blue for a team game. Clicks move this machine; the engine keeps
     the auto-balance until someone picks, and tells every lobby. */
  var teamBoard = element("div", { id: "hosted-teams", hidden: true, role: "group", "aria-label": "Teams" }, [
    element("div", { class: "hosted-team red" }, [
      element("button", { type: "button", class: "hosted-team-header", "data-team": "0", text: "Red" }),
      element("ul", { id: "hosted-team-red", class: "hosted-team-players" }),
    ]),
    element("div", { class: "hosted-team blue" }, [
      element("button", { type: "button", class: "hosted-team-header", "data-team": "1", text: "Blue" }),
      element("ul", { id: "hosted-team-blue", class: "hosted-team-players" }),
    ]),
  ]);
  var overlay = element("section", { id: "hosted-overlay", hidden: true, role: "dialog", "aria-modal": "false",
    "aria-labelledby": "hosted-overlay-title" }, [
    element("div", { class: "hosted-overlay-card", id: "hosted-overlay-main" }, [
      element("h2", { id: "hosted-overlay-title", text: "Click to play" }),
      element("p", { id: "hosted-overlay-text", hidden: true }),
      element("button", { type: "button", id: "hosted-spectate-join", class: "primary", hidden: true, text: "Join" }),
      element("button", { type: "button", id: "hosted-resume", class: "primary", text: "Play" }),
      element("div", { class: "hosted-audio" }, [
        element("button", { type: "button", id: "hosted-mute", "aria-pressed": "false", text: "Sound on" }),
        element("input", { type: "range", id: "hosted-volume", min: "0", max: "100", step: "5", "aria-label": "Volume" }),
      ]),
      element("div", { class: "hosted-overlay-actions" }, [
        element("button", { type: "button", id: "hosted-menu", text: "Game menu" }),
        element("button", { type: "button", id: "hosted-end-match", hidden: true, text: "End match" }),
        element("button", { type: "button", id: "hosted-settings-open", text: "Settings" }),
        element("button", { type: "button", id: "hosted-leave", text: "Leave game" }),
      ]),
      element("div", { id: "hosted-end-confirm", hidden: true, role: "group",
        "aria-labelledby": "hosted-end-confirm-text" }, [
        element("p", { id: "hosted-end-confirm-text", text: "End the match for everyone?" }),
        element("div", { class: "hosted-overlay-actions" }, [
          element("button", { type: "button", id: "hosted-end-cancel", text: "Cancel" }),
          element("button", { type: "button", id: "hosted-end-confirm-yes", text: "End match" }),
        ]),
      ]),
      element("p", { id: "hosted-overlay-hint", class: "hosted-hint" }),
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
  var spectateLabel = element("div", { id: "hosted-spectate", hidden: true, role: "status" }, [
    element("span", { id: "hosted-spectate-name" }),
    element("span", { class: "hosted-hint", text: "Click: next player · Right-click: previous · Esc: menu" }),
  ]);
  var lockNotice = element("div", { id: "hosted-lock-notice", hidden: true, role: "status" }, [
    element("span", { text: activityPage() ?
      "Mouse capture was blocked by this Discord client; fully restart Discord (Quit from the tray) " +
        "and relaunch. Playing without mouse look." :
      "The browser refused mouse capture. Playing without mouse look." }),
    element("button", { type: "button", id: "hosted-lock-retry", text: "Retry" }),
    element("button", { type: "button", id: "hosted-lock-menu", text: "Menu" }),
  ]);
  var root = element("div", { id: "hosted-ui" }, [panel, bar, teamBoard, overlay, mapLoading, spectateLabel, lockNotice]);

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
      } else if (endConfirm && !event.repeat) {
        endConfirm = false;
        render();
      } else if (controller.state.blocked && !event.repeat) {
        controller.showMenu();
        render();
      } else if (status.view === "spectating" && !event.repeat) {
        controller.spectateMenu(!controller.state.spectateMenu);
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
  /* (the Activity, the game holding the mouse, or played without it after
     a refused capture) Ctrl crouches there, so no Ctrl combination may do
     anything in the frame. The game still sees the keys. On Windows,
     Discord's menu accelerators (Ctrl+R reloads Discord, Ctrl+Q quits it)
     run only for keys the page leaves unhandled. */
  global.addEventListener("keydown", function(event) {
    if (event.ctrlKey && (document.pointerLockElement || controller.state.blocked) && activityPage()) {
      event.preventDefault();
    }
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
    var result = inputFromEvent(event, activityPage());
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

  function resumeAudio() {
    controller.applyAudio();
    if (!controller.audio.muted && typeof global.resumeBrowserAudio === "function") global.resumeBrowserAudio();
  }

  function play() {
    lockAttempt.retried = false;
    global.clearTimeout(lockAttempt.retryTimer);
    requestLock();
    resumeAudio();
  }

  /* (a spectator) its player joins the match (or its lobby's next one): from
     then on it plays as everyone does */
  function spectatorJoin() {
    if (!global.HaloOnline || typeof global.HaloOnline.spectatorJoin !== "function") return;
    controller.spectateMenu(false);
    if (global.HaloOnline.spectatorJoin() && status.view === "spectating") play();
    else resumeAudio();
    render();
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
    byId("hosted-resume").addEventListener("click", function() {
      endConfirm = false;
      if (status.view !== "spectating") {
        render();
        play();
        return;
      }
      controller.spectateMenu(false);
      resumeAudio();
      render();
    });
    byId("hosted-spectate-join").addEventListener("click", spectatorJoin);
    byId("hosted-bar-join").addEventListener("click", spectatorJoin);
    byId("hosted-menu").addEventListener("click", function() {
      endConfirm = false;
      render();
      play();
      global.setTimeout(function() { press(BUTTON.START); }, 100);
    });
    byId("hosted-end-match").addEventListener("click", function() {
      endConfirm = true;
      render();
    });
    byId("hosted-end-cancel").addEventListener("click", function() {
      endConfirm = false;
      render();
    });
    byId("hosted-end-confirm-yes").addEventListener("click", function() {
      endConfirm = false;
      if (global.HaloOnline && typeof global.HaloOnline.endMatch === "function") global.HaloOnline.endMatch();
      render();
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
    Array.prototype.forEach.call(teamBoard.querySelectorAll(".hosted-team-header"), function(header) {
      header.addEventListener("click", function() {
        if (header.disabled) return;
        setTeam(Number(header.getAttribute("data-team")));
      });
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
    if (canvas) {
      canvas.addEventListener("click", function() {
        if (status.view !== "spectating" && !document.pointerLockElement) play();
      });
      /* (a spectator) left: the next player, right: the previous */
      canvas.addEventListener("mousedown", function(event) {
        if (status.view !== "spectating" || (event.button !== 0 && event.button !== 2)) return;
        if (global.HaloOnline && typeof global.HaloOnline.spectateCycle === "function") {
          global.HaloOnline.spectateCycle(event.button === 2 ? -1 : 1);
        }
        resumeAudio();
        render();
      });
      canvas.addEventListener("contextmenu", function(event) {
        if (status.view === "spectating") event.preventDefault();
      });
    }
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
      endConfirm = false;
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
  /* (this page picks the next match: Halo's host goes from its results to its
     lobby, not to its own map select) */
  var pickerDeclared = false;

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

  /* The engine's roster when it has one. Otherwise a team mode still shows
     the columns (empty until players arrive); a free-for-all shows nothing. */
  function teamStatus(current) {
    if (current.teams && typeof current.teams.enabled === "boolean") {
      return current.teams.enabled ? current.teams : null;
    }
    var mode = current.settings && current.settings.modeIndex;
    if (!TEAM_MODES[mode]) return null;
    return { enabled: true, pregame: current.view === "hosting" || current.view === "joined", players: [] };
  }

  /* bar: Halo's lobby and the results. panel: the host picking the next match.
     overlay: the match's Esc menu. Never over the match itself, the mouse in
     the game. */
  function teamPlace(current, surface) {
    if (!current.role) return null;
    if (surface === "bar") return "bar";
    if (current.view === "hosting" && surface === "panel") return "panel";
    if ((current.view === "match" || current.view === "spectating") && controller.overlay() !== "none") {
      return "overlay";
    }
    return null;
  }

  function setTeam(team) {
    if (!global.HaloOnline || typeof global.HaloOnline.setTeam !== "function") return false;
    return !!global.HaloOnline.setTeam(team);
  }

  function teamColumn(list, team) {
    return (list || []).filter(function(player) { return player && player.team === team; })
      .sort(function(left, right) {
        if (!!left.self !== !!right.self) return left.self ? -1 : 1;
        return String(left.name || "").localeCompare(String(right.name || ""));
      });
  }

  function fillTeamList(list, team, players, interactive, allowedOther) {
    while (list.firstChild) list.removeChild(list.firstChild);
    teamColumn(players, team).forEach(function(player) {
      var self = !!player.self;
      var other = team === 0 ? 1 : 0;
      var control = self && interactive && (allowedOther === undefined || allowedOther);
      var name = player.name || "Player";
      var node = element(control ? "button" : "span", {
        class: "hosted-team-player" + (self ? " self" : ""),
        text: name,
      });
      if (self) node.setAttribute("data-self", "true");
      if (control) {
        node.type = "button";
        node.setAttribute("data-team", String(team));
        node.setAttribute("aria-label", "Switch " + name + " to " + (team === 0 ? "Blue" : "Red"));
        node.addEventListener("click", function() { setTeam(other); });
      }
      list.appendChild(element("li", {}, [node]));
    });
  }

  function placeTeamBoard(place) {
    var parent = root;
    if (place === "bar") parent = bar;
    else if (place === "panel") parent = panel;
    else if (place === "overlay") parent = byId("hosted-overlay-main");
    if (parent && teamBoard.parentNode !== parent) parent.appendChild(teamBoard);
  }

  function renderTeams(current, surface) {
    var teams = teamStatus(current);
    var place = teams ? teamPlace(current, surface) : null;
    show(teamBoard, !!place);
    if (!place) return;
    placeTeamBoard(place);
    var midMatch = !!(teams.canSwitch && place === "overlay" && !current.spectating);
    var interactive = !current.spectating && (
      (teams.pregame && (place === "bar" || place === "panel")) || midMatch);
    var allowed = teams.allowed || { 0: true, 1: true };
    if (teams.pregame) allowed = { 0: true, 1: true };
    teamBoard.setAttribute("data-interactive", interactive ? "true" : "false");
    Array.prototype.forEach.call(teamBoard.querySelectorAll(".hosted-team-header"), function(header) {
      var team = Number(header.getAttribute("data-team"));
      header.disabled = !interactive || (midMatch && !allowed[team]);
    });
    var listed = teams.players || [];
    var key = JSON.stringify({ place: place, interactive: interactive, allowed: allowed, players: listed });
    if (teamBoard.dataset.key === key) return;
    teamBoard.dataset.key = key;
    fillTeamList(byId("hosted-team-red"), 0, listed, interactive, midMatch ? allowed[1] : undefined);
    fillTeamList(byId("hosted-team-blue"), 1, listed, interactive, midMatch ? allowed[0] : undefined);
  }

  /* ---------- the server-wide lobby (the Discord Activity): the matches
     hosted from the server's other voice channels, polled while nobody
     hosts here and the picker shows */
  var GUILD_POLL_MILLISECONDS = 4000;
  var GUILD_STATES = { lobby: "In lobby", starting: "Starting", match: "In match", postgame: "Match over" };
  var GUILD_REASONS = { full: "Full", version: "Different version", match: "Can't join now" };
  var guildList = { polling: false, timer: 0, generation: 0, rooms: [], key: "" };

  function guildRoomLabel(room) {
    var map = MAPS[room.map] ? MAPS[room.map][1] : null;
    var mode = MODES[room.mode] ? MODES[room.mode][1] : null;
    return [map, mode].filter(Boolean).join(" · ");
  }

  function renderGuildRooms() {
    var key = JSON.stringify(guildList.rooms);
    if (key === guildList.key) return;
    guildList.key = key;
    var list = byId("hosted-guild-list");
    while (list.firstChild) list.removeChild(list.firstChild);
    guildList.rooms.forEach(function(room) {
      /* (a running match is watched first, #52: Join adds the player there) */
      var watch = room.state === "match" && (room.joinable || room.watchable);
      var reason = room.joinable || watch ? null : (GUILD_REASONS[room.reason] || "Can't join now");
      var join = element("button", { type: "button", class: "hosted-guild-join" + (reason ? "" : " primary"),
        text: reason || (watch ? "Watch" : "Join") });
      join.disabled = !!reason;
      if (reason) join.title = reason;
      join.addEventListener("click", function() {
        if (global.HaloOnline && global.HaloOnline.joinGuildRoom(room)) {
          stopGuildPoll();
          render();
        }
      });
      list.appendChild(element("li", { class: "hosted-guild-room", "data-room": String(room.roomId) }, [
        element("span", { class: "hosted-guild-host",
          text: String(room.host || "Someone") + (room.channel ? " · " + room.channel : "") }),
        element("span", { class: "hosted-guild-what", text: guildRoomLabel(room) }),
        element("span", { class: "hosted-guild-players", text: (room.players || 0) + "/" + (room.capacity || 64) +
          (room.spectators ? " · " + room.spectators + " watching" : "") }),
        element("span", { class: "hosted-guild-state", text: GUILD_STATES[room.state] || "" }),
        join,
      ]));
    });
    show(byId("hosted-guild"), guildList.rooms.length > 0);
  }

  function pollGuildRooms() {
    guildList.timer = 0;
    var generation = guildList.generation;
    global.HaloOnline.guildRooms().then(function(rooms) {
      if (generation !== guildList.generation) return;
      guildList.rooms = Array.isArray(rooms) ? rooms.filter(function(room) { return room && room.roomId; }) : [];
      renderGuildRooms();
      guildList.timer = global.setTimeout(pollGuildRooms, GUILD_POLL_MILLISECONDS);
    }, function() {
      if (generation === guildList.generation) guildList.timer = global.setTimeout(pollGuildRooms, GUILD_POLL_MILLISECONDS);
    });
  }

  function startGuildPoll() {
    if (guildList.polling) return;
    guildList.polling = true;
    guildList.generation++;
    pollGuildRooms();
  }

  function stopGuildPoll() {
    if (!guildList.polling) return;
    guildList.polling = false;
    guildList.generation++;
    if (guildList.timer) global.clearTimeout(guildList.timer);
    guildList.timer = 0;
    guildList.rooms = [];
    renderGuildRooms();
  }

  /* (the start-up report) halo.js and halo.wasm as Resource Timing saw them:
     when they had arrived, whether from the browser's cache, their size */
  function bootResources() {
    var found = {};
    try {
      global.performance.getEntriesByType("resource").forEach(function(entry) {
        var match = /\/halo\.(js|wasm)(\?|$)/.exec(entry.name);
        if (!match || found[match[1]]) return;
        found[match[1]] = {
          ms: Math.round(entry.responseEnd),
          cached: entry.transferSize === 0 && entry.decodedBodySize > 0,
          kb: Math.round(entry.encodedBodySize / 1024),
        };
      });
    } catch (error) {
      /* best effort */
    }
    return found;
  }

  function sendBootReport(body, beacon) {
    try {
      var payload = JSON.stringify(body);
      if (beacon && typeof global.navigator.sendBeacon === "function" &&
          global.navigator.sendBeacon("v1/client-boot", new global.Blob([payload], { type: "application/json" }))) {
        return;
      }
      global.fetch("v1/client-boot", {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: payload,
      }).catch(function() {});
    } catch (failure) {
      /* best effort */
    }
  }

  /* (read when a report goes: the loader's tags come after this script) */
  var boot = global.HaloHostedUI.boot = createBootRecorder({
    now: function() { return global.performance.now(); },
    send: sendBootReport,
    context: function() { return document.querySelector('meta[name="halo-activity"]') ? "activity" : "page"; },
    build: function() {
      var version = document.querySelector('meta[name="halo-asset-version"]');
      return version && version.content || null;
    },
    resources: bootResources,
    isolated: !!global.crossOriginIsolated,
  });
  ["warn", "error"].forEach(function(level) {
    var original = global.console[level];
    if (typeof original !== "function") return;
    global.console[level] = function() {
      try {
        boot.line(level, Array.prototype.map.call(arguments, String).join(" "));
      } catch (failure) {
        /* the console comes first */
      }
      return original.apply(global.console, arguments);
    };
  });
  /* the stages queued since the last frame */
  function drainBoot() {
    var queue = global.HaloBootEvents;
    if (queue && queue.length) queue.splice(0, queue.length).forEach(boot.event);
    var menuLoaded = module("platform_web_online_main_menu_loaded");
    if (menuLoaded && menuLoaded()) boot.menu();
  }
  if (document.visibilityState === "hidden") boot.hide();
  document.addEventListener("visibilitychange", function() {
    if (document.visibilityState === "hidden") boot.hide();
  });
  global.addEventListener("pagehide", function() {
    drainBoot();
    boot.pagehide();
  });
  function render() {
    var gameArea = byId("game-area");
    var presented = !!gameArea && gameArea.dataset.presented === "true";
    status = global.HaloOnline && typeof global.HaloOnline.status === "function" ?
      global.HaloOnline.status() : { view: "booting" };
    drainBoot();
    boot.view(status.view, presented);
    boot.check();
    if (status.view !== "booting" && !audioApplied && module("platform_web_set_volume")) {
      audioApplied = true;
      controller.applyAudio();
    }
    if (status.view !== "booting" && !inputApplied && module("platform_web_bind_input")) inputApplied = inputSettings.apply();
    if (!pickerDeclared && module("platform_web_online_set_page_picker")) {
      module("platform_web_online_set_page_picker")(1);
      pickerDeclared = true;
    }
    controller.update(presented, status.view);
    if (status.view === "match") lobby.playedMatch = true;
    else if (!status.role) lobby.playedMatch = false;
    var surface = presented ? surfaceFor(status.view, lobby.playedMatch) : "none";
    var host = status.host || "The host";
    var nextMatch = status.view === "hosting" && surface === "panel";
    var picking = status.view === "pick" || nextMatch;

    show(panel, surface === "panel");
    show(picker, picking);
    if (picking && surface === "panel") requestPictures();
    if (status.view === "pick" && surface === "panel" && global.HaloOnline &&
        typeof global.HaloOnline.guildRooms === "function") startGuildPoll();
    else stopGuildPoll();
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
      text("hosted-bar-text", (status.spectating ? "Spectating · " : "") +
        (lobby.playedMatch ? "Waiting for " + host + " to pick the next match…" :
          "In " + host + "'s lobby · waiting for " + host + " to start"));
    } else if (status.view === "postgame") {
      text("hosted-bar-text", status.role === "host" ? "Match over" :
        (status.spectating ? "Spectating · " : "") + "Match over · waiting for " + host);
    }
    show(byId("hosted-bar-join"), !!status.spectating && !status.spectatorJoining &&
      (status.view === "joined" || status.view === "postgame"));
    show(byId("hosted-start"), status.view === "hosting");
    show(byId("hosted-next"), status.view === "postgame" && status.role === "host");
    show(byId("hosted-bar-share"), status.view === "hosting" && !!status.shareUrl);
    text("hosted-bar-leave", status.view === "hosting" ? "Close lobby" : "Leave");
    renderTeams(status, surface);

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
    var watching = mode === "spectate";
    text("hosted-overlay-title", watching ? host + "'s match" : mode === "paused" ? "Paused" : "Click to play");
    show(byId("hosted-overlay-text"), watching);
    text("hosted-overlay-text", status.spectatorJoining ? "Joining the match…" :
      "You're spectating. Join to play, or keep watching.");
    show(byId("hosted-spectate-join"), watching && !status.spectatorJoining);
    text("hosted-resume", watching ? "Spectate" : mode === "paused" ? "Resume" : "Play");
    byId("hosted-resume").classList.toggle("primary", !watching);
    text("hosted-overlay-hint", watching ? "Esc shows this menu · F11 full screen" :
      "Esc releases the mouse · F11 full screen · F8 frame cap");
    show(byId("hosted-menu"), status.view === "match");
    var canEndMatch = mode !== "none" && status.role === "host" && status.view === "match";
    if (!canEndMatch) endConfirm = false;
    show(byId("hosted-end-match"), canEndMatch && !endConfirm);
    show(byId("hosted-end-confirm"), canEndMatch && endConfirm);
    show(spectateLabel, presented && status.view === "spectating" && !watching);
    text("hosted-spectate-name", status.spectatorJoining ? "Joining the match…" :
      status.spectated ? "Spectating " + status.spectated : "Spectating");
    show(byId("hosted-leave"), status.role === "host" || status.role === "guest");
    text("hosted-leave", status.role === "host" ? "Close room" : "Leave game");
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
