from __future__ import annotations

import json
import math
from pathlib import Path
import tempfile
import unittest

import numpy as np
from manim import *
from unittest.mock import patch

from manim_bopencut.cli import record_scene, text_basis, redirect_writes
from manim_bopencut.export import build_draft, markers_from_json, clip_samples
from manim_bopencut.geometry import Coordinates, fit_transform, reduce_keys, svg_path
from manim_bopencut.mapping import Mapper, leaves


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.config_context = tempconfig({"dry_run": True, "write_to_movie": False, "save_last_frame": False,
                                         "media_dir": str(self.root), "text_dir": str(self.root/"texts"),
                                         "pixel_width": 320, "pixel_height": 180, "frame_rate": 30,
                                         "verbosity": "ERROR"})
        self.config_context.__enter__()
        self.basis = text_basis()
        self.basis.__enter__()

    def tearDown(self):
        self.basis.__exit__(None, None, None)
        self.config_context.__exit__(None, None, None)
        self.temporary.cleanup()

    def record(self, cls, **kwargs):
        recorder = record_scene(cls, self.root/"assets", **kwargs)
        draft, report = build_draft(recorder, Coordinates(), name="Test", agent_id="test")
        json.dumps(draft, allow_nan=False)
        return recorder, draft, report

    def test_supported_types(self):
        objects = [(Rectangle(), "rectangle"), (RoundedRectangle(), "rectangle"), (Square(), "rectangle"),
                   (Circle(), "ellipse"), (Ellipse(), "ellipse"), (Dot(), "ellipse"),
                   (Line(), "line"), (DashedLine(), "line"), (Arrow(), "arrow"),
                   (Triangle(), "path"), (Polygon(LEFT, RIGHT, UP), "path"),
                   (VMobject().set_points_as_corners([LEFT, UP, RIGHT]), "path"),
                   (Text("two words", font="Arial"), "text"),
                   (MarkupText("<b>hello</b>"), "text")]
        mapper = Mapper(self.root/"assets")
        for obj, expected in objects:
            with self.subTest(type=type(obj).__name__):
                track = mapper.make_track(obj, obj, (), 0)
                self.assertEqual(track.element.get("graphic", {}).get("definitionId", "text"), expected)
        self.assertEqual(mapper.tracks[12].element["text"], "two words")

    def test_svg_and_tex_outlines_are_native(self):
        svg = self.root/"shape.svg"
        svg.write_text('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0C20 0 20 20 0 20Z" fill="red"/></svg>')
        obj = SVGMobject(str(svg))
        mapper = Mapper(self.root/"assets")
        for leaf, parents in leaves(obj):
            item = mapper.make_track(leaf, leaf, parents, 0)
            self.assertEqual(item.element["graphic"]["definitionId"], "path")
            self.assertIn("C", item.element["graphic"]["params"]["d"])
        # Substitute only the external compiler artifact: exercise real Tex /
        # MathTex objects and their grouping without requiring a TeX install.
        svg.write_text('<svg xmlns="http://www.w3.org/2000/svg"><g id="unique000"><path d="M0 0L10 0L10 20L0 20Z"/></g></svg>')
        with patch("manim.mobject.text.tex_mobject.tex_to_svg_file", return_value=svg):
            for cls in (MathTex, Tex):
                tex = cls("x")
                glyphs = list(leaves(tex))
                self.assertTrue(glyphs)
                for leaf, parents in glyphs:
                    item = mapper.make_track(leaf, leaf, parents, 0)
                    self.assertEqual(item.element["graphic"]["definitionId"], "path")
                    self.assertIn("TeX:", item.element["name"])

    def test_cubic_subpaths_and_coordinates(self):
        self.assertEqual(Coordinates().point([2, 1, 0]), [270., -135.])
        p = VMobject().set_points_as_corners([LEFT, UP, RIGHT, LEFT]).points
        d = svg_path(np.concatenate([p, p+RIGHT*4]))
        self.assertEqual(d.count("M"), 2)
        self.assertEqual(d.count("Z"), 2)
        fit = fit_transform(p, (p @ np.array([[0,1,0],[-1,0,0],[0,0,1]]))*2+RIGHT*3)
        self.assertAlmostEqual(fit[1], 2)
        self.assertAlmostEqual(fit[3], -90)
        self.assertLess(fit[4], 1e-8)

    def test_reduction_and_slice(self):
        samples = [(i/10, i) for i in range(11)]
        self.assertEqual(len(reduce_keys(samples, .001)), 2)
        self.assertEqual(clip_samples(samples, .25, .75)[0], (.25, 2.5))
        pulse = [(0, 0), (.5, 1), (1, 0)]
        self.assertEqual(len(reduce_keys(pulse, .01)), 3)
        rows = markers_from_json([{"name":"First","duration":1},{"name":"Second","duration":2}], 3)
        self.assertEqual(rows[1]["start"], 1)
        with self.assertRaises(ValueError):
            markers_from_json([{"start":0,"end":2},{"start":1,"end":3}], 3)

    def test_fades_transform_pulses_and_draw(self):
        class Example(Scene):
            def construct(self):
                square = Square(fill_opacity=1)
                arrow = Arrow(LEFT, RIGHT)
                self.play(FadeIn(square, shift=UP), run_time=.4)
                self.play(square.animate.shift(RIGHT).scale(.8).set_color(RED), run_time=.4)
                self.play(Indicate(square), Wiggle(square.copy()), run_time=.4)
                self.play(GrowArrow(arrow), run_time=.4)
                self.play(Flash(square), run_time=.3)
                self.play(FadeOut(square), run_time=.4)
                self.wait(.2)
        recorder, draft, report = self.record(Example)
        keys = [k for e in draft["ops"][0]["elements"] for k in e.get("keyframes", [])]
        paths = {k["path"] for k in keys}
        self.assertTrue({"opacity", "transform.positionX", "transform.scaleX", "drawProgress", "fill"} <= paths)
        self.assertEqual(report["fallback_count"], 0)
        self.assertAlmostEqual(recorder.time, 2.5)

    def test_lagged_start_updater_and_camera(self):
        class Example(MovingCameraScene):
            def construct(self):
                group = VGroup(Square().shift(LEFT), Circle().shift(RIGHT))
                self.play(LaggedStart(*[FadeIn(m) for m in group], lag_ratio=1), run_time=1)
                tracker = ValueTracker(0)
                dot = always_redraw(lambda: Dot([tracker.get_value(), 0, 0]))
                self.add(dot)
                self.camera.frame.add_updater(lambda frame: frame.move_to(dot))
                self.add(self.camera.frame)
                self.play(tracker.animate.set_value(3), rate_func=lambda x:x*x, run_time=1)
                self.camera.frame.clear_updaters()
                self.wait(.1)
        recorder, draft, _ = self.record(Example)
        keys = draft["ops"][0]["keyframes"]
        self.assertTrue(any(k["path"] == "transform.positionX" for k in keys))
        self.assertGreater(len(recorder.camera_samples), 20)
        circles = [t for t in recorder.mapper.tracks if t.source_type == "Circle" and t.samples]
        self.assertTrue(circles)
        self.assertLess(circles[0].samples[3][1]["opacity"], .01)

    def test_morphs_never_become_video(self):
        class Example(Scene):
            def construct(self):
                shape = Square(fill_opacity=1)
                self.add(shape)
                self.play(Transform(shape, Circle(fill_opacity=1)), run_time=.6)
                self.play(ReplacementTransform(shape, Triangle(fill_opacity=1)), run_time=.6)
                self.wait(.2)
        _, draft, report = self.record(Example)
        self.assertEqual(report["fallback_count"], 0)
        self.assertTrue(any(e.get("graphic", {}).get("definitionId") == "path" for e in draft["ops"][0]["elements"]))
        self.assertGreater(len(report["phrases"][0]["approximations"]), 0)

    def test_create_write_and_group(self):
        class Example(Scene):
            def construct(self):
                g = VGroup(Line(LEFT, RIGHT), Text("Readable text", font="Arial").shift(UP))
                self.add(g)
                self.play(Create(g[0]), Write(g[1]), run_time=.5)
                self.wait(.1)
        _, draft, report = self.record(Example)
        elements = draft["ops"][0]["elements"][1:]
        self.assertTrue(any("text" in e for e in elements))
        self.assertTrue(any("group" in e for e in elements))
        self.assertTrue(report["groups"])

    def test_image_and_fallback(self):
        class Example(Scene):
            def construct(self):
                self.add(ImageMobject(np.full((12,16,3), 255, dtype=np.uint8)))
                surface = Square(fill_opacity=1)
                surface.shade_in_3d = True
                self.add(surface)
                self.wait(.2)
        _, draft, report = self.record(Example)
        self.assertEqual(report["fallback_count"], 1)
        self.assertEqual(report["video_elements"], 0)
        self.assertEqual(len(list((self.root/"assets").glob("*.png"))), 2)
        self.assertAlmostEqual(report["phrases"][0]["fallbacks"][0]["duration"], .2)

    def test_split_keeps_cross_boundary_animation(self):
        class Example(Scene):
            def construct(self):
                m = Square()
                self.add(m)
                self.play(m.animate.shift(RIGHT*2), run_time=2, rate_func=linear)
        recorder, _, _ = self.record(Example)
        markers = markers_from_json([{"duration":1},{"duration":1}], 2)
        draft, _ = build_draft(recorder, Coordinates(), name="Test", agent_id="split", start=5, markers=markers)
        self.assertEqual([o["start"] for o in draft["ops"]], [5, 6])
        a = draft["ops"][0]["elements"][1]
        b = draft["ops"][1]["elements"][1]
        self.assertAlmostEqual(a["keyframes"][-1]["time"], 1)
        self.assertAlmostEqual(b["start"], 0)

    def test_no_video_renderer_or_encoder(self):
        class Example(Scene):
            def construct(self):
                self.play(FadeIn(Square()), run_time=.1)
                self.wait(.1)
        with patch("subprocess.Popen", side_effect=AssertionError("Encoder started")), patch("manim.renderer.cairo_renderer.SceneFileWriter", side_effect=AssertionError("Movie writer constructed")):
            recorder, _, _ = self.record(Example)
        self.assertEqual(recorder.file_writer.__class__.__name__, "RecordingWriter")

    def test_redirected_source_writes(self):
        source, dest = self.root/"source", self.root/"dest"
        source.mkdir()
        (source/"input.txt").write_text("original")
        with redirect_writes(source, dest):
            self.assertEqual((source/"input.txt").read_text(), "original")
            (source/"nested").mkdir(exist_ok=True)
            (source/"nested"/"result.txt").write_text("output")
        self.assertFalse((source/"nested").exists())
        self.assertEqual((dest/"nested"/"result.txt").read_text(), "output")

    def test_text_replacement_retains_wording_and_world_position(self):
        class Example(Scene):
            def construct(self):
                source = Text("First title", font="Arial").shift(UP*2)
                target = Text("New wording", font="Arial").shift(UP*2)
                self.add(source)
                self.play(ReplacementTransform(source, target), run_time=.6)
                self.wait(.2)
        recorder, draft, _ = self.record(Example)
        texts = [t for t in recorder.mapper.tracks if "text" in t.element and t.samples]
        self.assertTrue(any(t.element["text"] == "New wording" for t in texts))
        for t in texts:
            for _, sample in t.samples:
                self.assertAlmostEqual(sample["y"], 2, places=5)

    def test_wait_stop_condition_and_sections(self):
        class Example(Scene):
            def construct(self):
                tracker = ValueTracker(0)
                tracker.add_updater(lambda m, dt:m.increment_value(dt))
                self.add(tracker)
                self.next_section("First")
                self.wait(1, stop_condition=lambda:tracker.get_value() >= .2)
                self.next_section("Second")
                self.wait(.1)
        recorder, _, report = self.record(Example)
        self.assertLess(recorder.time, .5)
        self.assertEqual(len(recorder.markers), 2)
        self.assertEqual(report["fallback_count"], 0)

    def test_paint_order_changes_and_shared_descendants(self):
        class Example(Scene):
            def construct(self):
                a, b = Square(fill_opacity=1), Circle(fill_opacity=1)
                self.add(VGroup(a,b), VGroup(a))
                self.wait(.2)
                self.bring_to_front(b)
                self.wait(.2)
        recorder, draft, _ = self.record(Example)
        order = recorder.mapper.ordered_tracks()
        def types_at(time):
            return [t.source_type for t in order if t.samples and t.first <= time < t.end]
        self.assertEqual(types_at(.1), ["Circle", "Square"])
        self.assertEqual(types_at(.3), ["Square", "Circle"])

    def test_camera_discontinuities_survive_editor_ticks(self):
        class Example(MovingCameraScene):
            def construct(self):
                self.add(Square())
                self.wait(1)
                self.camera.frame.shift(RIGHT*3)
                self.wait(1)
        _, draft, _ = self.record(Example)
        keys = [k for k in draft["ops"][0]["keyframes"] if k["path"] == "transform.positionX"]
        times = [round(k["time"]*120000) for k in keys]
        self.assertEqual(len(times), len(set(times)))
        self.assertGreaterEqual(len(keys), 4)


if __name__ == "__main__":
    unittest.main()
