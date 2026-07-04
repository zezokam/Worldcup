// FIFA World Cup 2026 — live groups & knockout bracket.
// Live data is fetched at the Cloudflare edge from TheSportsDB (keyless public API),
// normalized into groups + knockout rounds, and cached at the edge for a short window
// so every visitor sees the latest state after each match without hammering upstream.

import { teamInfo } from "./countries.js";

const TSDB = "https://www.thesportsdb.com/api/v1/json/3";
const WC_LEAGUE_NAME = "fifa world cup";
const WC_LEAGUE_ID_FALLBACK = "4429"; // TheSportsDB id for "FIFA World Cup"
const SEASON = "2026";
const CACHE_TTL = 30; // seconds a cached payload is considered fresh (keeps live scores close to real time)
const CACHE_HARD = 1800; // keep stale copy up to 30m for stale-while-revalidate

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/bracket") {
      return handleApi(request, env, ctx);
    }
    if (url.pathname === "/api/health") {
      return json({ ok: true, ts: Date.now() });
    }
    if (url.pathname === "/api/debug") {
      return handleDebug(env);
    }
    // Everything else -> static assets (index.html, css, js).
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },

  // Cron trigger warms the edge cache so the first visitor after a goal gets fresh data.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(rebuildAndCache(request_from("/api/bracket"), env, ctx).catch(() => {}));
  },
};

function request_from(path) {
  return new Request("https://worldcup.internal" + path);
}

// Diagnostics: raw knockout fixtures exactly as the data source returns them
// (bypasses every cache layer), plus the remaining rate-limit budget.
async function handleDebug(env) {
  const token = env && env.FOOTBALL_DATA_TOKEN;
  if (!token) return json({ error: "no FOOTBALL_DATA_TOKEN configured" });
  const out = { checkedAt: new Date().toISOString() };
  try {
    const res = await fetch(FD_BASE + "/competitions/WC/matches?stage=LAST_16", {
      headers: { "X-Auth-Token": token },
    });
    out.upstreamStatus = res.status;
    out.rateRemainingPerMinute = res.headers.get("x-requests-available-minute");
    const data = await res.json();
    out.count = (data.matches || []).length;
    out.last16 = (data.matches || []).map((m) => ({
      id: m.id,
      utcDate: m.utcDate,
      status: m.status,
      home: (m.homeTeam && m.homeTeam.name) || null,
      away: (m.awayTeam && m.awayTeam.name) || null,
    }));
  } catch (e) {
    out.error = String(e && e.message || e);
  }
  return json(out);
}

// ---- API handler with stale-while-revalidate edge caching ----------------

// Serve-stale is capped: within STALE_MAX_MS we serve the cached copy and
// refresh in the background; older than that we rebuild synchronously so a
// returning visitor never sees minutes-old bracket state.
const STALE_MAX_MS = 3 * 60 * 1000;

async function handleApi(request, env, ctx) {
  const cache = caches.default;
  const key = cacheKey(request);
  const hit = await cache.match(key);

  if (hit) {
    const builtAt = Number(hit.headers.get("x-built-at") || 0);
    const ageMs = Date.now() - builtAt;
    if (ageMs <= CACHE_TTL * 1000) return cors(hit);
    if (ageMs <= STALE_MAX_MS) {
      // Serve stale immediately, refresh in the background.
      ctx.waitUntil(rebuildAndCache(request, env, ctx).catch(() => {}));
      return cors(hit);
    }
  }
  const fresh = await rebuildAndCache(request, env, ctx);
  return cors(fresh);
}

function cacheKey(request) {
  return new Request(new URL("/api/bracket", request.url).toString(), { method: "GET" });
}

async function rebuildAndCache(request, env, ctx) {
  const cache = caches.default;
  let payload;
  try {
    payload = await buildData(env);
  } catch (err) {
    payload = { error: String(err && err.message || err), updated: Date.now(), groups: [], knockout: [] };
  }
  // Never clobber good cached data with an empty payload (rate-limit blips,
  // upstream hiccups): keep serving the last good copy instead.
  const gotNothing =
    !payload || (((payload.groups || []).length === 0) && ((payload.knockout || []).length === 0));
  if (gotNothing) {
    const prev = await cache.match(cacheKey(request));
    if (prev) return prev;
  }
  const body = JSON.stringify(payload);
  const resp = new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_TTL}, stale-while-revalidate=${CACHE_HARD}`,
      "x-built-at": String(Date.now()),
    },
  });
  ctx.waitUntil(cache.put(cacheKey(request), resp.clone()));
  return resp;
}

// ---- Upstream fetch + normalization --------------------------------------

async function tsdb(path) {
  const res = await fetch(TSDB + path, {
    headers: { "user-agent": "worldcup.alkamali.uk edge worker" },
    cf: { cacheTtl: 30, cacheEverything: true },
  });
  if (!res.ok) throw new Error("upstream " + res.status);
  return res.json();
}

// Resolve the World Cup league id dynamically (with a hard-coded fallback) so the
// worker keeps working even if the numeric id changes.
async function resolveLeagueId() {
  try {
    const data = await tsdb("/all_leagues.php");
    const list = (data && data.leagues) || [];
    const match = list.find(
      (l) => (l.strLeague || "").trim().toLowerCase() === WC_LEAGUE_NAME
    );
    if (match && match.idLeague) return match.idLeague;
  } catch (_) {
    /* fall through to fallback id */
  }
  return WC_LEAGUE_ID_FALLBACK;
}

// Pick the data provider: football-data.org when a token is configured (higher
// quality, real World Cup coverage), otherwise the keyless TheSportsDB source.
async function buildData(env) {
  const token = env && env.FOOTBALL_DATA_TOKEN;
  if (token) {
    try {
      const fd = await buildFromFootballData(token);
      if (fd.counts.groups > 0 || fd.counts.matches > 0) return fd;
    } catch (_) {
      /* fall back to TheSportsDB */
    }
  }
  return buildFromTheSportsDB();
}

async function buildFromTheSportsDB() {
  const leagueId = await resolveLeagueId();
  let events = [];
  try {
    const data = await tsdb(`/eventsseason.php?id=${leagueId}&s=${SEASON}`);
    events = (data && data.events) || [];
  } catch (_) {
    events = [];
  }
  return normalize(events, leagueId);
}

// ---- football-data.org provider ------------------------------------------

const FD_BASE = "https://api.football-data.org/v4";

async function fd(path, token, ttl = 30) {
  const res = await fetch(FD_BASE + path, {
    headers: { "X-Auth-Token": token },
    cf: { cacheTtl: ttl, cacheEverything: true },
  });
  if (!res.ok) throw new Error("football-data " + res.status);
  return res.json();
}

const FD_STAGE = {
  LAST_32: { stage: "r32", order: 2, ar: "دور الـ32" },
  LAST_16: { stage: "r16", order: 3, ar: "دور الـ16" },
  QUARTER_FINALS: { stage: "qf", order: 4, ar: "ربع النهائي" },
  SEMI_FINALS: { stage: "sf", order: 5, ar: "نصف النهائي" },
  THIRD_PLACE: { stage: "third", order: 6, ar: "تحديد المركز الثالث" },
  FINAL: { stage: "final", order: 7, ar: "النهائي" },
};

function fdTeam(t) {
  const info = teamInfo((t && t.name) || "");
  if (!info.iso && t && t.crest) info.crest = t.crest;
  return info;
}

function fdStatusState(m) {
  const s = m.status;
  if (s === "IN_PLAY") return { state: "live", label: "مباشر" };
  if (s === "PAUSED") return { state: "live", label: "استراحة" };
  if (s === "FINISHED" || s === "AWARDED") return { state: "finished", label: "انتهت" };
  return { state: "scheduled", label: "لم تبدأ" };
}

function fdMatch(m) {
  const st = fdStatusState(m);
  const ft = (m.score && m.score.fullTime) || {};
  const hs = ft.home === undefined ? null : ft.home;
  const as = ft.away === undefined ? null : ft.away;
  const pen = (m.score && m.score.penalties) || null;
  return {
    id: m.id,
    home: fdTeam(m.homeTeam),
    away: fdTeam(m.awayTeam),
    hs,
    as,
    // Official winner marker ("HOME_TEAM"/"AWAY_TEAM") — decides shootouts too.
    winner: (m.score && m.score.winner) || null,
    pen: pen && pen.home !== null && pen.home !== undefined ? { h: pen.home, a: pen.away } : null,
    state: st.state,
    statusLabel: st.label,
    minute: st.state === "live" && m.minute ? m.minute + "'" : null,
    kickoff: m.utcDate || null,
  };
}

function fdGroupLetter(g) {
  return g ? String(g).replace(/GROUP[_\s]*/i, "").toUpperCase() : null;
}

async function buildFromFootballData(token) {
  // Scorers change rarely (only after goals), so cache that call harder to
  // stay well inside the free-tier rate limit.
  const [standingsRes, matchesRes, scorersRes] = await Promise.all([
    fd("/competitions/WC/standings", token).catch(() => null),
    fd("/competitions/WC/matches", token).catch(() => null),
    fd("/competitions/WC/scorers?limit=20", token, 120).catch(() => null),
  ]);
  // If either core call failed (rate-limit blip), bail out so the caller keeps
  // serving the last good cached payload instead of a half-empty one.
  if (!standingsRes || !matchesRes) throw new Error("football-data partial outage");
  const matches = (matchesRes && matchesRes.matches) || [];

  const scorers = ((scorersRes && scorersRes.scorers) || []).map((s) => ({
    name: (s.player && s.player.name) || "",
    team: fdTeam(s.team),
    played: s.playedMatches ?? null,
    goals: s.goals ?? 0,
    assists: s.assists ?? 0,
    penalties: s.penalties ?? 0,
  }));

  // Group tables from the standings endpoint.
  const groups = [];
  const byLetter = new Map();
  for (const s of (standingsRes && standingsRes.standings) || []) {
    if (s.type && s.type !== "TOTAL") continue;
    const letter = fdGroupLetter(s.group);
    if (!letter) continue;
    const table = (s.table || []).map((row) => {
      const info = fdTeam(row.team);
      return {
        ...info,
        P: row.playedGames, W: row.won, D: row.draw, L: row.lost,
        GF: row.goalsFor, GA: row.goalsAgainst,
        GD: row.goalDifference, Pts: row.points,
      };
    });
    const g = { name: letter, matches: [], table };
    groups.push(g);
    byLetter.set(letter, g);
  }
  groups.sort((a, b) => a.name.localeCompare(b.name));

  // Knockout rounds + live from the matches endpoint.
  const koMap = new Map();
  const live = [];
  for (const m of matches) {
    const mm = fdMatch(m);
    if (mm.state === "live") live.push(mm);
    const info = FD_STAGE[m.stage];
    if (info) {
      mm.stageAr = info.ar;
      if (!koMap.has(info.stage))
        koMap.set(info.stage, { stage: info.stage, ar: info.ar, order: info.order, matches: [] });
      koMap.get(info.stage).matches.push(mm);
    } else {
      mm.stageAr = "دور المجموعات";
      const g = byLetter.get(fdGroupLetter(m.group));
      if (g) g.matches.push(mm);
    }
  }
  const knockout = [...koMap.values()]
    .sort((a, b) => a.order - b.order)
    .map((r) => ({ stage: r.stage, ar: r.ar, matches: r.matches.sort(byKickoff) }));
  propagateWinners(knockout);

  const teams = new Set();
  for (const g of groups) for (const t of g.table) teams.add(t.name);

  // The matches LIST endpoint has no live minute — fetch per-match details for
  // the (few) live games. `live` shares object refs with the round arrays, so
  // the minute shows everywhere.
  await enrichLiveMinutes(live, token);

  return {
    updated: Date.now(),
    season: SEASON,
    source: "football-data.org",
    provider: "football-data",
    counts: { groups: groups.length, teams: teams.size, matches: matches.length, live: live.length },
    live: live.sort(byKickoff),
    scorers,
    groups: groups.map((g) => ({ name: g.name, matches: g.matches.sort(byKickoff), table: g.table })),
    knockout,
  };
}

// ---- winner propagation ---------------------------------------------------
// Fill TBD sides of the next knockout round from finished feeder matches.
// The feeder→slot mapping is positional (slot i ← feeders 2i, 2i+1), but we
// only trust an ordering after VALIDATING it against ≥2 pairings the source
// itself already filled — so a wrong guess can never place a team in the
// wrong tie. Filled sides are flagged `provisional` until the source confirms.

function winnerTeam(m) {
  if (m.state !== "finished") return null;
  if (m.winner === "HOME_TEAM") return m.home;
  if (m.winner === "AWAY_TEAM") return m.away;
  if (m.hs === null || m.as === null) return null;
  if (m.hs > m.as) return m.home;
  if (m.as > m.hs) return m.away;
  return null; // drawn with no official winner — cannot resolve
}

export function propagateWinners(rounds) {
  const seq = rounds.filter((r) => r.stage !== "third");
  const byId = (a, b) => Number(a.id) - Number(b.id);
  const byKick = (a, b) => (a.kickoff || "").localeCompare(b.kickoff || "") || byId(a, b);

  for (let k = 0; k + 1 < seq.length; k++) {
    const cur = seq[k].matches;
    const next = seq[k + 1].matches;
    if (!cur.length || cur.length !== next.length * 2) continue;

    for (const ordering of [byId, byKick]) {
      const C = cur.slice().sort(ordering);
      const N = next.slice().sort(ordering);

      // Validate the positional mapping against source-filled slots.
      let confirmed = 0;
      let ok = true;
      for (let i = 0; i < N.length; i++) {
        const n = N[i];
        if (!n.home.name || !n.away.name) continue;
        const w1 = winnerTeam(C[2 * i]);
        const w2 = winnerTeam(C[2 * i + 1]);
        if (!w1 || !w2) continue;
        const names = new Set([n.home.name, n.away.name]);
        if (names.has(w1.name) && names.has(w2.name)) confirmed++;
        else { ok = false; break; }
      }
      if (!ok || confirmed < 2) continue;

      // Mapping proven for this dataset — fill the gaps.
      for (let i = 0; i < N.length; i++) {
        const n = N[i];
        const w1 = winnerTeam(C[2 * i]);
        const w2 = winnerTeam(C[2 * i + 1]);
        if (!n.home.name && !n.away.name) {
          if (w1) { n.home = { ...w1 }; n.provisional = true; }
          if (w2) { n.away = { ...w2 }; n.provisional = true; }
        } else if (n.home.name && !n.away.name) {
          const w = w1 && n.home.name === w1.name ? w2 : w2 && n.home.name === w2.name ? w1 : null;
          if (w) { n.away = { ...w }; n.provisional = true; }
        } else if (!n.home.name && n.away.name) {
          const w = w1 && n.away.name === w1.name ? w2 : w2 && n.away.name === w2.name ? w1 : null;
          if (w) { n.home = { ...w }; n.provisional = true; }
        }
      }
      break; // this ordering validated — don't try the next one
    }
  }
}

// Fetch the real minute for live matches from the per-match endpoint (capped
// to stay inside the free-tier rate limit); anything we can't fetch gets an
// estimate computed from kickoff time.
async function enrichLiveMinutes(live, token) {
  const detailed = live.slice(0, 3);
  await Promise.all(
    detailed.map(async (m) => {
      try {
        const d = await fd(`/matches/${m.id}`, token);
        const raw = d && (d.minute ?? (d.match && d.match.minute));
        if (raw !== null && raw !== undefined && raw !== "") {
          m.minute = String(raw).endsWith("'") ? String(raw) : raw + "'";
          return;
        }
      } catch (_) {
        /* fall back to the estimate below */
      }
      m.minute = estimateMinute(m);
    })
  );
  for (const m of live.slice(3)) m.minute = estimateMinute(m);
}

// Rough live minute from kickoff time: first half, halftime window, second
// half (kickoff+~60), capped at 90+.
function estimateMinute(m) {
  if (m.statusLabel === "استراحة") return "استراحة";
  if (!m.kickoff) return "مباشر";
  const el = Math.floor((Date.now() - Date.parse(m.kickoff)) / 60000);
  if (el < 1) return "1'";
  if (el <= 45) return el + "'";
  if (el <= 60) return "45+'";
  if (el <= 105) return Math.min(el - 15, 90) + "'";
  return "90+'";
}

// Detect a match's stage and (for the group phase) its group letter.
function stageInfo(ev) {
  const hay = [(ev.strEvent || ""), (ev.strStage || ""), (ev.strGroup || ""), (ev.strDescriptionEN || "")]
    .join(" ")
    .toLowerCase();

  if (/round of 32|1\/16|last 32/.test(hay)) return { stage: "r32", order: 2, ar: "دور الـ32" };
  if (/round of 16|1\/8|last 16/.test(hay)) return { stage: "r16", order: 3, ar: "دور الـ16" };
  if (/quarter[\s-]?final/.test(hay)) return { stage: "qf", order: 4, ar: "ربع النهائي" };
  if (/semi[\s-]?final/.test(hay)) return { stage: "sf", order: 5, ar: "نصف النهائي" };
  if (/third place|3rd place|play[\s-]?off for third/.test(hay))
    return { stage: "third", order: 6, ar: "تحديد المركز الثالث" };
  if (/\bfinal\b/.test(hay)) return { stage: "final", order: 7, ar: "النهائي" };

  const g = hay.match(/group\s*([a-l])\b/);
  if (g) return { stage: "group", group: g[1].toUpperCase(), order: 1, ar: "دور المجموعات" };
  return { stage: "group", group: null, order: 1, ar: "دور المجموعات" };
}

function parseScore(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Map TheSportsDB status strings to our simplified state.
function statusInfo(ev, hs, as) {
  const s = (ev.strStatus || "").trim().toUpperCase();
  const prog = (ev.strProgress || "").trim();
  const LIVE = ["1H", "2H", "HT", "ET", "LIVE", "P", "BT"];
  const FINISHED = ["FT", "AET", "PEN", "MATCH FINISHED", "AWARDED", "WO"];

  if (LIVE.includes(s)) return { state: "live", label: prog || "مباشر", minute: prog };
  if (FINISHED.includes(s) || (hs !== null && as !== null && isPast(ev)))
    return { state: "finished", label: "انتهت" };
  if (s === "NS" || s === "") {
    if (hs !== null && as !== null && isPast(ev)) return { state: "finished", label: "انتهت" };
    return { state: "scheduled", label: "لم تبدأ" };
  }
  if (s === "PST" || s === "POSTP") return { state: "scheduled", label: "مؤجلة" };
  if (s === "CANC") return { state: "scheduled", label: "ملغاة" };
  return { state: "scheduled", label: s || "لم تبدأ" };
}

function isPast(ev) {
  const dt = matchDate(ev);
  if (!dt) return false;
  return dt.getTime() < Date.now() - 2.5 * 3600 * 1000; // 2.5h after kickoff => certainly done
}

function matchDate(ev) {
  const d = ev.dateEvent || ev.dateEventLocal;
  const t = ev.strTime || ev.strTimeLocal || "00:00:00";
  if (!d) return null;
  const iso = `${d}T${(t || "00:00:00").slice(0, 8)}Z`;
  const dt = new Date(iso);
  return isNaN(dt.getTime()) ? null : dt;
}

function toMatch(ev) {
  const hs = parseScore(ev.intHomeScore);
  const as = parseScore(ev.intAwayScore);
  const st = statusInfo(ev, hs, as);
  const dt = matchDate(ev);
  return {
    id: ev.idEvent,
    home: teamInfo(ev.strHomeTeam),
    away: teamInfo(ev.strAwayTeam),
    hs,
    as,
    state: st.state,
    statusLabel: st.label,
    minute: st.minute || null,
    kickoff: dt ? dt.toISOString() : null,
  };
}

export function normalize(events, leagueId) {
  const groupsMap = new Map(); // letter -> { matches:[], teams:Map }
  const koMap = new Map(); // stage -> { ar, order, matches:[] }
  const live = [];
  let anyData = events.length > 0;

  for (const ev of events) {
    const info = stageInfo(ev);
    const m = toMatch(ev);
    m.stageAr = info.ar;
    if (m.state === "live") live.push(m);

    if (info.stage === "group") {
      const letter = info.group || "?";
      if (!groupsMap.has(letter)) groupsMap.set(letter, { name: letter, matches: [], teams: new Map() });
      const g = groupsMap.get(letter);
      g.matches.push(m);
      accumulate(g.teams, ev, m);
    } else {
      if (!koMap.has(info.stage))
        koMap.set(info.stage, { stage: info.stage, ar: info.ar, order: info.order, matches: [] });
      koMap.get(info.stage).matches.push(m);
    }
  }

  const groups = [...groupsMap.values()]
    .filter((g) => g.name !== "?")
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((g) => ({
      name: g.name,
      matches: g.matches.sort(byKickoff),
      table: standings(g.teams),
    }));

  const knockout = [...koMap.values()]
    .sort((a, b) => a.order - b.order)
    .map((r) => ({ stage: r.stage, ar: r.ar, matches: r.matches.sort(byKickoff) }));
  propagateWinners(knockout);

  return {
    updated: Date.now(),
    season: SEASON,
    source: "TheSportsDB",
    leagueId,
    counts: {
      groups: groups.length,
      teams: countTeams(groups),
      matches: events.length,
      live: live.length,
    },
    live: live.sort(byKickoff),
    groups,
    knockout,
  };
}

function accumulate(teamsMap, ev, m) {
  for (const side of ["home", "away"]) {
    const info = side === "home" ? m.home : m.away;
    const key = info.name;
    if (!key) continue;
    if (!teamsMap.has(key)) teamsMap.set(key, { ...info, P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, Pts: 0 });
  }
  if (m.state !== "finished" || m.hs === null || m.as === null) return;
  const h = teamsMap.get(m.home.name);
  const a = teamsMap.get(m.away.name);
  if (!h || !a) return;
  h.P++; a.P++;
  h.GF += m.hs; h.GA += m.as;
  a.GF += m.as; a.GA += m.hs;
  if (m.hs > m.as) { h.W++; a.L++; h.Pts += 3; }
  else if (m.hs < m.as) { a.W++; h.L++; a.Pts += 3; }
  else { h.D++; a.D++; h.Pts++; a.Pts++; }
}

function standings(teamsMap) {
  return [...teamsMap.values()]
    .map((t) => ({ ...t, GD: t.GF - t.GA }))
    .sort((a, b) => b.Pts - a.Pts || b.GD - a.GD || b.GF - a.GF || a.name.localeCompare(b.name));
}

function countTeams(groups) {
  const s = new Set();
  for (const g of groups) for (const t of g.table) s.add(t.name);
  return s.size;
}

function byKickoff(a, b) {
  return (a.kickoff || "").localeCompare(b.kickoff || "");
}

// ---- helpers -------------------------------------------------------------

function json(obj) {
  return cors(
    new Response(JSON.stringify(obj), {
      headers: { "content-type": "application/json; charset=utf-8" },
    })
  );
}

function cors(resp) {
  const r = new Response(resp.body, resp);
  r.headers.set("access-control-allow-origin", "*");
  return r;
}
