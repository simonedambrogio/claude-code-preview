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

// ---- Session display names (sessionId → markdown filename) ----
//
// Preview tab titles come from the filename, so responses are stored under a
// human-readable name derived from the session: the `summary` in the
// project's sessions-index.json when available, otherwise the first user
// prompt, otherwise the session id. A name is assigned once per session and
// never changed afterwards — renaming under an open preview tab breaks it.

let sessionNames = null;

function sessionNamesPath() {
  return path.join(storageDir, 'sessions.json');
}

function loadSessionNames() {
  if (!sessionNames) {
    try {
      sessionNames = JSON.parse(fs.readFileSync(sessionNamesPath(), 'utf8'));
    } catch {
      sessionNames = {};
    }
  }
  return sessionNames;
}

function saveSessionNames() {
  try {
    fs.writeFileSync(sessionNamesPath(), JSON.stringify(sessionNames, null, 2));
  } catch (err) {
    log(`save session names failed: ${err.message}`);
  }
}

function sanitizeTitle(raw) {
  const cleaned = raw
    .replace(/<[^>]*>/g, ' ') // markup-ish tags (e.g. <ide_selection>…)
    .replace(/[\\/:*?"<>|]/g, ' ') // filename-unsafe characters
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, ''); // no hidden files, no Windows trailing dots
  if (!cleaned) return null;
  if (cleaned.length <= 50) return cleaned;
  const cut = cleaned.slice(0, 50);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 25 ? cut.slice(0, lastSpace) : cut).trim();
}

function summaryFromIndex(transcriptPath, sessionId) {
  const indexPath = path.join(path.dirname(transcriptPath), 'sessions-index.json');
  try {
    const data = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const entry = (data.entries || []).find((e) => e && e.sessionId === sessionId);
    if (entry && typeof entry.summary === 'string' && entry.summary.trim()) {
      return entry.summary;
    }
  } catch {}
  return null;
}

function firstUserPrompt(entries) {
  for (const e of entries) {
    if (e.type !== 'user') continue;
    const c = e.message && e.message.content;
    if (typeof c === 'string' && c.trim()) return c;
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          return b.text;
        }
      }
    }
  }
  return null;
}

// Returns the session's md path, or null if no name has been assigned yet.
function mdPathForSession(sessionId) {
  const names = loadSessionNames();
  return names[sessionId] ? path.join(storageDir, names[sessionId]) : null;
}

function assignMdPath(sessionId, transcriptPath, entries) {
  const existing = mdPathForSession(sessionId);
  if (existing) return existing;
  const title = summaryFromIndex(transcriptPath, sessionId) || firstUserPrompt(entries);
  const base = (title && sanitizeTitle(title)) || sessionId;
  let filename = `${base}.md`;
  const names = loadSessionNames();
  // Titles aren't unique across sessions — disambiguate with a short id.
  if (Object.values(names).includes(filename)) {
    filename = `${base} — ${sessionId.slice(0, 8)}.md`;
  }
  names[sessionId] = filename;
  saveSessionNames();
  return path.join(storageDir, filename);
}

// ---- Transcript → markdown extraction ----

function readTranscriptEntries(transcriptPath) {
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
  return entries;
}

// Splits the transcript at every "real" user turn — a string prompt, or
// array content with at least one block that isn't a tool_result — and
// returns the assistant text of each turn, oldest first. Sidechain entries
// (subagents) are skipped.
function extractResponses(entries) {
  const responses = [];
  let current = [];
  for (const e of entries) {
    if (e.isSidechain) continue;
    if (e.type === 'user') {
      const c = e.message && e.message.content;
      const isRealUserTurn =
        typeof c === 'string' ||
        (Array.isArray(c) && c.some((b) => b && b.type !== 'tool_result'));
      if (isRealUserTurn && current.length) {
        responses.push(current.join('\n\n'));
        current = [];
      }
      continue;
    }
    if (e.type !== 'assistant') continue;
    const content = e.message && e.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b && b.type === 'text' && typeof b.text === 'string') {
        current.push(b.text);
      }
    }
  }
  if (current.length) responses.push(current.join('\n\n'));
  return responses;
}

// ---- Response history navigation ----

// offset 0 = latest response, 1 = one older, … (mirrors `/copy N` counting
// from the end). Reset to 0 whenever the transcript changes.
const responseOffsets = new Map();

function writeResponseAtOffset(transcriptPath, offset) {
  const entries = readTranscriptEntries(transcriptPath);
  if (!entries) return false;
  const responses = extractResponses(entries);
  if (!responses.length) return false;

  const sessionId = path.basename(transcriptPath, '.jsonl');
  const clamped = Math.min(Math.max(offset, 0), responses.length - 1);
  responseOffsets.set(sessionId, clamped);

  const index = responses.length - 1 - clamped;
  let text = responses[index];
  // Indicator only while browsing history, so the latest response stays
  // clean for copying.
  if (clamped > 0) {
    text =
      `> *Response ${index + 1} of ${responses.length} — ` +
      `\`Cmd/Ctrl+←\` older · \`Cmd/Ctrl+→\` newer*\n\n` + text;
  }

  const outPath = assignMdPath(sessionId, transcriptPath, entries);
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

// A new transcript change snaps the preview back to the latest response.
function writeExtractedResponse(transcriptPath) {
  return writeResponseAtOffset(transcriptPath, 0);
}

async function navigateResponse(delta) {
  const sessionId = focusedPreviewSessionId || (await activeSessionId());
  if (!sessionId) return;
  const transcript = findTranscriptForSession(sessionId);
  if (!transcript) return;
  const current = responseOffsets.get(sessionId) || 0;
  writeResponseAtOffset(transcript, current + delta);
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

  // Drop name-map entries whose markdown file is gone.
  const names = loadSessionNames();
  let changed = false;
  for (const [sid, fname] of Object.entries(names)) {
    if (!fs.existsSync(path.join(storageDir, fname))) {
      delete names[sid];
      changed = true;
    }
  }
  if (changed) saveSessionNames();
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

// ---- Focused-preview tracking ----
//
// VS Code has no "is this markdown preview focused" context, but the active
// tab is observable. When it is a markdown-preview webview whose label ends
// with one of our session filenames, expose a context key so the navigation
// keybindings only fire there, and remember the session for the commands.

let focusedPreviewSessionId = null;

function updatePreviewFocusContext() {
  const group = vscode.window.tabGroups.activeTabGroup;
  const tab = group && group.activeTab;
  let sessionId = null;
  if (
    tab &&
    tab.input instanceof vscode.TabInputWebview &&
    /markdown/.test(tab.input.viewType)
  ) {
    for (const [sid, fname] of Object.entries(loadSessionNames())) {
      if (tab.label.endsWith(fname)) {
        sessionId = sid;
        break;
      }
    }
  }
  focusedPreviewSessionId = sessionId;
  vscode.commands
    .executeCommand('setContext', 'claudeCodePreview.previewFocused', !!sessionId)
    .then(undefined, () => {});
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
    if (mdPath && fs.existsSync(mdPath)) return { kind: 'file', path: mdPath };
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
    vscode.commands.registerCommand('claudeCodePreview.openCurrent', () => openPreview(false)),
    vscode.commands.registerCommand('claudeCodePreview.olderResponse', () => navigateResponse(1)),
    vscode.commands.registerCommand('claudeCodePreview.newerResponse', () => navigateResponse(-1)),
    vscode.window.tabGroups.onDidChangeTabs(updatePreviewFocusContext),
    vscode.window.tabGroups.onDidChangeTabGroups(updatePreviewFocusContext)
  );
  updatePreviewFocusContext();
}

function deactivate() {
  for (const t of debouncers.values()) clearTimeout(t);
  debouncers.clear();
}

module.exports = { activate, deactivate };
