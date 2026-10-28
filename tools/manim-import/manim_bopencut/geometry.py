"""Geometry and animation helpers, independent of scene execution."""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np


@dataclass
class Coordinates:
    width: int = 1920
    height: int = 1080
    frame_width: float = 128 / 9
    frame_height: float = 8

    @property
    def ppu(self):
        return self.width / self.frame_width

    def point(self, point):
        return [float(point[0] * self.ppu), float(-point[1] * self.ppu)]


def bounds(points):
    points = np.asarray(points)
    if not len(points):
        return np.zeros(2), np.ones(2) * 1e-6
    lo, hi = points[:, :2].min(axis=0), points[:, :2].max(axis=0)
    return (lo + hi) / 2, np.maximum(hi - lo, 1e-6)


def svg_path(points):
    """Keep cubic curves and disconnected subpaths, including glyph holes."""
    points = np.asarray(points)
    if len(points) % 4:
        raise ValueError("Expected Cairo cubic Bezier points (four per curve)")
    parts, previous, first = [], None, None
    def pair(p):
        return f"{p[0]:.7g},{-p[1]:.7g}"
    for curve in points.reshape((-1, 4, 3)):
        if previous is None or not np.allclose(previous, curve[0], atol=1e-7):
            if first is not None and np.allclose(previous, first, atol=1e-7):
                parts.append("Z")
            parts.append("M" + pair(curve[0]))
            first = curve[0]
        parts.append("C" + " ".join(pair(p) for p in curve[1:]))
        previous = curve[-1]
    if first is not None and np.allclose(previous, first, atol=1e-7):
        parts.append("Z")
    return " ".join(parts)


def fit_transform(reference, current):
    """Fit translation, rotation and axis scales; return residual in world units.

    A similarity fit also works for rank-one objects (straight lines). The
    general fit detects shear, which is emitted as an editable path variant.
    """
    reference, current = np.asarray(reference), np.asarray(current)
    if reference.shape != current.shape or not len(reference):
        return None
    x, y = reference[:, :2], current[:, :2]
    cx, cy = x.mean(axis=0), y.mean(axis=0)
    a, b = x - cx, y - cy
    denom = float(np.sum(a * a))
    if denom < 1e-14:
        return None
    dot = float(np.sum(a * b)) / denom
    cross = float(np.sum(a[:, 0] * b[:, 1] - a[:, 1] * b[:, 0])) / denom
    matrix = np.array([[dot, cross], [-cross, dot]])
    if np.linalg.matrix_rank(a, tol=1e-8) == 2:
        matrix = np.linalg.lstsq(a, b, rcond=None)[0]
    sx, sy = np.linalg.norm(matrix, axis=1)
    angle = math.atan2(matrix[0, 1], matrix[0, 0])
    rotation = np.array([[math.cos(angle), math.sin(angle)], [-math.sin(angle), math.cos(angle)]])
    representable = np.diag([sx, sy]) @ rotation
    error = float(np.max(np.linalg.norm(a @ representable - b, axis=1)))
    center, _ = bounds(reference)
    position = (center - cx) @ matrix + cy
    return position, float(sx), float(sy), -math.degrees(angle), error


def rgba(color, opacity=1):
    rgb = np.round(np.clip(color.to_rgb(), 0, 1) * 255).astype(int)
    return "#" + "".join(f"{v:02x}" for v in rgb) + f"{round(np.clip(opacity, 0, 1)*255):02x}"


def value_vector(value):
    if isinstance(value, str) and value.startswith("#"):
        s = value[1:]
        if len(s) == 6:
            s += "ff"
        return np.array([int(s[i:i+2], 16) / 255 for i in range(0, 8, 2)])
    return np.atleast_1d(float(value))


def interpolate(a, b, alpha):
    if isinstance(a, str):
        channels = value_vector(a) * (1-alpha) + value_vector(b) * alpha
        return "#" + "".join(f"{round(c*255):02x}" for c in channels)
    return a + (b - a) * alpha


def reduce_keys(samples, tolerance):
    """Time-aware Ramer-Douglas-Peucker reduction with a bounded error."""
    if len(samples) < 3:
        return samples
    keep = {0, len(samples)-1}
    stack = [(0, len(samples)-1)]
    values = np.array([value_vector(value) for _, value in samples])
    times = np.array([time for time, _ in samples])
    while stack:
        first, last = stack.pop()
        if last <= first + 1:
            continue
        span = times[last] - times[first]
        if span <= 0:
            continue
        alpha = (times[first+1:last] - times[first]) / span
        predicted = values[first] + alpha[:, None] * (values[last]-values[first])
        errors = np.max(np.abs(values[first+1:last]-predicted), axis=1)
        index = int(errors.argmax())
        if errors[index] > tolerance:
            middle = first + 1 + index
            keep.add(middle)
            stack.extend([(first, middle), (middle, last)])
    return [samples[i] for i in sorted(keep)]
