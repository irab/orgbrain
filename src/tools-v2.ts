/**
 * Version-aware MCP tools (org-agnostic).
 *
 * These tools aggregate knowledge across all configured repos and expose
 * higher-level queries (refs, NIPs, flows, infra, diagrams).
 */

import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { KnowledgeStore } from "./lib/knowledge-store.js";
import { GitManager } from "./lib/git-manager.js";
import { loadConfig, isRepoEnabled } from "./lib/config-loader.js";
import { runExtractors } from "./lib/extractor-base.js";
import "./extractors/index.js"; // Register all extractors

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type ToolContent = { type: "text"; text: string };

export type ToolHandler = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{ content: ToolContent[] }>;
};

let store: KnowledgeStore | null = null;
let gitManager: GitManager | null = null;

async function getStore(): Promise<KnowledgeStore> {
  if (!store) {
    const config = await loadConfig();
    const knowledgeDir = join(__dirname, "..", config.knowledge_dir || "knowledge/extracted");
    store = new KnowledgeStore(knowledgeDir);
  }
  return store;
}

async function getGitManager(): Promise<GitManager> {
  if (!gitManager) {
    const config = await loadConfig();
    const cacheDir = join(__dirname, "..", config.cache_dir || ".repo-cache");
    gitManager = new GitManager(cacheDir);
    await gitManager.init();
  }
  return gitManager;
}

/**
 * Get list of repos that are both extracted AND enabled in config.
 * This filters out old data from repos that have since been disabled.
 */
async function getEnabledExtractedRepos(): Promise<string[]> {
  const s = await getStore();
  const config = await loadConfig();
  const extractedRepos = await s.listRepos();

  // Filter to only repos that exist in config AND are enabled
  return extractedRepos.filter((repo) => {
    const repoConfig = config.repositories[repo];
    return repoConfig && isRepoEnabled(repoConfig);
  });
}

async function loadFromAllRepos(extractor: string): Promise<Record<string, unknown>> {
  const s = await getStore();
  const repos = await getEnabledExtractedRepos(); // Only load from enabled repos
  const result: Record<string, unknown> = {};

  for (const repo of repos) {
    const knowledge = await s.getLatest(repo);
    if (knowledge?.data?.[extractor]) {
      result[repo] = knowledge.data[extractor];
    }
  }

  return result;
}

async function getEcosystemOverview(): Promise<{
  repos: Array<{
    name: string;
    ref: string;
    refType: string;
    extractedAt: string;
    extractors: string[];
  }>;
}> {
  const s = await getStore();
  const repos = await getEnabledExtractedRepos(); // Only show enabled repos
  const overview: Array<{
    name: string;
    ref: string;
    refType: string;
    extractedAt: string;
    extractors: string[];
  }> = [];

  for (const repo of repos) {
    const knowledge = await s.getLatest(repo);
    if (knowledge) {
      const extractedAt =
        knowledge.manifest.extractedAt instanceof Date
          ? knowledge.manifest.extractedAt.toISOString()
          : String(knowledge.manifest.extractedAt);

      overview.push({
        name: repo,
        ref: knowledge.manifest.ref,
        refType: knowledge.manifest.refType,
        extractedAt,
        extractors: knowledge.manifest.extractors,
      });
    }
  }

  return { repos: overview };
}

function safeJson(value: unknown): { content: ToolContent[] } {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

/**
 * Diff helper for a specific extractor's data
 */
function diffExtractor(
  extractor: string,
  fromData: Record<string, unknown> | undefined,
  toData: Record<string, unknown> | undefined
): { hasChanges: boolean; added: unknown[]; removed: unknown[]; details?: unknown } {
  const result: { hasChanges: boolean; added: unknown[]; removed: unknown[]; details?: unknown } = {
    hasChanges: false,
    added: [],
    removed: [],
  };

  if (!fromData && !toData) return result;
  if (!fromData) {
    result.hasChanges = true;
    result.details = { status: "new", data: toData };
    return result;
  }
  if (!toData) {
    result.hasChanges = true;
    result.details = { status: "removed", data: fromData };
    return result;
  }

  switch (extractor) {
    case "nip_usage": {
      const fromNips = Object.keys((fromData.nips as Record<string, unknown>) || {});
      const toNips = Object.keys((toData.nips as Record<string, unknown>) || {});
      result.added = toNips.filter((n) => !fromNips.includes(n));
      result.removed = fromNips.filter((n) => !toNips.includes(n));
      result.hasChanges = result.added.length > 0 || result.removed.length > 0;

      const fromKinds = ((fromData.summary as Record<string, unknown>)?.uniqueEventKinds as number[]) || [];
      const toKinds = ((toData.summary as Record<string, unknown>)?.uniqueEventKinds as number[]) || [];
      result.details = {
        nips: { added: result.added, removed: result.removed },
        eventKinds: {
          added: toKinds.filter((k) => !fromKinds.includes(k)),
          removed: fromKinds.filter((k) => !toKinds.includes(k)),
        },
      };
      break;
    }

    case "user_flows": {
      const fromScreens = ((fromData.screens as Array<{ name: string }>) || []).map((s) => s.name);
      const toScreens = ((toData.screens as Array<{ name: string }>) || []).map((s) => s.name);
      result.added = toScreens.filter((s) => !fromScreens.includes(s));
      result.removed = fromScreens.filter((s) => !toScreens.includes(s));
      result.hasChanges = result.added.length > 0 || result.removed.length > 0;
      result.details = { screens: { added: result.added, removed: result.removed } };
      break;
    }

    case "data_flow": {
      const fromSvc = ((fromData.services as Array<{ name: string }>) || []).map((s) => s.name);
      const toSvc = ((toData.services as Array<{ name: string }>) || []).map((s) => s.name);
      result.added = toSvc.filter((s) => !fromSvc.includes(s));
      result.removed = fromSvc.filter((s) => !toSvc.includes(s));
      result.hasChanges = result.added.length > 0 || result.removed.length > 0;
      result.details = { services: { added: result.added, removed: result.removed } };
      break;
    }

    case "kubernetes": {
      const fromRes = ((fromData.resources as Array<{ kind: string; name: string }>) || [])
        .map((r) => `${r.kind}/${r.name}`);
      const toRes = ((toData.resources as Array<{ kind: string; name: string }>) || [])
        .map((r) => `${r.kind}/${r.name}`);
      result.added = toRes.filter((r) => !fromRes.includes(r));
      result.removed = fromRes.filter((r) => !toRes.includes(r));
      result.hasChanges = result.added.length > 0 || result.removed.length > 0;

      const fromApps = ((fromData.argoApps as Array<{ name: string }>) || []).map((a) => a.name);
      const toApps = ((toData.argoApps as Array<{ name: string }>) || []).map((a) => a.name);
      result.details = {
        resources: { added: result.added, removed: result.removed },
        argoApps: {
          added: toApps.filter((a) => !fromApps.includes(a)),
          removed: fromApps.filter((a) => !toApps.includes(a)),
        },
      };
      break;
    }

    case "terraform": {
      const fromCount = (fromData.resources as number) || 0;
      const toCount = (toData.resources as number) || 0;
      const fromProviders = (fromData.providers as string[]) || [];
      const toProviders = (toData.providers as string[]) || [];
      result.hasChanges = fromCount !== toCount || fromProviders.length !== toProviders.length;
      result.details = {
        resources: { from: fromCount, to: toCount, delta: toCount - fromCount },
        providers: {
          added: toProviders.filter((p) => !fromProviders.includes(p)),
          removed: fromProviders.filter((p) => !toProviders.includes(p)),
        },
      };
      break;
    }
  }

  return result;
}

/**
 * Generate a Mermaid diagram showing the diff between versions
 */
function generateDiffDiagram(
  fromRef: string,
  toRef: string,
  aggregated: {
    nips?: { added: string[]; removed: string[] };
    screens?: { added: string[]; removed: string[] };
    services?: { added: string[]; removed: string[] };
    k8sResources?: { added: string[]; removed: string[] };
  }
): string {
  const lines: string[] = [
    "flowchart LR",
    `    subgraph FROM["${fromRef}"]`,
  ];

  // Show removed items from source
  const removedNips = aggregated.nips?.removed || [];
  const removedScreens = aggregated.screens?.removed || [];
  const removedServices = aggregated.services?.removed || [];

  if (removedNips.length > 0) {
    lines.push(`        RN["🔴 NIPs: ${removedNips.slice(0, 5).join(", ")}${removedNips.length > 5 ? "..." : ""}"]`);
  }
  if (removedScreens.length > 0) {
    lines.push(`        RS["🔴 Screens: -${removedScreens.length}"]`);
  }
  if (removedServices.length > 0) {
    lines.push(`        RSV["🔴 Services: -${removedServices.length}"]`);
  }

  lines.push("    end");
  lines.push(`    subgraph TO["${toRef}"]`);

  // Show added items in target
  const addedNips = aggregated.nips?.added || [];
  const addedScreens = aggregated.screens?.added || [];
  const addedServices = aggregated.services?.added || [];

  if (addedNips.length > 0) {
    lines.push(`        AN["🟢 NIPs: ${addedNips.slice(0, 5).join(", ")}${addedNips.length > 5 ? "..." : ""}"]`);
  }
  if (addedScreens.length > 0) {
    lines.push(`        AS["🟢 Screens: +${addedScreens.length}"]`);
  }
  if (addedServices.length > 0) {
    lines.push(`        ASV["🟢 Services: +${addedServices.length}"]`);
  }

  lines.push("    end");
  lines.push(`    FROM -->|"changes"| TO`);

  return lines.join("\n");
}

export const toolHandlersV2: ToolHandler[] = [
  {
    name: "list_repos",
    description: "List repos with their latest extracted ref. Use extract_ref(repo, ref) to extract new branches/tags on-demand.",
    schema: { type: "object", properties: {} },
    handler: async () => {
      const overview = await getEcosystemOverview();
      return safeJson(overview);
    },
  },
  {
    name: "list_refs",
    description: "List branches and tags (latest first) for each configured repo",
    schema: { type: "object", properties: {} },
    handler: async () => {
      const config = await loadConfig();
      const gm = await getGitManager();
      const result: Record<string, unknown> = {};

      for (const [repoName, repoConfig] of Object.entries(config.repositories)) {
        try {
          const state = await gm.getRepoState(repoName, repoConfig.url);
          result[repoName] = {
            branches: state.branches.slice(0, 10).map((b) => ({
              name: b.name,
              sha: b.sha.slice(0, 8),
              date: b.date.toISOString(),
            })),
            tags: state.tags.slice(0, 10).map((t) => ({
              name: t.name,
              sha: t.sha.slice(0, 8),
              date: t.date.toISOString(),
            })),
          };
        } catch (error) {
          result[repoName] = { error: `Could not fetch refs: ${error}` };
        }
      }

      return safeJson(result);
    },
  },
  {
    name: "query_nips",
    description: "Aggregate NIP usage and event kinds across all extracted repos",
    schema: { type: "object", properties: {} },
    handler: async () => {
      const allNipData = await loadFromAllRepos("nip_usage");

      const nipUsage: Record<string, { repos: string[]; files: string[]; kinds: number[] }> = {};
      const kindUsage: Record<number, { repos: string[] }> = {};

      for (const [repo, data] of Object.entries(allNipData)) {
        const nipData = data as {
          nips?: Record<string, { files?: string[]; kinds?: number[] }>;
          summary?: { uniqueKinds?: number[] };
        };

        if (nipData.nips) {
          for (const [nip, info] of Object.entries(nipData.nips)) {
            if (!nipUsage[nip]) {
              nipUsage[nip] = { repos: [], files: [], kinds: [] };
            }
            nipUsage[nip].repos.push(repo);
            if (info.files) {
              nipUsage[nip].files.push(...info.files.map((f) => `${repo}:${f}`));
            }
            if (info.kinds) {
              for (const k of info.kinds) {
                if (!nipUsage[nip].kinds.includes(k)) {
                  nipUsage[nip].kinds.push(k);
                }
              }
            }
          }
        }

        if (nipData.summary?.uniqueKinds) {
          for (const kind of nipData.summary.uniqueKinds) {
            if (!kindUsage[kind]) {
              kindUsage[kind] = { repos: [] };
            }
            if (!kindUsage[kind].repos.includes(repo)) {
              kindUsage[kind].repos.push(repo);
            }
          }
        }
      }

      const sortedNips = Object.entries(nipUsage)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {});

      return safeJson({
        summary: {
          totalNIPs: Object.keys(nipUsage).length,
          totalKinds: Object.keys(kindUsage).length,
          reposAnalyzed: Object.keys(allNipData).length,
        },
        nipsByProtocol: sortedNips,
        eventKinds: kindUsage,
      });
    },
  },
  {
    name: "query_flows",
    description: "Aggregate user flows/screens across all frontend repos",
    schema: { type: "object", properties: {} },
    handler: async () => {
      const allFlowData = await loadFromAllRepos("user_flows");

      const aggregated: {
        totalScreens: number;
        totalFlows: number;
        byRepo: Record<string, { screens: number; flows: string[]; routes: string[] }>;
        allFlows: Array<{ repo: string; name: string; description?: string; mermaidDiagram?: string }>;
      } = {
        totalScreens: 0,
        totalFlows: 0,
        byRepo: {},
        allFlows: [],
      };

      for (const [repo, data] of Object.entries(allFlowData)) {
        const flowData = data as {
          screens?: Array<{ name: string }>;
          flows?: Array<{ name: string; description?: string; mermaidDiagram?: string }>;
          routes?: Record<string, string>;
        };

        const screenCount = flowData.screens?.length || 0;
        const flowNames = flowData.flows?.map((f) => f.name) || [];
        const routeList = Object.keys(flowData.routes || {});

        aggregated.totalScreens += screenCount;
        aggregated.totalFlows += flowNames.length;
        aggregated.byRepo[repo] = {
          screens: screenCount,
          flows: flowNames,
          routes: routeList.slice(0, 10),
        };

        if (flowData.flows) {
          for (const flow of flowData.flows) {
            aggregated.allFlows.push({
              repo,
              name: flow.name,
              description: flow.description,
              mermaidDiagram: flow.mermaidDiagram,
            });
          }
        }
      }

      return safeJson(aggregated);
    },
  },
  {
    name: "query_infra",
    description: "Aggregate Kubernetes and Terraform data across all extracted repos",
    schema: { type: "object", properties: {} },
    handler: async () => {
      const k8sData = await loadFromAllRepos("kubernetes");
      const tfData = await loadFromAllRepos("terraform");

      const aggregated: {
        kubernetes: {
          totalResources: number;
          byRepo: Record<string, unknown>;
          services: string[];
          deployments: string[];
          argoApps: string[];
        };
        terraform: {
          totalResources: number;
          byRepo: Record<string, unknown>;
          providers: string[];
        };
      } = {
        kubernetes: { totalResources: 0, byRepo: {}, services: [], deployments: [], argoApps: [] },
        terraform: { totalResources: 0, byRepo: {}, providers: [] },
      };

      for (const [repo, data] of Object.entries(k8sData)) {
        const k8s = data as {
          resources?: Array<{ kind: string; name: string }>;
          argoApps?: Array<{ name: string; namespace: string; destination?: { namespace: string } }>;
          summary?: unknown;
        };
        if (k8s.resources) {
          aggregated.kubernetes.totalResources += k8s.resources.length;
          aggregated.kubernetes.byRepo[repo] = {
            resourceCount: k8s.resources.length,
            argoAppCount: k8s.argoApps?.length || 0,
            summary: k8s.summary,
          };

          for (const r of k8s.resources) {
            if (r.kind === "Service" && !aggregated.kubernetes.services.includes(r.name)) {
              aggregated.kubernetes.services.push(r.name);
            }
            if (r.kind === "Deployment" && !aggregated.kubernetes.deployments.includes(r.name)) {
              aggregated.kubernetes.deployments.push(r.name);
            }
          }
        }

        // Include ArgoCD Applications
        if (k8s.argoApps) {
          for (const app of k8s.argoApps) {
            if (!aggregated.kubernetes.argoApps.includes(app.name)) {
              aggregated.kubernetes.argoApps.push(app.name);
            }
          }
        }
      }

      for (const [repo, data] of Object.entries(tfData)) {
        const tf = data as { resources?: Array<{ type: string; name: string; provider?: string }>; summary?: unknown };
        if (tf.resources) {
          aggregated.terraform.totalResources += tf.resources.length;
          aggregated.terraform.byRepo[repo] = {
            resourceCount: tf.resources.length,
            summary: tf.summary,
          };

          for (const r of tf.resources) {
            if (r.provider && !aggregated.terraform.providers.includes(r.provider)) {
              aggregated.terraform.providers.push(r.provider);
            }
          }
        }
      }

      return safeJson(aggregated);
    },
  },
  {
    name: "query_data_flow",
    description: "Aggregate service dependencies and event flows across repos",
    schema: { type: "object", properties: {} },
    handler: async () => {
      const allDataFlow = await loadFromAllRepos("data_flow");

      const aggregated: {
        services: Record<string, { repo: string; dependencies: string[]; dependents: string[] }>;
        eventFlows: Array<{ repo: string; flow: unknown }>;
        crossRepoConnections: Array<{ from: string; to: string; type: string }>;
      } = {
        services: {},
        eventFlows: [],
        crossRepoConnections: [],
      };

      for (const [repo, data] of Object.entries(allDataFlow)) {
        const flowData = data as {
          services?: Record<string, { dependencies?: string[] }>;
          eventFlows?: unknown[];
        };

        if (flowData.services) {
          for (const [serviceName, info] of Object.entries(flowData.services)) {
            const fullName = `${repo}/${serviceName}`;
            aggregated.services[fullName] = {
              repo,
              dependencies: info.dependencies || [],
              dependents: [],
            };

            for (const dep of info.dependencies || []) {
              if (dep.includes("://") || dep.includes("api.") || dep.includes("relay")) {
                aggregated.crossRepoConnections.push({
                  from: fullName,
                  to: dep,
                  type: "external",
                });
              }
            }
          }
        }

        if (flowData.eventFlows) {
          for (const flow of flowData.eventFlows) {
            aggregated.eventFlows.push({ repo, flow });
          }
        }
      }

      for (const [service, info] of Object.entries(aggregated.services)) {
        for (const dep of info.dependencies) {
          const depService = Object.keys(aggregated.services).find((s) => s.endsWith(`/${dep}`));
          if (depService) {
            aggregated.services[depService].dependents.push(service);
          }
        }
      }

      return safeJson({
        summary: {
          totalServices: Object.keys(aggregated.services).length,
          totalEventFlows: aggregated.eventFlows.length,
          crossRepoConnections: aggregated.crossRepoConnections.length,
        },
        services: aggregated.services,
        crossRepoConnections: aggregated.crossRepoConnections,
      });
    },
  },
  {
    name: "compare_versions",
    description: "Show available repos/refs for comparison. Use extract_ref to pull new refs first, then diff_versions to compare.",
    schema: { type: "object", properties: {} },
    handler: async () => {
      const s = await getStore();
      const repos = await getEnabledExtractedRepos();
      const repoVersions: Record<string, Array<{ refType: string; ref: string }>> = {};

      for (const repo of repos) {
        const versions = await s.listVersions(repo);
        repoVersions[repo] = versions.map((v) => ({ refType: v.refType, ref: v.ref }));
      }

      return safeJson({
        message: "Use diff_versions tool with from_ref and to_ref to compare. Optionally filter by repo or extractor.",
        availableVersions: repoVersions,
        example: {
          from_ref: "v1.0.0",
          to_ref: "main",
          repo: "(optional) filter to one repo",
          extractor: "(optional) nip_usage | user_flows | data_flow | kubernetes | terraform",
        },
      });
    },
  },
  {
    name: "diff_versions",
    description: "Compare ecosystem or repo between two refs (branches/tags). Shows added/removed/changed items.",
    schema: {
      type: "object",
      properties: {
        from_ref: {
          type: "string",
          description: "Source ref (branch or tag name) to compare from",
        },
        to_ref: {
          type: "string",
          description: "Target ref (branch or tag name) to compare to",
        },
        repo: {
          type: "string",
          description: "Optional: limit diff to a specific repo",
        },
        extractor: {
          type: "string",
          description: "Optional: limit diff to specific extractor (nip_usage, user_flows, data_flow, kubernetes, terraform)",
        },
      },
      required: ["from_ref", "to_ref"],
    },
    handler: async (args) => {
      const fromRef = args.from_ref as string;
      const toRef = args.to_ref as string;
      const repoFilter = args.repo as string | undefined;
      const extractorFilter = args.extractor as string | undefined;

      const s = await getStore();
      const repos = await getEnabledExtractedRepos();
      const targetRepos = repoFilter ? repos.filter((r) => r === repoFilter) : repos;

      if (targetRepos.length === 0) {
        return safeJson({ error: `No matching repos found${repoFilter ? ` for "${repoFilter}"` : ""}` });
      }

      const diff: {
        summary: {
          reposCompared: number;
          reposWithChanges: number;
          fromRef: string;
          toRef: string;
        };
        byRepo: Record<string, {
          fromFound: boolean;
          toFound: boolean;
          extractorDiffs: Record<string, unknown>;
        }>;
        aggregated: {
          nips?: { added: string[]; removed: string[]; };
          eventKinds?: { added: number[]; removed: number[]; };
          screens?: { added: string[]; removed: string[]; };
          services?: { added: string[]; removed: string[]; };
          k8sResources?: { added: string[]; removed: string[]; };
          tfResources?: { added: number; removed: number; };
        };
        mermaidDiff?: string;
      } = {
        summary: {
          reposCompared: targetRepos.length,
          reposWithChanges: 0,
          fromRef,
          toRef,
        },
        byRepo: {},
        aggregated: {},
      };

      // Aggregation sets
      const allNipsFrom = new Set<string>();
      const allNipsTo = new Set<string>();
      const allKindsFrom = new Set<number>();
      const allKindsTo = new Set<number>();
      const allScreensFrom = new Set<string>();
      const allScreensTo = new Set<string>();
      const allServicesFrom = new Set<string>();
      const allServicesTo = new Set<string>();
      const allK8sFrom = new Set<string>();
      const allK8sTo = new Set<string>();
      let tfResourcesFrom = 0;
      let tfResourcesTo = 0;

      for (const repo of targetRepos) {
        const versions = await s.listVersions(repo);

        // Find matching refs (check both branch and tag)
        const fromVersion = versions.find((v) => v.ref === fromRef);
        const toVersion = versions.find((v) => v.ref === toRef);

        const fromData = fromVersion
          ? await s.load(repo, fromVersion.refType as "branch" | "tag", fromRef)
          : null;
        const toData = toVersion
          ? await s.load(repo, toVersion.refType as "branch" | "tag", toRef)
          : null;

        diff.byRepo[repo] = {
          fromFound: !!fromData,
          toFound: !!toData,
          extractorDiffs: {},
        };

        if (!fromData && !toData) continue;

        const extractors = extractorFilter
          ? [extractorFilter]
          : ["nip_usage", "user_flows", "data_flow", "kubernetes", "terraform"];

        for (const extractor of extractors) {
          const fromExt = fromData?.data?.[extractor] as Record<string, unknown> | undefined;
          const toExt = toData?.data?.[extractor] as Record<string, unknown> | undefined;

          if (!fromExt && !toExt) continue;

          const extractorDiff = diffExtractor(extractor, fromExt, toExt);
          if (extractorDiff.hasChanges) {
            diff.byRepo[repo].extractorDiffs[extractor] = extractorDiff;
          }

          // Aggregate for ecosystem-wide diff
          if (extractor === "nip_usage") {
            const fromNips = fromExt?.nips as Record<string, unknown> | undefined;
            const toNips = toExt?.nips as Record<string, unknown> | undefined;
            if (fromNips) Object.keys(fromNips).forEach((n) => allNipsFrom.add(n));
            if (toNips) Object.keys(toNips).forEach((n) => allNipsTo.add(n));

            const fromKinds = (fromExt?.summary as { uniqueEventKinds?: number[] })?.uniqueEventKinds || [];
            const toKinds = (toExt?.summary as { uniqueEventKinds?: number[] })?.uniqueEventKinds || [];
            fromKinds.forEach((k) => allKindsFrom.add(k));
            toKinds.forEach((k) => allKindsTo.add(k));
          }

          if (extractor === "user_flows") {
            const fromScreens = (fromExt?.screens as Array<{ name: string }>) || [];
            const toScreens = (toExt?.screens as Array<{ name: string }>) || [];
            fromScreens.forEach((s) => allScreensFrom.add(`${repo}/${s.name}`));
            toScreens.forEach((s) => allScreensTo.add(`${repo}/${s.name}`));
          }

          if (extractor === "data_flow") {
            const fromSvc = (fromExt?.services as Array<{ name: string }>) || [];
            const toSvc = (toExt?.services as Array<{ name: string }>) || [];
            fromSvc.forEach((s) => allServicesFrom.add(`${repo}/${s.name}`));
            toSvc.forEach((s) => allServicesTo.add(`${repo}/${s.name}`));
          }

          if (extractor === "kubernetes") {
            const fromRes = (fromExt?.resources as Array<{ kind: string; name: string }>) || [];
            const toRes = (toExt?.resources as Array<{ kind: string; name: string }>) || [];
            fromRes.forEach((r) => allK8sFrom.add(`${r.kind}/${r.name}`));
            toRes.forEach((r) => allK8sTo.add(`${r.kind}/${r.name}`));
          }

          if (extractor === "terraform") {
            tfResourcesFrom += (fromExt?.resources as number) || 0;
            tfResourcesTo += (toExt?.resources as number) || 0;
          }
        }

        // Check if this repo has any changes
        if (Object.keys(diff.byRepo[repo].extractorDiffs).length > 0) {
          diff.summary.reposWithChanges++;
        }
      }

      // Build aggregated diff
      diff.aggregated = {
        nips: {
          added: [...allNipsTo].filter((n) => !allNipsFrom.has(n)).sort(),
          removed: [...allNipsFrom].filter((n) => !allNipsTo.has(n)).sort(),
        },
        eventKinds: {
          added: [...allKindsTo].filter((k) => !allKindsFrom.has(k)).sort((a, b) => a - b),
          removed: [...allKindsFrom].filter((k) => !allKindsTo.has(k)).sort((a, b) => a - b),
        },
        screens: {
          added: [...allScreensTo].filter((s) => !allScreensFrom.has(s)).sort(),
          removed: [...allScreensFrom].filter((s) => !allScreensTo.has(s)).sort(),
        },
        services: {
          added: [...allServicesTo].filter((s) => !allServicesFrom.has(s)).sort(),
          removed: [...allServicesFrom].filter((s) => !allServicesTo.has(s)).sort(),
        },
        k8sResources: {
          added: [...allK8sTo].filter((r) => !allK8sFrom.has(r)).sort(),
          removed: [...allK8sFrom].filter((r) => !allK8sTo.has(r)).sort(),
        },
        tfResources: {
          added: Math.max(0, tfResourcesTo - tfResourcesFrom),
          removed: Math.max(0, tfResourcesFrom - tfResourcesTo),
        },
      };

      // Generate Mermaid diff diagram
      diff.mermaidDiff = generateDiffDiagram(fromRef, toRef, diff.aggregated);

      return safeJson(diff);
    },
  },
  {
    name: "generate_c4_diagram",
    description: "Generate generic C4-style diagrams from config and data flow",
    schema: { type: "object", properties: {} },
    handler: async () => {
      const overview = await getEcosystemOverview();
      const config = await loadConfig();
      const allDataFlow = await loadFromAllRepos("data_flow");

      const inferCategory = (repoName: string): string => {
        const repoConfig = config.repositories[repoName];
        const type = repoConfig?.type || "unknown";
        const name = repoName.toLowerCase();
        if (name.includes("relay")) return "relay";
        if (name.includes("admin")) return "admin";
        if (name.includes("iac") || name.includes("infra") || type === "infrastructure") return "infra";
        if (name.includes("test") || name.includes("demo") || name === ".github") return "aux";
        if (type === "frontend") return "frontend";
        if (type === "backend") return "backend";
        return "other";
      };

      const mainRepos = overview.repos.filter((r) => inferCategory(r.name) !== "aux");

      const contextLines = [
        "C4Context",
        "    title System Context",
        "",
        '    Person(user, "User", "Uses the applications/services")',
        "",
        '    Enterprise_Boundary(system, "Platform") {',
        '        System(core, "Core System", "Aggregated services and clients")',
        "    }",
      ];

      const containerLines = [
        "C4Container",
        "    title Platform - Container Diagram",
        "",
        '    Person(user, "User", "Interacts with clients")',
        '    System_Boundary(platform, "Platform") {',
      ];

      for (const repo of mainRepos) {
        const cat = inferCategory(repo.name);
        const label = repo.name.replace(/[-_]/g, " ");
        const tech = config.repositories[repo.name]?.language || "unknown";
        const node = repo.name.replace(/[^a-zA-Z0-9]/g, "_");

        if (cat === "frontend") {
          containerLines.push(`        Container(${node}, "${label}", "${tech}", "Client/front-end")`);
          containerLines.push(`        Rel(user, ${node}, "Uses")`);
        } else if (cat === "infra" || cat === "relay") {
          containerLines.push(`        Container(${node}, "${label}", "${tech}", "Infrastructure / platform")`);
        } else if (cat === "admin") {
          containerLines.push(`        Container(${node}, "${label}", "${tech}", "Admin/ops tooling")`);
        } else {
          containerLines.push(`        Container(${node}, "${label}", "${tech}", "Service/component")`);
        }
      }

      containerLines.push("    }");

      const domainLines = [
        "classDiagram",
        "    title Generic Domain Model",
        "    class Entity {",
        "        +id: string",
        "        +createdAt: Date",
        "    }",
        "    class Event {",
        "        +type: string",
        "        +payload: object",
        "    }",
        "    class Service {",
        "        +name: string",
        "        +dependsOn(): Service[]",
        "    }",
        "    Event --> Entity : affects",
        "    Service --> Event : emits/consumes",
      ];

      const flows: string[] = [];
      Object.entries(allDataFlow).forEach(([repo, data]) => {
        const flowData = data as { services?: Record<string, { dependencies?: string[] }> };
        const services = flowData.services || {};
        Object.entries(services).forEach(([svc, info]) => {
          (info.dependencies || []).forEach((dep) => {
            flows.push(`${repo}/${svc} --> ${dep}`);
          });
        });
      });

      return safeJson({
        diagrams: {
          context: { description: "Level 1 context", mermaid: contextLines.join("\n") },
          container: { description: "Level 2 container", mermaid: containerLines.join("\n") },
          domain: { description: "Generic domain sketch", mermaid: domainLines.join("\n") },
          dataFlowEdges: flows.slice(0, 200),
        },
        repos: mainRepos.map((r) => ({ name: r.name, category: inferCategory(r.name) })),
      });
    },
  },
  {
    name: "generate_diagram",
    description: "Generate a simple Mermaid flowchart for the ecosystem",
    schema: { type: "object", properties: {} },
    handler: async () => {
      const overview = await getEcosystemOverview();
      const config = await loadConfig();
      const allDataFlow = await loadFromAllRepos("data_flow");
      const allNipData = await loadFromAllRepos("nip_usage");

      const inferCategory = (repoName: string): string => {
        const repoConfig = config.repositories[repoName];
        const type = repoConfig?.type || "unknown";
        const name = repoName.toLowerCase();
        if (name.includes("relay")) return "relay";
        if (name.includes("admin")) return "admin";
        if (name.includes("iac") || name.includes("infra") || type === "infrastructure") return "infra";
        if (type === "frontend") return "frontend";
        if (type === "backend") return "backend";
        return "other";
      };

      const lines: string[] = ["flowchart TD", "    subgraph Platform"];

      for (const repo of overview.repos) {
        const cat = inferCategory(repo.name);
        const node = repo.name.replace(/[^a-zA-Z0-9]/g, "_");
        lines.push(`        ${node}["${repo.name}\\n(${cat})"]`);
      }

      lines.push("    end");

      Object.entries(allDataFlow).forEach(([repo, data]) => {
        const flowData = data as { services?: Record<string, { dependencies?: string[] }> };
        const services = flowData.services || {};
        Object.entries(services).forEach(([svc, info]) => {
          (info.dependencies || []).forEach((dep) => {
            const from = `${repo}-${svc}`.replace(/[^a-zA-Z0-9]/g, "_");
            const to = dep.replace(/[^a-zA-Z0-9]/g, "_");
            lines.push(`    ${from}["${repo}/${svc}"] --> ${to}`);
          });
        });
      });

      const nipSummary = Object.entries(allNipData).reduce<Record<string, string[]>>((acc, [repo, data]) => {
        const nipData = data as { nips?: Record<string, unknown> };
        const nipKeys = nipData.nips ? Object.keys(nipData.nips) : [];
        acc[repo] = nipKeys;
        return acc;
      }, {});

      return safeJson({
        diagram: lines.join("\n"),
        nipUsage: nipSummary,
      });
    },
  },
  {
    name: "extract_ref",
    description: "Extract knowledge from a repo at a specific ref (branch/tag) on-demand. Fetches latest code and runs extractors.",
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
      const repoName = args.repo as string;
      const ref = args.ref as string;
      const force = (args.force as boolean) || false;

      const config = await loadConfig();
      const repoConfig = config.repositories[repoName];

      if (!repoConfig) {
        return safeJson({
          error: `Repository "${repoName}" not found in config`,
          availableRepos: Object.keys(config.repositories),
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
        // Ensure repo is cloned/updated (this also fetches latest)
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
        const refInfo = isBranch
          ? branches.find((b) => b.name === ref)
          : tags.find((t) => t.name === ref);
        const sha = refInfo?.sha;

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
          repoConfig.extractors
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
          summary: summarizeKnowledge(
            results.reduce((acc, r) => ({ ...acc, [r.extractor]: r.data }), {})
          ),
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
    description: "Extract knowledge from all enabled repos at their configured refs. Useful for initial setup or full refresh.",
    schema: {
      type: "object",
      properties: {
        force: {
          type: "boolean",
          description: "Force re-extraction even if data is fresh (default: false)",
        },
        repos: {
          type: "array",
          items: { type: "string" },
          description: "Optional: limit to specific repos",
        },
      },
    },
    handler: async (args) => {
      const force = (args.force as boolean) || false;
      const repoFilter = args.repos as string[] | undefined;

      const config = await loadConfig();
      const s = await getStore();
      const gm = await getGitManager();

      const results: Array<{
        repo: string;
        ref: string;
        status: "extracted" | "cached" | "skipped" | "error";
        extractors?: string[];
        error?: string;
        duration?: string;
      }> = [];

      const repoNames = repoFilter || Object.keys(config.repositories);

      for (const repoName of repoNames) {
        const repoConfig = config.repositories[repoName];
        if (!repoConfig) {
          results.push({ repo: repoName, ref: "-", status: "error", error: "Not in config" });
          continue;
        }

        if (!isRepoEnabled(repoConfig)) {
          results.push({ repo: repoName, ref: "-", status: "skipped", error: "Disabled" });
          continue;
        }

        // Get refs to extract from track config
        const refsToExtract: Array<{ ref: string; type: "branch" | "tag" }> = [];
        
        if (repoConfig.track.branches) {
          for (const branch of repoConfig.track.branches) {
            refsToExtract.push({ ref: branch, type: "branch" });
          }
        }

        for (const { ref, type } of refsToExtract) {
          // Check freshness
          if (!force) {
            const isFresh = await s.isFresh(repoName, type, ref, 24 * 60 * 60 * 1000);
            if (isFresh) {
              results.push({ repo: repoName, ref, status: "cached" });
              continue;
            }
          }

          try {
            const repoPath = await gm.ensureRepo(repoName, repoConfig.url);

            const startTime = Date.now();
            const extractionResults = await runExtractors(
              { repoName, repoPath, ref, refType: type, gitManager: gm },
              repoConfig.extractors
            );

            const branches = await gm.listBranches(repoPath);
            const sha = branches.find((b) => b.name === ref)?.sha;

            await s.save(repoName, type, ref, extractionResults, sha);

            results.push({
              repo: repoName,
              ref,
              status: "extracted",
              extractors: extractionResults.map((r) => r.extractor),
              duration: `${Date.now() - startTime}ms`,
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
      }

      const extracted = results.filter((r) => r.status === "extracted").length;
      const cached = results.filter((r) => r.status === "cached").length;
      const errors = results.filter((r) => r.status === "error").length;

      return safeJson({
        summary: {
          total: results.length,
          extracted,
          cached,
          skipped: results.filter((r) => r.status === "skipped").length,
          errors,
        },
        results,
      });
    },
  },
];

/**
 * Summarize knowledge data for display
 */
function summarizeKnowledge(data: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!data) return {};

  const summary: Record<string, unknown> = {};

  if (data.nip_usage) {
    const nip = data.nip_usage as { summary?: { uniqueNIPs?: string[]; uniqueEventKinds?: number[] } };
    summary.nip_usage = {
      nips: nip.summary?.uniqueNIPs?.length || 0,
      eventKinds: nip.summary?.uniqueEventKinds?.length || 0,
    };
  }

  if (data.user_flows) {
    const flows = data.user_flows as { screens?: unknown[]; routes?: unknown[] };
    summary.user_flows = {
      screens: flows.screens?.length || 0,
      routes: flows.routes?.length || 0,
    };
  }

  if (data.data_flow) {
    const df = data.data_flow as { services?: unknown[]; externalCalls?: unknown[] };
    summary.data_flow = {
      services: df.services?.length || 0,
      externalCalls: df.externalCalls?.length || 0,
    };
  }

  if (data.kubernetes) {
    const k8s = data.kubernetes as { resources?: unknown[]; argoApps?: unknown[] };
    summary.kubernetes = {
      resources: k8s.resources?.length || 0,
      argoApps: k8s.argoApps?.length || 0,
    };
  }

  if (data.terraform) {
    const tf = data.terraform as { resources?: number; providers?: string[] };
    summary.terraform = {
      resources: tf.resources || 0,
      providers: tf.providers?.length || 0,
    };
  }

  return summary;
}

