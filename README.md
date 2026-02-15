# Homer

> *"D'oh!" — Homer Simpson*

<!-- homer_banner.png — add your own Homer-themed banner here -->

Multi-agent TUI orchestrator for AI coding tools. Wraps Claude Code, Codex, Aider, or any AI CLI in a polished terminal dashboard with parallel agents, task management, and automated verification.

Named after Homer Simpson — he may not look like he's working, but somehow things get done. Homer orchestrates your AI agents so you don't have to.

```
┌──────────────────────────────────────────────────────────┐
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓│                                         │
│▓ ◆ HOMER     ▓│  ┌──────────────────────────────────┐   │
│▓  active (1)  ▓│  │ ⬢ agent-1 · #42 ● working       │   │
│▓              ▓│  │                                  │   │
│▓ ⬢ Claude    ▓│  │   [live terminal output]         │   │
│▓   v2.1.15   ▓│  │                                  │   │
│▓              ▓│  │                                  │   │
│▓ STORIES 2/5  ▓│  └──────────────────────────────────┘   │
│▓ ████████░░░  ▓│                                         │
│▓ ✓ Auth       ▓│                                         │
│▓ ● Dashboard  ▓│                                         │
│▓              ▓│                                         │
│▓ AGENTS       ▓│                                         │
│▓ ▸● agent-1   ▓│                                         │
│▓  ○ agent-2   ▓│                                         │
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓│─────────────────────────────────────────│
│ 01:23 │ ● TYPING ^A=nav  ^N=agent  ^G=join │ 2/5        │
│ + agent  j join  t tool  1-2 switch  q quit              │
└──────────────────────────────────────────────────────────┘
```

## Features

- **Multi-agent terminals** — Run up to 5 AI agents side-by-side in split panes
- **Tool-agnostic** — Claude Code, Codex CLI, Aider, Cline, or any CLI tool
- **Task sources** — Load from `prd.json` (Ralph-compatible) or GitHub Issues
- **Verification loop** — Agents signal `HOMER_DONE`, Homer runs typecheck/lint/tests, re-injects errors if they fail
- **Session persistence** — Quit and resume where you left off
- **Project index** — Scans your codebase on startup so agents don't waste time re-scanning
- **Agent coordination** — Agents leave notes for each other; shared context prevents duplicated work

## Install

```bash
# npm (global)
npm install -g homer-cli

# or clone
git clone https://github.com/ProfVex/homer.git
cd homer && npm install && npm link
```

### Prerequisites

| Tool | Required | Install |
|------|----------|---------|
| Node.js | v18+ | [nodejs.org](https://nodejs.org) |
| `gh` CLI | For GitHub issues | `brew install gh` then `gh auth login` |
| At least one AI CLI | Yes | See below |

**Supported AI CLIs** (install at least one):

| Tool | Install |
|------|---------|
| Claude Code | [claude.ai/download](https://claude.ai/download) |
| Codex CLI | `npm install -g @openai/codex` |
| Aider | `pip install aider-chat` |
| Cline | `npm install -g cline` |

## Quick Start

```bash
# Open TUI — auto-detects tools, shows picker if multiple installed
homer

# Use a specific tool
homer --tool claude

# Auto-mode: works through stories/issues without manual intervention
homer --auto

# Resume a previous session
homer --resume
```

## How It Works

1. **Homer scans your project** on startup — builds an index of exports, dependencies, and conventions
2. **You pick a task** — from a `prd.json` file (user stories) or GitHub Issues
3. **Homer spawns an AI agent** in a real PTY terminal with project context injected
4. **Agent works autonomously** — you can watch, type into it, or let it run
5. **Agent signals `HOMER_DONE`** when it thinks it's finished
6. **Homer runs verification** — typecheck, lint, tests (auto-detected from your project)
7. **If checks fail** — errors are re-injected into the agent to fix (tight feedback loop)
8. **If checks pass** — story is marked complete, next task is picked up

This verification loop is inspired by [Ralph](https://github.com/ProfVex/ralph) — the agent can't claim "done" until the code actually passes.

## Keyboard Shortcuts

**Nav mode** (default — press `Ctrl+A` to enter):

| Key | Action |
|-----|--------|
| `Enter` | Spawn agent / focus terminal |
| `+` | Spawn another agent |
| `j` | Join agent (picker overlay) |
| `i` | Pick a task (stories + issues) |
| `t` | Change AI tool |
| `Tab` | Cycle between agent panes |
| `1-9` | Switch to agent N |
| `c` | Rebuild project index |
| `w` | Show workflow history |
| `r` | Refresh sidebar |
| `q` / `Ctrl+C` | Quit |

**Terminal mode** (typing into an agent — press `Ctrl+A` to exit):

| Key | Action |
|-----|--------|
| `Ctrl+A` | Exit to nav mode |
| `Ctrl+N` | Spawn new agent (without leaving terminal) |
| `Ctrl+G` | Join/switch agent (without leaving terminal) |

## CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--tool NAME` | auto-detect | AI CLI to use (`claude`, `codex`, `aider`, `cline`, `openrouter`) |
| `--model MODEL` | — | Model selection (for aider/openrouter) |
| `--repo OWNER/REPO` | auto-detect | GitHub repo for issues |
| `--auto` | off | Auto-claim and work through tasks |
| `--agents N` | 5 | Max concurrent agents |
| `--label PREFIX` | `homer` | Label prefix for GitHub issues |
| `--permission-mode MODE` | `bypassPermissions` | Claude Code permission mode |
| `--resume` | — | Auto-resume previous session |
| `--fresh` | — | Start clean, ignore previous session |
| `-h, --help` | — | Show help |

## Task Sources

Homer supports two task sources that can be used together:

### 1. PRD Stories (`prd.json`)

Drop a `prd.json` in your project root with user stories. Homer picks them up automatically.

```json
{
  "project": "MyApp",
  "branchName": "homer/feature",
  "userStories": [
    {
      "id": "US-001",
      "title": "Add user login",
      "description": "As a user, I want to log in with email and password.",
      "acceptanceCriteria": ["Login form renders", "JWT token stored", "Typecheck passes"],
      "priority": 1,
      "passes": false,
      "notes": ""
    }
  ]
}
```

### 2. GitHub Issues

With `--repo` (or auto-detected), Homer shows all open issues. You pick one, and it's sent to the agent with full context.

Issues with checkbox acceptance criteria are parsed automatically. Label issues with `homer:ready` to use auto-mode.

## Project Context

Homer creates a `.homer/` directory in your project with:

- `context.md` — Auto-generated index of exports, dependencies, and recent agent work
- `progress.txt` — Log of completed stories

This directory is auto-added to `.gitignore`. Agents read `context.md` on startup to avoid re-scanning your codebase.

Global data lives in `~/.homer/`:

- `sessions/` — Session snapshots for resume
- `context/{repo}/` — Project index, agent notes, shared context

## Verification

Homer auto-detects verification commands from your project:

| Project Type | Detected Commands |
|-------------|-------------------|
| TypeScript | `npm run typecheck` or `npx tsc --noEmit` |
| ESLint | `npm run lint` |
| Jest/Vitest | `npm test` |
| Python + mypy | `mypy .` |
| Python + pytest | `pytest` |
| Python + ruff | `ruff check .` |
| Makefile | `make check` |

When an agent signals `HOMER_DONE`, all detected commands run. If any fail, errors are fed back to the agent.

## Platform Support

- **macOS** — Full support
- **Linux** — Full support
- **Windows** — Not supported (node-pty platform limitation)

## Ralph

<!-- ralph_banner.png — add your own Ralph-themed banner here -->

> *"I'm helping!"* — Ralph Wiggum

Homer's verification loop is directly inspired by **Ralph** — an autonomous agent system that enforces a tight feedback loop: agents can't claim "done" until tests actually pass.

Ralph uses `prd.json` files (Product Requirement Documents) to define user stories with acceptance criteria. Homer reads the same format, making them fully compatible.

<!-- Link to Ralph repo when published -->
<!-- See [Ralph on GitHub](https://github.com/ProfVex/ralph) for the standalone agent runner. -->

## Credits

- **Homer** and **Ralph** are named after characters from *The Simpsons*, created by Matt Groening. All Simpsons references are used as fan tributes — this project has no affiliation with 20th Century Fox or The Simpsons.
- Built with [blessed](https://github.com/chjj/blessed) for the TUI and [node-pty](https://github.com/microsoft/node-pty) for real terminal emulation.
- Designed to wrap [Claude Code](https://claude.ai), [Codex CLI](https://github.com/openai/codex), [Aider](https://github.com/paul-gauthier/aider), and other AI coding tools.
- Created by [@ProfVex](https://github.com/ProfVex).

## License

MIT
