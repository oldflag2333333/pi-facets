# Facets

A Pi extension for reusable capability profiles and delegating self-contained work to a fresh child Pi without sharing either session's full conversation.

The parent and child communicate through a deliberately narrow protocol:

- parent → child: initial task, answers to child questions, cancellation
- child → parent: blocking questions and one bounded final result
- never exposed by the extension: transcript, thinking blocks, tool history, or session files

When Pi runs inside [Herdr](https://herdr.dev), each child opens in a labeled background tab and the tab closes automatically when the task reaches a terminal state. Outside Herdr, the extension falls back to a headless Pi process.

> Status: early development MVP. The protocol and file channel are implemented; real-Herdr compatibility still needs end-to-end testing.

## Why the launch is asynchronous

`delegate_pi` returns after the child launches. A synchronous parent tool that waited for completion would deadlock when the child needed the parent to answer a question. The extension instead wakes the parent session when a question or final result arrives.

## Startup profiles

Facets does not ship built-in profiles. Profiles are user-owned JSON files loaded from:

```text
~/.pi/agent/facets/profiles/*.json       # global
<project>/.pi/facets/profiles/*.json     # trusted project
```

A trusted project profile overrides a same-named global profile. The file name must match `name`:

```json
{
  "version": 1,
  "name": "reviewer",
  "description": "Read-only code review",
  "model": "anthropic/claude-sonnet-4-5",
  "thinkingLevel": "high",
  "tools": ["read", "grep", "find", "ls"],
  "skills": ["code-review"],
  "instructions": "Review only; do not modify files."
}
```

`thinkingLevel` is passed to Pi rather than constrained by a Facets-owned enum. Skill entries may be standard skill names or paths relative to the profile file. Valid profile names, scope, and descriptions are injected into the Parent Pi system context at startup, so it can select a profile without calling a discovery tool. Users can still run `/profiles` for diagnostics; profiles cannot be switched inside a running session.

Starting Pi without `--profile` preserves Pi's existing model, thinking, tools, and skills. A selected profile replaces the active tool list exactly; include `delegate_pi`, `reply_child`, `cancel_child`, and `list_children` in an orchestrator profile when those controls should remain available. To opt into a startup profile:

```bash
pi --profile reviewer
```

For strict skill selection in a directly started Pi, also pass `--no-skills`; Facets contributes only the selected profile's skill paths. Delegated children always use `--no-skills` plus the resolved profile skills.

For delegated children, Facets resolves every non-built-in profile tool through Pi's canonical `sourceInfo.path` and loads only the installed extensions that own those tools. It does not inherit unrelated ambient extensions. In-memory SDK tools without a loadable extension path are rejected before launch.

## Tools

### Parent Pi

- `delegate_pi` — launch a fresh child with a self-contained task and explicit profile
- `reply_child` — answer one exact pending child question
- `cancel_child` — cancel a child and close its surface
- `list_children` — list bounded status metadata; never returns transcripts

### Child Pi

- `ask_parent` — ask one blocking question and wait for the corresponding answer
- `return_to_parent` — submit one final bounded result

Child mode is selected internally with `PI_FACETS_ROLE=child`. Nested delegation is intentionally disabled in the MVP.

## Context boundary

Children launch with:

- `--no-session` so their conversation is memory-only
- `--no-extensions -e <Facets>` so unrelated ambient extensions are not inherited
- a fresh initial prompt rather than a parent session fork
- an explicit tool allowlist

A child receives the configured profile tools plus the mandatory `ask_parent` and `return_to_parent` protocol tools. The parent resolves the profile once and stores that immutable launch snapshot in the channel manifest, so later config edits cannot change an already-running child.

The parent TUI renders each launch with the selected profile plus its configured tool and skill names; long capability lists are compacted. It otherwise receives only compact lifecycle notices. Full question/result payloads are injected transiently with Pi's `context` event for the model turn that handles them; they are not rendered as child transcripts.

This is a protocol boundary, not an operating-system sandbox. A child with shell access runs as the same OS user and may be able to access files outside the project. A future hardened adapter should run write-capable children in a container or restricted worktree environment.

## Herdr lifecycle

The Herdr adapter performs:

1. `herdr tab create` with a label such as `↳ pi · Review auth`
2. `herdr agent start ... --kind pi` in the new tab's root pane and wait for idle readiness
3. explicitly load Herdr's installed Pi lifecycle integration when available
4. submit the task through `herdr agent prompt` so Herdr observes the working transition
5. continue communication through the private file channel, not terminal scraping
6. `herdr tab close` after final result/failure acknowledgement

The adapter requires a current Herdr release that supports `tab create` and `agent start --kind`.

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
├── requests/
├── replies/
├── result.json
└── cancel.json
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
- maximum four concurrent children
- no nested children
- no worktree adapter yet
- no OS-level sandbox
- parent shutdown cancels children; `/reload` preserves and restores channels
- Herdr failure/crash detection currently relies on the overall task deadline
- successful final results are bounded to 1 MiB; questions and answers to 64 KiB

## Planned next steps

1. fake-Herdr adapter integration tests
2. real Herdr end-to-end test for create → ask → reply → result → close
3. worktree-backed write mode
4. external adapter registration API
5. optional hardened/container launcher
