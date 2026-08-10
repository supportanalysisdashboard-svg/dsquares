'use strict';
/* Support Analysis Dashboard — static single-page app. Renders everything
   client-side from pre-built JSON files (web/data/*) so it stays instant
   no matter how large the dataset is. */

/* ============================== CONFIG ============================== */
const NAVY = '#002147', BLUE = '#0055A4', LIGHT = '#00AEEF', RED = '#FF4B4B', GREEN = '#00873d';
const PIE_COLORS = ['#0055A4','#00AEEF','#16A34A','#F59E0B','#7C3AED','#EF4444','#0D9488','#DB2777','#65A30D','#0E7490'];
const TYPE_SHARE_COLORS = {
  'Technical issue': '#0066CC',
  'Inquiry': '#0A2240',
  'Connectivity': '#0088CC',
  'Request': '#004C99',
  'Others': '#80C4FF',
  'Maintenance': '#4A90E2',
  'Complaints': '#FF2D2D',
};
const BLACKLIST = new Set([
  '','n/a','n.a','n','dropped call','call dropped','out of our scope','other','0','na',' ',
  'N','none','nan','N/A','0.0','NaN','None','n/m','N/M',"what's app"
]);
const DATE_PRESETS = ['Last 3 months','Last 6 months','Last 12 months','All time','Custom range'];
const EXP_PAGE_SIZE = 100;
const TAB_EMOJI = {Overview:'🏠','Quality Board':'🏆','WhatsApp MOM':'💬','Inbound SLA':'📈','Redemption Tracker':'💰','Ticket Explorer':'🎫'};
const HOVER_STYLE = { backgroundColor:'#001e42', borderColor:'#00AEEF', textStyle:{color:'#fff', fontSize:12, fontFamily:'DM Sans'} };

/* ============================== STATE ============================== */
const S = {
  auth: null,
  authBase: null,              // raw access.json before localStorage overrides
  session: null,               // {role, key, projects, is_vodafone, logo}
  meta: null,
  tickets: null,               // {cols, rows}
  colIdx: {},
  agent: null, sla: null, redemption: null,
  filters: { dateMode:null, customStart:null, customEnd:null,
             merchant:[], project:[], branch:[], district:[], type:[], subtype:[], microtype:[], action:[], status:[] },
  fSearch: {},
  clickFilter: { col:null, val:null },
  activeTab: 0,
  ovTeam: 0,                   // 0 = Merchant Support, 1 = Client Support
  drill: { merchant:null, client:null },
  slideshow: false,
  slideIndex: 0,
  ffBase: null,
  charts: [],
  build: null,
  liveActive: false,
  liveStamp: null,
  redLiveStamp: null,
};

/* ============================== HELPERS ============================== */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (n) => Number(n).toLocaleString('en-US');
const inBlack = (v) => BLACKLIST.has(String(v == null ? '' : v).trim().toLowerCase());
const cleanVal = (v) => String(v == null ? '' : v).trim();
const logoSrc = (l) => (/^(data:|https?:|blob:)/.test(String(l == null ? '' : l)) ? l : 'assets/' + l);
const defaultDateMode = () => (S.session ? (S.session.role === 'admin' ? 'All time' : 'Last 3 months') : 'All time');

function col(name) { return S.colIdx[name]; }
function get(row, name) { const i = col(name); return i == null ? '' : row[i]; }

function parseNum(v) {
  if (v == null) return 0;
  const s = String(v).replace(/[%,]/g, '').replace(/EGP/gi, '').trim();
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function iso(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function monthOf(isoStr) { return String(isoStr).slice(0, 7); }
function monthName(isoStr) {
  const m = monthOf(isoStr);
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  if (m.length < 7) return m;
  const idx = parseInt(m.slice(5, 7), 10) - 1;
  return names[idx] || m;
}

/* ------------------------------ DATA LOADING ------------------------------ */
async function fetchJson(url, opts) {
  if (typeof opts === 'boolean') opts = { bust: opts };
  opts = opts || {};
  let u = url;
  if (opts.version) u += (u.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(opts.version);
  else if (opts.bust) u += (u.includes('?') ? '&' : '?') + 't=' + Date.now();
  const res = await fetch(u, { cache: (opts.bust && !opts.version) ? 'no-store' : 'default' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  if (url.endsWith('.gz')) {
    const enc = res.headers.get('Content-Encoding') || '';
    if (/gzip/i.test(enc)) return await res.json();
    if (typeof DecompressionStream !== 'undefined') {
      try {
        const blob = await res.blob();
        const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
        const text = await new Response(stream).text();
        return JSON.parse(text);
      } catch (e) { console.warn('gzip decode failed for ' + url + ' — falling back to raw JSON', e); }
    }
    return await fetchJson(url.replace(/\.gz$/, ''), opts);
  }
  return await res.json();
}

async function loadData(force) {
  showLoading('Loading metadata…');
  const meta = await fetchJson('data/meta.json', { bust: true });
  S.meta = meta;
  S.build = meta.updated_iso || String(Date.now());
  const opts = force ? { bust: true } : { version: S.build };
  showLoading('Loading tickets…');
  S.tickets = await fetchJson('data/tickets.json.gz', opts);
  S.colIdx = {};
  S.tickets.cols.forEach((c, i) => { S.colIdx[c] = i; });
  showLoading('Loading quality data…');
  S.agent = await fetchJson('data/agent.json', opts);
  S.sla = await fetchJson('data/sla.json', opts);
  S.redemption = normalizeRedemption(await fetchJson('data/redemption.json', opts));
}

/* ============================== LIVE MODE ==============================
   Reads the two ticket tabs straight from Google Sheets (gviz CSV endpoint)
   so the dashboard shows every Freshdesk change the moment it lands in the
   sheet — no waiting for the hourly build. Falls back to the bundled data
   (web/data/*) whenever Google is unreachable. */
const LIVE_SHEET_ID = '1f3L3zsB9u_kje2QezsL5qWKeg0vfbVDK8u42Q_gaio8';
const LIVE_GIDS = { merchant: 471895160, client: 1950888044 };
const LIVE_SHORT_NAMES = {
  'Not Done': 'Solved',
  'This Number Belongs To An Inactive Wallet': 'Inactive Wallet',
  'Escalated- Tech Support': 'Esc-Tech',
  'Escalated- Field Team': 'Esc-FO',
  'Escalated- Management Team': 'Esc-MGT',
  'Escalated- Sys.Set-Up': 'Esc-Sys',
  'Escalated- Monitoring Team': 'Esc-M&C',
  'Escalated- Product Team': 'Esc-PR',
  'Escalated- CCubed Team': 'Esc-CCubed',
  'Escalated- Data Team': 'Esc-Data',
  'Escalated- Fraud Team': 'Esc-Fraud',
  'Escalated- YGG/Like Card': 'Esc-YGG',
  'Escalated- PS Team': 'Esc-PS',
  'Escalated- PM Team': 'Esc-PM',
  'Escalated- AM Team': 'Esc-AM',
  'Escalated- Merchant': 'Esc - Merchant',
  'Connection Problem or Invalid MMI Code': 'Connection Problem',
  'Mismatch (Coupon Number & CST MSISDN)': 'Mismatch',
};
const LIVE_PROJECT_RENAME = { 'Red Ramadan': 'VF Red Ramadan' };

function pad2(n) { return String(n).padStart(2, '0'); }

function parseCsv(text) {
  const t = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], cell = '', inQ = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inQ) {
      if (ch === '"') {
        if (t[i + 1] === '"') { cell += '"'; i++; }
        else inQ = false;
      } else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch === '\r') {}
    else cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  while (rows.length && rows[rows.length - 1].every((c) => c === '')) rows.pop();
  if (!rows.length) return { cols: [], rows: [] };
  return { cols: rows[0].map((c) => String(c == null ? '' : c).trim()), rows: rows.slice(1) };
}

async function fetchLiveTable(team) {
  const url = 'https://docs.google.com/spreadsheets/d/' + LIVE_SHEET_ID + '/gviz/tq?tqx=out:csv&gid=' + LIVE_GIDS[team];
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('Live sheet HTTP ' + res.status);
  return parseCsv(await res.text());
}

function liveDateObj(v) {
  if (v == null) return '';
  const s = String(v);
  const m = s.match(/\d{4}-\d{1,2}-\d{1,2}/);
  if (m) return m[0].replace(/^(\d{4})-(\d{1,2})-(\d{1,2})$/, (_, y, mo, d) => y + '-' + pad2(mo) + '-' + pad2(d));
  const dt = new Date(s);
  return isNaN(dt.getTime()) ? '' : iso(dt);
}

function isDate(v) {
  if (v == null) return false;
  const s = String(v).trim();
  if (!s) return false;
  if (/\d{4}-\d{1,2}-\d{1,2}/.test(s)) return true;
  if (!/[-/]/.test(s)) return false;
  return !isNaN(new Date(s).getTime());
}

function applyLiveStatus(cols, rows) {
  const ci = cols.indexOf('Closed time');
  if (ci < 0) return { cols: cols.concat(['Ticket_Status']), rows: rows.map((r) => r.concat(['Open'])) };
  return { cols: cols.concat(['Ticket_Status']), rows: rows.map((r) => r.concat([isDate(r[ci]) ? 'Closed' : 'Open'])) };
}

function applyLiveProjectRename(cols, rows) {
  const pi = cols.indexOf('Project');
  if (pi < 0) return { cols, rows };
  return { cols, rows: rows.map((r) => {
    if (r[pi] === 'Red Ramadan') { const nr = r.slice(); nr[pi] = 'VF Red Ramadan'; return nr; }
    return r;
  }) };
}

/* Mirrors pipeline/build_data.py::process_ticket_df — short-name renames,
   date column detection, D_Obj derivation, blank-date row drop. */
function processLiveTickets(cols, rows) {
  let out = rows.filter((r) => String(r[0] == null ? '' : r[0]).trim() !== '');
  let dateIdx = 0;
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i].toLowerCase();
    if (c.indexOf('created') >= 0 || c.indexOf('date') >= 0) { dateIdx = i; break; }
  }
  const parsed = [];
  for (const r of out) {
    const nr = r.map((v) => {
      const key = String(v == null ? '' : v);
      return LIVE_SHORT_NAMES[key] != null ? LIVE_SHORT_NAMES[key] : v;
    });
    const dObj = liveDateObj(nr[dateIdx]);
    if (!dObj) continue;
    nr.push(dObj);
    parsed.push(nr);
  }
  const withStatus = applyLiveStatus(cols.concat(['D_Obj']), parsed);
  return applyLiveProjectRename(withStatus.cols, withStatus.rows);
}

function mergeLiveTickets(a, b) {
  const cols = a.cols.concat(['_team']);
  for (const c of b.cols) if (cols.indexOf(c) < 0) cols.push(c);
  const idx = {};
  cols.forEach((c, i) => { idx[c] = i; });
  const mapRows = (srcCols, srcRows, team) => srcRows.map((r) => {
    const out = new Array(cols.length).fill('');
    srcCols.forEach((c, i) => { if (idx[c] != null) out[idx[c]] = r[i]; });
    out[idx['_team']] = team;
    return out;
  });
  return { cols, rows: mapRows(a.cols, a.rows, 'merchant').concat(mapRows(b.cols, b.rows, 'client')) };
}

function liveStamp(tickets) {
  const colsStr = tickets.cols.join(',');
  let h = 0;
  for (let i = 0; i < colsStr.length; i++) h = (h * 31 + colsStr.charCodeAt(i)) >>> 0;
  const relCols = ['Ticket_Status', 'Closed time', 'Status', 'Action taken', 'Created time'];
  const relIdx = relCols.map((c) => tickets.cols.indexOf(c)).filter((i) => i >= 0);
  for (const r of tickets.rows) {
    for (const i of relIdx) {
      const cell = String(r[i] == null ? '' : r[i]);
      for (let j = 0; j < cell.length; j++) h = (h * 33 + cell.charCodeAt(j)) >>> 0;
      h = (h * 33 + 7) >>> 0;
    }
  }
  return String(tickets.rows.length) + ':' + h;
}

function buildLiveMeta(tickets) {
  const cols = tickets.cols;
  const rows = tickets.rows;
  const doj = cols.indexOf('D_Obj');
  const teamI = cols.indexOf('_team');
  let minD = '', maxD = '', mc = 0, cc = 0;
  for (const r of rows) {
    if (teamI >= 0 && r[teamI] === 'merchant') mc++; else cc++;
    const d = doj >= 0 ? String(r[doj] || '') : '';
    if (d) { if (!minD || d < minD) minD = d; if (!maxD || d > maxD) maxD = d; }
  }
  const filterCols = ['Merchant', 'Project', 'Branch User Name', 'District', 'Ticket type', 'Ticket subtype', 'Call Microtype', 'Action taken'];
  const filters = {};
  for (const c of filterCols) {
    const ci = cols.indexOf(c);
    const set = new Set();
    if (ci >= 0) for (const r of rows) { const v = String(r[ci] == null ? '' : r[ci]).trim(); if (v) set.add(v); }
    filters[c] = Array.from(set).sort();
  }
  return { counts: { merchant: mc, client: cc, all: rows.length }, date_min: minD, date_max: maxD, filters };
}

async function refreshLiveData() {
  try {
    const [m, c] = await Promise.all([fetchLiveTable('merchant'), fetchLiveTable('client')]);
    const pm = processLiveTickets(m.cols, m.rows);
    const pc = processLiveTickets(c.cols, c.rows);
    const tickets = mergeLiveTickets(pm, pc);
    const stamp = liveStamp(tickets);
    if (stamp === S.liveStamp) return false;
    S.liveStamp = stamp;
    S.liveActive = true;
    S.tickets = { cols: tickets.cols, rows: tickets.rows };
    S.colIdx = {};
    tickets.cols.forEach((c, i) => { S.colIdx[c] = i; });
    const lm = buildLiveMeta(tickets);
    const now = new Date();
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    S.meta.counts = lm.counts;
    S.meta.date_min = lm.date_min;
    S.meta.date_max = lm.date_max;
    S.meta.filters = lm.filters;
    S.meta.updated = pad2(now.getDate()) + ' ' + MON[now.getMonth()] + ' ' + now.getFullYear() + ' ' + pad2(now.getHours()) + ':' + pad2(now.getMinutes());
    S.meta.updated_iso = now.toISOString();
    S.meta.source = 'live';
    return true;
  } catch (e) {
    console.warn('Live sheet refresh failed — keeping bundled data', e);
    return false;
  }
}

/* ------------------------- REDEMPTION TRACKER (live) -------------------------
   The Redemption Tracker tab holds pre-calculated values that must be shown
   verbatim (not re-derived from raw tickets): a KPI row (Total Transactions |
   Top Agent | Total Redemption Amount) and an Agent table. It is read from the
   sheet's export endpoint because it preserves the exact cell layout (gviz
   compacts blank rows away, which would break the A2/B2/C2 / A6:C10 mapping). */
const LIVE_REDEMPTION_GID = 17439532;

async function fetchRedemptionLive() {
  const url = 'https://docs.google.com/spreadsheets/d/' + LIVE_SHEET_ID + '/export?format=csv&gid=' + LIVE_REDEMPTION_GID + '&_cb=' + Date.now();
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('Redemption sheet HTTP ' + res.status);
  return parseCsv(await res.text());
}

function structureRedemption(rows) {
  const kpi = { txn: 'N/A', agent: '', value: 'N/A' };
  const nonEmpty = rows.filter((r) => r.some((c) => String(c == null ? '' : c).trim() !== ''));
  for (const r of nonEmpty) {
    if (String(r[0] == null ? '' : r[0]).trim().slice(0, 1).match(/\d/)) {
      kpi.txn = String(r[0] == null ? '' : r[0]).trim() || 'N/A';
      kpi.agent = String(r[1] == null ? '' : r[1]).trim();
      kpi.value = String(r[2] == null ? '' : r[2]).trim() || 'N/A';
      break;
    }
  }
  const agentRows = [];
  const sub = nonEmpty.findIndex((r) => String(r[0] == null ? '' : r[0]).trim().toLowerCase() === 'agent');
  for (let i = sub + 1; i < nonEmpty.length; i++) {
    const r = nonEmpty[i];
    const name = String(r[0] == null ? '' : r[0]).trim();
    if (!name) continue;
    agentRows.push([name, String(r[1] == null ? '' : r[1]).trim(), String(r[2] == null ? '' : r[2]).trim()]);
  }
  if (!kpi.agent && agentRows.length) kpi.agent = agentRows[0][0];
  return { kpi, cols: ['Agent Name', 'Transaction Count', 'Total Redemption Value'], rows: agentRows };
}

function normalizeRedemption(raw) {
  if (!raw) return null;
  if (raw.kpi && raw.cols && raw.rows) return raw;
  return structureRedemption(raw.rows || []);
}

async function refreshRedemptionLive() {
  try {
    const parsed = await fetchRedemptionLive();
    const red = structureRedemption(parsed.rows);
    const stamp = JSON.stringify([red.kpi.txn, red.kpi.agent, red.kpi.value, red.rows.length,
      red.rows[0] ? red.rows[0].join('|') : '', red.rows[red.rows.length - 1] ? red.rows[red.rows.length - 1].join('|') : '']);
    if (stamp === S.redLiveStamp) return false;
    S.redLiveStamp = stamp;
    red.source = 'live';
    S.redemption = red;
    return true;
  } catch (e) {
    console.warn('Live redemption refresh failed', e);
    return false;
  }
}

async function refreshLiveAll() {
  const [a, b] = await Promise.all([refreshLiveData(), refreshRedemptionLive()]);
  return a || b;
}

/* ------------------------------ FILTER PIPELINE ------------------------------ */
function dateRange() {
  const mode = S.filters.dateMode;
  const maxStr = S.meta.date_max;
  if (mode === 'All time' || !mode) return null;
  if (mode === 'Custom range') {
    if (!S.filters.customStart || !S.filters.customEnd) return null;
    return { start: S.filters.customStart, end: S.filters.customEnd };
  }
  const months = parseInt(mode.split(' ')[1], 10) || 3;
  const max = new Date(maxStr + 'T00:00:00');
  const start = new Date(max);
  start.setDate(max.getDate() - months * 30);
  return { start: iso(start), end: iso(max) };
}

function baseFilter(row) {
  const d = dateRange();
  if (d) { const v = get(row, 'D_Obj'); if (!v || v < d.start || v > d.end) return false; }
  if (S.session && S.session.role === 'client' && S.session.projects) {
    if (!S.session.projects.includes(get(row, 'Project'))) return false;
  }
  return true;
}

function applyFilters(rows) {
  const f = S.filters;
  return rows.filter((r) => {
    if (f.merchant.length && !f.merchant.includes(get(r, 'Merchant'))) return false;
    if (f.project.length && !f.project.includes(get(r, 'Project'))) return false;
    if (f.branch.length && !f.branch.includes(get(r, 'Branch User Name'))) return false;
    if (f.district.length && !f.district.includes(get(r, 'District'))) return false;
    if (f.type.length && !f.type.includes(get(r, 'Ticket type'))) return false;
    if (f.subtype.length && !f.subtype.includes(get(r, 'Ticket subtype'))) return false;
    if (f.microtype.length && !f.microtype.includes(get(r, 'Call Microtype'))) return false;
    if (f.action.length && !f.action.includes(get(r, 'Action taken'))) return false;
    if (f.status.length && !f.status.includes(get(r, 'Ticket_Status'))) return false;
    if (S.clickFilter.col) {
      const cfIdx = col(S.clickFilter.col);
      if (cfIdx != null && cleanVal(get(r, S.clickFilter.col)) !== S.clickFilter.val) return false;
    }
    return true;
  });
}

function computeActiveFilters() {
  const f = S.filters, active = {};
  if (f.merchant.length) active.Merchant = f.merchant.join(', ');
  if (f.project.length) active.Project = f.project.join(', ');
  if (f.branch.length) active.Branch = f.branch.join(', ');
  if (f.district.length) active.District = f.district.join(', ');
  if (f.type.length) active['Ticket type'] = f.type.join(', ');
  if (f.subtype.length) active['Ticket subtype'] = f.subtype.join(', ');
  if (f.microtype.length) active['Ticket microtype'] = f.microtype.join(', ');
  if (f.action.length) active.Action = f.action.join(', ');
  if (f.status.length) active.Status = f.status.join(', ');
  if (f.dateMode && f.dateMode !== 'All time') {
    if (f.dateMode === 'Custom range') active.Date = `${f.customStart} → ${f.customEnd}`;
    else active.Date = f.dateMode;
  }
  if (S.clickFilter.col) active[S.clickFilter.col] = S.clickFilter.val;
  return active;
}

function cleanedUnique(rows, colName) {
  const out = new Set();
  for (const r of rows) {
    const v = cleanVal(get(r, colName));
    if (v && !inBlack(v)) out.add(v);
  }
  return Array.from(out).sort();
}

/* ------------------------------ AGGREGATION ------------------------------ */
function countBy(rows, colName, { clean = false, limit = null, sortDesc = true } = {}) {
  const counts = new Map();
  for (const r of rows) {
    let v = cleanVal(get(r, colName));
    if (clean && inBlack(v)) continue;
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  let arr = Array.from(counts.entries()).map(([name, value]) => ({ name, value }));
  arr.sort((a, b) => sortDesc ? b.value - a.value : (a.name < b.name ? -1 : 1));
  if (limit) arr = arr.slice(0, limit);
  return arr;
}

function topWithOthers(items, n = 6) {
  const sorted = items.slice().sort((a, b) => b.value - a.value);
  const top = sorted.slice(0, n);
  const rest = sorted.slice(n);
  const restSum = rest.reduce((s, x) => s + x.value, 0);
  if (restSum > 0) {
    const ex = top.find((x) => String(x.name).trim().toLowerCase() === 'others');
    if (ex) ex.value += restSum;
    else top.push({ name: 'Others', value: restSum });
  }
  return top;
}

function groupTop(rows, byCol, hoverCol, hoverN, { clean = true } = {}) {
  const top = countBy(rows, byCol, { clean, limit: 10 });
  return top.map((t) => {
    const sub = rows.filter((r) => cleanVal(get(r, byCol)) === t.name);
    const subArr = countBy(sub, hoverCol, { clean: true, limit: hoverN });
    const lines = subArr.map((x) => '• ' + x.name + ': ' + fmt(x.value));
    return { name: t.name, value: t.value, hover: lines.join('<br>'), link: subArr.map((x) => x.name) };
  });
}

function smartAnalysis(dataLen, baseLen) {
  const lines = [];
  if (!dataLen) return [['No data for this filter', 'gray']];
  const share = baseLen ? (dataLen / baseLen * 100) : 0;
  lines.push([share.toFixed(1) + '% of all tickets', NAVY]);
  if (dataLen > 0) {
    const mCounts = {};
    // peak month computed elsewhere (needs rows), filled by caller
    lines.push(['—', GREEN]);
  }
  return lines;
}

function topSafe(rows, colName) {
  const arr = countBy(rows, colName, { clean: true });
  return arr.length ? arr[0].name : 'N/A';
}

/* ============================== CHARTS ============================== */
function disposeCharts() {
  S.charts.forEach((c) => { try { c.dispose(); } catch (e) {} });
  S.charts = [];
}

function resizeChartsSoon() {
  requestAnimationFrame(() => {
    S.charts.forEach((c) => { try { c.resize(); } catch (e) {} });
  });
}

function chartIndexOf(chart, name) {
  try {
    const o = chart.getOption();
    if (!o) return -1;
    for (const s of o.series || []) {
      const d = s.data;
      if (Array.isArray(d)) {
        for (let i = 0; i < d.length; i++) {
          const it = d[i];
          const n = it && typeof it === 'object' ? it.name : null;
          if (n != null && String(n) === String(name)) return i;
        }
      }
    }
    for (const ax of o.xAxis || []) {
      if (Array.isArray(ax.data)) {
        for (let i = 0; i < ax.data.length; i++) {
          const it = ax.data[i];
          const n = it && typeof it === 'object' ? it.name : it;
          if (n != null && String(n) === String(name)) return i;
        }
      }
    }
  } catch (e) {}
  return -1;
}

// Hover linking matrix: hovering an item in a source chart highlights the related
// items (stored in each item's `link` array) in the paired target chart.
const HOVER_LINK_MATRIX = [
  { from: 'Volume Trend', to: 'Microtypes' },
  { from: 'Live Ticket Status', to: 'Action' },
  { from: 'Merchants', to: 'Microtypes' },
  { from: 'Branches', to: 'Merchants' },
  { from: 'Projects', to: 'Microtypes' },
  { from: 'Subtypes', to: 'Ticket Type' },
  { from: 'Microtypes', to: 'Subtypes' },
];

function chartTitle(c) {
  try { return (((c.getOption() || {}).title || [{}])[0] || {}).text || ''; } catch (e) { return ''; }
}

function chartByTitlePart(part, exclude) {
  let first = null;
  for (const c of S.charts) {
    if (c === exclude || c.isDisposed()) continue;
    if (chartTitle(c).indexOf(part) < 0) continue;
    if (!first) first = c;
    try {
      const dom = c.getDom();
      if (dom && dom.getClientRects().length) {
        const r = dom.getBoundingClientRect();
        if (r.width > 4 && r.height > 4) return c;
      }
    } catch (e) {}
  }
  return first;
}

function linkChartHover(chart) {
  const sourceTitle = chartTitle(chart);
  const rule = HOVER_LINK_MATRIX.find((r) => sourceTitle.indexOf(r.from) >= 0);
  if (!rule) return;
  let target = null;
  const sync = (item) => {
    try {
      if (!target || target.isDisposed()) target = chartByTitlePart(rule.to, chart);
      if (!target || target.isDisposed()) return;
      const link = item && item.data && Array.isArray(item.data.link) ? item.data.link : null;
      if (!link || !link.length) { target.dispatchAction({ type: 'downplay' }); return; }
      target.dispatchAction({ type: 'downplay' });
      const ns = (target.getOption().series || []).length;
      const seen = [];
      for (const n of link) {
        const idx = chartIndexOf(target, n);
        if (idx >= 0 && seen.indexOf(idx) < 0) {
          seen.push(idx);
          for (let si = 0; si < ns; si++) {
            target.dispatchAction({ type: 'highlight', seriesIndex: si, dataIndex: idx });
          }
        }
      }
    } catch (e) {}
  };
  chart.on('mouseover', (p) => { if (p && p.data != null) sync(p); });
  chart.on('mouseout', () => {
    try { if (target && !target.isDisposed()) target.dispatchAction({ type: 'downplay' }); } catch (e) {}
  });
}

let contentObserver = null;
function watchContentResize() {
  if (contentObserver || typeof ResizeObserver === 'undefined') return;
  const content = $('#content');
  if (!content) return;
  contentObserver = new ResizeObserver(() => { resizeChartsSoon(); });
  contentObserver.observe(content);
}

function mountChart(dom, option) {
  if (dom._chart) { try { dom._chart.dispose(); } catch (e) {} }
  const chart = echarts.init(dom);
  dom._chart = chart;
  chart.setOption(option, true);
  S.charts.push(chart);
  linkChartHover(chart);
  // Charts are usually mounted on detached nodes (cards/slides built before they
  // are appended). ECharts then measures 0x0 and stays invisible until a resize,
  // so force a resize once the node is in the document.
  if (!dom.isConnected) {
    requestAnimationFrame(() => {
      try { if (dom.isConnected && chart && !chart.isDisposed()) chart.resize(); } catch (e) {}
    });
  }
  return chart;
}

function barColors(baseHex, n) {
  const r = parseInt(baseHex.slice(1, 3), 16), g = parseInt(baseHex.slice(3, 5), 16), b = parseInt(baseHex.slice(5, 7), 16);
  const colors = [];
  for (let i = 0; i < n; i++) {
    const a = n <= 1 ? 1 : (0.55 + 0.45 * (i / (n - 1)));
    colors.push(`rgba(${r},${g},${b},${a.toFixed(2)})`);
  }
  return colors;
}

function barSpec(title, items, baseColor, tooltipFn) {
  const names = items.map((x) => x.name);
  return {
    tooltip: Object.assign({}, HOVER_STYLE, { trigger: 'axis', axisPointer: { type: 'shadow' }, formatter: tooltipFn || ((p) => { const it = p[0]; return `<b>${esc(it.name)}</b><br>${fmt(it.value)}`; }) }),
    grid: { left: 10, right: 14, top: 46, bottom: 8, containLabel: true },
    xAxis: { type: 'category', data: names, axisLabel: { color: NAVY, fontWeight: 600, fontSize: 11, rotate: 28 }, axisLine: { show: false }, axisTick: { show: false } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: 'rgba(0,33,71,.07)' } }, axisLabel: { color: NAVY, fontSize: 10 } },
    series: [{
      type: 'bar', data: items, barGap: '25%',
      itemStyle: { borderRadius: [6, 6, 0, 0], color: (p) => barColors(baseColor, items.length)[p.dataIndex] },
      label: { show: true, position: 'top', color: NAVY, fontWeight: 700, fontSize: 11, formatter: (p) => fmt(p.value) },
    }],
    title: { text: title, left: 0, top: 4, textStyle: { fontFamily: 'Sora, sans-serif', fontSize: 14, color: NAVY, fontWeight: 700 } },
    backgroundColor: 'transparent',
  };
}

function contrastText(hex) {
  const h = String(hex == null ? '' : hex).replace('#', '');
  if (h.length < 6) return NAVY;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.55 ? NAVY : '#fff';
}

function pieSpec(title, items, colors, tooltipFn, hole, labelColor) {
  const pieLabelColor = labelColor || ((p) => contrastText(p && p.color));
  return {
    tooltip: Object.assign({}, HOVER_STYLE, { formatter: tooltipFn || ((p) => `<b>${esc(p.name)}</b><br>${fmt(p.value)} (${p.percent == null ? '' : p.percent.toFixed(1) + '%'})`) }),
    series: [{
      type: 'pie', radius: ['45%', '70%'], center: ['50%', '52%'], data: items,
      itemStyle: { borderColor: '#fff', borderWidth: 2.5, borderRadius: 4 },
      label: { show: true, position: 'inside', color: pieLabelColor, fontSize: 11, fontWeight: 700, formatter: (p) => fmt(p.value) },
      labelLine: { show: false },
      emphasis: {
        itemStyle: { shadowBlur: 12, shadowColor: 'rgba(0,0,0,.35)' },
        label: { show: true, position: 'inside', color: pieLabelColor, fontWeight: 800, fontSize: 13, formatter: (p) => `${p.name}\n${fmt(p.value)} · ${p.percent == null ? '' : p.percent.toFixed(1) + '%'}` },
      },
      color: colors,
    }],
    legend: { bottom: 2, icon: 'circle', itemWidth: 10, itemHeight: 10, textStyle: { color: NAVY, fontSize: 11 } },
    title: { text: title, left: 0, top: 4, textStyle: { fontFamily: 'Sora, sans-serif', fontSize: 14, color: NAVY, fontWeight: 700 } },
    backgroundColor: 'transparent',
  };
}

function typeShareSpec(title, items, tooltipFn) {
  const colors = items.map((x) => TYPE_SHARE_COLORS[x.name] || '#80C4FF');
  const labelFmt = (p) => `${p.name}\n${p.percent == null ? '' : p.percent.toFixed(1) + '%'}`;
  return {
    tooltip: Object.assign({}, HOVER_STYLE, { formatter: tooltipFn || ((p) => `<b>${esc(p.name)}</b><br>${fmt(p.value)} (${p.percent == null ? '' : p.percent.toFixed(1) + '%'})`) }),
    series: [{
      type: 'pie', radius: ['25%', '75%'], center: ['42%', '50%'], data: items,
      itemStyle: { borderRadius: 0, borderWidth: 4, borderColor: '#ffffff' },
      label: {
        show: true, position: 'inside', color: '#FFFFFF', fontSize: 12, fontWeight: 700,
        rotate: 'auto', align: 'center', formatter: labelFmt,
      },
      labelLine: { show: false },
      emphasis: {
        itemStyle: { shadowBlur: 12, shadowColor: 'rgba(0,0,0,.35)' },
        label: { show: true, position: 'inside', color: '#FFFFFF', fontWeight: 800, fontSize: 13, formatter: labelFmt },
      },
      color: colors,
    }],
    legend: {
      orient: 'vertical', right: '10%', top: 'center',
      icon: 'rect', itemWidth: 14, itemHeight: 14, itemGap: 14,
      textStyle: { color: '#0A2240', fontSize: 12, fontWeight: 600 },
      data: items.map((x) => x.name),
    },
    title: { text: title, left: 0, top: 4, textStyle: { fontFamily: 'Sora, sans-serif', fontSize: 14, color: NAVY, fontWeight: 700 } },
    backgroundColor: 'transparent',
  };
}

function typeShareCard(title, items, tooltipFn, onClick) {
  const wrap = document.createElement('div');
  wrap.className = 'chart-card';
  const div = document.createElement('div');
  div.className = 'chart';
  wrap.appendChild(div);
  const chart = mountChart(div, typeShareSpec(title, items, tooltipFn));
  if (onClick) chart.on('click', (p) => { if (p.name != null) onClick(p.name); });
  return wrap;
}

function barCard(title, items, baseColor, tooltipFn, onClick) {
  const wrap = document.createElement('div');
  wrap.className = 'chart-card';
  const div = document.createElement('div');
  div.className = 'chart';
  wrap.appendChild(div);
  const chart = mountChart(div, barSpec(title, items, baseColor, tooltipFn));
  if (onClick) chart.on('click', (p) => { if (p.name != null) onClick(p.name); });
  return wrap;
}

function pieCard(title, items, tooltipFn, onClick) {
  const wrap = document.createElement('div');
  wrap.className = 'chart-card';
  const div = document.createElement('div');
  div.className = 'chart';
  wrap.appendChild(div);
  const chart = mountChart(div, pieSpec(title, items, PIE_COLORS, tooltipFn));
  if (onClick) chart.on('click', (p) => { if (p.name != null) onClick(p.name); });
  return wrap;
}

/* ============================== RENDER: LOGIN ============================== */
function showLogin() {
  hideLoading();
  $('#login-screen').hidden = false;
  $('#app').hidden = true;
}

function submitLogin() {
  if (!S.auth) return;
  const key = cleanVal($('#login-key').value);
  const err = $('#login-error');
  if (!key) return;
  if (key === S.auth.admin) { S.session = { role: 'admin', key }; }
  else if (key === S.auth.user) { S.session = { role: 'user', key }; }
  else if (S.auth.clients[key]) {
    const c = S.auth.clients[key];
    S.session = { role: 'client', key, projects: c.projects, is_vodafone: !!c.is_vodafone, logo: c.logo || null };
  } else { err.hidden = false; return; }
  err.hidden = true;
  localStorage.setItem('ds_session', JSON.stringify({ role: S.session.role, key }));
  boot();
}

/* ============================== RENDER: SIDEBAR ============================== */
const MSEL_LABEL = { merchant:'🏪 Merchant', project:'🏢 Project', branch:'📍 Branch', district:'🗺️ District', type:'🎫 Ticket type', subtype:'🏷️ Ticket subtype', microtype:'🔬 Ticket microtype', action:'🎬 Action taken', status:'🎫 Ticket Status' };
const MSEL_COL = { merchant:'Merchant', project:'Project', branch:'Branch User Name', district:'District', type:'Ticket type', subtype:'Ticket subtype', microtype:'Call Microtype', action:'Action taken', status:'Ticket_Status' };

function mselOptionsHtml(name, colName, selected, search) {
  const opts = colName ? cleanedUnique(S.ffBase, colName) : [];
  const q = (search || '').toLowerCase();
  const filtered = opts.filter((o) => o.toLowerCase().includes(q));
  const optsHtml = filtered.map((o) => {
    const checked = selected.includes(o) ? 'checked' : '';
    return `<label class="msel-opt"><input type="checkbox" data-f="${name}" data-v="${esc(o)}" ${checked}><span>${esc(o)}</span></label>`;
  }).join('');
  return optsHtml || '<div class="msel-empty">No options</div>';
}

function bindMselBehaviors(sb) {
  $$('.msel', sb).forEach((box) => {
    const name = box.dataset.msel;
    box.dataset.mselCol = MSEL_COL[name] || '';
    box.dataset.mselLabel = MSEL_LABEL[name] || name;
  });
  $$('.msel-head', sb).forEach((hd) => {
    hd.addEventListener('click', () => { hd.closest('.msel').classList.toggle('open'); });
  });
  $$('.msel-search', sb).forEach((inp) => {
    inp.addEventListener('input', () => {
      const name = inp.dataset.s;
      S.fSearch[name] = inp.value;
      const box = inp.closest('.msel');
      const selected = S.filters[name];
      box.querySelector('.msel-body').innerHTML =
        `<input class="msel-search" data-s="${name}" placeholder="Search…" value="${esc(inp.value)}">
         ${mselOptionsHtml(name, box.dataset.mselCol, selected, inp.value)}`;
      bindMselBehaviors(box);
      bindCheckboxes();
    });
  });
  $$('.msel-clear', sb).forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = btn.dataset.clear;
      if (name === 'date') {
        S.filters.dateMode = defaultDateMode();
        S.filters.customStart = S.filters.customEnd = null;
      } else {
        S.filters[name] = [];
      }
      renderAll();
    });
  });
}

function renderSidebar() {
  const sb = $('#sidebar');
  const role = S.session.role;
  const isClient = role === 'client';
  sb.className = 'sidebar' + (isClient ? ' client' : '');
  const ffBase = S.ffBase;

  const logoHtml = isClient && S.session.logo
    ? `<div class="sb-logo"><img src="${esc(logoSrc(S.session.logo))}" alt="logo"></div>`
    : `<div class="sb-logo"><img src="assets/logo_big.png" alt="Dsquares"></div>`;

  const mselHtml = (name, colName, label) => {
    const selected = S.filters[name];
    const search = S.fSearch[name] || '';
    return `<label class="f-label">${label}</label>
      <div class="msel" data-msel="${name}">
        <div class="msel-head">
          <span class="msel-title">${label} <span class="cnt">${selected.length ? selected.length : ''}</span></span>
          ${selected.length ? `<button class="msel-clear" data-clear="${name}" title="Clear ${label} filter">✕</button>` : ''}
        </div>
        <div class="msel-body">
          <input class="msel-search" data-s="${name}" placeholder="Search…" value="${esc(search)}">
          ${mselOptionsHtml(name, colName, selected, search)}
        </div>
      </div>`;
  };

  let fProjectHtml = '';
  if (!isClient || S.session.is_vodafone) {
    fProjectHtml = mselHtml('project', 'Project', '🏢 Project');
  }

  let html = `${logoHtml}
    <div class="sb-live"><span class="dot"></span>LIVE &nbsp;·&nbsp; Auto</div>
    <div class="sb-sec">Filters</div>
    <div class="sb-filter-hd">
      <label class="f-label">📅 Date filter</label>
      ${S.filters.dateMode && S.filters.dateMode !== 'All time' ? `<button class="msel-clear" data-clear="date" title="Clear date filter">✕</button>` : ''}
    </div>
    <div class="select-wrap">
      <select class="select-sel" id="date-mode">
        ${DATE_PRESETS.map((d) => `<option value="${d}" ${S.filters.dateMode === d ? 'selected' : ''}>${d}</option>`).join('')}
      </select>
    </div>
    ${S.filters.dateMode === 'Custom range' ? `
      <div class="date-range-wrap">
        <input type="date" class="select-sel date-sel" id="cust-start" value="${esc(S.filters.customStart || '')}" style="color:#fff;background:${NAVY};">
        <input type="date" class="select-sel date-sel" id="cust-end" value="${esc(S.filters.customEnd || '')}" style="color:#fff;background:${NAVY};">
      </div>` : ''}
    ${mselHtml('merchant', 'Merchant', '🏪 Merchant')}
    ${fProjectHtml}
    ${isClient ? '' : mselHtml('branch', 'Branch User Name', '📍 Branch')}
    ${mselHtml('district', 'District', '🗺️ District')}
    ${mselHtml('type', 'Ticket type', '🎫 Ticket type')}
    ${mselHtml('subtype', 'Ticket subtype', '🏷️ Ticket subtype')}
    ${mselHtml('microtype', 'Call Microtype', '🔬 Ticket microtype')}
    ${mselHtml('action', 'Action taken', '🎬 Action taken')}
    ${isClient ? '' : mselHtml('status', 'Ticket_Status', '🎫 Ticket Status')}
    <hr class="sb-divider">
    <button class="sb-btn" id="btn-refresh">🔄 Refresh Data Now</button>
    <button class="sb-btn" id="btn-slideshow">${S.slideshow ? '⏹ Stop Slideshow' : '▶️ Start Slideshow'}</button>
    ${role === 'admin' ? `<button class="sb-btn" id="btn-mgmt">🔐 Access Management</button>` : ''}
    <hr class="sb-divider">
    <button class="sb-btn danger" id="btn-logout">🚪 Log Out</button>`;

  sb.innerHTML = html;

  // date mode
  $('#date-mode').addEventListener('change', (e) => {
    S.filters.dateMode = e.target.value;
    if (S.filters.dateMode !== 'Custom range') { S.filters.customStart = S.filters.customEnd = null; }
    renderAll();
  });
  const cs = $('#cust-start'), ce = $('#cust-end');
  if (cs) cs.addEventListener('change', (e) => { S.filters.customStart = e.target.value; renderAll(); });
  if (ce) ce.addEventListener('change', (e) => { S.filters.customEnd = e.target.value; renderAll(); });

  // multiselects
  bindMselBehaviors(sb);
  bindCheckboxes();

  // buttons
  $('#btn-refresh').addEventListener('click', async () => {
    const btn = $('#btn-refresh');
    btn.textContent = '↻ Refreshing…';
    btn.disabled = true;
    try { await loadData(true); } catch (e) { console.error(e); }
    btn.textContent = '🔄 Refresh Data Now';
    btn.disabled = false;
    renderAll();
  });
  $('#btn-slideshow').addEventListener('click', () => {
    S.slideshow = !S.slideshow;
    S.slideIndex = 0;
    if (!S.slideshow && slideTimer) { clearInterval(slideTimer); slideTimer = null; }
    renderAll();
  });
  const bm = $('#btn-mgmt');
  if (bm) bm.addEventListener('click', () => {
    if (S.activeTab === 99) S.activeTab = 0; else S.activeTab = 99;
    renderAll();
  });
  $('#btn-logout').addEventListener('click', () => {
    if (slideTimer) { clearInterval(slideTimer); slideTimer = null; }
    stopAutoRefresh();
    S.slideshow = false;
    localStorage.removeItem('ds_session');
    S.session = null;
    showLogin();
  });
}

function bindCheckboxes() {
  $$('.msel-opt input[data-f]').forEach((cb) => {
    cb.removeEventListener('change', handleFilterChange);
    cb.addEventListener('change', handleFilterChange);
  });
}

function handleFilterChange(e) {
  const f = e.target.dataset.f;
  const v = e.target.dataset.v;
  const arr = S.filters[f];
  if (e.target.checked) { if (!arr.includes(v)) arr.push(v); }
  else { S.filters[f] = arr.filter((x) => x !== v); }
  renderAll();
}

/* ============================== RENDER: HEADER + TABS ============================== */
function renderHeader() {
  const hd = $('#dashboard-header');
  const updated = S.meta.updated || '';
  hd.innerHTML = `<div class="dashboard-header">
    <img src="assets/logo_small.png" width="34" alt="" onerror="this.style.display='none'">
    <h2>Support Analysis Dashboard</h2>
    <div style="display:flex;justify-content:center;align-items:center;gap:10px;margin-top:5px;flex-wrap:wrap;">
      <span class="live-badge"><span class="live-dot"></span> LIVE</span>
      <span class="sub-meta">Last updated: ${esc(updated)} | Auto-refresh 3 min</span>
    </div>
  </div>`;
}

function tabsForRole() {
  if (S.session.role === 'admin') return ['Overview','Quality Board','WhatsApp MOM','Inbound SLA','Redemption Tracker','Ticket Explorer'];
  if (S.session.role === 'user') return ['Overview','Ticket Explorer'];
  return null;
}

function renderTabs() {
  const tabs = tabsForRole();
  const bar = $('#tabbar');
  bar.innerHTML = '';
  const tabDefs = tabs.map((t, i) => {
    const btn = document.createElement('button');
    btn.className = 'tab' + (i === S.activeTab ? ' active' : '');
    btn.textContent = `${TAB_EMOJI[t] || ''} ${t}`;
    btn.addEventListener('click', () => { S.activeTab = i; renderAll(); });
    bar.appendChild(btn);
    return { name: t, idx: i };
  });
  if (S.activeTab >= tabDefs.length) S.activeTab = 0;
  return tabDefs;
}

/* ============================== SCORECARDS ============================== */
function cardHtml(title, value, border, lines, center, target) {
  const num = parseNum(value);
  const hasPct = /%/.test(value);
  const isNum = value != null && String(value) !== '' && !isNaN(parseFloat(String(value).replace(/[%,]/g, ''))) && !/^[A-Za-z]/.test(value);
  const dataAttrs = isNum ? `data-target="${num}" data-suffix="${hasPct ? '%' : ''}"` : '';
  let insightHtml = '';
  if (lines && lines.length) {
    insightHtml = '<div class="sc-divider"></div>' + lines.map(([t, c]) => `<div class="sc-insight" style="color:${c}">${esc(t)}</div>`).join('');
  }
  return `<div class="sc-card${center ? ' center' : ''}" style="--top-color:${border}">
    <div class="sc-label">${title}</div>
    <div class="sc-value${target ? ' small' : ''}" ${dataAttrs}>${esc(value)}</div>${insightHtml}</div>`;
}

function animateValues(root) {
  $$('.sc-value[data-target]', root).forEach((el) => {
    if (el.dataset.done) return;
    el.dataset.done = '1';
    const target = parseFloat(el.dataset.target);
    const suffix = el.dataset.suffix || '';
    const isFloat = String(el.dataset.target).indexOf('.') > -1;
    let cur = 0;
    const steps = 50, dur = 800, step = target / steps;
    const iv = setInterval(() => {
      cur = Math.min(cur + step, target);
      el.textContent = isFloat ? cur.toFixed(1) + suffix : Math.round(cur).toLocaleString() + suffix;
      if (cur >= target) clearInterval(iv);
    }, dur / steps);
  });
}

/* ============================== OVERVIEW ============================== */
function teamRows(rows) { return rows.filter((r) => get(r, '_team') === (S.ovTeam === 0 ? 'merchant' : 'client')); }

function applyClickFilter(col, val) {
  S.clickFilter = { col, val };
  renderAll();
  try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, 0); }
}

function buildOverviewCharts(ffDrill, clientMode, isVf) {
  const charts = [];
  const hoverHeader = (n) => (p) => `<b>${esc(p[0].name)}</b><br>${fmt(p[0].value)}<br><br>${p[0].data.hover || ''}`;
  const clickF = (colName) => (val) => applyClickFilter(colName, val);

  if (clientMode === 'client') {
    // real client login
    // 1. Top 10 Merchants
    const m = groupTop(ffDrill, 'Merchant', 'Call Microtype', 5);
    if (m.length) charts.push({ title: '🏪 1. Top 10 Merchants', type: 'bar', items: m, base: NAVY, tooltip: hoverHeader(), click: clickF('Merchant'), wide: false });
    // 2. Top 10 Branches (District)
    const b = groupTop(ffDrill, 'District', 'Merchant', 6);
    if (b.length) charts.push({ title: '📍 2. Top 10 Branches', type: 'bar', items: b, base: LIGHT, tooltip: hoverHeader(), click: clickF('District'), wide: false });
    if (isVf) {
      const p = groupTop(ffDrill, 'Project', 'Call Microtype', 5);
      if (p.length) charts.push({ title: '🏢 3. Top 10 Projects', type: 'bar', items: p, base: NAVY, tooltip: hoverHeader(), click: clickF('Project'), wide: false });
      const tt = topWithOthers(countBy(ffDrill, 'Ticket type', { clean: true }));
      if (tt.length) charts.push({ title: '🎫 4. Ticket Type Share', type: 'pie', doughnut: true, items: tt, click: clickF('Ticket type') });
      const su = groupTop(ffDrill, 'Ticket subtype', 'Ticket type', 3);
      if (su.length) charts.push({ title: '🏷️ 5. Top 10 Subtypes', type: 'bar', items: su, base: NAVY, tooltip: hoverHeader(), click: clickF('Ticket subtype'), wide: false });
      const mi = groupTop(ffDrill, 'Call Microtype', 'Ticket subtype', 5);
      if (mi.length) charts.push({ title: '🔬 6. Top 10 Microtypes', type: 'bar', items: mi, base: LIGHT, tooltip: hoverHeader(), click: clickF('Call Microtype'), wide: false });
      const ac = countBy(ffDrill, 'Action taken', { clean: true, limit: 10 });
      if (ac.length) charts.push({ title: '🎬 7. Key Actions Taken', type: 'bar', items: ac, base: NAVY, click: clickF('Action taken'), wide: true });
    } else {
      const tt = topWithOthers(countBy(ffDrill, 'Ticket type', { clean: true }));
      if (tt.length) charts.push({ title: '🎫 Ticket Type', type: 'pie', items: tt, click: clickF('Ticket type'), wide: false });
      const su = groupTop(ffDrill, 'Ticket subtype', 'Ticket type', 3);
      if (su.length) charts.push({ title: '🏷️ Top Subtypes', type: 'bar', items: su, base: NAVY, tooltip: hoverHeader(), click: clickF('Ticket subtype'), wide: false });
      const mi = groupTop(ffDrill, 'Call Microtype', 'Ticket subtype', 5);
      if (mi.length) charts.push({ title: '🔬 Top Microtypes', type: 'bar', items: mi, base: LIGHT, tooltip: hoverHeader(), click: clickF('Call Microtype'), wide: false });
      const ac = countBy(ffDrill, 'Action taken', { clean: true, limit: 10 });
      if (ac.length) charts.push({ title: '🎬 Action Taken', type: 'bar', items: ac, base: NAVY, click: clickF('Action taken'), wide: false });
    }
  } else {
    // admin/user: clientMode === false (merchant tab) or === true (client tab)
    const branchCol = clientMode === true ? 'District' : 'Branch User Name';
    const m = groupTop(ffDrill, 'Merchant', 'Call Microtype', 5);
    if (m.length) charts.push({ title: '🏪 1. Top 10 Merchants', type: 'bar', items: m, base: NAVY, tooltip: hoverHeader(), click: clickF('Merchant'), wide: false });
    const b = groupTop(ffDrill, branchCol, 'Merchant', 5);
    if (b.length) charts.push({ title: '📍 2. Top 10 Branches', type: 'bar', items: b, base: LIGHT, tooltip: hoverHeader(), click: clickF(branchCol), wide: false });
    const p = groupTop(ffDrill, 'Project', 'Call Microtype', 5);
    if (p.length) charts.push({ title: '🏢 3. Top 10 Projects', type: 'bar', items: p, base: NAVY, tooltip: hoverHeader(), click: clickF('Project'), wide: false });
    const tt = topWithOthers(countBy(ffDrill, 'Ticket type', { clean: true }));
    if (tt.length) charts.push({ title: '🎫 4. Ticket Type Share', type: 'pie', doughnut: true, items: tt, click: clickF('Ticket type') });
    const su = groupTop(ffDrill, 'Ticket subtype', 'Ticket type', 3);
    if (su.length) charts.push({ title: '🏷️ 5. Top 10 Subtypes', type: 'bar', items: su, base: NAVY, tooltip: hoverHeader(), click: clickF('Ticket subtype'), wide: false });
    const mi = groupTop(ffDrill, 'Call Microtype', 'Ticket subtype', 5);
    if (mi.length) charts.push({ title: '🔬 6. Top 10 Microtypes', type: 'bar', items: mi, base: LIGHT, tooltip: hoverHeader(), click: clickF('Call Microtype'), wide: false });
    const ac = countBy(ffDrill, 'Action taken', { clean: true, limit: 10 });
    if (ac.length) charts.push({ title: '🎬 7. Key Actions Taken', type: 'bar', items: ac, base: NAVY, click: clickF('Action taken'), wide: true });
  }
  return charts;
}

function renderChartCard(spec, idx) {
  if (spec.type === 'pie') {
    if (spec.doughnut) return typeShareCard(spec.title, spec.items, spec.tooltip, spec.click);
    return pieCard(spec.title, spec.items, spec.tooltip, spec.click);
  }
  const hoverFn = spec.tooltip ? (p) => {
    const it = p[0];
    const hover = it && it.data && it.data.hover ? `<br><br>${it.data.hover}` : '';
    return `<b>${esc(it.name)}</b><br>${fmt(it.value)}${hover}`;
  } : undefined;
  return barCard(spec.title, spec.items, spec.base, hoverFn, spec.click);
}

function renderVolumeTrend(rows, teamKey) {
  const daily = countBy(rows, 'D_Obj', { clean: false });
  daily.sort((a, b) => b.value - a.value);
  const peak = daily.slice(0, 20).sort((a, b) => (a.name < b.name ? -1 : 1));
  if (!peak.length) return { wrap: null, dates: [] };
  const items = peak.map((d) => {
    const sub = rows.filter((r) => get(r, 'D_Obj') === d.name);
    const subArr = countBy(sub, 'Call Microtype', { clean: true, limit: 5 });
    const lines = subArr.map((x) => '• ' + x.name + ': ' + fmt(x.value));
    return { name: d.name, value: d.value, hover: lines.join('<br>'), link: subArr.map((x) => x.name) };
  });
  const wrap = document.createElement('div');
  wrap.className = 'chart-card';
  const div = document.createElement('div');
  div.className = 'chart';
  wrap.appendChild(div);
  const chart = mountChart(div, barSpec('📊 Volume Trend (Peak Days)', items, NAVY, (p) => {
    const it = p[0];
    const hover = it && it.data && it.data.hover ? `<br><br>${it.data.hover}` : '';
    return `<b>${esc(it.name)}</b><br>${fmt(it.value)}${hover}`;
  }));
  chart.on('click', (p) => { if (p.name) { S.drill[teamKey] = p.name; goExplorer(); } });
  return { wrap, dates: peak.map((d) => d.name) };
}

function renderStatusPie(ffDrill, onClick) {
  const sc = countBy(ffDrill, 'Ticket_Status', { clean: false });
  if (!sc.length) return null;
  const items = sc.map((s) => {
    const sub = ffDrill.filter((r) => get(r, 'Ticket_Status') === s.name);
    const subArr = countBy(sub, 'Action taken', { clean: true, limit: 6 });
    const lines = subArr.map((x) => '• ' + x.name + ': ' + fmt(x.value));
    return { name: s.name, value: s.value, hover: lines.length ? lines.join('<br>') : 'No actions', link: subArr.map((x) => x.name) };
  });
  const colors = items.map((s) => (s.name === 'Closed' ? NAVY : RED));
  const wrap = document.createElement('div');
  wrap.className = 'chart-card';
  const div = document.createElement('div');
  div.className = 'chart';
  wrap.appendChild(div);
  const chart = mountChart(div, pieSpec('🎫 Live Ticket Status', items, colors, (p) => {
    return `<b>${esc(p.name)}</b><br>${fmt(p.value)}<br>${p.percent == null ? '' : p.percent.toFixed(2) + '%'}<br><br><b>Top Actions:</b><br>${p.data.hover || 'No actions'}`;
  }, false, '#FFFFFF'));
  if (onClick) chart.on('click', (p) => { if (p.name === 'Open' || p.name === 'Closed') onClick(p.name); });
  return wrap;
}

function renderTeamOverview(dataRows, opts) {
  const { clientMode, drillTab, teamKey } = opts; // clientMode: false|true|'client'
  const content = $('#content');
  const frag = document.createDocumentFragment();

  const activeFilters = computeActiveFilters();
  const hasFilter = Object.keys(activeFilters).length > 0;
  const baseLen = S.ffBase ? S.ffBase.length : 0;
  const dataLen = dataRows.length;

  const inboundAll = dataRows.filter((r) => /Inbound|Call/i.test(get(r, 'Type') || ''));
  const waAll = dataRows.filter((r) => /WhatsApp|App/i.test(get(r, 'Type') || ''));
  const inboundBase = S.ffBase ? S.ffBase.filter((r) => /Inbound|Call/i.test(get(r, 'Type') || '')) : [];
  const waBase = S.ffBase ? S.ffBase.filter((r) => /WhatsApp|App/i.test(get(r, 'Type') || '')) : [];

  const analysis = (n, base) => {
    if (!hasFilter || !n) return [];
    const lines = [];
    lines.push([(base ? (n / base * 100) : 0).toFixed(1) + '% of all tickets', NAVY]);
    // peak month
    const mm = {};
    for (const r of dataRows) { const m = monthOf(get(r, 'D_Obj')); mm[m] = (mm[m] || 0) + 1; }
    let best = null;
    for (const k in mm) if (!best || mm[k] > best[1]) best = [k, mm[k]];
    if (best) lines.push([`Peak: ${best[0]} (${fmt(best[1])} tickets)`, GREEN]);
    return lines;
  };

  // active filter badges
  const badgeHtml = Object.entries(activeFilters).map(([k, v]) => `<span class="filter-badge">${esc(k)}: ${esc(v)}</span>`).join('');
  const badges = document.createElement('div');
  badges.style.margin = '0 0 8px';
  badges.innerHTML = badgeHtml;
  if (badgeHtml) frag.appendChild(badges);

  if (S.clickFilter.col) {
    const cf = document.createElement('div');
    cf.className = 'click-filter-banner';
    const span = document.createElement('span');
    span.innerHTML = `🔍 ${esc(S.clickFilter.col)}: <b>${esc(S.clickFilter.val)}</b>`;
    const btn = document.createElement('button');
    btn.className = 'clear-btn';
    btn.textContent = '✕ Clear Chart Filter';
    btn.addEventListener('click', () => { S.clickFilter = { col: null, val: null }; renderAll(); });
    cf.appendChild(span);
    cf.appendChild(btn);
    frag.appendChild(cf);
  }

  // ---- scorecards ----
  const scRow = document.createElement('div');
  if (clientMode === 'client') {
    scRow.className = 'sc-row center';
    const topM = topSafe(dataRows, 'Merchant');
    const topT = topSafe(dataRows, 'Ticket type');
    scRow.innerHTML = cardHtml('📋 Total Tickets', fmt(dataLen), NAVY, analysis(dataLen, baseLen), true)
      + cardHtml('🏪 Top Merchant', topM, BLUE, [], true, true)
      + cardHtml('🎫 Top Ticket Type', topT, LIGHT, [], true, true);
  } else if (clientMode === true) {
    scRow.className = 'sc-row center';
    const rs = dataRows.filter((r) => /Within|Resolved/i.test(get(r, 'Resolution status') || '')).length;
    const urgent = dataRows.filter((r) => /Urgent|High/i.test(get(r, 'Priority') || '')).length;
    scRow.innerHTML = cardHtml('📋 Total Tickets', fmt(dataLen), NAVY, analysis(dataLen, baseLen), true)
      + cardHtml('🔧 Resolution Status', fmt(rs), BLUE, [], true)
      + cardHtml('🚨 Urgent Alert', fmt(urgent), RED, [], true);
  } else {
    scRow.className = 'sc-row';
    let redVal = 'N/A';
    if (S.redemption && S.redemption.kpi) {
      redVal = parseNum(S.redemption.kpi.value).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    }
    scRow.innerHTML = cardHtml('📋 Total Tickets', fmt(dataLen), NAVY, analysis(dataLen, baseLen), false)
      + cardHtml('📞 Inbound Calls', fmt(inboundAll.length), BLUE, analysis(inboundAll.length, inboundBase.length), false)
      + cardHtml('💬 WhatsApp', fmt(waAll.length), LIGHT, analysis(waAll.length, waBase.length), false)
      + cardHtml('💰 Total Redemption Value', redVal, '#00c06a', [], false);
  }
  frag.appendChild(scRow);

  let ffDrill = dataRows;
  if (clientMode !== 'client') {
    // ---- volume trend ----
    const vol = renderVolumeTrend(dataRows, teamKey);
    if (vol.wrap) {
      vol.wrap.style.gridColumn = '1/-1';
      frag.appendChild(vol.wrap);
    }
    // ---- drill-down select ----
    const drillRow = document.createElement('div');
    drillRow.className = 'drill-row';
    const curDrill = S.drill[teamKey] || 'All Data';
    drillRow.innerHTML = `<label>📅 Drill down by Peak Day:</label>
      <select class="select-sel" id="drill-sel" style="background:${NAVY};color:#fff;border-radius:8px;padding:7px 10px;font-size:12px;max-width:260px;">
        <option value="All Data">All Data</option>
        ${(vol.dates || []).map((d) => `<option value="${d}" ${curDrill === d ? 'selected' : ''}>${d}</option>`).join('')}
      </select>`;
    frag.appendChild(drillRow);
    ffDrill = curDrill === 'All Data' ? dataRows : dataRows.filter((r) => get(r, 'D_Obj') === curDrill);
    const drillSel = drillRow.querySelector('#drill-sel');
    drillSel.addEventListener('change', (e) => {
      const v = e.target.value;
      S.drill[teamKey] = v === 'All Data' ? null : v;
      if (v !== 'All Data') goExplorer(); else renderAll();
    });

    // ---- status pie ----
    const statusCard = renderStatusPie(ffDrill, (s) => applyClickFilter('Ticket_Status', s));
    if (statusCard) {
      const statusWrap = document.createElement('div');
      statusWrap.style.cssText = 'display:flex;justify-content:center;';
      statusCard.style.width = 'min(560px,100%)';
      statusWrap.appendChild(statusCard);
      frag.appendChild(statusWrap);
    }
  }

  // ---- chart grid ----
  const isVf = !!S.session.is_vodafone;
  const specs = buildOverviewCharts(ffDrill, clientMode, isVf);
  if (specs.length) {
    const grid = document.createElement('div');
    grid.className = 'chart-grid';
    specs.forEach((spec) => {
      const card = renderChartCard(spec);
      if (spec.wide) card.classList.add('wide');
      grid.appendChild(card);
    });
    frag.appendChild(grid);
  }

  content.appendChild(frag);
  animateValues(frag);
}

function goExplorer() {
  const tabs = tabsForRole();
  const idx = tabs.indexOf('Ticket Explorer');
  if (idx >= 0) { S.activeTab = idx; }
  renderAll();
}

function renderClientSection() {
  const content = $('#content');
  content.innerHTML = '';
  const bar = $('#tabbar');
  bar.innerHTML = '';

  const tabsWrap = document.createElement('div');
  tabsWrap.className = 'ov-subtabs';
  const mk = (label, idx) => {
    const b = document.createElement('button');
    b.className = 'ov-subbtn' + (S.ovTeam === idx ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', () => { S.ovTeam = idx; S.slideIndex = 0; renderAll(); });
    return b;
  };
  tabsWrap.appendChild(mk('🏪 Merchant Support', 0));
  tabsWrap.appendChild(mk('🤝 Client Support', 1));
  content.appendChild(tabsWrap);

  const ff = applyFilters(S.ffBase);
  const team = ff.filter((r) => get(r, '_team') === (S.ovTeam === 0 ? 'merchant' : 'client'));
  if (S.slideshow) {
    renderDualSlideDeck(ff, true);
    scheduleSlideshow();
    return;
  }
  renderTeamOverview(team, { clientMode: 'client', drillTab: S.ovTeam === 0 ? 'Merchant Support' : 'Client Support', teamKey: S.ovTeam === 0 ? 'merchant' : 'client' });
}

function renderOverview() {
  const content = $('#content');
  content.innerHTML = '';

  if (S.session.role === 'client') { renderClientSection(); return; }

  // admin/user: sub-tabs
  const subtabs = document.createElement('div');
  subtabs.className = 'ov-subtabs';
  const mk = (label, idx) => {
    const b = document.createElement('button');
    b.className = 'ov-subbtn' + (S.ovTeam === idx ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', () => { S.ovTeam = idx; S.slideIndex = 0; renderAll(); });
    return b;
  };
  subtabs.appendChild(mk('🏪 Merchant Support', 0));
  subtabs.appendChild(mk('🤝 Client Support', 1));
  content.appendChild(subtabs);

  const ff = applyFilters(S.ffBase);
  const teamRows = ff.filter((r) => get(r, '_team') === (S.ovTeam === 0 ? 'merchant' : 'client'));

  const clientMode = S.ovTeam === 1; // true for Client tab
  if (S.slideshow) {
    renderDualSlideDeck(ff, false);
    scheduleSlideshow();
    return;
  }
  renderTeamOverview(teamRows, {
    clientMode: clientMode ? true : false,
    drillTab: S.ovTeam === 0 ? 'Merchant Support' : 'Client Support',
    teamKey: S.ovTeam === 0 ? 'merchant' : 'client',
  });
}

/* ============================== QUALITY NORMALIZERS ============================== */
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) { if (obj[k] != null) return obj[k]; }
  return undefined;
}
function numOf(v, dflt) {
  if (v == null || v === '') return dflt != null ? dflt : 0;
  const n = parseFloat(String(v).replace(/[%,]/g, '').trim());
  return isNaN(n) ? (dflt != null ? dflt : 0) : n;
}
function fmtPct(v) {
  if (v == null || v === '') return 'N/A';
  const s = String(v).trim();
  if (/%$/.test(s)) return s;
  const n = parseFloat(s);
  return (isNaN(n) ? s : n + '%');
}
function normAgentSummary(list) {
  if (!Array.isArray(list)) return [];
  return list.map((r) => {
    if (!r || typeof r !== 'object') return null;
    const name = pick(r, ['Agent', 'agent', 'Name', 'name', 'Agent Name', 'Agent_Name']);
    const volume = pick(r, ['Volume', 'volume', 'Total Volume', 'total_volume', 'TotalVolume']);
    const ec = pick(r, ['Avg EC%', 'Avg EC', 'avg_ec', 'EC%', 'EC', 'ec']);
    const bc = pick(r, ['Avg BC%', 'Avg BC', 'avg_bc', 'BC%', 'BC', 'bc']);
    const overall = pick(r, ['Overall Avg', 'Overall', 'overall', 'overall_avg', 'Total Avg']);
    return { name: String(name == null ? '' : name), volume, avg_ec: ec, avg_bc: bc, overall };
  }).filter((x) => x && x.name);
}
function normErrorList(list) {
  if (!Array.isArray(list)) return [];
  return list.map((r) => {
    if (r == null) return null;
    if (typeof r === 'string' || typeof r === 'number') return { name: String(r), count: null };
    if (typeof r === 'object') {
      const name = pick(r, ['Error', 'error', 'Error_Name', 'error_name', 'Name', 'name', 'reason']);
      const count = pick(r, ['Count', 'count', 'Volume', 'volume', 'Total', 'total', 'Freq', 'freq']);
      return { name: String(name == null ? '' : name), count: count == null ? null : count };
    }
    return null;
  }).filter((x) => x && x.name);
}
function normTopErrors(t) {
  const out = { EC: [], BC: [], NC: [] };
  if (!t || typeof t !== 'object') return out;
  const srcs = {
    EC: ['EC', 'ec', 'ec_errors', 'Top EC Errors', 'top_ec_errors'],
    BC: ['BC', 'bc', 'bc_errors', 'Top BC Errors', 'top_bc_errors'],
    NC: ['NC', 'nc', 'nc_errors', 'Top NC Errors', 'top_nc_errors'],
  };
  Object.keys(srcs).forEach((k) => {
    let list = null;
    for (const key of srcs[k]) {
      const v = t[key];
      if (Array.isArray(v)) { list = v; break; }
      if (v && typeof v === 'object') {
        const inner = pick(v, ['errors', 'items', 'list', 'rows', 'data']);
        if (Array.isArray(inner)) { list = inner; break; }
        list = [v]; break;
      }
    }
    out[k] = normErrorList(list);
  });
  return out;
}
function normPerAgentErrors(pa) {
  if (!Array.isArray(pa)) return [];
  const out = [];
  pa.forEach((r) => {
    if (!r || typeof r !== 'object') return;
    const agent = pick(r, ['Agent', 'agent', 'Name', 'name', 'Agent Name', 'agent_name']);
    const type = pick(r, ['Type', 'type', 'Error Type', 'error_type', 'channel']);
    const error = pick(r, ['Error', 'error', 'Error_Name', 'error_name']);
    const count = pick(r, ['Count', 'count', 'Volume', 'volume', 'Freq', 'freq']);
    if (agent != null || error != null) {
      out.push({ agent: String(agent == null ? '' : agent), type: String(type == null ? '' : type).toUpperCase(), error: String(error == null ? '' : error), count: count == null ? null : count });
    }
  });
  return out;
}
function normPerAgent(pa) {
  if (!Array.isArray(pa)) return [];
  return pa.map((r) => {
    if (!r || typeof r !== 'object') return null;
    const agent = pick(r, ['agent', 'Agent', 'name', 'Name']);
    const ec = numOf(pick(r, ['ec', 'EC', 'EC%', 'avg_ec', 'Avg EC']), 0);
    const bc = numOf(pick(r, ['bc', 'BC', 'BC%', 'avg_bc', 'Avg BC']), 0);
    return { agent: String(agent == null ? '' : agent), ec, bc };
  }).filter((x) => x && x.agent);
}
function normAgentMetrics(a) {
  if (!a || typeof a !== 'object') a = {};
  return {
    avg_ec: pick(a, ['avg_ec', 'Avg EC%', 'avgEC', 'EC%', 'ec']),
    avg_bc: pick(a, ['avg_bc', 'Avg BC%', 'avgBC', 'BC%', 'bc']),
    total_volume: numOf(pick(a, ['total_volume', 'Total Volume', 'totalVolume', 'TotalVolume', 'Volume', 'volume']), 0),
    wa_volume: numOf(pick(a, ['wa_volume', 'WA Volume', 'WhatsApp Volume', 'waVolume']), 0),
    call_volume: numOf(pick(a, ['call_volume', 'Call Volume', 'callVolume']), 0),
  };
}
function normQuality(q) {
  if (q == null || typeof q !== 'object') q = {};
  let summary = Array.isArray(q) ? q : null;
  if (!summary) {
    const s = pick(q, ['agent_summary', 'agentSummary', 'Agent Summary']) || q.summary;
    if (Array.isArray(s)) summary = s;
  }
  const topSrc = pick(q, ['top_errors', 'topErrors', 'error_analysis', 'errorAnalysis']) || q;
  return {
    agent_summary: normAgentSummary(summary),
    top_errors: normTopErrors(typeof topSrc === 'object' ? topSrc : {}),
    per_agent_errors: normPerAgentErrors(pick(q, ['per_agent_errors', 'perAgentErrors', 'per_agent', 'perAgent', 'agent_errors']) || []),
  };
}

/* ============================== QUALITY BOARD ============================== */
function renderQuality() {
  const content = $('#content');
  content.innerHTML = `<div class="page-title">🏆 Agent Quality Board</div>`;
  const wrap = document.createElement('div');
  content.appendChild(wrap);

  const q = normQuality(S.meta ? S.meta.quality : null);
  const perAgent = normPerAgent(S.agent ? S.agent.per_agent : null);
  const aggM = S.agent && S.agent.summary ? normAgentMetrics(S.agent.summary) : {};
  const firstM = q.agent_summary.length ? normAgentMetrics(q.agent_summary[0]) : {};
  const sumVol = q.agent_summary.length
    ? q.agent_summary.reduce((s, r) => s + numOf(pick(r, ['Volume', 'volume', 'total_volume', 'totalVolume']), 0), 0)
    : 0;
  const metrics = {
    avg_ec: aggM.avg_ec != null ? aggM.avg_ec : firstM.avg_ec,
    avg_bc: aggM.avg_bc != null ? aggM.avg_bc : firstM.avg_bc,
    total_volume: sumVol > 0 ? sumVol : numOf(aggM.total_volume, 0),
    wa_volume: numOf(aggM.wa_volume, firstM.wa_volume),
    call_volume: numOf(aggM.call_volume, firstM.call_volume),
  };

  const hasAny = (metrics.avg_ec != null || metrics.avg_bc != null || metrics.total_volume > 0)
    || perAgent.length
    || q.agent_summary.length || q.per_agent_errors.length
    || q.top_errors.EC.length || q.top_errors.BC.length || q.top_errors.NC.length;
  if (!hasAny) {
    wrap.innerHTML = '<div class="empty-msg">No agent performance data available</div>';
    resizeChartsSoon();
    return;
  }

  const mgrid = document.createElement('div');
  mgrid.className = 'mgrid4';
  mgrid.innerHTML =
    `<div class="mcard" style="--c:${NAVY};"><div class="ml">Avg EC%</div><div class="mv">${metrics.avg_ec == null ? 'N/A' : fmtPct(metrics.avg_ec)}</div></div>
     <div class="mcard" style="--c:${BLUE};"><div class="ml">Avg BC%</div><div class="mv">${metrics.avg_bc == null ? 'N/A' : fmtPct(metrics.avg_bc)}</div></div>
     <div class="mcard" style="--c:${LIGHT};"><div class="ml">Total Volume</div><div class="mv">${fmt(metrics.total_volume)}</div></div>
     <div class="mcard" style="--c:#00c06a;"><div class="ml">WA / Calls</div><div class="mv sm">${fmt(metrics.wa_volume)} / ${fmt(metrics.call_volume)}</div></div>`;
  wrap.appendChild(mgrid);

  if (perAgent.length) {
    const card = document.createElement('div');
    card.className = 'chart-card';
    const div = document.createElement('div');
    div.className = 'chart tall';
    card.appendChild(div);
    const agents = perAgent;
    const chart = mountChart(div, {
      tooltip: Object.assign({}, HOVER_STYLE, { trigger: 'axis', axisPointer: { type: 'shadow' } }),
      legend: { top: 8, textStyle: { color: NAVY, fontSize: 11 } },
      grid: { left: 10, right: 14, top: 44, bottom: 8, containLabel: true },
      xAxis: { type: 'category', data: agents.map((a) => a.agent), axisLabel: { color: NAVY, fontWeight: 600, fontSize: 11, rotate: 32 }, axisLine: { show: false }, axisTick: { show: false } },
      yAxis: { type: 'value', min: 0, max: 115, splitLine: { lineStyle: { color: 'rgba(0,33,71,.07)' } }, axisLabel: { color: NAVY, fontSize: 10 } },
      series: [
        { name: 'EC%', type: 'bar', data: agents.map((a) => a.ec), itemStyle: { color: NAVY, borderRadius: [5, 5, 0, 0] }, label: { show: true, position: 'top', color: NAVY, fontSize: 10, formatter: (p) => p.value.toFixed(1) + '%' } },
        { name: 'BC%', type: 'bar', data: agents.map((a) => a.bc), itemStyle: { color: LIGHT, borderRadius: [5, 5, 0, 0] }, label: { show: true, position: 'top', color: NAVY, fontSize: 10, formatter: (p) => p.value.toFixed(1) + '%' } },
      ],
      backgroundColor: 'transparent',
    });
    wrap.appendChild(card);
  }

  wrap.appendChild(document.createElement('hr')).className = 'divider';
  const errTitle = document.createElement('div');
  errTitle.className = 'st-section-title';
  errTitle.textContent = '📊 Error Analysis';
  wrap.appendChild(errTitle);

  if (q.agent_summary && q.agent_summary.length) {
    const t = document.createElement('div');
    t.className = 'st-section-title';
    t.textContent = '📋 Agent Summary';
    wrap.appendChild(t);
    const tblWrap = document.createElement('div');
    tblWrap.className = 'table-wrap thin';
    tblWrap.innerHTML = renderTable(['🧑‍💼 Agent', '📊 Volume', '📈 Avg EC%', '📉 Avg BC%', '🎯 Overall Avg'],
      q.agent_summary.map((r) => [r.name, r.volume == null ? 'N/A' : r.volume, fmtPct(r.avg_ec), fmtPct(r.avg_bc), r.overall == null ? 'N/A' : r.overall]));
    wrap.appendChild(tblWrap);
  }

  const errCols = document.createElement('div');
  errCols.className = 'ac-row';
  ['EC', 'BC', 'NC'].forEach((et) => {
    const box = document.createElement('div');
    const tt = document.createElement('div');
    tt.className = 'st-section-title';
    tt.textContent = `📈 Top ${et} Errors`;
    box.appendChild(tt);
    const rows = (q.top_errors && q.top_errors[et]) || [];
    if (rows.length) {
      const tw = document.createElement('div');
      tw.className = 'table-wrap thin';
      tw.innerHTML = renderTable([`🏆 Top ${et} Errors`, '🔢 Count'], rows.map((r) => [r.name, r.count == null ? '' : r.count]));
      box.appendChild(tw);
    } else {
      const inf = document.createElement('div');
      inf.className = 'empty-msg';
      inf.textContent = `No ${et} errors found`;
      box.appendChild(inf);
    }
    errCols.appendChild(box);
  });
  wrap.appendChild(errCols);

  if (q.per_agent_errors && q.per_agent_errors.length) {
    const pe = q.per_agent_errors.filter((r) => r.type === 'EC' || r.type === 'BC' || r.type === 'NC');
    const t = document.createElement('div');
    t.className = 'st-section-title';
    t.textContent = '👤 Per-Agent Error Breakdown';
    wrap.appendChild(t);
    const filterRow = document.createElement('div');
    filterRow.className = 'drill-row';
    const agents = ['All', ...Array.from(new Set(pe.map((r) => r.agent))).sort()];
    filterRow.innerHTML = `<label>👤 Filter by Agent:</label>
      <select class="select-sel" id="qe-agent" style="background:${NAVY};color:#fff;border-radius:8px;padding:7px 10px;font-size:12px;max-width:220px;">
        ${agents.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('')}
      </select>
      <label>🏷️ Filter by Error Type:</label>
      <select class="select-sel" id="qe-type" style="background:${NAVY};color:#fff;border-radius:8px;padding:7px 10px;font-size:12px;max-width:160px;">
        ${['All','EC','BC','NC'].map((a) => `<option value="${a}">${a}</option>`).join('')}
      </select>`;
    wrap.appendChild(filterRow);
    const tblWrap = document.createElement('div');
    tblWrap.className = 'table-wrap';
    const draw = () => {
      const a = $('#qe-agent').value, ty = $('#qe-type').value;
      let rows = pe;
      if (a !== 'All') rows = rows.filter((r) => r.agent === a);
      if (ty !== 'All') rows = rows.filter((r) => r.type === ty);
      tblWrap.innerHTML = renderTable(['🧑‍💼 Agent', '📂 Type', '❌ Error', '🔢 Count'], rows.map((r) => [r.agent, r.type, r.error, r.count == null ? '' : r.count]));
    };
    wrap.appendChild(tblWrap);
    draw();
    $('#qe-agent').addEventListener('change', draw);
    $('#qe-type').addEventListener('change', draw);
  }

  resizeChartsSoon();
}

/* ============================== WHATSAPP MOM ============================== */
function renderWhatsApp() {
  const content = $('#content');
  content.innerHTML = `<div class="page-title">💬 WhatsApp MOM SLA Analysis</div>`;
  const wa = S.ffBase ? S.ffBase.filter((r) => get(r, '_team') === 'merchant' && cleanVal(get(r, 'WhatsApp SLA Status')) !== '') : [];
  if (!wa.length) {
    content.insertAdjacentHTML('beforeend', '<div class="empty-msg">No WhatsApp SLA data available</div>');
    return;
  }
  const ot = wa.filter((r) => /On-Time|On Time/i.test(get(r, 'WhatsApp SLA Status'))).length;
  const lt = wa.filter((r) => /Late/i.test(get(r, 'WhatsApp SLA Status'))).length;
  const ov = wa.length ? ot / wa.length * 100 : 0;
  const achieved = ov >= 95;
  const arrow = achieved ? '▲' : '▼';
  const acol = achieved ? GREEN : RED;

  const overall = document.createElement('div');
  overall.className = 'overall-card';
  overall.style.cssText = 'text-align:center;margin-bottom:20px;';
  overall.innerHTML = `
    <p style="margin:0 0 4px;font-weight:900;color:${NAVY};font-size:14px;letter-spacing:1px;font-family:Sora,sans-serif;">💬 OVERALL ON-TIME RESPONSE</p>
    <p style="color:${LIGHT};font-size:46px;font-weight:900;margin:2px 0 6px;font-family:Sora,sans-serif;">${ov.toFixed(1)}%</p>
    <p style="font-weight:800;font-size:16px;margin:0;color:${NAVY};">
      <span style="color:${acol};font-size:20px;">${arrow}</span>&nbsp;
      <span style="color:${GREEN};"> Target: 95%</span>&nbsp;—&nbsp;
      <span style="color:${acol};">${achieved ? 'Achieved' : 'Below Target'}</span></p>`;
  content.appendChild(overall);

  // monthly cards, sorted by date
  const months = [];
  for (const r of wa) { const m = monthOf(get(r, 'D_Obj')); if (!months.includes(m)) months.push(m); }
  months.sort();
  const momGrid = document.createElement('div');
  momGrid.className = 'mom-grid';
  months.forEach((m) => {
    const md = wa.filter((r) => monthOf(get(r, 'D_Obj')) === m);
    const mOt = md.filter((r) => /On-Time|On Time/i.test(get(r, 'WhatsApp SLA Status'))).length;
    const mLt = md.filter((r) => /Late/i.test(get(r, 'WhatsApp SLA Status'))).length;
    const prc = md.length ? mOt / md.length * 100 : 0;
    const card = document.createElement('div');
    card.className = 'wa-card';
    card.innerHTML = `<h5>📅 ${esc(monthName(m))}</h5><div class="perc">${prc.toFixed(1)}%</div>
      <p style="color:${GREEN};font-weight:700;margin:3px 0;">✅ On-Time: ${fmt(mOt)}</p>
      <p style="color:#CC0000;font-weight:700;margin:3px 0;">❌ Late: ${fmt(mLt)}</p>`;
    momGrid.appendChild(card);
  });
  content.appendChild(momGrid);
}

/* ============================== INBOUND SLA ============================== */
function renderSla() {
  const content = $('#content');
  content.innerHTML = `<div class="page-title">📈 Inbound SLA Performance</div>`;
  const sla = S.sla;
  if (!sla || !sla.cols.length || !sla.rows.length) {
    content.insertAdjacentHTML('beforeend', '<div class="empty-msg">No SLA data available</div>');
    return;
  }
  const pcaCol = sla.cols.find((c) => /pca/i.test(c));
  const monthCol = sla.cols.find((c) => /month/i.test(c)) || sla.cols[0];
  if (!pcaCol) {
    content.insertAdjacentHTML('beforeend', renderTable(sla.cols, sla.rows));
    return;
  }
  const pi = sla.cols.indexOf(pcaCol), mi = sla.cols.indexOf(monthCol);
  const pcaVals = sla.rows.map((r) => parseNum(r[pi])).filter((v) => v > 0);
  const opa = pcaVals.length ? pcaVals.reduce((a, b) => a + b, 0) / pcaVals.length : 0;
  const achieved = opa >= 95;
  const arrow = achieved ? '▲' : '▼';
  const acol = achieved ? GREEN : RED;

  const overall = document.createElement('div');
  overall.className = 'overall-card';
  overall.style.cssText = 'text-align:center;margin-bottom:20px;';
  overall.innerHTML = `
    <p style="margin:0 0 8px;font-weight:900;color:${NAVY};font-size:11px;letter-spacing:2px;font-family:Sora,sans-serif;text-transform:uppercase;opacity:.7;">📊 OVERALL PCA% ACHIEVEMENT (AVG)</p>
    <p style="color:${BLUE};font-size:52px;font-weight:900;margin:2px 0 10px;font-family:Sora,sans-serif;">${opa.toFixed(1)}%</p>
    <p style="font-weight:800;font-size:16px;margin:0;color:${NAVY};">
      <span style="color:${acol};font-size:22px;">${arrow}</span>&nbsp;
      Target: 95% &mdash; <span style="color:${acol};font-weight:900;">${achieved ? 'Achieved' : 'Below Target'}</span></p>`;
  content.appendChild(overall);

  // monthly bar (only months that actually have data)
  const items = sla.rows.filter((r) => parseNum(r[pi]) > 0).map((r) => ({ name: r[mi] || '', value: parseNum(r[pi]) }));
  const card = document.createElement('div');
  card.className = 'chart-card';
  const div = document.createElement('div');
  div.className = 'chart';
  card.appendChild(div);
  const chart = mountChart(div, barSpec('📊 Monthly PCA% Achievement', items, NAVY, (p) => {
    const it = p[0];
    return `<b>${esc(it.name)}</b><br>PCA: <b>${it.value.toFixed(1)}%</b>`;
  }));
  chart.setOption({ yAxis: { type: 'value', name: 'PCA %', nameTextStyle: { color: NAVY, fontWeight: 700 }, splitLine: { lineStyle: { color: 'rgba(0,33,71,.07)' } }, axisLabel: { color: NAVY, fontSize: 10 } } });
  content.appendChild(card);

  const tblWrap = document.createElement('div');
  tblWrap.className = 'table-wrap thin';
  tblWrap.innerHTML = renderTable(sla.cols, sla.rows.filter((r) => parseNum(r[pi]) > 0));
  content.appendChild(tblWrap);
}

/* ============================== REDEMPTION ============================== */
function renderRedemption() {
  const content = $('#content');
  content.innerHTML = `<div class="page-title">💰 Redemption Tracker</div>`;
  const red = S.redemption;
  if (!red || !red.kpi) {
    content.insertAdjacentHTML('beforeend', '<div class="empty-msg">No Redemption data available</div>');
    return;
  }
  const totalTxn = fmt(parseNum(red.kpi.txn));
  const topAgent = red.kpi.agent ? cleanVal(red.kpi.agent) : 'N/A';
  const totalVal = parseNum(red.kpi.value).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  const mgrid = document.createElement('div');
  mgrid.className = 'mgrid3';
  mgrid.innerHTML =
    `<div class="mcard" style="--c:${NAVY};"><div class="ml">📋 Total Transactions</div><div class="mv">${totalTxn}</div></div>
     <div class="mcard" style="--c:${BLUE};"><div class="ml">🏆 Top Agent</div><div class="mv sm">${esc(topAgent)}</div></div>
     <div class="mcard" style="--c:${LIGHT};"><div class="ml">💰 Total Redemption Amount</div><div class="mv">${totalVal}</div></div>`;
  content.appendChild(mgrid);

  if (red.rows.length) {
    const tblWrap = document.createElement('div');
    tblWrap.className = 'table-wrap';
    tblWrap.innerHTML = renderTable(red.cols, red.rows);
    content.appendChild(tblWrap);
  }
}

/* ============================== TICKET EXPLORER ============================== */
function renderTable(headers, rows, rawCols) {
  if (!rows.length) return '<div class="empty-msg">No matching tickets</div>';
  const th = headers.map((h) => `<th>${esc(h)}</th>`).join('');
  const tr = rows.map((r) => `<tr>${r.map((c, i) => `<td>${rawCols && rawCols.includes(i) ? c : esc(c)}</td>`).join('')}</tr>`).join('');
  return `<table class="modern-table"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

function csvOf(headers, rows) {
  const q = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [headers.map(q).join(','), ...rows.map((r) => r.map(q).join(','))].join('\n');
}

function renderExplorer() {
  const content = $('#content');
  content.innerHTML = '';
  const ff = applyFilters(S.ffBase);

  const subtabs = document.createElement('div');
  subtabs.className = 'ov-subtabs';
  const mk = (label, idx) => {
    const b = document.createElement('button');
    b.className = 'ov-subbtn' + (S.ovTeam === idx ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', () => { S.ovTeam = idx; renderAll(); });
    return b;
  };
  subtabs.appendChild(mk('🏪 Merchant Support', 0));
  subtabs.appendChild(mk('🤝 Client Support', 1));
  content.appendChild(subtabs);

  const team = ff.filter((r) => get(r, '_team') === (S.ovTeam === 0 ? 'merchant' : 'client'));
  const teamKey = S.ovTeam === 0 ? 'merchant' : 'client';
  const drillDate = S.drill[teamKey];

  let rows = team;
  if (drillDate) rows = rows.filter((r) => get(r, 'D_Obj') === drillDate);

  const displayCols = S.tickets.cols.filter((c) => !['D_Obj', 'Ticket_Status', '_team'].includes(c));
  const dispIdx = displayCols.map((c) => col(c));
  const headers = displayCols;

  const searchRow = document.createElement('div');
  searchRow.className = 'search-row';
  searchRow.innerHTML = `<input class="search-input" id="explorer-search" placeholder="Search…">
    <button class="dl-btn" id="explorer-export">📥 Export CSV</button>`;
  content.appendChild(searchRow);

  const tblWrap = document.createElement('div');
  tblWrap.className = 'table-wrap';
  content.appendChild(tblWrap);

  const pager = document.createElement('div');
  pager.className = 'pager';
  content.appendChild(pager);

  let page = 0;
  const draw = () => {
    const q = cleanVal($('#explorer-search').value).toLowerCase();
    let out = rows;
    if (q) out = rows.filter((r) => r.some((v) => String(v == null ? '' : v).toLowerCase().includes(q)));
    const total = out.length;
    const pages = Math.max(1, Math.ceil(total / EXP_PAGE_SIZE));
    if (page >= pages) page = pages - 1;
    const start = page * EXP_PAGE_SIZE;
    const slice = out.slice(start, start + EXP_PAGE_SIZE);
    const shown = slice.map((r) => dispIdx.map((i) => (r[i] == null ? '' : r[i])));
    tblWrap.innerHTML = renderTable(headers, shown);
    pager.innerHTML = pages > 1
      ? `<span class="pager-info">Showing ${fmt(start + 1)}–${fmt(Math.min(start + EXP_PAGE_SIZE, total))} of ${fmt(total)} tickets</span>
         <button class="pager-btn" id="pg-prev" ${page === 0 ? 'disabled' : ''}>‹ Prev</button>
         <span class="pager-cur">Page ${fmt(page + 1)} / ${fmt(pages)}</span>
         <button class="pager-btn" id="pg-next" ${page >= pages - 1 ? 'disabled' : ''}>Next ›</button>`
      : `<span class="pager-info">${fmt(total)} ticket${total === 1 ? '' : 's'}</span>`;
    const pp = $('#pg-prev'), pn = $('#pg-next');
    if (pp) pp.addEventListener('click', () => { page--; draw(); });
    if (pn) pn.addEventListener('click', () => { page++; draw(); });
    $('#explorer-export').onclick = () => {
      const csv = csvOf(headers, out.map((r) => dispIdx.map((i) => (r[i] == null ? '' : r[i]))));
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `tickets_${teamKey}_support.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    };
  };
  draw();
  $('#explorer-search').addEventListener('input', () => { page = 0; draw(); });
}

/* ============================== ACCESS MGMT ============================== */
const OVERRIDES_KEY = 'ds_access_overrides';
function loadOverrides() {
  try { return JSON.parse(localStorage.getItem(OVERRIDES_KEY)) || {}; } catch (e) { return {}; }
}
function saveOverrides(o) { localStorage.setItem(OVERRIDES_KEY, JSON.stringify(o)); }
function mergeAuth(base) {
  const o = loadOverrides();
  const auth = { admin: base.admin, user: base.user, clients: Object.assign({}, base.clients || {}) };
  if (o.admin != null) auth.admin = o.admin;
  if (o.user != null) auth.user = o.user;
  (o.removed || []).forEach((k) => { delete auth.clients[k]; });
  Object.assign(auth.clients, o.added || {});
  return auth;
}
function applyAccessOverrides() {
  S.authBase = S.authBase || S.auth;
  S.auth = mergeAuth(S.authBase);
}

function renderAccessMgmt() {
  const content = $('#content');
  const clients = Object.entries(S.auth.clients || {});
  const rows = clients.map(([pwd, c]) => [pwd, (c.projects || []).join(', '), c.is_vodafone ? '✅' : '—',
    c.logo ? (/^(data:|https?:|blob:)/.test(String(c.logo)) ? `<img class="am-logo-cell" src="${esc(c.logo)}" alt="logo">` : c.logo) : '—']);
  content.innerHTML = `<div class="page-title">🔐 Access Management</div>
    <div class="am-note">Changes apply instantly in this browser. To make them permanent for everyone, click
      <b>⬇️ Download access.json</b> and replace <code>web/access.json</code> with the saved file.
      Uploaded logos are embedded inside <code>access.json</code> automatically.</div>

    <div class="st-section-title">➕ Add New Access</div>
    <div class="am-form">
      <label class="am-f">Key / Password<input id="am-key" class="search-input" placeholder="e.g. newclient123"></label>
      <label class="am-f">Role<select id="am-role" class="select-sel"><option value="client">Client</option><option value="admin">Admin</option><option value="user">User</option></select></label>
      <label class="am-f" id="am-f-projects">Projects (comma separated)<input id="am-projects" class="search-input" placeholder="e.g. Project A, Project B"></label>
      <label class="am-f" id="am-f-vf"><span>Vodafone</span><input id="am-vf" type="checkbox" style="width:auto;transform:scale(1.4);margin-top:8px;"></label>
      <label class="am-f" id="am-f-logo"><span>Logo</span>
        <div class="am-logo-row">
          <button type="button" class="dl-btn" id="am-logo-upload">📤 Upload Logo</button>
          <input id="am-logo-file" type="file" accept="image/*" hidden>
          <input id="am-logo" class="search-input" placeholder="or paste file name e.g. logo_X.png" style="flex:1">
          <img id="am-logo-preview" class="am-logo-preview" alt="" hidden>
        </div>
      </label>
      <div class="am-actions"><button class="dl-btn" id="am-add">➕ Add Access</button></div>
    </div>

    <div class="st-section-title">🔑 Admin & User Keys</div>
    <div class="am-form">
      <label class="am-f">Admin key<input id="am-admin" class="search-input" value="${esc(S.auth.admin || '')}"></label>
      <label class="am-f">User key<input id="am-user" class="search-input" value="${esc(S.auth.user || '')}"></label>
      <div class="am-actions"><button class="dl-btn" id="am-save-keys">💾 Save Keys</button></div>
    </div>

    <div class="st-section-title">👥 Client Accesses (${rows.length})</div>
    ${rows.length ? `<div class="table-wrap thin">${renderTable(['Key', 'Projects', 'Vodafone', 'Logo', ''], rows.map((r, i) => [...r, `<button class="am-del" data-del="${esc(clients[i][0])}">🗑️</button>`]), [3, 4])}</div>` : '<div class="empty-msg">No client accesses</div>'}

    <div class="am-actions" style="margin-top:16px;"><button class="dl-btn" id="am-download">⬇️ Download access.json</button></div>`;

  // role-dependent fields
  const roleSel = $('#am-role');
  const upd = () => {
    const isClient = roleSel.value === 'client';
    $('#am-f-projects').style.display = isClient ? '' : 'none';
    $('#am-f-vf').style.display = isClient ? '' : 'none';
    $('#am-f-logo').style.display = isClient ? '' : 'none';
  };
  roleSel.addEventListener('change', upd);
  upd();

  // logo upload -> data URL preview
  let pendingLogo = null;
  const logoInput = $('#am-logo');
  const fileInput = $('#am-logo-file');
  const preview = $('#am-logo-preview');
  $('#am-logo-upload').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      pendingLogo = rd.result;
      preview.src = String(rd.result);
      preview.hidden = false;
      logoInput.value = '';
    };
    rd.readAsDataURL(f);
  });
  logoInput.addEventListener('input', () => {
    pendingLogo = null;
    preview.hidden = true;
    preview.removeAttribute('src');
  });

  $('#am-add').addEventListener('click', () => {
    const key = cleanVal($('#am-key').value);
    if (!key) return;
    const o = loadOverrides();
    o.removed = (o.removed || []).filter((k) => k !== key);
    if (roleSel.value === 'admin') o.admin = key;
    else if (roleSel.value === 'user') o.user = key;
    else {
      o.added = o.added || {};
      o.added[key] = {
        projects: cleanVal($('#am-projects').value).split(',').map((s) => s.trim()).filter(Boolean),
        is_vodafone: $('#am-vf').checked,
        logo: pendingLogo || cleanVal(logoInput.value).replace(/^assets\//, '') || null,
      };
    }
    saveOverrides(o);
    applyAccessOverrides();
    renderAccessMgmt();
  });

  $('#am-save-keys').addEventListener('click', () => {
    const o = loadOverrides();
    o.admin = cleanVal($('#am-admin').value);
    o.user = cleanVal($('#am-user').value);
    saveOverrides(o);
    applyAccessOverrides();
    renderAccessMgmt();
  });

  $$('.am-del').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.del;
      const o = loadOverrides();
      if (o.added && o.added[key]) delete o.added[key];
      if (S.authBase.clients && key in S.authBase.clients) {
        o.removed = o.removed || [];
        if (!o.removed.includes(key)) o.removed.push(key);
      }
      saveOverrides(o);
      applyAccessOverrides();
      renderAccessMgmt();
    });
  });

  $('#am-download').addEventListener('click', () => {
    const data = JSON.stringify({ admin: S.auth.admin, user: S.auth.user, clients: S.auth.clients }, null, 2);
    const blob = new Blob([data], { type: 'application/json;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'access.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

/* ============================== MAIN RENDER ============================== */
function renderAll() {
  disposeCharts();
  if (!S.meta || !S.tickets || !S.session) { resizeChartsSoon(); return; }

  // recompute base + applied filters
  S.ffBase = S.tickets.rows.filter(baseFilter);

  renderHeader();
  renderSidebar();

  const content = $('#content');
  content.innerHTML = '';

  if (S.session.role === 'client') {
    $('#tabbar').innerHTML = '';
    renderClientSection();
  } else if (S.activeTab === 99) {
    renderAccessMgmt();
  } else {
    const tabDefs = renderTabs();
    const tab = tabDefs.find((t) => t.idx === S.activeTab);
    const name = tab ? tab.name : 'Overview';
    if (name === 'Overview') renderOverview();
    else if (name === 'Quality Board') renderQuality();
    else if (name === 'WhatsApp MOM') renderWhatsApp();
    else if (name === 'Inbound SLA') renderSla();
    else if (name === 'Redemption Tracker') renderRedemption();
    else if (name === 'Ticket Explorer') renderExplorer();
  }
  resizeChartsSoon();
}

/* ============================== AUTO-REFRESH ============================== */
const AUTO_REFRESH_MS = 3 * 60 * 1000;
let autoTimer = null;

function startAutoRefresh() {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = setInterval(async () => {
    try {
      const changed = await refreshLiveAll();
      if (changed) { renderAll(); return; }
    } catch (e) { console.error('auto-refresh live failed', e); }
    if (!S.liveActive) {
      try {
        const meta = await fetchJson('data/meta.json', { bust: true });
        if (meta && meta.updated_iso && meta.updated_iso !== S.build) {
          await loadData(true);
          renderAll();
        }
      } catch (e) { console.error('auto-refresh bundled failed', e); }
    }
  }, AUTO_REFRESH_MS);
}

function stopAutoRefresh() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
}

/* ============================== SLIDESHOW ============================== */
let slideTimer = null;

function scheduleSlideshow() {
  if (slideTimer) clearInterval(slideTimer);
  slideTimer = setInterval(() => {
    if (!S.slideshow) { clearInterval(slideTimer); slideTimer = null; return; }
    S.slideIndex++;
    renderAll();
  }, 12000);
}

function buildSlideDeck(rows, teamKey, clientMode) {
  const deck = [];
  const teamLabel = teamKey === 'merchant' ? '🏪 Merchant' : '🤝 Client';
  const push = (title, el) => deck.push({ title: `${teamLabel} · ${title}`, el, rows, teamKey, clientMode });

  const vol = renderVolumeTrend(rows, teamKey);
  if (vol.wrap) push('📊 Volume Trend (Peak Days)', vol.wrap);

  const isVf = !!S.session.is_vodafone;
  buildOverviewCharts(rows, clientMode, isVf).forEach((spec) => {
    push(spec.title, renderChartCard(spec));
  });

  if (clientMode !== 'client') {
    const st = renderStatusPie(rows, (s) => applyClickFilter('Ticket_Status', s));
    if (st) push('🎫 Live Ticket Status', st);
  }
  return deck;
}

function renderDeck(deck) {
  const content = $('#content');
  if (!deck.length) {
    content.insertAdjacentHTML('beforeend', '<div class="empty-msg">No data for this filter</div>');
    return;
  }

  if (S.slideIndex >= deck.length) S.slideIndex = 0;
  const idx = S.slideIndex;
  const cur = deck[idx];
  const rows = cur.rows, clientMode = cur.clientMode;

  const banner = document.createElement('div');
  banner.className = 'slideshow-banner';
  banner.textContent = `▶ Slideshow | ${idx + 1}/${deck.length} | ${cur.title} | auto 12s`;

  const scWrap = document.createElement('div');
  scWrap.className = 'slide-scorecards';
  if (clientMode === 'client') {
    scWrap.innerHTML = `<div class="slide-sc"><div class="l">Total</div><div class="v">${fmt(rows.length)}</div></div>`;
  } else if (clientMode === true) {
    const rs = rows.filter((r) => /Within|Resolved/i.test(get(r, 'Resolution status') || '')).length;
    const urgent = rows.filter((r) => /Urgent|High/i.test(get(r, 'Priority') || '')).length;
    scWrap.innerHTML = `<div class="slide-sc"><div class="l">Total</div><div class="v">${fmt(rows.length)}</div></div>
      <div class="slide-sc"><div class="l">Resolution</div><div class="v">${fmt(rs)}</div></div>
      <div class="slide-sc"><div class="l">Urgent</div><div class="v">${fmt(urgent)}</div></div>`;
  } else {
    const inb = rows.filter((r) => /Inbound|Call/i.test(get(r, 'Type') || '')).length;
    const wa = rows.filter((r) => /WhatsApp|App/i.test(get(r, 'Type') || '')).length;
    scWrap.innerHTML = `<div class="slide-sc"><div class="l">Total</div><div class="v">${fmt(rows.length)}</div></div>
      <div class="slide-sc"><div class="l">Inbound</div><div class="v">${fmt(inb)}</div></div>
      <div class="slide-sc"><div class="l">WhatsApp</div><div class="v">${fmt(wa)}</div></div>`;
  }

  content.appendChild(banner);
  content.appendChild(scWrap);

  const stage = document.createElement('div');
  stage.style.cssText = 'display:grid;grid-template-columns:1fr;gap:18px;max-width:880px;margin:0 auto;';
  cur.el.style.height = '420px';
  stage.appendChild(cur.el);
  content.appendChild(stage);
}

function renderSlideDeck(rows, teamKey, clientMode) {
  renderDeck(buildSlideDeck(rows, teamKey, clientMode));
}

function renderDualSlideDeck(ff, forClient) {
  const mm = forClient ? 'client' : false;
  const cc = forClient ? 'client' : true;
  const merchant = buildSlideDeck(ff.filter((r) => get(r, '_team') === 'merchant'), 'merchant', mm);
  const client = buildSlideDeck(ff.filter((r) => get(r, '_team') === 'client'), 'client', cc);
  renderDeck(merchant.concat(client));
}

/* ============================== LOADING HELPERS ============================== */
function showLoading(msg) {
  $('#login-screen').hidden = true;
  $('#app').hidden = true;
  $('#loading-screen').hidden = false;
  $('#loading-status').textContent = msg || 'Loading…';
}
function hideLoading() {
  $('#loading-screen').hidden = true;
  $('#app').hidden = false;
}

/* ============================== INIT ============================== */
function ensureFreshAssets() {
  try {
    if (!window.DS_BUILD || !S.meta || !S.meta.build) return false;
    if (String(window.DS_BUILD).indexOf('DS_BUILD_TOKEN') >= 0) return false;
    if (window.DS_BUILD === S.meta.build) return false;
    if (sessionStorage.getItem('ds_reloaded')) return false;
    sessionStorage.setItem('ds_reloaded', '1');
    location.reload();
    return true;
  } catch (e) { return false; }
}

async function boot() {
  // reset UI state tied to the session
  S.filters = { dateMode: defaultDateMode(),
    customStart: null, customEnd: null, merchant: [], project: [], branch: [], district: [], type: [], subtype: [], microtype: [], action: [], status: [] };
  S.fSearch = {};
  S.clickFilter = { col: null, val: null };
  S.activeTab = 0;
  S.ovTeam = 0;
  S.drill = { merchant: null, client: null };
  S.slideshow = false;
  showLoading('Loading…');
  try {
    await loadData(false);
  } catch (e) {
    console.error(e);
    // try to load again — data may not be built yet
  }
  await refreshLiveAll();
  if (ensureFreshAssets()) return;
  renderAll();
  showLive();
  startAutoRefresh();
  hideLoading();
}

async function init() {
  watchContentResize();
  const sbToggle = $('#sb-toggle');
  if (sbToggle) {
    if (localStorage.getItem('ds_sb_collapsed') === '1') $('#app').classList.add('sb-collapsed');
    sbToggle.addEventListener('click', () => {
      const app = $('#app');
      app.classList.toggle('sb-collapsed');
      localStorage.setItem('ds_sb_collapsed', app.classList.contains('sb-collapsed') ? '1' : '0');
      resizeChartsSoon();
    });
  }
  // Render the shell immediately (before any network fetch) so the screen is
  // never blank: returning users see the themed loader, everyone else the login.
  let saved = null;
  try { saved = localStorage.getItem('ds_session'); } catch (e) {}
  if (saved) showLoading('Signing you in…');
  else showLogin();

  $('#login-btn').addEventListener('click', submitLogin);
  $('#login-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitLogin(); });

  S.authBase = await fetchJson('access.json');
  S.auth = mergeAuth(S.authBase);

  if (saved) {
    try {
      const sess = JSON.parse(saved);
      const valid = sess.role === 'admin' || sess.role === 'user' || S.auth.clients[sess.key];
      if (valid) {
        S.session = sess;
        if (sess.role === 'client') {
          const c = S.auth.clients[sess.key];
          S.session.projects = c.projects;
          S.session.is_vodafone = !!c.is_vodafone;
          S.session.logo = c.logo || null;
        }
        await boot();
        return;
      }
    } catch (e) {}
  }
  showLogin();
}

function showLive() {
  const live = document.createElement('div');
  live.style.display = 'none';
  document.body.appendChild(live);
}

window.addEventListener('resize', () => { S.charts.forEach((c) => { try { c.resize(); } catch (e) {} }); });
document.addEventListener('DOMContentLoaded', () => { init().catch((e) => { console.error(e); showLogin(); }); });
