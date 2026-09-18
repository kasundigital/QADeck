const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
const configPath = path.join(dataDir, 'runtime-config.json');

fs.mkdirSync(dataDir, { recursive: true });

let saved = {};
try {
  if (fs.existsSync(configPath)) {
    saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
} catch (error) {
  console.warn('[QADeck] Could not read persisted runtime config:', error.message);
}

const generated = {};
function useSecret(name) {
  const envValue = process.env[name];
  if (envValue) return envValue;
  if (saved[name]) return String(saved[name]);
  const value = crypto.randomBytes(32).toString('hex');
  generated[name] = value;
  return value;
}

process.env.SESSION_SECRET = useSecret('SESSION_SECRET');
process.env.CREDENTIALS_KEY = useSecret('CREDENTIALS_KEY');

const savedUsername = String(saved.QADECK_ADMIN_USERNAME || saved.QADECK_ADMIN_EMAIL || '').trim();
const savedPassword = String(saved.QADECK_ADMIN_PASSWORD || '');
const envUsername = String(process.env.QADECK_ADMIN_USERNAME || process.env.QADECK_ADMIN_EMAIL || '').trim();
const envPassword = String(process.env.QADECK_ADMIN_PASSWORD || '');
const envLoginIsUsable = Boolean(envUsername && envPassword && envPassword !== 'change-this-password');

if (savedUsername && savedPassword) {
  process.env.QADECK_ADMIN_USERNAME = savedUsername;
  process.env.QADECK_ADMIN_PASSWORD = savedPassword;
} else if (envLoginIsUsable) {
  process.env.QADECK_ADMIN_USERNAME = envUsername;
  process.env.QADECK_ADMIN_PASSWORD = envPassword;
}

const persisted = {
  ...saved,
  SESSION_SECRET: process.env.SESSION_SECRET,
  CREDENTIALS_KEY: process.env.CREDENTIALS_KEY
};
if (!savedUsername && envLoginIsUsable) {
  persisted.QADECK_ADMIN_USERNAME = envUsername;
  persisted.QADECK_ADMIN_PASSWORD = envPassword;
}

try {
  fs.writeFileSync(configPath, JSON.stringify(persisted, null, 2), { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
} catch (error) {
  console.error('[QADeck] Could not persist runtime config:', error.message);
  process.exit(1);
}

const loginConfigured = Boolean(
  String(persisted.QADECK_ADMIN_USERNAME || persisted.QADECK_ADMIN_EMAIL || '').trim()
  && String(persisted.QADECK_ADMIN_PASSWORD || '')
);

console.log('============================================================');
console.log(' QADeck all-in-one container');
console.log(' Web UI + background QA worker');
console.log('============================================================');
if (loginConfigured) {
  console.log(' Admin login: configured');
} else {
  console.log(' First-run setup: required');
  console.log(' Open QADeck in your browser to create the admin login.');
}
console.log(' Open: http://YOUR-SERVER-IP:' + (process.env.PORT || '3000'));
console.log('============================================================');

const children = new Set();
let stopping = false;
let exitCode = 0;

function launch(label, args) {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit'
  });
  children.add(child);

  child.on('exit', (code, signal) => {
    children.delete(child);
    if (!stopping) {
      exitCode = typeof code === 'number' ? code : 1;
      console.error(`[QADeck] ${label} exited unexpectedly (code=${code}, signal=${signal || 'none'}). Stopping container.`);
      shutdown('SIGTERM');
    }
  });

  return child;
}

function shutdown(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try { child.kill(signal); } catch {}
  }

  const deadline = setTimeout(() => {
    for (const child of children) {
      try { child.kill('SIGKILL'); } catch {}
    }
    process.exit(exitCode);
  }, 30000);
  deadline.unref();

  const check = setInterval(() => {
    if (children.size === 0) {
      clearInterval(check);
      clearTimeout(deadline);
      process.exit(exitCode);
    }
  }, 100);
  check.unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

launch('web', ['--require', './src/inspector-preload.js', 'src/app.js']);
launch('worker', ['src/worker.js']);
