# Manim to bopencut

Execute a trusted **Manim Community 0.22** scene and import it as a compound of
native, editable elements. The recorder executes the animation lifecycle and
updaters without rendering a movie. Open the compound in bopencut to select,
move, resize, restyle, or retime each part.

## Run

Install Manim's system dependencies and Python package first:

```powershell
py -3.11 -m pip install -r tools/manim-import/requirements.txt
py -3.11 tools/manim-import/manim_to_bopencut.py scene.py SceneName --out output/draft.json
```

The output includes `draft.json`, `draft.report.json`, and, if needed,
`draft-assets/`. Point the editor's `AGENT_WORKSPACE` at the output directory,
open an empty test project, and the bridge applies `draft.json` as one undoable
operation. Use the same canvas dimensions as the import (default 1920 x 1080).
The scene's aspect ratio must match the requested canvas.

```powershell
py -3.11 tools/manim-import/manim_to_bopencut.py scene.py SceneName --out output/draft.json --start 4 --track Illustrations --agent-id diagram-v1 --asset-root output
```

`--asset-root` should match `AGENT_FILES_ROOT`; it makes image paths relative to
that directory. Otherwise asset references are absolute. Each run uses the same
default revision and element identifiers for a scene. To apply a new revision,
choose a new `--agent-id` or remove the previous compound and change the draft's
`rev`. Importing another compound does not replace an existing one automatically.

Scene modules are executable Python, not inert data. Run only trusted scenes.
Imports can read files, run subprocesses, or perform arbitrary side effects.
The tool sets `dry_run`, disables movie output, and redirects Manim's media,
text, and TeX caches into a temporary directory. `--redirect-writes source-data`
also redirects ordinary Python `open`/`mkdir` writes below that directory into
`output/scene-writes`; this convenience is **not a security sandbox** and does
not intercept native-library or subprocess writes. It disables bytecode writes
while importing the source. A stale data dependency can be relocated without
editing a source file using repeatable `--read-map old-directory=new-directory`.

## Phrase compounds

```powershell
py -3.11 tools/manim-import/manim_to_bopencut.py scene.py SceneName --out output/draft.json --split markers.json
```

Accepted marker examples:

```json
[
  {"name": "Introduction", "start": 0, "end": 2},
  {"name": "Movement", "start": 2, "end": 5}
]
```

`name`/`duration` rows also work; starts are accumulated. The aliases `id` or
`kode` for names and `durasi` for duration allow existing phrase schedules.
For a dictionary of phrase lists, select a list with `--split-key SectionName`.
`--split-sections` uses `Scene.next_section()` markers instead. Markers must
cover the full recorded duration, contiguously and without overlap; mismatches
are rejected rather than silently truncating the scene. Animation curves are
interpolated at each cut, and every key time is local to its element.

## Mapping

| Source | Editable output | Limits |
| --- | --- | --- |
| Rectangle, RoundedRectangle, Square | Rectangle | Corner radius and uniform stroke; nonuniform stretch can distort stroke slightly |
| Circle, Ellipse, Dot | Ellipse | Filled and stroked |
| Line, DashedLine | Line | The editor uses equal dash and gap lengths |
| Straight Arrow | Arrow | Native triangular head approximates Manim's head; curved arrows use paths |
| Polygon, Triangle, braces, arbitrary VMobject | Cubic SVG path | Fill, stroke, alpha, disconnected contours and holes preserved |
| SVGMobject | One path per drawable leaf | No rasterization of vector artwork |
| Tex, MathTex | Glyph paths | TeX string retained in element names; TeX must compile in the source environment |
| Text, MarkupText | Text | Original spaces/newlines retained; markup and multistyle runs flattened to the first style |
| VGroup and nested groups | Separate elements with visual group IDs | Nearest group is editable; full ancestor tree retained in report |
| ImageMobject | Exported PNG image asset | Original image remains raster; translation, scale, rotation, opacity remain editable |
| 3D surfaces or unsupported raster appearance | Isolated transparent PNG | Per-object still, never a whole-scene video; internal deformation is frozen and reported |

Fonts must be available to both Manim and the browser. The draft bridge loads
supported web font families when importing text. A font registered only in
Python does not install that font in the browser; provide the same licensed
font through the editor/browser environment. Missing or different fonts affect
metrics. `glyphAnchor` centers visible letter outlines to match Manim's text
placement. Rich text, gradients, per-glyph styling, and 3D camera projection are
not fully reproduced.

## Animation and camera

The recorder runs every simulation frame at `--fps 30`. It records every second
frame by default (`--sample-every 2`), plus animation boundaries and requested
reference stills. This preserves custom rate functions, nested LaggedStart
timing, ValueTracker motion, `always_redraw`, and time-dependent updaters.
Updaters must be attached to scene mobjects, as in normal Manim execution.

- FadeIn/FadeOut: sampled opacity and transforms, including shifts/scales.
- Create/GrowArrow: native `drawProgress`; Create on other shapes uses a path.
- Write on text: editable text with an opacity reveal, rather than glyph strokes.
- Moves, scales, rotations and color changes: sampled native keys.
- Indicate, Wiggle, Flash, passing flashes: sampled motion and transient parts.
- Affine Transform/ReplacementTransform: sampled transforms. Non-affine
  deformations use a sequence of short editable path clips, at `--morph-step 0.2`
  seconds by default. Text replacements use two native text clips and an opacity
  crossfade. There is no video fallback for a 2D shape morph.

Keyframe reduction removes points whose linear reconstruction stays within the
configured tolerance (`--tolerance 0.35`, nested-canvas pixels for positions;
scale uses that tolerance / 1000, opacity 0.002, colors 1/255, angles 0.05 degrees).
Increase sampling or decrease the morph step for fast/deforming scenes. Sampled
curves approximate the source between recorded times; discontinuities use
distinct editor time ticks. Color keys retain alpha and numeric keys retain
precision independent of UI control step sizes.

MovingCameraScene pan/zoom becomes keys on the **compound**. The importer fits
the union of visited camera windows inside the nested canvas, preventing
offscreen content from being clipped before a pan reaches it. The resulting
overscan and origin are reported. Large camera travel/zoom can soften the
compound's current offscreen texture; individual elements remain editable.
Camera rotation and perspective are outside the supported 2D camera model.

## Report and verification

The report lists the complete mapped element inventory, group ancestry,
animation event spans, camera overscan, sampling settings, and **every fallback
per phrase with reason and duration**. Counts exclude the generated background;
path variants and objects carried across phrase cuts count as separate editable
clips. `video_elements` is always zero. Approximation notices are distinct from
raster fallbacks. Audio and subcaptions are currently omitted and reported.

To inspect a few frames without rendering video:

```powershell
py -3.11 tools/manim-import/manim_to_bopencut.py tests/scene.py SceneName --out output/draft.json --reference-times 0.5,1.5,3
```

This calls Manim's Cairo camera only at the selected times, at 854 x 480, and
saves PNGs under `output/reference/`. It does not invoke ffmpeg. Compare those
with the editor's `frames-request.json` output (which calls
`editor.renderer.createSnapshot`) at the same times. Use an isolated project,
workspace, and development-server port for validation.

Run the original synthetic regression scenes and tests:

```powershell
cd tools/manim-import
py -3.11 -m unittest discover -s tests -v
py -3.11 manim_to_bopencut.py tests/scenes.py Demo --out output/draft.json
```

The package is pinned to Manim CE 0.22's Cairo lifecycle. Other versions and
OpenGL scenes are not supported. Scene-specific custom renderers, interactive
embedding, custom output writers, and arbitrary renderer side effects are also
outside the recording contract.
