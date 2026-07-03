/* World Cup 2026 front-end. Fetches normalized data from the edge worker,
   renders group tables + knockout rounds + today's matches, and auto-refreshes
   (faster while a match is live) so the page always reflects the latest state. */

const API = "/api/bracket";
const REFRESH_MS = 60000;
const REFRESH_LIVE_MS = 30000;

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let state = { data: null, tab: "map", filter: "all", round: null, timer: null };

/* ---------- data ---------- */
async function load(showLoading) {
  // Preview mode: use an injected dataset instead of hitting the edge API.
  if (window.__PREVIEW_DATA__) { state.data = window.__PREVIEW_DATA__; render(); return; }
  if (showLoading && !state.data) setEmpty("جارٍ تحميل بيانات البطولة…", false);
  try {
    const res = await fetch(API, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    state.data = data;
    render();
  } catch (err) {
    if (!state.data) setEmpty("تعذّر تحميل البيانات. تحقّق من الاتصال وحاول مجددًا.", true);
  }
  scheduleRefresh();
}

// Poll faster while a match is live so the score/minute stay close to real time.
function scheduleRefresh() {
  clearTimeout(state.timer);
  const hasLive = !!(state.data && state.data.live && state.data.live.length);
  state.timer = setTimeout(() => load(false), hasLive ? REFRESH_LIVE_MS : REFRESH_MS);
}

/* ---------- render ---------- */
function render() {
  const d = state.data;
  if (!d) return;

  // stats
  const c = d.counts || {};
  $("#statTeams").textContent = c.teams ?? "—";
  $("#statGroups").textContent = c.groups ?? "—";
  $("#statMatches").textContent = c.matches ?? "—";
  $("#statUpdated").textContent = d.updated ? timeAr(d.updated) : "—";

  // live pill + strip
  const live = d.live || [];
  const pill = $("#livePill");
  if (live.length) {
    pill.hidden = false;
    $("#liveCount").textContent = live.length + " مباشر";
  } else pill.hidden = true;
  renderLiveStrip(live);

  const hasData = (d.groups && d.groups.length) || (d.knockout && d.knockout.length);
  $("#empty").hidden = hasData;
  if (!hasData) {
    setEmpty(
      d.error
        ? "لا تتوفر بيانات المباريات حاليًا. ستظهر تلقائيًا فور انطلاق المباريات."
        : "لم تُسجّل مباريات بعد. ستظهر النتائج هنا تلقائيًا بعد كل مباراة.",
      true
    );
  }

  renderMap(d.knockout || [], d.groups || []);
  renderToday(d);
  renderTeams(d.groups || []);
  renderGroups(d.groups || []);
  applyTab();
}

/* ---------- knockout ladder (hero) — one round at a time, clear pairings ----------
   The upstream API has no "winner of match X feeds slot Y" linkage, so a drawn
   tree can't be wired correctly. Instead each round is a list of explicit
   matchup cards (who plays whom, score, winner) with chips to move between rounds. */
function renderMap(rounds, groups) {
  const view = $("#view-map");
  view.innerHTML = "";
  view.appendChild(el("div", "section-title", "<h2>مسار البطولة — الأدوار الإقصائية</h2>"));

  const valid = rounds.filter((r) => (r.matches || []).length);
  if (!valid.length) {
    // Knockout not started: seed a preview from qualified teams (top 2 of each group).
    const seeded = seedFromGroups(groups);
    if (!seeded) {
      view.appendChild(el("div", "empty-row", "ستظهر مواجهات الأدوار الإقصائية هنا فور انطلاقها."));
      return;
    }
    view.appendChild(seeded);
    view.appendChild(el("p", "map-note", "خريطة مبدئية بالمنتخبات المتأهلة — تُحدَّث تلقائيًا عند بدء الأدوار الإقصائية."));
    return;
  }

  const active = activeRound(valid);

  // Round chips (دور الـ32 → النهائي) — the current round is picked automatically.
  const chips = el("div", "chips rounds-nav");
  valid.forEach((r) => {
    const done = r.matches.filter((m) => m.state === "finished").length;
    const b = el(
      "button",
      "chip" + (r.stage === active.stage ? " on" : ""),
      `${esc(r.ar)} <span class="cnt">${done}/${r.matches.length}</span>`
    );
    b.addEventListener("click", () => { state.round = r.stage; renderMap(rounds, groups); });
    chips.appendChild(b);
  });
  view.appendChild(chips);

  const list = el("div", "ko-list");
  active.matches.slice().sort(byKickoff).forEach((m, i) => list.appendChild(matchCard(m, i, {})));
  view.appendChild(list);
  view.appendChild(el("p", "map-note", "كل بطاقة = مواجهة مباشرة بين منتخبين — الفائز ينتقل للدور التالي. تنقّل بين الأدوار من الأزرار أعلاه."));
}

// Which round to show by default: the one with a live match, else the first
// round that still has unplayed matches, else the last round (tournament over).
function activeRound(rounds) {
  if (state.round) {
    const chosen = rounds.find((r) => r.stage === state.round);
    if (chosen) return chosen;
  }
  const live = rounds.find((r) => r.matches.some((m) => m.state === "live"));
  if (live) return live;
  const upcoming = rounds.find((r) => r.matches.some((m) => m.state !== "finished"));
  if (upcoming) return upcoming;
  return rounds[rounds.length - 1];
}

/* ---------- match card (shared by the ladder + today's matches) ---------- */
function matchCard(m, i, opts = {}) {
  const card = el("div", "ko-card" + (m.state === "live" ? " live" : ""));
  card.style.animationDelay = Math.min(i, 14) * 0.03 + "s";

  const when = opts.timeOnly
    ? `<b class="tm">${m.kickoff ? esc(timeAr(Date.parse(m.kickoff))) : "—"}</b>`
    : `<span class="when">${esc(dateAr(m.kickoff))}</span>`;
  const stg = opts.stage && m.stageAr ? `<span class="stg">${esc(m.stageAr)}</span>` : "";
  let st;
  if (m.state === "live") st = `<span class="st live">${esc(liveMinute(m))}</span>`;
  else if (m.state === "finished") st = `<span class="st done">${esc(m.statusLabel || "انتهت")}</span>`;
  else st = `<span class="st soon">${esc(m.statusLabel || "لم تبدأ")}</span>`;

  card.appendChild(el("div", "ko-head", `<span class="ko-when">${when}${stg}</span>${st}`));
  card.appendChild(teamRow(m, "home"));
  card.appendChild(teamRow(m, "away"));
  return card;
}

function teamRow(m, side) {
  const t = m[side] || {};
  const s = side === "home" ? m.hs : m.as;
  const o = side === "home" ? m.as : m.hs;
  const decided = m.state === "finished" && s !== null && o !== null;
  const cls = decided ? (s > o ? " win" : s < o ? " lose" : "") : "";
  const known = !!t.name;
  const row = el("div", "ko-row" + cls);
  row.innerHTML = `
    <span class="f">${known ? t.flag : "⚽"}</span>
    <span class="t${known ? "" : " tbd"}">${known ? esc(t.ar) : "يُحدَّد لاحقًا"}</span>
    <span class="sc">${s === null || s === undefined ? "—" : s}</span>`;
  return row;
}

// Live minute: use the provider's minute when present, otherwise estimate from kickoff.
function liveMinute(m) {
  if (m.minute) return m.minute;
  if (m.kickoff) {
    const mins = Math.round((Date.now() - new Date(m.kickoff).getTime()) / 60000);
    if (mins >= 0 && mins <= 130) return "≈ " + Math.min(mins, 120) + "′";
  }
  return "مباشر";
}

/* ---------- today's matches ---------- */
function renderToday(d) {
  const view = $("#view-today");
  view.innerHTML = "";

  const withDate = allMatches(d).filter((m) => m.kickoff);
  if (!withDate.length) {
    view.appendChild(el("div", "empty-row", "لا توجد مباريات مجدولة بعد."));
    return;
  }

  const byDay = new Map();
  for (const m of withDate) {
    const k = dayKey(new Date(m.kickoff));
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(m);
  }

  const todayK = dayKey(new Date());
  let key = todayK, title = "مباريات اليوم", note = "";
  if (!byDay.has(todayK)) {
    const days = [...byDay.keys()].sort();
    const future = days.filter((k) => k > todayK);
    if (future.length) {
      key = future[0];
      title = "أقرب المباريات القادمة";
      note = "لا توجد مباريات اليوم — هذه مباريات أقرب يوم قادم.";
    } else {
      key = days[days.length - 1];
      title = "آخر مباريات البطولة";
      note = "انتهت مباريات البطولة — هذه نتائج آخر يوم لعب.";
    }
  }

  view.appendChild(el("div", "section-title", `<h2>${title}</h2>`));
  view.appendChild(el("p", "day-head", esc(dayAr(key))));
  if (note) view.appendChild(el("p", "map-note top", esc(note)));

  const list = el("div", "today-list");
  byDay.get(key).sort(byKickoff).forEach((m, i) => list.appendChild(matchCard(m, i, { timeOnly: true, stage: true })));
  view.appendChild(list);
  view.appendChild(el("p", "map-note", "التوقيتات معروضة بالتوقيت المحلي لجهازك — تُحدَّث النتائج تلقائيًا."));
}

function allMatches(d) {
  const out = [];
  for (const g of d.groups || []) for (const m of g.matches || []) out.push(m);
  for (const r of d.knockout || []) for (const m of r.matches || []) out.push(m);
  return out;
}

// When knockout hasn't started, render a static map of qualified teams (top 2 per group).
function seedFromGroups(groups) {
  const qualified = [];
  for (const g of groups) (g.table || []).slice(0, 2).forEach((t) => qualified.push(t));
  if (qualified.length < 4) return null;

  const wrap = el("div", "bmap seeded");
  const half = Math.ceil(qualified.length / 2);
  const mk = (list) => {
    const col = el("div", "bm-round");
    list.forEach((t) => {
      const node = el("div", "bm-match");
      const slot = el("div", "bm-slot");
      slot.innerHTML = `<span class="f">${t.flag}</span>`;
      slot.title = t.ar;
      node.appendChild(slot);
      col.appendChild(node);
    });
    return col;
  };
  const left = el("div", "half left");
  left.appendChild(mk(qualified.slice(0, half)));
  const right = el("div", "half right");
  right.appendChild(mk(qualified.slice(half)));
  const center = el("div", "bm-center");
  center.appendChild(el("div", "bm-trophy", "🏆"));
  center.appendChild(el("div", "bm-champ", `<span class="tbd">البطل</span>`));
  wrap.appendChild(left);
  wrap.appendChild(center);
  wrap.appendChild(right);
  return wrap;
}

/* ---------- teams grid ---------- */
function renderTeams(groups) {
  const view = $("#view-teams");
  view.innerHTML = "";
  if (!groups.length) return;

  // Flatten teams, tagging each with its group letter + qualifying rank.
  const teams = [];
  for (const g of groups) {
    (g.table || []).forEach((t, idx) => teams.push({ ...t, group: g.name, rank: idx + 1 }));
  }
  if (!teams.length) return;

  // Filter chips (All + each group letter).
  const chips = el("div", "chips");
  const mk = (val, label) => {
    const b = el("button", "chip" + (state.filter === val ? " on" : ""), label);
    b.addEventListener("click", () => { state.filter = val; renderTeams(groups); });
    return b;
  };
  chips.appendChild(mk("all", "الكل"));
  groups.forEach((g) => chips.appendChild(mk(g.name, "المجموعة " + g.name)));

  const head = el("div", "section-title", "<h2>منتخبات البطولة</h2>");
  view.appendChild(head);
  view.appendChild(chips);

  const grid = el("div", "teams-grid");
  const shown = teams.filter((t) => state.filter === "all" || t.group === state.filter);
  shown.forEach((t, i) => grid.appendChild(teamCard(t, i)));
  view.appendChild(grid);
}

function teamCard(t, i) {
  const qualifies = t.rank <= 2;
  const card = el("div", "team-card" + (qualifies ? " q" : ""));
  card.style.animationDelay = Math.min(i, 24) * 0.025 + "s";
  card.innerHTML = `
    <div class="tc-top">
      <span class="tc-grp">${esc(t.group)}</span>
      ${qualifies ? '<span class="tc-tag">متأهل</span>' : ""}
    </div>
    <div class="tc-flag">${t.flag}</div>
    <div class="tc-name">${esc(t.ar)}</div>
    <div class="tc-stats">
      <span><b>${t.P}</b> لعب</span>
      <span class="dotsep"></span>
      <span><b class="pts">${t.Pts}</b> نقطة</span>
    </div>`;
  return card;
}

/* ---------- live strip (top of page while a match is on) ---------- */
function renderLiveStrip(live) {
  const strip = $("#liveStrip");
  strip.innerHTML = "";
  if (!live.length) { strip.hidden = true; return; }
  strip.hidden = false;
  for (const m of live) {
    const card = el("div", "live-card");
    card.innerHTML = `
      <div class="lc-top"><span>${esc(m.stageAr || "")}</span><span class="lc-min">${esc(liveMinute(m))}</span></div>
      ${liveRow(m.home, m.hs)}
      ${liveRow(m.away, m.as)}`;
    strip.appendChild(card);
  }
}
function liveRow(team, score) {
  return `<div class="live-row"><span class="nm"><span class="f">${team.flag}</span><span class="t">${esc(team.ar)}</span></span><span class="sc">${score ?? 0}</span></div>`;
}

function renderGroups(groups) {
  const view = $("#view-groups");
  view.innerHTML = "";
  if (!groups.length) return;

  const title = el("div", "section-title", "<h2>مجموعات البطولة</h2>");
  view.appendChild(title);

  const grid = el("div", "groups-grid");
  groups.forEach((g, i) => grid.appendChild(groupCard(g, i)));
  view.appendChild(grid);
}

function groupCard(g, i) {
  const card = el("div", "group-card");
  card.style.animationDelay = i * 0.04 + "s";
  const rows = (g.table || [])
    .map((t, idx) => {
      const q = idx < 2 ? " qualify" : "";
      return `<tr class="${q.trim()}">
        <td class="rank">${idx + 1}</td>
        <td class="team-col"><span class="team-cell"><span class="f">${t.flag}</span><span class="t">${esc(t.ar)}</span></span></td>
        <td>${t.P}</td><td>${signed(t.GD)}</td><td class="pts">${t.Pts}</td></tr>`;
    })
    .join("");

  card.innerHTML = `
    <div class="group-head"><span class="letter">${esc(g.name)}</span><h3>المجموعة ${esc(g.name)}</h3></div>
    <table class="table">
      <thead><tr>
        <th>#</th><th class="team-col">المنتخب</th><th>لعب</th><th>+/−</th><th>نقاط</th>
      </tr></thead>
      <tbody>${rows || `<tr><td colspan="5" class="empty-row">لم تُلعب مباريات بعد</td></tr>`}</tbody>
    </table>`;
  return card;
}

/* ---------- tabs ---------- */
function applyTab() {
  $("#view-map").hidden = state.tab !== "map";
  $("#view-today").hidden = state.tab !== "today";
  $("#view-teams").hidden = state.tab !== "teams";
  $("#view-groups").hidden = state.tab !== "groups";
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === state.tab));
}
document.querySelectorAll(".tab").forEach((b) =>
  b.addEventListener("click", () => { state.tab = b.dataset.tab; applyTab(); })
);
$("#retry").addEventListener("click", () => load(true));

/* ---------- helpers ---------- */
function setEmpty(msg, showRetry) {
  $("#empty").hidden = false;
  $("#emptyMsg").textContent = msg;
  $("#retry").hidden = !showRetry;
}
// Arabic wording but Latin (English) digits everywhere — `-u-nu-latn` forces 0-9.
const AR_LATN = "ar-u-nu-latn";
function signed(n) { return n > 0 ? "+" + n : String(n); }
const TIME_OPTS = { hour: "2-digit", minute: "2-digit", hour12: false, hourCycle: "h23" };
function timeAr(ts) {
  try { return new Date(ts).toLocaleTimeString(AR_LATN, TIME_OPTS); }
  catch { return "—"; }
}
function dateAr(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(AR_LATN, { day: "numeric", month: "short" }) + " · " +
           d.toLocaleTimeString(AR_LATN, TIME_OPTS);
  } catch { return "—"; }
}
// Local-timezone day key (YYYY-MM-DD) — string comparison keeps chronological order.
function dayKey(dt) {
  try { return dt.toLocaleDateString("en-CA"); } catch { return ""; }
}
function dayAr(key) {
  try {
    return new Date(key + "T12:00:00").toLocaleDateString(AR_LATN, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  } catch { return key; }
}
function byKickoff(a, b) {
  return (a.kickoff || "").localeCompare(b.kickoff || "");
}

/* ---------- boot ---------- */
load(true);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(false); });
