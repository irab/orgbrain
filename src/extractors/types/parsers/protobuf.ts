/**
 * Protocol Buffers Parser
 *
 * Extracts type definitions from .proto files, which often serve as the
 * source of truth for cross-language data schemas.
 *
 * Supports:
 * - message definitions with fields
 * - enum definitions
 * - oneof fields
 * - nested messages
 * - map fields
 * - repeated fields
 */

import type { TypeDefinition, FieldDefinition, VariantDefinition, TypeRef } from "../schema.js";
import {
  type TypeParser,
  type ParseContext,
  getLineNumber,
  extractBracedContent,
} from "./index.js";

/**
 * Map protobuf types to language-agnostic type names
 */
function protoTypeToTypeRef(protoType: string, isRepeated: boolean): TypeRef {
  const trimmed = protoType.trim();

  // Scalar type mappings
  const scalarMap: Record<string, string> = {
    "double": "f64",
    "float": "f32",
    "int32": "i32",
    "int64": "i64",
    "uint32": "u32",
    "uint64": "u64",
    "sint32": "i32",
    "sint64": "i64",
    "fixed32": "u32",
    "fixed64": "u64",
    "sfixed32": "i32",
    "sfixed64": "i64",
    "bool": "bool",
    "string": "string",
    "bytes": "bytes",
  };

  const mappedType = scalarMap[trimmed] || trimmed;

  return {
    name: mappedType,
    raw: protoType,
    isCollection: isRepeated,
  };
}

/**
 * Parse message fields
 */
function parseMessageFields(content: string): FieldDefinition[] {
  const fields: FieldDefinition[] = [];

  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines, comments, and nested definitions
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;
    if (trimmed.startsWith("message ") || trimmed.startsWith("enum ") || trimmed.startsWith("oneof ")) continue;
    if (trimmed === "}" || trimmed === "{") continue;
    if (trimmed.startsWith("option ") || trimmed.startsWith("reserved ")) continue;

    // Map field: map<KeyType, ValueType> field_name = N;
    const mapMatch = trimmed.match(/^map\s*<\s*(\w+)\s*,\s*(\w+)\s*>\s+(\w+)\s*=\s*\d+/);
    if (mapMatch) {
      fields.push({
        name: mapMatch[3],
        typeRef: {
          name: "Map",
          raw: `map<${mapMatch[1]}, ${mapMatch[2]}>`,
          generics: [
            { name: mapMatch[1], raw: mapMatch[1] },
            { name: mapMatch[2], raw: mapMatch[2] },
          ],
        },
      });
      continue;
    }

    // Regular field: [optional|required|repeated] type name = N;
    const fieldMatch = trimmed.match(/^(optional|required|repeated)?\s*(\w+)\s+(\w+)\s*=\s*\d+/);
    if (fieldMatch) {
      const modifier = fieldMatch[1];
      const type = fieldMatch[2];
      const name = fieldMatch[3];

      const typeRef = protoTypeToTypeRef(type, modifier === "repeated");
      fields.push({
        name,
        typeRef,
        optional: modifier === "optional",
      });
    }
  }

  return fields;
}

/**
 * Parse enum values
 */
function parseEnumValues(content: string): VariantDefinition[] {
  const variants: VariantDefinition[] = [];

  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;
    if (trimmed.startsWith("option ") || trimmed.startsWith("reserved ")) continue;
    if (trimmed === "}" || trimmed === "{") continue;

    // Enum value: NAME = N;
    const valueMatch = trimmed.match(/^(\w+)\s*=\s*(-?\d+)/);
    if (valueMatch) {
      variants.push({
        name: valueMatch[1],
        value: parseInt(valueMatch[2], 10),
      });
    }
  }

  return variants;
}

/**
 * Extract doc comment from proto file
 */
function extractProtoDoc(content: string, index: number): string | undefined {
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

  return docLines.length > 0 ? docLines.join(" ") : undefined;
}

const protobufParser: TypeParser = {
  language: "rust", // Using rust as placeholder since proto is language-agnostic
  extensions: [".proto"],

  parse(ctx: ParseContext): TypeDefinition[] {
    const types: TypeDefinition[] = [];
    const { content, file } = ctx;

    // Extract package name for context
    const packageMatch = content.match(/^package\s+([\w.]+);/m);
    const packageName = packageMatch?.[1];

    // Parse messages
    const messagePattern = /message\s+(\w+)\s*\{/g;
    let match;

    while ((match = messagePattern.exec(content)) !== null) {
      const line = getLineNumber(content, match.index);
      const name = match[1];
      const braced = extractBracedContent(content, match.index);

      if (braced) {
        // Check for nested messages and enums
        const nestedTypes = parseNestedTypes(braced.content, file, name);
        types.push(...nestedTypes);
      }

      types.push({
        name: packageName ? `${packageName}.${name}` : name,
        kind: "struct",
        file,
        line,
        language: "rust", // Protobuf is language-agnostic, using rust as base
        visibility: "public",
        fields: braced ? parseMessageFields(braced.content) : [],
        doc: extractProtoDoc(content, match.index),
        decorators: ["protobuf"],
      });
    }

    // Parse top-level enums
    const enumPattern = /^enum\s+(\w+)\s*\{/gm;
    while ((match = enumPattern.exec(content)) !== null) {
      const line = getLineNumber(content, match.index);
      const name = match[1];
      const braced = extractBracedContent(content, match.index);

      types.push({
        name: packageName ? `${packageName}.${name}` : name,
        kind: "enum",
        file,
        line,
        language: "rust",
        visibility: "public",
        variants: braced ? parseEnumValues(braced.content) : [],
        doc: extractProtoDoc(content, match.index),
        decorators: ["protobuf"],
      });
    }

    // Parse service definitions (as traits/interfaces)
    const servicePattern = /service\s+(\w+)\s*\{/g;
    while ((match = servicePattern.exec(content)) !== null) {
      const line = getLineNumber(content, match.index);
      const name = match[1];

      types.push({
        name: packageName ? `${packageName}.${name}` : name,
        kind: "trait",
        file,
        line,
        language: "rust",
        visibility: "public",
        doc: extractProtoDoc(content, match.index),
        decorators: ["protobuf", "service"],
      });
    }

    return types;
  },
};

/**
 * Parse nested messages and enums within a message
 */
function parseNestedTypes(content: string, file: string, parentName: string): TypeDefinition[] {
  const types: TypeDefinition[] = [];

  // Nested messages
  const messagePattern = /message\s+(\w+)\s*\{/g;
  let match;

  while ((match = messagePattern.exec(content)) !== null) {
    const name = `${parentName}.${match[1]}`;
    const braced = extractBracedContent(content, match.index);

    types.push({
      name,
      kind: "struct",
      file,
      line: 0, // Line numbers in nested content aren't accurate
      language: "rust",
      visibility: "public",
      fields: braced ? parseMessageFields(braced.content) : [],
      decorators: ["protobuf", "nested"],
    });
  }

  // Nested enums
  const enumPattern = /enum\s+(\w+)\s*\{/g;
  while ((match = enumPattern.exec(content)) !== null) {
    const name = `${parentName}.${match[1]}`;
    const braced = extractBracedContent(content, match.index);

    types.push({
      name,
      kind: "enum",
      file,
      line: 0,
      language: "rust",
      visibility: "public",
      variants: braced ? parseEnumValues(braced.content) : [],
      decorators: ["protobuf", "nested"],
    });
  }

  return types;
}

export { protobufParser };

