/**
 * MCP Resources - Expose knowledge files for direct reading by clients
 */

import { promises as fs } from "fs";
import { join, dirname, resolve, relative } from "path";
import { fileURLToPath } from "url";
import { glob } from "glob";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "./lib/config-loader.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Validate and sanitize a path segment (repo name, ref, extractor name)
 * Returns null if the segment is invalid
 */
function validatePathSegment(segment: string, maxLength = 100): string | null {
  if (!segment || typeof segment !== "string") return null;
  // Only allow alphanumeric, dots, hyphens, underscores
  // This prevents path traversal attacks via segments like ".." or "/"
  const sanitized = segment.slice(0, maxLength);
  if (!/^[a-zA-Z0-9._-]+$/.test(sanitized)) return null;
  // Extra check: no double dots even if they passed the regex (shouldn't happen but be safe)
  if (sanitized.includes("..")) return null;
  return sanitized;
}

/**
 * Validate that a constructed path stays within the base directory
 */
function isPathSafe(fullPath: string, baseDir: string): boolean {
  const normalizedBase = resolve(baseDir);
  const normalizedPath = resolve(fullPath);
  // Ensure the resolved path is within the base directory
  return normalizedPath.startsWith(normalizedBase + "/") || normalizedPath === normalizedBase;
}

export async function registerResources(server: McpServer): Promise<void> {
  const config = await loadConfig();
  const knowledgeDir = join(__dirname, "..", config.knowledge_dir || "knowledge/extracted");
  const staticKnowledgeDir = join(__dirname, "..", "knowledge");

  // Register resource template for extracted knowledge
  // URI pattern: knowledge://extracted/{repo}/{ref}/{extractor}
  server.resource(
    "extracted-knowledge",
    new ResourceTemplate("knowledge://extracted/{repo}/{ref}/{extractor}", {
      list: async () => {
        const resources: Array<{
          uri: string;
          name: string;
          mimeType: string;
        }> = [];

        try {
          const files = await glob("**/*.json", { cwd: knowledgeDir });
          for (const file of files) {
            if (file.includes("manifest")) continue;
            const parts = file.replace(".json", "").split("/");
            if (parts.length >= 3) {
              const [repo, ref, extractor] = parts;
              resources.push({
                uri: `knowledge://extracted/${repo}/${ref}/${extractor}`,
                name: `${repo}/${ref}/${extractor}`,
                mimeType: "application/json",
              });
            }
          }
        } catch {
          // ignore
        }

        return { resources };
      },
    }),
    { description: "Extracted knowledge data (user_flows, data_flow, kubernetes, terraform, etc.)" },
    async (uri, vars) => {
      const repo = Array.isArray(vars.repo) ? vars.repo[0] : vars.repo;
      const ref = Array.isArray(vars.ref) ? vars.ref[0] : vars.ref;
      const extractor = Array.isArray(vars.extractor) ? vars.extractor[0] : vars.extractor;

      // Validate all path segments to prevent path traversal
      const safeRepo = validatePathSegment(repo);
      const safeRef = validatePathSegment(ref, 250); // Git refs can be longer
      const safeExtractor = validatePathSegment(extractor, 50);

      if (!safeRepo || !safeRef || !safeExtractor) {
        return {
          contents: [{
            uri: uri.href,
            mimeType: "text/plain",
            text: "Error: Invalid path parameters. Path segments must contain only alphanumeric characters, dots, hyphens, and underscores.",
          }],
        };
      }

      const filePath = join(knowledgeDir, safeRepo, safeRef, `${safeExtractor}.json`);

      // Double-check the path is within the knowledge directory
      if (!isPathSafe(filePath, knowledgeDir)) {
        return {
          contents: [{
            uri: uri.href,
            mimeType: "text/plain",
            text: "Error: Access denied - path traversal not allowed.",
          }],
        };
      }

      try {
        const content = await fs.readFile(filePath, "utf-8");
        return {
          contents: [{
            uri: uri.href,
            mimeType: "application/json",
            text: content,
          }],
        };
      } catch (error) {
        return {
          contents: [{
            uri: uri.href,
            mimeType: "text/plain",
            text: `Error reading resource: ${error}`,
          }],
        };
      }
    }
  );

  // Register resource template for static knowledge files
  // URI pattern: knowledge://static/{path}
  server.resource(
    "static-knowledge",
    new ResourceTemplate("knowledge://static/{+path}", {
      list: async () => {
        const resources: Array<{
          uri: string;
          name: string;
          mimeType: string;
        }> = [];

        try {
          const files = await glob("**/*.{md,json}", {
            cwd: staticKnowledgeDir,
            ignore: ["extracted/**"],
          });
          for (const file of files) {
            resources.push({
              uri: `knowledge://static/${file}`,
              name: file,
              mimeType: file.endsWith(".json") ? "application/json" : "text/markdown",
            });
          }
        } catch {
          // ignore
        }

        return { resources };
      },
    }),
    { description: "Static knowledge files (markdown documentation, matrices)" },
    async (uri, vars) => {
      const path = Array.isArray(vars.path) ? vars.path.join("/") : vars.path;

      // Validate path to prevent directory traversal
      if (!path || typeof path !== "string") {
        return {
          contents: [{
            uri: uri.href,
            mimeType: "text/plain",
            text: "Error: Invalid path parameter.",
          }],
        };
      }

      // Check for path traversal attempts
      if (path.includes("..") || path.startsWith("/")) {
        return {
          contents: [{
            uri: uri.href,
            mimeType: "text/plain",
            text: "Error: Access denied - path traversal not allowed.",
          }],
        };
      }

      const filePath = join(staticKnowledgeDir, path);

      // Double-check the resolved path is within the static knowledge directory
      if (!isPathSafe(filePath, staticKnowledgeDir)) {
        return {
          contents: [{
            uri: uri.href,
            mimeType: "text/plain",
            text: "Error: Access denied - path traversal not allowed.",
          }],
        };
      }

      try {
        const content = await fs.readFile(filePath, "utf-8");
        const mimeType = filePath.endsWith(".json") ? "application/json" : "text/markdown";
        return {
          contents: [{
            uri: uri.href,
            mimeType,
            text: content,
          }],
        };
      } catch (error) {
        return {
          contents: [{
            uri: uri.href,
            mimeType: "text/plain",
            text: `Error reading resource: ${error}`,
          }],
        };
      }
    }
  );

  // Register a fixed resource for the index/manifest
  server.resource(
    "knowledge-index",
    "knowledge://index",
    { description: "Index of all available knowledge resources" },
    async (uri) => {
      const index: {
        extracted: Array<{ repo: string; ref: string; extractors: string[] }>;
        static: string[];
      } = {
        extracted: [],
        static: [],
      };

      // List extracted repos
      try {
        const repos = await fs.readdir(knowledgeDir);
        for (const repo of repos) {
          const repoPath = join(knowledgeDir, repo);
          const stat = await fs.stat(repoPath);
          if (!stat.isDirectory()) continue;

          const refs = await fs.readdir(repoPath);
          for (const ref of refs) {
            const refPath = join(repoPath, ref);
            const refStat = await fs.stat(refPath);
            if (!refStat.isDirectory()) continue;

            const files = await fs.readdir(refPath);
            const extractors = files
              .filter((f) => f.endsWith(".json") && f !== "manifest.json")
              .map((f) => f.replace(".json", ""));

            index.extracted.push({ repo, ref, extractors });
          }
        }
      } catch {
        // ignore
      }

      // List static files
      try {
        const files = await glob("**/*.{md,json}", {
          cwd: staticKnowledgeDir,
          ignore: ["extracted/**"],
        });
        index.static = files;
      } catch {
        // ignore
      }

      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(index, null, 2),
        }],
      };
    }
  );
}
