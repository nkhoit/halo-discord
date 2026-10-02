/* The Discord Activity's start-up, bundled with the Embedded App SDK and
   served as activity.js (Discord's policy forbids third-party scripts).
   It completes the SDK handshake before anything heavy loads, signs in
   through the SDK, and only then starts the game, whose first request is a
   map that needs the session cookie set here. */

import { DiscordSDK } from "@discord/embedded-app-sdk";

const SCOPES = ["identify", "guilds"];

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

/* Stands in for the SDK on local test pages (only offered under DEV_LOGIN). */
function developmentSdk(user, instanceId) {
  return {
    instanceId,
    ready: async () => {},
    commands: {
      authorize: async () => ({ code: `dev:${user}` }),
      openExternalLink: async ({ url }) => ({ opened: Boolean(window.open(url, "_blank", "noopener")) }),
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
    developmentSdk(developmentUser, parameters.get("instance_id") || "dev-instance") :
    new DiscordSDK(clientId);

  await status("Connecting to Discord…");
  await sdk.ready();

  if (!self.crossOriginIsolated) {
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
  window.HaloActivity = Object.freeze({
    roomId: session.roomId,
    user: session.user,
    /* Signs in again through the SDK, e.g. after the session expired. */
    signIn: async () => {
      session = await signIn(sdk, clientId);
      return session;
    },
    openExternalLink: (url) => openInBrowser(sdk, url),
  });

  await status("Loading Halo…");
  const script = document.createElement("script");
  script.src = "halo.js";
  document.head.append(script);
}

main().catch(async (error) => {
  console.error("Halo Activity start-up failed:", error);
  await panel("Halo could not start", error && error.message ? error.message : String(error),
    [{ label: "Try again", run: () => location.reload() }]);
});
