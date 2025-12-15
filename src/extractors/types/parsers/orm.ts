/**
 * ORM Model Parser
 *
 * Extracts type definitions from ORM model definitions across multiple
 * frameworks. These often represent the canonical database schema.
 *
 * Supports:
 * - Django models (Python)
 * - SQLAlchemy models (Python)
 * - GORM models (Go)
 * - Prisma Client types (TypeScript)
 * - TypeORM entities (TypeScript)
 * - Drizzle schemas (TypeScript)
 */

import type { TypeDefinition, FieldDefinition, TypeRef } from "../schema.js";
import type { ParseContext } from "./index.js";
import { getLineNumber } from "./index.js";

// =============================================================================
// Django Models (Python)
// =============================================================================

/**
 * Map Django field types to generic types
 */
function djangoFieldToTypeRef(fieldType: string): TypeRef {
  const fieldMap: Record<string, string> = {
    "CharField": "string",
    "TextField": "string",
    "EmailField": "string",
    "URLField": "string",
    "SlugField": "string",
    "UUIDField": "UUID",
    "IntegerField": "i32",
    "BigIntegerField": "i64",
    "SmallIntegerField": "i16",
    "PositiveIntegerField": "u32",
    "FloatField": "f64",
    "DecimalField": "decimal",
    "BooleanField": "bool",
    "NullBooleanField": "bool",
    "DateField": "date",
    "DateTimeField": "datetime",
    "TimeField": "time",
    "DurationField": "duration",
    "FileField": "file",
    "ImageField": "image",
    "BinaryField": "bytes",
    "JSONField": "json",
    "ForeignKey": "reference",
    "OneToOneField": "reference",
    "ManyToManyField": "reference[]",
  };

  const baseName = fieldType.split("(")[0];
  return {
    name: fieldMap[baseName] || baseName,
    raw: fieldType,
    optional: fieldType.includes("null=True"),
  };
}

export function parseDjangoModels(ctx: ParseContext): TypeDefinition[] {
  const types: TypeDefinition[] = [];
  const { content, file } = ctx;

  // Check for Django imports
  if (!content.includes("from django.db import models") && !content.includes("from django.db.models import")) {
    return types;
  }

  // Match class definitions that inherit from models.Model
  const classPattern = /class\s+(\w+)\s*\(\s*(?:models\.Model|[\w.]*Model)\s*\)\s*:/g;
  let match;

  while ((match = classPattern.exec(content)) !== null) {
    const name = match[1];
    const line = getLineNumber(content, match.index);

    // Find the class body
    const afterClass = content.slice(match.index + match[0].length);
    const fields = parseDjangoFields(afterClass);

    types.push({
      name,
      kind: "struct",
      file,
      line,
      language: "python",
      visibility: "public",
      fields,
      decorators: ["django", "orm"],
    });
  }

  return types;
}

function parseDjangoFields(classBody: string): FieldDefinition[] {
  const fields: FieldDefinition[] = [];
  const lines = classBody.split("\n");
  const baseIndent = lines[0]?.match(/^(\s*)/)?.[1]?.length || 0;

  for (const line of lines) {
    const indent = line.match(/^(\s*)/)?.[1]?.length || 0;
    if (indent <= baseIndent && line.trim() && !line.trim().startsWith("#")) {
      // End of class body
      break;
    }

    const trimmed = line.trim();
    // Pattern: field_name = models.FieldType(...)
    const fieldMatch = trimmed.match(/^(\w+)\s*=\s*models\.(\w+)\s*\(/);
    if (fieldMatch) {
      const fieldName = fieldMatch[1];
      if (fieldName.startsWith("_")) continue; // Skip private

      // Extract the full field definition to check for null=True etc
      const typeRef = djangoFieldToTypeRef(fieldMatch[2] + trimmed.slice(trimmed.indexOf("(")));

      // Check for ForeignKey/related fields to extract the related model
      const relatedMatch = trimmed.match(/(?:ForeignKey|OneToOneField|ManyToManyField)\s*\(\s*['"]?(\w+)['"]?/);
      if (relatedMatch) {
        typeRef.generics = [{ name: relatedMatch[1], raw: relatedMatch[1] }];
      }

      fields.push({
        name: fieldName,
        typeRef,
        optional: trimmed.includes("null=True") || trimmed.includes("blank=True"),
      });
    }
  }

  return fields;
}

// =============================================================================
// SQLAlchemy Models (Python)
// =============================================================================

function sqlalchemyTypeToTypeRef(colType: string): TypeRef {
  const typeMap: Record<string, string> = {
    "String": "string",
    "Text": "string",
    "Integer": "i32",
    "BigInteger": "i64",
    "SmallInteger": "i16",
    "Float": "f64",
    "Numeric": "decimal",
    "Boolean": "bool",
    "Date": "date",
    "DateTime": "datetime",
    "Time": "time",
    "LargeBinary": "bytes",
    "JSON": "json",
    "UUID": "UUID",
    "Enum": "enum",
  };

  const baseName = colType.split("(")[0];
  return {
    name: typeMap[baseName] || baseName,
    raw: colType,
  };
}

export function parseSQLAlchemyModels(ctx: ParseContext): TypeDefinition[] {
  const types: TypeDefinition[] = [];
  const { content, file } = ctx;

  // Check for SQLAlchemy imports
  if (!content.includes("from sqlalchemy") && !content.includes("import sqlalchemy")) {
    return types;
  }

  // Match class definitions with SQLAlchemy base
  const classPattern = /class\s+(\w+)\s*\(\s*(?:Base|DeclarativeBase|[\w.]*Base)\s*\)\s*:/g;
  let match;

  while ((match = classPattern.exec(content)) !== null) {
    const name = match[1];
    const line = getLineNumber(content, match.index);
    const afterClass = content.slice(match.index + match[0].length);
    const fields = parseSQLAlchemyFields(afterClass);

    types.push({
      name,
      kind: "struct",
      file,
      line,
      language: "python",
      visibility: "public",
      fields,
      decorators: ["sqlalchemy", "orm"],
    });
  }

  return types;
}

function parseSQLAlchemyFields(classBody: string): FieldDefinition[] {
  const fields: FieldDefinition[] = [];
  const lines = classBody.split("\n");
  const baseIndent = lines[0]?.match(/^(\s*)/)?.[1]?.length || 0;

  for (const line of lines) {
    const indent = line.match(/^(\s*)/)?.[1]?.length || 0;
    if (indent <= baseIndent && line.trim() && !line.trim().startsWith("#")) {
      break;
    }

    const trimmed = line.trim();

    // Pattern: column_name = Column(Type, ...)
    const columnMatch = trimmed.match(/^(\w+)\s*=\s*(?:Column|mapped_column)\s*\(\s*(\w+)/);
    if (columnMatch) {
      const fieldName = columnMatch[1];
      if (fieldName === "__tablename__" || fieldName.startsWith("_")) continue;

      fields.push({
        name: fieldName,
        typeRef: sqlalchemyTypeToTypeRef(columnMatch[2]),
        optional: trimmed.includes("nullable=True"),
      });
      continue;
    }

    // SQLAlchemy 2.0 style: column_name: Mapped[Type]
    const mappedMatch = trimmed.match(/^(\w+)\s*:\s*Mapped\[([^\]]+)\]/);
    if (mappedMatch) {
      const fieldName = mappedMatch[1];
      if (fieldName.startsWith("_")) continue;

      const typeStr = mappedMatch[2];
      fields.push({
        name: fieldName,
        typeRef: {
          name: typeStr.replace(/Optional\[|\]/g, ""),
          raw: typeStr,
          optional: typeStr.includes("Optional"),
        },
      });
    }
  }

  return fields;
}

// =============================================================================
// GORM Models (Go)
// =============================================================================

export function parseGORMModels(ctx: ParseContext): TypeDefinition[] {
  const types: TypeDefinition[] = [];
  const { content, file } = ctx;

  // Check for GORM import or gorm.Model embedding
  if (!content.includes("gorm.io/gorm") && !content.includes("gorm.Model")) {
    return types;
  }

  // Find structs that embed gorm.Model or have gorm tags
  const structPattern = /type\s+(\w+)\s+struct\s*\{([^}]+)\}/g;
  let match;

  while ((match = structPattern.exec(content)) !== null) {
    const name = match[1];
    const body = match[2];

    // Check if this is a GORM model
    if (!body.includes("gorm.Model") && !body.includes("`gorm:")) {
      continue;
    }

    const line = getLineNumber(content, match.index);
    const fields = parseGORMFields(body);

    types.push({
      name,
      kind: "struct",
      file,
      line,
      language: "go",
      visibility: name[0] === name[0].toUpperCase() ? "public" : "private",
      fields,
      decorators: ["gorm", "orm"],
    });
  }

  return types;
}

function parseGORMFields(body: string): FieldDefinition[] {
  const fields: FieldDefinition[] = [];
  const lines = body.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;

    // Skip gorm.Model embedding
    if (trimmed === "gorm.Model") continue;

    // Pattern: FieldName Type `gorm:"..."`
    const fieldMatch = trimmed.match(/^(\w+)\s+([\w.*\[\]]+)(?:\s+`[^`]*`)?/);
    if (fieldMatch) {
      const fieldName = fieldMatch[1];
      const fieldType = fieldMatch[2];

      // Skip embedded types
      if (!fieldType.includes(" ") && fieldType === fieldName) continue;

      fields.push({
        name: fieldName,
        typeRef: {
          name: fieldType.replace(/^\*/, ""),
          raw: fieldType,
          optional: fieldType.startsWith("*"),
          isCollection: fieldType.startsWith("[]"),
        },
        visibility: fieldName[0] === fieldName[0].toUpperCase() ? "public" : "private",
      });
    }
  }

  return fields;
}

// =============================================================================
// TypeORM Entities (TypeScript)
// =============================================================================

export function parseTypeORMEntities(ctx: ParseContext): TypeDefinition[] {
  const types: TypeDefinition[] = [];
  const { content, file } = ctx;

  // Check for TypeORM decorators
  if (!content.includes("@Entity") && !content.includes("from 'typeorm'") && !content.includes('from "typeorm"')) {
    return types;
  }

  // Match @Entity() decorated classes
  const entityPattern = /@Entity\s*\([^)]*\)\s*(?:export\s+)?class\s+(\w+)/g;
  let match;

  while ((match = entityPattern.exec(content)) !== null) {
    const name = match[1];
    const line = getLineNumber(content, match.index);

    // Find class body
    const classStart = content.indexOf("{", match.index);
    if (classStart === -1) continue;

    let depth = 1;
    let i = classStart + 1;
    let body = "";

    while (i < content.length && depth > 0) {
      if (content[i] === "{") depth++;
      else if (content[i] === "}") depth--;
      if (depth > 0) body += content[i];
      i++;
    }

    const fields = parseTypeORMFields(body);

    types.push({
      name,
      kind: "struct",
      file,
      line,
      language: "typescript",
      visibility: "public",
      fields,
      decorators: ["typeorm", "orm", "entity"],
    });
  }

  return types;
}

function parseTypeORMFields(body: string): FieldDefinition[] {
  const fields: FieldDefinition[] = [];

  // Match @Column() decorated properties
  const columnPattern = /@(?:Column|PrimaryColumn|PrimaryGeneratedColumn|CreateDateColumn|UpdateDateColumn|DeleteDateColumn)\s*\([^)]*\)\s*(\w+)(?:\??)\s*:\s*([^;=\n]+)/g;
  let match;

  while ((match = columnPattern.exec(body)) !== null) {
    const fieldName = match[1];
    const fieldType = match[2].trim();

    fields.push({
      name: fieldName,
      typeRef: {
        name: fieldType.replace(/[|&\s]/g, ""),
        raw: fieldType,
        optional: body.slice(match.index, match.index + match[0].length).includes("?"),
      },
    });
  }

  // Match relation decorators
  const relationPattern = /@(?:OneToOne|OneToMany|ManyToOne|ManyToMany)\s*\([^)]*\)\s*(\w+)(?:\??)\s*:\s*([^;=\n]+)/g;
  while ((match = relationPattern.exec(body)) !== null) {
    const fieldName = match[1];
    const fieldType = match[2].trim();

    fields.push({
      name: fieldName,
      typeRef: {
        name: fieldType.replace(/[|&\s\[\]]/g, ""),
        raw: fieldType,
        isCollection: fieldType.includes("[]"),
      },
    });
  }

  return fields;
}

// =============================================================================
// Drizzle Schemas (TypeScript)
// =============================================================================

export function parseDrizzleSchemas(ctx: ParseContext): TypeDefinition[] {
  const types: TypeDefinition[] = [];
  const { content, file } = ctx;

  // Check for Drizzle imports
  if (!content.includes("drizzle-orm") && !content.includes("pgTable") && !content.includes("mysqlTable") && !content.includes("sqliteTable")) {
    return types;
  }

  // Match table definitions: export const users = pgTable('users', { ... })
  const tablePattern = /(?:export\s+)?const\s+(\w+)\s*=\s*(?:pg|mysql|sqlite)Table\s*\(\s*['"](\w+)['"]\s*,\s*\{/g;
  let match;

  while ((match = tablePattern.exec(content)) !== null) {
    const varName = match[1];
    const tableName = match[2];
    const line = getLineNumber(content, match.index);

    // Extract table body
    let depth = 1;
    let i = match.index + match[0].length;
    let body = "";

    while (i < content.length && depth > 0) {
      if (content[i] === "{") depth++;
      else if (content[i] === "}") depth--;
      if (depth > 0) body += content[i];
      i++;
    }

    const fields = parseDrizzleFields(body);

    types.push({
      name: toPascalCase(varName),
      kind: "struct",
      file,
      line,
      language: "typescript",
      visibility: "public",
      fields,
      decorators: ["drizzle", "orm", tableName],
    });
  }

  return types;
}

function parseDrizzleFields(body: string): FieldDefinition[] {
  const fields: FieldDefinition[] = [];

  // Split by commas at depth 0
  let depth = 0;
  let current = "";
  const parts: string[] = [];

  for (const char of body) {
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

  const drizzleTypeMap: Record<string, string> = {
    "text": "string",
    "varchar": "string",
    "char": "string",
    "integer": "i32",
    "bigint": "i64",
    "smallint": "i16",
    "serial": "i32",
    "bigserial": "i64",
    "boolean": "bool",
    "timestamp": "datetime",
    "date": "date",
    "time": "time",
    "json": "json",
    "jsonb": "json",
    "uuid": "UUID",
    "real": "f32",
    "doublePrecision": "f64",
    "decimal": "decimal",
    "numeric": "decimal",
  };

  for (const part of parts) {
    // Pattern: fieldName: type(...)
    const fieldMatch = part.match(/^(\w+)\s*:\s*(\w+)/);
    if (!fieldMatch) continue;

    const fieldName = fieldMatch[1];
    const drizzleType = fieldMatch[2];

    fields.push({
      name: fieldName,
      typeRef: {
        name: drizzleTypeMap[drizzleType] || drizzleType,
        raw: drizzleType,
        optional: part.includes(".notNull()") ? false : true,
      },
      optional: !part.includes(".notNull()"),
    });
  }

  return fields;
}

// =============================================================================
// Prisma Client Types (TypeScript)
// =============================================================================

export function parsePrismaTypes(ctx: ParseContext): TypeDefinition[] {
  const types: TypeDefinition[] = [];
  const { content, file } = ctx;

  // This parses the generated Prisma client types
  // Typically in node_modules/.prisma/client/index.d.ts or similar
  if (!file.includes("prisma") && !content.includes("@prisma/client")) {
    return types;
  }

  // Match Prisma model types (these appear in the generated client)
  // export type User = { id: number; email: string; ... }
  const modelPattern = /export\s+type\s+(\w+)\s*=\s*\{/g;
  let match;

  while ((match = modelPattern.exec(content)) !== null) {
    const name = match[1];
    // Skip internal Prisma types
    if (name.startsWith("$") || name.includes("Args") || name.includes("Payload")) continue;

    const line = getLineNumber(content, match.index);

    // Extract type body
    let depth = 1;
    let i = match.index + match[0].length;
    let body = "";

    while (i < content.length && depth > 0) {
      if (content[i] === "{") depth++;
      else if (content[i] === "}") depth--;
      if (depth > 0) body += content[i];
      i++;
    }

    const fields = parsePrismaFields(body);
    if (fields.length === 0) continue;

    types.push({
      name,
      kind: "struct",
      file,
      line,
      language: "typescript",
      visibility: "public",
      fields,
      decorators: ["prisma", "orm"],
    });
  }

  return types;
}

function parsePrismaFields(body: string): FieldDefinition[] {
  const fields: FieldDefinition[] = [];

  // Pattern: fieldName: Type or fieldName?: Type
  const fieldPattern = /(\w+)(\?)?:\s*([^;\n]+)/g;
  let match;

  while ((match = fieldPattern.exec(body)) !== null) {
    const fieldName = match[1];
    const optional = Boolean(match[2]);
    let fieldType = match[3].trim();

    // Clean up Prisma type wrappers
    fieldType = fieldType.replace(/\s*\|\s*null\s*$/, "");

    fields.push({
      name: fieldName,
      typeRef: {
        name: fieldType.replace(/[|&\s\[\]]/g, ""),
        raw: fieldType,
        optional,
        isCollection: fieldType.includes("[]"),
      },
      optional,
    });
  }

  return fields;
}

// =============================================================================
// Helpers
// =============================================================================

function toPascalCase(str: string): string {
  return str
    .replace(/[-_](.)/g, (_, c) => c.toUpperCase())
    .replace(/^(.)/, (_, c) => c.toUpperCase());
}

// =============================================================================
// Combined ORM Parser
// =============================================================================

/**
 * Parse all ORM models from a file
 */
export function parseORMModels(ctx: ParseContext): TypeDefinition[] {
  const { file } = ctx;
  const types: TypeDefinition[] = [];

  // Python ORMs
  if (file.endsWith(".py")) {
    types.push(...parseDjangoModels(ctx));
    types.push(...parseSQLAlchemyModels(ctx));
  }

  // Go ORMs
  if (file.endsWith(".go")) {
    types.push(...parseGORMModels(ctx));
  }

  // TypeScript ORMs
  if (file.endsWith(".ts") || file.endsWith(".tsx")) {
    types.push(...parseTypeORMEntities(ctx));
    types.push(...parseDrizzleSchemas(ctx));
    types.push(...parsePrismaTypes(ctx));
  }

  return types;
}

