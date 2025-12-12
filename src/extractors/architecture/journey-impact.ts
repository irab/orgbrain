import type { Extractor, ExtractionContext, ExtractionResult } from "../../lib/extractor-base.js";
import { registerExtractor } from "../../lib/extractor-base.js";

interface JourneyDoc {
  title: string;
  file: string;
  summary?: string;
  services: string[];
  screens: string[];
}

interface JourneyImpactData {
  journeys: JourneyDoc[];
  screens: string[];
  services: string[];
}

const journeyImpactExtractor: Extractor = {
  name: "journey_impact",
  description: "Best-effort mapping of user journeys/docs to screens and services",

  async canExtract(ctx: ExtractionContext): Promise<boolean> {
    const files = await ctx.gitManager.listFilesAtRef(ctx.repoPath, ctx.ref);
    return files.some((f) =>
      f.toLowerCase().includes("journey") ||
      f.toLowerCase().includes("flows/") ||
      f.toLowerCase().includes("docs/") ||
      f.includes("/screens/") || f.includes("/pages/")
    );
  },

  async extract(ctx: ExtractionContext): Promise<ExtractionResult> {
    const files = await ctx.gitManager.listFilesAtRef(ctx.repoPath, ctx.ref);

    const journeyDocs = files.filter((f) =>
      f.match(/\.(md|mdx)$/) && (f.toLowerCase().includes("journey") || f.toLowerCase().includes("flow"))
    ).slice(0, 50);

    const screenFiles = files.filter((f) =>
      f.includes("/screens/") || f.includes("/pages/") || f.includes("/views/")
    ).slice(0, 100);

    const serviceFiles = files.filter((f) =>
      f.includes("/services/") || f.endsWith("Service.ts") || f.endsWith("Service.js")
    ).slice(0, 100);

    const screens = screenFiles.map(extractName);
    const services = serviceFiles.map(extractName);

    const journeys: JourneyDoc[] = [];

    for (const file of journeyDocs) {
      try {
        const content = await ctx.gitManager.getFileAtRef(ctx.repoPath, ctx.ref, file);
        const title = extractTitle(content) || extractName(file);
        const summary = summarize(content);
        const linkedScreens = screens.filter((s) => content.includes(s));
        const linkedServices = services.filter((s) => content.includes(s));
        journeys.push({
          title,
          file,
          summary,
          screens: linkedScreens,
          services: linkedServices,
        });
      } catch {
        // skip unreadable
      }
    }

    const data: JourneyImpactData = {
      journeys,
      screens: Array.from(new Set(screens)).sort(),
      services: Array.from(new Set(services)).sort(),
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

function extractName(path: string): string {
  const parts = path.split("/");
  const filename = parts[parts.length - 1];
  return filename
    .replace(/\.(md|mdx|ts|js|tsx|vue|dart)$/i, "")
    .replace(/[_-]/g, " ")
    .trim();
}

function extractTitle(content: string): string | undefined {
  const m = content.match(/^#\s+(.+)$/m);
  return m?.[1]?.trim();
}

function summarize(content: string): string | undefined {
  const first = content.split(/\n\n+/)[0]?.trim();
  if (!first) return undefined;
  return first.slice(0, 280);
}

registerExtractor(journeyImpactExtractor);
export { journeyImpactExtractor };
