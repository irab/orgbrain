import { promises as fs } from "fs";
import { parse } from "yaml";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_CONFIG = join(__dirname, "..", "..", "config", "repos.yaml");

export interface ExtractorConfig {
  name: string;
  config?: Record<string, unknown>;
}

export interface TrackConfig {
  branches?: string[];
  tags?: {
    pattern: string;
    latest?: number;
  };
}

export interface RepoConfig {
  url: string;
  description: string;
  type: "frontend" | "backend" | "infrastructure" | "library" | "documentation" | "unknown" | string;
  language: string;
  default_branch: string;
  private?: boolean;
  enabled?: boolean; // defaults to true; set to false to exclude from extraction/queries
  track: TrackConfig;
  extractors: ExtractorConfig[];
}

export interface DiagramStyles {
  [key: string]: string;
}

export interface KnowledgeConfig {
  version: string;
  cache_dir: string;
  knowledge_dir: string;
  diagram_styles?: DiagramStyles;
  repositories: Record<string, RepoConfig>;
  analysis?: Record<string, unknown>;
}

let cachedConfig: KnowledgeConfig | null = null;
let cachedPath: string | null = null;

function getConfigPath(): string {
  if (process.env.MCP_CONFIG) {
    return resolve(process.env.MCP_CONFIG);
  }
  return DEFAULT_CONFIG;
}

export async function loadConfig(customPath?: string): Promise<KnowledgeConfig> {
  const path = customPath ? resolve(customPath) : getConfigPath();

  if (cachedConfig && cachedPath === path) return cachedConfig;

  try {
    const content = await fs.readFile(path, "utf-8");
    cachedConfig = parse(content) as KnowledgeConfig;
    cachedPath = path;
    return cachedConfig;
  } catch (error) {
    throw new Error(`Failed to load config from ${path}: ${error}`);
  }
}

export function clearConfigCache(): void {
  cachedConfig = null;
  cachedPath = null;
}

export async function getRepoConfig(repoName: string): Promise<RepoConfig> {
  const config = await loadConfig();
  const repo = config.repositories[repoName];
  if (!repo) {
    throw new Error(`Repository ${repoName} not found in config`);
  }
  return repo;
}

export async function listRepos(includeDisabled = false): Promise<string[]> {
  const config = await loadConfig();
  return Object.entries(config.repositories)
    .filter(([_, repo]) => includeDisabled || repo.enabled !== false)
    .map(([name]) => name);
}

export async function listActiveRepos(): Promise<string[]> {
  return listRepos(false);
}

export function isRepoEnabled(repo: RepoConfig): boolean {
  return repo.enabled !== false;
}
