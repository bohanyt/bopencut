import type { ParamValues } from "@/params";
import { VisualNode, type ResolvedVisualSourceNodeState, type VisualNodeParams } from "./visual-node";

export interface Model3dNodeParams extends VisualNodeParams {
	mediaId: string;
	file: File;
	params: ParamValues;
}
export class Model3dNode extends VisualNode<Model3dNodeParams, ResolvedVisualSourceNodeState> {}
