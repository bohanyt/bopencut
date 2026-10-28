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
| `project.json`, `sync/<projectId>.json` | editor → agent | current timeline after each edit (0.8 s debounce), including the content of every compound clip (see *Compound clips for agents*) |
| `draft.json` | agent → editor | per-item operations; applied in ~2 s as **one Undo step** |
| `draft-result.json` | editor → agent | result per operation (items deleted by the human are skipped) |

**bundle.json** (any `schema`): `name,width,height`, `assets:[{key,path(relative to AGENT_FILES_ROOT),type:image|video|audio,name}]`, `main:[el]`, `audio:[el]`, `overlay:[{name,type:"video"|"effect",elements:[el]}]` (index 0 = topmost). `el`: `agent_id,name,start,duration,trimStart` (seconds), `asset` or `effect`+`effectParams`, `params` (e.g. `transform.positionX/Y` = pixels from canvas center, `opacity`, `volume`), `size:[w,h]` (display size in pixels), `keyframes:[{path:"opacity"|"scale"|param,time,value}]`.

**draft.json**: `{schema:"opencut-agent-draft-1", rev, label, projectId?, ops:[{op:"set", match:{agentId}|{id}, start?, duration?, trimStart?, params?}, {op:"delete", match:…}, {op:"add", track:{name, type?:"video"|"audio"|"effect", index?}, element:el}]}`. For `add`, `el.asset` is an object `{path,type,name}` (not a bundle key); an existing track with that name is reused, otherwise one is created (overlays are inserted at `index`). Exact names take precedence; `Main`, the legacy `Utama`, and the editor default `Main Track` are aliases of each other (so `Main` reaches the main track of a compound made in the editor). Existing saved track names are not renamed. The entire draft is one Undo; changed/added items are selected immediately. `match` can also reach inside compound clips, and `group`, `ungroup`, and `compound` ops exist: see *Compound clips for agents*. `replace`, `atomic`, `set` keyframes, and `mediaId`: see *Draft reliability*.

Browser console: `window.agent.snapshot()`, `window.agent.applyDraft(draft)`, `window.agent.ready()` (readiness, see below), `await window.agent.whenReady()` (true once ready; call it before `applyDraft` from the console).

## Draft reliability

**Readiness.** The editor is *ready* when the project is loaded, loading its stored media has finished, and every change is saved to disk. The sync snapshot reports `ready`, `mediaLoaded`, `mediaCount`, `missingMedia`, `pendingSave` (a change not yet in `project.json`), `saveError` (last save failed, else `null`), `savedAt`, and `syncedAt` (when this snapshot was taken; until now `savedAt` meant that). `savedAt` is the last write of *this* project to disk: on open, the stored project's last save; afterwards only successful writes move it.

**Missing media.** A stored media file that cannot be read when the project opens does not block readiness: it is listed in `missingMedia:[{id,name,error}]` (the editor shows a toast with *Retry*; `window.agent.retryMissingMedia()` does the same and returns what is still missing). While anything is missing, a frame request is refused: `frames-result.json` gets `{rev, files:[], error, missingMedia}` once per `rev`, unless the request has `allowMissing:true`. After a successful retry the same request is processed.

**Save failures.** A failed save is retried automatically after 1, 2, 4, 8, and 16 s (no edit needed); the toast shows the error. If the last retry fails too, the toast stays with a *Retry* button. `ready` stays false and `saveError` is set until a save succeeds. The snapshot is re-sent whenever readiness changes. `draft.json` and `frames-request.json` are only picked up while ready: a draft or frame request written while media are loading waits instead of running against a half-loaded project. Wait for `ready: true` before trusting a snapshot or frame of a large project.

**Assets first, all or nothing.** Drafts run one at a time (also `window.agent.applyDraft` calls). Every icon, asset, and `mediaId` a draft uses is loaded before the timeline changes. Imported assets stay private until the draft commits: they are saved to storage but not in the project's media, so nothing else can use them in the meantime. If any load fails (file missing, media cannot be saved, unknown `mediaId`), **nothing is applied**: every import the draft attempted is deleted again (also a half-saved one), the toast says *not applied*, and `draft-result.json` has `applied:false` and `rolledBack` with one entry per op: the ops that failed carry `error` (every failing element, by `agent_id`/name), the others `skipped:true`. `cleanup:{removed:[ids], failed:[{id,error}]}` lists what was deleted; `rolledBack:false` means some imported files could not be removed (the error says how many). Imports used only by ops that failed are removed the same way when the rest of the draft applies. A draft that deletes clips and adds their replacements can no longer lose the clips because the replacements' assets failed.

**Op failures.** Without `atomic`, an op that fails in the timeline (no match, invalid keyframe, …) is skipped and the rest applies, as before. With `{…, atomic:true}` on the draft, any failed op cancels the whole draft (`applied:false`, the other ops `skipped:true`). Use `atomic` whenever ops depend on each other.

**Saved before reported.** After a draft applies, the project is saved, then `draft-result.json` is written with `applied:true`, `saved` (true once `project.json` on disk has the change), and `savedAt`. `saved:false` comes with `saveError`.

**`replace`.** `{op:"replace", match, element:el, track?:{name, type?}}` deletes the matched element and puts `el` in its place in one op, so it either fully happens or not at all (and ripple editing sees one replacement, not a removal). Unset `agent_id`, `name`, `start`, and `duration` are taken from the replaced element, so the new one keeps its agentId and span; keyframes are not carried over. Without `track` it goes on the replaced element's track when its type fits there (a compound replacing a clip on a video track), otherwise on a track of that name. `el` may be a compound (`el.compound`), use `asset` or `mediaId`. The result has `element` (the new one) and `replaced:{sceneId,id}`.
```json
{"op":"replace", "match":{"agentId":"scene-5"}, "element":{"name":"Scene 5", "compound":{"elements":[
  {"agent_id":"label", "name":"Label", "text":"Label", "start":0, "duration":3, "track":{"name":"Text", "type":"text"}}]}}}
```

**Keyframes in `set`.** `{op:"set", match, keyframes:[{path, time, value, interpolation?}], keyframesMode?:"merge"|"replace"}`. `time` is in seconds relative to the element (clamped to its span, after any `start`/`duration` change in the same op); `interpolation` (`linear` default, `hold`, `bezier`) is the segment that starts at that key. `merge` (default) adds keys and overwrites a key already at the same time; `replace` first removes every keyframe of the element (all paths), so `keyframes:[]` with `replace` clears them. Paths are as in `add`: `opacity`, `transform.positionX`/`Y`, `transform.scaleX`/`Y`, `transform.rotate`, a graphic's own parameter by name (e.g. `drawProgress`), and `scale` for both axes, as a multiple of the element's current static scale. A path the element cannot animate fails the op. The whole draft stays one Undo.

**Reusing media: `mediaId`.** In `add`, `compound`, and `replace` elements (and inside compound content), `mediaId` (the id of media already in the project: every snapshot element that uses media reports its `mediaId`; or `editor.media.getAssets()` in the console) can replace `asset`: nothing is re-imported and the element points at the same media. It must exist, or the draft is not applied.

**Frame rate.** The project frame rate is never changed by agent imports: a bundle sets it with `fps` (default 30; e.g. `"fps":30` or `29.97`) and imported footage with a higher frame rate does not raise it; draft assets do not change it either. Media dropped by hand in the editor still raise it to the fastest footage (upstream behaviour), now with a toast saying so.

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

Write `frames-request.json`: `{rev:"capture-1", times:[0,1,2], width:960}`. `rev` may contain only letters, digits, `_`, or `-`; times must be within the timeline. `width` is optional (default 960, maximum 4096; frames are always rendered at full resolution then scaled down); height follows the canvas aspect ratio. Frames show the root timeline (see *Compound clips for agents*) with compound clips rendered from their content, also while the human has a compound open. The active editor processes requests when no drag is in progress; `frames-result.json` contains `{rev,files:["frames/capture-1/0.jpg",...],projectId}` after all frames are saved. Use a new `rev` for each request.

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

History is scene-bound: each command remembers the scene it ran in. Undo/Redo of a command from another scene first switches the editor to that scene (like an NLE jumping to the sequence being undone), then runs there. Every change of the open scene (a switch, deleting the open scene, undoing that) goes through one transition: the outgoing scene's playhead is remembered, playback pauses, the selection is cleared, and the destination opens at its own last playhead and becomes the project's current scene. An undo is an edit, so playback does not continue in the destination scene. If that scene no longer exists and the command does not bring it back, the step is refused with a message and history stays as it is. Redoing a scene creation or an insertion that made a track brings back the same scene and track ids.

A nested scene carries `compoundOrigin: {hostTrackOrder, trackSources}`: the host track order when the clip was created and, per nested track id, the host track its elements came from. Ungroup puts each nested track back on that host track when it still exists, has room, and is muted/hidden the same way; otherwise on a separate track right next to it that keeps the nested track's state.

Console/API: `editor.timeline.createCompound({elements:[{trackId,elementId}], name?})` returns `{compound, sceneId}`; `editor.timeline.ungroupCompound({trackId, elementId})` returns refs of the restored elements. Only the visible (trimmed) part comes back, at parent times; the clip's volume and mute are folded into the restored audio, video, and compound elements; its transform is not baked in. Each is one Undo step.

Duplicate and copy-paste deep-copy compound clips: each copied clip gets its own copy of its nested scene, recursively (new scene, track, element, and keyframe ids), so editing the copy never changes the original (as in CapCut). Clips copied together that shared a scene (the two halves of a split) share one copy. Copy takes a snapshot of the nested scenes, so a paste still works after the original was broken apart or deleted. Redo of a duplicate or paste brings back the same ids. A top-level copied scene takes its clip's name (e.g. "Compound clip 1 (copy)"). Inside the copy every reference follows the copy: notes (`elementIds`) point at the copied elements, and a copied inner compound's origin points at its copied parent's tracks, so breaking it apart puts its content back on the copy's tracks. A shared nested scene only arises from explicit features (today: the two halves of a split).

Copy identity policy: a copy made by duplicate or paste never keeps `agentId` (the copied clip and everything inside a copied compound), so an `agentId` always names one element: the original. Address copies by element id. Clips copied in another project are not pasted when they use media that is not in this project (the paste is refused with a message); import the media into this project first.

Naming: a new compound is named "Compound clip N" (one above the highest N in use) unless a name is given. A compound's name is its nested scene's name; renaming (`editor.timeline.renameCompound({sceneId, name})`, one Undo) renames the scene and every clip showing it.

Timeline UI:
- Create: select clips, then **Alt+G** or context menu *Create compound clip*. Break apart: select one compound, then **Alt+Shift+G**, context menu *Break apart*, or the properties panel. (Ctrl+G / Ctrl+Shift+G stay preview grouping.)
- Enter: double-click the clip (or context menu *Open compound clip*, or *Open* in the properties panel). The playhead lands on the same frame inside when it was over the clip. A breadcrumb above the timeline (`Main scene › Compound clip 2 › …`) shows where you are; click an ancestor to jump there. **Esc** first clears the selection, then goes back to the parent; the back arrow does the same. The preview toolbar shows the open compound's name. The scene picker never lists compound content; compounds are only entered from the timeline or breadcrumb.
- Look: amber clip with a layers label. Video compounds show a strip of five low-res frames of the visible window, rendered off the playback path (only while paused, after edits settle; a strip that playback interrupts stops between frames and finishes later) and cached by content and project background, so an edit at any depth refreshes it and Undo reuses the old strip. Samples in an empty tail show the empty tail. Audio-only compounds show their nested clips as bars.
- Properties: a *Compound clip* tab (name, Open, Break apart), Transform, Audio (volume in dB and mute for all nested audio; volume is not keyframable), Blending.

## Compound clips for agents

**Root timeline.** Snapshot `tracks` and `notes`, top-level draft ops, and frames all use the *root timeline*: the scene open in the editor, or, while the human is editing inside a compound clip, the user scene that contains it (the main scene first). The snapshot reports `sceneId` (the root) and `activeSceneId` (the scene open in the editor).

**Addresses.** Every element lives in exactly one scene. Its address is `sceneId` + `id`, plus `path`: the ids of the compound clips from the root down to its scene (`[]` on the root). A scene shown by several clips (for example the two halves of a split) has one path per clip; `path` is the first one (parents in the order they are first reached from the root, then clips in track order). Paths multiply with shared nesting, so at most 32 are listed per scene: such a scene's `compounds` entry has `truncated: true`, as do its elements, and their `visible` lists only cover the listed paths.

**Snapshot.** The schema stays `opencut-agent-sync-1`; all changes are additive, so readers of `tracks` keep working.
- `tracks`: the root timeline, same shape as before. Every element also has `sceneId`, `path`, and `visible`; a compound clip also has `compound:{sceneId, kind:"compound", volume, muted, sourceDuration}` (`volume` in dB, as in `params`).
- `compounds`: the content of every compound clip reachable from the root, each scene once, in the order first reached from the root: `{sceneId, name, kind:"compound", duration, path, truncated, instances:[{path, compoundId, agentId, offset, visible:[{start,end}]}], tracks:[…same lane shape…]}`.
- Times: `start`, `end`, `duration`, `trimStart`, and `trimEnd` are always **relative to the element's own scene** (inside a compound, 0 = the start of its content). `visible:[{start,end,path}]` is where the element really shows on the root timeline, through each enclosing clip's position and trim window, one entry per path; `[]` means an enclosing clip trims it out entirely. For a compound instance, root time = content time + `offset`, inside its `visible` window.

```json
{"sceneId":"main", "activeSceneId":"main",
 "tracks":[{"group":"overlay", "name":"Motion graphics", "elements":[
   {"id":"c1", "agentId":"scene-2", "type":"compound", "start":10, "end":15, "trimStart":2, "sceneId":"main", "path":[],
    "visible":[{"start":10, "end":15, "path":[]}], "compound":{"sceneId":"s1", "kind":"compound", "volume":0, "muted":false, "sourceDuration":9}}]}],
 "compounds":[{"sceneId":"s1", "path":["c1"], "duration":9,
   "instances":[{"path":["c1"], "compoundId":"c1", "agentId":"scene-2", "offset":8, "visible":[{"start":10, "end":15}]}],
   "tracks":[{"group":"overlay", "name":"Icons", "elements":[
     {"id":"i1", "agentId":"icon-db", "start":3, "end":6, "sceneId":"s1", "path":["c1"], "visible":[{"start":11, "end":14, "path":["c1"]}]}]}]}]}
```

**Matching inside compounds.** In `set`, `delete`, `group`, `ungroup`, and note `match`:
- `{agentId}` or `{id}` searches every scene reachable from the root. If the element is found in more than one scene, the op fails as ambiguous; narrow it with `sceneId` or `path`.
- `{agentId|id, sceneId}` searches only that scene.
- `{agentId|id, path:[…]}` searches the scene inside the last clip of `path`; entries are compound clip ids or their agentIds, from the root.
- Copies made by duplicate or paste have no `agentId` (see the copy identity policy above), so an `agentId` match always finds the original. Address a copy, and anything inside it, by element `id` (and `path`, using the copied clip's id); the snapshot shows its `agentId` as `null`.
- When both `id` and `agentId` are given, every candidate scene is searched for the `id` first; `agentId` is only used if no element has that id.

**Times in ops inside a compound are relative to that compound's content**, exactly as the snapshot reports them (`start`, `duration`, `trimStart`, keyframe times). The compound clip keeps its position and length when its content changes: added content becomes `trimEnd`, so extend the clip with a `set` `duration` if it should show more.

**New ops.**
- `add` into a compound: `{op:"add", track:{name, type?, index?, compound:{agentId}|{id}|{path}}, element:el}` adds to that clip's content (a bare `path` means the scene inside the last clip).
- `{op:"compound", agent_id, name, start, duration?, trimStart?, track:{name, type?, index?, compound?}, params?, keyframes?, elements:[el + track:{name, type?, index?}], main?, overlay?, audio?}` builds a new compound clip from element definitions in one step, for example one clip per motion-graphics scene. Each element is placed like a draft `add` (each new track goes on top, so list elements from back to front); `main`/`overlay`/`audio` follow the bundle layout instead. An element with its own `compound` content becomes a nested compound clip. `duration` defaults to the content length; `track` defaults to `{name:"Compound clips"}`; without a `name`, the clip gets the editor's next "Compound clip N". Keyframes, icons, and assets work as in `add`.
- `{op:"group", agent_id?, name?, match:[…]}` turns matched elements of one scene into a compound clip in that scene, as grouping in the UI does (the clip goes where the elements were, on a plain track).
- `{op:"ungroup", match}` puts the visible part of a compound clip's content back in its scene.

```json
{"op":"compound", "agent_id":"mg-1", "name":"Data flow", "start":4, "track":{"name":"Motion graphics"}, "elements":[
  {"agent_id":"icon-db", "name":"DB", "icon":{"name":"lucide:database"}, "start":0, "duration":4, "size":[160,160], "params":{"transform.positionX":-500}, "track":{"name":"Icons"}},
  {"agent_id":"arrow-1", "name":"Arrow", "graphic":{"definitionId":"arrow"}, "start":0.5, "duration":3.5, "track":{"name":"Arrows"},
   "keyframes":[{"path":"drawProgress", "time":0, "value":0}, {"path":"drawProgress", "time":0.6, "value":1}]},
  {"agent_id":"whoosh-1", "name":"Whoosh", "asset":{"path":"sfx/whoosh.wav", "type":"audio", "name":"whoosh"}, "start":0.4, "duration":0.8, "track":{"name":"SFX"}}]}
{"op":"set", "match":{"agentId":"icon-db"}, "start":0.2, "params":{"color":"#ffcc00"}}
{"op":"add", "track":{"name":"Icons", "compound":{"agentId":"mg-1"}}, "element":{"agent_id":"icon-user", "name":"User", "icon":{"name":"lucide:user"}, "start":1, "duration":3}}
{"op":"group", "agent_id":"captions-1", "name":"Captions", "match":[{"agentId":"cap-1"}, {"agentId":"cap-2"}]}
```

Compound clips the agent builds name their main track `Main Track`, like compounds made in the editor; `Main` reaches it by alias. Compound clips go on video tracks (or on audio tracks if their content is audio only). A compound's audio (for example a whoosh inside a motion-graphics clip) plays only on an unmuted track: tracks the agent creates for compounds are unmuted, while video tracks created for footage stay muted as before.

**Results.** Each entry in `draft-result.json` keeps its old fields and adds addresses `{sceneId, trackId, id, agentId, path}`: `element` for `add`/`set` (and `{sceneId,id}` for `delete`); `compound` + `sceneId` (the new content scene) + `elements` (the content) for `compound` and `group`; `elements` for `ungroup`. A failed op changes nothing and reports `error`; the rest of the draft still applies (unless the draft is `atomic`; failed asset loading always cancels the whole draft, see *Draft reliability*). The result also reports the root `sceneId`.

**One Undo.** The whole draft is still one Undo step, even when it changes several scenes (the root and the content of several compound clips): Undo restores every scene the draft changed, removes the scenes it created, and brings back scenes it removed; Redo restores the draft result with the same ids. If a scene the draft changed disappeared outside history, the step is refused with a message and history stays as it is. If the draft removes the scene open in the editor (for example ungrouping the compound clip the human is editing), the root opens instead; Undo brings that scene back and opens it again at its own playhead and selection, and Redo returns to the root. The selection of changed items is part of the step, so Redo selects them again. Items changed inside a compound are shown by selecting the compound clip that contains them in the open scene.

**Bundle.** In `bundle.json`, an element in `main`, a `video` overlay, or `audio` may carry `compound:{main?, overlay?, audio?, elements?}` with the same layout as the bundle itself (plus `elements` with a per-element `track`, as in the `compound` op); asset keys refer to the bundle's `assets`. `duration` may be omitted (= content length). Overlay tracks holding a compound are created unmuted.

**Edit log.** Human edits anywhere under the root timeline, inside compound clips included, are logged with `sceneId` and `path`. Grouping or ungrouping moves an element to another scene with the same id and is logged as one `sceneId` change: its local times, trims, and track are remapped by the move and are not logged, and the compound clip a group creates (or an ungroup removes) is not logged as an add or delete. If the element's position on the root timeline changed in the same edit, `startTime`/`duration` lines report it in root seconds. A compound clip's `trimEnd` follows its content length and is not logged. Agent drafts (inside compounds too) and their Undo/Redo are not logged.
