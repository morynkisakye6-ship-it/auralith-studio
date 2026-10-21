import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const pro = read('api/_pro.js');
const checkout = read('api/pro-checkout.js');
const jobs = read('api/jobs.js');
const security = read('api/security.js');
const vercel = JSON.parse(read('vercel.json'));

assert.match(pro, /export function publicAppUrl\(\)/, 'canonical URL helper exists');
assert.doesNotMatch(pro.match(/export function publicAppUrl\(\)[\s\S]*?\n\}/)?.[0] || '', /headers\?\.origin|headers\.origin/, 'payment URL must not trust request Origin');
assert.match(pro, /url\.protocol !== 'https:'/,'production public URL requires HTTPS');
assert.match(checkout, /const origin = publicAppUrl\(\)/, 'checkout uses configured canonical URL');
assert.match(jobs, /if \(!secret\)[\s\S]*?return json\(res, 503/, 'job processing fails closed without secret');
assert.match(jobs, /provided\.length !== secret\.length \|\| provided !== secret/, 'job processing validates supplied secret');
assert.match(security, /ipBuckets\.size >= 5000/, 'in-memory limiter bounds its map');
const headers = vercel.headers?.find(x => x.source === '/(.*)')?.headers || [];
for (const key of ['X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'Permissions-Policy']) {
  assert.ok(headers.some(h => h.key === key), `expected security header ${key}`);
}
console.log('Auralith security source checks passed.');
const ai = read('api/ai.js');
const quotaSql = read('supabase/migrations/20261010_atomic_ai_usage.sql');
assert.match(ai, /rpc\/reserve_ai_usage/, 'AI route must use atomic quota reservation');
assert.doesNotMatch(ai, /rpc\/check_ai_usage|rpc\/record_ai_usage/, 'AI route must not use separate check/record calls');
assert.match(ai, /Atomic AI quota reservation failed/, 'quota RPC errors must not silently fall back');
assert.match(quotaSql, /pg_advisory_xact_lock/, 'quota reservation serializes concurrent per-user requests');
assert.match(quotaSql, /grant execute on function public\.reserve_ai_usage\(uuid, integer\) to service_role/i, 'only service role receives RPC execution');
console.log('Atomic quota source checks passed.');

const trial = read('api/pro-trial.js');
const trialSql = read('supabase/migrations/20261010_atomic_pro_trial.sql');
assert.match(trial, /rpc\/claim_pro_trial/, 'trial endpoint must use atomic trial claim');
assert.doesNotMatch(trial, /pro_entitlements\?user_id=.*select=id.*limit=1/, 'trial endpoint must not rely on check-then-insert');
assert.match(trialSql, /user_id uuid primary key/i, 'trial claim must be unique per account');
assert.match(trialSql, /grant execute on function public\.claim_pro_trial\(uuid\) to service_role/i, 'only service role receives trial claim RPC execution');
console.log('Atomic trial source checks passed.');

const pesapal = read('api/_pesapal.js');
const ipn = read('api/pesapal-ipn.js');
const verify = read('api/pro-verify.js');
assert.match(pesapal, /status: 'processing'/, 'payment settlement must claim a processing state before granting Pro');
assert.match(pesapal, /Math\.abs\(paid - expected\) < 0\.005/, 'provider payment amount must exactly match transaction amount');
assert.match(pesapal, /Math\.abs\(expected - configuredAmount\) < 0\.005/, 'stored transaction amount must match configured plan price');
assert.match(pesapal, /pending\.currency[\s\S]*configuredCurrency/, 'stored currency must match configured checkout currency');
assert.match(pesapal, /merchant_reference[\s\S]*txRef/, 'settlement must validate provider merchant reference');
assert.match(pesapal, /current\?\.tx_ref === txRef/, 'settlement recovery must not extend the same payment twice');
assert.match(pesapal, /status=in\.\(pending,failed\)/, 'only eligible payment states may be claimed for settlement');
assert.match(ipn, /settleTransaction\(\{ txRef: merchantRef, orderTrackingId, recheck: true \}\)/, 'IPN must recheck payment status with provider');
assert.match(verify, /pending\.user_id !== user\.id/, 'browser verification must be bound to the signed-in transaction owner');
const checkoutBind = read('api/pro-checkout.js');
assert.match(checkoutBind, /status=eq\.pending/, 'checkout only binds provider IDs to a pending transaction');
assert.match(checkoutBind, /boundRows\.length !== 1/, 'checkout requires exactly one persisted provider tracking ID');
console.log('Pesapal settlement source checks passed.');

assert.match(pesapal, /if \(code === 3\)[\s\S]*?const revoke = await fetch/, 'reversals must revoke matching entitlements');
const reversedBlock = pesapal.match(/if \(code === 3\)[\s\S]*?return \{ state: 'reversed' \};/)?.[0] || '';
assert.ok(reversedBlock.includes('&tx_ref=eq.${encodeURIComponent(txRef)}'), 'reversal must target only the entitlement for that transaction');
assert.doesNotMatch(reversedBlock, /if \(pending\.status === 'successful'\)/, 'reversal must also recover partial settlement while transaction is processing');
console.log('Payment reversal recovery checks passed.');

// Abuse-resistance checks: forwarded-IP spoofing and sensitive endpoint throttles.
assert.match(security, /forwarded\.at\(-1\)/, 'IP limiter must not trust caller-controlled leftmost forwarded value');
const deletion = read('api/delete-account.js');
const trialRoute = read('api/pro-trial.js');
assert.match(deletion, /await rateLimit\(req, \{ name: 'delete-account', limit: 5, windowMs: 60_000 \}\)/, 'account deletion endpoint must be throttled');
assert.match(trialRoute, /await rateLimit\(req, \{ name: 'pro-trial', limit: 15, windowMs: 60_000 \}\)/, 'trial endpoint must be throttled');
for (const key of ['Strict-Transport-Security', 'X-DNS-Prefetch-Control', 'X-Permitted-Cross-Domain-Policies']) {
  assert.ok(headers.some(h => h.key === key), `expected additional security header ${key}`);
}
console.log('Abuse-resistance source checks passed.');

// Account deletion must enumerate nested storage objects and fail closed on
// storage list/delete errors before removing the authenticated user.
assert.match(deletion, /async function listUserObjects/, 'account deletion recursively enumerates user storage');
assert.match(deletion, /offset, sortBy/, 'storage listing must paginate deterministically');
assert.match(deletion, /if \(!r\.ok\) throw new Error\(`Storage listing failed/, 'storage listing errors must stop deletion');
assert.match(deletion, /if \(!r\.ok\) throw new Error\(`Storage deletion failed/, 'storage deletion errors must stop deletion');
assert.ok(deletion.indexOf('await listUserObjects') < deletion.indexOf('/auth/v1/admin/users/'), 'storage cleanup must finish before deleting auth user');
assert.match(deletion, /i \+= 100/, 'storage deletion uses bounded batches');
console.log('Account data deletion safety checks passed.');

// Private audio upload checks: bind the supplied profile to the authenticated
// Supabase user, validate room identifiers, avoid overwrites, and clean up
// newly uploaded objects when later steps fail.
const cloud = read('js/cloud.js');
const uploadBlock = cloud.match(/async uploadVocal\(roomCode, user, file\) \{[\s\S]*?\n  \},/)?.[0] || '';
assert.ok(uploadBlock, 'vocal upload handler exists');
assert.match(uploadBlock, /const authUser = await this\.currentAuthUser\(\)/, 'vocal upload must resolve the authenticated user');
assert.match(uploadBlock, /authUser\.id !== user\.id/, 'vocal upload must reject a mismatched user object');
assert.match(uploadBlock, /\^\[A-Z0-9_\-\]\{3,64\}\$/, 'vocal upload validates the room code');
assert.match(uploadBlock, /upsert: false/, 'vocal uploads must not overwrite existing storage objects');
assert.match(uploadBlock, /storage\.from\('vocals'\)\.remove\(\[path\]\)/, 'vocal upload must attempt orphan cleanup on later failure');
assert.match(uploadBlock, /file\.size > 25 \* 1024 \* 1024/, 'vocal upload enforces the 25MB cap');
console.log('Private audio upload checks passed.');

// Database ownership / RLS source checks (v1.12.10). These verify the migration and client
// contract only; they do not prove the policies are applied in Supabase.
const rls = read('supabase/migrations/20261012_database_ownership_rls.sql');
const audioRls = read('supabase/migrations/20261011_private_audio_rls.sql');
const appSrc = read('app.js');
for (const t of ['profiles','projects','feed_posts','likes','comments','follows','blocks','reports','messages','rooms','room_members','collab_messages','pro_entitlements','pro_transactions','tapehead_jobs','ai_usage']) {
  assert.match(rls, new RegExp(`alter table public\\.${t}\\s+enable row level security`), `RLS enabled on ${t}`);
}
assert.match(rls, /drop policy %I on %I\.%I/, 'legacy permissive policies are removed first');
assert.match(rls, /revoke all on public\.pro_entitlements[\s\S]*from anon, authenticated/, 'billing/entitlement tables are server-only');
assert.match(rls, /create policy messages_insert_sender[\s\S]*sender_id = auth\.uid\(\)/, 'messages insert bound to sender');
assert.match(rls, /rooms_lock_identity/, 'room host/code immutable');
assert.match(rls, /revoke insert, update on public\.room_members/, 'room membership only via join_room');
assert.match(rls, /security_invoker = false[\s\S]*avatar_url, bio, location, genres, links, open_to_collab from public\.profiles/, 'public_profiles omits contact/email');
assert.doesNotMatch(rls, /using \(true\)[\s\S]{0,40}to authenticated;\s*\n\s*create policy (profiles|projects|messages|rooms)/, 'no open policies on private tables');
assert.match(audioRls, /public = false/, 'vocals bucket private');
assert.doesNotMatch(audioRls, /for update/, 'no storage UPDATE policy');
assert.match(cloud, /async saveRoom[\s\S]*?\.from\('rooms'\)\.update\(row\)\.eq\('code', room\.code\)/, 'saveRoom uses update, not upsert');
assert.doesNotMatch(cloud.match(/async saveRoom[\s\S]*?\n  \},/)?.[0] || '', /upsert/, 'saveRoom must not upsert');
assert.match(appSrc, /function genRoomCode\(\)[\s\S]*?crypto\.getRandomValues/, 'room codes use CSPRNG');
console.log('Database ownership / RLS source checks passed.');

// Distributed rate limiting (v1.12.11).
const sec = read('api/security.js');
const dbrl = read('supabase/migrations/20261013_distributed_rate_limits.sql');
assert.match(sec, /export async function rateLimit\(/, 'shared async limiter exists');
assert.match(sec, /UPSTASH_REDIS_REST_URL/, 'limiter supports Upstash');
assert.match(sec, /\['INCR', key\], \['EXPIRE', key[\s\S]*'NX'\]/, 'redis counter sets TTL once per window');
assert.match(sec, /AbortSignal\.timeout/, 'limiter store call has a timeout');
assert.match(sec, /memoryLimit\(bucket/, 'limiter degrades to in-memory on store failure');
for (const f of ['ai','jobs','delete-account','pro-trial','pro-checkout','pro-verify','pesapal-ipn','pro-status']) {
  assert.match(read(`api/${f}.js`), /await rateLimit\(req/, `${f} uses the shared limiter`);
  assert.doesNotMatch(read(`api/${f}.js`), /rateLimitIp\(/, `${f} no longer uses the per-instance limiter`);
}
assert.match(read('api/pro-checkout.js'), /name: 'checkout-user', key: user\.id/, 'checkout has a per-user limit');
assert.match(read('api/ai.js'), /name: 'ai-user', key: user\.id/, 'AI has a per-user burst limit');
assert.match(dbrl, /pg_temp[\s\S]*insert into public\.rate_limits[\s\S]*on conflict \(bucket, window_start\) do update/, 'DB limiter is an atomic upsert counter');
assert.match(dbrl, /revoke all on function public\.rate_limit_hit[\s\S]*authenticated/, 'clients cannot call rate_limit_hit');
for (const t of ['messages','comments','collab_messages','reports','follows','feed_posts','likes','rooms','room_vocals']) {
  assert.match(dbrl, new RegExp(`create trigger rl_${t}\\s+before insert on public\\.${t}`), `DB limit on ${t}`);
}
assert.match(dbrl, /revoke execute on function public\.join_room\(text\) from public, anon, authenticated/, 'join_room only via limited wrapper');
assert.match(dbrl, /exception when others then[\s\S]*return to_jsonb\(false\)/, 'failed joins stay counted');
assert.doesNotMatch(cloud, /rpc\('join_room'/, 'client uses join_room_limited');
console.log('Distributed rate limiting source checks passed.');

// Regression-suite wiring (v1.12.12): the gate must exist and cover the critical paths.
for (const f of ['payments', 'trial-ai', 'delete-jobs', 'client-upload', 'route-throttle']) {
  assert.ok(fs.existsSync(new URL(`../tests/${f}.test.mjs`, import.meta.url)), `tests/${f}.test.mjs exists`);
}
const wf = fs.readFileSync(new URL('../../.github/workflows/security.yml', import.meta.url), 'utf8');
assert.match(wf, /node --test tests\/\*\.test\.mjs/, 'CI runs behavioural tests');
assert.match(wf, /verify-security\.mjs/, 'CI runs source assertions');
assert.match(wf, /two-user-rls-test\.mjs/, 'CI runs live RLS tests on staging');
assert.match(wf, /if: github\.event_name != 'pull_request'/, 'live tests never run with fork-PR secrets');
console.log('Regression-suite wiring checks passed.');

// Mobile QA regressions (v1.12.13): source-level guards for bugs found by the e2e suite.
const appJs = read('app.js'), swJs = read('sw.js'), indexHtml = read('index.html');
for (const fn of ['setBounceProgress', 'hideBounceProgress', 'audioBufferToWavBlob']) {
  assert.match(appJs, new RegExp(`function ${fn}\\(`), `${fn} is defined (bounce/export crashed without it)`);
}
assert.match(appJs, /window\.updateBeatPadHint\s*=\s*updateBeatPadHint/, 'beat hit counter function is reachable from its callers');
assert.match(appJs, /setMemberMeta\(room, \{ present: true \}\);\s*saveActiveRoom\(room, \{ localOnly: true \}\)/, 'rendering must not write rooms to the cloud (realtime feedback loop)');
assert.match(appJs, /!\(opts && opts\.localOnly\)\) Cloud\.saveRoom/, 'localOnly saves skip the cloud');
assert.match(appJs, /Cloud\.leaveRoom\(leavingCode\)/, 'leaving a room revokes server-side membership');
assert.match(cloud, /async leaveRoom\(roomCode\)[\s\S]*room_members'\)\.delete\(\)/, 'cloud leaveRoom deletes the membership row');
assert.match(cloud, /superseded vocal cleanup failed/, 'replaced vocal audio is deleted');
assert.match(cloud, /could not restore previous vocal metadata/, 'failed replace restores the previous vocal');
assert.match(cloud, /replace\(\/\\\.\{2,\}\/g, '\.'\)/, 'upload file names cannot contain ".."');
assert.match(swJs, /SDK_URL/, 'service worker caches the Supabase SDK for offline starts');
assert.match(swJs, /SHELL\.map\(\(u\) => c\.add\(u\)/, 'precache is per-file, not all-or-nothing');
assert.match(indexHtml, /\.play\{flex:0 0 52px;min-width:52px\}/, 'transport Play button cannot be squeezed');
assert.match(indexHtml, /@media \(pointer:coarse\)[\s\S]*min-height:44px/, 'touch devices get 44px controls');
for (const f of ['studio', 'collab', 'mobile', 'pwa']) assert.ok(fs.existsSync(new URL(`../e2e/${f}.e2e.mjs`, import.meta.url)), `e2e/${f}.e2e.mjs exists`);
assert.match(fs.readFileSync(new URL('../../.github/workflows/security.yml', import.meta.url), 'utf8'), /e2e\/\*\.e2e\.mjs/, 'CI runs the mobile e2e suite');
console.log('Mobile QA regression source checks passed.');

// Studio engine guards (v1.12.14).
const dspSrc = read('js/dsp.js'), mp3Src = read('js/mp3.js');
assert.match(dspSrc, /function integratedLoudness/, 'BS.1770 loudness exists');
assert.match(dspSrc, /function limit\(/, 'true-peak limiter exists');
assert.match(indexHtml, /src="js\/dsp\.js/, 'dsp.js is loaded');
assert.match(indexHtml, /src="js\/mp3\.js/, 'mp3.js is loaded');
assert.match(indexHtml, /id="bounceMaster"[\s\S]*value="streaming"[\s\S]*value="podcast"[\s\S]*value="loud"/, 'Master selector present');
assert.match(indexHtml, /id="bounceReport"/, 'loudness report element present');
assert.doesNotMatch(indexHtml, /var orig=window\.bounceFullSong/, 'dead MP3 wrapper (window.bounceFullSong is private) is gone');
assert.match(appJs, /DSP\.masterToTarget\(/, 'bounce applies loudness mastering');
assert.match(appJs, /AuralithMp3\.encode\(/, 'bounce can encode MP3');
assert.match(appJs, /DSP \? DSP\.quantize16\(x, rng\)/, '16-bit export is dithered');
assert.match(appJs, /function nextTakeNumber\(\)/, 'take numbers are computed, not string-concatenated');
assert.doesNotMatch(appJs, /'Take ' \+ \(\(state\.vocalTakes && state\.vocalTakes\.length\) \|\| 0\) \+ 1/, 'take label concatenation bug is gone');
assert.match(appJs, /function releaseKeysPanic\(\)/, 'Keys has an all-notes-off safety net');
assert.match(appJs, /document\.addEventListener\('visibilitychange',\(\)=>\{if\(document\.visibilityState==='hidden'\)releaseKeysPanic/, 'backgrounding releases notes');
assert.match(appJs, /startKeyNote\(n,state\.octave\);key\._vk=n\+state\.octave;key\.classList\.add\('on'\);try\{key\.setPointerCapture/, 'note starts before pointer capture, which is guarded');
assert.match(swJs, /LAME_URL/, 'service worker caches the MP3 encoder');
assert.match(swJs, /js\/dsp\.js/, 'dsp.js is precached');
assert.ok(fs.existsSync(new URL('../tests/dsp.test.mjs', import.meta.url)) && fs.existsSync(new URL('../e2e/engine.e2e.mjs', import.meta.url)), 'engine tests exist');
console.log('Studio engine source checks passed.');

// Studio features (v1.12.15): undo/redo, meters, MIDI, latency calibration and take placement.
const dspSrc2 = read('js/dsp.js');
assert.match(appJs, /function beatHistStep\(/, 'beat undo/redo exists');
assert.match(indexHtml, /id="beatUndo"[\s\S]*id="beatRedo"/, 'undo/redo buttons exist');
assert.match(appJs, /function meterPeakDb\(/, 'channel meters exist');
assert.match(appJs, /idleSince > 1800\) \{ cancelAnimationFrame\(_meterRAF\)/, 'the meter loop stops when idle (it used to redraw forever)');
assert.match(appJs, /async function enableMidi\(/, 'MIDI input exists');
assert.match(read('js/midi.js'), /channel === 9\) return null/, 'MIDI drum channel is ignored');
assert.match(appJs, /async function calibrateMicTiming\(/, 'latency calibration exists');
assert.match(appJs, /createVocalRecorder\(stream, mime\);/, 'calibration records through the same recorder as a take');
assert.match(appJs, /state\._beatT0\s*=\s*nextNoteTime/, 'the beat origin is recorded on the audio clock');
assert.match(appJs, /gapMs: state\._recGapMs \|\| 0/, 'takes store the beat-to-recorder gap');
assert.match(appJs, /\(state\.vocal\.offsetMs \|\| 0\) \+ \(state\.vocal\.gapMs \|\| 0\)\) \/ 1000/, 'the bounce places takes at gap + timing');
assert.match(appJs, /src\.start\(0, Math\.min\(audioBuf\.duration, -when\)\)/, 'a negative start trims the take instead of being ignored');
assert.match(dspSrc2, /function estimateLatency\(/, 'latency estimator exists');
for (const f of ['beat-history', 'meters', 'midi', 'timing']) assert.ok(fs.existsSync(new URL(`../e2e/${f}.e2e.mjs`, import.meta.url)), `e2e/${f}.e2e.mjs exists`);
assert.ok(fs.existsSync(new URL('../tests/midi.test.mjs', import.meta.url)), 'midi unit tests exist');
console.log('Studio feature source checks passed.');
