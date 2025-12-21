import pLimit from "p-limit";
import { GitManager } from "./git-manager.js";
import { loadConfig, isRepoEnabled, type RepoConfig } from "./config-loader.js";
import { runExtractors, type ExtractionResult } from "./extractor-base.js";
import { KnowledgeStore } from "./knowledge-store.js";
import "../extractors/index.js";

// Concurrency limit for parallel repo extraction
// Can be overridden via ORGBRAIN_REPO_CONCURRENCY env var
const REPO_CONCURRENCY = parseInt(process.env.ORGBRAIN_REPO_CONCURRENCY || "6", 10);

// Higher concurrency for git fetches (network-bound, can run more in parallel)
const GIT_FETCH_CONCURRENCY = parseInt(process.env.ORGBRAIN_GIT_FETCH_CONCURRENCY || "10", 10);

export interface ExtractionOptions {
  repos?: string[];
  refs?: string[] | Record<string, string[]>; // Can be array (applies to all) or object (per-repo)
  force?: boolean;
  maxAgeSecs?: number;
  /** Use shallow clones for faster fetching (only gets default branch tip, no tags/history) */
  shallow?: boolean;
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
    const repoNames = options.repos || Object.keys(config.repositories);

    // Filter to enabled repos only
    const enabledRepos: Array<{ name: string; config: RepoConfig }> = [];
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

      enabledRepos.push({ name: repoName, config: repoConfig });
    }

    // Phase 1: Pre-fetch all repos in parallel (network-bound, higher concurrency)
    const fetchLimit = pLimit(GIT_FETCH_CONCURRENCY);
    const shallowMode = options.shallow ?? false;
    console.log(`\n📥 Fetching ${enabledRepos.length} repos (${GIT_FETCH_CONCURRENCY} concurrent${shallowMode ? ', shallow' : ''})...`);
    const fetchStart = Date.now();
    
    const repoPathMap = new Map<string, string>();
    const fetchResults = await Promise.allSettled(
      enabledRepos.map(({ name, config: repoConfig }) =>
        fetchLimit(async () => {
          try {
            const path = await this.gitManager.ensureRepo(name, repoConfig.url, { shallow: shallowMode, forceFetch: true });
            repoPathMap.set(name, path);
            return { name, path, success: true };
          } catch (error) {
            console.error(`  ❌ Failed to fetch ${name}: ${error}`);
            return { name, path: null, success: false, error };
          }
        })
      )
    );
    
    const fetchDuration = Date.now() - fetchStart;
    const successfulFetches = fetchResults.filter(r => r.status === 'fulfilled' && r.value.success).length;
    console.log(`✅ Fetched ${successfulFetches}/${enabledRepos.length} repos in ${fetchDuration}ms\n`);

    // Phase 2: Run extractions in parallel (CPU-bound, lower concurrency)
    const extractLimit = pLimit(REPO_CONCURRENCY);
    console.log(`🚀 Extracting ${successfulFetches} repos (${REPO_CONCURRENCY} concurrent)...\n`);

    // Determine per-repo refs if refs override is provided
    const perRepoRefs: Record<string, string[]> = {};
    if (options.refs) {
      if (Array.isArray(options.refs)) {
        // If refs is an array, apply to all repos
        for (const { name } of enabledRepos) {
          perRepoRefs[name] = options.refs;
        }
      } else {
        // If refs is an object, use per-repo mapping
        Object.assign(perRepoRefs, options.refs);
      }
    }

    const allSummaries = await Promise.all(
      enabledRepos
        .filter(({ name }) => repoPathMap.has(name))
        .map(({ name, config: repoConfig }) => {
          // Use per-repo refs if specified, otherwise use default from config
          const repoRefs = perRepoRefs[name];
          const repoOptions = repoRefs ? { ...options, refs: repoRefs } : options;
          return extractLimit(() => this.runRepoWithPath(name, repoConfig, repoPathMap.get(name)!, repoOptions));
        })
    );

    // Add failed fetch results as summaries
    for (const result of fetchResults) {
      if (result.status === 'fulfilled' && !result.value.success) {
        const repo = enabledRepos.find(r => r.name === result.value.name);
        if (repo) {
          allSummaries.push([{
            repo: result.value.name,
            ref: repo.config.default_branch,
            refType: "branch",
            extractors: [],
            success: false,
            error: String(result.value.error),
            duration: 0,
          }]);
        }
      }
    }

    // Flatten the array of arrays
    return allSummaries.flat();
  }

  /**
   * Run extraction for a repo that has already been fetched
   */
  async runRepoWithPath(
    repoName: string,
    repoConfig: RepoConfig,
    repoPath: string,
    options: ExtractionOptions = {}
  ): Promise<ExtractionSummary[]> {
    const summaries: ExtractionSummary[] = [];
    console.log(`\n📦 Processing ${repoName}...`);

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
      // Get current SHA for the ref to detect changes
      let currentSha: string | undefined;
      try {
        const branches = await this.gitManager.listBranches(repoPath);
        const tags = await this.gitManager.listTags(repoPath);
        const version = [...branches, ...tags].find((v) => v.name === name);
        currentSha = version?.sha;
      } catch {
        // ignore - will fall back to time-based freshness
      }

      const maxAge = (options.maxAgeSecs || 86400) * 1000;
      if (!options.force && await this.store.isFresh(repoName, type, name, maxAge, currentSha)) {
        console.log(`  ⏭️  Skipping ${type}:${name} (fresh, sha: ${currentSha?.slice(0, 7) || 'unknown'})`);
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

        // Get SHA for this ref - try from branch/tag list first, then fallback to direct git lookup
        let sha: string | undefined;
        try {
          const branches = await this.gitManager.listBranches(repoPath);
          const tags = await this.gitManager.listTags(repoPath);
          const version = [...branches, ...tags].find((v) => v.name === name);
          sha = version?.sha;
        } catch {
          // ignore
        }
        
        // Fallback: get SHA directly from git if not found in list
        if (!sha) {
          const refSha = await this.gitManager.getRefSha(repoPath, name);
          if (refSha) {
            sha = refSha;
          }
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

  /**
   * Run extraction for a single repo (fetches first if needed)
   * Used by extract_ref tool for single-repo extraction
   */
  async runRepo(
    repoName: string,
    repoConfig: RepoConfig,
    options: ExtractionOptions = {}
  ): Promise<ExtractionSummary[]> {
    let repoPath: string;
    try {
      repoPath = await this.gitManager.ensureRepo(repoName, repoConfig.url, { shallow: options.shallow });
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

    return this.runRepoWithPath(repoName, repoConfig, repoPath, options);
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
