const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// ---- Paths & constants ----

const TRANSCRIPTS_ROOT = path.join(os.homedir(), '.claude', 'projects');
const CLAUDE_SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const DEBOUNCE_MS = 500;
const PRUNE_DAYS = 30;

// Prevents a leading `---` in a response (horizontal rule) from being parsed
// as the opening fence of YAML frontmatter, which would render the preview
// blank.
const MD_PREFIX = '<!-- claude-code-preview -->\n\n';

let storageDir = null;
let outputChannel = null;
const debouncers = new Map();

function log(msg) {
  if (outputChannel) outputChannel.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

function mdPathForSession(sessionId) {
  return path.join(storageDir, `${sessionId}.md`);
}

// ---- Transcript → markdown extraction ----

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
      // Partial / malformed line during streaming — skip.
    }
  }

  // Walk backwards to find the latest "real" user turn — a string prompt, or
  // array content with at least one block that isn't a tool_result.
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

  return texts.length ? texts.join('\n\n') : null;
}

function writeExtractedResponse(transcriptPath) {
  const text = extractLastResponse(transcriptPath);
  if (!text) return false;
  const sessionId = path.basename(transcriptPath, '.jsonl');
  const outPath = mdPathForSession(sessionId);
  try {
    fs.writeFileSync(outPath, MD_PREFIX + text + '\n');
  } catch (err) {
    log(`write failed ${outPath}: ${err.message}`);
    return false;
  }
  // VS Code's preview watcher misses external writes to paths outside the
  // workspace, so nudge it to re-render.
  vscode.commands.executeCommand('markdown.preview.refresh').then(undefined, () => {});
  return true;
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

// ---- Storage maintenance ----

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

function mostRecentMdPath() {
  let entries;
  try {
    entries = fs.readdirSync(storageDir);
  } catch {
    return null;
  }
  let best = null;
  for (const f of entries) {
    if (!f.endsWith('.md')) continue;
    const full = path.join(storageDir, f);
    let mtime;
    try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
    if (!best || mtime > best.mtime) best = { full, mtime };
  }
  return best ? best.full : null;
}

// ---- Session resolution (focused terminal → sessionId → transcript) ----

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

async function activeSessionId() {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) return null;
  let shellPid;
  try { shellPid = await terminal.processId; } catch { return null; }
  if (!shellPid) return null;
  return sessionIdForShellPid(shellPid);
}

function findTranscriptForSession(sessionId) {
  let projects;
  try {
    projects = fs.readdirSync(TRANSCRIPTS_ROOT);
  } catch {
    return null;
  }
  for (const proj of projects) {
    const candidate = path.join(TRANSCRIPTS_ROOT, proj, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// ---- Preview target resolution ----
//
// Returns one of:
//   { kind: 'file', path }        — open this .md
//   { kind: 'empty', sessionId }  — focused terminal has a claude session
//                                   with no responses yet; do NOT fall back
//                                   to another session's .md
//   { kind: 'none' }              — no claude session in focus and no .md
//                                   files anywhere
//
// When a session is in focus we always do a fresh extraction from its
// transcript, which covers the resumed/cold-start case where the file
// watcher hasn't yet seen a change but prior responses live on disk.

async function resolvePreview() {
  const sessionId = await activeSessionId();
  if (sessionId) {
    const transcript = findTranscriptForSession(sessionId);
    if (transcript) writeExtractedResponse(transcript);

    const mdPath = mdPathForSession(sessionId);
    if (fs.existsSync(mdPath)) return { kind: 'file', path: mdPath };
    return { kind: 'empty', sessionId };
  }

  const recent = mostRecentMdPath();
  return recent ? { kind: 'file', path: recent } : { kind: 'none' };
}

// ---- Commands ----

async function openPreview(toSide) {
  const result = await resolvePreview();

  if (result.kind === 'empty') {
    vscode.window.showInformationMessage(
      'Claude Code Preview: this Claude session has no responses yet.'
    );
    return;
  }
  if (result.kind === 'none') {
    vscode.window.showInformationMessage(
      'Claude Code Preview: no response files yet. Send a message in your Claude Code terminal and try again.'
    );
    return;
  }

  const uri = vscode.Uri.file(result.path);
  const cmd = toSide ? 'markdown.showPreviewToSide' : 'markdown.showPreview';
  await vscode.commands.executeCommand(cmd, uri);
  // Focusing an already-open preview doesn't re-render — force it, in case
  // the .md changed since the last render and the watcher missed it.
  try { await vscode.commands.executeCommand('markdown.preview.refresh'); } catch {}
}

// ---- Activation ----

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

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodePreview.open', () => openPreview(true)),
    vscode.commands.registerCommand('claudeCodePreview.openCurrent', () => openPreview(false))
  );
}

function deactivate() {
  for (const t of debouncers.values()) clearTimeout(t);
  debouncers.clear();
}

module.exports = { activate, deactivate };
