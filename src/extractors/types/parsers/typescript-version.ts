/**
 * TypeScript Version Detection and Compatibility
 * 
 * Handles detection of TypeScript versions across different repositories
 * and ensures AST parsing compatibility.
 */

import { promises as fs } from "fs";
import { join } from "path";

export interface TypeScriptConfig {
  /** Detected TypeScript version from package.json */
  version?: string;
  /** Target ES version from tsconfig.json */
  target?: string;
  /** Module system from tsconfig.json */
  module?: string;
  /** Whether strict mode is enabled */
  strict?: boolean;
}

/**
 * Detect TypeScript version from package.json
 */
export async function detectTypeScriptVersion(
  repoPath: string,
  ref: string,
  gitManager: { getFileAtRef: (repoPath: string, ref: string, file: string) => Promise<string> }
): Promise<string | undefined> {
  try {
    // Try package.json first
    const packageJsonContent = await gitManager.getFileAtRef(repoPath, ref, "package.json");
    const packageJson = JSON.parse(packageJsonContent);
    
    // Check dependencies and devDependencies
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
    const tsVersion = deps.typescript;
    
    if (tsVersion) {
      // Extract version number (handle ranges like "^5.0.0" or "~4.9.5")
      const match = tsVersion.match(/(\d+)\.(\d+)\.(\d+)/);
      if (match) {
        return `${match[1]}.${match[2]}.${match[3]}`;
      }
      // Handle ranges - extract minimum version
      const rangeMatch = tsVersion.match(/[>=<^~]*(\d+)\.(\d+)/);
      if (rangeMatch) {
        return `${rangeMatch[1]}.${rangeMatch[2]}.0`;
      }
    }
  } catch {
    // File doesn't exist or can't be parsed
  }
  
  return undefined;
}

/**
 * Read tsconfig.json to understand compilation target
 */
export async function readTsConfig(
  repoPath: string,
  ref: string,
  gitManager: { getFileAtRef: (repoPath: string, ref: string, file: string) => Promise<string> }
): Promise<TypeScriptConfig | undefined> {
  const configFiles = ["tsconfig.json", "tsconfig.base.json"];
  
  for (const configFile of configFiles) {
    try {
      const content = await gitManager.getFileAtRef(repoPath, ref, configFile);
      const config = JSON.parse(content);
      
      // Handle extends
      let compilerOptions = config.compilerOptions || {};
      if (config.extends) {
        // For simplicity, we'll just use the base config
        // In production, you'd want to resolve the extends chain
      }
      
      return {
        target: compilerOptions.target,
        module: compilerOptions.module,
        strict: compilerOptions.strict,
      };
    } catch {
      // File doesn't exist or can't be parsed
      continue;
    }
  }
  
  return undefined;
}

/**
 * Get appropriate ScriptTarget for TypeScript compiler API
 * Maps tsconfig.json target to TypeScript ScriptTarget enum
 */
export function getScriptTarget(target?: string): number {
  // Default to ES2020 for modern codebases
  if (!target) return 5; // ES2020
  
  const targetMap: Record<string, number> = {
    "ES3": 0,
    "ES5": 1,
    "ES2015": 2, // ES6
    "ES2016": 3,
    "ES2017": 4,
    "ES2018": 5,
    "ES2019": 6,
    "ES2020": 7,
    "ES2021": 8,
    "ES2022": 9,
    "ESNext": 99, // Latest
  };
  
  return targetMap[target] ?? 7; // Default to ES2020
}

/**
 * Determine if TypeScript version is compatible with AST parsing
 * 
 * The TypeScript Compiler API is generally backward compatible for parsing,
 * but some newer syntax features might not parse correctly if the repo uses
 * an older version. This function helps determine if we should use a fallback.
 */
export function isVersionCompatible(version?: string): boolean {
  if (!version) return true; // Assume compatible if unknown
  
  const [major, minor] = version.split(".").map(Number);
  
  // TypeScript 3.0+ is generally safe for AST parsing
  // Older versions might have issues with newer syntax
  if (major < 3) return false;
  
  return true;
}

