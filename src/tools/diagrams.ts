/**
 * Diagram generation tools - C4 and Mermaid flowcharts
 *
 * Supports native Mermaid C4 diagram types:
 * - C4Context: System Context diagram (high-level)
 * - C4Container: Container diagram (apps/services)
 * - C4Component: Component diagram (internal structure)
 * - C4Dynamic: Dynamic diagram (request flows)
 * - C4Deployment: Deployment diagram (infrastructure)
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
  validateC4Diagram,
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

type C4DiagramType = "context" | "container" | "component" | "dynamic" | "deployment";

const VALID_C4_TYPES: C4DiagramType[] = ["context", "container", "component", "dynamic", "deployment"];

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
function getExternalDomains(calls: ExternalCall[]): string[] {
  const domains = new Set<string>();
  for (const call of calls) {
    try {
      const url = new URL(call.target.split("\n")[0].trim());
      domains.add(url.hostname);
    } catch {
      // Skip invalid URLs
    }
  }
  return [...domains].slice(0, 5);
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
// C4 Context Diagram - High-level system overview
// ============================================================================

function generateC4Context(
  repoName: string,
  repoLabel: string,
  _monorepo: MonorepoData | null,
  dataFlow: DataFlowData | null
): string[] {
  const label = sanitizeLabel(repoLabel);
  const lines: string[] = ["C4Context"];
  lines.push(`    title System Context Diagram - ${label}`);
  lines.push("");

  // Users
  lines.push('    Person(user, "User", "End user of the system")');
  lines.push('    Person(admin, "Admin", "System administrator")');
  lines.push("");

  // Main system
  lines.push(`    System(${sanitize(repoName)}, "${label}", "The software system")`);
  lines.push("");

  // External systems
  const externals = getExternalDomains(dataFlow?.externalCalls || []);
  if (externals.length > 0) {
    for (const ext of externals) {
      const extLabel = sanitizeLabel(ext);
      lines.push(`    System_Ext(${sanitize("ext_" + ext)}, "${extLabel}", "External service")`);
    }
    lines.push("");
  }

  // Relationships
  lines.push(`    Rel(user, ${sanitize(repoName)}, "Uses")`);
  lines.push(`    Rel(admin, ${sanitize(repoName)}, "Administers")`);
  for (const ext of externals) {
    lines.push(`    Rel(${sanitize(repoName)}, ${sanitize("ext_" + ext)}, "Calls")`);
  }

  return lines;
}

// ============================================================================
// C4 Container Diagram - Apps/Services within the system
// ============================================================================

function generateC4Container(
  repoName: string,
  repoLabel: string,
  tech: string,
  monorepo: MonorepoData | null,
  userFlows: UserFlowsData | null,
  dataFlow: DataFlowData | null
): string[] {
  const label = sanitizeLabel(repoLabel);
  const lines: string[] = ["C4Container"];
  lines.push(`    title Container Diagram - ${label}`);
  lines.push("");

  // Users
  lines.push('    Person(user, "User", "End user")');
  lines.push("");

  // System boundary
  lines.push(`    System_Boundary(${sanitize(repoName)}_boundary, "${label}") {`);

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
      lines.push(`        Container(${node}, "${pkgLabel}", "${pkgTech}", "${desc}")`);
    }

    if (libs.length > 0) {
      for (const lib of libs) {
        const libLabel = sanitizeLabel(lib.name);
        lines.push(`        Container(${sanitize(lib.name)}, "${libLabel}", "Library", "Shared code")`);
      }
    }
  } else {
    // Non-monorepo
    const screensByApp = groupScreensByApp(userFlows?.screens || []);
    for (const [app, screens] of screensByApp) {
      const appLabel = sanitizeLabel(app);
      const screenList = screens.slice(0, 3).map((s) => sanitizeLabel(s)).join(", ");
      const desc = screenList + (screens.length > 3 ? "..." : "");
      lines.push(`        Container(${sanitize("ui_" + app)}, "${appLabel}", "${sanitizeLabel(tech)}", "${desc}")`);
    }

    const services = dataFlow?.services || [];
    for (const svc of services.slice(0, 5)) {
      const svcLabel = sanitizeLabel(svc.name);
      lines.push(`        Container(${sanitize("svc_" + svc.name)}, "${svcLabel}", "Service", "Backend service")`);
    }
  }

  lines.push("    }");
  lines.push("");

  // External systems
  const externals = getExternalDomains(dataFlow?.externalCalls || []);
  for (const ext of externals) {
    const extLabel = sanitizeLabel(ext);
    lines.push(`    System_Ext(${sanitize("ext_" + ext)}, "${extLabel}", "External API")`);
  }
  if (externals.length > 0) lines.push("");

  // Relationships
  if (monorepo?.detected) {
    const apps = monorepo.apps || [];
    const apiApp = apps.find((a) => a.name.includes("api") || a.name.includes("gateway"));

    for (const pkg of apps) {
      if (!pkg.name.includes("api") && !pkg.name.includes("gateway")) {
        lines.push(`    Rel(user, ${sanitize(pkg.name)}, "Uses", "HTTPS")`);
      }
    }

    if (apiApp) {
      for (const pkg of apps) {
        if (pkg !== apiApp && !pkg.name.includes("api")) {
          lines.push(`    Rel(${sanitize(pkg.name)}, ${sanitize(apiApp.name)}, "API calls", "REST")`);
        }
      }
    }
  }

  for (const ext of externals) {
    lines.push(`    Rel(${sanitize(repoName)}_boundary, ${sanitize("ext_" + ext)}, "Calls")`);
  }

  return lines;
}

// ============================================================================
// C4 Component Diagram - Internal structure of a container
// ============================================================================

function generateC4Component(
  repoName: string,
  repoLabel: string,
  tech: string,
  monorepo: MonorepoData | null,
  userFlows: UserFlowsData | null,
  dataFlow: DataFlowData | null
): string[] {
  const label = sanitizeLabel(repoLabel);
  const lines: string[] = ["C4Component"];
  lines.push(`    title Component Diagram - ${label}`);
  lines.push("");

  if (monorepo?.detected) {
    const apps = monorepo.apps || [];
    const screensByApp = groupScreensByApp(userFlows?.screens || []);

    // Show components for each app
    for (const pkg of apps) {
      const pkgLabel = sanitizeLabel(pkg.name);
      const appScreens = screensByApp.get(pkg.name) || [];
      lines.push(`    Container_Boundary(${sanitize(pkg.name)}_boundary, "${pkgLabel}") {`);

      if (appScreens.length > 0) {
        for (const screen of appScreens.slice(0, 6)) {
          const screenLabel = sanitizeLabel(screen);
          lines.push(`        Component(${sanitize(pkg.name + "_" + screen)}, "${screenLabel}", "Page", "UI Screen")`);
        }
        if (appScreens.length > 6) {
          lines.push(`        Component(${sanitize(pkg.name)}_more, "+${appScreens.length - 6} more", "Pages", "Additional screens")`);
        }
      } else {
        const techLabel = sanitizeLabel(pkg.framework || tech);
        lines.push(`        Component(${sanitize(pkg.name)}_main, "Main", "${techLabel}", "Entry point")`);
      }

      lines.push("    }");
      lines.push("");
    }
  } else {
    // Non-monorepo: show services as components
    const services = dataFlow?.services || [];
    lines.push(`    Container_Boundary(${sanitize(repoName)}_boundary, "${label}") {`);

    for (const svc of services) {
      const svcLabel = sanitizeLabel(svc.name);
      const deps = svc.dependencies?.slice(0, 2).map((d) => sanitizeLabel(d)).join(", ") || "core";
      lines.push(`        Component(${sanitize("svc_" + svc.name)}, "${svcLabel}", "Service", "Depends on: ${deps}")`);
    }

    const screens = userFlows?.screens || [];
    for (const screen of screens.slice(0, 8)) {
      const screenLabel = sanitizeLabel(screen.name);
      lines.push(`        Component(${sanitize("screen_" + screen.name)}, "${screenLabel}", "UI", "Screen")`);
    }

    lines.push("    }");
  }

  // Service dependencies
  if (dataFlow?.services) {
    lines.push("");
    for (const svc of dataFlow.services) {
      if (svc.dependencies) {
        for (const dep of svc.dependencies.slice(0, 2)) {
          const depSvc = dataFlow.services.find((s) => s.name === dep);
          if (depSvc) {
            lines.push(`    Rel(${sanitize("svc_" + svc.name)}, ${sanitize("svc_" + dep)}, "Calls")`);
          }
        }
      }
    }
  }

  return lines;
}

// ============================================================================
// C4 Dynamic Diagram - Request/interaction flows
// ============================================================================

function generateC4Dynamic(
  repoName: string,
  repoLabel: string,
  monorepo: MonorepoData | null,
  _userFlows: UserFlowsData | null,
  dataFlow: DataFlowData | null
): string[] {
  const label = sanitizeLabel(repoLabel);
  const lines: string[] = ["C4Dynamic"];
  lines.push(`    title Dynamic Diagram - ${label} Request Flow`);
  lines.push("");

  lines.push('    Person(user, "User")');
  lines.push("");

  if (monorepo?.detected) {
    const apps = monorepo.apps || [];
    const apiApp = apps.find((a) => a.name.includes("api") || a.name.includes("gateway"));
    const frontendApp = apps.find((a) => a.name.includes("website") || a.name.includes("web") || (!a.name.includes("api") && !a.name.includes("gateway")));

    for (const pkg of apps) {
      const pkgLabel = sanitizeLabel(pkg.name);
      lines.push(`    Container(${sanitize(pkg.name)}, "${pkgLabel}")`);
    }
    lines.push("");

    // Show typical request flow
    let step = 1;
    if (frontendApp) {
      lines.push(`    Rel(user, ${sanitize(frontendApp.name)}, "${step}. Visits", "HTTPS")`);
      step++;
      if (apiApp) {
        lines.push(`    Rel(${sanitize(frontendApp.name)}, ${sanitize(apiApp.name)}, "${step}. Fetches data", "API")`);
        step++;
      }
    }

    // External calls
    const externals = getExternalDomains(dataFlow?.externalCalls || []);
    for (const ext of externals.slice(0, 2)) {
      const extLabel = sanitizeLabel(ext);
      lines.push(`    System_Ext(${sanitize("ext_" + ext)}, "${extLabel}")`);
      if (apiApp) {
        lines.push(`    Rel(${sanitize(apiApp.name)}, ${sanitize("ext_" + ext)}, "${step}. Calls", "API")`);
        step++;
      }
    }
  } else {
    // Simple request flow for non-monorepo
    lines.push(`    Container(${sanitize(repoName)}, "${label}")`);
    lines.push(`    Rel(user, ${sanitize(repoName)}, "1. Uses")`);

    const externals = getExternalDomains(dataFlow?.externalCalls || []);
    for (const [idx, ext] of externals.slice(0, 3).entries()) {
      const extLabel = sanitizeLabel(ext);
      lines.push(`    System_Ext(${sanitize("ext_" + ext)}, "${extLabel}")`);
      lines.push(`    Rel(${sanitize(repoName)}, ${sanitize("ext_" + ext)}, "${idx + 2}. Calls")`);
    }
  }

  return lines;
}

// ============================================================================
// C4 Deployment Diagram - Infrastructure and deployment
// ============================================================================

function generateC4Deployment(
  repoName: string,
  repoLabel: string,
  monorepo: MonorepoData | null,
  k8s: K8sData | null,
  terraform: TerraformData | null
): string[] {
  const label = sanitizeLabel(repoLabel);
  const lines: string[] = ["C4Deployment"];
  lines.push(`    title Deployment Diagram - ${label}`);
  lines.push("");

  const hasK8s = k8s && ((k8s.deployments?.length || 0) > 0 || (k8s.services?.length || 0) > 0);
  const hasTf = terraform && ((terraform.resources || 0) > 0);

  if (hasK8s) {
    // Kubernetes deployment
    lines.push('    Deployment_Node(cloud, "Cloud Provider") {');
    lines.push('        Deployment_Node(k8s, "Kubernetes Cluster") {');

    const namespaces = new Set<string>();
    for (const dep of k8s.deployments || []) {
      namespaces.add(dep.namespace || "default");
    }

    for (const ns of namespaces) {
      const nsLabel = sanitizeLabel(ns);
      lines.push(`            Deployment_Node(ns_${sanitize(ns)}, "Namespace: ${nsLabel}") {`);

      const nsDeployments = (k8s.deployments || []).filter((d) => (d.namespace || "default") === ns);
      for (const dep of nsDeployments.slice(0, 5)) {
        const depLabel = sanitizeLabel(dep.name);
        const replicas = dep.replicas || 1;
        lines.push(`                Container(${sanitize("dep_" + dep.name)}, "${depLabel}", "Deployment", "${replicas} replicas")`);
      }

      const nsServices = (k8s.services || []).slice(0, 3);
      for (const svc of nsServices) {
        const svcLabel = sanitizeLabel(svc.name);
        const ports = svc.ports?.join(", ") || "80";
        lines.push(`                Container(${sanitize("svc_k8s_" + svc.name)}, "${svcLabel}", "Service", "Ports: ${ports}")`);
      }

      lines.push("            }");
    }

    // Ingresses
    const ingresses = k8s.ingresses || [];
    if (ingresses.length > 0) {
      lines.push('            Deployment_Node(ingress, "Ingress") {');
      for (const ing of ingresses.slice(0, 3)) {
        const ingLabel = sanitizeLabel(ing.name);
        const host = sanitizeLabel(ing.host || "/*");
        lines.push(`                Container(${sanitize("ing_" + ing.name)}, "${ingLabel}", "Ingress", "${host}")`);
      }
      lines.push("            }");
    }

    lines.push("        }");
    lines.push("    }");
  } else if (hasTf) {
    // Terraform-based deployment
    const providers = terraform.providers || ["cloud"];
    const providerLabel = sanitizeLabel(providers[0]);
    lines.push(`    Deployment_Node(cloud, "${providerLabel} Cloud") {`);

    if (monorepo?.detected) {
      const apps = monorepo.apps || [];
      for (const pkg of apps) {
        const pkgLabel = sanitizeLabel(pkg.name);
        lines.push(`        Container(${sanitize(pkg.name)}, "${pkgLabel}", "Deployed App")`);
      }
    } else {
      lines.push(`        Container(${sanitize(repoName)}, "${label}", "Application")`);
    }

    lines.push(`        Container(infra, "Infrastructure", "Terraform", "${terraform.resources || 0} resources")`);
    lines.push("    }");
  } else {
    // Generic deployment (no K8s/TF data)
    lines.push('    Deployment_Node(cloud, "Cloud") {');
    if (monorepo?.detected) {
      const apps = monorepo.apps || [];
      for (const pkg of apps) {
        const pkgLabel = sanitizeLabel(pkg.name);
        lines.push(`        Container(${sanitize(pkg.name)}, "${pkgLabel}", "Deployed")`);
      }
    } else {
      lines.push(`        Container(${sanitize(repoName)}, "${label}", "Application")`);
    }
    lines.push("    }");
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
    description: `Generate C4 architecture diagrams using native Mermaid C4 syntax.

DIAGRAM TYPES:
- context: System Context - shows system in relation to users and external systems
- container: Container - shows apps, services, databases within the system
- component: Component - shows internal structure of containers (screens, modules)
- dynamic: Dynamic - shows request/interaction flows with numbered steps
- deployment: Deployment - shows infrastructure (K8s pods, cloud resources)

TWO MODES:
1. Ecosystem overview - omit 'repo' param to see all repos
2. Single-repo detail - pass 'repo' name for detailed internal view

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
      },
    },
    handler: async (args) => {
      const targetRepo = args.repo as string | undefined;
      const diagramType = args.type as string | undefined;

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

        let lines: string[];

        switch (effectiveDiagramType) {
          case "context":
            lines = generateC4Context(targetRepo, label, monorepo, dataFlow);
            break;
          case "component":
            lines = generateC4Component(targetRepo, label, tech, monorepo, userFlows, dataFlow);
            break;
          case "dynamic":
            lines = generateC4Dynamic(targetRepo, label, monorepo, userFlows, dataFlow);
            break;
          case "deployment":
            lines = generateC4Deployment(targetRepo, label, monorepo, k8s, terraform);
            break;
          case "container":
          default:
            lines = generateC4Container(targetRepo, label, tech, monorepo, userFlows, dataFlow);
            break;
        }

        const mermaid = lines.join("\n");
        const validation = validateC4Diagram(lines);

        return safeJson({
          repo: targetRepo,
          ref: latest.ref,
          type: effectiveDiagramType,
          mermaid,
          valid: validation.valid,
          ...(validation.errors.length > 0 && { syntaxErrors: validation.errors }),
          stats: {
            packages: monorepo?.packages?.length || 0,
            screens: userFlows?.screens?.length || 0,
            services: dataFlow?.services?.length || 0,
            k8sDeployments: k8s?.deployments?.length || 0,
          },
          availableTypes: ["context", "container", "component", "dynamic", "deployment"],
          hint: "Display the 'mermaid' field in a ```mermaid code block to render visually",
        });
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
        lines = ["C4Container"];
        lines.push("    title Container Diagram - Platform Overview");
        lines.push("");
        lines.push('    Person(user, "User", "End user")');
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

          lines.push(`    System_Boundary(${sanitize(repo.name)}_boundary, "${repoLabel}") {`);

          if (monorepo?.detected) {
            const apps = monorepo.apps || monorepo.packages?.filter((p) => p.type === "app") || [];
            for (const pkg of apps.slice(0, 4)) {
              const pkgLabel = sanitizeLabel(pkg.name);
              const pkgTech = sanitizeLabel(pkg.framework || tech);
              lines.push(`        Container(${sanitize(repo.name + "_" + pkg.name)}, "${pkgLabel}", "${pkgTech}")`);
            }
            if (apps.length > 4) {
              lines.push(`        Container(${sanitize(repo.name)}_more, "+${apps.length - 4} more", "Apps")`);
            }
          } else {
            lines.push(`        Container(${sanitize(repo.name)}_main, "${repoLabel}", "${tech}")`);
          }

          lines.push("    }");
          lines.push("");
        }

        // User relationships
        for (const repo of frontends) {
          lines.push(`    Rel(user, ${sanitize(repo.name)}_boundary, "Uses")`);
        }

        // Frontend -> Backend relationships
        for (const fe of frontends) {
          for (const be of backends) {
            lines.push(`    Rel(${sanitize(fe.name)}_boundary, ${sanitize(be.name)}_boundary, "API")`);
          }
        }

      } else if (ecosystemType === "deployment") {
        // Ecosystem Deployment: aggregate K8s/TF across all repos
        lines = ["C4Deployment"];
        lines.push("    title Deployment Diagram - Platform Infrastructure");
        lines.push("");

        const allK8s: Array<{ repo: string; data: K8sData }> = [];
        const allTf: Array<{ repo: string; data: TerraformData }> = [];

        for (const repo of mainRepos) {
          const versions = await s.listVersions(repo.name);
          if (versions.length === 0) continue;

          const latest = versions[0];
          const refType = latest.refType as "branch" | "tag";
          const k8s = (await s.loadExtractor(repo.name, refType, latest.ref, "kubernetes")) as K8sData | null;
          const tf = (await s.loadExtractor(repo.name, refType, latest.ref, "terraform")) as TerraformData | null;

          if (k8s && ((k8s.deployments?.length || 0) > 0 || (k8s.services?.length || 0) > 0)) {
            allK8s.push({ repo: repo.name, data: k8s });
          }
          if (tf && (tf.resources || 0) > 0) {
            allTf.push({ repo: repo.name, data: tf });
          }
        }

        if (allK8s.length > 0) {
          lines.push('    Deployment_Node(k8s_cluster, "Kubernetes Cluster") {');

          for (const { repo, data } of allK8s) {
            const repoLabel = sanitizeLabel(repo);
            lines.push(`        Deployment_Node(${sanitize(repo)}_ns, "${repoLabel}") {`);
            for (const dep of (data.deployments || []).slice(0, 3)) {
              const depLabel = sanitizeLabel(dep.name);
              lines.push(`            Container(${sanitize(repo + "_" + dep.name)}, "${depLabel}", "Deployment")`);
            }
            lines.push("        }");
          }

          lines.push("    }");
          lines.push("");
        }

        if (allTf.length > 0) {
          const providers = [...new Set(allTf.flatMap((t) => t.data.providers || []))];
          const providerName = sanitizeLabel(providers[0] || "Cloud");
          lines.push(`    Deployment_Node(cloud, "${providerName}") {`);

          for (const { repo, data } of allTf) {
            const repoLabel = sanitizeLabel(repo);
            lines.push(`        Container(${sanitize(repo)}_infra, "${repoLabel}", "Terraform", "${data.resources || 0} resources")`);
          }

          lines.push("    }");
        }

        if (allK8s.length === 0 && allTf.length === 0) {
          // No infra data - show generic deployment
          lines.push('    Deployment_Node(cloud, "Cloud") {');
          for (const repo of mainRepos) {
            const repoLabel = sanitizeLabel(repo.name);
            lines.push(`        Container(${sanitize(repo.name)}, "${repoLabel}", "Deployed")`);
          }
          lines.push("    }");
        }

      } else {
        // Default: C4Context - high level system overview
        lines = ["C4Context"];
        lines.push("    title System Context - Platform Overview");
        lines.push("");
        lines.push('    Person(user, "User", "End user of the platform")');
        lines.push("");

        for (const repo of frontends) {
          const repoLabel = sanitizeLabel(repo.name);
          lines.push(`    System(${sanitize(repo.name)}, "${repoLabel}", "Frontend Application")`);
        }
        for (const repo of backends) {
          const repoLabel = sanitizeLabel(repo.name);
          lines.push(`    System(${sanitize(repo.name)}, "${repoLabel}", "Backend Service")`);
        }
        for (const repo of infra) {
          const repoLabel = sanitizeLabel(repo.name);
          lines.push(`    System(${sanitize(repo.name)}, "${repoLabel}", "Infrastructure")`);
        }
        for (const repo of others) {
          const repoLabel = sanitizeLabel(repo.name);
          lines.push(`    System(${sanitize(repo.name)}, "${repoLabel}", "System")`);
        }
        lines.push("");

        // User relationships
        for (const repo of frontends) {
          lines.push(`    Rel(user, ${sanitize(repo.name)}, "Uses")`);
        }

        // Frontend -> Backend relationships
        for (const fe of frontends) {
          for (const be of backends) {
            lines.push(`    Rel(${sanitize(fe.name)}, ${sanitize(be.name)}, "API calls")`);
          }
        }
      }

      const mermaid = lines.join("\n");
      const validation = validateC4Diagram(lines);

      return safeJson({
        mode: "ecosystem",
        type: ecosystemType,
        mermaid,
        valid: validation.valid,
        ...(validation.errors.length > 0 && { syntaxErrors: validation.errors }),
        repos: mainRepos.map((r) => ({
          name: r.name,
          category: inferCategory(r.name, config.repositories[r.name]?.type),
        })),
        availableTypes: ["context", "container", "deployment"],
        ecosystemNote: "component and dynamic types require a specific repo",
        hint: "For detailed view, call with repo='<name>'. Display 'mermaid' in a ```mermaid block.",
      });
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
