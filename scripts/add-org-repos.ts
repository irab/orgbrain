#!/usr/bin/env npx tsx
/**
 * Add repositories from a GitHub organization to config/repos.yaml
 *
 * Usage:
 *   pnpm add:org-repos <org-name> [options]
 *
 * Options:
 *   --interactive, -i   Interactively select which repos to include/exclude
 *   --dry-run           Preview changes without writing
 *   --ssh               Use SSH URLs (default)
 *   --https             Use HTTPS URLs
 *   --include-forks     Include forked repos
 *   --include-archived  Include archived repos
 *   --filter <regex>    Only include repos matching pattern
 *   --exclude <regex>   Exclude repos matching pattern
 */

import { execSync } from "child_process";
import { promises as fs } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import YAML from "yaml";
import { checkbox, confirm } from "@inquirer/prompts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = join(__dirname, "..", "config", "repos.yaml");

interface GHRepo {
  name: string;
  nameWithOwner: string;
  description: string | null;
  url: string;
  sshUrl: string;
  defaultBranchRef: { name: string } | null;
  primaryLanguage: { name: string } | null;
  isPrivate: boolean;
  isFork: boolean;
  isArchived: boolean;
  pushedAt: string;
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
  analysis?: Record<string, unknown>;
}

function parseArgs(args: string[]): {
  org: string;
  dryRun: boolean;
  useSsh: boolean;
  includeForks: boolean;
  includeArchived: boolean;
  interactive: boolean;
  filter?: RegExp;
  exclude?: RegExp;
} {
  const org = args[0];
  if (!org || org.startsWith("-")) {
    console.error(`
Usage: pnpm add:org-repos <org-name> [options]

Options:
  --interactive, -i   Interactively select which repos to include/exclude
  --dry-run           Preview changes without writing
  --ssh               Use SSH URLs (default)
  --https             Use HTTPS URLs
  --include-forks     Include forked repos
  --include-archived  Include archived repos
  --filter <regex>    Only include repos matching pattern
  --exclude <regex>   Exclude repos matching pattern
`);
    process.exit(1);
  }

  let dryRun = false;
  let useSsh = true;
  let includeForks = false;
  let includeArchived = false;
  let interactive = false;
  let filter: RegExp | undefined;
  let exclude: RegExp | undefined;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--interactive":
      case "-i":
        interactive = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--ssh":
        useSsh = true;
        break;
      case "--https":
        useSsh = false;
        break;
      case "--include-forks":
        includeForks = true;
        break;
      case "--include-archived":
        includeArchived = true;
        break;
      case "--filter":
        filter = new RegExp(args[++i]);
        break;
      case "--exclude":
        exclude = new RegExp(args[++i]);
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        process.exit(1);
    }
  }

  return { org, dryRun, useSsh, includeForks, includeArchived, interactive, filter, exclude };
}

function listOrgRepos(org: string): GHRepo[] {
  console.log(`Fetching repositories for organization: ${org}...`);

  try {
    const result = execSync(
      `gh repo list ${org} --limit 1000 --json name,nameWithOwner,description,url,sshUrl,defaultBranchRef,primaryLanguage,isPrivate,isFork,isArchived,pushedAt`,
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
    );
    return JSON.parse(result) as GHRepo[];
  } catch (error) {
    const err = error as Error & { stderr?: string };
    if (err.stderr?.includes("not logged in")) {
      console.error("Error: Not logged in to GitHub CLI. Run 'gh auth login' first.");
    } else if (err.stderr?.includes("Could not resolve")) {
      console.error(`Error: Organization '${org}' not found or not accessible.`);
    } else {
      console.error("Error fetching repos:", err.message);
    }
    process.exit(1);
  }
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
  if (name.includes("test") || name.includes("demo") || name.includes("poc") || name.includes("example")) {
    return "test";
  }

  if (["typescript", "javascript", "dart", "swift", "kotlin"].includes(lang)) return "frontend";
  if (["go", "rust", "python", "java"].includes(lang)) return "backend";
  if (["hcl", "dockerfile"].includes(lang)) return "infrastructure";

  return "unknown";
}

function buildRepoConfig(repo: GHRepo, useSsh: boolean, enabled = true): RepoConfig {
  const extractorDefaults: RepoConfig["extractors"] = [
    { name: "nip_usage", config: { patterns: ["NIP-\\d+", "kind:\\s*\\d+"], file_types: ["*"] } },
    { name: "user_flows" },
    { name: "data_flow" },
    { name: "kubernetes" },
    { name: "terraform" },
    { name: "journey_impact" },
  ];

  const config: RepoConfig = {
    url: useSsh ? repo.sshUrl : repo.url,
    description: repo.description || `Repository: ${repo.name}`,
    type: inferRepoType(repo),
    language: repo.primaryLanguage?.name || "unknown",
    default_branch: repo.defaultBranchRef?.name || "main",
    private: repo.isPrivate || undefined,
    track: {
      branches: [repo.defaultBranchRef?.name || "main"],
      tags: { pattern: "v*", latest: 5 },
    },
    extractors: extractorDefaults,
  };

  // Only add enabled: false if explicitly disabled
  if (!enabled) {
    config.enabled = false;
  }

  return config;
}

async function loadConfigFile(): Promise<Config> {
  try {
    const existing = await fs.readFile(CONFIG_PATH, "utf-8");
    return YAML.parse(existing) as Config;
  } catch {
    console.log("No existing config/repos.yaml found; creating new one.");
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

function formatRepoChoice(repo: GHRepo): string {
  const lang = repo.primaryLanguage?.name || "unknown";
  const type = inferRepoType(repo);
  const flags = [
    repo.isPrivate ? "🔒" : "",
    repo.isFork ? "🍴" : "",
    repo.isArchived ? "📦" : "",
  ].filter(Boolean).join("");
  
  const desc = repo.description 
    ? ` - ${repo.description.slice(0, 40)}${repo.description.length > 40 ? "..." : ""}`
    : "";
  
  return `${repo.name} (${type}, ${lang})${flags}${desc}`;
}

async function interactiveSelect(
  repos: GHRepo[],
  existingConfig: Config
): Promise<{ enabled: Set<string>; disabled: Set<string> }> {
  // Group repos by type for better organization
  const byType = new Map<string, GHRepo[]>();
  for (const repo of repos) {
    const type = inferRepoType(repo);
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type)!.push(repo);
  }

  // Sort types: production types first, then test/unknown
  const typeOrder = ["frontend", "backend", "infrastructure", "library", "documentation", "test", "unknown"];
  const sortedTypes = [...byType.keys()].sort((a, b) => {
    return typeOrder.indexOf(a) - typeOrder.indexOf(b);
  });

  // Build choices with grouping
  const choices: Array<{ name: string; value: string; checked: boolean }> = [];
  
  for (const type of sortedTypes) {
    const typeRepos = byType.get(type)!;
    // Add separator-like header
    for (const repo of typeRepos) {
      // Default: enable unless it looks like a test/demo repo or was previously disabled
      const existingRepo = existingConfig.repositories[repo.name];
      const wasDisabled = existingRepo?.enabled === false;
      const looksLikeTest = ["test", "demo", "poc", "example", "sandbox", "playground"].some(
        (t) => repo.name.toLowerCase().includes(t)
      );
      
      choices.push({
        name: formatRepoChoice(repo),
        value: repo.name,
        checked: wasDisabled ? false : !looksLikeTest,
      });
    }
  }

  console.log("\n📦 Select repositories to ENABLE (unchecked = disabled):\n");
  console.log("   Legend: 🔒 private  🍴 fork  📦 archived\n");

  const selected = await checkbox({
    message: "Use Space to toggle, Enter to confirm",
    choices,
    pageSize: 20,
  });

  const enabled = new Set(selected);
  const disabled = new Set(repos.map((r) => r.name).filter((n) => !enabled.has(n)));

  return { enabled, disabled };
}

async function main() {
  const { org, dryRun, useSsh, includeForks, includeArchived, interactive, filter, exclude } = parseArgs(
    process.argv.slice(2)
  );
  
  let repos = listOrgRepos(org);
  console.log(`Found ${repos.length} repositories.\n`);

  // Apply filters
  const ORG_META_REPOS = [".github", "profile", ".github-private"];
  repos = repos.filter((repo) => {
    if (!includeForks && repo.isFork) return false;
    if (!includeArchived && repo.isArchived) return false;
    if (ORG_META_REPOS.includes(repo.name)) return false; // Skip org-level meta repos
    if (filter && !filter.test(repo.name)) return false;
    if (exclude && exclude.test(repo.name)) return false;
    return true;
  });

  console.log(`${repos.length} repositories after filtering.\n`);

  const config = await loadConfigFile();
  
  let enabledRepos: Set<string>;
  let disabledRepos: Set<string>;

  if (interactive) {
    const selection = await interactiveSelect(repos, config);
    enabledRepos = selection.enabled;
    disabledRepos = selection.disabled;

    // Confirm
    console.log(`\n✅ Enabled: ${enabledRepos.size} repos`);
    console.log(`⏭️  Disabled: ${disabledRepos.size} repos`);

    if (!dryRun) {
      const proceed = await confirm({ message: "Save to config/repos.yaml?" });
      if (!proceed) {
        console.log("Aborted.");
        process.exit(0);
      }
    }
  } else {
    // Non-interactive: enable all by default
    enabledRepos = new Set(repos.map((r) => r.name));
    disabledRepos = new Set();
  }

  // Build config
  for (const repo of repos) {
    const isEnabled = enabledRepos.has(repo.name);
    const cfg = buildRepoConfig(repo, useSsh, isEnabled);
    config.repositories[repo.name] = cfg;
  }

  if (dryRun) {
    console.log(`\n[dry-run] Would add/update ${repos.length} repositories to config/repos.yaml`);
    console.log(`  - Enabled: ${enabledRepos.size}`);
    console.log(`  - Disabled: ${disabledRepos.size}`);
    process.exit(0);
  }

  await saveConfigFile(config);
  console.log(`\n✅ Updated config/repos.yaml with ${repos.length} repositories from org '${org}'.`);
  console.log(`   - ${enabledRepos.size} enabled`);
  console.log(`   - ${disabledRepos.size} disabled`);
  console.log(`\nRun 'pnpm build:knowledge' to extract data from enabled repos.`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
