import type { Extractor, ExtractionContext, ExtractionResult } from "../../lib/extractor-base.js";
import { registerExtractor } from "../../lib/extractor-base.js";

interface NIPReference {
  nip: string;
  file: string;
  line: number;
  context: string;
  type: "comment" | "code" | "constant";
}

interface EventKindUsage {
  kind: number;
  file: string;
  line: number;
  context: string;
}

interface NIPUsageData {
  nips: Record<string, {
    references: NIPReference[];
    eventKinds: number[];
    files: string[];
  }>;
  eventKinds: Record<number, EventKindUsage[]>;
  summary: {
    totalNIPReferences: number;
    uniqueNIPs: string[];
    uniqueEventKinds: number[];
  };
}

const nipUsageExtractor: Extractor = {
  name: "nip_usage",
  description: "Extract NIP references and event kind usage from codebase",

  async canExtract(ctx: ExtractionContext): Promise<boolean> {
    const files = await ctx.gitManager.listFilesAtRef(ctx.repoPath, ctx.ref);
    return files.some((f) =>
      f.endsWith(".dart") ||
      f.endsWith(".ts") ||
      f.endsWith(".js") ||
      f.endsWith(".rs")
    );
  },

  async extract(ctx: ExtractionContext): Promise<ExtractionResult> {
    const config = ctx.config as {
      patterns?: string[];
      file_types?: string[];
    };

    const fileTypes = config.file_types || ["dart", "ts", "js", "rs", "md"];
    const filePattern = `*.{${fileTypes.join(",")}}`;

    const nipData: NIPUsageData = {
      nips: {},
      eventKinds: {},
      summary: {
        totalNIPReferences: 0,
        uniqueNIPs: [],
        uniqueEventKinds: [],
      },
    };

    const nipPatterns = config.patterns && config.patterns.length > 0
      ? config.patterns
      : ["NIP-[0-9]+", "nip[0-9]+", "NIP[0-9]+"];

    for (const pattern of nipPatterns) {
      const matches = await ctx.gitManager.grepAtRef(
        ctx.repoPath,
        ctx.ref,
        pattern,
        filePattern
      );

      for (const match of matches) {
        const nipMatch = match.content.match(/NIP-?(\d+)/i);
        if (nipMatch) {
          const nipNum = nipMatch[1].padStart(2, "0");
          const nipKey = `NIP-${nipNum}`;

          if (!nipData.nips[nipKey]) {
            nipData.nips[nipKey] = {
              references: [],
              eventKinds: [],
              files: [],
            };
          }

          let type: "comment" | "code" | "constant" = "code";
          if (match.content.includes("//") || match.content.includes("/*") || match.content.includes("///")) {
            type = "comment";
          } else if (match.content.includes("const") || match.content.includes("static")) {
            type = "constant";
          }

          nipData.nips[nipKey].references.push({
            nip: nipKey,
            file: match.file,
            line: match.line,
            context: match.content.slice(0, 150),
            type,
          });

          if (!nipData.nips[nipKey].files.includes(match.file)) {
            nipData.nips[nipKey].files.push(match.file);
          }
        }
      }
    }

    const kindPatterns = [
      "kind:\\s*[0-9]+",
      "kind\\s*=\\s*[0-9]+",
      "Kind\\.[A-Z]+",
      "eventKind.*[0-9]+",
    ];

    for (const pattern of kindPatterns) {
      const matches = await ctx.gitManager.grepAtRef(
        ctx.repoPath,
        ctx.ref,
        pattern,
        filePattern
      );

      for (const match of matches) {
        const kindMatch = match.content.match(/kind[:\\s=]*(\d+)/i);
        if (kindMatch) {
          const kind = parseInt(kindMatch[1], 10);

          if (!nipData.eventKinds[kind]) {
            nipData.eventKinds[kind] = [];
          }

          nipData.eventKinds[kind].push({
            kind,
            file: match.file,
            line: match.line,
            context: match.content.slice(0, 150),
          });
        }
      }
    }

    nipData.summary.uniqueNIPs = Object.keys(nipData.nips).sort((a, b) => {
      const numA = parseInt(a.replace("NIP-", ""), 10);
      const numB = parseInt(b.replace("NIP-", ""), 10);
      return numA - numB;
    });

    nipData.summary.uniqueEventKinds = Object.keys(nipData.eventKinds)
      .map(Number)
      .sort((a, b) => a - b);

    nipData.summary.totalNIPReferences = Object.values(nipData.nips)
      .reduce((sum, nip) => sum + nip.references.length, 0);

    const kindToNIP: Record<number, string> = {
      0: "NIP-01", 1: "NIP-01", 3: "NIP-02", 4: "NIP-04",
      5: "NIP-09", 6: "NIP-18", 7: "NIP-25", 16: "NIP-18",
      21: "NIP-71", 22: "NIP-71", 1063: "NIP-94", 1984: "NIP-56",
      1985: "NIP-32", 10000: "NIP-51", 10002: "NIP-65", 10003: "NIP-51",
      27235: "NIP-98", 34235: "NIP-71", 34236: "NIP-71",
    };

    for (const [kind, usages] of Object.entries(nipData.eventKinds)) {
      const nip = kindToNIP[Number(kind)];
      if (nip && nipData.nips[nip]) {
        if (!nipData.nips[nip].eventKinds.includes(Number(kind))) {
          nipData.nips[nip].eventKinds.push(Number(kind));
        }
      }
    }

    return {
      extractor: this.name,
      repo: ctx.repoName,
      ref: ctx.ref,
      extractedAt: new Date(),
      data: nipData,
    };
  },
};

registerExtractor(nipUsageExtractor);
export { nipUsageExtractor };
