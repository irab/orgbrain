import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./lib/config-loader.js";
import { toolHandlers } from "./tools.js";
import { allTools } from "./tools/index.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";

// Convert JSON Schema to Zod shape (for server.tool())
function jsonSchemaToZodShape(schema: Record<string, unknown>): Record<string, z.ZodTypeAny> {
  const properties = schema.properties as
    | Record<string, { type?: string; description?: string; enum?: string[] }>
    | undefined;
  const required = (schema.required as string[]) || [];

  if (!properties || Object.keys(properties).length === 0) {
    return {};
  }

  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(properties)) {
    let field: z.ZodTypeAny;

    if (prop.enum) {
      field = z.enum(prop.enum as [string, ...string[]]);
    } else if (prop.type === "number") {
      field = z.number();
    } else if (prop.type === "boolean") {
      field = z.boolean();
    } else {
      field = z.string();
    }

    if (prop.description) {
      field = field.describe(prop.description);
    }

    if (!required.includes(key)) {
      field = field.optional();
    }

    shape[key] = field;
  }

  return shape;
}

async function main() {
  const configPath = process.env.MCP_CONFIG ?? "config/repos.yaml";
  await loadConfig(configPath);

  const server = new McpServer({
    name: "orgbrain",
    version: "0.1.0",
  });

  // Register all tools (legacy + refactored v2)
  [...toolHandlers, ...allTools].forEach(({ name, description, schema, handler }) => {
    const zodShape = jsonSchemaToZodShape(schema);
    server.tool(name, description, zodShape, handler);
  });

  // Register resources for direct file access
  await registerResources(server);

  // Register prompts (slash commands)
  await registerPrompts(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`MCP server ready on stdio with config: ${configPath}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
