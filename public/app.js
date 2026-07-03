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

let state = { data: null, tab: "map", filter: "all", timer: null };

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

  renderMap(d.knockout || [], d.groups || []);
  renderTeams(d.groups || []);
  renderGroups(d.groups || []);
  applyTab();
}

/* ---------- bracket MAP (hero) — mirrored tree, flags left & right, trophy center ---------- */
function renderMap(rounds, groups) {
  const view = $("#view-map");
  view.innerHTML = "";
  view.appendChild(el("div", "section-title", "<h2>خريطة البطولة</h2>"));

  // Knockout rounds excluding the third-place playoff and the final (final sits in the center).
  const tree = rounds.filter((r) => r.stage !== "third" && r.stage !== "final");
  const final = rounds.find((r) => r.stage === "final");

  if (!tree.length && !final) {
    // Knockout not started: seed a preview map from qualified teams (top 2 of each group).
    const seeded = seedFromGroups(groups);
    if (!seeded) {
      view.appendChild(el("div", "empty-row", "ستظهر خريطة الأدوار الإقصائية هنا فور انطلاقها."));
      return;
    }
    view.appendChild(seeded);
    view.appendChild(el("p", "map-note", "خريطة مبدئية بالمنتخبات المتأهلة — تُحدَّث تلقائيًا عند بدء الأدوار الإقصائية."));
    return;
  }

  const bmap = mapBracket(tree, final);
  view.appendChild(bmap);
  view.appendChild(el("p", "map-note", "اسحب لأعلى/أسفل لتصفّح الخريطة كاملة — تُحدَّث النتائج تلقائيًا بعد كل مباراة."));
  // Draw connector lines after layout settles.
  requestAnimationFrame(() => drawConnectors(bmap));
}

const SVGNS = "http://www.w3.org/2000/svg";

// Draw the bracket's connector lines as a measured SVG overlay so they stay
// correct at any width / team count. Pairs match j in a column with match
// floor(j/2) in the next inner column, plus the two semi-finals into the final.
function drawConnectors(bmap) {
  if (!bmap || !bmap.isConnected) return;
  const w = bmap.clientWidth, h = bmap.clientHeight;
  if (!w || !h) return;
  const base = bmap.getBoundingClientRect();
  bmap.querySelectorAll("svg.bm-lines").forEach((s) => s.remove());
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("class", "bm-lines");
  svg.setAttribute("width", w);
  svg.setAttribute("height", h);
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

  const edge = (elm, side) => {
    const r = elm.getBoundingClientRect();
    return { x: (side === "right" ? r.right : r.left) - base.left, y: r.top + r.height / 2 - base.top };
  };
  const elbow = (a, b) => {
    const midX = (a.x + b.x) / 2;
    const d = `M ${a.x} ${a.y} H ${midX} V ${b.y} H ${b.x}`;
    const path = document.createElementNS(SVGNS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "rgba(255,255,255,0.18)");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
  };
  const matches = (col) => [...col.querySelectorAll(".bm-match:not(.placeholder)")];

  bmap.querySelectorAll(".half").forEach((half) => {
    const outward = half.classList.contains("left"); // left: inner side = right edge
    const inSide = outward ? "right" : "left";
    const outSide = outward ? "left" : "right";
    const cols = [...half.querySelectorAll(".bm-round")].sort(
      (a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left
    );
    // Visual order: outer → inner is toward the center.
    const ordered = outward ? cols : cols.slice().reverse();
    for (let i = 0; i < ordered.length - 1; i++) {
      const A = matches(ordered[i]), B = matches(ordered[i + 1]);
      A.forEach((am, j) => {
        const bm = B[Math.floor(j / 2)];
        if (!bm) return;
        elbow(edge(am, inSide), edge(bm, outSide));
      });
    }
    // Innermost column into the final (center).
    const finalMatch = bmap.querySelector(".bm-center .bm-match");
    const inner = ordered[ordered.length - 1] && matches(ordered[ordered.length - 1]);
    if (finalMatch && inner && inner.length) {
      elbow(edge(inner[0], inSide), edge(finalMatch, outward ? "left" : "right"));
    }
  });

  bmap.insertBefore(svg, bmap.firstChild);
}

// Build the mirrored bracket. `tree` = rounds outer→inner (excluding final); `final` = final round.
function mapBracket(tree, final) {
  const wrap = el("div", "bmap");

  const leftHalf = el("div", "half left");
  const rightHalf = el("div", "half right");

  tree.forEach((r) => {
    const ms = r.matches || [];
    const half = Math.ceil(ms.length / 2);
    leftHalf.appendChild(roundCol(ms.slice(0, half), r.ar));
    rightHalf.appendChild(roundCol(ms.slice(half), r.ar));
  });

  // Center column: final match + trophy + champion.
  const center = el("div", "bm-center");
  const fm = final && final.matches && final.matches[0];
  const champ = fm && champion(fm);
  center.appendChild(el("div", "bm-final-label", "النهائي"));
  center.appendChild(el("div", "bm-trophy" + (champ ? " won" : ""), "🏆"));
  if (fm) {
    const fc = matchNode(fm, true);
    center.appendChild(fc);
  }
  center.appendChild(el("div", "bm-champ", champ ? `<span class="f">${champ.flag}</span><span>${esc(champ.ar)}</span>` : `<span class="tbd">البطل</span>`));

  wrap.appendChild(leftHalf);
  wrap.appendChild(center);
  wrap.appendChild(rightHalf);
  return wrap;
}

function roundCol(matches, roundAr) {
  const col = el("div", "bm-round");
  col.setAttribute("data-round", roundAr || "");
  if (!matches.length) {
    col.appendChild(el("div", "bm-match placeholder", ""));
    return col;
  }
  matches.forEach((m) => col.appendChild(matchNode(m, false)));
  return col;
}

function matchNode(m, isFinal) {
  const node = el("div", "bm-match" + (isFinal ? " final" : "") + (m.state === "live" ? " live" : ""));
  node.appendChild(teamSlot(m, "home"));
  node.appendChild(teamSlot(m, "away"));
  if (m.state === "live") node.appendChild(el("span", "bm-live", "●"));
  return node;
}

function teamSlot(m, side) {
  const t = m[side];
  const s = side === "home" ? m.hs : m.as;
  const o = side === "home" ? m.as : m.hs;
  const decided = m.state === "finished" && s !== null && o !== null;
  const cls = decided ? (s > o ? " win" : s < o ? " lose" : "") : "";
  const slot = el("div", "bm-slot" + cls);
  slot.innerHTML = `<span class="f">${t.flag}</span><span class="s">${s === null ? "" : s}</span>`;
  slot.title = t.ar;
  return slot;
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

function champion(m) {
  if (!m || m.state !== "finished" || m.hs === null || m.as === null) return null;
  if (m.hs > m.as) return m.home;
  if (m.as > m.hs) return m.away;
  return null;
}

/* ---------- tabs ---------- */
function applyTab() {
  $("#view-map").hidden = state.tab !== "map";
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

/* ---------- boot ---------- */
load(true);
state.timer = setInterval(() => load(false), REFRESH_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(false); });

// Redraw the bracket connectors on resize / orientation change.
let rzTimer;
window.addEventListener("resize", () => {
  clearTimeout(rzTimer);
  rzTimer = setTimeout(() => {
    const bmap = document.querySelector("#view-map .bmap");
    if (bmap) drawConnectors(bmap);
  }, 150);
});
