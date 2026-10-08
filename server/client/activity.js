/* The Discord Activity's start-up, bundled with the Embedded App SDK and
   served as activity.js (Discord's policy forbids third-party scripts).
   It completes the SDK handshake before anything heavy loads, signs in
   through the SDK, and only then starts the game, whose first request is a
   map that needs the session cookie set here. */

import { DiscordSDK } from "@discord/embedded-app-sdk";

const SCOPES = ["identify", "guilds"];

/* The SDK copies every console line to Discord (captureLog) unless told not
   to, and Discord rejects some (an over-long message: "child \"message\"
   fails because ..."); the rejection went unhandled and the shell showed it
   as a fatal start-up error. Halo's console is not Discord's business. */
const SDK_CONFIGURATION = { disableConsoleLogOverride: true };

/* Errors go to the server's log (POST /v1/client-errors), so a failure in
   someone's Discord client can be diagnosed. */
function reportError(kind, error) {
  try {
    const message = error && error.message ? String(error.message) : String(error);
    const stack = error && error.stack ? String(error.stack).slice(0, 2000) : null;
    fetch("v1/client-errors", {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, message: message.slice(0, 1000), stack, at: new Date().toISOString() }),
    }).catch(() => {});
  } catch {
    /* best effort */
  }
}

/* A failed Discord command rejects with the RPC error, a plain
   { code, message } object; none of them is fatal to the game. Registered
   before the shell's own handler, which treats every unhandled rejection as
   a failed start. */
function isDiscordCommandError(reason) {
  return Boolean(reason) && typeof reason === "object" && !(reason instanceof Error) &&
    typeof reason.code === "number" && typeof reason.message === "string";
}

window.addEventListener("unhandledrejection", (event) => {
  if (isDiscordCommandError(event.reason)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    reportError("discord-command", event.reason);
    return;
  }
  reportError("unhandledrejection", event.reason);
});
window.addEventListener("error", (event) => {
  reportError("error", event.error || event.message);
});

/* A stage of the start-up, for the start-up report (hosted.js's boot recorder,
   which runs before this script and reads the queue). */
function bootStage(name, detail = null) {
  (window.HaloBootEvents = window.HaloBootEvents || []).push([name, performance.now(), detail]);
}

function meta(name) {
  const element = document.querySelector(`meta[name="${name}"]`);
  return element ? element.content : null;
}

function domReady() {
  if (document.readyState !== "loading") return Promise.resolve();
  return new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
}

async function status(text) {
  await domReady();
  for (const id of ["status", "loading-label"]) {
    const element = document.getElementById(id);
    if (element) element.textContent = text;
  }
}

/* A blocking panel over the page, for problems the player has to act on. */
async function panel(title, text, actions) {
  await domReady();
  const overlay = document.createElement("div");
  overlay.id = "activity-panel";
  overlay.setAttribute("role", "alertdialog");
  Object.assign(overlay.style, {
    position: "fixed", inset: "0", zIndex: "1000", display: "grid", placeItems: "center",
    background: "rgba(4, 10, 14, .92)", color: "#e4f1ea", font: "16px system-ui, sans-serif",
  });
  const box = document.createElement("div");
  Object.assign(box.style, { maxWidth: "32rem", padding: "1.5rem", lineHeight: "1.45" });
  const heading = document.createElement("h2");
  heading.textContent = title;
  const body = document.createElement("p");
  body.textContent = text;
  box.append(heading, body);
  for (const { label, run } of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    Object.assign(button.style, { marginRight: ".5rem", padding: ".5rem 1rem", font: "inherit" });
    button.addEventListener("click", run);
    box.append(button);
  }
  overlay.append(box);
  document.body.append(overlay);
  return box;
}

/* Stands in for the SDK on local test pages (only offered under DEV_LOGIN),
   and makes the frame look like Discord's: no WebRTC at all, and, unless
   configured off as with the real SDK, every console line sent through a
   captureLog that rejects what Discord rejects (an empty or over-long
   message; the limit is an assumption, Discord's is not documented). */
const DEVELOPMENT_CAPTURE_LOG_LIMIT = 1000;

function developmentSdk(user, instanceId, configuration = {}, channelName = null) {
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel",
      "RTCSessionDescription", "RTCIceCandidate"]) {
    delete window[name];
    if (name in window) window[name] = undefined;
  }
  const channelId = (/-gc-\d+-(\d+)$/.exec(instanceId) || [])[1] || null;
  const commands = {
    authorize: async () => ({ code: `dev:${user}` }),
    getChannel: async ({ channel_id }) => ({ id: channel_id, name: channelName || `Channel ${channel_id}` }),
    openExternalLink: async ({ url }) => ({ opened: Boolean(window.open(url, "_blank", "noopener")) }),
    captureLog: async ({ message }) => {
      if (!message || message.length > DEVELOPMENT_CAPTURE_LOG_LIMIT) {
        throw { code: 4000, message: `child "message" fails because ["message" length must be less than or equal to ${DEVELOPMENT_CAPTURE_LOG_LIMIT} characters long]` };
      }
      return null;
    },
  };
  return {
    instanceId,
    channelId,
    commands,
    ready: async () => {
      if (configuration.disableConsoleLogOverride) return;
      for (const level of ["log", "warn", "debug", "info", "error"]) {
        const original = console[level];
        console[level] = function (...args) {
          commands.captureLog({ level, message: "" + args.join(" ") });
          original.apply(console, args);
        };
      }
    },
  };
}

async function signIn(sdk, clientId) {
  const { code } = await sdk.commands.authorize({
    client_id: clientId, response_type: "code", state: "", prompt: "none", scope: SCOPES,
  });
  const response = await fetch("auth/activity", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, instanceId: sdk.instanceId }),
  });
  if (response.status === 403) throw new Error("Halo is open only to members of its Discord server.");
  if (!response.ok) throw new Error(`Signing in failed (${response.status}). Try relaunching the Activity.`);
  return response.json();
}

/* The voice channel's name, for the server-wide lobby (best effort: null
   outside a server channel or when Discord does not say). */
async function voiceChannelName(sdk) {
  if (!sdk.channelId) return null;
  try {
    const channel = await sdk.commands.getChannel({ channel_id: sdk.channelId });
    return channel && typeof channel.name === "string" && channel.name ? channel.name : null;
  } catch (error) {
    return null;
  }
}

async function openInBrowser(sdk, url) {
  try {
    await sdk.commands.openExternalLink({ url });
  } catch (error) {
    console.error("openExternalLink failed:", error);
  }
}

async function main() {
  const clientId = meta("halo-activity");
  const publicOrigin = meta("halo-public-origin") || location.origin;
  const parameters = new URLSearchParams(location.search);
  const developmentUser = meta("halo-activity-dev") ? parameters.get("dev_user") : null;
  const sdk = developmentUser ?
    developmentSdk(developmentUser, parameters.get("instance_id") || "dev-instance", SDK_CONFIGURATION,
      parameters.get("channel_name")) :
    new DiscordSDK(clientId, SDK_CONFIGURATION);

  await status("Connecting to Discord…");
  await sdk.ready();
  bootStage("sdk-ready");

  if (!self.crossOriginIsolated) {
    bootStage("failed", "not-isolated");
    const box = await panel(
      "Halo can't run in this Discord client",
      "Halo needs cross-origin isolation for threaded WebAssembly, which this Discord client does not " +
        "provide (for example Discord in Firefox or Safari). The Discord desktop app and Discord in Chrome " +
        "or Edge work. You can also play in your browser:",
      [{ label: "Open Halo in the browser", run: () => openInBrowser(sdk, publicOrigin) }],
    );
    const link = document.createElement("p");
    link.textContent = publicOrigin;
    box.append(link);
    return;
  }

  await status("Signing in with Discord…");
  let session = await signIn(sdk, clientId);
  bootStage("signed-in");
  let channelName = null;
  voiceChannelName(sdk).then((name) => { channelName = name; });
  window.HaloActivity = Object.freeze({
    roomId: session.roomId,
    user: session.user,
    channelName: () => channelName,
    /* Signs in again through the SDK, e.g. after the session expired. */
    signIn: async () => {
      session = await signIn(sdk, clientId);
      return session;
    },
    openExternalLink: (url) => openInBrowser(sdk, url),
  });

  await status("Loading Halo…");
  startGame();
}

/* Loads the game at the page's asset version: halo.js?v= (whose URL its
   pthread workers reuse) and halo.wasm?v= through Module.locateFile, so no
   cache in front of the server can mix builds. Runs after the shell script,
   which defines Module (status() waited for the document). */
function startGame() {
  const version = meta("halo-asset-version");
  const suffix = version ? `?v=${encodeURIComponent(version)}` : "";
  const module = window.Module = window.Module || {};
  module.locateFile = (path, directory) => directory + path + (path === "halo.wasm" ? suffix : "");
  const script = document.createElement("script");
  script.src = `halo.js${suffix}`;
  script.addEventListener("load", () => bootStage("halo-js"));
  script.addEventListener("error", () => bootStage("failed", "halo-js"));
  document.head.append(script);
}

main().catch(async (error) => {
  console.error("Halo Activity start-up failed:", error);
  reportError("startup", error);
  bootStage("failed", "startup");
  await panel("Halo could not start", error && error.message ? error.message : String(error),
    [{ label: "Try again", run: () => location.reload() }]);
});
