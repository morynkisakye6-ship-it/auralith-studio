/**
 * Tapehead Musical Continuity layer v1.11.1 (deep)
 * Persists with each project, locks AI options, tracks section identity & rhyme anchors.
 */
(function () {
  'use strict';

  const SECTION_ORDER = ['intro', 'verse', 'pre', 'chorus', 'bridge', 'outro'];
  const STYLE_SET = new Set([
    'contemporary', 'afrobeats', 'amapiano', 'rnb', 'hiphop', 'gospel', 'pop', 'lofi'
  ]);

  function normalizeSection(name) {
    const s = String(name || '').toLowerCase().replace(/\s+/g, '');
    if (s.includes('intro')) return 'intro';
    if (s.includes('verse')) return 'verse';
    if (s.includes('pre')) return 'pre';
    if (s.includes('chorus') || s.includes('hook')) return 'chorus';
    if (s.includes('bridge')) return 'bridge';
    if (s.includes('outro')) return 'outro';
    return s || 'verse';
  }

  function firstLines(text, n) {
    return String(text || '')
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, n);
  }

  function rhymeTail(line) {
    const w = String(line || '')
      .toLowerCase()
      .replace(/[^a-z\s']/g, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .pop();
    if (!w || w.length < 2) return '';
    return w.slice(-3);
  }

  /** Build continuity snapshot from live state + DOM-ish options. */
  function snapshot(state, extra) {
    const x = extra || {};
    const sections = state?.writeSections || state?.sections || [];
    const list = Array.isArray(sections) ? sections : [];
    const style = String(x.style || state?.style || state?.writeStyle || 'contemporary').toLowerCase();
    return {
      version: 2,
      title: x.title || state?.currentSongTitle || '',
      bpm: Number(x.bpm || state?.bpm) || 120,
      key: x.key || state?.key || state?.writeKey || null,
      mood: x.mood || state?.mood || state?.writeMood || null,
      style: STYLE_SET.has(style) ? style : 'contemporary',
      language: x.language || state?.language || 'English',
      hook: x.hook || null,
      sectionOrder: list.map((s) => normalizeSection(s.id || s.name || s.label || s.title)),
      sectionSummaries: list.map((s) => {
        const text = s.text || s.body || '';
        const lines = firstLines(text, 4);
        return {
          id: s.id,
          type: normalizeSection(s.id || s.name || s.label || s.title),
          lineCount: String(text).split(/\n/).filter((l) => l.trim()).length,
          openers: lines.slice(0, 2),
          rhymeAnchors: lines.map(rhymeTail).filter(Boolean).slice(-3),
          hookish: /chorus|hook/i.test(String(s.id || s.name || s.label || ''))
        };
      }),
      locks: {
        bpm: true,
        key: true,
        style: true,
        language: true,
        mood: false,
        hookPhrase: true
      },
      updated: Date.now()
    };
  }

  /** Merge AI options with continuity locks. */
  function applyLocks(options, snap) {
    const o = Object.assign({}, options || {});
    if (!snap) return o;
    if (snap.locks?.bpm && snap.bpm) o.bpm = snap.bpm;
    if (snap.locks?.key && snap.key) o.key = snap.key;
    if (snap.locks?.style && snap.style) o.style = snap.style;
    if (snap.locks?.language && snap.language) o.language = snap.language;
    if (snap.locks?.mood && snap.mood) o.mood = snap.mood;
    else if (!o.mood && snap.mood) o.mood = snap.mood;
    return o;
  }

  /** Extra system brief for the AI from continuity (client sends as options.continuityBrief). */
  function buildBrief(snap, action) {
    if (!snap) return '';
    const parts = [];
    parts.push(`Continuity: stay in ${snap.style || 'contemporary'} style, ${snap.bpm || 120} BPM, key ${snap.key || 'unspecified'}, language ${snap.language || 'English'}.`);
    if (snap.mood) parts.push(`Mood: ${snap.mood}.`);
    if (snap.hook) parts.push(`Existing hook to respect: "${String(snap.hook).slice(0, 120)}".`);
    const chorus = (snap.sectionSummaries || []).find((s) => s.hookish);
    if (chorus && chorus.openers?.length) {
      parts.push(`Chorus already opens with: ${chorus.openers.join(' / ')}. Do not contradict it.`);
    }
    const anchors = (snap.sectionSummaries || [])
      .flatMap((s) => s.rhymeAnchors || [])
      .filter(Boolean)
      .slice(-6);
    if (anchors.length && action !== 'full_song') {
      parts.push(`Recent rhyme colours (soft constraint): ${[...new Set(anchors)].join(', ')}.`);
    }
    if (action === 'next_section') {
      parts.push(`Next section should advance the story; avoid paraphrasing the previous section.`);
    }
    if (action === 'polish') {
      parts.push(`Polish only: keep meaning and strongest images; improve cadence and specificity.`);
    }
    return parts.join(' ');
  }

  function suggestNextSection(snap) {
    const order = snap?.sectionOrder || [];
    const last = order[order.length - 1];
    const idx = SECTION_ORDER.indexOf(last);
    if (idx >= 0 && idx < SECTION_ORDER.length - 1) return SECTION_ORDER[idx + 1];
    if (!order.length) return 'verse';
    if (last === 'verse') return 'pre';
    if (last === 'chorus') return 'verse';
    return 'bridge';
  }

  /** Attach continuity blob onto a song object before persist. */
  function attachToSong(song, state, extra) {
    if (!song || typeof song !== 'object') return song;
    const snap = snapshot(state, Object.assign({}, extra || {}, {
      title: song.title,
      bpm: song.bpm || state?.bpm,
      key: song.key,
      mood: song.mood,
      hook: song.hook
    }));
    song.continuity = snap;
    return song;
  }

  /** Restore continuity-related UI/state fields from a saved song. */
  function restoreFromSong(song, state) {
    if (!song || !state) return null;
    const c = song.continuity;
    if (c && typeof c === 'object') {
      if (c.bpm) state.bpm = c.bpm;
      state.writeStyle = c.style || state.writeStyle;
      state.writeKey = c.key || song.key || state.writeKey;
      state.writeMood = c.mood || song.mood || state.writeMood;
      state.language = c.language || state.language;
      return c;
    }
    // Bootstrap from song fields when older projects have no continuity blob
    return snapshot(state, {
      title: song.title,
      bpm: song.bpm,
      key: song.key,
      mood: song.mood,
      hook: song.hook,
      style: state.writeStyle
    });
  }

  /** Diff helper for UI: did AI drift from locks? */
  function driftReport(snap, options) {
    const issues = [];
    if (!snap || !options) return issues;
    if (snap.locks?.bpm && options.bpm && Number(options.bpm) !== Number(snap.bpm)) {
      issues.push(`bpm ${options.bpm} ≠ locked ${snap.bpm}`);
    }
    if (snap.locks?.style && options.style && options.style !== snap.style) {
      issues.push(`style ${options.style} ≠ locked ${snap.style}`);
    }
    if (snap.locks?.key && options.key && snap.key && options.key !== snap.key) {
      issues.push(`key ${options.key} ≠ locked ${snap.key}`);
    }
    return issues;
  }

  window.TapeheadContinuity = {
    version: 2,
    SECTION_ORDER,
    normalizeSection,
    snapshot,
    applyLocks,
    buildBrief,
    suggestNextSection,
    attachToSong,
    restoreFromSong,
    driftReport
  };
})();
