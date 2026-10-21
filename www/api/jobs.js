/**
 * Auralith durable jobs API
 * POST   — create job { kind, payload }
 * GET    — ?id=uuid status
 * DELETE — ?id=uuid cancel
 * POST process — claim + run one ai_generate job (internal / cron)
 */
import { getBearerUser, getEntitlement } from './_pro.js';
import { rateLimit, clean, aiLimitForPlan } from './security.js';
import {
  createJob, getJob, claimJob, completeJob, failJob, cancelJob,
  publicJob, JOB_KINDS, JOB_PRIORITIES
} from './_jobs.js';

function json(res, status, body) {
  res.status(status).json(body);
}

async function handleCreate(req, res) {
  const ip = await rateLimit(req, { name: 'jobs-create', limit: 30, windowMs: 60_000 });
  if (!ip.ok) {
    res.setHeader('Retry-After', String(ip.retryAfter || 60));
    return json(res, 429, { error: 'Too many requests.' });
  }

  const user = await getBearerUser(req);
  if (!user?.id) return json(res, 401, { error: 'Sign in required.' });

  const body = typeof req.body === 'object' && req.body ? req.body : {};
  const kind = String(body.kind || '');
  if (!JOB_KINDS.has(kind)) return json(res, 400, { error: 'Unsupported job kind.' });

  // AI jobs require Pro
  if (kind === 'ai_generate') {
    const ent = await getEntitlement(user.id);
    if (!ent) return json(res, 403, { error: 'Pro or an active trial is required.' });
  }

  const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
  // Cap payload size roughly
  const raw = JSON.stringify(payload);
  if (raw.length > 80_000) return json(res, 413, { error: 'Payload too large.' });

  const job = await createJob({
    userId: user.id,
    kind,
    payload,
    priority: body.priority ?? JOB_PRIORITIES[kind]
  });

  return json(res, 201, { job: publicJob(job) });
}

async function handleStatus(req, res) {
  const user = await getBearerUser(req);
  if (!user?.id) return json(res, 401, { error: 'Sign in required.' });
  const id = clean(req.query?.id || '', 80);
  if (!id) return json(res, 400, { error: 'id required.' });
  const job = await getJob(id, user.id);
  if (!job) return json(res, 404, { error: 'Job not found.' });
  return json(res, 200, { job: publicJob(job) });
}

async function handleCancel(req, res) {
  const user = await getBearerUser(req);
  if (!user?.id) return json(res, 401, { error: 'Sign in required.' });
  const id = clean(req.query?.id || (req.body && req.body.id) || '', 80);
  if (!id) return json(res, 400, { error: 'id required.' });
  const job = await cancelJob(id, user.id);
  if (!job) return json(res, 404, { error: 'Job not found or not cancelable.' });
  return json(res, 200, { job: publicJob(job) });
}

/** Process one claimed AI job inline (Vercel-friendly worker entry). */
async function handleProcess(req, res) {
  // Protect with CRON secret or service path
  const secret = String(process.env.JOBS_PROCESS_SECRET || process.env.CRON_SECRET || '');
  // Fail closed: never expose the worker if deployment forgot its shared secret.
  if (!secret) {
    console.error('jobs process disabled: JOBS_PROCESS_SECRET or CRON_SECRET is not configured');
    return json(res, 503, { error: 'Job processing is not configured.' });
  }
  const auth = String(req.headers.authorization || '');
  const provided = auth.startsWith('Bearer ')
    ? auth.slice(7).trim()
    : String(req.headers['x-jobs-secret'] || '').trim();
  if (!provided || provided.length !== secret.length || provided !== secret) {
    return json(res, 401, { error: 'Unauthorized.' });
  }

  const workerId = `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const job = await claimJob(workerId, ['ai_generate']);
  if (!job) return json(res, 200, { processed: false, message: 'No queued jobs.' });

  try {
    if (job.kind === 'ai_generate') {
      const result = await runAiGenerateJob(job);
      await completeJob(job.id, result);
      return json(res, 200, { processed: true, jobId: job.id, status: 'succeeded' });
    }
    await failJob(job.id, `No processor for kind ${job.kind}`);
    return json(res, 200, { processed: true, jobId: job.id, status: 'failed' });
  } catch (e) {
    console.error('job process', e);
    try { await failJob(job.id, e.message || 'process error'); } catch (_) {}
    return json(res, 500, { processed: true, jobId: job.id, status: 'failed', error: 'Processing failed.' });
  }
}

async function runAiGenerateJob(job) {
  const payload = job.payload || {};
  const action = String(payload.action || 'full_song');
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  // Dynamic import to reuse instructions from ai route would couple too tight;
  // minimal full_song-style call for job processor.
  const model = process.env.OPENAI_MODEL || 'gpt-5.6-sol';
  const userInput = [
    `User idea/prompt:\n${String(payload.prompt || '').slice(0, 1600) || '(use context)'}`,
    `Current section: ${String(payload.section || '').slice(0, 100)}`,
    `Current section text:\n${String(payload.context || '').slice(0, 7000) || '(empty)'}`,
    `Existing hook:\n${String(payload.hook || '').slice(0, 300) || '(none)'}`,
    `Existing song context:\n${String(payload.lyrics || '').slice(0, 12000) || '(none)'}`
  ].join('\n\n');

  const opts = payload.options && typeof payload.options === 'object' ? payload.options : {};
  const brief = String(opts.continuityBrief || '').slice(0, 1200);
  const style = String(opts.style || 'contemporary').slice(0, 40);
  const language = String(opts.language || 'English').slice(0, 80);
  const mood = String(opts.mood || '').slice(0, 80);
  const key = String(opts.key || '').slice(0, 20);
  const bpm = Number(opts.bpm) || 120;
  const system = `You are Auralith Pro's premium songwriting assistant. Write original lyrics only.
Style: ${style}. Language: ${language}. Mood: ${mood || 'unspecified'}. Key: ${key || 'unspecified'}. ${bpm} BPM.
${brief ? brief + '\n' : ''}Return ONLY usable lyric text. For full_song use labels [Intro] [Verse 1] [Chorus] [Verse 2] [Bridge] [Outro].`;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: system }] },
        { role: 'user', content: [{ type: 'input_text', text: userInput }] }
      ],
      max_output_tokens: action === 'full_song' ? 2600 : 1400
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || 'Upstream AI failed');

  let text = '';
  if (typeof data?.output_text === 'string') text = data.output_text.trim();
  else {
    for (const item of data?.output || []) {
      for (const c of item?.content || []) {
        if (typeof c?.text === 'string') text += c.text;
      }
    }
    text = text.trim();
  }
  if (!text) throw new Error('Empty AI response');
  return { text, model, action };
}

export default async function handler(req, res) {
  try {
    if (req.method === 'POST' && (req.query?.op === 'process' || req.body?.op === 'process')) {
      return await handleProcess(req, res);
    }
    if (req.method === 'POST') return await handleCreate(req, res);
    if (req.method === 'GET') return await handleStatus(req, res);
    if (req.method === 'DELETE') return await handleCancel(req, res);
    return json(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    console.error('jobs api', e);
    return json(res, 500, { error: 'Jobs service temporarily unavailable.' });
  }
}
