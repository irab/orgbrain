/**
 * Kubernetes Extractor
 * 
 * Parses K8s manifests to extract resource topology, ArgoCD apps, and service mesh
 */

import type { Extractor, ExtractionContext, ExtractionResult } from "../../lib/extractor-base.js";
import { registerExtractor } from "../../lib/extractor-base.js";

interface K8sResource {
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
  file: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  spec?: Record<string, unknown>;
}

interface ArgoApp {
  name: string;
  namespace: string;
  source: {
    repoURL?: string;
    path?: string;
    chart?: string;
    targetRevision?: string;
  };
  destination: {
    server: string;
    namespace: string;
  };
  syncPolicy?: Record<string, unknown>;
}

interface ServiceTopology {
  name: string;
  namespace: string;
  type: string;
  ports: Array<{ port: number; targetPort: number; protocol: string }>;
  selector?: Record<string, string>;
  ingress?: {
    host: string;
    paths: string[];
  };
}

interface K8sData {
  resources: K8sResource[];
  argoApps: ArgoApp[];
  services: ServiceTopology[];
  deployments: Array<{
    name: string;
    namespace: string;
    replicas: number;
    image: string;
    ports: number[];
    env: string[];
  }>;
  configMaps: Array<{
    name: string;
    namespace: string;
    keys: string[];
  }>;
  secrets: Array<{
    name: string;
    namespace: string;
    type: string;
    keys: string[];
  }>;
  namespaces: string[];
  topology: {
    nodes: Array<{ id: string; kind: string; namespace: string }>;
    edges: Array<{ from: string; to: string; type: string }>;
  };
  summary: {
    byKind: Record<string, number>;
    byNamespace: Record<string, number>;
    totalResources: number;
  };
}

// Interface for parsed K8s YAML document
interface ParsedK8sDocument {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec?: Record<string, unknown>;
  data?: Record<string, unknown>;
  type?: string;
}

const kubernetesExtractor: Extractor = {
  name: "kubernetes",
  description: "Extract Kubernetes resource topology and ArgoCD applications",

  async canExtract(ctx: ExtractionContext): Promise<boolean> {
    const files = await ctx.gitManager.listFilesAtRef(ctx.repoPath, ctx.ref);
    return files.some((f) => 
      (f.endsWith(".yaml") || f.endsWith(".yml")) && 
      (f.includes("k8s") || f.includes("kubernetes") || f.includes("manifests"))
    );
  },

  async extract(ctx: ExtractionContext): Promise<ExtractionResult> {
    const config = ctx.config as {
      paths?: string[];
      resource_types?: string[];
    };

    const data: K8sData = {
      resources: [],
      argoApps: [],
      services: [],
      deployments: [],
      configMaps: [],
      secrets: [],
      namespaces: [],
      topology: {
        nodes: [],
        edges: [],
      },
      summary: {
        byKind: {},
        byNamespace: {},
        totalResources: 0,
      },
    };

    const allFiles = await ctx.gitManager.listFilesAtRef(ctx.repoPath, ctx.ref);
    let yamlFiles = allFiles.filter((f) => 
      (f.endsWith(".yaml") || f.endsWith(".yml")) &&
      !f.includes("node_modules")
    );

    // Filter by paths if configured
    if (config.paths?.length) {
      yamlFiles = yamlFiles.filter((f) => 
        config.paths!.some((p) => f.startsWith(p))
      );
    }

    for (const file of yamlFiles) {
      try {
        const content = await ctx.gitManager.getFileAtRef(ctx.repoPath, ctx.ref, file);
        await parseK8sFile(file, content, data, config.resource_types);
      } catch {
        // Skip unreadable files
      }
    }

    // Build topology graph
    buildTopologyGraph(data);

    // Collect unique namespaces
    data.namespaces = [...new Set(
      data.resources
        .map((r) => r.namespace)
        .filter(Boolean) as string[]
    )].sort();

    // Build summary
    for (const resource of data.resources) {
      data.summary.byKind[resource.kind] = 
        (data.summary.byKind[resource.kind] || 0) + 1;
      const ns = resource.namespace || "(cluster)";
      data.summary.byNamespace[ns] = 
        (data.summary.byNamespace[ns] || 0) + 1;
    }
    data.summary.totalResources = data.resources.length;

    return {
      extractor: this.name,
      repo: ctx.repoName,
      ref: ctx.ref,
      extractedAt: new Date(),
      data,
    };
  },
};

async function parseK8sFile(
  file: string,
  content: string,
  data: K8sData,
  resourceTypes?: string[]
): Promise<void> {
  // Split on document separators
  const documents = content.split(/^---$/m);

  for (const doc of documents) {
    if (!doc.trim()) continue;

    // Simple YAML parsing for K8s manifests
    const resource = parseSimpleYaml(doc) as ParsedK8sDocument;
    if (!resource || !resource.apiVersion || !resource.kind || !resource.metadata?.name) {
      continue;
    }

    // Filter by resource types if configured
    if (resourceTypes?.length && !resourceTypes.includes(resource.kind)) {
      continue;
    }

    const k8sResource: K8sResource = {
      apiVersion: resource.apiVersion,
      kind: resource.kind,
      name: resource.metadata.name,
      namespace: resource.metadata.namespace,
      file,
      labels: resource.metadata.labels,
      annotations: resource.metadata.annotations,
    };

    data.resources.push(k8sResource);

    // Process specific resource types
    const spec = resource.spec as Record<string, unknown> | undefined;
    
    switch (resource.kind) {
      case "Application":
        if (resource.apiVersion.includes("argoproj")) {
          const source = (spec?.source || {}) as ArgoApp["source"];
          const destination = (spec?.destination || { server: "", namespace: "" }) as ArgoApp["destination"];
          data.argoApps.push({
            name: resource.metadata.name,
            namespace: resource.metadata.namespace || "argocd",
            source,
            destination,
            syncPolicy: spec?.syncPolicy as Record<string, unknown> | undefined,
          });
        }
        break;

      case "Service": {
        const ports = (spec?.ports || []) as Array<Record<string, unknown>>;
        data.services.push({
          name: resource.metadata.name,
          namespace: resource.metadata.namespace || "default",
          type: (spec?.type as string) || "ClusterIP",
          ports: ports.map((p) => ({
            port: p.port as number,
            targetPort: (p.targetPort || p.port) as number,
            protocol: (p.protocol as string) || "TCP",
          })),
          selector: spec?.selector as Record<string, string> | undefined,
        });
        break;
      }

      case "Deployment":
      case "StatefulSet": {
        const template = spec?.template as Record<string, unknown> | undefined;
        const templateSpec = template?.spec as Record<string, unknown> | undefined;
        const containers = (templateSpec?.containers || []) as Array<Record<string, unknown>>;
        const container = containers[0] || {};
        const containerPorts = (container.ports || []) as Array<Record<string, number>>;
        const containerEnv = (container.env || []) as Array<Record<string, string>>;
        data.deployments.push({
          name: resource.metadata.name,
          namespace: resource.metadata.namespace || "default",
          replicas: (spec?.replicas as number) || 1,
          image: (container.image as string) || "unknown",
          ports: containerPorts.map((p) => p.containerPort),
          env: containerEnv.map((e) => e.name),
        });
        break;
      }

      case "ConfigMap":
        data.configMaps.push({
          name: resource.metadata.name,
          namespace: resource.metadata.namespace || "default",
          keys: Object.keys(resource.data || {}),
        });
        break;

      case "Secret":
        data.secrets.push({
          name: resource.metadata.name,
          namespace: resource.metadata.namespace || "default",
          type: resource.type || "Opaque",
          keys: Object.keys(resource.data || {}),
        });
        break;

      case "Ingress": {
        // Link ingress to services
        const rules = (spec?.rules || []) as Array<Record<string, unknown>>;
        for (const rule of rules) {
          const host = rule.host as string;
          const http = rule.http as Record<string, unknown> | undefined;
          const httpPaths = (http?.paths || []) as Array<Record<string, unknown>>;
          for (const path of httpPaths) {
            const backend = path.backend as Record<string, unknown> | undefined;
            const backendService = backend?.service as Record<string, unknown> | undefined;
            const serviceName = (backendService?.name || backend?.serviceName) as string | undefined;
            const service = data.services.find((s) => s.name === serviceName);
            if (service) {
              service.ingress = {
                host,
                paths: [...(service.ingress?.paths || []), path.path as string],
              };
            }
          }
        }
        break;
      }
    }
  }
}

function parseSimpleYaml(doc: string): Record<string, unknown> {
  // Very simple YAML parsing for K8s manifests
  // In production, use a proper YAML parser
  const result: Record<string, unknown> = {};
  const lines = doc.split("\n");
  const stack: Array<{ indent: number; obj: Record<string, unknown>; key?: string }> = [
    { indent: -1, obj: result },
  ];

  for (const line of lines) {
    const trimmed = line.replace(/\s+$/, "");
    if (!trimmed || trimmed.startsWith("#")) continue;

    const indent = line.search(/\S/);
    const content = trimmed.trim();

    // Pop stack for dedent
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const current = stack[stack.length - 1].obj;
    
    // Array item
    if (content.startsWith("- ")) {
      const value = content.slice(2).trim();
      const parentKey = stack[stack.length - 1].key;
      if (parentKey && !Array.isArray(current[parentKey])) {
        current[parentKey] = [];
      }
      if (parentKey && Array.isArray(current[parentKey])) {
        if (value.includes(":")) {
          const itemObj: Record<string, unknown> = {};
          const [k, v] = value.split(":", 2);
          itemObj[k.trim()] = parseValue(v?.trim() || "");
          (current[parentKey] as unknown[]).push(itemObj);
          stack.push({ indent, obj: itemObj, key: k.trim() });
        } else {
          (current[parentKey] as unknown[]).push(parseValue(value));
        }
      }
      continue;
    }

    // Key-value pair
    const colonIdx = content.indexOf(":");
    if (colonIdx > 0) {
      const key = content.slice(0, colonIdx).trim();
      const value = content.slice(colonIdx + 1).trim();

      if (value) {
        current[key] = parseValue(value);
      } else {
        // Nested object
        current[key] = {};
        stack.push({ indent, obj: current[key] as Record<string, unknown>, key });
      }
    }
  }

  return result;
}

function parseValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function buildTopologyGraph(data: K8sData): void {
  // Add deployment nodes
  for (const deployment of data.deployments) {
    const id = `${deployment.namespace}/${deployment.name}`;
    data.topology.nodes.push({
      id,
      kind: "Deployment",
      namespace: deployment.namespace,
    });
  }

  // Add service nodes and link to deployments
  for (const service of data.services) {
    const id = `${service.namespace}/${service.name}`;
    data.topology.nodes.push({
      id,
      kind: "Service",
      namespace: service.namespace,
    });

    // Link service to deployment by selector
    if (service.selector) {
      for (const deployment of data.deployments) {
        if (deployment.namespace === service.namespace) {
          // Simplified matching - in reality, check label selectors
          if (deployment.name.includes(service.name.replace("-svc", "")) ||
              service.name.includes(deployment.name)) {
            data.topology.edges.push({
              from: id,
              to: `${deployment.namespace}/${deployment.name}`,
              type: "routes_to",
            });
          }
        }
      }
    }
  }

  // Add ArgoCD app nodes
  for (const app of data.argoApps) {
    data.topology.nodes.push({
      id: `argocd/${app.name}`,
      kind: "Application",
      namespace: "argocd",
    });
  }
}

registerExtractor(kubernetesExtractor);

export { kubernetesExtractor };
