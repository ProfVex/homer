# Homer

Autonomous agent loop powered by GitHub Issues. Orchestrates Claude Code, Codex, or any AI CLI to work through issues in parallel.

```
Terminal 1:  homer --repo myorg/app          # agent starts working
Terminal 2:  homer --repo myorg/app          # second agent, same repo
Terminal 3:  homer-watch --repo myorg/app    # live dashboard
```

Homer turns GitHub Issues into an autonomous work queue. Each issue is a task with acceptance criteria. Homer claims one, calls your AI CLI to implement it, verifies completion, and moves to the next. Multiple Homer instances coordinate through GitHub labels — no collisions, full parallel execution.

## Install

```bash
# npm (global)
npm install -g homer-cli

# or clone
git clone https://github.com/ProfVex/homer.git
cd homer && npm link
```

### Prerequisites

| Tool | Required | Install |
|------|----------|---------|
| `gh` | Yes | `brew install gh` then `gh auth login` |
| `jq` | Yes | `brew install jq` |
| `claude` | Default AI | [claude.ai/download](https://claude.ai/download) |
| `codex` | Alternative | `npm install -g @openai/codex` |
| `node` | For dashboard | v18+ (already installed if you use npm) |

## Quick Start

```bash
# 1. Plan — decompose a feature into issues
homer plan "Add user authentication with JWT tokens"

# 2. Check the board
homer status

# 3. Start working (picks issues, implements, closes)
homer

# 4. Watch (in another terminal)
homer-watch
```

## Commands

### `homer`

Starts the work loop. Picks the highest-priority ready issue, claims it, invokes your AI CLI, and closes it on success.

```bash
homer                              # auto-detect repo, use claude
homer --repo owner/repo            # explicit repo
homer --tool codex                 # use codex instead of claude
homer --max-iterations 5           # stop after 5 issues
homer --dry-run                    # preview without executing
```

### `homer plan <description>`

Uses your AI CLI to decompose a feature description into GitHub Issues with proper labels, acceptance criteria, and dependency links.

```bash
homer plan "Add real-time notifications with WebSocket"
homer plan "Refactor the API to use middleware pattern" --repo owner/repo
```

Each issue gets:
- Acceptance criteria (verifiable, not vague)
- Priority label (`priority:1` through `priority:5`)
- State label (`homer:ready` or `homer:blocked`)
- Dependencies (`Depends on: #1, #3`)

### `homer status`

Shows the issue board grouped by state:

```
 HOMER  myorg/app  13:42:05

 ████████████░░░░░░░░░░░░░ 3/10 (30%)
──────────────────────────────────────
 ⚡ IN PROGRESS (1)          │ ✓ READY (3)
   #4 P1 Create auth middleware │   #6 P2 Add login page
                                │   #7 P2 Add signup page
 ✗ BLOCKED (3)                  │   #8 P3 Password reset
   #9 P3 User dashboard        │
     └ waiting: #6, #7         │ ✓ DONE (3)
                                │   #1 DB schema
──────────────────────────────────────
 AGENTS  ⚡ a3f2→#4
```

### `homer sync`

Re-evaluates blocked issues. If all dependencies are closed, unblocks them.

```bash
homer sync                         # auto-detect repo
homer sync --repo owner/repo       # explicit repo
```

### `homer-watch`

Live terminal dashboard. Refreshes every 5 seconds. Zero dependencies (pure Node.js).

```bash
homer-watch                        # auto-detect repo
homer-watch --repo owner/repo      # explicit repo
homer-watch --interval 10          # refresh every 10s
```

Keys: `q` quit, `r` force refresh.

## How It Works

### Issue Labels (State Machine)

```
                    ┌─────────────┐
                    │ homer:ready │ ◄── created by `homer plan`
                    └──────┬──────┘
                           │ claimed by agent
                    ┌──────▼──────────┐
                    │ homer:in-progress│
                    └──────┬──────────┘
                  success/ │ \failure
          ┌───────────┐    │    ┌──────────────┐
          │ homer:done │    │    │ homer:failed │
          └───────────┘    │    └──────────────┘
                           │
                    ┌──────▼───────┐
                    │homer:blocked │ ◄── has unmet deps
                    └──────────────┘
```

### Multi-Agent Coordination

Multiple Homer instances can work the same repo simultaneously:

1. Agent A runs `homer` — claims issue #3 (labeled `homer:in-progress`)
2. Agent B runs `homer` — sees #3 is claimed, picks #4 instead
3. Both work in parallel on independent issues
4. When both finish, `homer sync` unblocks any issues that depended on #3 and #4

No database. No message queue. Just GitHub labels.

### AI Tool Integration

Homer calls your AI CLI via stdin pipe:

```bash
# Claude Code (default)
echo "$PROMPT" | claude --dangerously-skip-permissions --print

# OpenAI Codex
echo "$PROMPT" | codex --quiet
```

The prompt includes the issue title, body (acceptance criteria, dependencies, notes), and instructions to output `HOMER_DONE` or `HOMER_BLOCKED` as a completion signal.

To add a new AI tool, it just needs to:
1. Accept a prompt via stdin
2. Execute code changes
3. Output results to stdout

## Issue Format

When creating issues manually (or via `homer plan`), use this format:

```markdown
## Story
As a [user], I want [feature] so that [benefit].

## Acceptance Criteria
- [ ] Specific verifiable criterion
- [ ] Another criterion
- [ ] Lint/typecheck passes

## Dependencies
Depends on: #1, #3

## Notes
Implementation hints, file paths, context.
```

Labels: `homer`, `homer:ready` (or `homer:blocked`), `priority:N`

## Configuration

Homer is zero-config by default. Everything is controlled via CLI flags:

| Flag | Default | Description |
|------|---------|-------------|
| `--repo` | auto-detect | GitHub repo (owner/name) |
| `--tool` | `claude` | AI CLI to use |
| `--max-iterations` | `0` (unlimited) | Stop after N issues |
| `--label` | `homer` | Label prefix |
| `--dry-run` | `false` | Preview mode |

## vs Ralph

| | Ralph | Homer |
|---|---|---|
| Task store | `prd.json` flat file | GitHub Issues |
| Progress | `progress.txt` append log | Issue comments |
| Ordering | Linear priority | Dependency graph |
| Parallelism | Single session | Multi-agent |
| Visibility | Local to machine | Team-visible on GitHub |
| Memory | Amnesiac between iterations | Comments preserve context |
| Reuse | Stories die with branch | Issues persist, commentable |

## License

MIT
