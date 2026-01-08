/**
 * Go Type Parser (Tree-sitter)
 *
 * Extracts:
 * - struct definitions with fields
 * - interface definitions
 * - type aliases
 */

import type { TypeDefinition, FieldDefinition, TypeRef } from "../schema.js";
import type { TypeParser, ParseContext } from "./index.js";
import {
  parseSource,
  findNodesOfType,
  getChildrenOfType,
  getNodeText,
  getNodeLine,
  parseTypeRef,
  extractDocComment,
  parseGoVisibility,
} from "./tree-sitter-utils.js";
import type Parser from "tree-sitter";

// =============================================================================
// Field Parsing
// =============================================================================

/**
 * Parse fields from a field_declaration_list node.
 */
function parseStructFields(fieldListNode: Parser.SyntaxNode): FieldDefinition[] {
  const fields: FieldDefinition[] = [];
  const fieldNodes = getChildrenOfType(fieldListNode, "field_declaration");

  for (const fieldNode of fieldNodes) {
    // Get field names (can be multiple: Name1, Name2 Type)
    const fieldIds = findNodesOfType(fieldNode, "field_identifier");

    // Get the type node
    const typeNode = findTypeNode(fieldNode);
    if (!typeNode) continue;

    const typeText = getNodeText(typeNode);
    const parsed = parseTypeRef(typeText);

    // Handle embedded types (no field identifier, just a type)
    if (fieldIds.length === 0) {
      // Embedded type - use the type name as the field name
      const typeName = parsed.name;
      fields.push({
        name: typeName,
        typeRef: {
          name: parsed.name,
          generics: parsed.generics,
          optional: typeText.startsWith("*"),
          isCollection: parsed.isCollection,
          raw: typeText,
        },
        visibility: parseGoVisibility(typeName),
      });
      continue;
    }

    // Regular fields
    for (const fieldId of fieldIds) {
      const name = getNodeText(fieldId);
      fields.push({
        name,
        typeRef: {
          name: parsed.name,
          generics: parsed.generics,
          optional: typeText.startsWith("*"),
          isCollection: parsed.isCollection || typeText.startsWith("[]"),
          raw: typeText,
        },
        visibility: parseGoVisibility(name),
      });
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
    "pointer_type",
    "array_type",
    "slice_type",
    "map_type",
    "channel_type",
    "function_type",
    "struct_type",
    "interface_type",
    "qualified_type",
    "generic_type",
  ];

  for (const child of node.children) {
    if (typeNodeTypes.includes(child.type)) {
      return child;
    }
  }
  return null;
}

// =============================================================================
// Interface Method Parsing
// =============================================================================

/**
 * Extract method signatures from an interface.
 */
function parseInterfaceMethods(interfaceNode: Parser.SyntaxNode): FieldDefinition[] {
  const methods: FieldDefinition[] = [];
  const methodNodes = findNodesOfType(interfaceNode, "method_elem");

  for (const methodNode of methodNodes) {
    const nameNode = findNodesOfType(methodNode, "field_identifier")[0];
    if (!nameNode) continue;

    const name = getNodeText(nameNode);

    // Get return type if present
    const returnType = findTypeNode(methodNode);
    const typeText = returnType ? getNodeText(returnType) : "void";

    methods.push({
      name,
      typeRef: {
        name: typeText,
        raw: typeText,
      },
      visibility: parseGoVisibility(name),
    });
  }

  return methods;
}

// =============================================================================
// Generic Parameters (Go 1.18+)
// =============================================================================

/**
 * Extract generic type parameters from a type_parameter_list node.
 */
function extractGenerics(node: Parser.SyntaxNode): string[] | undefined {
  const typeParams = findNodesOfType(node, "type_parameter_list")[0];
  if (!typeParams) return undefined;

  const generics: string[] = [];
  const paramDecls = findNodesOfType(typeParams, "type_parameter_declaration");

  for (const decl of paramDecls) {
    const identifiers = findNodesOfType(decl, "identifier");
    for (const id of identifiers) {
      generics.push(getNodeText(id));
    }
  }

  return generics.length > 0 ? generics : undefined;
}

// =============================================================================
// Main Parser
// =============================================================================

const goParser: TypeParser = {
  language: "go",
  extensions: [".go"],

  parse(ctx: ParseContext): TypeDefinition[] {
    const types: TypeDefinition[] = [];
    const { content, file, includePrivate } = ctx;

    let tree;
    try {
      tree = parseSource("go", content);
    } catch (error) {
      console.warn(`Failed to parse Go file ${file}:`, error);
      return [];
    }

    const rootNode = tree.rootNode;

    // Find all type declarations
    const typeDecls = findNodesOfType(rootNode, "type_declaration");

    for (const typeDecl of typeDecls) {
      // A type_declaration can contain multiple type_spec or type_alias nodes
      const typeSpecs = findNodesOfType(typeDecl, "type_spec");
      const typeAliases = findNodesOfType(typeDecl, "type_alias");

      // ==========================================================================
      // Type Specs (struct, interface, or named type)
      // ==========================================================================
      for (const typeSpec of typeSpecs) {
        const nameNode = findNodesOfType(typeSpec, "type_identifier")[0];
        if (!nameNode) continue;

        const name = getNodeText(nameNode);
        const visibility = parseGoVisibility(name);

        if (!includePrivate && visibility === "private") continue;

        const line = getNodeLine(typeSpec);

        // Check what kind of type this is
        const structType = findNodesOfType(typeSpec, "struct_type")[0];
        const interfaceType = findNodesOfType(typeSpec, "interface_type")[0];

        if (structType) {
          // Struct type
          const fieldList = findNodesOfType(structType, "field_declaration_list")[0];
          const fields = fieldList ? parseStructFields(fieldList) : [];

          types.push({
            name,
            kind: "struct",
            file,
            line,
            language: "go",
            visibility,
            generics: extractGenerics(typeSpec),
            fields,
            doc: extractDocComment(typeDecl, content),
          });
        } else if (interfaceType) {
          // Interface type
          const methods = parseInterfaceMethods(interfaceType);

          // Check for embedded interfaces
          const embeddedTypes: TypeRef[] = [];
          const typeIds = getChildrenOfType(interfaceType, "type_identifier");
          for (const typeId of typeIds) {
            const typeName = getNodeText(typeId);
            embeddedTypes.push({
              name: typeName,
              raw: typeName,
            });
          }

          types.push({
            name,
            kind: "interface",
            file,
            line,
            language: "go",
            visibility,
            generics: extractGenerics(typeSpec),
            fields: methods.length > 0 ? methods : undefined,
            extends: embeddedTypes.length > 0 ? embeddedTypes : undefined,
            doc: extractDocComment(typeDecl, content),
          });
        } else {
          // Named type (type Status int)
          types.push({
            name,
            kind: "type_alias",
            file,
            line,
            language: "go",
            visibility,
            generics: extractGenerics(typeSpec),
            doc: extractDocComment(typeDecl, content),
          });
        }
      }

      // ==========================================================================
      // Type Aliases (type UserID = int64)
      // ==========================================================================
      for (const typeAlias of typeAliases) {
        const nameNode = findNodesOfType(typeAlias, "type_identifier")[0];
        if (!nameNode) continue;

        const name = getNodeText(nameNode);
        const visibility = parseGoVisibility(name);

        if (!includePrivate && visibility === "private") continue;

        const line = getNodeLine(typeAlias);

        types.push({
          name,
          kind: "type_alias",
          file,
          line,
          language: "go",
          visibility,
          doc: extractDocComment(typeDecl, content),
        });
      }
    }

    return types;
  },
};

export { goParser };
