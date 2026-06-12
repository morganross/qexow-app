import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import os from 'os';
import { spawn } from 'child_process';
import readline from 'readline';
import { watch } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static files from Vite build (disable caching for index.html)
app.use(express.static(path.join(__dirname, 'dist'), {
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

function getCodexPath() {
  if (process.env.CAM_CODEX_EXE) return process.env.CAM_CODEX_EXE;
  if (process.platform === 'win32') {
    const candidate = path.join(os.homedir(), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin', 'codex.exe');
    return candidate;
  }
  return 'codex';
}

function decodeJwt(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payload);
  } catch (err) {
    console.error('Failed to decode JWT:', err);
    return null;
  }
}

async function getAuthInfo() {
  const authFile = path.join(os.homedir(), '.codex', 'auth.json');
  try {
    const content = await fs.readFile(authFile, 'utf8');
    const auth = JSON.parse(content);
    if (auth) {
      if (auth.tokens && auth.tokens.id_token) {
        const decoded = decodeJwt(auth.tokens.id_token);
        if (decoded) {
          const authPayload = decoded['https://api.openai.com/auth'] || {};
          return {
            authenticated: true,
            name: decoded.name || 'User',
            email: decoded.email || '',
            plan: authPayload.chatgpt_plan_type || 'free',
            subscriptionActiveUntil: authPayload.chatgpt_subscription_active_until || null
          };
        }
      }
      if (auth.OPENAI_API_KEY) {
        return {
          authenticated: true,
          name: 'API Key User',
          email: 'API Key',
          plan: 'developer',
          subscriptionActiveUntil: null
        };
      }
    }
  } catch (err) {
    // File doesn't exist or is invalid
  }
  return { authenticated: false };
}

async function touchSession(uuid, prompt) {
  const sessionIndexFile = path.join(os.homedir(), '.codex', 'session_index.jsonl');
  try {
    let content = '';
    try {
      content = await fs.readFile(sessionIndexFile, 'utf-8');
    } catch (err) {
      // File doesn't exist yet
    }
    
    const lines = content.split('\n');
    const sessions = [];
    let found = false;
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.id === uuid) {
          parsed.updated_at = new Date().toISOString();
          if (prompt) {
            parsed.thread_name = prompt;
          }
          found = true;
        }
        sessions.push(parsed);
      } catch (e) {
        // ignore invalid lines
      }
    }
    
    if (!found) {
      sessions.push({
        id: uuid,
        thread_name: prompt || 'Untitled Session',
        updated_at: new Date().toISOString()
      });
    }
    
    // Write back all sessions
    const newContent = sessions.map(s => JSON.stringify(s)).join('\n') + '\n';
    await fs.writeFile(sessionIndexFile, newContent, 'utf-8');
    console.log(`[Server] Touched session ${uuid} in master index.`);
  } catch (err) {
    console.error('[Server] Failed to touch session in master index:', err);
  }
}

// API: Check Auth Status
app.get('/api/auth/status', async (req, res) => {
  const info = await getAuthInfo();
  res.json(info);
});

// API: Get Codex Quota
app.get('/api/quota', (req, res) => {
  const scriptPath = path.join(__dirname, 'get_quota.py');
  const proc = spawn('python', [scriptPath], { shell: false, windowsHide: true });
  let stdout = '';
  let stderr = '';

  proc.stdout.on('data', (d) => { stdout += d.toString(); });
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  proc.on('close', (code) => {
    if (code !== 0) {
      console.warn(`[Server] get_quota.py failed with code ${code}. Stderr: ${stderr}`);
      return res.json({
        success: false,
        fiveHourRemaining: 100,
        weeklyRemaining: 100,
        error: stderr || 'Execution failed'
      });
    }

    try {
      const parsed = JSON.parse(stdout.trim());
      if (parsed.success && parsed.data && parsed.data.rate_limits) {
        const limits = parsed.data.rate_limits;
        const fiveHourRemaining = Math.max(0, 100 - (limits.primary?.used_percent ?? 0));
        const weeklyRemaining = Math.max(0, 100 - (limits.secondary?.used_percent ?? 0));
        return res.json({
          success: true,
          fiveHourRemaining,
          weeklyRemaining,
          primaryResetSeconds: limits.primary?.reset_after_seconds ?? null,
          secondaryResetSeconds: limits.secondary?.reset_after_seconds ?? null
        });
      } else {
        return res.json({
          success: false,
          fiveHourRemaining: 100,
          weeklyRemaining: 100,
          error: parsed.error || 'Invalid rate limits data'
        });
      }
    } catch (err) {
      console.error('[Server] Failed to parse quota JSON output:', err);
      return res.json({
        success: false,
        fiveHourRemaining: 100,
        weeklyRemaining: 100,
        error: err.message
      });
    }
  });

  proc.on('error', (err) => {
    console.error('[Server] Failed to spawn get_quota.py:', err);
    res.json({
      success: false,
      fiveHourRemaining: 100,
      weeklyRemaining: 100,
      error: err.message
    });
  });
});

// API: Trigger OAuth Login
app.post('/api/auth/login', (req, res) => {
  const codexPath = getCodexPath();
  console.log(`Spawning ${codexPath} login --device-auth...`);
  const loginProc = spawn(codexPath, ['login', '--device-auth'], { shell: false, windowsHide: true });
  
  let output = '';
  let responded = false;

  loginProc.stdout.on('data', (data) => {
    output += data.toString();
    console.log(`Login stdout: ${data}`);
    
    const urlMatch = output.match(/https:\/\/auth\.openai\.com\/[^\s]*/);
    const codeMatch = output.match(/[A-Z0-9]{3,}-[A-Z0-9]{3,}/);
    
    if (urlMatch && codeMatch && !responded) {
      responded = true;
      res.json({ success: true, deviceCode: codeMatch[0], url: urlMatch[0] });
    }
  });

  loginProc.stderr.on('data', (data) => {
    console.error(`Login stderr: ${data}`);
  });

  loginProc.on('error', (err) => {
    console.error('Failed to spawn login process:', err);
    if (!responded) {
      responded = true;
      res.status(500).json({ error: 'Failed to start login process' });
    }
  });

  loginProc.on('close', (code) => {
    console.log(`Login process closed with code ${code}`);
    if (!responded) {
      responded = true;
      res.status(500).json({ error: 'Login process exited early' });
    }
  });
});

// API: Logout
app.post('/api/auth/logout', (req, res) => {
  const codexPath = getCodexPath();
  console.log(`Spawning ${codexPath} logout...`);
  const logoutProc = spawn(codexPath, ['logout'], { shell: false, windowsHide: true });
  
  logoutProc.on('close', (code) => {
    res.json({ success: code === 0 });
  });

  logoutProc.on('error', (err) => {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Failed to execute logout' });
  });
});

// Keep track of active codex processes by session UUID
const activeProcesses = new Map();

// Active workspaces directory and active workspace path
const QEXOW_MAIN_DIR = path.resolve(process.env.QEXOW_MAIN_DIR || path.join(os.homedir(), 'Qexow'));
const workspacesParentDir = QEXOW_MAIN_DIR;
let activeWorkspace = '';

async function initWorkspaces() {
  try {
    await fs.mkdir(QEXOW_MAIN_DIR, { recursive: true });
    console.log('[Server] Main workspaces directory:', QEXOW_MAIN_DIR);

    const entries = await fs.readdir(QEXOW_MAIN_DIR, { withFileTypes: true });
    let folders = entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .filter(name => !['node_modules', '.git', '__pycache__', 'dist', 'dist_electron', 'output'].includes(name));

    if (folders.length === 0) {
      const defaultWS = path.join(QEXOW_MAIN_DIR, 'default-workspace');
      await fs.mkdir(defaultWS, { recursive: true });
      folders = ['default-workspace'];
      console.log('[Server] Created default workspace at:', defaultWS);
    }

    if (process.env.INITIAL_WORKSPACE) {
      const resolvedInit = path.resolve(process.env.INITIAL_WORKSPACE);
      if (resolvedInit.startsWith(QEXOW_MAIN_DIR)) {
        activeWorkspace = resolvedInit;
      }
    }

    if (!activeWorkspace) {
      activeWorkspace = path.join(QEXOW_MAIN_DIR, folders[0]);
    }

    console.log('[Server] Active workspace set to:', activeWorkspace);
  } catch (err) {
    console.error('[Server] Failed to initialize workspaces:', err);
    activeWorkspace = path.join(QEXOW_MAIN_DIR, 'default-workspace');
  }
}


let initialFileToOpen = process.env.INITIAL_FILE ? path.resolve(process.env.INITIAL_FILE) : null;

// API: Get Startup Options (workspace + initialFile)
app.get('/api/startup-options', (req, res) => {
  res.json({
    workspace: activeWorkspace,
    initialFile: initialFileToOpen
  });
  initialFileToOpen = null; // Clear after first load
});

// API: Handle opening a file or directory path (used by IPC second-instance)
app.post('/api/open-path', async (req, res) => {
  const { path: targetPath } = req.body;
  if (!targetPath) return res.status(400).json({ error: 'Missing path parameter' });
  try {
    const stats = await fs.stat(targetPath);
    let workspaceDir = targetPath;
    let fileToOpen = null;
    
    if (stats.isFile()) {
      workspaceDir = path.dirname(targetPath);
      fileToOpen = targetPath;
    }
    
    activeWorkspace = path.resolve(workspaceDir);
    console.log('[Server] Workspace set to:', activeWorkspace);
    
    res.json({
      success: true,
      workspace: activeWorkspace,
      file: fileToOpen
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Get Workspace Name + root path
app.get('/api/workspace', (req, res) => {
  res.json({ name: path.basename(activeWorkspace), root: activeWorkspace });
});

// API: Set Workspace root path
app.post('/api/workspace', async (req, res) => {
  const { path: newPath } = req.body;
  if (!newPath) return res.status(400).json({ error: 'Missing path parameter' });
  try {
    const stats = await fs.stat(newPath);
    if (!stats.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }
    const resolvedPath = path.resolve(newPath);
    activeWorkspace = resolvedPath;
    console.log('[Server] Workspace set to:', activeWorkspace);
    res.json({ success: true, name: path.basename(activeWorkspace), root: activeWorkspace });
  } catch (err) {
    res.status(400).json({ error: `Invalid workspace path: ${err.message}` });
  }
});

// API: Get all sibling workspaces in the parent folder
app.get('/api/workspaces', async (req, res) => {
  try {
    const entries = await fs.readdir(workspacesParentDir, { withFileTypes: true });
    const folders = entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .filter(name => !['node_modules', '.git', '__pycache__', 'dist', 'dist_electron', 'output'].includes(name));
    res.json({
      workspaces: folders,
      active: path.basename(activeWorkspace),
      root: activeWorkspace,
      parent: workspacesParentDir
    });
  } catch (err) {
    console.error('[Server] Failed to list workspaces:', err);
    res.status(500).json({ error: 'Failed to list workspaces' });
  }
});

// API: Select a sibling workspace by name
app.post('/api/workspace/select', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Missing name parameter' });
  
  const resolvedPath = path.resolve(path.join(workspacesParentDir, name));
  if (!resolvedPath.startsWith(workspacesParentDir)) {
    return res.status(400).json({ error: 'Invalid workspace path' });
  }

  try {
    const stats = await fs.stat(resolvedPath);
    if (!stats.isDirectory()) {
      return res.status(400).json({ error: 'Selected workspace is not a directory' });
    }
    activeWorkspace = resolvedPath;
    console.log('[Server] Workspace set to:', activeWorkspace);
    res.json({ success: true, name: path.basename(activeWorkspace), root: activeWorkspace });
  } catch (err) {
    res.status(400).json({ error: `Invalid workspace name: ${err.message}` });
  }
});

// API: Create a new sibling workspace by name
app.post('/api/workspace/create', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Missing name parameter' });
  
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return res.status(400).json({ error: 'Workspace name contains invalid characters' });
  }

  const resolvedPath = path.resolve(path.join(workspacesParentDir, name));
  if (!resolvedPath.startsWith(workspacesParentDir)) {
    return res.status(400).json({ error: 'Invalid workspace path' });
  }

  try {
    await fs.mkdir(resolvedPath, { recursive: true });
    activeWorkspace = resolvedPath;
    console.log('[Server] Created and selected workspace:', activeWorkspace);
    res.json({ success: true, name: path.basename(activeWorkspace), root: activeWorkspace });
  } catch (err) {
    res.status(500).json({ error: `Failed to create workspace directory: ${err.message}` });
  }
});

// Helper for recursive file scanning
async function getFiles(dir, baseDir = '') {
  let results = [];
  try {
    const list = await fs.readdir(dir, { withFileTypes: true });
    for (const dirent of list) {
      if (dirent.name === 'node_modules' || dirent.name === '.git' || dirent.name === 'dist') continue;
      
      const relPath = path.posix.join(baseDir, dirent.name);
      if (dirent.isDirectory()) {
        const children = await getFiles(path.join(dir, dirent.name), relPath);
        results = results.concat(children);
      } else {
        results.push(relPath);
      }
    }
  } catch (err) {
    // Ignore errors for unreadable subdirs
  }
  return results;
}

// API: Get Workspace Files
app.get('/api/workspace/files', async (req, res) => {
  try {
    const files = await getFiles(activeWorkspace);
    res.json(files.slice(0, 50)); // limit to 50 for UI performance
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to read files' });
  }
});

// API: Trigger Background Build
app.post('/api/workspace/build', (req, res) => {
  console.log('Triggering background build...');
  const buildProc = spawn('npm', ['run', 'build'], {
    shell: true,
    cwd: activeWorkspace,
    windowsHide: true
  });

  buildProc.on('close', (code) => {
    console.log(`Background build exited with code ${code}`);
  });

  buildProc.on('error', (err) => {
    console.error('[Server] Failed to spawn background build process:', err);
  });

  res.json({ success: true, message: 'Build started in background' });
});

// API: Read a file from disk
app.get('/api/file', async (req, res) => {
  const { path: filePath } = req.query;
  if (!filePath) return res.status(400).json({ error: 'Missing path parameter' });
  try {
    const content = await fs.readFile(filePath, 'utf8');
    res.json({ success: true, content, path: filePath });
  } catch (err) {
    console.error('[Server] Failed to read file:', filePath, err);
    res.status(404).json({ error: `Cannot read file: ${err.message}` });
  }
});

// API: Write a file to disk
app.post('/api/file', async (req, res) => {
  const { path: filePath, content } = req.body;
  if (!filePath || content === undefined) {
    return res.status(400).json({ error: 'Missing path or content' });
  }
  try {
    await fs.writeFile(filePath, content, 'utf8');
    console.log('[Server] Saved file:', filePath);
    res.json({ success: true, path: filePath });
  } catch (err) {
    console.error('[Server] Failed to write file:', filePath, err);
    res.status(500).json({ error: `Cannot write file: ${err.message}` });
  }
});

// Helper to recursively find the rollout file for a session UUID
async function findSessionFile(dir, uuid) {
  try {
    const list = await fs.readdir(dir, { withFileTypes: true });
    for (const dirent of list) {
      const fullPath = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        const found = await findSessionFile(fullPath, uuid);
        if (found) return found;
      } else if (dirent.isFile() && dirent.name.endsWith(`${uuid}.jsonl`)) {
        return fullPath;
      }
    }
  } catch (err) {
    // ignore directory read errors
  }
  return null;
}

// API: Get historical sessions from master index
app.get('/api/sessions', async (req, res) => {
  const sessionIndexFile = path.join(os.homedir(), '.codex', 'session_index.jsonl');
  try {
    const content = await fs.readFile(sessionIndexFile, 'utf-8');
    const lines = content.split('\n');
    const sessionsMap = new Map();
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.id) {
          sessionsMap.set(parsed.id, {
            uuid: parsed.id,
            title: parsed.thread_name || 'Untitled Session',
            updatedAt: parsed.updated_at ? new Date(parsed.updated_at).getTime() : Date.now()
          });
        }
      } catch (e) {
        // ignore invalid lines
      }
    }
    
    const sessions = Array.from(sessionsMap.values()).map(s => ({
      ...s,
      isRunning: activeProcesses.has(s.uuid)
    }));
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    res.json(sessions.slice(0, 15));
  } catch (err) {
    console.error('Failed to read sessions index:', err);
    res.json([]);
  }
});

// API: Read chat history for a specific session UUID
app.get('/api/sessions/read', async (req, res) => {
  const { sessionUuid } = req.query;
  if (!sessionUuid) {
    return res.status(400).json({ error: 'Missing sessionUuid parameter' });
  }

  const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
  const sessionFile = await findSessionFile(sessionsDir, sessionUuid);
  if (!sessionFile) {
    return res.status(404).json({ error: `Session file not found for UUID: ${sessionUuid}` });
  }

  try {
    const content = await fs.readFile(sessionFile, 'utf-8');
    const lines = content.split('\n');
    const messages = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.type === 'response_item' && parsed.payload && parsed.payload.type === 'message') {
          const { role, content: payloadContent } = parsed.payload;
          
          // Only show user and assistant messages, skip developer / system messages
          if (role === 'user' || role === 'assistant') {
            let text = '';
            if (Array.isArray(payloadContent)) {
              for (const part of payloadContent) {
                if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
                  text += part.text || '';
                }
              }
            }
            
            // Skip context/agent instructions messages to keep UI clean
            if (text && !text.startsWith('# AGENTS.md')) {
              messages.push({
                role: role,
                content: [{ type: 'text', text: text }]
              });
            }
          }
        }
      } catch (e) {
        // ignore invalid lines
      }
    }
    res.json(messages);
  } catch (err) {
    console.error(`Failed to read rollout file: ${sessionFile}`, err);
    res.status(500).json({ error: 'Failed to read session history' });
  }
});

let cachedModels = null;

// API: Get available models from codex CLI
app.get('/api/models', (req, res) => {
  if (cachedModels) {
    return res.json(cachedModels);
  }

  const codexPath = getCodexPath();
  console.log(`Spawning ${codexPath} debug models...`);
  const proc = spawn(codexPath, ['debug', 'models'], { shell: false, windowsHide: true });
  let stdout = '';
  let stderr = '';

  proc.stdout.on('data', (d) => { stdout += d.toString(); });
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  proc.on('close', (code) => {
    if (code !== 0) {
      console.warn(`[Server] codex debug models failed with code ${code}. Stderr: ${stderr}`);
      const fallback = [
        { slug: "gpt-5.4-mini", display_name: "gpt-5.4-mini" },
        { slug: "gpt-5.5", display_name: "gpt-5.5" },
        { slug: "gpt-5.4", display_name: "gpt-5.4" },
        { slug: "gpt-5.3-codex-spark", display_name: "gpt-5.3-codex-spark" },
        { slug: "gpt-5.3-codex", display_name: "gpt-5.3-codex" },
        { slug: "gpt-5.2", display_name: "gpt-5.2" }
      ];
      return res.json(fallback);
    }

    try {
      const sanitized = stdout.replace(/^\uFEFF/, '').trim();
      const parsed = JSON.parse(sanitized);
      cachedModels = parsed.models || [];
      res.json(cachedModels);
    } catch (err) {
      console.error('[Server] Failed to parse models JSON output:', err);
      const fallback = [
        { slug: "gpt-5.4-mini", display_name: "gpt-5.4-mini" },
        { slug: "gpt-5.5", display_name: "gpt-5.5" },
        { slug: "gpt-5.4", display_name: "gpt-5.4" },
        { slug: "gpt-5.3-codex-spark", display_name: "gpt-5.3-codex-spark" },
        { slug: "gpt-5.3-codex", display_name: "gpt-5.3-codex" },
        { slug: "gpt-5.2", display_name: "gpt-5.2" }
      ];
      res.json(fallback);
    }
  });

  proc.on('error', (err) => {
    console.error('[Server] Failed to spawn codex debug models:', err);
    const fallback = [
      { slug: "gpt-5.4-mini", display_name: "gpt-5.4-mini" },
      { slug: "gpt-5.5", display_name: "gpt-5.5" },
      { slug: "gpt-5.4", display_name: "gpt-5.4" },
      { slug: "gpt-5.3-codex-spark", display_name: "gpt-5.3-codex-spark" },
      { slug: "gpt-5.3-codex", display_name: "gpt-5.3-codex" },
      { slug: "gpt-5.2", display_name: "gpt-5.2" }
    ];
    res.json(fallback);
  });
});

// API: Execute codex and stream JSONL via Server-Sent Events (SSE)
app.get('/api/exec', (req, res) => {
  const { prompt, sessionUuid, model, reasoning, speed } = req.query;
  
  if (!prompt || !sessionUuid) {
    return res.status(400).json({ error: 'Missing prompt or sessionUuid' });
  }

  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const codexPath = getCodexPath();
  const args = [];
  if (sessionUuid && sessionUuid !== 'new' && sessionUuid !== 'null' && sessionUuid !== 'undefined') {
    args.push('exec', 'resume', sessionUuid, prompt, '--json', '--skip-git-repo-check');
  } else {
    args.push('exec', prompt, '--json', '--skip-git-repo-check');
  }

  if (model) {
    args.push('--model', model);
  }

  if (reasoning && reasoning !== 'default') {
    args.push('-c', `model_reasoning_effort="${reasoning}"`);
  }

  if (speed && speed !== 'default') {
    args.push('-c', `service_tier="${speed}"`);
  }

  console.log(`Spawning ${codexPath} with args: ${JSON.stringify(args)}`);

  const codexProcess = spawn(codexPath, args, {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: activeWorkspace,
    windowsHide: true
  });
  // Immediately close stdin with EOF so Codex stops waiting for extra context input
  // and proceeds to process the prompt. Using 'ignore' causes Codex to exit code 1.
  codexProcess.stdin.end();

  activeProcesses.set(sessionUuid, codexProcess);

  let watcher;
  try {
    watcher = watch(activeWorkspace, { recursive: true }, async (eventType, filename) => {
      if (!filename) return;
      const normalized = filename.replace(/\\/g, '/');
      if (normalized.includes('node_modules') || normalized.includes('.git') || normalized.includes('dist') || normalized.includes('dist_electron')) return;
      
      const absolutePath = path.join(activeWorkspace, filename);
      try {
        const content = await fs.readFile(absolutePath, 'utf8');
        const lines = content.split(/\r?\n/);
        const diffLines = lines.map(l => `+ ${l}`);
        const diffEvent = {
          type: 'diff',
          file: path.basename(absolutePath),
          absolutePath: absolutePath,
          diffLines: diffLines
        };
        res.write(`data: ${JSON.stringify(diffEvent)}\n\n`);
        console.log(`[Watcher] Generated diff for ${absolutePath}`);
      } catch (err) {
        // Ignore read errors for temporary files
      }
    });
  } catch (err) {
    console.error('[Server] Failed to start fs watcher:', err);
  }

  const rl = readline.createInterface({
    input: codexProcess.stdout,
    terminal: false
  });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    // Filter out noisy process termination and stdin messages from output
    if (trimmed.startsWith('SUCCESS: The process with PID') ||
        trimmed.includes('has been terminated') ||
        trimmed.includes('Reading additional input from stdin') ||
        trimmed.startsWith('warning:')) {
      return;
    }

    try {
      const data = JSON.parse(trimmed);
      res.write(`data: ${JSON.stringify(data)}\n\n`);

      // Once we know the real thread_id, also track the process by that UUID
      // so that approval (and cancellation) work after the session ID is known.
      if (data.type === 'thread.started' && data.thread_id) {
        activeProcesses.set(data.thread_id, codexProcess);
        touchSession(data.thread_id, prompt).catch(err => {
          console.error('Failed to touch session:', err);
        });
      }

      // If it's a completed file_change, generate a diff event with absolutePath
      console.log('[Server] received event:', data.type, 'item:', data.item ? JSON.stringify(data.item) : 'none');
      if (data.type === 'item.completed' && data.item?.type === 'file_change') {
        console.log('[Server] file_change completed! changes:', JSON.stringify(data.item.changes));
        if (data.item.changes) {
          for (const change of data.item.changes) {
            if (change.kind === 'add' || change.kind === 'modify') {
              try {
                const content = await fs.readFile(change.path, 'utf8');
                const lines = content.split(/\r?\n/);
                const diffLines = lines.map(l => `+ ${l}`);
                const diffEvent = {
                  type: 'diff',
                  file: path.basename(change.path),
                  absolutePath: change.path,
                  diffLines: diffLines
                };
                res.write(`data: ${JSON.stringify(diffEvent)}\n\n`);
                console.log(`Generated diff for ${change.path}`);
              } catch (err) {
                console.error(`Failed to generate diff for ${change.path}:`, err);
              }
            }
          }
        }
      }

      // If it's a completed shell command, forward as terminal_output event
      if (data.type === 'item.completed' && data.item?.type === 'shell') {
        const shellItem = data.item;
        const termEvent = {
          type: 'terminal_output',
          command: shellItem.command || '',
          output: shellItem.output || shellItem.stdout || '',
          exit_code: shellItem.exit_code ?? null
        };
        res.write(`data: ${JSON.stringify(termEvent)}\n\n`);
      }
    } catch (e) {
      // Not JSON — send as raw message
      res.write(`data: ${JSON.stringify({ type: 'message', content: line + '\n' })}\n\n`);
    }
  });

  codexProcess.stderr.on('data', (data) => {
    console.error(`Codex stderr: ${data}`);
  });

  codexProcess.on('close', (code) => {
    console.log(`Codex process exited with code ${code}`);
    if (watcher) {
      watcher.close();
      console.log('[Watcher] Closed fs watcher on process close');
    }
    activeProcesses.delete(sessionUuid);
    res.write(`data: ${JSON.stringify({ type: 'end' })}\n\n`);
    res.end();
  });

  codexProcess.on('error', (err) => {
    console.error('Failed to start codex process:', err);
    if (watcher) {
      watcher.close();
      console.log('[Watcher] Closed fs watcher on process error');
    }
    res.write(`data: ${JSON.stringify({
      type: 'message',
      content: `\n\n> **Error**: Could not launch codex CLI.\nDetails: ${err.message}`
    })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'end' })}\n\n`);
    res.end();
  });

  // Client disconnected early
  req.on('close', () => {
    console.log('Client closed connection');
    if (watcher) {
      watcher.close();
      console.log('[Watcher] Closed fs watcher on client disconnect');
    }
  });
});

// API: Approve destructive command
app.post('/api/approve', (req, res) => {
  const { sessionUuid } = req.body;
  if (!sessionUuid) return res.status(400).json({ error: 'Missing sessionUuid' });

  const proc = activeProcesses.get(sessionUuid);
  if (proc && proc.stdin) {
    console.log(`Sending approval to codex stdin for session: ${sessionUuid}`);
    proc.stdin.write('y\n');
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'No active process found for this session.' });
  }
});

// Fallback to index.html for React Router / SPA (disable caching)
app.use((req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// Allow running standalone (node server.js) or imported by main.js
export async function startServer(port) {
  await initWorkspaces();
  const listenPort = port || PORT;
  return new Promise((resolve) => {
    app.listen(listenPort, () => {
      console.log(`Qexow App Server running on http://localhost:${listenPort}`);
      resolve(listenPort);
    });
  });
}

// When run directly (not imported), start immediately
if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  startServer(PORT);
}
