# Change Log

## 0.3.0 — 2026-05-11

Initial public release.

- Watches Claude Code transcripts at `~/.claude/projects/**/*.jsonl` and extracts the latest assistant response into per-session markdown files in the extension's storage.
- Command **Claude Code Preview: Open Latest Response to the Side** (`Cmd+K V` when a terminal is focused) opens the preview beside the terminal.
- Command **Claude Code Preview: Open Latest Response** (`Cmd+Shift+V` when a terminal is focused) opens the preview in the current pane.
- Precise session resolution: walks the focused terminal's process tree to find the running `claude` process and previews that session's response (so parallel sessions in the same project don't collide). Falls back to the most-recently-updated session if the walk can't resolve.
- Self-prunes stored markdown files older than 30 days.
- Diagnostic logging available in the **Claude Code Preview** output channel.
