/**
 * Parser Registry
 *
 * Central registry for language-specific type parsers.
 * Each parser handles extraction for one or more file extensions.
 */

import type { TypeDefinition, Language } from "../schema.js";

// =============================================================================
// Parser Interface
// =============================================================================

export interface ParseContext {
  /** File content */
  content: string;
  /** File path (relative to repo root) */
  file: string;
  /** Include private/internal types */
  includePrivate: boolean;
}

export interface TypeParser {
  /** Language this parser handles */
  language: Language;
  /** File extensions this parser handles (e.g., [".rs"]) */
  extensions: string[];
  /** Parse types from file content */
  parse(ctx: ParseContext): TypeDefinition[];
}

// =============================================================================
// Parser Registry
// =============================================================================

const parsers = new Map<string, TypeParser>();
const extensionMap = new Map<string, TypeParser>();

/**
 * Register a type parser
 */
export function registerParser(parser: TypeParser): void {
  parsers.set(parser.language, parser);
  for (const ext of parser.extensions) {
    extensionMap.set(ext, parser);
  }
}

/**
 * Get parser for a specific language
 */
export function getParser(language: Language): TypeParser | undefined {
  return parsers.get(language);
}

/**
 * Get parser for a file based on extension
 */
export function getParserForFile(file: string): TypeParser | undefined {
  for (const [ext, parser] of extensionMap) {
    if (file.endsWith(ext)) {
      return parser;
    }
  }
  return undefined;
}

/**
 * Get all registered parsers
 */
export function listParsers(): TypeParser[] {
  return Array.from(parsers.values());
}

/**
 * Get all supported file extensions
 */
export function supportedExtensions(): string[] {
  return Array.from(extensionMap.keys());
}

// =============================================================================
// Parsing Utilities (shared across parsers)
// =============================================================================

/**
 * Get line number for a character index in content
 */
export function getLineNumber(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

/**
 * Extract content between balanced braces starting at given index
 * Returns the content and the end index
 */
export function extractBracedContent(
  content: string,
  startIndex: number,
  openChar = "{",
  closeChar = "}"
): { content: string; endIndex: number } | null {
  const braceStart = content.indexOf(openChar, startIndex);
  if (braceStart === -1) return null;

  let depth = 1;
  let i = braceStart + 1;
  let result = "";

  while (i < content.length && depth > 0) {
    const char = content[i];
    if (char === openChar) depth++;
    else if (char === closeChar) depth--;
    if (depth > 0) result += char;
    i++;
  }

  return { content: result, endIndex: i };
}

/**
 * Extract doc comment preceding a position
 * Supports /// style (Rust), block comment style (JS/TS), and # style (Python)
 */
export function extractDocComment(
  content: string,
  definitionIndex: number
): string | undefined {
  const before = content.slice(0, definitionIndex);
  const lines = before.split("\n");

  // Look for doc comments in the last few lines before the definition
  const docLines: string[] = [];

  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
    const line = lines[i].trim();

    // Skip empty lines at the start of our search
    if (docLines.length === 0 && line === "") continue;

    // Rust-style doc comments
    if (line.startsWith("///")) {
      docLines.unshift(line.slice(3).trim());
      continue;
    }

    // End of JS/TS block comment
    if (line.endsWith("*/")) {
      // Collect the block comment
      let j = i;
      while (j >= 0 && !lines[j].includes("/**")) {
        docLines.unshift(lines[j].replace(/^\s*\*\s?/, "").replace(/\*\/$/, "").trim());
        j--;
      }
      if (j >= 0) {
        docLines.unshift(lines[j].replace(/^\s*\/\*\*\s?/, "").trim());
      }
      break;
    }

    // Python docstrings would be after the definition, handled separately

    // If we hit a non-comment, non-empty line, stop
    if (line && !line.startsWith("//") && !line.startsWith("#")) {
      break;
    }
  }

  const doc = docLines.filter(Boolean).join(" ").trim();
  return doc || undefined;
}

/**
 * Parse a type string into a TypeRef structure
 * Handles generics, optionals, and collections
 */
export function parseTypeRef(raw: string): {
  name: string;
  generics?: { name: string; raw: string }[];
  optional: boolean;
  isCollection: boolean;
  raw: string;
} {
  const trimmed = raw.trim();

  // Common optional patterns
  const optionalPatterns = [
    /^Option<(.+)>$/,           // Rust Option
    /^Optional<(.+)>$/,         // Java Optional
    /^(.+)\?$/,                 // TypeScript/Swift optional
    /^\?(.+)$/,                 // Dart nullable
    /^Optional\[(.+)\]$/,       // Python Optional
  ];

  let isOptional = false;
  let inner = trimmed;

  for (const pattern of optionalPatterns) {
    const match = trimmed.match(pattern);
    if (match) {
      isOptional = true;
      inner = match[1];
      break;
    }
  }

  // Common collection patterns
  const collectionPatterns = [
    /^Vec<(.+)>$/,              // Rust Vec
    /^Array<(.+)>$/,            // TypeScript/Java Array
    /^List<(.+)>$/,             // Dart/Java List
    /^Set<(.+)>$/,              // Various Set
    /^\[(.+)\]$/,               // Go/Swift array
    /^(.+)\[\]$/,               // TypeScript array shorthand
  ];

  let isCollection = false;
  let elementType = inner;

  for (const pattern of collectionPatterns) {
    const match = inner.match(pattern);
    if (match) {
      isCollection = true;
      elementType = match[1];
      break;
    }
  }

  // Extract generics
  const genericMatch = elementType.match(/^(\w+)<(.+)>$/);
  let name = elementType;
  let generics: { name: string; raw: string }[] | undefined;

  if (genericMatch) {
    name = genericMatch[1];
    // Simple split by comma (doesn't handle nested generics perfectly)
    generics = genericMatch[2].split(",").map((g) => ({
      name: g.trim().split("<")[0],
      raw: g.trim(),
    }));
  }

  return {
    name: name.split("<")[0], // Remove any remaining generic syntax
    generics,
    optional: isOptional,
    isCollection,
    raw: trimmed,
  };
}

// =============================================================================
// Supplementary Parsers (re-exported for use by main extractor)
// =============================================================================

export { parseZodSchemas } from "./zod.js";
export { parseORMModels } from "./orm.js";

// =============================================================================
// Parser Registration
// =============================================================================

// Import parsers - they self-register via registerParser()
// These must be imported AFTER the registry functions are defined
import { rustParser } from "./rust.js";
import { typescriptParser } from "./typescript.js";
import { dartParser } from "./dart.js";
import { goParser } from "./go.js";
import { pythonParser } from "./python.js";
import { protobufParser } from "./protobuf.js";

// Explicitly register parsers to avoid ESM hoisting issues
registerParser(rustParser);
registerParser(typescriptParser);
registerParser(dartParser);
registerParser(goParser);
registerParser(pythonParser);
registerParser(protobufParser);
