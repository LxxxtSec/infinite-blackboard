'use strict';

/*
 * Thin Electron shell around the existing local blackboard server.
 *
 * The web app, CLI and Agent integrations stay unchanged. The desktop process
 * only owns the lifecycle: start the loopback server on a random port, show it
 * in a BrowserWindow, keep a tray entry, and stop the server on quit.
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ICON = path.join(__dirname, 'assets', 'icon.png');
const TRAY_ICON = path.join(__dirname, 'assets', 'tray.png');
const HOMEPAGE = 'https://github.com/LxxxtSec/infinite-blackboard';
const projectsRoot = process.env.BLACKBOARD_PROJECTS || path.join(os.homedir(), 'blackboard-projects');

let mainWindow = null;
let tray = null;
let server = null;
let serverUrl = '';
let quitting = false;
let starting = false;

app.setName('Infinite Blackboard');
if (process.platform === 'win32') app.setAppUserModelId('com.lxxxtsec.infiniteblackboard');

/** Finder/desktop launches do not inherit the login shell PATH. */
function augmentPath() {
  if (process.platform === 'win32') return;
  const current = process.env.PATH || '';
  let login = '';
  try {
    login = execFileSync(process.env.SHELL || '/bin/zsh', ['-lc', 'printf %s "$PATH"'], {
      encoding: 'utf8', timeout: 2500, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { /* keep the inherited PATH */ }
  const extra = [login, current, '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.bun', 'bin'), path.join(os.homedir(), 'bin')];
  process.env.PATH = [...new Set(extra.filter(Boolean).join(':').split(':').filter(Boolean))].join(path.delimiter);
}

async function startBoard() {
  if (starting) return;
  starting = true;
  try {
    fs.mkdirSync(projectsRoot, { recursive: true });
    const serverModule = await import(pathToFileURL(path.join(ROOT, 'lib', 'server.js')).href);
    server = await serverModule.startServer({ cwd: projectsRoot, projectsRoot, port: 0 });
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    if (!port) throw new Error('server did not bind a port');
    serverUrl = `http://127.0.0.1:${port}`;
    updateTray();
  } finally {
    starting = false;
  }
}

async function stopBoard() {
  const current = server;
  server = null;
  if (!current) return;
  await new Promise((resolve) => {
    try { current.close(() => resolve()); } catch { resolve(); }
    setTimeout(resolve, 1500);
  });
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  const icon = fs.existsSync(ICON) ? nativeImage.createFromPath(ICON) : undefined;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#090d0c',
    icon,
    title: 'Infinite Blackboard',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.loadURL(serverUrl || 'about:blank');
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(serverUrl)) return { action: 'allow' };
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(serverUrl)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  mainWindow.webContents.on('context-menu', (_event, params) => {
    if (!params.selectionText && !params.isEditable) return;
    const template = [];
    if (params.isEditable) {
      template.push({ role: 'cut', label: '剪切', enabled: params.editFlags.canCut });
    }
    if (params.selectionText || params.isEditable) {
      template.push({ role: 'copy', label: '复制', enabled: params.editFlags.canCopy || Boolean(params.selectionText) });
    }
    if (params.isEditable) {
      template.push({ role: 'paste', label: '粘贴', enabled: params.editFlags.canPaste });
      template.push({ type: 'separator' });
    }
    template.push({ role: 'selectAll', label: '全选' });
    Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });

  mainWindow.on('close', (event) => {
    if (!quitting && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (serverUrl && mainWindow) {
    const current = mainWindow.webContents.getURL();
    if (!current.startsWith(serverUrl)) mainWindow.loadURL(serverUrl);
  }
  mainWindow.show();
  mainWindow.focus();
}

function openProjects() {
  fs.mkdirSync(projectsRoot, { recursive: true });
  shell.openPath(projectsRoot);
}

async function restartBoard() {
  try {
    await stopBoard();
    await startBoard();
    if (mainWindow) mainWindow.loadURL(serverUrl);
    updateTray();
  } catch (error) {
    dialog.showErrorBox('Infinite Blackboard', `服务重启失败：${error.message}`);
  }
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(serverUrl ? `Infinite Blackboard · ${serverUrl}` : 'Infinite Blackboard');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开窗口', click: showWindow },
    { label: '在浏览器中打开', enabled: Boolean(serverUrl), click: () => serverUrl && shell.openExternal(serverUrl) },
    { type: 'separator' },
    { label: '打开项目目录', click: openProjects },
    { label: '重启本地服务', click: () => { void restartBoard(); } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
}

function createTray() {
  const iconPath = fs.existsSync(TRAY_ICON) ? TRAY_ICON : ICON;
  if (!fs.existsSync(iconPath)) return;
  try {
    let icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) return;
    icon = icon.resize({ width: 18, height: 18 });
    tray = new Tray(icon);
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);
    updateTray();
  } catch { tray = null; }
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ label: app.name, submenu: [
      { role: 'about' },
      { label: '打开项目目录', click: openProjects },
      { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { role: 'quit' },
    ] }] : []),
    { label: '文件', submenu: [
      { label: '打开项目目录', click: openProjects },
      { label: '重新加载页面', accelerator: 'CmdOrCtrl+R', click: () => mainWindow && mainWindow.reload() },
      ...(!isMac ? [{ type: 'separator' }, { role: 'quit' }] : []),
    ] },
    { label: '编辑', submenu: [
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      { role: 'pasteAndMatchStyle', label: '粘贴并匹配格式' },
      { role: 'delete', label: '删除' },
      { type: 'separator' },
      { role: 'selectAll', label: '全选' },
    ] },
    { label: '服务', submenu: [
      { label: '重启本地服务', click: () => { void restartBoard(); } },
      { label: '在浏览器中打开', enabled: Boolean(serverUrl), click: () => serverUrl && shell.openExternal(serverUrl) },
    ] },
    { label: '视图', submenu: [
      { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
      { role: 'togglefullscreen' },
    ] },
    { label: '帮助', submenu: [
      { label: 'GitHub 仓库', click: () => shell.openExternal(HOMEPAGE) },
      { label: '项目数据目录', click: openProjects },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(async () => {
    augmentPath();
    try {
      await startBoard();
    } catch (error) {
      dialog.showErrorBox('Infinite Blackboard 启动失败', `${error.message}\n\n数据目录：${projectsRoot}`);
      quitting = true;
      app.quit();
      return;
    }
    createWindow();
    buildMenu();
    createTray();
    app.on('activate', showWindow);
  }).catch((error) => {
    dialog.showErrorBox('Infinite Blackboard 启动失败', error.message);
    quitting = true;
    app.quit();
  });
}

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  stopBoard().finally(() => app.quit());
});

app.on('window-all-closed', () => {
  // The tray keeps the service alive; without one, closing the window quits.
  if (!tray) app.quit();
});
