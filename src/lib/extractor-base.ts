import type { GitManager } from "./git-manager.js";

export interface ExtractionContext {
  repoName: string;
  repoPath: string;
  ref: string;
  refType: "branch" | "tag";
  gitManager: GitManager;
  config: Record<string, unknown>;
}

export interface ExtractionResult {
  extractor: string;
  repo: string;
  ref: string;
  extractedAt: Date;
  data: unknown;
}

export interface Extractor {
  name: string;
  description: string;
  canExtract(ctx: ExtractionContext): Promise<boolean>;
  extract(ctx: ExtractionContext): Promise<ExtractionResult>;
}

const extractors = new Map<string, Extractor>();

export function registerExtractor(extractor: Extractor): void {
  extractors.set(extractor.name, extractor);
}

export function getExtractor(name: string): Extractor | undefined {
  return extractors.get(name);
}

export function listExtractors(): Extractor[] {
  return Array.from(extractors.values());
}

export async function runExtractors(
  ctx: Omit<ExtractionContext, "config">,
  extractorConfigs: Array<{ name: string; config?: Record<string, unknown> }>
): Promise<ExtractionResult[]> {
  const results: ExtractionResult[] = [];

  for (const extractorConfig of extractorConfigs) {
    const extractor = getExtractor(extractorConfig.name);
    if (!extractor) {
      console.warn(`Unknown extractor: ${extractorConfig.name}`);
      continue;
    }

    const fullCtx: ExtractionContext = {
      ...ctx,
      config: extractorConfig.config || {},
    };

    try {
      if (await extractor.canExtract(fullCtx)) {
        const result = await extractor.extract(fullCtx);
        results.push(result);
      }
    } catch (error) {
      console.error(`Extractor ${extractorConfig.name} failed:`, error);
      results.push({
        extractor: extractorConfig.name,
        repo: ctx.repoName,
        ref: ctx.ref,
        extractedAt: new Date(),
        data: { error: String(error) },
      });
    }
  }

  return results;
}
