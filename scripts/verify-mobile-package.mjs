import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const required = [
  'capacitor.config.json',
  'www/index.html',
  'www/manifest.webmanifest',
  'www/sw.js',
  'www/js/project-store.js',
  'www/js/project-sync.js',
  'www/icon-192.png',
  'www/icon-512.png',
  'www/icon-maskable-512.png',
  'assets/icon-foreground.png',
  'assets/icon-background.png',
  'native-shell/index.html'
];

const missing = required.filter(p => !fs.existsSync(path.join(root, p)));
if (missing.length) {
  console.error('Missing mobile package files:', missing.join(', '));
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(path.join(root, 'capacitor.config.json'), 'utf8'));
if (cfg.appId !== 'com.tapehead.pro') throw new Error('Unexpected Capacitor appId');
if (cfg.appName !== 'Auralith Studio') throw new Error('Unexpected Capacitor appName');
if (!cfg.server?.url?.startsWith('https://')) throw new Error('Native wrapper must use HTTPS');
if (cfg.server.cleartext !== false) throw new Error('Cleartext traffic must remain disabled');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (pkg.version !== '2.0.6') throw new Error('Release identity must remain v2.0.6');

for (const p of required) {
  const s = fs.statSync(path.join(root, p));
  if (!s.isFile() || s.size === 0) throw new Error(`Invalid mobile asset: ${p}`);
}

console.log('Auralith Studio v2.0.6 mobile package verification passed.');
console.log('Android/iOS Capacitor configuration is present.');
console.log('Native platform projects must be generated with: npm install && npm run android:add && npm run ios:add');
