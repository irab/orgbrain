import pLimit from "p-limit";
import type { GitManager } from "./git-manager.js";

// Concurrency limit for running extractors in parallel within a single repo
// Can be overridden via ORGBRAIN_EXTRACTOR_CONCURRENCY env var
const EXTRACTOR_CONCURRENCY = parseInt(process.env.ORGBRAIN_EXTRACTOR_CONCURRENCY || "8", 10);

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
  const limit = pLimit(EXTRACTOR_CONCURRENCY);

  // Build list of valid extractors with their contexts
  const extractorTasks = extractorConfigs
    .map((extractorConfig) => {
      const extractor = getExtractor(extractorConfig.name);
      if (!extractor) {
        console.warn(`Unknown extractor: ${extractorConfig.name}`);
        return null;
      }

      const fullCtx: ExtractionContext = {
        ...ctx,
        config: extractorConfig.config || {},
      };

      return { extractor, fullCtx, name: extractorConfig.name };
    })
    .filter(Boolean) as Array<{
      extractor: Extractor;
      fullCtx: ExtractionContext;
      name: string;
    }>;

  // Run extractors in parallel with concurrency limit
  const results = await Promise.all(
    extractorTasks.map(({ extractor, fullCtx, name }) =>
      limit(async (): Promise<ExtractionResult | null> => {
        try {
          if (await extractor.canExtract(fullCtx)) {
            return await extractor.extract(fullCtx);
          }
          return null;
        } catch (error) {
          console.error(`Extractor ${name} failed:`, error);
          return {
            extractor: name,
            repo: ctx.repoName,
            ref: ctx.ref,
            extractedAt: new Date(),
            data: { error: String(error) },
          };
        }
      })
    )
  );

  // Filter out nulls (extractors that couldn't extract or didn't apply)
  return results.filter(Boolean) as ExtractionResult[];
}
