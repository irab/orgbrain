/**
 * TypeScript Type Parser
 *
 * Extracts:
 * - interface definitions with fields
 * - type aliases (including union types)
 * - class definitions
 * - enum definitions
 */

import type { TypeDefinition, FieldDefinition, VariantDefinition, TypeRef } from "../schema.js";
import {
  type TypeParser,
  type ParseContext,
  getLineNumber,
  extractBracedContent,
  extractDocComment,
  parseTypeRef,
} from "./index.js";

function parseFields(content: string): FieldDefinition[] {
  const fields: FieldDefinition[] = [];

  // Split by semicolons or newlines, handling nested structures
  let depth = 0;
  let current = "";
  const parts: string[] = [];

  for (const char of content) {
    if (char === "<" || char === "(" || char === "{" || char === "[") depth++;
    else if (char === ">" || char === ")" || char === "}" || char === "]") depth--;

    if ((char === ";" || char === "\n") && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());

  for (const part of parts) {
    // Skip methods and comments
    if (part.includes("(") && part.includes(")")) continue;
    if (part.startsWith("//") || part.startsWith("/*")) continue;

    // Pattern: readonly? name?: type
    const match = part.match(/^\s*(readonly\s+)?(private\s+|public\s+|protected\s+)?(\w+)(\?)?:\s*(.+?)\s*;?\s*$/);
    if (!match) continue;

    const parsed = parseTypeRef(match[5]);
    fields.push({
      name: match[3],
      typeRef: {
        name: parsed.name,
        generics: parsed.generics?.map((g) => ({ name: g.name, raw: g.raw })),
        optional: parsed.optional || Boolean(match[4]),
        isCollection: parsed.isCollection,
        raw: parsed.raw,
      },
      optional: Boolean(match[4]),
      visibility: match[2]?.trim() as "private" | "public" | "protected" | undefined,
    });
  }

  return fields;
}

function parseEnumVariants(content: string): VariantDefinition[] {
  const variants: VariantDefinition[] = [];

  // Split by commas
  const parts = content.split(",").map((p) => p.trim()).filter(Boolean);

  for (const part of parts) {
    // Skip comments
    if (part.startsWith("//")) continue;

    // Pattern: Name = "value" or Name = 123 or just Name
    const match = part.match(/^(\w+)(?:\s*=\s*("[^"]*"|'[^']*'|\d+))?\s*$/);
    if (!match) continue;

    const variant: VariantDefinition = { name: match[1] };
    if (match[2]) {
      const val = match[2];
      if (val.startsWith('"') || val.startsWith("'")) {
        variant.value = val.slice(1, -1);
      } else {
        variant.value = parseInt(val, 10);
      }
    }
    variants.push(variant);
  }

  return variants;
}

function extractDecorators(content: string, index: number): string[] {
  const decorators: string[] = [];
  const before = content.slice(0, index);
  const lines = before.split("\n").reverse();

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("@")) {
      const match = trimmed.match(/@(\w+)/);
      if (match) decorators.push(match[1]);
    } else if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("*")) {
      continue;
    } else {
      break;
    }
  }

  return decorators.reverse();
}

const typescriptParser: TypeParser = {
  language: "typescript",
  extensions: [".ts", ".tsx", ".mts", ".cts"],

  parse(ctx: ParseContext): TypeDefinition[] {
    const types: TypeDefinition[] = [];
    const { content, file } = ctx;

    // Interfaces
    const interfacePattern = /(export\s+)?(declare\s+)?interface\s+(\w+)(?:<([^>]+)>)?(?:\s+extends\s+([^\{]+))?\s*\{/g;
    let match;

    while ((match = interfacePattern.exec(content)) !== null) {
      const line = getLineNumber(content, match.index);
      const braced = extractBracedContent(content, match.index);

      const extendsTypes = match[5]?.split(",").map((e) => {
        const parsed = parseTypeRef(e.trim());
        return { name: parsed.name, raw: parsed.raw } as TypeRef;
      });

      types.push({
        name: match[3],
        kind: "interface",
        file,
        line,
        language: "typescript",
        visibility: match[1] ? "public" : "internal",
        generics: match[4]?.split(",").map((g) => g.trim().split(/\s+extends\s+/)[0].trim()),
        extends: extendsTypes,
        fields: braced ? parseFields(braced.content) : [],
        doc: extractDocComment(content, match.index),
      });
    }

    // Type aliases
    const typePattern = /(export\s+)?(declare\s+)?type\s+(\w+)(?:<([^>]+)>)?\s*=\s*/g;
    while ((match = typePattern.exec(content)) !== null) {
      const line = getLineNumber(content, match.index);

      types.push({
        name: match[3],
        kind: "type_alias",
        file,
        line,
        language: "typescript",
        visibility: match[1] ? "public" : "internal",
        generics: match[4]?.split(",").map((g) => g.trim().split(/\s+extends\s+/)[0].trim()),
        doc: extractDocComment(content, match.index),
      });
    }

    // Classes
    const classPattern = /(export\s+)?(abstract\s+)?(declare\s+)?class\s+(\w+)(?:<([^>]+)>)?(?:\s+extends\s+(\w+)(?:<[^>]+>)?)?(?:\s+implements\s+([^\{]+))?\s*\{/g;
    while ((match = classPattern.exec(content)) !== null) {
      const line = getLineNumber(content, match.index);
      const braced = extractBracedContent(content, match.index);

      const extendsType = match[6] ? [{ name: match[6], raw: match[6] } as TypeRef] : undefined;
      const implementsTypes = match[7]?.split(",").map((i) => {
        const parsed = parseTypeRef(i.trim());
        return { name: parsed.name, raw: parsed.raw } as TypeRef;
      });

      types.push({
        name: match[4],
        kind: "class",
        file,
        line,
        language: "typescript",
        visibility: match[1] ? "public" : "internal",
        generics: match[5]?.split(",").map((g) => g.trim().split(/\s+extends\s+/)[0].trim()),
        extends: extendsType,
        implements: implementsTypes,
        fields: braced ? parseFields(braced.content) : [],
        decorators: extractDecorators(content, match.index),
        doc: extractDocComment(content, match.index),
      });
    }

    // Enums
    const enumPattern = /(export\s+)?(const\s+)?(declare\s+)?enum\s+(\w+)\s*\{/g;
    while ((match = enumPattern.exec(content)) !== null) {
      const line = getLineNumber(content, match.index);
      const braced = extractBracedContent(content, match.index);

      types.push({
        name: match[4],
        kind: "enum",
        file,
        line,
        language: "typescript",
        visibility: match[1] ? "public" : "internal",
        variants: braced ? parseEnumVariants(braced.content) : [],
        doc: extractDocComment(content, match.index),
      });
    }

    return types;
  },
};

export { typescriptParser };

