/**
 * Type Definitions Extractor
 *
 * Extracts data structures, interfaces, enums, and type definitions across
 * multiple programming languages. Designed for:
 *
 * - Cross-repo type mapping and comparison
 * - Diagram generation (ER diagrams, class diagrams, dependency graphs)
 * - Data flow analysis (tracking type usage across services)
 * - API contract validation
 */

import type { Extractor, ExtractionContext, ExtractionResult } from "../../lib/extractor-base.js";
import { registerExtractor } from "../../lib/extractor-base.js";
import type {
  TypeDefinition,
  TypeRelationship,
  TypeModule,
  TypeDefinitionsResult,
  RelationshipKind,
  CallDefinition,
  EventType,
} from "./schema.js";
import { getParserForFile, supportedExtensions, parseZodSchemas, parseORMModels } from "./parsers/index.js";

// =============================================================================
// Configuration
// =============================================================================

interface TypeExtractorConfig {
  /** Glob patterns to ignore */
  ignore?: string[];
  /** Maximum number of files to process */
  limit?: number;
  /** Include private/internal types */
  includePrivate?: boolean;
  /** Directories to prioritize (processed first) */
  prioritize?: string[];
}

// =============================================================================
// Relationship Analysis
// =============================================================================

/**
 * Build relationships between types based on field types and inheritance
 */
function buildRelationships(types: TypeDefinition[]): TypeRelationship[] {
  const relationships: TypeRelationship[] = [];
  const typeNames = new Set(types.map((t) => t.name));

  for (const type of types) {
    // Inheritance relationships
    if (type.extends) {
      for (const parent of type.extends) {
        relationships.push({
          from: type.name,
          to: parent.name,
          kind: "extends",
          file: type.file,
        });
      }
    }

    // Implementation relationships
    if (type.implements) {
      for (const iface of type.implements) {
        relationships.push({
          from: type.name,
          to: iface.name,
          kind: "implements",
          file: type.file,
        });
      }
    }

    // Field relationships
    if (type.fields) {
      for (const field of type.fields) {
        const targetName = field.typeRef.name;

        // Only track relationships to known types
        if (typeNames.has(targetName)) {
          const kind: RelationshipKind = field.typeRef.isCollection
            ? "collection"
            : "contains";

          relationships.push({
            from: type.name,
            to: targetName,
            kind,
            viaField: field.name,
            file: type.file,
          });
        }

        // Also check generics
        if (field.typeRef.generics) {
          for (const generic of field.typeRef.generics) {
            if (typeNames.has(generic.name)) {
              relationships.push({
                from: type.name,
                to: generic.name,
                kind: "references",
                viaField: field.name,
                file: type.file,
              });
            }
          }
        }
      }
    }

    // Enum variant field relationships
    if (type.variants) {
      for (const variant of type.variants) {
        if (variant.fields) {
          for (const field of variant.fields) {
            if (typeNames.has(field.typeRef.name)) {
              relationships.push({
                from: type.name,
                to: field.typeRef.name,
                kind: "contains",
                viaField: `${variant.name}.${field.name}`,
                file: type.file,
              });
            }
          }
        }
      }
    }
  }

  return relationships;
}

/**
 * Group types into modules based on directory structure
 */
function buildModules(
  types: TypeDefinition[],
  relationships: TypeRelationship[]
): TypeModule[] {
  // Group by directory
  const byDir = new Map<string, TypeDefinition[]>();

  for (const type of types) {
    const parts = type.file.split("/");
    const dir = parts.slice(0, -1).join("/") || "/";

    if (!byDir.has(dir)) {
      byDir.set(dir, []);
    }
    byDir.get(dir)!.push(type);
  }

  const modules: TypeModule[] = [];

  for (const [path, moduleTypes] of byDir) {
    const typeNamesInModule = new Set(moduleTypes.map((t) => t.name));

    // Partition relationships
    const internalRelationships: TypeRelationship[] = [];
    const externalRelationships: TypeRelationship[] = [];

    for (const rel of relationships) {
      if (typeNamesInModule.has(rel.from)) {
        if (typeNamesInModule.has(rel.to)) {
          internalRelationships.push(rel);
        } else {
          externalRelationships.push(rel);
        }
      }
    }

    modules.push({
      path,
      types: moduleTypes,
      internalRelationships,
      externalRelationships,
    });
  }

  return modules.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Build summary statistics
 */
function buildSummary(
  types: TypeDefinition[],
  relationships: TypeRelationship[],
  modules: TypeModule[]
): TypeDefinitionsResult["summary"] {
  const byKind: Record<string, number> = {};
  const byLanguage: Record<string, number> = {};
  const byModule: Record<string, number> = {};

  for (const type of types) {
    byKind[type.kind] = (byKind[type.kind] || 0) + 1;
    byLanguage[type.language] = (byLanguage[type.language] || 0) + 1;
  }

  for (const mod of modules) {
    byModule[mod.path] = mod.types.length;
  }

  return {
    byKind,
    byLanguage,
    byModule,
    totalTypes: types.length,
    totalRelationships: relationships.length,
  };
}

// =============================================================================
// Extractor Implementation
// =============================================================================

const typeDefinitionsExtractor: Extractor = {
  name: "type_definitions",
  description: "Extract data structures, interfaces, enums, and type definitions across languages",

  async canExtract(ctx: ExtractionContext): Promise<boolean> {
    const files = await ctx.gitManager.listFilesAtRef(ctx.repoPath, ctx.ref);
    const extensions = supportedExtensions();
    return files.some((f) => extensions.some((ext) => f.endsWith(ext)));
  },

  async extract(ctx: ExtractionContext): Promise<ExtractionResult> {
    const config = ctx.config as TypeExtractorConfig;
    const ignore = config.ignore || [];
    const limit = config.limit || 300;
    const includePrivate = config.includePrivate ?? true;
    const prioritize = config.prioritize || [];

    const allFiles = await ctx.gitManager.listFilesAtRef(ctx.repoPath, ctx.ref);

    // Built-in patterns to exclude
    const builtInIgnore = [
      ".test.", ".spec.", "__tests__", "/tests/", "/test/",
      "/__mocks__/", ".stories.", ".story.", "/generated/",
      "/vendor/", "/node_modules/", "/.dart_tool/", "/target/",
      "/build/", "/dist/", "/.git/",
    ];

    // Filter and sort files
    const extensions = supportedExtensions();
    let sourceFiles = allFiles.filter((f) => {
      const hasExtension = extensions.some((ext) => f.endsWith(ext));
      if (!hasExtension) return false;

      const isBuiltInIgnored = builtInIgnore.some((pat) => f.includes(pat));
      const isUserIgnored = ignore.some((pat) => f.includes(pat.replace("**", "")));
      return !isBuiltInIgnored && !isUserIgnored;
    });

    // Prioritize certain directories
    if (prioritize.length > 0) {
      sourceFiles.sort((a, b) => {
        const aScore = prioritize.findIndex((p) => a.includes(p));
        const bScore = prioritize.findIndex((p) => b.includes(p));
        const aVal = aScore >= 0 ? aScore : 1000;
        const bVal = bScore >= 0 ? bScore : 1000;
        return aVal - bVal;
      });
    }

    sourceFiles = sourceFiles.slice(0, limit);

    // Detect TypeScript version/config once per repo (for TypeScript files)
    const { detectTypeScriptVersion, readTsConfig } = await import("./parsers/typescript-version.js");
    let tsConfig: { target?: string; strict?: boolean } | undefined;
    let tsVersion: string | undefined;
    
    const hasTypeScriptFiles = sourceFiles.some((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
    if (hasTypeScriptFiles) {
      try {
        tsConfig = await readTsConfig(ctx.repoPath, ctx.ref, ctx.gitManager);
        tsVersion = await detectTypeScriptVersion(ctx.repoPath, ctx.ref, ctx.gitManager);
      } catch {
        // Version detection failed, continue with defaults
      }
    }

    // Extract types from all files
    const types: TypeDefinition[] = [];
    const calls: CallDefinition[] = [];
    const eventTypes: EventType[] = [];

    for (const file of sourceFiles) {
      const parser = getParserForFile(file);
      if (!parser) continue;

      try {
        const content = await ctx.gitManager.getFileAtRef(ctx.repoPath, ctx.ref, file);
        const parseCtx: { content: string; file: string; includePrivate: boolean; tsConfig?: { target?: string; strict?: boolean } } = { 
          content, 
          file, 
          includePrivate 
        };
        
        // For TypeScript files, pass version info if available
        if ((file.endsWith(".ts") || file.endsWith(".tsx")) && tsConfig) {
          parseCtx.tsConfig = {
            target: tsConfig.target,
            strict: tsConfig.strict,
          };
        }

        // Run the primary language parser
        const result = parser.parse(parseCtx);
        if (Array.isArray(result)) {
          types.push(...result);
        } else {
          types.push(...result.types);
          if (result.calls) {
            calls.push(...result.calls);
          }
        }

        // Run supplementary parsers for applicable files

        // Zod schemas (TypeScript files with Zod imports)
        if (file.endsWith(".ts") || file.endsWith(".tsx")) {
          const zodTypes = parseZodSchemas(parseCtx);
          types.push(...zodTypes);
        }

        // ORM models (various languages)
        const ormTypes = parseORMModels(parseCtx);
        types.push(...ormTypes);

        // Extract event types
        if (file.endsWith(".ts") || file.endsWith(".tsx") || file.endsWith(".js") || file.endsWith(".jsx")) {
          const events = extractEventTypes(parseCtx);
          eventTypes.push(...events);
        }
      } catch {
        // Skip unreadable files
      }
    }

    // Build relationships and modules
    const relationships = buildRelationships(types);
    const modules = buildModules(types, relationships);
    const summary = buildSummary(types, relationships, modules);

    // Identify API types (cross-reference with data_flow extractor if available)
    // This is a best-effort identification based on naming patterns
    identifyAPITypes(types);

    const data: TypeDefinitionsResult = {
      types,
      relationships,
      calls: calls.length > 0 ? calls : undefined,
      modules,
      eventTypes: eventTypes.length > 0 ? eventTypes : undefined,
      summary,
    };

    return {
      extractor: this.name,
      repo: ctx.repoName,
      ref: ctx.ref,
      extractedAt: new Date(),
      data,
    };
  },
};

/**
 * Identify API types based on naming patterns and usage
 */
function identifyAPITypes(types: TypeDefinition[]): void {
  const typeNames = new Set(types.map((t) => t.name));
  
  for (const type of types) {
    // Request types: ends with Request, Input, Create*, Update*, etc.
    if (
      type.name.endsWith("Request") ||
      type.name.endsWith("Input") ||
      type.name.match(/^(Create|Update|Delete|Patch)/) ||
      type.name.match(/Request$/)
    ) {
      type.apiType = "request";
    }
    
    // Response types: ends with Response, Output, *Result, etc.
    if (
      type.name.endsWith("Response") ||
      type.name.endsWith("Output") ||
      type.name.endsWith("Result") ||
      type.name.match(/Response$/)
    ) {
      type.apiType = "response";
    }
  }
}

/**
 * Extract event types from event bus patterns
 */
function extractEventTypes(ctx: { content: string; file: string }): EventType[] {
  const events: EventType[] = [];
  const { content, file } = ctx;
  
  // Pattern: eventBus.emit('eventName', payload)
  const emitPattern = /(?:eventBus|eventEmitter|bus)\.emit\s*\(\s*['"]([^'"]+)['"]/gi;
  let match: RegExpExecArray | null;
  while ((match = emitPattern.exec(content)) !== null) {
    const line = getLineNumber(content, match.index);
    const eventName = match[1];
    
    // Try to find payload type from next argument
    const afterMatch = content.slice(match.index, match.index + 500);
    const payloadMatch = afterMatch.match(/,\s*(\w+)/);
    
    events.push({
      name: eventName,
      payloadType: payloadMatch ? payloadMatch[1] : undefined,
      file,
      line,
    });
  }
  
  // Pattern: publish('eventName', payload)
  const publishPattern = /\.publish\s*\(\s*['"]([^'"]+)['"]/gi;
  while ((match = publishPattern.exec(content)) !== null) {
    const line = getLineNumber(content, match.index);
    const eventName = match[1];
    
    const afterMatch = content.slice(match.index, match.index + 500);
    const payloadMatch = afterMatch.match(/,\s*(\w+)/);
    
    events.push({
      name: eventName,
      payloadType: payloadMatch ? payloadMatch[1] : undefined,
      file,
      line,
    });
  }
  
  // Pattern: send({ type: 'eventName', ... })
  const sendPattern = /\.send\s*\(\s*\{[^}]*type\s*:\s*['"]([^'"]+)['"]/gi;
  while ((match = sendPattern.exec(content)) !== null) {
    const line = getLineNumber(content, match.index);
    const eventName = match[1];
    
    events.push({
      name: eventName,
      file,
      line,
    });
  }
  
  return events;
}

/**
 * Get line number from character index
 */
function getLineNumber(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

registerExtractor(typeDefinitionsExtractor);
export { typeDefinitionsExtractor };
export * from "./schema.js";

