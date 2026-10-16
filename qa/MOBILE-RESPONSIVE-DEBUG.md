# Tapehead v1.12.15 - Mobile Responsive Debug

This file records the mobile hardening kept under the project's v1.12.15
release identity.

- Long transient messages are bounded to the phone viewport and wrap.
- Modal sheets respect mobile safe areas and dynamic viewport height.
- Narrow-phone modal actions can stack instead of overflowing.
- iOS inputs use a 16px minimum to reduce unwanted browser zoom.
- Landscape phone layouts are constrained and scrollable.
- Mobile regression coverage is included for long messages and Explore as guest.
