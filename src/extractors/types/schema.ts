/**
 * Type Definition Schema
 *
 * Designed for:
 * - Cross-repo type mapping and comparison
 * - Diagram generation (ER, class diagrams, dependency graphs)
 * - Data flow analysis (tracking type usage across services)
 * - API contract validation
 */

// =============================================================================
// Core Type Definitions
// =============================================================================

export type TypeKind =
  | "struct"
  | "class"
  | "interface"
  | "enum"
  | "type_alias"
  | "trait"
  | "protocol"
  | "union"
  | "message"    // Protobuf message
  | "service"    // Protobuf/GraphQL service
  | "input"      // GraphQL input type
  | "model";     // Prisma/ORM model

export type Visibility = "public" | "private" | "internal" | "protected";

export type Language =
  | "rust"
  | "typescript"
  | "dart"
  | "go"
  | "swift"
  | "kotlin"
  | "python"
  | "protobuf"
  | "graphql"
  | "prisma";

/**
 * A reference to another type, enabling relationship tracking for diagrams
 */
export interface TypeRef {
  /** The referenced type name */
  name: string;
  /** Generic parameters if any (e.g., Vec<T> -> ["T"]) */
  generics?: TypeRef[];
  /** Whether this is a nullable/optional wrapper */
  optional?: boolean;
  /** Whether this is a collection type (array, list, set, etc.) */
  isCollection?: boolean;
  /** The raw type string as written in source */
  raw: string;
}

/**
 * A field within a struct, class, or interface
 */
export interface FieldDefinition {
  name: string;
  /** Parsed type reference for relationship tracking */
  typeRef: TypeRef;
  optional?: boolean;
  visibility?: Visibility;
  /** Field-level decorators/attributes */
  decorators?: string[];
  /** Documentation comment if present */
  doc?: string;
}

/**
 * A variant within an enum
 */
export interface VariantDefinition {
  name: string;
  /** For enum variants with associated data (Rust, Swift) */
  fields?: FieldDefinition[];
  /** For simple enums with explicit values */
  value?: string | number;
  /** Documentation comment if present */
  doc?: string;
}

/**
 * A complete type definition extracted from source code
 */
export interface TypeDefinition {
  /** Type name */
  name: string;
  /** What kind of type this is */
  kind: TypeKind;
  /** Source file path (relative to repo root) */
  file: string;
  /** Line number where definition starts */
  line: number;
  /** Source language */
  language: Language;
  /** Visibility modifier */
  visibility?: Visibility;

  // Structure details
  /** Fields for struct/class/interface */
  fields?: FieldDefinition[];
  /** Variants for enums */
  variants?: VariantDefinition[];

  // Relationships (for diagram generation)
  /** Generic type parameters */
  generics?: string[];
  /** Parent types (extends/inherits) */
  extends?: TypeRef[];
  /** Implemented traits/interfaces */
  implements?: TypeRef[];

  // Metadata
  /** Type-level decorators/attributes/derives */
  decorators?: string[];
  /** Documentation comment if present */
  doc?: string;
}

// =============================================================================
// Relationship Analysis (for diagrams and data flow)
// =============================================================================

export type RelationshipKind =
  | "extends"      // Inheritance
  | "implements"   // Interface/trait implementation
  | "contains"     // Has a field of this type
  | "references"   // References in method signatures, etc.
  | "collection";  // Contains a collection of this type

/**
 * A relationship between two types, used for generating diagrams
 */
export interface TypeRelationship {
  /** Source type name */
  from: string;
  /** Target type name */
  to: string;
  /** Kind of relationship */
  kind: RelationshipKind;
  /** Field name if this is a contains/collection relationship */
  viaField?: string;
  /** Source file for the relationship */
  file: string;
}

/**
 * Grouped types by domain/module for organized diagrams
 */
export interface TypeModule {
  /** Module/directory path */
  path: string;
  /** Types defined in this module */
  types: TypeDefinition[];
  /** Internal relationships within this module */
  internalRelationships: TypeRelationship[];
  /** Relationships to types in other modules */
  externalRelationships: TypeRelationship[];
}

// =============================================================================
// Extraction Result
// =============================================================================

export interface TypeDefinitionsResult {
  /** All extracted types */
  types: TypeDefinition[];

  /** Computed relationships between types (for diagrams) */
  relationships: TypeRelationship[];

  /** Types grouped by module/directory */
  modules: TypeModule[];

  /** Summary statistics */
  summary: {
    byKind: Record<string, number>;
    byLanguage: Record<string, number>;
    byModule: Record<string, number>;
    totalTypes: number;
    totalRelationships: number;
  };
}

// =============================================================================
// Diagram Generation Helpers
// =============================================================================

/**
 * Generate a stable ID for a type (for diagram node IDs)
 */
export function typeId(t: TypeDefinition): string {
  return `${t.file}:${t.name}`.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Generate a stable ID for a relationship (for diagram edge IDs)
 */
export function relationshipId(r: TypeRelationship): string {
  return `${r.from}_${r.kind}_${r.to}`.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Check if a type is a "domain entity" (likely to appear in ER diagrams)
 * Heuristic: has multiple fields and isn't a simple wrapper
 */
export function isDomainEntity(t: TypeDefinition): boolean {
  if (t.kind === "enum" || t.kind === "type_alias") return false;
  if (!t.fields || t.fields.length < 2) return false;
  // Exclude common wrapper/utility patterns
  const excludePatterns = [/^Option/, /^Result/, /^Vec/, /^Box/, /Error$/];
  return !excludePatterns.some((p) => p.test(t.name));
}

/**
 * Determine the "importance" of a type for filtering diagrams
 * Higher = more important
 */
export function typeImportance(t: TypeDefinition): number {
  let score = 0;
  if (t.visibility === "public") score += 2;
  if (t.fields && t.fields.length > 0) score += t.fields.length;
  if (t.doc) score += 1;
  if (t.kind === "trait" || t.kind === "interface") score += 3;
  if (t.extends && t.extends.length > 0) score += 2;
  if (t.implements && t.implements.length > 0) score += 2;
  return score;
}

