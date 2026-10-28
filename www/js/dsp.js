/* Auralith DSP core: loudness (ITU-R BS.1770-4 / EBU R128), true peak, lookahead limiter,
   loudness mastering, TPDF dither and take-level analysis. Pure functions on Float32Array channels;
   no DOM and no Web Audio, so it runs identically in the browser (window.AuralithDSP) and in Node tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AuralithDSP = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const toDb = x => (x > 0 ? 20 * Math.log10(x) : -Infinity);
  const fromDb = d => Math.pow(10, d / 20);

  /* ---------- K-weighting (BS.1770-4), coefficients for any sample rate ---------- */
  function kWeighting(fs) {
    let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    let K = Math.tan(Math.PI * f0 / fs);
    const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
    let a0 = 1 + K / Q + K * K;
    const shelf = { b: [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0], a: [2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0] };
    f0 = 38.13547087602444; Q = 0.5003270373238773;
    K = Math.tan(Math.PI * f0 / fs); a0 = 1 + K / Q + K * K;
    const hp = { b: [1, -2, 1], a: [2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0] };
    return [shelf, hp];
  }
  function biquad(x, c) {                                  // direct form I, Float64 internally
    const y = new Float64Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    const b0 = c.b[0], b1 = c.b[1], b2 = c.b[2], a1 = c.a[0], a2 = c.a[1];
    for (let i = 0; i < x.length; i++) {
      const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  }

  /** Integrated loudness in LUFS with absolute (-70) and relative (-10 LU) gating. -Infinity if silent. */
  function integratedLoudness(channels, rate) {
    const len = channels[0] ? channels[0].length : 0;
    if (!len) return -Infinity;
    const [s1, s2] = kWeighting(rate);
    const cum = channels.map(ch => {                       // prefix sums of squared K-weighted samples
      const f = biquad(biquad(ch, s1), s2), c = new Float64Array(len + 1);
      for (let i = 0; i < len; i++) c[i + 1] = c[i] + f[i] * f[i];
      return c;
    });
    const N = Math.round(0.4 * rate), step = Math.max(1, Math.round(0.1 * rate));
    const blocks = [];
    const push = (a, b) => { let z = 0; for (const c of cum) z += (c[b] - c[a]) / (b - a); blocks.push(z); };
    if (len < N) push(0, len); else for (let s = 0; s + N <= len; s += step) push(s, s + N);
    const loud = z => (z > 0 ? -0.691 + 10 * Math.log10(z) : -Infinity);
    const abs = blocks.filter(z => loud(z) > -70);
    if (!abs.length) return -Infinity;
    const rel = loud(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
    const gated = abs.filter(z => loud(z) > rel);
    if (!gated.length) return -Infinity;
    return loud(gated.reduce((a, b) => a + b, 0) / gated.length);
  }

  /* ---------- True peak: 4x windowed-sinc oversampling ---------- */
  const TAPS = 6;                                          // +/- samples either side
  const PH = [0.25, 0.5, 0.75].map(p => {
    const w = [];
    for (let k = -TAPS + 1; k <= TAPS; k++) {
      const d = k - p, s = Math.abs(d) < 1e-9 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
      const win = 0.5 * (1 + Math.cos(Math.PI * d / (TAPS + 0.5)));    // Hann
      w.push(s * win);
    }
    const sum = w.reduce((a, b) => a + b, 0);
    return w.map(v => v / sum);                            // unity DC gain
  });
  // Interpolated values are bounded by (sum |w|) * max|x| over the 12-sample window, so any position whose window
  // maximum is below floor/SUMW cannot reach `floor` and is skipped. This makes the scan fast on normal music.
  const SUMW = Math.max.apply(null, PH.map(w => w.reduce((a, b) => a + Math.abs(b), 0))) + 1e-6;
  function windowMax(x) {                                  // max |x[j]| for j in [i-TAPS+1, i+TAPS], monotonic deque
    const len = x.length, out = new Float32Array(len), dq = new Int32Array(len + 1); let h = 0, t = 0;
    for (let i = -TAPS + 1; i < len + TAPS; i++) {
      const j = i + TAPS - 1;                              // newest sample entering the window ending at i+TAPS
      if (j < len) { const v = Math.abs(x[j]); while (t > h && Math.abs(x[dq[t - 1]]) <= v) t--; dq[t++] = j; }
      const c = i; if (c < 0 || c >= len) continue;
      while (dq[h] < c - TAPS + 1) h++;
      out[c] = Math.abs(x[dq[h]]);
    }
    return out;
  }
  /** Per-sample true-peak envelope. Values at or below `floor` may be approximate (|x[i]|); above it they are exact. */
  function peakEnvelope(channels, floor) {
    const len = channels[0].length, env = new Float32Array(len), lim = floor > 0 ? floor / SUMW : 0;
    for (const x of channels) {
      const wm = windowMax(x);
      for (let i = 0; i < len; i++) {
        let m = Math.abs(x[i]);
        if (wm[i] >= lim) {
          for (let p = 0; p < 3; p++) {
            const w = PH[p]; let v = 0;
            for (let k = 0; k < 2 * TAPS; k++) { const j = i + k - TAPS + 1; if (j >= 0 && j < len) v += w[k] * x[j]; }
            const a = Math.abs(v); if (a > m) m = a;
          }
        }
        if (m > env[i]) env[i] = m;
      }
    }
    return env;
  }
  function truePeak(channels) {
    let best = samplePeak(channels);                       // true peak >= sample peak; only windows that could beat `best` are scanned
    for (const x of channels) {
      const wm = windowMax(x), len = x.length;
      for (let i = 0; i < len; i++) {
        if (wm[i] * SUMW <= best) continue;
        for (let p = 0; p < 3; p++) {
          const w = PH[p]; let v = 0;
          for (let k = 0; k < 2 * TAPS; k++) { const j = i + k - TAPS + 1; if (j >= 0 && j < len) v += w[k] * x[j]; }
          const a = Math.abs(v); if (a > best) best = a;
        }
      }
    }
    return best;
  }
  function samplePeak(channels) { let m = 0; for (const x of channels) for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > m) m = a; } return m; }

  function analyze(channels, rate) {
    return { lufs: integratedLoudness(channels, rate), truePeakDb: toDb(truePeak(channels)), samplePeakDb: toDb(samplePeak(channels)) };
  }

  /* ---------- Lookahead true-peak limiter (offline, zero overshoot at the oversampled points) ---------- */
  function limit(channels, rate, o) {
    o = o || {};
    const ceil = fromDb(o.ceilingDb != null ? o.ceilingDb : -1);
    const L = Math.max(1, Math.round((o.lookaheadMs || 3) * rate / 1000));
    const rel = Math.exp(-1 / (Math.max(5, o.releaseMs || 120) / 1000 * rate));
    const len = channels[0].length, env = peakEnvelope(channels, ceil);
    const req = new Float32Array(len);
    for (let i = 0; i < len; i++) req[i] = env[i] > ceil ? ceil / env[i] : 1;
    // m[i] = min(req[i .. i+L-1])  (monotonic deque)
    const m = new Float32Array(len), dq = new Int32Array(len + 1); let h = 0, t = 0;
    for (let i = len - 1; i >= 0; i--) {
      while (t > h && req[dq[t - 1]] >= req[i]) t--;
      dq[t++] = i;
      while (dq[h] > i + L - 1) h++;
      m[i] = req[dq[h]];
    }
    // g[i] = mean(m[i-L+1 .. i]) <= req[i]; then slow release, never above g
    const pre = new Float64Array(len + 1); for (let i = 0; i < len; i++) pre[i + 1] = pre[i] + m[i];
    const g = new Float32Array(len); let prev = 1, minG = 1;
    for (let i = 0; i < len; i++) {
      // History before sample 0 is padded with m[0] (not unity), so a transient at the very first sample is still limited.
      const a = Math.max(0, i - L + 1), mean = (pre[i + 1] - pre[a] + (L - (i - a + 1)) * m[0]) / L;
      let v = Math.min(mean, prev + (1 - prev) * (1 - rel));
      if (v > mean) v = mean;
      if (v > 1 - 1e-4) v = 1;                           // snap back to exact unity once the release is inaudible (<0.001 dB)
      g[i] = v; prev = v; if (v < minG) minG = v;
    }
    const out = channels.map(x => { const y = new Float32Array(len); for (let i = 0; i < len; i++) y[i] = g[i] === 1 ? x[i] : x[i] * g[i]; return y; });
    return { channels: out, maxReductionDb: minG >= 1 ? 0 : -toDb(minG) };
  }

  /* ---------- Loudness mastering ---------- */
  const PRESETS = {
    off: null,
    streaming: { label: 'Streaming', targetLufs: -14, ceilingDb: -1 },
    podcast: { label: 'Podcast', targetLufs: -16, ceilingDb: -1 },
    loud: { label: 'Loud', targetLufs: -11, ceilingDb: -1 }
  };
  const scale = (channels, db) => { const k = fromDb(db); return channels.map(x => { const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = x[i] * k; return y; }); };

  /** Gain to the target loudness, then limit to the true-peak ceiling; iterate to compensate limiter loss. */
  function masterToTarget(channels, rate, o) {
    const targetLufs = o.targetLufs, ceilingDb = o.ceilingDb != null ? o.ceilingDb : -1, maxBoost = o.maxBoostDb != null ? o.maxBoostDb : 24;
    const before = analyze(channels, rate);
    if (!isFinite(before.lufs)) return { channels, applied: false, reason: 'silent', before, after: before, gainDb: 0, maxReductionDb: 0 };
    let gainDb = Math.max(-40, Math.min(maxBoost, targetLufs - before.lufs)), best = null;
    for (let i = 0; i < 4; i++) {
      const lim = limit(scale(channels, gainDb), rate, { ceilingDb });
      const after = analyze(lim.channels, rate);
      best = { channels: lim.channels, applied: true, before, after, gainDb, maxReductionDb: lim.maxReductionDb };
      const err = targetLufs - after.lufs;
      if (Math.abs(err) <= 0.3 || gainDb >= maxBoost - 1e-6 || err < 0) break;
      gainDb = Math.min(maxBoost, gainDb + err);
    }
    return best;
  }

  /* ---------- 16-bit quantisation with TPDF dither ---------- */
  function makeRng(seed) { let s = (seed >>> 0) || 0x9e3779b9; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
  function quantize16(x, rng) {
    let v = x < 0 ? x * 32768 : x * 32767;
    if (rng) v += rng() - rng();                           // triangular PDF, +/-1 LSB
    v = Math.round(v);
    return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }

  /* ---------- Take (recording) level check ---------- */
  function analyzeLevels(x) {
    let peak = 0, sq = 0, clip = 0;
    for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; sq += x[i] * x[i]; if (a >= 0.999) clip++; }
    return { peakDb: toDb(peak), rmsDb: toDb(Math.sqrt(sq / Math.max(1, x.length))), clipCount: clip };
  }
  function takeAdvice(l) {
    if (!l || !isFinite(l.peakDb)) return { level: 'silent', text: 'No sound was captured. Check the microphone.' };
    if (l.clipCount >= 3 || l.peakDb >= -0.5) return { level: 'clipping', text: 'Recording is clipping: move back from the mic or lower the input level, then re-record.' };
    if (l.peakDb < -24) return { level: 'quiet', text: 'Recording is very quiet: move closer to the mic or raise the input level.' };
    return { level: 'good', text: null };
  }

  /* ---------- Timing: FFT cross-correlation, calibration chirp, round-trip latency estimation ---------- */
  function fft(re, im, inverse) {                          // in-place iterative radix-2
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = 2 * Math.PI / len * (inverse ? -1 : 1), wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k], xr = re[i + k + len / 2], xi = im[i + k + len / 2], vr = xr * cr - xi * ci, vi = xr * ci + xi * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
  /** r[k] = sum_n sig[n + k] * ref[n] for k in [0, sig.length): how well `ref` matches `sig` starting at sample k. */
  function correlate(sig, ref) {
    let n = 1; while (n < sig.length + ref.length) n <<= 1;
    const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
    ar.set(sig); br.set(ref); fft(ar, ai, false); fft(br, bi, false);
    for (let i = 0; i < n; i++) { const r = ar[i] * br[i] + ai[i] * bi[i], m = ai[i] * br[i] - ar[i] * bi[i]; ar[i] = r; ai[i] = m; }   // A * conj(B)
    fft(ar, ai, true);
    return ar.subarray(0, sig.length);
  }
  function parabolic(y, i) {                               // sub-sample peak position
    if (i <= 0 || i >= y.length - 1) return i;
    const a = y[i - 1], b = y[i], c = y[i + 1], d = a - 2 * b + c;
    return d === 0 ? i : i + 0.5 * (a - c) / d;
  }
  /** Delay of `sig` relative to `ref` in milliseconds (positive: sig lags), searched within +/-maxMs. score is a 0..1 match quality. */
  function delayBetween(ref, sig, rate, maxMs) {
    const maxL = Math.round(maxMs * rate / 1000), n = Math.max(ref.length, sig.length) + maxL;
    const pad = (x, front) => { const o = new Float32Array(n + maxL); o.set(x, front); return o; };
    const r = correlate(pad(sig, maxL), ref.length ? pad(ref, 0).subarray(0, ref.length + maxL) : ref);
    let best = -Infinity, bi = 0;
    for (let k = 0; k <= 2 * maxL; k++) if (r[k] > best) { best = r[k]; bi = k; }
    let ea = 0, eb = 0; for (let i = 0; i < ref.length; i++) ea += ref[i] * ref[i]; for (let i = 0; i < sig.length; i++) eb += sig[i] * sig[i];
    return { ms: (parabolic(r, bi) - maxL) * 1000 / rate, score: best / Math.sqrt((ea * eb) || 1) };
  }
  /** Hann-windowed linear chirp: broadband, so its correlation peak is sharp and survives room noise and speaker colouring. */
  function makeChirp(rate, durMs, f0, f1) {
    const n = Math.round((durMs || 30) * rate / 1000), x = new Float32Array(n), a = f0 || 1500, b = f1 || 6500, T = n / rate;
    for (let i = 0; i < n; i++) { const t = i / rate, ph = 2 * Math.PI * (a * t + (b - a) * t * t / (2 * T)); x[i] = Math.sin(ph) * 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1))); }
    return x;
  }
  /**
   * Round-trip latency from a recording that contains chirps played at known times (seconds after the recording started).
   * Returns { ok, latencyMs, spreadMs, found, total, reason }. Spread is the median absolute deviation across detections.
   */
  function estimateLatency(recorded, rate, expectedSecs, o) {
    o = o || {};
    const tpl = o.template || makeChirp(rate), maxMs = o.maxLatencyMs || 600, preMs = o.preMs != null ? o.preMs : 40;
    const r = correlate(recorded, tpl);
    let ref = 0; for (let i = 0; i < tpl.length; i++) ref += tpl[i] * tpl[i];
    // background level of the correlation: median absolute value
    const stride = Math.max(1, Math.floor(r.length / 20000)), samp = []; for (let i = 0; i < r.length; i += stride) samp.push(Math.abs(r[i]));
    samp.sort((a, b) => a - b); const floor = samp[Math.floor(samp.length / 2)] || 1e-9;
    const delays = [], order = expectedSecs.slice().sort((a, b) => a - b);
    for (let q = 0; q < order.length; q++) {
      const e = order[q];
      // The window must end before the NEXT click could possibly arrive (latency >= 0), otherwise two clicks are ambiguous.
      const end = q + 1 < order.length ? Math.min(e + maxMs / 1000, order[q + 1] - 0.02) : e + maxMs / 1000;
      const lo = Math.max(0, Math.round((e - preMs / 1000) * rate)), hi = Math.min(r.length - 1, Math.round(end * rate));
      if (hi <= lo) continue;
      let best = -Infinity, bi = lo;
      for (let k = lo; k <= hi; k++) if (r[k] > best) { best = r[k]; bi = k; }
      const snr = best / (floor * 8);                       // peak vs typical correlation level
      let en = 0; for (let k = bi; k < Math.min(recorded.length, bi + tpl.length); k++) en += recorded[k] * recorded[k];
      const nc = best / Math.sqrt((ref * en) || 1);        // normalised match, 1 = identical shape
      if (nc >= (o.minMatch || 0.25) && snr >= 3) delays.push((parabolic(r, bi) / rate - e) * 1000);
    }
    const total = order.length, found = delays.length;
    if (found < Math.max(3, Math.ceil(total * 0.6))) return { ok: false, found, total, reason: found === 0 ? 'silent' : 'unclear' };
    const sorted = delays.slice().sort((a, b) => a - b), med = sorted[Math.floor(sorted.length / 2)];
    const mad = sorted.map(d => Math.abs(d - med)).sort((a, b) => a - b)[Math.floor(sorted.length / 2)];
    const keep = delays.filter(d => Math.abs(d - med) <= Math.max(4, 4 * mad));
    const mean = keep.reduce((a, b) => a + b, 0) / keep.length;
    const spread = Math.max.apply(null, keep) - Math.min.apply(null, keep);
    return { ok: spread <= (o.maxSpreadMs || 12), latencyMs: mean, spreadMs: spread, found: keep.length, total, reason: spread <= (o.maxSpreadMs || 12) ? null : 'inconsistent' };
  }

  return { fft, correlate, delayBetween, makeChirp, estimateLatency, toDb, fromDb, kWeighting, integratedLoudness, truePeak, samplePeak, peakEnvelope, analyze, limit, masterToTarget, PRESETS, makeRng, quantize16, analyzeLevels, takeAdvice };
});
