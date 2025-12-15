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
];

