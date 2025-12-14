/**
 * Legacy-style MCP tools (org-agnostic).
 *
 * These tools operate on the local knowledge directory and extracted data.
 */

import { promises as fs } from "fs";
import { glob } from "glob";
import { fileURLToPath } from "url";
import { dirname, join, resolve, relative } from "path";
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

/**
 * Validate and sanitize a path to prevent directory traversal attacks.
 * Returns null if the path is invalid or tries to escape the base directory.
 */
function validatePath(userPath: string, baseDir: string): string | null {
  if (!userPath || typeof userPath !== "string") {
    return null;
  }

  // Normalize the path
  const normalizedBase = resolve(baseDir);
  const fullPath = resolve(baseDir, userPath);

  // Check if the resolved path is within the base directory
  const relativePath = relative(normalizedBase, fullPath);
  if (relativePath.startsWith("..") || resolve(fullPath) !== fullPath.replace(/\/$/, "")) {
    return null;
  }

  // Ensure the path stays within base directory
  if (!fullPath.startsWith(normalizedBase)) {
    return null;
  }

  return fullPath;
}

/**
 * Validate NIP number input
 */
function validateNipNumber(input: unknown): number | null {
  const num = Number(input);
  if (isNaN(num) || !Number.isInteger(num) || num < 1 || num > 9999) {
    return null;
  }
  return num;
}

/**
 * Validate and sanitize search query
 */
function validateSearchQuery(query: unknown): string | null {
  if (!query || typeof query !== "string") {
    return null;
  }
  // Limit length and remove control characters
  const sanitized = query.slice(0, 500).replace(/[\x00-\x1F\x7F]/g, "").trim();
  if (sanitized.length === 0) {
    return null;
  }
  return sanitized;
}

async function readKnowledgeFile(relativePath: string): Promise<string> {
  const validPath = validatePath(relativePath, KNOWLEDGE_DIR);
  if (!validPath) {
    return `Error: Invalid path "${relativePath}" - path traversal not allowed`;
  }
  try {
    return await fs.readFile(validPath, "utf-8");
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
            description: "Generate architecture diagrams (ecosystem overview OR single-repo detail)",
            tools: ["generate_diagram", "generate_c4_diagram"],
            examples: [
              'generate_c4_diagram() - ecosystem overview of all repos',
              'generate_c4_diagram(repo: "my-app") - detailed view of repo internals (apps, packages, services)',
              'generate_c4_diagram(repo: "my-app", level: "context") - high-level system context',
              'generate_diagram(repo: "my-app") - Mermaid flowchart of repo structure',
            ],
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
      const searchQuery = validateSearchQuery(query);
      if (!searchQuery) {
        return safeJson({
          error: "Invalid search query",
          message: "Please provide a non-empty search string (max 500 characters)",
        });
      }

      const searchLower = searchQuery.toLowerCase();
      const files = await glob("**/*.{md,json}", { cwd: KNOWLEDGE_DIR });
      const results: Array<{ file: string; matches: string[] }> = [];

      for (const file of files) {
        // Validate each file path before reading
        const validPath = validatePath(file, KNOWLEDGE_DIR);
        if (!validPath) continue;

        try {
          const content = await fs.readFile(validPath, "utf-8");
          const lines = content.split("\n");
          const matches: string[] = [];

          lines.forEach((line, index) => {
            if (line.toLowerCase().includes(searchLower)) {
              const start = Math.max(0, index - 1);
              const end = Math.min(lines.length, index + 2);
              matches.push(`Line ${index + 1}: ${lines.slice(start, end).join("\n")}`);
            }
          });

          if (matches.length > 0) {
            results.push({ file, matches: matches.slice(0, 5) });
          }
        } catch {
          // Skip files that can't be read
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
      const nipNum = validateNipNumber(nip_number);
      if (nipNum === null) {
        return safeJson({
          error: "Invalid NIP number",
          message: "Please provide a valid NIP number (integer between 1 and 9999)",
        });
      }

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
      const nipNum = validateNipNumber(nip_number);
      if (nipNum === null) {
        return safeJson({
          error: "Invalid NIP number",
          message: "Please provide a valid NIP number (integer between 1 and 9999)",
        });
      }

      try {
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
      } catch (error) {
        return safeJson({
          error: "Failed to search extracted data",
          message: error instanceof Error ? error.message : String(error),
        });
      }
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
      if (!path || typeof path !== "string") {
        return safeJson({
          error: "Invalid path",
          message: "Please provide a valid file path",
        });
      }

      // Limit path length to prevent abuse
      if (path.length > 500) {
        return safeJson({
          error: "Path too long",
          message: "File path must be less than 500 characters",
        });
      }

      const text = await readKnowledgeFile(String(path));
      return { content: [{ type: "text", text }] };
    },
  },
];

