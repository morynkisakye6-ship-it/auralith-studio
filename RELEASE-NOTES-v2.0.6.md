# Auralith Studio v2.0.6 — Fully Auralith

Baseline: v2.0.5. Branding only; no behaviour change intended. 55 files updated, ~200 references.

## Renamed
- **All documents** (release notes, hardening notes, QA checklists, runbooks, native build guides, CI workflow comments).
- **All user-facing text**: Privacy Policy and Terms (now "Auralith Pro"), the in-app copy ("Auralith artist", "Auralith Collab", the delete-account prompt, share text, BEAT MAKER / MIX headings, the AI assistant's system prompt), and the default export filename (`auralith-song_full.wav`).
- **Internal JavaScript names**: `window.AuralithCloud`, `AuralithDSP`, `AuralithMidi`, `AuralithMp3`, `AuralithContinuity`, the `window.Auralith` bridge, `AURALITH_CLOUD` (in `index.html` and `cloud-config.js`), the CDN cache name, style ids, logs and comments. The service worker already deletes caches it doesn't own, so the old CDN cache disappears on its own (two CDN scripts re-download once).
- **Support address**: the error messages that pointed at the old support mailbox now use the contact already published in the Privacy Policy and Terms (burstcomepsp@gmail.com). Change it in `api/pro-checkout.js` and `api/delete-account.js` if you set up an Auralith address.

## Deliberately NOT renamed (external contracts)
Renaming these without a coordinated migration would break live systems. Each is allow-listed in the new brand guard.

| Name | Why it stays | To rename it |
|---|---|---|
| `com.tapehead.pro` (Capacitor `appId`) | It is the App Store / Play identity. A new ID is a new app: installed users stop receiving upgrades and purchases do not carry over. The verifiers assert it on purpose. | Publish a new store listing, plan a user migration. |
| `tapehead-pro-phi.vercel.app` | The live hosting URL used by the canonical link, share image, native wrapper `server.url`, allowed navigation and the sign-in redirect. | Attach a new domain first, add it to Supabase auth redirects, then update these 6 places. |
| `tapehead_jobs`, `claim_tapehead_job` | Live Supabase table and function, plus RLS policies. | A SQL migration (`alter table ... rename`) deployed together with the API change. |
| `tapehead-media` (IndexedDB) | Holds users' saved record beds on their devices. Renaming it would hide that data. | A tested migration that copies old to new before deleting. |

## Guard
`npm run verify:engineering` now fails if the old name appears anywhere except those four contracts, so it cannot creep back in.

## Verification
- 185 unit tests, package and engineering verifiers, security and limiter scripts: all pass.
- Browser tests run file by file on the renamed build: pwa 5/5, tabs 5/5, projects 5/5, midi 13/13, studio 10/10, engine 11/11, beat-history 11/11, collab 13/13, mobile 12/12, timing 10/10.
- Two intermittent results, neither caused by the rename: `meters` "muting a channel" now fails about 3 runs in 4 on this machine, but the **untouched v2.0.2 baseline and the v2.0.5 package fail it at the same rate today**. `mobile-messages` "Explore as guest" failed once in about 7 runs and I did not capture its message. Treat both as environment-sensitive until seen in CI.
- Not run: live-staging Supabase tests.
