// Auralith Pro — hardened server-side AI route (v1.11 maturity).
// Never put OPENAI_API_KEY in the browser.
import { getBearerUser, getEntitlement, sbBase, sbHeaders } from './_pro.js';
import { rateLimit, clean, aiLimitForPlan, ALLOWED_AI_ACTIONS } from './security.js';
import { createJob, publicJob } from './_jobs.js';

const STYLE_NOTES = {
  contemporary: "current, natural songwriting with a strong conversational voice",
  afrobeats: "melodic Afro-pop/Afrobeats phrasing, rhythmic pockets, vivid everyday imagery",
  amapiano: "danceable South African/African pop phrasing, short memorable lines and groove-aware cadence",
  rnb: "smooth R&B/soul phrasing, intimate imagery, internal rhyme and melodic space",
  hiphop: "hip-hop/trap writing with punchy bars, internal rhyme, attitude and precise imagery",
  gospel: "uplifting gospel writing with sincere faith language, hope and communal singability",
  pop: "highly memorable pop writing, clean phrasing, emotional clarity and a strong hook",
  lofi: "intimate lo-fi writing, understated imagery, reflective tone and conversational detail"
};

function json(res, status, body) {
  res.status(status).json(body);
}

function extractText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  const out = Array.isArray(data?.output) ? data.output : [];
  const parts = [];
  for (const item of out) {
    for (const c of (item?.content || [])) {
      if (typeof c?.text === "string") parts.push(c.text);
    }
  }
  return parts.join("\n").trim();
}

/** Atomically reserve one hourly AI allowance through a database RPC.
 * Fail closed if the migration/RPC is not installed; no unsafe count-then-insert fallback.
 */
async function reserveUsage(userId, limit) {
  const base = sbBase();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return { ok: false, configured: false };
  const r = await fetch(`${base}/rest/v1/rpc/reserve_ai_usage`, {
    method: 'POST',
    headers: sbHeaders(),
    body: JSON.stringify({ p_user_id: userId, p_limit: limit })
  });
  if (!r.ok) {
    // Missing RPC/schema must stop AI use rather than silently reverting to a race-prone check.
    if (r.status === 404 || r.status === 400 || r.status === 401 || r.status === 403) {
      return { ok: false, configured: false };
    }
    throw new Error('Atomic AI quota reservation failed');
  }
  const result = await r.json();
  return { ok: result === true || result?.allowed === true, configured: true };
}

function buildInstructions(action, options) {
  const style = STYLE_NOTES[options.style] || STYLE_NOTES.contemporary;
  const language = clean(options.language || "English", 80);
  const mood = clean(options.mood || "unspecified", 80);
  const key = clean(options.key || "unspecified", 20);
  const bpm = Number(options.bpm) || 120;
  const length = Math.min(12, Math.max(4, Number(options.length) || 8));
  const continuityBrief = clean(options.continuityBrief || "", 1200);

  const base = `You are Auralith Pro's premium songwriting assistant.
Write original lyrics only. Do not imitate or reproduce a living artist's distinctive style, copyrighted lyrics, or recognizable lines.
Style: ${style}.
Language: ${language}.
Mood: ${mood}.
Musical context: key ${key}, ${bpm} BPM.
${continuityBrief ? continuityBrief + "\n" : ""}Prioritize specificity, emotional truth, singability, fresh imagery, varied line lengths, and natural rhyme.
Avoid filler, generic motivational phrases, overused AI metaphors, and forced rhymes.
Return ONLY usable lyric text, with no commentary, labels, quotation marks, or markdown unless the task explicitly requests section labels.`;

  if (action === "finish_verse") {
    return `${base}
Task: Continue the current section as a coherent verse. Preserve the user's voice and story. Add ${length} strong lines. Do not repeat lines already present.`;
  }
  if (action === "next_section") {
    return `${base}
Task: Write the next logical section. Develop the story rather than paraphrasing it. Add ${length} lines.`;
  }
  if (action === "polish") {
    return `${base}
Task: Rewrite the supplied section at a professional songwriting level. Preserve its meaning and strongest original ideas, but improve imagery, cadence, rhyme, emotional specificity and singability. Return the same approximate number of lines.`;
  }
  if (action === "hook") {
    return `${base}
Task: Create a memorable chorus/hook. Produce 4-8 short, highly singable lines with a repeatable central phrase. Keep it original and easy for a crowd to remember.`;
  }
  return `${base}
Task: Create a complete song using these exact section labels:
[Intro]
[Verse 1]
[Chorus]
[Verse 2]
[Bridge]
[Outro]
Write 2-4 lines for Intro and Outro, 6-10 lines for each Verse, 4-8 lines for Chorus and Bridge. Make the chorus the strongest repeated idea. Return only the labeled song.`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "POST required" });

  // Secondary defense: shared IP rate limit (global when Upstash is configured)
  const ipLimit = await rateLimit(req, { name: 'ai-ip', limit: 40, windowMs: 60_000 });
  if (!ipLimit.ok) {
    res.setHeader("Retry-After", String(ipLimit.retryAfter || 60));
    return json(res, 429, { error: "Too many requests. Slow down and try again." });
  }

  try {
    const user = await getBearerUser(req);
    if (!user?.id) return json(res, 401, { error: "Sign in required for Cloud AI." });
    const userLimit = await rateLimit(req, { name: 'ai-user', key: user.id, limit: 20, windowMs: 60_000 });
    if (!userLimit.ok) {
      res.setHeader("Retry-After", String(userLimit.retryAfter || 60));
      return json(res, 429, { error: "Too many requests. Slow down and try again." });
    }

    // Reject obviously invalid bodies early
    const body = typeof req.body === "object" && req.body ? req.body : {};
    const action = String(body.action || "");
    if (!ALLOWED_AI_ACTIONS.has(action)) return json(res, 400, { error: "Unsupported AI action." });

    const prompt = clean(body.prompt, 1600);
    const context = clean(body.context, 7000);
    const lyrics = clean(body.lyrics, 12000);
    const hook = clean(body.hook, 300);
    const section = clean(body.section, 100);
    const options = body.options && typeof body.options === "object" ? body.options : {};

    if (!prompt && action !== "full_song") {
      return json(res, 400, { error: "A prompt or lyric seed is required." });
    }

    // Strict server-side Pro entitlement (shared helper)
    const entitlement = await getEntitlement(user.id);
    if (!entitlement) {
      return json(res, 403, { error: "Pro or an active trial is required for Cloud AI." });
    }

    const limit = aiLimitForPlan(entitlement.plan);
    const usage = await reserveUsage(user.id, limit);
    if (!usage.configured) {
      return json(res, 503, { error: "Cloud AI is not fully configured." });
    }
    if (!usage.ok) {
      res.setHeader("Retry-After", "3600");
      return json(res, 429, {
        error: "AI limit reached for this hour. Try again later.",
        limit,
        plan: entitlement.plan || "pro"
      });
    }

    // Optional async path for long generations (durable job)
    const asyncMode = body.async === true || body.async === '1' || action === 'full_song' && body.async !== false && body.async !== '0' && process.env.AI_ASYNC_FULL_SONG === '1';
    if (asyncMode && action === 'full_song') {
      try {
        const job = await createJob({
          userId: user.id,
          kind: 'ai_generate',
          payload: { action, prompt, context, lyrics, hook, section, options },
          priority: 5
        });
        return json(res, 202, {
          async: true,
          job: publicJob(job),
          message: 'Generation queued. Poll GET /api/jobs?id=' + job.id
        });
      } catch (e) {
        console.warn('async job create failed, falling back to sync', e);
        // fall through to sync
      }
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return json(res, 503, { error: "Cloud AI is temporarily unavailable. Please try again later." });
    }

    const userInput = [
      `User idea/prompt:\n${prompt || "(use the existing song context)"}`,
      `Current section: ${section}`,
      `Current section text:\n${context || "(empty)"}`,
      `Existing hook:\n${hook || "(none)"}`,
      `Existing song context:\n${lyrics || "(none)"}`
    ].join("\n\n");

    const model = process.env.OPENAI_MODEL || "gpt-5.6-sol";
    const payload = {
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: buildInstructions(action, options) }] },
        { role: "user", content: [{ type: "input_text", text: userInput }] }
      ],
      max_output_tokens: action === "full_song" ? 2600 : 1400
    };

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error?.message || "Upstream AI request failed.";
      // Do NOT record usage on upstream failure
      return json(res, response.status >= 500 ? 502 : response.status, { error: message });
    }

    const text = extractText(data);
    if (!text) return json(res, 502, { error: "AI returned an empty response." });

    return json(res, 200, {
      text,
      model,
      usage: { limit, plan: entitlement.plan || "pro" }
    });
  } catch (err) {
    console.error("Auralith AI route error:", err);
    return json(res, 500, { error: "AI service temporarily unavailable." });
  }
}

// Exported for tests
export { reserveUsage, buildInstructions, extractText, aiLimitForPlan, ALLOWED_AI_ACTIONS };
