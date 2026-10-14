# Tapehead Pro: real-device music QA checklist

Automated suites (`www/tests`, `www/e2e`) cover logic, layout, a fake microphone, a fake backend and offline behaviour in
Chromium. They **cannot** judge sound, latency, or what iOS/Android do with audio hardware. Run this checklist on real
phones before each release that touches audio, recording, upload or collaboration. Budget: ~45 minutes per device.

## Device matrix (minimum)
| # | Device | Browser / mode | Why |
|---|---|---|---|
| 1 | iPhone (iOS 16 or older, if you have one) | Safari + installed PWA | oldest WebKit audio behavior |
| 2 | iPhone (current iOS) | Safari + installed PWA | main iOS path; MediaRecorder gives `audio/mp4` |
| 3 | Mid-range Android (3-4 GB RAM) | Chrome + installed PWA | typical user; MediaRecorder gives `audio/webm` |
| 4 | Low-end Android (2 GB RAM) | Chrome | worst-case bounce/render time, memory |
| 5 | Any tablet | Chrome or Safari | wide layout |
Add Samsung Internet if your users are on Galaxy phones. Test with and without headphones (wired, Bluetooth).

Mark each row: PASS / FAIL (+ ticket) / N/A. Record device, OS, browser version, app version (`data-app-version`).

## A. First launch and sign-in
- [ ] Sign up with a new email; the Pro trial toast appears once; no duplicate toasts.
- [ ] Kill the app and reopen: still signed in. Airplane mode, reopen: app opens (limited cloud features, studio usable).
- [ ] Install to home screen (iOS: Share > Add to Home Screen; Android: Install app). Icon and splash look right, no browser bar.
- [ ] Rotate the phone on every screen: nothing cut off, nav stays reachable, no horizontal scroll.
- [ ] Notch / Dynamic Island / gesture bar do not cover the bottom tabs or the top of any screen.

## B. Beat making
- [ ] First tap on Play makes sound (iOS requires a gesture: no silent first tap). Phone silent switch ON: note behavior (Web Audio is muted on iOS silent mode unless the app plays an `<audio>` element; record the result).
- [ ] Pads are easy to hit with a thumb on the smallest phone; no accidental double toggles.
- [ ] Tempo -/+ and Tap Tempo respond on every tap; the number shown always matches the audible tempo.
- [ ] Hit/accent counter matches what you see.
- [ ] Kits: each genre kit loads and sounds distinct; no clicks/pops at loop point; no distortion at max accent.
- [ ] Swing/groove change is audible and survives stop/start.
- [ ] Play for 5 minutes: timing stays steady, no drift, phone not hot, no dropouts. Repeat with screen locked / app backgrounded (expect pause, not crash).
- [ ] Incoming call / notification sound / Siri during playback: app recovers, Play works afterwards.
- [ ] Output switching: plug/unplug headphones, connect/disconnect Bluetooth mid-playback.

## C. Recording vocals
- [ ] First use shows the OS microphone prompt; **Allow** works; **Deny** shows a helpful message and a working retry path (re-enable in browser/site settings).
- [ ] Record 30 s over the beat: meter moves, waveform draws, Stop saves "Take N".
- [ ] Playback of the take: right volume, right pitch (no chipmunk/slow-down), no clipping, not out of sync with the beat. Note any **latency/offset** vs the beat: how many ms late does the vocal land? (Clap on the beat and compare.)
- [ ] Record with wired headset, Bluetooth headset (expect added latency: note it), and the phone mic.
- [ ] Headphones vs speaker: with speaker output the beat bleeds into the mic; confirm the app warns or the result is acceptable.
- [ ] Record for 5+ minutes: no crash, file size sensible, memory ok.
- [ ] Interrupt a recording (call, app switch, lock screen): what is saved? Nothing silently lost? Record the result.
- [ ] Take list: rename/delete/select works; 5+ takes stay usable; takes are named Take 1, 2, 3 in order.
- [ ] **Take quality advice**: shout into the mic (expect the clipping warning), whisper from arm's length (expect the quiet warning), then record normally (no warning).
- [ ] Send to Mix: the vocal appears as a channel with the correct audio.

## D. Mixing and export
- [ ] Mute / Solo / Level / Pan / Reverb on Beat channels and Vocal behave as labelled; no zipper noise when dragging faders.
- [ ] Master play reflects the mix; stop/start repeatable.
- [ ] **Bounce Full Mix** at Draft, Standard and High: progress bar moves, finishes, file downloads, plays in the phone's music/files app, length matches, vocal present and in time. Time it on the low-end Android (more than ~60 s for a 2-bar song is a finding).
- [ ] **Master** menu: bounce the same song as *As mixed*, *Streaming* and *Loud*. Streaming is clearly louder with no audible pumping or crackle; Loud may say it could not reach its target (expected for dynamic songs). The report line under the progress bar shows LUFS and dBTP. Play all three in a music app at the same volume setting.
- [ ] **MP3**: choose MP3 *online* and confirm a real `.mp3` plays in the phone's music app (first use downloads the encoder). Then go offline and repeat: you should get the message and a WAV, not a stuck progress bar. Check ID3-less playback in Safari/Files and WhatsApp.
- [ ] **Export Stems**: ZIP downloads, opens on the phone, each stem plays.
- [ ] Share the bounced file via the OS share sheet (iOS Files / Android Drive / WhatsApp). Large files (>20 MB) do not crash the tab.
- [ ] Bounce while a phone call / low memory: app does not wedge in "Bouncing..." (button recovers).

## E. Uploads and collaboration (two or three real phones)
- [ ] Phone A creates a room; the code is easy to read aloud; Copy works; Share link/QR (if present) opens the app.
- [ ] Phone B joins by typing the code in lower case and with spaces; joins; sees A's beat and vocal.
- [ ] A uploads a vocal from Files / Voice Memos / Google Recorder (iOS `.m4a`, Android `.m4a`/`.aac`/`.wav`/`.mp3`). Each accepted format plays on B. A rejected format gives a clear message. A file >25 MB is refused politely.
- [ ] B plays A's vocal over the shared beat; levels sane; no 403 after 1 hour (signed links expire: leave the room open for >60 min, then press play).
- [ ] Notes/chat from B appear on A within ~2 s without a refresh; send 10 quick notes; none lost or duplicated.
- [ ] Both edit the lyric sections / beat at once: no data loss, no flicker, no endless "saving" churn. Watch battery/data during 10 minutes in a room (should be near-idle).
- [ ] Switch Wi-Fi to cellular mid-upload; lose signal for 30 s then return: upload fails cleanly or resumes; retry works; no duplicate or half-saved vocal.
- [ ] B taps Leave: B loses the room and its audio immediately; A still sees the room.
- [ ] C (not invited) types a wrong code: friendly "Room not found"; cannot see anything. Try many wrong codes quickly: eventually throttled with a clear message.

## E1. Vocal timing (do this on every device)
- [ ] **Clap test**: on the phone speaker, record 10 s of yourself clapping exactly on the kick with the beat playing. Bounce (Draft) and listen: the claps should sit on the beat. Note how many ms early/late (a free tool such as Audacity on the file can measure). Repeat after tapping **Auto-calibrate** (quiet room, speaker volume up). Pass: within about 25 ms after calibration.
- [ ] Auto-calibrate on the phone speaker: result is a plausible number (iPhone usually tens of ms, Android often 80-250 ms). Run it 3 times: within ~10 ms of each other.
- [ ] Wired headphones, Bluetooth headphones: calibration says it cannot hear the test sounds (expected); recording still works; note the audible offset and use the nudge buttons.
- [ ] After calibrating, close and reopen the app: the timing value is still there.

## E3. Beat undo/redo, meters and MIDI
- [ ] Undo/redo a pad, a Randomize, a tempo change; buttons enable/disable correctly; works while the beat plays.
- [ ] Mix meters move with the beat, show clipping in red when you push levels, and stop animating (battery) when you leave the Mix screen.
- [ ] USB/Bluetooth MIDI keyboard (Android Chrome): tap MIDI, allow access, play notes with different velocity, use the sustain pedal, unplug the cable while holding a note (no stuck sound).

## E2. Keys
- [ ] Hold a key, switch to another app, come back: no drone. Hold a key and lock the screen: no drone.
- [ ] Play a 3-note chord with three fingers; slide fingers between keys; fast taps all sound.
- [ ] Change octave and toggle sustain while holding keys: nothing sticks; turning sustain off silences ringing notes.
- [ ] Check latency feel on the phone (tap to sound) with and without Bluetooth headphones.

## F. Accessibility and comfort
- [ ] OS text size at 130%: nothing overlaps or is unreachable.
- [ ] VoiceOver / TalkBack can find Play, Record, Mute/Solo, the nav tabs and read their state.
- [ ] Dark/light mode and "reduce motion" respected. Colour contrast readable outdoors (max brightness).
- [ ] Software keyboard never hides the field you are typing in (sign-in, join code, notes).

## G. Long-session health
- [ ] 30 minutes of mixed use: no memory growth to the point of reload, no stuck audio, no hot phone (>= 10% battery per 10 min while idle in a room is a finding).
- [ ] Update flow: ship a new build, reopen the installed app: it picks up the new version within one or two launches; nothing breaks while an old tab is open.

## Severity rubric
- **S1** data loss, recording lost, cannot sign in, audio exposed to the wrong person, crash on launch.
- **S2** core feature broken on a mainstream device (no sound, bounce fails, vocal missing for collaborator).
- **S3** wrong but recoverable (misleading label, slow, misaligned UI).
- **S4** polish.

## Bug report template
Device / OS / browser / app version, steps, expected, actual, frequency (always/sometimes), screen recording, and whether it
reproduces on a second device.

## Sign-off
Release is OK when: no open S1/S2 on devices 2 and 3, all of sections B-E pass on at least one iOS and one Android phone, and
every S3 has a ticket.
