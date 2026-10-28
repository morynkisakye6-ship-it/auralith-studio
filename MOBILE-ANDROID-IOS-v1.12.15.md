# Auralith v1.12.15 - Android + iOS Installation

## Two installation paths

### 1. Install from the web (PWA)
The existing `www/manifest.webmanifest`, icons, service worker and mobile
viewport configuration support installation as a web app.

- Android: Chrome/compatible browser -> Add to Home screen / Install app.
- iOS: Safari -> Share -> Add to Home Screen.

### 2. Native Android + iOS app stores
The repository now contains the Capacitor configuration and native build
dependencies.

From a machine with Node/npm and the Android/iOS toolchains:

```text
npm install
npm run verify:mobile
npm run android:add
npm run ios:add
npm run sync
```

Then:

```text
npm run android
npm run ios
```

Android requires Android Studio/SDK. iOS requires macOS + Xcode for the final
iPhone/iPad build and App Store signing.

## Important architecture note

The Capacitor wrapper points to the HTTPS production Auralith web app. This
means the native shell and the web app remain one shared product rather than
creating a second, divergent UI codebase.

Do not enable cleartext HTTP traffic. Keep the HTTPS production URL and the
restricted navigation allowlist.

## Release identity

All project release references remain **v1.12.15**.
