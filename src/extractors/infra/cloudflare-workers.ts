/**
 * Cloudflare Workers extractor
 * Extracts configuration and API routes from Cloudflare Workers projects
 */

import type { Extractor, ExtractionContext, ExtractionResult } from "../../lib/extractor-base.js";
import { registerExtractor } from "../../lib/extractor-base.js";

interface WorkerRoute {
  pattern: string;
  customDomain?: boolean;
}

interface KVNamespace {
  binding: string;
  id?: string;
}

interface DurableObject {
  name: string;
  className: string;
}

interface Queue {
  name: string;
  binding?: string;
  type: "producer" | "consumer";
  deadLetterQueue?: string;
}

interface APIEndpoint {
  method: string;
  path: string;
  file: string;
  description?: string;
}

interface CloudflareWorkersData {
  name: string;
  routes: WorkerRoute[];
  kvNamespaces: KVNamespace[];
  durableObjects: DurableObject[];
  queues: Queue[];
  variables: Record<string, string>;
  endpoints: APIEndpoint[];
  dependencies: Array<{ name: string; version: string; features?: string[] }>;
  buildCommand?: string;
  compatibilityDate?: string;
}

const cloudflareWorkersExtractor: Extractor = {
  name: "cloudflare_workers",
  description: "Extract Cloudflare Workers configuration, routes, KV bindings, queues, and API endpoints",

  async canExtract(ctx: ExtractionContext): Promise<boolean> {
    const files = await ctx.gitManager.listFilesAtRef(ctx.repoPath, ctx.ref);
    return files.some((f) => f === "wrangler.toml" || f.endsWith("/wrangler.toml"));
  },

  async extract(ctx: ExtractionContext): Promise<ExtractionResult> {
    const allFiles = await ctx.gitManager.listFilesAtRef(ctx.repoPath, ctx.ref);
    
    const data: CloudflareWorkersData = {
      name: "",
      routes: [],
      kvNamespaces: [],
      durableObjects: [],
      queues: [],
      variables: {},
      endpoints: [],
      dependencies: [],
    };

    // Find and parse wrangler.toml
    const wranglerFile = allFiles.find((f) => f === "wrangler.toml" || f.endsWith("/wrangler.toml"));
    if (wranglerFile) {
      try {
        const content = await ctx.gitManager.getFileAtRef(ctx.repoPath, ctx.ref, wranglerFile);
        parseWranglerToml(content, data);
      } catch {
        // skip
      }
    }

    // Parse Cargo.toml for Rust dependencies
    const cargoFile = allFiles.find((f) => f === "Cargo.toml" || f.endsWith("/Cargo.toml"));
    if (cargoFile) {
      try {
        const content = await ctx.gitManager.getFileAtRef(ctx.repoPath, ctx.ref, cargoFile);
        parseCargoToml(content, data);
      } catch {
        // skip
      }
    }

    // Find API endpoints in Rust source files
    const rustFiles = allFiles.filter((f) => f.endsWith(".rs")).slice(0, 30);
    for (const file of rustFiles) {
      try {
        const content = await ctx.gitManager.getFileAtRef(ctx.repoPath, ctx.ref, file);
        data.endpoints.push(...findRustEndpoints(content, file));
      } catch {
        // skip
      }
    }

    // Find API endpoints in TypeScript/JavaScript source files
    const jsFiles = allFiles.filter((f) => 
      (f.endsWith(".ts") || f.endsWith(".js")) && 
      !f.includes("node_modules") &&
      (f.includes("src/") || f.includes("worker"))
    ).slice(0, 30);
    
    for (const file of jsFiles) {
      try {
        const content = await ctx.gitManager.getFileAtRef(ctx.repoPath, ctx.ref, file);
        data.endpoints.push(...findJSEndpoints(content, file));
      } catch {
        // skip
      }
    }

    return {
      extractor: this.name,
      repo: ctx.repoName,
      ref: ctx.ref,
      extractedAt: new Date(),
      data,
    };
  },
};

function parseWranglerToml(content: string, data: CloudflareWorkersData): void {
  // Parse name
  const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
  if (nameMatch) {
    data.name = nameMatch[1];
  }

  // Parse compatibility_date
  const compatMatch = content.match(/^compatibility_date\s*=\s*"([^"]+)"/m);
  if (compatMatch) {
    data.compatibilityDate = compatMatch[1];
  }

  // Parse build command
  const buildMatch = content.match(/\[build\][\s\S]*?command\s*=\s*"([^"]+)"/m);
  if (buildMatch) {
    data.buildCommand = buildMatch[1];
  }

  // Parse routes
  const routesMatch = content.match(/routes\s*=\s*\[([\s\S]*?)\]/m);
  if (routesMatch) {
    const routePatterns = routesMatch[1].matchAll(/pattern\s*=\s*"([^"]+)"[^}]*?(custom_domain\s*=\s*true)?/g);
    for (const match of routePatterns) {
      data.routes.push({
        pattern: match[1],
        customDomain: !!match[2],
      });
    }
  }

  // Parse KV namespaces
  const kvMatches = content.matchAll(/\[\[kv_namespaces\]\][\s\S]*?binding\s*=\s*"([^"]+)"[\s\S]*?(?:id\s*=\s*"([^"]+)")?/g);
  for (const match of kvMatches) {
    data.kvNamespaces.push({
      binding: match[1],
      id: match[2],
    });
  }

  // Parse Durable Objects
  const doMatches = content.matchAll(/\[\[durable_objects\.bindings\]\][\s\S]*?name\s*=\s*"([^"]+)"[\s\S]*?class_name\s*=\s*"([^"]+)"/g);
  for (const match of doMatches) {
    data.durableObjects.push({
      name: match[1],
      className: match[2],
    });
  }

  // Parse Queue producers
  const prodMatches = content.matchAll(/\[\[queues\.producers\]\][\s\S]*?queue\s*=\s*"([^"]+)"[\s\S]*?binding\s*=\s*"([^"]+)"/g);
  for (const match of prodMatches) {
    data.queues.push({
      name: match[1],
      binding: match[2],
      type: "producer",
    });
  }

  // Parse Queue consumers
  const consMatches = content.matchAll(/\[\[queues\.consumers\]\][\s\S]*?queue\s*=\s*"([^"]+)"[\s\S]*?(?:dead_letter_queue\s*=\s*"([^"]+)")?/g);
  for (const match of consMatches) {
    data.queues.push({
      name: match[1],
      type: "consumer",
      deadLetterQueue: match[2],
    });
  }

  // Parse vars
  const varsMatch = content.match(/\[vars\]([\s\S]*?)(?=\n\[|$)/m);
  if (varsMatch) {
    const varMatches = varsMatch[1].matchAll(/^(\w+)\s*=\s*"([^"]+)"/gm);
    for (const match of varMatches) {
      data.variables[match[1]] = match[2];
    }
  }
}

function parseCargoToml(content: string, data: CloudflareWorkersData): void {
  // Find [dependencies] section
  const depsMatch = content.match(/\[dependencies\]([\s\S]*?)(?=\n\[|$)/);
  if (!depsMatch) return;

  const depsSection = depsMatch[1];

  // Parse simple deps: name = "version"
  const simpleMatches = depsSection.matchAll(/^(\w[\w-]*)\s*=\s*"([^"]+)"/gm);
  for (const match of simpleMatches) {
    data.dependencies.push({
      name: match[1],
      version: match[2],
    });
  }

  // Parse complex deps: name = { version = "...", features = [...] }
  const complexMatches = depsSection.matchAll(/^(\w[\w-]*)\s*=\s*\{([^}]+)\}/gm);
  for (const match of complexMatches) {
    const name = match[1];
    const props = match[2];
    
    const versionMatch = props.match(/version\s*=\s*"([^"]+)"/);
    const featuresMatch = props.match(/features\s*=\s*\[([^\]]+)\]/);
    
    const dep: { name: string; version: string; features?: string[] } = {
      name,
      version: versionMatch ? versionMatch[1] : "workspace",
    };
    
    if (featuresMatch) {
      dep.features = featuresMatch[1]
        .split(",")
        .map((f) => f.trim().replace(/"/g, ""))
        .filter(Boolean);
    }
    
    data.dependencies.push(dep);
  }
}

function findRustEndpoints(content: string, file: string): APIEndpoint[] {
  const endpoints: APIEndpoint[] = [];

  // Look for route patterns in match statements
  // Pattern: (Method::Get, "/path") => handler
  const routeMatches = content.matchAll(/\(Method::(\w+),\s*"([^"]+)"\)\s*=>/g);
  for (const match of routeMatches) {
    endpoints.push({
      method: match[1].toUpperCase(),
      path: match[2],
      file,
    });
  }

  // Look for path.starts_with patterns
  const startsWithMatches = content.matchAll(/path\.starts_with\("([^"]+)"\)/g);
  for (const match of startsWithMatches) {
    // Try to find the method from context
    const contextStart = Math.max(0, content.lastIndexOf("\n", match.index) - 200);
    const context = content.slice(contextStart, match.index);
    const methodMatch = context.match(/Method::(\w+)/);
    
    endpoints.push({
      method: methodMatch ? methodMatch[1].toUpperCase() : "GET",
      path: match[1] + "*",
      file,
    });
  }

  // Look for ABOUTME comments for descriptions
  const aboutMeMatch = content.match(/\/\/\s*ABOUTME:\s*(.+)/);
  if (aboutMeMatch && endpoints.length > 0) {
    endpoints[0].description = aboutMeMatch[1].trim();
  }

  return endpoints;
}

function findJSEndpoints(content: string, file: string): APIEndpoint[] {
  const endpoints: APIEndpoint[] = [];

  // Look for router patterns: router.get('/path', handler)
  const routerMatches = content.matchAll(/router\.(get|post|put|delete|patch|options)\s*\(\s*['"]([^'"]+)['"]/gi);
  for (const match of routerMatches) {
    endpoints.push({
      method: match[1].toUpperCase(),
      path: match[2],
      file,
    });
  }

  // Look for Hono-style routes: app.get('/path', ...)
  const honoMatches = content.matchAll(/app\.(get|post|put|delete|patch|options)\s*\(\s*['"]([^'"]+)['"]/gi);
  for (const match of honoMatches) {
    endpoints.push({
      method: match[1].toUpperCase(),
      path: match[2],
      file,
    });
  }

  // Look for case patterns: case '/path':
  const caseMatches = content.matchAll(/case\s+['"](\/?[^'"]+)['"]\s*:/g);
  for (const match of caseMatches) {
    if (match[1].startsWith("/")) {
      endpoints.push({
        method: "GET",
        path: match[1],
        file,
      });
    }
  }

  return endpoints;
}

registerExtractor(cloudflareWorkersExtractor);
export { cloudflareWorkersExtractor };


