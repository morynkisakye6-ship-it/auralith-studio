# Tapehead Pro v1.12.8 — Account Data Deletion Safety

## Changes
- Account deletion now paginates storage listings and descends into nested folders under the authenticated user's `vocals/<user-id>/` prefix.
- Storage listing and deletion failures stop the process before the Auth user is removed, avoiding a false success while private audio may remain.
- Storage objects are deleted in bounded batches, and account deletion only proceeds after cleanup is confirmed.
- Updated app/service-worker cache version identifiers.

## Important scope and limitations
- This endpoint currently cleans the `vocals` bucket because that is the bucket used by the app's audio upload flow. If other buckets are added, account deletion must be extended to them.
- Validate the Supabase Storage list response shape and pagination behavior in a non-production project before deployment.
- Cleanup is not a single transaction across Storage and Auth. If Auth deletion fails after storage cleanup, the account remains but its stored vocals may already have been removed; the response says so.
- Rate limiting remains in-memory per serverless instance. This is not distributed abuse prevention.
- Source-level tests do not replace integration tests against the deployed Supabase project.
