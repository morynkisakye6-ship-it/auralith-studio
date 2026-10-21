// Playwright harness: static server for www/ + fake Supabase backend, fake microphone, audio instrumentation.
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createBackend } from './fake-backend.mjs';
// Let Playwright routes also see service-worker network traffic (needed to test offline/SDK caching).
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

function loadPlaywright() {
  const roots = [process.cwd() + '/', process.env.PLAYWRIGHT_NODE_PATH, (() => { try { return execSync('npm root -g', { encoding: 'utf8' }).trim() + '/'; } catch { return null; } })()].filter(Boolean);
  for (const r of roots) { try { return createRequire(r.endsWith('/') ? r : r + '/')('playwright'); } catch (_) {} }
  throw new Error('Playwright not found. Run: npm i --no-save playwright && npx playwright install chromium');
}
export const pw = loadPlaywright();
export const WWW = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2' };

export const VIEWPORTS = {
  'small-android 360x640': { viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 12; SM-A125F) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36' },
  'iphone-14 390x844': { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  'pixel-7 412x915': { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36' }
};

// Injected before any page script: audio/recording/download instrumentation for assertions.
const INSTRUMENT = () => {
  const T = window.__qa = { contexts: [], sourcesStarted: 0, oscStarted: 0, mediaPlays: 0, raf: 0, recorders: [], blobs: [], downloads: [], errors: [], micRequests: 0 };
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC) {
    const Wrapped = function (...a) { const c = new AC(...a); T.contexts.push(c); return c; };
    Wrapped.prototype = AC.prototype; window.AudioContext = Wrapped; window.webkitAudioContext = Wrapped;
    for (const [cls, key] of [['AudioBufferSourceNode', 'sourcesStarted'], ['OscillatorNode', 'oscStarted']]) {
      const proto = window[cls] && window[cls].prototype; if (!proto) continue;
      const orig = proto.start; proto.start = function (...a) { T[key]++; if (T.firstSrcAt == null) T.firstSrcAt = performance.now(); return orig.apply(this, a); };
    }
  }
  const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = cb => { T.raf++; return raf(cb); };
  const mp = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { T.mediaPlays++; return mp.apply(this, arguments); };
  if (window.MediaRecorder) {
    const MR = window.MediaRecorder;
    window.MediaRecorder = class extends MR {
      constructor(...a) { super(...a); T.recorders.push(this); }
      start(...a) { T.recStartAt = performance.now(); return super.start(...a); }
    };
  }
  const gum = navigator.mediaDevices && navigator.mediaDevices.getUserMedia && navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  if (gum) navigator.mediaDevices.getUserMedia = (...a) => { T.micRequests++; return gum(...a); };
  const cou = URL.createObjectURL.bind(URL);
  URL.createObjectURL = b => { try { if (b instanceof Blob) T.blobs.push(b); } catch (_) {} return cou(b); };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { if (this.download) T.downloads.push({ name: this.download, href: this.href }); return click.apply(this, arguments); };
  window.addEventListener('error', e => T.errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', e => T.errors.push('unhandledrejection: ' + String(e.reason && e.reason.message || e.reason)));
};

export async function startWorld() {
  const backend = createBackend();
  let origin = '';
  const server = http.createServer(async (req, res) => {
    try {
      if (await backend.handle(req, res, origin)) return;
      let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
      const f = path.join(WWW, p);
      if (!f.startsWith(WWW) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end('not found'); }
      res.setHeader('content-type', MIME[path.extname(f)] || 'application/octet-stream');
      res.setHeader('cache-control', 'no-store');
      res.end(fs.readFileSync(f));
    } catch (e) { res.statusCode = 500; res.end(String(e)); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await pw.chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const stubLib = fs.readFileSync(new URL('./fake-supabase-client.js', import.meta.url), 'utf8');
  const world = { backend, origin, browser, contexts: [], blockedRequests: [] };

  /** Open a fresh, isolated "device" (own storage, own session). */
  world.device = async (name = 'iphone-14 390x844', opts = {}) => {
    const ctx = await browser.newContext({ ...VIEWPORTS[name], permissions: ['microphone'], acceptDownloads: true, serviceWorkers: opts.serviceWorkers || 'block', ...opts.context });
    await ctx.addInitScript(INSTRUMENT);
    await ctx.route('**/*', route => {
      const u = route.request().url();
      if (u.startsWith(origin)) return route.continue();
      if (/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js/.test(u)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: stubLib });
      world.blockedRequests.push(u); return route.abort();        // no real network in tests
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
    ctx.__errors = errors; world.contexts.push(ctx);
    return { ctx, page, errors, open: () => page.goto(origin + '/'), qa: () => page.evaluate(() => ({ sourcesStarted: window.__qa.sourcesStarted, mediaPlays: window.__qa.mediaPlays, oscStarted: window.__qa.oscStarted, micRequests: window.__qa.micRequests, recorders: window.__qa.recorders.length, blobs: window.__qa.blobs.length, downloads: window.__qa.downloads, errors: window.__qa.errors })) };
  };
  world.close = async () => { await browser.close(); await new Promise(r => server.close(r)); };
  return world;
}

/** Virtual cable: everything the app plays is fed back into getUserMedia after `delayMs` (an ideal speaker-to-mic path),
 *  optionally with white noise. Install with `await d.ctx.addInitScript(LOOPBACK, { delayMs, noise })`. */
export const LOOPBACK = (cfg) => {
  const L = window.__loop = { delayMs: cfg.delayMs || 0, noise: cfg.noise || 0, ctx: null, dest: null, delay: null, level: null, tap: null, opened: 0 };
  L.setDelay = ms => { L.delayMs = ms; if (L.delay) L.delay.delayTime.value = ms / 1000; };
  L.setLevel = v => { if (L.level) L.level.gain.value = v; };
  const AC = window.AudioContext;
  const Wrapped = function (...a) {
    const c = new AC(...a);
    if (!L.ctx) {
      L.ctx = c; L.dest = c.createMediaStreamDestination(); L.delay = c.createDelay(2); L.delay.delayTime.value = L.delayMs / 1000;
      L.level = c.createGain(); L.tap = c.createGain(); L.tap.connect(L.delay); L.delay.connect(L.level); L.level.connect(L.dest);
      if (L.noise) { const n = c.createBufferSource(), b = c.createBuffer(1, c.sampleRate * 2, c.sampleRate), d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; n.buffer = b; n.loop = true; const g = c.createGain(); g.gain.value = L.noise; n.connect(g); g.connect(L.dest); n.start(); }
    }
    return c;
  };
  Wrapped.prototype = AC.prototype; window.AudioContext = Wrapped; window.webkitAudioContext = Wrapped;
  const oc = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (t, ...r) {
    const res = oc.call(this, t, ...r);
    try { if (L.ctx && this.context === L.ctx && this !== L.tap && t === L.ctx.destination) oc.call(this, L.tap); } catch (_) {}
    return res;
  };
  L.streams = [];
  navigator.mediaDevices.getUserMedia = async () => { for (let i = 0; i < 200 && !L.dest; i++) await new Promise(r => setTimeout(r, 25)); L.opened++; const st = L.dest.stream.clone(); L.streams.push(st); return st; };
};
