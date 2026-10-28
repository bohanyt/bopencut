"""Execute Manim's animation lifecycle without a movie writer or render loop."""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image
from manim import AnimationGroup, Create, DrawBorderThenFill, GrowArrow, MarkupText, Text, Transform, Wait
from manim.renderer.cairo_renderer import CairoRenderer

from .mapping import leaves


class RecordingWriter:
    def __init__(self, renderer):
        self.renderer = renderer

    def next_section(self, name, section_type, skip_animations=False):
        self.renderer.markers.append({"name": name, "start": self.renderer.time})

    def add_sound(self, sound_file, time, gain=None, **kwargs):
        self.renderer.warnings.append({"reason": "Audio is not imported", "start": time})

    def add_subcaption(self, content, duration, offset=0):
        self.renderer.warnings.append({"reason": "Subcaption is not imported", "start": self.renderer.time+offset})


def animation_leaves(animation, alpha):
    """Evaluate nested group timings using the same clock as Manim."""
    alpha = float(np.clip(alpha, 0, 1))
    if isinstance(animation, AnimationGroup):
        group_time = animation.rate_func(alpha) * animation.max_end_time
        for row in animation.anims_with_timings:
            duration = row["end"] - row["start"]
            subalpha = (group_time-row["start"]) / duration if duration else float(group_time >= row["start"])
            yield from animation_leaves(row["anim"], subalpha)
    else:
        yield animation, alpha


class RecordingRenderer(CairoRenderer):
    def __init__(self, mapper, *, fps=30, sample_every=2, reference_times=(), reference_dir=None, **kwargs):
        super().__init__(**kwargs)
        self.mapper = mapper
        self.fps = fps
        self.sample_every = sample_every
        self.reference_times = sorted(set(reference_times))
        self.reference_dir = reference_dir
        self.saved_references = []
        self.camera_samples = []
        self.events = []
        self.markers = []
        self.warnings = []

    def init_scene(self, scene, session_spec, file_writer_settings):
        # Deliberately never construct SceneFileWriter (nor invoke ffmpeg).
        self.file_writer = RecordingWriter(self)
        if type(self.camera) is not scene.camera_class:
            self.camera = scene.camera_class()
        self.mapper.scene = scene

    def capture(self, scene, time, reveal=None, replacements=None):
        roots = [m for m in scene.mobjects if m is not getattr(self.camera, "frame", None)]
        self.mapper.capture(roots, time, reveal, replacements)
        camera = self.camera
        value = {"width": float(camera.frame_width), "height": float(camera.frame_height),
                 "x": float(camera.frame_center[0]), "y": float(camera.frame_center[1])}
        if self.camera_samples and abs(self.camera_samples[-1][0]-time) < 1e-9:
            if self.camera_samples[-1][1] != value and time > 0:
                old_time, old = self.camera_samples[-1]
                self.camera_samples[-1] = (old_time-1e-4, old)
                self.camera_samples.append((time, value))
            else:
                self.camera_samples[-1] = (time, value)
        else:
            self.camera_samples.append((time, value))
        for requested in self.reference_times:
            if abs(requested-time) < 1e-7 and requested not in self.saved_references:
                self.reference_dir.mkdir(parents=True, exist_ok=True)
                camera.reset()
                camera.capture_mobjects(scene.mobjects)
                Image.fromarray(camera.pixel_array).save(self.reference_dir / f"manim-{requested:g}.png")
                self.saved_references.append(requested)

    def play(self, scene, *args, **kwargs):
        start = self.time
        self.capture(scene, start)
        scene.compile_animation_data(*args, **kwargs)
        animations = scene.animations
        duration = float(scene.duration)
        full = {}
        text_sources = {}
        force_paths = set()
        for animation in animations:
            for child, _ in animation_leaves(animation, 0):
                if isinstance(child, Transform) and isinstance(child.mobject, (Text, MarkupText)):
                    text_sources[id(child)] = child.mobject.copy()
                if isinstance(child, (Create, DrawBorderThenFill, GrowArrow)):
                    for obj, _ in leaves(child.mobject):
                        full[id(obj)] = obj.copy()
                        if isinstance(child, Create) and type(obj).__name__ not in ("Text", "MarkupText", "Line", "Arrow"):
                            force_paths.add(id(obj))
        self.mapper.prime(scene.mobjects, start, force_paths)
        for animation in animations:
            self.mapper.prime([animation.mobject], start, force_paths)
        scene.begin_animations()
        text_morphs = {}
        for animation in animations:
            for child, _ in animation_leaves(animation, 0):
                if isinstance(child, Transform) and isinstance(child.mobject, (Text, MarkupText)):
                    target = child.target_mobject
                    if isinstance(target, (Text, MarkupText)) and getattr(child.mobject, "original_text", "") != getattr(target, "original_text", ""):
                        old, new = text_sources[id(child)], target.copy()
                        text_morphs[id(child)] = (old, new, old.copy(), new.copy())
                        self.mapper.warn(self.mapper.identity(child.mobject), "Text replacement uses two editable text clips with an opacity crossfade", start)
        events = [{"type": type(child).__name__, "run_time": float(child.run_time)}
                  for animation in animations for child, _ in animation_leaves(animation, 0)]
        frozen = len(animations) == 1 and isinstance(animations[0], Wait) and animations[0].is_static_wait
        times = {0., duration}
        if not frozen:
            times.update(float(t) for t in np.arange(0, duration, 1/self.fps))
        times.update(t-start for t in self.reference_times if start <= t <= start+duration)
        elapsed = 0.
        for index, t in enumerate(sorted(times)):
            self.time = start + t
            if not frozen:
                scene.update_to_time(t)
            is_reference = any(abs(self.time-r) < 1e-7 for r in self.reference_times)
            if index % self.sample_every == 0 or t == duration or is_reference or frozen:
                reveal = {}
                replacements = {}
                for animation in animations:
                    for child, alpha in animation_leaves(animation, min(1, t/animation.run_time)):
                        if id(child) in text_morphs:
                            old, new, old_style, new_style = text_morphs[id(child)]
                            progress = float(child.rate_func(alpha))
                            old.become(old_style).fade(progress)
                            new.become(new_style).fade(1-progress)
                            replacements[id(child.mobject)] = [old, new]
                        if isinstance(child, (Create, DrawBorderThenFill, GrowArrow)):
                            members = list(leaves(child.mobject))
                            for i, (obj, _) in enumerate(members):
                                if id(obj) in full:
                                    progress = child.get_sub_alpha(alpha, i, max(1, len(members)))
                                    reveal[id(obj)] = (full[id(obj)], float(np.clip(progress,0,1)))
                self.capture(scene, self.time, reveal, replacements)
            elapsed = t
            if scene.stop_condition is not None and scene.stop_condition():
                break
        for animation in animations:
            animation.finish()
            animation.clean_up_from_scene(scene)
            for child, _ in animation_leaves(animation, 1):
                if id(child) in text_morphs:
                    target = child.target_mobject
                    for attr in ("original_text", "text", "font", "weight", "slant", "_font_size", "initial_height", "_bopencut_text_basis"):
                        if hasattr(target, attr):
                            setattr(child.mobject, attr, getattr(target, attr))
        if not frozen:
            scene.update_mobjects(0)
        self.time = start + elapsed
        self.capture(scene, self.time)
        self.events.append({"start": start, "end": self.time, "animations": events})
        self.num_plays += 1
        self.static_image = None

    def scene_finished(self, scene):
        self.capture(scene, self.time)

    def render(self, *args, **kwargs):
        raise RuntimeError("The recording renderer does not render video")
