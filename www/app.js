(()=>{
/* ── Phase C: Cloud layer (loaded from js/cloud.js) ── */
const Cloud = window.TapeheadCloud || (function () {
  console.error('[Tapehead] TapeheadCloud module missing — cloud features unavailable');
  return {
    sb: null, mode: 'local', init() { this.mode = 'local'; return false; },
    isCloud() { return false; }, requiresCloud() { return false; },
    async currentAuthUser() { return null; }, async ensureSession() { return null; },
    async signUp() { return { error: 'Cloud module missing' }; },
    async signIn() { return { error: 'Cloud module missing' }; },
    async signOut() {}, async ensureProfile() { return null; },
    async getProfile() { return null; }, async updateProfile() { return null; },
    async toggleFollow() { return { following: false }; }, async isFollowing() { return false; },
    async getFollowStats() { return { followers: 0, following: 0 }; },
    async sendMessage() { return null; }, async fetchMessages() { return []; },
    async markMessagesRead() {}, async fetchFeed() { return null; },
    async publishPost() { return null; }, async deletePost() {},
    async toggleLike() {}, async addComment() {},
    subscribeSocial() { return () => {}; }, subscribeRoom() { return () => {}; },
    unsubscribeRoom() {}, createRoom() { return null; }, joinRoom() { return null; },
    leaveRoom() {}, updateRoom() {}, uploadVocal() { return null; }
  };
})();

/* ── Shared state (loaded from js/state.js) ── */
const $ = window.$ || (id => document.getElementById(id));
const on = window.on || ((id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); });
const makeStableId = window.makeStableId || ((prefix = 'id_') => { try { if (crypto && crypto.randomUUID) return prefix + crypto.randomUUID(); } catch (e) {} return prefix + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9); });
const state = window.state || {};
const scheduleSave = window.scheduleSave || function () {};
if (!window.state) window.state = state;


function updateContinuityBadge() {
  try {
    const C = window.TapeheadContinuity;
    const el = document.getElementById('continuityBadge');
    const pc = document.getElementById('pcContinuity');
    let snap = state._continuity;
    if (!snap && C && C.snapshot) {
      const opts = typeof getAiOptions === 'function' ? getAiOptions() : {};
      snap = C.snapshot(state, {
        key: opts.key || (document.getElementById('songKey')||{}).value,
        mood: opts.mood || (document.getElementById('songMood')||{}).value,
        style: opts.style || (document.getElementById('aiStyle')||{}).value,
        language: opts.language || (document.getElementById('aiLanguage')||{}).value,
        hook: (document.getElementById('songHook')||{}).value,
        bpm: state.bpm
      });
      state._continuity = snap;
    }
    if (!snap) {
      if (el) el.textContent = 'Continuity · —';
      if (pc) pc.textContent = '';
      return;
    }
    const parts = [];
    if (snap.key) parts.push(snap.key);
    if (snap.bpm) parts.push(snap.bpm + ' BPM');
    if (snap.style) parts.push(snap.style);
    const line = parts.length ? ('Locked · ' + parts.join(' · ')) : 'Continuity on';
    if (el) el.textContent = line;
    if (pc) pc.textContent = parts.length ? parts.join(' · ') : '';
  } catch (e) { console.warn('[Tapehead] continuity badge', e); }
}

function updateProjectContext(justSaved){
  try{updateContinuityBadge()}catch(e){}
  const pc=document.getElementById('pcSaveStatus');
  const playBtn=document.getElementById('pcPlayBtn');
  if(pc){
    const onCloud=!!(state.user&&state.user.cloudId);
    if(justSaved){
      pc.textContent='Saved';
      pc.classList.remove('dirty');
      pc.classList.toggle('cloud', onCloud);
      const dot=document.getElementById('saveDot');if(dot)dot.classList.add('on');
    } else if(pc.classList.contains('dirty')){
      pc.textContent='Unsaved';
    } else {
      pc.textContent='Saved';
      pc.classList.toggle('cloud', onCloud);
    }
  }
  if(playBtn){
    playBtn.textContent=state.playing?'■':'▶';
    playBtn.classList.toggle('on',!!state.playing);
  }
  const bpm=document.getElementById('bpmBadge');
  if(bpm&&state.bpm) bpm.textContent=(state.bpm||120)+' BPM';
  const beatBpm=document.getElementById('beatBpmValue');
  if(beatBpm&&state.bpm) beatBpm.textContent=String(state.bpm);
}
let audioCtx=null,nextNoteTime=0,timerID=null;const scheduleAhead=.15,lookahead=25;

function unlockAudio(){
  try{
    ensureAudio();
    if(audioCtx && audioCtx.state==='suspended') audioCtx.resume();
  }catch(e){}
  ['pointerdown','touchstart','keydown'].forEach(ev=>
    window.removeEventListener(ev, unlockAudio, true));
}
['pointerdown','touchstart','keydown'].forEach(ev=>
  window.addEventListener(ev, unlockAudio, {capture:true,once:false}));

function ensureAudio(){
    if(!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)();
    if(audioCtx.state==='suspended') audioCtx.resume();
    return audioCtx;
  }
  window.unlockAudio = unlockAudio;
  window.ensureAudio = ensureAudio;
/** Live multi-bus: tracks → pan → master → 3-band EQ → compressor → out */
function eqGainFromSlider(v){
  // 0..100 slider → -12..+12 dB (50 = flat)
  const n = Number(v);
  if (isNaN(n)) return 0;
  return ((Math.max(0, Math.min(100, n)) - 50) / 50) * 12;
}
function ensureLiveGraph(){
  const c = ensureAudio();
  // Do not call syncLiveGraphLevels() here: syncLiveGraphLevels() itself
  // calls ensureLiveGraph(), which previously created a recursive call chain
  // whenever the live graph already existed.
  if (state._liveGraph && state._liveGraph.ctx === c) {
    return state._liveGraph;
  }
  state.eq = state.eq || { low:50, mid:50, high:50 };
  state.glue = state.glue != null ? state.glue : 40;

  const master = c.createGain();
  master.gain.value = state.volumes?.master != null ? state.volumes.master : 0.85;

  const low = c.createBiquadFilter();
  low.type = 'lowshelf';
  low.frequency.value = 180;
  low.gain.value = eqGainFromSlider(state.eq.low);

  const mid = c.createBiquadFilter();
  mid.type = 'peaking';
  mid.frequency.value = 1000;
  mid.Q.value = 0.9;
  mid.gain.value = eqGainFromSlider(state.eq.mid);

  const high = c.createBiquadFilter();
  high.type = 'highshelf';
  high.frequency.value = 4200;
  high.gain.value = eqGainFromSlider(state.eq.high);

  const comp = c.createDynamicsCompressor();
  // Glue amount 0..100 maps threshold/ratio
  const glue = Math.max(0, Math.min(100, state.glue != null ? state.glue : 40)) / 100;
  comp.threshold.value = -8 - glue * 16; // -8 .. -24
  comp.knee.value = 6 + glue * 10;
  comp.ratio.value = 1.5 + glue * 4.5; // 1.5 .. 6
  comp.attack.value = 0.022;   // let drum transients through
  comp.release.value = 0.18 + glue * 0.15;

  const analyser = c.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.8;

  const _hp = thMakeHP(c), _lim = thMakeLimiter(c), _tn = thMakeTone(c), _mk = c.createGain();
  _mk.gain.value = 1.0;
  master.connect(_hp);
  _hp.connect(_tn[0]); _tn[0].connect(_tn[1]); _tn[1].connect(low);
  low.connect(mid);
  mid.connect(high);
  high.connect(comp);
  comp.connect(_mk); _mk.connect(_lim);
  _lim.connect(analyser);
  analyser.connect(c.destination);

  const tracks = {};
  ['kick','snare','hat','clap','chords','vocal','click'].forEach(id => {
    const gain = c.createGain();
    gain.gain.value = 1;
    let panNode = null;
    try {
      panNode = c.createStereoPanner();
      panNode.pan.value = (state.pan && state.pan[id] != null) ? state.pan[id] : 0;
      gain.connect(panNode);
      panNode.connect(master);
    } catch (e) {
      gain.connect(master);
    }
    let meter = null;
    try {
      meter = c.createAnalyser(); meter.fftSize = 1024; meter.smoothingTimeConstant = 0;
      (panNode || gain).connect(meter);
      const sink = c.createGain(); sink.gain.value = 0; meter.connect(sink); sink.connect(c.destination);   // silent sink: some browsers only process analysers that reach the destination
    } catch (e) { meter = null; }
    tracks[id] = { gain, pan: panNode, meter };
  });
  state._liveGraph = { ctx: c, master, tracks, eq: { low, mid, high }, comp, analyser };
  return state._liveGraph;
}
function liveDest(track){
  const g = ensureLiveGraph();
  return (g.tracks[track] && g.tracks[track].gain) || g.master;
}
function syncLiveGraphLevels(){
  try {
    const g = ensureLiveGraph();
    g.master.gain.value = state.volumes?.master != null ? state.volumes.master : 0.85;
    state.eq = state.eq || { low:50, mid:50, high:50 };
    if (g.eq) {
      g.eq.low.gain.setValueAtTime(eqGainFromSlider(state.eq.low), g.ctx.currentTime);
      g.eq.mid.gain.setValueAtTime(eqGainFromSlider(state.eq.mid), g.ctx.currentTime);
      g.eq.high.gain.setValueAtTime(eqGainFromSlider(state.eq.high), g.ctx.currentTime);
    }
    if (g.comp) {
      const glue = Math.max(0, Math.min(100, state.glue != null ? state.glue : 40)) / 100;
      g.comp.threshold.setValueAtTime(-8 - glue * 16, g.ctx.currentTime);
      g.comp.knee.setValueAtTime(6 + glue * 10, g.ctx.currentTime);
      g.comp.ratio.setValueAtTime(1.5 + glue * 4.5, g.ctx.currentTime);
    }
    Object.keys(g.tracks).forEach(id => {
      const t = g.tracks[id];
      if (t.pan && state.pan && state.pan[id] != null) {
        try { t.pan.pan.setValueAtTime(Math.max(-1, Math.min(1, state.pan[id])), g.ctx.currentTime); } catch(e){}
      }
    });
    // simple clip indicator from compressor reduction
    try {
      const warn = document.getElementById('clipWarn');
      if (warn && g.comp) {
        const red = g.comp.reduction || 0;
        warn.textContent = red < -1 ? ('Comp −' + Math.abs(red).toFixed(1) + ' dB') : '';
      }
    } catch (e) {}
  } catch (e) {}
}

let _meterRAF = null;
const _meterState = {};                     // id -> { db, hold, holdAt, clipAt }
const _meterBuf = new Float32Array(1024);
const METER_FLOOR = -60;
function meterPeakDb(an) {
  if (!an) return METER_FLOOR;
  if (an.fftSize !== _meterBuf.length) an.fftSize = _meterBuf.length;
  an.getFloatTimeDomainData(_meterBuf);
  let pk = 0;
  for (let i = 0; i < _meterBuf.length; i++) { const v = Math.abs(_meterBuf[i]); if (v > pk) pk = v; }
  return pk > 0 ? Math.max(METER_FLOOR, 20 * Math.log10(pk)) : METER_FLOOR;
}
/** Instant attack, ~50 dB/s release, 1.5 s peak hold, and a clip latch (peak >= -1 dBFS) that stays lit for 1.5 s. */
function meterStep(id, rawDb, now) {
  const m = _meterState[id] || (_meterState[id] = { db: METER_FLOOR, hold: METER_FLOOR, holdAt: 0, clipAt: 0 });
  m.db = rawDb >= m.db ? rawDb : Math.max(rawDb, m.db - 0.85);
  if (rawDb >= m.hold || now - m.holdAt > 1500) { m.hold = Math.max(rawDb, now - m.holdAt > 1500 ? m.db : m.hold); m.holdAt = now; }
  if (rawDb >= -1) m.clipAt = now;
  return m;
}
function paintMeter(el, m, now) {
  const pct = Math.max(0, Math.min(100, (m.db - METER_FLOOR) / -METER_FLOOR * 100));
  const fill = el.firstElementChild, hold = el.lastElementChild;
  if (fill) fill.style.width = (100 - pct).toFixed(1) + '%';       // the fill is a dark cover revealing a fixed green-to-red scale
  if (hold) hold.style.left = Math.max(0, Math.min(100, (m.hold - METER_FLOOR) / -METER_FLOOR * 100)).toFixed(1) + '%';
  el.classList.toggle('clip', now - m.clipAt < 1500);
  el.dataset.db = m.db.toFixed(1);
  el.setAttribute('aria-valuenow', m.db.toFixed(0));
}
function startMasterMeter(){
  if (_meterRAF) return;
  let idleSince = 0;
  const tick = () => {
    _meterRAF = requestAnimationFrame(tick);
    try {
      if (document.hidden) return;                                   // nothing visible: do no work
      const g = state._liveGraph, now = performance.now();
      if (!g) return;
      const view = document.getElementById('view-mix');
      const visible = view && !view.hidden;
      let busy = !!state.playing;
      if (visible) {
        const fill = document.getElementById('masterMeter');
        if (fill && g.analyser) {
          const m = meterStep('master', meterPeakDb(g.analyser), now);
          const wrap = fill.parentElement;
          const pct = Math.max(0, Math.min(100, (m.db - METER_FLOOR) / -METER_FLOOR * 100));
          fill.style.width = pct.toFixed(1) + '%';
          fill.style.background = m.db > -1 ? '#f87171' : m.db > -6 ? 'var(--brass)' : '#4ade80';
          if (wrap) { wrap.setAttribute('role', 'meter'); wrap.setAttribute('aria-label', 'Master level'); wrap.dataset.db = m.db.toFixed(1); wrap.classList.toggle('clip', now - m.clipAt < 1500); }
          const rd = document.getElementById('masterDb'); if (rd) rd.textContent = m.db <= METER_FLOOR + 0.1 ? '-∞ dB' : m.db.toFixed(1) + ' dB';
          if (m.db > METER_FLOOR + 1) busy = true;
          const warn = document.getElementById('clipWarn');
          if (warn) {
            const comp = g.comp || g.compressor, red = (comp && comp.reduction) || 0;
            if (now - m.clipAt < 1500 || document.querySelector('#channelStrip .ch-meter.clip')) warn.textContent = 'Peak clip risk';   // master at its ceiling, or any channel clipping
            else if (red < -1) warn.textContent = 'Comp −' + Math.abs(red).toFixed(1) + ' dB';
            else if (!warn.textContent || warn.textContent.indexOf('Comp') === 0 || warn.textContent.indexOf('Peak') === 0) warn.textContent = '';
          }
        }
        document.querySelectorAll('#channelStrip .ch-meter').forEach(el => {
          const t = g.tracks[el.dataset.meter];
          const m = meterStep(el.dataset.meter, t && t.meter ? meterPeakDb(t.meter) : METER_FLOOR, now);
          paintMeter(el, m, now);
          if (m.db > METER_FLOOR + 1) busy = true;
        });
      }
      if (busy) idleSince = 0;
      else if (!idleSince) idleSince = now;
      else if (now - idleSince > 1800) { cancelAnimationFrame(_meterRAF); _meterRAF = null; }   // silent and idle: stop redrawing until playback restarts
    } catch (e) {}
  };
  _meterRAF = requestAnimationFrame(tick);
}
function stopMasterMeter(){
  if (_meterRAF) { cancelAnimationFrame(_meterRAF); _meterRAF = null; }
}

function applyEqFromUI(){
  state.eq = {
    low: Number(document.getElementById('eqLow')?.value ?? 50),
    mid: Number(document.getElementById('eqMid')?.value ?? 50),
    high: Number(document.getElementById('eqHigh')?.value ?? 50)
  };
  state.glue = Number(document.getElementById('glueSlider')?.value ?? state.glue ?? 40);
  try { syncLiveGraphLevels(); } catch (e) {}
  try { scheduleSave(); } catch (e) {}
}
function setEqUIFromState(){
  state.eq = state.eq || { low:50, mid:50, high:50 };
  const l = document.getElementById('eqLow');
  const m = document.getElementById('eqMid');
  const h = document.getElementById('eqHigh');
  const g = document.getElementById('glueSlider');
  if (l) l.value = state.eq.low;
  if (m) m.value = state.eq.mid;
  if (h) h.value = state.eq.high;
  if (g) g.value = state.glue != null ? state.glue : 40;
  const gv = document.getElementById('glueVal');
  if (gv) gv.textContent = (state.glue != null ? state.glue : 40) + '%';
}
function channelAudible(ch){
  if(!state.mute) state.mute={};
  if(!state.solo) state.solo={};
  if(state.mute[ch]) return false;
  const anySolo=Object.values(state.solo).some(Boolean);
  if(anySolo && !state.solo[ch]) return false;
  return true;
}
function playSampleBuffer(buf,t,gainVal,durCap,dest){
  if(!buf)return false;
  try{
    const c=ensureAudio();
    const src=c.createBufferSource();
    src.buffer=buf;
    const g=c.createGain();
    const _d=Math.min(durCap||buf.duration,buf.duration||0.3);
    const attack=Math.min(0.002,Math.max(0.0005,_d*0.02));
    const release=Math.min(0.018,Math.max(0.006,_d*0.08));
    const peak=Math.max(0.0001,Math.min(1.5,Number(gainVal)||0));
    g.gain.setValueAtTime(0.0001,t);
    g.gain.linearRampToValueAtTime(peak,t+attack);
    g.gain.setValueAtTime(peak,t+Math.max(attack,_d-release));
    g.gain.linearRampToValueAtTime(0.0001,t+_d);
    src.connect(g);g.connect(dest||liveDest('kick'));
    src.start(t);
    src.stop(t+_d+0.02);
    return true;
  }catch(e){return false;}
}
window.playSampleBuffer = playSampleBuffer;

/* ===== Shared drum engine: live playback and bounce use the SAME voices ===== */
const TH_LEVEL={kick:.95,snare:.8,hat:.55,clap:.62};   // hats/snare were ~18 dB under the kick and got buried
const TH_NOISE=new WeakMap();
function thNoise(ctx){
  let b=TH_NOISE.get(ctx); if(b)return b;
  const len=Math.floor(ctx.sampleRate*0.5); b=ctx.createBuffer(1,len,ctx.sampleRate);
  const d=b.getChannelData(0); let x=0x9E3779B9>>>0;           // seeded: identical on every hit and every render
  for(let i=0;i<len;i++){x^=x<<13;x>>>=0;x^=x>>>17;x^=x<<5;x>>>=0;d[i]=x/2147483648-1;}
  TH_NOISE.set(ctx,b); return b;
}
function thMakeLimiter(ctx){const l=ctx.createDynamicsCompressor();l.threshold.value=-2;l.knee.value=0;l.ratio.value=20;l.attack.value=0.002;l.release.value=0.08;return l;}
function thMakeTone(ctx){                       // clarity tilt: trim low-mid mud, add presence
  var m=ctx.createBiquadFilter();m.type='peaking';m.frequency.value=280;m.Q.value=0.9;m.gain.value=-2.5;
  var p=ctx.createBiquadFilter();p.type='peaking';p.frequency.value=3800;p.Q.value=0.8;p.gain.value=2.2;
  return [m,p];
}
function thMakeHP(ctx){const f=ctx.createBiquadFilter();f.type='highpass';f.frequency.value=28;f.Q.value=0.7;return f;}
function thNoiseHit(ctx,t,dest,type,freq,q,peak,decay,offs){
  const n=ctx.createBufferSource();n.buffer=thNoise(ctx);
  const f=ctx.createBiquadFilter();f.type=type;f.frequency.value=freq;if(q)f.Q.value=q;
  const g=ctx.createGain();
  (offs||[0]).forEach(function(o,i){const tt=t+o;g.gain.setValueAtTime(0.0001,tt);g.gain.linearRampToValueAtTime(peak,tt+0.002);g.gain.exponentialRampToValueAtTime(0.001,tt+decay);});
  n.connect(f);f.connect(g);g.connect(dest);n.start(t);n.stop(t+(offs?offs[offs.length-1]:0)+decay+0.02);
}
function thDrumVoice(ctx,kind,t,gain,dest){
  gain=Math.max(0.0001,gain);
  if(kind==='kick'){
    const o=ctx.createOscillator(),g=ctx.createGain();
    o.type='sine';o.frequency.setValueAtTime(165,t);o.frequency.exponentialRampToValueAtTime(48,t+0.1);
    g.gain.setValueAtTime(0.0001,t);g.gain.linearRampToValueAtTime(gain,t+0.003);g.gain.exponentialRampToValueAtTime(0.001,t+0.34);
    o.connect(g);g.connect(dest);o.start(t);o.stop(t+0.36);
    thNoiseHit(ctx,t,dest,'highpass',2200,0,gain*0.22,0.012);          // beater click for clarity
  }else if(kind==='snare'){
    thNoiseHit(ctx,t,dest,'bandpass',2400,0.7,gain,0.17);
    const o=ctx.createOscillator(),g=ctx.createGain();
    o.type='triangle';o.frequency.setValueAtTime(200,t);o.frequency.exponentialRampToValueAtTime(150,t+0.07);
    g.gain.setValueAtTime(0.0001,t);g.gain.linearRampToValueAtTime(gain*0.55,t+0.002);g.gain.exponentialRampToValueAtTime(0.001,t+0.1);
    o.connect(g);g.connect(dest);o.start(t);o.stop(t+0.12);
  }else if(kind==='hat'){
    thNoiseHit(ctx,t,dest,'highpass',7500,0,gain,0.05);
  }else if(kind==='clap'){
    thNoiseHit(ctx,t,dest,'bandpass',1500,1,gain,0.05,[0,0.012,0.025]);
    thNoiseHit(ctx,t+0.03,dest,'bandpass',1400,1,gain*0.6,0.12);
  }
}
function playKick(t,v=1){
  const dest=liveDest('kick');const gain=v*drumVol('kick')*TH_LEVEL.kick;if(gain<=0)return;
  if(state.samples&&state.samples.kick&&playSampleBuffer(state.samples.kick,t,gain,0.5,dest))return;
  thDrumVoice(ensureAudio(),'kick',t,gain,dest);
}
function playSnare(t,v=1){
  const dest=liveDest('snare');const gain=v*drumVol('snare')*TH_LEVEL.snare;if(gain<=0)return;
  if(state.samples&&state.samples.snare&&playSampleBuffer(state.samples.snare,t,gain,0.4,dest))return;
  thDrumVoice(ensureAudio(),'snare',t,gain,dest);
}
function playHat(t,v=1){
  const dest=liveDest('hat');const gain=v*drumVol('hat')*TH_LEVEL.hat;if(gain<=0)return;
  if(state.samples&&state.samples.hat&&playSampleBuffer(state.samples.hat,t,gain,0.2,dest))return;
  thDrumVoice(ensureAudio(),'hat',t,gain,dest);
}
function playClap(t,v=1){
  const dest=liveDest('clap');const gain=v*drumVol('clap')*TH_LEVEL.clap;if(gain<=0)return;
  if(state.samples&&state.samples.clap&&playSampleBuffer(state.samples.clap,t,gain,0.35,dest))return;
  thDrumVoice(ensureAudio(),'clap',t,gain,dest);
}
async function loadDrumSample(slot,file){
  if(!file)return;
  if(file.size>3e6){toast('Sample max 3MB');return;}
  try{
    unlockAudio();
    const ctx=ensureAudio();
    const arr=await file.arrayBuffer();
    const decoded=await ctx.decodeAudioData(arr.slice(0));
    const channels=Math.min(2,decoded.numberOfChannels||1);
    const peakTarget=0.86;
    let peak=0;
    for(let ch=0;ch<channels;ch++){
      const data=decoded.getChannelData(ch);
      for(let i=0;i<data.length;i++){const a=Math.abs(data[i]);if(a>peak)peak=a;}
    }
    let buf=decoded;
    if(peak>0.0001){
      const norm=Math.min(4,peakTarget/peak);
      if(Math.abs(norm-1)>0.015){
        const nb=ctx.createBuffer(decoded.numberOfChannels,decoded.length,decoded.sampleRate);
        for(let ch=0;ch<decoded.numberOfChannels;ch++){
          const src=decoded.getChannelData(ch), dst=nb.getChannelData(ch);
          for(let i=0;i<src.length;i++)dst[i]=Math.max(-1,Math.min(1,src[i]*norm));
        }
        buf=nb;
      }
    }
    state.samples=state.samples||{};
    state.samples[slot]=buf;
    state.sampleNames=state.sampleNames||{};
    state.sampleNames[slot]=file.name.replace(/\.[^.]+$/,'');
    const lab=document.getElementById('sampleLabel'+slot.charAt(0).toUpperCase()+slot.slice(1));
    if(lab)lab.textContent=state.sampleNames[slot].slice(0,18);
    document.querySelector('.sample-slot[data-slot="'+slot+'"]')?.classList.add('has-sample');
    toast(slot+' sample loaded');
    try{saveCurrentSong()}catch(e){}
  }catch(e){console.warn(e);toast('Could not decode sample');}
}
function clearDrumSamples(){
  state.samples={};
  state.sampleNames={};
  ['kick','snare','hat','clap'].forEach(slot=>{
    const lab=document.getElementById('sampleLabel'+slot.charAt(0).toUpperCase()+slot.slice(1));
    if(lab)lab.textContent='Synth';
    document.querySelector('.sample-slot[data-slot="'+slot+'"]')?.classList.remove('has-sample');
  });
  toast('Custom samples cleared');
  try{saveCurrentSong()}catch(e){}
}
function scheduleOfflineSample(offline,buf,t,v,cap){
  if(!buf)return false;
  try{
    const src=offline.createBufferSource();
    src.buffer=buf;
    const g=offline.createGain();
    const dur=Math.min(cap||buf.duration,buf.duration||0.3);
    g.gain.setValueAtTime(v,t);
    g.gain.exponentialRampToValueAtTime(0.001,t+dur);
    src.connect(g);g.connect(offline.destination);
    src.start(t);src.stop(t+dur+0.02);
    return true;
  }catch(e){return false;}
}
const NOTE_FREQ={C:261.63,'C#':277.18,D:293.66,'D#':311.13,E:329.63,F:349.23,'F#':369.99,G:392,'G#':415.3,A:440,'A#':466.16,B:493.88};
function playNote(note,oct=state.octave,dur=.35){try{const c=ensureAudio(),freq=(NOTE_FREQ[note]||261.63)*Math.pow(2,oct-4),o=c.createOscillator(),g=c.createGain();o.type='triangle';o.frequency.value=freq;const vol=.22*(state.softPad?0.6:1)*drumVol('chords');if(vol<=0)return;g.gain.setValueAtTime(vol,c.currentTime);g.gain.exponentialRampToValueAtTime(.001,c.currentTime+dur);o.connect(g);g.connect(liveDest('chords'));o.start();o.stop(c.currentTime+dur+.02)}catch(e){}}
function keyOscType(){return ({piano:'triangle',electric:'sine',organ:'square',synth:'sawtooth',pad:'triangle'})[state.keysSound||'piano']||'triangle'}
function startKeyNote(note,oct=state.octave,vel){try{const c=ensureAudio();if(c.state==='suspended')c.resume();const key=note+oct;releaseKeyNote(key);const freq=(NOTE_FREQ[note]||261.63)*Math.pow(2,oct-4),o=c.createOscillator(),g=c.createGain();o.type=keyOscType();o.frequency.value=freq;const v=Math.max(.1,Math.min(1,vel!=null&&isFinite(vel)?Number(vel):(Number(state.keysVelocity)||.85)));const base=.2*v*drumVol('chords');g.gain.setValueAtTime(.0001,c.currentTime);g.gain.exponentialRampToValueAtTime(Math.max(.001,base),c.currentTime+.012);if(state.keysSound==='pad')g.gain.setTargetAtTime(base*.72,c.currentTime+.02,.12);o.connect(g);g.connect(liveDest('chords'));o.start();state._keyVoices[key]={o,g};if(state.keysRecording){if(!state._keyStartedAt)state._keyStartedAt=performance.now();state.keysTake.push({note,octave:oct,t:Math.round(performance.now()-state._keyStartedAt),velocity:v});} }catch(e){}}
function releaseKeyNote(key){const voice=state._keyVoices&&state._keyVoices[key];if(!voice)return;try{const c=audioCtx,when=c.currentTime;voice.g.gain.cancelScheduledValues(when);voice.g.gain.setTargetAtTime(.0001,when,.045);voice.o.stop(when+.22)}catch(e){}delete state._keyVoices[key]}
function releaseAllKeys(){Object.keys(state._keyVoices||{}).forEach(releaseKeyNote)}
/* ── MIDI keyboard input (Web MIDI: Chrome/Edge on desktop and Android; not available in iOS Safari) ──
   Notes keep their absolute pitch (independent of the on-screen octave) and their velocity. The sustain pedal (CC64)
   holds released notes until it is lifted; notes still physically held are not cut off. */
const keysMidi = { access: null, held: new Set(), sustained: new Set(), pedal: false };
function midiNoteKey(n) { const i = TapeheadMidi.noteInfo(n); return i.note + i.octave; }
function midiLight(n, on) {
  const i = TapeheadMidi.noteInfo(n); if (i.octave !== state.octave) return;
  const el = document.querySelector('#piano .pkey[data-note="' + i.note + '"]'); if (el) el.classList.toggle('on', on);
}
function midiMessage(ev) {
  try {
    const m = window.TapeheadMidi && TapeheadMidi.parse(ev && ev.data); if (!m) return;
    if (m.type === 'on') {
      const i = TapeheadMidi.noteInfo(m.note);
      keysMidi.held.add(m.note); keysMidi.sustained.delete(m.note);
      startKeyNote(i.note, i.octave, m.velocity); midiLight(m.note, true);
    } else if (m.type === 'off') {
      keysMidi.held.delete(m.note); midiLight(m.note, false);
      if (state.keysSustain || keysMidi.pedal) keysMidi.sustained.add(m.note); else releaseKeyNote(midiNoteKey(m.note));
    } else if (m.type === 'pedal') {
      keysMidi.pedal = m.down;
      if (!m.down) { keysMidi.sustained.forEach(n => { if (!keysMidi.held.has(n)) releaseKeyNote(midiNoteKey(n)); }); keysMidi.sustained.clear(); }
    } else if (m.type === 'panic') { releaseKeysPanic(); }
  } catch (e) { console.warn('[Tapehead] midi message', e); }
}
function setMidiStatus(text, kind) {
  const el = document.getElementById('midiStatus'); if (el) { el.textContent = text; el.dataset.state = kind || ''; }
  const b = document.getElementById('midiBtn'); if (b) { b.setAttribute('aria-pressed', kind === 'on' || kind === 'empty' ? 'true' : 'false'); b.classList.toggle('on', kind === 'on' || kind === 'empty'); }
}
function refreshMidiPorts() {
  const acc = keysMidi.access; if (!acc) return;
  const names = [];
  acc.inputs.forEach(inp => { if (inp.state !== 'disconnected') { inp.onmidimessage = midiMessage; names.push(inp.name || 'MIDI device'); } });
  setMidiStatus(names.length ? 'MIDI: ' + names.join(', ') : 'MIDI on: connect a keyboard or controller', names.length ? 'on' : 'empty');
}
async function enableMidi() {
  if (!navigator.requestMIDIAccess) { setMidiStatus('MIDI is not available in this browser. Use Chrome on Android or desktop.', 'unsupported'); return false; }
  try {
    keysMidi.access = await navigator.requestMIDIAccess({ sysex: false });
    keysMidi.access.onstatechange = e => { if (e && e.port && e.port.type === 'input' && e.port.state === 'disconnected') releaseKeysPanic(); refreshMidiPorts(); };
    try { localStorage.setItem('th-midi', '1'); } catch (e) {}
    refreshMidiPorts(); return true;
  } catch (e) { setMidiStatus('MIDI access was blocked. Allow it in the browser or site settings, then tap MIDI again.', 'blocked'); return false; }
}
function disableMidi() {
  const acc = keysMidi.access;
  if (acc) { acc.inputs.forEach(inp => { inp.onmidimessage = null; }); acc.onstatechange = null; }
  keysMidi.access = null; releaseKeysPanic();
  try { localStorage.removeItem('th-midi'); } catch (e) {}
  setMidiStatus('MIDI off', '');
}
async function maybeAutoMidi() {            // reconnect silently, but only if the browser already granted access (no surprise prompt)
  if (keysMidi.access || !navigator.requestMIDIAccess) return;
  try {
    if (localStorage.getItem('th-midi') !== '1') return;
    const st = navigator.permissions && navigator.permissions.query ? await navigator.permissions.query({ name: 'midi' }) : null;
    if (st && st.state === 'granted') await enableMidi();
  } catch (e) {}
}
(function wireMidiUi() {
  const b = document.getElementById('midiBtn'); if (!b) return;
  if (!navigator.requestMIDIAccess) { b.disabled = true; setMidiStatus('MIDI is not available in this browser. Use Chrome on Android or desktop.', 'unsupported'); return; }
  b.addEventListener('click', () => { keysMidi.access ? disableMidi() : enableMidi(); });
})();

/* Safety net: a note must never keep sounding when the user cannot lift the key (app backgrounded, screen locked,
   call, tab switched). Releases every voice, sustained ones included, and clears the pressed state. */
function releaseKeysPanic(){try{keysMidi.held.clear();keysMidi.sustained.clear();keysMidi.pedal=false;releaseAllKeys();document.querySelectorAll('#piano .pkey.on').forEach(k=>{k.classList.remove('on');k._vk=null})}catch(e){}}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')releaseKeysPanic()});
window.addEventListener('pagehide',releaseKeysPanic);
window.addEventListener('blur',releaseKeysPanic);
function updateKeysRecordUI(){const b=document.getElementById('keysRecordBtn'),s=document.getElementById('keysTakeStatus');if(b){b.textContent=state.keysRecording?'■ Stop':'● Record';b.classList.toggle('pri',!!state.keysRecording)}if(s)s.textContent=state.keysRecording?'Recording your keyboard idea…':(state.keysTake.length?`${state.keysTake.length} notes captured · ready to send to Studio.`:'Play freely, or tap Record to capture a keyboard idea.')}
const CHORDS=new Proxy({C:['C','E','G'],Dm:['D','F','A'],Em:['E','G','B'],F:['F','A','C'],G:['G','B','D'],Am:['A','C','E'],G7:['G','B','D','F']},{
  get(t,k){ if(typeof k!=='string'||k in t)return t[k]; const n=buildChord(k); if(n)t[k]=n; return n||undefined; }
});
/* Grid resolution: 1/8, 1/16 or 1/32 notes. Stored on the pattern (pattern._res) so it travels with songs, feed posts and rooms. */
function thRes(){var r=state&&state.pattern&&state.pattern._res;return (r===16||r===32)?r:8;}
function thSpb(){return thRes()/4;}                       // steps per beat
function thAcc(kind,step,level){
  var spb=thSpb(),p=step%(spb*4),base;
  if(kind==='kick')base=p===0?1:0.88;
  else if(kind==='snare')base=0.95;
  else if(kind==='clap')base=0.9;
  else base=p===0?1:(p%(spb*2)===0?0.92:(p%spb===0?0.82:0.7));
  var v=(typeof level==='number'&&level>0)?Math.min(1,level):1;
  return base*v;
}
/* Groove polish: expand 8th-note presets to the current grid, tile over all steps, small fill at the end */
function thFillGroove(pat,n){
  var f=Math.max(1,Math.round(thRes()/8));
  ['kick','snare','hat','clap'].forEach(function(k){
    var a=(pat[k]||[]).slice(), base=[];
    if(!a.length)a=[0];
    a.forEach(function(v){base.push(v?1:0);for(var z=1;z<f;z++)base.push(0);});
    var out=[];for(var i=0;i<n;i++)out.push(base[i%base.length]);
    pat[k]=out;
  });
  if(n>=16){
    if(!pat.kick[n-2]&&!pat.kick[n-1])pat.kick[n-2]=1;
    if(!pat.snare[n-2]&&!pat.snare[n-1]&&pat.snare.some(Boolean))pat.snare[n-1]=1;
    pat.hat[n-1]=1;
  }
  return pat;
}
function scheduler(){if(!state.playing)return;let c;try{c=ensureAudio()}catch(e){return;}if(!c)return;const stepDur=(60/(state.bpm||120))/thSpb();const swingAmt=Math.max(0,Math.min(0.45,(state.swing||0)/100));const pat=state.pattern||{};while(nextNoteTime<c.currentTime+scheduleAhead){const step=state.currentStep%(state.stepCount||16);const swingOff=(step%2===1)?stepDur*swingAmt:0;const t=nextNoteTime+swingOff;const _spb=thSpb();
if(pat.kick&&pat.kick[step])playKick(t,thAcc('kick',step,pat.kick[step]));
if(pat.snare&&pat.snare[step])playSnare(t,thAcc('snare',step,pat.snare[step]));
if(pat.hat&&pat.hat[step])playHat(t,thAcc('hat',step,pat.hat[step]));
if(pat.clap&&pat.clap[step])playClap(t,thAcc('clap',step,pat.clap[step]));
if(state._recMonitor && state._recMonitor.click && step%_spb===0) playClick(t, step%(_spb*4)===0?0.2:0.08);
if(state._recMonitor && state._recMonitor.chords && step%(_spb*2)===0 && (state.detectedChords||[]).length){
  const ch=state.detectedChords[Math.floor(step/(_spb*2))%state.detectedChords.length];
  playChordStab(t, ch, drumVol('chords'));
}highlightStep(step);try{highlightPlayhead(step)}catch(e){}try{if(state.arrMode)highlightArrangementSection(step)}catch(e){}nextNoteTime+=stepDur;state.currentStep++;updateTransportPos();
  if(state.arrMode&&state.arrEndStep!=null&&state.currentStep>=state.arrEndStep){stopTransport();state.arrMode=false;try{renderArrangement()}catch(e){}try{toast('Arrangement preview done')}catch(e){}return;}
}timerID=setTimeout(scheduler,lookahead)}
function highlightStep(step){document.querySelectorAll('.st').forEach(el=>el.classList.remove('playing'));document.querySelectorAll(`.st[data-step="${step}"]`).forEach(el=>el.classList.add('playing'));['kick','snare','hat','clap'].forEach(t=>{if(state.pattern[t][step]){const fill=document.querySelector(`.meter-fill[data-track="${t}"]`);if(fill){fill.style.width=(60+Math.random()*35)+'%';setTimeout(()=>fill.style.width='8%',120)}}})}
function startTransport(){
  try{ensureAudio()}catch(e){toast('Audio unavailable');return;}
  if(!audioCtx){toast('Audio unavailable');return;}
  try{if(audioCtx.state==='suspended')audioCtx.resume()}catch(e){}
  try{ensurePatternLength(state.stepCount||16)}catch(e){}
  state.playing=true;state.currentStep=0;
  nextNoteTime=audioCtx.currentTime+.08;
  state._beatT0=nextNoteTime;                       // audio-clock time of the beat's first step (used to place recorded takes)
  const pb=document.getElementById('playBtn');if(pb){pb.textContent='■';pb.classList.add('playing')}
  const ts=document.getElementById('transportStatus');if(ts&&!state.arrMode)ts.textContent='Playing';
  try{updateProjectContext()}catch(e){}
  try{ensureLiveGraph();startMasterMeter()}catch(e){}
  scheduler();
}
function stopTransport(){state.playing=false;state.arrMode=false;clearTimeout(timerID);const b=document.getElementById('playBtn');if(b){b.textContent='▶';b.classList.remove('playing')}const status=document.getElementById('transportStatus');if(status)status.textContent='Stopped';document.querySelectorAll('.st').forEach(el=>el.classList.remove('playing'));const pos=document.getElementById('transportPos');if(pos)pos.textContent='1.1.1';try{updateProjectContext()}catch(e){}try{stopMasterMeter()}catch(e){}}
function updateTransportPos(){const spb=thSpb(),inBar=state.currentStep%(spb*4),bar=Math.floor(state.currentStep/(spb*4))+1,beat=Math.floor(inBar/spb)+1,sub=(inBar%spb)+1;document.getElementById('transportPos').textContent=`${bar}.${beat}.${sub}`}

function requireAuth(soft){
  if(state.user) return true;
  if(soft){
    toast('Sign in to unlock this feature');
    // Guest mode: toast only — opening the auth modal covers the bottom nav
    // and makes Write/Studio/Feed/Collab feel "broken".
    if(!state.guest) openAuth('signin');
    return false;
  }
  lockApp(true);
  openAuth('signin');
  return false;
}
function enterGuestMode(){
  if(state.guest && document.querySelector('.app') && document.querySelector('.app').classList.contains('app-guest')){
    // already in guest — just ensure auth closed
  }
  state.guest = true;
  const app = document.querySelector('.app');
  if(app){
    app.classList.add('app-guest');
    app.classList.remove('app-locked');
  }
  // Close auth UI without re-entering guest (avoid recursion)
  try{
    const m = document.getElementById('authModal');
    if (m) { m.classList.remove('show'); m.style.display = ''; }
  }catch(e){}
  try{
    if(!state.songs || !state.songs.length){ newSong(); }
    setView(state.view || 'write');
  }catch(e){}
  toast('Guest mode — explore freely. Sign in anytime to save & share.');try{updateProjectContext()}catch(e){}
  try{ showGuestOnboardingTip(); }catch(e){}
}
function showGuestOnboardingTip(){
  if(localStorage.getItem('th-guest-tip-v199')) return;
  localStorage.setItem('th-guest-tip-v199','1');
  setTimeout(function(){
    toast('Tip: try Keys → Hum a melody, or Write one line and use AI Finish Verse', 5200);
  }, 900);
}
function lockApp(locked){
  const app=document.querySelector('.app');
  if(!app)return;
  if(state.guest && locked){
    // Guest stays unlocked for studio exploration
    app.classList.add('app-guest');
    app.classList.remove('app-locked');
    return;
  }
  app.classList.toggle('app-locked', !!locked);
  if(!locked) app.classList.remove('app-guest');
  if(state.user) app.classList.remove('app-guest');
}
function unlockIfAuthed(){
  if(state.user){
    state.guest = false;
    lockApp(false);
  } else if(state.guest){
    lockApp(false);
  } else {
    lockApp(true);
  }
}

function toast(msg,ms=2000){
    if(!msg||state._quiet)return;
    const el=document.getElementById('toast');
    if(!el)return;
    el.textContent=msg;el.classList.add('show');
    clearTimeout(el._t);el._t=setTimeout(()=>el.classList.remove('show'),ms);
  }
async function copyText(text){
  const value=String(text ?? '');
  if(!value)return false;
  try{
    if(navigator.clipboard?.writeText){
      await navigator.clipboard.writeText(value);
      return true;
    }
  }catch(e){}
  try{
    const ta=document.createElement('textarea');
    ta.value=value;
    ta.setAttribute('readonly','');
    ta.style.position='fixed';ta.style.opacity='0';ta.style.pointerEvents='none';
    document.body.appendChild(ta);ta.select();
    const ok=document.execCommand('copy');
    ta.remove();
    return !!ok;
  }catch(e){return false;}
}
  function softStatus(msg){
  try {
    const el = document.getElementById('aiStatus');
    if (el && msg) {
      el.textContent = msg;
      clearTimeout(el._soft);
      el._soft = setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 2800);
    }
  } catch (e) {}
}
function setView(name){
  // Resolve studio hub alias
  if(name==='studio'){
    name = state.studioView || 'beat';
  }
  const freeViews = ['write','keys','beat','record','mix','community','collab'];
  const studioTools = ['keys','beat','record','mix'];
  if(!state.user){
    if(freeViews.indexOf(name) >= 0){
      if(!state.guest) enterGuestMode();
    } else {
      requireAuth(true);
      return;
    }
  }
  if(name!=='keys'){try{releaseKeysPanic()}catch(e){}}
  if(name==='keys'){try{maybeAutoMidi()}catch(e){}}
  if(studioTools.indexOf(name)>=0) state.studioView = name;
  state.view=name;
  try {
    localStorage.setItem('th-view', state.view);
    localStorage.setItem('th-studio-view', state.studioView || 'beat');
  } catch (e) {}
  try{updateProjectContext()}catch(e){};
  try{
    const labels={write:'Write',keys:'Keys',beat:'Beat',record:'Record',mix:'Mix',community:'Feed',collab:'Collab'};
    const pt=document.getElementById('pageTitleBar');
    if(pt) pt.textContent=labels[name]||name;
  }catch(e){}
  // Studio subnav visibility
  try{
    const sub=document.getElementById('studioSubnav');
    if(sub){
      const show=studioTools.indexOf(name)>=0;
      sub.hidden=!show;
      if(show) sub.querySelectorAll('.studio-tab').forEach(t=>t.classList.toggle('on',t.dataset.studio===name));
    }
  }catch(e){}
document.querySelectorAll('.view').forEach(v=>{v.hidden=true;v.setAttribute('hidden','');v.style.display='none';v.style.visibility='hidden';});const t=document.getElementById('view-'+name);if(t){t.hidden=false;t.removeAttribute('hidden');t.style.display='block';t.style.visibility='visible';t.style.flex='0 0 auto';t.style.flexGrow='0';t.style.alignSelf='flex-start';t.style.width='100%';t.style.minHeight='0';t.style.height='auto';t.style.maxHeight='none';t.style.overflow='visible';}document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('on',t.dataset.view===name));
  // Primary bottom tabs: studio is active for any studio tool
  document.querySelectorAll('.bottom-tab').forEach(tab=>{
    const nav=tab.dataset.nav;
    const active = nav===name || (nav==='studio' && studioTools.indexOf(name)>=0);
    tab.classList.toggle('active', !!active);
  });if(name==='mix'){try{startMasterMeter()}catch(e){}try{buildChannelStrip();renderArrangement();updatePublishChecklist();setEqUIFromState();syncLiveGraphLevels()}catch(e){}}
  if(name==='write'){try{ensureWriteSections();showActiveSection();bindWriteProUI();bindWriteGlobalOnce();const bpm=document.getElementById('songBpmNote');if(bpm&&!bpm.value)bpm.value=state.bpm||120}catch(e){}}
  if(name==='record'){
    const bl=document.getElementById('recBpmLabel');
    if(bl) bl.textContent=(state.bpm||120)+' BPM · '+(state.kit||'trap');
    renderVocalTakes();
    try {
      const sec = document.getElementById('recSection')?.value || 'verse1';
      renderTimelineMap(sec);
      state._recMonitor = {
        click: !!document.getElementById('recMetronome')?.checked,
        chords: true,
        drums: true
      };
      updateRecBeatBedUI();
    } catch (e) {}
  }if(name==='keys'){try{renderProgStrip();buildPiano()}catch(e){}}if(name==='beat'){try{ensurePatternLength(state.stepCount||16);buildTracks()}catch(e){}}if(name==='community'){try{if(!state.user&&state.guest&&!state._guestFeedTip){state._guestFeedTip=1;toast('Guest can browse Feed — sign in to post & like');}bindFeedPro();bindCommunityActions(); try{bindFeedGlobalOnce()}catch(e){}}catch(e){}renderCommunityFeed();}if(name==='collab'){
  try{if(!state.user&&state.guest&&!state._guestCollabTip){state._guestCollabTip=1;toast('Guest can open Collab — sign in to create or join rooms');}}catch(e){}
  try{
    const btn=document.getElementById('createRoomBtn');
    const t=(document.getElementById('songTitle')?.value||'Untitled');
    if(btn) btn.textContent='＋ Create Room — Share '+t+' ('+(state.bpm||120)+' BPM)';
  }catch(e){}
  renderCollabView();startCollabPoll();
}else{stopCollabPoll()}}

// Navigation is handled by the dedicated tab listeners below. Avoid a
// capture-phase global handler: it can suppress other listeners for the same click.

function setTheme(mode){state.theme=mode;document.documentElement.setAttribute('data-theme',mode==='light'?'light':'');localStorage.setItem('th-theme',mode);const meta=document.querySelector('meta[name="theme-color"]');if(meta)meta.content=mode==='light'?'#F5F3EF':'#0A0A0C'}
const WHITE=['C','D','E','F','G','A','B'],BLACK_MAP={C:'C#',D:'D#',F:'F#',G:'G#',A:'A#'};
function buildPiano(){const el=document.getElementById('piano');if(!el)return;releaseAllKeys();el.innerHTML='';const addKey=(key,n,black=false)=>{key.className='pkey'+(black?' black':'');key.dataset.note=n;key.textContent=n;const down=e=>{e.preventDefault();startKeyNote(n,state.octave);key._vk=n+state.octave;key.classList.add('on');try{key.setPointerCapture&&key.setPointerCapture(e.pointerId)}catch(_){/* pointer already gone (very fast tap): the note must still sound */}};const up=e=>{if(e&&e.preventDefault)e.preventDefault();key.classList.remove('on');const vk=key._vk||(n+state.octave);key._vk=null;if(!state.keysSustain)releaseKeyNote(vk)};key.addEventListener('pointerdown',down);key.addEventListener('pointerup',up);key.addEventListener('pointercancel',up);key.addEventListener('lostpointercapture',up);key.addEventListener('pointerleave',e=>{if(e.buttons===0){key.classList.remove('on');const vk=key._vk||(n+state.octave);key._vk=null;if(!state.keysSustain)releaseKeyNote(vk)}});el.appendChild(key)};WHITE.forEach(n=>{addKey(document.createElement('div'),n,false);if(BLACK_MAP[n])addKey(document.createElement('div'),BLACK_MAP[n],true)});document.getElementById('octaveLabel').textContent=state.octave;try{applyScaleLock()}catch(e){}document.getElementById('octaveRange').textContent=`C${state.octave} — B${state.octave}`}
const TRACKS=[{id:'kick',name:'Kick',icon:'🥁'},{id:'snare',name:'Snare',icon:'🧴'},{id:'hat',name:'Hi-Hat',icon:'🎩'},{id:'clap',name:'Clap',icon:'👏'}];

/* ── UX v2 engine ── */
state.stepCount = state.stepCount || 16;
state.stepEditMode = state.stepEditMode || 'cycle';
state._tapTempoTimes = state._tapTempoTimes || [];

function ensurePatternLength(n) {
  n = n || state.stepCount || 16;
  state.stepCount = n;
  ['kick','snare','hat','clap'].forEach(k => {
    let a = state.pattern[k];
    if (!Array.isArray(a)) a = [];
    if (a.length < n) {
      while (a.length < n) a.push(0);
    } else if (a.length > n) {
      a = a.slice(0, n);
    }
    state.pattern[k] = a;
  });
  const lab = document.getElementById('stepLenLabel');
  if (lab) {
    const _b = n / (thSpb() * 4), bars = _b === 0.5 ? '½ bar' : _b === 1 ? '1 bar' : _b + ' bars';
    lab.textContent = n + ' steps · 1/' + thRes() + ' · ' + bars;
  }
}

function randomizePattern() {
  ensurePatternLength(state.stepCount);
  const dens = { kick: 0.28, snare: 0.22, hat: 0.55, clap: 0.12 };
  Object.keys(dens).forEach(k => {
    state.pattern[k] = state.pattern[k].map((_, i) => {
      if (k === 'kick' && i % 4 === 0) return 1;
      if (k === 'snare' && i % 8 === 4) return 1;
      return Math.random() < dens[k] ? 1 : 0;
    });
  });
  buildTracks();
  saveCurrentSong();
}

function duplicatePatternHalf() {
  ensurePatternLength(state.stepCount);
  const n = state.stepCount;
  const half = Math.floor(n / 2);
  ['kick','snare','hat','clap'].forEach(k => {
    const a = state.pattern[k];
    for (let i = 0; i < half && half + i < n; i++) a[half + i] = a[i];
  });
  buildTracks();
  saveCurrentSong();
}

function highlightPlayhead(step) {
  document.querySelectorAll('#tracks .st').forEach(el => {
    const s = parseInt(el.dataset.step, 10);
    el.classList.toggle('playhead', state.playing && s === step);
  });
}

function renderProgSlots() {
  const el = document.getElementById('progSlots');
  if (!el) return;
  const prog = state.detectedChords || [];
  const romans = ['I','V','vi','IV','ii','iii','VII','I'];
  let html = '';
  for (let i = 0; i < 4; i++) {
    const c = prog[i];
    if (c) {
      html += `<div class="prog-slot filled" data-slot="${i}"><span class="ps-chord">${esc(c)}</span><span class="ps-roman">${romans[i]||''}</span></div>`;
    } else {
      html += `<div class="prog-slot" data-slot="${i}"><span class="ps-plus">+</span></div>`;
    }
  }
  el.innerHTML = html;
}

function autoNameProject(song) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const d = new Date(song.updated || Date.now());
  const kit = (song.kit || state.kit || 'trap');
  const bpm = song.bpm || state.bpm || 120;
  const label = kit.charAt(0).toUpperCase() + kit.slice(1);
  return months[d.getMonth()] + ' ' + d.getDate() + ' · ' + label + ' ' + bpm + ' BPM';
}

function updateCloudBadge() {
  const b = document.getElementById('cloudModeBadge');
  if (!b) return;
  try {
    if (typeof Cloud !== 'undefined' && Cloud.isCloud && Cloud.isCloud()) {
      b.textContent = 'Cloud Connected';
      b.className = 'text-dim text-center cloud-ok';
    } else {
      b.textContent = 'Cloud Offline — local mode';
      b.className = 'text-dim text-center cloud-bad';
      b.style.fontSize = '10px';
      b.style.marginTop = '-8px';
      b.style.marginBottom = '4px';
    }
  } catch (e) {
    b.textContent = 'Local mode';
  }
}


/* ── Vocal record pipeline ── */
state.vocal = state.vocal || null; // { blob, url, section, offsetMs, gain, reverb }
state.volumes.vocal = state.volumes.vocal != null ? state.volumes.vocal : 0.9;
state.volumes.chords = state.volumes.chords != null ? state.volumes.chords : 0.55;
state.mute = state.mute || {};
state.solo = state.solo || {};


let _vocalRec = null, _vocalChunks = [], _vocalAudio = null, _recWaveRAF = null;
let _vocalInputStream = null, _vocalCaptureStream = null, _vocalCaptureNodes = null;

/* Music-first microphone capture. Browser voice processing (AGC/noise suppression/
   echo cancellation) is intentionally disabled: it is designed for calls, not vocals.
   We apply gentle, predictable processing ourselves and record the processed stream. */
async function getMusicMicStream(){
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('no-mic-api');
  const attempts = [
    {audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:1,sampleRate:48000,latency:0}},
    {audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:1}},
    {audio:true}
  ];
  let last;
  for(const constraints of attempts){
    try { return await navigator.mediaDevices.getUserMedia(constraints); }
    catch(e){ last=e; }
  }
  throw last || new Error('mic-denied');
}
function buildVocalCapture(stream){
  const c=ensureAudio();
  const src=c.createMediaStreamSource(stream);
  const hp=c.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=70; hp.Q.value=.7;
  const body=c.createBiquadFilter(); body.type='peaking'; body.frequency.value=220; body.Q.value=.8; body.gain.value=-1.5;
  const presence=c.createBiquadFilter(); presence.type='peaking'; presence.frequency.value=4200; presence.Q.value=.9; presence.gain.value=1.5;
  const comp=c.createDynamicsCompressor();
  comp.threshold.value=-18; comp.knee.value=12; comp.ratio.value=2.5; comp.attack.value=.004; comp.release.value=.12;
  const limiter=thMakeLimiter(c); limiter.threshold.value=-1.2; limiter.knee.value=1; limiter.ratio.value=12; limiter.attack.value=.001; limiter.release.value=.06;
  const makeup=c.createGain(); makeup.gain.value=.95;
  const analyser=c.createAnalyser(); analyser.fftSize=256; analyser.smoothingTimeConstant=.65;
  const dest=c.createMediaStreamDestination();
  src.connect(hp); hp.connect(body); body.connect(presence); presence.connect(comp); comp.connect(limiter); limiter.connect(makeup); makeup.connect(analyser); analyser.connect(dest);
  _vocalInputStream=stream; _vocalCaptureStream=dest.stream;
  _vocalCaptureNodes={src,hp,body,presence,comp,limiter,makeup,analyser,dest};
  return dest.stream;
}
function cleanupVocalCapture(){
  try{ _vocalInputStream?.getTracks().forEach(t=>t.stop()); }catch(e){}
  try{ _vocalCaptureNodes?.src?.disconnect(); _vocalCaptureNodes?.dest?.disconnect(); }catch(e){}
  _vocalInputStream=null; _vocalCaptureStream=null; _vocalCaptureNodes=null;
}
function chooseVocalMime(){
  const candidates=[
    'audio/mp4;codecs=mp4a.40.2','audio/mp4',
    'audio/webm;codecs=opus','audio/webm',
    'audio/ogg;codecs=opus'
  ];
  return candidates.find(t=>window.MediaRecorder?.isTypeSupported?.(t))||'';
}
function createVocalRecorder(captureStream,mime){
  const opts={};
  if(mime) opts.mimeType=mime;
  if(mime.includes('opus')) opts.audioBitsPerSecond=256000;
  else if(mime.includes('mp4')) opts.audioBitsPerSecond=192000;
  return Object.keys(opts).length ? new MediaRecorder(captureStream,opts) : new MediaRecorder(captureStream);
}


/* ═══ Full Song Pipeline ═══ */
const SECTION_BARS = {
  intro:  { start: 1,  len: 4,  label: 'Intro' },
  verse1: { start: 5,  len: 8,  label: 'Verse 1' },
  chorus: { start: 13, len: 8,  label: 'Chorus' },
  verse2: { start: 21, len: 8,  label: 'Verse 2' },
  bridge: { start: 29, len: 4,  label: 'Bridge' },
  outro:  { start: 33, len: 4,  label: 'Outro' },
  verse:  { start: 5,  len: 8,  label: 'Verse' },
  hook:   { start: 13, len: 8,  label: 'Hook' },
  full:   { start: 1,  len: 36, label: 'Full' }
};

function barsToMs(bars, bpm) {
  bpm = bpm || state.bpm || 120;
  // 1 bar = 4 beats at 4/4; stepDur is 8th note = (60/bpm)/2, 8 steps = 1 bar
  return bars * 8 * ((60 / bpm) / 2) * 1000;
}

function getSectionBarInfo(sectionId) {
  const key = (sectionId || 'verse1').toLowerCase().replace(/\s+/g, '');
  return SECTION_BARS[key] || SECTION_BARS.verse1;
}

function sectionStartOffsetMs(sectionId) {
  const info = getSectionBarInfo(sectionId);
  return barsToMs(info.start - 1, state.bpm);
}

function renderTimelineMap(activeId) {
  const el = document.getElementById('timelineMap');
  if (!el) return;
  const order = ['intro','verse1','chorus','verse2','bridge','outro'];
  el.innerHTML = order.map(id => {
    const s = SECTION_BARS[id];
    const on = (activeId || document.getElementById('recSection')?.value || '') === id ||
      (activeId === 'hook' && id === 'chorus') ||
      (activeId === 'verse' && id === 'verse1');
    return `<div class="tl-sec${on?' on':''}" data-tl="${id}">
      <div class="tl-lab">${s.label}</div>
      <div class="tl-bars">Bars ${s.start}–${s.start+s.len-1}</div>
    </div>`;
  }).join('');
}


function defaultArrangement() {
  return ['intro','verse1','chorus','verse2','bridge','outro'].map(id => ({
    id,
    on: true,
    bars: (SECTION_BARS[id] && SECTION_BARS[id].len) || 4
  }));
}
function ensureArrangement() {
  if (!state.arrangement || !state.arrangement.length) {
    state.arrangement = defaultArrangement();
  }
  // sanitize
  state.arrangement = state.arrangement.map(a => ({
    id: a.id,
    on: a.on !== false,
    bars: Math.max(1, Number(a.bars) || (SECTION_BARS[a.id] && SECTION_BARS[a.id].len) || 4)
  }));
  return state.arrangement;
}
function arrangementTotalBars() {
  return ensureArrangement().filter(a => a.on).reduce((s, a) => s + a.bars, 0);
}
function arrangementPatternCycles(steps) {
  steps = steps || state.stepCount || 16;
  const barsPerCycle = Math.max(0.5, steps / (thSpb() * 4)); // 16 steps = 2 bars
  const totalBars = Math.max(1, arrangementTotalBars());
  return Math.max(1, Math.round(totalBars / barsPerCycle));
}
function sectionStartInArrangementMs(sectionId) {
  const bpm = state.bpm || 120;
  let bars = 0;
  for (const a of ensureArrangement()) {
    if (!a.on) continue;
    if (a.id === sectionId || (sectionId === 'verse' && a.id === 'verse1') || (sectionId === 'hook' && a.id === 'chorus')) {
      return barsToMs(bars, bpm);
    }
    bars += a.bars;
  }
  return sectionStartOffsetMs(sectionId);
}
function renderArrangement() {
  const el = document.getElementById('arrangementList');
  if (!el) return;
  const arr = ensureArrangement();
  el.innerHTML = arr.map((a, i) => {
    const lab = (SECTION_BARS[a.id] && SECTION_BARS[a.id].label) || a.id;
    return `<div class="arr-row${a.on ? '' : ' off'}" data-arr-i="${i}">
      <button type="button" class="btn ghost arr-move" data-arr-up="${i}" title="Move up">↑</button>
      <button type="button" class="btn ghost arr-move" data-arr-down="${i}" title="Move down">↓</button>
      <span class="arr-lab">${lab}</span>
      <label class="arr-bars" style="display:flex;align-items:center;gap:4px">
        <input type="number" class="modal-input arr-bars-in" data-arr-bars="${i}" min="1" max="32" value="${a.bars}" inputmode="numeric" style="width:52px;padding:4px 6px;font-size:16px">
        <span>bars</span>
      </label>
      <button type="button" class="btn ghost" data-arr-dup="${i}" title="Duplicate">＋</button>
      <button type="button" class="btn arr-tog" data-arr-tog="${i}">${a.on ? 'On' : 'Off'}</button>
    </div>`;
  }).join('');
  const sum = document.getElementById('arrSummary');
  if (sum) {
    const bars = arrangementTotalBars();
    const cycles = arrangementPatternCycles();
    const sec = (bars * 4 * 60 / (state.bpm || 120)).toFixed(1);
    sum.textContent = bars + ' bars · ~' + sec + 's @ ' + (state.bpm || 120) + ' BPM · ' + cycles + ' pattern cycles';
  }
  const pb = document.getElementById('arrPlayBtn');
  if (pb) pb.textContent = (state.playing && state.arrMode) ? '■ Stop form' : '▶ Preview form';
}
function startArrangementPreview() {
  if (state.playing && state.arrMode) {
    stopTransport();
    state.arrMode = false;
    renderArrangement();
    return;
  }
  const cycles = arrangementPatternCycles();
  const steps = state.stepCount || 16;
  state.arrMode = true;
  state.arrEndStep = cycles * steps;
  try { ensureLiveGraph(); unlockAudio(); } catch (e) {}
  if (state.playing) stopTransport();
  startTransport();
  const ts = document.getElementById('transportStatus');
  if (ts) ts.textContent = 'Form · ' + arrangementTotalBars() + ' bars';
  renderArrangement();
  toast('Playing arrangement (' + arrangementTotalBars() + ' bars)');
}
function arrangementSectionAtStep(step) {
  const steps = state.stepCount || 16;
  const barsPerCycle = Math.max(0.5, steps / (thSpb() * 4));
  const stepsPerBar = steps / barsPerCycle; // usually 8
  let bar = Math.floor(step / stepsPerBar);
  for (const a of ensureArrangement()) {
    if (!a.on) continue;
    if (bar < a.bars) return a.id;
    bar -= a.bars;
  }
  return null;
}
function highlightArrangementSection(step) {
  const id = arrangementSectionAtStep(step);
  document.querySelectorAll('.arr-row').forEach(row => {
    const i = Number(row.getAttribute('data-arr-i'));
    const arr = ensureArrangement()[i];
    row.classList.toggle('playing', !!(arr && arr.id === id && state.arrMode));
  });
  const sum = document.getElementById('arrSummary');
  if (sum && state.arrMode && id) {
    const lab = (SECTION_BARS[id] && SECTION_BARS[id].label) || id;
    const bars = arrangementTotalBars();
    const cycles = arrangementPatternCycles();
    const sec = (bars * 4 * 60 / (state.bpm || 120)).toFixed(1);
    sum.textContent = '▶ ' + lab + ' · ' + bars + ' bars · ~' + sec + 's · ' + cycles + ' cycles';
  }
}

function playClick(t, v) {
  try {
    const c = ensureAudio();
    const o = c.createOscillator();
    const g = c.createGain();
    o.frequency.value = 1200;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime((v || 0.15) * (state.volumes?.click || 0.4), t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    o.connect(g); g.connect(liveDest('click'));
    o.start(t); o.stop(t + 0.04);
  } catch (e) {}
}

function playChordStab(t, chordName, v) {
  try {
    const notes = (typeof CHORDS !== 'undefined' && CHORDS[chordName]) ? CHORDS[chordName] : null;
    if (!notes) return;
    const vol = (v != null ? v : 0.35) * (state.volumes?.chords != null ? state.volumes.chords : 0.55);
    notes.forEach((n, i) => {
      setTimeout(() => {
        try {
          // schedule relative is hard offline; for live use playNote
        } catch (e) {}
      }, i * 8);
      try {
        const c = ensureAudio();
        const freq = noteToFreq(n, 3);
        if (!freq) return;
        const o = c.createOscillator();
        const g = c.createGain();
        o.type = 'triangle';
        o.frequency.value = freq;
        const tt = t + i * 0.01;
        g.gain.setValueAtTime(0.0001, tt);
        g.gain.exponentialRampToValueAtTime(vol * 0.25, tt + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.45);
        o.connect(g); g.connect(liveDest('chords'));
        o.start(tt); o.stop(tt + 0.5);
      } catch (e) {}
    });
  } catch (e) {}
}

function noteToFreq(note, oct) {
  const map = { C:0, 'C#':1, Db:1, D:2, 'D#':3, Eb:3, E:4, F:5, 'F#':6, Gb:6, G:7, 'G#':8, Ab:8, A:9, 'A#':10, Bb:10, B:11 };
  const n = map[note];
  if (n == null) return null;
  return 440 * Math.pow(2, (n - 9) / 12 + ((oct || 3) - 4));
}

// Patch scheduler conceptually via flag
state._recMonitor = state._recMonitor || { click: true, chords: true };

function drumVol(track) {
  if (state.mute && state.mute[track]) return 0;
  if (state.solo && Object.values(state.solo).some(Boolean) && !state.solo[track]) return 0;
  return state.volumes && state.volumes[track] != null ? state.volumes[track] : 0.8;
}

async function bounceFullSong(loops, opts) {
  opts = opts || {};
  const stem = opts.stem || 'full'; // full | drums | chords | vocal | kick | snare | hat | clap
  loops = loops || 2;
  const bpm = state.bpm || 120;
  const steps = state.stepCount || 16;
  const stepDur = (60 / bpm) / thSpb();
  const swingAmt = Math.max(0, Math.min(0.6, (state.swing || 0) / 100));
  // Arrangement-driven length: pattern cycles fill enabled sections; quality multiplies whole form
  let patternCycles = arrangementPatternCycles(steps);
  if (loops <= 1) patternCycles = Math.max(1, Math.ceil(patternCycles * 0.5)); // draft
  else if (loops >= 4) patternCycles = patternCycles * 2; // high = full form twice
  const duration = steps * stepDur * patternCycles + 0.8;
  const sr = 44100;
  const offline = new OfflineAudioContext(2, Math.ceil(sr * duration), sr);

  // Multi-bus graph
  const master = offline.createGain();
  master.gain.value = (state.volumes && state.volumes.master != null) ? state.volumes.master : 0.85;

  // Master FX inserts: 3-band EQ + compressor (same as live)
  const eqState = state.eq || { low:50, mid:50, high:50 };
  const low = offline.createBiquadFilter();
  low.type = 'lowshelf'; low.frequency.value = 180;
  low.gain.value = (typeof eqGainFromSlider === 'function' ? eqGainFromSlider(eqState.low) : 0);
  const mid = offline.createBiquadFilter();
  mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = 0.9;
  mid.gain.value = (typeof eqGainFromSlider === 'function' ? eqGainFromSlider(eqState.mid) : 0);
  const high = offline.createBiquadFilter();
  high.type = 'highshelf'; high.frequency.value = 4200;
  high.gain.value = (typeof eqGainFromSlider === 'function' ? eqGainFromSlider(eqState.high) : 0);
  const comp = offline.createDynamicsCompressor();
  const glue = Math.max(0, Math.min(100, state.glue != null ? state.glue : 40)) / 100;
  comp.threshold.value = -8 - glue * 16;
  comp.knee.value = 6 + glue * 10;
  comp.ratio.value = 1.5 + glue * 4.5;
  comp.attack.value = 0.022;   // let drum transients through
  comp.release.value = 0.18 + glue * 0.15;
  const _hp = thMakeHP(offline), _lim = thMakeLimiter(offline), _tn = thMakeTone(offline), _mk = offline.createGain(); _mk.gain.value = 1.0; master.connect(_hp); _hp.connect(_tn[0]); _tn[0].connect(_tn[1]); _tn[1].connect(low); low.connect(mid); mid.connect(high); high.connect(comp); comp.connect(_mk); _mk.connect(_lim); _lim.connect(offline.destination);

  function makeBus(id, defaultVol) {
    const g = offline.createGain();
    g.gain.value = defaultVol;
    const panVal = (state.pan && state.pan[id] != null) ? state.pan[id] : 0;
    try {
      const p = offline.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, panVal));
      g.connect(p);
      p.connect(master);
    } catch (e) {
      g.connect(master);
    }
    return g;
  }
  const bus = {
    kick: makeBus('kick', 1),
    snare: makeBus('snare', 1),
    hat: makeBus('hat', 1),
    clap: makeBus('clap', 1),
    chords: makeBus('chords', 1),
    vocal: makeBus('vocal', 1)
  };

  // Stem isolation: mute buses not in this stem
  const stemMap = {
    full: null,
    drums: ['kick','snare','hat','clap'],
    chords: ['chords'],
    vocal: ['vocal'],
    kick: ['kick'],
    snare: ['snare'],
    hat: ['hat'],
    clap: ['clap']
  };
  if (stem !== 'full' && stemMap[stem]) {
    Object.keys(bus).forEach(k => {
      bus[k].gain.value = stemMap[stem].indexOf(k) >= 0 ? 1 : 0;
    });
  }

  function oKick(t, v, dest) { thDrumVoice(offline, 'kick', t, v, dest || bus.kick); }
  function oSample(buf, t, v, dest, cap) {
    if (!buf) return false;
    try {
      const src = offline.createBufferSource();
      src.buffer = buf;
      const g = offline.createGain();
      const dur = Math.min(cap || buf.duration, buf.duration || 0.3);
      g.gain.setValueAtTime(Math.max(0.0001, v), t); g.gain.setValueAtTime(Math.max(0.0001, v), t + Math.max(0, dur - 0.03)); g.gain.linearRampToValueAtTime(0, t + dur);
      src.connect(g); g.connect(dest);
      src.start(t); src.stop(t + dur + 0.02);
      return true;
    } catch (e) { return false; }
  }
  function oChord(t, name, v) {
    const notes = (CHORDS && CHORDS[name]) ? CHORDS[name] : null;
    if (!notes) return;
    notes.forEach((note, i) => {
      const f = noteToFreq(note, 3);
      if (!f) return;
      const o = offline.createOscillator();
      const g = offline.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      const tt = t + i * 0.008;
      g.gain.setValueAtTime(0.001, tt);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0001, v * 0.22), tt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, tt + 0.4);
      o.connect(g); g.connect(bus.chords);
      o.start(tt); o.stop(tt + 0.42);
    });
  }

  const pat = state.pattern || {};
  const samples = state.samples || {};
  for (let loop = 0; loop < patternCycles; loop++) {
    for (let step = 0; step < steps; step++) {
      const swingOff = (step % 2 === 1) ? stepDur * swingAmt : 0;
      const t = loop * steps * stepDur + step * stepDur + 0.05 + swingOff;
      if (pat.kick && pat.kick[step]) {
        const v = drumVol('kick') * TH_LEVEL.kick * thAcc('kick', step, pat.kick[step]);
        if (!(samples.kick && oSample(samples.kick, t, v, bus.kick, 0.5))) oKick(t, v, bus.kick);
      }
      if (pat.snare && pat.snare[step]) {
        const v = drumVol('snare') * TH_LEVEL.snare * thAcc('snare', step, pat.snare[step]);
        if (!(samples.snare && oSample(samples.snare, t, v, bus.snare, 0.4))) thDrumVoice(offline, 'snare', t, v, bus.snare);
      }
      if (pat.hat && pat.hat[step]) {
        const v = drumVol('hat') * TH_LEVEL.hat * thAcc('hat', step, pat.hat[step]);
        if (!(samples.hat && oSample(samples.hat, t, v, bus.hat, 0.2))) thDrumVoice(offline, 'hat', t, v, bus.hat);
      }
      if (pat.clap && pat.clap[step]) {
        const v = drumVol('clap') * TH_LEVEL.clap * thAcc('clap', step, pat.clap[step]);
        if (!(samples.clap && oSample(samples.clap, t, v, bus.clap, 0.35))) thDrumVoice(offline, 'clap', t, v, bus.clap);
      }
      if (step % 4 === 0 && (state.detectedChords || []).length) {
        const ch = state.detectedChords[Math.floor(step / 4) % state.detectedChords.length];
        oChord(t, ch, drumVol('chords'));
      }
    }
  }

  // Vocal on its own bus
  if (state.vocal && state.vocal.blob && (stem === 'full' || stem === 'vocal')) {
    try {
      const arr = await state.vocal.blob.arrayBuffer();
      const audioBuf = await offline.decodeAudioData(arr.slice(0));
      const src = offline.createBufferSource();
      src.buffer = audioBuf;
      const g = offline.createGain();
      const vg = (state.volumes && state.volumes.vocal != null) ? state.volumes.vocal : 0.9;
      g.gain.value = vg * drumVol('vocal');
      src.connect(g); g.connect(bus.vocal);
      const sec = state.vocal.section || 'verse';
      const off = ((typeof sectionStartInArrangementMs === 'function' ? sectionStartInArrangementMs(sec) : sectionStartOffsetMs(sec)) + (state.vocal.offsetMs || 0) + (state.vocal.gapMs || 0)) / 1000;
      const when = 0.05 + off;
      if (when >= 0) src.start(when); else src.start(0, Math.min(audioBuf.duration, -when));   // a take that must start before 0 loses its head instead of being pushed late
    } catch (e) {
      console.warn('vocal mix', e);
    }
  }

  const rendered = await offline.startRendering();
  const DSP = window.TapeheadDSP;
  let out = rendered;
  state.lastMasterReport = null;
  if (DSP && stem === 'full') {
    const chs = []; for (let c = 0; c < rendered.numberOfChannels; c++) chs.push(rendered.getChannelData(c));
    const preset = opts.master && DSP.PRESETS[opts.master];
    if (preset) {
      if (typeof opts.onStage === 'function') { opts.onStage('Mastering to ' + preset.targetLufs + ' LUFS…'); await new Promise(r => setTimeout(r, 30)); }
      const r = DSP.masterToTarget(chs, rendered.sampleRate, preset);
      state.lastMasterReport = { preset: opts.master, applied: r.applied, before: r.before, after: r.after, gainDb: r.gainDb, reductionDb: r.maxReductionDb };
      out = { numberOfChannels: chs.length, sampleRate: rendered.sampleRate, length: rendered.length, getChannelData: i => r.channels[i] };
    } else {
      const a = DSP.analyze(chs, rendered.sampleRate);
      state.lastMasterReport = { preset: 'off', applied: false, before: a, after: a, gainDb: 0, reductionDb: 0 };
    }
  }
  state._lastBounceChannels = { rate: rendered.sampleRate, channels: Array.from({ length: out.numberOfChannels }, (_, i) => out.getChannelData(i)) };
  return audioBufferToWavBlob(out);
}

function crc32Table(){
  if (window._crcTable) return window._crcTable;
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  window._crcTable = t;
  return t;
}
function crc32(buf){
  const table = crc32Table();
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
/** Minimal store-only ZIP for stem packs */
function buildZipBlob(files){
  const parts = [];
  const central = [];
  let offset = 0;
  const enc = new TextEncoder();
  files.forEach(f => {
    const nameBytes = enc.encode(f.name);
    const data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
    const crc = crc32(data);
    const local = new ArrayBuffer(30 + nameBytes.length);
    const lv = new DataView(local);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    parts.push(new Uint8Array(local), nameBytes, data);
    const cen = new ArrayBuffer(46 + nameBytes.length);
    const cv = new DataView(cen);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    central.push(new Uint8Array(cen), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  });
  let centralSize = 0;
  const centralStart = offset;
  central.forEach(p => { centralSize += p.length; parts.push(p); });
  const endRec = new ArrayBuffer(22);
  const ev = new DataView(endRec);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  ev.setUint16(20, 0, true);
  parts.push(new Uint8Array(endRec));
  return new Blob(parts, { type: 'application/zip' });
}

async function bounceStems(loops) {
  const stems = ['full', 'drums', 'chords', 'vocal'];
  const title = ((document.getElementById('songTitle')?.value) || 'tapehead-song').replace(/[^\w\-]+/g, '_');
  const files = [];
  for (let i = 0; i < stems.length; i++) {
    const st = stems[i];
    if (st === 'vocal' && !(state.vocal && state.vocal.blob)) continue;
    if (st === 'chords' && !(state.detectedChords && state.detectedChords.length)) continue;
    setBounceProgress(10 + (i / stems.length) * 75, 'Rendering ' + st + ' stem…');
    await new Promise(r => setTimeout(r, 20));
    try {
      const blob = await bounceFullSong(loops, { stem: st });
      const buf = new Uint8Array(await blob.arrayBuffer());
      files.push({ name: title + '_' + st + '.wav', data: buf });
      if (st === 'full') {
        state.mixdownBlob = blob;
        if (state.mixdownUrl) try { URL.revokeObjectURL(state.mixdownUrl); } catch (e) {}
        state.mixdownUrl = URL.createObjectURL(blob);
      }
    } catch (e) {
      console.warn('stem', st, e);
    }
  }
  setBounceProgress(92, 'Packing ZIP…');
  if (!files.length) throw new Error('No stems rendered');
  const zip = buildZipBlob(files);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(zip);
  a.download = title + '_stems.zip';
  a.click();
  return files;
}


/* ── Bounce helpers (progress UI + WAV encoder) ──
   doMixdown/doExportStems/bounceFullSong/stem exports depend on these. */
function setBounceProgress(pct, label) {
  const wrap = document.getElementById('bounceProgress');
  const fill = document.getElementById('bounceFill');
  const lab = document.getElementById('bounceLabel');
  if (wrap) wrap.hidden = false;
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  if (fill) fill.style.width = p + '%';
  if (lab && label != null) lab.textContent = String(label);
  if (wrap) wrap.setAttribute('aria-valuenow', String(Math.round(p)));
}
function hideBounceProgress() {
  const wrap = document.getElementById('bounceProgress');
  const fill = document.getElementById('bounceFill');
  if (wrap) wrap.hidden = true;
  if (fill) fill.style.width = '0%';
}
/** Encode an AudioBuffer as a 16-bit PCM little-endian WAV (interleaved channels). */
function audioBufferToWavBlob(buffer) {
  const channels = Math.max(1, Math.min(2, buffer.numberOfChannels || 1));
  const rate = buffer.sampleRate;
  const frames = buffer.length;
  const bytesPerSample = 2;
  const dataSize = frames * channels * bytesPerSample;
  const ab = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(ab);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) dv.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + dataSize, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, channels, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * channels * bytesPerSample, true);
  dv.setUint16(32, channels * bytesPerSample, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, dataSize, true);
  const data = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));
  let o = 44;
  const DSP = window.TapeheadDSP, rng = DSP ? DSP.makeRng(0x9e3779b9) : null;   // TPDF dither: no quantisation distortion on quiet tails
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      let x = data[c][i];
      x = x > 1 ? 1 : x < -1 ? -1 : (x || 0);          // clamp, and map NaN to silence
      dv.setInt16(o, DSP ? DSP.quantize16(x, rng) : (x < 0 ? x * 0x8000 : x * 0x7fff), true);
      o += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}
async function doMixdown() {
  const q = document.getElementById('bounceQuality')?.value || 'standard';
  const loops = q === 'high' ? 4 : q === 'draft' ? 1 : 2;
  const btn = document.getElementById('mixdownBtn');
  const stemsBtn = document.getElementById('stemsBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Bouncing…'; }
  if (stemsBtn) stemsBtn.disabled = true;
  setBounceProgress(8, 'Building multi-bus graph…');
  toast(q === 'high' ? 'High-quality multi-track bounce…' : 'Bouncing full mix…');
  try {
    setBounceProgress(30, 'Rendering drum buses…');
    await new Promise(r => setTimeout(r, 30));
    setBounceProgress(55, state.vocal ? 'Routing vocal bus…' : 'Instrumental buses only…');
    const master = document.getElementById('bounceMaster')?.value || 'off';
    const wantMp3 = document.getElementById('bounceFormat')?.value === 'mp3';
    let blob = await bounceFullSong(loops, { stem: 'full', master, onStage: t => setBounceProgress(75, t) });
    let mp3Failed = false;
    if (wantMp3 && window.TapeheadMp3 && state._lastBounceChannels) {
      setBounceProgress(88, 'Encoding MP3…');
      try {
        const lb = state._lastBounceChannels;
        blob = await window.TapeheadMp3.encode(lb.channels, lb.rate, { kbps: 192, onProgress: f => setBounceProgress(88 + Math.round(f * 8), 'Encoding MP3…') });
      } catch (e) { console.warn('mp3', e); mp3Failed = true; toast('MP3 encoder unavailable (check your connection): saved as WAV'); }
    }
    state._lastBounceChannels = null;
    setBounceProgress(97, blob.type === 'audio/mpeg' ? 'Preparing MP3…' : 'Encoding master WAV…');
    if (state.mixdownUrl) try { URL.revokeObjectURL(state.mixdownUrl); } catch (e) {}
    state.mixdownBlob = blob;
    state.mixdownUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = state.mixdownUrl;
    a.download = ((document.getElementById('songTitle')?.value) || 'tapehead-song').replace(/[^\w\-]+/g, '_') + '_full.' + (blob.type === 'audio/mpeg' ? 'mp3' : 'wav');
    a.click();
    const rep = state.lastMasterReport, fmt1 = v => (isFinite(v) ? v.toFixed(1) : '-inf');
    setBounceProgress(100, 'Master mix downloaded' + (rep && isFinite(rep.after.lufs) ? ' · ' + fmt1(rep.after.lufs) + ' LUFS · ' + fmt1(rep.after.truePeakDb) + ' dBTP' : ''));
    const repEl = document.getElementById('bounceReport');
    if (repEl && rep) {
      if (!isFinite(rep.after.lufs)) repEl.textContent = 'The mix is silent. Add a beat or a vocal first.';
      else if (rep.preset === 'off') repEl.textContent = 'Loudness ' + fmt1(rep.after.lufs) + ' LUFS · true peak ' + fmt1(rep.after.truePeakDb) + ' dBTP.' + (rep.after.lufs < -18 ? ' Tip: choose Master > Streaming for a louder, release-ready file.' : '');
      else {
        const tgt = window.TapeheadDSP && window.TapeheadDSP.PRESETS[rep.preset] ? window.TapeheadDSP.PRESETS[rep.preset].targetLufs : null;
        const short = tgt != null && rep.after.lufs < tgt - 0.5;
        repEl.textContent = 'Mastered: ' + fmt1(rep.before.lufs) + ' → ' + fmt1(rep.after.lufs) + ' LUFS (' + (rep.gainDb >= 0 ? '+' : '') + fmt1(rep.gainDb) + ' dB), true peak ' + fmt1(rep.after.truePeakDb) + ' dBTP.'
          + (short ? ' Target ' + tgt + ' LUFS not reached: going louder would need heavy limiting. Lower the drum level or choose a quieter target.' : (rep.reductionDb > 6 ? ' Heavy limiting (' + fmt1(rep.reductionDb) + ' dB): lower the drum level for a cleaner result.' : ''));
      }
    }
    toast(blob.type === 'audio/mpeg' ? 'Full mix bounced — MP3' : (mp3Failed ? 'Full mix bounced — WAV (MP3 unavailable)' : 'Full mix bounced — multi-bus WAV'));
    try { updatePublishChecklist(); } catch (e) {}
    setTimeout(hideBounceProgress, 1800);
    return blob;
  } catch (err) {
    console.warn(err);
    hideBounceProgress();
    toast('Bounce failed — try again');
    return null;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🎧 Bounce Full Mix'; }
    if (stemsBtn) stemsBtn.disabled = false;
  }
}
async function doExportStems() {
  const q = document.getElementById('bounceQuality')?.value || 'standard';
  const loops = q === 'high' ? 4 : q === 'draft' ? 1 : 2;
  const btn = document.getElementById('stemsBtn');
  const mixBtn = document.getElementById('mixdownBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Exporting stems…'; }
  if (mixBtn) mixBtn.disabled = true;
  setBounceProgress(5, 'Preparing stem renders…');
  toast('Exporting stems (separate WAVs)…');
  try {
    await bounceStems(loops);
    setBounceProgress(100, 'Stems downloaded');
    toast('Stem pack ZIP downloaded');
    setTimeout(hideBounceProgress, 2000);
  } catch (err) {
    console.warn(err);
    hideBounceProgress();
    toast('Stem export failed');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🎚 Export Stems (ZIP)'; }
    if (mixBtn) mixBtn.disabled = false;
  }
}

async function publishWithMixdown() {
  if (!state.mixdownBlob) {
    try { await doMixdown(); } catch (e) {}
  }
  // attach mixdown to next publish via state
  openPublish();
  const vocalCb = document.getElementById('shareVocal');
  if (vocalCb) vocalCb.checked = true;
  const beatCb = document.getElementById('shareBeat');
  if (beatCb) beatCb.checked = true;
}


function patternHasHits() {
  const p = state.pattern || {};
  return ['kick','snare','hat','clap'].some(t => Array.isArray(p[t]) && p[t].some(Boolean));
}

function ensureRecordBed() {
  ensurePatternLength(state.stepCount || 16);
  if (!patternHasHits()) {
    // minimal 4-on-floor + snare so record is never silent
    const n = state.stepCount || 16;
    state.pattern = state.pattern || {};
    state.pattern.kick = Array.from({ length: n }, (_, i) => (i % 4 === 0 ? 1 : 0));
    state.pattern.snare = Array.from({ length: n }, (_, i) => (i % 8 === 4 ? 1 : 0));
    state.pattern.hat = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 1 : 0));
    state.pattern.clap = Array.from({ length: n }, () => 0);
    return 'auto';
  }
  return 'ok';
}

function updateRecBeatBedUI() {
  const meta = document.getElementById('recBeatBedMeta');
  const box = document.getElementById('recBeatBed');
  if (!meta) return;
  const hits = patternHasHits();
  const bpm = state.bpm || 120;
  const kit = state.kit || 'trap';
  const steps = state.stepCount || 16;
  const chords = (state.detectedChords || []).length
    ? (state.detectedChords.slice(0, 4).join(' – '))
    : 'none yet (Keys optional)';
  if (!hits) {
    if (box) box.classList.add('warn');
    meta.innerHTML = '<strong>No beat steps yet.</strong> Go to Beat and tap pads, or press <strong>Use simple bed</strong> so you have something to sing over.';
  } else {
    if (box) box.classList.remove('warn');
    meta.innerHTML = '<strong>' + String(kit).toUpperCase() + '</strong> · <strong>' + bpm + ' BPM</strong> · ' + steps + ' steps<br>Chords: ' + chords + '<br>This loop plays in your ears when you press REC.';
  }
  const bl = document.getElementById('recBpmLabel');
  if (bl) bl.textContent = bpm + ' BPM · ' + kit;
}

function auditionRecordBed() {
  try {
    unlockAudio();
    ensureRecordBed();
    updateRecBeatBedUI();
    state._recMonitor = {
      click: document.getElementById('recMetronome')?.checked !== false,
      chords: true
    };
    if (state.playing) {
      stopTransport();
      const btn = document.getElementById('recAuditionBedBtn');
      if (btn) btn.textContent = '▶ Hear beat';
      setRecStatus('Beat stopped');
    } else {
      startTransport();
      const btn = document.getElementById('recAuditionBedBtn');
      if (btn) btn.textContent = '■ Stop beat';
      setRecStatus('Beat playing — this is your record bed');
    }
  } catch (e) {
    toast('Could not play beat');
  }
}

function applyQuickRecordBed() {
  state.stepCount = 16;
  ensurePatternLength(16);
  state.pattern.kick  = [1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0];
  state.pattern.snare = [0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0];
  state.pattern.hat   = [1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0];
  state.pattern.clap  = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];
  if (!(state.detectedChords || []).length) {
    state.detectedChords = ['C', 'G', 'Am', 'F'];
  }
  try { buildTracks(); } catch (e) {}
  try { saveCurrentSong(); } catch (e) {}
  updateRecBeatBedUI();
  toast('Simple bed loaded — Hear beat, then REC');
  setRecStatus('Simple bed ready — headphones on, then REC');
}

async function startVocalRecord() {
  // Guest can record locally; cloud upload still requires sign-in elsewhere
  try {
    unlockAudio();
    try { await ensureAudio().resume(); } catch (e) {}
    const bed = ensureRecordBed();
    updateRecBeatBedUI();
    state._recMonitor = {
      click: document.getElementById('recMetronome')?.checked !== false,
      chords: true,
      drums: true
    };
    setRecStatus(bed === 'auto' ? 'No beat found — using a simple bed…' : 'Starting beat + mic…');
    // Start instrumental FIRST so user hears the bed
    if (state.playing) try { stopTransport(); } catch (e) {}
    try { startTransport(); } catch (e) { console.warn(e); }
    await new Promise(r => setTimeout(r, 350));
    const inputStream = await getMusicMicStream();
    const stream = buildVocalCapture(inputStream);
    _vocalChunks = [];
    const mime = chooseVocalMime();
    _vocalRec = createVocalRecorder(stream, mime);
    _vocalRec.ondataavailable = e => { if (e.data.size) _vocalChunks.push(e.data); };
    _vocalRec.onstop = () => {
      cleanupVocalCapture();
      const blob = new Blob(_vocalChunks, { type: mime || 'audio/webm' });
      const url = URL.createObjectURL(blob);
      const sec = document.getElementById('recSection')?.value || 'verse';
      const take = {
        id: 't_' + Date.now().toString(36),
        blob, url,
        section: sec,
        offsetMs: Number.isFinite(state.recordDelayMs) ? state.recordDelayMs : 0,   // user/calibrated mic timing (negative = earlier)
        gapMs: state._recGapMs || 0,                                                // beat started this long before the recorder did
        barStart: (typeof getSectionBarInfo === 'function' ? getSectionBarInfo(sec).start : 1),
        gain: (state.volumes && state.volumes.vocal) || 0.9,
        reverb: 0.2,
        created: Date.now(),
        bpm: state.bpm,
        kit: state.kit,
        label: 'Take ' + nextTakeNumber()
      };
      state.vocalTakes = state.vocalTakes || [];
      state.vocalTakes.push(take);
      // Keep last 6 takes
      while (state.vocalTakes.length > 6) {
        const old = state.vocalTakes.shift();
        try { if (old && old.url) URL.revokeObjectURL(old.url); } catch (e) {}
      }
      state.vocal = take; // active take
      renderVocalTakes();
      setRecStatus(take.label + ' saved · ' + (state.kit || 'beat') + ' @ ' + (state.bpm || 120) + ' BPM');
      analyzeTakeLevels(blob).then(adv => {
        if (!adv) return;
        take.advice = adv;
        if (adv.text && state.vocal === take) setRecStatus(take.label + ' saved · ⚠ ' + adv.text);
        try { renderVocalTakes(); } catch (e) {}
      });
      try { buildChannelStrip(); } catch (e) {}
      try { saveCurrentSong(); } catch (e) {}
      const btn = document.getElementById('recAuditionBedBtn');
      if (btn) btn.textContent = '▶ Hear beat';
    };
    // The beat is already playing (it started before the microphone was opened). Record how far ahead it is, on the audio
    // clock, so the take can be placed where it was actually sung instead of at the start of its section.
    state._recGapMs = (audioCtx && state.playing && Number.isFinite(state._beatT0)) ? Math.max(0, Math.round((audioCtx.currentTime - state._beatT0) * 1000)) : 0;
    _vocalRec.start(100);
    document.getElementById('vocalRecBtn')?.classList.add('rec-on');
    setRecStatus('● Clean vocal capture · ' + (state.kit || 'beat') + ' @ ' + (state.bpm || 120) + ' BPM — sing now');
    startRecWave(stream);
  } catch (e) {
    console.warn(e);
    toast('Mic permission needed');
    setRecStatus('Mic blocked — allow microphone in browser settings');
    try { if (state.playing) stopTransport(); } catch (err) {}
  }
}

function stopVocalRecord() {
  if (_vocalRec && _vocalRec.state !== 'inactive') _vocalRec.stop();
  else cleanupVocalCapture();
  _vocalRec = null;
  document.getElementById('vocalRecBtn')?.classList.remove('rec-on');
  stopRecWave();
  if (state.playing) try { stopTransport(); } catch (e) {}
}

function toggleVocalRecord() {
  if (_vocalRec && _vocalRec.state === 'recording') stopVocalRecord();
  else startVocalRecord();
}

function setRecStatus(msg) {
  const el = document.getElementById('recStatus');
  if (el) el.textContent = msg;
}

/* Next take number: one more than the highest existing number (the list keeps only the last 6 takes). */
function nextTakeNumber() {
  let max = 0;
  (state.vocalTakes || []).forEach(t => { const m = /^Take (\d+)$/.exec(t && t.label || ''); if (m) max = Math.max(max, parseInt(m[1], 10)); });
  return Math.max(max, (state.vocalTakes || []).length) + 1;
}
/** Decode a finished take and report clipping / very quiet / silent recordings so the artist can fix it before mixing. */
async function analyzeTakeLevels(blob) {
  const DSP = window.TapeheadDSP; if (!DSP || !blob) return null;
  try {
    const c = ensureAudio(), buf = await c.decodeAudioData(await blob.arrayBuffer());
    const adv = DSP.takeAdvice(DSP.analyzeLevels(buf.getChannelData(0)));
    adv.levels = DSP.analyzeLevels(buf.getChannelData(0));
    return adv;
  } catch (e) { return null; }
}

function startRecWave(stream) {
  try {
    const c = ensureAudio();
    const src = c.createMediaStreamSource(stream);
    const an = c.createAnalyser();
    an.fftSize = 256;
    src.connect(an);
    const canvas = document.getElementById('recWaveCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const buf = new Uint8Array(an.frequencyBinCount);
    function draw() {
      _recWaveRAF = requestAnimationFrame(draw);
      an.getByteTimeDomainData(buf);
      const w = canvas.width = canvas.clientWidth || 300;
      const h = canvas.height = 48;
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--panel2') || '#16161c';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#f87171';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < buf.length; i++) {
        const x = (i / buf.length) * w;
        const y = (buf[i] / 255) * h;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    draw();
    state._recAnalyser = { src, an };
  } catch (e) {}
}
function stopRecWave() {
  if (_recWaveRAF) cancelAnimationFrame(_recWaveRAF);
  _recWaveRAF = null;
}

function renderVocalTakes() {
  const el = document.getElementById('vocalTakes');
  if (!el) return;
  const takes = state.vocalTakes || [];
  if (!takes.length && !state.vocal) {
    el.innerHTML = '<div class="empty-state" style="padding:12px"><div class="es-icon">🎙</div><p style="font-size:12px;margin:0">No takes yet — hit REC over your beat</p></div>';
    return;
  }
  // migrate single vocal if needed
  if (!takes.length && state.vocal) {
    state.vocalTakes = [state.vocal];
  }
  const activeId = state.vocal && state.vocal.id;
  el.innerHTML = '<div class="vocal-takes-list">' + (state.vocalTakes || []).map((v, i) => {
    const active = (activeId && v.id === activeId) || (!activeId && i === state.vocalTakes.length - 1);
    const when = v.created ? new Date(v.created).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '';
    return `<div class="vocal-take-item ${active ? 'active' : ''}" data-take="${esc(v.id)}">
      <div class="vt-meta"><strong>${esc(v.label || ('Take ' + (i+1)))}</strong> · ${esc(v.section || 'verse')} · ${when}<br><span class="text-dim">${v.offsetMs|0}ms nudge · ${v.bpm||state.bpm} BPM</span>${v.advice && v.advice.text ? `<br><span class="vt-warn" data-advice="${esc(v.advice.level)}">⚠ ${esc(v.advice.text)}</span>` : ''}</div>
      <div class="vt-actions">
        <button type="button" class="btn" data-take-play="${esc(v.id)}" style="padding:4px 8px;font-size:11px">▶</button>
        <button type="button" class="btn ${active?'pri':''}" data-take-use="${esc(v.id)}" style="padding:4px 8px;font-size:11px">${active?'Active':'Use'}</button>
      </div>
    </div>`;
  }).join('') + '</div>';
}
function selectVocalTake(id) {
  const t = (state.vocalTakes || []).find(x => x.id === id);
  if (!t) return;
  state.vocal = t;
  renderVocalTakes();
  try { buildChannelStrip(); } catch (e) {}
  try { saveCurrentSong(); } catch (e) {}
  toast((t.label || 'Take') + ' is active for Mix');
}
function playVocalTakeById(id) {
  const t = (state.vocalTakes || []).find(x => x.id === id) || state.vocal;
  if (!t || !t.url) { toast('No take to play'); return; }
  try {
    if (_vocalAudio) { _vocalAudio.pause(); _vocalAudio = null; }
    _vocalAudio = new Audio(t.url);
    _vocalAudio.volume = state.volumes.vocal || 0.9;
    _vocalAudio.play();
  } catch (e) { toast('Could not play take'); }
}

function playVocalTake() {
  if (!state.vocal?.url) { toast('Record a take first'); return; }
  try {
    if (_vocalAudio) { _vocalAudio.pause(); _vocalAudio = null; }
    _vocalAudio = new Audio(state.vocal.url);
    _vocalAudio.volume = state.volumes.vocal || 0.9;
    _vocalAudio.play();
  } catch (e) { toast('Could not play take'); }
}

function nudgeVocal(ms) {
  if (!state.vocal) return;
  state.vocal.offsetMs = (state.vocal.offsetMs || 0) + ms;
  renderVocalTakes();
  saveCurrentSong();
}

async function bounceMixdown() {
  // Prefer full multi-bus bounce; fall back to Mix view if unavailable
  try {
    if (typeof doMixdown === 'function') {
      const blob = await doMixdown();
      return blob || null;
    }
  } catch (e) { console.warn('bounceMixdown', e); }
  try { setView('mix'); } catch (e) {}
  toast('Open Mix → Bounce Full Mix');
  return state.vocal?.blob || null;
}

function publishFullSong() {
  if (!state.user) { requireAuth(); return; }
  const title = (document.getElementById('songTitle')?.value || '').trim();
  if (!title || title === 'Untitled Session') {
    toast('Set a real title before publishing');
    return;
  }
  // use existing publish path + vocal flag
  state._publishHasVocal = !!(state.vocal && state.vocal.url);
  if (typeof publishCurrentToFeed === 'function') publishCurrentToFeed();
  else if (typeof openPublish === 'function') openPublish();
  else toast('Open Mix → Publish Session');
}


function gatherPublishPayload() {
  const title = (document.getElementById('songTitle')?.value || 'Untitled').trim();
  const lyricsEl = document.getElementById('lyrics');
  let lyrics = lyricsEl ? lyricsEl.value : '';
  try {
    if (typeof sectionsToLyrics === 'function') {
      const s = sectionsToLyrics();
      if (s && s.trim()) lyrics = s;
    }
  } catch (e) {}
  const hook = (document.getElementById('songHook')?.value || '').trim();
  const includeLyrics = document.getElementById('shareLyrics')?.checked !== false;
  const includeBeat = document.getElementById('shareBeat')?.checked !== false;
  const includeKeys = document.getElementById('shareKeys')?.checked !== false;
  const includeMix = document.getElementById('shareMix')?.checked !== false;
  const includeVocal = !!document.getElementById('shareVocal')?.checked;
  const openCollab = !!document.getElementById('shareOpenCollab')?.checked;
  const caption = (document.getElementById('publishCaption')?.value || '').trim();

  return {
    title,
    caption,
    lyrics: includeLyrics ? lyrics : '',
    hook: includeLyrics ? hook : '',
    bpm: state.bpm,
    kit: includeBeat ? state.kit : null,
    pattern: includeBeat && state.pattern ? JSON.parse(JSON.stringify(state.pattern)) : null,
    stepCount: includeBeat ? (state.stepCount || 16) : null,
    key: includeKeys ? ((document.getElementById('songKey')||{}).value || '') : '',
    mood: (document.getElementById('songMood')||{}).value || '',
    chords: includeKeys ? (state.detectedChords || []).slice() : [],
    volumes: includeMix ? JSON.parse(JSON.stringify(state.volumes || {})) : null,
    hasVocal: includeVocal && !!(state.vocal && state.vocal.url),
    vocalMeta: includeVocal && state.vocal ? {
      section: state.vocal.section,
      offsetMs: (state.vocal.offsetMs || 0) + (state.vocal.gapMs || 0),
      reverb: state.vocal.reverb
    } : null,
    openToCollab: openCollab,
    parts: {
      lyrics: includeLyrics,
      beat: includeBeat,
      keys: includeKeys,
      mix: includeMix,
      vocal: includeVocal && !!(state.vocal && state.vocal.url)
    }
  };
}


function updatePublishChecklist() {
  const el = document.getElementById('publishChecklist');
  const title = (document.getElementById('songTitle')?.value || '').trim();
  let lyrics = (document.getElementById('lyrics')?.value || '');
  try {
    if (typeof sectionsToLyrics === 'function') {
      const s = sectionsToLyrics();
      if (s) lyrics = s;
    }
  } catch (e) {}
  const hook = (document.getElementById('songHook')?.value || '').trim();
  const hasVerse = /\[verse/i.test(lyrics) || lyrics.split('\n').filter(Boolean).length >= 4;
  const hasChorus = /\[chorus/i.test(lyrics) || !!hook || /chorus/i.test(lyrics);
  const beatOk = !!(state.pattern && Object.values(state.pattern).some(a => Array.isArray(a) && a.some(x => x)));
  const master = state.volumes?.master != null ? state.volumes.master : 0.78;
  const items = [
    [title && !/^untitled/i.test(title), 'Title set'],
    [hasVerse && hasChorus, 'Lyrics have verse + chorus'],
    [beatOk, 'Beat rendered'],
    [master < 0.95, 'Mix not clipping'],
    [!!(state.vocal||state.mixdownBlob||(state.pattern&&Object.values(state.pattern).some(a=>Array.isArray(a)&&a.some(x=>x)))), 'Sound ready']
  ];
  if (el) {
    el.innerHTML = items.map(([ok, label]) =>
      `<div class="checklist-item ${ok ? 'ok' : ''}"><span class="ck">${ok ? '✓' : ''}</span>${label}</div>`
    ).join('');
  }
  const allOk = items.every(x => x[0]);
  const pub = document.getElementById('publishBtn');
  if (pub) {
    pub.disabled = !allOk;
    pub.style.opacity = allOk ? '1' : '0.5';
    pub.title = allOk ? 'Publish to Feed' : 'Complete the checklist first';
  }
  return allOk;
}

function openPublish() {
  if (!state.user) { openAuth('signin'); return; }
  try { saveCurrentSong(); } catch (e) {}
  try { closeSidebar(); } catch (e) {}
  const vocalCb = document.getElementById('shareVocal');
  if (vocalCb) {
    vocalCb.checked = !!(state.vocal && (state.vocal.url || state.vocal.blob));
    vocalCb.disabled = !(state.vocal && (state.vocal.url || state.vocal.blob));
  }
  const beatCb = document.getElementById('shareBeat');
  if (beatCb) {
    const has = state.pattern && ['kick','snare','hat','clap'].some(t => (state.pattern[t]||[]).some(Boolean));
    beatCb.checked = !!has;
  }
  const collabCb = document.getElementById('shareOpenCollab');
  if (collabCb) {
    try {
      const u = loadUsers()[state.user.contact];
      collabCb.checked = !!(u && u.openToCollab);
    } catch (e) {}
  }
  try { refreshPublishPreview(); } catch (e) {}
  const modal = document.getElementById('publishModal');
  if (modal) {
    modal.classList.add('show');
    modal.style.display = 'flex';
    modal.style.opacity = '1';
    modal.style.pointerEvents = 'auto';
  } else {
    toast('Publish sheet missing — re-upload index.html');
  }
}

function refreshPublishPreview() {
  const p = gatherPublishPayload();
  const lines = [];
  lines.push(p.title);
  if (p.caption) lines.push(p.caption);
  lines.push('');
  lines.push((p.bpm || 120) + ' BPM' + (p.kit ? ' · ' + p.kit : '') + (p.key ? ' · Key ' + p.key : ''));
  if (p.chords && p.chords.length) lines.push('Chords: ' + p.chords.join(' – '));
  if (p.hook) lines.push('Hook: ' + p.hook);
  if (p.lyrics) {
    lines.push('');
    lines.push(p.lyrics.slice(0, 400) + (p.lyrics.length > 400 ? '…' : ''));
  }
  const flags = [];
  if (p.parts.lyrics) flags.push('Lyrics');
  if (p.parts.beat) flags.push('Beat');
  if (p.parts.keys) flags.push('Keys');
  if (p.parts.mix) flags.push('Mix');
  if (p.parts.vocal) flags.push('Vocal');
  lines.push('');
  lines.push('Sharing: ' + (flags.join(', ') || 'nothing selected'));
  const ta = document.getElementById('publishPreview');
  if (ta) ta.textContent = lines.join('\n');
  const sub = document.getElementById('publishSub');
  if (sub) sub.textContent = flags.length ? ('Ready · ' + flags.join(' + ')) : 'Select what to share';
  const st = document.getElementById('shareCardTitle');
  if (st) st.textContent = p.title || 'Untitled session';
  const sm = document.getElementById('shareCardMeta');
  if (sm) sm.textContent = (p.bpm || 120) + ' BPM' + (p.kit ? ' · ' + p.kit : '') + (p.key ? ' · ' + p.key : '');
  const sh = document.getElementById('shareCardHook');
  if (sh) sh.textContent = p.hook ? ('"' + p.hook + '"') : (p.caption || '');
  const sp = document.getElementById('shareCardParts');
  if (sp) sp.innerHTML = flags.map(f => '<span>' + f + '</span>').join('') || '<span class="text-dim">Nothing selected</span>';
}

function publishCurrentToFeed() {
  if (!state.user) { toast('Sign in to post to the Feed'); openAuth('signin'); return; }
  const payload = gatherPublishPayload();
  if (!payload.parts.lyrics && !payload.parts.beat && !payload.parts.keys && !payload.parts.vocal && !payload.parts.mix) {
    toast('Select at least one thing to share');
    return;
  }
  if (/^untitled/i.test(payload.title || '')) {
    toast('Give your song a title first');
    return;
  }
  if (state._publishing) return;
  state._publishing = true;
  toast('Posting…');
  Promise.resolve().then(async () => {
   try {
    let vocalPack = null;
    if (payload.parts.vocal && state.vocal) {
      vocalPack = await captureVocalForFeed();
      if (vocalPack && vocalPack.tooLarge) {
        toast('Vocal too large for local Feed — posting beat + lyrics');
        vocalPack = null;
      }
    }
    const social = loadSocial();
    social.feed = social.feed || [];
    const id = 'pub_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const entry = {
      id,
      songId: state.currentSongId || null,
      userId: state.user.cloudId || state.user.id,
      username: state.user.username,
      avatar: state.user.avatar || null,
      title: payload.title,
      caption: payload.caption,
      lyrics: payload.lyrics,
      hook: payload.hook,
      bpm: payload.bpm || state.bpm || 120,
      kit: payload.kit || state.kit,
      pattern: payload.pattern || (payload.parts.beat ? JSON.parse(JSON.stringify(state.pattern)) : null),
      stepCount: payload.stepCount || state.stepCount || 16,
      key: payload.key,
      mood: payload.mood,
      chords: payload.chords || [],
      volumes: payload.volumes,
      hasVocal: !!(vocalPack && vocalPack.dataUrl) || payload.hasVocal,
      vocalData: vocalPack && vocalPack.dataUrl ? vocalPack.dataUrl : null,
      vocalMeta: vocalPack ? { section: vocalPack.section, offsetMs: vocalPack.offsetMs } : payload.vocalMeta,
      openToCollab: payload.openToCollab,
      parts: Object.assign({}, payload.parts, { vocal: !!(vocalPack && vocalPack.dataUrl) }),
      hasSound: !!(payload.pattern || (vocalPack && vocalPack.dataUrl) || (payload.chords || []).length || state.mixdownUrl),
      fullSong: !!(state.mixdownBlob || (payload.pattern && vocalPack && vocalPack.dataUrl)),
      mixdownUrl: state.mixdownUrl || null,
      updated: Date.now()
    };
    // strip huge fields if storage fails
    try {
      social.feed.unshift(entry);
      if (social.feed.length > 60) social.feed = social.feed.slice(0, 60);
      saveSocial(social);
    } catch (err) {
      entry.vocalData = null;
      entry.hasVocal = false;
      social.feed = social.feed || [];
      social.feed.unshift(entry);
      try { saveSocial(social); } catch (e2) {
        toast('Storage full — could not post');
        return;
      }
      toast('Posted (vocal skipped — storage limit)');
    }
    // Show the post right away; sync to the cloud in the background.
    closePublish();
    try { setView('community'); renderCommunityFeed(); } catch (e) {}
    if (typeof Cloud !== 'undefined' && Cloud.isCloud && Cloud.isCloud() && Cloud.publishFeed) {
      toast('Posted to Feed');
      const undo = (msg) => {
        try {
          const s2 = loadSocial();
          s2.feed = (s2.feed || []).filter(x => x.id !== entry.id);
          saveSocial(s2);
          renderCommunityFeed();
        } catch (e) {}
        toast(msg);
      };
      try {
        const remote = await Cloud.publishFeed(entry);
        if (!remote || remote.ok === false) undo((remote && remote.error) || 'Could not publish to the Feed. Please try again.');
      } catch (e) {
        console.warn('publishFeed', e);
        undo('Could not publish to the Feed. Please try again.');
      }
    } else {
      toast('Posted to Feed');
    }
   } finally {
    state._publishing = false;
   }
  });
}

function nativeShareWork() {
  const p = gatherPublishPayload();
  const text = [p.title, p.caption, p.hook, (p.lyrics || '').slice(0, 280)].filter(Boolean).join('\n');
  if (navigator.share) {
    navigator.share({ title: p.title, text }).catch(() => {});
  } else {
    copyText(text).then(ok => { if (ok) toast('Copied to clipboard'); else toast('Share not available'); });
  }
}

function buildTracks(){
  if(!state.pattern)state.pattern={kick:[1,0,0,0,1,0,0,0],snare:[0,0,1,0,0,0,1,0],hat:[1,1,1,1,1,1,1,1],clap:[0,0,0,0,0,0,1,0]};
  ensurePatternLength(state.stepCount||16);
  const container=document.getElementById('tracks');if(!container)return;
  container.innerHTML='';container.style.setProperty('--steps',String(state.stepCount||16));
  TRACKS.forEach(t=>{
    const row=document.createElement('div');row.className='track';
    row.innerHTML=`<div class="t-name"><span class="t-icon">${t.icon}</span><span>${t.name}</span></div><div class="steps" data-track="${t.id}"></div><div class="fader-wrap"><div class="meter"><div class="meter-fill" data-track="${t.id}" style="width:12%"></div></div><input type="range" class="fader" data-vol="${t.id}" min="0" max="100" value="${Math.round(state.volumes[t.id]*100)}" aria-label="${t.name} volume"></div>`;
    const stepsEl=row.querySelector('.steps');const nSteps=state.stepCount||state.pattern[t.id].length||16;
    for(let i=0;i<nSteps;i++){
      const st=document.createElement('div');
      const value=Number(state.pattern[t.id][i])||0;
      st.className='st'+(value>0?' on':'')+(value>0&&value<.75?' soft':'')+(value>=.99?' accent':'')+(i%4===0?' bar':'');
      st.dataset.step=i;st.dataset.track=t.id;st.dataset.velocity=value;
      st.setAttribute('role','button');st.setAttribute('tabindex','0');
      st.setAttribute('aria-label',`${t.name} step ${i+1}: ${value<=0?'off':value<.75?'soft':value<.99?'normal':'accent'}`);
      const cycle=()=>{
        const cur=Number(state.pattern[t.id][i])||0;
        const next=cur<=0?.62:cur<.75?.86:cur<.99?1:0;
        state.pattern[t.id][i]=next;
        st.classList.toggle('on',next>0);st.classList.toggle('soft',next>0&&next<.75);st.classList.toggle('accent',next>=.99);st.dataset.velocity=next;
        st.setAttribute('aria-label',`${t.name} step ${i+1}: ${next<=0?'off':next<.75?'soft':next<.99?'normal':'accent'}`);
        if(next>0){try{unlockAudio();const t0=ensureAudio().currentTime+.005;const preview={kick:playKick,snare:playSnare,hat:playHat,clap:playClap}[t.id];if(preview)preview(t0,thAcc(t.id,i,next));}catch(e){}}
        saveCurrentSong();
        try{window.updateBeatPadHint&&window.updateBeatPadHint()}catch(e){}
      };
      st.addEventListener('click',cycle);st.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();cycle();}});
      stepsEl.appendChild(st);
    }
    container.appendChild(row);
  });
  container.querySelectorAll('.fader[data-vol]').forEach(f=>{f.addEventListener('input',()=>{state.volumes[f.dataset.vol]=f.value/100;try{syncLiveGraphLevels()}catch(e){};scheduleSave()})});
  try{window.updateBeatPadHint&&window.updateBeatPadHint()}catch(e){}
}

function buildChannelStrip(){
  const el = document.getElementById('channelStrip');
  if (!el) return;
  state.pan = state.pan || {kick:0,snare:0,hat:0,clap:0,chords:0,vocal:0};
  const rows = [
    {id:'kick',name:'Kick'},
    {id:'snare',name:'Snare'},
    {id:'hat',name:'Hi-Hat'},
    {id:'clap',name:'Clap'},
    {id:'chords',name:'Chords'},
    {id:'vocal',name:'Vocal'}
  ];
  el.innerHTML = rows.map(r => {
    const vol = Math.round((state.volumes[r.id] != null ? state.volumes[r.id] : 0.7) * 100);
    const pan = Math.round(((state.pan[r.id] != null ? state.pan[r.id] : 0) * 100));
    const muted = state.mute && state.mute[r.id];
    const solo = state.solo && state.solo[r.id];
    return `<div class="ch-row" data-ch="${r.id}">
      <span class="ch-name">${r.name}</span>
      <span class="ch-meter" role="meter" aria-label="${r.name} level" aria-valuemin="-60" aria-valuemax="0" aria-valuenow="-60" data-meter="${r.id}" data-db="-60"><i></i><b></b></span>
      <button type="button" class="chip ${muted?'on':''}" data-mute="${r.id}">M</button>
      <button type="button" class="chip ${solo?'on':''}" data-solo="${r.id}">S</button>
      <input type="range" class="fader" data-vol="${r.id}" min="0" max="100" value="${vol}" title="Level">
      <input type="range" class="fader pan-fader" data-pan="${r.id}" min="-100" max="100" value="${pan}" title="Pan L/R">
      ${r.id==='vocal'?'<input type="range" class="fader" data-reverb="vocal" min="0" max="100" value="'+Math.round((state.vocal&&state.vocal.reverb||0.2)*100)+'" title="Reverb">':''}
    </div>`;
  }).join('');
  el.querySelectorAll('[data-vol]').forEach(inp => {
    inp.addEventListener('input', () => {
      state.volumes[inp.dataset.vol] = inp.value / 100;
      if (inp.dataset.vol === 'vocal' && state.vocal) state.vocal.gain = state.volumes.vocal;
      try { syncLiveGraphLevels(); } catch (e) {}
      try { scheduleSave(); } catch (e) {}
    });
  });
  el.querySelectorAll('[data-pan]').forEach(inp => {
    inp.addEventListener('input', () => {
      state.pan = state.pan || {};
      state.pan[inp.dataset.pan] = Number(inp.value) / 100;
      try { syncLiveGraphLevels(); } catch (e) {}
      try { scheduleSave(); } catch (e) {}
    });
  });
  el.querySelectorAll('[data-mute]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.mute = state.mute || {};
      state.mute[btn.dataset.mute] = !state.mute[btn.dataset.mute];
      buildChannelStrip();
    });
  });
  el.querySelectorAll('[data-solo]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.solo = state.solo || {};
      state.solo[btn.dataset.solo] = !state.solo[btn.dataset.solo];
      buildChannelStrip();
    });
  });
  el.querySelectorAll('[data-reverb]').forEach(inp => {
    inp.addEventListener('input', () => {
      if (state.vocal) state.vocal.reverb = inp.value / 100;
    });
  });
  try { syncLiveGraphLevels(); } catch (e) {}
}

function buildWave(){const bars=document.getElementById('waveBars');if(!bars)return;bars.innerHTML='';for(let i=0;i<48;i++){const b=document.createElement('div');b.className='wave-bar';b.style.height=(12+Math.random()*28)+'px';bars.appendChild(b)}}
function saveCurrentSong(){if(!state.currentSongId)return;const song=state.songs.find(s=>s.id===state.currentSongId);if(!song)return;song.title=document.getElementById('songTitle').value||'Untitled Session';try{commitSectionEditor()}catch(e){}
    song.lyrics=syncLyricsHidden();
    song.hook=(document.getElementById('songHook')||{}).value||'';
    song.key=(document.getElementById('songKey')||{}).value||'';
    song.mood=(document.getElementById('songMood')||{}).value||'';
    song.ref=(document.getElementById('songRef')||{}).value||'';
    song.sections=JSON.parse(JSON.stringify(state.writeSections||[]));
    flashSaveDot();song.bpm=state.bpm;song.stepCount=state.stepCount||16;song.kit=state.kit;song.pattern=JSON.parse(JSON.stringify(state.pattern));song.swing=state.swing||0;song.volumes=JSON.parse(JSON.stringify(state.volumes||{}));song.pan=JSON.parse(JSON.stringify(state.pan||{}));song.eq=JSON.parse(JSON.stringify(state.eq||{low:50,mid:50,high:50}));song.glue=state.glue!=null?state.glue:40;song.chords=(state.detectedChords||[]).slice();song.sampleNames=JSON.parse(JSON.stringify(state.sampleNames||{}));song.arrangement=JSON.parse(JSON.stringify(ensureArrangement()));if(state.vocal){song.vocalMeta={section:state.vocal.section,offsetMs:state.vocal.offsetMs,reverb:state.vocal.reverb};}song.updated=Date.now();
    try {
      if (window.TapeheadContinuity && window.TapeheadContinuity.attachToSong) {
        window.TapeheadContinuity.attachToSong(song, state, {
          title: song.title, bpm: song.bpm, key: song.key, mood: song.mood, hook: song.hook,
          style: (document.getElementById('aiStyle')||{}).value || state.writeStyle,
          language: (document.getElementById('aiLanguage')||{}).value || state.language || 'English'
        });
      }
    } catch (e) { console.warn('[Tapehead] continuity attach', e); }
    persistSongs();renderSongList()}
function loadSong(id){
    const song=state.songs.find(s=>s.id===id);if(!song)return;
    state.currentSongId=id;
    const titleEl=document.getElementById('songTitle');if(titleEl)titleEl.value=song.title||'Untitled Session';
    const lyr=document.getElementById('lyrics');if(lyr)lyr.value=song.lyrics||'';
    const hk=document.getElementById('songHook');if(hk)hk.value=song.hook||'';
    const sk=document.getElementById('songKey');if(sk)sk.value=song.key||'';
    const sm=document.getElementById('songMood');if(sm)sm.value=song.mood||'';
    const sr=document.getElementById('songRef');if(sr)sr.value=song.ref||'';
    const sb=document.getElementById('songBpmNote');if(sb)sb.value=song.bpm||state.bpm||120;
    if(song.sections&&song.sections.length){state.writeSections=song.sections;state.writeSectionId=song.sections[0].id}
    else{lyricsToSections(song.lyrics||'')}
    try {
      if (window.TapeheadContinuity && window.TapeheadContinuity.restoreFromSong) {
        state._continuity = window.TapeheadContinuity.restoreFromSong(song, state);
        try{updateContinuityBadge()}catch(e2){}
      }
    } catch (e) { console.warn('[Tapehead] continuity restore', e); }
    try{showActiveSection()}catch(e){}
    state.bpm=song.bpm||120;
    const bpmEl=document.getElementById('bpmBadge');if(bpmEl)bpmEl.textContent=state.bpm+' BPM';
    const beatBpmEl=document.getElementById('beatBpmValue');if(beatBpmEl)beatBpmEl.textContent=String(state.bpm);
    if(song.pattern)state.pattern=song.pattern;
    if(song.kit)state.kit=song.kit;
    if(song.swing!=null){state.swing=song.swing;const ss=document.getElementById('swingSlider');if(ss)ss.value=song.swing;const sv=document.getElementById('swingVal');if(sv)sv.textContent=Math.round(song.swing)+'%';}
    if(song.volumes)state.volumes=Object.assign({},state.volumes||{},song.volumes);
    if(song.pan)state.pan=Object.assign({},state.pan||{},song.pan);
    if(song.eq)state.eq=Object.assign({low:50,mid:50,high:50},song.eq);
    if(song.glue!=null)state.glue=song.glue;
    if(song.chords&&song.chords.length)state.detectedChords=song.chords.slice();
    if(song.sampleNames)state.sampleNames=song.sampleNames;if(song.arrangement)state.arrangement=song.arrangement;
    try{setEqUIFromState();syncLiveGraphLevels()}catch(e){}
    try{buildTracks()}catch(e){console.warn(e)}
    try{if(document.getElementById('channelStrip'))buildChannelStrip()}catch(e){}
    renderSongList();
    try{updateProjectContext(true)}catch(e){}
  }
function newSong(){
  if(!state.user && !state.guest){requireAuth();return;}
  if(state.user && !canCreateProject())return;
  // Guests get one local working project without paywall pressure
  if(state.guest && !state.user && (state.songs||[]).length >= 1){
    // reuse existing guest song if present
    if(state.songs[0]){ loadSong(state.songs[0].id); try{closeSidebar()}catch(e){} return; }
  }
const id=makeStableId('s_'),song={id,title:autoNameProject({kit:state.kit,bpm:state.bpm,updated:Date.now()}),lyrics:'',bpm:state.bpm||120,kit:state.kit||'trap',stepCount:16,pattern:{kick:[1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0],snare:[0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0],hat:[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],clap:[0,0,0,0,0,0,1,0,0,0,0,0,0,0,1,0]},updated:Date.now()};state.songs.unshift(song);persistSongs();loadSong(id);try{closeSidebar()}catch(e){}}
function renderSongList(){const list=document.getElementById('songList');if(!list)return;list.innerHTML='';
  const pc=document.getElementById('projectCount');
  if(pc){const n=(state.songs||[]).length;pc.textContent=isPro()? (n+' project'+(n===1?'':'s')) : (n+' / '+FREE_PROJECT_LIMIT+' project'+(FREE_PROJECT_LIMIT===1?'':'s'));}
if(!state.songs.length){list.innerHTML='<div class="text-dim" style="padding:12px;text-align:center;font-size:12px">No projects yet</div>';return}state.songs.forEach(s=>{const item=document.createElement('div');item.className='song-item'+(s.id===state.currentSongId?' active':'');const date=new Date(s.updated).toLocaleDateString(undefined,{month:'short',day:'numeric'});item.innerHTML=`<div class="title">${esc(s.title)}</div><div class="meta">${Number(s.bpm)||120} BPM · ${date}</div>`;item.addEventListener('click',()=>{loadSong(s.id);closeSidebar()});list.appendChild(item)})}



/* ── AI Lyrics Engine (prompt / first-lines aware) ── */
const MOOD_BANK = {
  love: {
    words: ['heart','love','kiss','arms','together','forever','darling','hold','you','us'],
    lines: [
      'Your name still soft on my tongue',
      'I find you in every quiet room',
      'We were written in the same breath',
      'Come closer, the night is ours',
      'I loved you in the spaces between'
    ],
    chorus: [
      'Stay with me through the fall',
      'We are the only light I need',
      'Don\'t let this moment leave',
      'Love me like the first time again'
    ]
  },
  heartbreak: {
    words: ['gone','left','alone','tears','miss','empty','broke','goodbye','hurt','lost'],
    lines: [
      'The door still remembers your name',
      'I keep replaying what we said',
      'Silence sits where you used to be',
      'I wore your absence like a coat',
      'Every street leads back to you'
    ],
    chorus: [
      'You left the light on in my chest',
      'I\'m still learning how to let go',
      'We were fire, then only smoke',
      'Don\'t call — I already know'
    ]
  },
  night: {
    words: ['night','dark','moon','stars','city','street','midnight','shadow','sleep','dream'],
    lines: [
      'Streetlights paint the empty road',
      'The city hums a lonely tune',
      'Midnight holds what daylight hides',
      'I walk until the sky turns blue',
      'Neon signs know all my secrets'
    ],
    chorus: [
      'Under the same cold moon',
      'We were ghosts in the glow',
      'Night never asks for permission',
      'I belong to the after-hours'
    ]
  },
  hope: {
    words: ['rise','hope','light','new','morning','believe','tomorrow','sun','free','start'],
    lines: [
      'Morning finds me still standing',
      'I fold the dark into a map',
      'Something brighter is coming',
      'I plant a seed in the cracks',
      'The horizon keeps its promise'
    ],
    chorus: [
      'We rise again, we always do',
      'Hold on — the light is near',
      'This is not the end of us',
      'Tomorrow already knows my name'
    ]
  },
  party: {
    words: ['dance','party','bass','club','night','move','body','rhythm','drink','vibe'],
    lines: [
      'The bass is in my bloodstream',
      'Bodies move like liquid gold',
      'Don\'t stop until the lights come up',
      'This floor was made for us',
      'Feel the drop, forget the rest'
    ],
    chorus: [
      'Dance until we disappear',
      'Turn it up, we\'re not done',
      'One more song, one more night',
      'Lose yourself in the sound'
    ]
  },
  default: {
    words: [],
    lines: [
      'I still feel the weight of it all',
      'Words we left hanging in the air',
      'Time moves but I stay the same',
      'There\'s a story under my skin',
      'I write what I cannot say'
    ],
    chorus: [
      'We were fire in the rain',
      'Nothing ever stays the same',
      'I still taste the summer',
      'Hold your breath, the drop is coming'
    ]
  }
};


function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function rhymeHint(line) {
  const last = (line.trim().split(/\s+/).pop() || '').replace(/[^a-z]/gi, '').toLowerCase();
  const map = {
    me: ['see', 'free', 'be', 'key'], you: ['true', 'through', 'blue', 'new'],
    night: ['light', 'right', 'sight', 'fight'], heart: ['start', 'part', 'art', 'dark'],
    love: ['enough', 'above', 'of', 'touch'], gone: ['on', 'song', 'long', 'wrong'],
    day: ['away', 'stay', 'way', 'say'], time: ['mine', 'line', 'fine', 'sign']
  };
  for (const [k, v] of Object.entries(map)) {
    if (last.endsWith(k) || last === k) return pick(v);
  }
  return pick(['again', 'away', 'tonight', 'inside', 'alone']);
}


function improveSeed(seed) {
  return String(seed || '').trim().replace(/\s+/g, ' ').slice(0, 1200);
}

function getAiOptions() {
  const mood = (document.getElementById('songMood')?.value || '').trim();
  const key = (document.getElementById('songKey')?.value || '').trim();
  const bpm = parseInt(document.getElementById('songBpmNote')?.value || state.bpm || 120, 10) || 120;
  return {
    style: document.getElementById('aiStyle')?.value || 'contemporary',
    language: document.getElementById('aiLanguage')?.value || 'English',
    length: Math.min(12, Math.max(4, parseInt(document.getElementById('aiLength')?.value || 8, 10) || 8)),
    mood,
    key,
    bpm
  };
}

function detectMood(text) {
  const t = (text || '').toLowerCase();
  const keys = {
    love: ['love','heart','kiss','darling','together','baby','romance'],
    heartbreak: ['gone','leave','broke','tears','lonely','miss','goodbye'],
    faith: ['god','pray','believe','grace','bless','faith','church'],
    hype: ['fire','night','dance','club','party','turn','energy'],
    night: ['night','moon','dark','city','drive','street','neon'],
    joy: ['happy','smile','sun','laugh','celebrate','win','joy'],
    struggle: ['hustle','struggle','pressure','pain','rise','survive']
  };
  let best = 'night', score = 0;
  for (const [k, words] of Object.entries(keys)) {
    const s = words.filter(w => t.includes(w)).length;
    if (s > score) { score = s; best = k; }
  }
  return best;
}

function localVerseLines(seed, mood, count) {
  count = count || 8;
  seed = (seed || '').trim() || 'the night';
  const banks = {
    love: ['I still hear your name when the room goes quiet','Every streetlight remembers the way you move','I turn the silence into something I can hold','If tomorrow comes I hope it comes with you','Two hearts can find a rhythm after the rain','Your voice turns a long road into home','I do not need forever, just this moment true','Stay close enough to hear what I cannot say'],
    heartbreak: ['I left the porch light on for a ghost that never came','Your shadow still knows every corner of this room','I practice goodbye but the words will not land','Some endings leave a melody under the skin','I learned the hard way that silence has a sound','The city keeps moving while I stand in yesterday','I am rebuilding slowly from the pieces you left','Maybe letting go is how I make room for light'],
    faith: ['I lift what I cannot carry into hands bigger than mine','Morning finds me believing through the dust','Even when the road is heavy I keep walking on','Grace meets me where my strength runs out','I have seen a little hope survive a heavy night','When I cannot see the way I trust the next step','My scars are proof that I made it through the fire','I sing because tomorrow is still being written'],
    hype: ['Bass in my bloodstream, city under my feet','We turn the night up until the morning speaks','No brakes on this feeling, let the tempo climb','Whole room moving like we own the time','Hands in the air, let the pressure disappear','From the first kick the whole place catches fire','We came for the moment, now the moment is ours','Run it back once more, let the speakers testify'],
    night: ['Neon on the windshield, quiet in my chest','Counting every mile between here and the rest','The radio knows secrets I have not said yet','Drive until the sky forgets what darkness meant','Streetlights draw a rhythm on the glass','City after midnight has a language of its own','I chase a little peace between the red lights','By sunrise I will know what this road was for'],
    joy: ['Sun on my shoulders and a pocket full of light','We laugh like the world has finally got it right','Every little win feels bigger in this air','Today I choose the feeling that will take me there','Good news travels faster when we sing it together','We made a way where yesterday saw none','Let the drums remind us how far we have come','If this is a dream, let the morning wait'],
    struggle: ['I learned to make a ladder from the weight on my back','Every closed door taught me how to build my own','Pressure made a diamond out of days I could not waste','I kept one spark alive when the whole room went cold','Now every small step sounds like victory','I carry where I came from without letting it hold me','The road was never easy but my feet learned the map','I am still here, and that is enough to start again']
  };
  const pool = banks[mood] || banks.night;
  const opener = seed.split(/[.?!\n]/)[0].trim().slice(0, 72);
  const lines = opener ? [opener] : [];
  const used = new Set(lines);
  for (let guard=0; lines.length<count && guard<100; guard++) {
    const pick=pool[Math.floor(Math.random()*pool.length)];
    if(!used.has(pick)){used.add(pick);lines.push(pick);}
  }
  return lines.slice(0,count);
}

function localChorus(seed, mood) {
  const short=(seed||'stay with me').split(/[.?!\n]/)[0].trim().slice(0,48)||'stay with me tonight';
  const hooks={
    love:[short,'Hold me close, let the whole world disappear',short,'We find our way back home'],
    heartbreak:[short,'I am learning how to leave you behind',short,'But your echo still lives in my mind'],
    faith:[short,'I still believe, even here, even now',short,'Grace will meet me somehow'],
    hype:[short,'Turn it up, let the whole room decide',short,'We came alive tonight'],
    night:[short,'Under these lights we come alive',short,'Hold the moment, let it ride'],
    joy:[short,'We made it here, so sing it out loud',short,'Let the joy rise above the crowd'],
    struggle:[short,'I will rise, I will rise again',short,'This is not where my story ends']
  };
  return hooks[mood]||hooks.night;
}

function applyLinesToSection(lines, mode) {
  ensureWriteSections();
  const block = (Array.isArray(lines) ? lines : [String(lines)]).join('\n');
  const ed = document.getElementById('sectionEditor');
  let sec = getActiveSection();
  if (mode === 'next') {
    const idx = state.writeSections.findIndex(s => s.id === (sec && sec.id));
    const empty = state.writeSections.slice(idx + 1).find(s => !(s.text || '').trim());
    if (empty) { sec = empty; state.writeSectionId = sec.id; }
    else if (idx < state.writeSections.length - 1) { sec = state.writeSections[idx + 1]; state.writeSectionId = sec.id; }
    else { addWriteSection(); sec = getActiveSection(); }
  }
  if (!sec) { sec = state.writeSections[0]; state.writeSectionId = sec.id; }
  sec.text = mode === 'replace' ? block : ((sec.text || '').trim() ? sec.text.trim() + '\n' + block : block);
  if (ed) ed.value = sec.text;
  showActiveSection();
  try { syncLyricsHidden(); } catch (e) {}
  try { scheduleSave(); } catch (e) {}
  return sec;
}

function setAiBusy(busy, label) {
  const ids=['aiFinishVerse','aiNextSection','aiPolish','aiHook','aiFullSong'];
  ids.forEach(id => { const b=document.getElementById(id); if(b) b.disabled=!!busy; });
  const badge=document.getElementById('aiEngineBadge');
  if(badge) badge.textContent=busy ? 'Thinking…' : (window._aiCloudReady ? 'Cloud AI' : 'Local fallback');
  setAiStatus(label || (busy ? 'AI is thinking…' : ''));
}

async function getAiAccessToken() {
  try {
    if (typeof Cloud !== 'undefined' && Cloud.ensureSession) {
      const session = await Cloud.ensureSession();
      return session?.access_token || '';
    }
  } catch (e) {}
  return '';
}

async function requestPremiumAI(action, source, extra={}) {
  const cfg = window.TAPEHEAD_CLOUD || {};
  const endpoint = cfg.aiApiUrl || '/api/ai';
  const token = await getAiAccessToken();
  if (!token) throw new Error('Sign in to use Cloud AI');
  let options=getAiOptions();
  try {
    if (window.TapeheadContinuity && typeof window.TapeheadContinuity.snapshot === 'function') {
      const hookVal = (document.getElementById('songHook')?.value || '').trim();
      const snap = window.TapeheadContinuity.snapshot(Object.assign({}, state, {
        writeKey: options.key, writeMood: options.mood, writeStyle: options.style, language: options.language
      }), { key: options.key, mood: options.mood, style: options.style, language: options.language, hook: hookVal, bpm: state.bpm });
      options = window.TapeheadContinuity.applyLocks(options, snap);
      if (typeof window.TapeheadContinuity.buildBrief === 'function') {
        options.continuityBrief = window.TapeheadContinuity.buildBrief(snap, action);
      }
      state._continuity = snap;
      try{updateContinuityBadge()}catch(e2){}
    }
  } catch (e) { console.warn('[Tapehead] continuity', e); }
  const body={
    action,
    prompt: improveSeed(source),
    context: improveSeed(extra.context || ''),
    section: extra.section || getActiveSection()?.label || 'Verse',
    lyrics: improveSeed(extra.lyrics || syncLyricsHidden()),
    hook: (document.getElementById('songHook')?.value || '').trim(),
    options
  };
  const res=await fetch(endpoint,{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
    body:JSON.stringify(body)
  });
  let data={};
  try{data=await res.json();}catch(e){}
  if(!res.ok) throw new Error(data.error || `AI request failed (${res.status})`);
  if(!data.text) throw new Error('AI returned no text');
  window._aiCloudReady=true;
  return data;
}

function applyFullSongText(text) {
  const normalized=String(text||'').replace(/\r/g,'').trim();
  if(!normalized) throw new Error('Empty song returned');
  if(/\[(Intro|Verse|Pre|Chorus|Bridge|Outro)/i.test(normalized)) {
    lyricsToSections(normalized);
  } else {
    const chunks=normalized.split(/\n{2,}/).filter(Boolean);
    ensureWriteSections();
    const labels=['Intro','Verse 1','Chorus','Verse 2','Bridge','Outro'];
    chunks.slice(0,labels.length).forEach((chunk,i)=>{state.writeSections[i].text=chunk.trim();});
  }
  const preferred = state.writeSections.find(s => /verse\s*1/i.test((s.label || '') + ' ' + (s.id || '')))
    || state.writeSections.find(s => /chorus/i.test((s.label || '') + ' ' + (s.id || '')))
    || state.writeSections[0];
  if (preferred) state.writeSectionId = preferred.id;
  showActiveSection();
  syncLyricsHidden();
  scheduleSave();
}

async function runAi(action) {
  if(!state.user){openAuth('signin');return;}
  ensureWriteSections();
  const g=getPromptOrSeed();
  const source=improveSeed(
    action === 'polish'
      ? (g.sectionText || g.lyrics || g.prompt || g.hook || '')
      : (g.prompt || g.sectionText || g.lyrics || g.hook || '')
  );
  if(!source && action!=='full_song'){
    toast('Add a prompt or write a few lines first');
    document.getElementById('aiPrompt')?.focus();
    return;
  }
  if(action==='full_song' && !source){
    toast('Describe the song you want to create first');
    document.getElementById('aiPrompt')?.focus();
    return;
  }
  const sec=getActiveSection();
  const context=sec ? sec.text : '';
  const fallbackMood=detectMood(source+' '+context);
  const fallbackCount=getAiOptions().length;
  setAiBusy(true, action==='full_song' ? 'Building a complete song…' : 'Writing with Cloud AI…');
  try{
    const data=await requestPremiumAI(action,source,{context,lyrics:g.lyrics});
    if(action==='full_song') applyFullSongText(data.text);
    else if(action==='hook') {
      const lines=String(data.text).split('\n').map(x=>x.trim()).filter(Boolean).slice(0,8);
      const hook=document.getElementById('songHook');
      if(hook) hook.value=lines[0]||data.text.trim().slice(0,120);
      const chorus=state.writeSections.find(s=>/chorus|hook/i.test(s.label+' '+s.id));
      if(chorus){chorus.text=lines.join('\n');state.writeSectionId=chorus.id;showActiveSection();syncLyricsHidden();scheduleSave();}
    } else {
      const lines=String(data.text).split('\n').map(x=>x.trim()).filter(Boolean);
      applyLinesToSection(lines, action==='next_section' ? 'next' : action==='polish' ? 'replace' : 'append');
    }
    setAiBusy(false, data.cached ? 'AI result reused' : 'Cloud AI ready');
    toast(action==='full_song'?'Full song created':action==='hook'?'Hook generated':action==='polish'?'Section polished':'Lyrics generated');
  }catch(err){
    console.warn('Cloud AI unavailable:',err);
    // Local songwriting fallback keeps Write usable if Cloud AI is briefly unavailable.
    const lines=action==='hook' ? localChorus(source,fallbackMood)
      : localVerseLines(source+' '+context,fallbackMood,fallbackCount);
    if(action==='full_song'){
      const mood=fallbackMood, hook=localChorus(source,mood);
      ensureWriteSections();
      state.writeSections.forEach(s=>{
        const lab=(s.label+' '+s.id).toLowerCase();
        if(lab.includes('intro')) s.text=hook[0];
        else if(lab.includes('chorus')) s.text=hook.join('\n');
        else if(lab.includes('verse 2')) s.text=localVerseLines(source+' second chapter',mood,8).join('\n');
        else if(lab.includes('verse')) s.text=localVerseLines(source,mood,8).join('\n');
        else if(lab.includes('bridge')) s.text=localVerseLines(source,mood,4).join('\n');
        else if(lab.includes('outro')) s.text=hook[0]+'\n'+hook[hook.length-1];
      });
      showActiveSection();syncLyricsHidden();scheduleSave();
    } else if(action==='hook'){
      const hook=document.getElementById('songHook');if(hook)hook.value=lines[0]||'';
      const chorus=state.writeSections.find(s=>/chorus|hook/i.test(s.label+' '+s.id));
      if(chorus){chorus.text=lines.join('\n');state.writeSectionId=chorus.id;}
      showActiveSection();syncLyricsHidden();scheduleSave();
    } else {
      applyLinesToSection(lines, action==='next_section'?'next':action==='polish'?'replace':'append');
    }
    window._aiCloudReady=false;
    setAiBusy(false,'Local writing mode · add API key for Cloud AI');
    toast('Local AI fallback used');
  } finally {
    setTimeout(()=>setAiStatus(''),3200);
  }
}

function aiFinishVerse(){ runAi('finish_verse'); }
function aiNextSection(){ runAi('next_section'); }
function aiPolish(){ runAi('polish'); }
function aiHookLab(){ runAi('hook'); }
function aiFullSong(){ runAi('full_song'); }

window.aiFinishVerse=aiFinishVerse;
window.aiNextSection=aiNextSection;
window.aiPolish=aiPolish;
window.aiHookLab=aiHookLab;
window.aiFullSong=aiFullSong;

function getPromptOrSeed() {
  try { if (typeof commitSectionEditor === 'function') commitSectionEditor(); } catch (e) {}
  try { if (typeof syncLyricsHidden === 'function') syncLyricsHidden(); } catch (e) {}
  const prompt = (document.getElementById('aiPrompt')?.value || '').trim();
  const lyrics = (document.getElementById('lyrics')?.value || '').trim();
  const sectionText = (document.getElementById('sectionEditor')?.value || '').trim();
  const hook = (document.getElementById('songHook')?.value || '').trim();
  const seed = prompt || sectionText || lyrics || hook;
  return { prompt, lyrics, sectionText, hook, seed };
}

function setAiStatus(msg) {
  const el = document.getElementById('aiStatus');
  if (el) el.innerHTML = msg;
}



function pushAiUndo() {
  try{commitSectionEditor()}catch(e){}
  state._lyricsUndo = syncLyricsHidden();
  state._sectionsUndo = JSON.parse(JSON.stringify(state.writeSections || []));
  const btn = document.getElementById('undoAiBtn');
  if (btn) btn.style.opacity = '1';
}

function undoAiLyrics() {
  if (state._sectionsUndo) {
    state.writeSections = state._sectionsUndo;
    state._sectionsUndo = null;
    state._lyricsUndo = null;
    showActiveSection();
    syncLyricsHidden();
    scheduleSave();
    setAiStatus('Restored before AI');
    setTimeout(() => setAiStatus(''), 2500);
    return;
  }
  if (state._lyricsUndo == null) return;
  lyricsToSections(state._lyricsUndo);
  state._lyricsUndo = null;
  showActiveSection();
  scheduleSave();
  setAiStatus('Restored before AI');
  setTimeout(() => setAiStatus(''), 2500);
}

function insertStructureSection() {
  const on = document.querySelector('#structureChips .chip.on');
  const sec = on?.dataset?.sec || 'verse';
  const marker = SECTION_MARKERS[sec] || '[Verse]\n';
  const ta = document.getElementById('lyrics');
  if (!ta) return;
  const start = ta.selectionStart || ta.value.length;
  const end = ta.selectionEnd || start;
  const before = ta.value.slice(0, start);
  const after = ta.value.slice(end);
  const needsNl = before.length && !before.endsWith('\n');
  const insert = (needsNl ? '\n\n' : '') + marker;
  ta.value = before + insert + after;
  const pos = (before + insert).length;
  ta.focus();
  ta.setSelectionRange(pos, pos);
  scheduleSave();
}

function applyLyricTemplate(key) {
  if (!key || !LYRIC_TEMPLATES[key]) return;
  ensureWriteSections();
  const tpl = LYRIC_TEMPLATES[key];
  if ((sectionsToLyrics() || '').trim()) {
    if (!confirm('Replace current lyrics with this template?')) {
      const sel = document.getElementById('lyricTemplate');
      if (sel) sel.value = '';
      return;
    }
  }
  // tpl may be string or object
  if (typeof tpl === 'string') {
    lyricsToSections(tpl);
  } else if (tpl && typeof tpl === 'object') {
    state.writeSections.forEach(s => {
      const lab = (s.label || s.id || '').toLowerCase();
      if (tpl[s.id]) s.text = tpl[s.id];
      else if (lab.includes('verse') && tpl.verse) s.text = tpl.verse;
      else if (lab.includes('chorus') && tpl.chorus) s.text = tpl.chorus;
      else if (lab.includes('bridge') && tpl.bridge) s.text = tpl.bridge;
      else if (lab.includes('intro') && tpl.intro) s.text = tpl.intro;
      else if (lab.includes('outro') && tpl.outro) s.text = tpl.outro;
    });
  }
  showActiveSection();
  syncLyricsHidden();
  scheduleSave();
  const sel = document.getElementById('lyricTemplate');
  if (sel) sel.value = '';
  toast('Template applied');
}

function flashSaveDot() {
  const d = document.getElementById('saveDot');
  if (!d) return;
  d.classList.add('on');
  clearTimeout(d._t);
  d._t = setTimeout(() => d.classList.remove('on'), 1200);
}


/* ── Write sections engine ── */
const DEFAULT_SECTIONS = [
  { id: 'intro', label: 'Intro', text: '' },
  { id: 'verse1', label: 'Verse 1', text: '' },
  { id: 'chorus', label: 'Chorus', text: '' },
  { id: 'verse2', label: 'Verse 2', text: '' },
  { id: 'bridge', label: 'Bridge', text: '' },
  { id: 'outro', label: 'Outro', text: '' }
];

const RHYME_MAP = {
  love:['above','dove','of','enough','touch'], night:['light','right','fight','bright','tight'],
  heart:['start','part','art','apart','dark'], time:['mine','line','fine','rhyme','climb'],
  day:['way','say','play','stay','away'], pain:['rain','gain','flame','name','same'],
  go:['know','show','flow','home','alone'], me:['see','be','free','key','dream'],
  you:['true','do','through','blue','new'], fire:['desire','higher','liar','wire','tired'],
  home:['alone','phone','own','known','stone'], sky:['high','try','eye','fly','why'],
  beat:['heat','street','feet','complete','need'], soul:['goal','whole','control','cold','road'],
  life:['wife','knife','strife','light','fight'], god:['rod','odd','abroad','applaud'],
  grace:['place','face','space','race','embrace'], hope:['rope','scope','open','spoken'],
  dance:['chance','romance','trance','advance'], money:['honey','sunny','funny','run me'],
  baby:['maybe','crazy','lady','daily'], girl:['world','pearl','swirl','turn'],
  boy:['joy','toy','employ','destroy'], yes:['bless','stress','best','rest'],
  no:['go','low','flow','know','so'], up:['love','enough','touch','us'],
  down:['town','sound','found','around','ground'], feel:['real','deal','wheel','heal','still'],
  cry:['eye','sky','try','why','high'], smile:['while','mile','style','trial'],
  dream:['seem','team','stream','believe','me'], dark:['heart','start','spark','art'],
  light:['night','right','fight','bright','sight']
};

function countSyllables(word) {
  word = (word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!word) return 0;
  if (word.length <= 3) return 1;
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const m = word.match(/[aeiouy]{1,2}/g);
  return m ? m.length : 1;
}

function lineSyllables(line) {
  return (line || '').split(/\s+/).reduce((s, w) => s + countSyllables(w), 0);
}

function ensureWriteSections() {
  if (!state.writeSections || !state.writeSections.length) {
    state.writeSections = DEFAULT_SECTIONS.map(s => ({ ...s }));
    state.writeSectionId = 'verse1';
  }
  if (!state.writeSectionId) state.writeSectionId = state.writeSections[0].id;
}

function sectionsToLyrics() {
  ensureWriteSections();
  return state.writeSections
    .filter(s => (s.text || '').trim())
    .map(s => `[${s.label}]\n${(s.text || '').trim()}`)
    .join('\n\n');
}

function lyricsToSections(lyrics) {
  const text = lyrics || '';
  if (!text.trim()) {
    state.writeSections = DEFAULT_SECTIONS.map(s => ({ ...s }));
    return;
  }
  const parts = text.split(/\n(?=\[)/);
  const sections = [];
  let anon = 0;
  parts.forEach(p => {
    const m = p.match(/^\[([^\]]+)\]\s*\n?([\s\S]*)/);
    if (m) {
      const label = m[1].trim();
      const id = label.toLowerCase().replace(/\s+/g, '') + (sections.length);
      sections.push({ id, label, text: (m[2] || '').trim() });
    } else if (p.trim()) {
      anon++;
      sections.push({ id: 'block' + anon, label: 'Section ' + anon, text: p.trim() });
    }
  });
  state.writeSections = sections.length ? sections : DEFAULT_SECTIONS.map(s => ({ ...s }));
  if (!state.writeSections.find(s => s.id === state.writeSectionId)) {
    state.writeSectionId = state.writeSections[0].id;
  }
}

function syncLyricsHidden() {
  const full = sectionsToLyrics();
  const ta = document.getElementById('lyrics');
  if (ta) ta.value = full;
  return full;
}

function renderSectionTabs() {
  ensureWriteSections();
  const tabs = document.getElementById('sectionTabs');
  if (!tabs) return;
  tabs.innerHTML = state.writeSections.map(s =>
    `<button type="button" class="section-tab${s.id === state.writeSectionId ? ' on' : ''}" data-sid="${s.id}">${esc(s.label)}</button>`
  ).join('');
}

function getActiveSection() {
  ensureWriteSections();
  return state.writeSections.find(s => s.id === state.writeSectionId) || state.writeSections[0];
}

function showActiveSection() {
  const sec = getActiveSection();
  const ed = document.getElementById('sectionEditor');
  if (ed) ed.value = sec ? (sec.text || '') : '';
  renderSectionTabs();
  updateRhymeBar();
  const pl = document.getElementById('perfSectionLabel');
  if (pl) pl.textContent = sec ? sec.label : 'Performance';
  const pt = document.getElementById('perfText');
  if (pt) pt.textContent = sec ? (sec.text || '…') : '';
}

function commitSectionEditor() {
  const sec = getActiveSection();
  const ed = document.getElementById('sectionEditor');
  if (sec && ed) sec.text = ed.value;
  syncLyricsHidden();
  scheduleSave();
}

function selectWriteSection(id) {
  commitSectionEditor();
  state.writeSectionId = id;
  showActiveSection();
}

function addWriteSection() {
  commitSectionEditor();
  const n = state.writeSections.length + 1;
  const id = 'sec' + Date.now();
  state.writeSections.push({ id, label: 'Section ' + n, text: '' });
  state.writeSectionId = id;
  showActiveSection();
  scheduleSave();
}

function updateRhymeBar() {
  const ed = document.getElementById('sectionEditor');
  const text = ed ? ed.value : '';
  const lines = text.split('\n');
  const last = (lines[lines.length - 1] || '').trim();
  const syl = lineSyllables(last);
  const el = document.getElementById('sylCount');
  if (el) el.textContent = String(syl);
  const words = last.split(/\s+/).filter(Boolean);
  const lastWord = (words[words.length - 1] || '').toLowerCase().replace(/[^a-z']/g, '');
  const chips = document.getElementById('rhymeChips');
  if (!chips) return;
  const rhymes = RHYME_MAP[lastWord] || RHYME_MAP[lastWord.slice(0, 4)] || [];
  chips.innerHTML = rhymes.slice(0, 6).map(r =>
    `<span class="rhyme-chip" data-rhyme="${r}">${r}</span>`
  ).join('') || (lastWord ? '<span class="text-dim">No suggestions</span>' : '');
}

function insertRhyme(word) {
  const ed = document.getElementById('sectionEditor');
  if (!ed) return;
  const v = ed.value;
  const lines = v.split('\n');
  const last = lines[lines.length - 1] || '';
  lines[lines.length - 1] = last.replace(/\s*$/, '') + (last.trim() ? ' ' : '') + word;
  ed.value = lines.join('\n');
  commitSectionEditor();
  updateRhymeBar();
}

function exportWriteLyrics() {
  commitSectionEditor();
  const title = document.getElementById('songTitle')?.value || 'Untitled';
  const hook = document.getElementById('songHook')?.value || '';
  const key = document.getElementById('songKey')?.value || '';
  const mood = document.getElementById('songMood')?.value || '';
  const full = syncLyricsHidden();
  const sheet = `TAPEHEAD · ${title}\nKey: ${key || '—'} · Mood: ${mood || '—'} · BPM: ${state.bpm}\nHook: ${hook || '—'}\n\n${full}\n`;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(sheet).then(() => setAiStatus('Copied song sheet')).catch(() => fallbackExport(sheet));
  } else fallbackExport(sheet);
  setTimeout(() => setAiStatus(''), 2500);
}

function fallbackExport(sheet) {
  const ta = document.createElement('textarea');
  ta.value = sheet;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); setAiStatus('Copied song sheet'); } catch(e) { setAiStatus('Copy failed'); }
  document.body.removeChild(ta);
}

async function sendSectionToCollab() {
  if (!state.user) { openAuth('signin'); return; }
  commitSectionEditor();
  const sec = getActiveSection();
  if (!sec || !(sec.text || '').trim()) { toast('Write something in this section first'); return; }
  if (!state.collabCode) {
    await createRoom();
  }
  const room = getActiveRoom();
  if (!room) { setView('collab'); return; }
  // put text into matching or empty section
  let target = room.sections.find(s => (s.label || '').toLowerCase().includes((sec.label || '').toLowerCase().split(' ')[0]));
  if (!target) target = room.sections.find(s => !(s.text || '').trim());
  if (!target) target = room.sections[1] || room.sections[0];
  if (target) {
    target.text = sec.text;
    target.ownerId = state.user.id;
    target.ownerName = state.user.username;
    saveActiveRoom(room);
  }
  setView('collab');
  renderCollabView();
  setAiStatus('Section sent to collab room');
  setTimeout(() => setAiStatus(''), 2500);
}

function startVoiceLyrics() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast('Voice not supported in this browser'); return; }
  const rec = new SR();
  rec.lang = 'en-US';
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  const btn = document.getElementById('voiceLyricsBtn');
  if (btn) btn.textContent = 'Listening…';
  rec.onresult = (e) => {
    const t = e.results[0][0].transcript;
    const ed = document.getElementById('sectionEditor');
    if (ed) {
      ed.value = (ed.value ? ed.value + '\n' : '') + t;
      commitSectionEditor();
      updateRhymeBar();
    }
  };
  rec.onerror = () => { if (btn) btn.textContent = '🎤 Dictate'; };
  rec.onend = () => { if (btn) btn.textContent = '🎤 Dictate'; };
  try { rec.start(); } catch(e) { toast('Mic busy — try again'); if (btn) btn.textContent = '🎤 Dictate'; }
}

function togglePerfMode(on) {
  try {
    const app = document.querySelector('.app');
    if (!app) return;
    try { commitSectionEditor(); } catch (e) {}
    try { ensureWriteSections(); } catch (e) {}
    if (on) {
      const sec = typeof getActiveSection === 'function' ? getActiveSection() : null;
      const text = (sec && sec.text) || document.getElementById('sectionEditor')?.value || document.getElementById('lyrics')?.value || '';
      const pl = document.getElementById('perfSectionLabel');
      if (pl) pl.textContent = (sec && sec.label) ? sec.label : 'Performance';
      const pt = document.getElementById('perfText');
      if (pt) {
        pt.textContent = (text || '').trim() || 'Nothing to perform yet — write a verse or run Create Full Song first.';
      }
      app.classList.add('perf-mode');
      document.getElementById('perfCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      toast('Performance mode');
    } else {
      app.classList.remove('perf-mode');
      toast('Editor mode');
    }
  } catch (err) {
    console.warn('perf', err);
    toast('Could not open Perform mode');
  }
}




document.addEventListener('click', function(e) {
  const t = e.target.closest && e.target.closest('button, [id]');
  if (!t || !t.id) return;
  if (t.id === 'upgradeBtn') { e.preventDefault(); try { openPaywall('Upgrade to Pro'); } catch (err) { console.warn(err); } }
  if (t.id === 'payNowBtn') { e.preventDefault(); try { processProPayment(); } catch (err) { console.warn(err); } }
}, true);


function toggleWriteTools(){
  const view=document.getElementById('view-write');
  const btn=document.getElementById('writeMoreTools');
  if(!view||!btn) return;
  const open=view.classList.toggle('write-simple-expanded');
  btn.textContent=open?'Less':'More tools';
  if(open) setTimeout(()=>document.getElementById('writeCoachCard')?.scrollIntoView({behavior:'smooth',block:'nearest'}),80);
}

function bindWriteGlobalOnce() {
  if (window._writeGlobalBound) return;
  window._writeGlobalBound = true;
  document.addEventListener('click', function(e) {
    const tab = e.target.closest && e.target.closest('#sectionTabs [data-sid], .section-tab[data-sid]');
    if (tab) {
      e.preventDefault();
      const id = tab.getAttribute('data-sid');
      try { ensureWriteSections(); selectWriteSection(id); } catch (err) { console.warn(err); }
      return;
    }
    if (e.target.closest && e.target.closest('#perfModeBtn')) {
      e.preventDefault();
      try { togglePerfMode(true); } catch (err) { console.warn(err); }
      return;
    }
    if (e.target.closest && e.target.closest('#exitPerfBtn')) {
      e.preventDefault();
      try { togglePerfMode(false); } catch (err) { console.warn(err); }
      return;
    }
    if (e.target.closest && e.target.closest('#addSectionBtn')) {
      e.preventDefault();
      try { addWriteSection(); } catch (err) { console.warn(err); }
      return;
    }
  });
}

function bindWriteProUI() {
  if (window._writeProBound) { try { showActiveSection(); } catch(e) {} return; }
  window._writeProBound = true;
  try { ensureWriteSections(); } catch (e) {}
  document.getElementById('writeMoreTools')?.addEventListener('click', e => { e.preventDefault(); toggleWriteTools(); });
  document.getElementById('sectionTabs')?.addEventListener('click', e => {
    const t = e.target.closest('[data-sid]');
    if (t) selectWriteSection(t.dataset.sid);
  });
  document.getElementById('sectionEditor')?.addEventListener('input', () => {
    commitSectionEditor();
    updateRhymeBar();
  });
  document.getElementById('rhymeChips')?.addEventListener('click', e => {
    const c = e.target.closest('[data-rhyme]');
    if (c) insertRhyme(c.dataset.rhyme);
  });
  document.getElementById('addSectionBtn')?.addEventListener('click', addWriteSection);
  document.getElementById('structureChips')?.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    document.querySelectorAll('#structureChips .chip').forEach(c => c.classList.remove('on'));
    chip.classList.add('on');
    ensureWriteSections();
    const map = { intro: 'intro', verse: 'verse1', pre: 'verse1', chorus: 'chorus', bridge: 'bridge', outro: 'outro' };
    const want = map[chip.dataset.sec] || chip.dataset.sec;
    let sec = state.writeSections.find(s => s.id === want || (s.label || '').toLowerCase().includes(chip.dataset.sec || ''));
    if (!sec) {
      sec = { id: (chip.dataset.sec || 'sec') + Date.now(), label: chip.textContent, text: '' };
      state.writeSections.push(sec);
    }
    selectWriteSection(sec.id);
  });
  document.getElementById('exportWriteBtn')?.addEventListener('click', exportWriteLyrics);
  document.getElementById('sendCollabBtn')?.addEventListener('click', sendSectionToCollab);
  document.getElementById('voiceLyricsBtn')?.addEventListener('click', startVoiceLyrics);
  document.getElementById('perfModeBtn')?.addEventListener('click', e => { e.preventDefault(); togglePerfMode(true); });
  document.getElementById('exitPerfBtn')?.addEventListener('click', e => { e.preventDefault(); togglePerfMode(false); });
  document.getElementById('clearLyrics')?.addEventListener('click', () => {
    if (!confirm('Clear all section lyrics?')) return;
    ensureWriteSections();
    state.writeSections.forEach(s => { s.text = ''; });
    const ed = document.getElementById('sectionEditor');
    if (ed) ed.value = '';
    const L = document.getElementById('lyrics');
    if (L) L.value = '';
    showActiveSection();
    scheduleSave();
    toast('Lyrics cleared');
  });
  document.getElementById('writeShareBtn')?.addEventListener('click', openPublish);
  document.getElementById('undoAiBtn')?.addEventListener('click', undoAiLyrics);
    document.getElementById('writeRecVocalBtn')?.addEventListener('click', () => setView('record'));
  document.getElementById('aiFinishVerse')?.addEventListener('click', e => { e.preventDefault(); aiFinishVerse(); });
  document.getElementById('aiNextSection')?.addEventListener('click', e => { e.preventDefault(); aiNextSection(); });
  document.getElementById('aiPolish')?.addEventListener('click', e => { e.preventDefault(); aiPolish(); });
  document.getElementById('aiHook')?.addEventListener('click', e => { e.preventDefault(); aiHookLab(); });
  document.getElementById('aiFullSong')?.addEventListener('click', e => { e.preventDefault(); aiFullSong(); });

document.getElementById('secAiFinish')?.addEventListener('click', e => {
  e.preventDefault();
  try { commitSectionEditor(); } catch (err) {}
  if (typeof aiFinishVerse === 'function') aiFinishVerse();
  else if (typeof runAi === 'function') runAi('finish_verse');
});
document.getElementById('secAiPolish')?.addEventListener('click', e => {
  e.preventDefault();
  try { commitSectionEditor(); } catch (err) {}
  if (typeof aiPolish === 'function') aiPolish();
  else if (typeof runAi === 'function') runAi('polish');
});
document.getElementById('secAiNext')?.addEventListener('click', e => {
  e.preventDefault();
  try { commitSectionEditor(); } catch (err) {}
  if (typeof aiNextSection === 'function') aiNextSection();
  else if (typeof runAi === 'function') runAi('write_next');
});

  ['aiStyle','aiLanguage','aiLength'].forEach(id => document.getElementById(id)?.addEventListener('change', scheduleSave));
  ['songKey','songBpmNote','songMood','songRef','songHook'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', scheduleSave);
    document.getElementById(id)?.addEventListener('change', scheduleSave);
  });
  document.getElementById('songBpmNote')?.addEventListener('change', e => {
    const v = parseInt(e.target.value, 10);
    if (v >= 60 && v <= 200) {
      state.bpm = v;
      const b = document.getElementById('bpmBadge');
      if (b) b.textContent = v + ' BPM';
    }
  });
  try { showActiveSection(); } catch (e) {}
}

function humConfidence(frames,notes){
  const usable=(frames||[]).filter(v=>v>=0).length;
  const total=(frames||[]).length||1;
  const coverage=usable/total;
  const noteCount=(notes||[]).length;
  const stability=Math.min(1,noteCount/8);
  return Math.max(45,Math.min(98,Math.round((coverage*.7+stability*.3)*100)));
}
function humAlternatives(key){
  if(!key)return [];
  const root=key.root, minor=key.minor;
  const sets=minor?[[0,3,5,4],[0,5,3,4],[5,3,0,4]]:[[0,5,3,4],[0,4,5,3],[1,4,0,5]];
  return sets.map(ds=>progFromDegrees(root,minor,ds));
}
function renderHumAnalysis(notes,frames){
  const box=document.getElementById('humAnalysis'),kv=document.getElementById('humKeyValue'),cv=document.getElementById('humConfidence'),nb=document.getElementById('humNotes');
  if(box)box.hidden=false;
  const key=state._humKey?(NOTE_NAMES_SHARP[state._humKey.root]+(state._humKey.minor?'m':'')):'—';
  if(kv)kv.textContent=key;
  if(cv)cv.textContent=humConfidence(frames,notes)+'%';
  if(nb){nb.hidden=false;nb.innerHTML=(notes||[]).slice(0,12).map(n=>`<span class="hum-note">${esc(NOTE_NAMES_SHARP[n.pc])}</span>`).join('');}
}
function showChordResult(chords){
  const el=document.getElementById('chordResult');if(!el)return;
  el.hidden=false;
  const key=(state._humKey&&NOTE_NAMES_SHARP)?(NOTE_NAMES_SHARP[state._humKey.root]+(state._humKey.minor?'m':'')):'';
  const keyBadge=key?`<div class="chord-result-head"><span class="chord-result-label">Suggested progression</span><span class="chord-result-confidence">${humConfidence(state._humFrames||[],state._humNotes||[])}% confidence</span></div><div class="chord-key-badge">Key ${esc(key)}</div>`:'';
  const alts=humAlternatives(state._humKey);
  const altHtml=alts.length?`<div style="width:100%;margin-top:10px"><div class="chord-result-label">Try another progression</div><div class="chord-result" style="margin-top:6px">${alts.map((a,i)=>`<button type="button" class="chip" data-hum-alt="${i}">${esc(a.join(' · '))}</button>`).join('')}</div></div>`:'';
  el.innerHTML=keyBadge+(chords||[]).map(c=>`<div class="chord-pill" role="button" tabindex="0" data-pchord="${esc(c)}">${esc(c)}</div>`).join('')+altHtml;
  const ha=document.getElementById('humActions');if(ha)ha.hidden=false;
  const inv=document.getElementById('inversionRow');if(inv){inv.hidden=false;inv.querySelectorAll('.chip').forEach(c=>c.classList.toggle('on',c.dataset.inv==='0'));}
  state._humInversion=0;
  chords.forEach((c,i)=>{setTimeout(()=>{const notes=voicedChordNotes(c,0);notes.forEach((n,j)=>setTimeout(()=>playNote(n,3,.6),j*25))},i*700)});
}
function voicedChordNotes(name, inv){
  const base=(CHORDS&&CHORDS[name])?CHORDS[name].slice():['C','E','G'];
  inv=Math.max(0,Math.min(2,inv|0));
  const notes=base.slice();
  for(let i=0;i<inv;i++){const n=notes.shift();notes.push(n);}
  return notes;
}
function applyInversion(inv){
  state._humInversion=inv|0;
  const invRow=document.getElementById('inversionRow');
  if(invRow)invRow.querySelectorAll('.chip').forEach(c=>c.classList.toggle('on',Number(c.dataset.inv)===state._humInversion));
  const chords=state.detectedChords||[];
  const el=document.getElementById('chordResult');
  if(el&&!el.hidden){
    const key=(state._humKey&&NOTE_NAMES_SHARP)?(NOTE_NAMES_SHARP[state._humKey.root]+(state._humKey.minor?'m':'')):'';
    const keyBadge=key?`<div class="chord-key-badge">Key ${esc(key)}</div>`:'';
    el.innerHTML=keyBadge+chords.map(c=>`<div class="chord-pill">${esc(c)}</div>`).join('');
  }
  // Preview voiced progression
  chords.forEach((c,i)=>{setTimeout(()=>{const notes=voicedChordNotes(c,state._humInversion);notes.forEach((n,j)=>setTimeout(()=>playNote(n,3,.55),j*22))},i*550)});
  toast(inv===0?'Root position':inv===1?'1st inversion':'2nd inversion');
}
function applyChordProgression(chords){
  if(!chords||!chords.length)return;
  state.detectedChords=chords.slice();
  if(!patternHasHits()){
    const n=state.stepCount||16, minor=/m$/.test(chords[0]);
    const mk=(fn)=>Array.from({length:n},(_,i)=>fn(i)?1:0);
    state.pattern={kick:mk(i=>minor?[0,3,6,10].includes(i%16):i%4===0),snare:mk(i=>i%8===4),hat:mk(i=>i%2===1),clap:mk(i=>minor?i%16===2:i%8===4)};
  }
  try{buildTracks()}catch(e){}
  saveCurrentSong();
  toast('Chords applied — your beat now plays them');
}

/* ── Auth & Social (local multi-account) ── */

function normalizeContact(c) {
  return String(c || '').trim().toLowerCase().replace(/\s+/g, '');
}

function findUserRecord(contactRaw, pass) {
  const users = loadUsers();
  const key = normalizeContact(contactRaw);
  if (users[key] && (!pass || users[key].pass === pass || users[key].password === pass)) {
    return { key, user: users[key] };
  }
  // scan by username or contact variants
  for (const [k, u] of Object.entries(users)) {
    if (!u) continue;
    const matchContact = normalizeContact(u.contact) === key || normalizeContact(u.email) === key || normalizeContact(u.phone) === key;
    const matchUser = (u.username || '').toLowerCase() === String(contactRaw || '').trim().toLowerCase();
    if ((matchContact || matchUser) && (!pass || u.pass === pass || u.password === pass)) {
      return { key: k, user: u };
    }
  }
  return { key, user: null };
}

function finishSignIn(key, user) {
  state.user = { id: user.id, username: user.username, contact: normalizeContact(user.contact || key), avatar: user.avatar || null, cloudId: user.cloudId || null };
  state.artistName = user.username || 'Artist';
  saveSession({ contact: state.user.contact, id: user.id });
  if (user.pro) { state.pro = user.pro; try { savePro(user.pro); } catch (e) {} }
  else { try { grantTrialPro(); } catch (e) {} }
  state.songs = loadUserSongs();
  closeAuth(); lockApp(false); updateUserUI(); updateProUI(); renderSongList();
  try { if (state.songs.length) loadSong(state.songs[0].id); else newSong(); } catch (e) { console.warn(e); }
  toast('Welcome back, ' + state.user.username);
}

async function doSignIn(){
  if (window.__thSigningIn) return;
  const btn = document.getElementById('doSignIn');
  const btnLabel = btn ? btn.textContent : '';
  const setBusy = (on) => {
    window.__thSigningIn = on;
    if (btn) { btn.disabled = on; btn.textContent = on ? 'Signing in…' : btnLabel; }
  };
  try {
    const contactRaw = document.getElementById('signinContact')?.value || '';
    const pass = document.getElementById('signinPass')?.value || '';
    if (!contactRaw.trim() || !pass) { toast('Enter email and password'); return; }
    setBusy(true);
    if (Cloud.isCloud() && isEmail(contactRaw)) {
      const email = contactRaw.trim().toLowerCase();
      const r = await Promise.race([
        Cloud.signIn(email, pass),
        new Promise(res => setTimeout(() => res({ error: '__timeout' }), 20000))
      ]);
      if (r.error || !r.user) {
        const msg = String(r.error || '');
        if (msg === '__timeout') toast('Sign in is taking too long. Check your connection and try again.');
        else if (/not confirmed/i.test(msg)) toast('Please confirm your email first — check your inbox, then sign in.');
        else if (/invalid login/i.test(msg)) toast('Wrong email or password.');
        else toast(msg || 'Invalid login details');
        return;
      }
      /* Credentials are valid from here on: nothing below may turn this into a failed sign-in. */
      let profile = null;
      try { profile = await Cloud.getProfile(r.user.id) || await Cloud.ensureProfile(r.user, email.split('@')[0], email); }
      catch (e) { console.warn('signin profile', e); }
      state.user = { id: r.user.id, cloudId: r.user.id, contact: email, username: profile?.username || r.user.user_metadata?.username || email.split('@')[0], avatar: profile?.avatar_url || null };
      state.artistName = state.user.username;
      state.guest = false;
      saveSession({ contact: state.user.contact, id: state.user.id, cloud: true });
      try { state.songs = loadUserSongs(); } catch (e) { console.warn('signin songs', e); }
      closeAuth(); lockApp(false);
      try { updateUserUI(); } catch (e) { console.warn(e); }
      try { renderSongList(); } catch (e) {}
      try { if (state.songs && state.songs.length) loadSong(state.songs[0].id); else newSong(); } catch (e) { console.warn(e); }
      toast('Welcome back, ' + state.user.username);
      try { await syncCloudPro(); } catch (e) { console.warn('syncCloudPro', e); }
      try { updateProUI(); } catch (e) {}
      try { await syncCloudSocial(); } catch (e) { console.warn('syncCloudSocial', e); }
      return;
    }
    if (Cloud.requiresCloud()) { toast(isEmail(contactRaw) ? 'Cloud services are temporarily unavailable. Please try again later.' : 'Please sign in with the email address you registered with.'); return; }
    const { key, user } = findUserRecord(contactRaw, pass);
    if (!user) { toast('Invalid login details'); return; }
    finishSignIn(key, user);
  } catch (e) {
    console.warn(e); toast('Sign in failed');
  } finally {
    setBusy(false);
  }
}
async function doSignUp(){try{const username=(document.getElementById('signupUsername')?.value||'').trim(),contactRaw=(document.getElementById('signupContact')?.value||'').trim(),pass=document.getElementById('signupPass')?.value||'';if(username.length<2){toast('Choose a username');return;}if(!contactRaw){toast('Enter email');return;}if(pass.length<8){toast('Password min 8 characters');return;}if(Cloud.isCloud()&&isEmail(contactRaw)){const r=await Cloud.signUp(contactRaw.toLowerCase(),pass,username);if(!r.error&&r.user){const profile=await Cloud.ensureProfile(r.user,username,contactRaw);if(r.session){if(state._pendingAvatar){try{await Cloud.updateProfile(r.user.id,{avatar_url:state._pendingAvatar})}catch(e){}}state.user={id:r.user.id,cloudId:r.user.id,contact:contactRaw.toLowerCase(),username:profile?.username||username,avatar:state._pendingAvatar||profile?.avatar_url||null};saveSession({contact:state.user.contact,id:state.user.id,cloud:true});await syncCloudPro();if(!state.pro){try{const tr=await fetch('/api/pro-trial',{method:'POST',headers:{Authorization:'Bearer '+(await Cloud.ensureSession())?.access_token}});const td=await tr.json().catch(()=>({}));if(td.entitlement){state.pro={active:true,plan:'trial',label:'30-day free trial',started:Date.now(),expires:new Date(td.entitlement.expires_at).getTime(),server:true};}}catch(e){console.warn('trial start',e)}}closeAuth();lockApp(false);updateUserUI();updateProUI();await syncCloudSocial();toast('Account created — 30-day Pro trial on');}else toast('Account created. Check your email to confirm, then sign in.');return;}toast(r.error||'Sign up failed. Please try again.');return;}if(Cloud.requiresCloud()){toast(isEmail(contactRaw)?'Cloud services are temporarily unavailable. Please try again later.':'Please sign up with a valid email address.');return;}const users=loadUsers(),key=normalizeContact(contactRaw);if(users[key]){toast('Account already exists — sign in');setAuthTab('signin');return;}for(const u of Object.values(users))if(u&&(u.username||'').toLowerCase()===username.toLowerCase()){toast('Username taken');return;}const user={id:'u_'+Date.now().toString(36),contact:contactRaw,username,pass,password:pass,avatar:state._pendingAvatar||null,created:Date.now(),trialUsed:false};users[key]=user;saveUsers(users);state.user={id:user.id,contact:user.contact,username:user.username,avatar:user.avatar};saveSession({contact:user.contact,id:user.id});grantTrialPro();users[key].trialUsed=true;users[key].pro=state.pro;saveUsers(users);closeAuth();lockApp(false);updateUserUI();updateProUI();toast('Account created — 30-day Pro trial on');}catch(e){console.warn(e);toast('Sign up failed');}}

async function syncCloudPro() {
  if (!Cloud.isCloud() || !state.user?.cloudId) return;
  // In Cloud mode, browser storage is only a cache. Never trust a cached Pro flag.
  state.pro = null;
  try { savePro(null); } catch (e) {}
  try {
    const p = await Cloud.getProStatus();
    if (p) {
      state.pro = { active:true, plan:p.plan, label:p.plan==='trial'?'30-day free trial':(p.plan==='lifetime'?'Lifetime Pro':p.plan==='year'?'Yearly Pro':'Monthly Pro'), started:p.started_at?new Date(p.started_at).getTime():Date.now(), expires:p.expires_at?new Date(p.expires_at).getTime():null, server:true };
      try { savePro(state.pro); } catch (e) {}
    }
    updateProUI();
  } catch(e) {
    state.pro = null;
    try { savePro(null); } catch (err) {}
    updateProUI();
    console.warn('syncCloudPro',e);
  }
}

async function syncCloudSocial(){if(!Cloud.isCloud()||!state.user?.cloudId)return;const auth=await Cloud.currentAuthUser();if(!auth||auth.id!==state.user.cloudId)return;try{const remote=await Cloud.fetchFeed();if(remote){const local=loadSocial();local.feed=remote.posts||[];local.likes={};(remote.likes||[]).forEach(x=>(local.likes[x.post_id]||=[]).push(x.user_id));local.comments={};(remote.comments||[]).forEach(x=>(local.comments[x.post_id]||=[]).push({user:x.username||'Artist',userId:x.user_id,text:x.body,at:new Date(x.created_at).getTime()}));local.seeded=true;saveSocial(local);window.__thFeedMore=(remote.posts||[]).length>=(window.__thFeedLimit||30);window.__thUpdateFeedMore&&window.__thUpdateFeedMore();}const msgs=await Cloud.fetchMessages(),g=loadSocialGraph(),peerIds=[...new Set((msgs||[]).flatMap(m=>[m.sender_id,m.recipient_id]).filter(id=>id&&id!==state.user.cloudId))],peerProfiles={};const pc=(window.__thPeerCache=window.__thPeerCache||{}),nowT=Date.now();await Promise.all(peerIds.map(async id=>{const hit=pc[id];if(hit&&nowT-hit.t<300000){peerProfiles[id]=hit.p;return;}const pr=await Cloud.getProfile(id);if(pr){peerProfiles[id]=pr;pc[id]={p:pr,t:nowT};}}));g.messages=(msgs||[]).map(m=>({id:m.id,sender:m.sender_id,recipient:m.recipient_id,senderName:peerProfiles[m.sender_id]?.username||state.user.username||m.sender_id,recipientName:peerProfiles[m.recipient_id]?.username||m.recipient_id,body:m.body,created:new Date(m.created_at).getTime(),read:!!m.read_at}));saveSocialGraph(g);renderCommunityFeed();if(document.getElementById('messagesModal')?.classList.contains('show')){if(state._msgPeer) await showMessageThread(state._msgPeer); else await showMessageInbox();}}catch(e){console.warn('syncCloudSocial',e);}}

function loadUsers() {
  try { const u=JSON.parse(localStorage.getItem('th-users') || '{}'); return u && typeof u==='object' ? u : {}; } catch { return {}; }
}
function saveUsers(users) { localStorage.setItem('th-users', JSON.stringify(users)); }

function loadSession() {
  try { return JSON.parse(localStorage.getItem('th-session') || 'null'); } catch { return null; }
}
function saveSession(s) {
  if (s) localStorage.setItem('th-session', JSON.stringify(s));
  else localStorage.removeItem('th-session');
}

function userKey(contact) {
  return (contact || '').trim().toLowerCase().replace(/\s+/g, '');
}

function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }
function isPhone(s) { return /^\+?[\d\s\-()]{7,}$/.test(s) && (s.replace(/\D/g,'').length >= 7); }

function getSongsKey() {
  return state.user ? 'th-songs-' + state.user.id : 'th-songs-guest';
}

function loadUserSongs() {
  try {
    return JSON.parse(localStorage.getItem(getSongsKey()) || '[]');
  } catch { return []; }
}

let _cloudProjectSaveTimer = null;
let _cloudProjectSaveInFlight = false;
let _cloudProjectSaveQueued = false;
function persistSongs() {
  try { localStorage.setItem(getSongsKey(), JSON.stringify(state.songs || [])); } catch(e) { console.warn('persist', e); }
  if (Cloud.isCloud() && state.user?.cloudId) scheduleCloudProjectSave();
}
function scheduleCloudProjectSave() {
  clearTimeout(_cloudProjectSaveTimer);
  _cloudProjectSaveTimer = setTimeout(flushCloudProjectSave, 900);
}
async function flushCloudProjectSave() {
  if (!Cloud.isCloud() || !state.user?.cloudId) return true;
  if (_cloudProjectSaveInFlight) { _cloudProjectSaveQueued = true; return false; }
  _cloudProjectSaveInFlight = true;
  try {
    const ok = await Cloud.saveProjects(state.user.cloudId, state.songs || []);
    const dot = document.getElementById('saveDot');
    if (dot) dot.title = ok ? 'Saved to cloud' : 'Cloud save failed; local copy kept';
    return ok;
  } finally {
    _cloudProjectSaveInFlight = false;
    if (_cloudProjectSaveQueued) { _cloudProjectSaveQueued = false; scheduleCloudProjectSave(); }
  }
}
async function hydrateCloudProjects() {
  if (!Cloud.isCloud() || !state.user?.cloudId) return;
  try {
    const remote = await Cloud.loadProjects(state.user.cloudId);
    if (!Array.isArray(remote)) return;
    const merged = new Map((state.songs || []).map(s => [s.id, s]));
    remote.forEach(r => {
      const local = merged.get(r.id);
      if (!local || (r.updated || 0) > (local.updated || 0)) merged.set(r.id, r);
    });
    state.songs = [...merged.values()].sort((a,b)=>(b.updated||0)-(a.updated||0));
    persistSongs();
    renderSongList();
    if (state.currentSongId && state.songs.some(s => s.id === state.currentSongId)) loadSong(state.currentSongId);
  } catch (e) { console.warn('hydrateCloudProjects', e); }
}

function loadSocial() {
  try {
    let raw = localStorage.getItem('th-social') || localStorage.getItem('th-community');
    const s = JSON.parse(raw || '{}');
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      return { feed: Array.isArray(s) ? s : [], likes: {}, comments: {}, seeded: false };
    }
    s.feed = Array.isArray(s.feed) ? s.feed : [];
    s.likes = s.likes && typeof s.likes === 'object' ? s.likes : {};
    s.comments = s.comments && typeof s.comments === 'object' ? s.comments : {};
    return s;
  } catch (e) {
    return { feed: [], likes: {}, comments: {}, seeded: false };
  }
}
function saveSocial(s) {
  try { localStorage.setItem('th-social', JSON.stringify(s)); } catch (e) {}
}

function seedCommunity() {
  const social = loadSocial();
  if (social.seeded) return social;
  const feed = [
    { id: 'pub_1', title: 'Midnight Drive', username: 'NovaKeys', hook: 'We were fire on the highway', openToCollab: true, key: 'Am', mood: 'Night', contact: 'nova@demo.tape', avatar: null, bpm: 120, lyrics: '[Verse]\nStreetlights blur past the glass\nYour song still on the radio\n\n[Chorus]\nWe were fire on the highway\nBurning quiet, burning slow', kit: 'trap', updated: Date.now() - 86400000 },
    { id: 'pub_2', title: 'Soft Landing', username: 'Amara', hook: 'Soft landing on an empty page', openToCollab: false, key: 'C', mood: 'Heartbreak', contact: 'amara@demo.tape', avatar: null, bpm: 95, lyrics: '[Verse]\nI fold the morning into paper planes\nSend them where you used to wait\n\n[Chorus]\nSoft landing on an empty page', kit: 'boom', updated: Date.now() - 172800000 },
    { id: 'pub_3', title: 'Club Static', username: 'DJ Pulse', contact: 'pulse@demo.tape', avatar: null, bpm: 128, lyrics: '[Chorus]\nBass in my bloodstream\nDon\'t stop until the lights come up\nOne more song, one more night', kit: 'house', updated: Date.now() - 3600000 }
  ];
  social.feed = feed;
  social.likes = social.likes || {};
  social.comments = social.comments || {};
  feed.forEach(p => {
    if (!social.likes[p.id]) social.likes[p.id] = [];
    if (!social.comments[p.id]) social.comments[p.id] = [
      { user: 'Listener', text: 'This hook is clean 🔥', at: Date.now() - 5000000 }
    ];
  });
  social.seeded = true;
  saveSocial(social);
  return social;
}

function currentUserId() { return state.user ? state.user.id : null; }

const _likeBusy={};
function _paintLike(projectId,liked,n){document.querySelectorAll('[data-like]').forEach(function(b){if(b.getAttribute('data-like')===String(projectId)){b.classList.toggle('on',!!liked);b.textContent='\u2661 '+n;}});}
async function toggleLike(projectId){
  if(!state.user){toast('Sign in to like');openAuth('signin');return;}
  if(_likeBusy[projectId])return;
  const uid=state.user.id,social=loadSocial();social.likes=social.likes||{};
  const arr=(social.likes[projectId]||[]).slice(),idx=arr.indexOf(uid),want=idx<0;
  if(want)arr.push(uid);else arr.splice(idx,1);
  social.likes[projectId]=arr;saveSocial(social);
  _paintLike(projectId,want,arr.length);
  if(!(Cloud.isCloud()&&state.user.cloudId))return;
  _likeBusy[projectId]=1;
  try{
    const ok=await Cloud.setLike(projectId,want);
    if(ok===false)throw new Error('like failed');
  }catch(e){
    console.warn('toggleLike',e);
    const s2=loadSocial();s2.likes=s2.likes||{};const a2=(s2.likes[projectId]||[]).slice(),i2=a2.indexOf(uid);
    if(want&&i2>=0)a2.splice(i2,1);else if(!want&&i2<0)a2.push(uid);
    s2.likes[projectId]=a2;saveSocial(s2);_paintLike(projectId,!want,a2.length);toast('Could not save like');
  }finally{delete _likeBusy[projectId];}
}
async function addComment(projectId,text){
  if(!state.user){toast('Sign in to comment');openAuth('signin');return;}
  text=(text||'').trim();if(!text)return;
  const now=Date.now(),key=projectId+'|'+text;
  if(window._lastCmt&&window._lastCmt.key===key&&now-window._lastCmt.t<1500)return;
  window._lastCmt={key:key,t:now};
  const open=Array.prototype.map.call(document.querySelectorAll('#communityFeed .comment-list:not([hidden])'),function(e){return e.id;});
  const social=loadSocial();social.comments=social.comments||{};social.comments[projectId]=social.comments[projectId]||[];
  const entry={user:state.user.username,userId:state.user.id,text:text,at:now};
  social.comments[projectId].push(entry);saveSocial(social);renderCommunityFeed();
  open.forEach(function(id){const b=document.getElementById(id);if(b)b.hidden=false;});
  if(!(Cloud.isCloud()&&state.user.cloudId))return;
  try{
    const r=await Cloud.addComment(projectId,text,state.user.username);
    if(!r)throw new Error('comment failed');
  }catch(e){
    console.warn('addComment',e);
    const s2=loadSocial(),l=(s2.comments&&s2.comments[projectId])||[],ix=l.findIndex(function(c){return c.at===now&&c.userId===entry.userId;});
    if(ix>=0){l.splice(ix,1);saveSocial(s2);renderCommunityFeed();}
    toast('Could not post comment');
  }
}

async function deleteOwnFeedPost(postId) {
  if(!state.user){ toast('Sign in to manage your posts'); openAuth('signin'); return; }
  const social=loadSocial();
  const post=(social.feed||[]).find(p=>String(p.id)===String(postId));
  const uid=state.user.cloudId||state.user.id;
  if(!post || String(post.userId)!==String(uid)){ toast('You can only delete your own posts'); return; }
  if(!window.confirm('Delete this post from your Feed? This cannot be undone.')) return;
  // Remove immediately from the local feed for a responsive UI.
  social.feed=(social.feed||[]).filter(p=>String(p.id)!==String(postId));
  if(social.likes) delete social.likes[postId];
  if(social.comments) delete social.comments[postId];
  saveSocial(social); renderCommunityFeed();
  if(Cloud.isCloud() && state.user.cloudId){
    const remote=await Cloud.deleteFeedPost(postId);
    if(!remote.ok){
      social.feed.unshift(post);
      saveSocial(social); renderCommunityFeed();
      toast(remote.error||'Could not delete post');
      return;
    }
  }
  toast('Post deleted');
}

function getFeedFilter() {
  return state.feedFilter || 'latest';
}

async function hydrateFeedFollowingIds() {
  state.feedFollowingIds = state.feedFollowingIds || [];
  if (!state.user) return state.feedFollowingIds;
  try {
    if (Cloud.isCloud() && state.user.cloudId && Cloud.sb) {
      const r = await Cloud.sb.from('follows').select('following_id').eq('follower_id', state.user.cloudId);
      if (!r.error) state.feedFollowingIds = (r.data || []).map(x => x.following_id);
    } else {
      const g = loadSocialGraph();
      state.feedFollowingIds = (g.follows[currentUserKey()] || []).slice();
    }
  } catch (e) { console.warn('hydrateFeedFollowingIds', e); }
  return state.feedFollowingIds;
}


function openFeedProject(id) {
  try {
    if (!id) { toast('Post not found'); return; }
    if (!state.user) { openAuth('signin'); return; }
    const social = loadSocial();
    const p = (social.feed || []).find(x => x.id === id);
    if (!p) { toast('Post not found'); return; }
    const newId = 's_' + Date.now();
    const pattern = p.pattern
      ? JSON.parse(JSON.stringify(p.pattern))
      : JSON.parse(JSON.stringify(state.pattern || { kick:[], snare:[], hat:[], clap:[] }));
    const song = {
      id: newId,
      title: (p.title || 'From Feed').replace(/^/, '') || 'From Feed',
      lyrics: p.lyrics || '',
      hook: p.hook || '',
      bpm: p.bpm || 120,
      kit: p.kit || state.kit || 'trap',
      key: p.key || '',
      mood: p.mood || '',
      pattern: pattern,
      stepCount: p.stepCount || (pattern.kick && pattern.kick.length) || 16,
      chords: (p.chords || []).slice(),
      updated: Date.now()
    };
    if (!Array.isArray(state.songs)) state.songs = [];
    state.songs.unshift(song);
    try { persistSongs(); } catch (err) {}
    state.currentSongId = newId;
    state.bpm = song.bpm;
    state.kit = song.kit;
    state.stepCount = song.stepCount;
    if (song.pattern) state.pattern = song.pattern;
    if (song.chords.length) state.detectedChords = song.chords.slice();
    try { loadSong(newId); } catch (err) {
      const titleEl = document.getElementById('songTitle');
      if (titleEl) titleEl.value = song.title;
      const lyr = document.getElementById('lyrics');
      if (lyr) lyr.value = song.lyrics;
    }
    try {
      if (typeof lyricsToSections === 'function') lyricsToSections(song.lyrics);
      if (typeof showActiveSection === 'function') showActiveSection();
    } catch (err) {}
    try { ensurePatternLength(state.stepCount); buildTracks(); } catch (err) {}
    try { renderSongList(); } catch (err) {}
    setView('write');
    toast('Opened “' + song.title + '”');
  } catch (err) {
    console.warn('openFeedProject', err);
    toast('Could not open post');
  }
}

function shareFeedPost(id) {
  const social = loadSocial();
  const p = (social.feed || []).find(x => x.id === id);
  if (!p) return;
  const text = `"${p.title}" by ${p.username} — ${p.hook || 'on Tapehead'}\n${(p.lyrics||'').slice(0,120)}…`;
  if (navigator.share) navigator.share({ title: p.title, text }).catch(()=>{});
  else copyText(text).catch(()=>{});
}


function bindFeedGlobalOnce() {
  if (window.thFeedGlobalBound) return;
  window.thFeedGlobalBound = true;
  document.addEventListener('click', e => {
    const open = e.target.closest && e.target.closest('[data-open]');
    if (open && open.closest('#communityFeed')) {
      e.preventDefault();
      openFeedProject(open.getAttribute('data-open'));
      return;
    }
    const artist = e.target.closest && e.target.closest('[data-artist]');
    if (artist && artist.closest('#communityFeed, #publicProfileModal')) {
      if (e._thDone) return;
      e._thDone = true;
      openPublicProfile(artist.getAttribute('data-artist'));
    }
  });
}
function bindCommunityActions() {
  const el = document.getElementById('communityFeed');
  if (!el) return;
  if (el._bound) return;
  el._bound = true;
  el.addEventListener('click', e => {
    if (e.target.closest('[data-play],[data-add-vocal],[data-share-post],[data-like],[data-cmt],[data-cmt-send],[data-open],[data-delete-post],[data-artist]')) { if (e._thDone) return; e._thDone = true; }
    const playB = e.target.closest('[data-play]');
    if (playB) { playFeedPost(playB.getAttribute('data-play')); return; }
    const addV = e.target.closest('[data-add-vocal]');
    if (addV) { addVocalToPost(addV.getAttribute('data-add-vocal')); return; }
    const shareP = e.target.closest('[data-share-post]');
    if (shareP) { shareFeedPost(shareP.getAttribute('data-share-post')); return; }
    const like = e.target.closest('[data-like]');
    if (like) { toggleLike(like.getAttribute('data-like')); return; }
    const cmt = e.target.closest('[data-cmt]');
    if (cmt) {
      const box = document.getElementById('cmt-' + cmt.getAttribute('data-cmt'));
      if (box) box.hidden = !box.hidden;
      return;
    }
    const send = e.target.closest('[data-cmt-send]');
    if (send) {
      const id = send.getAttribute('data-cmt-send');
      const input = document.querySelector('[data-cmt-input="'+id+'"]');
      const text = (input && input.value || '').trim();
      if (!text) return;
      if (!state.user) { openAuth('signin'); return; }
      try { addComment(id, text); if (input) input.value = ''; } catch (err) { console.warn(err); }
      return;
    }
    const del = e.target.closest('[data-delete-post]');
    if (del) {
      e.preventDefault();
      e.stopPropagation();
      deleteOwnFeedPost(del.getAttribute('data-delete-post'));
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open) {
      const pid = open.getAttribute('data-open');
      openFeedProject(pid);
      return;
    }
    const artist = e.target.closest('[data-artist]');
    if (artist) {
      openPublicProfile(artist.getAttribute('data-artist'));
      return;
    }
  });
}



/* Feed sound engine */
state._feedPlayingId = null;
state._feedTimer = null;
state._feedVocalAudio = null;

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

async function captureVocalForFeed() {
  if (!state.vocal || !state.vocal.blob) return null;
  try {
    if (state.vocal.blob.size > 450000) return { tooLarge: true };
    const dataUrl = await blobToDataURL(state.vocal.blob);
    return { dataUrl, section: state.vocal.section, offsetMs: (state.vocal.offsetMs || 0) + (state.vocal.gapMs || 0) };
  } catch (e) { return null; }
}

function stopFeedPlayback() {
  if (state._feedTimer) { clearTimeout(state._feedTimer); state._feedTimer = null; }
  if (state._feedVocalAudio) {
    try { state._feedVocalAudio.pause(); } catch (e) {}
    state._feedVocalAudio = null;
  }
  if (state.playing && state._feedPlayingId) {
    try { stopTransport(); } catch (e) {}
  }
  state._feedPlayingId = null;
  document.querySelectorAll('.cc-play.playing').forEach(b => {
    b.classList.remove('playing');
    b.textContent = '▶';
  });
}

function playFeedBeat(post, loops) {
  loops = loops || 2;
  if (!post.pattern) return false;
  try {
    unlockAudio();
    // temporarily load pattern
    const prev = {
      pattern: JSON.parse(JSON.stringify(state.pattern)),
      bpm: state.bpm,
      kit: state.kit,
      stepCount: state.stepCount,
      playing: state.playing
    };
    state._feedRestore = prev;
    state.pattern = JSON.parse(JSON.stringify(post.pattern));
    state.bpm = post.bpm || 120;
    state.kit = post.kit || state.kit;
    state.stepCount = post.stepCount || (post.pattern.kick && post.pattern.kick.length) || 16;
    ensurePatternLength(state.stepCount);
    if (state.playing) stopTransport();
    startTransport();
    const stepMs = (60 / state.bpm) * 1000 / thSpb(); // matches the sequencer grid
    const total = stepMs * state.stepCount * loops;
    state._feedTimer = setTimeout(() => {
      stopTransport();
      if (state._feedRestore) {
        state.pattern = state._feedRestore.pattern;
        state.bpm = state._feedRestore.bpm;
        state.kit = state._feedRestore.kit;
        state.stepCount = state._feedRestore.stepCount;
        state._feedRestore = null;
      }
      stopFeedPlayback();
    }, Math.min(total, 16000));
    return true;
  } catch (e) {
    console.warn(e);
    return false;
  }
}

function playFeedVocal(post) {
  if (!post.vocalData && !post.vocalUrl) return false;
  try {
    const src = post.vocalData || post.vocalUrl;
    const a = new Audio(src);
    a.volume = 0.9;
    state._feedVocalAudio = a;
    a.onended = () => stopFeedPlayback();
    a.play();
    return true;
  } catch (e) { return false; }
}

function playFeedPost(id) {
  const social = loadSocial();
  const post = (social.feed || []).find(p => p.id === id);
  if (!post) return;
  if (state._feedPlayingId === id) {
    stopFeedPlayback();
    return;
  }
  stopFeedPlayback();
  state._feedPlayingId = id;
  if (post.mixdownUrl) {
    try {
      const a = new Audio(post.mixdownUrl);
      state._feedVocalAudio = a;
      a.onended = () => stopFeedPlayback();
      a.play();
      const btn = document.querySelector('.cc-play[data-play="'+id+'"]');
      if (btn) { btn.classList.add('playing'); btn.textContent = '■'; }
      return;
    } catch (e) {}
  }
  const btn = document.querySelector(`.cc-play[data-play="${id}"]`);
  if (btn) { btn.classList.add('playing'); btn.textContent = '■'; }

  const hasVocal = !!(post.vocalData || post.vocalUrl);
  const hasBeat = !!(post.pattern && Object.values(post.pattern).some(a => Array.isArray(a) && a.some(x => x)));

  if (hasBeat) playFeedBeat(post, hasVocal ? 4 : 2);
  if (hasVocal) {
    // slight delay so beat starts first
    setTimeout(() => playFeedVocal(post), post.vocalMeta?.offsetMs || 80);
  }
  if (!hasBeat && !hasVocal) {
    // play chord stabs if keys only
    if ((post.chords || []).length) {
      unlockAudio();
      post.chords.slice(0, 4).forEach((c, i) => {
        setTimeout(() => {
          const notes = (typeof CHORDS !== 'undefined' && CHORDS[c]) ? CHORDS[c] : null;
          if (notes) notes.forEach((n, j) => setTimeout(() => playNote(n, 3, 0.5), j * 30));
        }, i * 400);
      });
      state._feedTimer = setTimeout(stopFeedPlayback, 2000);
    } else {
      toast('No playable sound on this post');
      stopFeedPlayback();
    }
  }
}

function miniWaveHTML() {
  let s = '';
  for (let i = 0; i < 16; i++) {
    const h = 30 + Math.random() * 70;
    s += `<i style="height:${h}%"></i>`;
  }
  return s;
}


function avatarColor(name) {
  const colors = ['#F0B060','#7dd3fc','#c4b5fd','#f9a8d4','#86efac','#fcd34d','#a5b4fc','#fda4af'];
  let h = 0;
  const s = String(name || 'A');
  for (let i = 0; i < s.length; i++) h = (h + s.charCodeAt(i) * 17) % colors.length;
  return colors[h];
}

function estimatePlaySecs(p) {
  if (p.fullSong || p.mixdownUrl) return 32;
  if (p.vocalData || p.hasVocal) return 24;
  if (p.pattern) {
    const steps = p.stepCount || (p.pattern.kick && p.pattern.kick.length) || 16;
    const bpm = p.bpm || 120;
    return Math.max(8, Math.round(steps * (60 / bpm) * 2 / (((p.pattern && p.pattern._res) || 8) / 4)));
  }
  if ((p.chords || []).length) return 8;
  return 0;
}

function addVocalToPost(postId) {
  if (!state.user) { openAuth('signin'); return; }
  openFeedProject(postId);
  setView('record');
  toast('Record your vocal on this beat');
}

function renderCommunityFeed() {
  const el = document.getElementById('communityFeed');
  if (!el) return;
  const social = seedCommunity();
  let feed = (social.feed || []).slice();
  const q = (document.getElementById('feedSearch')?.value || '').trim().toLowerCase();
  const filter = getFeedFilter();
  const uid = currentUserId();

  if (q) {
    feed = feed.filter(p =>
      (p.title || '').toLowerCase().includes(q) ||
      (p.username || '').toLowerCase().includes(q) ||
      (p.lyrics || '').toLowerCase().includes(q) ||
      (p.hook || '').toLowerCase().includes(q)
    );
  }
  if (filter === 'mine' && state.user) {
    feed = feed.filter(p => p.userId === state.user.id || p.username === state.user.username);
  } else if (filter === 'following') {
    const following = new Set(state.feedFollowingIds || []);
    feed = state.user ? feed.filter(p => following.has(p.userId) || (p.userId && String(p.userId) === String(state.user.cloudId))) : [];
  } else if (filter === 'popular') {
    feed.sort((a, b) => {
      const lb = (social.likes[b.id] || []).length + (social.comments[b.id] || []).length * 2;
      const la = (social.likes[a.id] || []).length + (social.comments[a.id] || []).length * 2;
      return lb - la;
    });
  } else if (filter === 'collab') {
    feed = feed.filter(p => p.openToCollab);
  } else if (['trap','house','amapiano','afrobeats','gospel','rnb','afro','drill'].includes(filter)) {
    const aliases = { afrobeats:['afro','afrobeats'], rnb:['rnb','r&b','rb'], gospel:['gospel'], amapiano:['amapiano','piano'] };
    const keys = aliases[filter] || [filter];
    feed = feed.filter(p => {
      const kit = (p.kit || '').toLowerCase();
      const mood = (p.mood || '').toLowerCase();
      const title = (p.title || '').toLowerCase();
      return keys.some(k => kit.includes(k) || mood.includes(k) || title.includes(k));
    });
  } else if (filter === 'sound') {
    feed = feed.filter(p => p.hasSound || p.pattern || p.vocalData || p.hasVocal);
  } else if (filter === 'vocal') {
    feed = feed.filter(p => p.hasVocal || p.vocalData);
  } else if (filter === '120') {
    feed = feed.filter(p => Math.abs((p.bpm || 120) - 120) <= 8);
    feed.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  } else {
    feed.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  }

  if (!feed.length) {
    el.innerHTML = `<div class="feed-empty empty-state">
      <div class="es-icon">✦</div>
      <h3 class="fe-title">${q || (filter !== 'latest' && filter !== 'popular') ? 'No matches' : 'Feed is quiet'}</h3>
      <p>${filter === 'mine' ? 'Publish from Mix to appear here.' : filter === 'collab' ? 'No open-collab posts yet — mark Open to collab when you publish.' : q ? 'Try another search or clear filters.' : 'Be the first — write a hook, build a beat, and publish from Mix.'}</p>
      <button type="button" class="btn pri" id="feedEmptyPost" style="margin-top:12px">＋ Publish a session</button>
    </div>`;
    return;
  }

  el.innerHTML = feed.map(p => {
    const likes = (social.likes[p.id] || []);
    const comments = (social.comments[p.id] || []);
    const liked = uid && likes.includes(uid);
    const name = p.username || 'Artist';
    const initials = name.slice(0, 2).toUpperCase();
    const avColor = avatarColor(name);
    const av = p.avatar
      ? `<img src="${esc(p.avatar)}" alt="">`
      : initials;
    const lines = (p.lyrics || '').split('\n').filter(Boolean);
    const preview = lines.slice(0, 1).join(' ') || '';
    const date = new Date(p.updated || Date.now()).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const hook = p.hook || '';
    const hasAudio = !!(p.pattern || p.vocalData || p.hasVocal || p.mixdownUrl || p.fullSong || (p.chords || []).length);
    const secs = estimatePlaySecs(p);
    const dur = secs ? ('0:' + String(secs).padStart(2, '0')) : '';
    const openCollab = !!p.openToCollab;
    const wave = Array.from({ length: 20 }, (_, i) => {
      const ht = 28 + ((i * 19 + (p.id || '').length * 3) % 72);
      return '<i style="height:' + ht + '%"></i>';
    }).join('');
    const audioLabel = [
      (p.fullSong || p.mixdownUrl) ? 'Full' : '',
      (p.hasVocal || p.vocalData) ? 'Vocal' : '',
      p.pattern ? 'Beat' : '',
      (p.chords || []).length ? 'Keys' : ''
    ].filter(Boolean).join(' · ') || 'Preview';

    return `<div class="community-card" data-pid="${esc(p.id)}">
      <div class="cc-head">
        <div class="cc-av" data-artist="${esc(name)}" role="button" tabindex="0" aria-label="Open ${esc(name)} profile" style="background:${p.avatar ? 'transparent' : avColor}">${av}</div>
        <div style="flex:1;min-width:0">
          <div class="cc-name" data-artist="${esc(name)}">${esc(name)}</div>
          <div class="cc-meta">
            <span>${date}</span>
            ${openCollab ? '<span class="cc-open-dot">Open to collab</span>' : ''}
          </div>
        </div>
      </div>
      <div class="cc-title">${esc(p.title || 'Untitled')}</div>
      <div class="cc-tags">
        ${p.kit ? `<span class="cc-tag kit">${esc(p.kit)}</span>` : ''}
        ${p.bpm ? `<span class="cc-tag">${p.bpm} BPM</span>` : ''}
        ${p.key ? `<span class="cc-tag">Key ${esc(p.key)}</span>` : ''}
        ${p.fullSong ? '<span class="cc-tag" style="color:#4ade80">Full song</span>' : ''}
      </div>
      ${hasAudio ? `<div class="cc-player">
        <button type="button" class="cc-play" data-play="${esc(p.id)}" aria-label="Play">▶</button>
        <div class="cc-wave">${wave}</div>
        <div class="cc-player-meta">▶ ${dur}<br><span style="opacity:.8">${audioLabel}</span></div>
      </div>` : `<div class="cc-empty-audio">No vocal yet — Be first to sing</div>`}
      ${hook ? `<div class="cc-hook">“${esc(hook)}”</div>` : ''}
      ${preview ? `<div class="cc-lyrics">${esc(preview)}</div>` : ''}
      <div class="cc-actions">
        <button type="button" class="cc-btn${liked ? ' on' : ''}" data-like="${esc(p.id)}">♡ ${likes.length}</button>
        <button type="button" class="cc-btn" data-cmt="${esc(p.id)}">💬 ${comments.length}</button>
        <button type="button" class="cc-btn" data-open="${esc(p.id)}">Remix</button>
        ${String(p.userId) === String(uid) ? `<button type="button" class="cc-btn feed-delete-btn" data-delete-post="${esc(p.id)}">Delete</button>` : ''}
        ${hasAudio ? `<button type="button" class="cc-btn cc-btn-vocal" data-add-vocal="${esc(p.id)}">+ Vocal</button>` : ''}
      </div>
      <div class="comment-list" id="cmt-${esc(p.id)}" hidden>
        ${comments.map(c => `<div class="comment-item"><strong>${esc(c.user)}</strong> ${esc(c.text)}</div>`).join('') || '<div class="text-dim">No comments yet</div>'}
        <div class="comment-compose">
          <input placeholder="Write a comment…" maxlength="160" data-cmt-input="${esc(p.id)}">
          <button type="button" class="btn" data-cmt-send="${esc(p.id)}">Post</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function bindFeedPro() {
  document.getElementById('feedMainTabs')?.addEventListener('click', async e => {
    const tab = e.target.closest('[data-feed-main]');
    if (!tab) return;
    document.querySelectorAll('#feedMainTabs .feed-main-tab').forEach(x => x.classList.remove('on'));
    tab.classList.add('on');
    state.feedFilter = tab.dataset.feedMain || 'latest';
    if (state.feedFilter === 'following') await hydrateFeedFollowingIds();
    renderCommunityFeed();
  });
  document.getElementById('feedMoreBtn')?.addEventListener('click', () => {
    const box = document.getElementById('feedAdvanced');
    if (box) box.hidden = !box.hidden;
  });
  window.__thUpdateFeedMore = function () {
    const w = document.getElementById('feedLoadMoreWrap');
    if (w) w.hidden = !(window.__thFeedMore && Cloud.isCloud());
  };
  document.getElementById('feedLoadMoreBtn')?.addEventListener('click', async e => {
    const b = e.currentTarget;
    if (b.disabled) return;
    b.disabled = true; const t0 = b.textContent; b.textContent = 'Loading…';
    try {
      window.__thFeedLimit = (window.__thFeedLimit || 30) + 30;
      await syncCloudSocial();
    } catch (err) { console.warn('feed load more', err); }
    b.disabled = false; b.textContent = t0;
  });
  document.getElementById('communityFeed')?.addEventListener('click', async e => {
    if (!e.target.closest('[data-add-vocal],[data-share-post],[data-like],[data-cmt],[data-cmt-send],[data-open],[data-delete-post]')) return;
    if (e._thDone) return; e._thDone = true;
    const sh=e.target.closest('[data-share-post]'); if(sh){e.preventDefault();shareFeedPost(sh.getAttribute('data-share-post'));return;}
    const like=e.target.closest('[data-like]'); if(like){toggleLike(like.getAttribute('data-like'));return;}
    const cmt=e.target.closest('[data-cmt]'); if(cmt){const box=document.getElementById('cmt-'+cmt.getAttribute('data-cmt'));if(box)box.hidden=!box.hidden;return;}
    const send=e.target.closest('[data-cmt-send]'); if(send){const id=send.getAttribute('data-cmt-send'),input=document.querySelector('[data-cmt-input="'+id+'"]');const _t=input?.value||'';if(input)input.value='';await addComment(id,_t);return;}
    const del=e.target.closest('[data-delete-post]'); if(del){await deleteOwnFeedPost(del.getAttribute('data-delete-post'));return;}
    const open=e.target.closest('[data-open]'); if(open){openFeedProject(open.getAttribute('data-open'));return;}
    const vocal=e.target.closest('[data-add-vocal]'); if(vocal){addVocalToPost(vocal.getAttribute('data-add-vocal'));return;}
  });

  document.getElementById('feedFilters')?.addEventListener('click', e => {
    const chip = e.target.closest('[data-feed-filter]');
    if (!chip) return;
    document.querySelectorAll('#feedFilters .chip').forEach(c => c.classList.remove('on'));
    chip.classList.add('on');
    state.feedFilter = chip.dataset.feedFilter;
    document.querySelectorAll('#feedMainTabs .feed-main-tab').forEach(c => c.classList.remove('on'));
    renderCommunityFeed();
  });
  let t;
  document.getElementById('feedSearch')?.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => renderCommunityFeed(), 180);
  });
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function updateUserUI() {
  const u = state.user;
  if (u && u.username) state.artistName = u.username;
  const avBtn = document.getElementById('avatarBtn');
  if (!avBtn) return;
  const sideAv = document.getElementById('sidebarAv');
  const sideName = document.getElementById('sidebarName');
  const sideBadge = document.getElementById('sidebarBadge');
  if (u) {
    const initials = (u.username || 'A').slice(0, 2).toUpperCase();
    if (u.avatar) {
      avBtn.innerHTML = `<img src="${esc(u.avatar)}" alt="" loading="lazy" decoding="async">`;
      if (sideAv) sideAv.innerHTML = `<img src="${esc(u.avatar)}" alt="" loading="lazy" decoding="async">`;
    } else {
      avBtn.textContent = initials;
      if (sideAv) sideAv.textContent = initials;
    }
    if (sideName) sideName.textContent = u.username;
    if (sideBadge) sideBadge.textContent = u.contact;
  } else {
    avBtn.textContent = '?';
    if (sideAv) sideAv.textContent = '?';
    if (sideName) sideName.textContent = 'Guest';
    if (sideBadge) sideBadge.textContent = 'Tap avatar to sign in';
  }
}












async function signOut() {
  try { saveCurrentSong(); } catch (e) {}
  if (Cloud.isCloud()) {
    try { await Cloud.signOut(); } catch (e) { console.warn('cloud sign out', e); }
  }
  // keep account in th-users (pass + pro) — only clear session
  try {
    if (state.user && state.user.contact) {
      const users = loadUsers();
      const u = users[state.user.contact];
      if (u) {
        if (state.pro) u.pro = state.pro;
        saveUsers(users);
      }
    }
  } catch (e) {}
  state.user = null;
  state.guest = false;
  state.pro = null;
  try { savePro(null); } catch (e) {}
  saveSession(null);
  state.songs = [];
  state.currentSongId = null;
  state.collabCode = null;
  const app = document.querySelector('.app');
  if (app) app.classList.remove('app-guest');
  updateUserUI();
  renderSongList();
  try { closeProfile(); } catch (e) {}
  lockApp(true);
  openAuth('signin');
  softStatus('Signed out — sign in with the same details anytime');
  toast('Signed out');
}

function openAuth(tab) {
  const m = document.getElementById('authModal');
  if (m) { m.classList.add('show'); m.style.display = 'flex'; }
  setAuthTab(tab || 'signin');
}
function closeAuth() {
  const m = document.getElementById('authModal');
  if (m) {
    m.classList.remove('show');
    m.style.display = '';
    m.style.opacity = '';
    m.style.pointerEvents = '';
  }
  if (!state.user) {
    // "Not now" / dismiss → enter guest exploration instead of hard lock
    try { enterGuestMode(); } catch (e) { try { lockApp(false); } catch (e2) {} }
  } else {
    try { lockApp(false); } catch (e) {}
  }
}

function setAuthTab(tab) {
  const signin = tab !== 'signup';
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('on', t.dataset.auth === (signin ? 'signin' : 'signup')));
  const si = document.getElementById('authSignIn');
  const su = document.getElementById('authSignUp');
  if (si) si.hidden = !signin;
  if (su) su.hidden = signin;
  const title = document.getElementById('authTitle');
  const sub = document.getElementById('authSub');
  if (title) title.textContent = signin ? 'Welcome back' : 'Create your artist space';
  if (sub) sub.textContent = signin ? 'Sign in to your studio' : '30-day Pro trial included';
}



function readAvatarFile(file, cb) {
  if (!file || !file.type.startsWith('image/')) { toast('Choose an image'); return; }
  if (file.size > 2e6) { toast('Image max 2MB'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    // resize via canvas
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      const size = 256;
      c.width = size; c.height = size;
      const ctx = c.getContext('2d');
      const scale = Math.max(size / img.width, size / img.height);
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      cb(c.toDataURL('image/jpeg', 0.85));
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

/* openProfile moved */

function closeProfile() {
  const m = document.getElementById('profileModal');
  if (m) { m.classList.remove('show'); m.style.display = ''; }
}

/* saveProfile moved */


/* ── Collaboration Rooms ── */
function loadRooms() {
  try { return JSON.parse(localStorage.getItem('th-rooms') || '{}'); } catch { return {}; }
}
function saveRooms(rooms) { localStorage.setItem('th-rooms', JSON.stringify(rooms)); }

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = 'TH-';
  // Room codes are the join secret: use a CSPRNG (32 symbols divides 256 evenly, so masking is unbiased).
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  for (let i = 0; i < 8; i++) s += chars[buf[i] & 31];
  return s;
}

function defaultSections() {
  return [
    { id: 'intro', label: 'Intro', ownerId: null, ownerName: null, text: '' },
    { id: 'verse1', label: 'Verse 1', ownerId: null, ownerName: null, text: '' },
    { id: 'verse2', label: 'Verse 2', ownerId: null, ownerName: null, text: '' },
    { id: 'pre', label: 'Pre-Chorus', ownerId: null, ownerName: null, text: '' },
    { id: 'chorus', label: 'Chorus', ownerId: null, ownerName: null, text: '' },
    { id: 'bridge', label: 'Bridge', ownerId: null, ownerName: null, text: '' },
    { id: 'outro', label: 'Outro', ownerId: null, ownerName: null, text: '' }
  ];
}

function ensureCollabUser() {
  if (!state.user) {
    toast('Sign in to use Collaboration Rooms');
    openAuth('signin');
    return false;
  }
  return true;
}

async function createRoom(){
  if (!state.user) { openAuth('signin'); return; }
  try {
    const rooms = loadRooms();
    const code = genRoomCode();
    const titleEl = document.getElementById('songTitle');
    const lyrics = (document.getElementById('lyrics')?.value || '').trim();
    const room = {
      code,
      hostId: state.user.id,
      hostName: state.user.username || 'Artist',
      title: (titleEl && titleEl.value) ? titleEl.value : 'Collab Session',
      bpm: state.bpm || 120,
      pattern: JSON.parse(JSON.stringify(state.pattern || {})),
      kit: state.kit || 'trap',
      sections: defaultSections(),
      members: [{
        id: state.user.id,
        username: state.user.username || 'Artist',
        avatar: state.user.avatar || null,
        role: 'producer',
        ready: false,
        lastSeen: Date.now()
      }],
      vocals: [],
      activity: [{ text: 'opened the room', user: state.user.username, at: Date.now() }],
      updated: Date.now()
    };
    if (lyrics) {
      room.sections[1].text = lyrics.split('\n').slice(0, 8).join('\n');
      room.sections[1].ownerId = state.user.id;
      room.sections[1].ownerName = state.user.username;
    }
    rooms[code] = room;
    saveRooms(rooms);
    state.collabCode = code;
    if (typeof Cloud !== 'undefined' && Cloud.isCloud() && state.user.cloudId) {
      room.hostId = state.user.cloudId;
      room.members[0].id = state.user.cloudId;
      const created = await Cloud.createRoom(room);
      if (!created) { toast('Could not create the cloud room. Try again.'); return; }
      Cloud.subscribeRoom(code, async function() {
        var r = await Cloud.getRoom(code);
        if (r) { var rs = loadRooms(); rs[code] = r; saveRooms(rs); renderCollabView(); }
      });
      Cloud.subscribeCollabChat(code, async function(){var rr=await Cloud.fetchCollabMessages(code),rs=loadRooms(),room2=rs[code];if(room2){room2.activity=(rr||[]).map(m=>({id:m.id,text:m.body,user:m.username,at:new Date(m.created_at).getTime()})).slice(-40).reverse();rs[code]=room2;saveRooms(rs);renderCollabView();}});
    }
    renderCollabView();
    var codeEl = document.getElementById('roomCodeDisplay');
    if (codeEl) codeEl.textContent = code;
    var lobby = document.getElementById('collabLobby');
    var roomEl = document.getElementById('collabRoom');
    if (lobby) lobby.hidden = true;
    if (roomEl) roomEl.hidden = false;
  } catch (err) {
    console.error('createRoom', err);
    toast('Could not create room — try again');
  }
}

function joinRoom(code) {
  if (!state.user) { openAuth('signin'); return; }
  code = (code || '').trim().toUpperCase();
  if (!code) { toast('Enter a room code'); return; }
  if (typeof Cloud !== 'undefined' && Cloud.isCloud() && state.user.cloudId) {
    Cloud.joinRoom(code, { id: state.user.cloudId, username: state.user.username, avatar: state.user.avatar }).then(function(r) {
      if (!r) { toast('Room not found'); return; }
      var rooms = loadRooms();
      rooms[r.code] = r;
      saveRooms(rooms);
      state.collabCode = r.code;
      Cloud.subscribeRoom(r.code, async function() {
        var fresh = await Cloud.getRoom(r.code);
        if (fresh) { rooms[r.code] = fresh; saveRooms(rooms); renderCollabView(); }
      });
      Cloud.subscribeCollabChat(r.code, async function(){var rr=await Cloud.fetchCollabMessages(r.code),rs=loadRooms(),room2=rs[r.code];if(room2){room2.activity=(rr||[]).map(m=>({id:m.id,text:m.body,user:m.username,at:new Date(m.created_at).getTime()})).slice(-40).reverse();rs[r.code]=room2;saveRooms(rs);renderCollabView();}});
      renderCollabView();
    });
    return;
  }
  var rooms = loadRooms();
  var room = rooms[code];
  if (!room && code.indexOf('TH-') !== 0) room = rooms['TH-' + code];
  if (!room) { toast('Room not found on this device'); return; }
  if (!room.members.find(function(m){ return m.id === state.user.id; })) {
    room.members.push({
      id: state.user.id,
      username: state.user.username,
      avatar: state.user.avatar || null
    });
    room.updated = Date.now();
    rooms[room.code] = room;
    saveRooms(rooms);
  }
  state.collabCode = room.code;
  renderCollabView();
}

function leaveRoom() {
  const leavingCode = state.collabCode;
  // Revoke server-side access first; local UI state is cleared regardless so the user is never stuck in a room.
  if (leavingCode && typeof Cloud !== 'undefined' && Cloud.isCloud() && Cloud.leaveRoom) {
    Cloud.leaveRoom(leavingCode).then(ok => { if (!ok) { try { toast('Left on this device — could not update the room. Try again online.'); } catch (e) {} } }).catch(() => {});
  }
  try{Cloud.unsubscribeRoom();if(Cloud.collabChatChannel){Cloud.sb.removeChannel(Cloud.collabChatChannel);Cloud.collabChatChannel=null;}}catch(e){}
  state.collabCode = null;
  if (state._vocalMix) {
    try { state._vocalMix.forEach(a => { a.pause(); }); } catch(e) {}
    state._vocalMix = null;
  }
  /* quiet */;
  renderCollabView();
}

function getActiveRoom() {
  if (!state.collabCode) return null;
  const rooms = loadRooms();
  return rooms[state.collabCode] || null;
}

function saveActiveRoom(room, opts) {
  const rooms = loadRooms();
  room.updated = Date.now();
  try {
    if (window.TapeheadContinuity && window.TapeheadContinuity.snapshot) {
      const opts = typeof getAiOptions === 'function' ? getAiOptions() : {};
      room.continuity = window.TapeheadContinuity.snapshot(state, {
        key: opts.key || room.key, mood: opts.mood, style: opts.style,
        language: opts.language, bpm: room.bpm || state.bpm, hook: (document.getElementById('songHook')||{}).value
      });
    }
  } catch (e) { console.warn('[Tapehead] room continuity', e); }
  rooms[room.code] = room;
  saveRooms(rooms);
  // localOnly: presence/render bookkeeping must never write to the cloud (a write fires a realtime event,
  // which re-renders, which would write again: an endless request loop).
  if (Cloud.isCloud() && !(opts && opts.localOnly)) Cloud.saveRoom(room);
}

function claimNextSection() {
  const room = getActiveRoom();
  if (!room || !state.user) return;
  const empty = room.sections.find(s => !s.ownerId);
  if (!empty) { toast('All sections claimed'); return; }
  empty.ownerId = state.user.id;
  empty.ownerName = state.user.username;
  saveActiveRoom(room);
  renderSectionBoard(room);
  /* quiet */;
}

function updateSectionText(sectionId, text) {
  const room = getActiveRoom();
  if (!room || !state.user) return;
  const sec = room.sections.find(s => s.id === sectionId);
  if (!sec) return;
  if (sec.ownerId && sec.ownerId !== state.user.id) {
    toast('This section belongs to ' + sec.ownerName);
    return;
  }
  if (!sec.ownerId) {
    sec.ownerId = state.user.id;
    sec.ownerName = state.user.username;
  }
  sec.text = text;
  saveActiveRoom(room);
}

function renderSectionBoard(room) {
  const board = document.getElementById('sectionBoard');
  if (!board || !room) return;
  const uid = state.user?.id;
  board.innerHTML = room.sections.map(s => {
    const mine = s.ownerId === uid;
    const locked = s.ownerId && !mine;
    return `<div class="section-card" data-sec="${s.id}">
      <div class="sc-head">
        <span class="sc-title">${s.label}</span>
        <span class="sc-owner">${s.ownerName ? (mine ? 'You' : s.ownerName) : 'Open'}</span>
      </div>
      <textarea data-sec-input="${s.id}" placeholder="Write ${s.label.toLowerCase()}…" ${locked ? 'disabled' : ''}>${esc(s.text || '')}</textarea>
    </div>`;
  }).join('');
  board.querySelectorAll('[data-sec-input]').forEach(ta => {
    let t;
    ta.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => updateSectionText(ta.getAttribute('data-sec-input'), ta.value), 400);
    });
  });
}

function mergeSectionsToLyrics() {
  const room = getActiveRoom();
  if (!room) return;
  const parts = room.sections
    .filter(s => (s.text || '').trim())
    .map(s => `[${s.label}]\n${s.text.trim()}`);
  if (!parts.length) { toast('No section text yet'); return; }
  const merged = parts.join('\n\n');
  document.getElementById('lyrics').value = merged;
  if (room.title) document.getElementById('songTitle').value = room.title;
  saveCurrentSong();
  setView('write');
  /* quiet */;
}

function pushBeatToRoom() {
  const room = getActiveRoom();
  if (!room) return;
  room.pattern = JSON.parse(JSON.stringify(state.pattern));
  room.bpm = state.bpm;
  room.kit = state.kit;
  room.chords = (state.detectedChords || []).slice();
  room.activity = room.activity || [];
  room.activity.unshift({ text: 'pushed beat (' + (state.bpm||120) + ' BPM · ' + (state.kit||'kit') + ')', user: (state.user&&state.user.username)||'Artist', at: Date.now() });
  saveActiveRoom(room);
  try { snapshotRoomVersion('After push · ' + (state.bpm||120) + ' BPM'); } catch (e) { renderCollabView(); }
  toast('Beat pushed to room');
}

function pullBeatFromRoom() {
  const room = getActiveRoom();
  if (!room || !room.pattern) { toast('No beat in room yet'); return; }
  state.pattern = JSON.parse(JSON.stringify(room.pattern));
  if (room.bpm) {
    state.bpm = room.bpm;
    document.getElementById('bpmBadge').textContent = room.bpm + ' BPM';
  }
  if (room.kit) state.kit = room.kit;
  buildTracks();
  saveCurrentSong();
  setView('beat');
  /* quiet */;
}

function addVocalTake(file) {
  const room = getActiveRoom();
  if (!room || !state.user) return;
  if (!file) return;
  if (file.size > 8e6) { toast('Audio max 8MB'); return; }
  if (Cloud.isCloud() && state.user.cloudId) {
    /* quiet */;
    Cloud.uploadVocal(room.code, { id: state.user.cloudId, username: state.user.username }, file).then(url => {
      if (url) {
        room.vocals = (room.vocals || []).filter(v => v.userId !== state.user.cloudId);
        room.vocals.push({ userId: state.user.cloudId, username: state.user.username, name: file.name, dataUrl: url, at: Date.now() });
        saveActiveRoom(room);
        renderVocalSlots(room);
        /* quiet */;
      } else toast('Upload failed — check Storage bucket "vocals"');
    });
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    room.vocals = room.vocals || [];
    // replace existing take by same user
    room.vocals = room.vocals.filter(v => v.userId !== state.user.id);
    room.vocals.push({
      userId: state.user.id,
      username: state.user.username,
      name: file.name,
      dataUrl: reader.result,
      at: Date.now()
    });
    saveActiveRoom(room);
    renderVocalSlots(room);
    /* quiet */;
  };
  reader.readAsDataURL(file);
}

function renderVocalSlots(room) {
  const el = document.getElementById('vocalSlots');
  if (!el || !room) return;
  const vocals = room.vocals || [];
  if (!vocals.length) {
    el.innerHTML = '<div class="text-dim text-center" style="padding:12px;font-size:12px">No vocals yet — upload your take</div>';
    return;
  }
  el.innerHTML = vocals.map(v => `
    <div class="vocal-slot">
      <div class="vs-info">
        <div class="vs-name">${esc(v.username)}</div>
        <div class="vs-meta">${esc(v.name || 'Vocal take')}</div>
        <audio controls src="${esc(v.dataUrl)}" preload="none"></audio>
      </div>
    </div>`).join('');
}

function previewBeatWithVocals() {
  const room = getActiveRoom();
  if (!room) return;
  // Start sequencer + play all vocal audio elements
  if (!state.playing) startTransport();
  const audios = document.querySelectorAll('#vocalSlots audio');
  audios.forEach(a => {
    try {
      a.currentTime = 0;
      a.play();
    } catch (e) {}
  });
  /* quiet */;
}


function startCollabPoll(){
  stopCollabPoll();
  state._collabPoll = setInterval(() => {
    if (state.view === 'collab' && state.collabCode) renderCollabView();
  }, 2500);
}
function stopCollabPoll(){
  if (state._collabPoll) { clearInterval(state._collabPoll); state._collabPoll = null; }
}


/* ── Collab pro upgrades ── */
function pushRoomActivity(room, text, user) {
  if (!room.activity) room.activity = [];
  room.activity.unshift({
    text,
    user: user || state.user?.username || 'Artist',
    at: Date.now()
  });
  room.activity = room.activity.slice(0, 40);
  room.updated = Date.now();
}

function setMemberMeta(room, patch) {
  if (!room || !state.user) return;
  const m = (room.members || []).find(x => x.id === state.user.id);
  if (!m) return;
  Object.assign(m, patch);
  m.lastSeen = Date.now();
}


function snapshotRoomVersion(label) {
  const room = getActiveRoom();
  if (!room) { toast('Join a room first'); return; }
  room.history = room.history || [];
  const snap = {
    id: 'v_' + Date.now().toString(36),
    at: Date.now(),
    by: (state.user && state.user.username) || 'Artist',
    label: label || ('Snapshot ' + (room.history.length + 1)),
    bpm: room.bpm || state.bpm,
    kit: room.kit || state.kit,
    pattern: room.pattern ? JSON.parse(JSON.stringify(room.pattern)) : JSON.parse(JSON.stringify(state.pattern || {})),
    sections: (room.sections || []).map(sec => ({
      id: sec.id, label: sec.label, text: sec.text || '', note: sec.note || '',
      ownerId: sec.ownerId || null, ownerName: sec.ownerName || null
    })),
    chords: (room.chords || state.detectedChords || []).slice(),
    continuity: room.continuity || state._continuity || null
  };
  room.history.unshift(snap);
  while (room.history.length > 12) room.history.pop();
  room.activity = room.activity || [];
  room.activity.unshift({ text: 'saved version “' + snap.label + '”', user: snap.by, at: Date.now() });
  while (room.activity.length > 40) room.activity.pop();
  saveActiveRoom(room);
  renderCollabView();
  toast('Version saved');
}
function restoreRoomVersion(vid) {
  const room = getActiveRoom();
  if (!room || !room.history) return;
  const snap = room.history.find(h => h.id === vid);
  if (!snap) { toast('Version not found'); return; }
  if (!confirm('Restore “' + snap.label + '”? Current room beat & sections will be replaced.')) return;
  room.bpm = snap.bpm || room.bpm;
  room.kit = snap.kit || room.kit;
  if (snap.pattern) room.pattern = JSON.parse(JSON.stringify(snap.pattern));
  if (snap.sections) room.sections = JSON.parse(JSON.stringify(snap.sections));
  if (snap.chords) room.chords = snap.chords.slice();
  if (snap.continuity) { room.continuity = snap.continuity; state._continuity = snap.continuity; try{updateContinuityBadge()}catch(e){} }
  // Apply into local studio
  if (snap.pattern) state.pattern = JSON.parse(JSON.stringify(snap.pattern));
  if (snap.bpm) state.bpm = snap.bpm;
  if (snap.kit) state.kit = snap.kit;
  if (snap.chords) state.detectedChords = snap.chords.slice();
  try { ensurePatternLength(state.stepCount || 16); buildTracks(); } catch (e) {}
  const bpmBadge = document.getElementById('bpmBadge');
  if (bpmBadge) bpmBadge.textContent = (state.bpm || 120) + ' BPM';
  room.activity = room.activity || [];
  room.activity.unshift({
    text: 'restored version “' + snap.label + '”',
    user: (state.user && state.user.username) || 'Artist',
    at: Date.now()
  });
  saveActiveRoom(room);
  renderCollabView();
  toast('Restored “' + snap.label + '”');
}
function renderRoomVersions(room) {
  const el = document.getElementById('roomVersionList');
  if (!el) return;
  const hist = (room && room.history) || [];
  if (!hist.length) {
    el.innerHTML = '<div class="text-dim" style="font-size:12px;padding:8px 0">No snapshots yet — tap Snapshot after a solid take.</div>';
    return;
  }
  el.innerHTML = hist.map(h => {
    const when = new Date(h.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const secs = (h.sections || []).filter(x => (x.text || '').trim()).length;
    return `<div class="version-item" data-vid="${h.id}">
      <div class="vi-meta"><strong>${esc(h.label)}</strong><span>${when} · ${esc(h.by)} · ${h.bpm || 120} BPM · ${secs} sections</span></div>
      <button type="button" class="btn" style="padding:4px 8px;font-size:11px" data-restore-ver="${h.id}">Restore</button>
    </div>`;
  }).join('');
}

async function renderCollabDiscover(){
  const el=document.getElementById('collabDiscover');
  if(!el)return;
  const localUsers=(()=>{try{return Object.values(loadUsers()||{}).map(u=>({id:u.id,username:u.username,avatar:u.avatar,avatar_url:u.avatar_url,bio:u.bio,genres:u.genres,open_to_collab:u.openToCollab})).filter(u=>u.open_to_collab);}catch(e){return[];}})();
  let profiles=localUsers;
  if(Cloud.isCloud()&&Cloud.sb){
    try{const {data}=await Cloud.sb.from('public_profiles').select('id,username,avatar_url,bio,genres,open_to_collab').eq('open_to_collab',true).limit(8);if(data?.length)profiles=data;}catch(e){console.warn('collab discover',e);}
  }
  const seen=new Set();
  profiles=profiles.filter(p=>{const k=String(p.id||p.username||'').toLowerCase();if(!k||seen.has(k))return false;seen.add(k);return String(p.username||'').toLowerCase()!==String(state.user?.username||'').toLowerCase();}).slice(0,8);
  el.innerHTML=profiles.length?'<div class="collab-artist-grid">'+profiles.map(p=>{
    const name=p.username||'Artist', genres=Array.isArray(p.genres)?p.genres.slice(0,2).join(' · '):'';
    const av=p.avatar_url||p.avatar;
    return `<div class="collab-artist"><div class="collab-artist-av">${av?`<img src="${esc(av)}" alt="" loading="lazy" decoding="async">`:esc(name.slice(0,2).toUpperCase())}</div><div class="collab-artist-copy"><div class="collab-artist-name">${esc(name)}</div><div class="collab-artist-meta">${esc(genres||'Artist')}</div><span class="collab-open-dot">Open to collab</span></div><button class="btn collab-artist-action" type="button" data-collab-artist="${esc(name)}">Invite</button></div>`;
  }).join('')+'</div>':'<div class="collab-discover-empty text-dim">No artists are showing as open to collaboration yet.</div>';
  el.querySelectorAll('[data-collab-artist]').forEach(b=>b.addEventListener('click',()=>{const name=b.dataset.collabArtist;try{openPublicProfile(name);}catch(e){} }));
}

function renderCollabView() {
  const lobby = document.getElementById('collabLobby');
  const roomEl = document.getElementById('collabRoom');
  if (!lobby || !roomEl) return;

  const rooms = loadRooms();
  const myList = document.getElementById('myRoomsList');
  if (myList) {
    const mine = Object.values(rooms).filter(r =>
      r.members?.some(m => m.id === state.user?.id) || r.hostId === state.user?.id
    ).slice(0, 8);
    if (mine.length && state.user) {
      myList.innerHTML = '<div class="modal-label">Your rooms</div>' + mine.map(r =>
        `<button type="button" class="btn" style="width:100%;margin-bottom:6px;justify-content:space-between" data-rejoin="${r.code}">
          <span>${esc(r.code)}</span><span class="text-dim">${(r.members||[]).length} artists</span>
        </button>`
      ).join('');
      myList.querySelectorAll('[data-rejoin]').forEach(b => {
        b.addEventListener('click', () => joinRoom(b.getAttribute('data-rejoin')));
      });
    } else myList.innerHTML = '';
  }

  const room = getActiveRoom();
  if (!room) {
    lobby.hidden = false;
    roomEl.hidden = true;
    renderCollabDiscover();
    return;
  }
  lobby.hidden = true;
  roomEl.hidden = false;

  // presence heartbeat (local only; rendering must not trigger cloud writes)
  setMemberMeta(room, { present: true });
  saveActiveRoom(room, { localOnly: true });

  document.getElementById('roomCodeDisplay').textContent = room.code;
  const mem = document.getElementById('roomMembers');
  if (mem) {
    const members = room.members || [];
    const online = members.filter(m => !(m.lastSeen && (Date.now() - m.lastSeen > 120000))).length;
    mem.innerHTML = members.map(m => {
      const me = m.id === state.user?.id;
      const ready = m.ready ? ' ✓' : '';
      const role = m.role || 'writer';
      const away = m.lastSeen && (Date.now() - m.lastSeen > 120000);
      const av = m.avatar ? `<img src="${esc(m.avatar)}" alt="" style="width:20px;height:20px;border-radius:50%;object-fit:cover">` : '';
      return `<div class="presence-chip${away?' away':''}" title="${esc(m.username)} · ${away?'away':'online'}">
        <span class="dot"></span>${av}<span>${esc(m.username||'?')}${me?' (you)':''}${ready}</span>
        <span class="role">${esc(role)}</span>
      </div>`;
    }).join('') + (members.length ? `<div class="presence-summary"><strong>${online}</strong> online · ${members.length} in room</div>` : '');
  }

  const meta = document.getElementById('roomBeatMeta');
  if (meta) {
    meta.textContent = `Beat · ${room.bpm || 120} BPM · ${(room.kit || 'trap')} kit · ${(room.sections||[]).filter(s=>s.ownerId).length}/${(room.sections||[]).length} sections claimed`;
  }

  const roleSel = document.getElementById('myRoleSelect');
  if (roleSel && state.user) {
    const me = (room.members||[]).find(m => m.id === state.user.id);
    if (me && me.role) roleSel.value = me.role;
  }
  const readyBtn = document.getElementById('readyToggleBtn');
  if (readyBtn && state.user) {
    const me = (room.members||[]).find(m => m.id === state.user.id);
    readyBtn.textContent = me?.ready ? '✓ Ready' : 'Mark ready';
    readyBtn.classList.toggle('pri', !!me?.ready);
  }

  // sections board
  const board = document.getElementById('sectionBoard');
  if (board) {
    board.innerHTML = (room.sections || []).map((sec, idx) => {
      const mine = sec.ownerId === state.user?.id;
      const locked = sec.ownerId && !mine;
      const owner = sec.ownerName || (sec.ownerId ? 'Taken' : 'Open');
      return `<div class="section-card${mine?' mine':''}${locked?' locked':''}" data-sec-idx="${idx}">
        <div class="sc-head">
          <span class="sc-label">${esc(sec.label || ('Section '+(idx+1)))}</span>
          <span class="text-dim" style="font-size:11px">${esc(owner)}</span>
        </div>
        <textarea data-sec-text="${idx}" ${locked?'readonly':''} placeholder="${locked?'Locked — claimed by '+owner:'Write this section…'}">${esc(sec.text||'')}</textarea>
        <input class="sc-note" data-sec-note="${idx}" ${locked?'readonly':''} placeholder="Note (e.g. need stronger ending)" value="${esc(sec.note||'')}">
        <div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap">
          ${!sec.ownerId ? `<button type="button" class="btn" style="font-size:11px" data-claim-idx="${idx}">Claim</button>` : ''}
          ${mine ? `<button type="button" class="btn ghost" style="font-size:11px" data-release-idx="${idx}">Release</button>` : ''}
          ${mine ? `<button type="button" class="btn ghost" style="font-size:11px" data-to-write-idx="${idx}">→ Write</button>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  // activity
  const act = document.getElementById('roomActivity');
  if (act) {
    const items = room.activity || [];
    act.innerHTML = items.length
      ? items.map(a => `<div><strong>${esc(a.user)}</strong> · ${esc(a.text)} <span style="opacity:.6">${new Date(a.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span></div>`).join('')
      : '<div>No activity yet — claim a section or send a note.</div>';
  }

  try { renderRoomVersions(room); } catch (e) {}
  renderVocalSlots(room);
}

function bindCollabProExtras() {
  document.getElementById('shareRoomBtn')?.addEventListener('click', () => {
    const room = getActiveRoom();
    if (!room) return;
    const text = `Join my Tapehead collab room: ${room.code}`;
    if (navigator.share) {
      navigator.share({ title: 'Tapehead Collab', text }).catch(() => {});
    } else {
      copyText(text).then(ok => { if (ok) setAiStatus('Invite copied'); });
    }
  });
  document.getElementById('myRoleSelect')?.addEventListener('change', e => {
    const room = getActiveRoom();
    if (!room) return;
    setMemberMeta(room, { role: e.target.value });
    pushRoomActivity(room, 'set role to ' + e.target.value);
    saveActiveRoom(room);
    renderCollabView();
  });
  document.getElementById('readyToggleBtn')?.addEventListener('click', () => {
    const room = getActiveRoom();
    if (!room || !state.user) return;
    const me = (room.members||[]).find(m => m.id === state.user.id);
    const next = !me?.ready;
    setMemberMeta(room, { ready: next });
    pushRoomActivity(room, next ? 'is ready ✓' : 'unmarked ready');
    saveActiveRoom(room);
    renderCollabView();
  });
  document.getElementById('activitySendBtn')?.addEventListener('click', sendRoomNote);
  document.getElementById('activityInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') sendRoomNote();
  });
  document.getElementById('sectionBoard')?.addEventListener('click', e => {
    const claim = e.target.closest('[data-claim-idx]');
    const release = e.target.closest('[data-release-idx]');
    const toWrite = e.target.closest('[data-to-write-idx]');
    const room = getActiveRoom();
    if (!room || !state.user) return;
    if (claim) {
      const i = parseInt(claim.dataset.claimIdx, 10);
      const sec = room.sections[i];
      if (sec && !sec.ownerId) {
        sec.ownerId = state.user.id;
        sec.ownerName = state.user.username;
        pushRoomActivity(room, 'claimed ' + (sec.label||'section'));
        saveActiveRoom(room);
        renderCollabView();
      }
    }
    if (release) {
      const i = parseInt(release.dataset.releaseIdx, 10);
      const sec = room.sections[i];
      if (sec && sec.ownerId === state.user.id) {
        sec.ownerId = null;
        sec.ownerName = null;
        pushRoomActivity(room, 'released ' + (sec.label||'section'));
        saveActiveRoom(room);
        renderCollabView();
      }
    }
    if (toWrite) {
      const i = parseInt(toWrite.dataset.toWriteIdx, 10);
      const sec = room.sections[i];
      if (sec) {
        try {
          ensureWriteSections();
          let w = state.writeSections.find(s => (s.label||'').toLowerCase() === (sec.label||'').toLowerCase());
          if (!w) {
            w = { id: 'collab'+Date.now(), label: sec.label || 'Section', text: sec.text || '' };
            state.writeSections.push(w);
          } else w.text = sec.text || '';
          state.writeSectionId = w.id;
          showActiveSection();
          setView('write');
        } catch(err) {}
      }
    }
  });
  document.getElementById('sectionBoard')?.addEventListener('change', e => {
    const room = getActiveRoom();
    if (!room || !state.user) return;
    const t = e.target;
    if (t.dataset.secText != null) {
      const i = parseInt(t.dataset.secText, 10);
      const sec = room.sections[i];
      if (sec && sec.ownerId === state.user.id) {
        sec.text = t.value;
        saveActiveRoom(room);
      }
    }
    if (t.dataset.secNote != null) {
      const i = parseInt(t.dataset.secNote, 10);
      const sec = room.sections[i];
      if (sec && (!sec.ownerId || sec.ownerId === state.user.id)) {
        sec.note = t.value;
        saveActiveRoom(room);
      }
    }
  });
  // also input event for live save
  document.getElementById('sectionBoard')?.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.secText == null && t.dataset.secNote == null) return;
    const room = getActiveRoom();
    if (!room || !state.user) return;
    if (t.dataset.secText != null) {
      const i = parseInt(t.dataset.secText, 10);
      const sec = room.sections[i];
      if (sec && sec.ownerId === state.user.id) sec.text = t.value;
    }
    if (t.dataset.secNote != null) {
      const i = parseInt(t.dataset.secNote, 10);
      const sec = room.sections[i];
      if (sec && (!sec.ownerId || sec.ownerId === state.user.id)) sec.note = t.value;
    }
    clearTimeout(state._collabSaveT);
    state._collabSaveT = setTimeout(() => saveActiveRoom(room), 400);
  });
}

async function sendRoomNote(){const room=getActiveRoom(),input=document.getElementById('activityInput'),text=(input?.value||'').trim();if(!room||!text)return;if(Cloud.isCloud()&&state.user?.cloudId){const r=await Cloud.sendCollabMessage(room.code,text);if(r){room.activity=room.activity||[];room.activity.unshift({id:r.id,text:r.body,user:r.username,at:new Date(r.created_at).getTime()});room.activity=room.activity.slice(0,40);}}else{pushRoomActivity(room,text);saveActiveRoom(room);}if(input)input.value='';renderCollabView();}


function bindCollabUI() {
  document.getElementById('createRoomBtn')?.addEventListener('click', createRoom);
  document.getElementById('focusJoinCodeBtn')?.addEventListener('click', () => {
    const box=document.getElementById('collabJoinInline'); if(box){box.hidden=false; document.getElementById('joinCodeInput')?.focus();}
  });
  document.getElementById('refreshCollabArtists')?.addEventListener('click', renderCollabDiscover);
  document.getElementById('pasteCodeBtn')?.addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      const inp = document.getElementById('joinCodeInput');
      if (inp && t) inp.value = t.trim().toUpperCase();
    } catch (e) { toast('Paste not available'); }
  });
  document.getElementById('joinCodeInput')?.addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase();
  });
  document.getElementById('joinRoomBtn')?.addEventListener('click', () => {
    joinRoom(document.getElementById('joinCodeInput')?.value);
  });
  document.getElementById('joinCodeInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') joinRoom(e.target.value);
  });
  document.getElementById('leaveRoomBtn')?.addEventListener('click', leaveRoom);
  document.getElementById('copyRoomCode')?.addEventListener('click', () => {
    const code = state.collabCode;
    if (!code) return;
    copyText(code).catch(() => {});
  });
  document.getElementById('claimSectionBtn')?.addEventListener('click', claimNextSection);
  document.getElementById('mergeToLyrics')?.addEventListener('click', mergeSectionsToLyrics);
  document.getElementById('collabPushBeat')?.addEventListener('click', pushBeatToRoom);
  document.getElementById('collabSyncBeat')?.addEventListener('click', pullBeatFromRoom);
  document.getElementById('vocalUpload')?.addEventListener('change', e => {
    const f = e.target.files?.[0];
    if (f) addVocalTake(f);
    e.target.value = '';
  });
  document.getElementById('playMixPreview')?.addEventListener('click', previewBeatWithVocals);
}


/* ── Pro / Monetization ── */
const FREE_PROJECT_LIMIT = 3;

function loadPro() {
  try {
    const raw = localStorage.getItem('th-pro');
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p && p.active) return p;
  } catch (e) {}
  return null;
}

function savePro(data) {
  if (data) localStorage.setItem('th-pro', JSON.stringify(data));
  else localStorage.removeItem('th-pro');
}

function isPro() {
  try {
    const p = state.pro || loadPro();
    if (!p || !p.active) return false;
    if (p.expires && Date.now() > p.expires) {
      try { savePro(null); } catch (e) {}
      state.pro = null;
      return false;
    }
    state.pro = p;
    return true;
  } catch (e) {
    return false;
  }
}

function daysLeftPro() {
  try {
    const p = state.pro || loadPro();
    if (!p || !p.active || !p.expires) return null;
    return Math.max(0, Math.ceil((p.expires - Date.now()) / 864e5));
  } catch (e) { return null; }
}




const PROFILE_GENRES = ['Afrobeats','Amapiano','Trap','Drill','Gospel','R&B','Hip-Hop','House','Pop','Lo-Fi','Dancehall','Jazz'];


function persistUserPro(pro) {
  try {
    if (!state.user || !state.user.contact) return;
    const users = loadUsers();
    const u = users[state.user.contact];
    if (u) {
      u.pro = pro;
      if (pro && pro.plan === 'trial') u.trialUsed = true;
      saveUsers(users);
    }
  } catch (e) {}
}


async function loadLivePrices() {
  try {
    const r = await fetch('/api/pro-plans', { cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    const fmt = n => '$' + (Number.isInteger(Number(n)) ? Number(n) : Number(n).toFixed(2));
    Object.entries(d.plans || {}).forEach(([id, p]) => {
      const el = document.querySelector('[data-price-for="' + id + '"]');
      if (el && p && p.amount) el.innerHTML = fmt(p.amount) + ' <span style="font-size:11px;font-weight:500;color:var(--dim)">USD</span>';
    });
  } catch (e) { /* keep static prices */ }
}

function openPaywall(reason) {
  try {
    if (!state.user) { openAuth('signin'); return; }
    loadLivePrices();
    state.payMethod = 'pesapal';
    state.selectedPlan = state.selectedPlan || 'month';
    try {
      document.querySelectorAll('#payMethods .pay-method').forEach(el => {
        el.classList.toggle('on', el.dataset.pay === state.payMethod);
      });
      if (typeof showPayFields === 'function') showPayFields(state.payMethod);
      document.querySelectorAll('.price-card').forEach(el => {
        el.classList.toggle('on', el.dataset.plan === state.selectedPlan);
      });
    } catch (e) {}
    const sub = document.querySelector('#paywallModal .modal-sub');
    if (sub && reason) sub.textContent = String(reason);
    else if (sub) sub.textContent = isPro() ? 'Extend or change your Pro plan' : 'AI, collab, unlimited projects — 30-day free trial included';
    const modal = document.getElementById('paywallModal');
    if (modal) {
      modal.classList.add('show');
      modal.style.display = 'flex';
      modal.style.opacity = '1';
      modal.style.pointerEvents = 'auto';
    }
    try { updateProUI(); } catch (e) {}
  } catch (err) {
    console.warn(err);
    toast('Could not open Pro');
  }
}

function closePaywall() {
  const modal = document.getElementById('paywallModal');
  if (modal) {
    modal.classList.remove('show');
    modal.style.display = 'none';
    modal.style.opacity = '';
    modal.style.pointerEvents = 'none';
  }
  document.body.classList.remove('menu-open');
  try {
    const app = document.querySelector('.app');
    if (app) { app.style.filter = ''; app.style.pointerEvents = ''; }
  } catch (e) {}
  // kill any stuck overlays
  document.querySelectorAll('.modal-overlay').forEach(ov => {
    if (!ov.classList.contains('show')) {
      ov.style.display = 'none';
      ov.style.pointerEvents = 'none';
    }
  });
}

function activateProPlan(planId, methodLabel) {
  const plan = (typeof PRO_PLANS !== 'undefined' && PRO_PLANS[planId]) ? PRO_PLANS[planId] : { id: planId || 'month', label: 'Pro', days: 30 };
  const days = plan.days || 30;
  const pro = {
    active: true,
    plan: plan.id || planId || 'month',
    label: plan.label || 'Pro',
    method: methodLabel || state.payMethod || 'demo',
    userId: state.user && (state.user.id || state.user.contact),
    started: Date.now(),
    expires: Date.now() + days * 864e5
  };
  state.pro = pro;
  try { savePro(pro); } catch (e) {}
  try {
    const users = loadUsers();
    const key = normalizeContact(state.user.contact);
    if (users[key]) {
      users[key].isPro = true;
      users[key].pro = pro;
      saveUsers(users);
    }
  } catch (e) {}
  try { updateProUI(); } catch (e) {}
  toast('Pro active — ' + (plan.label || 'Pro') + ' · ' + days + ' days');
  closePaywall();
  return true;
}

function processProPayment() {
  if (!state.user) { openAuth('signin'); return; }
  if (!Cloud.isCloud()) { toast('Secure payments require Cloud mode.'); return; }
  const planId = state.selectedPlan || 'month';
  (async () => {
    try {
      const session = await Cloud.ensureSession();
      if (!session?.access_token) { toast('Please sign in again.'); return; }
      toast('Opening secure checkout…');
      const r = await fetch('/api/pro-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token },
        body: JSON.stringify({ plan: planId })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.link) { toast(data.error || 'Could not start checkout.'); return; }
      state.pendingTxRef = data.tx_ref;
      localStorage.setItem('th-pending-tx', data.tx_ref);
      window.location.href = data.link;
    } catch (e) {
      console.warn('processProPayment', e);
      toast('Could not start secure checkout.');
    }
  })();
}


function startTrialFromPaywall() {
  if (!state.user) { openAuth('signin'); return; }
  if (!Cloud.isCloud()) { toast('Cloud account required for the secure trial.'); return; }
  (async () => {
    try {
      const session = await Cloud.ensureSession();
      if (!session?.access_token) { toast('Please sign in again.'); return; }
      const r = await fetch('/api/pro-trial', { method:'POST', headers:{Authorization:'Bearer '+session.access_token} });
      const data = await r.json().catch(()=>({}));
      if (!r.ok || !data.entitlement) { toast(data.error || 'Trial unavailable.'); return; }
      state.pro = { active:true, plan:data.entitlement.plan, label:'30-day free trial', started:data.entitlement.started_at ? new Date(data.entitlement.started_at).getTime() : Date.now(), expires:data.entitlement.expires_at ? new Date(data.entitlement.expires_at).getTime() : null, server:true };
      updateProUI(); closePaywall(); toast('30-day Pro trial started');
    } catch(e) { console.warn('startTrial',e); toast('Could not start trial.'); }
  })();
}




function showPayFields(method) {
  const el = document.getElementById('payFieldsPesapal');
  if (el) el.hidden = false;
}

function bindPaywallUI() {
  if (window._paywallBound) return;
  window._paywallBound = true;
    document.getElementById('payNowBtn')?.addEventListener('click', e => { e.preventDefault(); processProPayment(); });
  document.getElementById('startTrialBtn')?.addEventListener('click', e => { e.preventDefault(); startTrialFromPaywall(); });
  document.getElementById('closePaywall')?.addEventListener('click', closePaywall);
  document.getElementById('paywallModal')?.addEventListener('click', e => {
    if (e.target.id === 'paywallModal') closePaywall();
  });
  document.getElementById('payMethods')?.addEventListener('click', e => {
    const pm = e.target.closest('.pay-method');
    if (!pm) return;
    state.payMethod = pm.dataset.pay;
    document.querySelectorAll('#payMethods .pay-method').forEach(el => el.classList.toggle('on', el === pm));
    showPayFields(state.payMethod);
  });
  document.querySelectorAll('.price-card').forEach(card => {
    card.addEventListener('click', () => {
      state.selectedPlan = card.dataset.plan;
      document.querySelectorAll('.price-card').forEach(c => c.classList.toggle('on', c === card));
    });
  });
}

function getUserProfileExtras(contact) {
  try {
    const users = loadUsers();
    const u = users[contact];
    if (!u) return {};
    return {
      bio: u.bio || '',
      location: u.location || '',
      genres: Array.isArray(u.genres) ? u.genres : [],
      links: u.links || {},
      openToCollab: !!u.openToCollab
    };
  } catch(e) { return {}; }
}

function computeProfileStats() {
  const projects = (state.songs || []).length;
  let published = 0, likes = 0;
  try {
    const feed = (loadSocial().feed||[]);
    const mine = feed.filter(p => state.user && (p.userId === state.user.id || p.username === state.user.username));
    published = mine.length;
    likes = mine.reduce((s, p) => s + (p.likes || 0), 0);
  } catch(e) {}
  return { projects, published, likes };
}

function renderGenreTags(selected) {
  const box = document.getElementById('profileGenreTags');
  if (!box) return;
  const sel = new Set(selected || []);
  box.innerHTML = PROFILE_GENRES.map(g =>
    `<span class="genre-tag${sel.has(g)?' on':''}" data-genre="${g}">${g}</span>`
  ).join('');
  box.onclick = (e) => {
    const t = e.target.closest('.genre-tag');
    if (!t) return;
    t.classList.toggle('on');
  };
}


async function onProfileAvatar(e) {
  const file = e.target && e.target.files && e.target.files[0];
  if (!file || !state.user) return;
  if (!file.type.startsWith('image/')) { toast('Choose an image'); return; }
  if (file.size > 5e6) { toast('Image max 5MB'); return; }

  const readAsDataUrl = () => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  try {
    let dataUrl = await readAsDataUrl();
    // Keep profile payloads small enough for reliable mobile/cloud updates.
    try {
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = reject;
        im.src = dataUrl;
      });
      const max = 640;
      const scale = Math.min(1, max / Math.max(img.naturalWidth || max, img.naturalHeight || max));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round((img.naturalWidth || max) * scale));
      canvas.height = Math.max(1, Math.round((img.naturalHeight || max) * scale));
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      dataUrl = canvas.toDataURL('image/jpeg', 0.82);
    } catch (_) {}

    state.user.avatar = dataUrl;
    const users = loadUsers();
    if (users[state.user.contact]) {
      users[state.user.contact].avatar = dataUrl;
      saveUsers(users);
    }

    if (Cloud.isCloud() && state.user.cloudId) {
      const remote = await Cloud.updateProfile(state.user.cloudId, { avatar_url: dataUrl });
      if (!remote) {
        toast('Photo saved locally, but cloud update failed');
      } else {
        state.user.avatar = remote.avatar_url || dataUrl;
        toast('Profile photo updated');
      }
    } else {
      toast('Photo updated');
    }
    updateUserUI();
    await openProfile();
  } catch (err) {
    console.warn('onProfileAvatar', err);
    toast('Could not update photo');
  }
}

async function openProfile() {
  try {
    if (!state.user) {
      try { openAuth('signin'); } catch (e) { toast('Sign in to open profile'); }
      return;
    }
    try { closeSidebar(); } catch (e) {}
    let u = state.user;
    let extras = {};
    // Cloud is authoritative for signed-in profiles. Load the current row
    // before rendering so Profile never shows stale local-only values.
    if (Cloud.isCloud() && u.cloudId) {
      try {
        const _pp = Cloud.getProfile(u.cloudId).then(r => { state._profCache = { t: Date.now(), r: r }; return r; });
        const remote = (state._profCache && Date.now() - state._profCache.t < 60000)
          ? state._profCache.r
          : await Promise.race([_pp, new Promise(res => setTimeout(() => res(null), 800))]);
        if (remote) {
          u = state.user = { ...u, username: remote.username || u.username, avatar: remote.avatar_url || u.avatar, contact: remote.contact || u.contact };
          extras = {
            bio: remote.bio || '',
            location: remote.location || '',
            genres: Array.isArray(remote.genres) ? remote.genres : [],
            links: remote.links || {},
            openToCollab: !!remote.open_to_collab
          };
          try {
            const users = loadUsers();
            const lu = users[u.contact] || {};
            users[u.contact] = { ...lu, username: u.username, avatar: u.avatar, bio: extras.bio, location: extras.location, genres: extras.genres, links: extras.links, openToCollab: extras.openToCollab };
            saveUsers(users);
          } catch (_) {}
        }
      } catch (e) { console.warn('load cloud profile', e); }
    }
    if (!Object.keys(extras).length) {
      try { extras = (typeof getUserProfileExtras === 'function' && getUserProfileExtras(u.contact)) || {}; } catch (e) {}
    }
    const setVal = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.value = v == null ? '' : String(v);
    };
    setVal('profileName', u.username || '');
    setVal('profileContact', u.contact || '');
    setVal('profileBio', extras.bio || '');
    setVal('profileLocation', extras.location || '');
    setVal('profileLinkIg', (extras.links && extras.links.instagram) || '');
    setVal('profileLinkYt', (extras.links && extras.links.youtube) || '');
    setVal('profileLinkOther', (extras.links && extras.links.other) || '');
    try {
      const tog = document.getElementById('profileCollabToggle');
      if (tog) {
        tog.classList.toggle('on', !!extras.openToCollab);
        tog.setAttribute('aria-checked', extras.openToCollab ? 'true' : 'false');
      }
    } catch (e) {}
    try { if (typeof renderGenreTags === 'function') renderGenreTags(extras.genres || []); } catch (e) {}
    try {
      const heroName = document.getElementById('profileHeroName');
      if (heroName) heroName.textContent = u.username || 'Artist';
      const heroHandle = document.getElementById('profileHeroHandle');
      if (heroHandle) heroHandle.textContent = '@' + String(u.username || 'artist').toLowerCase().replace(/\s+/g, '');
    } catch (e) {}
    let stats = { projects: (state.songs || []).length, published: 0, likes: 0 };
    try { if (typeof computeProfileStats === 'function') stats = computeProfileStats() || stats; } catch (e) {}
    try {
      const sp = document.getElementById('statProjects'); if (sp) sp.textContent = String(stats.projects);
      const sb = document.getElementById('statPublished'); if (sb) sb.textContent = String(stats.published);
      const sl = document.getElementById('statLikes'); if (sl) sl.textContent = String(stats.likes);
    } catch (e) {}
    try {
      const meta = document.getElementById('profileHeroMeta');
      if (meta) {
        let pills = '';
        try { if (typeof isPro === 'function' && isPro()) pills += '<span class="pro-pill">PRO</span> '; } catch (e) {}
        if (extras.openToCollab) pills += '<span class="ai-badge">Open to collab</span> ';
        if (extras.location) pills += '<span class="text-dim" style="font-size:12px">📍 ' + String(extras.location).replace(/</g,'') + '</span>';
        meta.innerHTML = pills || '<span class="text-dim">Artist profile</span>';
      }
    } catch (e) {}
    try {
      const box = document.getElementById('profileAvatarBox');
      if (box) {
        const safeName = String(u.username || 'A').slice(0, 2).toUpperCase();
        if (u.avatar) {
          box.innerHTML = '<img src="' + esc(u.avatar) + '" alt=""><input type="file" id="profileAvatarInput" accept="image/*">';
        } else {
          box.innerHTML = '<span>' + esc(safeName) + '</span><input type="file" id="profileAvatarInput" accept="image/*">';
        }
        const inp = document.getElementById('profileAvatarInput');
        if (inp && typeof onProfileAvatar === 'function') {
          inp.onchange = onProfileAvatar;
        }
      }
    } catch (e) {}
    try { if (typeof updateProUI === 'function') updateProUI(); } catch (e) {}
    const modal = document.getElementById('profileModal');
    if (!modal) {
      toast('Profile UI missing — re-upload index.html');
      console.warn('profileModal not in DOM');
      return;
    }
    modal.classList.add('show');
    modal.style.display = 'flex';
    modal.style.opacity = '1';
    modal.style.pointerEvents = 'auto';
    modal.setAttribute('aria-hidden', 'false');
  } catch (err) {
    console.warn('openProfile error', err);
    toast('Could not open profile');
  }
}

// Expose the profile opener for the mobile-safe delegated tap bridge below.
try { window.__tapeheadOpenProfile = openProfile; } catch (e) {}



async function saveProfile() {
  if (!state.user) return;
  state._profCache = null;
  const name = (document.getElementById('profileName')?.value || '').trim();
  if (name.length < 2) { toast('Username too short'); return; }
  const bio = (document.getElementById('profileBio')?.value || '').trim().slice(0, 200);
  const location = (document.getElementById('profileLocation')?.value || '').trim().slice(0, 40);
  const genres = [...document.querySelectorAll('#profileGenreTags .genre-tag.on')].map(t => t.dataset.genre);
  const links = {
    instagram: (document.getElementById('profileLinkIg')?.value || '').trim(),
    youtube: (document.getElementById('profileLinkYt')?.value || '').trim(),
    other: (document.getElementById('profileLinkOther')?.value || '').trim()
  };
  const openToCollab = document.getElementById('profileCollabToggle')?.classList.contains('on') || false;
  state.user.username = name;
  const users = loadUsers();
  const u = users[state.user.contact];
  if (u) {
    u.username = name;
    u.bio = bio;
    u.location = location;
    u.genres = genres;
    u.links = links;
    u.openToCollab = openToCollab;
    if (state.user.avatar) u.avatar = state.user.avatar;
    saveUsers(users);
  }
  if (Cloud.isCloud() && state.user.cloudId) {
    try {
      const remote = await Cloud.updateProfile(state.user.cloudId, { username:name, bio, location, genres, links, open_to_collab:openToCollab, avatar_url:state.user.avatar||null });
      if (!remote) { toast('Could not save profile to cloud'); return; }
      state.user.username = remote.username || name;
      state.user.avatar = remote.avatar_url || state.user.avatar || null;
    } catch(e) { console.warn('save cloud profile',e); toast('Could not save profile to cloud'); return; }
  }
  updateUserUI();
  closeProfile();
  toast('Profile saved');
}


function formatProfileCount(n) {
  n = Number(n) || 0;
  if (n >= 1000000) return (n/1000000).toFixed(n >= 10000000 ? 0 : 1).replace('.0','') + 'M';
  if (n >= 1000) return (n/1000).toFixed(n >= 10000 ? 0 : 1).replace('.0','') + 'K';
  return String(n);
}
function renderArtistProfileTabs(active) {
  document.querySelectorAll('#publicProfileModal [data-pp-tab]').forEach(b => {
    const on = b.getAttribute('data-pp-tab') === active;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  [['music','ppPanelMusic'],['projects','ppPanelProjects'],['about','ppPanelAbout']].forEach(([key,id]) => {
    const el = document.getElementById(id); if (el) el.classList.toggle('on', key === active);
  });
}
function artistProfilePosts(name) {
  try {
    const feed = loadSocial().feed || [];
    return feed.filter(p => String(p.username || '').toLowerCase() === String(name || '').toLowerCase()).sort((a,b)=>(b.updated||0)-(a.updated||0));
  } catch(e) { return []; }
}
function renderArtistProfileMedia(posts, name) {
  const featured = posts[0];
  const title = document.getElementById('ppFeaturedTitle');
  const meta = document.getElementById('ppFeaturedMeta');
  const player = document.getElementById('ppFeaturedPlayer');
  const play = document.getElementById('ppFeaturedPlay');
  const wave = document.getElementById('ppFeaturedWave');
  const time = document.getElementById('ppFeaturedTime');
  const releaseBox = document.getElementById('ppReleases');
  const projectBox = document.getElementById('ppProjects');
  const highlightBox = document.getElementById('ppHighlights');
  const hasAudio = p => !!(p && (p.pattern || p.vocalData || p.hasVocal || p.mixdownUrl || p.fullSong || (p.chords || []).length));
  if (!featured) {
    if (title) title.textContent = 'No featured release yet';
    if (meta) meta.textContent = 'Publish a track to give your profile a sound.';
    if (player) player.hidden = true;
  } else {
    if (title) title.textContent = featured.title || 'Untitled release';
    if (meta) meta.textContent = [featured.kit, featured.bpm ? featured.bpm + ' BPM' : '', featured.key ? 'Key ' + featured.key : ''].filter(Boolean).join(' · ') || 'Tapehead release';
    if (player) player.hidden = !hasAudio(featured);
    if (play) play.onclick = () => { try { playFeedPost(featured.id); } catch(e) {} };
    if (wave) wave.innerHTML = Array.from({length:24},(_,i)=>`<i style="height:${22+((i*17+(featured.id||'').length*5)%70)}%"></i>`).join('');
    if (time) time.textContent = hasAudio(featured) ? 'Play preview' : 'Lyrics / project';
  }
  const renderRows = (arr, limit) => arr.slice(0,limit).map(p => {
    const date = p.updated ? new Date(p.updated).toLocaleDateString(undefined,{month:'short',day:'numeric'}) : '';
    const parts = [p.fullSong||p.mixdownUrl?'Full':null,p.hasVocal||p.vocalData?'Vocal':null,p.pattern?'Beat':null,(p.chords||[]).length?'Keys':null].filter(Boolean).join(' · ') || 'Project';
    return `<div class="artist-release"><div class="artist-release-art">♪</div><div class="artist-release-copy"><div class="artist-release-title">${esc(p.title||'Untitled')}</div><div class="artist-release-meta">${esc(parts)}${date?' · '+esc(date):''}</div></div><button type="button" class="btn artist-release-btn" data-pp-play="${esc(p.id)}">${hasAudio(p)?'▶ Play':'Open'}</button></div>`;
  }).join('');
  if (releaseBox) releaseBox.innerHTML = arrEmpty(posts) ? '<div class="artist-profile-empty">No releases yet. Published music will appear here.</div>' : renderRows(posts,4);
  if (projectBox) projectBox.innerHTML = arrEmpty(posts) ? '<div class="artist-profile-empty">No published projects yet.</div>' : renderRows(posts,10);
  if (highlightBox) {
    const likes = posts.reduce((n,p)=>n+(Number(p.likes)||0),0);
    const top = posts.slice().sort((a,b)=>(Number(b.likes)||0)-(Number(a.likes)||0))[0];
    highlightBox.innerHTML = `<div class="artist-highlight"><b>Latest release</b><span>${esc(featured ? featured.title || 'Untitled' : '—')}</span></div><div class="artist-highlight"><b>Top track</b><span>${esc(top ? top.title || 'Untitled' : '—')}</span></div><div class="artist-highlight"><b>Total likes</b><span>${formatProfileCount(likes)}</span></div><div class="artist-highlight"><b>Releases</b><span>${posts.length}</span></div>`;
  }
  document.querySelectorAll('#publicProfileModal [data-pp-play]').forEach(btn => btn.addEventListener('click',()=>{
    const id=btn.getAttribute('data-pp-play'); const p=posts.find(x=>String(x.id)===String(id));
    if (p && hasAudio(p)) { try{playFeedPost(id);}catch(e){} } else { try{openFeedProject(id);}catch(e){} }
  }));
}
function arrEmpty(a){ return !Array.isArray(a) || !a.length; }

async function openPublicProfile(username) {
  try {
    if (!username) return;
    try {
      const _m = document.getElementById('publicProfileModal');
      const _n = document.getElementById('ppName'); if (_n) _n.textContent = username;
      const _h = document.getElementById('ppHandle'); if (_h) _h.textContent = '@' + String(username).toLowerCase().replace(/\s+/g, '');
      const _a = document.getElementById('ppAvatar'); if (_a) _a.textContent = String(username).slice(0, 2).toUpperCase();
      if (_m) { _m.classList.add('show'); _m.style.display = 'flex'; _m.style.opacity = '1'; _m.style.pointerEvents = 'auto'; }
    } catch (e) {}
    let found = null;
    if (Cloud.isCloud()) {
      try { found = await Cloud.getPublicProfile(username); } catch (e) {}
    }
    if (!found) {
      try {
        const users = loadUsers();
        found = Object.values(users).find(u => (u.username || '').toLowerCase() === String(username).toLowerCase());
      } catch (e) {}
    }
    if (found) {
      found = { ...found, avatar: found.avatar || found.avatar_url || null, openToCollab: typeof found.openToCollab === 'boolean' ? found.openToCollab : !!found.open_to_collab };
    }
    const name=(found&&found.username)||username;
    const setTxt = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.textContent = v == null ? '' : String(v);
    };
    setTxt('ppName', name);
    setTxt('ppHandle', '@' + String(name).toLowerCase().replace(/\s+/g, ''));
    const av = document.getElementById('ppAvatar');
    if (av) {
      if (found && (found.avatar_url || found.avatar)) av.innerHTML = '<img src="' + esc(found.avatar_url || found.avatar) + '" alt="">';
      else av.textContent = String(name).slice(0, 2).toUpperCase();
    }
    setTxt('ppBio', (found && found.bio) || 'Tapehead artist');
    const meta = document.getElementById('ppMeta');
    if (meta) {
      let pills = '';
      if (found && found.location) pills += '<span class="text-dim" style="font-size:11px">📍 ' + String(found.location).replace(/</g,'') + '</span>';
      if (found && found.openToCollab) pills += '<span class="ai-badge">Open to collab</span>';
      meta.innerHTML = pills || '<span class="text-dim" style="font-size:11px">Tapehead artist</span>';
    }
    const genresBox = document.getElementById('ppGenres');
    if (genresBox) {
      const gs = Array.isArray(found?.genres) ? found.genres : [];
      genresBox.innerHTML = gs.length
        ? gs.slice(0, 6).map(g => '<span class="genre-tag on" style="cursor:default">' + String(g).replace(/</g,'') + '</span>').join('')
        : '<div class="artist-profile-empty">Genres have not been added yet.</div>';
    }
    const collabCard = document.getElementById('ppCollabCard');
    const collabTitle = document.getElementById('ppCollabTitle');
    const collabCopy = document.getElementById('ppCollabCopy');
    const collabBadge = document.getElementById('ppCollabBadge');
    if (collabCard) {
      const open = !!(found && found.openToCollab);
      collabCard.style.opacity = open ? '1' : '.72';
      if (collabTitle) collabTitle.textContent = open ? 'Open to collaboration' : 'Not currently marked open';
      if (collabCopy) collabCopy.textContent = open ? 'Available for ideas, sessions and features.' : 'This artist has not marked their profile open for collaboration.';
      if (collabBadge) { collabBadge.textContent = open ? 'Open' : 'Closed'; collabBadge.style.display = open ? '' : 'none'; }
    }
    let published = 0, likes = 0;
    try {
      const feed = (loadSocial().feed || []);
      const mine = feed.filter(p => (p.username || '').toLowerCase() === String(name).toLowerCase());
      published = mine.length;
      likes = mine.reduce((s, p) => s + ((p.likes || 0) | 0), 0);
    } catch (e) {}
    let followers = 0, following = 0;
    if (Cloud.isCloud() && found?.id) {
      try {
        const remoteStats = await Cloud.getProfileStats(found.id);
        published = remoteStats.published; likes = remoteStats.likes;
        followers = remoteStats.followers || 0; following = remoteStats.following || 0;
      } catch (e) { console.warn('public profile stats', e); }
    }
    setTxt('ppPublished', published);
    setTxt('ppLikes', likes);
    setTxt('ppFollowers', followers);
    setTxt('ppFollowing', following);
    let posts = artistProfilePosts(name);
    if (Cloud.isCloud()) {
      try {
        const remoteFeed = await Cloud.fetchFeed({ username: name, limit: 80 });
        const remotePosts = (remoteFeed && remoteFeed.posts) || [];
        const remoteMine = remotePosts.filter(p => String(p.username || '').toLowerCase() === String(name || '').toLowerCase());
        if (remoteMine.length) posts = remoteMine.sort((a,b)=>(b.updated||b.created_at||0)>(a.updated||a.created_at||0)?-1:1);
      } catch(e) { console.warn('public profile media', e); }
    }
    renderArtistProfileMedia(posts, name);
    renderArtistProfileTabs('music');
    setTxt('ppAboutCopy', (found && found.bio) || 'Tapehead artist');
    const ownProfile = !!(state.user && ((found && found.id && state.user.cloudId && found.id === state.user.cloudId) || String(name).toLowerCase() === String(state.user.username || '').toLowerCase()));
    const editBtn = document.getElementById('ppEditBtn');
    if (editBtn) editBtn.style.display = ownProfile ? 'block' : 'none';
    const collabBtn = document.getElementById('ppCollabBtn');
    if (collabBtn) collabBtn.style.display = (found && found.openToCollab && !ownProfile) ? 'block' : 'none';
    const linksBox = document.getElementById('ppLinks');
    const linksSection = document.getElementById('ppLinksSection');
    if (linksBox) {
      linksBox.innerHTML = '';
      const L = (found && found.links) || {};
      [['instagram','Instagram'],['youtube','YouTube'],['other','Link']].forEach(([k, label]) => {
        if (!L[k]) return;
        let href = L[k];
        if (k === 'instagram' && String(href).startsWith('@')) href = 'https://instagram.com/' + href.slice(1);
        if (!/^https?:/i.test(href) && k === 'instagram') href = 'https://instagram.com/' + String(href).replace(/^@/, '');
        if (!/^https?:\/\//i.test(href)) href = 'https://' + String(href).replace(/^[a-z][a-z0-9+.-]*:\/*/i, '');
          linksBox.innerHTML += '<a class="link-chip" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
      });
      if (linksSection) linksSection.style.display = linksBox.children.length ? '' : 'none';
    }
    const followBtn = document.getElementById('ppFollowBtn');
    const msgBtn = document.getElementById('ppMessageBtn');
    const peerKey = (found && (found.id || found.contact || found.username)) || username;
    state._profilePeer = { key: peerKey, name: name, username: name, cloudId: found && found.id };
    if (followBtn) {
      let on=isFollowing(peerKey)||isFollowing(name); if(Cloud.isCloud()&&found?.id&&state.user?.cloudId){try{on=await Cloud.isFollowing(found.id);}catch(e){}}
      followBtn.textContent = on ? 'Following' : 'Follow';
      followBtn.className = on ? 'btn' : 'btn pri';
      followBtn.style.width = '100%';
      followBtn.style.marginBottom = '8px';
    }
    if (msgBtn) {
      msgBtn.style.display = (state.user && peerKey !== currentUserKey()) ? 'block' : 'none';
    }
    const modal = document.getElementById('publicProfileModal');
    if (modal) {
      modal.classList.add('show');
      modal.style.display = 'flex';
      modal.style.opacity = '1';
      modal.style.pointerEvents = 'auto';
    } else {
      toast('Profile view missing');
    }
  } catch (err) {
    console.warn('openPublicProfile', err);
    toast('Could not open artist profile');
  }
}

function closePublicProfile() {
  const modal = document.getElementById('publicProfileModal');
  if (modal) {
    modal.classList.remove('show');
    modal.style.display = '';
  }
}


const PRO_PLANS = {
  month: { id: 'month', label: 'Monthly', price: 4.99, days: 30 },
  year: { id: 'year', label: 'Yearly', price: 29, days: 365 },
  lifetime: { id: 'lifetime', label: 'Lifetime', price: 49, days: null }
};
const TRIAL_DAYS = 30;
state.payMethod = 'pesapal';
state.selectedPlan = state.selectedPlan || 'month';

function grantTrialPro() {
  if (isPro() && state.pro && state.pro.plan !== 'trial') return;
  // only one trial per account
  try {
    const users = loadUsers();
    const u = users[state.user?.contact];
    if (u && u.trialUsed && !(state.pro && state.pro.plan === 'trial' && isPro())) {
      return;
    }
  } catch (e) {}
  const pro = {
    active: true,
    plan: 'trial',
    userId: state.user && state.user.id,
    label: '30-day free trial',
    code: 'TRIAL',
    activated: Date.now(),
    expires: Date.now() + TRIAL_DAYS * 864e5,
    contact: state.user?.contact || null
  };
  state.pro = pro;
  savePro(pro);
  try { if (typeof persistUserPro === "function") persistUserPro(pro); } catch(e) {}
  try {
    const users = loadUsers();
    if (state.user && state.user.contact && users[state.user.contact]) {
      users[state.user.contact].pro = pro;
      users[state.user.contact].trialUsed = true;
      saveUsers(users);
    }
  } catch(e) {}
  try {
    const users = loadUsers();
    if (state.user?.contact && users[state.user.contact]) {
      users[state.user.contact].trialUsed = true;
      users[state.user.contact].pro = pro;
      saveUsers(users);
    }
  } catch (e) {}
  updateProUI();
}

function daysLeftPro() {
  const p = state.pro || loadPro();
  if (!p || !p.active || !p.expires) return null;
  return Math.max(0, Math.ceil((p.expires - Date.now()) / 864e5));
}




function activateLicense(code) {
  toast('Use Upgrade to Pro for paid access. Promo codes are managed by support.');
  return false;
}


function requirePro(featureLabel) {
  if (!state.user) { openAuth('signin'); return false; }
  if (isPro()) return true;
  openPaywall((featureLabel || 'This feature') + ' needs Pro or an active trial.');
  return false;
}

function canCreateProject() {
  if (isPro()) return true;
  if ((state.songs || []).length >= FREE_PROJECT_LIMIT) {
    openPaywall('Free plan allows ' + FREE_PROJECT_LIMIT + ' projects. Upgrade for unlimited.');
    return false;
  }
  return true;
}

function updateProUI() {
  const pro = isPro();
  const p = state.pro || loadPro();
  const banner = document.getElementById('proGateBanner');
  if (banner) banner.style.display = pro ? 'none' : 'flex';
  const status = document.getElementById('profileProStatus');
  if (status) {
    if (pro && p) {
      let extra = '';
      if (p.plan === 'trial' && p.expires) {
        const d = Math.max(0, Math.ceil((p.expires - Date.now()) / 864e5));
        extra = ' · ' + d + ' day' + (d === 1 ? '' : 's') + ' left';
      } else if (p.label) {
        extra = ' · ' + p.label;
      }
      status.innerHTML = '<span class="pro-pill">PRO</span>' + (extra ? extra : '');
    } else {
      status.textContent = 'Free plan · ' + FREE_PROJECT_LIMIT + ' projects max';
    }
  }
  const up = document.getElementById('upgradeBtn');
  if (up) {
    up.style.display = 'block';
    up.disabled = false;
    up.textContent = pro ? '✦ Manage Pro' : '✦ Upgrade to Pro';
    up.className = pro ? 'btn' : 'btn pri';
  }
  const pu = document.getElementById('profileUpgrade');
  if (pu) {
    pu.style.display = 'block';
    pu.disabled = false;
    pu.textContent = pro ? '✦ Manage / Extend Pro' : '✦ Get Pro';
    pu.className = pro ? 'btn' : 'btn pri';
  }
  try {
    const badge = document.getElementById('sidebarBadge');
    if (badge && state.user) {
      if (pro) badge.innerHTML = '<span class="pro-pill">PRO</span>';
      else if (!badge.dataset.locked) badge.textContent = state.user.username || 'Artist';
    }
  } catch (e) {}
}

function bindProUI() {
  if (window._proUiBound) return;
  window._proUiBound = true;

  document.getElementById('profileCollabToggle')?.addEventListener('click', function() {
    this.classList.toggle('on');
    this.setAttribute('aria-checked', this.classList.contains('on') ? 'true' : 'false');
  });
document.getElementById('activatePro')?.addEventListener('click', () => {
    activateLicense(document.getElementById('licenseCode')?.value);
  });
  document.getElementById('licenseCode')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') activateLicense(e.target.value);
  });
document.getElementById('saveRecoveryPassword')?.addEventListener('click', async () => {
  const input = document.getElementById('recoveryPass');
  const password = input?.value || '';
  if (password.length < 8) { toast('Password must be at least 8 characters.'); return; }
  if (!Cloud.isCloud()) { toast('Cloud services are unavailable.'); return; }
  const btn = document.getElementById('saveRecoveryPassword');
  if (btn) { btn.disabled = true; btn.textContent = 'Updating…'; }
  try {
    const r = await Cloud.updatePassword(password);
    if (r.error) { toast(r.error); return; }
    if (input) input.value = '';
    const m = document.getElementById('recoveryModal');
    if (m) { m.classList.remove('show'); m.style.display = 'none'; m.style.opacity = ''; m.style.pointerEvents = ''; }
    toast('Password updated.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Update password'; }
  }
});
document.getElementById('recoveryModal')?.addEventListener('click', e => { if (e.target.id === 'recoveryModal') e.preventDefault(); });

document.getElementById('forgotPasswordBtn')?.addEventListener('click', async () => {
  const email = (document.getElementById('signinContact')?.value || '').trim();
  if (!isEmail(email)) { toast('Enter the email you used for your account first.'); return; }
  if (!Cloud.isCloud()) { toast('Password recovery requires a Cloud account.'); return; }
  const r = await Cloud.resetPassword(email);
  toast(r.error || 'Password reset email sent. Check your inbox.');
});
document.getElementById('deleteAccountBtn')?.addEventListener('click', async () => {
  if (!state.user) { openAuth('signin'); return; }
  if (!Cloud.isCloud() || !state.user.cloudId) { toast('Account deletion is available for Cloud accounts.'); return; }
  const ok = confirm('Delete your Tapehead account? Your projects, social account data, messages and account will be permanently deleted.');
  if (!ok) return;
  const r = await Cloud.deleteAccount();
  if (r.error) { toast(r.error); return; }
  state.user = null; state.songs = []; state.pro = null;
  saveSession(null);
  try { localStorage.removeItem('th-pro'); } catch(e) {}
  lockApp(true); updateUserUI(); closeProfile(); toast('Your account has been deleted.');
});
document.getElementById('ppBlockBtn')?.addEventListener('click', async () => {
  const id=state._profilePeer?.cloudId; if(!id) { toast('This artist cannot be blocked here.'); return; }
  if(!confirm('Block this artist? They will no longer be able to message you.')) return;
  if(Cloud.isCloud()) { const r=await Cloud.blockUser(id); if(r.error) toast(r.error); else { toast('Artist blocked.'); closePublicProfile(); } }
});
document.getElementById('ppReportBtn')?.addEventListener('click', async () => {
  const id=state._profilePeer?.cloudId; if(!id) { toast('This artist cannot be reported here.'); return; }
  const reason=prompt('Why are you reporting this artist?'); if(!reason) return;
  if(Cloud.isCloud()) { const r=await Cloud.reportUser(id, reason); toast(r.error || 'Report submitted.'); }
});
}

function closePublish() {
  const modal = document.getElementById('publishModal');
  if (modal) {
    modal.classList.remove('show');
    modal.style.display = '';
    modal.style.pointerEvents = '';
  }
}
/* ── Follow + Messages ── */
function loadSocialGraph() {
  try {
    return JSON.parse(localStorage.getItem('th-social-graph') || '{"follows":{},"messages":[]}');
  } catch (e) {
    return { follows: {}, messages: [] };
  }
}
function saveSocialGraph(g) {
  localStorage.setItem('th-social-graph', JSON.stringify(g));
}

function currentUserKey() {
  return state.user && (state.user.cloudId || state.user.id || state.user.contact);
}

function isFollowing(targetKey) {
  if (!targetKey || !state.user) return false;
  const me = currentUserKey();
  const g = loadSocialGraph();
  const list = g.follows[me] || [];
  return list.includes(targetKey) || list.includes(String(targetKey).toLowerCase());
}

async function toggleFollow(targetUser){if(!state.user){openAuth('signin');return false;}const me=currentUserKey(),target=targetUser.cloudId||targetUser.id||targetUser.contact||targetUser.username;if(!target||target===me)return false;if(Cloud.isCloud()&&state.user.cloudId&&targetUser.cloudId){const cur=await Cloud.isFollowing(targetUser.cloudId),r=await Cloud.toggleFollow(targetUser.cloudId,!cur);toast(r.following?'Following':'Unfollowed');return r.following;}const g=loadSocialGraph();g.follows[me]=g.follows[me]||[];const idx=g.follows[me].indexOf(target),following=idx<0;if(following)g.follows[me].push(target);else g.follows[me].splice(idx,1);saveSocialGraph(g);toast(following?'Following':'Unfollowed');return following;}

function getInboxThreads() {
  const me = currentUserKey();
  if (!me) return [];
  const g = loadSocialGraph();
  const msgs = g.messages || [];
  const map = {};
  msgs.forEach(m => {
    if (m.sender !== me && m.recipient !== me) return;
    const other = m.sender === me ? m.recipient : m.sender;
    if (!map[other] || m.created > map[other].created) map[other] = m;
  });
  return Object.keys(map).map(other => ({
    other,
    last: map[other],
    unread: msgs.filter(m => m.sender === other && m.recipient === me && !m.read).length
  })).sort((a, b) => (b.last.created || 0) - (a.last.created || 0));
}

function getThread(otherKey) {
  const me = currentUserKey();
  const g = loadSocialGraph();
  return (g.messages || []).filter(m =>
    (m.sender === me && m.recipient === otherKey) ||
    (m.sender === otherKey && m.recipient === me)
  ).sort((a, b) => (a.created || 0) - (b.created || 0));
}

async function sendDirectMessage(toKey, body, toMeta) {
  if (!state.user) { openAuth('signin'); return null; }
  body = (body || '').trim();
  if (!body) { toast('Write a message'); return null; }
  if (!toKey) return null;
  const me = currentUserKey();

  // In AIR/cloud mode, the database is authoritative. Only cache the
  // message locally after the server confirms the insert.
  if (Cloud.isCloud() && state.user.cloudId) {
    if (!/^[0-9a-f-]{36}$/i.test(String(toKey))) { toast('This artist is not available for cloud messaging yet'); return null; }
    const remote = await Cloud.sendMessage(toKey, body);
    if (!remote) { toast('Message could not be sent — check your cloud account permissions'); return null; }
    const msg = {
      id: remote.id, sender: remote.sender_id, recipient: remote.recipient_id,
      senderName: state.user.username, recipientName: (toMeta && toMeta.username) || toKey,
      body: remote.body, created: new Date(remote.created_at).getTime(), read: false
    };
    const g = loadSocialGraph(); g.messages = (g.messages || []).filter(m => m.id !== msg.id); g.messages.push(msg);
    if (g.messages.length > 500) g.messages = g.messages.slice(-500); saveSocialGraph(g);
    return msg;
  }

  // Local fallback for non-cloud accounts.
  const msg = {
    id: 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    sender: me, recipient: toKey, senderName: state.user.username,
    recipientName: (toMeta && toMeta.username) || toKey, body: body.slice(0, 2000),
    created: Date.now(), read: false
  };
  const g = loadSocialGraph(); g.messages = g.messages || []; g.messages.push(msg);
  if (g.messages.length > 500) g.messages = g.messages.slice(-500); saveSocialGraph(g);
  return msg;
}

function markThreadRead(otherKey) {
  const me = currentUserKey();
  const g = loadSocialGraph();
  (g.messages || []).forEach(m => {
    if (m.sender === otherKey && m.recipient === me) m.read = true;
  });
  saveSocialGraph(g);
}

state._msgPeer = null;

async function openMessages(peer) {
  try { closeSidebar(); } catch (e) {}
  if (!state.user) { openAuth('signin'); return; }
  const modal = document.getElementById('messagesModal');
  if (!modal) {
    toast('Messages UI missing');
    return;
  }
  modal.classList.add('show');
  modal.style.display = 'flex';
  modal.style.opacity = '1';
  modal.style.pointerEvents = 'auto';
  modal.setAttribute('aria-hidden', 'false');
  try {
    if (Cloud.isCloud() && state.user.cloudId) await syncCloudSocial();
  } catch (e) { console.warn('syncCloudSocial', e); }
  if (peer) {
    state._msgPeer = peer;
    await showMessageThread(peer);
  } else {
    state._msgPeer = null;
    await showMessageInbox();
  }
}

function closeMessages() {
  const m = document.getElementById('messagesModal');
  if (m) {
    m.classList.remove('show');
    m.style.display = '';
    m.style.pointerEvents = '';
    m.setAttribute('aria-hidden', 'true');
  }
  state._msgPeer = null;
}

async function showMessageInbox() {
  document.getElementById('messagesInbox').hidden = false;
  document.getElementById('messagesThreadView').hidden = true;
  document.getElementById('messagesBackBtn').hidden = true;
  document.getElementById('messagesTitle').textContent = 'Messages';
  document.getElementById('messagesSub').textContent = 'Private chats — only you and them';
  const threads = getInboxThreads();
  const el = document.getElementById('messagesInbox');
  if (!threads.length) {
    el.innerHTML = '<p class="text-dim" style="font-size:13px;line-height:1.5">No messages yet. Open an artist profile and tap <strong>Message</strong>.</p>';
    return;
  }
  el.innerHTML = '<div class="msg-list">' + threads.map(t => {
    const name = t.last.sender === currentUserKey() ? (t.last.recipientName || t.other) : (t.last.senderName || t.other);
    const col = typeof avatarColor === 'function' ? avatarColor(name) : '#F0B060';
    const prev = (t.last.body || '').slice(0, 60);
    const time = new Date(t.last.created || Date.now()).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `<button type="button" class="msg-row" data-msg-peer="${esc(t.other)}" data-msg-name="${esc(name)}">
      <div class="mr-av" style="background:${col}">${esc(String(name).slice(0,2).toUpperCase())}</div>
      <div class="mr-body"><div class="mr-name">${esc(name)}</div><div class="mr-prev">${esc(prev)}</div></div>
      <div class="mr-meta">${time}${t.unread ? '<br><span class="msg-unread"></span>' : ''}</div>
    </button>`;
  }).join('') + '</div>';
}

async function showMessageThread(peer) {
  const key = peer.key || peer;
  const name = peer.name || peer.username || key;
  state._msgPeer = { key, name };
  markThreadRead(key);
  if (Cloud.isCloud() && state.user?.cloudId && /^[0-9a-f-]{36}$/i.test(String(key))) {
    try { await Cloud.markMessagesRead(key); } catch (e) { console.warn('mark cloud messages read', e); }
  }
  document.getElementById('messagesInbox').hidden = true;
  document.getElementById('messagesThreadView').hidden = false;
  document.getElementById('messagesBackBtn').hidden = false;
  document.getElementById('messagesTitle').textContent = name;
  document.getElementById('messagesSub').textContent = 'Private · only visible to you two';
  const thread = getThread(key);
  const me = currentUserKey();
  const el = document.getElementById('messagesThread');
  el.innerHTML = thread.map(m => {
    const mine = m.sender === me;
    return `<div class="msg-bubble ${mine ? 'me' : 'them'}">${esc(m.body)}</div>`;
  }).join('') || '<p class="text-dim text-center" style="font-size:12px">Say hello — start the collab chat</p>';
  el.scrollTop = el.scrollHeight;
}

async function handleSendMessage() {
  if (!state._msgPeer) return;
  const input = document.getElementById('messageInput');
  const body = (input && input.value || '').trim();
  if (!body) return;
  const sent = await sendDirectMessage(state._msgPeer.key, body, { username: state._msgPeer.name });
  if (sent && input) input.value = '';
  if (sent) await showMessageThread(state._msgPeer);
}

function openHelp() {
  try { closeSidebar(); } catch (e) {}
  const m = document.getElementById('helpModal');
  if (m) {
    m.classList.add('show');
    m.style.display = 'flex';
    m.style.opacity = '1';
    m.style.pointerEvents = 'auto';
    m.setAttribute('aria-hidden', 'false');
  }
}
function closeHelp() {
  const m = document.getElementById('helpModal');
  if (m) {
    m.classList.remove('show');
    m.style.display = '';
    m.style.pointerEvents = '';
    m.setAttribute('aria-hidden', 'true');
  }
}

function openSidebar() {
  const side = document.getElementById('sidebar');
  const ov = document.getElementById('overlay');
  if (side) side.classList.add('open');
  if (ov) {
    ov.classList.add('show');
    ov.style.pointerEvents = 'auto';
    ov.style.opacity = '1';
  }
  document.body.classList.add('menu-open');
  var mt = document.getElementById('menuToggle');
  if (mt) mt.setAttribute('aria-expanded','true');
}

function closeSidebar() {
  const side = document.getElementById('sidebar');
  const ov = document.getElementById('overlay');
  if (side) side.classList.remove('open');
  if (ov) {
    ov.classList.remove('show');
    ov.style.pointerEvents = 'none';
    ov.style.opacity = '0';
  }
  document.body.classList.remove('menu-open');
  var menuToggle = document.getElementById('menuToggle');
  if (menuToggle) menuToggle.setAttribute('aria-expanded','false');
  // clear any stuck blur on main
  try {
    const app = document.querySelector('.app');
    if (app) {
      app.style.filter = '';
      app.style.pointerEvents = '';
    }
  } catch (e) {}
}


/* ══ Hum → Chord: real pitch tracking + key-aware chord suggestion ══ */
const NOTE_NAMES_SHARP=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
function buildChord(name){
  const m=/^([A-G][#b]?)(m|dim|7|m7|maj7)?$/.exec(String(name||''));
  if(!m)return null;
  const flat={Db:'C#',Eb:'D#',Gb:'F#',Ab:'G#',Bb:'A#'};
  const root=NOTE_NAMES_SHARP.indexOf(flat[m[1]]||m[1]);
  if(root<0)return null;
  const q=m[2]||'';
  const iv=q==='m'?[0,3,7]:q==='dim'?[0,3,6]:q==='7'?[0,4,7,10]:q==='m7'?[0,3,7,10]:q==='maj7'?[0,4,7,11]:[0,4,7];
  return iv.map(i=>NOTE_NAMES_SHARP[(root+i)%12]);
}
/* Autocorrelation pitch detector. Returns Hz or -1 when there is no clear pitch. */
function detectPitch(buf,sr){
  const n=buf.length;let rms=0;
  for(let i=0;i<n;i++)rms+=buf[i]*buf[i];
  rms=Math.sqrt(rms/n);
  if(rms<0.01)return -1;
  const minLag=Math.floor(sr/1000),maxLag=Math.min(Math.floor(sr/70),n-1);
  const c=new Float32Array(maxLag+1);
  for(let lag=minLag-1;lag<=maxLag;lag++){let s=0;for(let i=0;i<n-lag;i++)s+=buf[i]*buf[i+lag];c[lag]=s;}
  let d=minLag;while(d<maxLag&&c[d]>c[d+1])d++;          // skip the zero-lag lobe
  let best=-1,bv=-Infinity;
  for(let lag=d;lag<=maxLag;lag++)if(c[lag]>bv){bv=c[lag];best=lag;}
  if(best<0)return -1;
  let e0=0;for(let i=0;i<n;i++)e0+=buf[i]*buf[i];
  if(bv/e0<0.5)return -1;                                 // weak periodicity = noise/breath
  let lag=best;
  for(let m=2;m<=4;m++){                                  // prefer the fundamental over a subharmonic
    const l2=Math.round(best/m);
    if(l2>=minLag&&c[l2]>0.9*bv){lag=l2;bv=c[l2];}
  }
  const a=c[lag-1]||c[lag],b=c[lag],cc=c[lag+1]||c[lag];
  const den=a-2*b+cc;const shift=den!==0?0.5*(a-cc)/den:0;
  return sr/(lag+shift);
}
const MAJOR_DEG=[[0,'',0],[2,'m',1],[4,'m',2],[5,'',3],[7,'',4],[9,'m',5],[11,'dim',6]];
const MINOR_DEG=[[0,'m',0],[2,'dim',1],[3,'',2],[5,'m',3],[7,'m',4],[8,'',5],[10,'',6]];
const MAJOR_SCALE=[0,2,4,5,7,9,11],MINOR_SCALE=[0,2,3,5,7,8,10];
/* notes: [{pc:0-11, w:weight}] in time order. Returns {key, chords[4]} */
function melodyToChords(notes){
  if(!notes||!notes.length)return null;
  const hist=new Array(12).fill(0);notes.forEach(n=>hist[n.pc]+=n.w);
  let best=null;
  for(let root=0;root<12;root++)for(const minor of [false,true]){
    const sc=minor?MINOR_SCALE:MAJOR_SCALE;let s=0;
    sc.forEach((d,i)=>{s+=hist[(root+d)%12]*(i===0||i===4?1.25:1);});
    s-=(hist.reduce((a,b)=>a+b,0)-sc.reduce((a,d)=>a+hist[(root+d)%12],0))*0.8;
    if(minor)s+=hist[root]*0.15+hist[(root+7)%12]*0.05;
    if(!best||s>best.s)best={s,root,minor};
  }
  const degs=best.minor?MINOR_DEG:MAJOR_DEG;
  const chordOf=(deg)=>{const [semi,q]=deg;const r=(best.root+semi)%12;return {name:NOTE_NAMES_SHARP[r]+(q==='m'?'m':q==='dim'?'dim':''),pcs:(buildChord(NOTE_NAMES_SHARP[r]+(q==='m'?'m':q==='dim'?'dim':''))||[]).map(x=>NOTE_NAMES_SHARP.indexOf(x))};};
  const cands=degs.map(chordOf);
  const tonic=best.minor?0:0;
  // split the melody into 4 equal time slices and pick the best-fitting chord for each
  const total=notes.reduce((a,n)=>a+n.w,0);let acc=0;const slices=[[],[],[],[]];
  notes.forEach(n=>{const idx=Math.min(3,Math.floor((acc/total)*4));slices[idx].push(n);acc+=n.w;});
  const prog=[];
  slices.forEach((sl,i)=>{
    let pick=null;
    cands.forEach((c,ci)=>{
      let s=0;sl.forEach(n=>{if(c.pcs.includes(n.pc))s+=n.w*(n.pc===c.pcs[0]?1.2:1);});
      if(ci===tonic)s+=0.01;                 // small bias toward the tonic chord
      if(i===0&&ci===tonic)s+=total*0.02;    // start on home when unsure
      if(prog.length&&prog[prog.length-1]===c.name)s*=0.6; // avoid repeating the same chord
      if(!pick||s>pick.s)pick={s,name:c.name};
    });
    prog.push(pick.name);
  });
  const keyName=NOTE_NAMES_SHARP[best.root]+(best.minor?'m':'');
  return {key:keyName,chords:prog};
}

/* ══ Extras: missing definitions + modal wiring (added in fix pass) ══ */
const PROGRESSIONS=[['C','G','Am','F'],['Am','F','C','G'],['C','Am','F','G'],['Dm','G','C','Am'],['Em','C','G','Am'],['F','G','Em','Am'],['Am','G','F','E']];
const SECTION_MARKERS={intro:'[Intro]\n',verse:'[Verse]\n',pre:'[Pre-Chorus]\n',chorus:'[Chorus]\n',bridge:'[Bridge]\n',outro:'[Outro]\n'};
const LYRIC_TEMPLATES={
  amapiano:'[Intro]\n\n[Verse 1]\n\n[Pre-Chorus]\n\n[Chorus]\n\n[Verse 2]\n\n[Chorus]\n\n[Outro]\n',
  afrobeats:'[Intro]\n\n[Verse 1]\n\n[Chorus]\n\n[Verse 2]\n\n[Chorus]\n\n[Bridge]\n\n[Outro]\n',
  trap:'[Intro]\n\n[Hook]\n\n[Verse 1]\n\n[Hook]\n\n[Verse 2]\n\n[Outro]\n',
  gospel:'[Verse 1]\n\n[Chorus]\n\n[Verse 2]\n\n[Chorus]\n\n[Bridge]\n\n[Chorus]\n',
  rnb:'[Intro]\n\n[Verse 1]\n\n[Pre-Chorus]\n\n[Chorus]\n\n[Verse 2]\n\n[Chorus]\n\n[Bridge]\n\n[Outro]\n',
  pop:'[Verse 1]\n\n[Pre-Chorus]\n\n[Chorus]\n\n[Verse 2]\n\n[Pre-Chorus]\n\n[Chorus]\n\n[Bridge]\n\n[Chorus]\n',
  lofi:'[Intro]\n\n[Verse 1]\n\n[Chorus]\n\n[Verse 2]\n\n[Outro]\n'
};
const CHORD_BANKS={pop:['C','G','Am','F'],gospel:['Dm','G','C','Am'],amapiano:['Am','F','C','G'],trap:['Am','F','G','Em'],jazz:['Dm','G','C','Am'],afro:['C','Am','F','G']};
const TH_SCALES={chromatic:[0,1,2,3,4,5,6,7,8,9,10,11],major:[0,2,4,5,7,9,11],minor:[0,2,3,5,7,8,10],pentatonic:[0,2,4,7,9]};
const TH_PC={C:0,'C#':1,Db:1,D:2,'D#':3,Eb:3,E:4,F:5,'F#':6,Gb:6,G:7,'G#':8,Ab:8,A:9,'A#':10,Bb:10,B:11};
function applyScaleLock(){
  const lock=!!document.getElementById('scaleLock')?.checked;
  const k=(document.getElementById('songKey')?.value||'').trim().match(/^([A-Ga-g])([#b]?)/);
  const root=k&&TH_PC[k[1].toUpperCase()+k[2]]!=null?TH_PC[k[1].toUpperCase()+k[2]]:0;
  const steps=TH_SCALES[state.scale||'chromatic']||TH_SCALES.chromatic;
  document.querySelectorAll('#piano .pkey').forEach(key=>{
    const pc=TH_PC[key.dataset.note];
    const inKey=steps.includes(((pc-root)%12+12)%12);
    key.classList.toggle('locked-out',lock&&!inKey);
  });
}
function renderProgStrip(){
  try{renderProgSlots()}catch(e){}
  const el=document.getElementById('progStrip');if(!el)return;
  const prog=state.detectedChords||[];
  el.innerHTML=prog.length
    ?prog.map(c=>'<span class="prog-chord" data-pchord="'+esc(c)+'">'+esc(c)+'</span>').join('')
    :'<span class="text-dim" style="font-size:12px">Tap chords below to build</span>';
}
let _humCtx=null;
async function startHumRecording(){
  // Guest + signed-in both allowed (local analysis)
  try{
    unlockAudio();
    if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia)throw new Error('no-mic-api');
    const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:true}});
    const ctx=ensureAudio();
    const src=ctx.createMediaStreamSource(stream);
    const an=ctx.createAnalyser();an.fftSize=2048;src.connect(an);
    const buf=new Float32Array(an.fftSize);
    _humCtx={stream,src,an,frames:[],timer:null};
    state.recording=true;
    document.getElementById('humZone')?.classList.add('recording');
    document.getElementById('humBtn')?.classList.add('recording','rec');
    const lab=document.getElementById('humLabel');if(lab)lab.textContent='Listening… hum a short melody (up to 10 s)';
    const tm=document.getElementById('humTimer');const t0=Date.now();
    if(tm){tm.style.opacity='1';tm.textContent='0:00';}
    const NOTE_LABELS=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    const liveEl=document.getElementById('humLivePitch');
    if(liveEl)liveEl.textContent='…';
    _humCtx.timer=setInterval(()=>{
      an.getFloatTimeDomainData(buf);
      const f=detectPitch(buf,ctx.sampleRate);
      let pc=-1;
      if(f>70&&f<1100)pc=((Math.round(12*Math.log2(f/440))+69)%12+12)%12;
      _humCtx.frames.push(pc);
      if(liveEl){
        if(pc>=0){liveEl.textContent=NOTE_LABELS[pc];liveEl.style.opacity='1';}
        else {liveEl.textContent='·';liveEl.style.opacity='.45';}
      }
      const secs=Math.floor((Date.now()-t0)/1000);
      if(tm)tm.textContent='0:'+String(secs).padStart(2,'0');
      if(secs>=10)stopHumRecording();
    },50);
  }catch(e){
    console.warn('hum',e);state.recording=false;_humCtx=null;
    toast('Mic permission needed');
    const lab=document.getElementById('humLabel');if(lab)lab.textContent='Mic blocked — allow microphone access and try again';
  }
}
function stopHumRecording(){
  if(!state.recording||!_humCtx)return;
  state.recording=false;
  const h=_humCtx;_humCtx=null;
  clearInterval(h.timer);
  try{h.stream.getTracks().forEach(t=>t.stop());}catch(e){}
  try{h.src.disconnect();}catch(e){}
  document.getElementById('humZone')?.classList.remove('recording');
  document.getElementById('humBtn')?.classList.remove('recording','rec');
  const tm=document.getElementById('humTimer');if(tm)tm.style.opacity='0';
  const liveEl=document.getElementById('humLivePitch');
  if(liveEl){liveEl.textContent='—';liveEl.style.opacity='1';}
  analyzeHum(h.frames);
}
function framesToNotes(frames){
  // median-smooth, then merge runs of the same pitch class into weighted notes
  const sm=frames.map((v,i)=>{const w=[frames[i-1],v,frames[i+1]].filter(x=>x!==undefined&&x>=0);if(v<0)return -1;const c={};w.forEach(x=>c[x]=(c[x]||0)+1);return +Object.keys(c).sort((a,b)=>c[b]-c[a])[0];});
  const notes=[];let cur=null;
  sm.forEach(pc=>{
    if(pc<0){if(cur){notes.push(cur);cur=null;}return;}
    if(cur&&cur.pc===pc)cur.w++;else{if(cur)notes.push(cur);cur={pc,w:1};}
  });
  if(cur)notes.push(cur);
  return notes.filter(n=>n.w>=3);
}
function progFromDegrees(rootPc,minor,degs){
  const sc=minor?MINOR_SCALE:MAJOR_SCALE,tab=minor?MINOR_DEG:MAJOR_DEG;
  return degs.map(d=>{const [semi,q]=tab[d];const r=(rootPc+semi)%12;return NOTE_NAMES_SHARP[r]+(q==='m'?'m':q==='dim'?'dim':'');});
}
function alternativeProgression(){
  const k=state._humKey;
  if(!k)return null;
  const majorSets=[[0,4,5,3],[5,3,0,4],[0,5,3,4],[1,4,0,5],[0,2,3,4]];
  const minorSets=[[0,5,2,6],[0,3,6,2],[0,6,5,6],[0,3,4,0],[0,5,3,4]];
  const sets=k.minor?minorSets:majorSets;
  state._humAlt=((state._humAlt||0)+1)%sets.length;
  return progFromDegrees(k.root,k.minor,sets[state._humAlt]);
}
function analyzeHum(frames){
  const lab=document.getElementById('humLabel');
  const notes=framesToNotes(frames||[]);
  if(notes.length<4){
    if(lab)lab.textContent='Couldn\u2019t hear a clear melody — hum a bit louder, closer to the mic, in a quiet place.';
    toast('No clear melody heard');
    return;
  }
  const r=melodyToChords(notes);
  if(!r){if(lab)lab.textContent='Couldn\u2019t analyze that — try again.';return;}
  const minor=/m$/.test(r.key);
  state._humKey={root:NOTE_NAMES_SHARP.indexOf(r.key.replace(/m$/,'')),minor};
  state._humAlt=0;
  state._humFrames=(frames||[]).slice();
  state._humNotes=notes.slice();
  state.detectedChords=r.chords;
  renderHumAnalysis(notes,frames);
  showChordResult(r.chords);
  try{renderProgStrip()}catch(e){}
  if(lab)lab.textContent='Key: '+r.key+' — '+notes.length+' notes heard';
  const keyEl=document.getElementById('songKey');
  if(keyEl&&!keyEl.value.trim()){keyEl.value=r.key;try{applyScaleLock()}catch(e){};scheduleSave();}
}
function bindExtras(){
  if(window._extrasBound)return;window._extrasBound=true;
  const g=id=>document.getElementById(id);
  g('closeHelp')?.addEventListener('click',e=>{e.preventDefault();closeHelp()});
  g('closeMessages')?.addEventListener('click',e=>{e.preventDefault();closeMessages()});
  g('messagesBackBtn')?.addEventListener('click',e=>{e.preventDefault();state._msgPeer=null;showMessageInbox()});
  g('messagesInbox')?.addEventListener('click',e=>{
    const row=e.target.closest('[data-msg-peer]');if(!row)return;
    showMessageThread({key:row.getAttribute('data-msg-peer'),name:row.getAttribute('data-msg-name')});
  });
  g('closePublicProfile')?.addEventListener('click',e=>{e.preventDefault();closePublicProfile()});
  [['helpModal',closeHelp],['messagesModal',closeMessages],['publicProfileModal',closePublicProfile]].forEach(([id,fn])=>{
    const m=g(id);if(m)m.addEventListener('click',e=>{if(e.target===m)fn()});
  });
  g('ppFollowBtn')?.addEventListener('click',async e=>{
    e.preventDefault();const p=state._profilePeer;if(!p)return;
    if(!state.user){openAuth('signin');return;}
    const on=await toggleFollow({cloudId:p.cloudId,id:p.key,username:p.username});
    const b=g('ppFollowBtn');if(b){b.textContent=on?'Following':'Follow';b.className=on?'btn':'btn pri';b.style.width='100%';b.style.marginBottom='8px';}
  });
  g('ppMessageBtn')?.addEventListener('click',e=>{
    e.preventDefault();const p=state._profilePeer;if(!p)return;
    closePublicProfile();
    openMessages({key:p.cloudId||p.key,name:p.name});
  });
  g('scaleLock')?.addEventListener('change',applyScaleLock);
  g('songKey')?.addEventListener('input',applyScaleLock);
  g('progStrip')?.addEventListener('click',e=>{
    const c=e.target.closest('[data-pchord]');if(!c)return;
    unlockAudio();(CHORDS[c.dataset.pchord]||[]).forEach((n,j)=>setTimeout(()=>playNote(n,3,.5),j*30));
  });
  g('chordBank')?.addEventListener('change',e=>{
    const bank=CHORD_BANKS[e.target.value];if(!bank)return;
    state.detectedChords=bank.slice();renderProgStrip();
    bank.forEach((c,i)=>setTimeout(()=>(CHORDS[c]||[]).forEach((n,j)=>setTimeout(()=>playNote(n,3,.5),j*30)),i*600));
    e.target.value='';
  });
  g('chordChips')?.addEventListener('click',e=>{
    const chip=e.target.closest('.chip');if(!chip||!CHORDS[chip.dataset.chord])return;
    const prog=(state.detectedChords||[]).slice();
    if(prog.length>=4)prog.shift();
    prog.push(chip.dataset.chord);state.detectedChords=prog;renderProgStrip();
  });
  g('lyricTemplate')?.addEventListener('change',e=>applyLyricTemplate(e.target.value));
}
function bindManualCompletion(){
 const safe=f=>{try{return f()}catch(e){console.warn('[Tapehead manual]',e)}};
 const once=(id,ev,f)=>{const e=document.getElementById(id);if(e&&!e.dataset.m188){e.dataset.m188='1';e.addEventListener(ev,f)}};
 once('copyProgBtn','click',async()=>safe(async()=>{const c=state.detectedChords||[];if(!c.length){toast('No chord progression to copy');return}toast((await copyText(c.join(' - ')))?'Chords copied':'Copy failed')}));
 once('playProgBtn','click',()=>safe(()=>{const c=state.detectedChords||[];if(!c.length){toast('Build a chord progression first');return}unlockAudio();c.forEach((ch,i)=>setTimeout(()=>{(CHORDS[ch]||[]).forEach((n,j)=>setTimeout(()=>playNote(n,state.octave||3,.55),j*35))},i*650))}));
 once('clearProgBtn','click',()=>safe(()=>{state.detectedChords=[];renderProgSlots();const r=document.getElementById('chordResult');if(r){r.hidden=true;r.innerHTML=''}const a=document.getElementById('humActions');if(a)a.hidden=true;saveCurrentSong();toast('Chord progression cleared')}));
 once('abMixBtn','click',()=>safe(()=>{const b=document.getElementById('abMixBtn');if(!state._mixAB){state._mixAB={volumes:JSON.parse(JSON.stringify(state.volumes||{})),mute:JSON.parse(JSON.stringify(state.mute||{})),solo:JSON.parse(JSON.stringify(state.solo||{})),label:'A'};b.textContent='A/B · A';toast('Mix A saved — change the mix, then press A/B again');return}const cur={volumes:JSON.parse(JSON.stringify(state.volumes||{})),mute:JSON.parse(JSON.stringify(state.mute||{})),solo:JSON.parse(JSON.stringify(state.solo||{}))};if(!state._mixAB.b){state._mixAB.b=cur;state.volumes=JSON.parse(JSON.stringify(state._mixAB.volumes));state.mute=JSON.parse(JSON.stringify(state._mixAB.mute));state.solo=JSON.parse(JSON.stringify(state._mixAB.solo));state._mixAB.label='A';b.textContent='A/B · A'}else if(state._mixAB.label==='A'){state.volumes=JSON.parse(JSON.stringify(state._mixAB.b.volumes));state.mute=JSON.parse(JSON.stringify(state._mixAB.b.mute));state.solo=JSON.parse(JSON.stringify(state._mixAB.b.solo));state._mixAB.label='B';b.textContent='A/B · B'}else{state.volumes=JSON.parse(JSON.stringify(state._mixAB.volumes));state.mute=JSON.parse(JSON.stringify(state._mixAB.mute));state.solo=JSON.parse(JSON.stringify(state._mixAB.solo));state._mixAB.label='A';b.textContent='A/B · A'}buildChannelStrip()}));
 once('mixPresets','click',e=>safe(()=>{const c=e.target.closest('[data-preset]');if(!c)return;const base={kick:.82,snare:.70,hat:.45,clap:.55,chords:.55,vocal:.85,master:.78},P={balanced:{...base},vocal:{...base,vocal:1,kick:.78,chords:.48},club:{...base,kick:.95,snare:.82,hat:.55,clap:.68,chords:.62,vocal:.82,master:.82},radio:{...base,kick:.76,snare:.68,hat:.42,clap:.5,chords:.58,vocal:.94},soft:{...base,kick:.62,snare:.52,hat:.3,clap:.4,chords:.62,vocal:.72,master:.7}};const EQ={balanced:{low:50,mid:50,high:52},vocal:{low:46,mid:56,high:58},club:{low:62,mid:48,high:55},radio:{low:48,mid:54,high:60},soft:{low:52,mid:48,high:46}};const GLUE={balanced:35,vocal:30,club:55,radio:45,soft:25};state.volumes={...(state.volumes||{}),...(P[c.dataset.preset]||base)};state.eq={...(EQ[c.dataset.preset]||EQ.balanced)};state.glue=GLUE[c.dataset.preset]!=null?GLUE[c.dataset.preset]:40;state.mute={};state.solo={};document.querySelectorAll('#mixPresets [data-preset]').forEach(x=>x.classList.toggle('on',x===c));const m=document.getElementById('masterFader');if(m)m.value=Math.round(state.volumes.master*100);const d=document.getElementById('masterDb');if(d)d.textContent=(20*Math.log10(Math.max(.01,state.volumes.master))).toFixed(1)+' dB';try{setEqUIFromState();syncLiveGraphLevels()}catch(e){}buildChannelStrip();saveCurrentSong();toast(c.textContent.trim()+' mix applied')}));
 once('copyMixBtn','click',async()=>safe(async()=>{const n=(document.getElementById('mixNotes')?.value||'').trim();if(!n){toast('No mix notes to copy');return}toast((await copyText(n))?'Mix notes copied':'Copy failed')}));
 once('messageSendBtn','click',()=>safe(()=>handleSendMessage()));
 const mi=document.getElementById('messageInput');if(mi&&!mi.dataset.m188){mi.dataset.m188='1';mi.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();safe(()=>handleSendMessage())}})}
 once('masterFader','input',e=>safe(()=>{state.volumes.master=Number(e.target.value)/100;try{syncLiveGraphLevels()}catch(_e){}const d=document.getElementById('masterDb');if(d)d.textContent=(20*Math.log10(Math.max(.01,state.volumes.master))).toFixed(1)+' dB';saveCurrentSong()}));
 const mn=document.getElementById('mixNotes');if(mn&&!mn.dataset.m188){mn.dataset.m188='1';mn.addEventListener('input',()=>{state.mixNotes=mn.value;saveCurrentSong()})}
}

/* Expose UI APIs on window right away (sidebar bridge scripts use these) */
(function(){
  var api={openMessages:openMessages,closeMessages:closeMessages,openHelp:openHelp,closeHelp:closeHelp,openSidebar:openSidebar,closeSidebar:closeSidebar,openProfile:openProfile,closeProfile:closeProfile,openPublish:openPublish,closePublish:closePublish,openPaywall:openPaywall,closePaywall:closePaywall,openAuth:openAuth,setView:setView,setTheme:setTheme,newSong:newSong,doMixdown:doMixdown,bounceMixdown:bounceMixdown,isPro:isPro,toast:toast,processProPayment:processProPayment};
  window.Tapehead=window.Tapehead||{};
  Object.keys(api).forEach(function(k){window[k]=api[k];window.Tapehead[k]=api[k];});
  window.__tapeheadOpenProfile=openProfile;
})();
function thStartupWait(promise, ms, fallback){
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(err => { throw err; }),
    new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); })
  ]).finally(() => clearTimeout(timer));
}
async function init(){try{bindPaywallUI()}catch(e){};try{bindExtras()}catch(e){console.warn(e)};try{bindManualCompletion()}catch(e){console.warn(e)};try{bindCollabProExtras()}catch(e){console.warn(e)};try{bindProUI()}catch(e){};try{bindCollabUI()}catch(e){};try{bindWriteProUI();bindWriteGlobalOnce()}catch(e){};try{bindFeedPro()}catch(e){};try{Cloud.init();const b=document.getElementById('cloudModeBadge');try{updateCloudBadge()}catch(e){if(b)b.textContent=Cloud.isCloud()?'Cloud Connected':'Local mode'}}catch(e){console.warn(e)};

    // Auth session restore
    state.user = null;
    try{state.pro=loadPro()}catch(e){}
    const sess = loadSession();
    if (sess && sess.cloud && Cloud.isCloud()) {
      try {
        const cloudSession = await thStartupWait(Cloud.ensureSession(), 5000, { __thStartupTimeout: true });
        if (cloudSession?.__thStartupTimeout) {
          console.warn('[Tapehead] Cloud session restore timed out; continuing startup so controls remain responsive.');
        } else if (cloudSession?.user) {
          const cu = cloudSession.user;
          const profile = await thStartupWait(Cloud.getProfile(cu.id).then(p => p || Cloud.ensureProfile(cu, cu.user_metadata?.username, cu.email)), 5000, null);
          state.user = { id:cu.id, cloudId:cu.id, username:profile?.username || cu.user_metadata?.username || cu.email?.split('@')[0] || 'Artist', contact:cu.email || sess.contact, avatar:profile?.avatar_url || null };
          state.artistName = state.user.username;
        } else { localStorage.removeItem('th-session'); }
        if (state.user) await thStartupWait(syncCloudPro(), 5000, null);
      } catch(e) { console.warn('cloud session restore',e); }
    } else if (sess && sess.contact) {
      const users = loadUsers();
      let u = users[sess.contact] || users[normalizeContact(sess.contact)];
      if (!u) {
        for (const [k, val] of Object.entries(users)) {
          if (val && (val.id === sess.id || normalizeContact(val.contact||k) === normalizeContact(sess.contact))) { u = val; break; }
        }
      }
      if (u) {
        const ckey = normalizeContact(u.contact || sess.contact);
        state.user = { id: u.id, username: u.username, contact: ckey, avatar: u.avatar, cloudId: u.cloudId || null };
        state.artistName = u.username || 'Artist';
        if (u.pro) { state.pro = u.pro; savePro(u.pro); } else { try{grantTrialPro()}catch(e){} }
      }
    }
    {
      const qs = new URLSearchParams(window.location.search);
      const payFlag = qs.get('payment');
      const clearUrl = () => { try { history.replaceState({}, document.title, window.location.pathname); } catch (e) {} };
      if (payFlag === 'cancelled') {
        localStorage.removeItem('th-pending-tx');
        setTimeout(() => toast('Payment cancelled — you were not charged.'), 600);
        clearUrl();
      } else if (payFlag === 'complete' && Cloud.isCloud() && state.user?.cloudId) {
        // Pesapal appends OrderTrackingId + OrderMerchantReference to our callback URL.
        const trackingId = qs.get('OrderTrackingId');
        const txRef = qs.get('OrderMerchantReference') || localStorage.getItem('th-pending-tx');
        if (txRef) {
          try {
            const session = await Cloud.ensureSession();
            let vd = {}, vr = null;
            for (let attempt = 0; attempt < 4; attempt++) {
              vr = await fetch('/api/pro-verify', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token }, body: JSON.stringify({ tx_ref: txRef, order_tracking_id: trackingId || undefined }) });
              vd = await vr.json().catch(() => ({}));
              if (vr.status !== 202) break;
              await new Promise(res => setTimeout(res, 3000));
            }
            if (vr.ok && vd.entitlement) {
              localStorage.removeItem('th-pending-tx');
              state.pro = { active: true, plan: vd.entitlement.plan, label: vd.entitlement.plan === 'lifetime' ? 'Lifetime Pro' : vd.entitlement.plan === 'year' ? 'Yearly Pro' : 'Monthly Pro', started: Date.now(), expires: vd.entitlement.expires_at ? new Date(vd.entitlement.expires_at).getTime() : null, server: true };
              toast('Payment confirmed — Pro is active.');
            } else if (vr.status === 202) {
              toast('Payment is still processing. Pro turns on automatically once Pesapal confirms it.', 5000);
            } else toast(vd.error || 'Payment could not be confirmed.');
          } catch (e) { console.warn('payment return', e); }
        }
        clearUrl();
      }
    }
    state.songs = loadUserSongs();
    if (Cloud.isCloud() && state.user?.cloudId) {
      await thStartupWait(hydrateCloudProjects(), 5000, null);
    }
    updateUserUI();
    seedCommunity(); if(Cloud.isCloud()){Cloud.subscribeSocial(()=>{clearTimeout(state._socialRefreshT);state._socialRefreshT=setTimeout(()=>{if(document.hidden){window.__thSocialDirty=true;return;}syncCloudSocial();},1500);});if(!window.__thVisBound){window.__thVisBound=true;document.addEventListener('visibilitychange',()=>{if(!document.hidden&&window.__thSocialDirty){window.__thSocialDirty=false;syncCloudSocial();}});}syncCloudSocial();}

try{setTheme(state.theme)}catch(e){};try{buildPiano()}catch(e){};try{ensurePatternLength(state.stepCount||16);buildTracks()}catch(e){};try{buildChannelStrip()}catch(e){};try{buildWave()}catch(e){};try{renderSongList()}catch(e){};const initials=state.artistName.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()||'TH';const _av=document.getElementById('avatarBtn');if(_av&&!state.user){_av.textContent=initials;}if(state.user){
  try{ if(state.songs.length) loadSong(state.songs[0].id); else newSong(); }catch(e){console.warn(e)}
  try{unlockIfAuthed()}catch(e){};try{updateProUI()}catch(e){}
}else{
  try{buildTracks()}catch(e){}
  try{
    // Progressive: show auth but allow "Explore as guest" / Not now
    lockApp(true);
    setTimeout(function(){ openAuth('signin'); }, 280);
  }catch(e){}
}


// Restore the last workspace after the project/auth state has been initialized.
try { setView(state.view || 'write'); } catch (e) { console.warn('view restore', e); }

/* ── Sidebar safety controller ── */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeSidebar();
    closePaywall();
    closeProfile();
    closeMessages();
    closeHelp();
    closePublish();
    closePublicProfile();
  }
});

document.querySelectorAll('.tab').forEach(t =>
  t.addEventListener('click', () => setView(t.dataset.view))
);

document.querySelectorAll('.bottom-tab').forEach(t =>
  t.addEventListener('click', () => {
    const name=t.dataset.nav;
    setView(name);
    if(name==='community'){
      const feedView=document.getElementById('view-community');
      if(feedView && !feedView.hidden){
        feedView.style.display='block';
        feedView.style.flex='0 0 auto';
        feedView.style.minHeight='0';
        feedView.style.height='auto';
        feedView.style.overflow='visible';
      }
    }
  })
);
document.getElementById('studioSubnav')?.addEventListener('click', e => {
  const tab = e.target.closest('[data-studio]');
  if (!tab) return;
  setView(tab.dataset.studio);
});

document.getElementById('sampleKitRow')?.addEventListener('change', e => {
  const input = e.target.closest('input[data-sample]');
  if (!input || !input.files || !input.files[0]) return;
  loadDrumSample(input.getAttribute('data-sample'), input.files[0]);
  input.value = '';
});
document.getElementById('clearSamplesBtn')?.addEventListener('click', clearDrumSamples);
document.getElementById('snapshotRoomBtn')?.addEventListener('click', () => {
  const label = prompt('Version label', 'Take ' + new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}));
  if (label == null) return;
  snapshotRoomVersion(label.trim() || undefined);
});
document.getElementById('roomVersionList')?.addEventListener('click', e => {
  const btn = e.target.closest('[data-restore-ver]');
  if (!btn) return;
  restoreRoomVersion(btn.getAttribute('data-restore-ver'));
});


/* Sidebar events are installed in the final isolated bridge below. */

/* sidebarUser bound in profile binds */
document.getElementById('profileUpgrade')?.addEventListener('click', function(e){
  e.preventDefault(); e.stopPropagation();
  openPaywall(isPro() ? 'Extend or change your Pro plan.' : 'Get Pro — 30-day trial available.');
});


function bindProfileTrigger() {
  const avatar = document.getElementById('avatarBtn');
  if (!avatar || avatar.dataset.profileBound === '1' || avatar.dataset.profileBridge === '1') return;
  avatar.dataset.profileBound = '1';
  avatar.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    try { openProfile(); } catch (err) { console.warn('profile trigger', err); }
  });
}
bindProfileTrigger();
document.getElementById('closeProfile')?.addEventListener('click', function(e) {
  e.preventDefault();
  closeProfile();
});
document.getElementById('profileModal')?.addEventListener('click', function(e) {
  if (e.target.id === 'profileModal') closeProfile();
});
document.getElementById('saveProfile')?.addEventListener('click',saveProfile);
document.getElementById('previewProfileBtn')?.addEventListener('click',()=>{ if(state.user?.username){ closeProfile(); openPublicProfile(state.user.username); } });
document.getElementById('ppEditBtn')?.addEventListener('click',()=>{ closePublicProfile(); openProfile(); });
document.getElementById('ppCollabBtn')?.addEventListener('click',()=>{ try{ closePublicProfile(); setView('collab'); }catch(e){ toast('Open Collab from the bottom bar'); } });
document.getElementById('publicProfileModal')?.addEventListener('click',e=>{ const tab=e.target.closest('[data-pp-tab]'); if(tab){ renderArtistProfileTabs(tab.getAttribute('data-pp-tab')); } });document.getElementById('profileTheme')?.addEventListener('click',()=>{setTheme(state.theme==='dark'?'light':'dark');/* quiet */});document.getElementById('clearAllData')?.addEventListener('click',()=>{if(confirm('Delete all projects? This cannot be undone.')){state.songs=[];persistSongs();newSong();closeProfile();toast('All projects cleared')}});document.getElementById('songTitle')?.addEventListener('input',scheduleSave);document.getElementById('lyrics')?.addEventListener('input',scheduleSave);

document.getElementById('bpmBadge')?.addEventListener('click', () => {
  const cur = state.bpm || 120;
  const v = prompt('BPM (60–200)', String(cur));
  if (v == null) return;
  const n = parseInt(v, 10);
  if (n >= 60 && n <= 200) {
    state.bpm = n;
    const b = document.getElementById('bpmBadge');
    if (b) b.textContent = n + ' BPM';
    const sb = document.getElementById('songBpmNote');
    if (sb) sb.value = n;
    scheduleSave();
  }
});

document.getElementById('insertSectionBtn')?.addEventListener('click', insertStructureSection);
document.getElementById('songHook')?.addEventListener('input', scheduleSave);

document.getElementById('octaveUp')?.addEventListener('click',()=>{state.octave=Math.min(6,state.octave+1);buildPiano()});document.getElementById('octaveDown')?.addEventListener('click',()=>{state.octave=Math.max(1,state.octave-1);buildPiano()});
document.getElementById('keysSound')?.addEventListener('change',e=>{state.keysSound=e.target.value;toast(e.target.options[e.target.selectedIndex]?.text+' sound')});document.getElementById('keysVelocity')?.addEventListener('input',e=>{state.keysVelocity=Number(e.target.value)/100});document.getElementById('keysSustainBtn')?.addEventListener('click',e=>{state.keysSustain=!state.keysSustain;e.currentTarget.classList.toggle('pri',state.keysSustain);e.currentTarget.textContent=state.keysSustain?'Sustain On':'Sustain';if(!state.keysSustain)releaseAllKeys()});document.getElementById('keysRecordBtn')?.addEventListener('click',e=>{if(state.keysRecording){state.keysRecording=false;releaseAllKeys();updateKeysRecordUI();toast(state.keysTake.length+' notes captured')}else{state.keysTake=[];state._keyStartedAt=performance.now();state.keysRecording=true;updateKeysRecordUI();toast('Keys recording started')}});document.getElementById('keysClearTake')?.addEventListener('click',()=>{state.keysTake=[];state.keysRecording=false;state._keyStartedAt=0;releaseAllKeys();updateKeysRecordUI();toast('Keys take cleared')});document.getElementById('keysCaptureBtn')?.addEventListener('click',()=>{if(!state.keysTake.length){toast('Record a keyboard idea first');return}state._keysIdea={notes:state.keysTake.slice(),bpm:state.bpm||120,octave:state.octave,sound:state.keysSound};try{saveCurrentSong()}catch(e){}toast('Keyboard idea captured in this project')});
document.getElementById('scaleChips')?.addEventListener('click',e=>{const chip=e.target.closest('.chip');if(!chip)return;document.querySelectorAll('#scaleChips .chip').forEach(c=>c.classList.remove('on'));chip.classList.add('on');state.scale=chip.dataset.scale;try{applyScaleLock()}catch(e){}});
document.getElementById('chordChips')?.addEventListener('click',e=>{const chip=e.target.closest('.chip');if(!chip)return;const notes=CHORDS[chip.dataset.chord];if(notes){notes.forEach((n,i)=>setTimeout(()=>playNote(n,state.octave,.5),i*30));/* quiet */}});

  
document.getElementById('mixdownBtn')?.addEventListener('click', () => { doMixdown(); });
[document.getElementById('mixPlayTop'),document.getElementById('mixMasterPlay')].forEach(btn=>btn?.addEventListener('click',()=>{ try{document.getElementById('playBtn')?.click()}catch(e){} }));
document.getElementById('stemsBtn')?.addEventListener('click', () => { doExportStems(); });

document.getElementById('arrangementList')?.addEventListener('click', e => {
  const tog = e.target.closest('[data-arr-tog]');
  const up = e.target.closest('[data-arr-up]');
  const down = e.target.closest('[data-arr-down]');
  const arr = ensureArrangement();
  const dup = e.target.closest('[data-arr-dup]');
  if (tog) {
    const i = Number(tog.getAttribute('data-arr-tog'));
    if (arr[i]) arr[i].on = !arr[i].on;
  } else if (dup) {
    const i = Number(dup.getAttribute('data-arr-dup'));
    if (arr[i] && arr.length < 16) {
      arr.splice(i + 1, 0, { id: arr[i].id, on: true, bars: arr[i].bars });
    }
  } else if (up) {
    const i = Number(up.getAttribute('data-arr-up'));
    if (i > 0) { const t = arr[i-1]; arr[i-1] = arr[i]; arr[i] = t; }
  } else if (down) {
    const i = Number(down.getAttribute('data-arr-down'));
    if (i < arr.length - 1) { const t = arr[i+1]; arr[i+1] = arr[i]; arr[i] = t; }
  } else return;
  state.arrangement = arr;
  renderArrangement();
  try { scheduleSave(); } catch (err) {}
});
document.getElementById('arrangementList')?.addEventListener('change', e => {
  const inp = e.target.closest('[data-arr-bars]');
  if (!inp) return;
  const i = Number(inp.getAttribute('data-arr-bars'));
  const arr = ensureArrangement();
  if (arr[i]) {
    arr[i].bars = Math.max(1, Math.min(32, Number(inp.value) || 4));
    state.arrangement = arr;
    renderArrangement();
    try { scheduleSave(); } catch (err) {}
  }
});
document.getElementById('arrPlayBtn')?.addEventListener('click', () => { startArrangementPreview(); });
document.getElementById('arrResetBtn')?.addEventListener('click', () => {
  state.arrangement = defaultArrangement();
  renderArrangement();
  try { scheduleSave(); } catch (err) {}
  toast('Arrangement reset');
});


['eqLow','eqMid','eqHigh'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', applyEqFromUI);
});
document.getElementById('glueSlider')?.addEventListener('input', e => {
  state.glue = Number(e.target.value);
  const gv = document.getElementById('glueVal');
  if (gv) gv.textContent = state.glue + '%';
  applyEqFromUI();
});

document.getElementById('timelineMap')?.addEventListener('click', e => {
  const t = e.target.closest('[data-tl]');
  if (!t) return;
  const id = t.dataset.tl;
  const sel = document.getElementById('recSection');
  if (sel) {
    // map to option values
    const map = { intro:'full', verse1:'verse', chorus:'chorus', verse2:'verse', bridge:'verse', outro:'full' };
    if ([...sel.options].some(o => o.value === id)) sel.value = id;
    else if (map[id]) sel.value = map[id];
  }
  renderTimelineMap(id);
});
document.getElementById('recSection')?.addEventListener('change', e => {
  renderTimelineMap(e.target.value);
});
document.getElementById('recMetronome')?.addEventListener('change', e => {
  state._recMonitor = state._recMonitor || {};
  state._recMonitor.click = e.target.checked;
});

document.getElementById('vocalRecBtn')?.addEventListener('click', toggleVocalRecord);
document.getElementById('vocalTakes')?.addEventListener('click', e => {
  const use = e.target.closest('[data-take-use]');
  if (use) { e.preventDefault(); selectVocalTake(use.getAttribute('data-take-use')); return; }
  const play = e.target.closest('[data-take-play]');
  if (play) { e.preventDefault(); playVocalTakeById(play.getAttribute('data-take-play')); return; }
});
  
document.getElementById('recAuditionBedBtn')?.addEventListener('click', () => { if (!state.externalBed) auditionRecordBed(); });
document.getElementById('recGoBeatBtn')?.addEventListener('click', () => setView('beat'));
document.getElementById('recQuickBedBtn')?.addEventListener('click', applyQuickRecordBed);

document.getElementById('recPlayBeatBtn')?.addEventListener('click', auditionRecordBed);
  document.getElementById('recPlayVocalBtn')?.addEventListener('click', playVocalTake);
  document.getElementById('recNudgeLeft')?.addEventListener('click', () => nudgeVocal(-50));
  document.getElementById('recNudgeRight')?.addEventListener('click', () => nudgeVocal(50));
  document.getElementById('recSendMixBtn')?.addEventListener('click', () => {
    if (!state.vocal) { toast('Record a take first'); return; }
    setView('mix');
    try { buildChannelStrip(); updatePublishChecklist(); } catch (e) {}
    toast('Vocal on Mix — balance then Publish');
  });

document.getElementById('playBtn')?.addEventListener('click',()=>{if(state.playing)stopTransport();else startTransport()});document.getElementById('clearPattern')?.addEventListener('click',()=>{
  if(!confirm('Clear all steps?'))return;
  ensurePatternLength(state.stepCount);
  Object.keys(state.pattern).forEach(k=>{if(Array.isArray(state.pattern[k]))state.pattern[k]=state.pattern[k].map(()=>0)});
  buildTracks();saveCurrentSong();
});
document.getElementById('randomizePattern')?.addEventListener('click',randomizePattern);
document.getElementById('duplicatePattern')?.addEventListener('click',duplicatePatternHalf);
document.getElementById('stepLenChips')?.addEventListener('click',e=>{
  const c=e.target.closest('[data-steps]');if(!c)return;
  document.querySelectorAll('#stepLenChips .chip').forEach(x=>x.classList.remove('on'));
  c.classList.add('on');
  state.stepCount=parseInt(c.dataset.steps,10);
  ensurePatternLength(state.stepCount);
  buildTracks();saveCurrentSong();
});
const KITS={  trap:{kick:[1,0,0,0,1,0,0,1],snare:[0,0,1,0,0,0,1,0],hat:[1,1,1,1,1,1,1,1],clap:[0,0,0,0,0,0,1,0]},  house:{kick:[1,0,0,0,1,0,0,0],snare:[0,0,0,0,1,0,0,0],hat:[0,1,0,1,0,1,0,1],clap:[0,0,0,0,1,0,0,0]},  boom:{kick:[1,0,0,1,0,0,1,0],snare:[0,0,1,0,0,0,1,0],hat:[0,1,0,1,0,1,0,1],clap:[0,0,1,0,0,0,0,0]},  afro:{kick:[1,0,0,1,0,1,0,0],snare:[0,0,1,0,0,0,1,0],hat:[1,0,1,0,1,0,1,0],clap:[0,0,0,0,1,0,0,0]},  amapiano:{kick:[1,0,0,0,1,0,1,0],snare:[0,0,0,0,1,0,0,0],hat:[0,1,0,1,0,1,1,1],clap:[0,0,1,0,0,0,0,0]},  techno:{kick:[1,0,1,0,1,0,1,0],snare:[0,0,0,0,1,0,0,0],hat:[1,1,1,1,1,1,1,1],clap:[0,0,0,0,0,0,0,0]},  drill:{kick:[1,0,0,1,0,0,0,0],snare:[0,0,0,0,1,0,0,1],hat:[1,0,1,1,0,1,1,0],clap:[0,0,0,0,1,0,0,0]},  rnb:{kick:[1,0,0,0,0,0,1,0],snare:[0,0,0,0,1,0,0,0],hat:[0,1,0,1,0,1,0,1],clap:[0,0,1,0,0,0,0,0]},  reggaeton:{kick:[1,0,0,1,1,0,0,1],snare:[0,0,1,0,0,0,1,0],hat:[0,1,0,0,0,1,0,0],clap:[0,0,1,0,0,0,1,0]},  dancehall:{kick:[1,0,0,0,0,1,0,0],snare:[0,0,1,0,0,0,1,0],hat:[1,0,1,0,1,0,1,0],clap:[0,0,0,0,1,0,0,0]},  gospel:{kick:[1,0,0,0,1,0,0,0],snare:[0,0,0,0,1,0,0,0],hat:[0,0,1,0,0,0,1,0],clap:[0,0,1,0,0,0,1,0]},  rock:{kick:[1,0,0,0,1,0,0,0],snare:[0,0,1,0,0,0,1,0],hat:[1,1,1,1,1,1,1,1],clap:[0,0,0,0,0,0,0,0]},  jazz:{kick:[1,0,0,1,0,0,1,0],snare:[0,0,1,0,0,1,0,0],hat:[0,1,0,1,0,1,0,1],clap:[0,0,0,0,0,0,0,0]},  lofi:{kick:[1,0,0,0,0,0,1,0],snare:[0,0,0,0,1,0,0,0],hat:[0,1,0,0,0,1,0,1],clap:[0,0,0,0,0,0,0,0]},  pop:{kick:[1,0,0,0,1,0,0,0],snare:[0,0,0,0,1,0,0,0],hat:[0,1,0,1,0,1,0,1],clap:[0,0,1,0,0,0,1,0]},  hiphop:{kick:[1,0,0,0,0,0,1,0],snare:[0,0,1,0,0,0,1,0],hat:[0,1,0,1,0,1,0,1],clap:[0,0,0,0,1,0,0,0]}};
document.getElementById('genreSelect')?.addEventListener('change',e=>{
  state.kit=e.target.value;
  const kitPat=KITS[state.kit]||KITS.trap;
  const _keepRes=thRes();
  state.pattern=JSON.parse(JSON.stringify(kitPat));
  if(_keepRes!==8)state.pattern._res=_keepRes;
  try{ thFillGroove(state.pattern, state.stepCount||16); }catch(e){console.warn(e);}
  buildTracks();
  saveCurrentSong();
});
document.getElementById('masterFader')?.addEventListener('input',e=>{state.volumes.master=e.target.value/100;try{syncLiveGraphLevels()}catch(_e){}document.getElementById('masterDb').textContent=(20*Math.log10(Math.max(.01,state.volumes.master))).toFixed(1)+' dB'});

document.getElementById('shareOpts')?.addEventListener('change', () => {
  document.querySelectorAll('#shareOpts .share-opt').forEach(lab => {
    const inp = lab.querySelector('input');
    lab.classList.toggle('on', !!(inp && inp.checked));
  });
  refreshPublishPreview();
});
document.getElementById('publishCaption')?.addEventListener('input', refreshPublishPreview);
document.getElementById('nativeShareBtn')?.addEventListener('click', nativeShareWork);
document.getElementById('shareToFeed')?.addEventListener('click', () => { publishCurrentToFeed(); });

document.getElementById('publishBtn')?.addEventListener('click',openPublish);document.getElementById('closePublishBtn')?.addEventListener('click',closePublish);document.getElementById('publishModal')?.addEventListener('click',e=>{if(e.target.id==='publishModal')closePublish()});/* shareToFeed bound in share pipeline */
    document.getElementById('copyPublish')?.addEventListener('click',async()=>{const preview=document.getElementById('publishPreview');const text=preview?.value ?? preview?.textContent ?? '';const ok=await copyText(text);if(ok)closePublish();else toast('Copy failed')});
document.getElementById('exportBtn')?.addEventListener('click',()=>{const data={title:document.getElementById('songTitle').value,artist:state.artistName,lyrics:document.getElementById('lyrics').value,bpm:state.bpm,pattern:state.pattern,chords:state.detectedChords,kit:state.kit};const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=(data.title||'tapehead-session')+'.json';a.click();/* quiet */});
document.getElementById('copyLyricsBtn')?.addEventListener('click',async()=>{const lyrics=document.getElementById('lyrics')?.value||'';if(!lyrics.trim()){toast('No lyrics to copy');return}if(!(await copyText(lyrics)))toast('Copy failed')});

    // Auth UI
    document.querySelectorAll('.auth-tab').forEach(t => t.addEventListener('click', () => setAuthTab(t.dataset.auth)));
    document.getElementById('closeAuth')?.addEventListener('click', closeAuth);
    document.getElementById('closeAuth2')?.addEventListener('click', closeAuth);
    
document.querySelectorAll('.pw-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const id = btn.getAttribute('data-pw');
    const inp = document.getElementById(id);
    if (!inp) return;
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    btn.textContent = show ? 'Hide' : 'Show';
  });
});
document.getElementById('gotoSignup')?.addEventListener('click', () => setAuthTab('signup'));
document.getElementById('gotoSignin')?.addEventListener('click', () => setAuthTab('signin'));
document.getElementById('doSignIn')?.addEventListener('click', doSignIn);
  document.getElementById('signinPass')?.addEventListener('keydown', e => { if (e.key === 'Enter') doSignIn(); });
  document.getElementById('signupPass')?.addEventListener('keydown', e => { if (e.key === 'Enter') doSignUp(); });

    document.getElementById('doSignUp')?.addEventListener('click', doSignUp);
    document.getElementById('signOutBtn')?.addEventListener('click', signOut);
    document.getElementById('authModal')?.addEventListener('click', e => { if (e.target.id === 'authModal') closeAuth(); });
    document.getElementById('signupAvatarBox')?.addEventListener('change', e => {
      const input = e.target.closest && e.target.closest('#signupAvatar');
      if (!input) return;
      const f = input.files?.[0];
      if (!f) return;
      readAvatarFile(f, data => {
        state._pendingAvatar = data;
        const box = document.getElementById('signupAvatarBox');
        if (box) box.innerHTML = `<img src="${data}" alt=""><input type="file" id="signupAvatar" accept="image/*">`;
      });
    });
    
document.getElementById('feedPostBtn')?.addEventListener('click', function(e) {
  e.preventDefault();
  openPublish();
});
document.getElementById('confirmPublishBtn')?.addEventListener('click', function(e) {
  e.preventDefault();
  publishCurrentToFeed();
});
document.getElementById('refreshFeed')?.addEventListener('click', () => { renderCommunityFeed(); /* quiet */; });
    // Publish to community when publishing

    /* AI buttons bound in bindWriteProUI */
document.getElementById('humBtn')?.addEventListener('click',()=>{if(state.recording)stopHumRecording();else startHumRecording()});
document.getElementById('inversionRow')?.addEventListener('click',e=>{const chip=e.target.closest('[data-inv]');if(!chip)return;applyInversion(Number(chip.dataset.inv));});
function updateBeatPadHint(){
  const el=document.getElementById('beatPadHint');
  if(el)el.textContent='Tap: off → soft → normal → accent · 1/4 beat markers';
  const n=state.stepCount||16;
  const count=document.getElementById('beatHitCount');
  if(count){let hits=0,acc=0;['kick','snare','hat','clap'].forEach(k=>(state.pattern[k]||[]).slice(0,n).forEach(v=>{if(v){hits++;if(v>=.99)acc++;}}));count.textContent=hits+' hits · '+acc+' accents';}
}
window.updateBeatPadHint=updateBeatPadHint;
function beatTapTempo(){
  const now=performance.now();state._tapTempoTimes=(state._tapTempoTimes||[]).filter(t=>now-t<2200);state._tapTempoTimes.push(now);
  if(state._tapTempoTimes.length>=2){const a=state._tapTempoTimes.slice(-6),g=[];for(let i=1;i<a.length;i++)g.push(a[i]-a[i-1]);const avg=g.reduce((x,y)=>x+y,0)/g.length;const bpm=Math.max(60,Math.min(200,Math.round(60000/avg)));state.bpm=bpm;const b=document.getElementById('bpmBadge');if(b)b.textContent=bpm+' BPM';const hb=document.getElementById('beatBpmValue');if(hb)hb.textContent=bpm;const sb=document.getElementById('songBpmNote');if(sb)sb.value=bpm;try{saveCurrentSong()}catch(e){}}
  const tap=document.getElementById('beatTapTempo');if(tap){tap.classList.add('on');setTimeout(()=>tap.classList.remove('on'),120)}
}
function setBeatBpm(delta){const n=Math.max(60,Math.min(200,(Number(state.bpm)||120)+delta));state.bpm=n;const b=document.getElementById('bpmBadge');if(b)b.textContent=n+' BPM';const hb=document.getElementById('beatBpmValue');if(hb)hb.textContent=n;const sb=document.getElementById('songBpmNote');if(sb)sb.value=n;try{saveCurrentSong()}catch(e){}}

document.getElementById('beatTapTempo')?.addEventListener('click',beatTapTempo);
document.getElementById('beatBpmDown')?.addEventListener('click',()=>setBeatBpm(-1));
document.getElementById('beatBpmUp')?.addEventListener('click',()=>setBeatBpm(1));
/* ── Beat undo / redo ──
   History is captured around user gestures inside the Beat view (so every edit path is covered without patching each
   one): the state before the first event of a gesture is compared with the state shortly after the last one.
   If something else replaced the pattern in between (song load, room restore), the stale history is discarded. */
const beatHist = { undo: [], redo: [], last: null, pending: null, timer: null, kind: '', t: 0, max: 60 };
function beatSnap() { return JSON.stringify({ p: state.pattern, n: state.stepCount, s: state.swing || 0, k: state.kit, b: state.bpm }); }
function beatHistRefresh() {
  const u = document.getElementById('beatUndo'), r = document.getElementById('beatRedo');
  if (u) u.disabled = !beatHist.undo.length;
  if (r) r.disabled = !beatHist.redo.length;
}
function beatHistKind(a, b) {
  const x = JSON.parse(a), y = JSON.parse(b), keys = ['p', 'n', 's', 'k', 'b'].filter(k => JSON.stringify(x[k]) !== JSON.stringify(y[k]));
  return keys.length === 1 && (keys[0] === 'b' || keys[0] === 's') ? keys[0] : keys.join('');
}
function beatHistFlush() {
  beatHist.timer = null;
  const before = beatHist.pending; beatHist.pending = null;
  if (before == null) return;
  const after = beatSnap();
  if (beatHist.last != null && before !== beatHist.last) { beatHist.undo = []; beatHist.redo = []; }   // changed behind our back: old history is meaningless
  if (before !== after) {
    const kind = beatHistKind(before, after), now = Date.now();
    const merge = (kind === 'b' || kind === 's') && kind === beatHist.kind && now - beatHist.t < 1000 && beatHist.undo.length;
    if (!merge) { beatHist.undo.push(before); if (beatHist.undo.length > beatHist.max) beatHist.undo.shift(); }
    beatHist.redo = []; beatHist.kind = kind; beatHist.t = now;
  }
  beatHist.last = after;
  beatHistRefresh();
}
function beatHistBegin() {
  if (beatHist.pending == null) beatHist.pending = beatSnap();
  clearTimeout(beatHist.timer); beatHist.timer = setTimeout(beatHistFlush, 120);
}
function applyBeatSnapshot(json) {
  const v = JSON.parse(json);
  state.pattern = v.p; state.stepCount = v.n; state.swing = v.s; state.kit = v.k; if (v.b) state.bpm = v.b;
  ensurePatternLength(state.stepCount);
  buildTracks();
  document.querySelectorAll('#stepLenChips .chip').forEach(c => c.classList.toggle('on', parseInt(c.dataset.steps, 10) === state.stepCount));
  const ss = document.getElementById('swingSlider'); if (ss) ss.value = state.swing || 0;
  const sv = document.getElementById('swingVal'); if (sv) sv.textContent = (state.swing || 0) + '%';
  const gs = document.getElementById('genreSelect'); if (gs && state.kit) gs.value = state.kit;
  const b = document.getElementById('bpmBadge'); if (b) b.textContent = state.bpm + ' BPM';
  const hb = document.getElementById('beatBpmValue'); if (hb) hb.textContent = String(state.bpm);
  const sb = document.getElementById('songBpmNote'); if (sb) sb.value = state.bpm;
  try { window.updateBeatPadHint && window.updateBeatPadHint(); } catch (e) {}
  try { saveCurrentSong(); } catch (e) {}
}
function beatHistStep(dir) {
  beatHistFlush();                                                  // settle any gesture in flight
  const cur = beatSnap();
  if (beatHist.last != null && cur !== beatHist.last) { beatHist.undo = []; beatHist.redo = []; beatHist.last = cur; beatHistRefresh(); return false; }
  const from = dir < 0 ? beatHist.undo : beatHist.redo, to = dir < 0 ? beatHist.redo : beatHist.undo;
  if (!from.length) return false;
  to.push(cur);
  const next = from.pop();
  applyBeatSnapshot(next);
  beatHist.last = beatSnap(); beatHist.kind = ''; beatHistRefresh();
  return true;
}
(function wireBeatHistory() {
  const view = document.getElementById('view-beat'); if (!view) return;
  ['pointerdown', 'pointerup', 'click', 'input', 'change'].forEach(t => view.addEventListener(t, e => {
    if (e.target && e.target.closest && e.target.closest('#beatUndo, #beatRedo')) return;
    beatHistBegin();
  }, true));
  document.getElementById('beatUndo')?.addEventListener('click', () => beatHistStep(-1));
  document.getElementById('beatRedo')?.addEventListener('click', () => beatHistStep(1));
  document.addEventListener('keydown', e => {
    if (view.hidden || !(e.metaKey || e.ctrlKey) || e.altKey) return;
    const t = e.target, tag = t && t.tagName; if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    const k = String(e.key).toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); beatHistStep(-1); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); beatHistStep(1); }
  });
  beatHist.last = beatSnap(); beatHistRefresh();
})();
document.getElementById('groovePresetRow')?.addEventListener('click',e=>{const b=e.target.closest('[data-groove]');if(!b)return;const v=Number(b.dataset.groove)||0;state.swing=v;const ss=document.getElementById('swingSlider');if(ss)ss.value=v;const sv=document.getElementById('swingVal');if(sv)sv.textContent=v+'%';const ps=document.getElementById('proSwing');if(ps)ps.value=v;const pv=document.getElementById('proSwingVal');if(pv)pv.textContent=v+'%';try{saveCurrentSong()}catch(_e){};toast(b.textContent+' groove')});
document.getElementById('swingSlider')?.addEventListener('input', e => {
  state.swing = Number(e.target.value) || 0;
  const lab = document.getElementById('swingVal');
  if (lab) lab.textContent = state.swing + '%';
  try { saveCurrentSong(); } catch (err) {}
});

document.getElementById('pcPlayBtn')?.addEventListener('click', () => {
  try {
    if (state.playing) stopTransport();
    else startTransport();
    updateProjectContext();
  } catch (e) {}
});
document.getElementById('pcShareBtn')?.addEventListener('click', () => {
  try { openPublish(); } catch (e) { openAuth('signin'); }
});
document.getElementById('communityFeed')?.addEventListener('click', e => {
  const btn = e.target.closest('#feedEmptyPost');
  if (btn) { e.preventDefault(); try { openPublish(); } catch (err) { openAuth('signin'); } }
});

document.getElementById('applyChords')?.addEventListener('click',()=>{applyChordProgression(state.detectedChords);toast('Progression sent to Beat + Studio');setView('beat')});
document.getElementById('regenChords')?.addEventListener('click',()=>{const prog=alternativeProgression()||PROGRESSIONS[Math.floor(Math.random()*PROGRESSIONS.length)];state.detectedChords=prog;showChordResult(prog);try{renderProgStrip()}catch(e){}});
document.getElementById('playHumMelody')?.addEventListener('click',()=>{const notes=state._humNotes||[];if(!notes.length){toast('Hum a melody first');return;}unlockAudio();notes.slice(0,16).forEach((n,i)=>setTimeout(()=>{const name=NOTE_NAMES_SHARP[n.pc];playNote(name,3,.38)},i*220));toast('Playing your hummed contour');});
document.getElementById('chordResult')?.addEventListener('click',e=>{const alt=e.target.closest('[data-hum-alt]');if(alt){const alts=humAlternatives(state._humKey);const p=alts[Number(alt.dataset.humAlt)];if(p){state.detectedChords=p;showChordResult(p);renderProgStrip();toast('Alternative progression selected');}return;}const pill=e.target.closest('[data-pchord]');if(pill){unlockAudio();(CHORDS[pill.dataset.pchord]||[]).forEach((n,j)=>setTimeout(()=>playNote(n,3,.5),j*25));}});

    unlockIfAuthed();
    if(!state.user && !state.guest){
      lockApp(true);
      setTimeout(()=>openAuth('signin'), 300);
    }
    document.getElementById('bannerSignIn')?.addEventListener('click', () => openAuth('signin'));
    document.getElementById('bannerSignUp')?.addEventListener('click', () => openAuth('signup'));
    document.getElementById('bannerExplore')?.addEventListener('click', () => { try{ enterGuestMode(); }catch(e){} });
    document.getElementById('guestSignInBtn')?.addEventListener('click', () => openAuth('signin'));
    document.getElementById('closeAuth')?.addEventListener('click', () => { /* already bound; enterGuest via closeAuth */ });

window.addEventListener('keydown',e=>{
      if(e.code==='Escape'){closeAuth();closeProfile();closePaywall();closePublish();return;}
      if(e.target.matches('input, textarea, select'))return;
      if(!state.user && !state.guest)return;
      if(e.code==='Space'){e.preventDefault();if(state.playing)stopTransport();else startTransport()}
    })
  /* Promote nested menu APIs to window (they were defined inside init) */
  try {
    if (typeof openMessages === 'function') window.openMessages = openMessages;
    if (typeof closeMessages === 'function') window.closeMessages = closeMessages;
    if (typeof openHelp === 'function') window.openHelp = openHelp;
    if (typeof closeHelp === 'function') window.closeHelp = closeHelp;
    if (typeof closeSidebar === 'function') window.closeSidebar = closeSidebar;
    if (typeof openSidebar === 'function') window.openSidebar = openSidebar;
    if (typeof openProfile === 'function') window.openProfile = openProfile;
    if (typeof closeProfile === 'function') window.closeProfile = closeProfile;
    if (typeof openPublish === 'function') window.openPublish = openPublish;
    if (typeof closePublish === 'function') window.closePublish = closePublish;
    if (typeof openPaywall === 'function') window.openPaywall = openPaywall;
    if (typeof closePaywall === 'function') window.closePaywall = closePaywall;
    if (typeof bounceMixdown === 'function') window.bounceMixdown = bounceMixdown;
    if (typeof setView === 'function') window.setView = setView;
    if (typeof openAuth === 'function') window.openAuth = openAuth;
    if (typeof toast === 'function') window.toast = toast;
    window.Tapehead = window.Tapehead || {};
    ['openMessages','openHelp','closeSidebar','openProfile','openPublish','openPaywall','closePaywall','bounceMixdown','setView','openAuth'].forEach(function(k){
      if (typeof window[k] === 'function') window.Tapehead[k] = window[k];
    });
  } catch (e) { console.warn('promote', e); }
  try {
    // Bind menu using local closures
    function _bindMenu() {
      if (window.__thMenuBound) return;
      window.__thMenuBound = true;
      function go(id, fn) {
        var el = document.getElementById(id);
        /* These sidebar buttons are owned by the bridge script in index.html
           (el.onclick); binding them here too would fire each action twice. */
        if (!el || el.__th188 || /^(menuProfileBtn|menuMessagesBtn|menuHelpBtn|menuShareBtn|menuBounceBtn|upgradeBtn|sidebarUser)$/.test(id)) return;
        el.__th188 = true;
        el.addEventListener('click', function(e) {
          if (e) { e.preventDefault(); e.stopPropagation(); }
          try { fn(); } catch (err) { console.warn(id, err); }
        });
      }
      go('menuProfileBtn', function(){ try{closeSidebar()}catch(e){}; try{openProfile()}catch(e){console.warn(e)} });
      go('menuMessagesBtn', function(){ try{openMessages()}catch(e){console.warn(e)} });
      go('menuHelpBtn', function(){ try{openHelp()}catch(e){console.warn(e)} });
      go('menuShareBtn', function(){ try{openPublish()}catch(e){console.warn(e)} });
      go('menuBounceBtn', function(){
        try {
          var r = bounceMixdown && bounceMixdown();
          if (!r) setView('mix');
        } catch(e) { try{setView('mix')}catch(x){} }
      });
      go('upgradeBtn', function(){ try{openPaywall('Manage Pro')}catch(e){console.warn(e)} });
      go('avatarBtn', function(){ try{openProfile()}catch(e){} });
      go('sidebarUser', function(){
        try {
          if (state.user) openProfile();
          else openAuth('signin');
        } catch(e) {}
      });
      go('feedPostBtn', function(){ try{openPublish()}catch(e){} });
      go('paywallCloseX', function(){ try{closePaywall()}catch(e){} });
      go('closePaywall', function(){ try{closePaywall()}catch(e){} });

      // Bind sidebar controls directly; don't depend on inline handlers' legacy global `event`.
      var side = document.getElementById('sidebar'), overlay = document.getElementById('overlay'), toggle = document.getElementById('menuToggle');
      var close = function(e) {
        if (e) { e.preventDefault(); e.stopPropagation(); }
        if (typeof closeSidebar === 'function') closeSidebar();
        else { if(side) side.classList.remove('open'); if(overlay) overlay.classList.remove('show'); document.body.classList.remove('menu-open'); if(toggle) toggle.setAttribute('aria-expanded','false'); }
      };
      var closeBtn = document.getElementById('sidebarClose');
      if (closeBtn && !closeBtn.__thCloseBound) { closeBtn.__thCloseBound = true; closeBtn.addEventListener('click', close); }
      if (overlay && !overlay.__thCloseBound) { overlay.__thCloseBound = true; overlay.addEventListener('click', close); }
      if (toggle && !toggle.__thToggleBound) {
        toggle.__thToggleBound = true;
        toggle.addEventListener('click', function(e) {
          e.preventDefault(); e.stopPropagation();
          if (side && side.classList.contains('open')) close();
          else if (typeof openSidebar === 'function') openSidebar();
          else { if(side) side.classList.add('open'); if(overlay) overlay.classList.add('show'); document.body.classList.add('menu-open'); toggle.setAttribute('aria-expanded','true'); }
        });
      }
      var pay = document.getElementById('paywallModal');
      if (pay) {
        pay.addEventListener('click', function(e){ if (e.target === pay) try{closePaywall()}catch(x){} });
      }
      console.log('[Tapehead] menu onclick bound from init');
    }
    _bindMenu();
  } catch (e) { console.warn('bind menu init', e); }

}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (typeof _vocalRec !== 'undefined' && _vocalRec && _vocalRec.state === 'recording') {
      try { setRecStatus('Recording continues only while Tapehead stays active; keep the app open.'); } catch (e) {}
    }
    try {
      if (typeof state !== 'undefined' && state.playing && typeof stopTransport === 'function') stopTransport();
    } catch (e) {}
    try { if (typeof audioCtx !== 'undefined' && audioCtx && audioCtx.state === 'running') audioCtx.suspend(); } catch (e) {}
    try { flushCloudProjectSave(); } catch (e) {}
  } else if (document.visibilityState === 'visible') {
    try { if (typeof unlockAudio === 'function') unlockAudio(); } catch (e) {}
  }
});
try {
  (async function initNativeShell() {
    const Cap = window.Capacitor;
    if (!Cap || typeof Cap.isNativePlatform !== 'function' || !Cap.isNativePlatform()) return;
    document.documentElement.classList.add('is-native');

    // Status bar
    try {
      const StatusBar = Cap.Plugins?.StatusBar;
      if (StatusBar) {
        await StatusBar.setStyle({ style: 'DARK' });
        await StatusBar.setBackgroundColor({ color: '#0A0A0C' });
        try { await StatusBar.setOverlaysWebView({ overlay: false }); } catch (e) {}
      }
    } catch (e) { console.warn('StatusBar', e); }

    // Splash hide after first paint
    try {
      const Splash = Cap.Plugins?.SplashScreen;
      if (Splash) {
        setTimeout(() => { try { Splash.hide(); } catch (e) {} }, 400);
      }
    } catch (e) {}

    const nativeApp = Cap.Plugins?.App;
    if (!nativeApp) return;

    // Background: save + stop transport + suspend audio
    nativeApp.addListener?.('appStateChange', async ({ isActive }) => {
      if (!isActive) {
        try { flushCloudProjectSave(); } catch (e) {}
        try { if (typeof state !== 'undefined' && state.playing && typeof stopTransport === 'function') stopTransport(); } catch (e) {}
        try { if (typeof audioCtx !== 'undefined' && audioCtx && audioCtx.state === 'running') await audioCtx.suspend(); } catch (e) {}
      } else {
        try {
          if (typeof audioCtx !== 'undefined' && audioCtx && audioCtx.state === 'suspended') await audioCtx.resume();
        } catch (e) {}
        try { if (typeof unlockAudio === 'function') unlockAudio(); } catch (e) {}
      }
    });

    // Android hardware back: close overlays first, else move task to background
    nativeApp.addListener?.('backButton', ({ canGoBack }) => {
      const closers = [
        ['paywallModal', typeof closePaywall === 'function' ? closePaywall : null],
        ['authModal', typeof closeAuth === 'function' ? closeAuth : null],
        ['profileModal', typeof closeProfile === 'function' ? closeProfile : null],
        ['messagesModal', typeof closeMessages === 'function' ? closeMessages : null],
        ['helpModal', typeof closeHelp === 'function' ? closeHelp : null],
        ['publishModal', typeof closePublish === 'function' ? closePublish : null],
        ['sidebar', typeof closeSidebar === 'function' ? closeSidebar : null]
      ];
      for (let i = 0; i < closers.length; i++) {
        const el = document.getElementById(closers[i][0]);
        if (el && !el.hidden && getComputedStyle(el).display !== 'none' && !el.classList.contains('hidden')) {
          try { if (closers[i][1]) closers[i][1](); } catch (e) {}
          return;
        }
        // open class pattern
        if (el && (el.classList.contains('open') || el.classList.contains('show'))) {
          try { if (closers[i][1]) closers[i][1](); } catch (e) {}
          return;
        }
      }
      // Studio sub-view → leave studio tools to Write
      try {
        if (typeof state !== 'undefined' && state.view && ['beat','keys','record','mix'].indexOf(state.view) >= 0) {
          setView('write');
          return;
        }
      } catch (e) {}
      try {
        if (nativeApp.minimizeApp) nativeApp.minimizeApp();
        else if (nativeApp.exitApp) { /* don't force-exit */ }
      } catch (e) {}
    });
  })();
} catch (e) { console.warn('native shell', e); }


/* Export menu APIs to window so onclick + menu work */
try {
  window.Tapehead = window.Tapehead || {};
  var _api = {
    openProfile: typeof openProfile === 'function' ? openProfile : null,
    closeProfile: typeof closeProfile === 'function' ? closeProfile : null,
    openMessages: typeof openMessages === 'function' ? openMessages : null,
    closeMessages: typeof closeMessages === 'function' ? closeMessages : null,
    openHelp: typeof openHelp === 'function' ? openHelp : null,
    closeHelp: typeof closeHelp === 'function' ? closeHelp : null,
    openPublish: typeof openPublish === 'function' ? openPublish : null,
    closePublish: typeof closePublish === 'function' ? closePublish : null,
    openPaywall: typeof openPaywall === 'function' ? openPaywall : null,
    closePaywall: typeof closePaywall === 'function' ? closePaywall : null,
    closeSidebar: typeof closeSidebar === 'function' ? closeSidebar : null,
    openSidebar: typeof openSidebar === 'function' ? openSidebar : null,
    bounceMixdown: typeof bounceMixdown === 'function' ? bounceMixdown : null,
    setView: typeof setView === 'function' ? setView : null,
    openAuth: typeof openAuth === 'function' ? openAuth : null,
    processProPayment: typeof processProPayment === 'function' ? processProPayment : null,
    toast: typeof toast === 'function' ? toast : null
  };
  Object.keys(_api).forEach(function(k){
    if (_api[k]) {
      window[k] = _api[k];
      window.Tapehead[k] = _api[k];
    }
  });
  // Menu binder inside IIFE (has closure access even if export fails)
  function bindMenuInside() {
    /* Menu buttons are bound once by _bindMenu() in init; this only adds
       global Escape handling, guarded so repeated calls can't stack listeners. */
    if (window.__thEscBound) return;
    window.__thEscBound = true;
    document.addEventListener('keydown', function(e){
      if (e.key === 'Escape') {
        try { closeSidebar(); } catch(_){}
        try { closePaywall(); } catch(_){}
        try { closeProfile(); } catch(_){}
        try { closeMessages(); } catch(_){}
        try { closeHelp(); } catch(_){}
        try { closePublish(); } catch(_){}
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindMenuInside);
  else bindMenuInside();
  // also after init
  setTimeout(bindMenuInside, 500);
  setTimeout(bindMenuInside, 1500);
} catch (e) { console.warn('export', e); }



/* ── Tapehead v1.10.16 Feature Pass: custom record bed, sync slider, stem downloads, mobile polish ── */
(function(){
  state.externalBed = state.externalBed || null;
  state.recordDelayMs = Number.isFinite(state.recordDelayMs) ? state.recordDelayMs : 0;
  let _externalBedAudio = null;
  let _externalBedObjectUrl = null;


  /* Expanded offline rhyme dictionary: common songwriting families, used when the
     compact original map has no match. It stays local and works without AI/network. */
  const TH_RHYME_FAMILIES = [
    'able stable table label cable fable', 'air care fair share stare prayer', 'ain rain pain gain name flame same', 
    'ake make take break wake shake mistake', 'ame game name frame same flame', 'and hand land band stand grand', 
    'ate late fate gate wait state create', 'ay day way say play stay away', 'ear near clear fear hear year', 
    'ell well tell fell shell smell', 'end bend friend send trend spend', 'ight night light right fight bright sight', 
    'ill still will feel real deal heal', 'ime time rhyme line mine fine climb', 'ing sing bring thing ring swing king', 
    'ive alive drive five survive arrive', 'o go show flow know slow low', 'one done sun run fun one', 
    'ore more door floor before shore', 'ound sound ground found round town down', 'ow now how wow allow somehow', 
    'oy boy joy toy employ destroy', 'ue blue true new you through', 'ump jump pump bump thump', 
    'ust trust must just dust lust', 'ake ache break wake take', 'art heart start part art dark', 
    'ace face place grace space race embrace', 'ook book look took shook hook', 'old cold told bold gold hold', 
    'own own known grown shown thrown', 'ame came same blame frame', 'eed need speed feed lead read', 
  ];
  const TH_RHYME_BANK = TH_RHYME_FAMILIES.flatMap(x=>x.split(/\s+/)).filter(w=>/^[a-z]+$/.test(w));
  function thFamilyRhymes(word){
    word=String(word||'').toLowerCase().replace(/[^a-z']/g,'').replace(/'/g,'');
    if(!word)return[];
    const family=TH_RHYME_FAMILIES.find(f=>f.split(/\s+/).includes(word));
    if(family)return family.split(/\s+/).filter(w=>w!==word).slice(0,8);
    const tail=word.length>=4?word.slice(-3):word.slice(-2);
    return TH_RHYME_BANK.filter(w=>w!==word && w.endsWith(tail)).slice(0,8);
  }
  const _thOriginalRhymeBar=updateRhymeBar;
  updateRhymeBar=function(){
    try{_thOriginalRhymeBar()}catch(e){}
    const ed=document.getElementById('sectionEditor'),chips=document.getElementById('rhymeChips');
    if(!ed||!chips)return;
    const lines=ed.value.split('\n'),last=(lines[lines.length-1]||'').trim();
    const words=last.split(/\s+/).filter(Boolean),word=(words[words.length-1]||'').toLowerCase().replace(/[^a-z']/g,'');
    if(!word)return;
    const hasReal=chips.querySelector('[data-rhyme]');
    if(hasReal)return;
    const more=thFamilyRhymes(word);
    chips.innerHTML=more.length?more.map(r=>`<span class="rhyme-chip" data-rhyme="${r}">${r}</span>`).join(''):'<span class="text-dim">No close rhymes</span>';
  };

  function thDownloadBlob(blob, filename){
    if(!blob)return;
    try{
      const u=URL.createObjectURL(blob), a=document.createElement('a');
      a.href=u; a.download=filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(u),1500);
    }catch(e){ console.warn('[Tapehead] download failed',e); }
  }

  function thOpenExternalBed(file){
    if(!file)return;
    if(!/^audio\//i.test(file.type) && !/\.(mp3|wav|m4a|aac|ogg|webm|flac)$/i.test(file.name||'')){
      toast('Choose an audio file such as MP3 or WAV'); return;
    }
    if(_externalBedAudio){ try{_externalBedAudio.pause();_externalBedAudio.currentTime=0;}catch(e){} }
    if(_externalBedObjectUrl)try{URL.revokeObjectURL(_externalBedObjectUrl)}catch(e){}
    _externalBedObjectUrl=URL.createObjectURL(file);
    _externalBedAudio=new Audio(_externalBedObjectUrl);
    _externalBedAudio.preload='auto';
    _externalBedAudio.loop=false;
    state.externalBed={name:file.name,type:file.type||'audio/*',size:file.size||0,blob:file,url:_externalBedObjectUrl,duration:0};
    _externalBedAudio.onloadedmetadata=function(){
      if(state.externalBed)state.externalBed.duration=_externalBedAudio.duration||0;
      thRenderExternalBed();
    };
    thPersistExternalBed();
    thRenderExternalBed();
    toast('Song loaded — you can record over it');
  }

  function thClearExternalBed(){
    if(_externalBedAudio){try{_externalBedAudio.pause();_externalBedAudio.currentTime=0}catch(e){}}
    _externalBedAudio=null;
    if(_externalBedObjectUrl)try{URL.revokeObjectURL(_externalBedObjectUrl)}catch(e){}
    _externalBedObjectUrl=null;
    state.externalBed=null;
    thDeleteExternalBed();
    thRenderExternalBed();
    toast('Uploaded song removed');
  }

  function thPlayExternalBed(){
    if(!state.externalBed || !_externalBedAudio){toast('Upload a song first');return false;}
    try{
      unlockAudio();
      if(state.playing)try{stopTransport()}catch(e){}
      if(_externalBedAudio.ended)_externalBedAudio.currentTime=0;
      _externalBedAudio.play();
      const b=document.getElementById('recAuditionBedBtn'); if(b)b.textContent='■ Stop song';
      setRecStatus('Uploaded song playing — record when ready');
      _externalBedAudio.onended=function(){
        const x=document.getElementById('recAuditionBedBtn'); if(x)x.textContent='▶ Hear song';
        if(!_vocalRec)setRecStatus('Song finished — press Hear song to replay');
      };
      return true;
    }catch(e){console.warn(e);toast('Could not play uploaded song');return false;}
  }

  function thStopExternalBed(){
    if(_externalBedAudio){try{_externalBedAudio.pause();_externalBedAudio.currentTime=0}catch(e){}}
    const b=document.getElementById('recAuditionBedBtn');if(b)b.textContent=state.externalBed?'▶ Hear song':'▶ Hear beat';
  }

  function thRenderExternalBed(){
    const box=document.getElementById('recBeatBed'), meta=document.getElementById('recBeatBedMeta');
    const upload=document.getElementById('recUploadSong');
    if(upload)upload.value='';
    if(!box||!meta)return;
    if(state.externalBed){
      box.classList.remove('warn');
      const mb=(Number(state.externalBed.size||0)/1048576).toFixed(1);
      const dur=Number(state.externalBed.duration||0);
      const ds=dur?(' · '+Math.floor(dur/60)+':'+String(Math.floor(dur%60)).padStart(2,'0')):'';
      meta.innerHTML='<strong>'+esc(state.externalBed.name||'Uploaded song')+'</strong> · '+mb+' MB'+ds+
        '<br>Your uploaded track is now the record bed. Wear headphones to avoid the mic hearing the playback.';
      const hear=document.getElementById('recAuditionBedBtn');if(hear)hear.textContent='▶ Hear song';
      const clr=document.getElementById('recClearSongBtn');if(clr)clr.hidden=false;
    }else{
      const clr=document.getElementById('recClearSongBtn');if(clr)clr.hidden=true;
      try{updateRecBeatBedUI()}catch(e){}
      const hear=document.getElementById('recAuditionBedBtn');if(hear)hear.textContent='▶ Hear beat';
    }
  }

  function thIdb(){
    return new Promise((resolve,reject)=>{
      if(!window.indexedDB)return reject(new Error('indexeddb'));
      const req=indexedDB.open('tapehead-media',1);
      req.onupgradeneeded=e=>{try{e.target.result.createObjectStore('beds')}catch(err){}};
      req.onsuccess=e=>resolve(e.target.result);
      req.onerror=()=>reject(req.error||new Error('indexeddb'));
    });
  }
  async function thPersistExternalBed(){
    if(!state.currentSongId||!state.externalBed?.blob)return;
    try{
      const db=await thIdb(),tx=db.transaction('beds','readwrite');
      tx.objectStore('beds').put({blob:state.externalBed.blob,name:state.externalBed.name,type:state.externalBed.type,size:state.externalBed.size,duration:state.externalBed.duration||0},state.currentSongId);
    }catch(e){console.warn('[Tapehead] uploaded song storage unavailable',e);}
  }
  async function thDeleteExternalBed(){
    if(!state.currentSongId)return;
    try{const db=await thIdb(),tx=db.transaction('beds','readwrite');tx.objectStore('beds').delete(state.currentSongId)}catch(e){}
  }
  async function thLoadExternalBed(id){
    if(!id)return;
    try{
      const db=await thIdb(),req=db.transaction('beds','readonly').objectStore('beds').get(id);
      req.onsuccess=()=>{
        const rec=req.result;
        if(rec?.blob){
          state.externalBed={...rec,blob:rec.blob};
          if(_externalBedObjectUrl)try{URL.revokeObjectURL(_externalBedObjectUrl)}catch(e){}
          _externalBedObjectUrl=URL.createObjectURL(rec.blob);
          _externalBedAudio=new Audio(_externalBedObjectUrl);
          _externalBedAudio.preload='auto';
          _externalBedAudio.onloadedmetadata=()=>{if(state.externalBed)state.externalBed.duration=_externalBedAudio.duration||state.externalBed.duration||0;thRenderExternalBed()};
          thRenderExternalBed();
        }else thRenderExternalBed();
      };
    }catch(e){thRenderExternalBed();}
  }

  /* Load uploaded backing track alongside the normal project. */
  const _thOriginalLoadSong = loadSong;
  loadSong = function(id){
    _thOriginalLoadSong(id);
    state.externalBed=null;
    thLoadExternalBed(id);
    setTimeout(thRenderExternalBed,80);
  };

  /* A simple, visible record-latency control. Positive values move the take later;
     negative values move it earlier. Existing nudge buttons continue to work. */
  function thSetRecordDelay(v){
    state.recordDelayMs=Math.max(-500,Math.min(500,Number(v)||0));
    try{localStorage.setItem('th-rec-delay',String(state.recordDelayMs))}catch(e){}
    const lab=document.getElementById('recDelayVal');
    if(lab)lab.textContent=(state.recordDelayMs>0?'+':'')+Math.round(state.recordDelayMs)+' ms';
    const sl=document.getElementById('recDelaySlider');if(sl)sl.value=state.recordDelayMs;
    if(state.vocal){
      state.vocal.offsetMs=state.recordDelayMs;
      renderVocalTakes();
      scheduleSave();
    }
  }

  /* ── Mic timing: persistence + automatic calibration ──
     A take's content lags the beat by the round-trip hardware latency (speaker out, mic in, recorder start). The
     calibration plays short chirps through the speaker while recording them through the same microphone path and
     recorder a real take uses, finds how late they arrive (FFT cross-correlation), and stores the negative of that
     as the mic timing for NEW takes. Existing takes are never changed behind the user's back. */
  try { const saved = parseFloat(localStorage.getItem('th-rec-delay')); if (Number.isFinite(saved)) { state.recordDelayMs = Math.max(-500, Math.min(500, saved)); thSetRecordDelayUiOnly(); } } catch (e) {}
  function thSetRecordDelayUiOnly() {
    const lab = document.getElementById('recDelayVal'); if (lab) lab.textContent = (state.recordDelayMs > 0 ? '+' : '') + Math.round(state.recordDelayMs) + ' ms';
    const sl = document.getElementById('recDelaySlider'); if (sl) sl.value = state.recordDelayMs;
  }
  const _calOffsets = [0.6, 1.15, 1.8, 2.4, 3.05, 3.6, 4.3, 4.9];       // irregular spacing: no ambiguity between clicks
  let _cal = null;
  function setCalStatus(text, kind) { const el = document.getElementById('recCalibrateResult'); if (el) { el.textContent = text; el.dataset.state = kind || ''; } }
  async function calibrateMicTiming() {
    const btn = document.getElementById('recCalibrateBtn');
    if (_cal) { _cal.abort = true; return; }                                         // second tap cancels
    if (typeof _vocalRec !== 'undefined' && _vocalRec && _vocalRec.state === 'recording') { setCalStatus('Stop the current recording first.', 'error'); return; }
    if (!window.TapeheadDSP || !window.MediaRecorder) { setCalStatus('Calibration is not supported in this browser.', 'error'); return; }
    try { if (state.playing) stopTransport(); } catch (e) {}
    const run = _cal = { abort: false };
    if (btn) btn.textContent = 'Cancel';
    setCalStatus('Turn the volume up, use the phone speaker (not Bluetooth) and keep quiet for 7 seconds…', 'run');
    let stream = null, rec = null;
    const finish = (text, kind) => { try { stream && stream.getTracks().forEach(t => t.stop()); } catch (e) {} try { run.tap && run.tap.disconnect(); } catch (e) {} _cal = null; if (btn) btn.textContent = 'Auto-calibrate'; setCalStatus(text, kind); };
    try {
      const c = ensureAudio(); if (c.state === 'suspended') await c.resume();
      stream = await getMusicMicStream();
      if (run.abort) return finish('Calibration cancelled.', '');
      const mime = chooseVocalMime(), chunks = [];
      // Mirror a real take exactly: the live-waveform tap on the stream and the same recorder options. Any difference in
      // the capture path would make the measured latency wrong for real takes.
      try { const tap = c.createMediaStreamSource(stream), an = c.createAnalyser(); an.fftSize = 256; tap.connect(an); run.tap = tap; } catch (e) {}
      rec = createVocalRecorder(stream, mime);
      rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      const stopped = new Promise(res => { rec.onstop = res; });
      const chirp = TapeheadDSP.makeChirp(c.sampleRate, 30), buf = c.createBuffer(1, chirp.length, c.sampleRate); buf.copyToChannel(chirp, 0);
      // Play through the live mix bus, like the beat: its compressor/limiter lookahead is part of what a singer hears.
      const out = c.createGain(); out.gain.value = 0.9; let dest = c.destination;
      try { dest = (ensureLiveGraph(), liveDest('chords')) || c.destination; } catch (e) {}
      out.connect(dest);
      const t0 = c.currentTime; rec.start(100);                                       // same order as a real take: clock read, then recorder start
      const base = t0 + 0.0;
      _calOffsets.forEach(o => { const src = c.createBufferSource(); src.buffer = buf; src.connect(out); src.start(base + o); });
      const end = Date.now() + (_calOffsets[_calOffsets.length - 1] + 1.3) * 1000;
      while (Date.now() < end && !run.abort) await new Promise(r => setTimeout(r, 100));
      try { rec.stop(); } catch (e) {} await stopped;
      try { out.disconnect(); } catch (e) {}
      if (run.abort) return finish('Calibration cancelled.', '');
      const ab = await new Blob(chunks, { type: mime || 'audio/webm' }).arrayBuffer();
      const decoded = await c.decodeAudioData(ab);
      const r = TapeheadDSP.estimateLatency(decoded.getChannelData(0), decoded.sampleRate, _calOffsets, { maxLatencyMs: 500, preMs: 120 });   // a recorder can include a little pre-roll, so allow slightly early arrivals
      if (!r.ok) {
        const why = r.reason === 'silent' ? "Couldn't hear the test sounds. Turn the volume up, use the phone speaker (not Bluetooth headphones) and try again."
          : r.reason === 'inconsistent' ? "The timing wasn't steady (Bluetooth or a busy phone can cause this). Try again."
          : 'Too noisy or too quiet to measure. Try again somewhere quieter with the volume up.';
        return finish(why, 'error');
      }
      const ms = Math.round(r.latencyMs);
      state.recordDelayMs = Math.max(-500, Math.min(500, -ms));
      try { localStorage.setItem('th-rec-delay', String(state.recordDelayMs)); } catch (e) {}
      thSetRecordDelayUiOnly();
      finish('Measured ' + ms + ' ms mic delay (±' + Math.max(1, Math.round(r.spreadMs / 2)) + ' ms). New takes are placed ' + Math.abs(ms) + ' ms ' + (ms >= 0 ? 'earlier' : 'later') + ' automatically.', 'ok');
    } catch (e) {
      console.warn('calibration', e);
      finish(e && /denied|NotAllowed|Permission/i.test(String(e.name || e.message)) ? 'Microphone access is needed to calibrate.' : 'Calibration failed. Try again.', 'error');
    }
  }
  document.getElementById('recCalibrateBtn')?.addEventListener('click', calibrateMicTiming);

  const _thOriginalNudgeVocal = nudgeVocal;
  nudgeVocal = function(ms){
    _thOriginalNudgeVocal(ms);
    if(state.vocal){ thSetRecordDelay(state.vocal.offsetMs||0); }
  };

  /* Preserve the existing recorder but start uploaded playback instead of the generated beat. */
  const _thOriginalStartVocalRecord = startVocalRecord;
  startVocalRecord = async function(){
    if(!state.externalBed?.blob)return _thOriginalStartVocalRecord();
    try{
      unlockAudio();
      try{await ensureAudio().resume()}catch(e){}
      if(state.playing)try{stopTransport()}catch(e){}
      if(!_externalBedAudio){
        _externalBedObjectUrl=URL.createObjectURL(state.externalBed.blob);
        _externalBedAudio=new Audio(_externalBedObjectUrl);
      }
      _externalBedAudio.currentTime=0;
      _externalBedAudio.loop=false;
      const inputStream=await getMusicMicStream();
      const stream=buildVocalCapture(inputStream);
      _vocalChunks=[];
      const mime=chooseVocalMime();
      _vocalRec=createVocalRecorder(stream,mime);
      const startedAt=performance.now();
      _vocalRec.ondataavailable=e=>{if(e.data.size)_vocalChunks.push(e.data)};
      _vocalRec.onstop=()=>{
        cleanupVocalCapture();
        const blob=new Blob(_vocalChunks,{type:mime||'audio/webm'});
        const url=URL.createObjectURL(blob);
        const sec=document.getElementById('recSection')?.value||'verse';
        const take={
          id:'t_'+Date.now().toString(36),blob,url,section:sec,
          offsetMs:state.recordDelayMs||0,gapMs:0,
          barStart:1,gain:(state.volumes&&state.volumes.vocal)||0.9,reverb:0.2,
          created:Date.now(),bpm:state.bpm,kit:'uploaded',label:'Take '+nextTakeNumber(),
          bedType:'uploaded',bedName:state.externalBed?.name||'Uploaded song'
        };
        state.vocalTakes=state.vocalTakes||[];state.vocalTakes.push(take);
        while(state.vocalTakes.length>6){const old=state.vocalTakes.shift();try{if(old?.url)URL.revokeObjectURL(old.url)}catch(e){}}
        state.vocal=take;renderVocalTakes();buildChannelStrip();saveCurrentSong();
        setRecStatus(take.label+' saved · '+(state.externalBed?.name||'uploaded song')+' · '+(state.recordDelayMs||0)+' ms sync');
        const b=document.getElementById('recAuditionBedBtn');if(b)b.textContent='▶ Hear song';
      };
      _vocalRec.start(100);
      _externalBedAudio.currentTime=0;
      await _externalBedAudio.play();
      document.getElementById('vocalRecBtn')?.classList.add('rec-on');
      setRecStatus('● Clean vocal capture over '+(state.externalBed.name||'uploaded song')+' — sing now');
      startRecWave(stream);
    }catch(e){
      console.warn('[Tapehead] uploaded-track recording',e);
      toast('Mic permission needed');
      setRecStatus('Mic blocked — allow microphone in browser settings');
      try{if(_externalBedAudio)_externalBedAudio.pause()}catch(err){}
    }
  };

  const _thOriginalStopVocalRecord = stopVocalRecord;
  stopVocalRecord = function(){
    if(state.externalBed && _externalBedAudio){
      try{_externalBedAudio.pause()}catch(e){}
      _externalBedAudio=null;
      if(_externalBedObjectUrl)try{URL.revokeObjectURL(_externalBedObjectUrl)}catch(e){}
      _externalBedObjectUrl=null;
      /* Recreate playback object from the stored blob for the next take. */
      if(state.externalBed.blob){
        _externalBedObjectUrl=URL.createObjectURL(state.externalBed.blob);
        _externalBedAudio=new Audio(_externalBedObjectUrl);
        _externalBedAudio.preload='auto';
      }
    }
    return _thOriginalStopVocalRecord();
  };

  /* Preview a vocal take with its alignment offset when the user taps Play. */
  const _thOriginalPlayVocalTake = playVocalTake;
  playVocalTake = function(){
    if(!state.vocal?.url)return _thOriginalPlayVocalTake();
    try{
      if(_vocalAudio){_vocalAudio.pause();_vocalAudio=null}
      _vocalAudio=new Audio(state.vocal.url);
      _vocalAudio.volume=state.volumes.vocal||0.9;
      const delay=Math.max(-500,Math.min(500,Number(state.vocal.offsetMs)||0));
      setTimeout(()=>{try{_vocalAudio.play()}catch(e){}},Math.max(0,delay));
      setRecStatus('Take preview · '+(delay>0?'+':'')+delay+' ms alignment');
    }catch(e){toast('Could not play take')}
  };

  /* Existing stem renderer is already multi-bus. Add direct one-click downloads. */
  async function thDownloadStem(stem){
    const q=document.getElementById('bounceQuality')?.value||'standard';
    const loops=q==='high'?4:q==='draft'?1:2;
    if(stem==='vocal' && !(state.vocal&&state.vocal.blob)){toast('Record a vocal take first');return}
    if(stem==='chords' && !(state.detectedChords&&state.detectedChords.length)){toast('Add chords first');return}
    try{
      setBounceProgress(15,'Rendering '+stem+'…');
      const blob=await bounceFullSong(loops,{stem});
      const title=((document.getElementById('songTitle')?.value)||'tapehead-song').replace(/[^\w\-]+/g,'_');
      thDownloadBlob(blob,title+'_'+(stem==='chords'?'piano':stem)+'.wav');
      setBounceProgress(100,(stem==='chords'?'Piano / keys':stem)+' downloaded');
      setTimeout(hideBounceProgress,1400);
    }catch(e){console.warn(e);hideBounceProgress();toast('Could not export '+stem)}
  }

  function thBindFeatureUI(){
    const up=document.getElementById('recUploadSong');
    if(up&&!up.__thBound){up.__thBound=true;up.addEventListener('change',e=>thOpenExternalBed(e.target.files?.[0]))}
    const clear=document.getElementById('recClearSongBtn');
    if(clear&&!clear.__thBound){clear.__thBound=true;clear.addEventListener('click',thClearExternalBed)}
    const hear=document.getElementById('recAuditionBedBtn');
    if(hear&&!hear.__thBound){hear.__thBound=true;hear.addEventListener('click',e=>{
      e.preventDefault();
      if(state.externalBed) {
        if(_externalBedAudio&&!_externalBedAudio.paused){thStopExternalBed();setRecStatus('Uploaded song stopped')}
        else thPlayExternalBed();
      } else auditionRecordBed();
    })}
    const sl=document.getElementById('recDelaySlider');
    if(sl&&!sl.__thBound){sl.__thBound=true;sl.addEventListener('input',()=>thSetRecordDelay(sl.value));}
    ['thStemDrums','thStemPiano','thStemVocal','thStemFull'].forEach(id=>{
      const el=document.getElementById(id); if(el&&!el.__thBound){el.__thBound=true;el.addEventListener('click',()=>thDownloadStem(id==='thStemDrums'?'drums':id==='thStemPiano'?'chords':id==='thStemVocal'?'vocal':'full'))}
    });
    thRenderExternalBed();
    const dl=document.getElementById('recDelaySlider');if(dl)thSetRecordDelay(state.vocal?.offsetMs??state.recordDelayMs??0);
  }

  /* Rebind once the DOM is ready, and once more after the app's own init. */
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',thBindFeatureUI);
  else thBindFeatureUI();
  setTimeout(thBindFeatureUI,500);
  setTimeout(thBindFeatureUI,1200);

  /* Small mobile-friendly override: make 32-step rows scroll rather than crush into tiny targets. */
  try{
    const st=document.createElement('style');st.id='th-v11015-feature-css';
    st.textContent='.th-mobile-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.th-mobile-row>*{min-width:0}#tracks{overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:6px}#tracks .track{min-width:700px}.th-sync-control{border:1px solid var(--line);border-radius:12px;padding:10px;background:var(--panel2)}.th-sync-control input[type=range]{width:100%}.th-upload-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}@media(max-width:760px){#tracks .track{min-width:650px}.track .t-name{width:92px;font-size:11px}.track .st{min-width:25px;min-height:25px}.track .fader-wrap{width:82px}.beat-tools{display:grid;grid-template-columns:repeat(3,1fr)}.transport{gap:5px;overflow-x:auto;padding-bottom:4px}.transport .chip{flex:0 0 auto}.rec-bed-actions,.rec-stage+.th-mobile-row{display:grid;grid-template-columns:1fr 1fr}.th-mobile-row .btn{width:100%}.th-sync-control{margin-top:8px}.write-actions{display:grid!important;grid-template-columns:1fr 1fr;gap:7px!important}.write-actions>*{width:100%!important}.section-editor{min-height:190px!important}}';
    document.head.appendChild(st);
  }catch(e){}
})();

/* ── Write Studio premium layer: quick sections, hero pills, Writing Coach, Song Compass,
      section tools (duplicate / rename / move / delete), Focus mode and Idea Vault. ── */
function bindWritePremiumUI(){
  if(window.__thWritePremiumBound)return; window.__thWritePremiumBound=true;
  const $=id=>document.getElementById(id);
  const QUICK={intro:'Intro',verse1:'Verse 1',pre:'Pre-Chorus',chorus:'Chorus',bridge:'Bridge',outro:'Outro'};
  const setTxt=(id,t)=>{const el=$(id); if(el&&el.textContent!==t)el.textContent=t;};
  const lastWord=l=>((l.trim().split(/\s+/).pop()||'').toLowerCase().replace(/[^a-z']/g,''));
  function afterEdit(){ try{syncLyricsHidden();}catch(e){} try{showActiveSection();}catch(e){} try{scheduleSave();}catch(e){} refresh(); }

  /* ---- Live stats, hero pills and Song Compass ---- */
  function stats(){
    ensureWriteSections();
    const secs=state.writeSections, act=getActiveSection(), ed=$('sectionEditor'), lines=[]; let words=0, syl=0, filled=0, rhymed=0, rhymeBase=0;
    secs.forEach(sec=>{
      const txt=(ed&&act&&sec.id===act.id)?ed.value:sec.text;   /* read the live editor, never write (no autosave churn) */
      const ls=String(txt||'').split('\n').map(x=>x.trim()).filter(Boolean);
      if(ls.length)filled++;
      ls.forEach(l=>{ lines.push(l); words+=l.split(/\s+/).filter(Boolean).length; try{syl+=lineSyllables(l);}catch(e){} });
      if(ls.length>=2){
        const ends=ls.map(lastWord).filter(w=>w.length>1);
        ends.forEach((w,i)=>{ rhymeBase++; if(ends.some((o,j)=>j!==i&&o.slice(-2)===w.slice(-2)))rhymed++; });
      }
    });
    return {words,lines:lines.length,syl,filled,total:secs.length,rhyme:rhymeBase>=2?Math.round(100*rhymed/rhymeBase)+'%':'—'};
  }
  function refresh(){
    const view=$('view-write'); if(!view||view.offsetParent===null)return;
    const st=stats();
    setTxt('wcWords',String(st.words)); setTxt('wcLines',String(st.lines)); setTxt('wcSyllables',String(st.syl));
    setTxt('wcSections',st.filled+'/'+st.total); setTxt('wcRhyme',st.rhyme);
    const key=($('songKey')||{}).value||'', mood=($('songMood')||{}).value||'', hook=(($('songHook')||{}).value||'').trim();
    const sec=getActiveSection();
    setTxt('writeHeroKey',key.trim()||'—'); setTxt('writeHeroBpm',String(state.bpm||120));
    setTxt('writeHeroMood',mood||'Open'); setTxt('writeHeroSection',sec?sec.label:'—');
    const pct=Math.min(100,Math.round((st.total?70*st.filled/st.total:0)+(hook?20:0)+((key.trim()||mood)?10:0)));
    const bar=$('writeProgressMeter'); if(bar)bar.style.width=pct+'%';
    setTxt('writeProgressText',pct+'% song built');
    const chorus=state.writeSections.find(x=>/chorus/i.test(x.label+' '+x.id)), chorusTxt=chorus?((act0=>act0&&chorus.id===act0.id&&$('sectionEditor')?$('sectionEditor').value:chorus.text)(getActiveSection())):'';
    let t,sub;
    if(!hook){t='Start with the hook';sub='Give the song one memorable idea. Tapehead will help you build the sections around it.';}
    else if(!st.filled){t='Write your first section';sub='Your hook is set. Turn it into a verse, then build outward from there.';}
    else if(chorus&&!String(chorusTxt||'').trim()){t='Build the chorus';sub='Your verse is moving. Give the hook a chorus people can sing back.';}
    else if(st.filled<st.total){t='Fill the remaining sections';sub=(st.total-st.filled)+' section'+(st.total-st.filled===1?'':'s')+' still empty. Finish them or delete what you do not need.';}
    else{t='Ready to record';sub='Every section has words. Head to Beat and Record to bring it to life.';}
    setTxt('writeCompassTitle',t); setTxt('writeCompassText',sub);
  }

  /* ---- Quick section chips ---- */
  $('writeQuickStart')?.addEventListener('click',e=>{
    const b=e.target.closest('[data-quick-section]'); if(!b)return;
    const id=b.getAttribute('data-quick-section'); if(!QUICK[id])return;
    try{commitSectionEditor();}catch(_){}
    ensureWriteSections();
    if(!state.writeSections.some(x=>x.id===id))state.writeSections.push({id,label:QUICK[id],text:''});
    state.writeSectionId=id; afterEdit();
    $('sectionEditor')?.focus({preventScroll:true});
  });

  /* ---- Section tools ---- */
  function idx(){ ensureWriteSections(); const a=getActiveSection(); return state.writeSections.findIndex(x=>x.id===(a&&a.id)); }
  $('duplicateSectionBtn')?.addEventListener('click',()=>{
    try{commitSectionEditor();}catch(_){} const i=idx(); if(i<0)return; const src=state.writeSections[i];
    const copy={id:'sec'+Date.now(),label:String(src.label+' copy').slice(0,24),text:src.text||''};
    state.writeSections.splice(i+1,0,copy); state.writeSectionId=copy.id; afterEdit(); toast('Section duplicated');
  });
  $('renameSectionBtn')?.addEventListener('click',()=>{
    const sec=getActiveSection(); if(!sec)return;
    const v=prompt('Section name',sec.label); if(v===null)return;
    const name=v.replace(/[\r\n\[\]]/g,' ').trim().slice(0,24); if(!name)return;
    sec.label=name; afterEdit();
  });
  function move(d){
    try{commitSectionEditor();}catch(_){} const i=idx(), j=i+d, a=state.writeSections;
    if(i<0||j<0||j>=a.length){toast(d<0?'Already first':'Already last');return;}
    const t=a[i]; a[i]=a[j]; a[j]=t; afterEdit();
  }
  $('moveSectionUpBtn')?.addEventListener('click',()=>move(-1));
  $('moveSectionDownBtn')?.addEventListener('click',()=>move(1));
  $('deleteSectionBtn')?.addEventListener('click',()=>{
    try{commitSectionEditor();}catch(_){} ensureWriteSections();
    if(state.writeSections.length<=1){toast('A song needs at least one section');return;}
    const i=idx(), sec=state.writeSections[i]; if(!sec)return;
    if((sec.text||'').trim()&&!confirm('Delete "'+sec.label+'" and its words?'))return;
    state.writeSections.splice(i,1);
    state.writeSectionId=state.writeSections[Math.min(i,state.writeSections.length-1)].id; afterEdit();
  });

  /* ---- Focus writing ---- */
  function focusMode(on){
    document.body.classList.toggle('write-focus',on);
    const b=$('focusWriteBtn'); if(b)b.textContent=on?'Exit focus':'Focus writing';
    if(on)$('sectionEditor')?.focus({preventScroll:false});
  }
  $('focusWriteBtn')?.addEventListener('click',()=>focusMode(!document.body.classList.contains('write-focus')));
  document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&document.body.classList.contains('write-focus'))focusMode(false); });

  /* ---- Idea Vault (one list per device, so ideas survive project switches and reloads) ---- */
  function ideaKey(){ return 'th_ideas_v1'; }
  function loadIdeas(){ try{const a=JSON.parse(localStorage.getItem(ideaKey())||'[]'); return Array.isArray(a)?a.filter(x=>typeof x==='string'):[];}catch(e){return[];} }
  function saveIdeas(a){ try{localStorage.setItem(ideaKey(),JSON.stringify(a.slice(0,50)));}catch(e){} }
  function renderIdeas(){
    const box=$('ideaList'); if(!box)return; const a=loadIdeas();
    box.innerHTML=a.length?a.map((t,i)=>'<span class="idea-chip" data-idea-use="'+i+'" title="Tap to add to the current section">'+esc(t)+' <b data-idea-del="'+i+'" title="Remove" style="opacity:.6;margin-left:4px">×</b></span>').join(''):'<span class="text-dim" style="font-size:10px">Your saved ideas will appear here.</span>';
  }
  function addIdea(){
    const inp=$('ideaInput'); if(!inp)return; const t=inp.value.replace(/\s+/g,' ').trim().slice(0,160); if(!t)return;
    const a=loadIdeas(); if(!a.includes(t))a.unshift(t); saveIdeas(a); inp.value=''; renderIdeas();
  }
  $('saveIdeaBtn')?.addEventListener('click',addIdea);
  $('ideaInput')?.addEventListener('keydown',e=>{ if(e.key==='Enter'){e.preventDefault();addIdea();} });
  $('ideaList')?.addEventListener('click',e=>{
    const del=e.target.closest('[data-idea-del]');
    if(del){ e.stopPropagation(); const a=loadIdeas(); a.splice(parseInt(del.getAttribute('data-idea-del'),10),1); saveIdeas(a); renderIdeas(); return; }
    const use=e.target.closest('[data-idea-use]'); if(!use)return;
    const text=loadIdeas()[parseInt(use.getAttribute('data-idea-use'),10)]; const ed=$('sectionEditor'); if(!text||!ed)return;
    ed.value=(ed.value&&!/\n$/.test(ed.value)?ed.value+'\n':ed.value)+text;
    try{commitSectionEditor();updateRhymeBar();}catch(_){} refresh(); toast('Idea added');
  });

  /* ---- Keep stats current ---- */
  ['sectionEditor','songKey','songMood','songBpmNote','songHook'].forEach(id=>{ const el=$(id); if(el){el.addEventListener('input',refresh);el.addEventListener('change',refresh);} });
  $('sectionTabs')?.addEventListener('click',()=>setTimeout(refresh,0));
  setInterval(()=>{ if(!document.hidden)refresh(); },1200);
  renderIdeas(); refresh();
}

/* Bridge: later <script> blocks (grid chips, Library, live meters) call these main-scope functions. */
try{Object.assign(window,{bindWritePremiumUI,requirePro,buildTracks,saveCurrentSong,thRes,thSpb,stopTransport,ensurePatternLength,FREE_PROJECT_LIMIT,autoNameProject,makeStableId,persistSongs,renderSongList,canCreateProject,loadSong,scheduleSave,saveSession,updateUserUI,lockApp,updateCloudBadge,updateContinuityBadge,updateProjectContext,NOTE_FREQ,liveDest,syncLiveGraphLevels});}catch(e){console.warn('[Tapehead] bridge',e);}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',function(){try{init()}catch(e){console.error(e)}});else{try{init()}catch(e){console.error(e)}}})();




