/**
 * Type Definition Tools - Cross-repo type analysis and dataflow mapping
 *
 * Enables:
 * - Finding shared types across repos (API contracts)
 * - Mapping data flow between services via type relationships
 * - Generating type relationship diagrams
 */

import { loadConfig } from "../lib/config-loader.js";
import {
  ToolHandler,
  safeJson,
  loadFromAllRepos,
  getStore,
  sanitize,
  sanitizeLabel,
} from "./shared.js";
import type {
  TypeDefinition,
  TypeRelationship,
  TypeDefinitionsResult,
} from "../extractors/types/schema.js";

// =============================================================================
// Type Matching Utilities
// =============================================================================

/**
 * Normalize a type name for matching (handle naming convention differences)
 * - Rust: snake_case struct names (BlobDescriptor)
 * - TypeScript: PascalCase interfaces (BlobDescriptor)
 * - Dart: PascalCase classes (BlobDescriptor)
 * - Go: PascalCase structs (BlobDescriptor)
 */
function normalizeTypeName(name: string): string {
  return name
    .replace(/[_-]/g, "") // Remove underscores/hyphens
    .toLowerCase();
}

/**
 * Calculate similarity between two type definitions
 * Returns a score from 0-100
 */
function calculateTypeSimilarity(a: TypeDefinition, b: TypeDefinition): number {
  let score = 0;

  // Exact name match after normalization
  if (normalizeTypeName(a.name) === normalizeTypeName(b.name)) {
    score += 50;
  }

  // Same kind (struct/class/interface are equivalent)
  const equivalentKinds: Record<string, string[]> = {
    struct: ["struct", "class", "interface"],
    class: ["struct", "class", "interface"],
    interface: ["struct", "class", "interface", "trait", "protocol"],
    enum: ["enum"],
    trait: ["trait", "interface", "protocol"],
    type_alias: ["type_alias"],
  };
  if (equivalentKinds[a.kind]?.includes(b.kind)) {
    score += 20;
  }

  // Field matching (for structs/classes)
  if (a.fields && b.fields && a.fields.length > 0 && b.fields.length > 0) {
    const aFieldNames = new Set(a.fields.map((f) => normalizeTypeName(f.name)));
    const bFieldNames = new Set(b.fields.map((f) => normalizeTypeName(f.name)));
    const intersection = [...aFieldNames].filter((n) => bFieldNames.has(n));
    const fieldOverlap = intersection.length / Math.max(aFieldNames.size, bFieldNames.size);
    score += Math.round(fieldOverlap * 30);
  }

  return score;
}

/**
 * Find types that appear in multiple repos (shared contracts)
 */
interface CrossRepoMatch {
  normalizedName: string;
  instances: Array<{
    repo: string;
    type: TypeDefinition;
  }>;
  similarity: number;
}

function findCrossRepoTypes(
  allTypeData: Record<string, TypeDefinitionsResult>
): CrossRepoMatch[] {
  // Group types by normalized name
  const byName = new Map<string, Array<{ repo: string; type: TypeDefinition }>>();

  for (const [repo, data] of Object.entries(allTypeData)) {
    for (const type of data.types) {
      const normalized = normalizeTypeName(type.name);
      if (!byName.has(normalized)) {
        byName.set(normalized, []);
      }
      byName.get(normalized)!.push({ repo, type });
    }
  }

  // Filter to types that appear in multiple repos
  const matches: CrossRepoMatch[] = [];
  for (const [normalizedName, instances] of byName) {
    const repos = new Set(instances.map((i) => i.repo));
    if (repos.size > 1) {
      // Calculate average similarity between instances
      let totalSimilarity = 0;
      let comparisons = 0;
      for (let i = 0; i < instances.length; i++) {
        for (let j = i + 1; j < instances.length; j++) {
          if (instances[i].repo !== instances[j].repo) {
            totalSimilarity += calculateTypeSimilarity(
              instances[i].type,
              instances[j].type
            );
            comparisons++;
          }
        }
      }
      const avgSimilarity = comparisons > 0 ? Math.round(totalSimilarity / comparisons) : 0;

      matches.push({
        normalizedName,
        instances,
        similarity: avgSimilarity,
      });
    }
  }

  // Sort by similarity (highest first)
  return matches.sort((a, b) => b.similarity - a.similarity);
}

/**
 * Build cross-repo type flow edges
 */
interface TypeFlowEdge {
  fromRepo: string;
  fromType: string;
  toRepo: string;
  toType: string;
  confidence: number;
  sharedFields: string[];
}

function buildTypeFlowEdges(matches: CrossRepoMatch[]): TypeFlowEdge[] {
  const edges: TypeFlowEdge[] = [];

  for (const match of matches) {
    if (match.similarity < 50) continue; // Skip low-confidence matches

    // Create edges between all repo pairs for this type
    for (let i = 0; i < match.instances.length; i++) {
      for (let j = i + 1; j < match.instances.length; j++) {
        const a = match.instances[i];
        const b = match.instances[j];

        // Find shared fields
        const aFields = new Set(a.type.fields?.map((f) => normalizeTypeName(f.name)) || []);
        const bFields = new Set(b.type.fields?.map((f) => normalizeTypeName(f.name)) || []);
        const sharedFields = [...aFields].filter((f) => bFields.has(f));

        edges.push({
          fromRepo: a.repo,
          fromType: a.type.name,
          toRepo: b.repo,
          toType: b.type.name,
          confidence: match.similarity,
          sharedFields,
        });
      }
    }
  }

  return edges;
}

// =============================================================================
// Tool Handlers
// =============================================================================

export const typeTools: ToolHandler[] = [
  {
    name: "query_types",
    description: `Query type definitions across repos.

OPTIONS:
- No args: Summary of all types across all repos
- repo: Types in a specific repo
- name: Search for types by name (fuzzy match)
- kind: Filter by kind (struct, class, interface, enum, trait, type_alias)

Returns type definitions with fields, relationships, and module organization.`,
    schema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Filter to a specific repo",
        },
        name: {
          type: "string",
          description: "Search for types by name (case-insensitive, partial match)",
        },
        kind: {
          type: "string",
          enum: ["struct", "class", "interface", "enum", "trait", "type_alias", "protocol", "union"],
          description: "Filter by type kind",
        },
        limit: {
          type: "number",
          description: "Max results to return (default: 50)",
        },
      },
    },
    handler: async (args) => {
      const targetRepo = args.repo as string | undefined;
      const searchName = args.name as string | undefined;
      const filterKind = args.kind as string | undefined;
      const limit = (args.limit as number) || 50;

      const allTypeData = (await loadFromAllRepos("type_definitions")) as Record<
        string,
        TypeDefinitionsResult
      >;

      // Filter repos
      const reposToSearch = targetRepo
        ? { [targetRepo]: allTypeData[targetRepo] }
        : allTypeData;

      if (targetRepo && !allTypeData[targetRepo]) {
        return safeJson({
          error: `No type data for repo '${targetRepo}'. Run type_definitions extractor first.`,
        });
      }

      // Collect matching types
      const results: Array<{
        repo: string;
        type: TypeDefinition;
      }> = [];

      for (const [repo, data] of Object.entries(reposToSearch)) {
        if (!data?.types) continue;

        for (const type of data.types) {
          // Apply filters
          if (filterKind && type.kind !== filterKind) continue;
          if (searchName) {
            const normalized = normalizeTypeName(searchName);
            if (!normalizeTypeName(type.name).includes(normalized)) continue;
          }

          results.push({ repo, type });
        }
      }

      // Sort by importance (public types with more fields first)
      results.sort((a, b) => {
        const aScore = (a.type.visibility === "public" ? 100 : 0) + (a.type.fields?.length || 0);
        const bScore = (b.type.visibility === "public" ? 100 : 0) + (b.type.fields?.length || 0);
        return bScore - aScore;
      });

      // Build summary
      const summary: Record<string, Record<string, number>> = {};
      for (const [repo, data] of Object.entries(allTypeData)) {
        if (!data?.summary) continue;
        summary[repo] = data.summary.byKind;
      }

      return safeJson({
        totalMatches: results.length,
        types: results.slice(0, limit).map(({ repo, type }) => ({
          repo,
          name: type.name,
          kind: type.kind,
          file: type.file,
          language: type.language,
          visibility: type.visibility,
          fields: type.fields?.slice(0, 10).map((f) => ({
            name: f.name,
            type: f.typeRef.raw,
            optional: f.optional,
          })),
          fieldCount: type.fields?.length,
          variants: type.variants?.map((v) => v.name),
          extends: type.extends?.map((e) => e.name),
          implements: type.implements?.map((i) => i.name),
          decorators: type.decorators,
        })),
        summary,
        hint: results.length > limit
          ? `Showing ${limit} of ${results.length} matches. Use 'limit' param for more.`
          : undefined,
      });
    },
  },
  {
    name: "query_shared_types",
    description: `Find types that appear across multiple repos - identifies shared data contracts.

This is KEY for understanding cross-service data flow:
- Types with the same name in different repos indicate API boundaries
- High similarity scores mean the types have matching fields (strong contract)
- Low similarity might indicate drift or versioning issues

Returns: Shared types ranked by similarity, with field comparison.`,
    schema: {
      type: "object",
      properties: {
        minSimilarity: {
          type: "number",
          description: "Minimum similarity score (0-100). Default: 50",
        },
        limit: {
          type: "number",
          description: "Max shared types to return. Default: 20",
        },
      },
    },
    handler: async (args) => {
      const minSimilarity = (args.minSimilarity as number) || 50;
      const limit = (args.limit as number) || 20;

      const allTypeData = (await loadFromAllRepos("type_definitions")) as Record<
        string,
        TypeDefinitionsResult
      >;

      const matches = findCrossRepoTypes(allTypeData);
      const filtered = matches.filter((m) => m.similarity >= minSimilarity);

      return safeJson({
        totalSharedTypes: filtered.length,
        sharedTypes: filtered.slice(0, limit).map((match) => ({
          name: match.normalizedName,
          similarity: match.similarity,
          repos: [...new Set(match.instances.map((i) => i.repo))],
          instances: match.instances.map((inst) => ({
            repo: inst.repo,
            name: inst.type.name,
            kind: inst.type.kind,
            language: inst.type.language,
            file: inst.type.file,
            fields: inst.type.fields?.slice(0, 8).map((f) => ({
              name: f.name,
              type: f.typeRef.raw,
            })),
            fieldCount: inst.type.fields?.length,
          })),
        })),
        insight:
          filtered.length > 0
            ? `Found ${filtered.length} shared types indicating data contracts between repos.`
            : "No shared types found. Repos may use different type naming or be independent.",
      });
    },
  },
  {
    name: "generate_type_flow_diagram",
    description: `Generate a Mermaid diagram showing how types flow between repos.

This visualizes the data contract relationships between services:
- Nodes are repos
- Edges show shared types (data flowing between services)
- Edge labels show the type names

IMPORTANT: Display the returned 'mermaid' field in a \`\`\`mermaid code block.`,
    schema: {
      type: "object",
      properties: {
        minSimilarity: {
          type: "number",
          description: "Minimum similarity to show edge (0-100). Default: 60",
        },
        focusRepo: {
          type: "string",
          description: "Optional: Focus on connections to/from a specific repo",
        },
      },
    },
    handler: async (args) => {
      const minSimilarity = (args.minSimilarity as number) || 60;
      const focusRepo = args.focusRepo as string | undefined;

      const allTypeData = (await loadFromAllRepos("type_definitions")) as Record<
        string,
        TypeDefinitionsResult
      >;

      const matches = findCrossRepoTypes(allTypeData);
      let edges = buildTypeFlowEdges(matches.filter((m) => m.similarity >= minSimilarity));

      // Filter to focus repo if specified
      if (focusRepo) {
        edges = edges.filter((e) => e.fromRepo === focusRepo || e.toRepo === focusRepo);
      }

      // Group edges by repo pair
      const edgesByPair = new Map<string, TypeFlowEdge[]>();
      for (const edge of edges) {
        const key = [edge.fromRepo, edge.toRepo].sort().join("↔");
        if (!edgesByPair.has(key)) {
          edgesByPair.set(key, []);
        }
        edgesByPair.get(key)!.push(edge);
      }

      // Build Mermaid diagram
      const lines: string[] = ["flowchart LR"];

      // Collect all repos involved
      const repos = new Set<string>();
      for (const edge of edges) {
        repos.add(edge.fromRepo);
        repos.add(edge.toRepo);
      }

      // Add repo nodes
      const config = await loadConfig();
      for (const repo of repos) {
        const repoConfig = config.repositories[repo];
        const lang = repoConfig?.language || "?";
        const repoLabel = sanitizeLabel(repo);
        lines.push(`    ${sanitize(repo)}["📦 ${repoLabel}<br/>${lang}"]`);
      }
      lines.push("");

      // Add edges with type labels
      for (const [_pairKey, pairEdges] of edgesByPair) {
        const typeNames = [...new Set(pairEdges.map((e) => e.fromType))].slice(0, 3);
        const label = typeNames.join(", ") + (pairEdges.length > 3 ? "..." : "");
        const avgConfidence = Math.round(
          pairEdges.reduce((sum, e) => sum + e.confidence, 0) / pairEdges.length
        );

        const from = sanitize(pairEdges[0].fromRepo);
        const to = sanitize(pairEdges[0].toRepo);
        const style = avgConfidence >= 80 ? "==>" : "-->";

        lines.push(`    ${from} ${style}|"${sanitizeLabel(label)}"| ${to}`);
      }

      if (edges.length === 0) {
        lines.push('    note["No shared types found above similarity threshold"]');
      }

      const mermaid = lines.join("\n");

      return safeJson({
        mermaid,
        stats: {
          repos: repos.size,
          sharedTypes: edges.length,
          strongContracts: edges.filter((e) => e.confidence >= 80).length,
        },
        edges: edges.slice(0, 20).map((e) => ({
          from: `${e.fromRepo}/${e.fromType}`,
          to: `${e.toRepo}/${e.toType}`,
          confidence: e.confidence,
          sharedFields: e.sharedFields.slice(0, 5),
        })),
        hint: "Display 'mermaid' in a ```mermaid block. Use focusRepo param to filter.",
      });
    },
  },
  {
    name: "query_type_relationships",
    description: `Get type relationships within a repo - useful for ER diagrams and understanding data models.

Returns:
- extends: Inheritance relationships
- implements: Trait/interface implementations
- contains: Field references to other types
- collection: Collection fields (arrays/lists of other types)`,
    schema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Repository to analyze (required)",
        },
        type: {
          type: "string",
          description: "Optional: Focus on relationships for a specific type",
        },
      },
      required: ["repo"],
    },
    handler: async (args) => {
      const repo = args.repo as string;
      const focusType = args.type as string | undefined;

      const s = await getStore();
      const versions = await s.listVersions(repo);
      if (versions.length === 0) {
        return safeJson({ error: `No data for repo '${repo}'` });
      }

      const latest = versions[0];
      const data = (await s.loadExtractor(
        repo,
        latest.refType as "branch" | "tag",
        latest.ref,
        "type_definitions"
      )) as TypeDefinitionsResult | null;

      if (!data) {
        return safeJson({ error: `No type_definitions data for '${repo}'` });
      }

      let relationships = data.relationships;

      // Filter to focus type if specified
      if (focusType) {
        const normalized = normalizeTypeName(focusType);
        relationships = relationships.filter(
          (r) =>
            normalizeTypeName(r.from).includes(normalized) ||
            normalizeTypeName(r.to).includes(normalized)
        );
      }

      // Group by kind
      const byKind: Record<string, TypeRelationship[]> = {};
      for (const rel of relationships) {
        if (!byKind[rel.kind]) byKind[rel.kind] = [];
        byKind[rel.kind].push(rel);
      }

      return safeJson({
        repo,
        ref: latest.ref,
        totalRelationships: relationships.length,
        byKind: Object.fromEntries(
          Object.entries(byKind).map(([kind, rels]) => [
            kind,
            rels.slice(0, 20).map((r) => ({
              from: r.from,
              to: r.to,
              viaField: r.viaField,
            })),
          ])
        ),
        modules: data.modules.map((m) => ({
          path: m.path,
          types: m.types.length,
          internalRelationships: m.internalRelationships.length,
          externalRelationships: m.externalRelationships.length,
        })),
      });
    },
  },
  {
    name: "generate_call_diagram",
    description: `Generate a Mermaid diagram showing function call relationships.

Shows how functions call each other within a repo. Great for:
- Understanding code flow and dependencies
- Finding entry points and hotspots
- Tracing execution paths

OPTIONS:
- repo: Required. Repository to analyze
- function: Optional. Focus on calls to/from a specific function
- direction: 'callers' | 'callees' | 'both' (default: 'both')
- depth: How many levels to traverse (default: 2, max: 5)
- limit: Max nodes to show (default: 30)
- format: 'flowchart' | 'sequence' (default: 'flowchart')
  - flowchart: Shows call graph structure
  - sequence: Shows temporal call order (great for tracing execution)

IMPORTANT: Display the returned 'mermaid' field in a \`\`\`mermaid code block.`,
    schema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Repository to analyze (required)",
        },
        function: {
          type: "string",
          description: "Focus on a specific function (partial match)",
        },
        direction: {
          type: "string",
          enum: ["callers", "callees", "both"],
          description: "Direction to traverse. Default: both",
        },
        depth: {
          type: "number",
          description: "Levels to traverse (1-5). Default: 2",
        },
        limit: {
          type: "number",
          description: "Max nodes to show. Default: 30",
        },
        format: {
          type: "string",
          enum: ["flowchart", "sequence"],
          description: "Diagram format. Default: flowchart",
        },
      },
      required: ["repo"],
    },
    handler: async (args) => {
      const repo = args.repo as string;
      const focusFunction = args.function as string | undefined;
      const direction = (args.direction as "callers" | "callees" | "both") || "both";
      const depth = Math.min(Math.max((args.depth as number) || 2, 1), 5);
      const limit = (args.limit as number) || 30;
      const format = (args.format as "flowchart" | "sequence") || "flowchart";

      const s = await getStore();
      const versions = await s.listVersions(repo);
      if (versions.length === 0) {
        return safeJson({ error: `No data for repo '${repo}'` });
      }

      const latest = versions[0];
      const data = (await s.loadExtractor(
        repo,
        latest.refType as "branch" | "tag",
        latest.ref,
        "type_definitions"
      )) as TypeDefinitionsResult | null;

      if (!data || !data.calls || data.calls.length === 0) {
        return safeJson({
          error: `No call data for '${repo}'. Only TypeScript repos with the AST parser have call extraction.`,
        });
      }

      interface CallEdge {
        caller: string;
        callee: string;
        file: string;
        line: number;
      }

      const calls = data.calls as CallEdge[];

      // Helper to sanitize participant names for sequence diagrams
      function sanitizeParticipant(name: string): string {
        return name.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+|_+$/g, "") || "fn";
      }

      // Build call graph
      const callersOf = new Map<string, Set<string>>(); // function -> who calls it
      const calleesOf = new Map<string, Set<string>>(); // function -> what it calls
      const callCounts = new Map<string, number>(); // function -> how many times called

      for (const call of calls) {
        // Track callers
        if (!callersOf.has(call.callee)) callersOf.set(call.callee, new Set());
        callersOf.get(call.callee)!.add(call.caller);

        // Track callees
        if (!calleesOf.has(call.caller)) calleesOf.set(call.caller, new Set());
        calleesOf.get(call.caller)!.add(call.callee);

        // Count calls
        callCounts.set(call.callee, (callCounts.get(call.callee) || 0) + 1);
      }

      // Find focus functions or top callees
      let focusFunctions: string[] = [];

      if (focusFunction) {
        const lower = focusFunction.toLowerCase();
        focusFunctions = [...calleesOf.keys(), ...callersOf.keys()]
          .filter((fn) => fn.toLowerCase().includes(lower))
          .filter((fn, idx, arr) => arr.indexOf(fn) === idx) // unique
          .slice(0, 5);

        if (focusFunctions.length === 0) {
          return safeJson({
            error: `No functions matching '${focusFunction}' found`,
            availableFunctions: [...new Set([...calleesOf.keys()].slice(0, 20))],
          });
        }
      } else {
        // Show most-called functions as starting points
        focusFunctions = [...callCounts.entries()]
          .filter(([fn]) => !fn.includes(".") && fn !== "<top-level>") // Skip method calls and top-level
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([fn]) => fn);
      }

      // BFS to collect nodes within depth
      const nodesToShow = new Set<string>(focusFunctions);
      const edgesToShow = new Set<string>();

      function addEdge(from: string, to: string) {
        edgesToShow.add(`${from}|||${to}`);
      }

      let frontier = new Set(focusFunctions);
      for (let d = 0; d < depth && nodesToShow.size < limit; d++) {
        const nextFrontier = new Set<string>();

        for (const fn of frontier) {
          if (direction === "callers" || direction === "both") {
            for (const caller of callersOf.get(fn) || []) {
              if (nodesToShow.size < limit && !nodesToShow.has(caller)) {
                nodesToShow.add(caller);
                nextFrontier.add(caller);
              }
              if (nodesToShow.has(caller)) {
                addEdge(caller, fn);
              }
            }
          }
          if (direction === "callees" || direction === "both") {
            for (const callee of calleesOf.get(fn) || []) {
              if (nodesToShow.size < limit && !nodesToShow.has(callee)) {
                nodesToShow.add(callee);
                nextFrontier.add(callee);
              }
              if (nodesToShow.has(callee)) {
                addEdge(fn, callee);
              }
            }
          }
        }

        frontier = nextFrontier;
      }

      // Build Mermaid diagram
      let mermaid: string;

      if (format === "sequence") {
        // ===== SEQUENCE DIAGRAM =====
        // Filter calls to only those involving focus functions and their immediate connections
        const relevantCalls: CallEdge[] = [];
        const participantSet = new Set<string>();

        // Noise patterns to skip - standard library, obvious operations
        const noisePatterns = [
          // Logging
          /^console\./,
          /^debugLog$/,
          /^verboseLog$/,
          /^log$/,
          // Standard array/object methods
          /\.forEach$/,
          /\.map$/,
          /\.filter$/,
          /\.find$/,
          /\.reduce$/,
          /\.push$/,
          /\.pop$/,
          /\.shift$/,
          /\.slice$/,
          /\.splice$/,
          /\.split$/,
          /\.join$/,
          /\.includes$/,
          /\.indexOf$/,
          /\.keys$/,
          /\.values$/,
          /\.entries$/,
          /\.has$/,
          /\.get$/,
          /\.set$/,
          /\.delete$/,
          /\.clear$/,
          /\.add$/,
          /\.size$/,
          // String methods
          /\.trim$/,
          /\.toLowerCase$/,
          /\.toUpperCase$/,
          /\.replace$/,
          /\.match$/,
          /\.startsWith$/,
          /\.endsWith$/,
          /\.substring$/,
          /\.charAt$/,
          // Number/parsing
          /^parseInt$/,
          /^parseFloat$/,
          /^Number$/,
          /^String$/,
          /^Boolean$/,
          /^JSON\.parse$/,
          /^JSON\.stringify$/,
          // Promise/async
          /\.then$/,
          /\.catch$/,
          /\.finally$/,
          /^Promise\./,
          /^await$/,
          // Object operations
          /^Object\./,
          /^Array\./,
          // Generic single-word methods
          /^push$/,
          /^pop$/,
          /^sort$/,
          /^reverse$/,
        ];

        const isNoise = (name: string): boolean => {
          return noisePatterns.some(p => p.test(name));
        };

        // Get calls from focus functions (showing what they call)
        for (const call of calls) {
          const callerMatches = focusFunctions.some(fn => call.caller === fn || call.caller.includes(fn));
          const calleeMatches = focusFunctions.some(fn => call.callee === fn || call.callee.includes(fn));

          if (callerMatches || calleeMatches) {
            // Skip noise - standard library calls that clutter the diagram
            if (isNoise(call.callee)) continue;

            relevantCalls.push(call);
            participantSet.add(call.caller);
            participantSet.add(call.callee);
          }
        }

        // Sort by file then line to show temporal order
        relevantCalls.sort((a, b) => {
          if (a.file !== b.file) return a.file.localeCompare(b.file);
          return a.line - b.line;
        });

        // Limit calls shown
        const callsToShow = relevantCalls.slice(0, limit);

        // Build participant list - focus functions first, then others
        const participants: string[] = [];
        for (const fn of focusFunctions) {
          if (participantSet.has(fn)) {
            participants.push(fn);
            participantSet.delete(fn);
          }
        }
        // Add remaining participants (limited)
        const remaining = [...participantSet].slice(0, Math.max(0, 15 - participants.length));
        participants.push(...remaining);

        const lines: string[] = ["sequenceDiagram"];

        // Add participants with aliases (quoted labels for special chars)
        for (const fn of participants) {
          const alias = sanitizeParticipant(fn);
          // Replace dots with middot for cleaner display, quote the label
          const label = fn.replace(/\./g, "·");
          if (focusFunctions.includes(fn)) {
            lines.push(`    participant ${alias} as "🎯 ${label}"`);
          } else {
            lines.push(`    participant ${alias} as "${label}"`);
          }
        }
        lines.push("");

        // Group calls by file for better organization
        let currentFile = "";
        for (const call of callsToShow) {
          // Only show calls between known participants
          if (!participants.includes(call.caller) || !participants.includes(call.callee)) continue;

          const fromAlias = sanitizeParticipant(call.caller);
          const toAlias = sanitizeParticipant(call.callee);

          // Add file context as a note when file changes
          const shortFile = call.file.split("/").slice(-2).join("/");
          if (shortFile !== currentFile) {
            currentFile = shortFile;
            lines.push(`    Note over ${fromAlias}: ${shortFile.replace(/[<>]/g, "")}`);
          }

          lines.push(`    ${fromAlias}->>+${toAlias}: call`);
          lines.push(`    ${toAlias}-->>-${fromAlias}: return`);
        }

        if (callsToShow.length === 0) {
          lines.push("    Note over " + sanitizeParticipant(focusFunctions[0] || "fn") + ": No calls found");
        }

        mermaid = lines.join("\n");
      } else {
        // ===== FLOWCHART DIAGRAM =====
        const lines: string[] = ["flowchart TD"];

        // Categorize nodes
        const entryPoints = new Set<string>(); // called but don't call much
        const hotspots = new Set<string>(); // highly connected

        for (const fn of nodesToShow) {
          const callerCount = callersOf.get(fn)?.size || 0;
          const calleeCount = calleesOf.get(fn)?.size || 0;

          if (callerCount === 0 && calleeCount > 0) {
            entryPoints.add(fn);
          } else if (callerCount + calleeCount > 10) {
            hotspots.add(fn);
          }
        }

        // Add nodes with styling
        for (const fn of nodesToShow) {
          const fnLabel = sanitizeLabel(fn);
          const nodeId = sanitize("fn_" + fn);
          const callCount = callCounts.get(fn) || 0;

          if (focusFunctions.includes(fn)) {
            lines.push(`    ${nodeId}[["🎯 ${fnLabel}"]]`);
          } else if (entryPoints.has(fn)) {
            lines.push(`    ${nodeId}(["▶️ ${fnLabel}"])`);
          } else if (hotspots.has(fn)) {
            lines.push(`    ${nodeId}[("🔥 ${fnLabel}<br/>${callCount} calls")]`);
          } else if (fn === "<top-level>") {
            lines.push(`    ${nodeId}["📄 module top-level"]`);
          } else {
            lines.push(`    ${nodeId}["${fnLabel}"]`);
          }
        }

        lines.push("");

        // Add edges
        for (const edge of edgesToShow) {
          const [from, to] = edge.split("|||");
          const fromId = sanitize("fn_" + from);
          const toId = sanitize("fn_" + to);
          lines.push(`    ${fromId} --> ${toId}`);
        }

        if (edgesToShow.size === 0) {
          lines.push('    note["No call relationships found for selected functions"]');
        }

        mermaid = lines.join("\n");
      }

      // Compute stats
      const uniqueCallers = new Set<string>();
      const uniqueCallees = new Set<string>();
      for (const call of calls) {
        uniqueCallers.add(call.caller);
        uniqueCallees.add(call.callee);
      }

      return safeJson({
        repo,
        ref: latest.ref,
        format,
        mermaid,
        stats: {
          totalCalls: calls.length,
          uniqueCallers: uniqueCallers.size,
          uniqueCallees: uniqueCallees.size,
          nodesShown: nodesToShow.size,
          edgesShown: edgesToShow.size,
        },
        focus: focusFunctions,
        topCalledFunctions: [...callCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([fn, count]) => ({ function: fn, callCount: count })),
        hint: `Display 'mermaid' in a \`\`\`mermaid block. Use format:'sequence' for temporal view, 'function' to focus.`,
      });
    },
  },
  {
    name: "generate_impact_tree",
    description: `Analyze blast radius: what user journeys break if a service/function fails?

Traces dependencies from external services UP to screens/pages to show:
- Which services are critical (most dependents)
- Which screens are affected if a service is down
- Single points of failure

Great for:
- Incident response planning ("if X breaks, what's affected?")
- Prioritizing reliability work
- Understanding system coupling

OPTIONS:
- repo: Required. Repository to analyze
- service: Optional. Focus on a specific service/function
- format: 'tree' | 'table' | 'mermaid' (default: 'tree')

Returns impact tree showing: Service → Functions → Screens → User Impact`,
    schema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Repository to analyze (required)",
        },
        service: {
          type: "string",
          description: "Focus on a specific service (e.g., 'nostr', 'fetch', 'database')",
        },
        format: {
          type: "string",
          enum: ["tree", "table", "mermaid"],
          description: "Output format. Default: tree",
        },
      },
      required: ["repo"],
    },
    handler: async (args) => {
      const repo = args.repo as string;
      const focusService = args.service as string | undefined;
      const format = (args.format as "tree" | "table" | "mermaid") || "tree";

      const s = await getStore();
      const versions = await s.listVersions(repo);
      if (versions.length === 0) {
        return safeJson({ error: `No data for repo '${repo}'` });
      }

      const latest = versions[0];
      const data = (await s.loadExtractor(
        repo,
        latest.refType as "branch" | "tag",
        latest.ref,
        "type_definitions"
      )) as TypeDefinitionsResult | null;

      if (!data || !data.calls || data.calls.length === 0) {
        return safeJson({
          error: `No call data for '${repo}'. Only TypeScript repos with the AST parser have call extraction.`,
        });
      }

      interface CallEdge {
        caller: string;
        callee: string;
        file: string;
        line: number;
      }

      const calls = data.calls as CallEdge[];

      // Build reverse call graph (callee -> callers)
      const callersOf = new Map<string, Set<string>>();
      const fileOf = new Map<string, string>(); // function -> file

      for (const call of calls) {
        if (!callersOf.has(call.callee)) callersOf.set(call.callee, new Set());
        callersOf.get(call.callee)!.add(call.caller);
        fileOf.set(call.caller, call.file);
      }

      // Identify external services (likely failure points)
      const externalPatterns = [
        /fetch$/i,
        /query$/i,
        /request$/i,
        /api\./i,
        /client\./i,
        /service\./i,
        /database\./i,
        /db\./i,
        /redis\./i,
        /nostr\./i,
        /relay\./i,
        /socket\./i,
        /http\./i,
        /axios/i,
        /supabase/i,
        /prisma/i,
        /firebase/i,
      ];

      const isExternalService = (name: string): boolean => {
        return externalPatterns.some(p => p.test(name));
      };

      // Identify screens/pages (user-facing)
      const isScreen = (file: string): boolean => {
        return file.includes("/pages/") || 
               file.includes("/screens/") || 
               file.includes("/views/") ||
               file.includes("/routes/") ||
               file.endsWith("Page.tsx") ||
               file.endsWith("Screen.tsx") ||
               file.endsWith("View.tsx");
      };

      // Find all external services in the codebase
      const externalServices = new Set<string>();
      for (const call of calls) {
        if (isExternalService(call.callee)) {
          externalServices.add(call.callee);
        }
      }

      // Filter if focus service specified
      let servicesToAnalyze = [...externalServices];
      if (focusService) {
        const lower = focusService.toLowerCase();
        servicesToAnalyze = servicesToAnalyze.filter(s => s.toLowerCase().includes(lower));
        if (servicesToAnalyze.length === 0) {
          return safeJson({
            error: `No services matching '${focusService}' found`,
            availableServices: [...externalServices].slice(0, 20),
          });
        }
      }

      // For each service, trace UP to find affected screens
      interface ImpactNode {
        service: string;
        directCallers: string[];
        affectedScreens: Array<{
          screen: string;
          file: string;
          path: string[]; // call chain from service to screen
        }>;
        totalDependents: number;
      }

      const impacts: ImpactNode[] = [];

      for (const service of servicesToAnalyze.slice(0, 20)) {
        const directCallers = [...(callersOf.get(service) || [])];
        const affectedScreens: ImpactNode["affectedScreens"] = [];
        const visited = new Set<string>();
        const totalDependents = new Set<string>();

        // BFS to find all paths to screens
        const queue: Array<{ fn: string; path: string[] }> = directCallers.map(c => ({
          fn: c,
          path: [service, c],
        }));

        while (queue.length > 0 && affectedScreens.length < 10) {
          const { fn, path } = queue.shift()!;
          if (visited.has(fn)) continue;
          visited.add(fn);
          totalDependents.add(fn);

          const file = fileOf.get(fn) || "";

          // Check if this is a screen
          if (isScreen(file)) {
            affectedScreens.push({
              screen: fn,
              file,
              path,
            });
          }

          // Continue tracing up
          const callers = callersOf.get(fn);
          if (callers && path.length < 6) { // limit depth
            for (const caller of callers) {
              if (!visited.has(caller)) {
                queue.push({ fn: caller, path: [...path, caller] });
              }
            }
          }
        }

        if (directCallers.length > 0 || affectedScreens.length > 0) {
          impacts.push({
            service,
            directCallers: directCallers.slice(0, 10),
            affectedScreens,
            totalDependents: totalDependents.size,
          });
        }
      }

      // Sort by impact (most dependents first)
      impacts.sort((a, b) => b.totalDependents - a.totalDependents);

      // Generate output based on format
      let output: string;

      if (format === "mermaid") {
        const lines: string[] = ["flowchart BT"]; // Bottom-to-top for impact tree

        lines.push('    subgraph Services["🔌 External Services"]');
        for (const impact of impacts.slice(0, 8)) {
          const id = sanitize("svc_" + impact.service);
          lines.push(`        ${id}[("${sanitizeLabel(impact.service)}")]`);
        }
        lines.push("    end");
        lines.push("");

        // Collect screens
        const screens = new Set<string>();
        for (const impact of impacts) {
          for (const s of impact.affectedScreens) {
            screens.add(s.screen);
          }
        }

        if (screens.size > 0) {
          lines.push('    subgraph Screens["📱 User Screens"]');
          for (const screen of [...screens].slice(0, 10)) {
            const id = sanitize("scr_" + screen);
            lines.push(`        ${id}["${sanitizeLabel(screen)}"]`);
          }
          lines.push("    end");
          lines.push("");
        }

        // Add edges (service -> screen via intermediates)
        for (const impact of impacts.slice(0, 8)) {
          const svcId = sanitize("svc_" + impact.service);
          for (const affected of impact.affectedScreens.slice(0, 3)) {
            const scrId = sanitize("scr_" + affected.screen);
            lines.push(`    ${svcId} -.->|"breaks"| ${scrId}`);
          }
        }

        output = lines.join("\n");
      } else if (format === "table") {
        const rows: string[] = ["| Service | Dependents | Affected Screens | Risk |"];
        rows.push("|---------|------------|------------------|------|");
        for (const impact of impacts.slice(0, 15)) {
          const risk = impact.affectedScreens.length >= 3 ? "🔴 HIGH" :
                       impact.affectedScreens.length >= 1 ? "🟡 MED" : "🟢 LOW";
          const screens = impact.affectedScreens.map(s => s.screen).slice(0, 3).join(", ");
          rows.push(`| ${impact.service} | ${impact.totalDependents} | ${screens || "none"} | ${risk} |`);
        }
        output = rows.join("\n");
      } else {
        // Tree format
        const lines: string[] = ["# Impact Analysis\n"];
        for (const impact of impacts.slice(0, 10)) {
          const risk = impact.affectedScreens.length >= 3 ? "🔴" :
                       impact.affectedScreens.length >= 1 ? "🟡" : "🟢";
          lines.push(`${risk} **${impact.service}** (${impact.totalDependents} dependents)`);
          
          if (impact.affectedScreens.length > 0) {
            lines.push("  └── Affected screens:");
            for (const s of impact.affectedScreens.slice(0, 5)) {
              const path = s.path.slice(1).join(" → ");
              lines.push(`      └── 📱 ${s.screen}`);
              lines.push(`          via: ${path}`);
            }
          } else {
            lines.push("  └── (no direct screen impact found)");
          }
          lines.push("");
        }
        output = lines.join("\n");
      }

      return safeJson({
        repo,
        ref: latest.ref,
        format,
        output,
        summary: {
          totalExternalServices: externalServices.size,
          servicesAnalyzed: impacts.length,
          highRiskServices: impacts.filter(i => i.affectedScreens.length >= 3).length,
          mediumRiskServices: impacts.filter(i => i.affectedScreens.length >= 1 && i.affectedScreens.length < 3).length,
        },
        impacts: impacts.slice(0, 10).map(i => ({
          service: i.service,
          totalDependents: i.totalDependents,
          affectedScreens: i.affectedScreens.map(s => s.screen),
          riskLevel: i.affectedScreens.length >= 3 ? "high" : i.affectedScreens.length >= 1 ? "medium" : "low",
        })),
        hint: format === "mermaid" 
          ? "Display 'output' in a ```mermaid block"
          : "Use format:'mermaid' for visual diagram, format:'table' for summary",
      });
    },
  },
  {
    name: "ecosystem_impact",
    description: `Cross-repo blast radius analysis: what happens if a repo/service goes down?

Analyzes dependencies BETWEEN repos to show:
- Which repos depend on which services
- If repo X fails, what other repos are affected?
- Critical paths through the system

Shows ALL service layers:
- Edge services (Cloudflare Workers)
- Backend services (Kubernetes deployments)  
- Internal services (modules/components)

OPTIONS:
- repo: Focus on impact if THIS repo goes down
- format: 'tree' | 'mermaid' (default: 'mermaid')

Example: "If divine-relay goes down, divine-web and divine-mobile break"`,
    schema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Focus on what breaks if this repo goes down",
        },
        format: {
          type: "string",
          enum: ["tree", "mermaid"],
          description: "Output format. Default: mermaid",
        },
      },
    },
    handler: async (args) => {
      const focusRepo = args.repo as string | undefined;
      const format = (args.format as "tree" | "mermaid") || "mermaid";

      // Load all data sources
      const allDataFlow = await loadFromAllRepos("data_flow") as Record<string, { 
        services?: Array<{ name: string; file: string; type?: string }>;
        externalCalls?: Array<{ target: string; file: string }>;
      }>;
      
      const allCfWorkers = await loadFromAllRepos("cloudflare_workers") as Record<string, {
        name?: string;
        routes?: Array<{ pattern: string }>;
        endpoints?: Array<{ method: string; path: string }>;
      }>;

      const allK8s = await loadFromAllRepos("kubernetes") as Record<string, {
        resources?: Array<{ 
          kind: string; 
          name: string; 
          file: string;
          labels?: Record<string, string>;
          annotations?: Record<string, string>;
        }>;
        deployments?: Array<{
          name: string;
          namespace: string;
          image: string;
          sourceRepo?: string;
        }>;
        kustomizeImages?: Array<{
          name: string;
          newName?: string;
          newTag?: string;
        }>;
        imageToRepo?: Record<string, string>;
      }>;

      const allTypeData = await loadFromAllRepos("type_definitions") as Record<string, TypeDefinitionsResult>;

      // Track services by layer
      interface ServiceInfo {
        name: string;
        layer: "edge" | "backend" | "internal";
        repo: string;
        routes?: string[];
        image?: string;
      }
      
      const allServices: ServiceInfo[] = [];
      const serviceProviders = new Map<string, string>(); // domain/service pattern -> repo
      const repoServices = new Map<string, ServiceInfo[]>(); // repo -> all its services

      // 1. Edge layer: Cloudflare Workers
      for (const [repo, data] of Object.entries(allCfWorkers)) {
        if (!data?.routes) continue;
        const routes = data.routes.map(r => r.pattern);
        for (const route of data.routes) {
          const domain = route.pattern.split("/")[0].replace("*", "");
          serviceProviders.set(domain, repo);
        }
        const svc: ServiceInfo = {
          name: data.name || repo,
          layer: "edge",
          repo,
          routes,
        };
        allServices.push(svc);
        if (!repoServices.has(repo)) repoServices.set(repo, []);
        repoServices.get(repo)!.push(svc);
      }

      // 2. Backend layer: Kubernetes deployments/services
      // Build image->repo mapping from all K8s data
      const imageToRepoMap = new Map<string, string>();
      for (const [_repo, data] of Object.entries(allK8s)) {
        if (data?.imageToRepo) {
          for (const [img, repoName] of Object.entries(data.imageToRepo)) {
            imageToRepoMap.set(img, repoName);
          }
        }
        // Also build from kustomize images
        if (data?.kustomizeImages) {
          for (const img of data.kustomizeImages) {
            if (img.newName) {
              // Extract repo name from full image path
              const parts = img.newName.split("/");
              const imageName = parts[parts.length - 1].split(":")[0];
              imageToRepoMap.set(img.name, imageName);
              imageToRepoMap.set(imageName, imageName);
            }
          }
        }
      }

      for (const [iacRepo, data] of Object.entries(allK8s)) {
        // Use deployments array which has more detail including sourceRepo
        if (data?.deployments?.length) {
          for (const dep of data.deployments) {
            // Use sourceRepo if available, otherwise try image mapping, otherwise infer from name
            let targetRepo = dep.sourceRepo;
            if (!targetRepo && dep.image && dep.image !== "unknown") {
              const parts = dep.image.split("/");
              const imageName = parts[parts.length - 1].split(":")[0];
              targetRepo = imageToRepoMap.get(imageName) || imageName;
            }
            if (!targetRepo) {
              // Infer from deployment name
              targetRepo = dep.name
                .replace(/-api$/, "")
                .replace(/-relay$/, "")
                .replace(/-worker$/, "")
                .replace(/-service$/, "");
            }

            // Try to find actual repo that matches
            const matchingRepo = [...Object.keys(allDataFlow), ...Object.keys(allTypeData)]
              .find(r => 
                r === targetRepo ||
                r === `divine-${targetRepo}` ||
                r.includes(targetRepo) ||
                targetRepo.includes(r.replace("divine-", ""))
              );

            const finalRepo = matchingRepo || targetRepo;
            
            const svc: ServiceInfo = {
              name: dep.name,
              layer: "backend",
              repo: finalRepo,
              image: dep.image !== "unknown" ? dep.image : undefined,
            };
            allServices.push(svc);
            
            // Register backend services as providers
            serviceProviders.set(dep.name, finalRepo);
            
            if (!repoServices.has(finalRepo)) repoServices.set(finalRepo, []);
            // Avoid duplicates
            if (!repoServices.get(finalRepo)!.some(s => s.name === dep.name)) {
              repoServices.get(finalRepo)!.push(svc);
            }
          }
        } else if (data?.resources) {
          // Fallback to resources if no deployments array
          const deployments = data.resources.filter(r => 
            r.kind === "Deployment" || r.kind === "Service" || r.kind === "HTTPRoute"
          );
          
          const appNames = new Set<string>();
          for (const r of deployments) {
            const appName = r.labels?.["app"] || r.labels?.["app.kubernetes.io/name"] || r.name;
            appNames.add(appName);
          }
          
          for (const appName of appNames) {
            const matchingRepo = [...Object.keys(allDataFlow), ...Object.keys(allTypeData)]
              .find(r => appName.includes(r.replace("divine-", "")) || r.includes(appName.replace("-api", "").replace("-relay", "")));
            
            const svc: ServiceInfo = {
              name: appName,
              layer: "backend",
              repo: matchingRepo || iacRepo,
            };
            allServices.push(svc);
            
            serviceProviders.set(appName, matchingRepo || iacRepo);
            
            const targetRepo = matchingRepo || iacRepo;
            if (!repoServices.has(targetRepo)) repoServices.set(targetRepo, []);
            if (!repoServices.get(targetRepo)!.some(s => s.name === appName)) {
              repoServices.get(targetRepo)!.push(svc);
            }
          }
        }
      }

      // 3. Internal layer: data_flow services (modules/components)
      for (const [repo, data] of Object.entries(allDataFlow)) {
        if (!data?.services?.length) continue;
        
        for (const svcData of data.services) {
          const svc: ServiceInfo = {
            name: svcData.name,
            layer: "internal",
            repo,
          };
          allServices.push(svc);
          if (!repoServices.has(repo)) repoServices.set(repo, []);
          repoServices.get(repo)!.push(svc);
        }
      }

      // Build dependency graph: repo -> [repos it depends on]
      const dependsOn = new Map<string, Set<string>>(); // repo -> set of repos it calls
      const dependedBy = new Map<string, Set<string>>(); // repo -> set of repos that call it

      // Process data_flow external calls
      for (const [repo, data] of Object.entries(allDataFlow)) {
        if (!data?.externalCalls) continue;
        
        for (const call of data.externalCalls) {
          try {
            const url = new URL(call.target.split("\n")[0].trim());
            const hostname = url.hostname;
            
            // Skip test URLs
            if (hostname.includes("example.com") || hostname.includes("test.com") || hostname.includes("localhost")) {
              continue;
            }
            
            // Find which repo provides this service
            for (const [pattern, providerRepo] of serviceProviders) {
              if (hostname.includes(pattern.replace("*", "")) || pattern.includes(hostname)) {
                if (providerRepo !== repo) { // Don't count self-dependencies
                  if (!dependsOn.has(repo)) dependsOn.set(repo, new Set());
                  dependsOn.get(repo)!.add(providerRepo);
                  
                  if (!dependedBy.has(providerRepo)) dependedBy.set(providerRepo, new Set());
                  dependedBy.get(providerRepo)!.add(repo);
                }
              }
            }
          } catch {
            // Skip invalid URLs
          }
        }
      }

      // Check call data from type_definitions for additional patterns
      interface CallEdge { caller: string; callee: string; file: string; line: number; }
      
      const apiPatterns = ['api.', 'client.', 'service.', 'http.', 'axios', 'nostr.', 'fetch'];
      for (const [repo, data] of Object.entries(allTypeData)) {
        if (!data?.calls?.length) continue;
        const calls = data.calls as CallEdge[];
        
        for (const call of calls) {
          const callee = call.callee.toLowerCase();
          if (apiPatterns.some(p => callee.includes(p))) {
            // This repo uses API clients - it's a consumer
            if (!dependsOn.has(repo)) dependsOn.set(repo, new Set());
            break; // Only need to mark once
          }
        }
      }
      
      // Group types by normalized name across repos for shared type detection
      const sharedTypes = new Map<string, string[]>(); // type name -> repos that have it
      for (const [repo, data] of Object.entries(allTypeData)) {
        if (!data?.types) continue;
        for (const type of data.types) {
          const normalized = type.name.toLowerCase();
          if (!sharedTypes.has(normalized)) sharedTypes.set(normalized, []);
          const repos = sharedTypes.get(normalized)!;
          if (!repos.includes(repo)) repos.push(repo);
        }
      }

      // Types shared by 2+ repos indicate data contracts (implicit dependencies)
      const typeContracts: Array<{ type: string; repos: string[] }> = [];
      for (const [typeName, repos] of sharedTypes) {
        if (repos.length >= 2) {
          typeContracts.push({ type: typeName, repos });
        }
      }

      // Calculate impact scores
      interface RepoImpact {
        repo: string;
        services: ServiceInfo[];
        dependedByRepos: string[];
        dependsOnRepos: string[];
        sharedTypes: string[];
        impactScore: number;
      }

      const impacts: RepoImpact[] = [];
      
      // Include ALL repos that have any services or dependencies
      const allRepos = new Set([
        ...dependsOn.keys(), 
        ...dependedBy.keys(), 
        ...repoServices.keys(),
        ...Object.keys(allDataFlow),
        ...Object.keys(allTypeData),
      ]);

      for (const repo of allRepos) {
        const dependedByRepos = [...(dependedBy.get(repo) || [])];
        const dependsOnRepos = [...(dependsOn.get(repo) || [])];
        const services = repoServices.get(repo) || [];
        const typesShared = typeContracts
          .filter(tc => tc.repos.includes(repo))
          .map(tc => tc.type)
          .slice(0, 5);
        
        // Impact score = services provided + repos depending on this + shared types
        const impactScore = services.length * 5 + dependedByRepos.length * 10 + typesShared.length;

        impacts.push({
          repo,
          services,
          dependedByRepos,
          dependsOnRepos,
          sharedTypes: typesShared,
          impactScore,
        });
      }

      // Sort by impact
      impacts.sort((a, b) => b.impactScore - a.impactScore);

      // Filter if focus repo specified
      let focusedImpacts = impacts;
      if (focusRepo) {
        const focus = impacts.find(i => i.repo === focusRepo);
        if (!focus) {
          return safeJson({
            error: `Repo '${focusRepo}' not found or has no services/dependencies`,
            availableRepos: impacts.map(i => i.repo),
          });
        }
        // Show the focus repo and everything that depends on it
        focusedImpacts = [focus, ...impacts.filter(i => i.dependsOnRepos.includes(focusRepo))];
      }

      // Generate output
      let output: string;

      if (format === "mermaid") {
        const lines: string[] = ["flowchart TD"];
        
        // Style definitions for different layers
        lines.push("    classDef edge fill:#f472b6,stroke:#db2777");
        lines.push("    classDef backend fill:#4ade80,stroke:#16a34a");
        lines.push("    classDef internal fill:#60a5fa,stroke:#2563eb");
        lines.push("    classDef consumer fill:#a78bfa,stroke:#7c3aed");
        lines.push("    classDef critical fill:#f87171,stroke:#dc2626");
        lines.push("");

        // Group services by layer
        const edgeServices = impacts.filter(i => i.services.some(s => s.layer === "edge"));
        const backendServices = impacts.filter(i => i.services.some(s => s.layer === "backend") && !edgeServices.includes(i));
        const internalOnly = impacts.filter(i => i.services.length > 0 && !edgeServices.includes(i) && !backendServices.includes(i));
        const consumersOnly = impacts.filter(i => i.services.length === 0 && i.dependsOnRepos.length > 0);
        const standalone = impacts.filter(i => i.services.length === 0 && i.dependsOnRepos.length === 0 && i.dependedByRepos.length === 0);

        // Edge layer (Cloudflare Workers)
        if (edgeServices.length > 0) {
          lines.push('    subgraph Edge["☁️ Edge Layer (Cloudflare Workers)"]');
          for (const p of edgeServices.slice(0, 8)) {
            const id = sanitize(p.repo);
            const edgeSvcs = p.services.filter(s => s.layer === "edge");
            const routes = edgeSvcs.flatMap(s => s.routes || []).slice(0, 2).map(r => r.split("/")[0]).join(", ");
            const label = sanitizeLabel(p.repo);
            const critical = p.dependedByRepos.length >= 2 ? "🔴 " : "";
            lines.push(`        ${id}["${critical}${label}<br/>${routes}"]`);
          }
          lines.push("    end");
          lines.push("");
        }

        // Backend layer (K8s)
        if (backendServices.length > 0) {
          lines.push('    subgraph Backend["⚙️ Backend Layer (Kubernetes)"]');
          for (const p of backendServices.slice(0, 8)) {
            const id = sanitize(p.repo);
            const backendSvcs = p.services.filter(s => s.layer === "backend");
            const svcNames = backendSvcs.map(s => s.name).slice(0, 2).join(", ");
            const label = sanitizeLabel(p.repo);
            const critical = p.dependedByRepos.length >= 1 ? "🟡 " : "";
            lines.push(`        ${id}["${critical}${label}<br/>${svcNames}"]`);
          }
          lines.push("    end");
          lines.push("");
        }

        // Internal services layer
        if (internalOnly.length > 0) {
          lines.push('    subgraph Internal["📦 Internal Services"]');
          for (const p of internalOnly.slice(0, 8)) {
            const id = sanitize(p.repo);
            const internalSvcs = p.services.filter(s => s.layer === "internal");
            const svcCount = `${internalSvcs.length} modules`;
            const label = sanitizeLabel(p.repo);
            lines.push(`        ${id}["${label}<br/>${svcCount}"]`);
          }
          lines.push("    end");
          lines.push("");
        }

        // Consumers
        if (consumersOnly.length > 0) {
          lines.push('    subgraph Consumers["📱 Clients"]');
          for (const c of consumersOnly.slice(0, 8)) {
            const id = sanitize(c.repo);
            const label = sanitizeLabel(c.repo);
            lines.push(`        ${id}["${label}"]`);
          }
          lines.push("    end");
          lines.push("");
        }

        // Standalone repos (have data but no explicit dependencies)
        if (standalone.length > 0) {
          lines.push('    subgraph Standalone["📂 Other Repos"]');
          for (const s of standalone.slice(0, 6)) {
            const id = sanitize(s.repo);
            const label = sanitizeLabel(s.repo);
            lines.push(`        ${id}["${label}"]`);
          }
          lines.push("    end");
          lines.push("");
        }

        // Add dependency edges
        for (const impact of impacts) {
          const fromId = sanitize(impact.repo);
          for (const dep of impact.dependsOnRepos) {
            const toId = sanitize(dep);
            lines.push(`    ${fromId} -->|"depends on"| ${toId}`);
          }
        }

        // Apply layer styling
        for (const p of edgeServices) {
          lines.push(`    ${sanitize(p.repo)}:::edge`);
        }
        for (const p of backendServices) {
          lines.push(`    ${sanitize(p.repo)}:::backend`);
        }
        for (const p of internalOnly) {
          lines.push(`    ${sanitize(p.repo)}:::internal`);
        }
        for (const c of consumersOnly) {
          lines.push(`    ${sanitize(c.repo)}:::consumer`);
        }

        // Highlight critical path if focus repo
        if (focusRepo) {
          const focusId = sanitize(focusRepo);
          lines.push("");
          lines.push(`    ${focusId}:::critical`);
        }

        output = lines.join("\n");
      } else {
        // Tree format
        const lines: string[] = ["# Ecosystem Impact Analysis\n"];
        lines.push(`**${impacts.length} repos analyzed**\n`);
        
        if (focusRepo) {
          const focus = impacts.find(i => i.repo === focusRepo);
          if (focus) {
            lines.push(`## If **${focusRepo}** goes down:\n`);
            lines.push(`🔴 **Direct Impact:**`);
            for (const dep of focus.dependedByRepos) {
              lines.push(`  └── ${dep} would break`);
            }
            if (focus.dependedByRepos.length === 0) {
              lines.push(`  └── No known dependents`);
            }
            lines.push("");
            lines.push(`📋 **Services provided:**`);
            for (const svc of focus.services.slice(0, 10)) {
              const layerIcon = svc.layer === "edge" ? "☁️" : svc.layer === "backend" ? "⚙️" : "📦";
              lines.push(`  └── ${layerIcon} ${svc.name} (${svc.layer})`);
            }
            if (focus.services.length === 0) {
              lines.push(`  └── No explicit services defined`);
            }
          }
        } else {
          // Group by layer
          const edgeServices = impacts.filter(i => i.services.some(s => s.layer === "edge"));
          const backendServices = impacts.filter(i => i.services.some(s => s.layer === "backend"));
          const internalServices = impacts.filter(i => i.services.some(s => s.layer === "internal"));
          const consumersOnly = impacts.filter(i => i.services.length === 0);

          if (edgeServices.length > 0) {
            lines.push("## ☁️ Edge Layer (Cloudflare Workers)\n");
            for (const impact of edgeServices.slice(0, 8)) {
              const risk = impact.dependedByRepos.length >= 2 ? "🔴" : 
                          impact.dependedByRepos.length >= 1 ? "🟡" : "🟢";
              const edgeSvcs = impact.services.filter(s => s.layer === "edge");
              const routes = edgeSvcs.flatMap(s => s.routes || []).slice(0, 3).join(", ");
              lines.push(`${risk} **${impact.repo}** (${impact.dependedByRepos.length} dependents)`);
              lines.push(`  └── Routes: ${routes || "none"}`);
              if (impact.dependedByRepos.length > 0) {
                lines.push(`  └── Used by: ${impact.dependedByRepos.join(", ")}`);
              }
              lines.push("");
            }
          }

          if (backendServices.length > 0) {
            lines.push("## ⚙️ Backend Layer (Kubernetes)\n");
            for (const impact of backendServices.slice(0, 8)) {
              const backendSvcs = impact.services.filter(s => s.layer === "backend");
              const svcNames = backendSvcs.map(s => s.name).join(", ");
              lines.push(`**${impact.repo}**`);
              lines.push(`  └── Services: ${svcNames}`);
              lines.push("");
            }
          }

          if (internalServices.length > 0) {
            lines.push("## 📦 Internal Services\n");
            for (const impact of internalServices.slice(0, 8)) {
              const internalSvcs = impact.services.filter(s => s.layer === "internal");
              lines.push(`**${impact.repo}** (${internalSvcs.length} modules)`);
              lines.push(`  └── ${internalSvcs.slice(0, 5).map(s => s.name).join(", ")}`);
              lines.push("");
            }
          }

          if (consumersOnly.length > 0) {
            lines.push("## 📱 Clients / Consumers\n");
            for (const impact of consumersOnly.slice(0, 8)) {
              lines.push(`**${impact.repo}**`);
              if (impact.dependsOnRepos.length > 0) {
                lines.push(`  └── Depends on: ${impact.dependsOnRepos.join(", ")}`);
              } else {
                lines.push(`  └── No tracked dependencies`);
              }
              lines.push("");
            }
          }
        }
        
        output = lines.join("\n");
      }

      // Build summary with layer breakdown
      const edgeCount = impacts.filter(i => i.services.some(s => s.layer === "edge")).length;
      const backendCount = impacts.filter(i => i.services.some(s => s.layer === "backend")).length;
      const internalCount = impacts.filter(i => i.services.some(s => s.layer === "internal")).length;

      return safeJson({
        format,
        output,
        summary: {
          totalReposAnalyzed: allRepos.size,
          layers: {
            edge: edgeCount,
            backend: backendCount,
            internal: internalCount,
          },
          totalServices: allServices.length,
          crossRepoDependencies: [...dependsOn.values()].reduce((sum, s) => sum + s.size, 0),
          sharedTypeContracts: typeContracts.length,
        },
        criticalRepos: impacts
          .filter(i => i.services.length > 0 || i.dependedByRepos.length >= 1)
          .slice(0, 10)
          .map(i => ({
            repo: i.repo,
            services: i.services.slice(0, 3).map(s => ({ name: s.name, layer: s.layer })),
            dependedBy: i.dependedByRepos,
          })),
        hint: format === "mermaid"
          ? "Display 'output' in a ```mermaid block. Use repo:'name' to focus on specific service."
          : "Use format:'mermaid' for visual diagram",
      });
    },
  },
];

