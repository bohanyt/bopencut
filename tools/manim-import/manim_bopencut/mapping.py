"""Map retained mobject geometry to editable elements and sampled properties."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image
from manim.camera.three_d_camera import ThreeDCamera
from manim import (Arrow, Circle, DashedLine, Dot, Ellipse, ImageMobject,
                   Line, MarkupText, Rectangle, RoundedRectangle, Text, ValueTracker, VMobject)

from .geometry import bounds, fit_transform, rgba, svg_path


def points_of(mobject):
    if isinstance(mobject, (Text, MarkupText, ImageMobject, Arrow, DashedLine)) or getattr(mobject, "shade_in_3d", False) or "Surface" in type(mobject).__name__:
        return np.asarray(mobject.get_all_points()).copy()
    return np.asarray(mobject.points).copy()


def leaves(root, parents=()):
    """Text and arrows are semantic leaves; groups and SVGs retain their parts."""
    if isinstance(root, ValueTracker):
        return
    if isinstance(root, (Text, MarkupText, ImageMobject, Arrow, DashedLine)):
        yield root, parents
        return
    if getattr(root, "shade_in_3d", False) or "Surface" in type(root).__name__:
        yield root, parents
        return
    if len(root.points):
        yield root, parents
    for child in root.submobjects:
        yield from leaves(child, (*parents, root))


def style(mobject):
    if isinstance(mobject, ImageMobject):
        return {"opacity": float(np.mean(mobject.pixel_array[:, :, 3])) / 255}
    if not isinstance(mobject, VMobject):
        return {"opacity": 1.0}
    members = mobject.family_members_with_points()
    painted = members[0] if members else mobject
    fill_alpha = float(np.max(painted.get_fill_opacity()))
    stroke_alpha = float(np.max(painted.get_stroke_opacity()))
    stroke_width = float(np.max(painted.get_stroke_width()))
    opacity = max(fill_alpha, stroke_alpha if stroke_width > 0 else 0)
    denominator = max(opacity, 1e-9)
    return {"opacity": opacity,
            "fill": rgba(painted.get_fill_color(), fill_alpha / denominator),
            "stroke": rgba(painted.get_stroke_color(), stroke_alpha / denominator),
            "stroke_world": stroke_width * 0.01}


@dataclass
class Track:
    key: str
    object_id: str
    source_type: str
    element: dict
    reference: np.ndarray
    center: np.ndarray
    side: float
    samples: list = field(default_factory=list)
    first: float = 0
    end: float = 0
    z: float = 0
    order: int = 0
    parents: tuple = ()
    fallback: str | None = None
    closed: bool = False


class Mapper:
    def __init__(self, asset_dir: Path, geometry_tolerance=0.002, morph_step=0.2):
        self.asset_dir = asset_dir
        self.geometry_tolerance = geometry_tolerance
        self.morph_step = morph_step
        self.identities = {}
        self.tracks: list[Track] = []
        self.active: dict[int, Track] = {}
        self.groups = {}
        self.approximations = []
        self._warnings = set()
        self.scene = None
        self.previous_order = []
        self.order_edges = set()

    def identity(self, obj):
        # Retain references: CPython can reuse ids when a scene removes objects.
        if id(obj) not in self.identities:
            self.identities[id(obj)] = (obj, f"m{len(self.identities)+1:05d}")
        return self.identities[id(obj)][1]

    def warn(self, object_id, reason, time):
        key = (object_id, reason)
        if key not in self._warnings:
            self._warnings.add(key)
            self.approximations.append({"object": object_id, "reason": reason, "start": time})

    def prime(self, roots, time=0, force_paths=()):
        for root in roots:
            for obj, parents in leaves(root):
                if id(obj) not in self.active and len(points_of(obj)):
                    self.make_track(obj, obj, parents, time, force_path=id(obj) in force_paths)

    def make_track(self, obj, visual, parents, time, force_path=False):
        object_id = self.identity(obj)
        points = points_of(visual)
        center, size = bounds(points)
        painted = style(visual)
        stroke = painted.get("stroke_world", 0)
        side = float(max(size) + 2 * stroke + 0.002)
        element = {"name": type(visual).__name__}
        source_type = type(visual).__name__
        fallback = None
        kind = "path"
        projected = self.scene is not None and isinstance(self.scene.camera, ThreeDCamera)
        if isinstance(visual, (Text, MarkupText)) and not projected:
            kind = "text"
            basis = getattr(visual, "_bopencut_text_basis", None)
            if basis is not None:
                points = basis[0].copy()
                center, size = bounds(points)
                side = max(size)
                font_size = basis[1]
            else:
                font_size = visual.font_size
            content = getattr(visual, "original_text", visual.text)
            if isinstance(visual, MarkupText):
                import html
                content = html.unescape(re.sub(r"<[^>]*>", "", content))
                self.warn(object_id, "Markup styles are flattened to the first text style", time)
            element.update(text=content, font_world=font_size / 72,
                           params={"fontFamily": visual.font or "sans-serif",
                                   "fontWeight": "bold" if str(visual.weight).upper() in ("BOLD", "700", "HEAVY") else "normal",
                                   "fontStyle": "italic" if str(visual.slant).upper() != "NORMAL" else "normal",
                                   "textAlign": "center", "lineHeight": 1.3, "glyphAnchor": True})
            element["name"] = content[:70] or source_type
        elif isinstance(visual, ImageMobject) and not projected:
            kind = "image"
            self.asset_dir.mkdir(parents=True, exist_ok=True)
            filename = f"{object_id}.png"
            Image.fromarray(visual.pixel_array).save(self.asset_dir / filename)
            element["asset"] = {"path": str(self.asset_dir / filename), "type": "image", "name": source_type}
            element["image_alpha"] = max(painted["opacity"], 1e-9)
            edge = points[1]-points[0]
            angle = math.atan2(edge[1], edge[0])
            rotation = np.array([[math.cos(angle), -math.sin(angle)], [math.sin(angle), math.cos(angle)]])
            points[:, :2] = (points[:, :2]-center) @ rotation + center
            center, size = bounds(points)
        elif projected or not isinstance(visual, VMobject) or getattr(visual, "shade_in_3d", False) or "Surface" in source_type:
            kind = "image"
            fallback = "Unsupported raster/3D appearance: isolated transparent still; internal deformation is frozen"
            element["asset"], center, size = self.rasterize(visual, object_id)
            element["image_alpha"] = max(painted["opacity"], 1e-9)
            points = np.array([[center[0]-size[0]/2, center[1]-size[1]/2, 0],
                               [center[0]+size[0]/2, center[1]+size[1]/2, 0]])
            side = max(size)
        elif not force_path and isinstance(visual, Rectangle):
            # Canonical rectangle geometry follows its first straight edge.
            vertices = visual.get_vertices() if not isinstance(visual, RoundedRectangle) else None
            if vertices is not None and len(vertices) == 4:
                edge = vertices[1]-vertices[0]
                angle = math.atan2(edge[1], edge[0])
            else:
                vectors = points.reshape(-1, 4, 3)[:, 3] - points.reshape(-1, 4, 3)[:, 0]
                edge = vectors[np.argmax(np.linalg.norm(vectors, axis=1))]
                angle = math.atan2(edge[1], edge[0])
            rotation = np.array([[math.cos(angle), -math.sin(angle)], [math.sin(angle), math.cos(angle)]])
            points[:, :2] = (points[:, :2]-center) @ rotation + center
            center, size = bounds(points)
            side = float(max(size) + 2*stroke + 0.002)
            kind = "rectangle"
            radius = getattr(visual, "corner_radius", 0)
            # Rounded rectangles can already have been scaled before first use.
            if isinstance(visual, RoundedRectangle):
                curves = points.reshape(-1, 4, 3)
                curved = [c for c in curves if np.linalg.norm(np.cross(c[1]-c[0], c[3]-c[0])) > 1e-9]
                if curved:
                    radius = min(np.linalg.norm(curved[0][-1,:2]-curved[0][0,:2])/math.sqrt(2), min(size)/2)
            element["graphic"] = {"definitionId": kind, "params": {"shapeWidth": (size[0]+stroke)/side, "shapeHeight": (size[1]+stroke)/side,
                                      "cornerRadius": min(50, float(radius / max(min(size),1e-9)*100)), "strokeAlign": "center"}}
        elif not force_path and isinstance(visual, (Circle, Ellipse, Dot)):
            kind = "ellipse"
            # Axis orientation of the first anchor is retained in the fit.
            angle = math.atan2(points[0,1]-center[1], points[0,0]-center[0])
            rotation = np.array([[math.cos(angle), -math.sin(angle)], [math.sin(angle), math.cos(angle)]])
            points[:, :2] = (points[:, :2]-center) @ rotation + center
            center, size = bounds(points)
            side = float(max(size)+2*stroke+0.002)
            element["graphic"] = {"definitionId": kind, "params": {"shapeWidth": (size[0]+stroke)/side, "shapeHeight": (size[1]+stroke)/side}}
        elif not force_path and isinstance(visual, (Line, Arrow, DashedLine)) and not getattr(visual, "path_arc", 0):
            kind = "arrow" if isinstance(visual, Arrow) else "line"
            start, end = visual.get_start(), visual.get_end()
            length = np.linalg.norm(end-start)
            center = (start[:2]+end[:2])/2
            side = max(length/0.96, 1e-5)
            angle = math.atan2(end[1]-start[1], end[0]-start[0])
            rotation = np.array([[math.cos(angle), -math.sin(angle)], [math.sin(angle), math.cos(angle)]])
            points[:, :2] = (points[:, :2]-center) @ rotation + center
            element["graphic"] = {"definitionId": kind, "params": {"lineCap": "butt"}}
            if isinstance(visual, DashedLine):
                element["graphic"]["params"]["dash"] = visual.dash_length / side * 512
            if isinstance(visual, Arrow):
                element["graphic"]["params"].update(headStyle="triangle", headSize=min(48, visual.tip.length / side * 100), headFill=painted["stroke"])
                self.warn(object_id, "Arrowhead uses the editor's triangle geometry", time)
        if kind == "path":
            relative = points.copy()
            relative[:, :2] -= center
            element["graphic"] = {"definitionId": "path", "params": {
                "d": svg_path(relative), "viewBox": f"{-side/2} {-side/2} {side} {side}", "lineCap": "butt"}}
        tex = next((getattr(parent, "tex_string", None) for parent in reversed(parents) if getattr(parent, "tex_string", None)), None)
        if tex:
            element["name"] = f"TeX: {tex[:60]}"
        key = f"{object_id}-v{sum(t.object_id == object_id for t in self.tracks)}"
        track = Track(key, object_id, source_type, element, points, np.asarray(center), float(side),
                      first=time, end=time, parents=tuple(self.identity(p) for p in parents), fallback=fallback)
        self.tracks.append(track)
        self.active[id(obj)] = track
        return track

    def rasterize(self, obj, object_id):
        if self.scene is None:
            raise ValueError("Raster fallback needs a scene camera")
        camera = self.scene.camera
        old_opacity = camera.background_opacity
        try:
            camera.background_opacity = 0
            camera.init_background()
            camera.reset()
            camera.capture_mobjects([obj])
            image = Image.fromarray(camera.pixel_array.copy())
            box = image.getbbox()
            if box is None:
                box = (0, 0, 1, 1)
            image = image.crop(box)
            self.asset_dir.mkdir(parents=True, exist_ok=True)
            filename = self.asset_dir / f"{object_id}-fallback.png"
            image.save(filename)
            scale = camera.frame_width / camera.pixel_width
            center = np.array([((box[0]+box[2])/2-camera.pixel_width/2)*scale+camera.frame_center[0],
                               (camera.pixel_height/2-(box[1]+box[3])/2)*scale+camera.frame_center[1]])
            return {"path": str(filename), "type": "image", "name": "Isolated fallback"}, center, np.array(image.size)*scale
        finally:
            camera.background_opacity = old_opacity
            camera.init_background()
            camera.reset()

    def capture(self, roots, time, reveal=None, replacements=None):
        reveal = reveal or {}
        replacements = replacements or {}
        seen = set()
        ordered = []
        for root in roots:
            for obj, parents in leaves(root):
                if id(obj) in replacements:
                    ordered.extend((substitute, parents) for substitute in replacements[id(obj)])
                else:
                    ordered.append((obj, parents))
        # Cairo retains the last occurrence of shared descendants. Animation
        # groups can reintroduce a nested leaf above its original parent.
        unique = {}
        for obj, parents in reversed(ordered):
            unique.setdefault(id(obj), (obj, parents))
        ordered = sorted(reversed(list(unique.values())), key=lambda pair: pair[0].z_index)
        current_order = [id(obj) for obj, _ in ordered if len(points_of(obj))]
        common = set(current_order) & set(self.previous_order)
        before = [key for key in self.previous_order if key in common]
        after = [key for key in current_order if key in common]
        if before != after:
            old_rank = {key: index for index, key in enumerate(before)}
            for index, key in enumerate(after):
                if old_rank[key] != index and key in self.active:
                    self.active[key].closed = True
                    self.active[key].end = time
        self.previous_order = current_order
        captured = []
        for order, (obj, parents) in enumerate(ordered):
            if id(obj) in seen or not len(points_of(obj)):
                continue
            seen.add(id(obj))
            visual, progress = reveal.get(id(obj), (obj, None))
            track = self.active.get(id(obj))
            if track is None or track.closed:
                track = self.make_track(obj, visual, parents, time)
            current = points_of(visual)
            fit = fit_transform(track.reference, current)
            if track.fallback:
                fit = None
            if fit is None or fit[4] > self.geometry_tolerance:
                if track.fallback:
                    fit = (track.center, 1., 1., 0., 0.)
                elif time - track.first >= self.morph_step or not track.samples:
                    track.closed = True
                    track.end = time
                    self.warn(track.object_id, "Non-affine deformation uses sampled editable path variants", time)
                    track = self.make_track(obj, visual, parents, time, force_path=True)
                    fit = fit_transform(track.reference, current)
                if fit is None:
                    fit = (track.center, 1., 1., 0., 0.)
            position, sx, sy, rotation, _ = fit
            painted = style(visual)
            values = {"x": float(position[0]), "y": float(position[1]),
                      "sx": max(sx, 1e-6), "sy": max(sy, 1e-6), "rotation": rotation,
                      "opacity": painted["opacity"]}
            if "image_alpha" in track.element:
                values["opacity"] /= track.element["image_alpha"]
            if "graphic" in track.element:
                values.update(fill=painted.get("fill", "#00000000"), stroke=painted.get("stroke", "#00000000"),
                              strokeWidth=painted.get("stroke_world", 0) / track.side * 512 / max((sx+sy)/2, 1e-6))
                if track.element["graphic"]["definitionId"] in ("path", "line", "arrow"):
                    values["drawProgress"] = 1. if progress is None else float(progress)
                if track.element["graphic"]["definitionId"] == "arrow":
                    values["headFill"] = values["stroke"]
            elif "text" in track.element:
                values["color"] = painted.get("fill", "#ffffffff")
                if progress is not None:
                    values["opacity"] *= float(progress)
                    self.warn(track.object_id, "Write/Create on native text uses an opacity reveal; glyph stroke order is approximated", time)
            track.z = float(obj.z_index)
            track.order = order
            track.parents = tuple(self.identity(p) for p in parents) or track.parents
            for index, parent in enumerate(parents):
                gid = self.identity(parent)
                self.groups[gid] = {"id": gid, "type": type(parent).__name__,
                                    "parent": self.identity(parents[index-1]) if index else None}
            if track.samples and abs(track.samples[-1][0]-time) < 1e-9:
                if track.samples[-1][1] != values and time > track.first+1e-4:
                    track.samples[-1] = (time-1e-4, track.samples[-1][1])
                    track.samples.append((time, values))
                else:
                    track.samples[-1] = (time, values)
            else:
                track.samples.append((time, values))
            track.end = time
            captured.append(track.key)
        self.order_edges.update(zip(captured, captured[1:]))
        for key, track in self.active.items():
            if key not in seen and track.samples and not track.closed:
                track.end = time
                track.closed = True

    def ordered_tracks(self):
        """One layer order satisfying all sampled paint-order constraints."""
        import heapq
        by_key = {track.key: track for track in self.tracks}
        outgoing = {key: set() for key in by_key}
        degrees = {key: 0 for key in by_key}
        for lower, upper in self.order_edges:
            if lower != upper and upper not in outgoing[lower]:
                outgoing[lower].add(upper)
                degrees[upper] += 1
        ready = [key for key, degree in degrees.items() if degree == 0]
        heapq.heapify(ready)
        result = []
        while ready:
            key = heapq.heappop(ready)
            result.append(by_key[key])
            for upper in outgoing[key]:
                degrees[upper] -= 1
                if degrees[upper] == 0:
                    heapq.heappush(ready, upper)
        if len(result) != len(by_key):
            raise ValueError("Conflicting paint-order samples; reduce sample interval")
        return result
