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
`config/example.repos.yaml` demonstrates the expected shape (copy to `config/repos.yaml` to edit):

```yaml
version: "1.0"
cache_dir: .repo-cache
knowledge_dir: knowledge/extracted
repositories:
  sample-frontend:
    url: https://github.com/example-org/sample-frontend.git
    description: Example frontend app
    type: frontend
    language: typescript
    default_branch: main
    track:
      branches: [main]
    extractors:
      - name: nip_usage
        config:
          patterns: ["NIP-\\d+", "kind:\\s*\\d+"]
          file_types: ["ts", "js", "md"]
      - name: user_flows
      - name: data_flow
```

Add more repos under `repositories:` and tune extractor configs per repo.

## Knowledge extraction
- `pnpm build:knowledge` — clone/fetch repos, run all configured extractors, write to `knowledge/extracted/`.
- `pnpm build:knowledge --repo <name>` — only one repo.
- `pnpm build:knowledge --ref <branch-or-tag>` — only one ref.
- `pnpm build:knowledge --force` — rebuild even if fresh.
- `pnpm build:knowledge --list` — list extracted versions (highlights disabled repos).
- `pnpm build:knowledge --prune` — **remove stale data** from disabled or removed repos.
- `pnpm add:org-repos <org>` — populate `config/repos.yaml` from a GitHub org (requires `gh` auth).
- `pnpm add:org-repos <org> -i` — **interactive mode**: select which repos to enable/disable.

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

Extractors live in `src/extractors/` and register themselves on import via `registerExtractor`. Included: `nip_usage`, `user_flows`, `data_flow`, `kubernetes`, `terraform`, and `journey_impact`.

## Tools
Tools are registered in `src/index.ts` from two bundles:
- Legacy/utility (`src/tools.ts`): `health_check`, `search_knowledge`, `list_knowledge`, `get_resource`, `get_nip_details`, `find_nip_in_extracted`.
- Version-aware (`src/tools-v2.ts`): `list_repos`, `list_refs`, `query_nips`, `query_flows`, `query_data_flow`, `query_infra`, `compare_versions`, `diff_versions`, `extract_ref`, `extract_all`, `generate_diagram`, `generate_c4_diagram`.

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
