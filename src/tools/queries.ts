/**
 * Query tools - aggregate data across repos
 */

import { loadConfig } from "../lib/config-loader.js";
import {
  ToolHandler,
  safeJson,
  loadFromAllRepos,
  getEcosystemOverview,
  getStore,
  getGitManager,
} from "./shared.js";

export const queryTools: ToolHandler[] = [
  {
    name: "list_repos",
    description:
      "List repos with their latest extracted ref. Use extract_ref(repo, ref) to extract new branches/tags on-demand.",
    schema: { type: "object", properties: {} },
    handler: async () => {
      const overview = await getEcosystemOverview();
      return safeJson(overview);
    },
  },
  {
    name: "list_refs",
    description: "List branches and tags for each configured repo from local cache. Tags are sorted by date (latest first), branches are unsorted. Only fetches from remote if repo doesn't exist locally.",
    schema: { type: "object", properties: {} },
    handler: async () => {
      const config = await loadConfig();
      const gm = await getGitManager();
      const result: Record<string, unknown> = {};

      // Process repos in parallel for better performance
      // Use skipFetch=true and verify=false to read from local cache only (fast, no verification)
      const repoEntries = Object.entries(config.repositories);
      const promises = repoEntries.map(async ([repoName, repoConfig]) => {
        try {
          // Skip verification and cloning for list_refs - we just want to list refs from local cache
          // If repo doesn't exist, return error instead of cloning (which is slow)
          const state = await gm.getRepoState(repoName, repoConfig.url, { skipFetch: true, verify: false, skipClone: true });
          return {
            repoName,
            data: {
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
            },
          };
        } catch (error) {
          return {
            repoName,
            data: { error: `Could not list refs: ${error}` },
          };
        }
      });

      const results = await Promise.all(promises);
      for (const { repoName, data } of results) {
        result[repoName] = data;
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
              nipUsage[nip].kinds.push(...info.kinds);
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

      return safeJson({
        summary: {
          totalNips: Object.keys(nipUsage).length,
          totalKinds: Object.keys(kindUsage).length,
          reposWithNips: [...new Set(Object.values(nipUsage).flatMap((n) => n.repos))].length,
        },
        nipUsage,
        kindUsage,
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
      } = {
        totalScreens: 0,
        totalFlows: 0,
        byRepo: {},
      };

      for (const [repo, data] of Object.entries(allFlowData)) {
        const flowData = data as {
          screens?: Array<{ name: string; file: string }>;
          routes?: string[];
        };

        const screens = flowData.screens || [];
        const routes = flowData.routes || [];

        aggregated.totalScreens += screens.length;
        aggregated.totalFlows += routes.length;

        aggregated.byRepo[repo] = {
          screens: screens.length,
          flows: screens.map((s) => s.name),
          routes,
        };
      }

      return safeJson(aggregated);
    },
  },
  {
    name: "query_infra",
    description: "Aggregate Kubernetes and Terraform data across all extracted repos",
    schema: { type: "object", properties: {} },
    handler: async () => {
      const allK8sData = await loadFromAllRepos("kubernetes");
      const allTfData = await loadFromAllRepos("terraform");

      const aggregated: {
        kubernetes: {
          totalDeployments: number;
          totalServices: number;
          byRepo: Record<string, { deployments: string[]; services: string[] }>;
        };
        terraform: {
          totalResources: number;
          totalModules: number;
          providers: string[];
          byRepo: Record<string, { resources: number; modules: number; providers: string[] }>;
        };
      } = {
        kubernetes: {
          totalDeployments: 0,
          totalServices: 0,
          byRepo: {},
        },
        terraform: {
          totalResources: 0,
          totalModules: 0,
          providers: [],
          byRepo: {},
        },
      };

      for (const [repo, data] of Object.entries(allK8sData)) {
        const k8s = data as {
          deployments?: Array<{ name: string }>;
          services?: Array<{ name: string }>;
        };

        const deployments = (k8s.deployments || []).map((d) => d.name);
        const services = (k8s.services || []).map((s) => s.name);

        aggregated.kubernetes.totalDeployments += deployments.length;
        aggregated.kubernetes.totalServices += services.length;
        aggregated.kubernetes.byRepo[repo] = { deployments, services };
      }

      for (const [repo, data] of Object.entries(allTfData)) {
        const tf = data as {
          files?: string[];
          resources?: number;
          modules?: number;
          providers?: string[];
        };

        const resourceCount = tf.resources || 0;
        const moduleCount = tf.modules || 0;
        const providers = tf.providers || [];

        aggregated.terraform.totalResources += resourceCount;
        aggregated.terraform.totalModules += moduleCount;
        aggregated.terraform.providers.push(...providers);
        aggregated.terraform.byRepo[repo] = {
          resources: resourceCount,
          modules: moduleCount,
          providers,
        };
      }

      aggregated.terraform.providers = [...new Set(aggregated.terraform.providers)];

      return safeJson(aggregated);
    },
  },
  {
    name: "query_data_flow",
    description: "Aggregate service dependencies and event flows across repos",
    schema: { type: "object", properties: {} },
    handler: async () => {
      const allDataFlow = await loadFromAllRepos("data_flow");

      const services: Record<
        string,
        {
          repo: string;
          dependencies: string[];
          dependents: string[];
        }
      > = {};

      const crossRepoConnections: Array<{
        from: string;
        to: string;
        type: string;
      }> = [];

      for (const [repo, data] of Object.entries(allDataFlow)) {
        const flowData = data as {
          services?: Array<{ name: string; dependencies?: string[] }>;
          externalCalls?: Array<{ target: string }>;
        };

        if (flowData.services) {
          for (const [idx, svc] of flowData.services.entries()) {
            const svcKey = `${repo}/${idx}`;
            services[svcKey] = {
              repo,
              dependencies: svc.dependencies || [],
              dependents: [],
            };
          }
        }
      }

      return safeJson({
        summary: {
          totalServices: Object.keys(services).length,
          totalEventFlows: 0,
          crossRepoConnections: crossRepoConnections.length,
        },
        services,
        crossRepoConnections,
      });
    },
  },
  {
    name: "query_monorepos",
    description: "Aggregate monorepo structure data across all repos - packages, apps, dependencies",
    schema: { type: "object", properties: {} },
    handler: async () => {
      const allMonorepoData = await loadFromAllRepos("monorepo");

      const aggregated: {
        totalMonorepos: number;
        byRepo: Record<
          string,
          {
            tool: string;
            packages: number;
            apps: number;
            libs: number;
            frameworks: string[];
          }
        >;
        allPackages: Array<{
          repo: string;
          name: string;
          path: string;
          type: string;
          framework?: string;
        }>;
        frameworks: Record<string, number>;
        dependencyGraph: Array<{ from: string; to: string }>;
      } = {
        totalMonorepos: 0,
        byRepo: {},
        allPackages: [],
        frameworks: {},
        dependencyGraph: [],
      };

      for (const [repo, data] of Object.entries(allMonorepoData)) {
        const mono = data as {
          detected?: boolean;
          tool?: string;
          packages?: Array<{
            name: string;
            path: string;
            type: string;
            framework?: string;
          }>;
          apps?: Array<{ name: string; path: string; framework?: string }>;
          libs?: Array<{ name: string; path: string }>;
          summary?: { frameworks?: string[] };
          dependencyGraph?: Array<{ from: string; to: string }>;
        };

        if (!mono.detected) continue;

        aggregated.totalMonorepos++;

        const apps = mono.apps || [];
        const libs = mono.libs || [];
        const packages = mono.packages || [];
        const frameworks = mono.summary?.frameworks || [];

        aggregated.byRepo[repo] = {
          tool: mono.tool || "unknown",
          packages: packages.length,
          apps: apps.length,
          libs: libs.length,
          frameworks,
        };

        for (const pkg of packages) {
          aggregated.allPackages.push({
            repo,
            name: pkg.name,
            path: pkg.path,
            type: pkg.type,
            framework: pkg.framework,
          });

          if (pkg.framework) {
            aggregated.frameworks[pkg.framework] = (aggregated.frameworks[pkg.framework] || 0) + 1;
          }
        }

        if (mono.dependencyGraph) {
          for (const dep of mono.dependencyGraph) {
            aggregated.dependencyGraph.push({
              from: `${repo}/${dep.from}`,
              to: `${repo}/${dep.to}`,
            });
          }
        }
      }

      return safeJson(aggregated);
    },
  },
];
