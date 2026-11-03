// Generates the profile cards (overview, activity, languages) as static SVGs.
// Runs in GitHub Actions; no dependencies. Usage:
//   GH_TOKEN=... GH_USER=maxtherox node .github/scripts/profile-cards.mjs dist
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TOKEN = process.env.GH_TOKEN;
const LOGIN = process.env.GH_USER || "maxtherox";
const OUT = process.argv[2] || "dist";

// Languages that describe tooling, not code written.
const IGNORED_LANGUAGES = new Set(["Batchfile", "Roff", "Dockerfile", "Makefile", "CMake", "Procfile", "NSIS", "Inno Setup"]);
const FONT = "'Segoe UI', Ubuntu, 'Helvetica Neue', Arial, sans-serif";
const MONO = "'JetBrains Mono', 'Fira Code', Consolas, monospace";

const THEMES = {
  dark: {
    bg: "#0d1117", border: "#30363d", text: "#e6edf3", muted: "#8b949e", grid: "#21262d",
    accentA: "#7aa2f7", accentB: "#bb9af7", cyan: "#2ac3de", fire: "#ff9e64",
  },
  light: {
    bg: "#ffffff", border: "#d0d7de", text: "#1f2328", muted: "#59636e", grid: "#eaeef2",
    accentA: "#3b5bdb", accentB: "#7c3aed", cyan: "#0891b2", fire: "#e8590c",
  },
};

if (!TOKEN) {
  console.error("GH_TOKEN is not set");
  process.exit(1);
}

async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json", "User-Agent": "profile-cards" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors || json));
  return json.data;
}

async function fetchRepos() {
  const repos = [];
  let cursor = null;
  do {
    const data = await gql(
      `query($login:String!,$cursor:String){ user(login:$login){
        repositories(ownerAffiliations:OWNER, isFork:false, first:100, after:$cursor){
          totalCount pageInfo{ hasNextPage endCursor }
          nodes{ isPrivate stargazerCount
            languages(first:15, orderBy:{field:SIZE, direction:DESC}){ edges{ size node{ name color } } } }
        } } }`,
      { login: LOGIN, cursor },
    );
    const page = data.user.repositories;
    repos.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return repos;
}

async function fetchCalendar() {
  const meta = await gql(`query($login:String!){ user(login:$login){ contributionsCollection{ contributionYears } } }`, { login: LOGIN });
  const years = meta.user.contributionsCollection.contributionYears;
  const now = new Date();
  const fields = years.map((y) => {
    const to = y === now.getUTCFullYear() ? now.toISOString() : `${y}-12-31T23:59:59Z`;
    return `y${y}: contributionsCollection(from:"${y}-01-01T00:00:00Z", to:"${to}"){
      contributionCalendar{ totalContributions weeks{ contributionDays{ date contributionCount } } } }`;
  });
  const data = await gql(`query($login:String!){ user(login:$login){ ${fields.join("\n")} } }`, { login: LOGIN });
  const days = [];
  const totals = {};
  for (const y of years) {
    const cal = data.user[`y${y}`].contributionCalendar;
    totals[y] = cal.totalContributions;
    for (const w of cal.weeks) for (const d of w.contributionDays) days.push({ date: d.date, count: d.contributionCount });
  }
  const unique = [...new Map(days.map((d) => [d.date, d])).values()].sort((a, b) => a.date.localeCompare(b.date));
  return { years, totals, days: unique };
}

function streaks(days) {
  let longest = 0, run = 0, longestEnd = null;
  for (const d of days) {
    run = d.count > 0 ? run + 1 : 0;
    if (run > longest) { longest = run; longestEnd = d.date; }
  }
  // Today still counts as "in progress": an empty today does not break the streak.
  let i = days.length - 1;
  if (i >= 0 && days[i].count === 0) i--;
  let current = 0;
  while (i >= 0 && days[i].count > 0) { current++; i--; }
  return { current, longest, longestEnd };
}

// Linguist colors such as Lua (#000080) vanish on a dark card: mix those toward white.
function readable(hex, t) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return t.muted;
  const n = parseInt(m[1], 16), rgb = [n >> 16, (n >> 8) & 255, n & 255];
  const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  if (t !== THEMES.dark || lum >= 0.3) return `#${m[1]}`;
  return `#${rgb.map((c) => Math.round(c + (255 - c) * 0.45).toString(16).padStart(2, "0")).join("")}`;
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmt = (n) => n.toLocaleString("en-US");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (iso) => { const [y, m, d] = iso.split("-"); return `${MONTHS[+m - 1]} ${+d}, ${y}`; };

function frame(t, w, h, title, body, extraDefs = "") {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<defs>
  <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${t.accentA}"/><stop offset="1" stop-color="${t.accentB}"/></linearGradient>
  ${extraDefs}
</defs>
<style>
  text{font-family:${FONT};fill:${t.text}}
  .muted{fill:${t.muted}} .title{font-size:15px;font-weight:600} .label{font-size:12px}
  .big{font-size:30px;font-weight:700} .mid{font-size:20px;font-weight:700} .mono{font-family:${MONO}}
  .in{animation:fade .6s ease-out both}
  @keyframes fade{from{opacity:0}}
  @media (prefers-reduced-motion:reduce){.in{animation:none}}
</style>
<clipPath id="card"><rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="12"/></clipPath>
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="12" fill="${t.bg}"/>
<rect x="0" y="0" width="${w}" height="3" fill="url(#accent)" clip-path="url(#card)"/>
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="12" fill="none" stroke="${t.border}"/>
${body}
</svg>
`;
}

function overviewCard(t, s) {
  const w = 480, h = 200;
  const col = (x, value, label, sub, color, delay) => `
  <g class="in" style="animation-delay:${delay}s">
    <text x="${x}" y="98" text-anchor="middle" class="big" style="fill:${color}">${esc(value)}</text>
    <text x="${x}" y="122" text-anchor="middle" class="label">${esc(label)}</text>
    <text x="${x}" y="140" text-anchor="middle" class="label muted">${esc(sub)}</text>
  </g>`;
  const body = `
  <text x="24" y="36" class="title">Contribution overview</text>
  <text x="${w - 24}" y="36" text-anchor="end" class="label muted mono">since ${s.since}</text>
  ${col(88, fmt(s.allTime), "All-time", "contributions", t.accentA, 0)}
  <line x1="168" y1="72" x2="168" y2="146" stroke="${t.border}"/>
  ${col(240, `${s.current}d`, "Current streak", s.current ? "and counting" : "start today", t.fire, 0.15)}
  <line x1="312" y1="72" x2="312" y2="146" stroke="${t.border}"/>
  ${col(392, `${s.longest}d`, "Longest streak", s.longestEnd ? `ended ${shortDate(s.longestEnd)}` : "-", t.accentB, 0.3)}
  <line x1="24" y1="160" x2="${w - 24}" y2="160" stroke="${t.grid}"/>
  <text x="24" y="182" class="label muted">${s.year}: <tspan style="fill:${t.text};font-weight:600">${fmt(s.thisYear)}</tspan></text>
  <text x="${w / 2}" y="182" text-anchor="middle" class="label muted">Best day: <tspan style="fill:${t.text};font-weight:600">${fmt(s.bestDay.count)}</tspan></text>
  <text x="${w - 24}" y="182" text-anchor="end" class="label muted">Repositories: <tspan style="fill:${t.text};font-weight:600">${fmt(s.repoCount)}</tspan></text>`;
  return frame(t, w, h, `${LOGIN} contribution overview`, body);
}

// Catmull-Rom spline through the points, as cubic Bezier segments. Control points are
// clamped to [minY, maxY] so the curve never dips below the baseline.
function smoothPath(pts, minY, maxY) {
  const cy = (v) => Math.min(Math.max(v, minY), maxY);
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, cy(p1[1] + (p2[1] - p0[1]) / 6)];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, cy(p2[1] - (p3[1] - p1[1]) / 6)];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

function niceMax(v) {
  if (v <= 5) return 5;
  const mag = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((m) => m >= v);
}

function activityCard(t, days) {
  const w = 980, h = 280, left = 56, right = 24, top = 64, bottom = 44;
  const weeks = [];
  const recent = days.slice(-52 * 7);
  for (let i = 0; i < recent.length; i += 7) {
    const chunk = recent.slice(i, i + 7);
    weeks.push({ start: chunk[0].date, count: chunk.reduce((a, d) => a + d.count, 0) });
  }
  const max = niceMax(Math.max(...weeks.map((x) => x.count), 1));
  const pw = w - left - right, ph = h - top - bottom;
  const x = (i) => left + (pw * i) / (weeks.length - 1);
  const y = (v) => top + ph - (ph * v) / max;
  const pts = weeks.map((wk, i) => [x(i), y(wk.count)]);
  const line = smoothPath(pts, top, top + ph);
  const area = `${line} L${x(weeks.length - 1).toFixed(1)},${top + ph} L${left},${top + ph} Z`;
  const total = weeks.reduce((a, wk) => a + wk.count, 0);
  const peakIdx = weeks.reduce((b, wk, i) => (wk.count > weeks[b].count ? i : b), 0);

  let grid = "";
  for (let g = 0; g <= 4; g++) {
    const v = (max / 4) * g, gy = y(v);
    grid += `<line x1="${left}" y1="${gy.toFixed(1)}" x2="${w - right}" y2="${gy.toFixed(1)}" stroke="${t.grid}"${g ? ' stroke-dasharray="3 4"' : ""}/>
  <text x="${left - 10}" y="${(gy + 4).toFixed(1)}" text-anchor="end" class="label muted mono">${fmt(Math.round(v))}</text>`;
  }
  let months = "", lastMonth = -1;
  weeks.forEach((wk, i) => {
    const m = +wk.start.split("-")[1] - 1;
    if (m !== lastMonth && i > 0) months += `<text x="${x(i).toFixed(1)}" y="${h - 18}" text-anchor="middle" class="label muted">${MONTHS[m]}</text>`;
    lastMonth = m;
  });
  const [px, py] = pts[peakIdx];
  const tipW = 132, tipX = Math.min(Math.max(px - tipW / 2, left), w - right - tipW);
  const defs = `<linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.accentA}" stop-opacity=".45"/><stop offset="1" stop-color="${t.accentB}" stop-opacity="0"/></linearGradient>
  <clipPath id="reveal"><rect x="0" y="0" width="${w}" height="${h}"><animate attributeName="width" from="0" to="${w}" dur="1.4s" fill="freeze" calcMode="spline" keySplines=".2 .7 .2 1" keyTimes="0;1"/></rect></clipPath>`;
  const body = `
  <text x="24" y="36" class="title">Contribution activity</text>
  <text x="${w - 24}" y="36" text-anchor="end" class="label muted">last 52 weeks · <tspan style="fill:${t.text};font-weight:600">${fmt(total)}</tspan> contributions</text>
  ${grid}
  ${months}
  <g clip-path="url(#reveal)">
    <path d="${area}" fill="url(#fill)"/>
    <path d="${line}" fill="none" stroke="url(#accent)" stroke-width="2.5" stroke-linecap="round"/>
  </g>
  <g class="in" style="animation-delay:1.2s">
    <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="5" fill="${t.bg}" stroke="${t.fire}" stroke-width="2.5"/>
    <rect x="${tipX.toFixed(1)}" y="${(py - 34).toFixed(1)}" width="${tipW}" height="22" rx="6" fill="${t.bg}" stroke="${t.border}"/>
    <text x="${(tipX + tipW / 2).toFixed(1)}" y="${(py - 19).toFixed(1)}" text-anchor="middle" class="label">Peak: <tspan style="font-weight:700;fill:${t.fire}">${fmt(weeks[peakIdx].count)}</tspan> / week</text>
  </g>`;
  return frame(t, w, h, `${LOGIN} contribution activity`, body, defs);
}

function languagesCard(t, repos) {
  const w = 480, h = 200;
  const sizes = new Map();
  for (const r of repos) for (const e of r.languages.edges) {
    if (IGNORED_LANGUAGES.has(e.node.name)) continue;
    const cur = sizes.get(e.node.name) || { size: 0, color: readable(e.node.color, t) };
    cur.size += e.size;
    sizes.set(e.node.name, cur);
  }
  const sorted = [...sizes.entries()].sort((a, b) => b[1].size - a[1].size);
  const top = sorted.slice(0, 8);
  const total = top.reduce((a, [, v]) => a + v.size, 0) || 1;
  const barX = 24, barW = w - 48;
  let bar = "", acc = 0;
  top.forEach(([name, v], i) => {
    const bw = (barW * v.size) / total;
    bar += `<rect x="${(barX + acc).toFixed(2)}" y="56" width="${Math.max(bw - (i < top.length - 1 ? 2 : 0), 0).toFixed(2)}" height="10" fill="${v.color}"/>`;
    acc += bw;
  });
  let legend = "";
  top.forEach(([name, v], i) => {
    const cx = i % 2 === 0 ? 24 : w / 2 + 8, cy = 94 + Math.floor(i / 2) * 26;
    const pct = ((100 * v.size) / total).toFixed(1);
    legend += `<g class="in" style="animation-delay:${(0.08 * i).toFixed(2)}s">
    <circle cx="${cx + 5}" cy="${cy - 4}" r="5" fill="${v.color}"/>
    <text x="${cx + 18}" y="${cy}" class="label">${esc(name)}</text>
    <text x="${cx + (w / 2 - 40)}" y="${cy}" text-anchor="end" class="label muted mono">${pct}%</text>
  </g>`;
  });
  const body = `
  <text x="24" y="36" class="title">Most used languages</text>
  <text x="${w - 24}" y="36" text-anchor="end" class="label muted mono">${fmt(repos.length)} repos</text>
  <clipPath id="barclip"><rect x="${barX}" y="56" width="${barW}" height="10" rx="5"/></clipPath>
  <g clip-path="url(#barclip)">${bar}</g>
  ${legend}`;
  return frame(t, w, h, `${LOGIN} most used languages`, body);
}

const [calendar, repos] = await Promise.all([fetchCalendar(), fetchRepos()]);
const { current, longest, longestEnd } = streaks(calendar.days);
const year = Math.max(...calendar.years);
const stats = {
  since: Math.min(...calendar.years),
  allTime: Object.values(calendar.totals).reduce((a, b) => a + b, 0),
  thisYear: calendar.totals[year],
  year,
  current, longest, longestEnd,
  bestDay: calendar.days.reduce((b, d) => (d.count > b.count ? d : b), { count: 0 }),
  repoCount: repos.length,
};

mkdirSync(OUT, { recursive: true });
for (const [name, t] of Object.entries(THEMES)) {
  writeFileSync(join(OUT, `overview-${name}.svg`), overviewCard(t, stats));
  writeFileSync(join(OUT, `activity-${name}.svg`), activityCard(t, calendar.days));
  writeFileSync(join(OUT, `languages-${name}.svg`), languagesCard(t, repos));
}
console.log(JSON.stringify({ ...stats, privateRepos: repos.filter((r) => r.isPrivate).length }));
