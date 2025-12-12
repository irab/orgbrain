import type { Extractor, ExtractionContext, ExtractionResult } from "../../lib/extractor-base.js";
import { registerExtractor } from "../../lib/extractor-base.js";

interface TerraformSummary {
  files: string[];
  resources: number;
  modules: number;
  providers: string[];
}

const terraformExtractor: Extractor = {
  name: "terraform",
  description: "Summarize Terraform files, resources, modules, and providers",

  async canExtract(ctx: ExtractionContext): Promise<boolean> {
    const files = await ctx.gitManager.listFilesAtRef(ctx.repoPath, ctx.ref);
    return files.some((f) => f.endsWith(".tf"));
  },

  async extract(ctx: ExtractionContext): Promise<ExtractionResult> {
    const files = await ctx.gitManager.listFilesAtRef(ctx.repoPath, ctx.ref, "*.tf");
    const limited = files.slice(0, 200);

    const providers = new Set<string>();
    let resources = 0;
    let modules = 0;

    for (const file of limited) {
      try {
        const content = await ctx.gitManager.getFileAtRef(ctx.repoPath, ctx.ref, file);
        resources += countMatches(content, /resource\s+"[^"]+"\s+"[^"]+"/g);
        modules += countMatches(content, /module\s+"[^"]+"/g);
        for (const p of findProviders(content)) providers.add(p);
      } catch {
        // ignore unreadable
      }
    }

    const data: TerraformSummary = {
      files: limited,
      resources,
      modules,
      providers: Array.from(providers).sort(),
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

function countMatches(content: string, pattern: RegExp): number {
  return (content.match(pattern) || []).length;
}

function findProviders(content: string): string[] {
  const providers: string[] = [];
  const providerPattern = /provider\s+"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = providerPattern.exec(content)) !== null) {
    providers.push(match[1]);
  }
  return providers;
}

registerExtractor(terraformExtractor);
export { terraformExtractor };
