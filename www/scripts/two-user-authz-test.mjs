// Two-account authorization test for the private `vocals` bucket.
// RUN ONLY AGAINST A STAGING/PREVIEW SUPABASE PROJECT, never production.
//
//   npm i @supabase/supabase-js
//   STAGING_SUPABASE_REF=<staging project ref> SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=... \
//   USER_A_EMAIL=... USER_A_PASSWORD=... USER_B_EMAIL=... USER_B_PASSWORD=... \
//   USER_C_EMAIL=... USER_C_PASSWORD=...   (C = signed in but NOT in A's room; optional)
//   node scripts/two-user-authz-test.mjs
//
// A creates a room and uploads a vocal. B joins A's room (legit collaborator).
// C is an outsider. Every "must fail" case is asserted.
import { createClient } from '@supabase/supabase-js';

// Safety: refuse to run (these scripts create and delete rows) unless the target is the project you named as staging.
// Set STAGING_SUPABASE_REF to the staging project's reference id (the xxxx in https://xxxx.supabase.co).
{
  const ref = String(process.env.STAGING_SUPABASE_REF || '').trim();
  const host = (() => { try { return new globalThis.URL(process.env.SUPABASE_URL || '').hostname; } catch { return ''; } })();
  if (!/^[a-z0-9]{15,30}$/.test(ref)) { console.error('Refusing to run: set STAGING_SUPABASE_REF to your STAGING project ref (e.g. abcdefghijklmnopqrst).'); process.exit(2); }
  if (host !== `${ref}.supabase.co`) { console.error(`Refusing to run: SUPABASE_URL host "${host}" is not ${ref}.supabase.co. Wrong project?`); process.exit(2); }
}

const env = n => { const v = process.env[n]; if (!v) { console.error('Missing env ' + n); process.exit(2); } return v; };
const URL = env('SUPABASE_URL'), KEY = env('SUPABASE_ANON_KEY');
const login = async (e, p) => {
  const sb = createClient(URL, KEY, { auth: { persistSession: false } });
  const { data, error } = await sb.auth.signInWithPassword({ email: e, password: p });
  if (error) throw new Error('login failed for ' + e + ': ' + error.message);
  return { sb, id: data.user.id };
};

let failed = 0;
const check = (name, ok, detail = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + detail)); if (!ok) failed++; };
const blob = () => new Blob([new Uint8Array(2048)], { type: 'audio/wav' });

const A = await login(env('USER_A_EMAIL'), env('USER_A_PASSWORD'));
const B = await login(env('USER_B_EMAIL'), env('USER_B_PASSWORD'));
const C = process.env.USER_C_EMAIL ? await login(env('USER_C_EMAIL'), env('USER_C_PASSWORD')) : null;

const room = 'AUTHZ' + Date.now().toString(36).toUpperCase();
const pathA = `${A.id}/${room}_${Date.now()}_take.wav`;
const cleanup = [];

try {
  // Setup: A creates + joins room, uploads vocal, records metadata.
  let r = await A.sb.from('rooms').insert({ code: room, host_id: A.id, title: 'authz', bpm: 90, kit: 'x', pattern: {}, sections: [] });
  check('A can create room', !r.error, r.error?.message);
  r = await A.sb.rpc('join_room', { p_room_code: room });
  check('A joins own room', !r.error, r.error?.message);

  r = await A.sb.storage.from('vocals').upload(pathA, blob(), { upsert: false });
  check('A uploads to own folder', !r.error, r.error?.message);
  cleanup.push(pathA);
  r = await A.sb.from('room_vocals').insert({ room_code: room, user_id: A.id, username: 'A', file_path: pathA, file_url: 'x' });
  check('A inserts own vocal metadata', !r.error, r.error?.message);

  // Overwrite / duplicate
  r = await A.sb.storage.from('vocals').upload(pathA, blob(), { upsert: false });
  check('A cannot overwrite existing object (no upsert)', !!r.error);
  r = await A.sb.storage.from('vocals').upload(pathA, blob(), { upsert: true });
  check('A cannot overwrite via upsert (no UPDATE policy)', !!r.error);

  // Cross-user write into A's folder
  r = await B.sb.storage.from('vocals').upload(`${A.id}/${room}_evil.wav`, blob(), { upsert: false });
  check("B cannot upload into A's folder", !!r.error);
  r = await B.sb.storage.from('vocals').upload(pathA, blob(), { upsert: true });
  check("B cannot overwrite A's object", !!r.error);

  // Cross-user delete
  r = await B.sb.storage.from('vocals').remove([pathA]);
  const stillThere = await A.sb.storage.from('vocals').createSignedUrl(pathA, 60);
  check("B cannot delete A's object", !!stillThere.data?.signedUrl && !(r.data || []).length, JSON.stringify(r));

  // Metadata spoofing
  r = await B.sb.from('room_vocals').insert({ room_code: room, user_id: A.id, username: 'spoof', file_path: pathA, file_url: 'x' });
  check('B cannot insert metadata as A', !!r.error);
  r = await B.sb.from('room_vocals').insert({ room_code: room, user_id: B.id, username: 'B', file_path: `${A.id}/x.wav`, file_url: 'x' });
  check("B cannot register a path inside A's folder", !!r.error);
  r = await B.sb.from('room_vocals').delete().eq('room_code', room).eq('user_id', A.id).select();
  check("B cannot delete A's metadata", !r.error && (r.data || []).length === 0);

  // Reads before B is a member
  r = await B.sb.from('room_vocals').select('*').eq('room_code', room);
  check('non-member B sees no room_vocals', !r.error && (r.data || []).length === 0);
  r = await B.sb.storage.from('vocals').createSignedUrl(pathA, 60);
  check('non-member B cannot sign A\'s object', !!r.error || !r.data?.signedUrl);

  // Legit collaborator
  r = await B.sb.rpc('join_room', { p_room_code: room });
  check('B joins room', !r.error, r.error?.message);
  r = await B.sb.from('room_vocals').select('*').eq('room_code', room);
  check('member B sees room_vocals', !r.error && (r.data || []).length === 1);
  r = await B.sb.storage.from('vocals').createSignedUrl(pathA, 60);
  check('member B can sign A\'s room vocal', !!r.data?.signedUrl, r.error?.message);
  if (r.data?.signedUrl) { const f = await fetch(r.data.signedUrl); check('member B can download via signed URL', f.ok); }
  // Member still cannot touch it
  r = await B.sb.storage.from('vocals').remove([pathA]);
  const again = await A.sb.storage.from('vocals').createSignedUrl(pathA, 60);
  check('member B still cannot delete A\'s object', !!again.data?.signedUrl);

  // Outsider
  if (C) {
    r = await C.sb.from('room_vocals').select('*').eq('room_code', room);
    check('outsider C sees no room_vocals', !r.error && (r.data || []).length === 0);
    r = await C.sb.storage.from('vocals').createSignedUrl(pathA, 60);
    check('outsider C cannot sign A\'s object', !!r.error || !r.data?.signedUrl);
    r = await C.sb.storage.from('vocals').download(pathA);
    check('outsider C cannot download A\'s object', !!r.error);
  }

  // Anonymous
  const anon = createClient(URL, KEY, { auth: { persistSession: false } });
  r = await anon.storage.from('vocals').download(pathA);
  check('anonymous cannot download', !!r.error);
  const pub = await fetch(`${URL}/storage/v1/object/public/vocals/${pathA}`);
  check('bucket is not public', !pub.ok, 'HTTP ' + pub.status);

  // Server-side limits
  r = await A.sb.storage.from('vocals').upload(`${A.id}/${room}_bad.txt`, new Blob(['x'], { type: 'text/plain' }));
  check('server rejects non-audio MIME', !!r.error);
} finally {
  await A.sb.from('room_vocals').delete().eq('room_code', room);
  await A.sb.storage.from('vocals').remove(cleanup);
  await A.sb.from('room_members').delete().eq('room_code', room).eq('user_id', A.id);
  await B.sb.from('room_members').delete().eq('room_code', room).eq('user_id', B.id);
  await A.sb.from('rooms').delete().eq('code', room);
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
