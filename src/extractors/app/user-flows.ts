import type { Extractor, ExtractionContext, ExtractionResult } from "../../lib/extractor-base.js";
import { registerExtractor } from "../../lib/extractor-base.js";

interface Screen {
  name: string;
  file: string;
  navigatesTo: string[];
}

interface UserFlowResult {
  screens: Screen[];
  routes: string[];
  entryPoints: string[];
}

const userFlowsExtractor: Extractor = {
  name: "user_flows",
  description: "Extract basic screens/pages and navigation targets for UI repos",

  async canExtract(ctx: ExtractionContext): Promise<boolean> {
    const files = await ctx.gitManager.listFilesAtRef(ctx.repoPath, ctx.ref);
    return files.some((f) => f.includes("/screens/") || f.includes("/pages/") || f.includes("/views/"));
  },

  async extract(ctx: ExtractionContext): Promise<ExtractionResult> {
    const config = ctx.config as {
      ignore?: string[];
      limit?: number;
    };

    const allFiles = await ctx.gitManager.listFilesAtRef(ctx.repoPath, ctx.ref);
    const ignore = config.ignore || [];
    const limit = config.limit || 50;

    const screenFiles = allFiles.filter((f) => {
      const isScreen = f.includes("/screens/") || f.includes("/pages/") || f.includes("/views/");
      const ignored = ignore.some((pat) => f.includes(pat.replace("**", "")));
      return isScreen && !ignored && (f.endsWith(".dart") || f.endsWith(".tsx") || f.endsWith(".vue") || f.endsWith(".js") || f.endsWith(".ts"));
    }).slice(0, limit);

    const screens: Screen[] = [];
    const routes = new Set<string>();

    for (const file of screenFiles) {
      try {
        const content = await ctx.gitManager.getFileAtRef(ctx.repoPath, ctx.ref, file);
        const name = extractScreenName(file);
        const navigatesTo = findNavigations(content).map(extractScreenName);
        screens.push({ name, file, navigatesTo });

        // Very rough route detection
        const routeMatch = content.match(/['"]\/(.+?)['"]/);
        if (routeMatch) routes.add(`/${routeMatch[1]}`);
      } catch {
        // skip unreadable files
      }
    }

    const entryPoints = screens.filter((s) => /home|main|splash/i.test(s.file)).map((s) => s.name);

    const data: UserFlowResult = {
      screens,
      routes: Array.from(routes).sort(),
      entryPoints,
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

function extractScreenName(path: string): string {
  const parts = path.split("/");
  const filename = parts[parts.length - 1];
  return filename
    .replace(/\.(dart|tsx?|vue|js)$/, "")
    .replace(/_screen$/i, "")
    .replace(/_page$/i, "")
    .replace(/Screen$/i, "")
    .replace(/Page$/i, "")
    .split(/[-_]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

function findNavigations(content: string): string[] {
  const targets: string[] = [];
  const patterns = [
    /Navigator\.push.*?['"]([^'"#]+)['"]/g,
    /context\.go\(['"]([^'"#]+)['"]\)/g,
    /context\.push\(['"]([^'"#]+)['"]\)/g,
    /router\.navigate\(['"]([^'"#]+)['"]\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      targets.push(match[1]);
    }
  }
  return Array.from(new Set(targets));
}

registerExtractor(userFlowsExtractor);
export { userFlowsExtractor };
