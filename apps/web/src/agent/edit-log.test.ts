import { describe, expect, test } from "bun:test";
import { createEditLogger, diffEdits, type EditSnapshot } from "./edit-log";
import { summarizeEdits } from "./edits-summary";
const item = { id: "e", agentId: "a", name: "Clip", media: null, type: "video", track: "Utama", sceneId: "main", path: [] as string[], startTime: 0, duration: 3, trimStart: 0, trimEnd: 0, params: { "transform.positionX": 0 }, animations: {} };
const snap = (startTime: number): EditSnapshot => ({ projectId: "p", items: [{ ...item, startTime }] });
const wait = () => new Promise((resolve) => setTimeout(resolve, 900));
describe("edit log", () => {
 test("diff, additions, deletion, and project boundary", () => {
  expect(diffEdits(snap(0), snap(1)).map((x) => [x.field, x.from, x.to])).toEqual([["startTime", 0, 1]]);
  expect(diffEdits(snap(0), { projectId: "p", items: [] })[0].kind).toBe("delete");
  expect(diffEdits({ projectId: "p", items: [] }, { projectId: "p", items: [{ ...item, agentId: null }] })[0].kind).toBe("add");
  expect(diffEdits(snap(0), { ...snap(2), projectId: "other" })).toEqual([]);
 });
 test("coalesces previews and suppresses agent and undo", async () => {
  let current = snap(0); let preview = true; const sent: any[] = [];
  const logger = createEditLogger(() => current, () => preview, (lines) => sent.push(...lines));
  current = snap(1); logger.changed(); current = snap(2); logger.changed(); await wait(); expect(sent).toHaveLength(0);
  preview = false; logger.changed(); await wait(); expect(sent.map((x) => [x.from, x.to])).toEqual([[0, 2]]);
  logger.agent(() => { current = snap(5); logger.changed(); }); await wait();
  logger.agent(() => { current = snap(2); logger.changed(); }); await wait(); expect(sent).toHaveLength(1);
  current = snap(3); logger.changed(); current = snap(2); logger.changed(); await wait(); expect(sent).toHaveLength(1);
 });
 test("aggregates counts, projects, median and threshold", () => {
  const lines = [diffEdits(snap(0), snap(1))[0], diffEdits(snap(1), snap(3))[0], { ...diffEdits(snap(3), snap(6))[0], projectId: "q" }];
  expect(summarizeEdits(lines)[0]).toMatchObject({ count: 3, projects: 2, medianDelta: 2, ruleCandidate: true });
 });
});
