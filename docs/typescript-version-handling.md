# TypeScript Version Handling in Orgbrain

## Overview

Orgbrain extracts knowledge from multiple repositories, each potentially using different versions of TypeScript. This document explains how orgbrain handles version differences and ensures accurate AST parsing across diverse codebases.

## Current Implementation

### 1. **Version Detection**

Orgbrain detects TypeScript versions at the repository level:

- **From `package.json`**: Reads the `typescript` dependency version (from both `dependencies` and `devDependencies`)
- **From `tsconfig.json`**: Reads compilation target, module system, and strict mode settings
- **Fallback**: If detection fails, uses sensible defaults (ES2020 target, strict mode enabled)

### 2. **AST Parsing Strategy**

The TypeScript Compiler API used by orgbrain (`typescript@5.6.3`) is **backward compatible** for parsing:

- ✅ **Parses older syntax**: TypeScript 5.6 can parse code written for TypeScript 3.0+
- ✅ **Handles newer syntax**: If a repo uses newer syntax (e.g., `satisfies` operator), it parses correctly
- ⚠️ **Semantic differences**: While parsing works, semantic meaning might differ (e.g., type narrowing behavior)

### 3. **Compatibility Matrix**

| Repo TS Version | Orgbrain TS Version | Parsing | Notes |
|----------------|---------------------|---------|-------|
| 3.0+ | 5.6.3 | ✅ Works | Full compatibility |
| 2.x | 5.6.3 | ⚠️ Partial | May miss some older syntax patterns |
| 4.x | 5.6.3 | ✅ Works | Full compatibility |
| 5.x | 5.6.3 | ✅ Works | Full compatibility |

### 4. **Target Version Handling**

Orgbrain respects `tsconfig.json` target settings:

```typescript
// If repo has tsconfig.json with target: "ES2018"
// Orgbrain uses ScriptTarget.ES2018 for parsing
// This ensures correct handling of:
// - Optional chaining (?.)
// - Nullish coalescing (??)
// - Top-level await
// - etc.
```

## How It Works

### Step 1: Repository-Level Detection

When extracting from a repository, orgbrain:

1. Checks for `package.json` to find TypeScript version
2. Checks for `tsconfig.json` to find compilation target
3. Caches this information for all files in that repo

### Step 2: Per-File Parsing

For each TypeScript file:

1. Uses detected `tsconfig.json` target (or default ES2020)
2. Parses with TypeScript Compiler API
3. Extracts types and call sites
4. Logs version info for debugging (if different from default)

### Step 3: Fallback Behavior

If version detection fails:

- Uses `ScriptTarget.Latest` (ES2022+)
- Enables strict mode by default
- Logs a warning but continues extraction

## Limitations & Future Improvements

### Current Limitations

1. **No Multi-Version Parsing**: Orgbrain uses a single TypeScript version (5.6.3) for all repos
2. **No Semantic Analysis**: Only parses syntax; doesn't perform type checking
3. **Limited Config Resolution**: Doesn't fully resolve `extends` chains in `tsconfig.json`

### Future Enhancements

1. **Version-Specific Parsers**: Could use different TypeScript versions for different repos (requires dynamic loading)
2. **Type Checking Integration**: Could use the TypeScript language service for semantic analysis
3. **Full Config Resolution**: Resolve `extends` chains and merged configs
4. **Syntax Feature Detection**: Detect which TypeScript features are used and adjust parsing accordingly

## Example Scenarios

### Scenario 1: Old Repo (TS 4.0)

```typescript
// Repo uses TypeScript 4.0
// package.json: "typescript": "^4.0.0"
// tsconfig.json: { "target": "ES2018" }

// Orgbrain:
// ✅ Detects version 4.0.0
// ✅ Uses ES2018 target for parsing
// ✅ Successfully extracts types and calls
```

### Scenario 2: Modern Repo (TS 5.5)

```typescript
// Repo uses TypeScript 5.5 with latest features
// package.json: "typescript": "^5.5.0"
// Uses: satisfies operator, const type parameters

// Orgbrain:
// ✅ Detects version 5.5.0
// ✅ Parses modern syntax correctly
// ✅ Extracts all types including new features
```

### Scenario 3: No Config

```typescript
// Repo has no tsconfig.json
// package.json: "typescript": "^4.9.0"

// Orgbrain:
// ✅ Detects version 4.9.0
// ⚠️ Uses default ES2020 target
// ✅ Still extracts types successfully
```

## Best Practices

### For Repository Maintainers

1. **Include `tsconfig.json`**: Helps orgbrain understand your compilation target
2. **Pin TypeScript Version**: Use exact versions (`"typescript": "5.0.0"`) rather than ranges for better detection
3. **Document Version Requirements**: Mention TypeScript version in README if critical

### For Orgbrain Users

1. **Monitor Warnings**: Check logs for version compatibility warnings
2. **Verify Extraction**: Review extracted types for accuracy, especially for older repos
3. **Report Issues**: If extraction fails for a specific TS version, report it

## Technical Details

### Version Detection Code

Located in: `src/extractors/types/parsers/typescript-version.ts`

Key functions:
- `detectTypeScriptVersion()`: Reads version from package.json
- `readTsConfig()`: Reads tsconfig.json settings
- `getScriptTarget()`: Maps tsconfig target to TypeScript ScriptTarget enum
- `isVersionCompatible()`: Checks if version is safe for parsing

### AST Parser

Located in: `src/extractors/types/parsers/typescript-ast.ts`

Uses:
- `ts.createSourceFile()`: Creates AST from source code
- `ts.ScriptTarget`: Determines language version for parsing
- Version-aware parsing based on detected config

## Conclusion

Orgbrain handles TypeScript version differences through:

1. **Backward-Compatible Parser**: TypeScript 5.6 can parse older code
2. **Config-Aware Parsing**: Respects tsconfig.json settings
3. **Graceful Fallbacks**: Works even when version detection fails
4. **Future-Proof**: Handles newer syntax as TypeScript evolves

This approach ensures accurate extraction across diverse codebases while maintaining simplicity and performance.

