/**
 * Organization management tools - connect GitHub orgs
 */

import { spawn } from "child_process";
import { promises as fs } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import YAML from "yaml";
import { ToolHandler, safeJson } from "./shared.js";
import { clearConfigCache } from "../lib/config-loader.js";
import { createJob, getJob, updateJob, listJobs, listActiveJobs, type Job } from "../lib/job-manager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = join(__dirname, "..", "..", "config", "repos.yaml");

/**
 * Validate GitHub organization name format
 */
function isValidOrgName(org: string): boolean {
  if (!org || typeof org !== "string") return false;
  // GitHub org names: alphanumeric and hyphens, 1-39 chars, can't start/end with hyphen
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(org);
}

/**
 * Validate regex pattern - returns true if valid, false if invalid
 */
function isValidRegex(pattern: string): boolean {
  if (!pattern || typeof pattern !== "string") return false;
  if (pattern.length > 500) return false; // Prevent ReDoS with very long patterns
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Validate repository name format
 */
function isValidRepoName(repo: string): boolean {
  if (!repo || typeof repo !== "string") return false;
  return /^[a-zA-Z0-9._-]{1,100}$/.test(repo);
}

interface GHRepo {
  name: string;
  description: string | null;
  sshUrl: string;
  defaultBranchRef: { name: string } | null;
  primaryLanguage: { name: string } | null;
  isPrivate: boolean;
  isFork: boolean;
  isArchived: boolean;
}

interface RepoConfig {
  url: string;
  description: string;
  type: string;
  language: string;
  default_branch: string;
  private?: boolean;
  enabled?: boolean;
  track: {
    branches: string[];
    tags?: { pattern: string; latest: number };
  };
  extractors: Array<{ name: string; config?: Record<string, unknown> }>;
}

interface Config {
  version: string;
  cache_dir: string;
  knowledge_dir: string;
  diagram_styles?: Record<string, string>;
  repositories: Record<string, RepoConfig>;
}

/**
 * Check if a repo name contains a word (not just substring).
 * Matches at word boundaries: start/end of string or separated by - or _
 * e.g., "test-repo" matches "test", but "battle-tested" does NOT match "test"
 */
function nameContainsWord(name: string, word: string): boolean {
  const regex = new RegExp(`(^|[-_])${word}($|[-_])`, "i");
  return regex.test(name);
}

function inferRepoType(repo: GHRepo): string {
  const name = repo.name.toLowerCase();
  const lang = repo.primaryLanguage?.name?.toLowerCase() || "";

  if (name.includes("mobile") || name.includes("app") || lang === "dart" || lang === "swift" || lang === "kotlin") {
    return "frontend";
  }
  if (name.includes("web") || name.includes("site") || name.includes("ui")) {
    return "frontend";
  }
  if (name.includes("api") || name.includes("server") || name.includes("backend") || name.includes("worker")) {
    return "backend";
  }
  if (name.includes("infra") || name.includes("iac") || name.includes("deploy") || name.includes("k8s")) {
    return "infrastructure";
  }
  if (name.includes("lib") || name.includes("sdk") || name.includes("package")) {
    return "library";
  }
  if (name.includes("doc") || name.includes("spec")) {
    return "documentation";
  }
  // Use word-boundary matching for test patterns to avoid false positives
  // e.g., "battle-tested" should NOT match "test"
  if (["test", "demo", "poc", "example"].some((t) => nameContainsWord(name, t))) {
    return "test";
  }

  if (["typescript", "javascript", "dart", "swift", "kotlin"].includes(lang)) return "frontend";
  if (["go", "rust", "python", "java"].includes(lang)) return "backend";
  if (["hcl", "dockerfile"].includes(lang)) return "infrastructure";

  return "unknown";
}

function buildRepoConfig(repo: GHRepo, options: { includeNips?: boolean } = {}): RepoConfig {
  const repoType = inferRepoType(repo);
  const extractors: RepoConfig["extractors"] = [];

  if (options.includeNips) {
    extractors.push({ name: "nip_usage", config: { patterns: ["NIP-\\d+", "kind:\\s*\\d+"], file_types: ["*"] } });
  }

  extractors.push({ name: "monorepo" });

  if (repoType === "frontend") {
    extractors.push({ name: "user_flows" });
    extractors.push({ name: "data_flow" });
  } else if (repoType === "backend") {
    extractors.push({ name: "data_flow" });
  } else if (repoType === "infrastructure") {
    extractors.push({ name: "kubernetes" });
    extractors.push({ name: "terraform" });
  } else {
    extractors.push({ name: "user_flows" });
    extractors.push({ name: "data_flow" });
    extractors.push({ name: "kubernetes" });
    extractors.push({ name: "terraform" });
  }

  extractors.push({ name: "journey_impact" });

  // Use word-boundary matching to avoid false positives like "battle-tested" matching "test"
  const looksLikeTest = ["test", "demo", "poc", "example", "sandbox", "playground"].some((t) =>
    nameContainsWord(repo.name, t)
  );

  const config: RepoConfig = {
    url: repo.sshUrl,
    description: repo.description || `Repository: ${repo.name}`,
    type: repoType,
    language: repo.primaryLanguage?.name || "unknown",
    default_branch: repo.defaultBranchRef?.name || "main",
    private: repo.isPrivate || undefined,
    track: {
      branches: [repo.defaultBranchRef?.name || "main"],
      tags: { pattern: "v*", latest: 5 },
    },
    extractors,
  };

  if (looksLikeTest) {
    config.enabled = false;
  }

  return config;
}

async function loadConfigFile(): Promise<Config> {
  try {
    const existing = await fs.readFile(CONFIG_PATH, "utf-8");
    return YAML.parse(existing) as Config;
  } catch {
    return {
      version: "1.0",
      cache_dir: ".repo-cache",
      knowledge_dir: "knowledge/extracted",
      diagram_styles: {
        frontend: "#4CAF50",
        backend: "#FF9800",
        infrastructure: "#607D8B",
        library: "#00BCD4",
        test: "#9E9E9E",
        unknown: "#9E9E9E",
      },
      repositories: {},
    };
  }
}

async function saveConfigFile(config: Config): Promise<void> {
  await fs.writeFile(CONFIG_PATH, YAML.stringify(config));
}

/**
 * Fetch repos from GitHub using gh CLI (async via spawn)
 */
function fetchGHRepos(org: string): Promise<GHRepo[]> {
  return new Promise((resolve, reject) => {
    const args = [
      "repo",
      "list",
      org,
      "--limit",
      "1000",
      "--json",
      "name,description,sshUrl,defaultBranchRef,primaryLanguage,isPrivate,isFork,isArchived",
    ];

    const proc = spawn("gh", args);
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        if (stderr.includes("not logged in")) {
          reject(new Error("Not logged in to GitHub CLI. Run 'gh auth login' first."));
        } else if (stderr.includes("Could not resolve")) {
          reject(new Error(`Organization '${org}' not found or not accessible.`));
        } else {
          reject(new Error(`gh command failed: ${stderr || "Unknown error"}`));
        }
        return;
      }

      try {
        const repos = JSON.parse(stdout) as GHRepo[];
        resolve(repos);
      } catch {
        reject(new Error(`Failed to parse gh output: ${stdout.slice(0, 200)}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn gh: ${err.message}`));
    });
  });
}

interface ConnectOrgOptions {
  org: string;
  includeForks: boolean;
  includeArchived: boolean;
  includeNips: boolean;
  filterPattern?: string;
  excludePattern?: string;
}

/**
 * Core logic for connecting an org - runs as background job
 */
async function runConnectOrg(job: Job, options: ConnectOrgOptions): Promise<void> {
  const { org, includeForks, includeArchived, includeNips, filterPattern, excludePattern } = options;

  try {
    updateJob(job.id, {
      status: "running",
      progress: { current: 0, total: 4, message: "Fetching repos from GitHub..." },
    });

    // Step 1: Fetch repos
    let repos: GHRepo[];
    try {
      repos = await fetchGHRepos(org);
    } catch (error) {
      updateJob(job.id, {
        status: "failed",
        error: (error as Error).message,
        completedAt: new Date(),
      });
      return;
    }

    const initialCount = repos.length;

    updateJob(job.id, {
      progress: { current: 1, total: 4, message: `Fetched ${initialCount} repos, filtering...` },
    });

    // Step 2: Apply filters
    const ORG_META_REPOS = [".github", "profile", ".github-private"];
    const filter = filterPattern ? new RegExp(filterPattern) : undefined;
    const exclude = excludePattern ? new RegExp(excludePattern) : undefined;

    repos = repos.filter((repo) => {
      if (!includeForks && repo.isFork) return false;
      if (!includeArchived && repo.isArchived) return false;
      if (ORG_META_REPOS.includes(repo.name)) return false;
      if (filter && !filter.test(repo.name)) return false;
      if (exclude && exclude.test(repo.name)) return false;
      return true;
    });

    updateJob(job.id, {
      progress: { current: 2, total: 4, message: `${repos.length} repos after filters, updating config...` },
    });

    // Step 3: Update config
    const config = await loadConfigFile();

    // Clear all existing repos - connect_org gives a fresh start
    const removed = Object.keys(config.repositories).length;
    config.repositories = {};

    // Add repos
    let added = 0;
    let disabled = 0;

    for (const repo of repos) {
      const repoConfig = buildRepoConfig(repo, { includeNips });
      config.repositories[repo.name] = repoConfig;
      added++;

      if (repoConfig.enabled === false) {
        disabled++;
      }
    }

    updateJob(job.id, {
      progress: { current: 3, total: 4, message: "Saving config..." },
    });

    // Step 4: Save
    await saveConfigFile(config);
    clearConfigCache();

    updateJob(job.id, {
      status: "completed",
      progress: { current: 4, total: 4, message: "Done" },
      result: {
        org,
        summary: {
          fetched: initialCount,
          afterFilters: repos.length,
          removed,
          added,
          autoDisabled: disabled,
          totalRepos: Object.keys(config.repositories).length,
        },
        message: `Connected ${org}! Removed ${removed} old repos, added ${added} new.${disabled > 0 ? ` ${disabled} test/demo repos auto-disabled.` : ""}`,
        nextSteps: [
          "Run extract_all to extract knowledge from all enabled repos",
          "Use list_repos to see all connected repositories",
          "Use generate_diagram to visualize the architecture",
        ],
      },
      completedAt: new Date(),
    });
  } catch (error) {
    updateJob(job.id, {
      status: "failed",
      error: (error as Error).message,
      completedAt: new Date(),
    });
  }
}

export const orgTools: ToolHandler[] = [
  {
    name: "connect_org",
    description:
      "Connect a GitHub organization - fetches all repos and adds them to config. Runs as a background job; use job_status to check progress. Requires GitHub CLI (gh) to be authenticated.",
    schema: {
      type: "object",
      properties: {
        org: {
          type: "string",
          description: "GitHub organization name",
        },
        include_forks: {
          type: "boolean",
          description: "Include forked repositories (default: false)",
        },
        include_archived: {
          type: "boolean",
          description: "Include archived repositories (default: false)",
        },
        include_nips: {
          type: "boolean",
          description: "Include NIP extractor for Nostr repos (default: false)",
        },
        filter: {
          type: "string",
          description: "Regex pattern to filter repo names (only include matching)",
        },
        exclude: {
          type: "string",
          description: "Regex pattern to exclude repo names",
        },
      },
      required: ["org"],
    },
    handler: async (args) => {
      const org = args.org as string;

      // Validate organization name
      if (!isValidOrgName(org)) {
        return safeJson({
          error: "Invalid organization name",
          message: "GitHub organization names must be 1-39 characters, containing only alphanumeric characters and hyphens, and cannot start or end with a hyphen.",
        });
      }

      const includeForks = Boolean(args.include_forks) || false;
      const includeArchived = Boolean(args.include_archived) || false;
      const includeNips = Boolean(args.include_nips) || false;
      const filterPattern = args.filter as string | undefined;
      const excludePattern = args.exclude as string | undefined;

      // Validate regex patterns if provided
      if (filterPattern && !isValidRegex(filterPattern)) {
        return safeJson({
          error: "Invalid filter pattern",
          message: "The filter pattern is not a valid regular expression. Please check the syntax.",
        });
      }

      if (excludePattern && !isValidRegex(excludePattern)) {
        return safeJson({
          error: "Invalid exclude pattern",
          message: "The exclude pattern is not a valid regular expression. Please check the syntax.",
        });
      }

      // Create background job
      const job = createJob(`connect_org:${org}`);

      // Start the work in the background (don't await)
      runConnectOrg(job, {
        org,
        includeForks,
        includeArchived,
        includeNips,
        filterPattern,
        excludePattern,
      });

      return safeJson({
        status: "started",
        jobId: job.id,
        message: `Background job started for connecting ${org}. Use job_status(jobId: "${job.id}") to check progress.`,
      });
    },
  },
  {
    name: "job_status",
    description: "Check the status of a background job, or list all recent jobs if no jobId provided.",
    schema: {
      type: "object",
      properties: {
        jobId: {
          type: "string",
          description: "Job ID to check. If omitted, lists all recent jobs.",
        },
      },
    },
    handler: async (args) => {
      const jobId = args.jobId as string | undefined;

      if (jobId) {
        // Validate jobId format (UUID-like or reasonable string)
        if (typeof jobId !== "string" || jobId.length === 0 || jobId.length > 100) {
          return safeJson({
            error: "Invalid job ID",
            message: "Job ID must be a non-empty string (max 100 characters).",
          });
        }

        const job = getJob(jobId);
        if (!job) {
          return safeJson({
            error: `Job "${jobId}" not found`,
            activeJobs: listActiveJobs().map((j) => ({ id: j.id, type: j.type, status: j.status })),
          });
        }

        return safeJson({
          id: job.id,
          type: job.type,
          status: job.status,
          progress: job.progress,
          result: job.result,
          error: job.error,
          startedAt: job.startedAt.toISOString(),
          completedAt: job.completedAt?.toISOString(),
          duration: job.completedAt
            ? `${((job.completedAt.getTime() - job.startedAt.getTime()) / 1000).toFixed(1)}s`
            : undefined,
        });
      }

      // List all jobs
      const jobs = listJobs();
      return safeJson({
        jobs: jobs.map((j) => ({
          id: j.id,
          type: j.type,
          status: j.status,
          progress: j.progress?.message,
          startedAt: j.startedAt.toISOString(),
          completedAt: j.completedAt?.toISOString(),
        })),
        activeCount: listActiveJobs().length,
      });
    },
  },
  {
    name: "disconnect_repo",
    description: "Remove a repository from the config",
    schema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Repository name to remove",
        },
      },
      required: ["repo"],
    },
    handler: async (args) => {
      const repoName = args.repo as string;

      // Validate repo name format
      if (!isValidRepoName(repoName)) {
        return safeJson({
          error: "Invalid repository name",
          message: "Repository names must be 1-100 characters containing only alphanumeric characters, hyphens, underscores, and dots.",
        });
      }

      try {
        const config = await loadConfigFile();

        if (!config.repositories[repoName]) {
          return safeJson({
            error: `Repository "${repoName}" not found in config`,
            availableRepos: Object.keys(config.repositories).slice(0, 20), // Limit to 20 to avoid huge responses
          });
        }

        delete config.repositories[repoName];
        await saveConfigFile(config);
        clearConfigCache();

        return safeJson({
          status: "disconnected",
          repo: repoName,
          remainingRepos: Object.keys(config.repositories).length,
        });
      } catch (error) {
        return safeJson({
          error: "Failed to disconnect repository",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  },
  {
    name: "toggle_repo",
    description: "Enable or disable a repository",
    schema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Repository name",
        },
        enabled: {
          type: "boolean",
          description: "true to enable, false to disable",
        },
      },
      required: ["repo", "enabled"],
    },
    handler: async (args) => {
      const repoName = args.repo as string;
      const enabled = args.enabled;

      // Validate repo name format
      if (!isValidRepoName(repoName)) {
        return safeJson({
          error: "Invalid repository name",
          message: "Repository names must be 1-100 characters containing only alphanumeric characters, hyphens, underscores, and dots.",
        });
      }

      // Validate enabled is a boolean
      if (typeof enabled !== "boolean") {
        return safeJson({
          error: "Invalid enabled value",
          message: "The 'enabled' parameter must be a boolean (true or false).",
        });
      }

      try {
        const config = await loadConfigFile();

        if (!config.repositories[repoName]) {
          return safeJson({
            error: `Repository "${repoName}" not found in config`,
            availableRepos: Object.keys(config.repositories).slice(0, 20), // Limit to 20
          });
        }

        if (enabled) {
          delete config.repositories[repoName].enabled;
        } else {
          config.repositories[repoName].enabled = false;
        }

        await saveConfigFile(config);
        clearConfigCache();

        return safeJson({
          status: enabled ? "enabled" : "disabled",
          repo: repoName,
        });
      } catch (error) {
        return safeJson({
          error: "Failed to toggle repository",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  },
];
