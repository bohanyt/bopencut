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

**draft.json**: `{schema:"opencut-agent-draft-1", rev, label, projectId?, ops:[{op:"set", match:{agentId}|{id}, start?, duration?, trimStart?, params?}, {op:"delete", match:…}, {op:"add", track:{name, type?:"video"|"audio"|"effect", index?}, element:el}]}`. For `add`, `el.asset` is an object `{path,type,name}` (not a bundle key); an existing track with that name is reused, otherwise one is created (overlays are inserted at `index`). Exact names take precedence; `Main`, the legacy `Utama`, and the editor default `Main Track` are aliases of each other (so `Main` reaches the main track of a compound made in the editor). Existing saved track names are not renamed. The entire draft is one Undo; changed/added items are selected immediately. `match` can also reach inside compound clips, and `group`, `ungroup`, and `compound` ops exist: see *Compound clips for agents*.

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

Write `frames-request.json`: `{rev:"capture-1", times:[0,1,2], width:960}`. `rev` may contain only letters, digits, `_`, or `-`; times must be within the timeline. `width` is optional (default 960, maximum 4096; frames are always rendered at full resolution then scaled down); height follows the canvas aspect ratio. Frames show the root timeline (see *Compound clips for agents*) with compound clips rendered from their content, also while the human has a compound open. The active editor processes requests when no drag is in progress; `frames-result.json` contains `{rev,files:["frames/capture-1/0.jpg",...],projectId}` after all frames are saved. Use a new `rev` for each request.

## 3D models
Assets with `type:"model"` accept GLB or glTF with embedded resources. On an element, use `model3d:{params:{rotationY:0,modelScale:1,cameraDistance:3.5,cameraFov:45,lightIntensity:2,lightX:3,lightY:4,lightZ:5}}`; `rotationX/Y/Z` are in degrees. Numeric parameters can be animated through `keyframes` (e.g. `path:"rotationY"`). Transform and opacity work as for image elements.

Graphic elements can use `graphic:{definitionId:"line"|"arrow"|"path"|"rectangle"|"ellipse"|"polygon"|"star",params:{...}}` on a `graphic` track. `path.params.d` accepts an SVG path; `path.params.viewBox` is an optional `"minX minY width height"` string, otherwise path bounds are calculated automatically. `drawProgress` (0–1) on lines, arrows, and paths can be animated through `keyframes` with `path:"drawProgress"`. `size:[w,h]` sets display size in pixels.

Add icons with `icon:{name:"lucide:server",color:"#ffffff"}` on a `graphic` track; icon data is fetched during import and its color can be changed in the editor.
Add text with `text:"Text"` on a `text` track; text attributes can be set through `params`.

### Native styled captions

Use one text element per phrase on a normal `text` overlay track. A caption is a text element with a `caption` timing payload; text, transforms, effects, selection, copy/paste, and undo keep their normal behavior. The canonical editable text is `params.content`; snapshots also expose `caption:{text,words,approximate}`. No image assets are needed. Subtitle imports also create caption payloads with estimated word timings.

In bundles and draft `add`, use `caption:{text,words?,preset?,style?,highlight?}` instead of `text`. Draft `set` accepts a partial `caption` object (for example, only `style` or `preset`). `words` is an ordered array of `{text,start,end,highlight?}`; times are seconds relative to the untrimmed element, intervals are half-open, and words must match the whitespace-separated text. Trimming or splitting advances the timing window using `trimStart`. Gaps are allowed; overlapping or out-of-range intervals are rejected. If omitted when creating a caption, words divide the duration evenly and are marked `approximate:true`.

Editing text in the properties panel or through `set.params.content` preserves matching words in order (including their emphasis and timings). New or replaced word runs divide the available gap between retained words evenly and are marked approximate. If an insertion has no available gap, the whole phrase is redistributed. Punctuation and case edits preserve timings. Emphasis can be toggled per word in the text properties panel. Active-word color takes precedence over emphasis while that word is active.

`style` uses the same flat parameter keys as `params`. All numeric controls below, including font size, letter spacing, and line height, are keyframable using their parameter names:

- `stroke.inner.color`, `stroke.inner.width`, `stroke.outer.color`, `stroke.outer.width`: two round-join outline rings. Widths are outward radii in em (font-size multiples), not Canvas line widths; the outer radius should exceed the inner radius. Rendering order is outer, inner, fill across the whole phrase.
- `stroke.inner.widthPx`, `stroke.outer.widthPx`: pixel aliases. A positive px value overrides em. Zero uses em unless the px parameter has a keyframe channel, in which case the animated px value (including zero) wins. Remove that channel to return to em.
- `shadow.color`, `shadow.offsetX`, `shadow.offsetY`, `shadow.blur`, `shadow.opacity`: one shadow of the combined outlined text. Offsets and blur are project pixels; opacity is 0–1. Shadow opacity defaults to zero. Text transforms scale both strokes and shadows. Preview quality scales the complete result; export and agent frames remain full resolution.
- `caption.maxWidth`: wrapping width in project pixels; zero disables automatic wrapping. Captions default to 80% of the canvas width. Explicit newlines are preserved. The limit measures glyph advances and spacing; rings and shadows can extend beyond it. A word wider than the limit is kept intact.
- `caption.noOrphan`: move a word from the preceding line to avoid a final one-word line when the pair fits. Explicit paragraph breaks and the width limit take precedence.
- `caption.wordSpacing`: additional space between words in em; `caption.highlightColor`: fill for words flagged `highlight:true`.
- `caption.activeEnabled`, `caption.activeColor`, `caption.activeScale`: active-word fill and optional scale bump (1 = no bump). The bump is centered on the word and does not reflow lines. Active highlighting is off by default.

The `highlight` shorthand is `{color,emphasisColor?,scale?,enabled?}`. It enables active highlighting unless `enabled:false`, uses `color` for the active word, defaults emphasis to that color, and defaults scale to 1. Precedence is element `params`, then preset style, then inline `style`, then `highlight`. Existing `fontSize` units remain unchanged: pixel font size = `fontSize * canvasHeight / 90`.

**Presets.** In text properties, enter a name and choose **Save** to capture the style at the playhead. Choose a saved preset and **Apply to selected** to update all selected text/caption elements in one Undo step (also available with multiple elements selected). Applying a preset leaves text, timings, emphasis flags, and placement intact and replaces animation on the style properties supplied by the preset. Saving an existing name replaces that workspace preset. Presets are private JSON files in `AGENT_WORKSPACE/presets/*.json`, each `{ "name": "Readable", "style": { ... } }`. Names are case-sensitive; agents can create these files directly. `GET /api/agent/presets` lists them and `POST` saves one. A preset is resolved once during bundle/draft preparation and its values are copied into the element, so later changes to the preset do not change existing elements. Missing or invalid presets report an error. No presets or custom fonts are bundled with the repository; load custom fonts for the editing/export session before capturing frames.

For example, after saving a preset named `Readable`, this draft creates two phrases on the same track and adjusts one phrase without replacing it:

```json
{
  "schema": "opencut-agent-draft-1",
  "rev": "captions-1",
  "ops": [
    {"op":"add","track":{"name":"Captions","type":"text"},"element":{
      "agent_id":"phrase-1","name":"Caption 1","start":0,"duration":3,
      "caption":{"text":"Keep text editable","preset":"Readable",
        "words":[{"text":"Keep","start":0,"end":0.7},{"text":"text","start":0.7,"end":1.5,"highlight":true},{"text":"editable","start":1.5,"end":3}],
        "highlight":{"color":"#ffcc00","scale":1.05}}
    }},
    {"op":"add","track":{"name":"Captions"},"element":{
      "agent_id":"phrase-2","name":"Caption 2","start":3,"duration":3,
      "caption":{"text":"One element per phrase","preset":"Readable"}
    }},
    {"op":"set","match":{"agentId":"phrase-2"},"caption":{
      "text":"One editable element per phrase","style":{"caption.maxWidth":1000}
    }}
  ]
}
```

For a bundle, put the same `element` objects in `overlay:[{name:"Captions",type:"text",elements:[...]}]`. Seventy phrases are seventy elements on one text track, not seventy tracks or one element per word.

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

**Results.** Each entry in `draft-result.json` keeps its old fields and adds addresses `{sceneId, trackId, id, agentId, path}`: `element` for `add`/`set` (and `{sceneId,id}` for `delete`); `compound` + `sceneId` (the new content scene) + `elements` (the content) for `compound` and `group`; `elements` for `ungroup`. A failed op changes nothing and reports `error`; the rest of the draft still applies. The result also reports the root `sceneId`.

**One Undo.** The whole draft is still one Undo step, even when it changes several scenes (the root and the content of several compound clips): Undo restores every scene the draft changed, removes the scenes it created, and brings back scenes it removed; Redo restores the draft result with the same ids. If a scene the draft changed disappeared outside history, the step is refused with a message and history stays as it is. If the draft removes the scene open in the editor (for example ungrouping the compound clip the human is editing), the root opens instead; Undo brings that scene back and opens it again at its own playhead and selection, and Redo returns to the root. The selection of changed items is part of the step, so Redo selects them again. Items changed inside a compound are shown by selecting the compound clip that contains them in the open scene.

**Bundle.** In `bundle.json`, an element in `main`, a `video` overlay, or `audio` may carry `compound:{main?, overlay?, audio?, elements?}` with the same layout as the bundle itself (plus `elements` with a per-element `track`, as in the `compound` op); asset keys refer to the bundle's `assets`. `duration` may be omitted (= content length). Overlay tracks holding a compound are created unmuted.

**Edit log.** Human edits anywhere under the root timeline, inside compound clips included, are logged with `sceneId` and `path`. Grouping or ungrouping moves an element to another scene with the same id and is logged as one `sceneId` change: its local times, trims, and track are remapped by the move and are not logged, and the compound clip a group creates (or an ungroup removes) is not logged as an add or delete. If the element's position on the root timeline changed in the same edit, `startTime`/`duration` lines report it in root seconds. A compound clip's `trimEnd` follows its content length and is not logged. Agent drafts (inside compounds too) and their Undo/Redo are not logged.
