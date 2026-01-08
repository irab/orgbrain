/**
 * Dart Type Parser (Regex-based)
 *
 * NOTE: This parser uses regex instead of tree-sitter because there is no
 * official tree-sitter-dart package available on npm. Community grammars exist
 * (e.g., https://github.com/AUAboi/tree-sitter-dart) but would require manual
 * building and distribution of native binaries.
 *
 * When an official tree-sitter-dart npm package becomes available, this parser
 * should be migrated to use it for better accuracy and edge case handling.
 *
 * Extracts:
 * - class definitions with fields
 * - abstract classes (interfaces)
 * - enum definitions
 * - mixin definitions
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

  // Match field declarations: final Type name; or Type? name; or late Type name;
  const fieldPattern = /(?:final\s+|late\s+)?([\w<>?,\s]+?)\s+(\w+)\s*[;=]/g;
  let match;

  while ((match = fieldPattern.exec(content)) !== null) {
    // Skip if it looks like a method
    if (content.slice(match.index).match(/^\s*[\w<>?,\s]+\s+\w+\s*\(/)) {
      continue;
    }

    const typeStr = match[1].trim();
    // Skip if type is a keyword
    if (["return", "if", "else", "for", "while", "switch", "case", "class", "void"].includes(typeStr)) {
      continue;
    }

    const parsed = parseTypeRef(typeStr);
    fields.push({
      name: match[2],
      typeRef: {
        name: parsed.name,
        generics: parsed.generics?.map((g) => ({ name: g.name, raw: g.raw })),
        optional: parsed.optional || typeStr.endsWith("?"),
        isCollection: parsed.isCollection,
        raw: typeStr,
      },
      optional: typeStr.endsWith("?"),
    });
  }

  return fields;
}

function parseEnumVariants(content: string): VariantDefinition[] {
  const variants: VariantDefinition[] = [];

  // Remove any methods section (after semicolon)
  const valuesSection = content.split(";")[0];

  // Split by commas
  const parts = valuesSection.split(",").map((p) => p.trim()).filter(Boolean);

  for (const part of parts) {
    // Skip comments
    if (part.startsWith("//")) continue;

    // Pattern: name or name(args)
    const match = part.match(/^(\w+)(?:\(([^)]*)\))?/);
    if (!match) continue;

    const variant: VariantDefinition = { name: match[1] };

    // If there are constructor args, treat as fields
    if (match[2]) {
      const args = match[2].split(",").map((a) => a.trim()).filter(Boolean);
      variant.fields = args.map((arg, i) => {
        // Try to parse "Type name" or just "value"
        const argMatch = arg.match(/^([\w<>?]+)\s+(\w+)$/) || arg.match(/^this\.(\w+)$/);
        if (argMatch) {
          const parsed = parseTypeRef(argMatch[1] || "dynamic");
          return {
            name: argMatch[2] || argMatch[1],
            typeRef: { name: parsed.name, raw: argMatch[1] || "dynamic" },
          };
        }
        return {
          name: `_${i}`,
          typeRef: { name: "dynamic", raw: arg },
        };
      });
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
    } else if (trimmed === "" || trimmed.startsWith("///")) {
      continue;
    } else {
      break;
    }
  }

  return decorators.reverse();
}

const dartParser: TypeParser = {
  language: "dart",
  extensions: [".dart"],

  parse(ctx: ParseContext): TypeDefinition[] {
    const types: TypeDefinition[] = [];
    const { content, file, includePrivate } = ctx;

    // Classes (including abstract)
    const classPattern = /(abstract\s+)?(base\s+|sealed\s+|final\s+)?class\s+(\w+)(?:<([^>]+)>)?(?:\s+extends\s+(\w+)(?:<[^>]+>)?)?(?:\s+(?:with|implements)\s+([^\{]+))?\s*\{/g;
    let match;

    while ((match = classPattern.exec(content)) !== null) {
      const name = match[3];
      // In Dart, private = starts with _
      const visibility = name.startsWith("_") ? "private" : "public";
      if (!includePrivate && visibility === "private") continue;

      const line = getLineNumber(content, match.index);
      const braced = extractBracedContent(content, match.index);

      const extendsType = match[5] ? [{ name: match[5], raw: match[5] } as TypeRef] : undefined;

      // Parse 'with' and 'implements'
      let implementsTypes: TypeRef[] | undefined;
      if (match[6]) {
        const parts = match[6].split(/\s+(?:with|implements)\s+/);
        implementsTypes = parts.flatMap((p) =>
          p.split(",").map((i) => {
            const parsed = parseTypeRef(i.trim());
            return { name: parsed.name, raw: parsed.raw } as TypeRef;
          })
        );
      }

      types.push({
        name,
        kind: match[1] ? "interface" : "class", // abstract class = interface-like
        file,
        line,
        language: "dart",
        visibility,
        generics: match[4]?.split(",").map((g) => g.trim().split(/\s+extends\s+/)[0].trim()),
        extends: extendsType,
        implements: implementsTypes,
        fields: braced ? parseFields(braced.content) : [],
        decorators: extractDecorators(content, match.index),
        doc: extractDocComment(content, match.index),
      });
    }

    // Enums
    const enumPattern = /enum\s+(\w+)(?:\s+with\s+([^\{]+))?\s*\{/g;
    while ((match = enumPattern.exec(content)) !== null) {
      const name = match[1];
      const visibility = name.startsWith("_") ? "private" : "public";
      if (!includePrivate && visibility === "private") continue;

      const line = getLineNumber(content, match.index);
      const braced = extractBracedContent(content, match.index);

      types.push({
        name,
        kind: "enum",
        file,
        line,
        language: "dart",
        visibility,
        variants: braced ? parseEnumVariants(braced.content) : [],
        doc: extractDocComment(content, match.index),
      });
    }

    // Mixins
    const mixinPattern = /(base\s+)?mixin\s+(\w+)(?:<([^>]+)>)?(?:\s+on\s+([^\{]+))?\s*\{/g;
    while ((match = mixinPattern.exec(content)) !== null) {
      const name = match[2];
      const visibility = name.startsWith("_") ? "private" : "public";
      if (!includePrivate && visibility === "private") continue;

      const line = getLineNumber(content, match.index);

      const onTypes = match[4]?.split(",").map((t) => {
        const parsed = parseTypeRef(t.trim());
        return { name: parsed.name, raw: parsed.raw } as TypeRef;
      });

      types.push({
        name,
        kind: "trait", // mixin is similar to trait
        file,
        line,
        language: "dart",
        visibility,
        generics: match[3]?.split(",").map((g) => g.trim()),
        extends: onTypes,
        doc: extractDocComment(content, match.index),
      });
    }

    return types;
  },
};

export { dartParser };

