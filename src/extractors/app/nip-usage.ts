import type { Extractor, ExtractionContext, ExtractionResult } from "../../lib/extractor-base.js";
import { registerExtractor, getExtractor } from "../../lib/extractor-base.js";

// Type definitions from type_definitions extractor
interface TypeDefinition {
  name: string;
  kind: string;
  file: string;
  line: number;
  language: string;
  fields?: Array<{
    name: string;
    typeRef?: { name: string; raw: string };
  }>;
  variants?: Array<{ name: string; value?: string | number }>;
  decorators?: string[];
  doc?: string;
}

interface NIPReference {
  nip: string;
  file: string;
  line: number;
  context: string;
  type: "comment" | "code" | "constant" | "declared";
}

interface EventKindUsage {
  kind: number;
  file: string;
  line: number;
  context: string;
}

interface NIPEvidence {
  /** Type definitions that indicate this NIP is implemented */
  types: Array<{ name: string; file: string; reason: string }>;
  /** Event kinds used that map to this NIP */
  eventKinds: number[];
}

interface NIPUsageData {
  /** NIPs explicitly declared as supported (e.g., in NIP-11 supported_nips) */
  declaredNips: number[];
  /** NIPs with implementation evidence from type definitions */
  implementedNips: Record<string, NIPEvidence>;
  /** All NIP references found in code */
  nips: Record<string, {
    references: NIPReference[];
    eventKinds: number[];
    files: string[];
    /** Whether this NIP is explicitly declared as supported */
    declared: boolean;
    /** Whether there's type-based evidence of implementation */
    implemented: boolean;
  }>;
  eventKinds: Record<number, EventKindUsage[]>;
  summary: {
    /** NIPs explicitly declared as supported */
    declaredNIPs: string[];
    /** NIPs with implementation evidence (types/event kinds) */
    implementedNIPs: string[];
    /** NIPs mentioned but no evidence of implementation */
    mentionedNIPs: string[];
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

    const fileTypes = config.file_types || ["dart", "ts", "js", "rs", "md", "sql", "toml"];
    // Pass individual glob patterns for git grep (brace expansion doesn't work without shell)
    const filePatterns = fileTypes.map((ext) => `*.${ext}`);

    const nipData: NIPUsageData = {
      declaredNips: [],
      implementedNips: {},
      nips: {},
      eventKinds: {},
      summary: {
        declaredNIPs: [],
        implementedNIPs: [],
        mentionedNIPs: [],
        totalNIPReferences: 0,
        uniqueNIPs: [],
        uniqueEventKinds: [],
      },
    };

    // Type patterns that indicate NIP implementation
    // Maps regex patterns for type names to the NIPs they implement
    const typeToNIP: Array<{ pattern: RegExp; nip: number; reason: string }> = [
      // Core protocol
      { pattern: /^(Filter|Subscription)$/i, nip: 1, reason: "NIP-01 core protocol types" },
      { pattern: /^(RelayEvent|NostrEvent|Event|UnsignedEvent|SignedEvent)$/i, nip: 1, reason: "NIP-01 event type" },
      { pattern: /^(ClientMessage|RelayMessage|ClientToRelay|RelayToClient)$/i, nip: 1, reason: "NIP-01 message types" },
      // Relay info
      { pattern: /^(RelayInformation|RelayInfo|RelayMetadata)$/i, nip: 11, reason: "NIP-11 relay information document type" },
      { pattern: /^RelayLimitation$/i, nip: 11, reason: "NIP-11 relay limitations type" },
      // Explicit NIP-named types
      { pattern: /^Nip0?4/i, nip: 4, reason: "NIP-04 encrypted DM types" },
      { pattern: /^Nip0?5/i, nip: 5, reason: "NIP-05 identifier types" },
      { pattern: /^Nip17/i, nip: 17, reason: "NIP-17 private DM types" },
      { pattern: /^Nip19/i, nip: 19, reason: "NIP-19 bech32 encoding types" },
      { pattern: /^Nip26/i, nip: 26, reason: "NIP-26 delegation types" },
      { pattern: /^Nip42/i, nip: 42, reason: "NIP-42 authentication types" },
      { pattern: /^Nip44/i, nip: 44, reason: "NIP-44 encryption types" },
      { pattern: /^Nip46/i, nip: 46, reason: "NIP-46 remote signing types" },
      { pattern: /^Nip47/i, nip: 47, reason: "NIP-47 wallet connect types" },
      { pattern: /^Nip57/i, nip: 57, reason: "NIP-57 zaps types" },
      { pattern: /^Nip59/i, nip: 59, reason: "NIP-59 gift wrap types" },
      { pattern: /^Nip65/i, nip: 65, reason: "NIP-65 relay list types" },
      { pattern: /^Nip96/i, nip: 96, reason: "NIP-96 file storage types" },
      { pattern: /^Nip98/i, nip: 98, reason: "NIP-98 HTTP auth types" },
      // Management API
      { pattern: /^(RpcRequest|RpcResponse|RpcMethod|ManagementRequest|ManagementResponse)$/i, nip: 86, reason: "NIP-86 relay management API types" },
      { pattern: /^(BannedPubkey|AllowedPubkey|BlockedIp|BanList|AllowList)$/i, nip: 86, reason: "NIP-86 ban/allow list types" },
      // Video
      { pattern: /^(VideoMeta|VideoEvent|HorizontalVideo|VerticalVideo)$/i, nip: 71, reason: "NIP-71 video metadata type" },
      // COUNT
      { pattern: /^(CountResponse|CountResult)$/i, nip: 45, reason: "NIP-45 COUNT response type" },
      // Negentropy
      { pattern: /^(Negentropy|NegentropyMessage|NegentropyRequest|NegentropyResponse)$/i, nip: 77, reason: "NIP-77 negentropy sync types" },
      // Gift wrap
      { pattern: /^(Gift|GiftWrap|Rumor|Seal|PrivateMessage)$/i, nip: 59, reason: "NIP-59 gift wrap types" },
      // Lists
      { pattern: /^(ListEvent|MuteList|PinList|BookmarkList|FollowList|RelayList)$/i, nip: 51, reason: "NIP-51 list types" },
      // Zaps
      { pattern: /^(Zap|ZapRequest|ZapReceipt|LnurlPay)$/i, nip: 57, reason: "NIP-57 zap types" },
      // Labels
      { pattern: /^(Label|LabelEvent|Labeling)$/i, nip: 32, reason: "NIP-32 labeling types" },
      // Reporting
      { pattern: /^(Report|ReportEvent|Reporting)$/i, nip: 56, reason: "NIP-56 reporting types" },
      // File metadata
      { pattern: /^(FileMetadata|FileHeader|BlobDescriptor)$/i, nip: 94, reason: "NIP-94 file metadata types" },
      // Blossom
      { pattern: /^(Blossom|BlobUpload|BlobDownload)$/i, nip: 96, reason: "Blossom/NIP-96 file storage types" },
    ];

    // Field patterns that indicate NIP implementation when found in specific types
    // e.g., Filter.search field indicates NIP-50 support
    const fieldToNIP: Array<{ typeName: RegExp; fieldName: string; nip: number; reason: string }> = [
      { typeName: /^Filter$/i, fieldName: "search", nip: 50, reason: "NIP-50 search capability (Filter.search field)" },
      { typeName: /^Filter$/i, fieldName: "limit", nip: 1, reason: "NIP-01 filter limit" },
      { typeName: /^Filter$/i, fieldName: "since", nip: 1, reason: "NIP-01 filter time range" },
      { typeName: /^Filter$/i, fieldName: "until", nip: 1, reason: "NIP-01 filter time range" },
      { typeName: /^(RelayEvent|Event)$/i, fieldName: "delegation", nip: 26, reason: "NIP-26 delegation field" },
      { typeName: /^(RelayInformation|RelayInfo)$/i, fieldName: "supported_nips", nip: 11, reason: "NIP-11 supported NIPs field" },
      { typeName: /^(RelayInformation|RelayInfo)$/i, fieldName: "limitation", nip: 11, reason: "NIP-11 limitations field" },
    ];

    // Enum variant patterns that indicate NIP implementation
    const variantToNIP: Array<{ pattern: RegExp; nip: number; reason: string }> = [
      { pattern: /^(AUTH|Auth)$/i, nip: 42, reason: "NIP-42 AUTH message variant" },
      { pattern: /^(COUNT|Count)$/i, nip: 45, reason: "NIP-45 COUNT message variant" },
      { pattern: /^(CLOSE|Close)$/i, nip: 1, reason: "NIP-01 CLOSE message variant" },
      { pattern: /^(EVENT|Event)$/i, nip: 1, reason: "NIP-01 EVENT message variant" },
      { pattern: /^(REQ|Req)$/i, nip: 1, reason: "NIP-01 REQ message variant" },
      { pattern: /^(NOTICE|Notice)$/i, nip: 1, reason: "NIP-01 NOTICE message variant" },
      { pattern: /^(EOSE|Eose)$/i, nip: 1, reason: "NIP-01 EOSE message variant" },
      { pattern: /^(OK|Ok)$/i, nip: 20, reason: "NIP-20 OK message variant" },
    ];

    // Step 1: Find explicitly declared/supported NIPs (NIP-11 supported_nips field)
    // These patterns match the authoritative declaration of supported NIPs
    const declaredPatterns = [
      "supported_nips.*\\[",      // Rust: supported_nips: vec![1, 9, 11]
      "supportedNips.*\\[",       // JS/TS: supportedNips: [1, 9, 11]
      "supported_nips.*=.*\\[",   // Python/TOML: supported_nips = [1, 9, 11]
      '"supported_nips".*\\[',    // JSON: "supported_nips": [1, 9, 11]
    ];

    for (const pattern of declaredPatterns) {
      const matches = await ctx.gitManager.grepAtRef(
        ctx.repoPath,
        ctx.ref,
        pattern,
        filePatterns
      );

      for (const match of matches) {
        // Skip test files - they often have mock data
        if (match.file.includes("test") || match.file.includes("spec") || match.file.includes("mock")) {
          continue;
        }
        
        // Extract all numbers from the line (these are the declared NIPs)
        const numbers = match.content.match(/\d+/g);
        if (numbers) {
          for (const num of numbers) {
            const nipNum = parseInt(num, 10);
            // Filter out obviously invalid NIP numbers (year numbers, etc.)
            if (nipNum > 0 && nipNum < 1000 && !nipData.declaredNips.includes(nipNum)) {
              nipData.declaredNips.push(nipNum);
            }
          }
        }
      }
    }

    // Sort declared NIPs
    nipData.declaredNips.sort((a, b) => a - b);

    // Extended kind to NIP mapping (used for event kind detection and constant detection)
    const kindToNIPMapping: Record<number, string> = {
      0: "NIP-01", 1: "NIP-01", 2: "NIP-01", 3: "NIP-02", 4: "NIP-04",
      5: "NIP-09", 6: "NIP-18", 7: "NIP-25", 8: "NIP-27", 16: "NIP-18",
      17: "NIP-17", 20: "NIP-17", 21: "NIP-71", 22: "NIP-71",
      1059: "NIP-59", 1063: "NIP-94", 1311: "NIP-17",
      1984: "NIP-56", 1985: "NIP-32",
      10000: "NIP-51", 10001: "NIP-51", 10002: "NIP-65", 10003: "NIP-51",
      13194: "NIP-47", 22242: "NIP-42", 23194: "NIP-47", 23195: "NIP-47",
      24133: "NIP-46", 27235: "NIP-98",
      30000: "NIP-51", 30001: "NIP-51", 30008: "NIP-51", 30009: "NIP-51",
      30017: "NIP-15", 30018: "NIP-15", 30023: "NIP-23", 30024: "NIP-23",
      30078: "NIP-78", 30311: "NIP-53",
      34235: "NIP-71", 34236: "NIP-71", 34237: "NIP-71",
    };

    // Step 2: Detect NIP implementations from type definitions
    // Helper to add implementation evidence
    const addImplementationEvidence = (nip: number, typeName: string, file: string, reason: string) => {
      const nipKey = `NIP-${nip.toString().padStart(2, "0")}`;
      if (!nipData.implementedNips[nipKey]) {
        nipData.implementedNips[nipKey] = { types: [], eventKinds: [] };
      }
      // Avoid duplicates
      if (!nipData.implementedNips[nipKey].types.some(t => t.name === typeName && t.file === file)) {
        nipData.implementedNips[nipKey].types.push({ name: typeName, file, reason });
      }
    };

    // Try to use type_definitions extractor data if available (runs after type_definitions in pipeline)
    // This gives us rich field/variant information we can't get from grep
    const typeDefExtractor = getExtractor("type_definitions");
    let typeDefinitions: TypeDefinition[] = [];
    
    if (typeDefExtractor) {
      try {
        const typeResult = await typeDefExtractor.extract({
          ...ctx,
          config: {},
        });
        if (typeResult.data && typeof typeResult.data === "object" && "types" in typeResult.data) {
          typeDefinitions = (typeResult.data as { types: TypeDefinition[] }).types;
        }
      } catch {
        // Fall back to grep-based detection if type extractor fails
      }
    }

    if (typeDefinitions.length > 0) {
      // Use rich type definitions data
      for (const typeDef of typeDefinitions) {
        // Check type name patterns
        for (const { pattern, nip, reason } of typeToNIP) {
          if (pattern.test(typeDef.name)) {
            addImplementationEvidence(nip, typeDef.name, typeDef.file, reason);
          }
        }

        // Check field patterns (e.g., Filter.search indicates NIP-50)
        if (typeDef.fields) {
          for (const field of typeDef.fields) {
            for (const { typeName, fieldName, nip, reason } of fieldToNIP) {
              if (typeName.test(typeDef.name) && field.name === fieldName) {
                addImplementationEvidence(nip, `${typeDef.name}.${field.name}`, typeDef.file, reason);
              }
            }
          }
        }

        // Check enum variant patterns (e.g., ClientMessage::Auth indicates NIP-42)
        if (typeDef.variants) {
          for (const variant of typeDef.variants) {
            for (const { pattern, nip, reason } of variantToNIP) {
              if (pattern.test(variant.name)) {
                addImplementationEvidence(nip, `${typeDef.name}::${variant.name}`, typeDef.file, reason);
              }
            }
            
            // Also check for event kind enum variants (e.g., Kind::Metadata = 0)
            if (typeDef.name.match(/Kind/i) && typeof variant.value === "number") {
              const kindNum = variant.value;
              if (kindToNIPMapping[kindNum]) {
                const mappedNip = kindToNIPMapping[kindNum];
                addImplementationEvidence(
                  parseInt(mappedNip.replace("NIP-", ""), 10),
                  `${typeDef.name}::${variant.name}`,
                  typeDef.file,
                  `Event kind ${kindNum} enum variant`
                );
              }
            }
          }
        }
      }
    } else {
      // Fallback: grep-based type detection (less accurate but works without type extractor)
      const typeSearchPatterns = [
        "(pub )?(struct|enum) [A-Z]",
        "(export )?(interface|class|type) [A-Z]",
        "class [A-Z]",
      ];

      for (const searchPattern of typeSearchPatterns) {
        const typeMatches = await ctx.gitManager.grepAtRef(
          ctx.repoPath,
          ctx.ref,
          searchPattern,
          filePatterns
        );

        for (const match of typeMatches) {
          const typeNameMatch = match.content.match(/(?:struct|enum|type|interface|class)\s+([A-Za-z_][A-Za-z0-9_]*)/);
          if (!typeNameMatch) continue;

          const typeName = typeNameMatch[1];

          for (const { pattern, nip, reason } of typeToNIP) {
            if (pattern.test(typeName)) {
              addImplementationEvidence(nip, typeName, match.file, reason);
            }
          }
        }
      }
    }

    // Also grep for KIND constants (e.g., const KIND_VIDEO: u16 = 34235)
    const kindConstantMatches = await ctx.gitManager.grepAtRef(
      ctx.repoPath,
      ctx.ref,
      "(const |static |let |var ).*(KIND|Kind|EVENT_KIND).*=.*[0-9]",
      filePatterns
    );

    for (const match of kindConstantMatches) {
      const kindMatch = match.content.match(/=\s*(\d+)/);
      if (kindMatch) {
        const kindNum = parseInt(kindMatch[1], 10);
        if (kindToNIPMapping[kindNum]) {
          const mappedNip = kindToNIPMapping[kindNum];
          const nipNum = parseInt(mappedNip.replace("NIP-", ""), 10);
          const constName = match.content.match(/(KIND[A-Z_]*|Kind[A-Za-z]*)/)?.[1] || `kind_${kindNum}`;
          addImplementationEvidence(nipNum, constName, match.file, `Event kind ${kindNum} constant`);
        }
      }
    }


    // Step 3: Find all NIP mentions in code/comments
    const nipPatterns = config.patterns && config.patterns.length > 0
      ? config.patterns
      : ["NIP-[0-9]+", "nip[0-9]+", "NIP[0-9]+"];

    for (const pattern of nipPatterns) {
      const matches = await ctx.gitManager.grepAtRef(
        ctx.repoPath,
        ctx.ref,
        pattern,
        filePatterns
      );

      for (const match of matches) {
        const nipMatch = match.content.match(/NIP-?(\d+)/i);
        if (nipMatch) {
          const nipNum = parseInt(nipMatch[1], 10);
          // Filter out false positives (very large numbers are likely not NIPs)
          if (nipNum > 10000) continue;
          
          const nipKey = `NIP-${nipNum.toString().padStart(2, "0")}`;
          const isDeclared = nipData.declaredNips.includes(nipNum);
          const isImplemented = !!nipData.implementedNips[nipKey];

          if (!nipData.nips[nipKey]) {
            nipData.nips[nipKey] = {
              references: [],
              eventKinds: [],
              files: [],
              declared: isDeclared,
              implemented: isImplemented,
            };
          }

          let type: "comment" | "code" | "constant" | "declared" = "code";
          if (match.content.match(/supported_nips|supportedNips/i)) {
            type = "declared";
          } else if (match.content.includes("//") || match.content.includes("/*") || match.content.includes("///") || match.content.includes("#")) {
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

    // Step 3: Find event kind usage
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
        filePatterns
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

    // Add event kinds to NIP references and implementation evidence
    for (const [kind, usages] of Object.entries(nipData.eventKinds)) {
      const nip = kindToNIPMapping[Number(kind)];
      if (nip) {
        // Add to nip references
        if (nipData.nips[nip] && !nipData.nips[nip].eventKinds.includes(Number(kind))) {
          nipData.nips[nip].eventKinds.push(Number(kind));
        }
        // Add to implementation evidence (using event kinds indicates implementation)
        if (!nipData.implementedNips[nip]) {
          nipData.implementedNips[nip] = { types: [], eventKinds: [] };
        }
        if (!nipData.implementedNips[nip].eventKinds.includes(Number(kind))) {
          nipData.implementedNips[nip].eventKinds.push(Number(kind));
        }
      }
    }

    // Build summary
    nipData.summary.uniqueNIPs = Object.keys(nipData.nips).sort((a, b) => {
      const numA = parseInt(a.replace("NIP-", ""), 10);
      const numB = parseInt(b.replace("NIP-", ""), 10);
      return numA - numB;
    });

    nipData.summary.declaredNIPs = nipData.declaredNips.map(n => `NIP-${n.toString().padStart(2, "0")}`);
    
    // Implemented NIPs: have type definitions or event kind usage as evidence
    nipData.summary.implementedNIPs = Object.keys(nipData.implementedNips)
      .filter(nip => {
        const evidence = nipData.implementedNips[nip];
        return evidence.types.length > 0 || evidence.eventKinds.length > 0;
      })
      .sort((a, b) => {
        const numA = parseInt(a.replace("NIP-", ""), 10);
        const numB = parseInt(b.replace("NIP-", ""), 10);
        return numA - numB;
      });

    // Mentioned NIPs: referenced but not declared AND not implemented
    nipData.summary.mentionedNIPs = nipData.summary.uniqueNIPs.filter(
      nip => !nipData.summary.declaredNIPs.includes(nip) && !nipData.summary.implementedNIPs.includes(nip)
    );

    // Update implemented flag on each NIP
    for (const nipKey of Object.keys(nipData.nips)) {
      nipData.nips[nipKey].implemented = nipData.summary.implementedNIPs.includes(nipKey);
    }

    nipData.summary.uniqueEventKinds = Object.keys(nipData.eventKinds)
      .map(Number)
      .sort((a, b) => a - b);

    nipData.summary.totalNIPReferences = Object.values(nipData.nips)
      .reduce((sum, nip) => sum + nip.references.length, 0);

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
