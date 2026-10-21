# Auralith v1.12.15 - Button / Feature Debug Pass

## Underlying event-logic fixes
- Feed Pro controls are now bound once. Re-opening Feed no longer accumulates duplicate listeners.
- Feed Post no longer receives a second click handler from the generic menu binder.
- Avatar no longer receives a second profile-opening click handler.
- Sidebar user is left to the dedicated sidebar bridge instead of being bound twice.
- Paywall close controls are left to their dedicated listeners instead of receiving duplicate handlers.
- Library menu action closes the sidebar before scrolling to the project list.

## Primary flows reviewed
- Explore as guest
- Write
- Studio -> Beat / Keys / Record / Mix
- Feed
- Collab
- Sidebar menu
- Profile / avatar
- Library
- Export / Bounce
