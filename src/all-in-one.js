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
function useValue(name, fallbackFactory) {
  const envValue = process.env[name];
  if (envValue) return envValue;
  if (saved[name]) return String(saved[name]);
  const value = fallbackFactory();
  generated[name] = value;
  return value;
}

process.env.QADECK_ADMIN_EMAIL = useValue('QADECK_ADMIN_EMAIL', () => 'admin@qadeck.local');
process.env.QADECK_ADMIN_PASSWORD = useValue('QADECK_ADMIN_PASSWORD', () => crypto.randomBytes(15).toString('base64url'));
process.env.SESSION_SECRET = useValue('SESSION_SECRET', () => crypto.randomBytes(32).toString('hex'));
process.env.CREDENTIALS_KEY = useValue('CREDENTIALS_KEY', () => crypto.randomBytes(32).toString('hex'));

const persisted = {
  QADECK_ADMIN_EMAIL: process.env.QADECK_ADMIN_EMAIL,
  QADECK_ADMIN_PASSWORD: process.env.QADECK_ADMIN_PASSWORD,
  SESSION_SECRET: process.env.SESSION_SECRET,
  CREDENTIALS_KEY: process.env.CREDENTIALS_KEY
};

try {
  fs.writeFileSync(configPath, JSON.stringify(persisted, null, 2), { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
} catch (error) {
  console.error('[QADeck] Could not persist runtime config:', error.message);
  process.exit(1);
}

const firstSetup = Object.keys(generated).length > 0;
console.log('============================================================');
console.log(' QADeck all-in-one container');
console.log(' Web UI + background QA worker');
console.log('============================================================');
console.log(` Login email: ${process.env.QADECK_ADMIN_EMAIL}`);
if (firstSetup || !saved.QADECK_ADMIN_PASSWORD) {
  console.log(` Login password: ${process.env.QADECK_ADMIN_PASSWORD}`);
  console.log(' Save this password. It is persisted in the QADeck data volume.');
} else {
  console.log(' Login password: already configured (not printed again)');
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
