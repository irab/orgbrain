/**
 * MCP Tools - aggregated exports
 */

export { ToolHandler } from "./shared.js";
export { queryTools } from "./queries.js";
export { diagramTools } from "./diagrams.js";
export { extractionTools } from "./extraction.js";
export { comparisonTools } from "./comparison.js";

import { queryTools } from "./queries.js";
import { diagramTools } from "./diagrams.js";
import { extractionTools } from "./extraction.js";
import { comparisonTools } from "./comparison.js";

/**
 * All v2 tools combined
 */
export const allTools = [...queryTools, ...diagramTools, ...extractionTools, ...comparisonTools];
