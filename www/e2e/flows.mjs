// Reusable user flows + media analysis helpers for the e2e specs.
import fs from 'node:fs';

let n = 0;
export async function signUp(d, name = 'artist' + ++n) {
  const pg = d.page;
  await d.open();
  await pg.waitForSelector('#gotoSignup', { state: 'visible' });
  await pg.tap('#gotoSignup');
  await pg.fill('#signupUsername', name);
  await pg.fill('#signupContact', `${name}@example.test`);
  await pg.fill('#signupPass', 'password123');
  await pg.tap('#doSignUp');
  await pg.waitForFunction(() => !document.querySelector('#authModal.show'), null, { timeout: 10000 });
  return name;
}
export const goNav = (d, nav) => d.page.tap(`[data-nav="${nav}"]`);
export async function goStudio(d, sub) { await goNav(d, 'studio'); await d.page.tap(`[data-studio="${sub}"]`); await d.page.waitForSelector(`#view-${sub}:not([hidden])`); }
export const visibleView = pg => pg.$$eval('section.view', els => els.filter(e => !e.hidden).map(e => e.id));

/** Record `ms` of fake-mic audio on the Record tab; resolves once the take is saved. */
export async function recordTake(d, ms = 2200) {
  const pg = d.page;
  await goStudio(d, 'record');
  await pg.tap('#vocalRecBtn');
  await pg.waitForFunction(() => /sing now|recording/i.test(document.getElementById('recStatus')?.textContent || ''), null, { timeout: 8000 });
  await pg.waitForTimeout(ms);
  await pg.tap('#vocalRecBtn');
  await pg.waitForFunction(() => /take \d+ saved/i.test(document.getElementById('recStatus')?.textContent || ''), null, { timeout: 15000 });
}

/** Parse a WAV buffer: header facts + peak/RMS of the PCM data. */
export function analyzeWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return { valid: false, reason: 'not RIFF/WAVE' };
  let o = 12, fmt = null, data = null;
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4), size = buf.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(o + 8), channels: buf.readUInt16LE(o + 10), rate: buf.readUInt32LE(o + 12), bits: buf.readUInt16LE(o + 22) };
    if (id === 'data') { data = { start: o + 8, size }; break; }
    o += 8 + size + (size & 1);
  }
  if (!fmt || !data) return { valid: false, reason: 'missing fmt/data chunk' };
  const riffSize = buf.readUInt32LE(4);
  const frames = Math.floor(data.size / (fmt.channels * (fmt.bits / 8)));
  let peak = 0, sum = 0, count = 0;
  for (let i = data.start; i + 1 < data.start + data.size && i + 1 < buf.length; i += 2 * 17) { const v = Math.abs(buf.readInt16LE(i)) / 32768; if (v > peak) peak = v; sum += v * v; count++; }
  return { valid: true, ...fmt, riffSizeOk: riffSize === buf.length - 8, dataSizeOk: data.start + data.size === buf.length, frames, seconds: frames / fmt.rate, peak, rms: Math.sqrt(sum / Math.max(1, count)) };
}
export const readDownload = async dl => fs.readFileSync(await dl.path());

/** A tiny but valid mono 16-bit WAV with a sine tone, for upload tests. */
export function makeWav({ seconds = 1, rate = 8000, freq = 440 } = {}) {
  const frames = Math.floor(seconds * rate), data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / rate) * 12000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
