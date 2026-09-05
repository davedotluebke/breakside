@AGENTS.md

# Claude Code notes

Everything that matters is in AGENTS.md above. What follows is specific to Claude Code and its tools.

## Memory

The per-project memory directory is a cache of pointers, not a knowledge store. If something is worth remembering next session, write it into a repo file (engineering: `docs/dev-notes/` or ARCHITECTURE.md; production: `../breakside-ops`) and leave a one-line memory entry saying where. Do not accumulate multi-page project memories. `../breakside-ops/scripts/mirror-claude-memory.sh` backs the directory up; run it after a session that changed memory materially.

## Previewing a worktree

`preview_start({name})` resolves `.claude/launch.json` from the primary working directory (the main checkout), not the worktree, and `dev-server.sh` serves the directory containing the script. A relative script path in a launch config therefore always serves `main`. To preview a worktree, add a config entry whose `runtimeExecutable` is the absolute worktree script path and whose port is worktree-specific, then confirm with a `curl` for a file only the branch has. `.claude/launch.json` is gitignored (a shared entry needs `git add -f`); never flag its changes, and remove your entry at cleanup.

Cheap verification tricks: `?testMode=true` on localhost skips the auth redirect; app screens can be driven from the console via `await import('/teams/<module>.js')` with a synthetic game object. More in the recovered notes under `docs/dev-notes/` as they land.

## Shell quirks

- The Bash tool's cwd can silently reset to the primary working directory between calls. Absolute paths for every git command, every script, every redirect. Prefer the Write/Edit tools for file changes.
- Claude Code Desktop strips PATH to `/usr/bin:/bin:/usr/sbin:/sbin`; scripts that need `aws` or Homebrew tools source `~/.zshenv` first.
- `ssh breakside '<cmd>'` works from the Bash tool. Reading `/etc/breakside/env`, even redacted, trips the permission classifier; do not try.

## Agents and skills

Do not spawn subagents unless asked. When a session's work is done, remove its worktree and stop its dev servers without being asked, and keep the branch.
