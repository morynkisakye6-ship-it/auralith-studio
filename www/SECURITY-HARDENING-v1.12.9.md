# Tapehead Pro v1.12.9 — Private Audio Upload Hardening

## Scope
- Bind the vocal upload call to the currently authenticated Supabase user rather than trusting the passed profile object alone.
- Validate and normalize collaboration room codes before using them in storage paths or metadata.
- Avoid overwriting storage objects on upload.
- Remove a newly uploaded object when signed-URL creation or subsequent metadata operations fail, and log cleanup failures for investigation.
- Extend source-level security verification to cover these behaviors.

## Validation performed
- JavaScript syntax checks for the app scripts and API routes.
- `node scripts/verify-security.mjs` source assertions.
- ZIP integrity check.

## Important limits
These are source-level checks only. They do not prove that Supabase Storage RLS policies are correct or that database ownership rules are enforced. The deployment owner must inspect the actual Supabase policies and test with two separate user accounts. The browser client cannot substitute for server/database authorization. Existing schema constraints around `room_vocals` also need integration testing.

## Preview test plan
1. Sign in as user A and upload a valid vocal to a room where A is authorized.
2. Attempt to call the upload method with a profile object for user B; it must refuse before storage upload.
3. Try invalid room-code strings and unsupported/oversized audio files.
4. Simulate signed-URL or metadata failure and verify the newly uploaded object is removed; inspect logs if cleanup fails.
5. Confirm user B cannot read, replace, or delete user A's private audio through direct Storage API requests.
6. Confirm legitimate collaboration participants can access only the vocal assets intended for their room.
