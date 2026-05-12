# Claude Code Preview

Render [Claude Code](https://docs.claude.com/claude-code) responses with proper LaTeX math, code highlighting, and markdown formatting — directly from VS Code's integrated terminal.

When you press `Cmd+K V` (or `Ctrl+K V` on Linux/Windows) in a terminal running `claude`, the latest response opens as a markdown preview beside the terminal. The preview auto-refreshes after every new response.

## Features

- **No setup.** Install the extension and it just works alongside Claude Code. No shell hooks, no config files to edit.
- **Math rendering.** Inline `$...$` and display `$$...$$` LaTeX expressions render via VS Code's built-in KaTeX support.
- **Per-session previews.** The extension finds *which* session belongs to the focused terminal by walking its process tree. Parallel sessions in the same project show their own previews — no collisions.
- **Two open modes.** Open to the side (`Cmd+K V`) or in the current pane (`Cmd+Shift+V`), mirroring the built-in markdown preview keybindings.

## Requirements

- [Claude Code](https://docs.claude.com/claude-code) installed and used in a terminal (any terminal — VS Code's integrated terminal works best).
- macOS or Linux for precise per-session resolution. Windows users get the most-recently-updated session as a fallback.

## Usage

1. Open a terminal in VS Code and run `claude`.
2. Send a message.
3. Press `Cmd+K V` with the terminal focused.

The preview opens beside the terminal. Each subsequent response updates it automatically.

The commands are also available in the Command Palette:

- **Claude Code Preview: Open Latest Response to the Side**
- **Claude Code Preview: Open Latest Response**

## How it works

The extension watches Claude Code's transcript files at `~/.claude/projects/**/*.jsonl`. When a transcript changes, it extracts the latest assistant response and writes it to the extension's private storage. The preview command resolves which session belongs to your focused terminal (via process-tree walking and Claude Code's `~/.claude/sessions/<pid>.json` registry) and opens the corresponding markdown file.

If precise resolution fails (e.g. on Windows or when `pgrep` is unavailable), the command falls back to the most-recently-updated session.

## Troubleshooting

Logs are written to the **Claude Code Preview** output channel: `View → Output → Claude Code Preview`. If the preview doesn't open:

- Confirm `~/.claude/projects/` exists and contains `.jsonl` transcript files.
- Check that the terminal you focus is running `claude` (not a parent shell or `tmux` wrapper).
- Reload the window after install: `Cmd+Shift+P → Developer: Reload Window`.

## License

[MIT](LICENSE)
