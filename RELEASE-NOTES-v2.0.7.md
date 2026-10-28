# Auralith v2.0.7 — Studio look

- New `<style id="auralith-studio-look">` layer (last in `<head>` of `www/index.html`): Inter-only type, compact text scale, near-black surfaces with hairline borders, pill controls, ivory primary buttons, gold accent, violet AI buttons.
- Type scale is tunable from `:root` (`--au-fs-label/meta/body/ui/title/h2/h1`, `--au-track-*`).
- Minimum text size raised from 7–9px to 10px across the stylesheet.
- Fonts: Fraunces and JetBrains Mono dropped from the Google Fonts request.
- Service-worker cache renamed to `auralith-v207-look-shell` so installed apps pick up the new look.
