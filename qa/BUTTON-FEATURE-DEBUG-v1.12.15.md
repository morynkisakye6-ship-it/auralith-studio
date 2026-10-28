# Auralith v1.12.15 - Button / Feature Debug Pass v3

## Focus
Underlying event behavior on mobile, especially accidental double taps and
re-entry while a navigation command is already being processed.

## Hardened
- High-level Feed, Collab, Studio, Write, Record and Mix commands reject
  accidental same-command re-entry within 300ms.
- Existing one-time listener guards remain in place.
- No feature or release-version change.

## Required manual/device verification
1. Explore as guest: one tap opens guest experience; no duplicate modal/state.
2. Write: opens exactly once.
3. Studio: opens exactly once.
4. Record: opens exactly once and does not create duplicate controls.
5. Mix: opens exactly once.
6. Feed: opens exactly once after repeated visits.
7. Collab: opens exactly once after repeated visits.
8. Sidebar menu: opens/closes cleanly; destination opens after selection.
9. Profile/avatar: opens exactly once.
10. Test each flow after returning from another section.
