"""Timeline slicing, camera placement and draft/report generation."""

from __future__ import annotations

import copy
import math
from pathlib import Path

import numpy as np

from .geometry import bounds, interpolate, reduce_keys, value_vector


def at(samples, time):
    if time <= samples[0][0]:
        return samples[0][1]
    for (left, a), (right, b) in zip(samples, samples[1:]):
        if time <= right:
            return interpolate(a, b, (time-left)/max(1e-12, right-left))
    return samples[-1][1]


def clip_samples(samples, start, end):
    return [(start, at(samples, start)), *[(t, v) for t, v in samples if start < t < end], (end, at(samples, end))]


def markers_from_json(data, duration, key=None):
    if isinstance(data, dict):
        if key:
            data = data[key]
        elif "markers" in data:
            data = data["markers"]
        elif "phrases" in data:
            data = data["phrases"]
        else:
            raise ValueError("Marker file contains sections: select one with --split-key")
    if not isinstance(data, list) or not data:
        raise ValueError("Expected a non-empty marker list")
    result, cursor = [], 0.
    for i, row in enumerate(data):
        if isinstance(row, (int, float)):
            row = {"start": row}
        start = float(row.get("start", cursor))
        span = row.get("duration", row.get("durasi"))
        end = float(row.get("end", start + float(span))) if span is not None else row.get("end")
        result.append({"name": str(row.get("name", row.get("id", row.get("kode", f"Part {i+1}")))),
                       "start": start, "end": end})
        cursor = end if end is not None else start
    for i, row in enumerate(result):
        if row["end"] is None:
            row["end"] = result[i+1]["start"] if i+1 < len(result) else duration
        row["end"] = float(row["end"])
        if not all(math.isfinite(row[k]) for k in ("start", "end")) or row["start"] < 0 or row["end"] <= row["start"]:
            raise ValueError("Markers must have finite, positive, ordered spans")
        if i and abs(row["start"]-result[i-1]["end"]) > 0.002:
            raise ValueError("Markers must cover the scene contiguously without overlap")
    if abs(result[0]["start"]) > 0.002 or abs(result[-1]["end"]-duration) > max(0.05, duration*1e-6):
        raise ValueError(f"Marker duration {result[-1]['end']:g} does not match recorded duration {duration:g}")
    result[0]["start"] = 0.
    result[-1]["end"] = duration
    return result


def keyframes(channels, start, end, tolerance=0.35):
    params, keys = {}, []
    for path, values in channels.items():
        values = clip_samples(values, start, end)
        if path == "transform.rotate":
            angles = np.degrees(np.unwrap(np.radians([v for _, v in values])))
            values = [(t, float(v)) for (t, _), v in zip(values, angles)]
        params[path] = values[0][1]
        epsilon = tolerance if "position" in path else tolerance/1000 if "scale" in path else 0.002 if path in ("opacity", "drawProgress") else 1/255 if isinstance(values[0][1], str) else 0.05
        if all(np.max(np.abs(value_vector(v)-value_vector(values[0][1]))) <= epsilon for _, v in values):
            continue
        for t, value in reduce_keys(values, epsilon):
            keys.append({"path": path, "time": round(t-start, 7),
                         "value": round(value, 7) if isinstance(value, float) else value})
    return params, keys


def build_draft(recorder, coordinates, *, name, agent_id, start=0, track_name="Manim", markers=None, tolerance=0.35, asset_root=None):
    duration = recorder.time
    if duration <= 0:
        raise ValueError("Scene has no duration; add a wait() to hold static content")
    markers = markers or [{"name": name, "start": 0., "end": duration}]
    mapper = recorder.mapper
    ops, phrases = [], []
    mapped = [t for t in mapper.ordered_tracks() if t.samples and t.end > t.first and any(s["opacity"] > 0 for _, s in t.samples)]
    # Fit all visited camera windows inside the nested canvas. A compound is
    # clipped before its parent transform, so this overscan is essential for pan.
    cams = recorder.camera_samples
    xmin = min(c["x"]-c["width"]/2 for _, c in cams)
    xmax = max(c["x"]+c["width"]/2 for _, c in cams)
    ymin = min(c["y"]-c["height"]/2 for _, c in cams)
    ymax = max(c["y"]+c["height"]/2 for _, c in cams)
    origin = ((xmin+xmax)/2, (ymin+ymax)/2)
    overscan = max((xmax-xmin)/coordinates.frame_width, (ymax-ymin)/coordinates.frame_height, 1.) * 1.002
    ppu = coordinates.ppu / overscan
    base = min(coordinates.width, coordinates.height)
    camera_channels = {k: [] for k in ("transform.positionX", "transform.positionY", "transform.scaleX", "transform.scaleY")}
    for t, c in cams:
        zoom = coordinates.frame_width/c["width"]
        values = [(origin[0]-c["x"])*coordinates.ppu*zoom, (c["y"]-origin[1])*coordinates.ppu*zoom, overscan*zoom, overscan*zoom]
        for key, value in zip(camera_channels, values):
            camera_channels[key].append((t, value))
    for index, marker in enumerate(markers):
        left, right = marker["start"], marker["end"]
        prefix = f"{agent_id}-{index+1}"
        elements = [{"agent_id": f"{prefix}-background", "name": "Background", "start": 0, "duration": right-left,
                     "size": [coordinates.width, coordinates.height],
                     "graphic": {"definitionId": "rectangle", "params": {"fill": recorder.camera.background_color.to_hex(), "strokeWidth": 0}},
                     "track": {"name": "Background", "type": "graphic"}}]
        fallback_rows, element_rows = [], []
        for item in mapped:
            begin, end = max(left, item.first), min(right, item.end)
            if end-begin <= 1e-7:
                continue
            element = copy.deepcopy(item.element)
            channels = {}
            def add(path, time, value):
                channels.setdefault(path, []).append((time, value))
            graphic = element.get("graphic")
            for time, sample in item.samples:
                add("transform.positionX", time, (sample["x"]-origin[0])*ppu)
                add("transform.positionY", time, -(sample["y"]-origin[1])*ppu)
                if graphic:
                    sx, sy = item.side*ppu/base*sample["sx"], item.side*ppu/base*sample["sy"]
                elif "asset" in element:
                    _, extent = bounds(item.reference)
                    contain = min(coordinates.width/extent[0], coordinates.height/extent[1])
                    sx, sy = ppu/contain*sample["sx"], ppu/contain*sample["sy"]
                else:
                    sx, sy = sample["sx"], sample["sy"]
                add("transform.scaleX", time, sx)
                add("transform.scaleY", time, sy)
                add("transform.rotate", time, sample["rotation"])
                add("opacity", time, sample["opacity"])
                for key in ("fill", "stroke", "strokeWidth", "color", "drawProgress", "headFill"):
                    if key in sample and (key != "fill" or graphic["definitionId"] not in ("line", "arrow")):
                        add(key, time, sample[key])
            params, keys = keyframes(channels, begin, end, tolerance)
            if graphic:
                for key in ("fill", "stroke", "strokeWidth", "drawProgress", "headFill"):
                    if key in params:
                        graphic["params"][key] = params.pop(key)
            if "text" in element:
                element["params"]["fontSize"] = element.pop("font_world")*ppu*90/coordinates.height
            if "asset" in element:
                element.pop("image_alpha", None)
                asset_path = Path(element["asset"]["path"]).resolve()
                element["asset"]["path"] = asset_path.relative_to(Path(asset_root).resolve()).as_posix() if asset_root else asset_path.as_posix()
            element["params"] = {**element.get("params", {}), **params}
            element.update(agent_id=f"{prefix}-{item.key}", start=round(begin-left, 7), duration=round(end-begin, 7), keyframes=keys,
                           track={"name": item.key, "type": "graphic" if graphic else "text" if "text" in element else "video"})
            if item.parents:
                element["group"] = f"{prefix}-{item.parents[-1]}"
            elements.append(element)
            row = {"object": item.object_id, "element": element["agent_id"], "type": item.source_type,
                   "mapped_to": graphic["definitionId"] if graphic else "text" if "text" in element else "image",
                   "start": begin, "duration": end-begin, "groups": list(item.parents), "keyframes": len(keys)}
            element_rows.append(row)
            if item.fallback:
                fallback_rows.append({**row, "reason": item.fallback})
        params, keys = keyframes(camera_channels, left, right, tolerance)
        ops.append({"op": "compound", "agent_id": prefix, "name": marker["name"], "start": start+left,
                    "duration": right-left, "track": {"name": track_name}, "params": params, "keyframes": keys, "elements": elements})
        objects = {row["object"] for row in element_rows}
        phrases.append({"name": marker["name"], "start": left, "duration": right-left,
                        "native_elements": sum(row["mapped_to"] != "image" for row in element_rows),
                        "image_elements": sum(row["mapped_to"] == "image" for row in element_rows),
                        "fallbacks": fallback_rows, "elements": element_rows,
                        "approximations": [w for w in mapper.approximations if w["object"] in objects]})
    draft = {"schema": "opencut-agent-draft-1", "rev": agent_id, "label": name, "ops": ops}
    report = {"schema": "manim-bopencut-report-1", "scene": name, "duration": duration,
              "canvas": {"width": coordinates.width, "height": coordinates.height},
              "sampling": {"fps": recorder.fps, "every_frames": recorder.sample_every, "pixel_tolerance": tolerance},
              "camera": {"overscan": overscan, "origin": origin, "samples": len(cams), "mode": "compound transform"},
              "native_elements": sum(p["native_elements"] for p in phrases),
              "image_elements": sum(p["image_elements"] for p in phrases),
              "fallback_count": sum(len(p["fallbacks"]) for p in phrases),
              "video_elements": 0, "phrases": phrases, "groups": list(mapper.groups.values()),
              "events": recorder.events, "warnings": recorder.warnings,
              "reference_frames": recorder.saved_references}
    return draft, report
