import { app, BrowserWindow, ipcMain, Menu, Tray, globalShortcut, nativeImage, dialog } from 'electron';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawn, exec } from 'child_process';
import readline from 'readline';
import fs from 'fs/promises';
import os from 'os';
import net from 'net';
import { promisify } from 'util';
import { startServer } from './server.js';
import pkgUpdater from 'electron-updater';
const { autoUpdater } = pkgUpdater;

const execAsync = (cmd) => promisify(exec)(cmd, { windowsHide: true });

// Configure Auto Updater
function setupAutoUpdater() {
  if (process.env.NODE_ENV === 'development') {
    console.log('[Electron Main] Skipping auto updater check in development.');
    return;
  }
  
  autoUpdater.logger = console;
  
  autoUpdater.on('checking-for-update', () => {
    console.log('[AutoUpdater] Checking for update...');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[AutoUpdater] Update available:', info.version);
  });

  autoUpdater.on('update-not-available', (info) => {
    console.log('[AutoUpdater] Update not available.');
  });

  autoUpdater.on('error', (err) => {
    console.error('[AutoUpdater] Error in auto-updater:', err);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[AutoUpdater] Update downloaded:', info.version);
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: `A new version of Qexow (${info.version}) has been downloaded and is ready to install.`,
      detail: 'The application will restart to apply the update.',
      buttons: ['Restart Now', 'Later']
    }).then((result) => {
      if (result.response === 0) {
        autoUpdater.quitAndInstall();
      }
    });
  });

  autoUpdater.checkForUpdatesAndNotify();
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
// serverProcess is no longer needed — server runs in-process via startServer()

// Disable hardware acceleration to resolve potential rendering glitches in VM environments
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('no-sandbox');

// Helper to find a free port
function getFreePort(startPort) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(startPort, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', () => {
      resolve(getFreePort(startPort + 1));
    });
  });
}

// Backend server is now started in-process via startServer() imported from server.js

function getPathFromArgs(argv) {
  for (const arg of argv) {
    if (arg.endsWith('electron.exe') || arg.endsWith('electron') || arg.endsWith('Qexow.exe') || arg === '.') {
      continue;
    }
    if (arg.startsWith('--')) {
      continue;
    }
    if (path.isAbsolute(arg)) {
      return arg;
    }
  }
  return null;
}

async function registerContextMenu() {
  const execPath = process.execPath;
  if (execPath.toLowerCase().includes('node_modules') || execPath.toLowerCase().includes('electron.exe')) {
    console.log('[Electron Main] Skipping context menu registry in development mode.');
    return;
  }
  try {
    // 1. File Context Menu
    await execAsync(`reg add "HKCU\\Software\\Classes\\*\\shell\\Open in Qexow" /ve /t REG_SZ /d "Open in Qexow" /f`);
    await execAsync(`reg add "HKCU\\Software\\Classes\\*\\shell\\Open in Qexow\\command" /ve /t REG_SZ /d "\\"${execPath}\\" \\"%1\\"" /f`);
    await execAsync(`reg add "HKCU\\Software\\Classes\\*\\shell\\Open in Qexow" /v "Icon" /t REG_SZ /d "\\"${execPath}\\",0" /f`);
    
    // 2. Folder Context Menu
    await execAsync(`reg add "HKCU\\Software\\Classes\\Directory\\shell\\Open in Qexow" /ve /t REG_SZ /d "Open in Qexow" /f`);
    await execAsync(`reg add "HKCU\\Software\\Classes\\Directory\\shell\\Open in Qexow\\command" /ve /t REG_SZ /d "\\"${execPath}\\" \\"%1\\"" /f`);
    await execAsync(`reg add "HKCU\\Software\\Classes\\Directory\\shell\\Open in Qexow" /v "Icon" /t REG_SZ /d "\\"${execPath}\\",0" /f`);
    
    // 3. Folder Background Context Menu
    await execAsync(`reg add "HKCU\\Software\\Classes\\Directory\\Background\\shell\\Open in Qexow" /ve /t REG_SZ /d "Open in Qexow" /f`);
    await execAsync(`reg add "HKCU\\Software\\Classes\\Directory\\Background\\shell\\Open in Qexow\\command" /ve /t REG_SZ /d "\\"${execPath}\\" \\"%V\\"" /f`);
    await execAsync(`reg add "HKCU\\Software\\Classes\\Directory\\Background\\shell\\Open in Qexow" /v "Icon" /t REG_SZ /d "\\"${execPath}\\",0" /f`);
    
    console.log('[Electron Main] Context menu successfully registered in Windows registry.');
  } catch (err) {
    console.error('[Electron Main] Failed to register context menu in registry:', err.message);
  }
}

function setupApplicationMenu() {
  const menuTemplate = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Workspace',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('menu-action', 'new-workspace');
          }
        },
        {
          label: 'Save File',
          accelerator: 'CmdOrCtrl+S',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('menu-action', 'save-file');
          }
        },
        { type: 'separator' },
        {
          label: 'Exit',
          click: () => {
            app.isQuitting = true;
            app.quit();
          }
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Sidebar',
          accelerator: 'CmdOrCtrl+B',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('menu-action', 'toggle-sidebar');
          }
        },
        {
          label: 'Toggle Editor',
          accelerator: 'CmdOrCtrl+E',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('menu-action', 'toggle-editor');
          }
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: 'About',
      submenu: [
        {
          label: 'About Qexow',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('menu-action', 'about-qexow');
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);
}

function createWindow(port, state) {
  const statePath = path.join(os.homedir(), '.codex', 'window_state.json');

  mainWindow = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width || 1200,
    height: state.height || 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    backgroundColor: '#09090b' // Matches modern dark-theme styling
  });

  setupApplicationMenu();

  if (state.isMaximized) {
    mainWindow.maximize();
  }

  // Register state saving logic on resize/move
  const saveState = async () => {
    try {
      if (mainWindow.isDestroyed()) return;
      const isMaximized = mainWindow.isMaximized();
      let bounds = {};
      if (!isMaximized) {
        bounds = mainWindow.getBounds();
      } else {
        try {
          const raw = await fs.readFile(statePath, 'utf-8');
          bounds = JSON.parse(raw) || {};
        } catch (_) {}
      }
      const newState = {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width || 1200,
        height: bounds.height || 800,
        isMaximized
      };
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      await fs.writeFile(statePath, JSON.stringify(newState), 'utf-8');
    } catch (_) {}
  };

  mainWindow.on('resize', saveState);
  mainWindow.on('move', saveState);

  // Hide window to system tray on close instead of exiting
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    // Load local loading bootstrap screen first
    const loadingUrl = pathToFileURL(path.join(__dirname, 'loading.html'));
    loadingUrl.searchParams.set('port', String(port));
    mainWindow.loadURL(loadingUrl.href);
  }
}

let tray = null;

async function createTray() {
  const iconDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAWklEQVQ4T2NkQAP/Gf4zMDKgA7w6DLgMIGQATsNgGAYMQzAIBrsJGAaDCTgJAzkGlIYBMQyEYYCQDAZjMAwDhsFgAgZqDCDHM6EZQG4YjGaA2DAg1wByDDEMIAoA58V9bwGepYcAAAAASUVORK5CYII=';
  const image = nativeImage.createFromDataURL(iconDataUrl);
  
  tray = new Tray(image);
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show App', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { label: 'Hide App', click: () => mainWindow.hide() },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  tray.setToolTip('Qexow');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function registerGlobalShortcut() {
  globalShortcut.register('Alt+Space', () => {
    if (mainWindow.isVisible()) {
      if (mainWindow.isFocused()) {
        mainWindow.hide();
      } else {
        mainWindow.focus();
      }
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
      
      const targetPath = getPathFromArgs(commandLine);
      if (targetPath) {
        console.log(`[Electron Main] Sending open-path via IPC to frontend: ${targetPath}`);
        mainWindow.webContents.send('open-path', targetPath);
      }
    }
  });

  app.whenReady().then(async () => {
    const statePath = path.join(os.homedir(), '.codex', 'window_state.json');
    let state = { width: 1200, height: 800 };
    try {
      const raw = await fs.readFile(statePath, 'utf-8');
      state = JSON.parse(raw);
    } catch (err) {}

    let port = 3000;
    if (process.env.NODE_ENV !== 'development') {
      port = await getFreePort(3000);
    }

    // Parse path arguments on boot
    const initialPath = getPathFromArgs(process.argv);
    let initialWorkspace = null;
    let initialFile = null;
    if (initialPath) {
      try {
        const stats = await fs.stat(initialPath);
        if (stats.isFile()) {
          initialWorkspace = path.dirname(initialPath);
          initialFile = initialPath;
        } else if (stats.isDirectory()) {
          initialWorkspace = initialPath;
        }
      } catch (_) {}
    }

    // Register Windows context menu
    await registerContextMenu();

    // Inject workspace/file context into process.env before starting server in-process
    if (initialWorkspace) process.env.INITIAL_WORKSPACE = initialWorkspace;
    if (initialFile) process.env.INITIAL_FILE = initialFile;
    process.env.PORT = String(port);

    // Start Express server in-process (works in packaged EXE — no external node needed)
    await startServer(port);
    console.log(`[Electron Main] In-process Express server started on port ${port}`);

    createWindow(port, state);
    await createTray();
    registerGlobalShortcut();
    setupAutoUpdater();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow(port, state);
      }
    });
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// IPC handler to execute the codex CLI (kept for backward compatibility)
let activeCodexProcess = null;

ipcMain.on('codex-exec', (event, { prompt, sessionUuid }) => {
  console.log(`Executing codex for prompt: ${prompt} with session: ${sessionUuid}`);

  activeCodexProcess = spawn('codex', ['exec', prompt, '--session', sessionUuid, '--json'], {
    shell: true,
    windowsHide: true
  });

  const rl = readline.createInterface({
    input: activeCodexProcess.stdout,
    terminal: false
  });

  rl.on('line', (line) => {
    try {
      if (line.trim()) {
        const data = JSON.parse(line);
        event.sender.send('codex-exec-reply', data);
      }
    } catch (e) {
      console.error('Failed to parse codex json:', line);
      event.sender.send('codex-exec-reply', { type: 'message', content: line + '\n' });
    }
  });

  activeCodexProcess.stderr.on('data', (data) => {
    console.error(`Codex stderr: ${data}`);
  });

  activeCodexProcess.on('close', (code) => {
    console.log(`Codex process exited with code ${code}`);
    activeCodexProcess = null;
    event.sender.send('codex-exec-end');
  });

  activeCodexProcess.on('error', (err) => {
    console.error('Failed to start codex process:', err);
    event.sender.send('codex-exec-reply', {
      type: 'message',
      content: `\n\n> **Error**: Could not launch codex CLI. Make sure it is installed and in your PATH.\nDetails: ${err.message}`
    });
    event.sender.send('codex-exec-end');
    activeCodexProcess = null;
  });
});

ipcMain.on('codex-exec-approve', (event) => {
  if (activeCodexProcess && activeCodexProcess.stdin) {
    console.log('Sending approval to codex stdin');
    activeCodexProcess.stdin.write('y\n');
  }
});

ipcMain.handle('codex-get-sessions', async () => {
  const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
  try {
    const files = await fs.readdir(sessionsDir);
    const sessions = [];
    for (const file of files) {
      if (file.endsWith('.json')) {
        const content = await fs.readFile(path.join(sessionsDir, file), 'utf-8');
        try {
          const parsed = JSON.parse(content);
          sessions.push({
            uuid: file.replace('.json', ''),
            title: parsed.title || 'Untitled Session',
            updatedAt: parsed.updatedAt || Date.now()
          });
        } catch(e) {
          // ignore corrupted session file
        }
      }
    }
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (err) {
    console.error('Failed to read sessions:', err.message);
    return [];
  }
});

ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.on('window-fullscreen', () => {
  if (mainWindow) {
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
  }
});
