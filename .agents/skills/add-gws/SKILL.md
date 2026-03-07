---
name: add-gws
description: Add Google Workspace CLI (gws) MCP integration with OAuth profile support (Gmail/Calendar/Drive).
---

# Add GWS Integration

This skill adds Google Workspace CLI MCP support to NanoClaw so agents can use Gmail, Calendar, and Drive through an OAuth profile.

## What This Adds

- Installs `@googleworkspace/cli` in the agent container image
- Mounts host GWS OAuth config (`~/.config/gws` by default) into containers
- Passes GWS-related environment variables into container runtime
- Registers a `gws` MCP server in the in-container Codex config
- Documents optional GWS env vars in `.env.example`

## Files Modified

- `src/container-runner.ts`
- `container/agent-runner/src/index.ts`
- `container/Dockerfile`
- `.env.example`

## Apply

```bash
npx tsx scripts/apply-skill.ts .agents/skills/add-gws
```

## OAuth Setup

Run on host (outside container):

```bash
gws auth login
gws auth list
```

Then set profile in `.env` (optional but recommended):

```bash
GOOGLE_WORKSPACE_CLI_ACCOUNT=default
# Optional service list for MCP exposure:
# GWS_MCP_SERVICES=gmail,calendar,drive
# Optional: set 0 to disable:
# NANOCLAW_ENABLE_GWS_MCP=1
# Optional custom config path if not ~/.config/gws
# GWS_CONFIG_DIR=~/.config/gws
```

## Rebuild + Restart

```bash
npm run build
./container/build.sh
# Linux
systemctl --user restart nanoclaw
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Quick Verification

```bash
docker run --rm --entrypoint gws nanoclaw-agent:latest --version
```

From a chat message, ask NanoClaw to perform a small Gmail/Calendar read operation to confirm MCP wiring.
