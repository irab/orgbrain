/**
 * TypeScript AST Parser using TypeScript Compiler API
 *
 * Extracts:
 * - Type definitions (interfaces, classes, enums, type aliases)
 * - Function/method call sites for data flow analysis
 * - Method definitions and their signatures
 */

import * as ts from "typescript";
import type { TypeDefinition, FieldDefinition, VariantDefinition, TypeRef, CallDefinition } from "../schema.js";
import {
  type TypeParser,
  type ParseContext,
  parseTypeRef,
} from "./index.js";
import { detectTypeScriptVersion, readTsConfig, getScriptTarget, isVersionCompatible } from "./typescript-version.js";

interface ParseResult {
  types: TypeDefinition[];
  calls: CallDefinition[];
}

/**
 * Extract JSDoc comment from a node
 */
function getDocComment(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  const fullText = sourceFile.getFullText();
  const start = node.getFullStart();
  
  // Look for JSDoc comments before the node
  const before = fullText.slice(0, start);
  const lines = before.split("\n");
  
  const docLines: string[] = [];
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
    const line = lines[i].trim();
    if (line.endsWith("*/")) {
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
    if (line && !line.startsWith("//") && !line.startsWith("*")) {
      break;
    }
  }
  
  const doc = docLines.filter(Boolean).join(" ").trim();
  return doc || undefined;
}

/**
 * Convert TypeScript type to TypeRef
 */
function typeToTypeRef(type: ts.TypeNode, sourceFile: ts.SourceFile): TypeRef {
  const text = type.getText(sourceFile);
  const parsed = parseTypeRef(text);
  
  return {
    name: parsed.name,
    generics: parsed.generics,
    optional: parsed.optional,
    isCollection: parsed.isCollection,
    raw: parsed.raw,
  };
}

/**
 * Extract fields from a class/interface body
 */
function extractFields(
  members: ts.NodeArray<ts.TypeElement | ts.ClassElement>,
  sourceFile: ts.SourceFile
): FieldDefinition[] {
  const fields: FieldDefinition[] = [];
  
  for (const member of members) {
    // Property signatures (interfaces) or property declarations (classes)
    if (
      ts.isPropertySignature(member) ||
      ts.isPropertyDeclaration(member) ||
      ts.isPropertyAssignment(member)
    ) {
      const name = member.name && ts.isIdentifier(member.name) ? member.name.text : undefined;
      if (!name) continue;
      
      const typeNode = ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)
        ? member.type
        : undefined;
      
      if (!typeNode) continue;
      
      const typeRef = typeToTypeRef(typeNode, sourceFile);
      const questionToken = ts.isPropertySignature(member)
        ? member.questionToken
        : ts.isPropertyDeclaration(member)
        ? member.questionToken
        : undefined;
      
      const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
      const visibility = modifiers?.find((m) =>
        [ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword].includes(m.kind)
      );
      
      fields.push({
        name,
        typeRef,
        optional: !!questionToken,
        visibility: visibility
          ? (visibility.kind === ts.SyntaxKind.PublicKeyword
              ? "public"
              : visibility.kind === ts.SyntaxKind.PrivateKeyword
              ? "private"
              : "protected")
          : undefined,
        doc: getDocComment(member, sourceFile),
      });
    }
  }
  
  return fields;
}

/**
 * Extract enum variants
 */
function extractEnumMembers(
  members: ts.NodeArray<ts.EnumMember>,
  sourceFile: ts.SourceFile
): VariantDefinition[] {
  const variants: VariantDefinition[] = [];
  
  for (const member of members) {
    const name = member.name && ts.isIdentifier(member.name) ? member.name.text : undefined;
    if (!name) continue;
    
    const variant: VariantDefinition = { name };
    
    if (member.initializer) {
      if (ts.isStringLiteral(member.initializer)) {
        variant.value = member.initializer.text;
      } else if (ts.isNumericLiteral(member.initializer)) {
        variant.value = parseInt(member.initializer.text, 10);
      }
    }
    
    variant.doc = getDocComment(member, sourceFile);
    variants.push(variant);
  }
  
  return variants;
}

/**
 * Extract decorators from a node
 */
function extractDecorators(node: ts.Node): string[] {
  const decorators: string[] = [];
  if (ts.canHaveDecorators(node)) {
    const nodeDecorators = ts.getDecorators(node);
    if (nodeDecorators) {
      for (const decorator of nodeDecorators) {
        if (ts.isCallExpression(decorator.expression)) {
          const expr = decorator.expression.expression;
          if (ts.isIdentifier(expr)) {
            decorators.push(expr.text);
          }
        } else if (ts.isIdentifier(decorator.expression)) {
          decorators.push(decorator.expression.text);
        }
      }
    }
  }
  return decorators;
}

/**
 * Extract visibility from modifiers
 */
function extractVisibility(modifiers: readonly ts.Modifier[] | undefined): "public" | "private" | "protected" | "internal" | undefined {
  if (!modifiers) return undefined;
  
  for (const mod of modifiers) {
    if (mod.kind === ts.SyntaxKind.PublicKeyword) return "public";
    if (mod.kind === ts.SyntaxKind.PrivateKeyword) return "private";
    if (mod.kind === ts.SyntaxKind.ProtectedKeyword) return "protected";
  }
  
  return undefined;
}

/**
 * Extract call expression from a node
 */
function extractCallExpression(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  currentFunction: string
): CallDefinition | null {
  const expression = node.expression;
  let calleeName: string | undefined;
  
  if (ts.isIdentifier(expression)) {
    calleeName = expression.text;
  } else if (ts.isPropertyAccessExpression(expression)) {
    const prop = expression.name;
    if (ts.isIdentifier(prop)) {
      // Include object name if available (e.g., "service.process")
      const obj = expression.expression;
      if (ts.isIdentifier(obj)) {
        calleeName = `${obj.text}.${prop.text}`;
      } else {
        calleeName = prop.text;
      }
    }
  } else if (ts.isElementAccessExpression(expression)) {
    const arg = expression.argumentExpression;
    if (ts.isStringLiteral(arg) || ts.isNumericLiteral(arg)) {
      calleeName = arg.text;
    }
  }
  
  if (!calleeName) return null;
  
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const args: string[] = [];
  
  // Extract argument types/names
  for (const arg of node.arguments) {
    if (ts.isIdentifier(arg)) {
      args.push(arg.text);
    } else if (ts.isStringLiteral(arg)) {
      args.push(`"${arg.text}"`);
    } else if (ts.isNumericLiteral(arg)) {
      args.push(arg.text);
    } else {
      // Try to infer type from expression (limit length)
      const typeText = arg.getText(sourceFile).slice(0, 50);
      args.push(typeText);
    }
  }
  
  return {
    caller: currentFunction,
    callee: calleeName,
    file: sourceFile.fileName,
    line,
    args: args.length > 0 ? args : undefined,
  };
}

/**
 * Main AST parser function
 */
function parseAST(
  content: string,
  file: string,
  includePrivate: boolean,
  scriptTarget: ts.ScriptTarget = ts.ScriptTarget.Latest,
  useStrictMode: boolean = true
): ParseResult {
  const sourceFile = ts.createSourceFile(
    file,
    content,
    scriptTarget,
    useStrictMode,
    ts.ScriptKind.TS
  );
  
  const types: TypeDefinition[] = [];
  const calls: CallDefinition[] = [];
  let currentFunction = "<top-level>";
  
  function visit(node: ts.Node) {
    // Track current function context for call extraction
    if (ts.isFunctionDeclaration(node) && node.name) {
      currentFunction = node.name.text;
    } else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      currentFunction = node.name.text;
    } else if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      // Anonymous functions - keep parent context
    }
    
    // Extract call expressions
    if (ts.isCallExpression(node)) {
      const call = extractCallExpression(node, sourceFile, currentFunction);
      if (call) {
        calls.push(call);
      }
    }
    // Extract types
    if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.text;
      const modifiers = ts.getModifiers(node);
      const visibility = extractVisibility(modifiers);
      
      // Skip private interfaces if not including private
      if (!includePrivate && visibility === "private") {
        node.forEachChild(visit);
        return;
      }
      
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      
      // Extract extends clause
      const extendsTypes: TypeRef[] = [];
      if (node.heritageClauses) {
        for (const clause of node.heritageClauses) {
          if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
            for (const type of clause.types) {
              const typeText = type.getText(sourceFile);
              const parsed = parseTypeRef(typeText);
              extendsTypes.push({
                name: parsed.name,
                raw: parsed.raw,
              });
            }
          }
        }
      }
      
      const isExported = modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      
      types.push({
        name,
        kind: "interface",
        file,
        line,
        language: "typescript",
        visibility: visibility || (isExported ? "public" : "internal"),
        generics: node.typeParameters?.map((tp) => tp.name.text),
        extends: extendsTypes.length > 0 ? extendsTypes : undefined,
        fields: extractFields(node.members, sourceFile),
        doc: getDocComment(node, sourceFile),
      });
    } else if (ts.isClassDeclaration(node) && node.name) {
      const name = node.name.text;
      const modifiers = ts.getModifiers(node);
      const visibility = extractVisibility(modifiers);
      
      if (!includePrivate && visibility === "private") {
        node.forEachChild(visit);
        return;
      }
      
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      
      // Extract extends
      const extendsType: TypeRef[] | undefined = node.heritageClauses
        ?.find((c) => c.token === ts.SyntaxKind.ExtendsKeyword)
        ?.types.map((t) => {
          const parsed = parseTypeRef(t.getText(sourceFile));
          return { name: parsed.name, raw: parsed.raw };
        });
      
      // Extract implements
      const implementsTypes: TypeRef[] | undefined = node.heritageClauses
        ?.find((c) => c.token === ts.SyntaxKind.ImplementsKeyword)
        ?.types.map((t) => {
          const parsed = parseTypeRef(t.getText(sourceFile));
          return { name: parsed.name, raw: parsed.raw };
        });
      
      const isExported = modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      
      types.push({
        name,
        kind: "class",
        file,
        line,
        language: "typescript",
        visibility: visibility || (isExported ? "public" : "internal"),
        generics: node.typeParameters?.map((tp) => tp.name.text),
        extends: extendsType,
        implements: implementsTypes,
        fields: extractFields(node.members, sourceFile),
        decorators: extractDecorators(node),
        doc: getDocComment(node, sourceFile),
      });
    } else if (ts.isEnumDeclaration(node)) {
      const name = node.name.text;
      const modifiers = ts.getModifiers(node);
      const visibility = extractVisibility(modifiers);
      
      if (!includePrivate && visibility === "private") {
        node.forEachChild(visit);
        return;
      }
      
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      
      const isExported = modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      
      types.push({
        name,
        kind: "enum",
        file,
        line,
        language: "typescript",
        visibility: visibility || (isExported ? "public" : "internal"),
        variants: extractEnumMembers(node.members, sourceFile),
        doc: getDocComment(node, sourceFile),
      });
    } else if (ts.isTypeAliasDeclaration(node)) {
      const name = node.name.text;
      const modifiers = ts.getModifiers(node);
      const visibility = extractVisibility(modifiers);
      
      if (!includePrivate && visibility === "private") {
        node.forEachChild(visit);
        return;
      }
      
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      
      const isExported = modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      
      types.push({
        name,
        kind: "type_alias",
        file,
        line,
        language: "typescript",
        visibility: visibility || (isExported ? "public" : "internal"),
        generics: node.typeParameters?.map((tp) => tp.name.text),
        doc: getDocComment(node, sourceFile),
      });
    }
    
    // Recurse into children
    node.forEachChild(visit);
  }
  
  visit(sourceFile);
  
  return { types, calls };
}

const typescriptASTParser: TypeParser = {
  language: "typescript",
  extensions: [".ts", ".tsx", ".mts", ".cts"],
  
  parse(ctx: ParseContext): ParseResult {
    try {
      // Use detected TypeScript config if available, otherwise use defaults
      let scriptTarget: ts.ScriptTarget = ts.ScriptTarget.Latest;
      let useStrictMode = true;
      
      if (ctx.tsConfig) {
        // getScriptTarget returns a number that corresponds to ScriptTarget enum values
        scriptTarget = getScriptTarget(ctx.tsConfig.target) as ts.ScriptTarget;
        useStrictMode = ctx.tsConfig.strict ?? true;
      }
      
      return parseAST(ctx.content, ctx.file, ctx.includePrivate, scriptTarget, useStrictMode);
    } catch (error) {
      // Fallback: return empty result if AST parsing fails
      console.warn(`AST parsing failed for ${ctx.file}: ${error}`);
      return { types: [], calls: [] };
    }
  },
};

export { typescriptASTParser };

