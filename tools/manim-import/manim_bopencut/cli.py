"""Command line entry point and scoped scene-loading helpers."""

from __future__ import annotations

import argparse
import builtins
from contextlib import contextmanager, ExitStack
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

import manim
from manim import MarkupText, Scene, Text, tempconfig

from .export import build_draft, markers_from_json
from .geometry import Coordinates
from .mapping import Mapper, points_of
from .recorder import RecordingRenderer


@contextmanager
def text_basis():
    # Text stores its nominal size but rotations/scales alter its bounding box.
    # Capture the original outlines once so affine fitting preserves true size.
    with ExitStack() as stack:
        for cls in (Text, MarkupText):
            original = cls.__init__
            def initialize(self, *args, _original=original, **kwargs):
                _original(self, *args, **kwargs)
                self._bopencut_text_basis = (points_of(self), self.font_size)
            stack.enter_context(patch.object(cls, "__init__", initialize))
        yield


@contextmanager
def redirect_writes(source, destination, read_maps=()):
    """Redirect ordinary Python file writes by trusted scenes; not a sandbox.

    Reads prefer an already redirected file, otherwise the original. Subprocess
    and native-extension I/O is intentionally outside this convenience feature.
    """
    if source is None and not read_maps:
        yield
        return
    source, destination = Path(source).resolve() if source else None, Path(destination).resolve()
    read_maps = [(Path(a).resolve(), Path(b).resolve()) for a, b in read_maps]
    destination.mkdir(parents=True, exist_ok=True)
    original_open, original_io, original_mkdir = builtins.open, io.open, os.mkdir
    def resolve(file, writing):
        if isinstance(file, int):
            return file
        path = Path(file).resolve()
        if not writing:
            for old, new in read_maps:
                if path.is_relative_to(old):
                    return new / path.relative_to(old)
        if source and path.is_relative_to(source) and not path.is_relative_to(destination):
            redirected = destination / path.relative_to(source)
            if writing:
                redirected.parent.mkdir(parents=True, exist_ok=True)
                return redirected
            if redirected.exists():
                return redirected
        return file
    def opener(original):
        def wrapped(file, mode="r", *args, **kwargs):
            return original(resolve(file, any(flag in mode for flag in "wax+")), mode, *args, **kwargs)
        return wrapped
    def mkdir(path, mode=0o777, *, dir_fd=None):
        if dir_fd is not None:
            return original_mkdir(path, mode, dir_fd=dir_fd)
        return original_mkdir(resolve(path, True), mode)
    with patch("builtins.open", opener(original_open)), patch("io.open", opener(original_io)), patch("os.mkdir", mkdir):
        yield


def record_scene(scene_class, asset_dir, *, fps=30, sample_every=2, morph_step=0.2, geometry_tolerance=0.002,
                 reference_times=(), reference_dir=None):
    mapper = Mapper(Path(asset_dir), geometry_tolerance=geometry_tolerance, morph_step=morph_step)
    renderer = RecordingRenderer(mapper, fps=fps, sample_every=sample_every,
                                 reference_times=reference_times, reference_dir=reference_dir)
    scene = scene_class(renderer=renderer)
    scene.setup()
    scene.construct()
    scene.tear_down()
    renderer.scene_finished(scene)
    return renderer


def parser():
    result = argparse.ArgumentParser(description="Record a trusted Manim CE scene as editable bopencut compounds (no video render).")
    result.add_argument("source", type=Path)
    result.add_argument("scene")
    result.add_argument("--out", type=Path, required=True)
    result.add_argument("--report", type=Path)
    result.add_argument("--start", type=float, default=0)
    result.add_argument("--track", default="Manim")
    result.add_argument("--agent-id")
    result.add_argument("--split", type=Path, help="Contiguous marker/phrase JSON; name/start/end or name/duration")
    result.add_argument("--split-key", help="Section key when the marker file contains a dictionary of lists")
    result.add_argument("--split-sections", action="store_true", help="Use Scene.next_section markers")
    result.add_argument("--width", type=int, default=1920)
    result.add_argument("--height", type=int, default=1080)
    result.add_argument("--fps", type=float, default=30)
    result.add_argument("--sample-every", type=int, default=2)
    result.add_argument("--tolerance", type=float, default=0.35, help="Maximum position reduction error in nested-canvas pixels")
    result.add_argument("--morph-step", type=float, default=0.2, help="Minimum interval between non-affine path variants")
    result.add_argument("--asset-root", type=Path, help="AGENT_FILES_ROOT; write asset references relative to this directory")
    result.add_argument("--redirect-writes", type=Path, help="Redirect ordinary Python writes under this source directory into the output directory")
    result.add_argument("--read-map", action="append", default=[], metavar="OLD=NEW", help="Remap stale scene data paths without editing the source; repeatable")
    result.add_argument("--reference-times", default="", help="Comma-separated seconds for low-quality Manim camera stills; never writes video")
    return result


def main(argv=None):
    args = parser().parse_args(argv)
    if args.width <= 0 or args.height <= 0 or args.sample_every < 1 or not math.isfinite(args.fps) or args.fps <= 0:
        raise ValueError("Canvas dimensions, fps and sample interval must be positive")
    if not all(math.isfinite(n) and n >= 0 for n in (args.start, args.tolerance, args.morph_step)):
        raise ValueError("Start, tolerance and morph step must be finite and non-negative")
    args.out = args.out.resolve()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    source = args.source.resolve()
    reference_times = [float(v) for v in args.reference_times.split(",") if v]
    if any(not math.isfinite(t) or t < 0 for t in reference_times):
        raise ValueError("Reference times must be finite and non-negative")
    asset_dir = args.out.parent / (args.out.stem + "-assets")
    prior_path = sys.path.copy()
    prior_bytecode = sys.dont_write_bytecode
    try:
        sys.dont_write_bytecode = True
        sys.path.insert(0, str(source.parent))
        with tempfile.TemporaryDirectory(prefix="manim-record-") as temporary, tempconfig({"dry_run": True, "renderer": "cairo", "disable_caching": True,
                    "media_dir": temporary, "frame_rate": args.fps, "verbosity": "ERROR"}), text_basis(), \
                redirect_writes(args.redirect_writes, args.out.parent / "scene-writes", [s.split("=", 1) for s in args.read_map]):
            spec = importlib.util.spec_from_file_location("_recorded_scene", source)
            if spec is None or spec.loader is None:
                raise ValueError("Cannot import scene file")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            cls = getattr(module, args.scene)
            if not isinstance(cls, type) or not issubclass(cls, Scene):
                raise ValueError("Selected class is not a Manim Scene")
            # Reapply output controls: source modules often set media_dir.
            with tempconfig({"dry_run": True, "write_to_movie": False, "save_last_frame": False, "renderer": "cairo",
                             "media_dir": temporary, "text_dir": str(Path(temporary)/"texts"), "tex_dir": str(Path(temporary)/"Tex"),
                             "pixel_width": 854, "pixel_height": 480, "frame_rate": args.fps}):
                coordinates = Coordinates(args.width, args.height, manim.config.frame_width, manim.config.frame_height)
                if abs(args.width/args.height-coordinates.frame_width/coordinates.frame_height) > .01:
                    raise ValueError("Output aspect ratio must match the Manim frame")
                recorder = record_scene(cls, asset_dir, fps=args.fps, sample_every=args.sample_every, morph_step=args.morph_step,
                                        reference_times=reference_times, reference_dir=args.out.parent/"reference")
                markers = None
                if args.split:
                    data = json.loads(args.split.read_text(encoding="utf-8-sig"))
                    markers = markers_from_json(data, recorder.time, args.split_key)
                elif args.split_sections:
                    sections = recorder.markers
                    if not sections or sections[0]["start"] > 0:
                        sections = [{"name": args.scene, "start": 0}, *sections]
                    markers = markers_from_json(sections, recorder.time)
                draft, report = build_draft(recorder, coordinates, name=args.scene, agent_id=args.agent_id or f"manim-{args.scene.lower()}",
                                           start=args.start, track_name=args.track, markers=markers, tolerance=args.tolerance, asset_root=args.asset_root)
                report["manim_version"] = manim.__version__
                missing = sorted(set(reference_times)-set(recorder.saved_references))
                if missing:
                    report["warnings"].append({"reason": "Reference times outside the scene", "times": missing})
        args.out.write_text(json.dumps(draft, ensure_ascii=False, indent=2), encoding="utf-8")
        report_path = args.report or args.out.with_suffix(".report.json")
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"duration": report["duration"], "compounds": len(draft["ops"]),
                          "native_elements": report["native_elements"], "fallbacks": report["fallback_count"], "out": str(args.out)}))
    finally:
        sys.path[:] = prior_path
        sys.dont_write_bytecode = prior_bytecode


if __name__ == "__main__":
    main()
