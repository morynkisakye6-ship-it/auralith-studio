# Tapehead — iOS & Android build

Live app: https://tapehead-pro-phi.vercel.app (deploy `www/` to Vercel as before).
The store apps are a Capacitor shell that opens that address, so a Vercel deploy updates the
installed apps too. Only native changes (icon, name, permissions) need a new store release.

## Before you start
- **App ID** is `com.tapehead.pro` in `capacitor.config.json`. Change it now if you want a different one;
  it cannot be changed after the first store release.
- iOS needs a Mac with Xcode and an Apple Developer account. Android needs Android Studio and a Google Play developer account.
- Node 20+ installed.

## One-time setup (run in this folder, next to package.json)
```
npm install --save @capacitor/core @capacitor/app @capacitor/status-bar @capacitor/splash-screen
npm install --save-dev @capacitor/cli @capacitor/ios @capacitor/android @capacitor/assets
npx cap add ios
npx cap add android
npm run icons        # builds every native icon + splash from assets/
npx cap sync
```

## iOS
1. `npm run ios` opens Xcode.
2. Select the App target → Signing & Capabilities → choose your Team.
3. Info tab: add **Privacy - Microphone Usage Description**, e.g. "Tapehead records your vocals and hums."
4. Product → Archive → Distribute App → App Store Connect.

## Android
1. `npm run android` opens Android Studio.
2. Confirm `AndroidManifest.xml` has `android.permission.RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS`.
3. Build → Generate Signed App Bundle (.aab). Keep the keystore file and passwords safe; losing them blocks updates.
4. Upload the .aab in Google Play Console.

## Store listing requirements
- **Privacy policy URL and Terms URL**: the app links to `/privacy.html` and `/terms.html`, but those pages are not
  in this project. Make sure they exist on the live site before submitting.
- **Account deletion**: already in the app (Profile → Delete account); both stores require it.
- **Paid plans**: Apple requires in-app purchase for digital subscriptions sold inside an iOS app. The Pesapal checkout
  may be rejected on iOS; Google Play has similar rules. Decide this before submitting.
- Apple can reject apps that only wrap a website (guideline 4.2). Mention native features in review notes:
  microphone recording, offline-capable studio, audio export.
- Screenshots: take them on a real phone from the live app.

## Icons in this project
- `www/icon-*.png` (32–1024), `icon-maskable-512.png`, `favicon.ico`, `og-image.jpg`: web, PWA install and link previews.
- `assets/`: source art for `npm run icons`, which writes the iOS and Android icon/splash sets.
