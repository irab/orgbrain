/**
 * Shared utilities for MCP tools
 */

import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { KnowledgeStore } from "../lib/knowledge-store.js";
import { GitManager } from "../lib/git-manager.js";
import { loadConfig, isRepoEnabled } from "../lib/config-loader.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Tool types
export type ToolContent = { type: "text"; text: string };

export type ToolHandler = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{ content: ToolContent[] }>;
};

// Singleton instances
let store: KnowledgeStore | null = null;
let gitManager: GitManager | null = null;

export async function getStore(): Promise<KnowledgeStore> {
  if (!store) {
    const config = await loadConfig();
    const knowledgeDir = join(__dirname, "..", "..", config.knowledge_dir || "knowledge/extracted");
    store = new KnowledgeStore(knowledgeDir);
  }
  return store;
}

export async function getGitManager(): Promise<GitManager> {
  if (!gitManager) {
    const config = await loadConfig();
    gitManager = new GitManager(config.cache_dir || ".repo-cache");
    await gitManager.init();
  }
  return gitManager;
}

/**
 * Get repos that are both extracted AND enabled in config.
 * This filters out old data from repos that have since been disabled.
 */
export async function getEnabledExtractedRepos(): Promise<string[]> {
  const s = await getStore();
  const config = await loadConfig();
  const extractedRepos = await s.listRepos();

  // Filter to only repos that exist in config AND are enabled
  return extractedRepos.filter((repo) => {
    const repoConfig = config.repositories[repo];
    return repoConfig && isRepoEnabled(repoConfig);
  });
}

/**
 * Load extracted data for a specific extractor from all enabled repos
 */
export async function loadFromAllRepos(extractor: string): Promise<Record<string, unknown>> {
  const s = await getStore();
  const repos = await getEnabledExtractedRepos();
  const result: Record<string, unknown> = {};

  for (const repo of repos) {
    const knowledge = await s.getLatest(repo);
    if (knowledge?.data?.[extractor]) {
      result[repo] = knowledge.data[extractor];
    }
  }

  return result;
}

/**
 * Get overview of all enabled repos with extraction info
 */
export async function getEcosystemOverview(): Promise<{
  repos: Array<{
    name: string;
    ref: string;
    refType: string;
    extractedAt: string;
    extractors: string[];
    sha?: string;
    commitDate?: string;
  }>;
}> {
  const s = await getStore();
  const gm = await getGitManager();
  const config = await loadConfig();
  const repos = await getEnabledExtractedRepos();
  const overview: Array<{
    name: string;
    ref: string;
    refType: string;
    extractedAt: string;
    extractors: string[];
    sha?: string;
    commitDate?: string;
  }> = [];

  for (const repo of repos) {
    const knowledge = await s.getLatest(repo);
    if (knowledge) {
      const extractedAt =
        knowledge.manifest.extractedAt instanceof Date
          ? knowledge.manifest.extractedAt.toISOString()
          : String(knowledge.manifest.extractedAt);

      const repoInfo: {
        name: string;
        ref: string;
        refType: string;
        extractedAt: string;
        extractors: string[];
        sha?: string;
        commitDate?: string;
      } = {
        name: repo,
        ref: knowledge.manifest.ref,
        refType: knowledge.manifest.refType,
        extractedAt,
        extractors: knowledge.manifest.extractors,
      };

      // Include commit SHA if available
      if (knowledge.manifest.sha) {
        repoInfo.sha = knowledge.manifest.sha;

        // Get commit date/time from git
        try {
          const repoConfig = config.repositories[repo];
          if (repoConfig) {
            // Use skipFetch to avoid unnecessary network calls, but commit date should be available from local cache
            const repoPath = await gm.ensureRepo(repo, repoConfig.url, { skipFetch: true });
            const commitDate = await gm.getCommitDate(repoPath, knowledge.manifest.sha);
            if (commitDate) {
              repoInfo.commitDate = commitDate.toISOString();
            }
          }
        } catch (error) {
          // Log error for debugging but don't fail the whole operation
          console.warn(`Failed to get commit date for ${repo}: ${error}`);
        }
      }

      overview.push(repoInfo);
    }
  }

  return { repos: overview };
}

/**
 * Safely convert value to JSON response
 */
export function safeJson(value: unknown): { content: ToolContent[] } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/**
 * Sanitize string for use in diagram node IDs (aliases)
 * Must start with letter, only alphanumeric and underscore
 */
export function sanitize(s: string): string {
  // Replace non-alphanumeric with underscore, ensure starts with letter
  const cleaned = s.replace(/[^a-zA-Z0-9]/g, "_").replace(/^[0-9_]+/, "");
  return cleaned || "node";
}

/**
 * Sanitize string for use in Mermaid diagram labels
 * Escapes quotes and special characters that break Mermaid parsing
 */
export function sanitizeLabel(s: string): string {
  return s
    .replace(/"/g, "'") // Replace double quotes with single
    .replace(/[<>]/g, "") // Remove angle brackets
    .replace(/[\r\n]+/g, " ") // Replace newlines with space
    .replace(/\s+/g, " ") // Collapse multiple spaces
    .trim()
    .slice(0, 100); // Limit length
}

/**
 * Check if a package name is a config/tooling package (should be filtered from diagrams)
 */
export function isConfigPackage(name: string): boolean {
  return /eslint|typescript|prettier|tsconfig|stylelint|babel|jest|vitest|config$/i.test(name);
}

/**
 * Infer category from repo name and config
 */
export function inferCategory(repoName: string, repoType?: string): string {
  const name = repoName.toLowerCase();
  if (name.includes("relay")) return "relay";
  if (name.includes("admin")) return "admin";
  if (name.includes("iac") || name.includes("infra") || repoType === "infrastructure") return "infra";
  // Only filter as "aux" if it's clearly a test/demo repo
  if (name.match(/[-_](test|demo)s?$/) || name.match(/^(test|demo)[-_]/) || name === ".github") return "aux";
  if (repoType === "frontend") return "frontend";
  if (repoType === "backend") return "backend";
  return "other";
}
