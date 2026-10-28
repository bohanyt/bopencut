import { graphicsRegistry } from "../registry";
import { ellipseGraphicDefinition } from "./ellipse";
import { polygonGraphicDefinition } from "./polygon";
import { rectangleGraphicDefinition } from "./rectangle";
import { starGraphicDefinition } from "./star";
import { iconGraphicDefinition } from "./icon";
import { lineGraphicDefinition, arrowGraphicDefinition, pathGraphicDefinition } from "./strokes";

const defaultGraphicDefinitions = [
	rectangleGraphicDefinition,
	ellipseGraphicDefinition,
	polygonGraphicDefinition,
	starGraphicDefinition,
	lineGraphicDefinition,
	arrowGraphicDefinition,
	pathGraphicDefinition,
	iconGraphicDefinition,
];

export function registerDefaultGraphics(): void {
	for (const definition of defaultGraphicDefinitions) {
		if (graphicsRegistry.has(definition.id)) {
			continue;
		}
		graphicsRegistry.register({
			key: definition.id,
			definition,
		});
	}
}

export {
	ellipseGraphicDefinition,
	polygonGraphicDefinition,
	rectangleGraphicDefinition,
	starGraphicDefinition,
};
export { STROKE_ALIGN_PARAM } from "./shared";
