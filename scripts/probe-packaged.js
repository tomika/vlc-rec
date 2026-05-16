const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const exe = path.join(root, 'dist', 'vlc-rec', 'vlc-rec-win_x64.exe');
const startupLog = path.join(os.tmpdir(), 'vlc_rec_startup.log');

if (!fs.existsSync(exe)) {
  console.error('Executable not found:', exe);
  process.exit(2);
}

try {
  fs.rmSync(startupLog, { force: true });
} catch {}

console.log('Launching:', exe);
const child = spawn(exe, [], { cwd: root, stdio: 'pipe' });

child.on('error', (err) => {
  console.error('spawn error:', err.message);
});

const startedAt = Date.now();
let exited = false;

child.on('exit', (code, signal) => {
  exited = true;
  console.log('child exit event:', { code, signal, elapsedMs: Date.now() - startedAt });
});

setTimeout(() => {
  const logExists = fs.existsSync(startupLog);
  const logBody = logExists ? fs.readFileSync(startupLog, 'utf8') : '';
  console.log('probe result:', {
    pid: child.pid,
    exited,
    elapsedMs: Date.now() - startedAt,
    startupLogExists: logExists,
    startupLogSize: logBody.length
  });

  if (logExists && logBody.trim()) {
    console.log('--- startup log ---');
    console.log(logBody);
  }

  if (!exited) {
    console.log('probe: process still running after 5s (likely healthy GUI process)');
  }

  process.exit(exited ? 0 : 0);
}, 5000);
