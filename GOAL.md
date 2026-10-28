# bopencut goal

**From script to finished video, with AI doing most of the work and a human in full control, on one shared timeline.**

## Workflow

```
  script → 1. AI drafts → 2. human edits → 3. AI refines → export
             ↑                 ↑              |             |
             |                 └──────────────┴─────────────┘ (repeat until done)
             |                                ↓
             └──── read in the next draft ── 4. AI records preferences
```

1. **AI drafts the entire video from a script.** Aim for about 75% complete, including voice-over, captions, footage, motion graphics, and transitions. Everything is an editable element, not a locked video.
2. **The human edits directly.** Move, trim, and resize on the timeline and in the preview; add their own PNGs, GIFs, or footage.
3. **The human asks AI to refine specific parts.** For example, "this transition is lacking" or "this motion graphic is empty". AI reads the current state, including human edits, and changes only that part. The result can be undone in one step and does not overwrite human edits.
4. **AI learns from human edits.** Every human edit to an AI-created item is logged (what changed and its previous and new values). AI summarizes these as preference rules, such as "always raise captions by about 40 px" or "shorten meme clips by about 0.4 s". A new rule is written only when the same pattern appears **at least 3 times**, with evidence. The human may edit or delete it. AI must read these rules before the next draft so the same edits need not be repeated.

Preferences have two levels:
- **General**, for all projects: `PREFERENCES.md` in the folder specified by `AGENT_PREFS`.
- **Per project/channel:** `PREFERENCES.md` in `AGENT_WORKSPACE`.

These are private and are not stored in this public repository. The repository contains only the mechanism.

## Feature filter

New features are implemented only if they make one of the steps above **faster or better**. If it is unclear which step benefits, the feature is deferred.

- Project-specific details (a particular scene or channel style) do not belong in this repository. bopencut contains only general capabilities: primitives, presets, and agent workflows.
- Real scenes may be used for testing, but they are test material, not features.

## Stages

A stage is complete when its **Done when** criteria are met and tested directly in the editor.

| # | Stage | Steps supported | Status | Done when |
|---|---|---|---|---|
| ? | **Folder storage** | 1, 2, 3, 4 | Done (#7) | Projects and media are stored in a local folder, open in another browser, and old browser projects are safely copied |
| 0 | Agent bridge: draft import, timeline sync, draft set/add/delete | 1, 3 | Done (#1) | AI adds, changes, and deletes items in the open project; one Undo reverses everything |
| 1 | **Timeline notes + AI frame viewing** | 3 | Done (#4) | The human marks a time range/item with a note; AI reads it and can capture any frame |
| 1b | **Edit log + preferences** | 4 → 1 | Done (#2) | Human edits to AI items are logged in `edits/<projectId>.jsonl`; AI writes preference rules from recurring patterns, and the next draft uses them |
| 2 | **Motion graphics building blocks:** icons (Iconify), lines/arrows/paths, groups, draw progress | 1, 3 | Done (#6); partial leftovers: `drawProgress` for stroke icons, group transforms with animated members untested | AI builds a scene from icons and shapes; each part can be dragged and resized in the preview |
| 3 | **Lively motion + transitions:** easing, bounce, stagger, appear/move/disappear presets, transitions between clips | 1, 3 | Planned | The stage 2 scene moves without looking stiff; the human can change presets per element |
| 4 | **Before/after:** ghost of another state + path in preview | 2 | Planned | Animation start and end positions are visible and can be dragged directly |
| 5 | **Depth:** shadows, gradients, parallax, camera (zoom/pan) | 1 | Planned | The scene has depth without rendering outside the editor |
| 6 | **3D:** 3D model and text elements (Three.js), rendered per frame | 1 | Done (#5); 3D text, material color, and loading placeholder later | 3D models look identical in preview and export; position/rotation can be keyframed |
| 7 | **Script → generic draft:** draft format from script + voice-over independent of a specific project | 1 | Planned | A new script becomes a draft in the editor without project-specific code |
| 8 | **Ready for local AI:** one-command install, prompt for footage folder and create `.env.local`, and start server; step-by-step video-editing agent playbook; generic agent CLI (status / draft / frames / notes / preferences); apply drafts server-side to disk projects without an open browser; script → draft with stage 7 | 1, 3, 4 | Planned | A fresh clone, one command, and a local AI pointed at `AGENTS.md` produce a first draft from a script and footage folder |
| — | **Preview quality:** Full / ½ / ¼ | 2 | Done (#8) | Preview quality is selectable without reducing export or agent frame quality |
| — | **Compound clips:** many layers as one clip referencing a nested scene; double-click to edit inside | 1, 2, 3 | Done: A foundation (#13: data model, rendering, audio, create/ungroup commands); B timeline UI (#14: create/break apart shortcuts and menu, double-click to enter, breadcrumb, thumbnails, rename, deep-copy duplicate/paste); C agent path (snapshot of nested content with root-time intervals and addresses, draft ops inside compounds, `group`/`ungroup`/`compound` ops, one Undo across scenes, bundle compounds, nested edit log) | Foundation, timeline UI, and agent path are complete |

## Later

- Lottie (ready-made animation)
- Convert old Manim scenes → primitives
- Shape morph A → B, data charts
- Voice recording in the editor
