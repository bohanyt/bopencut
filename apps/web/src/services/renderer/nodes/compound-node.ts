import type { RootNode } from "./root-node";
import {
	VisualNode,
	type ResolvedVisualNodeState,
	type VisualNodeParams,
} from "./visual-node";

export interface CompoundNodeParams extends VisualNodeParams {
	/** Nested scene tracks (no background); resolved at the nested local time, not the parent time. */
	content: RootNode;
}

export class CompoundNode extends VisualNode<
	CompoundNodeParams,
	ResolvedVisualNodeState
> {}
