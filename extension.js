const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const TRANSCRIPTS_ROOT = path.join(os.homedir(), '.claude', 'projects');
const CLAUDE_SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const DEBOUNCE_MS = 500;
const PRUNE_DAYS = 30;

let storageDir = null;
let outputChannel = null;
const debouncers = new Map();

function log(msg) {
  if (outputChannel) outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

function extractLastResponse(transcriptPath) {
  let content;
  try {
    content = fs.readFileSync(transcriptPath, 'utf8');
  } catch (err) {
    log(`extract: read failed ${transcriptPath}: ${err.message}`);
    return null;
  }

  const entries = [];
  for (const line of content.split('\n')) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Partial or malformed line during streaming — skip.
    }
  }

  let lastUserIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type !== 'user') continue;
    const c = e.message && e.message.content;
    if (typeof c === 'string') { lastUserIdx = i; break; }
    if (Array.isArray(c) && c.some((b) => b && b.type !== 'tool_result')) {
      lastUserIdx = i;
      break;
    }
  }

  const texts = [];
  for (let i = lastUserIdx + 1; i < entries.length; i++) {
    const e = entries[i];
    if (e.type !== 'assistant') continue;
    const content = e.message && e.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b && b.type === 'text' && typeof b.text === 'string') {
        texts.push(b.text);
      }
    }
  }

  if (texts.length === 0) return null;
  return texts.join('\n\n');
}

function writeExtractedResponse(transcriptPath) {
  const text = extractLastResponse(transcriptPath);
  if (!text) return;
  const sessionId = path.basename(transcriptPath, '.jsonl');
  const outPath = path.join(storageDir, `${sessionId}.md`);
  try {
    fs.writeFileSync(outPath, text + '\n');
  } catch (err) {
    log(`write failed ${outPath}: ${err.message}`);
  }
}

function scheduleExtraction(transcriptPath) {
  const existing = debouncers.get(transcriptPath);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    debouncers.delete(transcriptPath);
    writeExtractedResponse(transcriptPath);
  }, DEBOUNCE_MS);
  debouncers.set(transcriptPath, timer);
}

function pruneOldResponses() {
  let entries;
  try {
    entries = fs.readdirSync(storageDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - PRUNE_DAYS * 24 * 60 * 60 * 1000;
  for (const f of entries) {
    if (!f.endsWith('.md')) continue;
    const full = path.join(storageDir, f);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    } catch {}
  }
}

function walkDescendantPids(rootPid) {
  const result = [];
  const queue = [rootPid];
  const seen = new Set();
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    let out;
    try {
      out = execSync(`pgrep -P ${pid}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      continue;
    }
    for (const line of out.split('\n')) {
      const n = parseInt(line.trim(), 10);
      if (!Number.isNaN(n) && !seen.has(n)) {
        result.push(n);
        queue.push(n);
      }
    }
  }
  return result;
}

function sessionIdForShellPid(shellPid) {
  let descendants;
  try {
    descendants = walkDescendantPids(shellPid);
  } catch (err) {
    log(`pid walk failed: ${err.message}`);
    return null;
  }
  for (const pid of descendants) {
    const file = path.join(CLAUDE_SESSIONS_DIR, `${pid}.json`);
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && data.sessionId) return data.sessionId;
    } catch {}
  }
  return null;
}

async function resolveTargetMarkdown() {
  const terminal = vscode.window.activeTerminal;
  if (terminal) {
    let shellPid;
    try { shellPid = await terminal.processId; } catch {}
    if (shellPid) {
      const sessionId = sessionIdForShellPid(shellPid);
      if (sessionId) {
        const candidate = path.join(storageDir, `${sessionId}.md`);
        if (fs.existsSync(candidate)) return candidate;
        log(`precise: session ${sessionId} resolved but no .md written yet`);
      }
    }
  }

  let entries;
  try {
    entries = fs.readdirSync(storageDir);
  } catch {
    return null;
  }
  const candidates = entries
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const full = path.join(storageDir, f);
      try { return { full, mtime: fs.statSync(full).mtimeMs }; } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  return candidates.length ? candidates[0].full : null;
}

function activate(context) {
  outputChannel = vscode.window.createOutputChannel('Claude Code Preview');
  context.subscriptions.push(outputChannel);

  storageDir = context.globalStorageUri.fsPath;
  try {
    fs.mkdirSync(storageDir, { recursive: true });
  } catch (err) {
    log(`mkdir storage failed: ${err.message}`);
  }

  pruneOldResponses();

  if (fs.existsSync(TRANSCRIPTS_ROOT)) {
    const pattern = new vscode.RelativePattern(TRANSCRIPTS_ROOT, '**/*.jsonl');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const handler = (uri) => scheduleExtraction(uri.fsPath);
    watcher.onDidChange(handler);
    watcher.onDidCreate(handler);
    context.subscriptions.push(watcher);
    log(`watching ${TRANSCRIPTS_ROOT}`);
  } else {
    log(`transcripts dir not found: ${TRANSCRIPTS_ROOT}`);
  }

  const open = async (toSide) => {
    const target = await resolveTargetMarkdown();
    if (!target) {
      vscode.window.showInformationMessage(
        'Claude Code Preview: no response files yet. Send a message in your Claude Code terminal and try again.'
      );
      return;
    }
    const uri = vscode.Uri.file(target);
    const cmd = toSide ? 'markdown.showPreviewToSide' : 'markdown.showPreview';
    await vscode.commands.executeCommand(cmd, uri);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodePreview.open', () => open(true)),
    vscode.commands.registerCommand('claudeCodePreview.openCurrent', () => open(false))
  );
}

function deactivate() {
  for (const t of debouncers.values()) clearTimeout(t);
  debouncers.clear();
}

module.exports = { activate, deactivate };
