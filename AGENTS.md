# NanoClaw

A project that provides a personal Codex-based assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Codex runtime running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/SOUL.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Important File Tree (Developer Map)

Use this as the default map when making code changes; open only the relevant subset.

```text
src/
  index.ts                  # Main loop/orchestrator
  router.ts                 # Inbound->agent->outbound routing
  ipc.ts                    # IPC task/message handling + auth checks
  task-scheduler.ts         # Scheduled task execution
  container-runner.ts       # Container lifecycle, mounts, env
  db.ts                     # SQLite schema + data access
  channels/
    registry.ts             # Channel registration/bootstrap
    *.ts                    # Installed channel integrations (discord, telegram, etc.)

container/
  Dockerfile                # Agent container image
  build.sh                  # Container rebuild entrypoint
  agent-runner/src/index.ts # In-container runtime execution path
  skills/                   # Shared runtime instructions/tools

setup/
  index.ts                  # Guided setup entrypoint
  environment.ts            # Environment/runtime checks
  register.ts               # Main group registration + SOUL updates
  verify.ts                 # Post-setup validation

skills-engine/
  index.ts                  # Skill apply/replay/rebase entrypoints
  replay.ts                 # Replay applied skills from base
  uninstall.ts              # Skill uninstall + replay flow
  rebase.ts                 # Flatten/rebase skill state into base

scripts/
  apply-skill.ts            # Apply one skill package
  rebuild-nanoclaw.sh       # Stop/build/(optional container rebuild)/start
  validate-all-skills.ts    # CI drift/typecheck validation
  fix-skill-drift.ts        # Auto-merge skill modify/ drift

groups/
  global/SOUL.md            # Optional shared notes (not auto-injected)
  {group}/SOUL.md           # Per-group behavior/memory

docs/
  REQUIREMENTS.md           # Product/architecture intent
  skills-architecture.md    # Skills system design (apply/replay/rebase model)
  SPEC.md                   # Runtime behavior + dataflow/spec details
  SECURITY.md               # Isolation model and threat assumptions
  DEBUG_CHECKLIST.md        # Operational debugging playbook
```

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```


## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
