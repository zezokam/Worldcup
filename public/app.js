/* World Cup 2026 front-end. Fetches normalized data from the edge worker,
   renders group tables + knockout bracket, and auto-refreshes so the page
   always reflects the latest state after each match. */

const API = "/api/bracket";
const REFRESH_MS = 60000;

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let state = { data: null, tab: "teams", filter: "all", timer: null };

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

  renderTeams(d.groups || []);
  renderGroups(d.groups || []);
  renderBracket(d.knockout || [], d);
  applyTab();
}

/* ---------- teams grid (hero view) ---------- */
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

function renderLiveStrip(live) {
  const strip = $("#liveStrip");
  strip.innerHTML = "";
  if (!live.length) { strip.hidden = true; return; }
  strip.hidden = false;
  for (const m of live) {
    const card = el("div", "live-card");
    card.innerHTML = `
      <div class="lc-top"><span>${esc(m.stageAr || "")}</span><span class="lc-min">${esc(m.minute || "مباشر")}</span></div>
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

function renderBracket(rounds, d) {
  const view = $("#view-bracket");
  view.innerHTML = "";
  if (!rounds.length) {
    view.appendChild(el("div", "section-title", "<h2>خط سير البطولة</h2>"));
    view.appendChild(el("div", "empty-row", "لم تبدأ الأدوار الإقصائية بعد — ستظهر شجرة المباريات هنا تلقائيًا."));
    return;
  }
  view.appendChild(el("div", "section-title", "<h2>خط سير البطولة</h2>"));

  const ko = el("div", "ko");

  // Champion banner when the final is decided.
  const final = rounds.find((r) => r.stage === "final");
  const champ = final && champion(final.matches[0]);
  if (champ) {
    ko.appendChild(el("div", "champ-banner",
      `<span class="cb-cup">🏆</span><span class="cb-txt">بطل العالم</span>
       <span class="cb-team"><span class="f">${champ.flag}</span>${esc(champ.ar)}</span>`));
  }

  rounds.forEach((r) => ko.appendChild(koRound(r)));
  view.appendChild(ko);
}

function koRound(r) {
  const isFinal = r.stage === "final";
  const round = el("div", "ko-round" + (isFinal ? " final" : ""));
  round.appendChild(el("div", "ko-round-head",
    `<span class="line"></span><h3>${isFinal ? "🏆 " : ""}${esc(r.ar)}</h3><span class="line"></span>`));
  const wrap = el("div", "ko-matches");
  (r.matches || []).forEach((m) => wrap.appendChild(matchCard(m, r.stage)));
  round.appendChild(wrap);
  return round;
}

function matchCard(m, stage) {
  const card = el("div", "match" + (m.state === "live" ? " is-live" : "") + (stage === "final" ? " is-final" : ""));
  const meta =
    m.state === "live"
      ? `<span class="live">● ${esc(m.minute || "مباشر")}</span>`
      : m.state === "finished"
      ? "انتهت"
      : dateAr(m.kickoff);
  card.innerHTML = `<div class="m-meta">${meta}</div>${teamLine(m, "home")}${teamLine(m, "away")}`;
  return card;
}

function teamLine(m, side) {
  const t = m[side];
  const s = side === "home" ? m.hs : m.as;
  const o = side === "home" ? m.as : m.hs;
  const decided = m.state === "finished" && s !== null && o !== null;
  const cls = decided ? (s > o ? " win" : s < o ? " lose" : "") : "";
  const score = s === null ? "" : s;
  return `<div class="m-team${cls}"><span class="nm"><span class="f">${t.flag}</span><span class="t">${esc(t.ar)}</span></span><span class="sc">${score}</span></div>`;
}

function champion(m) {
  if (!m || m.state !== "finished" || m.hs === null || m.as === null) return null;
  if (m.hs > m.as) return m.home;
  if (m.as > m.hs) return m.away;
  return null;
}

/* ---------- tabs ---------- */
function applyTab() {
  $("#view-teams").hidden = state.tab !== "teams";
  $("#view-groups").hidden = state.tab !== "groups";
  $("#view-bracket").hidden = state.tab !== "bracket";
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
function signed(n) { return n > 0 ? "+" + n : String(n); }
function timeAr(ts) {
  try { return new Date(ts).toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" }); }
  catch { return "—"; }
}
function dateAr(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("ar-SA", { day: "numeric", month: "short" }) + " · " +
           d.toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit" });
  } catch { return "—"; }
}

/* ---------- boot ---------- */
load(true);
state.timer = setInterval(() => load(false), REFRESH_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(false); });
