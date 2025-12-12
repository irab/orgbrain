import { GitManager } from "./git-manager.js";
import { loadConfig, isRepoEnabled, type RepoConfig } from "./config-loader.js";
import { runExtractors, type ExtractionResult } from "./extractor-base.js";
import { KnowledgeStore } from "./knowledge-store.js";
import "../extractors/index.js";

export interface ExtractionOptions {
  repos?: string[];
  refs?: string[];
  force?: boolean;
  maxAgeSecs?: number;
}

export interface ExtractionSummary {
  repo: string;
  ref: string;
  refType: "branch" | "tag";
  extractors: string[];
  success: boolean;
  error?: string;
  duration: number;
}

export class ExtractionRunner {
  private gitManager: GitManager;
  private store: KnowledgeStore;

  constructor(cacheDir: string, knowledgeDir?: string) {
    this.gitManager = new GitManager(cacheDir);
    this.store = new KnowledgeStore(knowledgeDir);
  }

  async init(): Promise<void> {
    await this.gitManager.init();
  }

  async runAll(options: ExtractionOptions = {}): Promise<ExtractionSummary[]> {
    const config = await loadConfig();
    const summaries: ExtractionSummary[] = [];

    const repoNames = options.repos || Object.keys(config.repositories);

    for (const repoName of repoNames) {
      const repoConfig = config.repositories[repoName];
      if (!repoConfig) {
        console.warn(`Repository ${repoName} not found in config`);
        continue;
      }

      if (!isRepoEnabled(repoConfig)) {
        console.log(`⏭️  Skipping ${repoName} (disabled)`);
        continue;
      }

      const repoSummaries = await this.runRepo(repoName, repoConfig, options);
      summaries.push(...repoSummaries);
    }

    return summaries;
  }

  async runRepo(
    repoName: string,
    repoConfig: RepoConfig,
    options: ExtractionOptions = {}
  ): Promise<ExtractionSummary[]> {
    const summaries: ExtractionSummary[] = [];

    console.log(`\n📦 Processing ${repoName}...`);

    let repoPath: string;
    try {
      repoPath = await this.gitManager.ensureRepo(repoName, repoConfig.url);
    } catch (error) {
      console.error(`  ❌ Failed to clone/update repo: ${error}`);
      return [{
        repo: repoName,
        ref: repoConfig.default_branch,
        refType: "branch",
        extractors: [],
        success: false,
        error: String(error),
        duration: 0,
      }];
    }

    const refsToProcess: Array<{ type: "branch" | "tag"; name: string }> = [];

    if (options.refs?.length) {
      const branches = await this.gitManager.listBranches(repoPath);
      const tags = await this.gitManager.listTags(repoPath);

      for (const ref of options.refs) {
        if (branches.find((b) => b.name === ref)) {
          refsToProcess.push({ type: "branch", name: ref });
        } else if (tags.find((t) => t.name === ref)) {
          refsToProcess.push({ type: "tag", name: ref });
        }
      }
    } else {
      if (repoConfig.track.branches) {
        for (const branch of repoConfig.track.branches) {
          refsToProcess.push({ type: "branch", name: branch });
        }
      }

      if (repoConfig.track.tags) {
        const tags = await this.gitManager.listTags(repoPath, repoConfig.track.tags.pattern);
        const latestTags = tags.slice(0, repoConfig.track.tags.latest || 5);
        for (const tag of latestTags) {
          refsToProcess.push({ type: "tag", name: tag.name });
        }
      }
    }

    for (const { type, name } of refsToProcess) {
      const maxAge = (options.maxAgeSecs || 86400) * 1000;
      if (!options.force && await this.store.isFresh(repoName, type, name, maxAge)) {
        console.log(`  ⏭️  Skipping ${type}:${name} (fresh)`);
        continue;
      }

      console.log(`  🔍 Extracting ${type}:${name}...`);
      const startTime = Date.now();

      try {
        // Auto-detect monorepo and add extractor if not already configured
        let extractors = [...repoConfig.extractors];
        const hasMonorepoExtractor = extractors.some((e) => e.name === "monorepo");
        
        if (!hasMonorepoExtractor) {
          const files = await this.gitManager.listFilesAtRef(repoPath, name);
          const isMonorepo = files.some((f) =>
            f === "turbo.json" ||
            f === "pnpm-workspace.yaml" ||
            f === "nx.json" ||
            f === "lerna.json" ||
            f.match(/^packages\/[^/]+\/package\.json$/) ||
            f.match(/^apps\/[^/]+\/package\.json$/)
          );
          
          if (isMonorepo) {
            console.log(`  📦 Auto-detected monorepo structure`);
            extractors = [{ name: "monorepo" }, ...extractors];
          }
        }

        const results = await runExtractors(
          {
            repoName,
            repoPath,
            ref: name,
            refType: type,
            gitManager: this.gitManager,
          },
          extractors
        );

        let sha: string | undefined;
        try {
          const branches = await this.gitManager.listBranches(repoPath);
          const tags = await this.gitManager.listTags(repoPath);
          const version = [...branches, ...tags].find((v) => v.name === name);
          sha = version?.sha;
        } catch {
          // ignore
        }

        await this.store.save(repoName, type, name, results, sha);

        const duration = Date.now() - startTime;
        console.log(`  ✅ Completed in ${duration}ms (${results.length} extractors)`);

        summaries.push({
          repo: repoName,
          ref: name,
          refType: type,
          extractors: results.map((r) => r.extractor),
          success: true,
          duration,
        });
      } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`  ❌ Failed: ${error}`);

        summaries.push({
          repo: repoName,
          ref: name,
          refType: type,
          extractors: [],
          success: false,
          error: String(error),
          duration,
        });
      }
    }

    return summaries;
  }

  getStore(): KnowledgeStore {
    return this.store;
  }

  getGitManager(): GitManager {
    return this.gitManager;
  }
}

export async function runExtraction(options: ExtractionOptions = {}): Promise<ExtractionSummary[]> {
  const config = await loadConfig();
  const runner = new ExtractionRunner(
    config.cache_dir || ".repo-cache",
    config.knowledge_dir || "knowledge/extracted"
  );

  await runner.init();
  return runner.runAll(options);
}
