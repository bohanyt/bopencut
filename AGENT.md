# bopencut — shared human + AI workspace

**bopencut** is a fork of [OpenCut](https://github.com/opencut-app/opencut-classic) by the OpenCut team (MIT license; see `LICENSE`). All credit for the base editor belongs to them; this fork adds an agent bridge and a few small improvements. It can be used for any video project. Humans edit in the UI as usual; agents (AI/scripts) can read and modify the same timeline without overwriting human edits.

## Running
```
bun install
cd apps/web && bunx next dev --turbopack -H 127.0.0.1 -p 3000
```
No account or database is required. Projects and media are stored in `<repo>/workspace/projects/<projectId>/`: `project.json`, `media/<mediaId>.<ext>`, and media metadata. Git ignores `workspace/`. Old browser projects and their media are automatically copied the first time they are opened; the browser copies are not deleted. Deleting a disk project does not trigger another copy.

## Agent workspace (`apps/web/.env.local`)
```
BOPENCUT_DATA=C:\path\to\data-folder         # default: <repo>/workspace
AGENT_WORKSPACE=C:\path\to\workspace     # default: <repo>/workspace
AGENT_FILES_ROOT=C:\path\to\asset-root        # default: = AGENT_WORKSPACE
```
BOPENCUT_DATA can point outside the repository; do not commit private data. Use one workspace per job; change the environment and restart the server to switch projects.

| File in AGENT_WORKSPACE | Direction | Contents |
|---|---|---|
| `bundle/bundle.json` | agent → editor | complete draft; open **/agent** → *Import draft* = new project |
| `project.json`, `sync/<projectId>.json` | editor → agent | current timeline after each edit (0.8 s debounce) |
| `draft.json` | agent → editor | per-item operations; applied in ~2 s as **one Undo step** |
| `draft-result.json` | editor → agent | result per operation (items deleted by the human are skipped) |

**bundle.json** (any `schema`): `name,width,height`, `assets:[{key,path(relative to AGENT_FILES_ROOT),type:image|video|audio,name}]`, `main:[el]`, `audio:[el]`, `overlay:[{name,type:"video"|"effect",elements:[el]}]` (index 0 = topmost). `el`: `agent_id,name,start,duration,trimStart` (seconds), `asset` or `effect`+`effectParams`, `params` (e.g. `transform.positionX/Y` = pixels from canvas center, `opacity`, `volume`), `size:[w,h]` (display size in pixels), `keyframes:[{path:"opacity"|"scale"|param,time,value}]`.

**draft.json**: `{schema:"opencut-agent-draft-1", rev, label, projectId?, ops:[{op:"set", match:{agentId}|{id}, start?, duration?, trimStart?, params?}, {op:"delete", match:…}, {op:"add", track:{name, type?:"video"|"audio"|"effect", index?}, element:el}]}`. For `add`, `el.asset` is an object `{path,type,name}` (not a bundle key); an existing track with that name is reused, otherwise one is created (overlays are inserted at `index`). Exact names take precedence; `Main` and the legacy `Utama` are aliases in both directions. Existing saved track names are not renamed. The entire draft is one Undo; changed/added items are selected immediately.

Browser console: `window.agent.snapshot()`, `window.agent.applyDraft(draft)`.

## Other changes from upstream
- Dropped GIFs are converted to silent MP4 (local ffmpeg) so they animate.
- Fix: preview interruption on effect tracks (`effect_pass_groups`).
- Removed: React Scan, Next dev indicator, databuddy analytics.

## Preferences

Before assembling a bundle or draft, read the general `PREFERENCES.md` in `AGENT_PREFS` and the project/channel `AGENT_WORKSPACE/PREFERENCES.md`, if present. Both files are private and are not stored in the repository. The editor does not read them.

Human edits are logged in `AGENT_WORKSPACE/edits/<projectId>.jsonl`. Run `bun apps/web/scripts/edits-summary.ts <AGENT_WORKSPACE> [other workspace...]` (add `--json` for JSON, including `ruleCandidate`). Write a new rule only when a pattern appears at least 3 times. Each rule includes the rule, evidence with counts and projects, and date; the human may edit or delete it. See `PREFERENCES.example.md` for an example.

## Notes and frames

Ruler bookmarks also serve as notes: press the bookmark button at the playhead (select an element first to associate it), then double-click the marker to enter text, duration, color, resolve, or delete it. Agent markers are orange; resolved markers are gray. Snapshot `notes` contain `{id,text,start,end?,elementIds,replies,author,resolved,createdAt}`; times are in seconds. Old bookmarks without text are excluded from the notes list.

Add `{op:"note", text, start, end?, match?:[{agentId}|{id}]}`, `{op:"resolve-note", id}`, or `{op:"reply-note", id, text}` to draft `ops`. The result includes the note ID and status per operation in `draft-result.json`, and the whole draft remains one Undo. Because bookmarks use one position per frame, additions at an existing position are rejected and reported.

Write `frames-request.json`: `{rev:"capture-1", times:[0,1,2], width:960}`. `rev` may contain only letters, digits, `_`, or `-`; times must be within the timeline. `width` is optional (default 960, maximum 4096; frames are always rendered at full resolution then scaled down); height follows the canvas aspect ratio. The active editor processes requests when no drag is in progress; `frames-result.json` contains `{rev,files:["frames/capture-1/0.jpg",...],projectId}` after all frames are saved. Use a new `rev` for each request.

## 3D models
Assets with `type:"model"` accept GLB or glTF with embedded resources. On an element, use `model3d:{params:{rotationY:0,modelScale:1,cameraDistance:3.5,cameraFov:45,lightIntensity:2,lightX:3,lightY:4,lightZ:5}}`; `rotationX/Y/Z` are in degrees. Numeric parameters can be animated through `keyframes` (e.g. `path:"rotationY"`). Transform and opacity work as for image elements.

Graphic elements can use `graphic:{definitionId:"line"|"arrow"|"path"|"rectangle"|"ellipse"|"polygon"|"star",params:{...}}` on a `graphic` track. `path.params.d` accepts an SVG path; `path.params.viewBox` is an optional `"minX minY width height"` string, otherwise path bounds are calculated automatically. `drawProgress` (0–1) on lines, arrows, and paths can be animated through `keyframes` with `path:"drawProgress"`. `size:[w,h]` sets display size in pixels.

Add icons with `icon:{name:"lucide:server",color:"#ffffff"}` on a `graphic` track; icon data is fetched during import and its color can be changed in the editor.
Add text with `text:"Text"` on a `text` track; text attributes can be set through `params`.
`group` is stored and reported as `groupId`. Click selects a group, double-click selects a member, and Ctrl+G / Ctrl+Shift+G groups or ungroups.

Preview quality can be selected in the toolbar: Full, ½ (default), or ¼. The choice is stored in the browser and does not reduce export or agent frame quality.

## Compound clips
A compound clip is an element `{type:"compound", sceneId, startTime, duration, trimStart, trimEnd, sourceDuration, params}` that points at a nested scene with `kind:"compound"` (hidden from the scene picker; regular scenes have no `kind`). The nested scene's tracks render as one layer: nested time = `t - startTime + trimStart`. `params` are the video ones: `transform.*`, `opacity`, and `blendMode` act on the whole group; `volume` (dB) and `muted` act on all nested audio (audio clips and video source audio). Nested gains add up exactly; only the final gain is clamped. Compound `volume` is a single gain for now: it cannot be keyframed (`keyframable: false`) until automation is composed into the nested mix. A compound on the main track keeps the blurred background, taken from its nested main-track media.

Track placement (content-change policy):
- A new compound goes on a video track if its content has anything visual, otherwise on an audio track (`getTrackTypeForElement` / `getCompoundTrackType`).
- A compound already on a video track stays valid whatever its content becomes; one that turns audio-only keeps playing its audio there, and moves along its track never fail.
- A compound on an audio track must stay audio-only. When its content gains visuals, it is moved to a video track with the same mute state in every scene that uses it, inside the same command, so one Undo moves it back and Redo restores the same track.

Rules kept by the scenes manager on every change:
- `sourceDuration` always equals the nested scene's duration. A clip's span (`startTime`, `duration`, `trimStart`) never changes implicitly: added content becomes `trimEnd` (the clip can then be extended); removed content leaves `trimEnd` at 0 and an empty tail until the clip is shortened.
- A change that would make a scene contain itself (directly or through nested clips) is rejected with `CompoundCycleError` before anything is applied; a batch is rolled back as a whole.
- A scene that a compound clip still references cannot be deleted.

History is scene-bound: each command remembers the scene it ran in, and Undo/Redo apply it there even if another scene is open (e.g. edit inside a compound, go back, Undo reverts the nested edit). Selection is only restored while that scene is open.

A nested scene carries `compoundOrigin: {hostTrackOrder, trackSources}`: the host track order when the clip was created and, per nested track id, the host track its elements came from. Ungroup puts each nested track back on that host track when it still exists, has room, and is muted/hidden the same way; otherwise on a separate track right next to it that keeps the nested track's state.

Console/API: `editor.timeline.createCompound({elements:[{trackId,elementId}], name?})` returns `{compound, sceneId}`; `editor.timeline.ungroupCompound({trackId, elementId})` returns refs of the restored elements. Only the visible (trimmed) part comes back, at parent times; the clip's volume and mute are folded into the restored audio, video, and compound elements; its transform is not baked in. Each is one Undo step.

Decision for duplicate and copy-paste (to implement in the timeline UI and agent paths): duplicating or pasting a compound must deep-copy its nested scene, so the copy is independent (as in CapCut). A shared nested scene only arises from explicit features (today: the two halves of a split). The generic duplicate/paste commands do not do this yet; they still copy only the element, so the copy shares the nested scene.
