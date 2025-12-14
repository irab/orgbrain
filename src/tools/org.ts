/**
 * Organization management tools - connect GitHub orgs
 */

import { execSync } from "child_process";
import { promises as fs } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import YAML from "yaml";
import { ToolHandler, safeJson } from "./shared.js";
import { clearConfigCache } from "../lib/config-loader.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = join(__dirname, "..", "..", "config", "repos.yaml");

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

export const orgTools: ToolHandler[] = [
  {
    name: "connect_org",
    description:
      "Connect a GitHub organization - fetches all repos and adds them to config. Requires GitHub CLI (gh) to be authenticated.",
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
      const includeForks = (args.include_forks as boolean) || false;
      const includeArchived = (args.include_archived as boolean) || false;
      const includeNips = (args.include_nips as boolean) || false;
      const filterPattern = args.filter as string | undefined;
      const excludePattern = args.exclude as string | undefined;

      // Fetch repos using gh CLI
      let repos: GHRepo[];
      try {
        const result = execSync(
          `gh repo list ${org} --limit 1000 --json name,description,sshUrl,defaultBranchRef,primaryLanguage,isPrivate,isFork,isArchived`,
          { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
        );
        repos = JSON.parse(result) as GHRepo[];
      } catch (error) {
        const err = error as Error & { stderr?: string };
        if (err.stderr?.includes("not logged in")) {
          return safeJson({
            error: "Not logged in to GitHub CLI. Run 'gh auth login' first.",
          });
        }
        if (err.stderr?.includes("Could not resolve")) {
          return safeJson({
            error: `Organization '${org}' not found or not accessible.`,
          });
        }
        return safeJson({
          error: `Failed to fetch repos: ${err.message}`,
        });
      }

      const initialCount = repos.length;

      // Apply filters
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

      // Load existing config
      const config = await loadConfigFile();
      const existingCount = Object.keys(config.repositories).length;

      // Add repos
      let added = 0;
      let updated = 0;
      let disabled = 0;

      for (const repo of repos) {
        const isNew = !config.repositories[repo.name];
        const repoConfig = buildRepoConfig(repo, { includeNips });
        config.repositories[repo.name] = repoConfig;

        if (isNew) {
          added++;
        } else {
          updated++;
        }

        if (repoConfig.enabled === false) {
          disabled++;
        }
      }

      // Save config
      await saveConfigFile(config);

      // Clear the config cache so changes take effect immediately
      clearConfigCache();

      return safeJson({
        status: "connected",
        org,
        summary: {
          fetched: initialCount,
          afterFilters: repos.length,
          added,
          updated,
          autoDisabled: disabled,
          totalRepos: Object.keys(config.repositories).length,
        },
        message: `Connected ${org}! Added ${added} new repos, updated ${updated} existing. ${disabled} test/demo repos auto-disabled.`,
        nextSteps: [
          "Run extract_all to extract knowledge from all enabled repos",
          "Use list_repos to see all connected repositories",
          "Use generate_diagram to visualize the architecture",
        ],
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

      const config = await loadConfigFile();

      if (!config.repositories[repoName]) {
        return safeJson({
          error: `Repository "${repoName}" not found in config`,
          availableRepos: Object.keys(config.repositories),
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
      const enabled = args.enabled as boolean;

      const config = await loadConfigFile();

      if (!config.repositories[repoName]) {
        return safeJson({
          error: `Repository "${repoName}" not found in config`,
          availableRepos: Object.keys(config.repositories),
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
    },
  },
];
