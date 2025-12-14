/**
 * Extraction tools - on-demand knowledge extraction
 */

import { loadConfig, isRepoEnabled } from "../lib/config-loader.js";
import { runExtractors } from "../lib/extractor-base.js";
import "../extractors/index.js"; // Register all extractors
import { ToolHandler, safeJson, getStore, getGitManager } from "./shared.js";

/**
 * Validate repository name format
 */
function isValidRepoName(repo: unknown): repo is string {
  if (!repo || typeof repo !== "string") return false;
  return /^[a-zA-Z0-9._-]{1,100}$/.test(repo);
}

/**
 * Validate git ref format (branch/tag name)
 */
function isValidGitRef(ref: unknown): ref is string {
  if (!ref || typeof ref !== "string") return false;
  if (ref.length > 250) return false;
  if (/\.\./.test(ref)) return false; // No double dots
  if (/^\/|\/\/|\/$/g.test(ref)) return false; // No leading/trailing/double slashes
  if (/[\x00-\x1F\x7F~^:?*\[\]\\]/.test(ref)) return false; // No special chars
  return true;
}

/**
 * Summarize extracted knowledge for response
 */
function summarizeKnowledge(data: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!data) return {};

  const summary: Record<string, unknown> = {};

  if (data.nip_usage) {
    const nips = data.nip_usage as { nips?: Record<string, unknown>; summary?: { uniqueKinds?: number[] } };
    summary.nips = Object.keys(nips.nips || {}).length;
    summary.eventKinds = nips.summary?.uniqueKinds?.length || 0;
  }

  if (data.user_flows) {
    const flows = data.user_flows as { screens?: unknown[]; routes?: unknown[] };
    summary.screens = flows.screens?.length || 0;
    summary.routes = flows.routes?.length || 0;
  }

  if (data.data_flow) {
    const flow = data.data_flow as { services?: unknown[]; externalCalls?: unknown[] };
    summary.services = flow.services?.length || 0;
    summary.externalCalls = flow.externalCalls?.length || 0;
  }

  if (data.kubernetes) {
    const k8s = data.kubernetes as { deployments?: unknown[]; services?: unknown[] };
    summary.k8sDeployments = k8s.deployments?.length || 0;
    summary.k8sServices = k8s.services?.length || 0;
  }

  if (data.terraform) {
    const tf = data.terraform as { resources?: number; modules?: number };
    summary.tfResources = tf.resources || 0;
    summary.tfModules = tf.modules || 0;
  }

  if (data.monorepo) {
    const mono = data.monorepo as { detected?: boolean; packages?: unknown[]; apps?: unknown[] };
    if (mono.detected) {
      summary.monorepo = {
        packages: mono.packages?.length || 0,
        apps: mono.apps?.length || 0,
      };
    }
  }

  return summary;
}

export const extractionTools: ToolHandler[] = [
  {
    name: "extract_ref",
    description:
      "Extract knowledge from a repo at a specific ref (branch/tag) on-demand. Fetches latest code and runs extractors.",
    schema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Repository name (must be in config)",
        },
        ref: {
          type: "string",
          description: "Branch or tag name to extract (e.g., 'main', 'v1.0.0', 'feature/auth')",
        },
        force: {
          type: "boolean",
          description: "Force re-extraction even if data exists and is fresh (default: false)",
        },
      },
      required: ["repo", "ref"],
    },
    handler: async (args) => {
      const repoName = args.repo;
      const ref = args.ref;
      const force = Boolean(args.force) || false;

      // Validate repo name
      if (!isValidRepoName(repoName)) {
        return safeJson({
          error: "Invalid repository name",
          message: "Repository names must be 1-100 characters containing only alphanumeric characters, hyphens, underscores, and dots.",
        });
      }

      // Validate git ref
      if (!isValidGitRef(ref)) {
        return safeJson({
          error: "Invalid git ref",
          message: "Please provide a valid branch or tag name (no special characters like .., ~, ^, :, ?, *, [, ], \\).",
        });
      }

      let config;
      try {
        config = await loadConfig();
      } catch (error) {
        return safeJson({
          error: "Failed to load config",
          message: error instanceof Error ? error.message : String(error),
        });
      }

      const repoConfig = config.repositories[repoName];

      if (!repoConfig) {
        return safeJson({
          error: `Repository "${repoName}" not found in config`,
          availableRepos: Object.keys(config.repositories).slice(0, 20), // Limit list
        });
      }

      if (!isRepoEnabled(repoConfig)) {
        return safeJson({
          error: `Repository "${repoName}" is disabled in config`,
        });
      }

      const s = await getStore();
      const gm = await getGitManager();

      // Check if we already have fresh data
      if (!force) {
        const versions = await s.listVersions(repoName);
        const existing = versions.find((v) => v.ref === ref);
        if (existing) {
          const ageMs = Date.now() - existing.extractedAt.getTime();
          const ageHours = Math.round(ageMs / 1000 / 60 / 60);
          if (ageMs < 24 * 60 * 60 * 1000) {
            const knowledge = await s.load(repoName, existing.refType as "branch" | "tag", ref);
            return safeJson({
              status: "cached",
              message: `Using cached data (${ageHours}h old). Use force=true to re-extract.`,
              repo: repoName,
              ref,
              refType: existing.refType,
              extractedAt: existing.extractedAt.toISOString(),
              extractors: knowledge?.manifest.extractors || [],
              summary: summarizeKnowledge(knowledge?.data),
            });
          }
        }
      }

      try {
        // Ensure repo is cloned/updated
        const repoPath = await gm.ensureRepo(repoName, repoConfig.url);

        // Determine ref type
        const branches = await gm.listBranches(repoPath);
        const tags = await gm.listTags(repoPath);

        const isBranch = branches.some((b) => b.name === ref);
        const isTag = tags.some((t) => t.name === ref);

        if (!isBranch && !isTag) {
          return safeJson({
            error: `Ref "${ref}" not found in repository "${repoName}"`,
            availableBranches: branches.slice(0, 10).map((b) => b.name),
            availableTags: tags.slice(0, 10).map((t) => t.name),
          });
        }

        const refType: "branch" | "tag" = isBranch ? "branch" : "tag";

        // Get SHA for this ref
        const refInfo = isBranch ? branches.find((b) => b.name === ref) : tags.find((t) => t.name === ref);
        const sha = refInfo?.sha;

        // Auto-detect monorepo if not configured
        let extractors = [...repoConfig.extractors];
        const hasMonorepoExtractor = extractors.some((e) => e.name === "monorepo");

        if (!hasMonorepoExtractor) {
          const files = await gm.listFilesAtRef(repoPath, ref);
          const isMonorepo = files.some(
            (f) =>
              f === "turbo.json" ||
              f === "pnpm-workspace.yaml" ||
              f === "nx.json" ||
              f === "lerna.json" ||
              f.match(/^packages\/[^/]+\/package\.json$/) ||
              f.match(/^apps\/[^/]+\/package\.json$/)
          );

          if (isMonorepo) {
            extractors = [{ name: "monorepo" }, ...extractors];
          }
        }

        // Run extractors
        const startTime = Date.now();
        const results = await runExtractors(
          {
            repoName,
            repoPath,
            ref,
            refType,
            gitManager: gm,
          },
          extractors
        );

        // Save to knowledge store
        await s.save(repoName, refType, ref, results, sha);

        const duration = Date.now() - startTime;

        return safeJson({
          status: "extracted",
          message: `Successfully extracted ${results.length} extractors in ${duration}ms`,
          repo: repoName,
          ref,
          refType,
          sha: sha?.slice(0, 8),
          extractedAt: new Date().toISOString(),
          duration: `${duration}ms`,
          extractors: results.map((r) => r.extractor),
          summary: summarizeKnowledge(results.reduce((acc, r) => ({ ...acc, [r.extractor]: r.data }), {})),
        });
      } catch (error) {
        return safeJson({
          status: "error",
          error: String(error),
          repo: repoName,
          ref,
        });
      }
    },
  },
  {
    name: "extract_all",
    description:
      "Extract knowledge from all enabled repos at their configured refs. Useful for initial setup or full refresh.",
    schema: {
      type: "object",
      properties: {
        force: {
          type: "boolean",
          description: "Force re-extraction even if data is fresh (default: false)",
        },
        repos: {
          type: "string",
          description: "Optional: limit to specific repos (comma-separated)",
        },
      },
    },
    handler: async (args) => {
      const force = Boolean(args.force) || false;
      const reposFilter = args.repos as string | undefined;

      // Validate repos filter if provided
      if (reposFilter !== undefined && typeof reposFilter !== "string") {
        return safeJson({
          error: "Invalid repos parameter",
          message: "The 'repos' parameter must be a comma-separated string of repository names.",
        });
      }

      // Limit filter length to prevent abuse
      if (reposFilter && reposFilter.length > 1000) {
        return safeJson({
          error: "Repos filter too long",
          message: "The repos filter string must be less than 1000 characters.",
        });
      }

      let config;
      try {
        config = await loadConfig();
      } catch (error) {
        return safeJson({
          error: "Failed to load config",
          message: error instanceof Error ? error.message : String(error),
        });
      }

      const s = await getStore();
      const gm = await getGitManager();

      const results: Array<{
        repo: string;
        ref: string;
        status: string;
        extractors?: string[];
        error?: string;
      }> = [];

      // Parse and validate repo names if filter provided
      let repoNames: string[];
      if (reposFilter) {
        repoNames = reposFilter.split(",").map((r) => r.trim()).filter((r) => r.length > 0);
        // Validate each repo name
        for (const name of repoNames) {
          if (!isValidRepoName(name)) {
            return safeJson({
              error: `Invalid repository name: "${name}"`,
              message: "Repository names must be 1-100 characters containing only alphanumeric characters, hyphens, underscores, and dots.",
            });
          }
        }
      } else {
        repoNames = Object.keys(config.repositories);
      }

      for (const repoName of repoNames) {
        const repoConfig = config.repositories[repoName];
        if (!repoConfig) {
          results.push({ repo: repoName, ref: "-", status: "not_found" });
          continue;
        }

        if (!isRepoEnabled(repoConfig)) {
          results.push({ repo: repoName, ref: "-", status: "disabled" });
          continue;
        }

        const ref = repoConfig.default_branch || "main";

        // Check cache
        if (!force) {
          const versions = await s.listVersions(repoName);
          const existing = versions.find((v) => v.ref === ref);
          if (existing) {
            const ageMs = Date.now() - existing.extractedAt.getTime();
            if (ageMs < 24 * 60 * 60 * 1000) {
              results.push({
                repo: repoName,
                ref,
                status: "cached",
                extractors: (await s.load(repoName, existing.refType as "branch" | "tag", ref))?.manifest.extractors,
              });
              continue;
            }
          }
        }

        try {
          const repoPath = await gm.ensureRepo(repoName, repoConfig.url);

          // Auto-detect monorepo
          let extractors = [...repoConfig.extractors];
          const hasMonorepoExtractor = extractors.some((e) => e.name === "monorepo");

          if (!hasMonorepoExtractor) {
            const files = await gm.listFilesAtRef(repoPath, ref);
            const isMonorepo = files.some(
              (f) =>
                f === "turbo.json" ||
                f === "pnpm-workspace.yaml" ||
                f === "nx.json" ||
                f === "lerna.json"
            );
            if (isMonorepo) {
              extractors = [{ name: "monorepo" }, ...extractors];
            }
          }

          const extractResults = await runExtractors(
            { repoName, repoPath, ref, refType: "branch", gitManager: gm },
            extractors
          );

          await s.save(repoName, "branch", ref, extractResults);

          results.push({
            repo: repoName,
            ref,
            status: "extracted",
            extractors: extractResults.map((r) => r.extractor),
          });
        } catch (error) {
          results.push({
            repo: repoName,
            ref,
            status: "error",
            error: String(error),
          });
        }
      }

      return safeJson({
        summary: {
          total: results.length,
          extracted: results.filter((r) => r.status === "extracted").length,
          cached: results.filter((r) => r.status === "cached").length,
          errors: results.filter((r) => r.status === "error").length,
        },
        results,
      });
    },
  },
];
