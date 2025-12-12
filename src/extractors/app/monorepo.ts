/**
 * Monorepo Extractor
 * 
 * Detects and analyzes monorepo structures:
 * - Turborepo, pnpm workspaces, npm workspaces, Yarn workspaces
 * - Nx, Lerna
 * - Package dependencies and relationships
 */

import type { Extractor, ExtractionContext, ExtractionResult } from "../../lib/extractor-base.js";
import { registerExtractor } from "../../lib/extractor-base.js";

interface Package {
  name: string;
  path: string;
  type: "app" | "package" | "lib" | "config" | "unknown";
  language?: string;
  framework?: string;
  dependencies: string[];      // Internal workspace dependencies
  devDependencies: string[];   // Internal workspace devDependencies
  scripts: string[];           // Available npm scripts
}

interface MonorepoData {
  detected: boolean;
  tool: "turborepo" | "nx" | "lerna" | "pnpm" | "npm" | "yarn" | "unknown";
  rootConfig: {
    packageManager?: string;
    workspaces?: string[];
  };
  packages: Package[];
  apps: Package[];
  libs: Package[];
  dependencyGraph: Array<{ from: string; to: string; type: "dependency" | "devDependency" }>;
  summary: {
    totalPackages: number;
    totalApps: number;
    totalLibs: number;
    frameworks: string[];
    languages: string[];
  };
}

const monorepoExtractor: Extractor = {
  name: "monorepo",
  description: "Detect and analyze monorepo structure, packages, and internal dependencies",

  async canExtract(ctx: ExtractionContext): Promise<boolean> {
    const files = await ctx.gitManager.listFilesAtRef(ctx.repoPath, ctx.ref);
    
    // Check for monorepo indicators
    return files.some((f) =>
      f === "turbo.json" ||
      f === "pnpm-workspace.yaml" ||
      f === "nx.json" ||
      f === "lerna.json" ||
      f.match(/^packages\/[^/]+\/package\.json$/) ||
      f.match(/^apps\/[^/]+\/package\.json$/)
    );
  },

  async extract(ctx: ExtractionContext): Promise<ExtractionResult> {
    const files = await ctx.gitManager.listFilesAtRef(ctx.repoPath, ctx.ref);
    
    const data: MonorepoData = {
      detected: true,
      tool: "unknown",
      rootConfig: {},
      packages: [],
      apps: [],
      libs: [],
      dependencyGraph: [],
      summary: {
        totalPackages: 0,
        totalApps: 0,
        totalLibs: 0,
        frameworks: [],
        languages: [],
      },
    };

    // Detect monorepo tool
    if (files.includes("turbo.json")) {
      data.tool = "turborepo";
    } else if (files.includes("nx.json")) {
      data.tool = "nx";
    } else if (files.includes("lerna.json")) {
      data.tool = "lerna";
    } else if (files.includes("pnpm-workspace.yaml")) {
      data.tool = "pnpm";
    }

    // Parse root package.json for workspaces
    try {
      const rootPkg = await ctx.gitManager.getFileAtRef(ctx.repoPath, ctx.ref, "package.json");
      const pkg = JSON.parse(rootPkg);
      data.rootConfig.packageManager = pkg.packageManager;
      data.rootConfig.workspaces = pkg.workspaces;
    } catch {
      // No root package.json
    }

    // Parse pnpm-workspace.yaml if present
    if (files.includes("pnpm-workspace.yaml")) {
      try {
        const workspaceYaml = await ctx.gitManager.getFileAtRef(ctx.repoPath, ctx.ref, "pnpm-workspace.yaml");
        const packagesMatch = workspaceYaml.match(/packages:\s*\n((?:\s+-\s+.+\n?)+)/);
        if (packagesMatch) {
          const patterns = packagesMatch[1]
            .split("\n")
            .map((line) => line.replace(/^\s*-\s*['"]?/, "").replace(/['"]?\s*$/, ""))
            .filter(Boolean);
          data.rootConfig.workspaces = patterns;
        }
      } catch {
        // ignore
      }
    }

    // Find all package.json files
    const packageJsonFiles = files.filter((f) => 
      f.endsWith("package.json") && 
      f !== "package.json" &&
      !f.includes("node_modules")
    );

    // Collect all workspace package names first
    const workspacePackages = new Map<string, string>(); // name -> path

    for (const pkgFile of packageJsonFiles) {
      try {
        const content = await ctx.gitManager.getFileAtRef(ctx.repoPath, ctx.ref, pkgFile);
        const pkg = JSON.parse(content);
        if (pkg.name) {
          const pkgPath = pkgFile.replace("/package.json", "");
          workspacePackages.set(pkg.name, pkgPath);
        }
      } catch {
        // ignore invalid package.json
      }
    }

    // Process each package
    for (const pkgFile of packageJsonFiles) {
      try {
        const content = await ctx.gitManager.getFileAtRef(ctx.repoPath, ctx.ref, pkgFile);
        const pkg = JSON.parse(content);
        const pkgPath = pkgFile.replace("/package.json", "");
        
        const packageInfo = await analyzePackage(pkg, pkgPath, workspacePackages, ctx, files);
        data.packages.push(packageInfo);

        // Categorize
        if (packageInfo.type === "app") {
          data.apps.push(packageInfo);
        } else if (packageInfo.type === "lib" || packageInfo.type === "package") {
          data.libs.push(packageInfo);
        }

        // Build dependency graph
        for (const dep of packageInfo.dependencies) {
          data.dependencyGraph.push({ from: packageInfo.name, to: dep, type: "dependency" });
        }
        for (const dep of packageInfo.devDependencies) {
          data.dependencyGraph.push({ from: packageInfo.name, to: dep, type: "devDependency" });
        }

        // Collect frameworks/languages
        if (packageInfo.framework && !data.summary.frameworks.includes(packageInfo.framework)) {
          data.summary.frameworks.push(packageInfo.framework);
        }
        if (packageInfo.language && !data.summary.languages.includes(packageInfo.language)) {
          data.summary.languages.push(packageInfo.language);
        }
      } catch {
        // skip invalid packages
      }
    }

    // Update summary
    data.summary.totalPackages = data.packages.length;
    data.summary.totalApps = data.apps.length;
    data.summary.totalLibs = data.libs.length;

    return {
      extractor: this.name,
      repo: ctx.repoName,
      ref: ctx.ref,
      extractedAt: new Date(),
      data,
    };
  },
};

async function analyzePackage(
  pkg: Record<string, unknown>,
  pkgPath: string,
  workspacePackages: Map<string, string>,
  ctx: ExtractionContext,
  allFiles: string[]
): Promise<Package> {
  const name = (pkg.name as string) || pkgPath.split("/").pop() || "unknown";
  
  // Determine package type from path and content
  let type: Package["type"] = "unknown";
  if (pkgPath.startsWith("apps/") || pkgPath.includes("/apps/")) {
    type = "app";
  } else if (pkgPath.startsWith("packages/") || pkgPath.includes("/packages/")) {
    type = "package";
  } else if (pkgPath.startsWith("libs/") || pkgPath.includes("/libs/")) {
    type = "lib";
  } else if (pkgPath.includes("config") || name.includes("config") || name.includes("eslint") || name.includes("tsconfig")) {
    type = "config";
  }

  // Detect framework
  const deps = { ...(pkg.dependencies as Record<string, string> || {}), ...(pkg.devDependencies as Record<string, string> || {}) };
  let framework: string | undefined;
  let language: string | undefined = "javascript";

  if (deps["next"]) framework = "Next.js";
  else if (deps["nuxt"]) framework = "Nuxt";
  else if (deps["@remix-run/react"]) framework = "Remix";
  else if (deps["svelte"] || deps["@sveltejs/kit"]) framework = "Svelte";
  else if (deps["vue"]) framework = "Vue";
  else if (deps["react"]) framework = "React";
  else if (deps["express"]) framework = "Express";
  else if (deps["fastify"]) framework = "Fastify";
  else if (deps["nestjs"] || deps["@nestjs/core"]) framework = "NestJS";
  else if (deps["hono"]) framework = "Hono";

  // Detect TypeScript
  if (deps["typescript"] || allFiles.some((f) => f.startsWith(pkgPath) && f.endsWith(".ts"))) {
    language = "typescript";
  }

  // Find internal dependencies
  const internalDeps: string[] = [];
  const internalDevDeps: string[] = [];

  for (const [depName] of Object.entries(pkg.dependencies as Record<string, string> || {})) {
    if (workspacePackages.has(depName)) {
      internalDeps.push(depName);
    }
  }

  for (const [depName] of Object.entries(pkg.devDependencies as Record<string, string> || {})) {
    if (workspacePackages.has(depName)) {
      internalDevDeps.push(depName);
    }
  }

  // Get scripts
  const scripts = Object.keys(pkg.scripts as Record<string, string> || {});

  return {
    name,
    path: pkgPath,
    type,
    language,
    framework,
    dependencies: internalDeps,
    devDependencies: internalDevDeps,
    scripts,
  };
}

registerExtractor(monorepoExtractor);
export { monorepoExtractor };
