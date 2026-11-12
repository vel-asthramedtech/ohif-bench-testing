// bench.spec.js
// OHIF benchmark: 2D stack first-render (render.csv) + 3D/MPR visual load (render3d.csv)
//
// Env options (PowerShell: $env:NAME="value"):
//   OHIF_URL=http://localhost:3000
//   RUNS=5
//   MODE=both | 2d | 3d            which tests to run (default both)
//   HP=mprAnd3DVolumeViewport      hanging protocol id used for 3D (see notes)
//   VIEWPORTS=4                    how many viewports must show content (only3D -> 1)
//   FULL_LOAD=1                    (2D only) scroll to last slice, wait for network idle
//   NETWORK=fast4g | slow4g
//   HEADED=1

const { test } = require('@playwright/test');
const fs = require('fs');
let studies;
try {
  studies = require('./studies.json');
} catch {
  throw new Error('studies.json not found. Run upload.spec.js first.');
}

const OHIF = process.env.OHIF_URL || 'http://localhost:3000';
const RUNS = parseInt(process.env.RUNS || '5', 10);
const MODE = (process.env.MODE || 'both').toLowerCase();
const HP = process.env.HP || 'mprAnd3DVolumeViewport';
const MIN_VIEWPORTS = parseInt(process.env.VIEWPORTS || '4', 10);
const FULL_LOAD = !!process.env.FULL_LOAD;
const NETWORK = process.env.NETWORK;

const CSV_2D = 'render.csv';
const CSV_3D = 'render3d.csv';

const FIRST_RENDER_TIMEOUT = 20_000;
const CANVAS_FALLBACK_TIMEOUT = 60_000;
const IDLE_TIMEOUT = 60_000;
const VISUAL_TIMEOUT = 120_000; // max wait for 3D to appear
const STABLE_MS = 1500;         // picture must stop changing this long to count as "ready"
const POLL_MS = 100;
const SCROLL_CAP_MS = 3 * 60 * 1000; // max time spent scrolling in FULL_LOAD
const TEST_TIMEOUT = 20 * 60 * 1000; // each test runs cold + warm, so allow plenty

console.log(
  `[config] MODE=${MODE} RUNS=${RUNS} FULL_LOAD=${FULL_LOAD} NETWORK=${NETWORK || 'off'} ` +
  `HEADED=${process.env.HEADED ? 'on' : 'off'} HP=${HP} VIEWPORTS=${MIN_VIEWPORTS}`
);

const PROFILES = {
  fast4g: { latency: 150, down: (1.6 * 1024 * 1024) / 8, up: (750 * 1024) / 8 },
  slow4g: { latency: 400, down: (400 * 1024) / 8, up: (400 * 1024) / 8 },
};

function ensureCsv(file, header) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, header + '\n', 'utf8');
}
ensureCsv(CSV_2D, 'timestamp,label,size_mb,instances,phase,run,network,headed,first_frame_ms,last_frame_ms,first_render_ms,render_source,full_load_ms,frames,heap_mb,status');
ensureCsv(CSV_3D, 'timestamp,label,size_mb,instances,phase,run,hp,network,headed,first_frame_ms,last_frame_ms,visual_first_ms,visual_ready_ms,ready_after_last_frame_ms,viewports,frames,heap_mb,status');
fs.mkdirSync('shots', { recursive: true });

const url2d = (s) => `${OHIF}/viewer?StudyInstanceUIDs=${s.uid}`;
const url3d = (s) => `${OHIF}/viewer?StudyInstanceUIDs=${s.uid}&hangingprotocolId=${HP}`;

async function applyThrottle(context, page) {
  if (!NETWORK || !PROFILES[NETWORK]) return;
  const p = PROFILES[NETWORK];
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: p.latency,
    downloadThroughput: p.down,
    uploadThroughput: p.up,
  });
}

async function readHeap(page) {
  try {
    return (await page.evaluate(() => performance.memory.usedJSHeapSize / 1e6)).toFixed(0);
  } catch {
    return '';
  }
}

// scan size and instance count come from studies.json (written by upload.spec.js)
const sizeMb = (s) => (s.size_mb ?? '');
const instCount = (s) => (s.instances ?? '');
const NET = NETWORK || 'off';
const HEADED = process.env.HEADED ? 'yes' : 'no';

/* ------------------------------------------------------------------ */
/* 2D stack measurement                                                */
/* ------------------------------------------------------------------ */
async function measure2D(page, s, phase, run, navigate) {
  const state = { frames: 0, firstFrame: null, lastFrame: null };
  const t0 = Date.now();
  const onResponse = (r) => {
    if (r.url().includes('/frames/')) {
      state.frames++;
      if (state.firstFrame === null) state.firstFrame = Date.now() - t0;
      state.lastFrame = Date.now() - t0;
    }
  };
  page.on('response', onResponse);

  let firstRender = null, source = 'none', fullLoad = null, status = 'ok';

  try {
    await navigate();
    try {
      await page.waitForFunction(() => window.__rendered === true, null, { timeout: FIRST_RENDER_TIMEOUT });
      source = 'event';
    } catch {
      await page.waitForSelector('canvas', { state: 'visible', timeout: CANVAS_FALLBACK_TIMEOUT });
      source = 'canvas';
    }
    firstRender = Date.now() - t0;
    console.log(`[${s.label}] 2D ${phase} #${run}: first render ${firstRender} ms (${source})`);

    if (FULL_LOAD) {
      await page.locator('canvas').first().hover();
      const scrollStart = Date.now();
      for (let i = 0; i < s.instances; i++) {
        if (Date.now() - scrollStart > SCROLL_CAP_MS) { status = 'scroll_cap'; break; }
        await page.mouse.wheel(0, 100);
        if (i % 20 === 0) await page.waitForTimeout(50);
      }
      await page.waitForLoadState('networkidle', { timeout: IDLE_TIMEOUT }).catch(() => { status = 'idle_timeout'; });
      fullLoad = Date.now() - t0;
    }
  } catch (err) {
    status = 'failed: ' + String(err.message).split('\n')[0].replace(/,/g, ';');
    console.log(`[${s.label}] 2D ${phase} #${run}: ${status}`);
  } finally {
    page.off('response', onResponse);
  }

  const heap = await readHeap(page);
  fs.appendFileSync(
    CSV_2D,
    [
      new Date().toISOString(), s.label, sizeMb(s), instCount(s), phase, run, NET, HEADED,
      state.firstFrame ?? '', state.lastFrame ?? '', firstRender ?? '', source, fullLoad ?? '',
      state.frames, heap, status,
    ].join(',') + '\n'
  );
}

/* ------------------------------------------------------------------ */
/* 3D / MPR visual load                                                */
/* ------------------------------------------------------------------ */

// Runs inside the browser: samples every Cornerstone viewport canvas at 32x32
// and returns how many exist, whether all show content, and a signature of the pixels.
function sampleViewports() {
  const canvases = Array.from(document.querySelectorAll('canvas.cornerstone-canvas'));
  if (!canvases.length) return { n: 0, allNonBlank: false, sig: '' };
  const W = 32, H = 32;
  const tmp = document.createElement('canvas');
  tmp.width = W;
  tmp.height = H;
  const ctx = tmp.getContext('2d', { willReadFrequently: true });
  const sigs = [];
  let allNonBlank = true;
  for (const c of canvases) {
    if (!c.width || !c.height) { allNonBlank = false; sigs.push('0'); continue; }
    ctx.clearRect(0, 0, W, H);
    try {
      ctx.drawImage(c, 0, 0, W, H);
    } catch (e) {
      allNonBlank = false;
      sigs.push('err');
      continue;
    }
    const d = ctx.getImageData(0, 0, W, H).data;
    let sum = 0, lit = 0;
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i] + d[i + 1] + d[i + 2];
      sum += v;
      if (v > 30) lit++;
    }
    if (lit < 8) allNonBlank = false;
    sigs.push(sum);
  }
  return { n: canvases.length, allNonBlank, sig: sigs.join('|') };
}

// visual_first = first moment every expected viewport shows content
// visual_ready = moment the picture last changed before staying still for STABLE_MS
async function waitForVisual(page, t0) {
  const deadline = Date.now() + VISUAL_TIMEOUT;
  let first = null, lastSig = null, lastChange = null, ready = null, lastN = 0;

  while (Date.now() < deadline) {
    const r = await page.evaluate(sampleViewports).catch(() => null);
    const now = Date.now() - t0;
    if (r) lastN = r.n;

    if (r && r.n >= MIN_VIEWPORTS && r.allNonBlank) {
      if (first === null) first = now;
      if (r.sig !== lastSig) {
        lastSig = r.sig;
        lastChange = now;
      } else if (now - lastChange >= STABLE_MS) {
        ready = lastChange;
        break;
      }
    } else {
      lastSig = null; // content disappeared or still loading, restart stability check
    }
    await page.waitForTimeout(POLL_MS);
  }
  return { first, ready, viewports: lastN };
}

async function measure3D(page, s, phase, run, navigate) {
  const state = { frames: 0, firstFrame: null, lastFrame: null };
  const t0 = Date.now();
  const onResponse = (r) => {
    if (r.url().includes('/frames/')) {
      state.frames++;
      if (state.firstFrame === null) state.firstFrame = Date.now() - t0;
      state.lastFrame = Date.now() - t0;
    }
  };
  page.on('response', onResponse);

  let visual = { first: null, ready: null, viewports: 0 };
  let status = 'ok';

  try {
    await navigate();
    visual = await waitForVisual(page, t0);
    if (visual.ready === null) {
      status = visual.first === null
        ? `no_visual (viewports seen: ${visual.viewports}, expected ${MIN_VIEWPORTS})`
        : 'never_stable';
    }
    console.log(
      `[${s.label}] 3D ${phase} #${run}: visual first ${visual.first} ms, ready ${visual.ready} ms, ` +
      `last frame ${state.lastFrame} ms, viewports ${visual.viewports}, frames ${state.frames}, ${status}`
    );
    // Screenshot as visual proof (taken after timing, so it doesn't affect results)
    await page.screenshot({ path: `shots/${s.label}_3d_${phase}_${run}.png` }).catch(() => {});
  } catch (err) {
    status = 'failed: ' + String(err.message).split('\n')[0].replace(/,/g, ';');
    console.log(`[${s.label}] 3D ${phase} #${run}: ${status}`);
  } finally {
    page.off('response', onResponse);
  }

  // rough rendering time after the last image frame arrived (blank if no frames or not ready)
  const afterLast = visual.ready !== null && state.lastFrame !== null ? visual.ready - state.lastFrame : null;

  const heap = await readHeap(page);
  fs.appendFileSync(
    CSV_3D,
    [
      new Date().toISOString(), s.label, sizeMb(s), instCount(s), phase, run, HP, NET, HEADED,
      state.firstFrame ?? '', state.lastFrame ?? '', visual.first ?? '', visual.ready ?? '',
      afterLast ?? '', visual.viewports, state.frames, heap, status.replace(/,/g, ';'),
    ].join(',') + '\n'
  );
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */
for (const s of studies) {
  for (let run = 1; run <= RUNS; run++) {
    if (MODE === 'both' || MODE === '2d') {
      test(`2D ${s.label} run ${run}`, async ({ browser }) => {
        test.setTimeout(TEST_TIMEOUT);
        const context = await browser.newContext(); // fresh context = cold cache
        const page = await context.newPage();
        await page.addInitScript(() => {
          window.__rendered = false;
          document.addEventListener('CORNERSTONE_IMAGE_RENDERED', () => { window.__rendered = true; }, true);
        });
        await applyThrottle(context, page);

        await measure2D(page, s, 'cold', run, () => page.goto(url2d(s), { waitUntil: 'domcontentloaded' }));
        await measure2D(page, s, 'warm', run, () => page.reload({ waitUntil: 'domcontentloaded' }));
        await context.close();
      });
    }

    if (MODE === 'both' || MODE === '3d') {
      test(`3D ${s.label} run ${run}`, async ({ browser }) => {
        test.setTimeout(TEST_TIMEOUT);
        const context = await browser.newContext();
        const page = await context.newPage();
        await applyThrottle(context, page);

        await measure3D(page, s, 'cold', run, () => page.goto(url3d(s), { waitUntil: 'domcontentloaded' }));
        await measure3D(page, s, 'warm', run, () => page.reload({ waitUntil: 'domcontentloaded' }));
        await context.close();
      });
    }
  }
}