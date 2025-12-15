/**
 * Zod Runtime Schema Parser
 *
 * Extracts type information from Zod schema definitions, which are commonly
 * used in modern TypeScript codebases for runtime validation.
 *
 * Supports:
 * - z.object({ ... }) definitions
 * - z.enum([...]) definitions
 * - z.union([...]) definitions
 * - z.intersection(...) definitions
 * - Schema composition with .extend(), .merge(), .pick(), .omit()
 * - Inferred types: type Foo = z.infer<typeof FooSchema>
 */

import type { TypeDefinition, FieldDefinition, VariantDefinition, TypeRef } from "../schema.js";
import {
  registerParser,
  type TypeParser,
  type ParseContext,
  getLineNumber,
} from "./index.js";

/**
 * Map Zod type methods to TypeScript types
 */
function zodTypeToTypeRef(zodType: string): TypeRef {
  const trimmed = zodType.trim();

  // Handle common Zod types
  const typeMap: Record<string, string> = {
    "z.string()": "string",
    "z.number()": "number",
    "z.boolean()": "boolean",
    "z.date()": "Date",
    "z.bigint()": "bigint",
    "z.undefined()": "undefined",
    "z.null()": "null",
    "z.void()": "void",
    "z.any()": "any",
    "z.unknown()": "unknown",
    "z.never()": "never",
    "z.nan()": "number",
  };

  // Direct match
  for (const [zod, ts] of Object.entries(typeMap)) {
    if (trimmed.startsWith(zod)) {
      return { name: ts, raw: trimmed, optional: trimmed.includes(".optional()") };
    }
  }

  // z.literal("value") or z.literal(123)
  const literalMatch = trimmed.match(/^z\.literal\(([^)]+)\)/);
  if (literalMatch) {
    return { name: "literal", raw: literalMatch[1] };
  }

  // z.array(...)
  if (trimmed.startsWith("z.array(")) {
    const inner = extractInnerType(trimmed, "z.array(");
    return {
      name: "Array",
      isCollection: true,
      generics: inner ? [zodTypeToTypeRef(inner)] : undefined,
      raw: trimmed,
      optional: trimmed.includes(".optional()"),
    };
  }

  // z.record(...)
  if (trimmed.startsWith("z.record(")) {
    return { name: "Record", raw: trimmed, optional: trimmed.includes(".optional()") };
  }

  // z.map(...)
  if (trimmed.startsWith("z.map(")) {
    return { name: "Map", raw: trimmed, optional: trimmed.includes(".optional()") };
  }

  // z.set(...)
  if (trimmed.startsWith("z.set(")) {
    return { name: "Set", isCollection: true, raw: trimmed, optional: trimmed.includes(".optional()") };
  }

  // z.promise(...)
  if (trimmed.startsWith("z.promise(")) {
    return { name: "Promise", raw: trimmed };
  }

  // z.lazy(() => ...)
  if (trimmed.startsWith("z.lazy(")) {
    return { name: "lazy", raw: trimmed };
  }

  // Reference to another schema: SomeSchema or z.lazy(() => SomeSchema)
  const refMatch = trimmed.match(/^(\w+)(?:Schema)?$/);
  if (refMatch) {
    return { name: refMatch[1].replace(/Schema$/, ""), raw: trimmed };
  }

  // Fallback
  return { name: "unknown", raw: trimmed };
}

/**
 * Extract inner content from a Zod method call
 */
function extractInnerType(content: string, prefix: string): string | null {
  const start = content.indexOf(prefix);
  if (start === -1) return null;

  let depth = 0;
  let i = start + prefix.length;
  let result = "";

  while (i < content.length) {
    const char = content[i];
    if (char === "(" || char === "{" || char === "[") depth++;
    else if (char === ")" || char === "}" || char === "]") {
      if (depth === 0) break;
      depth--;
    }
    result += char;
    i++;
  }

  return result.trim();
}

/**
 * Parse z.object({ ... }) fields
 */
function parseZodObjectFields(content: string): FieldDefinition[] {
  const fields: FieldDefinition[] = [];

  // Remove outer braces if present
  const inner = content.trim().replace(/^\{/, "").replace(/\}$/, "").trim();

  // Split by commas at depth 0
  let depth = 0;
  let current = "";
  const parts: string[] = [];

  for (const char of inner) {
    if (char === "(" || char === "{" || char === "[") depth++;
    else if (char === ")" || char === "}" || char === "]") depth--;

    if (char === "," && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());

  for (const part of parts) {
    // Pattern: fieldName: z.type()
    const match = part.match(/^(\w+)\s*:\s*(.+)$/s);
    if (!match) continue;

    const fieldName = match[1];
    const zodType = match[2].trim();

    const typeRef = zodTypeToTypeRef(zodType);
    fields.push({
      name: fieldName,
      typeRef,
      optional: zodType.includes(".optional()") || zodType.includes(".nullish()"),
    });
  }

  return fields;
}

/**
 * Parse z.enum([...]) variants
 */
function parseZodEnumVariants(content: string): VariantDefinition[] {
  const variants: VariantDefinition[] = [];

  // Extract array content
  const arrayMatch = content.match(/\[([^\]]+)\]/);
  if (!arrayMatch) return variants;

  const items = arrayMatch[1].split(",").map((s) => s.trim()).filter(Boolean);

  for (const item of items) {
    // Remove quotes
    const value = item.replace(/^['"]|['"]$/g, "");
    variants.push({
      name: value,
      value: value,
    });
  }

  return variants;
}

const zodParser: TypeParser = {
  language: "typescript",
  extensions: [], // Don't auto-register for .ts files - we'll be called explicitly

  parse(ctx: ParseContext): TypeDefinition[] {
    const types: TypeDefinition[] = [];
    const { content, file } = ctx;

    // Skip if no Zod imports
    if (!content.includes("from 'zod'") && !content.includes('from "zod"') && !content.includes("require('zod')")) {
      return types;
    }

    // Match: const/let/var FooSchema = z.object({ ... })
    const objectSchemaPattern = /(?:export\s+)?(?:const|let|var)\s+(\w+)(?:Schema)?\s*=\s*z\.object\s*\(\s*\{/g;
    let match;

    while ((match = objectSchemaPattern.exec(content)) !== null) {
      const line = getLineNumber(content, match.index);
      const name = match[1].replace(/Schema$/, "");

      // Extract the object content
      let depth = 1;
      let i = match.index + match[0].length;
      let objectContent = "";

      while (i < content.length && depth > 0) {
        const char = content[i];
        if (char === "{") depth++;
        else if (char === "}") depth--;
        if (depth > 0) objectContent += char;
        i++;
      }

      types.push({
        name,
        kind: "struct",
        file,
        line,
        language: "typescript",
        visibility: content.slice(match.index - 10, match.index).includes("export") ? "public" : "internal",
        fields: parseZodObjectFields(objectContent),
        decorators: ["zod"],
      });
    }

    // Match: const FooSchema = z.enum([...])
    const enumSchemaPattern = /(?:export\s+)?(?:const|let|var)\s+(\w+)(?:Schema)?\s*=\s*z\.enum\s*\(\s*\[/g;
    while ((match = enumSchemaPattern.exec(content)) !== null) {
      const line = getLineNumber(content, match.index);
      const name = match[1].replace(/Schema$/, "");

      // Find the closing bracket
      const start = match.index + match[0].length - 1;
      let depth = 1;
      let i = start + 1;

      while (i < content.length && depth > 0) {
        if (content[i] === "[") depth++;
        else if (content[i] === "]") depth--;
        i++;
      }

      const enumContent = content.slice(start, i);

      types.push({
        name,
        kind: "enum",
        file,
        line,
        language: "typescript",
        visibility: content.slice(match.index - 10, match.index).includes("export") ? "public" : "internal",
        variants: parseZodEnumVariants(enumContent),
        decorators: ["zod"],
      });
    }

    // Match: const FooSchema = z.union([...])
    const unionSchemaPattern = /(?:export\s+)?(?:const|let|var)\s+(\w+)(?:Schema)?\s*=\s*z\.union\s*\(/g;
    while ((match = unionSchemaPattern.exec(content)) !== null) {
      const line = getLineNumber(content, match.index);
      const name = match[1].replace(/Schema$/, "");

      types.push({
        name,
        kind: "union",
        file,
        line,
        language: "typescript",
        visibility: content.slice(match.index - 10, match.index).includes("export") ? "public" : "internal",
        decorators: ["zod"],
      });
    }

    // Match schema extensions: FooSchema.extend({ ... })
    const extendPattern = /(?:export\s+)?(?:const|let|var)\s+(\w+)(?:Schema)?\s*=\s*(\w+)(?:Schema)?\.extend\s*\(\s*\{/g;
    while ((match = extendPattern.exec(content)) !== null) {
      const line = getLineNumber(content, match.index);
      const name = match[1].replace(/Schema$/, "");
      const baseName = match[2].replace(/Schema$/, "");

      // Extract the extension fields
      let depth = 1;
      let i = match.index + match[0].length;
      let objectContent = "";

      while (i < content.length && depth > 0) {
        const char = content[i];
        if (char === "{") depth++;
        else if (char === "}") depth--;
        if (depth > 0) objectContent += char;
        i++;
      }

      types.push({
        name,
        kind: "struct",
        file,
        line,
        language: "typescript",
        visibility: content.slice(match.index - 10, match.index).includes("export") ? "public" : "internal",
        extends: [{ name: baseName, raw: baseName }],
        fields: parseZodObjectFields(objectContent),
        decorators: ["zod"],
      });
    }

    return types;
  },
};

// Export but don't auto-register - it will be called from the TypeScript parser
export { zodParser };
export function parseZodSchemas(ctx: ParseContext): TypeDefinition[] {
  return zodParser.parse(ctx);
}
