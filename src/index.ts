import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./lib/config-loader.js";
import { toolHandlers } from "./tools.js";
import { toolHandlersV2 } from "./tools-v2.js";

async function main() {
  const configPath = process.env.MCP_CONFIG ?? "config/repos.yaml";
  await loadConfig(configPath);

  const server = new McpServer({
    name: "orgbrain",
    version: "0.1.0",
  });

  [...toolHandlers, ...toolHandlersV2].forEach(({ name, description, schema, handler }) => {
    server.tool(name, description, schema, handler);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`MCP server ready on stdio with config: ${configPath}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
