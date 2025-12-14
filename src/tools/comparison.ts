/**
 * Comparison tools - diff between versions/refs
 */

import { ToolHandler, safeJson, getStore, getEnabledExtractedRepos, sanitize } from "./shared.js";

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
 * Validate repository name format
 */
function isValidRepoName(repo: unknown): repo is string {
  if (!repo || typeof repo !== "string") return false;
  return /^[a-zA-Z0-9._-]{1,100}$/.test(repo);
}

/**
 * Validate extractor name
 */
function isValidExtractorName(extractor: unknown): extractor is string {
  if (!extractor || typeof extractor !== "string") return false;
  const validExtractors = ["nip_usage", "user_flows", "data_flow", "kubernetes", "terraform", "monorepo", "journey_impact"];
  return validExtractors.includes(extractor);
}

/**
 * Diff two sets and return added/removed items
 */
function diffSets<T>(from: T[], to: T[]): { added: T[]; removed: T[] } {
  const fromSet = new Set(from);
  const toSet = new Set(to);
  return {
    added: to.filter((x) => !fromSet.has(x)),
    removed: from.filter((x) => !toSet.has(x)),
  };
}

/**
 * Generate a Mermaid diagram showing diff summary
 */
function generateDiffDiagram(diff: {
  nips?: { added: string[]; removed: string[] };
  screens?: { added: string[]; removed: string[] };
  services?: { added: string[]; removed: string[] };
}): string {
  const lines: string[] = ["flowchart LR"];
  lines.push('    subgraph Changes["📊 Changes"]');

  if (diff.nips) {
    if (diff.nips.added.length > 0) {
      lines.push(`        nips_added["✅ NIPs Added: ${diff.nips.added.join(", ")}"]`);
    }
    if (diff.nips.removed.length > 0) {
      lines.push(`        nips_removed["❌ NIPs Removed: ${diff.nips.removed.join(", ")}"]`);
    }
  }

  if (diff.screens) {
    if (diff.screens.added.length > 0) {
      const preview = diff.screens.added.slice(0, 3).join(", ");
      const more = diff.screens.added.length > 3 ? ` (+${diff.screens.added.length - 3})` : "";
      lines.push(`        screens_added["✅ Screens: ${preview}${more}"]`);
    }
    if (diff.screens.removed.length > 0) {
      lines.push(`        screens_removed["❌ Screens: -${diff.screens.removed.length}"]`);
    }
  }

  if (diff.services) {
    if (diff.services.added.length > 0) {
      lines.push(`        svc_added["✅ Services: +${diff.services.added.length}"]`);
    }
    if (diff.services.removed.length > 0) {
      lines.push(`        svc_removed["❌ Services: -${diff.services.removed.length}"]`);
    }
  }

  lines.push("    end");

  return lines.join("\n");
}

export const comparisonTools: ToolHandler[] = [
  {
    name: "compare_versions",
    description:
      "Show available repos/refs for comparison. Use extract_ref to pull new refs first, then diff_versions to compare.",
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
          description:
            "Optional: limit diff to specific extractor (nip_usage, user_flows, data_flow, kubernetes, terraform)",
        },
      },
      required: ["from_ref", "to_ref"],
    },
    handler: async (args) => {
      const fromRef = args.from_ref;
      const toRef = args.to_ref;
      const repoFilter = args.repo;
      const extractorFilter = args.extractor;

      // Validate from_ref
      if (!isValidGitRef(fromRef)) {
        return safeJson({
          error: "Invalid from_ref",
          message: "Please provide a valid branch or tag name for from_ref.",
        });
      }

      // Validate to_ref
      if (!isValidGitRef(toRef)) {
        return safeJson({
          error: "Invalid to_ref",
          message: "Please provide a valid branch or tag name for to_ref.",
        });
      }

      // Validate repo filter if provided
      if (repoFilter !== undefined && !isValidRepoName(repoFilter)) {
        return safeJson({
          error: "Invalid repository name",
          message: "Repository names must be 1-100 characters containing only alphanumeric characters, hyphens, underscores, and dots.",
        });
      }

      // Validate extractor filter if provided
      if (extractorFilter !== undefined && !isValidExtractorName(extractorFilter)) {
        return safeJson({
          error: "Invalid extractor name",
          message: "Valid extractors are: nip_usage, user_flows, data_flow, kubernetes, terraform, monorepo, journey_impact",
        });
      }

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
        byRepo: Record<
          string,
          {
            fromFound: boolean;
            toFound: boolean;
            extractorDiffs: Record<string, unknown>;
          }
        >;
        aggregated: {
          nips?: { added: string[]; removed: string[] };
          eventKinds?: { added: number[]; removed: number[] };
          screens?: { added: string[]; removed: string[] };
          services?: { added: string[]; removed: string[] };
          k8sResources?: { added: string[]; removed: string[] };
          tfResources?: { added: number; removed: number };
        };
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

      // Collect all changes for aggregation
      const allNipsFrom: string[] = [];
      const allNipsTo: string[] = [];
      const allScreensFrom: string[] = [];
      const allScreensTo: string[] = [];
      const allServicesFrom: string[] = [];
      const allServicesTo: string[] = [];

      for (const repo of targetRepos) {
        const versions = await s.listVersions(repo);
        const fromVersion = versions.find((v) => v.ref === fromRef);
        const toVersion = versions.find((v) => v.ref === toRef);

        diff.byRepo[repo] = {
          fromFound: !!fromVersion,
          toFound: !!toVersion,
          extractorDiffs: {},
        };

        if (!fromVersion || !toVersion) continue;

        const fromData = await s.load(repo, fromVersion.refType as "branch" | "tag", fromRef);
        const toData = await s.load(repo, toVersion.refType as "branch" | "tag", toRef);

        if (!fromData || !toData) continue;

        let hasChanges = false;

        // Compare NIPs
        if (!extractorFilter || extractorFilter === "nip_usage") {
          const fromNips = fromData.data?.nip_usage as { nips?: Record<string, unknown> } | undefined;
          const toNips = toData.data?.nip_usage as { nips?: Record<string, unknown> } | undefined;
          const fromKeys = Object.keys(fromNips?.nips || {});
          const toKeys = Object.keys(toNips?.nips || {});

          allNipsFrom.push(...fromKeys);
          allNipsTo.push(...toKeys);

          const nipDiff = diffSets(fromKeys, toKeys);
          if (nipDiff.added.length > 0 || nipDiff.removed.length > 0) {
            diff.byRepo[repo].extractorDiffs.nip_usage = nipDiff;
            hasChanges = true;
          }
        }

        // Compare screens
        if (!extractorFilter || extractorFilter === "user_flows") {
          const fromFlows = fromData.data?.user_flows as { screens?: Array<{ name: string }> } | undefined;
          const toFlows = toData.data?.user_flows as { screens?: Array<{ name: string }> } | undefined;
          const fromScreens = (fromFlows?.screens || []).map((s) => s.name);
          const toScreens = (toFlows?.screens || []).map((s) => s.name);

          allScreensFrom.push(...fromScreens);
          allScreensTo.push(...toScreens);

          const screenDiff = diffSets(fromScreens, toScreens);
          if (screenDiff.added.length > 0 || screenDiff.removed.length > 0) {
            diff.byRepo[repo].extractorDiffs.user_flows = screenDiff;
            hasChanges = true;
          }
        }

        // Compare services
        if (!extractorFilter || extractorFilter === "data_flow") {
          const fromFlow = fromData.data?.data_flow as { services?: Array<{ name: string }> } | undefined;
          const toFlow = toData.data?.data_flow as { services?: Array<{ name: string }> } | undefined;
          const fromServices = (fromFlow?.services || []).map((s) => s.name);
          const toServices = (toFlow?.services || []).map((s) => s.name);

          allServicesFrom.push(...fromServices);
          allServicesTo.push(...toServices);

          const serviceDiff = diffSets(fromServices, toServices);
          if (serviceDiff.added.length > 0 || serviceDiff.removed.length > 0) {
            diff.byRepo[repo].extractorDiffs.data_flow = serviceDiff;
            hasChanges = true;
          }
        }

        if (hasChanges) {
          diff.summary.reposWithChanges++;
        }
      }

      // Aggregate changes
      diff.aggregated.nips = diffSets([...new Set(allNipsFrom)], [...new Set(allNipsTo)]);
      diff.aggregated.screens = diffSets([...new Set(allScreensFrom)], [...new Set(allScreensTo)]);
      diff.aggregated.services = diffSets([...new Set(allServicesFrom)], [...new Set(allServicesTo)]);

      // Generate visual diff
      const mermaid = generateDiffDiagram(diff.aggregated);

      return safeJson({
        ...diff,
        mermaid,
        hint: "Display 'mermaid' in a ```mermaid block for visual diff",
      });
    },
  },
];
