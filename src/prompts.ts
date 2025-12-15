/**
 * MCP Prompts - Pre-defined templates for common workflows
 *
 * These appear as "slash commands" or quick actions in MCP clients.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig, clearConfigCache } from "./lib/config-loader.js";

/**
 * Sanitize user input for use in prompt text
 * - Limits length to prevent excessively long inputs
 * - Removes control characters
 * - Trims whitespace
 */
function sanitizeInput(input: string, maxLength = 100): string {
  if (!input || typeof input !== "string") return "";
  return input
    .slice(0, maxLength)
    .replace(/[\x00-\x1F\x7F]/g, "") // Remove control characters
    .trim();
}

/**
 * Validate org name format (GitHub organization naming rules)
 */
function isValidOrgName(org: string): boolean {
  // GitHub org names: alphanumeric and hyphens, 1-39 chars, can't start/end with hyphen
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(org);
}

/**
 * Validate repo name format
 */
function isValidRepoName(repo: string): boolean {
  // Basic validation: alphanumeric, hyphens, underscores, dots, 1-100 chars
  return /^[a-zA-Z0-9._-]{1,100}$/.test(repo);
}

/**
 * Validate git ref format (branch/tag name)
 */
function isValidGitRef(ref: string): boolean {
  // Git ref rules: no double dots, no control chars, no spaces, etc.
  if (!ref || ref.length > 250) return false;
  if (/\.\./.test(ref)) return false; // No double dots
  if (/^\/|\/\/|\/$/g.test(ref)) return false; // No leading/trailing/double slashes
  if (/[\x00-\x1F\x7F~^:?*\[\]\\]/.test(ref)) return false; // No special chars
  return true;
}

export async function registerPrompts(server: McpServer): Promise<void> {
  // Connect a GitHub organization
  server.prompt(
    "connect-org",
    "Connect a GitHub organization to import all repositories",
    {
      org: z.string().describe("GitHub organization name (e.g., 'facebook', 'vercel')"),
      include_nips: z.string().optional().describe("Set to 'true' to include NIP extractor for Nostr repos"),
    },
    async ({ org, include_nips }) => {
      const sanitizedOrg = sanitizeInput(org, 39);

      if (!sanitizedOrg || !isValidOrgName(sanitizedOrg)) {
        return {
          messages: [
            {
              role: "user" as const,
              content: {
                type: "text" as const,
                text: `⚠️ Invalid organization name: "${sanitizeInput(org, 50)}". GitHub organization names must be 1-39 characters, containing only alphanumeric characters and hyphens.`,
              },
            },
          ],
        };
      }

      const includeNips = include_nips === "true";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Please connect the GitHub organization "${sanitizedOrg}" to orgbrain:

1. Call connect_org with org="${sanitizedOrg}"${includeNips ? " and include_nips=true" : ""}

2. After connecting, show a summary of:
   - How many repos were added
   - How many were auto-disabled (test/demo repos)
   - The breakdown by type (frontend, backend, etc.)

3. Ask if I want to:
   - Extract knowledge from all repos now (extract_all)
   - See the architecture diagram (generate_diagram)
   - Enable/disable specific repos (toggle_repo)

Note: This requires GitHub CLI (gh) to be authenticated. If you get an auth error, run 'gh auth login' first.`,
            },
          },
        ],
      };
    }
  );

  // Analyze a specific repository
  server.prompt(
    "analyze-repo",
    "Deep dive into a repository - extract data, analyze structure, generate diagrams",
    { repo: z.string().describe("Repository name to analyze") },
    async ({ repo }) => {
      const sanitizedRepo = sanitizeInput(repo, 100);

      if (!sanitizedRepo || !isValidRepoName(sanitizedRepo)) {
        return {
          messages: [
            {
              role: "user" as const,
              content: {
                type: "text" as const,
                text: `⚠️ Invalid repository name: "${sanitizeInput(repo, 50)}". Repository names must be 1-100 characters containing only alphanumeric characters, hyphens, underscores, and dots.`,
              },
            },
          ],
        };
      }

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Please analyze the "${sanitizedRepo}" repository:

1. First, ensure we have the latest data by calling extract_ref with repo="${sanitizedRepo}" and ref="main" (or the default branch)

2. Check if it's a monorepo by calling query_monorepos and looking for ${sanitizedRepo}

3. Generate architecture diagrams:
   - Call generate_diagram with repo="${sanitizedRepo}" for a flowchart view
   - Call generate_c4_diagram with repo="${sanitizedRepo}" and type="container" for a detailed architecture view

4. Analyze the extracted data:
   - Check user_flows for screens/pages
   - Check data_flow for services and external dependencies
   - Check kubernetes/terraform if it's an infrastructure repo

5. Provide a summary including:
   - Repository type and structure
   - Key components/packages
   - External dependencies
   - Technology stack
   - Recommendations for documentation or improvements`,
            },
          },
        ],
      };
    }
  );

  // Architecture overview of the entire ecosystem
  server.prompt(
    "architecture-overview",
    "Generate a complete architecture overview of all repositories",
    {},
    async () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Please generate a comprehensive architecture overview of the entire ecosystem:

1. Start by listing all repositories with list_repos

2. Generate ecosystem-level diagrams:
   - Call generate_c4_diagram with type="context" for high-level view
   - Call generate_c4_diagram with type="container" for detailed view
   - Call generate_diagram for an ecosystem flowchart

3. Analyze cross-cutting concerns:
   - Call query_data_flow to understand service dependencies
   - Call query_infra to see infrastructure components (K8s, Terraform)
   - Call query_monorepos to identify monorepo structures

4. If this is a Nostr ecosystem, also call query_nips to see NIP usage across repos

5. Provide a summary including:
   - Overall system architecture
   - How repositories interact
   - Shared infrastructure
   - Technology stack overview
   - Key integration points`,
          },
        },
      ],
    })
  );

  // Compare two versions/releases
  server.prompt(
    "compare-releases",
    "Compare two versions/releases to see what changed",
    {
      from: z.string().describe("Source version/ref (e.g., v1.0.0)"),
      to: z.string().describe("Target version/ref (e.g., v2.0.0 or main)"),
      repo: z.string().optional().describe("Optional: specific repo to compare"),
    },
    async ({ from, to, repo }) => {
      const sanitizedFrom = sanitizeInput(from, 250);
      const sanitizedTo = sanitizeInput(to, 250);
      const sanitizedRepo = repo ? sanitizeInput(repo, 100) : undefined;

      // Validate git refs
      if (!sanitizedFrom || !isValidGitRef(sanitizedFrom)) {
        return {
          messages: [
            {
              role: "user" as const,
              content: {
                type: "text" as const,
                text: `⚠️ Invalid source ref: "${sanitizeInput(from, 50)}". Please provide a valid git branch or tag name.`,
              },
            },
          ],
        };
      }

      if (!sanitizedTo || !isValidGitRef(sanitizedTo)) {
        return {
          messages: [
            {
              role: "user" as const,
              content: {
                type: "text" as const,
                text: `⚠️ Invalid target ref: "${sanitizeInput(to, 50)}". Please provide a valid git branch or tag name.`,
              },
            },
          ],
        };
      }

      if (sanitizedRepo && !isValidRepoName(sanitizedRepo)) {
        return {
          messages: [
            {
              role: "user" as const,
              content: {
                type: "text" as const,
                text: `⚠️ Invalid repository name: "${sanitizeInput(repo || "", 50)}". Repository names must be 1-100 characters containing only alphanumeric characters, hyphens, underscores, and dots.`,
              },
            },
          ],
        };
      }

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Please compare versions "${sanitizedFrom}" to "${sanitizedTo}"${sanitizedRepo ? ` for repository "${sanitizedRepo}"` : " across the ecosystem"}:

1. First, ensure both versions are extracted:
   - Call extract_ref with ref="${sanitizedFrom}"${sanitizedRepo ? ` and repo="${sanitizedRepo}"` : ""}
   - Call extract_ref with ref="${sanitizedTo}"${sanitizedRepo ? ` and repo="${sanitizedRepo}"` : ""}

2. Run the comparison:
   - Call diff_versions with from_ref="${sanitizedFrom}" and to_ref="${sanitizedTo}"${sanitizedRepo ? ` and repo="${sanitizedRepo}"` : ""}

3. Analyze the changes:
   - What NIPs/features were added or removed?
   - What screens/pages changed?
   - What services were modified?
   - Any infrastructure changes?

4. Generate a migration/changelog summary:
   - Breaking changes
   - New features
   - Deprecations
   - Recommendations for upgrading`,
            },
          },
        ],
      };
    }
  );

  // Onboard to a new codebase
  server.prompt(
    "onboard",
    "Get oriented with a new codebase - perfect for new team members",
    {
      repo: z.string().optional().describe("Optional: specific repo to focus on"),
    },
    async ({ repo }) => {
      const sanitizedRepo = repo ? sanitizeInput(repo, 100) : undefined;

      if (sanitizedRepo && !isValidRepoName(sanitizedRepo)) {
        return {
          messages: [
            {
              role: "user" as const,
              content: {
                type: "text" as const,
                text: `⚠️ Invalid repository name: "${sanitizeInput(repo || "", 50)}". Repository names must be 1-100 characters containing only alphanumeric characters, hyphens, underscores, and dots.`,
              },
            },
          ],
        };
      }

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Please help me get oriented with ${sanitizedRepo ? `the "${sanitizedRepo}" repository` : "this codebase"}:

1. Overview:
   - Call list_repos to see all available repositories
   - ${sanitizedRepo ? `Focus on "${sanitizedRepo}" specifically` : "Identify the main/core repositories"}

2. Architecture:
   - Generate diagrams to visualize the structure
   - ${sanitizedRepo ? `Call generate_diagram with repo="${sanitizedRepo}"` : "Call generate_diagram for ecosystem view"}
   - Explain how the pieces fit together

3. Key Components:
   - Call query_monorepos to understand workspace structures
   - Identify the main applications vs shared libraries
   - List the technology stack (frameworks, languages)

4. Data & Integration:
   - Call query_data_flow to see service dependencies
   - Identify external APIs and services
   - Show how data flows through the system

5. Development Guide:
   - What are the main entry points?
   - How are things organized?
   - What patterns/conventions are used?

Please explain everything as if I'm new to this codebase.`,
            },
          },
        ],
      };
    }
  );

  // Refresh all knowledge
  server.prompt(
    "refresh-knowledge",
    "Re-extract all repositories to get the latest data",
    {
      force: z.string().optional().describe("Set to 'true' to force re-extraction even if data is fresh"),
    },
    async ({ force }) => {
      const forceExtract = force === "true";
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Please refresh the knowledge base:

1. Call extract_all${forceExtract ? " with force=true" : ""} to re-extract all enabled repositories

2. After extraction completes, call list_repos to show what was extracted

3. Provide a summary of:
   - How many repos were processed
   - Any errors or issues
   - What extractors ran for each repo`,
            },
          },
        ],
      };
    }
  );

  // Quick status check
  server.prompt("status", "Quick status check - what's in the knowledge base?", {}, async () => {
    let repoCount = 0;
    let enabledCount = 0;
    let configError = "";

    try {
      const config = await loadConfig();
      repoCount = Object.keys(config.repositories).length;
      enabledCount = Object.values(config.repositories).filter((r) => r.enabled !== false).length;
    } catch (error) {
      configError = `\n\n⚠️ Warning: Could not load config: ${error instanceof Error ? error.message : String(error)}`;
    }

    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Please give me a quick status of the knowledge base:

Configuration shows ${repoCount} repositories (${enabledCount} enabled).${configError}

1. Call list_repos to see what's been extracted and when

2. Call health_check to verify server capabilities

3. Summarize:
   - Which repos have been extracted?
   - How fresh is the data?
   - Are there any repos that need extraction?
   - Any disabled repos?`,
          },
        },
      ],
    };
  });

  // Reload configuration
  server.prompt("reload-config", "Reload the repos.yaml configuration (clears cache)", {}, async () => {
    clearConfigCache();

    try {
      const config = await loadConfig();
      const repoCount = Object.keys(config.repositories).length;
      const enabledCount = Object.values(config.repositories).filter((r) => r.enabled !== false).length;
      const disabledRepos = Object.entries(config.repositories)
        .filter(([_, r]) => r.enabled === false)
        .map(([name]) => name);

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Configuration reloaded successfully!

**Summary:**
- Total repositories: ${repoCount}
- Enabled: ${enabledCount}
- Disabled: ${disabledRepos.length > 0 ? disabledRepos.join(", ") : "none"}

The config cache has been cleared and the latest repos.yaml has been loaded.`,
            },
          },
        ],
      };
    } catch (error) {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `⚠️ **Configuration reload failed!**

Error: ${error instanceof Error ? error.message : String(error)}

The config cache has been cleared, but the configuration file could not be loaded.
Please check that your repos.yaml file exists and is valid YAML.`,
            },
          },
        ],
      };
    }
  });

  // Find NIP implementation
  server.prompt(
    "find-nip",
    "Find where a specific NIP is implemented across the codebase",
    {
      nip: z.string().describe("NIP number to search for (e.g., 01, 19, 98)"),
    },
    async ({ nip }) => {
      // Validate NIP is a valid number
      const nipNum = parseInt(nip, 10);
      if (isNaN(nipNum) || nipNum < 1 || nipNum > 999) {
        return {
          messages: [
            {
              role: "user" as const,
              content: {
                type: "text" as const,
                text: `⚠️ Invalid NIP number: "${nip}". Please provide a valid NIP number (e.g., 01, 19, 98).`,
              },
            },
          ],
        };
      }

      const sanitizedNip = nipNum.toString();
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Please find all implementations of NIP-${sanitizedNip} in the codebase:

1. Call query_nips to get an overview of NIP usage across all repos

2. Call find_nip_in_extracted with the NIP number ${sanitizedNip} to find specific files

3. Call get_nip_details with nip_number=${sanitizedNip} to get details from the NIP matrix

4. Summarize:
   - Which repos implement this NIP?
   - What files contain the implementation?
   - What event kinds are associated with it?
   - Any related NIPs that are commonly used together?`,
            },
          },
        ],
      };
    }
  );
}
