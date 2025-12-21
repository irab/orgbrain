# OrgBrain MCP Server

A reusable Model Context Protocol (MCP) server that provides knowledge-extraction and cross-repo analysis tools for multi-repository organizations. Extract type definitions, user flows, service dependencies, infrastructure configs, and more — then query across your entire codebase.

## Features

- **Org-wide analysis**: Inventory and analyze many repos across an org; helper script to add all repos from a GitHub org.
- **Cross-repo type mapping**: Extract data structures across languages (Rust, TypeScript, Python, Go, Dart) and find shared types between services.
- **Config-driven**: Point the server to a YAML file of repos to analyze.
- **Pluggable extractors**: Register new extractors in `src/extractors/` and wire them via config.
- **Version-aware tools**: List refs, aggregate types, user flows, data flow, infra, and diagrams across repos.
- **Knowledge store**: Versioned JSON under `knowledge/extracted/` with manifests per repo/ref.
- **Infra-aware**: Kubernetes and Terraform extractors map infrastructure resources.
- **Journey-aware**: Optional journey/impact extractor links journey docs to screens and services.
- **Ready for local dev** (`pnpm dev`) or compiled output (`pnpm build && pnpm start`).

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

#### `type_definitions` - Data Structures & Cross-Repo Contracts

Extracts structs, classes, interfaces, enums, and type aliases across multiple languages. Enables cross-repo type matching to identify shared data contracts between services.

**Supported languages:** Rust, TypeScript, Python, Go, Dart, Protobuf

**Bonus detection:**
- Zod schemas (TypeScript)
- ORM models: Django, SQLAlchemy, GORM, TypeORM, Drizzle, Prisma

```yaml
- name: type_definitions
  config:
    ignore: ["**/generated/**", "**/migrations/**"]  # Patterns to skip
    limit: 300                                        # Max files to process
    includePrivate: true                              # Include non-public types
    prioritize: ["src/models/", "src/types/"]         # Directories to process first
```

**Output includes:**
- Type definitions with fields, variants, generics
- Relationships (extends, implements, contains, collection)
- Module groupings for diagram generation
- Summary statistics by kind/language

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

#### `nip_usage` - Nostr NIP Detection
```yaml
- name: nip_usage
  config:
    patterns: ["NIP-\\d+", "kind:\\s*\\d+"]  # Regex patterns to search
    file_types: ["ts", "js", "rs", "dart", "md"]  # File extensions to scan
```

#### `cloudflare_workers` - Cloudflare Workers Projects
Extracts configuration, API endpoints, and infrastructure from Cloudflare Workers projects (Rust/WASM or JavaScript).

```yaml
- name: cloudflare_workers
  # No config options - auto-detects wrangler.toml
```

**Output includes:**
- Worker name and routes (custom domains)
- KV namespace bindings
- Durable Object bindings and class names
- Queue producers and consumers
- API endpoints (extracted from Rust router patterns)
- Rust dependencies from Cargo.toml
- Compatibility date and build commands

### Example Configurations

#### Backend API with Type Extraction
```yaml
api-service:
  url: git@github.com:org/api-service.git
  type: backend
  language: rust
  default_branch: main
  track:
    branches: [main]
    tags: { pattern: "v*", latest: 5 }
  extractors:
    - name: type_definitions
      config:
        prioritize: ["src/models/", "src/api/"]
    - name: data_flow
    - name: journey_impact
```

#### Frontend App
```yaml
web-client:
  url: git@github.com:org/web-client.git
  type: frontend
  language: typescript
  default_branch: main
  track:
    branches: [main, develop]
  extractors:
    - name: type_definitions
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
    - name: type_definitions
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

#### Multi-Language Service (with Protobuf)
```yaml
data-service:
  url: git@github.com:org/data-service.git
  type: backend
  language: go
  default_branch: main
  extractors:
    - name: type_definitions
      config:
        prioritize: ["proto/", "internal/models/"]
    - name: data_flow
```

#### Cloudflare Worker (Rust/WASM)
```yaml
api-gateway:
  url: git@github.com:org/api-gateway.git
  type: backend
  language: rust
  default_branch: main
  extractors:
    - name: cloudflare_workers
    - name: data_flow
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

# Specify exact extractors
pnpm add:org-repos <org-name> --extractors user_flows,data_flow,type_definitions

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

Use `--extractors` for full control over which extractors to enable.

> **Note:** When you disable a repo in config, its extracted data remains until you run `--prune`. The MCP server automatically filters out disabled repos from query results.

## Tools

Tools are registered in `src/index.ts` from multiple modules:

### Query Tools
- `list_repos` - List repos with their latest extracted ref
- `list_refs` - List branches and tags for each repo (tags sorted by date, branches unsorted)
- `query_nips` - Aggregate NIP usage across repos
- `query_flows` - Aggregate user flows/screens
- `query_monorepos` - Aggregate monorepo structure
- `query_data_flow` - Aggregate service dependencies
- `query_infra` - Aggregate Kubernetes and Terraform data

### Type Analysis Tools
- `query_types` - Search type definitions across repos by name, kind, or repo
- `query_shared_types` - **Find types that appear in multiple repos** (identifies shared data contracts)
- `query_type_relationships` - Get type relationships within a repo (extends, contains, implements)
- `generate_type_flow_diagram` - Generate Mermaid diagram showing cross-repo type flow

### Diagram Tools
- `generate_diagram` - Generate Mermaid flowchart for repo or ecosystem
- `generate_c4_diagram` - Generate C4-style architecture diagrams (context, container, component, dynamic, deployment)
  - `detailed: true` - Show ALL elements without truncation (default: false)
  - `export: true` - Include export instructions for saving diagram to file

### Extraction Tools
- `extract_ref` - Extract a specific ref for a repo
- `extract_all` - Extract all enabled repos

### Comparison Tools
- `compare_versions` - List available versions for comparison
- `diff_versions` - Compare extractors between refs

### Org Management Tools
- `connect_org` - Add repos from a GitHub org
- `disconnect_repo` - Remove a repo from config
- `toggle_repo` - Enable/disable a repo
- `job_status` - Check extraction job status

### Diagram Generation Example

```
# Generate a container diagram for a repo
generate_c4_diagram(repo: "my-app", type: "container")

# Generate a FULL diagram with ALL elements (no truncation)
generate_c4_diagram(repo: "my-app", type: "deployment", detailed: true)

# Generate diagram with export instructions
generate_c4_diagram(repo: "my-app", type: "deployment", detailed: true, export: true)
# Returns: { mermaid: "...", exportTo: { suggestedPath: "docs/diagrams/my-app-deployment.md", instruction: "..." } }

# Ecosystem-wide deployment diagram
generate_c4_diagram(type: "deployment", detailed: true, export: true)

# Available diagram types:
# - context: System context (users, external systems)
# - container: Apps, services, databases
# - component: Internal structure (screens, modules)
# - dynamic: Request/interaction flows with numbered steps
# - deployment: Infrastructure (K8s, Cloudflare Workers, Terraform)
```

**Truncation limits (when `detailed: false`):**
| Element | Limit |
|---------|-------|
| Endpoints | 8 |
| Services | 5 |
| Screens | 8 |
| K8s Deployments | 5 |
| Apps per repo (ecosystem) | 4 |

Use `detailed: true` to show ALL elements without limits.

### Cross-Repo Type Analysis Example

```
# Find shared types between your services
query_shared_types()

# Result shows types appearing in multiple repos:
{
  "sharedTypes": [
    {
      "name": "user",
      "similarity": 85,
      "repos": ["api-service", "web-client", "mobile-app"],
      "instances": [
        { "repo": "api-service", "kind": "struct", "language": "rust" },
        { "repo": "web-client", "kind": "interface", "language": "typescript" },
        { "repo": "mobile-app", "kind": "class", "language": "dart" }
      ]
    }
  ]
}

# Generate a diagram showing type flow between repos
generate_type_flow_diagram()
```

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
diff_versions(from_ref: "main", to_ref: "develop", extractor: "type_definitions")
```

Returns:
- **Per-repo diffs**: which extractors changed and what was added/removed
- **Aggregated ecosystem diff**: types, screens, services, K8s resources across all repos
- **Mermaid diagram**: visual representation of the diff

## MCP Resources

The server exposes knowledge files as MCP Resources that clients can browse and read directly:

| Resource URI | Description |
|--------------|-------------|
| `knowledge://index` | Index of all available knowledge |
| `knowledge://extracted/{repo}/{ref}/{extractor}` | Extracted data (e.g., `knowledge://extracted/my-app/branch-main/type_definitions`) |
| `knowledge://static/{path}` | Static knowledge files (markdown, matrices) |

**Example URIs:**
```
knowledge://index
knowledge://extracted/example-repo/branch-main/type_definitions
knowledge://extracted/example-repo/branch-main/user_flows
knowledge://static/matrices/nip-usage.json
```

## Adding your own extractor

1) Create a file in `src/extractors/` that exports an `Extractor` and calls `registerExtractor` (see existing extractors as templates). Implement `canExtract` (lightweight file check) and `extract` (do the work, return `ExtractionResult`).

2) Import your file in `src/extractors/index.ts` so it registers at startup.

3) Add the extractor to any repo in `config/repos.yaml` under `repositories.<name>.extractors`, with optional `config` passed to your extractor.

4) Run `pnpm build:knowledge` to generate knowledge; results appear under `knowledge/extracted/<repo>/<ref>/your_extractor.json`.

Keep extractors fast; use `gitManager` helpers for file listing/grep at refs, and limit file counts to avoid timeouts.

## Project structure

```
src/
├── index.ts                    # Server entrypoint
├── lib/
│   ├── config-loader.ts        # YAML config loader
│   ├── git-manager.ts          # Git helpers (clone/fetch/list/grep)
│   ├── extractor-base.ts       # Extractor interface/registry
│   ├── extraction-runner.ts    # Orchestrates extractors
│   └── knowledge-store.ts      # Versioned knowledge storage
├── extractors/
│   ├── index.ts                # Registers all extractors
│   ├── app/                    # App-level extractors
│   │   ├── user-flows.ts
│   │   ├── data-flow.ts
│   │   ├── nip-usage.ts
│   │   └── monorepo.ts
│   ├── infra/                  # Infrastructure extractors
│   │   ├── kubernetes.ts
│   │   ├── terraform.ts
│   │   └── cloudflare-workers.ts
│   ├── architecture/           # Architecture extractors
│   │   └── journey-impact.ts
│   └── types/                  # Type definition extractor
│       ├── index.ts            # Main extractor
│       ├── schema.ts           # Type definitions & helpers
│       └── parsers/            # Language-specific parsers
│           ├── index.ts        # Parser registry
│           ├── rust.ts
│           ├── typescript.ts
│           ├── python.ts
│           ├── go.ts
│           ├── dart.ts
│           ├── protobuf.ts
│           ├── zod.ts          # Zod schema detection
│           └── orm.ts          # ORM model detection
├── tools/
│   ├── index.ts                # Tool aggregator
│   ├── queries.ts              # Query tools
│   ├── diagrams.ts             # Diagram generation
│   ├── extraction.ts           # On-demand extraction
│   ├── comparison.ts           # Version comparison
│   ├── org.ts                  # Org management
│   └── types.ts                # Type analysis tools
├── prompts.ts                  # MCP prompts
└── resources.ts                # MCP resources

scripts/
├── build-knowledge.ts          # CLI for knowledge extraction
└── add-org-repos.ts            # Add repos from GitHub org

config/
├── example.repos.yaml          # Sample config
└── repos.yaml                  # Your config (gitignored)

knowledge/
└── extracted/                  # Extracted knowledge (gitignored)
    └── {repo}/
        └── branch-{ref}/
            ├── manifest.json
            ├── type_definitions.json
            ├── user_flows.json
            └── ...
```

## Contributing / Extending

- Add new tools in `src/tools/` and register in `src/tools/index.ts`.
- Add new extractors in `src/extractors/` and import in `src/extractors/index.ts`.
- For the type extractor, add new language parsers in `src/extractors/types/parsers/`.
- Keep sample configs free of sensitive data.

## License

MIT (see `LICENSE`).
