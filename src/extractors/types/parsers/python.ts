/**
 * Python Type Parser (Tree-sitter)
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
import type { TypeParser, ParseContext } from "./index.js";
import {
  parseSource,
  findNodesOfType,
  findFirstNodeOfType,
  getChildByFieldName,
  getChildrenOfType,
  getNodeText,
  getNodeLine,
  parseTypeRef,
  parsePythonVisibility,
  extractPythonDecorators,
} from "./tree-sitter-utils.js";
import type Parser from "tree-sitter";

// =============================================================================
// Field Parsing
// =============================================================================

/**
 * Parse fields from a class body block.
 */
function parseClassFields(blockNode: Parser.SyntaxNode): FieldDefinition[] {
  const fields: FieldDefinition[] = [];

  // Look for expression_statements containing assignments with type annotations
  const exprStatements = getChildrenOfType(blockNode, "expression_statement");

  for (const stmt of exprStatements) {
    const assignment = findFirstNodeOfType(stmt, "assignment");
    if (!assignment) continue;

    // Check if this is a typed assignment (has a type annotation)
    const typeNode = findFirstNodeOfType(assignment, "type");
    if (!typeNode) continue;

    // Get the field name (first identifier in the assignment)
    const nameNode = findFirstNodeOfType(assignment, "identifier");
    if (!nameNode) continue;

    const name = getNodeText(nameNode);

    // Skip dunder methods and class-level constants
    if (name.startsWith("__") && name.endsWith("__")) continue;

    const typeText = getNodeText(typeNode);
    const parsed = parseTypeRef(typeText);

    // Check if there's a default value
    const hasDefault = assignment.children.some((c) => c.type === "=");

    fields.push({
      name,
      typeRef: {
        name: parsed.name,
        generics: parsed.generics,
        optional: parsed.optional || typeText.includes("Optional") || typeText.includes("| None"),
        isCollection: parsed.isCollection,
        raw: typeText,
      },
      optional: typeText.includes("Optional") || typeText.includes("| None") || hasDefault,
      visibility: parsePythonVisibility(name),
    });
  }

  return fields;
}

/**
 * Parse enum variants from a class body block.
 */
function parseEnumVariants(blockNode: Parser.SyntaxNode): VariantDefinition[] {
  const variants: VariantDefinition[] = [];

  const exprStatements = getChildrenOfType(blockNode, "expression_statement");

  for (const stmt of exprStatements) {
    const assignment = findFirstNodeOfType(stmt, "assignment");
    if (!assignment) continue;

    // Get the variant name
    const nameNode = findFirstNodeOfType(assignment, "identifier");
    if (!nameNode) continue;

    const name = getNodeText(nameNode);

    // Skip non-uppercase names (likely not enum values)
    if (name !== name.toUpperCase() && !name.match(/^[A-Z][A-Z0-9_]*$/)) continue;

    const variant: VariantDefinition = { name };

    // Try to get the value
    const valueNode = assignment.children.find(
      (c) => c.type === "string" || c.type === "integer" || c.type === "float"
    );

    if (valueNode) {
      if (valueNode.type === "string") {
        // Extract string content
        const stringContent = findFirstNodeOfType(valueNode, "string_content");
        if (stringContent) {
          variant.value = getNodeText(stringContent);
        }
      } else if (valueNode.type === "integer") {
        variant.value = parseInt(getNodeText(valueNode), 10);
      }
    }

    variants.push(variant);
  }

  return variants;
}

// =============================================================================
// Docstring Extraction
// =============================================================================

/**
 * Extract docstring from a class body.
 */
function extractDocstring(blockNode: Parser.SyntaxNode): string | undefined {
  // The first expression_statement in a block might be a docstring
  const firstStmt = blockNode.children.find((c) => c.type === "expression_statement");
  if (!firstStmt) return undefined;

  const stringNode = findFirstNodeOfType(firstStmt, "string");
  if (!stringNode) return undefined;

  // Check if it's a triple-quoted string (docstring)
  const stringStart = findFirstNodeOfType(stringNode, "string_start");
  if (!stringStart) return undefined;

  const startText = getNodeText(stringStart);
  if (!startText.startsWith('"""') && !startText.startsWith("'''")) return undefined;

  const stringContent = findFirstNodeOfType(stringNode, "string_content");
  if (!stringContent) return undefined;

  return getNodeText(stringContent).trim();
}

// =============================================================================
// Base Class Parsing
// =============================================================================

/**
 * Extract base classes from a class definition.
 */
function extractBaseClasses(classNode: Parser.SyntaxNode): string[] {
  const argList = findFirstNodeOfType(classNode, "argument_list");
  if (!argList) return [];

  const bases: string[] = [];
  const identifiers = findNodesOfType(argList, "identifier");

  for (const id of identifiers) {
    bases.push(getNodeText(id));
  }

  return bases;
}

/**
 * Determine the type kind based on decorators and base classes.
 */
function determineTypeKind(
  decorators: string[],
  bases: string[]
): { kind: TypeDefinition["kind"]; isEnum: boolean } {
  // Check decorators
  if (decorators.includes("dataclass") || decorators.includes("define")) {
    return { kind: "struct", isEnum: false };
  }

  // Check base classes
  const baseSet = new Set(bases);

  if (baseSet.has("TypedDict")) {
    return { kind: "struct", isEnum: false };
  }
  if (baseSet.has("NamedTuple")) {
    return { kind: "struct", isEnum: false };
  }
  if (baseSet.has("BaseModel")) {
    return { kind: "struct", isEnum: false }; // Pydantic
  }
  if (baseSet.has("Protocol")) {
    return { kind: "protocol", isEnum: false };
  }
  if (
    baseSet.has("Enum") ||
    baseSet.has("IntEnum") ||
    baseSet.has("StrEnum") ||
    baseSet.has("Flag") ||
    baseSet.has("IntFlag")
  ) {
    return { kind: "enum", isEnum: true };
  }

  return { kind: "class", isEnum: false };
}

/**
 * Filter base classes to get extends types (exclude special bases).
 */
function getExtendsTypes(bases: string[]): TypeRef[] | undefined {
  const specialBases = new Set([
    "TypedDict",
    "NamedTuple",
    "BaseModel",
    "Protocol",
    "Enum",
    "IntEnum",
    "StrEnum",
    "Flag",
    "IntFlag",
    "ABC",
    "object",
  ]);

  const extendsTypes = bases
    .filter((b) => !specialBases.has(b))
    .map((b) => ({ name: b, raw: b }));

  return extendsTypes.length > 0 ? extendsTypes : undefined;
}

// =============================================================================
// Main Parser
// =============================================================================

const pythonParser: TypeParser = {
  language: "python",
  extensions: [".py", ".pyi"],

  parse(ctx: ParseContext): TypeDefinition[] {
    const types: TypeDefinition[] = [];
    const { content, file, includePrivate } = ctx;

    let tree;
    try {
      tree = parseSource("python", content);
    } catch (error) {
      console.warn(`Failed to parse Python file ${file}:`, error);
      return [];
    }

    const rootNode = tree.rootNode;

    // Find all class definitions
    // We need to avoid duplicates - decorated classes appear both as class_definition
    // and inside decorated_definition. We track which ones we've seen.
    const classNodes: Parser.SyntaxNode[] = [];
    const seenNodes = new Set<number>();

    // Find all class_definition nodes
    const allClassDefs = findNodesOfType(rootNode, "class_definition");
    
    for (const classDef of allClassDefs) {
      // Skip if we've already processed this node
      if (seenNodes.has(classDef.id)) continue;
      seenNodes.add(classDef.id);
      classNodes.push(classDef);
    }

    // Process each class
    for (const classNode of classNodes) {
      const nameNode = findFirstNodeOfType(classNode, "identifier");
      if (!nameNode) continue;

      const name = getNodeText(nameNode);
      const visibility = parsePythonVisibility(name);

      if (!includePrivate && visibility === "private") continue;

      const line = getNodeLine(classNode);

      // Get decorators
      const decorators = extractPythonDecorators(classNode);

      // Get base classes
      const bases = extractBaseClasses(classNode);

      // Determine type kind
      const { kind, isEnum } = determineTypeKind(decorators, bases);

      // Get the block (class body)
      const blockNode = findFirstNodeOfType(classNode, "block");

      const typeDef: TypeDefinition = {
        name,
        kind,
        file,
        line,
        language: "python",
        visibility,
        decorators: decorators.length > 0 ? decorators : undefined,
        extends: getExtendsTypes(bases),
      };

      if (blockNode) {
        // Extract docstring
        typeDef.doc = extractDocstring(blockNode);

        // Extract fields or variants
        if (isEnum) {
          typeDef.variants = parseEnumVariants(blockNode);
        } else {
          const fields = parseClassFields(blockNode);
          if (fields.length > 0) {
            typeDef.fields = fields;
          }
        }
      }

      types.push(typeDef);
    }

    return types;
  },
};

export { pythonParser };
