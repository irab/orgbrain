/**
 * Cross-Repository Service Dependency Mapper
 * 
 * Analyzes HTTP calls across repositories and maps them to services
 * in other repositories to build a complete service-to-service call graph.
 */

import { KnowledgeStore } from "../lib/knowledge-store.js";
import { promises as fs } from "fs";
import { join } from "path";

export interface ServiceEndpoint {
  repo: string;
  service: string;
  method: string;
  path: string;
  file: string;
}

export interface ServiceCall {
  fromRepo: string;
  fromService: string;
  toRepo: string;
  toService?: string;
  url: string;
  method?: string;
  file: string;
  line: number;
}

export interface CrossRepoServiceMap {
  endpoints: ServiceEndpoint[];
  calls: ServiceCall[];
  graph: {
    nodes: Array<{ id: string; repo: string; service: string; type: "service" | "external" }>;
    links: Array<{ source: string; target: string; calls: number; urls: string[] }>;
  };
}

/**
 * Extract service endpoints from a repository's data
 */
function extractEndpoints(repo: string, data: Record<string, unknown>): ServiceEndpoint[] {
  const endpoints: ServiceEndpoint[] = [];

  // Extract from cloudflare_workers (has endpoints)
  if (data.cloudflare_workers) {
    const cfWorkers = data.cloudflare_workers as { endpoints?: Array<{ method: string; path: string; file: string }> };
    if (cfWorkers.endpoints) {
      cfWorkers.endpoints.forEach(endpoint => {
        endpoints.push({
          repo,
          service: inferServiceFromFile(endpoint.file),
          method: endpoint.method,
          path: endpoint.path,
          file: endpoint.file,
        });
      });
    }
  }

  // Extract from kubernetes (services expose endpoints)
  if (data.kubernetes) {
    const k8s = data.kubernetes as { services?: Array<{ name: string; namespace: string; ingress?: { host: string; paths: string[] } }> };
    if (k8s.services) {
      k8s.services.forEach(service => {
        if (service.ingress) {
          service.ingress.paths.forEach(path => {
            endpoints.push({
              repo,
              service: service.name,
              method: "GET", // Default, could be enhanced
              path: path,
              file: `${service.namespace}/${service.name}`,
            });
          });
        }
      });
    }
  }

  // Extract from data_flow services (infer endpoints from service names/files)
  if (data.data_flow) {
    const dataFlow = data.data_flow as { services?: Array<{ name: string; file: string }> };
    if (dataFlow.services) {
      dataFlow.services.forEach(service => {
        // Try to infer common endpoint patterns
        const serviceName = service.name.toLowerCase().replace(/\s+/g, "-");
        endpoints.push({
          repo,
          service: service.name,
          method: "POST", // Default for services
          path: `/api/${serviceName}`,
          file: service.file,
        });
      });
    }
  }

  return endpoints;
}

/**
 * Extract HTTP calls from a repository's data
 */
function extractCalls(repo: string, data: Record<string, unknown>): ServiceCall[] {
  const calls: ServiceCall[] = [];

  if (data.data_flow) {
    const dataFlow = data.data_flow as {
      services?: Array<{ name: string; file: string }>;
      externalCalls?: Array<{ file: string; line: number; target: string }>;
    };

    if (dataFlow.externalCalls) {
      dataFlow.externalCalls.forEach(call => {
        // Find which service made this call
        const service = dataFlow.services?.find(s => s.file === call.file)?.name || inferServiceFromFile(call.file);

        calls.push({
          fromRepo: repo,
          fromService: service,
          toRepo: "", // Will be resolved later
          url: call.target,
          file: call.file,
          line: call.line,
        });
      });
    }
  }

  return calls;
}

/**
 * Infer service name from file path
 */
function inferServiceFromFile(file: string): string {
  const parts = file.split("/");
  const filename = parts[parts.length - 1];
  return filename
    .replace(/\.(ts|js|dart|rs)$/, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim() || parts[parts.length - 2] || "unknown";
}

/**
 * Match a URL to a service endpoint
 */
function matchUrlToEndpoint(url: string, endpoints: ServiceEndpoint[]): ServiceEndpoint | null {
  try {
    const urlObj = new URL(url.startsWith("http") ? url : `https://${url}`);
    const urlPath = urlObj.pathname;
    const urlHost = urlObj.hostname;

    // Try exact path match
    let match = endpoints.find(e => e.path === urlPath || urlPath.startsWith(e.path));
    if (match) return match;

    // Try hostname-based matching (e.g., api.example.com -> example service)
    if (urlHost && urlHost !== "localhost" && !urlHost.includes("example.com")) {
      const hostParts = urlHost.split(".");
      const serviceName = hostParts[0]; // e.g., "api" from "api.example.com"
      match = endpoints.find(e => 
        e.service.toLowerCase().includes(serviceName) ||
        serviceName.includes(e.service.toLowerCase().split(" ")[0])
      );
      if (match) return match;
    }

    // Try fuzzy path matching
    const pathParts = urlPath.split("/").filter(Boolean);
    if (pathParts.length > 0) {
      const firstPart = pathParts[0];
      match = endpoints.find(e => 
        e.path.includes(firstPart) ||
        e.service.toLowerCase().includes(firstPart) ||
        firstPart.includes(e.service.toLowerCase().split(" ")[0])
      );
      if (match) return match;
    }

    return null;
  } catch {
    // Invalid URL, try simple string matching
    const urlLower = url.toLowerCase();
    return endpoints.find(e => 
      urlLower.includes(e.service.toLowerCase()) ||
      e.path && urlLower.includes(e.path.toLowerCase())
    ) || null;
  }
}

/**
 * Build cross-repository service dependency map
 */
export async function buildCrossRepoServiceMap(
  knowledgeDir: string = "knowledge/extracted"
): Promise<CrossRepoServiceMap> {
  const store = new KnowledgeStore(knowledgeDir);
  const repos = await store.listRepos();

  const allEndpoints: ServiceEndpoint[] = [];
  const allCalls: ServiceCall[] = [];

  // Collect endpoints and calls from all repos
  for (const repo of repos) {
    try {
      const versions = await store.listVersions(repo);
      if (versions.length === 0) continue;

      const latest = versions[0];
      const data = await store.load(repo, latest.refType as "branch" | "tag", latest.ref);
      if (!data) continue;

      // Extract endpoints
      const endpoints = extractEndpoints(repo, data.data);
      allEndpoints.push(...endpoints);

      // Extract calls
      const calls = extractCalls(repo, data.data);
      allCalls.push(...calls);
    } catch (error) {
      console.warn(`Failed to process ${repo}:`, error);
    }
  }

  // Match calls to endpoints
  const resolvedCalls: ServiceCall[] = [];
  const unmatchedCalls: ServiceCall[] = [];

  for (const call of allCalls) {
    const matchedEndpoint = matchUrlToEndpoint(call.url, allEndpoints);
    if (matchedEndpoint) {
      resolvedCalls.push({
        ...call,
        toRepo: matchedEndpoint.repo,
        toService: matchedEndpoint.service,
        method: matchedEndpoint.method,
      });
    } else {
      // Mark as external/unmatched
      unmatchedCalls.push({
        ...call,
        toRepo: "<external>",
      });
    }
  }

  // Build graph nodes and links
  const nodeMap = new Map<string, { id: string; repo: string; service: string; type: "service" | "external" }>();
  const linkMap = new Map<string, { source: string; target: string; calls: number; urls: string[] }>();

  // Add nodes from endpoints
  allEndpoints.forEach(endpoint => {
    const nodeId = `${endpoint.repo}:${endpoint.service}`;
    if (!nodeMap.has(nodeId)) {
      nodeMap.set(nodeId, {
        id: nodeId,
        repo: endpoint.repo,
        service: endpoint.service,
        type: "service",
      });
    }
  });

  // Add nodes from calls (services that make calls)
  resolvedCalls.forEach(call => {
    const fromId = `${call.fromRepo}:${call.fromService}`;
    const toId = `${call.toRepo}:${call.toService}`;

    if (!nodeMap.has(fromId)) {
      nodeMap.set(fromId, {
        id: fromId,
        repo: call.fromRepo,
        service: call.fromService,
        type: "service",
      });
    }

    if (!nodeMap.has(toId)) {
      nodeMap.set(toId, {
        id: toId,
        repo: call.toRepo,
        service: call.toService || "unknown",
        type: "service",
      });
    }

    // Add link
    const linkKey = `${fromId}->${toId}`;
    if (!linkMap.has(linkKey)) {
      linkMap.set(linkKey, {
        source: fromId,
        target: toId,
        calls: 0,
        urls: [],
      });
    }
    const link = linkMap.get(linkKey)!;
    link.calls++;
    if (!link.urls.includes(call.url)) {
      link.urls.push(call.url);
    }
  });

  // Add external nodes
  unmatchedCalls.forEach(call => {
    const fromId = `${call.fromRepo}:${call.fromService}`;
    const externalId = `external:${call.url}`;

    if (!nodeMap.has(fromId)) {
      nodeMap.set(fromId, {
        id: fromId,
        repo: call.fromRepo,
        service: call.fromService,
        type: "service",
      });
    }

    if (!nodeMap.has(externalId)) {
      nodeMap.set(externalId, {
        id: externalId,
        repo: "<external>",
        service: call.url.substring(0, 50),
        type: "external",
      });
    }

    const linkKey = `${fromId}->${externalId}`;
    if (!linkMap.has(linkKey)) {
      linkMap.set(linkKey, {
        source: fromId,
        target: externalId,
        calls: 0,
        urls: [],
      });
    }
    const link = linkMap.get(linkKey)!;
    link.calls++;
    if (!link.urls.includes(call.url)) {
      link.urls.push(call.url);
    }
  });

  // Ensure we always return valid arrays
  const graphNodes = Array.from(nodeMap.values());
  const graphLinks = Array.from(linkMap.values());

  return {
    endpoints: allEndpoints,
    calls: [...resolvedCalls, ...unmatchedCalls],
    graph: {
      nodes: graphNodes.length > 0 ? graphNodes : [],
      links: graphLinks.length > 0 ? graphLinks : [],
    },
  };
}

