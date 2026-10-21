# Auralith Studio v2.0.2 — Project Persistence Hardening

## Changes
- Added a dedicated project-store module for local project persistence.
- Keeps project storage isolated by signed-in user ID, with a guest-only storage key when signed out.
- Safely handles malformed stored JSON and browser storage failures.
- Validates project records before writing.
- Merges local and cloud projects by ID and keeps the newer timestamp; equal timestamps prefer local edits.
- Updates the service-worker cache version and pre-caches the new project-store module.
- Adds six focused persistence tests and updates mobile/engineering release verification to v2.0.2.

## Verification
- `npm run verify:engineering` passed.
- 108 tests passed, 0 failed.
- Node.js emitted existing module-type performance warnings for server API files; these did not fail tests.

## Important deployment note
This hardens client-side project persistence and the existing cloud-sync path. Cross-device and post-logout persistence depends on the deployed cloud configuration and the backend `projects` table policies being correct. After deploying, sign in, create/save a test project, wait for the save status, sign out, sign in again, and verify it appears. Test on a second browser/device if cross-device persistence is required.
