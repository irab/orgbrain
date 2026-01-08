import type { Extractor, ExtractionContext, ExtractionResult } from "../../lib/extractor-base.js";
import { registerExtractor } from "../../lib/extractor-base.js";

interface JourneyStep {
  number?: number;
  description: string;
  actor?: string;
  screens?: string[];
  services?: string[];
}

interface UserStory {
  role: string;
  goal: string;
  benefit: string;
  file: string;
  line: number;
}

interface FeatureFlag {
  name: string;
  file: string;
  line: number;
  journeys: string[];
}

interface JourneyDoc {
  title: string;
  file: string;
  summary?: string;
  services: string[];
  screens: string[];
  steps?: JourneyStep[];
  actors?: string[];
  outcomes?: string[];
}

interface JourneyImpactData {
  journeys: JourneyDoc[];
  screens: string[];
  services: string[];
  userStories?: UserStory[];
  featureFlags?: FeatureFlag[];
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
      f.includes("/screens/") || f.includes("/pages/") ||
      // Rust projects with docs
      (f.startsWith("docs/") && f.endsWith(".md")) ||
      f === "README.md"
    );
  },

  async extract(ctx: ExtractionContext): Promise<ExtractionResult> {
    const files = await ctx.gitManager.listFilesAtRef(ctx.repoPath, ctx.ref);

    const journeyDocs = files.filter((f) =>
      f.match(/\.(md|mdx)$/) && (
        f.toLowerCase().includes("journey") || 
        f.toLowerCase().includes("flow") ||
        f.toLowerCase().includes("design") ||
        f.toLowerCase().includes("plan")
      )
    ).slice(0, 50);

    const screenFiles = files.filter((f) =>
      f.includes("/screens/") || f.includes("/pages/") || f.includes("/views/")
    ).slice(0, 100);

    // JS/TS services
    const jsServiceFiles = files.filter((f) =>
      f.includes("/services/") || f.endsWith("Service.ts") || f.endsWith("Service.js")
    ).slice(0, 100);

    // Rust modules (src/*.rs)
    const rustServiceFiles = files.filter((f) =>
      f.startsWith("src/") && f.endsWith(".rs") && f !== "src/lib.rs" && f !== "src/main.rs"
    ).slice(0, 100);

    const screens = screenFiles.map(extractName);
    const services = [...jsServiceFiles.map(extractName), ...rustServiceFiles.map(extractRustName)];

    const journeys: JourneyDoc[] = [];
    const userStories: UserStory[] = [];
    const featureFlags: FeatureFlag[] = [];

    for (const file of journeyDocs) {
      try {
        const content = await ctx.gitManager.getFileAtRef(ctx.repoPath, ctx.ref, file);
        const title = extractTitle(content) || extractName(file);
        const summary = summarize(content);
        const linkedScreens = screens.filter((s) => content.includes(s));
        const linkedServices = services.filter((s) => content.includes(s));
        
        // Parse structured journey
        const structured = parseStructuredJourney(content, linkedScreens, linkedServices);
        
        journeys.push({
          title,
          file,
          summary,
          screens: linkedScreens,
          services: linkedServices,
          steps: structured.steps,
          actors: structured.actors,
          outcomes: structured.outcomes,
        });
        
        // Extract user stories
        const stories = extractUserStories(content, file);
        userStories.push(...stories);
      } catch {
        // skip unreadable
      }
    }

    // Extract feature flags from code files
    const codeFiles = [...jsServiceFiles, ...rustServiceFiles, ...screenFiles].slice(0, 100);
    for (const file of codeFiles) {
      try {
        const content = await ctx.gitManager.getFileAtRef(ctx.repoPath, ctx.ref, file);
        const flags = extractFeatureFlags(content, file);
        featureFlags.push(...flags);
      } catch {
        // skip unreadable
      }
    }

    // Link feature flags to journeys
    for (const flag of featureFlags) {
      for (const journey of journeys) {
        const journeyContent = await ctx.gitManager.getFileAtRef(ctx.repoPath, ctx.ref, journey.file).catch(() => "");
        if (journeyContent.includes(flag.name)) {
          flag.journeys.push(journey.title);
        }
      }
    }

    const data: JourneyImpactData = {
      journeys,
      screens: Array.from(new Set(screens)).sort(),
      services: Array.from(new Set(services)).sort(),
      userStories: userStories.length > 0 ? userStories : undefined,
      featureFlags: featureFlags.length > 0 ? featureFlags : undefined,
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

function extractRustName(path: string): string {
  const parts = path.split("/");
  const filename = parts[parts.length - 1];
  return filename
    .replace(/\.rs$/i, "")
    .replace(/_/g, " ")
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

/**
 * Parse structured journey from markdown content
 */
function parseStructuredJourney(
  content: string,
  linkedScreens: string[],
  linkedServices: string[]
): { steps: JourneyStep[]; actors: string[]; outcomes: string[] } {
  const steps: JourneyStep[] = [];
  const actors: string[] = [];
  const outcomes: string[] = [];

  // Extract steps from numbered lists or bullet points
  const stepPatterns = [
    /^\d+\.\s+(.+)$/gm,  // Numbered list
    /^[-*]\s+(.+)$/gm,   // Bullet list
    /^##\s+Step\s+\d+[:\s]+(.+)$/gmi,  // Step headers
  ];

  for (const pattern of stepPatterns) {
    let match: RegExpExecArray | null;
    let stepNumber = 1;
    while ((match = pattern.exec(content)) !== null) {
      const description = match[1].trim();
      
      // Try to extract actor from step
      const actorMatch = description.match(/(?:user|actor|persona):\s*(\w+)/i);
      const actor = actorMatch ? actorMatch[1] : undefined;
      
      // Find linked screens/services in step
      const stepScreens = linkedScreens.filter((s) => description.includes(s));
      const stepServices = linkedServices.filter((s) => description.includes(s));
      
      steps.push({
        number: stepNumber++,
        description,
        actor,
        screens: stepScreens.length > 0 ? stepScreens : undefined,
        services: stepServices.length > 0 ? stepServices : undefined,
      });
    }
    if (steps.length > 0) break; // Use first pattern that finds steps
  }

  // Extract actors from "Actors:" or "Personas:" section
  const actorSectionMatch = content.match(/(?:actors?|personas?):\s*\n((?:[-*]\s*.+\n?)+)/i);
  if (actorSectionMatch) {
    const actorLines = actorSectionMatch[1].match(/[-*]\s*(.+)/g);
    if (actorLines) {
      for (const line of actorLines) {
        const actor = line.replace(/[-*]\s*/, "").trim();
        if (actor) actors.push(actor);
      }
    }
  }

  // Extract outcomes from "Outcomes:" or "Results:" section
  const outcomeSectionMatch = content.match(/(?:outcomes?|results?):\s*\n((?:[-*]\s*.+\n?)+)/i);
  if (outcomeSectionMatch) {
    const outcomeLines = outcomeSectionMatch[1].match(/[-*]\s*(.+)/g);
    if (outcomeLines) {
      for (const line of outcomeLines) {
        const outcome = line.replace(/[-*]\s*/, "").trim();
        if (outcome) outcomes.push(outcome);
      }
    }
  }

  return { steps, actors, outcomes };
}

/**
 * Extract user stories from content
 */
function extractUserStories(content: string, file: string): UserStory[] {
  const stories: UserStory[] = [];

  // Pattern: "As a [role] I want [goal] So that [benefit]"
  const storyPattern = /As\s+a\s+([^,]+?)\s+I\s+want\s+([^,]+?)\s+So\s+that\s+(.+?)(?:\.|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = storyPattern.exec(content)) !== null) {
    const line = getLineNumber(content, match.index);
    stories.push({
      role: match[1].trim(),
      goal: match[2].trim(),
      benefit: match[3].trim(),
      file,
      line,
    });
  }

  // Alternative pattern: "As [role], I want [goal], so that [benefit]"
  const altPattern = /As\s+([^,]+?),\s*I\s+want\s+([^,]+?),\s*so\s+that\s+(.+?)(?:\.|$)/gi;
  while ((match = altPattern.exec(content)) !== null) {
    const line = getLineNumber(content, match.index);
    stories.push({
      role: match[1].trim(),
      goal: match[2].trim(),
      benefit: match[3].trim(),
      file,
      line,
    });
  }

  return stories;
}

/**
 * Extract feature flags from code
 */
function extractFeatureFlags(content: string, file: string): FeatureFlag[] {
  const flags: FeatureFlag[] = [];

  // Pattern: featureFlags.isEnabled('flagName')
  const isEnabledPattern = /featureFlags\.isEnabled\s*\(\s*['"]([^'"]+)['"]/gi;
  let match: RegExpExecArray | null;
  while ((match = isEnabledPattern.exec(content)) !== null) {
    const line = getLineNumber(content, match.index);
    flags.push({
      name: match[1],
      file,
      line,
      journeys: [],
    });
  }

  // Pattern: useFeatureFlag('flagName')
  const useFeaturePattern = /useFeatureFlag\s*\(\s*['"]([^'"]+)['"]/gi;
  while ((match = useFeaturePattern.exec(content)) !== null) {
    const line = getLineNumber(content, match.index);
    flags.push({
      name: match[1],
      file,
      line,
      journeys: [],
    });
  }

  // Pattern: FF_ENABLED or FEATURE_FLAG_NAME
  const envPattern = /(?:FF_|FEATURE_)([A-Z_]+)/g;
  while ((match = envPattern.exec(content)) !== null) {
    const line = getLineNumber(content, match.index);
    flags.push({
      name: match[1].toLowerCase().replace(/_/g, "-"),
      file,
      line,
      journeys: [],
    });
  }

  // Pattern: if (flags.flagName) or if (featureFlags.flagName)
  const ifPattern = /if\s*\(\s*(?:flags|featureFlags)\.(\w+)/gi;
  while ((match = ifPattern.exec(content)) !== null) {
    const line = getLineNumber(content, match.index);
    flags.push({
      name: match[1],
      file,
      line,
      journeys: [],
    });
  }

  return flags;
}

/**
 * Get line number from character index
 */
function getLineNumber(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

registerExtractor(journeyImpactExtractor);
export { journeyImpactExtractor };
