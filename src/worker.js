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

// ---- API handler with stale-while-revalidate edge caching ----------------

async function handleApi(request, env, ctx) {
  const cache = caches.default;
  const key = cacheKey(request);
  const hit = await cache.match(key);

  if (hit) {
    const builtAt = Number(hit.headers.get("x-built-at") || 0);
    const ageMs = Date.now() - builtAt;
    if (ageMs > CACHE_TTL * 1000) {
      // Serve stale immediately, refresh in the background.
      ctx.waitUntil(rebuildAndCache(request, env, ctx).catch(() => {}));
    }
    return cors(hit);
  }
  const fresh = await rebuildAndCache(request, env, ctx);
  return cors(fresh);
}

function cacheKey(request) {
  return new Request(new URL("/api/bracket", request.url).toString(), { method: "GET" });
}

async function rebuildAndCache(request, env, ctx) {
  let payload;
  try {
    payload = await buildData(env);
  } catch (err) {
    payload = { error: String(err && err.message || err), updated: Date.now(), groups: [], knockout: [] };
  }
  const body = JSON.stringify(payload);
  const resp = new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_TTL}, stale-while-revalidate=${CACHE_HARD}`,
      "x-built-at": String(Date.now()),
    },
  });
  const cache = caches.default;
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

async function fd(path, token) {
  const res = await fetch(FD_BASE + path, {
    headers: { "X-Auth-Token": token },
    cf: { cacheTtl: 30, cacheEverything: true },
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
  return {
    id: m.id,
    home: fdTeam(m.homeTeam),
    away: fdTeam(m.awayTeam),
    hs,
    as,
    state: st.state,
    statusLabel: st.label,
    minute: st.state === "live" ? (m.minute ? m.minute + "'" : "مباشر") : null,
    kickoff: m.utcDate || null,
  };
}

function fdGroupLetter(g) {
  return g ? String(g).replace(/GROUP[_\s]*/i, "").toUpperCase() : null;
}

async function buildFromFootballData(token) {
  const [standingsRes, matchesRes] = await Promise.all([
    fd("/competitions/WC/standings", token).catch(() => null),
    fd("/competitions/WC/matches", token).catch(() => null),
  ]);
  const matches = (matchesRes && matchesRes.matches) || [];

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

  const teams = new Set();
  for (const g of groups) for (const t of g.table) teams.add(t.name);

  return {
    updated: Date.now(),
    season: SEASON,
    source: "football-data.org",
    provider: "football-data",
    counts: { groups: groups.length, teams: teams.size, matches: matches.length, live: live.length },
    live: live.sort(byKickoff),
    groups: groups.map((g) => ({ name: g.name, matches: g.matches.sort(byKickoff), table: g.table })),
    knockout,
  };
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
