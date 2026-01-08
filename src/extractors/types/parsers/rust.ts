/**
 * Rust Type Parser (Tree-sitter)
 *
 * Extracts:
 * - struct definitions with fields (including tuple structs)
 * - enum definitions with variants (including associated data)
 * - trait definitions
 * - type aliases
 */

import type { TypeDefinition, FieldDefinition, VariantDefinition, TypeRef } from "../schema.js";
import type { TypeParser, ParseContext } from "./index.js";
import {
  parseSource,
  findNodesOfType,
  getChildByFieldName,
  getChildrenOfType,
  getNodeText,
  getNodeLine,
  parseTypeRef,
  extractDocComment,
  parseRustVisibility,
  extractRustAttributes,
} from "./tree-sitter-utils.js";
import type Parser from "tree-sitter";

// =============================================================================
// Field Parsing
// =============================================================================

/**
 * Parse fields from a field_declaration_list node (struct fields).
 */
function parseStructFields(fieldListNode: Parser.SyntaxNode): FieldDefinition[] {
  const fields: FieldDefinition[] = [];
  const fieldNodes = getChildrenOfType(fieldListNode, "field_declaration");

  for (const fieldNode of fieldNodes) {
    const nameNode = findNodesOfType(fieldNode, "field_identifier")[0];
    const visNode = findNodesOfType(fieldNode, "visibility_modifier")[0];

    // Get the type - could be various type nodes
    const typeNode = findTypeNode(fieldNode);
    if (!nameNode || !typeNode) continue;

    const typeText = getNodeText(typeNode);
    const parsed = parseTypeRef(typeText);

    fields.push({
      name: getNodeText(nameNode),
      typeRef: {
        name: parsed.name,
        generics: parsed.generics,
        optional: parsed.optional,
        isCollection: parsed.isCollection,
        raw: parsed.raw,
      },
      visibility: parseRustVisibility(visNode),
    });
  }

  return fields;
}

/**
 * Parse fields from an ordered_field_declaration_list node (tuple struct fields).
 */
function parseTupleFields(orderedListNode: Parser.SyntaxNode): FieldDefinition[] {
  const fields: FieldDefinition[] = [];
  let index = 0;

  for (const child of orderedListNode.children) {
    // Skip punctuation
    if (child.type === "(" || child.type === ")" || child.type === ",") continue;

    // Check for visibility modifier
    let visNode: Parser.SyntaxNode | null = null;
    let typeNode = child;

    if (child.type === "visibility_modifier") {
      visNode = child;
      continue; // The next node will be the type
    }

    // Type nodes
    if (isTypeNode(child)) {
      const typeText = getNodeText(child);
      const parsed = parseTypeRef(typeText);

      fields.push({
        name: `_${index}`,
        typeRef: {
          name: parsed.name,
          generics: parsed.generics,
          optional: parsed.optional,
          isCollection: parsed.isCollection,
          raw: parsed.raw,
        },
        visibility: parseRustVisibility(visNode),
      });
      index++;
    }
  }

  return fields;
}

/**
 * Find the type node within a field declaration.
 */
function findTypeNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const typeNodeTypes = [
    "type_identifier",
    "primitive_type",
    "generic_type",
    "reference_type",
    "pointer_type",
    "array_type",
    "tuple_type",
    "function_type",
    "scoped_type_identifier",
    "unit_type",
  ];

  for (const child of node.children) {
    if (typeNodeTypes.includes(child.type)) {
      return child;
    }
  }
  return null;
}

/**
 * Check if a node is a type node.
 */
function isTypeNode(node: Parser.SyntaxNode): boolean {
  const typeNodeTypes = [
    "type_identifier",
    "primitive_type",
    "generic_type",
    "reference_type",
    "pointer_type",
    "array_type",
    "tuple_type",
    "function_type",
    "scoped_type_identifier",
    "unit_type",
  ];
  return typeNodeTypes.includes(node.type);
}

// =============================================================================
// Enum Variant Parsing
// =============================================================================

/**
 * Parse enum variants from an enum_variant_list node.
 */
function parseEnumVariants(variantListNode: Parser.SyntaxNode): VariantDefinition[] {
  const variants: VariantDefinition[] = [];
  const variantNodes = getChildrenOfType(variantListNode, "enum_variant");

  for (const variantNode of variantNodes) {
    const nameNode = findNodesOfType(variantNode, "identifier")[0];
    if (!nameNode) continue;

    const variant: VariantDefinition = {
      name: getNodeText(nameNode),
    };

    // Check for struct-style fields: Variant { field: Type }
    const fieldList = findNodesOfType(variantNode, "field_declaration_list")[0];
    if (fieldList) {
      variant.fields = parseStructFields(fieldList);
    }

    // Check for tuple-style fields: Variant(Type1, Type2)
    const orderedList = findNodesOfType(variantNode, "ordered_field_declaration_list")[0];
    if (orderedList) {
      variant.fields = parseTupleFields(orderedList);
    }

    variants.push(variant);
  }

  return variants;
}

// =============================================================================
// Generic Parameters
// =============================================================================

/**
 * Extract generic type parameters from a type_parameters node.
 */
function extractGenerics(node: Parser.SyntaxNode): string[] | undefined {
  const typeParams = findNodesOfType(node, "type_parameters")[0];
  if (!typeParams) return undefined;

  const generics: string[] = [];
  const paramNodes = findNodesOfType(typeParams, ["type_identifier", "constrained_type_parameter"]);

  for (const param of paramNodes) {
    if (param.type === "type_identifier") {
      generics.push(getNodeText(param));
    } else if (param.type === "constrained_type_parameter") {
      // Get just the type name, not the bounds
      const typeId = findNodesOfType(param, "type_identifier")[0];
      if (typeId) generics.push(getNodeText(typeId));
    }
  }

  return generics.length > 0 ? generics : undefined;
}

// =============================================================================
// Trait Bounds (extends)
// =============================================================================

/**
 * Extract supertraits from a trait definition.
 */
function extractSupertraits(node: Parser.SyntaxNode): TypeRef[] | undefined {
  // Look for trait_bounds after the trait name
  const traitBounds = findNodesOfType(node, "trait_bounds")[0];
  if (!traitBounds) return undefined;

  const supertraits: TypeRef[] = [];
  const boundNodes = findNodesOfType(traitBounds, ["type_identifier", "generic_type", "scoped_type_identifier"]);

  for (const bound of boundNodes) {
    const text = getNodeText(bound);
    const parsed = parseTypeRef(text);
    supertraits.push({
      name: parsed.name,
      raw: text,
    });
  }

  return supertraits.length > 0 ? supertraits : undefined;
}

// =============================================================================
// Main Parser
// =============================================================================

const rustParser: TypeParser = {
  language: "rust",
  extensions: [".rs"],

  parse(ctx: ParseContext): TypeDefinition[] {
    const types: TypeDefinition[] = [];
    const { content, file, includePrivate } = ctx;

    let tree;
    try {
      tree = parseSource("rust", content);
    } catch (error) {
      console.warn(`Failed to parse Rust file ${file}:`, error);
      return [];
    }

    const rootNode = tree.rootNode;

    // ==========================================================================
    // Structs
    // ==========================================================================
    const structNodes = findNodesOfType(rootNode, "struct_item");
    for (const structNode of structNodes) {
      const nameNode = findNodesOfType(structNode, "type_identifier")[0];
      if (!nameNode) continue;

      const visNode = findNodesOfType(structNode, "visibility_modifier")[0];
      const visibility = parseRustVisibility(visNode);

      if (!includePrivate && visibility === "private") continue;

      const name = getNodeText(nameNode);
      const line = getNodeLine(structNode);

      // Parse fields - could be regular struct or tuple struct
      let fields: FieldDefinition[] = [];
      const fieldList = findNodesOfType(structNode, "field_declaration_list")[0];
      const orderedList = findNodesOfType(structNode, "ordered_field_declaration_list")[0];

      if (fieldList) {
        fields = parseStructFields(fieldList);
      } else if (orderedList) {
        fields = parseTupleFields(orderedList);
      }
      // Unit structs have no fields

      types.push({
        name,
        kind: "struct",
        file,
        line,
        language: "rust",
        visibility,
        generics: extractGenerics(structNode),
        fields,
        decorators: extractRustAttributes(structNode),
        doc: extractDocComment(structNode, content),
      });
    }

    // ==========================================================================
    // Enums
    // ==========================================================================
    const enumNodes = findNodesOfType(rootNode, "enum_item");
    for (const enumNode of enumNodes) {
      const nameNode = findNodesOfType(enumNode, "type_identifier")[0];
      if (!nameNode) continue;

      const visNode = findNodesOfType(enumNode, "visibility_modifier")[0];
      const visibility = parseRustVisibility(visNode);

      if (!includePrivate && visibility === "private") continue;

      const name = getNodeText(nameNode);
      const line = getNodeLine(enumNode);

      // Parse variants
      const variantList = findNodesOfType(enumNode, "enum_variant_list")[0];
      const variants = variantList ? parseEnumVariants(variantList) : [];

      types.push({
        name,
        kind: "enum",
        file,
        line,
        language: "rust",
        visibility,
        generics: extractGenerics(enumNode),
        variants,
        decorators: extractRustAttributes(enumNode),
        doc: extractDocComment(enumNode, content),
      });
    }

    // ==========================================================================
    // Traits
    // ==========================================================================
    const traitNodes = findNodesOfType(rootNode, "trait_item");
    for (const traitNode of traitNodes) {
      const nameNode = findNodesOfType(traitNode, "type_identifier")[0];
      if (!nameNode) continue;

      const visNode = findNodesOfType(traitNode, "visibility_modifier")[0];
      const visibility = parseRustVisibility(visNode);

      if (!includePrivate && visibility === "private") continue;

      const name = getNodeText(nameNode);
      const line = getNodeLine(traitNode);

      types.push({
        name,
        kind: "trait",
        file,
        line,
        language: "rust",
        visibility,
        generics: extractGenerics(traitNode),
        extends: extractSupertraits(traitNode),
        decorators: extractRustAttributes(traitNode),
        doc: extractDocComment(traitNode, content),
      });
    }

    // ==========================================================================
    // Type Aliases
    // ==========================================================================
    const typeNodes = findNodesOfType(rootNode, "type_item");
    for (const typeNode of typeNodes) {
      const nameNode = findNodesOfType(typeNode, "type_identifier")[0];
      if (!nameNode) continue;

      const visNode = findNodesOfType(typeNode, "visibility_modifier")[0];
      const visibility = parseRustVisibility(visNode);

      if (!includePrivate && visibility === "private") continue;

      const name = getNodeText(nameNode);
      const line = getNodeLine(typeNode);

      types.push({
        name,
        kind: "type_alias",
        file,
        line,
        language: "rust",
        visibility,
        generics: extractGenerics(typeNode),
        doc: extractDocComment(typeNode, content),
      });
    }

    return types;
  },
};

export { rustParser };
