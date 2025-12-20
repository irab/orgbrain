/**
 * Diagram generation tools - Mermaid flowcharts
 *
 * Supports architecture diagram types (rendered as standard flowcharts):
 * - context: System Context diagram (high-level)
 * - container: Container diagram (apps/services)
 * - component: Component diagram (internal structure)
 * - dynamic: Dynamic diagram (request flows)
 * - deployment: Deployment diagram (infrastructure)
 */

import { loadConfig } from "../lib/config-loader.js";
import {
  ToolHandler,
  safeJson,
  loadFromAllRepos,
  getEcosystemOverview,
  getStore,
  sanitize,
  sanitizeLabel,
  isConfigPackage,
  inferCategory,
} from "./shared.js";

// Types for extracted data
interface Screen {
  name: string;
  file: string;
  navigatesTo?: string[];
}

interface Service {
  name: string;
  file: string;
  dependencies?: string[];
}

interface ExternalCall {
  file: string;
  target: string;
}

interface MonorepoPackage {
  name: string;
  path: string;
  type?: string;
  framework?: string;
}

interface MonorepoData {
  detected?: boolean;
  tool?: string;
  packages?: MonorepoPackage[];
  apps?: MonorepoPackage[];
  libs?: MonorepoPackage[];
  dependencyGraph?: Array<{ from: string; to: string }>;
}

interface UserFlowsData {
  screens?: Screen[];
  routes?: string[];
}

interface DataFlowData {
  services?: Service[];
  externalCalls?: ExternalCall[];
}

interface K8sData {
  deployments?: Array<{ name: string; namespace?: string; replicas?: number; image?: string }>;
  services?: Array<{ name: string; type?: string; ports?: number[] }>;
  configMaps?: Array<{ name: string }>;
  ingresses?: Array<{ name: string; host?: string }>;
}

interface TerraformData {
  resources?: number;
  modules?: number;
  providers?: string[];
}

interface CloudflareWorkersData {
  name?: string;
  routes?: Array<{ pattern: string; customDomain: boolean }>;
  kvNamespaces?: Array<{ binding: string; id?: string }>;
  durableObjects?: Array<{ name: string; className: string }>;
  queues?: Array<{ name: string; binding?: string; type: "producer" | "consumer" }>;
  endpoints?: Array<{ method: string; path: string; file: string; description?: string }>;
  dependencies?: Array<{ name: string; version: string; features?: string[] }>;
  compatibilityDate?: string;
  variables?: Record<string, string>;
}

type C4DiagramType = "context" | "container" | "component" | "dynamic" | "deployment";

const VALID_C4_TYPES: C4DiagramType[] = ["context", "container", "component", "dynamic", "deployment"];

// Configurable limits for diagram elements
interface DiagramLimits {
  endpoints: number;
  endpointsPerFile: number;
  services: number;
  screens: number;
  externalDomains: number;
  k8sDeployments: number;
  k8sServices: number;
  ingresses: number;
  appsPerRepo: number;
  dependencies: number;
}

const DEFAULT_LIMITS: DiagramLimits = {
  endpoints: 8,
  endpointsPerFile: 5,
  services: 5,
  screens: 8,
  externalDomains: 5,
  k8sDeployments: 5,
  k8sServices: 3,
  ingresses: 3,
  appsPerRepo: 4,
  dependencies: 2,
};

const NO_LIMITS: DiagramLimits = {
  endpoints: Infinity,
  endpointsPerFile: Infinity,
  services: Infinity,
  screens: Infinity,
  externalDomains: Infinity,
  k8sDeployments: Infinity,
  k8sServices: Infinity,
  ingresses: Infinity,
  appsPerRepo: Infinity,
  dependencies: Infinity,
};

/**
 * Validate repository name format
 */
function isValidRepoName(repo: unknown): repo is string {
  if (!repo || typeof repo !== "string") return false;
  return /^[a-zA-Z0-9._-]{1,100}$/.test(repo);
}

/**
 * Validate C4 diagram type
 */
function isValidC4Type(type: unknown): type is C4DiagramType {
  return typeof type === "string" && VALID_C4_TYPES.includes(type as C4DiagramType);
}

/**
 * Group screens by their app folder
 */
function groupScreensByApp(screens: Screen[]): Map<string, string[]> {
  const byApp = new Map<string, string[]>();
  for (const screen of screens) {
    const parts = screen.file.split("/");
    const appIdx = parts.findIndex((p) => p === "apps" || p === "app");
    const appName = appIdx >= 0 && parts[appIdx + 1] ? parts[appIdx + 1] : "main";
    if (!byApp.has(appName)) byApp.set(appName, []);
    byApp.get(appName)!.push(screen.name);
  }
  return byApp;
}

/**
 * Extract unique external domains from calls
 */
function getExternalDomains(calls: ExternalCall[], limit: number = 5): string[] {
  const domains = new Set<string>();
  for (const call of calls) {
    try {
      const url = new URL(call.target.split("\n")[0].trim());
      domains.add(url.hostname);
    } catch {
      // Skip invalid URLs
    }
  }
  const all = [...domains];
  return limit === Infinity ? all : all.slice(0, limit);
}

/**
 * Helper to slice with infinity support
 */
function limitSlice<T>(arr: T[], limit: number): T[] {
  return limit === Infinity ? arr : arr.slice(0, limit);
}

/**
 * Get smart description for an app based on name and screens
 */
function getAppDescription(name: string, screens: string[]): string {
  const n = name.toLowerCase();
  if (n.includes("admin") || n.includes("medusa")) return "Admin Dashboard";
  if (n.includes("portal")) {
    const screenList = screens.slice(0, 2).map((s) => sanitizeLabel(s)).join(", ");
    return screens.length > 0 ? `Staff Portal: ${screenList}` : "Staff Portal";
  }
  if (n.includes("api") || n.includes("gateway")) return "API Gateway";
  if (n.includes("website") || n.includes("web")) return "Public Website";
  if (screens.length > 0) {
    const screenList = screens.slice(0, 3).map((s) => sanitizeLabel(s)).join(", ");
    return screenList + (screens.length > 3 ? "..." : "");
  }
  return "Application";
}

// ============================================================================
// Context Diagram - High-level system overview (flowchart)
// ============================================================================

function generateContextDiagram(
  repoName: string,
  repoLabel: string,
  _monorepo: MonorepoData | null,
  dataFlow: DataFlowData | null,
  cfWorkers: CloudflareWorkersData | null = null,
  limits: DiagramLimits = DEFAULT_LIMITS
): string[] {
  const label = sanitizeLabel(repoLabel);
  const lines: string[] = ["flowchart TB"];

  // Users
  lines.push('    User(["👤 User"])');
  lines.push('    Admin(["👤 Admin"])');
  lines.push("");

  // Main system - detect if this is a Cloudflare Worker
  if (cfWorkers?.name) {
    const routes = cfWorkers.routes?.map(r => sanitizeLabel(r.pattern)).join(", ") || "";
    lines.push(`    subgraph ${sanitize(repoName)}["⚡ ${label}"]`);
    lines.push(`        ${sanitize(repoName)}_core["Cloudflare Worker<br/>${routes}"]`);
    lines.push("    end");
  } else {
    lines.push(`    subgraph ${sanitize(repoName)}["🏢 ${label}"]`);
    lines.push(`        ${sanitize(repoName)}_core["The Software System"]`);
    lines.push("    end");
  }
  lines.push("");

  // Cloudflare services used by the worker
  if (cfWorkers) {
    const hasKV = (cfWorkers.kvNamespaces?.length || 0) > 0;
    const hasDO = (cfWorkers.durableObjects?.length || 0) > 0;
    const hasQueues = (cfWorkers.queues?.length || 0) > 0;

    if (hasKV || hasDO || hasQueues) {
      lines.push('    subgraph CF["☁️ Cloudflare Services"]');
      if (hasKV) {
        for (const kv of cfWorkers.kvNamespaces!) {
          const kvLabel = sanitizeLabel(kv.binding);
          lines.push(`        ${sanitize("kv_" + kv.binding)}[("💾 KV: ${kvLabel}")]`);
        }
      }
      if (hasDO) {
        for (const dobj of cfWorkers.durableObjects!) {
          const doLabel = sanitizeLabel(dobj.className);
          lines.push(`        ${sanitize("do_" + dobj.name)}[["🔗 DO: ${doLabel}"]]`);
        }
      }
      if (hasQueues) {
        const uniqueQueues = [...new Set(cfWorkers.queues!.map(q => q.name))];
        for (const queueName of uniqueQueues) {
          const qLabel = sanitizeLabel(queueName);
          lines.push(`        ${sanitize("queue_" + queueName)}>"📬 Queue: ${qLabel}"]`);
        }
      }
      lines.push("    end");
      lines.push("");
    }
  }

  // External systems
  const externals = getExternalDomains(dataFlow?.externalCalls || [], limits.externalDomains);
  if (externals.length > 0) {
    lines.push('    subgraph External["🌐 External Systems"]');
    for (const ext of externals) {
      const extLabel = sanitizeLabel(ext);
      lines.push(`        ${sanitize("ext_" + ext)}[("${extLabel}")]`);
    }
    lines.push("    end");
    lines.push("");
  }

  // Relationships
  lines.push(`    User -->|Uses| ${sanitize(repoName)}`);
  lines.push(`    Admin -->|Administers| ${sanitize(repoName)}`);

  // Worker to Cloudflare services
  if (cfWorkers) {
    for (const kv of cfWorkers.kvNamespaces || []) {
      lines.push(`    ${sanitize(repoName)} -->|Reads/Writes| ${sanitize("kv_" + kv.binding)}`);
    }
    for (const dobj of cfWorkers.durableObjects || []) {
      lines.push(`    ${sanitize(repoName)} -->|Coordinates| ${sanitize("do_" + dobj.name)}`);
    }
    const uniqueQueues = [...new Set((cfWorkers.queues || []).map(q => q.name))];
    for (const queueName of uniqueQueues) {
      lines.push(`    ${sanitize(repoName)} -->|Pub/Sub| ${sanitize("queue_" + queueName)}`);
    }
  }

  for (const ext of externals) {
    lines.push(`    ${sanitize(repoName)} -->|Calls| ${sanitize("ext_" + ext)}`);
  }

  return lines;
}

// ============================================================================
// Container Diagram - Apps/Services within the system (flowchart)
// ============================================================================

function generateContainerDiagram(
  repoName: string,
  repoLabel: string,
  tech: string,
  monorepo: MonorepoData | null,
  userFlows: UserFlowsData | null,
  dataFlow: DataFlowData | null,
  cfWorkers: CloudflareWorkersData | null = null,
  limits: DiagramLimits = DEFAULT_LIMITS
): string[] {
  const label = sanitizeLabel(repoLabel);
  const lines: string[] = ["flowchart TB"];

  // Users
  lines.push('    User(["👤 User"])');
  lines.push("");

  // Cloudflare Worker container diagram
  if (cfWorkers?.name) {
    const workerLabel = sanitizeLabel(cfWorkers.name);
    const routes = cfWorkers.routes?.map(r => r.pattern).join(", ") || "";
    const routeLabel = sanitizeLabel(routes);

    lines.push(`    subgraph ${sanitize(repoName)}_boundary["⚡ ${workerLabel}"]`);

    // API Endpoints
    if (cfWorkers.endpoints && cfWorkers.endpoints.length > 0) {
      lines.push('        subgraph Endpoints["🔌 API Endpoints"]');
      const shownEndpoints = limitSlice(cfWorkers.endpoints, limits.endpoints);
      for (const ep of shownEndpoints) {
        const epId = sanitize(`ep_${ep.method}_${ep.path}`);
        const desc = ep.description ? `<br/>${sanitizeLabel(ep.description.slice(0, 30))}` : "";
        lines.push(`            ${epId}["${ep.method} ${sanitizeLabel(ep.path)}${desc}"]`);
      }
      if (cfWorkers.endpoints.length > shownEndpoints.length) {
        lines.push(`            ep_more["+${cfWorkers.endpoints.length - shownEndpoints.length} more endpoints"]`);
      }
      lines.push("        end");
    }

    // Durable Objects
    if (cfWorkers.durableObjects && cfWorkers.durableObjects.length > 0) {
      lines.push('        subgraph DurableObjects["🔗 Durable Objects"]');
      for (const dobj of cfWorkers.durableObjects) {
        const doId = sanitize(`do_${dobj.name}`);
        const doLabel = sanitizeLabel(dobj.className);
        lines.push(`            ${doId}[["${doLabel}"]]`);
      }
      lines.push("        end");
    }

    lines.push("    end");
    lines.push("");

    // Cloudflare data services
    const hasKV = (cfWorkers.kvNamespaces?.length || 0) > 0;
    const hasQueues = (cfWorkers.queues?.length || 0) > 0;

    if (hasKV || hasQueues) {
      lines.push('    subgraph CF["☁️ Cloudflare Services"]');
      if (hasKV) {
        for (const kv of cfWorkers.kvNamespaces!) {
          const kvLabel = sanitizeLabel(kv.binding);
          lines.push(`        ${sanitize("kv_" + kv.binding)}[("💾 KV: ${kvLabel}")]`);
        }
      }
      if (hasQueues) {
        const uniqueQueues = [...new Set(cfWorkers.queues!.map(q => q.name))];
        for (const queueName of uniqueQueues) {
          const qLabel = sanitizeLabel(queueName);
          lines.push(`        ${sanitize("queue_" + queueName)}>"📬 ${qLabel}"]`);
        }
      }
      lines.push("    end");
      lines.push("");
    }

    // Relationships
    if (routeLabel) {
      lines.push(`    User -->|"${routeLabel}"| ${sanitize(repoName)}_boundary`);
    } else {
      lines.push(`    User -->|HTTPS| ${sanitize(repoName)}_boundary`);
    }

    // Worker internal connections
    if (cfWorkers.durableObjects && cfWorkers.durableObjects.length > 0) {
      lines.push(`    Endpoints -->|coordinates| DurableObjects`);
    }

    // Worker to data services
    for (const kv of cfWorkers.kvNamespaces || []) {
      lines.push(`    ${sanitize(repoName)}_boundary -->|cache| ${sanitize("kv_" + kv.binding)}`);
    }
    const uniqueQueues = [...new Set((cfWorkers.queues || []).map(q => q.name))];
    for (const queueName of uniqueQueues) {
      lines.push(`    ${sanitize(repoName)}_boundary -->|pub/sub| ${sanitize("queue_" + queueName)}`);
    }

    return lines;
  }

  // Standard system boundary (non-worker)
  lines.push(`    subgraph ${sanitize(repoName)}_boundary["🏢 ${label}"]`);

  if (monorepo?.detected) {
    const apps = monorepo.apps || monorepo.packages?.filter((p) => p.type === "app") || [];
    const libs = (monorepo.libs || monorepo.packages?.filter((p) => p.type === "package") || []).filter(
      (p) => !isConfigPackage(p.name)
    );
    const screensByApp = groupScreensByApp(userFlows?.screens || []);

    for (const pkg of apps) {
      const node = sanitize(pkg.name);
      const pkgLabel = sanitizeLabel(pkg.name);
      const pkgTech = sanitizeLabel(pkg.framework || tech);
      const appScreens = screensByApp.get(pkg.name) || [];
      const desc = sanitizeLabel(getAppDescription(pkg.name, appScreens));
      lines.push(`        ${node}["🖥️ ${pkgLabel}<br/>${pkgTech}<br/>${desc}"]`);
    }

    if (libs.length > 0) {
      lines.push('        subgraph Libs["📦 Libraries"]');
      for (const lib of libs) {
        const libLabel = sanitizeLabel(lib.name);
        lines.push(`            ${sanitize(lib.name)}["${libLabel}"]`);
      }
      lines.push("        end");
    }
  } else {
    // Non-monorepo
    const screensByApp = groupScreensByApp(userFlows?.screens || []);
    for (const [app, screens] of screensByApp) {
      const appLabel = sanitizeLabel(app);
      const shownScreens = limitSlice(screens, 3);
      const screenList = shownScreens.map((s) => sanitizeLabel(s)).join(", ");
      const desc = screenList + (screens.length > shownScreens.length ? "..." : "");
      lines.push(`        ${sanitize("ui_" + app)}["🖥️ ${appLabel}<br/>${sanitizeLabel(tech)}<br/>${desc}"]`);
    }

    const services = dataFlow?.services || [];
    if (services.length > 0) {
      lines.push('        subgraph Services["⚙️ Services"]');
      const shownServices = limitSlice(services, limits.services);
      for (const svc of shownServices) {
        const svcLabel = sanitizeLabel(svc.name);
        lines.push(`            ${sanitize("svc_" + svc.name)}["${svcLabel}"]`);
      }
      if (services.length > shownServices.length) {
        lines.push(`            svc_more["+${services.length - shownServices.length} more services"]`);
      }
      lines.push("        end");
    }
  }

  lines.push("    end");
  lines.push("");

  // External systems
  const externals = getExternalDomains(dataFlow?.externalCalls || [], limits.externalDomains);
  if (externals.length > 0) {
    lines.push('    subgraph External["🌐 External APIs"]');
    for (const ext of externals) {
      const extLabel = sanitizeLabel(ext);
      lines.push(`        ${sanitize("ext_" + ext)}[("${extLabel}")]`);
    }
    lines.push("    end");
    lines.push("");
  }

  // Relationships
  if (monorepo?.detected) {
    const apps = monorepo.apps || [];
    const apiApp = apps.find((a) => a.name.includes("api") || a.name.includes("gateway"));

    for (const pkg of apps) {
      if (!pkg.name.includes("api") && !pkg.name.includes("gateway")) {
        lines.push(`    User -->|HTTPS| ${sanitize(pkg.name)}`);
      }
    }

    if (apiApp) {
      for (const pkg of apps) {
        if (pkg !== apiApp && !pkg.name.includes("api")) {
          lines.push(`    ${sanitize(pkg.name)} -->|REST| ${sanitize(apiApp.name)}`);
        }
      }
    }
  }

  for (const ext of externals) {
    lines.push(`    ${sanitize(repoName)}_boundary -->|API| ${sanitize("ext_" + ext)}`);
  }

  return lines;
}

// ============================================================================
// Component Diagram - Internal structure of a container (flowchart)
// ============================================================================

function generateComponentDiagram(
  repoName: string,
  repoLabel: string,
  tech: string,
  monorepo: MonorepoData | null,
  userFlows: UserFlowsData | null,
  dataFlow: DataFlowData | null,
  cfWorkers: CloudflareWorkersData | null = null,
  limits: DiagramLimits = DEFAULT_LIMITS
): string[] {
  const label = sanitizeLabel(repoLabel);
  const lines: string[] = ["flowchart TB"];

  // Cloudflare Worker component diagram - show detailed internal structure
  if (cfWorkers?.name) {
    const workerLabel = sanitizeLabel(cfWorkers.name);
    lines.push(`    subgraph ${sanitize(repoName)}_boundary["⚡ ${workerLabel} - Internal Components"]`);

    // Group endpoints by file/handler
    const endpointsByFile = new Map<string, typeof cfWorkers.endpoints>();
    for (const ep of cfWorkers.endpoints || []) {
      const file = ep.file || "main";
      if (!endpointsByFile.has(file)) endpointsByFile.set(file, []);
      endpointsByFile.get(file)!.push(ep);
    }

    // Router/entry point
    lines.push('        subgraph Router["🔀 Router"]');
    for (const [file, eps] of endpointsByFile) {
      const fileLabel = sanitizeLabel(file.replace(/.*\//, "").replace(".rs", ""));
      lines.push(`            subgraph ${sanitize("file_" + file)}["📄 ${fileLabel}"]`);
      const shownEps = limitSlice(eps || [], limits.endpointsPerFile);
      for (const ep of shownEps) {
        const epId = sanitize(`ep_${ep.method}_${ep.path}`);
        lines.push(`                ${epId}["${ep.method} ${sanitizeLabel(ep.path)}"]`);
      }
      if ((eps || []).length > shownEps.length) {
        lines.push(`                ${sanitize("file_" + file)}_more["+${(eps || []).length - shownEps.length} more"]`);
      }
      lines.push("            end");
    }
    lines.push("        end");

    // Durable Objects as internal components
    if (cfWorkers.durableObjects && cfWorkers.durableObjects.length > 0) {
      lines.push('        subgraph DO["🔗 Durable Objects"]');
      for (const dobj of cfWorkers.durableObjects) {
        const doId = sanitize(`do_${dobj.name}`);
        const doLabel = sanitizeLabel(dobj.className);
        lines.push(`            ${doId}[["${doLabel}<br/>Stateful Actor"]]`);
      }
      lines.push("        end");
    }

    // Key dependencies as internal modules
    const keyDeps = (cfWorkers.dependencies || []).filter(
      d => ["worker", "serde", "k256", "sha2"].includes(d.name)
    );
    if (keyDeps.length > 0) {
      lines.push('        subgraph Deps["📦 Key Dependencies"]');
      for (const dep of keyDeps) {
        const depId = sanitize(`dep_${dep.name}`);
        const features = dep.features ? ` [${dep.features.join(", ")}]` : "";
        lines.push(`            ${depId}["${dep.name} ${dep.version}${features}"]`);
      }
      lines.push("        end");
    }

    lines.push("    end");
    lines.push("");

    // Internal relationships
    if (cfWorkers.durableObjects && cfWorkers.durableObjects.length > 0) {
      lines.push("    Router -->|coordinates| DO");
    }

    return lines;
  }

  if (monorepo?.detected) {
    const apps = monorepo.apps || [];
    const screensByApp = groupScreensByApp(userFlows?.screens || []);

    // Show components for each app
    for (const pkg of apps) {
      const pkgLabel = sanitizeLabel(pkg.name);
      const appScreens = screensByApp.get(pkg.name) || [];
      lines.push(`    subgraph ${sanitize(pkg.name)}_boundary["📦 ${pkgLabel}"]`);

      if (appScreens.length > 0) {
        const shownScreens = limitSlice(appScreens, limits.screens);
        for (const screen of shownScreens) {
          const screenLabel = sanitizeLabel(screen);
          lines.push(`        ${sanitize(pkg.name + "_" + screen)}["📄 ${screenLabel}"]`);
        }
        if (appScreens.length > shownScreens.length) {
          lines.push(`        ${sanitize(pkg.name)}_more["+${appScreens.length - shownScreens.length} more pages"]`);
        }
      } else {
        const techLabel = sanitizeLabel(pkg.framework || tech);
        lines.push(`        ${sanitize(pkg.name)}_main["🚀 Main (${techLabel})"]`);
      }

      lines.push("    end");
      lines.push("");
    }
  } else {
    // Non-monorepo: show services as components
    const services = dataFlow?.services || [];
    lines.push(`    subgraph ${sanitize(repoName)}_boundary["📦 ${label}"]`);

    if (services.length > 0) {
      lines.push('        subgraph Services["⚙️ Services"]');
      const shownServices = limitSlice(services, limits.services);
      for (const svc of shownServices) {
        const svcLabel = sanitizeLabel(svc.name);
        lines.push(`            ${sanitize("svc_" + svc.name)}["${svcLabel}"]`);
      }
      if (services.length > shownServices.length) {
        lines.push(`            svc_more["+${services.length - shownServices.length} more"]`);
      }
      lines.push("        end");
    }

    const screens = userFlows?.screens || [];
    if (screens.length > 0) {
      lines.push('        subgraph Screens["📄 Screens"]');
      const shownScreens = limitSlice(screens, limits.screens);
      for (const screen of shownScreens) {
        const screenLabel = sanitizeLabel(screen.name);
        lines.push(`            ${sanitize("screen_" + screen.name)}["${screenLabel}"]`);
      }
      if (screens.length > shownScreens.length) {
        lines.push(`            screens_more["+${screens.length - shownScreens.length} more"]`);
      }
      lines.push("        end");
    }

    lines.push("    end");
  }

  // Service dependencies
  if (dataFlow?.services) {
    lines.push("");
    for (const svc of dataFlow.services) {
      if (svc.dependencies) {
        const shownDeps = limitSlice(svc.dependencies, limits.dependencies);
        for (const dep of shownDeps) {
          const depSvc = dataFlow.services.find((s) => s.name === dep);
          if (depSvc) {
            lines.push(`    ${sanitize("svc_" + svc.name)} --> ${sanitize("svc_" + dep)}`);
          }
        }
      }
    }
  }

  return lines;
}

// ============================================================================
// Dynamic Diagram - Request/interaction flows (flowchart)
// ============================================================================

function generateDynamicDiagram(
  repoName: string,
  repoLabel: string,
  monorepo: MonorepoData | null,
  _userFlows: UserFlowsData | null,
  dataFlow: DataFlowData | null,
  cfWorkers: CloudflareWorkersData | null = null,
  limits: DiagramLimits = DEFAULT_LIMITS
): string[] {
  const label = sanitizeLabel(repoLabel);
  const lines: string[] = ["flowchart LR"];

  lines.push('    User(["👤 User"])');
  lines.push("");

  // Cloudflare Worker request flow
  if (cfWorkers?.name) {
    const workerLabel = sanitizeLabel(cfWorkers.name);
    const route = cfWorkers.routes?.[0]?.pattern || "worker";

    // Show the worker
    lines.push(`    Worker["⚡ ${workerLabel}"]`);

    // Show key endpoints
    const allKeyEndpoints = (cfWorkers.endpoints || []).filter(
      ep => !ep.path.includes("health") && ep.path !== "/"
    );
    const keyEndpoints = limitSlice(allKeyEndpoints, limits.endpoints);

    if (keyEndpoints.length > 0) {
      lines.push('    subgraph Handlers["🔀 Request Handlers"]');
      for (const ep of keyEndpoints) {
        const epId = sanitize(`handler_${ep.method}_${ep.path}`);
        lines.push(`        ${epId}["${ep.method} ${sanitizeLabel(ep.path)}"]`);
      }
      if (allKeyEndpoints.length > keyEndpoints.length) {
        lines.push(`        handlers_more["+${allKeyEndpoints.length - keyEndpoints.length} more"]`);
      }
      lines.push("    end");
    }
    lines.push("");

    // Durable Objects
    if (cfWorkers.durableObjects && cfWorkers.durableObjects.length > 0) {
      lines.push('    subgraph DOs["🔗 Durable Objects"]');
      for (const dobj of cfWorkers.durableObjects) {
        const doId = sanitize(`do_${dobj.name}`);
        lines.push(`        ${doId}[["${sanitizeLabel(dobj.className)}"]]`);
      }
      lines.push("    end");
    }

    // Data stores
    const hasKV = (cfWorkers.kvNamespaces?.length || 0) > 0;
    const hasQueues = (cfWorkers.queues?.length || 0) > 0;

    if (hasKV || hasQueues) {
      lines.push('    subgraph Data["💾 Data Layer"]');
      for (const kv of cfWorkers.kvNamespaces || []) {
        lines.push(`        ${sanitize("kv_" + kv.binding)}[("KV: ${sanitizeLabel(kv.binding)}")]`);
      }
      const uniqueQueues = [...new Set((cfWorkers.queues || []).map(q => q.name))];
      for (const queueName of uniqueQueues) {
        lines.push(`        ${sanitize("queue_" + queueName)}>"Queue: ${sanitizeLabel(queueName)}"]`);
      }
      lines.push("    end");
    }
    lines.push("");

    // Flow with numbered steps
    let step = 1;
    lines.push(`    User -->|"${step}. HTTPS ${route}"| Worker`);
    step++;

    if (keyEndpoints.length > 0) {
      lines.push(`    Worker -->|"${step}. Route"| Handlers`);
      step++;
    }

    if (cfWorkers.durableObjects && cfWorkers.durableObjects.length > 0) {
      lines.push(`    Handlers -->|"${step}. Coordinate"| DOs`);
      step++;
    }

    if (hasKV) {
      lines.push(`    ${keyEndpoints.length > 0 ? "Handlers" : "Worker"} -->|"${step}. Cache lookup"| ${sanitize("kv_" + cfWorkers.kvNamespaces![0].binding)}`);
      step++;
    }

    if (hasQueues) {
      const firstQueue = (cfWorkers.queues || [])[0];
      if (firstQueue) {
        lines.push(`    ${keyEndpoints.length > 0 ? "Handlers" : "Worker"} -->|"${step}. Async"| ${sanitize("queue_" + firstQueue.name)}`);
        step++;
      }
    }

    return lines;
  }

  if (monorepo?.detected) {
    const apps = monorepo.apps || [];
    const apiApp = apps.find((a) => a.name.includes("api") || a.name.includes("gateway"));
    const frontendApp = apps.find((a) => a.name.includes("website") || a.name.includes("web") || (!a.name.includes("api") && !a.name.includes("gateway")));

    for (const pkg of apps) {
      const pkgLabel = sanitizeLabel(pkg.name);
      lines.push(`    ${sanitize(pkg.name)}["🖥️ ${pkgLabel}"]`);
    }
    lines.push("");

    // Show typical request flow with numbered steps
    let step = 1;
    if (frontendApp) {
      lines.push(`    User -->|"${step}. Visits"| ${sanitize(frontendApp.name)}`);
      step++;
      if (apiApp) {
        lines.push(`    ${sanitize(frontendApp.name)} -->|"${step}. Fetches data"| ${sanitize(apiApp.name)}`);
        step++;
      }
    }

    // External calls
    const externals = getExternalDomains(dataFlow?.externalCalls || [], limits.externalDomains);
    if (externals.length > 0) {
      lines.push("");
      lines.push('    subgraph External["🌐 External"]');
      for (const ext of externals) {
        const extLabel = sanitizeLabel(ext);
        lines.push(`        ${sanitize("ext_" + ext)}[("${extLabel}")]`);
      }
      lines.push("    end");
      lines.push("");
      for (const ext of externals) {
        if (apiApp) {
          lines.push(`    ${sanitize(apiApp.name)} -->|"${step}. Calls API"| ${sanitize("ext_" + ext)}`);
          step++;
        }
      }
    }
  } else {
    // Simple request flow for non-monorepo
    lines.push(`    ${sanitize(repoName)}["🖥️ ${label}"]`);
    lines.push(`    User -->|"1. Uses"| ${sanitize(repoName)}`);

    const externals = getExternalDomains(dataFlow?.externalCalls || [], limits.externalDomains);
    if (externals.length > 0) {
      lines.push("");
      lines.push('    subgraph External["🌐 External"]');
      for (const ext of externals) {
        const extLabel = sanitizeLabel(ext);
        lines.push(`        ${sanitize("ext_" + ext)}[("${extLabel}")]`);
      }
      lines.push("    end");
      lines.push("");
      for (const [idx, ext] of externals.entries()) {
        lines.push(`    ${sanitize(repoName)} -->|"${idx + 2}. Calls"| ${sanitize("ext_" + ext)}`);
      }
    }
  }

  return lines;
}

// ============================================================================
// Deployment Diagram - Infrastructure and deployment (flowchart)
// ============================================================================

function generateDeploymentDiagram(
  repoName: string,
  repoLabel: string,
  monorepo: MonorepoData | null,
  k8s: K8sData | null,
  terraform: TerraformData | null,
  cfWorkers: CloudflareWorkersData | null = null,
  limits: DiagramLimits = DEFAULT_LIMITS
): string[] {
  const label = sanitizeLabel(repoLabel);
  const lines: string[] = ["flowchart TB"];

  const hasK8s = k8s && ((k8s.deployments?.length || 0) > 0 || (k8s.services?.length || 0) > 0);
  const hasTf = terraform && ((terraform.resources || 0) > 0);
  const hasCfWorker = cfWorkers?.name;

  // Cloudflare Worker deployment
  if (hasCfWorker) {
    const workerLabel = sanitizeLabel(cfWorkers!.name!);
    const route = cfWorkers!.routes?.[0]?.pattern || "worker.example.com";
    const compatDate = cfWorkers!.compatibilityDate || "latest";

    lines.push('    Internet(["🌐 Internet"])');
    lines.push("");

    lines.push('    subgraph Cloudflare["☁️ Cloudflare Edge Network"]');

    // DNS/Route
    lines.push('        subgraph Edge["🌍 Edge (300+ PoPs)"]');
    lines.push(`            DNS["📍 ${sanitizeLabel(route)}"]`);
    lines.push("        end");
    lines.push("");

    // Worker runtime
    lines.push('        subgraph Runtime["⚡ Workers Runtime"]');
    lines.push(`            Worker["🔧 ${workerLabel}<br/>Rust/WASM<br/>compat: ${compatDate}"]`);

    if (cfWorkers!.durableObjects && cfWorkers!.durableObjects.length > 0) {
      for (const dobj of cfWorkers!.durableObjects) {
        const doLabel = sanitizeLabel(dobj.className);
        lines.push(`            ${sanitize("do_" + dobj.name)}[["🔗 DO: ${doLabel}"]]`);
      }
    }
    lines.push("        end");
    lines.push("");

    // Data services
    const hasKV = (cfWorkers!.kvNamespaces?.length || 0) > 0;
    const hasQueues = (cfWorkers!.queues?.length || 0) > 0;

    if (hasKV || hasQueues) {
      lines.push('        subgraph DataServices["💾 Data Services"]');
      for (const kv of cfWorkers!.kvNamespaces || []) {
        const kvLabel = sanitizeLabel(kv.binding);
        lines.push(`            ${sanitize("kv_" + kv.binding)}[("KV: ${kvLabel}<br/>Global replicated")]`);
      }
      const uniqueQueues = [...new Set((cfWorkers!.queues || []).map(q => q.name))];
      for (const queueName of uniqueQueues) {
        const qLabel = sanitizeLabel(queueName);
        lines.push(`            ${sanitize("queue_" + queueName)}>"Queue: ${qLabel}"]`);
      }
      lines.push("        end");
    }

    lines.push("    end");
    lines.push("");

    // Relationships
    lines.push("    Internet -->|HTTPS| DNS");
    lines.push("    DNS -->|Route| Worker");

    if (cfWorkers!.durableObjects && cfWorkers!.durableObjects.length > 0) {
      for (const dobj of cfWorkers!.durableObjects) {
        lines.push(`    Worker -->|stub| ${sanitize("do_" + dobj.name)}`);
      }
    }

    for (const kv of cfWorkers!.kvNamespaces || []) {
      lines.push(`    Worker -->|get/put| ${sanitize("kv_" + kv.binding)}`);
    }

    const uniqueQueues = [...new Set((cfWorkers!.queues || []).map(q => q.name))];
    for (const queueName of uniqueQueues) {
      lines.push(`    Worker -->|send/receive| ${sanitize("queue_" + queueName)}`);
    }

    return lines;
  }

  if (hasK8s) {
    // Kubernetes deployment
    lines.push('    subgraph Cloud["☁️ Cloud Provider"]');
    lines.push('        subgraph K8s["⎈ Kubernetes Cluster"]');

    const namespaces = new Set<string>();
    for (const dep of k8s.deployments || []) {
      namespaces.add(dep.namespace || "default");
    }

    for (const ns of namespaces) {
      const nsLabel = sanitizeLabel(ns);
      lines.push(`            subgraph ns_${sanitize(ns)}["📁 Namespace: ${nsLabel}"]`);

      const nsDeployments = (k8s.deployments || []).filter((d) => (d.namespace || "default") === ns);
      const shownDeps = limitSlice(nsDeployments, limits.k8sDeployments);
      for (const dep of shownDeps) {
        const depLabel = sanitizeLabel(dep.name);
        const replicas = dep.replicas || 1;
        lines.push(`                ${sanitize("dep_" + dep.name)}["🚀 ${depLabel}<br/>${replicas} replicas"]`);
      }
      if (nsDeployments.length > shownDeps.length) {
        lines.push(`                dep_more_${sanitize(ns)}["+${nsDeployments.length - shownDeps.length} more deployments"]`);
      }

      const nsServices = limitSlice(k8s.services || [], limits.k8sServices);
      for (const svc of nsServices) {
        const svcLabel = sanitizeLabel(svc.name);
        const ports = svc.ports?.join(", ") || "80";
        lines.push(`                ${sanitize("svc_k8s_" + svc.name)}["🔌 ${svcLabel}<br/>Ports: ${ports}"]`);
      }
      if ((k8s.services || []).length > nsServices.length) {
        lines.push(`                svc_more_${sanitize(ns)}["+${(k8s.services || []).length - nsServices.length} more services"]`);
      }

      lines.push("            end");
    }

    // Ingresses
    const ingresses = k8s.ingresses || [];
    if (ingresses.length > 0) {
      lines.push('            subgraph Ingress["🌐 Ingress"]');
      const shownIngresses = limitSlice(ingresses, limits.ingresses);
      for (const ing of shownIngresses) {
        const ingLabel = sanitizeLabel(ing.name);
        const host = sanitizeLabel(ing.host || "/*");
        lines.push(`                ${sanitize("ing_" + ing.name)}["${ingLabel}<br/>${host}"]`);
      }
      if (ingresses.length > shownIngresses.length) {
        lines.push(`                ing_more["+${ingresses.length - shownIngresses.length} more ingresses"]`);
      }
      lines.push("            end");
    }

    lines.push("        end");
    lines.push("    end");
  } else if (hasTf) {
    // Terraform-based deployment
    const providers = terraform.providers || ["cloud"];
    const providerLabel = sanitizeLabel(providers[0]);
    lines.push(`    subgraph Cloud["☁️ ${providerLabel} Cloud"]`);

    if (monorepo?.detected) {
      const apps = monorepo.apps || [];
      for (const pkg of apps) {
        const pkgLabel = sanitizeLabel(pkg.name);
        lines.push(`        ${sanitize(pkg.name)}["🚀 ${pkgLabel}"]`);
      }
    } else {
      lines.push(`        ${sanitize(repoName)}["🚀 ${label}"]`);
    }

    lines.push(`        infra["🔧 Terraform<br/>${terraform.resources || 0} resources"]`);
    lines.push("    end");
  } else {
    // Generic deployment (no K8s/TF data)
    lines.push('    subgraph Cloud["☁️ Cloud"]');
    if (monorepo?.detected) {
      const apps = monorepo.apps || [];
      for (const pkg of apps) {
        const pkgLabel = sanitizeLabel(pkg.name);
        lines.push(`        ${sanitize(pkg.name)}["🚀 ${pkgLabel}"]`);
      }
    } else {
      lines.push(`        ${sanitize(repoName)}["🚀 ${label}"]`);
    }
    lines.push("    end");
  }

  return lines;
}

// ============================================================================
// Mermaid Flowchart (non-C4)
// ============================================================================

function generateRepoFlowchart(
  repoName: string,
  monorepo: MonorepoData | null,
  userFlows: UserFlowsData | null,
  dataFlow: DataFlowData | null
): string[] {
  const lines: string[] = ["flowchart TB"];

  if (monorepo?.detected) {
    const tool = monorepo.tool || "monorepo";
    lines.push(`    subgraph ${sanitize(repoName)}["${repoName} (${tool})"]`);
    lines.push("        direction TB");

    const apps = monorepo.apps || monorepo.packages?.filter((p) => p.type === "app") || [];
    const libs = (monorepo.libs || monorepo.packages?.filter((p) => p.type === "package") || []).filter(
      (p) => !isConfigPackage(p.name)
    );
    const screensByApp = groupScreensByApp(userFlows?.screens || []);

    for (const pkg of apps) {
      const node = sanitize(pkg.name);
      const framework = pkg.framework ? ` (${pkg.framework})` : "";
      const appScreens = screensByApp.get(pkg.name) || [];

      lines.push(`        subgraph ${node}["${pkg.name}${framework}"]`);
      if (appScreens.length > 0) {
        for (const screen of appScreens.slice(0, 4)) {
          lines.push(`            ${sanitize(pkg.name + "_" + screen)}["📄 ${screen}"]`);
        }
        if (appScreens.length > 4) {
          lines.push(`            ${node}_more["... +${appScreens.length - 4} pages"]`);
        }
      } else {
        lines.push(`            ${node}_app["🚀 App"]`);
      }
      lines.push("        end");
    }

    if (libs.length > 0) {
      lines.push('        subgraph SharedLibs["📦 Shared"]');
      for (const lib of libs) {
        lines.push(`            ${sanitize(lib.name)}["${lib.name}"]`);
      }
      lines.push("        end");
    }

    lines.push("    end");

    const apiApp = apps.find((a) => a.name.includes("api") || a.name.includes("gateway"));
    if (apiApp) {
      lines.push("");
      for (const pkg of apps) {
        if (pkg !== apiApp) {
          lines.push(`    ${sanitize(pkg.name)} -->|API| ${sanitize(apiApp.name)}`);
        }
      }
    }
  } else {
    lines.push(`    subgraph ${sanitize(repoName)}["${repoName}"]`);

    const screensByApp = groupScreensByApp(userFlows?.screens || []);
    for (const [app, screens] of screensByApp) {
      lines.push(`        subgraph ${sanitize(app)}["${app}"]`);
      for (const screen of screens.slice(0, 5)) {
        lines.push(`            ${sanitize(app + "_" + screen)}["📄 ${screen}"]`);
      }
      if (screens.length > 5) {
        lines.push(`            ${sanitize(app)}_more["... +${screens.length - 5} more"]`);
      }
      lines.push("        end");
    }

    const services = dataFlow?.services || [];
    if (services.length > 0) {
      lines.push('        subgraph Services["⚙️ Services"]');
      for (const svc of services.slice(0, 5)) {
        lines.push(`            ${sanitize("svc_" + svc.name)}["${svc.name}"]`);
      }
      lines.push("        end");
    }

    lines.push("    end");
  }

  const externals = getExternalDomains(dataFlow?.externalCalls || []);
  if (externals.length > 0) {
    lines.push("");
    lines.push('    subgraph External["🌐 External"]');
    for (const ext of externals) {
      lines.push(`        ${sanitize("ext_" + ext)}[("${ext}")]`);
    }
    lines.push("    end");
    lines.push("");
    for (const ext of externals) {
      lines.push(`    ${sanitize(repoName)} --> ${sanitize("ext_" + ext)}`);
    }
  }

  return lines;
}

// ============================================================================
// Tool Exports
// ============================================================================

export const diagramTools: ToolHandler[] = [
  {
    name: "generate_c4_diagram",
    description: `Generate architecture diagrams as standard Mermaid flowcharts.

DIAGRAM TYPES:
- context: System Context - shows system in relation to users and external systems
- container: Container - shows apps, services, databases within the system
- component: Component - shows internal structure of containers (screens, modules)
- dynamic: Dynamic - shows request/interaction flows with numbered steps
- deployment: Deployment - shows infrastructure (K8s pods, cloud resources)

TWO MODES:
1. Ecosystem overview - omit 'repo' param to see all repos
2. Single-repo detail - pass 'repo' name for detailed internal view

OPTIONS:
- detailed: Set to true to show ALL elements without truncation (default: false)
- export: Set to true to get export instructions for saving to file (default: false)

IMPORTANT: Display the returned 'mermaid' field in a \`\`\`mermaid code block to render.`,
    schema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Repo name for detailed view. Omit for ecosystem overview.",
        },
        type: {
          type: "string",
          enum: ["context", "container", "component", "dynamic", "deployment"],
          description: "C4 diagram type. Default: container",
        },
        detailed: {
          type: "boolean",
          description: "Show ALL elements without truncation. Default: false",
        },
        export: {
          type: "boolean",
          description: "Include export instructions for saving diagram to file. Default: false",
        },
      },
    },
    handler: async (args) => {
      const targetRepo = args.repo as string | undefined;
      const diagramType = args.type as string | undefined;
      const detailed = args.detailed === true;
      const shouldExport = args.export === true;
      const limits = detailed ? NO_LIMITS : DEFAULT_LIMITS;

      // Validate repo name format if provided
      if (targetRepo !== undefined && !isValidRepoName(targetRepo)) {
        return safeJson({
          error: "Invalid repository name",
          message: "Repository names must be 1-100 characters containing only alphanumeric characters, hyphens, underscores, and dots.",
        });
      }

      // Validate diagram type if provided
      const effectiveDiagramType: C4DiagramType = diagramType && isValidC4Type(diagramType) ? diagramType : "container";
      if (diagramType !== undefined && !isValidC4Type(diagramType)) {
        return safeJson({
          error: "Invalid diagram type",
          message: `Valid diagram types are: ${VALID_C4_TYPES.join(", ")}`,
          providedType: diagramType,
        });
      }

      const config = await loadConfig();

      // Single repo mode
      if (targetRepo) {
        const repoConfig = config.repositories[targetRepo];
        if (!repoConfig) {
          return safeJson({ error: `Repository '${targetRepo}' not found in config` });
        }

        const s = await getStore();
        const versions = await s.listVersions(targetRepo);
        if (versions.length === 0) {
          return safeJson({ error: `No extracted data for '${targetRepo}'. Run extract_ref first.` });
        }

        const latest = versions[0];
        const refType = latest.refType as "branch" | "tag";
        const label = targetRepo.replace(/[-_]/g, " ");
        const tech = repoConfig.language || "TypeScript";

        // Load all potentially needed data
        const userFlows = (await s.loadExtractor(targetRepo, refType, latest.ref, "user_flows")) as UserFlowsData | null;
        const dataFlow = (await s.loadExtractor(targetRepo, refType, latest.ref, "data_flow")) as DataFlowData | null;
        const monorepo = (await s.loadExtractor(targetRepo, refType, latest.ref, "monorepo")) as MonorepoData | null;
        const k8s = (await s.loadExtractor(targetRepo, refType, latest.ref, "kubernetes")) as K8sData | null;
        const terraform = (await s.loadExtractor(targetRepo, refType, latest.ref, "terraform")) as TerraformData | null;
        const cfWorkers = (await s.loadExtractor(targetRepo, refType, latest.ref, "cloudflare_workers")) as CloudflareWorkersData | null;

        let lines: string[];

        switch (effectiveDiagramType) {
          case "context":
            lines = generateContextDiagram(targetRepo, label, monorepo, dataFlow, cfWorkers, limits);
            break;
          case "component":
            lines = generateComponentDiagram(targetRepo, label, tech, monorepo, userFlows, dataFlow, cfWorkers, limits);
            break;
          case "dynamic":
            lines = generateDynamicDiagram(targetRepo, label, monorepo, userFlows, dataFlow, cfWorkers, limits);
            break;
          case "deployment":
            lines = generateDeploymentDiagram(targetRepo, label, monorepo, k8s, terraform, cfWorkers, limits);
            break;
          case "container":
          default:
            lines = generateContainerDiagram(targetRepo, label, tech, monorepo, userFlows, dataFlow, cfWorkers, limits);
            break;
        }

        const mermaid = lines.join("\n");

        const stats = {
          packages: monorepo?.packages?.length || 0,
          screens: userFlows?.screens?.length || 0,
          services: dataFlow?.services?.length || 0,
          k8sDeployments: k8s?.deployments?.length || 0,
          cfWorkerEndpoints: cfWorkers?.endpoints?.length || 0,
        };

        const result: Record<string, unknown> = {
          repo: targetRepo,
          ref: latest.ref,
          type: effectiveDiagramType,
          detailed,
          mermaid,
          stats,
          availableTypes: ["context", "container", "component", "dynamic", "deployment"],
          hint: "Display the 'mermaid' field in a ```mermaid code block to render visually",
        };

        if (shouldExport) {
          const filename = `${targetRepo}-${effectiveDiagramType}.md`;
          result.exportTo = {
            suggestedPath: `docs/diagrams/${filename}`,
            instruction: `Export this diagram by writing the mermaid content to a markdown file. The agent should save the following to docs/diagrams/${filename}:\n\n# ${label} - ${effectiveDiagramType.charAt(0).toUpperCase() + effectiveDiagramType.slice(1)} Diagram\n\n\`\`\`mermaid\n${mermaid}\n\`\`\``,
          };
        }

        return safeJson(result);
      }

      // Ecosystem mode - supports context, container, deployment
      const overview = await getEcosystemOverview();
      const mainRepos = overview.repos.filter((r) => inferCategory(r.name, config.repositories[r.name]?.type) !== "aux");
      const s = await getStore();

      // Group repos by category
      const frontends = mainRepos.filter((r) => inferCategory(r.name, config.repositories[r.name]?.type) === "frontend");
      const backends = mainRepos.filter((r) => inferCategory(r.name, config.repositories[r.name]?.type) === "backend");
      const infra = mainRepos.filter((r) => inferCategory(r.name, config.repositories[r.name]?.type) === "infra");
      const others = mainRepos.filter((r) => !["frontend", "backend", "infra"].includes(inferCategory(r.name, config.repositories[r.name]?.type)));

      let lines: string[];
      let ecosystemType = effectiveDiagramType;

      // Component and Dynamic don't make sense at ecosystem level - fallback to context
      if (effectiveDiagramType === "component" || effectiveDiagramType === "dynamic") {
        ecosystemType = "context";
      }

      if (ecosystemType === "container") {
        // Ecosystem Container: show all apps/containers across all repos
        lines = ["flowchart TB"];
        lines.push('    User(["👤 User"])');
        lines.push("");

        for (const repo of mainRepos) {
          const versions = await s.listVersions(repo.name);
          if (versions.length === 0) continue;

          const latest = versions[0];
          const refType = latest.refType as "branch" | "tag";
          const monorepo = (await s.loadExtractor(repo.name, refType, latest.ref, "monorepo")) as MonorepoData | null;
          const repoConfig = config.repositories[repo.name];
          const tech = sanitizeLabel(repoConfig?.language || "TypeScript");
          const repoLabel = sanitizeLabel(repo.name);

          lines.push(`    subgraph ${sanitize(repo.name)}_boundary["🏢 ${repoLabel}"]`);

          if (monorepo?.detected) {
            const apps = monorepo.apps || monorepo.packages?.filter((p) => p.type === "app") || [];
            const shownApps = limitSlice(apps, limits.appsPerRepo);
            for (const pkg of shownApps) {
              const pkgLabel = sanitizeLabel(pkg.name);
              const pkgTech = sanitizeLabel(pkg.framework || tech);
              lines.push(`        ${sanitize(repo.name + "_" + pkg.name)}["🖥️ ${pkgLabel}<br/>${pkgTech}"]`);
            }
            if (apps.length > shownApps.length) {
              lines.push(`        ${sanitize(repo.name)}_more["+${apps.length - shownApps.length} more apps"]`);
            }
          } else {
            lines.push(`        ${sanitize(repo.name)}_main["🖥️ ${repoLabel}<br/>${tech}"]`);
          }

          lines.push("    end");
          lines.push("");
        }

        // User relationships
        for (const repo of frontends) {
          lines.push(`    User -->|Uses| ${sanitize(repo.name)}_boundary`);
        }

        // Frontend -> Backend relationships
        for (const fe of frontends) {
          for (const be of backends) {
            lines.push(`    ${sanitize(fe.name)}_boundary -->|API| ${sanitize(be.name)}_boundary`);
          }
        }

      } else if (ecosystemType === "deployment") {
        // Ecosystem Deployment: aggregate K8s/TF/CF Workers across all repos
        lines = ["flowchart TB"];

        const allK8s: Array<{ repo: string; data: K8sData }> = [];
        const allTf: Array<{ repo: string; data: TerraformData }> = [];
        const allCfWorkers: Array<{ repo: string; data: CloudflareWorkersData }> = [];

        for (const repo of mainRepos) {
          const versions = await s.listVersions(repo.name);
          if (versions.length === 0) continue;

          const latest = versions[0];
          const refType = latest.refType as "branch" | "tag";
          const k8s = (await s.loadExtractor(repo.name, refType, latest.ref, "kubernetes")) as K8sData | null;
          const tf = (await s.loadExtractor(repo.name, refType, latest.ref, "terraform")) as TerraformData | null;
          const cfWorkers = (await s.loadExtractor(repo.name, refType, latest.ref, "cloudflare_workers")) as CloudflareWorkersData | null;

          if (k8s && ((k8s.deployments?.length || 0) > 0 || (k8s.services?.length || 0) > 0)) {
            allK8s.push({ repo: repo.name, data: k8s });
          }
          if (tf && (tf.resources || 0) > 0) {
            allTf.push({ repo: repo.name, data: tf });
          }
          if (cfWorkers?.name) {
            allCfWorkers.push({ repo: repo.name, data: cfWorkers });
          }
        }

        // Cloudflare Workers
        if (allCfWorkers.length > 0) {
          lines.push('    subgraph Cloudflare["☁️ Cloudflare Edge"]');
          for (const { repo, data } of allCfWorkers) {
            const repoLabel = sanitizeLabel(repo);
            const route = data.routes?.[0]?.pattern || "";
            const routeLabel = route ? `<br/>${sanitizeLabel(route)}` : "";
            const hasKV = (data.kvNamespaces?.length || 0) > 0;
            const hasDO = (data.durableObjects?.length || 0) > 0;
            const hasQueues = (data.queues?.length || 0) > 0;
            const services = [hasKV ? "KV" : "", hasDO ? "DO" : "", hasQueues ? "Queue" : ""].filter(Boolean).join(", ");
            const servicesLabel = services ? `<br/>[${services}]` : "";
            lines.push(`        ${sanitize(repo)}["⚡ ${repoLabel}${routeLabel}${servicesLabel}"]`);
          }
          lines.push("    end");
          lines.push("");
        }

        if (allK8s.length > 0) {
          lines.push('    subgraph K8s["⎈ Kubernetes Cluster"]');

          for (const { repo, data } of allK8s) {
            const repoLabel = sanitizeLabel(repo);
            lines.push(`        subgraph ${sanitize(repo)}_ns["📁 ${repoLabel}"]`);
            const shownDeps = limitSlice(data.deployments || [], limits.k8sDeployments);
            for (const dep of shownDeps) {
              const depLabel = sanitizeLabel(dep.name);
              lines.push(`            ${sanitize(repo + "_" + dep.name)}["🚀 ${depLabel}"]`);
            }
            if ((data.deployments || []).length > shownDeps.length) {
              lines.push(`            ${sanitize(repo)}_more["+${(data.deployments || []).length - shownDeps.length} more"]`);
            }
            lines.push("        end");
          }

          lines.push("    end");
          lines.push("");
        }

        if (allTf.length > 0) {
          const providers = [...new Set(allTf.flatMap((t) => t.data.providers || []))];
          const providerName = sanitizeLabel(providers[0] || "Cloud");
          lines.push(`    subgraph Cloud["☁️ ${providerName}"]`);

          for (const { repo, data } of allTf) {
            const repoLabel = sanitizeLabel(repo);
            lines.push(`        ${sanitize(repo)}_infra["🔧 ${repoLabel}<br/>Terraform: ${data.resources || 0} resources"]`);
          }

          lines.push("    end");
        }

        if (allK8s.length === 0 && allTf.length === 0 && allCfWorkers.length === 0) {
          // No infra data - show generic deployment
          lines.push('    subgraph Cloud["☁️ Cloud"]');
          for (const repo of mainRepos) {
            const repoLabel = sanitizeLabel(repo.name);
            lines.push(`        ${sanitize(repo.name)}["🚀 ${repoLabel}"]`);
          }
          lines.push("    end");
        }

      } else {
        // Default: Context - high level system overview
        lines = ["flowchart TB"];
        lines.push('    User(["👤 User"])');
        lines.push("");

        if (frontends.length > 0) {
          lines.push('    subgraph Frontends["🖥️ Frontend Applications"]');
          for (const repo of frontends) {
            const repoLabel = sanitizeLabel(repo.name);
            lines.push(`        ${sanitize(repo.name)}["${repoLabel}"]`);
          }
          lines.push("    end");
          lines.push("");
        }

        if (backends.length > 0) {
          lines.push('    subgraph Backends["⚙️ Backend Services"]');
          for (const repo of backends) {
            const repoLabel = sanitizeLabel(repo.name);
            lines.push(`        ${sanitize(repo.name)}["${repoLabel}"]`);
          }
          lines.push("    end");
          lines.push("");
        }

        if (infra.length > 0) {
          lines.push('    subgraph Infrastructure["🔧 Infrastructure"]');
          for (const repo of infra) {
            const repoLabel = sanitizeLabel(repo.name);
            lines.push(`        ${sanitize(repo.name)}["${repoLabel}"]`);
          }
          lines.push("    end");
          lines.push("");
        }

        if (others.length > 0) {
          lines.push('    subgraph Other["📦 Other"]');
          for (const repo of others) {
            const repoLabel = sanitizeLabel(repo.name);
            lines.push(`        ${sanitize(repo.name)}["${repoLabel}"]`);
          }
          lines.push("    end");
          lines.push("");
        }

        // User relationships
        if (frontends.length > 0) {
          lines.push("    User -->|Uses| Frontends");
        }

        // Frontend -> Backend relationships
        if (frontends.length > 0 && backends.length > 0) {
          lines.push("    Frontends -->|API calls| Backends");
        }
      }

      const mermaid = lines.join("\n");

      const result: Record<string, unknown> = {
        mode: "ecosystem",
        type: ecosystemType,
        detailed,
        mermaid,
        repos: mainRepos.map((r) => ({
          name: r.name,
          category: inferCategory(r.name, config.repositories[r.name]?.type),
        })),
        availableTypes: ["context", "container", "deployment"],
        ecosystemNote: "component and dynamic types require a specific repo",
        hint: "For detailed view, call with repo='<name>'. Display 'mermaid' in a ```mermaid block.",
      };

      if (shouldExport) {
        const filename = `ecosystem-${ecosystemType}.md`;
        result.exportTo = {
          suggestedPath: `docs/diagrams/${filename}`,
          instruction: `Export this diagram by writing the mermaid content to a markdown file. The agent should save the following to docs/diagrams/${filename}:\n\n# Ecosystem - ${ecosystemType.charAt(0).toUpperCase() + ecosystemType.slice(1)} Diagram\n\n\`\`\`mermaid\n${mermaid}\n\`\`\``,
        };
      }

      return safeJson(result);
    },
  },
  {
    name: "generate_diagram",
    description:
      "Generate Mermaid flowchart (renders in chat). TWO MODES: (1) Ecosystem - call without 'repo' to see all repos. (2) Single-repo - pass 'repo' name to see internal structure. IMPORTANT: Display the returned 'mermaid' field in a ```mermaid code block.",
    schema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description:
            "Repo name for detailed internal view. Shows monorepo structure, screens, services. Omit for ecosystem overview.",
        },
      },
    },
    handler: async (args) => {
      const targetRepo = args.repo as string | undefined;

      // Validate repo name format if provided
      if (targetRepo !== undefined && !isValidRepoName(targetRepo)) {
        return safeJson({
          error: "Invalid repository name",
          message: "Repository names must be 1-100 characters containing only alphanumeric characters, hyphens, underscores, and dots.",
        });
      }

      const config = await loadConfig();

      if (targetRepo) {
        const repoConfig = config.repositories[targetRepo];
        if (!repoConfig) {
          return safeJson({ error: `Repository '${targetRepo}' not found in config` });
        }

        const s = await getStore();
        const versions = await s.listVersions(targetRepo);
        if (versions.length === 0) {
          return safeJson({ error: `No extracted data for '${targetRepo}'. Run extract_ref first.` });
        }

        const latest = versions[0];
        const refType = latest.refType as "branch" | "tag";

        const userFlows = (await s.loadExtractor(targetRepo, refType, latest.ref, "user_flows")) as UserFlowsData | null;
        const dataFlow = (await s.loadExtractor(targetRepo, refType, latest.ref, "data_flow")) as DataFlowData | null;
        const monorepo = (await s.loadExtractor(targetRepo, refType, latest.ref, "monorepo")) as MonorepoData | null;

        const lines = generateRepoFlowchart(targetRepo, monorepo, userFlows, dataFlow);
        const mermaid = lines.join("\n");

        return safeJson({
          repo: targetRepo,
          ref: latest.ref,
          mermaid,
          stats: {
            screens: userFlows?.screens?.length || 0,
            services: dataFlow?.services?.length || 0,
            packages: monorepo?.packages?.length || 0,
          },
          hint: "Display the 'mermaid' field in a ```mermaid code block to render visually",
        });
      }

      // Ecosystem mode
      const overview = await getEcosystemOverview();
      const allNipData = await loadFromAllRepos("nip_usage");

      const lines: string[] = ["flowchart TD", '    subgraph Platform["🏢 Platform"]'];

      for (const repo of overview.repos) {
        const cat = inferCategory(repo.name, config.repositories[repo.name]?.type);
        if (cat === "aux") continue;
        const icon = cat === "frontend" ? "🖥️" : cat === "backend" ? "⚙️" : cat === "infra" ? "🔧" : "📦";
        lines.push(`        ${sanitize(repo.name)}["${icon} ${repo.name}"]`);
      }

      lines.push("    end");

      const nipSummary = Object.entries(allNipData).reduce<Record<string, string[]>>((acc, [repo, data]) => {
        const nipData = data as { nips?: Record<string, unknown> };
        const nipKeys = nipData.nips ? Object.keys(nipData.nips) : [];
        acc[repo] = nipKeys;
        return acc;
      }, {});

      const mermaid = lines.join("\n");

      return safeJson({
        mode: "ecosystem",
        mermaid,
        nipUsage: nipSummary,
        hint: "For detailed view, call with repo='<name>'. Display 'mermaid' in a ```mermaid block.",
      });
    },
  },
];
