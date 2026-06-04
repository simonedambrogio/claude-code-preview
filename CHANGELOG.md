# Change Log

## 0.3.4 — 2026-06-04

- Fix keybindings on Windows/Linux: `Ctrl+K V` and `Ctrl+Shift+V` (previously bound to `cmd`, which maps to the Win/Meta key outside macOS).
- README revamp: animated demo GIF, quick-start section, and a keybindings table.

## 0.3.3 — 2026-05-12

- Extract the latest response from the focused session's transcript on demand when the preview is opened. Fixes two cases that previously fell through to another session's content: resuming an existing session before sending a new message, and opening the preview from a freshly-started session.
- When a session is identified but has no responses yet, show an explicit "no responses yet" message instead of falling back to the most recently updated `.md` from a different session.
- Refactor `extension.js` into clearly-grouped sections (extraction, storage, session resolution, preview resolution, commands) for readability.

## 0.3.2 — 2026-05-12

- Prefix the written markdown with a no-op HTML comment so responses that begin with `---` (horizontal rule) aren't mis-parsed as YAML frontmatter, which previously rendered the preview blank.

## 0.3.1 — 2026-05-12

- Force the markdown preview to refresh after writing a new response and after focusing an already-open preview. VS Code's built-in preview watcher misses external writes to paths outside the workspace, so the preview could keep rendering a stale response.

## 0.3.0 — 2026-05-11

Initial public release.

- Watches Claude Code transcripts at `~/.claude/projects/**/*.jsonl` and extracts the latest assistant response into per-session markdown files in the extension's storage.
- Command **Claude Code Preview: Open Latest Response to the Side** (`Cmd+K V` when a terminal is focused) opens the preview beside the terminal.
- Command **Claude Code Preview: Open Latest Response** (`Cmd+Shift+V` when a terminal is focused) opens the preview in the current pane.
- Precise session resolution: walks the focused terminal's process tree to find the running `claude` process and previews that session's response (so parallel sessions in the same project don't collide). Falls back to the most-recently-updated session if the walk can't resolve.
- Self-prunes stored markdown files older than 30 days.
- Diagnostic logging available in the **Claude Code Preview** output channel.
