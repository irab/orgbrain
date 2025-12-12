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
    return files.some((f) => f.includes("/services/") || f.includes("/api/") || f.endsWith("Service.ts"));
  },

  async extract(ctx: ExtractionContext): Promise<ExtractionResult> {
    const allFiles = await ctx.gitManager.listFilesAtRef(ctx.repoPath, ctx.ref);
    const serviceFiles = allFiles.filter((f) =>
      f.includes("/services/") || f.endsWith("Service.ts") || f.endsWith("Service.js")
    ).slice(0, 50);

    const services: ServiceInfo[] = [];
    const externalCalls: Array<{ file: string; line: number; target: string }> = [];

    for (const file of serviceFiles) {
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

function findImports(content: string): string[] {
  const imports: string[] = [];
  const importPattern = /import.*['"]([^'"}]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(content)) !== null) {
    imports.push(match[1]);
  }
  return imports;
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

registerExtractor(dataFlowExtractor);
export { dataFlowExtractor };
