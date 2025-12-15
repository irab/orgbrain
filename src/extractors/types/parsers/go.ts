/**
 * Go Type Parser
 *
 * Extracts:
 * - struct definitions with fields
 * - interface definitions
 * - type aliases
 */

import type { TypeDefinition, FieldDefinition, TypeRef } from "../schema.js";
import {
  type TypeParser,
  type ParseContext,
  getLineNumber,
  extractBracedContent,
  parseTypeRef,
} from "./index.js";

function parseStructFields(content: string): FieldDefinition[] {
  const fields: FieldDefinition[] = [];

  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;

    // Pattern: Name Type `json:"tag"` or embedded Type
    // Handle multi-field declarations: Name1, Name2 Type
    const match = trimmed.match(/^(\w+(?:\s*,\s*\w+)*)\s+([\w.*\[\]]+)(?:\s+`[^`]*`)?/);
    if (match) {
      const names = match[1].split(",").map((n) => n.trim());
      const typeStr = match[2];
      const parsed = parseTypeRef(typeStr);

      for (const name of names) {
        fields.push({
          name,
          typeRef: {
            name: parsed.name,
            generics: parsed.generics?.map((g) => ({ name: g.name, raw: g.raw })),
            optional: typeStr.startsWith("*"),
            isCollection: parsed.isCollection || typeStr.startsWith("[]"),
            raw: typeStr,
          },
          visibility: name[0] === name[0].toUpperCase() ? "public" : "private",
        });
      }
      continue;
    }

    // Embedded type
    const embeddedMatch = trimmed.match(/^\*?(\w+)$/);
    if (embeddedMatch) {
      const typeStr = trimmed;
      const parsed = parseTypeRef(typeStr);
      fields.push({
        name: embeddedMatch[1],
        typeRef: {
          name: parsed.name,
          optional: typeStr.startsWith("*"),
          isCollection: false,
          raw: typeStr,
        },
        visibility: "public",
      });
    }
  }

  return fields;
}

function extractDocComment(content: string, index: number): string | undefined {
  const before = content.slice(0, index);
  const lines = before.split("\n").reverse();
  const docLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      if (docLines.length > 0) break;
      continue;
    }
    if (trimmed.startsWith("//")) {
      docLines.unshift(trimmed.slice(2).trim());
    } else {
      break;
    }
  }

  const doc = docLines.join(" ").trim();
  return doc || undefined;
}

const goParser: TypeParser = {
  language: "go",
  extensions: [".go"],

  parse(ctx: ParseContext): TypeDefinition[] {
    const types: TypeDefinition[] = [];
    const { content, file, includePrivate } = ctx;

    // Type declarations: type Name struct { ... }
    const structPattern = /type\s+(\w+)\s+struct\s*\{/g;
    let match;

    while ((match = structPattern.exec(content)) !== null) {
      const name = match[1];
      // In Go, exported = starts with uppercase
      const visibility = name[0] === name[0].toUpperCase() ? "public" : "private";
      if (!includePrivate && visibility === "private") continue;

      const line = getLineNumber(content, match.index);
      const braced = extractBracedContent(content, match.index);

      types.push({
        name,
        kind: "struct",
        file,
        line,
        language: "go",
        visibility,
        fields: braced ? parseStructFields(braced.content) : [],
        doc: extractDocComment(content, match.index),
      });
    }

    // Interface declarations
    const interfacePattern = /type\s+(\w+)\s+interface\s*\{/g;
    while ((match = interfacePattern.exec(content)) !== null) {
      const name = match[1];
      const visibility = name[0] === name[0].toUpperCase() ? "public" : "private";
      if (!includePrivate && visibility === "private") continue;

      const line = getLineNumber(content, match.index);

      types.push({
        name,
        kind: "interface",
        file,
        line,
        language: "go",
        visibility,
        doc: extractDocComment(content, match.index),
      });
    }

    // Type aliases: type Name = OtherType or type Name OtherType
    const aliasPattern = /type\s+(\w+)\s*=?\s*([\w.*\[\]]+)\s*$/gm;
    while ((match = aliasPattern.exec(content)) !== null) {
      // Skip struct and interface (already handled)
      if (match[2] === "struct" || match[2] === "interface") continue;

      const name = match[1];
      const visibility = name[0] === name[0].toUpperCase() ? "public" : "private";
      if (!includePrivate && visibility === "private") continue;

      const line = getLineNumber(content, match.index);

      types.push({
        name,
        kind: "type_alias",
        file,
        line,
        language: "go",
        visibility,
        doc: extractDocComment(content, match.index),
      });
    }

    return types;
  },
};

export { goParser };

