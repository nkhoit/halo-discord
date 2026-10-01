import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { HttpDiscordApi } from "./discord.ts";

const config = loadConfig();
const discord = config.discord ? new HttpDiscordApi(config.discord.clientId, config.discord.clientSecret) : null;
const { server } = createApp(config, discord);
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
