/**
 * Python Type Parser
 *
 * Extracts:
 * - dataclass definitions
 * - Pydantic BaseModel definitions
 * - TypedDict definitions
 * - NamedTuple definitions
 * - Enum definitions
 * - Protocol definitions
 * - Regular class definitions with type annotations
 */

import type { TypeDefinition, FieldDefinition, VariantDefinition, TypeRef } from "../schema.js";
import {
  type TypeParser,
  type ParseContext,
  getLineNumber,
  parseTypeRef,
} from "./index.js";

function parseClassBody(content: string, classIndent: number): FieldDefinition[] {
  const fields: FieldDefinition[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    // Calculate indentation
    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1].length : 0;

    // Skip if not at class body level (one indent deeper than class)
    if (indent <= classIndent) break;

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("def ") || trimmed.startsWith("@")) {
      continue;
    }

    // Pattern: name: Type or name: Type = default
    const fieldMatch = trimmed.match(/^(\w+)\s*:\s*([^=]+?)(?:\s*=.*)?$/);
    if (fieldMatch) {
      const name = fieldMatch[1];
      const typeStr = fieldMatch[2].trim();

      // Skip if name is a dunder or method-like
      if (name.startsWith("_") && name.endsWith("_")) continue;

      const parsed = parseTypeRef(typeStr);
      fields.push({
        name,
        typeRef: {
          name: parsed.name,
          generics: parsed.generics?.map((g) => ({ name: g.name, raw: g.raw })),
          optional: parsed.optional || typeStr.includes("Optional"),
          isCollection: parsed.isCollection,
          raw: typeStr,
        },
        optional: typeStr.includes("Optional") || typeStr.includes("| None"),
        visibility: name.startsWith("_") ? "private" : "public",
      });
    }
  }

  return fields;
}

function parseEnumBody(content: string, classIndent: number): VariantDefinition[] {
  const variants: VariantDefinition[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1].length : 0;

    if (indent <= classIndent) break;

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("def ") || trimmed.startsWith("@")) {
      continue;
    }

    // Pattern: NAME = "value" or NAME = 123 or NAME = auto()
    const variantMatch = trimmed.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$/);
    if (variantMatch) {
      const variant: VariantDefinition = { name: variantMatch[1] };
      const value = variantMatch[2].trim();

      if (value.startsWith('"') || value.startsWith("'")) {
        variant.value = value.slice(1, -1);
      } else if (/^\d+$/.test(value)) {
        variant.value = parseInt(value, 10);
      }
      // auto() and other complex values are left without a value

      variants.push(variant);
    }
  }

  return variants;
}

function extractDocstring(content: string, classEndIndex: number): string | undefined {
  const after = content.slice(classEndIndex);
  // Look for docstring right after class definition
  const docMatch = after.match(/^\s*:\s*\n\s*("""(.+?)"""|'''(.+?)''')/s);
  if (docMatch) {
    return (docMatch[2] || docMatch[3])?.trim();
  }
  return undefined;
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
    } else if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    } else {
      break;
    }
  }

  return decorators.reverse();
}

const pythonParser: TypeParser = {
  language: "python",
  extensions: [".py", ".pyi"],

  parse(ctx: ParseContext): TypeDefinition[] {
    const types: TypeDefinition[] = [];
    const { content, file, includePrivate } = ctx;

    // Match class definitions
    const classPattern = /^(\s*)class\s+(\w+)(?:\(([^)]*)\))?:/gm;
    let match;

    while ((match = classPattern.exec(content)) !== null) {
      const indent = match[1].length;
      const name = match[2];
      const bases = match[3]?.split(",").map((b) => b.trim()).filter(Boolean) || [];

      // Determine visibility (Python convention: _ prefix = private)
      const visibility = name.startsWith("_") ? "private" : "public";
      if (!includePrivate && visibility === "private") continue;

      const line = getLineNumber(content, match.index);
      const decorators = extractDecorators(content, match.index);
      const afterClass = content.slice(match.index + match[0].length);
      const doc = extractDocstring(content, match.index + match[0].length);

      // Determine type kind based on decorators and base classes
      let kind: TypeDefinition["kind"] = "class";
      let isEnum = false;

      if (decorators.includes("dataclass") || decorators.includes("define")) {
        kind = "struct"; // Treat dataclass as struct-like
      } else if (bases.some((b) => b.includes("TypedDict"))) {
        kind = "struct";
      } else if (bases.some((b) => b.includes("NamedTuple"))) {
        kind = "struct";
      } else if (bases.some((b) => b.includes("BaseModel"))) {
        kind = "struct"; // Pydantic model
      } else if (bases.some((b) => b.includes("Protocol"))) {
        kind = "protocol";
      } else if (bases.some((b) => ["Enum", "IntEnum", "StrEnum", "Flag", "IntFlag"].some((e) => b.includes(e)))) {
        kind = "enum";
        isEnum = true;
      }

      // Parse extends (filter out special base classes)
      const specialBases = ["TypedDict", "NamedTuple", "BaseModel", "Protocol", "Enum", "IntEnum", "StrEnum", "Flag", "ABC"];
      const extendsTypes = bases
        .filter((b) => !specialBases.some((s) => b.includes(s)))
        .map((b) => {
          const parsed = parseTypeRef(b);
          return { name: parsed.name, raw: b } as TypeRef;
        });

      const typeDef: TypeDefinition = {
        name,
        kind,
        file,
        line,
        language: "python",
        visibility,
        decorators: decorators.length > 0 ? decorators : undefined,
        extends: extendsTypes.length > 0 ? extendsTypes : undefined,
        doc,
      };

      if (isEnum) {
        typeDef.variants = parseEnumBody(afterClass, indent);
      } else {
        typeDef.fields = parseClassBody(afterClass, indent);
      }

      types.push(typeDef);
    }

    return types;
  },
};

export { pythonParser };

