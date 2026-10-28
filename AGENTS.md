# Agents.md

## Mode 1 — Editing videos (default)

**bopencut is a place to edit video alongside a human.** You will usually be asked to **create or refine a video**, not change bopencut code. Change code only when the owner explicitly asks (see the rules below).

Available capabilities:
- **Shared timeline:** you assemble a draft (voice-over, footage, captions, motion graphics, transitions), the human edits directly in the UI, then you refine the requested parts. All your changes can be undone and do not overwrite human edits.
- **Editable motion graphics** (in place of locked Manim videos): icons, rectangles, circles, lines, arrows, and paths with a draw effect; object groups; keyframes for position, size, rotation, and opacity. Each part is a separate element the human can move and resize in the preview.
- **3D models** (GLB/glTF) that can be rotated and animated with keyframes.
- **Live preview:** the human checks results in the editor without rendering. Small changes need only a draft, not an export. Export MP4 only for the final result.
- **Eyes for you:** request a frame image at any time to check your work before reporting.
- **Notes and preferences:** read human timeline notes and `PREFERENCES.md` before drafting; reply to or resolve notes after addressing them.

See [`AGENT.md`](AGENT.md) for the workflow (drafts, notes, frames, preferences, and data locations). Footage and assets are in a separate folder specified by `AGENT_FILES_ROOT`, not in this repository; do not modify source files there.

## Mode 2 — Changing bopencut's code (only when explicitly asked)

- **This repository is public.** Do not include AI attribution anywhere (no AI co-author lines or AI model or vendor names), or the owner's project, client, channel, laptop path, or private data in code, comments, documents, or commit messages. Project-specific details stay outside the repository; bopencut contains only general capabilities (see the feature filter in `GOAL.md`).
- One stage = one branch + one PR to `main`. Do not push directly to `main`.
- CI must pass: in `apps/web`, run `bun run build`, `bunx tsc --noEmit -p .`, and `bun test`. Do not suppress type errors (`@ts-ignore`, `any` to avoid errors, `ignoreBuildErrors`) or delete tests to pass.
- Test in a browser only through browser tab automation. Do not use desktop controls (mouse, keyboard, screen screenshots, or system clipboard) on the owner's machine.
- Do not commit project data or agent workspace folders (`workspace/`, `BOPENCUT_DATA`, `AGENT_WORKSPACE`).
- Follow the surrounding code style. **All code, comments, docs and commit messages are in English; only README.md is in Indonesian.**
- The agent workspace protocol (bundles, drafts, notes, frames, preferences) is in `AGENT.md`; update it when the format changes.

## OpenCut architecture notes

Bopencut-specific code, including the agent bridge, storage server, and renderer additions, lives in TypeScript under `apps/web`. The Rust direction below is upstream's long-term plan, not a rule for bopencut changes.


An ongoing migration is moving all business logic into `rust/`. Each app under `apps/` is a UI shell — it owns rendering, interaction, and platform-specific concerns, but never owns logic. The UI framework for any given app is a replaceable detail.

### `rust/`

The single source of truth for all non-UI code. Everything platform-agnostic belongs here: no components, no hooks, no framework imports.

### `apps/`

Each app is a frontend that calls into Rust. Logic is never duplicated between apps — only UI is, because each platform may use an entirely different framework and language to build it.

- `web/` — Next.js
- `desktop/` — GPUI

## Web

### React

- Read components before using them. They may already apply classes, which affects what you need to pass and how to override them.

