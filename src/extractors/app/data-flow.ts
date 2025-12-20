import type { Extractor, ExtractionContext, ExtractionResult } from "../../lib/extractor-base.js";
import { registerExtractor } from "../../lib/extractor-base.js";

interface ServiceInfo {
  name: string;
  file: string;
  dependencies: string[];
}

interface DataFlowResult {
  services: ServiceInfo[];
  externalCalls: Array<{ file: string; line: number; target: string }>;
}

const dataFlowExtractor: Extractor = {
  name: "data_flow",
  description: "Lightweight service dependency hints from imports and HTTP calls",

  async canExtract(ctx: ExtractionContext): Promise<boolean> {
    const files = await ctx.gitManager.listFilesAtRef(ctx.repoPath, ctx.ref);
    return files.some((f) => 
      f.includes("/services/") || 
      f.includes("/api/") || 
      f.endsWith("Service.ts") ||
      // Rust projects
      (f.startsWith("src/") && f.endsWith(".rs")) ||
      f === "Cargo.toml"
    );
  },

  async extract(ctx: ExtractionContext): Promise<ExtractionResult> {
    const allFiles = await ctx.gitManager.listFilesAtRef(ctx.repoPath, ctx.ref);
    
    // JavaScript/TypeScript service files
    const jsServiceFiles = allFiles.filter((f) =>
      f.includes("/services/") || f.endsWith("Service.ts") || f.endsWith("Service.js")
    ).slice(0, 50);

    // Rust source files
    const rustFiles = allFiles.filter((f) =>
      f.startsWith("src/") && f.endsWith(".rs")
    ).slice(0, 50);

    const services: ServiceInfo[] = [];
    const externalCalls: Array<{ file: string; line: number; target: string }> = [];

    // Process JS/TS services
    for (const file of jsServiceFiles) {
      try {
        const content = await ctx.gitManager.getFileAtRef(ctx.repoPath, ctx.ref, file);
        const name = inferServiceName(file);
        const dependencies = findImports(content).map(inferServiceName);
        services.push({ name, file, dependencies });

        externalCalls.push(...findHttpCalls(content).map((target) => ({ file, line: 0, target })));
      } catch {
        // skip unreadable
      }
    }

    // Process Rust files
    for (const file of rustFiles) {
      try {
        const content = await ctx.gitManager.getFileAtRef(ctx.repoPath, ctx.ref, file);
        const name = inferRustModuleName(file);
        const dependencies = findRustImports(content);
        const description = extractRustAboutMe(content);
        
        services.push({ 
          name: description ? `${name} - ${description}` : name, 
          file, 
          dependencies 
        });

        externalCalls.push(...findHttpCalls(content).map((target) => ({ file, line: 0, target })));
        externalCalls.push(...findRustHttpCalls(content).map((target) => ({ file, line: 0, target })));
      } catch {
        // skip unreadable
      }
    }

    const data: DataFlowResult = {
      services,
      externalCalls,
    };

    return {
      extractor: this.name,
      repo: ctx.repoName,
      ref: ctx.ref,
      extractedAt: new Date(),
      data,
    };
  },
};

function inferServiceName(path: string): string {
  const parts = path.split("/");
  const filename = parts[parts.length - 1];
  return filename.replace(/\.(ts|js)$/, "").replace(/[^a-zA-Z0-9]+/g, " ").trim();
}

function inferRustModuleName(path: string): string {
  const parts = path.split("/");
  const filename = parts[parts.length - 1];
  return filename.replace(/\.rs$/, "").replace(/_/g, " ");
}

function extractRustAboutMe(content: string): string | undefined {
  const match = content.match(/\/\/\s*ABOUTME:\s*(.+)/);
  return match?.[1]?.trim();
}

function findImports(content: string): string[] {
  const imports: string[] = [];
  const importPattern = /import.*['"]([^'"}]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(content)) !== null) {
    imports.push(match[1]);
  }
  return imports;
}

function findRustImports(content: string): string[] {
  const imports: string[] = [];
  // use crate::module;
  const usePattern = /use\s+(?:crate::)?(\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = usePattern.exec(content)) !== null) {
    imports.push(match[1]);
  }
  // mod module;
  const modPattern = /mod\s+(\w+)/g;
  while ((match = modPattern.exec(content)) !== null) {
    imports.push(match[1]);
  }
  return [...new Set(imports)];
}

function findHttpCalls(content: string): string[] {
  const targets: string[] = [];
  const patterns = [
    /https?:\/\/[^'" )]+/g,
    /fetch\(['"]([^'"#]+)['"]/g,
    /axios\.(get|post|put|delete)\(['"]([^'"#]+)['"]/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const url = match[1] || match[2] || match[0];
      targets.push(url);
    }
  }
  return Array.from(new Set(targets));
}

function findRustHttpCalls(content: string): string[] {
  const targets: string[] = [];
  // Look for URL patterns in Rust
  const patterns = [
    /wss?:\/\/[^'" >\)]+/g,  // WebSocket URLs
    /https?:\/\/[^'" >\)]+/g,  // HTTP URLs
    /Url::parse\s*\(\s*["']([^"']+)["']/g,  // Url::parse("...")
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const url = match[1] || match[0];
      // Filter out placeholder URLs
      if (!url.includes("example.com") && !url.includes("localhost")) {
        targets.push(url);
      }
    }
  }
  return Array.from(new Set(targets));
}

registerExtractor(dataFlowExtractor);
export { dataFlowExtractor };
