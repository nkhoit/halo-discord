import { createApp } from "./app.ts";
import { activityBundle } from "./bundle.ts";
import { loadConfig } from "./config.ts";
import { HttpDiscordApi } from "./discord.ts";

const config = loadConfig();
const discord = config.discord ? new HttpDiscordApi(config.discord.clientId, config.discord.clientSecret) : null;
const { server } = createApp(config, discord);
/* Bundling takes a moment; do it before the first Activity launch needs it. */
activityBundle().catch((error: Error) => console.error(JSON.stringify({ event: "bundle-error", message: error.message })));
server.listen(config.port, config.host, () => {
  console.log(JSON.stringify({
    event: "listening", host: config.host, port: config.port, publicOrigin: config.publicOrigin,
    discord: Boolean(config.discord), devLogin: config.devLogin,
  }));
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
