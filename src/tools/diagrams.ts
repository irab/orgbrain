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
// Context Diagram - High-level system overview (flowchart)
// ============================================================================

function generateContextDiagram(
  repoName: string,
  repoLabel: string,
  _monorepo: MonorepoData | null,
  dataFlow: DataFlowData | null
): string[] {
  const label = sanitizeLabel(repoLabel);
  const lines: string[] = ["flowchart TB"];

  // Users
  lines.push('    User(["👤 User"])');
  lines.push('    Admin(["👤 Admin"])');
  lines.push("");

  // Main system
  lines.push(`    subgraph ${sanitize(repoName)}["🏢 ${label}"]`);
  lines.push(`        ${sanitize(repoName)}_core["The Software System"]`);
  lines.push("    end");
  lines.push("");

  // External systems
  const externals = getExternalDomains(dataFlow?.externalCalls || []);
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
  dataFlow: DataFlowData | null
): string[] {
  const label = sanitizeLabel(repoLabel);
  const lines: string[] = ["flowchart TB"];

  // Users
  lines.push('    User(["👤 User"])');
  lines.push("");

  // System boundary
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
      const screenList = screens.slice(0, 3).map((s) => sanitizeLabel(s)).join(", ");
      const desc = screenList + (screens.length > 3 ? "..." : "");
      lines.push(`        ${sanitize("ui_" + app)}["🖥️ ${appLabel}<br/>${sanitizeLabel(tech)}<br/>${desc}"]`);
    }

    const services = dataFlow?.services || [];
    if (services.length > 0) {
      lines.push('        subgraph Services["⚙️ Services"]');
      for (const svc of services.slice(0, 5)) {
        const svcLabel = sanitizeLabel(svc.name);
        lines.push(`            ${sanitize("svc_" + svc.name)}["${svcLabel}"]`);
      }
      lines.push("        end");
    }
  }

  lines.push("    end");
  lines.push("");

  // External systems
  const externals = getExternalDomains(dataFlow?.externalCalls || []);
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
  dataFlow: DataFlowData | null
): string[] {
  const label = sanitizeLabel(repoLabel);
  const lines: string[] = ["flowchart TB"];

  if (monorepo?.detected) {
    const apps = monorepo.apps || [];
    const screensByApp = groupScreensByApp(userFlows?.screens || []);

    // Show components for each app
    for (const pkg of apps) {
      const pkgLabel = sanitizeLabel(pkg.name);
      const appScreens = screensByApp.get(pkg.name) || [];
      lines.push(`    subgraph ${sanitize(pkg.name)}_boundary["📦 ${pkgLabel}"]`);

      if (appScreens.length > 0) {
        for (const screen of appScreens.slice(0, 6)) {
          const screenLabel = sanitizeLabel(screen);
          lines.push(`        ${sanitize(pkg.name + "_" + screen)}["📄 ${screenLabel}"]`);
        }
        if (appScreens.length > 6) {
          lines.push(`        ${sanitize(pkg.name)}_more["+${appScreens.length - 6} more pages"]`);
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
      for (const svc of services) {
        const svcLabel = sanitizeLabel(svc.name);
        lines.push(`            ${sanitize("svc_" + svc.name)}["${svcLabel}"]`);
      }
      lines.push("        end");
    }

    const screens = userFlows?.screens || [];
    if (screens.length > 0) {
      lines.push('        subgraph Screens["📄 Screens"]');
      for (const screen of screens.slice(0, 8)) {
        const screenLabel = sanitizeLabel(screen.name);
        lines.push(`            ${sanitize("screen_" + screen.name)}["${screenLabel}"]`);
      }
      if (screens.length > 8) {
        lines.push(`            screens_more["+${screens.length - 8} more"]`);
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
        for (const dep of svc.dependencies.slice(0, 2)) {
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
  dataFlow: DataFlowData | null
): string[] {
  const label = sanitizeLabel(repoLabel);
  const lines: string[] = ["flowchart LR"];

  lines.push('    User(["👤 User"])');
  lines.push("");

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
    const externals = getExternalDomains(dataFlow?.externalCalls || []);
    if (externals.length > 0) {
      lines.push("");
      lines.push('    subgraph External["🌐 External"]');
      for (const ext of externals.slice(0, 2)) {
        const extLabel = sanitizeLabel(ext);
        lines.push(`        ${sanitize("ext_" + ext)}[("${extLabel}")]`);
      }
      lines.push("    end");
      lines.push("");
      for (const ext of externals.slice(0, 2)) {
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

    const externals = getExternalDomains(dataFlow?.externalCalls || []);
    if (externals.length > 0) {
      lines.push("");
      lines.push('    subgraph External["🌐 External"]');
      for (const ext of externals.slice(0, 3)) {
        const extLabel = sanitizeLabel(ext);
        lines.push(`        ${sanitize("ext_" + ext)}[("${extLabel}")]`);
      }
      lines.push("    end");
      lines.push("");
      for (const [idx, ext] of externals.slice(0, 3).entries()) {
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
  terraform: TerraformData | null
): string[] {
  const label = sanitizeLabel(repoLabel);
  const lines: string[] = ["flowchart TB"];

  const hasK8s = k8s && ((k8s.deployments?.length || 0) > 0 || (k8s.services?.length || 0) > 0);
  const hasTf = terraform && ((terraform.resources || 0) > 0);

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
      for (const dep of nsDeployments.slice(0, 5)) {
        const depLabel = sanitizeLabel(dep.name);
        const replicas = dep.replicas || 1;
        lines.push(`                ${sanitize("dep_" + dep.name)}["🚀 ${depLabel}<br/>${replicas} replicas"]`);
      }

      const nsServices = (k8s.services || []).slice(0, 3);
      for (const svc of nsServices) {
        const svcLabel = sanitizeLabel(svc.name);
        const ports = svc.ports?.join(", ") || "80";
        lines.push(`                ${sanitize("svc_k8s_" + svc.name)}["🔌 ${svcLabel}<br/>Ports: ${ports}"]`);
      }

      lines.push("            end");
    }

    // Ingresses
    const ingresses = k8s.ingresses || [];
    if (ingresses.length > 0) {
      lines.push('            subgraph Ingress["🌐 Ingress"]');
      for (const ing of ingresses.slice(0, 3)) {
        const ingLabel = sanitizeLabel(ing.name);
        const host = sanitizeLabel(ing.host || "/*");
        lines.push(`                ${sanitize("ing_" + ing.name)}["${ingLabel}<br/>${host}"]`);
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
            lines = generateContextDiagram(targetRepo, label, monorepo, dataFlow);
            break;
          case "component":
            lines = generateComponentDiagram(targetRepo, label, tech, monorepo, userFlows, dataFlow);
            break;
          case "dynamic":
            lines = generateDynamicDiagram(targetRepo, label, monorepo, userFlows, dataFlow);
            break;
          case "deployment":
            lines = generateDeploymentDiagram(targetRepo, label, monorepo, k8s, terraform);
            break;
          case "container":
          default:
            lines = generateContainerDiagram(targetRepo, label, tech, monorepo, userFlows, dataFlow);
            break;
        }

        const mermaid = lines.join("\n");

        return safeJson({
          repo: targetRepo,
          ref: latest.ref,
          type: effectiveDiagramType,
          mermaid,
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
            for (const pkg of apps.slice(0, 4)) {
              const pkgLabel = sanitizeLabel(pkg.name);
              const pkgTech = sanitizeLabel(pkg.framework || tech);
              lines.push(`        ${sanitize(repo.name + "_" + pkg.name)}["🖥️ ${pkgLabel}<br/>${pkgTech}"]`);
            }
            if (apps.length > 4) {
              lines.push(`        ${sanitize(repo.name)}_more["+${apps.length - 4} more apps"]`);
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
        // Ecosystem Deployment: aggregate K8s/TF across all repos
        lines = ["flowchart TB"];

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
          lines.push('    subgraph K8s["⎈ Kubernetes Cluster"]');

          for (const { repo, data } of allK8s) {
            const repoLabel = sanitizeLabel(repo);
            lines.push(`        subgraph ${sanitize(repo)}_ns["📁 ${repoLabel}"]`);
            for (const dep of (data.deployments || []).slice(0, 3)) {
              const depLabel = sanitizeLabel(dep.name);
              lines.push(`            ${sanitize(repo + "_" + dep.name)}["🚀 ${depLabel}"]`);
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

        if (allK8s.length === 0 && allTf.length === 0) {
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

      return safeJson({
        mode: "ecosystem",
        type: ecosystemType,
        mermaid,
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
