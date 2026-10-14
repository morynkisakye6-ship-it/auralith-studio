// Two-account Row Level Security test for the app tables.
// RUN ONLY AGAINST A STAGING/PREVIEW SUPABASE PROJECT, never production.
//
//   npm i @supabase/supabase-js
//   STAGING_SUPABASE_REF=<staging project ref> SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=... \
//   USER_A_EMAIL=... USER_A_PASSWORD=... USER_B_EMAIL=... USER_B_PASSWORD=... \
//   node scripts/two-user-rls-test.mjs
//
// A is the "victim/owner", B the "attacker". Each "must fail" case is asserted.
// Note: PostgREST usually returns success with 0 rows (not an error) when RLS filters a
// write, so write checks verify the row is unchanged afterwards.
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
const denied = r => !!r.error || (Array.isArray(r.data) && r.data.length === 0);
const tag = Date.now().toString(36);

const A = await login(env('USER_A_EMAIL'), env('USER_A_PASSWORD'));
const B = await login(env('USER_B_EMAIL'), env('USER_B_PASSWORD'));
const anon = createClient(URL, KEY, { auth: { persistSession: false } });
const postId = 'authz_post_' + tag, projId = 'authz_proj_' + tag, room = 'AUTHZ' + tag.toUpperCase();
let r;

try {
  // ---- profiles
  await A.sb.from('profiles').upsert({ id: A.id, username: 'authzA', contact: 'a@example.test' });
  r = await B.sb.from('profiles').select('id,contact').eq('id', A.id);
  check("B cannot read A's profile row (contact/email)", denied(r), JSON.stringify(r.data));
  r = await anon.from('profiles').select('id,contact').eq('id', A.id);
  check('anonymous cannot read profiles table', denied(r));
  r = await B.sb.from('public_profiles').select('*').eq('id', A.id);
  check('public_profiles is readable', !r.error && r.data.length === 1);
  check('public_profiles does not expose contact', r.data?.[0] && !('contact' in r.data[0]));
  await B.sb.from('profiles').update({ username: 'hijacked' }).eq('id', A.id);
  r = await A.sb.from('profiles').select('username').eq('id', A.id).single();
  check("B cannot rename A's profile", r.data?.username === 'authzA', r.data?.username);
  r = await B.sb.from('profiles').update({ id: A.id }).eq('id', B.id);
  check("B cannot re-point own profile id to A's", !!r.error || denied(r));

  // ---- projects
  r = await A.sb.from('projects').upsert({ id: projId, user_id: A.id, title: 'secret', updated_at: new Date().toISOString() });
  check('A can save own project', !r.error, r.error?.message);
  r = await B.sb.from('projects').select('*').eq('id', projId);
  check("B cannot read A's project", denied(r));
  await B.sb.from('projects').upsert({ id: projId, user_id: B.id, title: 'stolen' });
  r = await A.sb.from('projects').select('title,user_id').eq('id', projId).single();
  check("A's project unchanged after B's upsert", r.data?.title === 'secret' && r.data?.user_id === A.id, JSON.stringify(r.data));
  r = await B.sb.from('projects').insert({ id: projId + '_x', user_id: A.id, title: 'planted' });
  check('B cannot create a project owned by A', !!r.error);
  await B.sb.from('projects').delete().eq('id', projId);
  r = await A.sb.from('projects').select('id').eq('id', projId);
  check("B cannot delete A's project", r.data?.length === 1);

  // ---- feed_posts / likes / comments
  r = await A.sb.from('feed_posts').upsert({ id: postId, user_id: A.id, username: 'authzA', title: 'hello' }, { onConflict: 'id' });
  check('A can publish post', !r.error, r.error?.message);
  await B.sb.from('feed_posts').upsert({ id: postId, user_id: B.id, username: 'evil', title: 'pwn' }, { onConflict: 'id' });
  r = await A.sb.from('feed_posts').select('title,user_id').eq('id', postId).single();
  check("B cannot hijack A's post via upsert", r.data?.title === 'hello' && r.data?.user_id === A.id, JSON.stringify(r.data));
  r = await B.sb.from('feed_posts').insert({ id: postId + '_f', user_id: A.id, username: 'x', title: 'forged' });
  check('B cannot publish a post as A', !!r.error);
  await B.sb.from('feed_posts').delete().eq('id', postId);
  r = await A.sb.from('feed_posts').select('id').eq('id', postId);
  check("B cannot delete A's post", r.data?.length === 1);
  r = await anon.from('feed_posts').select('id').eq('id', postId);
  check('feed is publicly readable', r.data?.length === 1);

  r = await B.sb.from('likes').insert({ post_id: postId, user_id: B.id });
  check('B can like A\'s post', !r.error, r.error?.message);
  r = await B.sb.from('likes').insert({ post_id: postId, user_id: A.id });
  check('B cannot like as A', !!r.error);
  r = await B.sb.from('comments').insert({ post_id: postId, user_id: A.id, username: 'A', body: 'forged' });
  check('B cannot comment as A', !!r.error);
  r = await B.sb.from('comments').insert({ post_id: postId, user_id: B.id, username: 'B', body: 'nice' });
  check('B can comment as self', !r.error, r.error?.message);
  await A.sb.from('comments').delete().eq('post_id', postId);
  r = await A.sb.from('comments').select('id').eq('post_id', postId);
  check("post owner A can delete others' comments on own post", r.data?.length === 0);

  // ---- follows / blocks / reports
  r = await B.sb.from('follows').insert({ follower_id: A.id, following_id: B.id });
  check('B cannot make A follow B', !!r.error);
  r = await B.sb.from('follows').insert({ follower_id: B.id, following_id: A.id });
  check('B can follow A', !r.error, r.error?.message);
  await A.sb.from('follows').delete().eq('follower_id', B.id);
  r = await B.sb.from('follows').select('*').eq('follower_id', B.id);
  check("A cannot remove B's follow", r.data?.length === 1);
  await B.sb.from('follows').delete().eq('follower_id', B.id);

  r = await A.sb.from('blocks').upsert({ blocker_id: A.id, blocked_id: B.id }, { onConflict: 'blocker_id,blocked_id' });
  check('A can block B', !r.error, r.error?.message);
  r = await B.sb.from('blocks').select('*').eq('blocker_id', A.id);
  check("B cannot see A's block list", denied(r));
  r = await B.sb.from('messages').insert({ sender_id: B.id, recipient_id: A.id, body: 'hi' });
  check('blocked B cannot message A', !!r.error);
  await A.sb.from('blocks').delete().eq('blocker_id', A.id).eq('blocked_id', B.id);

  r = await B.sb.from('reports').insert({ reporter_id: B.id, reported_user_id: A.id, reason: 'authz-test' });
  check('B can file a report', !r.error, r.error?.message);
  r = await B.sb.from('reports').select('*');
  check('reports are not readable by users', denied(r));

  // ---- messages
  r = await A.sb.from('messages').insert({ sender_id: A.id, recipient_id: B.id, body: 'authz-private' });
  check('A can message B', !r.error, r.error?.message);
  r = await B.sb.from('messages').insert({ sender_id: A.id, recipient_id: B.id, body: 'forged' });
  check('B cannot send as A', !!r.error);
  r = await B.sb.from('messages').select('body').eq('body', 'authz-private');
  check('recipient B can read message', r.data?.length === 1);
  // third-party check needs a user C; approximated with anonymous
  r = await anon.from('messages').select('*').limit(1);
  check('anonymous cannot read messages', denied(r));
  r = await B.sb.from('messages').update({ body: 'edited' }).eq('sender_id', A.id).select();
  check("B cannot edit A's message", denied(r));
  r = await A.sb.from('messages').delete().eq('sender_id', A.id).select();
  check('users cannot hard-delete messages directly', denied(r));

  // ---- rooms / members / collab chat
  r = await A.sb.from('rooms').insert({ code: room, host_id: A.id, title: 't', bpm: 90, kit: 'trap', pattern: {}, sections: [] });
  check('A creates room', !r.error, r.error?.message);
  r = await B.sb.from('rooms').select('*').eq('code', room);
  check('non-member B cannot read room', denied(r));
  r = await B.sb.from('room_members').insert({ room_code: room, user_id: B.id, username: 'B' });
  check('B cannot insert itself into room_members directly', !!r.error);
  r = await B.sb.from('collab_messages').insert({ room_code: room, user_id: B.id, username: 'B', body: 'let me in' });
  check('non-member B cannot post in room chat', !!r.error);
  r = await A.sb.rpc('join_room_limited', { p_room_code: room });
  check('host joins via join_room', !r.error, r.error?.message);
  r = await B.sb.rpc('join_room_limited', { p_room_code: room });
  check('B joins via join_room (knows code)', !r.error, r.error?.message);
  r = await B.sb.from('rooms').update({ title: 'collab edit' }).eq('code', room).select();
  check('member B can edit room content', !r.error && r.data?.length === 1);
  r = await B.sb.from('rooms').update({ host_id: B.id }).eq('code', room).select();
  check('member B cannot take over host_id', !!r.error || denied(r));
  r = await B.sb.from('rooms').delete().eq('code', room).select();
  check('member B cannot delete room', denied(r));
  r = await B.sb.from('collab_messages').insert({ room_code: room, user_id: A.id, username: 'A', body: 'forged' });
  check('B cannot post room chat as A', !!r.error);
  r = await B.sb.from('collab_messages').insert({ room_code: room, user_id: B.id, username: 'B', body: 'hi' });
  check('member B can post room chat', !r.error, r.error?.message);

  // ---- rate limits (DB-side)
  r = await B.sb.rpc('join_room', { p_room_code: room });
  check('join_room is not directly callable by clients', !!r.error);
  let joinErrs = 0;
  for (let i = 0; i < 14; i++) {
    const j = await B.sb.rpc('join_room_limited', { p_room_code: 'NOPE' + i });
    if (j.error && /rate_limited/.test(j.error.message || '')) joinErrs++;
  }
  check('room-code guessing is throttled (14 bad joins in <1 min)', joinErrs >= 3, 'rate_limited errors: ' + joinErrs);
  let msgBlocked = 0;
  for (let i = 0; i < 36; i++) {
    const m = await B.sb.from('collab_messages').insert({ room_code: room, user_id: B.id, username: 'B', body: 'flood' + i });
    if (m.error && /rate_limited/.test(m.error.message || '')) msgBlocked++;
  }
  check('room chat flood is throttled (36 msgs in <1 min)', msgBlocked >= 1, 'blocked: ' + msgBlocked);

  // ---- server-only tables
  for (const t of ['pro_entitlements', 'pro_transactions', 'tapehead_jobs', 'ai_usage']) {
    r = await B.sb.from(t).select('*').limit(1);
    check(`${t}: client cannot read`, !!r.error || (r.data || []).length === 0);
  }
  r = await B.sb.from('pro_entitlements').insert({ user_id: B.id, plan: 'pro', status: 'active' });
  check('B cannot grant self Pro', !!r.error);
  r = await B.sb.from('pro_entitlements').update({ status: 'active', expires_at: '2099-01-01' }).eq('user_id', B.id).select();
  check('B cannot extend own entitlement', !!r.error || denied(r));
  r = await B.sb.rpc('reserve_ai_usage', { p_user_id: B.id, p_limit: 1000 });
  check('client cannot call reserve_ai_usage', !!r.error);
  r = await B.sb.rpc('claim_pro_trial', { p_user_id: B.id });
  check('client cannot call claim_pro_trial', !!r.error);
} finally {
  await A.sb.from('comments').delete().eq('post_id', postId);
  await A.sb.from('likes').delete().eq('post_id', postId);
  await A.sb.from('feed_posts').delete().eq('id', postId);
  await A.sb.from('projects').delete().eq('id', projId);
  await A.sb.from('collab_messages').delete().eq('room_code', room);
  await B.sb.from('room_members').delete().eq('room_code', room).eq('user_id', B.id);
  await A.sb.from('room_members').delete().eq('room_code', room).eq('user_id', A.id);
  await A.sb.from('rooms').delete().eq('code', room);
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
