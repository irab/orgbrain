/**
 * MCP Prompts - Pre-defined templates for common workflows
 *
 * These appear as "slash commands" or quick actions in MCP clients.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig, clearConfigCache } from "./lib/config-loader.js";

export async function registerPrompts(server: McpServer): Promise<void> {
  // Connect a GitHub organization
  server.prompt(
    "connect-org",
    "Connect a GitHub organization to import all repositories",
    {
      org: z.string().describe("GitHub organization name (e.g., 'facebook', 'vercel')"),
      include_nips: z.boolean().optional().describe("Include NIP extractor for Nostr repos"),
    },
    async ({ org, include_nips }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Please connect the GitHub organization "${org}" to orgbrain:

1. Call connect_org with org="${org}"${include_nips ? " and include_nips=true" : ""}

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
    })
  );

  // Analyze a specific repository
  server.prompt(
    "analyze-repo",
    "Deep dive into a repository - extract data, analyze structure, generate diagrams",
    { repo: z.string().describe("Repository name to analyze") },
    async ({ repo }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Please analyze the "${repo}" repository:

1. First, ensure we have the latest data by calling extract_ref with repo="${repo}" and ref="main" (or the default branch)

2. Check if it's a monorepo by calling query_monorepos and looking for ${repo}

3. Generate architecture diagrams:
   - Call generate_diagram with repo="${repo}" for a flowchart view
   - Call generate_c4_diagram with repo="${repo}" and level="container" for C4 view

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
    })
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
   - Call generate_c4_diagram with level="context" for high-level view
   - Call generate_c4_diagram with level="container" for detailed view
   - Call generate_diagram for a Mermaid flowchart

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
    async ({ from, to, repo }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Please compare versions "${from}" to "${to}"${repo ? ` for repository "${repo}"` : " across the ecosystem"}:

1. First, ensure both versions are extracted:
   - Call extract_ref with ref="${from}"${repo ? ` and repo="${repo}"` : ""}
   - Call extract_ref with ref="${to}"${repo ? ` and repo="${repo}"` : ""}

2. Run the comparison:
   - Call diff_versions with from_ref="${from}" and to_ref="${to}"${repo ? ` and repo="${repo}"` : ""}

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
    })
  );

  // Onboard to a new codebase
  server.prompt(
    "onboard",
    "Get oriented with a new codebase - perfect for new team members",
    {
      repo: z.string().optional().describe("Optional: specific repo to focus on"),
    },
    async ({ repo }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Please help me get oriented with ${repo ? `the "${repo}" repository` : "this codebase"}:

1. Overview:
   - Call list_repos to see all available repositories
   - ${repo ? `Focus on "${repo}" specifically` : "Identify the main/core repositories"}

2. Architecture:
   - Generate diagrams to visualize the structure
   - ${repo ? `Call generate_diagram with repo="${repo}"` : "Call generate_diagram for ecosystem view"}
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
    })
  );

  // Refresh all knowledge
  server.prompt(
    "refresh-knowledge",
    "Re-extract all repositories to get the latest data",
    {
      force: z.boolean().optional().describe("Force re-extraction even if data is fresh"),
    },
    async ({ force }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Please refresh the knowledge base:

1. Call extract_all${force ? " with force=true" : ""} to re-extract all enabled repositories

2. After extraction completes, call list_repos to show what was extracted

3. Provide a summary of:
   - How many repos were processed
   - Any errors or issues
   - What extractors ran for each repo`,
          },
        },
      ],
    })
  );

  // Quick status check
  server.prompt("status", "Quick status check - what's in the knowledge base?", {}, async () => {
    const config = await loadConfig();
    const repoCount = Object.keys(config.repositories).length;
    const enabledCount = Object.values(config.repositories).filter((r) => r.enabled !== false).length;

    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Please give me a quick status of the knowledge base:

Configuration shows ${repoCount} repositories (${enabledCount} enabled).

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
  });

  // Find NIP implementation
  server.prompt(
    "find-nip",
    "Find where a specific NIP is implemented across the codebase",
    {
      nip: z.string().describe("NIP number to search for (e.g., 01, 19, 98)"),
    },
    async ({ nip }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Please find all implementations of NIP-${nip} in the codebase:

1. Call query_nips to get an overview of NIP usage across all repos

2. Call find_nip_in_extracted with the NIP number ${nip} to find specific files

3. Call get_nip_details with nip_number=${nip} to get details from the NIP matrix

4. Summarize:
   - Which repos implement this NIP?
   - What files contain the implementation?
   - What event kinds are associated with it?
   - Any related NIPs that are commonly used together?`,
          },
        },
      ],
    })
  );
}
