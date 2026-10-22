'use strict';

// Renderer smoke test: starts the real local server, loads the real built page
// in a hidden BrowserWindow and fails when the React root is empty.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const root = path.join(__dirname, '..');
  const projects = process.env.BLACKBOARD_PROJECTS || path.join(os.homedir(), 'blackboard-projects');
  const { startServer } = await import(pathToFileURL(path.join(root, 'lib', 'server.js')).href);
  const server = await startServer({ cwd: projects, projectsRoot: projects, port: 0 });
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 920,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const errors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) errors.push(message);
  });
  await win.loadURL(url);
  await new Promise((resolve) => setTimeout(resolve, 1600));
  const result = await win.webContents.executeJavaScript(`JSON.stringify({ title: document.title, body: document.body.innerText.slice(0, 120), root: (document.querySelector('#root') || {}).innerHTML?.slice(0, 80) || '' })`);
  console.log('[desktop smoke]', result);
  if (errors.length) console.error('[desktop smoke errors]', errors.slice(0, 4));
  const parsed = JSON.parse(result);
  const ok = Boolean(parsed.root) && !errors.some((message) => /Cannot read properties of null|Invalid hook call|Minified React error/.test(message));
  if (!ok) process.exitCode = 1;
  win.destroy();
  try { server.close(); } catch { /* ignore */ }
  setTimeout(() => app.exit(process.exitCode || 0), 200);
}).catch((error) => {
  console.error('[desktop smoke] failed', error);
  process.exitCode = 1;
  app.quit();
});
