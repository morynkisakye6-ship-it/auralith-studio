/* Tapehead MP3 export: loads lamejs on demand (cached by the service worker for offline use) and encodes
   mastered channel data in small slices so the UI stays responsive. Exposes window.TapeheadMp3. */
(function (root) {
  'use strict';
  const LAME_URL = 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js';
  function load() {
    if (root.lamejs) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('lamejs load timed out')), 15000);
      const s = document.createElement('script');
      s.src = LAME_URL;
      s.onload = () => { clearTimeout(t); root.lamejs ? resolve() : reject(new Error('lamejs missing after load')); };
      s.onerror = () => { clearTimeout(t); reject(new Error('lamejs failed to load')); };
      document.head.appendChild(s);
    });
  }
  /** channels: Float32Array[] (1 or 2), rate: Hz. Resolves to an audio/mpeg Blob. */
  async function encode(channels, rate, o) {
    o = o || {};
    await load();
    const n = Math.min(2, channels.length), N = channels[0].length, B = 1152;
    const enc = new root.lamejs.Mp3Encoder(n, rate, o.kbps || 192);
    const dsp = root.TapeheadDSP, rng = dsp ? dsp.makeRng(0x1234abcd) : null;
    const q = x => (dsp ? dsp.quantize16(x, rng) : Math.max(-32768, Math.min(32767, Math.round(x < 0 ? x * 32768 : x * 32767))));
    const parts = [];
    const span = B * 64;                                   // ~1.7 s of audio between yields to the event loop
    for (let s = 0; s < N; s += span) {
      const e = Math.min(N, s + span), data = [];
      for (let c = 0; c < n; c++) { const p = new Int16Array(e - s), f = channels[c]; for (let i = s; i < e; i++) p[i - s] = q(f[i]); data.push(p); }
      for (let i = 0; i < e - s; i += B) {
        const l = data[0].subarray(i, i + B), r = n > 1 ? data[1].subarray(i, i + B) : undefined;
        const m = n > 1 ? enc.encodeBuffer(l, r) : enc.encodeBuffer(l);
        if (m.length) parts.push(new Int8Array(m));
      }
      if (o.onProgress) o.onProgress(e / N);
      await new Promise(r => setTimeout(r, 0));
    }
    const tail = enc.flush(); if (tail.length) parts.push(new Int8Array(tail));
    return new Blob(parts, { type: 'audio/mpeg' });
  }
  root.TapeheadMp3 = { encode, load, LAME_URL };
})(typeof self !== 'undefined' ? self : this);
