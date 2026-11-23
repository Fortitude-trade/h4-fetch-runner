// H4 candle fetcher for GitHub Actions: downloads Dukascopy hourly-candle files and writes one JSON file per
// instrument-year (<instrument>-<year>-h4.json) with bid H4 bars. One request at a time, long pauses, no retries,
// stops on the first failure so it never hammers the host.
//
// Env: INSTRUMENTS (comma list), FROM_YEAR (default 2003), TO_YEAR (default 2025), OUT_DIR (default ./out),
//      PAUSE_FILES_MS (default 6000), PAUSE_YEARS_MS (default 20000).
// Exit: 0 all requested years done (or skipped as pre-inception); 3 stopped on a failure (files so far are kept).
const fs = require('fs');
const path = require('path');

const OUT = process.env.OUT_DIR || path.join(process.cwd(), 'out');
const INSTRUMENTS = (process.env.INSTRUMENTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const FROM = Number(process.env.FROM_YEAR || 2003);
const TO = Number(process.env.TO_YEAR || 2025);
const PAUSE_FILES = Number(process.env.PAUSE_FILES_MS || 6000);
const PAUSE_YEARS = Number(process.env.PAUSE_YEARS_MS || 20000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);

async function main() {
  if (!INSTRUMENTS.length) { console.error('INSTRUMENTS is empty'); process.exit(2); }
  fs.mkdirSync(OUT, { recursive: true });
  const mod = await import('dukascopy-node');
  const getHistoricalRates = mod.getHistoricalRates || (mod.default && mod.default.getHistoricalRates);
  const meta = mod.instrumentMetaData || (mod.default && mod.default.instrumentMetaData);
  let failed = false;
  for (const inst of INSTRUMENTS) {
    // A year entirely before the vendor-declared
    // H4 inception is not fetched; unknown instrument => nothing skipped.
    const entry = meta && meta[inst];
    const start = entry && entry.startMonthForHourlyCandles;
    const incMs = start ? new Date(start).getTime() : null;
    const inception = Number.isFinite(incMs) ? incMs : null;
    for (let y = FROM; y <= TO; y++) {
      if (inception != null && Date.UTC(y + 1, 0, 1) <= inception) { console.log(ts(), inst, y, 'skip (pre-inception)'); continue; }
      const file = path.join(OUT, `${inst}-${y}-h4.json`);
      if (fs.existsSync(file)) { console.log(ts(), inst, y, 'already present'); continue; }
      try {
        const rates = await getHistoricalRates({
          instrument: inst,
          dates: { from: new Date(Date.UTC(y, 0, 1)), to: new Date(Date.UTC(y + 1, 0, 1)) },
          timeframe: 'h4', priceType: 'bid', format: 'json',
          retryCount: 0, batchSize: 1, pauseBetweenBatchesMs: PAUSE_FILES,
        });
        const out = (rates || []).map(r => ({
          ts: new Date(r.timestamp).toISOString(),
          open: +r.open, high: +r.high, low: +r.low, close: +r.close,
          volume: r.volume == null ? 0 : +r.volume,
        }));
        fs.writeFileSync(file, JSON.stringify(out));
        console.log(ts(), inst, y, `OK ${out.length}`);
      } catch (e) {
        const c = e && e.cause; const cause = c ? ` | cause: ${c.code || ''} ${String(c.message || c).slice(0, 160)}` : '';
        console.log(ts(), inst, y, `FAILED ${String(e && e.message).slice(0, 80)}${cause} - stopping this instrument`);
        failed = true;
        break; // stop on first failure; never loop retries
      }
      await sleep(PAUSE_YEARS);
    }
  }
  console.log(ts(), failed ? 'STOPPED ON FAILURE' : 'CI FETCH COMPLETE', fs.readdirSync(OUT).length, 'files');
  process.exit(failed ? 3 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
