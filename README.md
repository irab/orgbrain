# OrgBrain MCP Server

A reusable Model Context Protocol (MCP) server that can host tools and run a knowledge-extraction pipeline across multiple repositories (NIP usage, user flows, data flow, Kubernetes, Terraform, journey impact, etc.). This is the de-branded, org-agnostic build with the full toolset exposed.

## Features
- Org-wide: built to inventory and analyze many repos across an org; helper script to add all repos from a GitHub org.
- Config-driven: point the server to a YAML file of repos to analyze.
- Pluggable extractors: register new extractors in `src/extractors/` and wire them via config.
- Version-aware tools: list refs, aggregate NIP usage, user flows, data flow, infra, and diagrams across repos.
- Knowledge store: versioned JSON under `knowledge/extracted/` with manifests per repo/ref.
- Infra-aware: Kubernetes extractor maps env → cluster → namespace → apps (best effort from ArgoCD/helm paths).
- Journey-aware: optional journey/impact extractor links journey docs to screens and services when present.
- Ready for local dev (`pnpm dev`) or compiled output (`pnpm build && pnpm start`).

## Quickstart
Requirements: Node.js 18+ and pnpm. For org bootstrap: [GitHub CLI (`gh`)](https://cli.github.com/) authenticated.

```bash
# install deps
pnpm install

# bootstrap config from a GitHub org (requires `gh auth login` first)
pnpm add:org-repos <your-org>

# or manually: copy the example and edit
cp config/example.repos.yaml config/repos.yaml
```

Once `config/repos.yaml` exists:

```bash
# run in dev mode (watches for changes)
pnpm dev

# or build then run compiled output
pnpm build
pnpm start
```

The server reads `MCP_CONFIG` (defaults to `config/repos.yaml`).

```bash
# override config path if needed
MCP_CONFIG=path/to/custom.yaml pnpm dev
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_CONFIG` | `config/repos.yaml` | Path to configuration file |

## Using from an MCP client

The server uses stdio transport — MCP clients spawn it as a subprocess.

### Cursor

Add to `.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` globally):

```json
{
  "mcpServers": {
    "orgbrain": {
      "command": "node",
      "args": ["/absolute/path/to/orgbrain-mcp-server/dist/index.js"],
      "env": {
        "MCP_CONFIG": "/absolute/path/to/orgbrain-mcp-server/config/repos.yaml"
      }
    }
  }
}
```

> **Note:** Run `pnpm build` first to generate `dist/index.js`. Use absolute paths.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "orgbrain": {
      "command": "node",
      "args": ["/absolute/path/to/orgbrain-mcp-server/dist/index.js"],
      "env": {
        "MCP_CONFIG": "/absolute/path/to/orgbrain-mcp-server/config/repos.yaml"
      }
    }
  }
}
```

### MCP CLI

```bash
npx @modelcontextprotocol/cli@latest call \
  --command list_repos \
  --server "node dist/index.js"
```

## Configuration

Copy `config/example.repos.yaml` to `config/repos.yaml` and customize.

### Global Settings

```yaml
version: "1.0"
cache_dir: .repo-cache           # Where git repos are cloned
knowledge_dir: knowledge/extracted  # Where extracted data is stored

# Optional: customize diagram colors by repo type
diagram_styles:
  frontend: "#4CAF50"
  backend: "#FF9800"
  infrastructure: "#607D8B"
```

### Repository Configuration

```yaml
repositories:
  my-repo:
    # Required fields
    url: https://github.com/org/repo.git  # Or git@github.com:org/repo.git
    description: "What this repo does"
    type: frontend                         # frontend | backend | infrastructure | library | documentation | unknown
    language: typescript
    default_branch: main

    # Optional fields
    enabled: true                          # Set to false to skip this repo
    private: true                          # Informational flag

    # What refs to track
    track:
      branches: [main, develop]            # Extract these branches
      tags:
        pattern: "v*"                      # Glob pattern for tags
        latest: 5                          # Only extract N most recent matching tags

    # Extractors to run
    extractors:
      - name: extractor_name
        config: { ... }                    # Extractor-specific config
```

### Extractor Configurations

#### `nip_usage` - Nostr NIP Detection
```yaml
- name: nip_usage
  config:
    patterns: ["NIP-\\d+", "kind:\\s*\\d+"]  # Regex patterns to search
    file_types: ["ts", "js", "rs", "dart", "md"]  # File extensions to scan
```

#### `user_flows` - UI Screens & Navigation
```yaml
- name: user_flows
  config:
    ignore: ["**/*.test.*", "**/stories/*"]  # Glob patterns to skip
    limit: 50                                 # Max files to process
```

#### `data_flow` - Service Dependencies
```yaml
- name: data_flow
  # No config options - auto-detects /services/ folders
```

#### `monorepo` - Workspace Structure
```yaml
- name: monorepo
  # No config options - auto-detects turbo.json, pnpm-workspace.yaml, etc.
```

#### `kubernetes` - K8s Manifests
```yaml
- name: kubernetes
  config:
    paths: ["k8s/", "manifests/", "deploy/"]  # Directories to scan
    resource_types: ["Deployment", "Service", "Ingress"]  # Filter by kind
```

#### `terraform` - Infrastructure as Code
```yaml
- name: terraform
  # No config options - scans all *.tf files
```

#### `journey_impact` - Documentation Mapping
```yaml
- name: journey_impact
  # No config options - scans docs/, flows/, journey files
```

### Example Configurations

#### Nostr Project
```yaml
nostr-client:
  url: git@github.com:org/nostr-client.git
  type: frontend
  language: dart
  default_branch: main
  track:
    branches: [main]
    tags: { pattern: "v*", latest: 3 }
  extractors:
    - name: nip_usage
      config:
        patterns: ["NIP-\\d+", "kind:\\s*\\d+"]
        file_types: ["dart", "md"]
    - name: user_flows
    - name: data_flow
    - name: journey_impact
```

#### Turborepo Monorepo
```yaml
my-monorepo:
  url: git@github.com:org/my-monorepo.git
  type: frontend
  language: typescript
  default_branch: main
  track:
    branches: [main, develop]
  extractors:
    - name: monorepo
    - name: user_flows
      config:
        ignore: ["**/node_modules/**", "**/*.test.*"]
    - name: data_flow
    - name: journey_impact
```

#### Infrastructure Repo
```yaml
platform-infra:
  url: git@github.com:org/platform-infra.git
  type: infrastructure
  language: hcl
  default_branch: main
  track:
    branches: [main]
  extractors:
    - name: kubernetes
      config:
        paths: ["k8s/", "argocd/", "helm/"]
    - name: terraform
    - name: journey_impact
```

#### Backend API
```yaml
api-service:
  url: git@github.com:org/api-service.git
  type: backend
  language: go
  default_branch: main
  track:
    branches: [main]
    tags: { pattern: "v*", latest: 5 }
  extractors:
    - name: data_flow
    - name: kubernetes
    - name: journey_impact
```

## CLI Commands

### Knowledge Extraction

```bash
# Extract all enabled repos
pnpm build:knowledge

# Extract specific repo
pnpm build:knowledge --repo my-app

# Extract specific ref (branch or tag)
pnpm build:knowledge --repo my-app --ref v1.0.0

# Force re-extraction (ignore cache)
pnpm build:knowledge --force

# List extracted knowledge
pnpm build:knowledge --list

# Remove stale data from disabled/removed repos
pnpm build:knowledge --prune

# Set max age before re-extraction (seconds)
pnpm build:knowledge --max-age 3600
```

### Adding Repos from GitHub Org

```bash
# Add all repos from org
pnpm add:org-repos <org-name>

# Interactive mode - select which repos to include
pnpm add:org-repos <org-name> -i

# Start fresh - clear existing config first
pnpm add:org-repos <org-name> --reset

# Include NIP extractor (for Nostr projects)
pnpm add:org-repos <org-name> --nips

# Specify exact extractors
pnpm add:org-repos <org-name> --extractors user_flows,data_flow,kubernetes

# Use HTTPS URLs instead of SSH
pnpm add:org-repos <org-name> --https

# Include forks and archived repos
pnpm add:org-repos <org-name> --include-forks --include-archived

# Filter repos by name
pnpm add:org-repos <org-name> --filter "^api-"
pnpm add:org-repos <org-name> --exclude "test|demo"

# Preview without saving
pnpm add:org-repos <org-name> --dry-run
```

### Extractor Auto-Selection

When using `add:org-repos`, extractors are auto-selected based on repo type:

| Repo Type | Extractors |
|-----------|------------|
| Frontend | `monorepo`, `user_flows`, `data_flow`, `journey_impact` |
| Backend | `monorepo`, `data_flow`, `journey_impact` |
| Infrastructure | `monorepo`, `kubernetes`, `terraform`, `journey_impact` |
| Unknown | `monorepo`, `user_flows`, `data_flow`, `kubernetes`, `terraform`, `journey_impact` |

Use `--nips` to add `nip_usage` extractor, or `--extractors` for full control.

> **Note:** When you disable a repo in config, its extracted data remains until you run `--prune`. The MCP server automatically filters out disabled repos from query results.

### Interactive repo selection

Use `-i` or `--interactive` to choose which repos to include:

```bash
pnpm add:org-repos my-org -i
```

This shows a checkbox UI where you can:
- **Space** to toggle repos on/off
- **Enter** to confirm

Repos marked as disabled get `enabled: false` in the config and are skipped during extraction.

Extractors live in `src/extractors/` and register themselves on import via `registerExtractor`. Included:
- `nip_usage` - Nostr NIP references and event kinds
- `user_flows` - UI screens and navigation
- `data_flow` - Service dependencies and HTTP calls
- `monorepo` - Turborepo/pnpm/npm workspace structure, packages, internal deps
- `kubernetes` - K8s manifests, ArgoCD apps, services
- `terraform` - TF resources, modules, providers
- `journey_impact` - Journey docs to screens/services mapping

## MCP Resources

The server exposes knowledge files as MCP Resources that clients can browse and read directly:

| Resource URI | Description |
|--------------|-------------|
| `knowledge://index` | Index of all available knowledge |
| `knowledge://extracted/{repo}/{ref}/{extractor}` | Extracted data (e.g., `knowledge://extracted/my-app/branch-main/user_flows`) |
| `knowledge://static/{path}` | Static knowledge files (markdown, matrices) |

**Example URIs:**
```
knowledge://index
knowledge://extracted/example-repo/branch-main/user_flows
knowledge://extracted/example-repo/branch-main/terraform
knowledge://static/matrices/nip-usage.json
```

## Tools
Tools are registered in `src/index.ts` from two bundles:
- Legacy/utility (`src/tools.ts`): `health_check`, `search_knowledge`, `list_knowledge`, `get_resource`, `get_nip_details`, `find_nip_in_extracted`.
- Version-aware (`src/tools-v2.ts`): `list_repos`, `list_refs`, `query_nips`, `query_flows`, `query_monorepos`, `query_data_flow`, `query_infra`, `compare_versions`, `diff_versions`, `extract_ref`, `extract_all`, `generate_diagram`, `generate_c4_diagram`.

### On-Demand Extraction
The MCP client can trigger extraction directly without running the CLI:

```
# Extract a specific ref for a repo
extract_ref(repo: "my-app", ref: "v2.0.0")
extract_ref(repo: "my-app", ref: "feature/auth", force: true)

# Extract all enabled repos at their configured branches
extract_all()
extract_all(force: true, repos: ["my-app", "my-backend"])
```

Results are stored in `knowledge/extracted/` and immediately available for queries. Cached data is returned if fresh (<24h) unless `force: true`.

### Diff / Compare Versions
Use `compare_versions` to see available refs, then `diff_versions` to compare:

```
diff_versions(from_ref: "v1.0.0", to_ref: "main")
diff_versions(from_ref: "v1.0.0", to_ref: "v2.0.0", repo: "my-app")
diff_versions(from_ref: "main", to_ref: "develop", extractor: "nip_usage")
```

Returns:
- **Per-repo diffs**: which extractors changed and what was added/removed
- **Aggregated ecosystem diff**: NIPs, event kinds, screens, services, K8s resources across all repos
- **Mermaid diagram**: visual representation of the diff

Add your own tools by extending either file and wiring them in `src/index.ts`.

## Adding your own extractor
1) Create a file in `src/extractors/` that exports an `Extractor` and calls `registerExtractor` (see `nip-usage.ts` as a template). Implement `canExtract` (lightweight file check) and `extract` (do the work, return `ExtractionResult`).
2) Import your file in `src/extractors/index.ts` so it registers at startup.
3) Add the extractor to any repo in `config/repos.yaml` under `repositories.<name>.extractors`, with optional `config` passed to your extractor.
4) Run `pnpm build:knowledge` to generate knowledge; results appear under `knowledge/extracted/<repo>/<ref>/your_extractor.json`.

Keep extractors fast; use `gitManager` helpers for file listing/grep at refs, and limit file counts to avoid timeouts.

## Project structure
- `src/index.ts`: server entrypoint; registers tools from `src/tools.ts` and `src/tools-v2.ts`.
- `src/lib/config-loader.ts`: YAML config loader + helpers.
- `src/lib/git-manager.ts`: git helpers for clone/fetch/list/grep.
- `src/lib/extractor-base.ts`: extractor interface/registry.
- `src/lib/extraction-runner.ts`: orchestrates extractors over refs.
- `src/lib/knowledge-store.ts`: versioned knowledge storage.
- `src/extractors/app/`: app-level extractors (user flows, NIP usage, data flow).
- `src/extractors/infra/`: infra extractors (Terraform, Kubernetes).
- `src/extractors/architecture/`: journey impact extractor.
- `scripts/build-knowledge.ts`: CLI to build/list knowledge.
- `scripts/add-org-repos.ts`: helper to add all repos from a GitHub org to config.
- `config/example.repos.yaml`: sample config (copy to `config/repos.yaml`).
- `examples/`: usage notes.

## Contributing / Extending
- Add new tools in `src/lib/router.ts`.
- Add new extractors in `src/extractors/` and wire them in config.
- If your tools need extra services (git, DB, etc.), keep the wiring in `src/lib` and inject via the router.
- Please keep sample configs free of sensitive data.

## License
MIT (see `LICENSE`).
