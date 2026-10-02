// Usage: node tools/web/feel-scorecard.mjs [--since ISO] [--until ISO] [--label text] < server.log
// Reads the server's JSON log lines (docker logs halo-server), keeps the netstats windows uploaded
// during matches (ticksPerSecond >= 20) and prints one feel scorecard per player as a JSON line:
//   minutes            match time covered
//   freezes            frames over 33 / 50 / 100 ms per minute, and the longest frame gap (ms)
//   fire               shots answering a press: p50 and worst-window p99 / max press-to-shot (ms),
//                      presses no shot answered within a second
//   hitConfirm         hits reported (clients): p50 and worst-window p99 / max report-to-host-damage (ms),
//                      reports the host did not answer within a second
//   remote             other players' per-tick correction distance p50 / worst-window p99 / max (world
//                      units) and snaps over 1 unit per minute
//   relayedInput       % of ticks run on the others' last input (no newer one), the longest run, % after
//                      two or more arrived at once (clients)
//   own                own-unit corrections per minute, the farthest (units), aim corrections, seat corrections
//   peerRttMs          median peer round trip
//   matchStart         map loads and each match's first 15 s, kept out of the above: how many, the
//                      longest frame gap while loading and in those first seconds, frames over 100 ms
// p50s are shot/sample-weighted medians of the windows' p50s; p99s are the worst window's.
import readline from "node:readline";

const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const since = option("--since"), until = option("--until"), label = option("--label") ?? "";

const players = new Map();
const median = (pairs) => {
  const total = pairs.reduce((sum, [, weight]) => sum + weight, 0);
  if (!total) return null;
  pairs.sort((a, b) => a[0] - b[0]);
  let seen = 0;
  for (const [value, weight] of pairs) { seen += weight; if (seen >= total / 2) return value; }
  return pairs.at(-1)[0];
};
const round = (value, digits = 1) => value === null || value === undefined ? null : +value.toFixed(digits);

for await (const line of readline.createInterface({ input: process.stdin })) {
  if (!line.includes('"netstats"')) continue;
  let entry;
  try { entry = JSON.parse(line); } catch { continue; }
  if (entry.event !== "netstats" || (since && entry.at < since) || (until && entry.at > until)) continue;
  const stats = entry.stats ?? {}, game = stats.game ?? {}, feel = stats.feel ?? {};
  let p = players.get(entry.user);
  if (!p) players.set(entry.user, p = { playing: false, startUntil: "", starts: 0, loadMax: 0, startMax: 0,
    startOver100: 0, seconds: 0, over: [0, 0, 0], freeze: 0, fire: [], fireP99: 0, fireMax: 0,
    shots: 0, unanswered: 0, unconfirmed: 0, hit: [], hitP99: 0, hitMax: 0, hits: 0, remote: [], remoteP99: 0, remoteMax: 0,
    remoteCorrections: 0, snaps: 0, ticks: 0, held: 0, heldRun: 0, bunched: 0, own: 0, ownMax: 0, aim: 0, seat: 0,
    rtt: [] });
  const seconds = stats.windowSeconds ?? 5;
  /* loading (and the menus): not play */
  if (!(game.ticksPerSecond >= 20)) {
    p.playing = false;
    if (game.frameGapMaxMs) p.loadMax = Math.max(p.loadMax, game.frameGapMaxMs);
    continue;
  }
  if (!p.playing) {
    p.playing = true;
    p.starts++;
    p.startUntil = new Date(Date.parse(entry.at) + 15000).toISOString();
  }
  if (entry.at <= p.startUntil) {
    p.startMax = Math.max(p.startMax, game.frameGapMaxMs ?? 0);
    p.startOver100 += (game.framesOver16_33_50_100Ms ?? [])[3] ?? 0;
    continue;
  }
  p.seconds += seconds;
  const over = game.framesOver16_33_50_100Ms ?? [0, 0, 0, 0];
  for (let i = 0; i < 3; i++) p.over[i] += over[i + 1] ?? 0;
  p.freeze = Math.max(p.freeze, game.frameGapMaxMs ?? 0);
  p.ticks += (game.ticksPerSecond ?? 0) * seconds;
  p.own += game.ownCorrections ?? 0;
  p.ownMax = Math.max(p.ownMax, game.ownCorrectionMaxUnits ?? 0);
  p.aim += game.ownAimCorrections ?? 0;
  p.seat += game.ownSeatCorrections ?? 0;
  if (feel.shots) {
    p.shots += feel.shots; p.fire.push([feel.fireP50Ms, feel.shots]);
    p.fireP99 = Math.max(p.fireP99, feel.fireP99Ms); p.fireMax = Math.max(p.fireMax, feel.fireMaxMs);
  }
  p.unanswered += feel.unansweredPresses ?? 0;
  p.unconfirmed += feel.unconfirmedHits ?? 0;
  if (feel.hitConfirms) {
    p.hits += feel.hitConfirms; p.hit.push([feel.hitConfirmP50Ms, feel.hitConfirms]);
    p.hitP99 = Math.max(p.hitP99, feel.hitConfirmP99Ms); p.hitMax = Math.max(p.hitMax, feel.hitConfirmMaxMs);
  }
  if (feel.remoteCorrections) {
    p.remoteCorrections += feel.remoteCorrections; p.remote.push([feel.remoteErrorP50, feel.remoteCorrections]);
    p.remoteP99 = Math.max(p.remoteP99, feel.remoteErrorP99); p.remoteMax = Math.max(p.remoteMax, feel.remoteErrorMax);
  }
  p.snaps += feel.remoteSnaps ?? 0;
  p.held += feel.relayedHeldTicks ?? 0;
  p.heldRun = Math.max(p.heldRun, feel.relayedHeldRunMax ?? 0);
  p.bunched += feel.relayedBunchedTicks ?? 0;
  for (const peer of stats.peers ?? []) if (typeof peer.rttMs === "number") p.rtt.push([peer.rttMs, 1]);
}

for (const [user, p] of players) {
  if (!p.seconds && !p.starts) continue;
  const minutes = p.seconds / 60 || Infinity;
  const perMinute = (value) => round(value / minutes, 1);
  const clientTicks = p.held || p.bunched || p.remoteCorrections ? p.ticks : 0;
  console.log(JSON.stringify({
    label, user, minutes: round(minutes, 2),
    freezes: { over33PerMin: perMinute(p.over[0]), over50PerMin: perMinute(p.over[1]),
      over100PerMin: perMinute(p.over[2]), maxMs: round(p.freeze) },
    fire: { shots: p.shots, p50Ms: round(median(p.fire)), p99Ms: round(p.fireP99), maxMs: round(p.fireMax),
      unanswered: p.unanswered },
    hitConfirm: { hits: p.hits, p50Ms: round(median(p.hit)), p99Ms: round(p.hitP99), maxMs: round(p.hitMax),
      unconfirmed: p.unconfirmed },
    remote: { corrections: p.remoteCorrections, p50: round(median(p.remote), 3), p99: round(p.remoteP99, 3),
      max: round(p.remoteMax, 2), snapsPerMin: perMinute(p.snaps) },
    relayedInput: clientTicks ? { heldPct: round(100 * p.held / clientTicks), longestRun: p.heldRun,
      bunchedPct: round(100 * p.bunched / clientTicks) } : null,
    own: { correctionsPerMin: perMinute(p.own), maxUnits: round(p.ownMax, 2), aim: p.aim, seat: p.seat },
    peerRttMs: round(median(p.rtt)),
    matchStart: { matches: p.starts, loadingMaxGapMs: round(p.loadMax), firstSecondsMaxGapMs: round(p.startMax),
      firstSecondsOver100: p.startOver100 },
  }));
}
