/**
 * Rust Type Parser
 *
 * Extracts:
 * - struct definitions with fields
 * - enum definitions with variants (including associated data)
 * - trait definitions
 * - type aliases
 */

import type { TypeDefinition, FieldDefinition, VariantDefinition, TypeRef, Visibility } from "../schema.js";
import {
  type TypeParser,
  type ParseContext,
  getLineNumber,
  extractBracedContent,
  extractDocComment,
  parseTypeRef,
} from "./index.js";

function parseVisibility(vis: string | undefined): Visibility {
  if (!vis) return "private";
  if (vis.includes("pub(crate)")) return "internal";
  if (vis.includes("pub(super)")) return "protected";
  if (vis.includes("pub")) return "public";
  return "private";
}

function parseField(fieldStr: string): FieldDefinition | null {
  // Pattern: `pub name: Type` or `name: Type`
  const match = fieldStr.match(/^\s*(pub(?:\([^)]*\))?\s+)?(\w+)\s*:\s*(.+?)\s*$/);
  if (!match) return null;

  const parsed = parseTypeRef(match[3]);
  return {
    name: match[2],
    typeRef: {
      name: parsed.name,
      generics: parsed.generics?.map((g) => ({ name: g.name, raw: g.raw })),
      optional: parsed.optional,
      isCollection: parsed.isCollection,
      raw: parsed.raw,
    },
    visibility: parseVisibility(match[1]),
  };
}

function parseFields(content: string): FieldDefinition[] {
  const fields: FieldDefinition[] = [];

  // Split by commas, but be careful about generics
  let depth = 0;
  let current = "";
  const parts: string[] = [];

  for (const char of content) {
    if (char === "<" || char === "(" || char === "{" || char === "[") depth++;
    else if (char === ">" || char === ")" || char === "}" || char === "]") depth--;

    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());

  for (const part of parts) {
    // Skip attributes and comments
    if (part.startsWith("#[") || part.startsWith("//")) continue;
    const field = parseField(part);
    if (field) fields.push(field);
  }

  return fields;
}

function parseEnumVariants(content: string): VariantDefinition[] {
  const variants: VariantDefinition[] = [];

  // Split by commas at depth 0
  let depth = 0;
  let current = "";
  const parts: string[] = [];

  for (const char of content) {
    if (char === "<" || char === "(" || char === "{" || char === "[") depth++;
    else if (char === ">" || char === ")" || char === "}" || char === "]") depth--;

    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());

  for (const part of parts) {
    // Skip attributes and comments
    const cleaned = part.replace(/#\[[^\]]*\]/g, "").trim();
    if (!cleaned || cleaned.startsWith("//")) continue;

    // Pattern: VariantName or VariantName { fields } or VariantName(types)
    const namedFieldsMatch = cleaned.match(/^(\w+)\s*\{([^}]*)\}/);
    const tupleFieldsMatch = cleaned.match(/^(\w+)\s*\(([^)]*)\)/);
    const simpleMatch = cleaned.match(/^(\w+)$/);

    if (namedFieldsMatch) {
      variants.push({
        name: namedFieldsMatch[1],
        fields: parseFields(namedFieldsMatch[2]),
      });
    } else if (tupleFieldsMatch) {
      const types = tupleFieldsMatch[2].split(",").map((t) => t.trim()).filter(Boolean);
      variants.push({
        name: tupleFieldsMatch[1],
        fields: types.map((t, i) => {
          const parsed = parseTypeRef(t);
          return {
            name: `_${i}`,
            typeRef: {
              name: parsed.name,
              generics: parsed.generics?.map((g) => ({ name: g.name, raw: g.raw })),
              optional: parsed.optional,
              isCollection: parsed.isCollection,
              raw: parsed.raw,
            },
          };
        }),
      });
    } else if (simpleMatch) {
      variants.push({ name: simpleMatch[1] });
    }
  }

  return variants;
}

function extractDecorators(content: string, index: number): string[] {
  const decorators: string[] = [];
  const before = content.slice(0, index);
  const lines = before.split("\n").reverse();

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#[")) {
      const match = trimmed.match(/#\[([^\]]+)\]/);
      if (match) decorators.push(match[1]);
    } else if (trimmed === "" || trimmed.startsWith("///")) {
      continue;
    } else {
      break;
    }
  }

  return decorators.reverse();
}

/**
 * Parse tuple struct fields: struct Wrapper(String, i32);
 */
function parseTupleStructFields(content: string): FieldDefinition[] {
  const types = content.split(",").map((t) => t.trim()).filter(Boolean);
  return types.map((t, i) => {
    // Handle pub fields in tuple structs: (pub String, i32)
    const pubMatch = t.match(/^(pub(?:\([^)]*\))?\s+)?(.+)$/);
    const typeStr = pubMatch ? pubMatch[2].trim() : t;
    const parsed = parseTypeRef(typeStr);
    return {
      name: `_${i}`,
      typeRef: {
        name: parsed.name,
        generics: parsed.generics?.map((g) => ({ name: g.name, raw: g.raw })),
        optional: parsed.optional,
        isCollection: parsed.isCollection,
        raw: parsed.raw,
      },
      visibility: parseVisibility(pubMatch?.[1]),
    };
  });
}

const rustParser: TypeParser = {
  language: "rust",
  extensions: [".rs"],

  parse(ctx: ParseContext): TypeDefinition[] {
    const types: TypeDefinition[] = [];
    const { content, file, includePrivate } = ctx;
    let match;

    // Regular structs with braces: struct Foo { x: i32 }
    const bracedStructPattern = /(pub(?:\([^)]*\))?\s+)?struct\s+(\w+)(?:<([^>]+)>)?\s*(?:where[^{]+)?\{/g;
    while ((match = bracedStructPattern.exec(content)) !== null) {
      const visibility = parseVisibility(match[1]);
      if (!includePrivate && visibility === "private") continue;

      const line = getLineNumber(content, match.index);
      const braced = extractBracedContent(content, match.index);

      types.push({
        name: match[2],
        kind: "struct",
        file,
        line,
        language: "rust",
        visibility,
        generics: match[3]?.split(",").map((g) => g.trim().split(":")[0].trim()),
        fields: braced ? parseFields(braced.content) : [],
        decorators: extractDecorators(content, match.index),
        doc: extractDocComment(content, match.index),
      });
    }

    // Tuple structs: struct Wrapper(String, i32);
    const tupleStructPattern = /(pub(?:\([^)]*\))?\s+)?struct\s+(\w+)(?:<([^>]+)>)?\s*\(([^)]*)\)\s*;/g;
    while ((match = tupleStructPattern.exec(content)) !== null) {
      const visibility = parseVisibility(match[1]);
      if (!includePrivate && visibility === "private") continue;

      const line = getLineNumber(content, match.index);

      types.push({
        name: match[2],
        kind: "struct",
        file,
        line,
        language: "rust",
        visibility,
        generics: match[3]?.split(",").map((g) => g.trim().split(":")[0].trim()),
        fields: parseTupleStructFields(match[4]),
        decorators: extractDecorators(content, match.index),
        doc: extractDocComment(content, match.index),
      });
    }

    // Unit structs: struct Marker;
    const unitStructPattern = /(pub(?:\([^)]*\))?\s+)?struct\s+(\w+)(?:<([^>]+)>)?\s*;/g;
    while ((match = unitStructPattern.exec(content)) !== null) {
      const visibility = parseVisibility(match[1]);
      if (!includePrivate && visibility === "private") continue;

      const line = getLineNumber(content, match.index);

      types.push({
        name: match[2],
        kind: "struct",
        file,
        line,
        language: "rust",
        visibility,
        generics: match[3]?.split(",").map((g) => g.trim().split(":")[0].trim()),
        fields: [], // Unit structs have no fields
        decorators: extractDecorators(content, match.index),
        doc: extractDocComment(content, match.index),
      });
    }

    // Enums
    const enumPattern = /(pub(?:\([^)]*\))?\s+)?enum\s+(\w+)(?:<([^>]+)>)?\s*\{/g;
    while ((match = enumPattern.exec(content)) !== null) {
      const visibility = parseVisibility(match[1]);
      if (!includePrivate && visibility === "private") continue;

      const line = getLineNumber(content, match.index);
      const braced = extractBracedContent(content, match.index);

      types.push({
        name: match[2],
        kind: "enum",
        file,
        line,
        language: "rust",
        visibility,
        generics: match[3]?.split(",").map((g) => g.trim().split(":")[0].trim()),
        variants: braced ? parseEnumVariants(braced.content) : [],
        decorators: extractDecorators(content, match.index),
        doc: extractDocComment(content, match.index),
      });
    }

    // Traits
    const traitPattern = /(pub(?:\([^)]*\))?\s+)?trait\s+(\w+)(?:<([^>]+)>)?(?:\s*:\s*([^\{]+))?\s*\{/g;
    while ((match = traitPattern.exec(content)) !== null) {
      const visibility = parseVisibility(match[1]);
      if (!includePrivate && visibility === "private") continue;

      const line = getLineNumber(content, match.index);
      const supertraits = match[4]?.split("+").map((s) => {
        const parsed = parseTypeRef(s.trim());
        return { name: parsed.name, raw: parsed.raw } as TypeRef;
      });

      types.push({
        name: match[2],
        kind: "trait",
        file,
        line,
        language: "rust",
        visibility,
        generics: match[3]?.split(",").map((g) => g.trim().split(":")[0].trim()),
        extends: supertraits,
        decorators: extractDecorators(content, match.index),
        doc: extractDocComment(content, match.index),
      });
    }

    // Type aliases
    const typePattern = /(pub(?:\([^)]*\))?\s+)?type\s+(\w+)(?:<([^>]+)>)?\s*=\s*([^;]+);/g;
    while ((match = typePattern.exec(content)) !== null) {
      const visibility = parseVisibility(match[1]);
      if (!includePrivate && visibility === "private") continue;

      const line = getLineNumber(content, match.index);

      types.push({
        name: match[2],
        kind: "type_alias",
        file,
        line,
        language: "rust",
        visibility,
        generics: match[3]?.split(",").map((g) => g.trim().split(":")[0].trim()),
        doc: extractDocComment(content, match.index),
      });
    }

    return types;
  },
};

export { rustParser };

