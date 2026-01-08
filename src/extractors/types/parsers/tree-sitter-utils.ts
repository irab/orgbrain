/**
 * Tree-sitter Utilities
 *
 * Shared utilities for tree-sitter-based parsers.
 * Provides parser initialization, caching, and common AST traversal helpers.
 */

import { createRequire } from "module";
import Parser from "tree-sitter";
import type { TypeRef, Visibility } from "../schema.js";

// Create require function for loading native modules in ESM
const require = createRequire(import.meta.url);

// =============================================================================
// Parser Cache
// =============================================================================

const parserCache = new Map<string, Parser>();
const languageCache = new Map<string, Parser.Language>();

/**
 * Get or create a parser for a specific language.
 * Parsers are cached for reuse across multiple files.
 */
export function getParser(language: string): Parser {
  let parser = parserCache.get(language);
  if (!parser) {
    parser = new Parser();
    const lang = getLanguage(language);
    parser.setLanguage(lang);
    parserCache.set(language, parser);
  }
  return parser;
}

/**
 * Get the tree-sitter language grammar for a language.
 */
export function getLanguage(language: string): Parser.Language {
  let lang = languageCache.get(language);
  if (!lang) {
    switch (language) {
      case "rust":
        lang = require("tree-sitter-rust") as Parser.Language;
        break;
      case "go":
        lang = require("tree-sitter-go") as Parser.Language;
        break;
      case "python":
        lang = require("tree-sitter-python") as Parser.Language;
        break;
      default:
        throw new Error(`Unsupported tree-sitter language: ${language}`);
    }
    languageCache.set(language, lang);
  }
  return lang;
}

/**
 * Parse source code and return the syntax tree.
 */
export function parseSource(language: string, source: string): Parser.Tree {
  const parser = getParser(language);
  return parser.parse(source);
}

// =============================================================================
// AST Traversal Helpers
// =============================================================================

/**
 * Find all descendant nodes of a specific type.
 */
export function findNodesOfType(
  node: Parser.SyntaxNode,
  type: string | string[]
): Parser.SyntaxNode[] {
  const types = Array.isArray(type) ? type : [type];
  const results: Parser.SyntaxNode[] = [];

  function traverse(n: Parser.SyntaxNode) {
    if (types.includes(n.type)) {
      results.push(n);
    }
    for (const child of n.children) {
      traverse(child);
    }
  }

  traverse(node);
  return results;
}

/**
 * Find the first descendant node of a specific type.
 */
export function findFirstNodeOfType(
  node: Parser.SyntaxNode,
  type: string | string[]
): Parser.SyntaxNode | null {
  const types = Array.isArray(type) ? type : [type];

  function traverse(n: Parser.SyntaxNode): Parser.SyntaxNode | null {
    if (types.includes(n.type)) {
      return n;
    }
    for (const child of n.children) {
      const result = traverse(child);
      if (result) return result;
    }
    return null;
  }

  return traverse(node);
}

/**
 * Find a direct child node by field name.
 */
export function getChildByFieldName(
  node: Parser.SyntaxNode,
  fieldName: string
): Parser.SyntaxNode | null {
  return node.childForFieldName(fieldName);
}

/**
 * Get all direct children of a specific type.
 */
export function getChildrenOfType(
  node: Parser.SyntaxNode,
  type: string | string[]
): Parser.SyntaxNode[] {
  const types = Array.isArray(type) ? type : [type];
  return node.children.filter((child) => types.includes(child.type));
}

/**
 * Get the text content of a node.
 */
export function getNodeText(node: Parser.SyntaxNode | null): string {
  return node?.text ?? "";
}

/**
 * Get the line number (1-indexed) of a node.
 */
export function getNodeLine(node: Parser.SyntaxNode): number {
  return node.startPosition.row + 1;
}

// =============================================================================
// Type Parsing Helpers
// =============================================================================

/**
 * Parse a type string into a TypeRef structure.
 * Handles generics, optionals, and collections.
 */
export function parseTypeRef(raw: string): TypeRef {
  const trimmed = raw.trim();

  // Common optional patterns
  const optionalPatterns = [
    /^Option<(.+)>$/, // Rust Option
    /^Optional<(.+)>$/, // Java Optional
    /^(.+)\?$/, // TypeScript/Swift optional
    /^\?(.+)$/, // Dart nullable
    /^Optional\[(.+)\]$/, // Python Optional
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
    /^Vec<(.+)>$/, // Rust Vec
    /^Array<(.+)>$/, // TypeScript/Java Array
    /^List<(.+)>$/, // Dart/Java List
    /^Set<(.+)>$/, // Various Set
    /^\[(.+)\]$/, // Go/Swift array
    /^(.+)\[\]$/, // TypeScript array shorthand
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
  let generics: TypeRef[] | undefined;

  if (genericMatch) {
    name = genericMatch[1];
    // Simple split by comma (doesn't handle nested generics perfectly)
    generics = splitGenericArgs(genericMatch[2]).map((g) => ({
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

/**
 * Split generic arguments, respecting nested angle brackets.
 */
export function splitGenericArgs(args: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let current = "";

  for (const char of args) {
    if (char === "<") depth++;
    else if (char === ">") depth--;

    if (char === "," && depth === 0) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    result.push(current.trim());
  }

  return result;
}

// =============================================================================
// Doc Comment Extraction
// =============================================================================

/**
 * Extract doc comment from nodes preceding a definition.
 * Supports various comment styles (///, /**, #, etc.)
 */
export function extractDocComment(
  node: Parser.SyntaxNode,
  source: string
): string | undefined {
  // Look for comment nodes immediately preceding this node
  const startLine = node.startPosition.row;
  const lines = source.split("\n");
  const docLines: string[] = [];

  // Walk backwards from the line before the definition
  for (let i = startLine - 1; i >= Math.max(0, startLine - 20); i--) {
    const line = lines[i].trim();

    // Skip empty lines at the start
    if (docLines.length === 0 && line === "") continue;

    // Rust-style doc comments
    if (line.startsWith("///")) {
      docLines.unshift(line.slice(3).trim());
      continue;
    }

    // Python-style comments
    if (line.startsWith("#") && !line.startsWith("#[")) {
      docLines.unshift(line.slice(1).trim());
      continue;
    }

    // Go-style comments
    if (line.startsWith("//")) {
      docLines.unshift(line.slice(2).trim());
      continue;
    }

    // End of JS/TS block comment
    if (line.endsWith("*/")) {
      let j = i;
      while (j >= 0 && !lines[j].includes("/**") && !lines[j].includes("/*")) {
        const commentLine = lines[j]
          .replace(/^\s*\*\s?/, "")
          .replace(/\*\/$/, "")
          .trim();
        if (commentLine) docLines.unshift(commentLine);
        j--;
      }
      if (j >= 0) {
        const startComment = lines[j]
          .replace(/^\s*\/\*\*?\s?/, "")
          .trim();
        if (startComment) docLines.unshift(startComment);
      }
      break;
    }

    // If we hit a non-comment, non-empty line, stop
    if (line && !line.startsWith("@") && !line.startsWith("#[")) {
      break;
    }
  }

  const doc = docLines.filter(Boolean).join(" ").trim();
  return doc || undefined;
}

// =============================================================================
// Visibility Helpers
// =============================================================================

/**
 * Parse Rust visibility modifier.
 */
export function parseRustVisibility(visNode: Parser.SyntaxNode | null): Visibility {
  if (!visNode) return "private";
  const text = visNode.text;
  if (text === "pub") return "public";
  if (text.includes("pub(crate)")) return "internal";
  if (text.includes("pub(super)")) return "protected";
  return "private";
}

/**
 * Parse Go visibility based on identifier capitalization.
 */
export function parseGoVisibility(name: string): Visibility {
  if (!name) return "private";
  return name[0] === name[0].toUpperCase() ? "public" : "private";
}

/**
 * Parse Python visibility based on underscore prefix convention.
 */
export function parsePythonVisibility(name: string): Visibility {
  if (!name) return "public";
  if (name.startsWith("__") && !name.endsWith("__")) return "private";
  if (name.startsWith("_")) return "protected";
  return "public";
}

// =============================================================================
// Decorator/Attribute Extraction
// =============================================================================

/**
 * Extract decorators/attributes from nodes preceding a definition.
 */
export function extractDecorators(
  node: Parser.SyntaxNode,
  attributeType: string
): string[] {
  const decorators: string[] = [];
  let sibling = node.previousNamedSibling;

  while (sibling && sibling.type === attributeType) {
    // Extract the decorator name
    const text = sibling.text;
    // Handle different formats: #[derive(...)], @decorator, etc.
    const match = text.match(/#\[([^\]]+)\]/) || text.match(/@(\w+)/);
    if (match) {
      decorators.unshift(match[1]);
    } else {
      decorators.unshift(text);
    }
    sibling = sibling.previousNamedSibling;
  }

  return decorators;
}

/**
 * Extract Rust attributes (including derive macros).
 */
export function extractRustAttributes(node: Parser.SyntaxNode): string[] {
  const attributes: string[] = [];
  let sibling = node.previousNamedSibling;

  while (sibling && sibling.type === "attribute_item") {
    const attrContent = sibling.text.replace(/^#\[/, "").replace(/\]$/, "");
    attributes.unshift(attrContent);
    sibling = sibling.previousNamedSibling;
  }

  return attributes;
}

/**
 * Extract Python decorators.
 */
export function extractPythonDecorators(node: Parser.SyntaxNode): string[] {
  const decorators: string[] = [];

  // In Python, decorators are part of decorated_definition
  if (node.parent?.type === "decorated_definition") {
    const decoratorNodes = getChildrenOfType(node.parent, "decorator");
    for (const dec of decoratorNodes) {
      // Get the decorator name (first identifier or call)
      const nameNode = findFirstNodeOfType(dec, ["identifier", "call"]);
      if (nameNode) {
        if (nameNode.type === "call") {
          const funcName = getChildByFieldName(nameNode, "function");
          if (funcName) decorators.push(funcName.text);
        } else {
          decorators.push(nameNode.text);
        }
      }
    }
  }

  return decorators;
}

