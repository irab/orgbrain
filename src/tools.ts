/**
 * Legacy-style MCP tools (org-agnostic).
 *
 * These tools operate on the local knowledge directory and extracted data.
 */

import { promises as fs } from "fs";
import { glob } from "glob";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { KnowledgeStore } from "./lib/knowledge-store.js";
import { loadConfig } from "./lib/config-loader.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const KNOWLEDGE_DIR = join(__dirname, "..", "knowledge");

type ToolContent = { type: "text"; text: string };

export type ToolHandler = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{ content: ToolContent[] }>;
};

function safeJson(value: unknown): { content: ToolContent[] } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

async function readKnowledgeFile(relativePath: string): Promise<string> {
  const fullPath = join(KNOWLEDGE_DIR, relativePath);
  try {
    return await fs.readFile(fullPath, "utf-8");
  } catch (error) {
    return `Error reading ${relativePath}: ${error}`;
  }
}

export const toolHandlers: ToolHandler[] = [
  {
    name: "health_check",
    description: "Report server readiness and list available capabilities",
    schema: { type: "object", properties: {} },
    handler: async () => {
      const capabilities = {
        status: "ok",
        description: "OrgBrain MCP Server - Multi-repo knowledge extraction and analysis",
        capabilities: {
          extraction: {
            description: "Extract knowledge from repos on-demand",
            tools: ["extract_ref", "extract_all"],
            example: 'extract_ref(repo: "my-app", ref: "v1.0.0")',
          },
          query: {
            description: "Query aggregated knowledge across repos",
            tools: ["query_nips", "query_flows", "query_data_flow", "query_infra"],
          },
          compare: {
            description: "Compare ecosystem between versions/refs",
            tools: ["compare_versions", "diff_versions"],
            example: 'diff_versions(from_ref: "v1.0.0", to_ref: "main")',
          },
          visualize: {
            description: "Generate architecture diagrams",
            tools: ["generate_diagram", "generate_c4_diagram"],
          },
          explore: {
            description: "Browse repos and refs",
            tools: ["list_repos", "list_refs", "list_knowledge"],
          },
        },
        tip: "Use list_repos to see configured repos, then extract_ref to pull knowledge for any branch/tag",
      };
      return { content: [{ type: "text", text: JSON.stringify(capabilities, null, 2) }] };
    },
  },
  {
    name: "search_knowledge",
    description: "Search markdown/JSON under knowledge/",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Case-insensitive search term" },
      },
      required: ["query"],
    },
    handler: async ({ query }) => {
      const searchQuery = String(query || "").toLowerCase();
      const files = await glob("**/*.{md,json}", { cwd: KNOWLEDGE_DIR });
      const results: Array<{ file: string; matches: string[] }> = [];

      for (const file of files) {
        const content = await fs.readFile(join(KNOWLEDGE_DIR, file), "utf-8");
        const lines = content.split("\n");
        const matches: string[] = [];

        lines.forEach((line, index) => {
          if (line.toLowerCase().includes(searchQuery)) {
            const start = Math.max(0, index - 1);
            const end = Math.min(lines.length, index + 2);
            matches.push(`Line ${index + 1}: ${lines.slice(start, end).join("\n")}`);
          }
        });

        if (matches.length > 0) {
          results.push({ file, matches: matches.slice(0, 5) });
        }
      }

      return safeJson(results);
    },
  },
  {
    name: "get_nip_details",
    description: "Get details for a NIP from knowledge/matrices/nip-usage.json",
    schema: {
      type: "object",
      properties: { nip_number: { type: "number", description: "NIP number (e.g., 1, 98)" } },
      required: ["nip_number"],
    },
    handler: async ({ nip_number }) => {
      const nipNum = Number(nip_number);
      const matrixPath = join(KNOWLEDGE_DIR, "matrices", "nip-usage.json");

      try {
        const matrix = JSON.parse(await fs.readFile(matrixPath, "utf-8"));
        const nipKey = `NIP-${nipNum.toString().padStart(2, "0")}`;
        const nipInfo = matrix.nips?.[nipKey];
        if (!nipInfo) {
          return { content: [{ type: "text", text: `NIP-${nipNum} not found in knowledge.` }] };
        }
        return safeJson(nipInfo);
      } catch (error) {
        return { content: [{ type: "text", text: `Unable to load NIP matrix: ${error}` }] };
      }
    },
  },
  {
    name: "list_knowledge",
    description: "List all knowledge resources (md/json) with URIs",
    schema: { type: "object", properties: {} },
    handler: async () => {
      const files = await glob("**/*.{md,json}", { cwd: KNOWLEDGE_DIR });
      const resources = files.map((file) => {
        const uri = `knowledge://${file.replace(/\.(md|json)$/, "")}`;
        return { file, uri };
      });
      return safeJson(resources);
    },
  },
  {
    name: "find_nip_in_extracted",
    description: "Search extracted nip_usage data for a given NIP number",
    schema: {
      type: "object",
      properties: { nip_number: { type: "number" } },
      required: ["nip_number"],
    },
    handler: async ({ nip_number }) => {
      const nipNum = Number(nip_number);
      const config = await loadConfig();
      const store = new KnowledgeStore(join(__dirname, "..", config.knowledge_dir || "knowledge/extracted"));
      const repos = await store.listRepos();
      const hits: Array<{ repo: string; files: string[] }> = [];

      for (const repo of repos) {
        const latest = await store.getLatest(repo);
        const nipData = latest?.data?.nip_usage as
          | { nips?: Record<string, { files?: string[] }> }
          | undefined;
        const nipKey = `NIP-${nipNum.toString().padStart(2, "0")}`;
        const files = nipData?.nips?.[nipKey]?.files || [];
        if (files.length) {
          hits.push({ repo, files });
        }
      }

      if (!hits.length) {
        return { content: [{ type: "text", text: `NIP-${nipNum} not found in extracted data.` }] };
      }

      return safeJson(hits);
    },
  },
  {
    name: "get_resource",
    description: "Load a specific knowledge file by relative path under knowledge/",
    schema: {
      type: "object",
      properties: { path: { type: "string", description: "Relative path under knowledge/" } },
      required: ["path"],
    },
    handler: async ({ path }) => {
      const text = await readKnowledgeFile(String(path));
      return { content: [{ type: "text", text }] };
    },
  },
];

