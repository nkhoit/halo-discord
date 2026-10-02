/* Discord's OAuth2 and user API, behind an interface so tests use a fake. */

export interface DiscordUser {
  id: string;
  username: string;
  globalName: string | null;
}

export interface DiscordApi {
  /* Exchanges an authorization code for a user access token. redirectUri is
     omitted for the Embedded App SDK's authorize flow. */
  exchangeCode(code: string, redirectUri?: string): Promise<string>;
  getUser(accessToken: string): Promise<DiscordUser>;
  /* Whether the user belongs to the guild (needs the `guilds` scope). */
  isGuildMember(accessToken: string, guildId: string): Promise<boolean>;
}

const API = "https://discord.com/api/v10";

export class DiscordError extends Error {}

export class HttpDiscordApi implements DiscordApi {
  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor(clientId: string, clientSecret: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  async exchangeCode(code: string, redirectUri?: string): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: "authorization_code",
      code,
    });
    if (redirectUri) body.set("redirect_uri", redirectUri);
    const response = await fetch(`${API}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new DiscordError(`token exchange failed (${response.status})`);
    const value = await response.json() as { access_token?: unknown };
    if (typeof value.access_token !== "string") throw new DiscordError("token exchange returned no token");
    return value.access_token;
  }

  async getUser(accessToken: string): Promise<DiscordUser> {
    const value = await this.get(accessToken, "/users/@me") as
      { id?: unknown; username?: unknown; global_name?: unknown };
    if (typeof value.id !== "string" || typeof value.username !== "string") {
      throw new DiscordError("unexpected user response");
    }
    return {
      id: value.id,
      username: value.username,
      globalName: typeof value.global_name === "string" ? value.global_name : null,
    };
  }

  async isGuildMember(accessToken: string, guildId: string): Promise<boolean> {
    const guilds = await this.get(accessToken, "/users/@me/guilds");
    return Array.isArray(guilds) && guilds.some((guild) => guild && guild.id === guildId);
  }

  private async get(accessToken: string, path: string): Promise<unknown> {
    const response = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new DiscordError(`${path} failed (${response.status})`);
    return response.json();
  }
}
