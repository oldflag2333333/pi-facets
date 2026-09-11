# Facets

A Pi extension for reusable capability profiles and delegating self-contained work to a fresh child Pi without sharing either session's full conversation.

The Parent and Child communicate through a deliberately narrow protocol:

- Parent → Child: messages through `talk`, plus explicit closure
- Child → Parent: messages through `talk`
- never exposed by the extension: transcript, thinking blocks, tool history, or session files

Facets requires a supported interactive Child surface. Herdr is currently the only surface adapter; future adapters may include tmux. Every Child opens in a labeled Herdr background tab and remains open until the Parent calls `close_child` or the user closes the tab manually.

> Status: early development MVP. The protocol and file channel are implemented; real-Herdr compatibility still needs end-to-end testing.

## Why the launch is asynchronous

`create_child` returns after the Child launches. Parent and Child then exchange asynchronous `talk` messages. Facets wakes the Parent whenever a Child sends a message.

## Parent context

Parent-only orchestration rules can be written in:

```text
~/.pi/agent/facets/PARENT.md                 # global
<cwd-or-ancestor>/.pi/facets/PARENT.md       # trusted project hierarchy
```

Facets appends non-empty files to the Parent Pi system prompt in global-to-nearest order. Project files are discovered by walking from the Parent Pi working directory to the filesystem root, and are loaded only when project resources are trusted. `PARENT.md` is never loaded by delegated children, so use it for delegation policy such as work the Parent must route to a specific profile. Keep shared project rules in `AGENTS.md` and keep each profile focused on the selected child's capabilities and execution boundaries.

Changes take effect after `/reload`.

## Startup profiles

Facets does not ship built-in profiles. Profiles are user-owned JSON files loaded from:

```text
~/.pi/agent/facets/profiles/*.json                 # global
<cwd-or-ancestor>/.pi/facets/profiles/*.json        # trusted project hierarchy
```

Facets walks from the Parent Pi working directory to the filesystem root. A profile closer to the current working directory overrides a same-named ancestor profile, and any trusted project profile overrides a same-named global profile. This lets a Pi started under `project/workspace/` use profiles defined at `project/.pi/facets/profiles/`. The file name must match `name`:

```json
{
  "version": 1,
  "name": "reviewer",
  "description": "Read-only code review",
  "model": "anthropic/claude-sonnet-4-5",
  "thinkingLevel": "high",
  "sessionPersistence": "persistent",
  "tools": ["read", "grep", "find", "ls"],
  "skills": ["code-review"],
  "instructions": "Review only; do not modify files."
}
```

`thinkingLevel` is passed to Pi rather than constrained by a Facets-owned enum. `sessionPersistence` is `ephemeral` by default or `persistent`: ephemeral conversations remain in memory only, while persistent conversations are saved by Pi. Both remain open until the Parent calls `close_child` or the user closes the Herdr tab. Skill entries may be standard skill names or paths relative to the profile file. Named project skills are also resolved from the Parent Pi working directory and its ancestors; explicit skill paths remain relative to the profile file. Selecting a skill in a profile is an explicit capability choice, so Facets makes it model-visible even when its source declares `disable-model-invocation: true`; the source is not modified, and relative skill assets remain available through a private runtime mirror. Valid profile names, scope, and descriptions are injected into the Parent Pi system context only as a capability catalog, so it can select a profile without calling a discovery tool; Parent routing policy belongs in `PARENT.md`. Users can still run `/profiles` for diagnostics; profiles cannot be switched inside a running session.

Starting Pi without `--profile` preserves Pi's existing model, thinking, tools, and skills. A selected profile replaces the active tool list exactly; include `create_child`, `talk`, `close_child`, and `list_child` in an orchestrator profile when those controls should remain available. To opt into a startup profile:

```bash
pi --profile reviewer
```

For strict skill selection in a directly started Pi, also pass `--no-skills`; Facets contributes only the selected profile's skill paths. Delegated children always use `--no-skills` plus the resolved profile skills.

For delegated children, Facets resolves every non-built-in profile tool through Pi's canonical `sourceInfo.path` and loads only the installed extensions that own those tools. It does not inherit unrelated ambient extensions. In-memory SDK tools without a loadable extension path are rejected before launch.

## Tools

### Parent Pi

- `create_child` — launch a fresh child with a self-contained task and explicit profile
- `talk` — send one message to an existing Child
- `close_child` — stop active work if needed and close the child session
- `list_child` — list open Child sessions; never returns transcripts

### Child Pi

- `talk` — send one message to the Parent and end the current turn

Child mode is selected internally with `PI_FACETS_ROLE=child`. Nested delegation is intentionally disabled in the MVP.

## Context boundary

Children launch with:

- a Herdr tab; no headless fallback is available
- `--no-session` for ephemeral profiles; persistent profiles use a normal saved Pi session
- `--no-extensions -e <Facets>` so unrelated ambient extensions are not inherited
- a fresh initial prompt rather than a parent session fork
- an explicit tool allowlist

A child receives the configured profile tools plus the mandatory `talk` protocol tool. The parent resolves the profile once and stores that immutable launch snapshot in the channel manifest, so later config edits cannot change an already-running child.

The Parent TUI renders each launch with the selected profile plus its configured tool and skill names; long capability lists are compacted. It otherwise receives only compact lifecycle notices. Child `talk` messages are injected transiently with Pi's `context` event for the Parent turn that handles them; they are not rendered as Child transcripts.

This is a protocol boundary, not an operating-system sandbox. A child with shell access runs as the same OS user and may be able to access files outside the project. A future hardened adapter should run write-capable children in a container or restricted worktree environment.

## Herdr lifecycle

The Herdr adapter performs:

1. `herdr tab create` with a label such as `↳ pi · Review auth`
2. `herdr agent start ... --kind pi` in the new tab's root pane and wait for idle readiness
3. explicitly load Herdr's installed Pi lifecycle integration when available
4. submit the task through `herdr agent prompt` so Herdr observes the working transition
5. continue communication through the private file channel, not terminal scraping
6. keep the tab open until `close_child` or manual closure

The adapter requires a current Herdr release that supports `tab create` and `agent start --kind`. If Herdr is unavailable, `create_child` fails instead of falling back to a non-interactive process.

### Hide/show Facets subagents

The companion plugin under `herdr-plugin/` marks Facets subagents as hidden in Herdr's Agents panel by default and exposes show/hide/toggle actions:

```bash
herdr plugin link /absolute/path/to/facets/herdr-plugin
herdr plugin action invoke facets.agent-visibility.hide-subagents
herdr plugin action invoke facets.agent-visibility.toggle-subagents
```

This is a global flat-list filter, not per-parent tree expansion. It changes only the built-in Agents view; `agent list`, lifecycle state, notifications, and attention counts remain unchanged. See [`herdr-plugin/README.md`](herdr-plugin/README.md) for the optional keybinding.

## File channel

Runtime data lives under:

```text
$XDG_RUNTIME_DIR/pi-facets-<uid>/<parent-session>/<run-id>/
├── manifest.json
├── to-parent/
├── to-child/
├── close.json
└── closed.json
```

Directories use mode `0700`, files use `0600`, writes use atomic rename, and every payload carries a random capability token plus exact parent/run identity. A polling transport is used initially for portability and reload recovery.

## Install for development

```bash
npm install
npm run check
pi -e ./src/index.ts
```

Or register the local package:

```bash
pi install ./
```

Then restart Pi or run `/reload`.

## Example

Ask the parent Pi:

```text
Delegate a read-only child to review the authentication refresh flow. Give its Herdr tab the title "Review auth".
```

Equivalent model-facing call:

```json
{
  "title": "Review auth",
  "task": "Review the authentication refresh flow. Return concrete risks with file and symbol references.",
  "profile": "reviewer",
  "adapter": "auto"
}
```

## Current limitations

- no built-in profiles; every delegated child requires an explicit global or trusted-project profile
- custom profile tools must already be registered in the parent Pi so Facets can resolve their owning extension; in-memory SDK tools cannot be recreated in delegated children
- maximum four open Child sessions
- no nested children
- no worktree adapter yet
- no OS-level sandbox
- Parent shutdown and `/reload` preserve open Child sessions and channels
- a graceful manual close of a persistent Herdr tab is reported back and releases its retained channel; hard crashes still rely on timeout/manual cleanup
- hard Herdr or Child crashes without graceful shutdown require manual cleanup
- each `talk` message is bounded to 1 MiB

## Planned next steps

1. fake-Herdr adapter integration tests
2. real Herdr end-to-end test for create → talk → talk → close
3. tmux surface adapter
4. worktree-backed write mode
5. external adapter registration API
6. optional hardened/container launcher
