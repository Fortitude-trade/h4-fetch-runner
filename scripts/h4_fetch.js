// H4 candle fetcher for GitHub Actions: downloads Dukascopy hourly-candle files and writes one JSON file per
// instrument-year (<instrument>-<year>-h4.json) with bid H4 bars.
//
// Safety rules (each exists because the library hides failures):
//  - dukascopy-node treats an HTTP 429 as "no data" instead of an error, so a year with some months blocked would
//    come back half-empty and look valid. This script wraps fetch and THROWS on any status other than 200/404, which
//    aborts the attempt after the first blocked request. A year is only written when EVERY request was 200 or 404.
//  - 0 bars for a year after inception is a failure, never a cached empty result.
//  - On a blocked/failed attempt it waits (default 10 min) and retries the SAME year, until a runtime budget is used up,
//    then stops (exit 3) keeping everything fetched so far. One request at a time, long pauses, no hammering.
//
// Env: INSTRUMENTS (comma list), FROM_YEAR (default 2003), TO_YEAR (default 2025), OUT_DIR (default ./out),
//      PAUSE_FILES_MS (6000), PAUSE_YEARS_MS (20000), WAIT_MS (600000), MAX_RUNTIME_MS (19200000 = 5h20m),
//      DEBUG_LIB=1 (log the status of every request).
// Exit: 0 all requested years done (or skipped as pre-inception); 3 stopped before finishing (files so far are kept).
const fs = require('fs');
const path = require('path');

const OUT = process.env.OUT_DIR || path.join(process.cwd(), 'out');
const INSTRUMENTS = (process.env.INSTRUMENTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const FROM = Number(process.env.FROM_YEAR || 2003);
const TO = Number(process.env.TO_YEAR || 2025);
const PAUSE_FILES = Number(process.env.PAUSE_FILES_MS || 6000);
const PAUSE_YEARS = Number(process.env.PAUSE_YEARS_MS || 20000);
const WAIT = Number(process.env.WAIT_MS || 600000);
const MAX_RUNTIME = Number(process.env.MAX_RUNTIME_MS || 19200000);
const DEBUG = process.env.DEBUG_LIB === '1';
const T0 = Date.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);

// Per-attempt record of every HTTP outcome, and a fetch wrapper that refuses to hide a block.
let seen = [];
if (typeof globalThis.fetch === 'function') {
  const orig = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (...args) => {
    const u = String((args[0] && args[0].url) || args[0]);
    let r;
    try {
      r = await orig(...args);
    } catch (e) {
      const c = e && e.cause;
      const why = String((c && (c.code || c.message)) || e.message).slice(0, 100);
      seen.push('NETERR ' + why);
      if (DEBUG) console.log(ts(), 'NETERR', why, u.slice(-58));
      throw e;
    }
    seen.push(String(r.status));
    if (DEBUG) console.log(ts(), 'HTTP', r.status, r.headers.get('content-length') || '-', u.slice(-58));
    if (r.status !== 200 && r.status !== 404) throw new Error(`HTTP ${r.status}`);
    return r;
  };
}

function summarise(list) {
  const c = {};
  for (const s of list) c[s] = (c[s] || 0) + 1;
  return Object.entries(c).map(([k, v]) => `${k}x${v}`).join(',') || 'no requests';
}

async function main() {
  if (!INSTRUMENTS.length) { console.error('INSTRUMENTS is empty'); process.exit(2); }
  fs.mkdirSync(OUT, { recursive: true });
  // Node's built-in fetch gives up connecting after 10s, but Dukascopy's CDN can take 15-35s to accept a connection from
  // some networks. Give connects/headers/body a generous timeout (no effect on what is requested).
  try {
    const { Agent, setGlobalDispatcher } = await import('undici');
    setGlobalDispatcher(new Agent({ connect: { timeout: 90000 }, headersTimeout: 180000, bodyTimeout: 180000 }));
    console.log(ts(), 'undici dispatcher set: connect timeout 90s');
  } catch (e) { console.log(ts(), 'undici not available, default timeouts:', e.message); }
  const mod = await import('dukascopy-node');
  const getHistoricalRates = mod.getHistoricalRates || (mod.default && mod.default.getHistoricalRates);
  const meta = mod.instrumentMetaData || (mod.default && mod.default.instrumentMetaData);
  let stopped = false;
  for (const inst of INSTRUMENTS) {
    if (stopped) break;
    // A year entirely before the vendor-declared H4 inception is not fetched; unknown instrument => nothing skipped.
    const entry = meta && meta[inst];
    const start = entry && entry.startMonthForHourlyCandles;
    const incMs = start ? new Date(start).getTime() : null;
    const inception = Number.isFinite(incMs) ? incMs : null;
    for (let y = FROM; y <= TO && !stopped; y++) {
      if (inception != null && Date.UTC(y + 1, 0, 1) <= inception) { console.log(ts(), inst, y, 'skip (pre-inception)'); continue; }
      const file = path.join(OUT, `${inst}-${y}-h4.json`);
      if (fs.existsSync(file)) { console.log(ts(), inst, y, 'already present'); continue; }
      for (let attempt = 1; ; attempt++) {
        seen = [];
        let problem = null, out = null;
        try {
          const rates = await getHistoricalRates({
            instrument: inst,
            dates: { from: new Date(Date.UTC(y, 0, 1)), to: new Date(Date.UTC(y + 1, 0, 1)) },
            timeframe: 'h4', priceType: 'bid', format: 'json',
            retryCount: 0, batchSize: 1, pauseBetweenBatchesMs: PAUSE_FILES,
            debug: false,
          });
          out = (rates || []).map(r => ({
            ts: new Date(r.timestamp).toISOString(),
            open: +r.open, high: +r.high, low: +r.low, close: +r.close,
            volume: r.volume == null ? 0 : +r.volume,
          }));
          const bad = seen.filter(s => s !== '200' && s !== '404');
          if (bad.length) problem = `non-clean responses (${summarise(bad)})`;
          else if (out.length === 0) problem = `0 bars (${summarise(seen)})`;
        } catch (e) {
          const c = e && e.cause;
          problem = `${String(e && e.message).slice(0, 60)}${c ? ' | ' + (c.code || '') + ' ' + String(c.message || c).slice(0, 80) : ''} (${summarise(seen)})`;
        }
        if (!problem) {
          fs.writeFileSync(file, JSON.stringify(out));
          console.log(ts(), inst, y, `OK ${out.length} (${summarise(seen)})`);
          break;
        }
        const left = MAX_RUNTIME - (Date.now() - T0);
        if (left < WAIT + 120000) {
          console.log(ts(), inst, y, `FAILED attempt ${attempt}: ${problem} - runtime budget used up, stopping`);
          stopped = true;
          break;
        }
        console.log(ts(), inst, y, `BLOCKED attempt ${attempt}: ${problem} - waiting ${Math.round(WAIT / 60000)}m, ${Math.round(left / 60000)}m of budget left`);
        await sleep(WAIT);
      }
      if (!stopped) await sleep(PAUSE_YEARS);
    }
  }
  console.log(ts(), stopped ? 'STOPPED BEFORE FINISHING' : 'CI FETCH COMPLETE', fs.readdirSync(OUT).length, 'files');
  process.exit(stopped ? 3 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
