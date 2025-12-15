import type { Extractor, ExtractionContext, ExtractionResult } from "../../lib/extractor-base.js";
import { registerExtractor } from "../../lib/extractor-base.js";

interface DnsRecord {
  name: string;
  type: string;
  value?: string;
  proxied?: boolean;
  file: string;
}

interface StaticIp {
  name: string;
  type: string;
  region?: string;
  file: string;
}

interface TerraformResource {
  type: string;
  name: string;
  file: string;
}

interface TerraformSummary {
  files: string[];
  resources: number;
  modules: number;
  providers: string[];
  // Enhanced: DNS and networking
  domains: string[];
  dnsRecords: DnsRecord[];
  staticIps: StaticIp[];
  // Key resources by type
  resourcesByType: Record<string, TerraformResource[]>;
}

const terraformExtractor: Extractor = {
  name: "terraform",
  description: "Extract Terraform infrastructure including DNS records, domains, and static IPs",

  async canExtract(ctx: ExtractionContext): Promise<boolean> {
    const files = await ctx.gitManager.listFilesAtRef(ctx.repoPath, ctx.ref);
    return files.some((f) => f.endsWith(".tf"));
  },

  async extract(ctx: ExtractionContext): Promise<ExtractionResult> {
    const files = await ctx.gitManager.listFilesAtRef(ctx.repoPath, ctx.ref, "*.tf");
    const limited = files.slice(0, 200);

    const providers = new Set<string>();
    const domains = new Set<string>();
    const dnsRecords: DnsRecord[] = [];
    const staticIps: StaticIp[] = [];
    const resourcesByType: Record<string, TerraformResource[]> = {};
    let resourceCount = 0;
    let modules = 0;

    for (const file of limited) {
      try {
        const content = await ctx.gitManager.getFileAtRef(ctx.repoPath, ctx.ref, file);
        
        // Count resources and modules
        resourceCount += countMatches(content, /resource\s+"[^"]+"\s+"[^"]+"/g);
        modules += countMatches(content, /module\s+"[^"]+"/g);
        
        // Extract providers
        for (const p of findProviders(content)) providers.add(p);
        
        // Extract resources by type
        extractResources(content, file, resourcesByType);
        
        // Extract DNS records (Cloudflare, AWS Route53, Google DNS)
        extractDnsRecords(content, file, dnsRecords, domains);
        
        // Extract static IPs (GCP, AWS)
        extractStaticIps(content, file, staticIps);
        
        // Extract domains from various sources
        extractDomains(content, domains);
      } catch {
        // ignore unreadable
      }
    }

    const data: TerraformSummary = {
      files: limited,
      resources: resourceCount,
      modules,
      providers: Array.from(providers).sort(),
      domains: Array.from(domains).sort(),
      dnsRecords,
      staticIps,
      resourcesByType,
    };

    return {
      extractor: this.name,
      repo: ctx.repoName,
      ref: ctx.ref,
      extractedAt: new Date(),
      data,
    };
  },
};

function countMatches(content: string, pattern: RegExp): number {
  return (content.match(pattern) || []).length;
}

function findProviders(content: string): string[] {
  const providers: string[] = [];
  const providerPattern = /provider\s+"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = providerPattern.exec(content)) !== null) {
    providers.push(match[1]);
  }
  return providers;
}

function extractResources(content: string, file: string, resourcesByType: Record<string, TerraformResource[]>): void {
  const resourcePattern = /resource\s+"([^"]+)"\s+"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = resourcePattern.exec(content)) !== null) {
    const type = match[1];
    const name = match[2];
    if (!resourcesByType[type]) {
      resourcesByType[type] = [];
    }
    resourcesByType[type].push({ type, name, file });
  }
}

function extractDnsRecords(
  content: string, 
  file: string, 
  dnsRecords: DnsRecord[], 
  domains: Set<string>
): void {
  // Cloudflare DNS records
  const cfRecordPattern = /resource\s+"cloudflare_record"\s+"([^"]+)"\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/gs;
  let match: RegExpExecArray | null;
  
  while ((match = cfRecordPattern.exec(content)) !== null) {
    const name = match[1];
    const block = match[2];
    
    const record: DnsRecord = { name, type: "A", file };
    
    // Extract record type
    const typeMatch = block.match(/type\s*=\s*"([^"]+)"/);
    if (typeMatch) record.type = typeMatch[1];
    
    // Extract record name/subdomain
    const nameMatch = block.match(/name\s*=\s*"([^"]+)"/);
    if (nameMatch) record.name = nameMatch[1];
    
    // Extract value
    const valueMatch = block.match(/value\s*=\s*"([^"]+)"/);
    if (valueMatch) record.value = valueMatch[1];
    
    // Extract proxied status
    const proxiedMatch = block.match(/proxied\s*=\s*(true|false)/);
    if (proxiedMatch) record.proxied = proxiedMatch[1] === "true";
    
    dnsRecords.push(record);
  }
  
  // AWS Route53 records
  const r53Pattern = /resource\s+"aws_route53_record"\s+"([^"]+)"\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/gs;
  while ((match = r53Pattern.exec(content)) !== null) {
    const name = match[1];
    const block = match[2];
    
    const record: DnsRecord = { name, type: "A", file };
    
    const typeMatch = block.match(/type\s*=\s*"([^"]+)"/);
    if (typeMatch) record.type = typeMatch[1];
    
    const nameMatch = block.match(/name\s*=\s*"([^"]+)"/);
    if (nameMatch) {
      record.name = nameMatch[1];
      // Extract domain from FQDN
      const domain = nameMatch[1].replace(/^\*\./, "").split(".").slice(-2).join(".");
      if (domain.includes(".")) domains.add(domain);
    }
    
    dnsRecords.push(record);
  }
  
  // Google DNS records
  const gDnsPattern = /resource\s+"google_dns_record_set"\s+"([^"]+)"\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/gs;
  while ((match = gDnsPattern.exec(content)) !== null) {
    const name = match[1];
    const block = match[2];
    
    const record: DnsRecord = { name, type: "A", file };
    
    const typeMatch = block.match(/type\s*=\s*"([^"]+)"/);
    if (typeMatch) record.type = typeMatch[1];
    
    const nameMatch = block.match(/name\s*=\s*"([^"]+)"/);
    if (nameMatch) record.name = nameMatch[1];
    
    dnsRecords.push(record);
  }
}

function extractStaticIps(content: string, file: string, staticIps: StaticIp[]): void {
  // GCP static IPs
  const gcpIpPattern = /resource\s+"google_compute_(?:global_)?address"\s+"([^"]+)"\s*\{([^}]+)\}/gs;
  let match: RegExpExecArray | null;
  
  while ((match = gcpIpPattern.exec(content)) !== null) {
    const name = match[1];
    const block = match[2];
    
    const ip: StaticIp = { 
      name, 
      type: content.includes("global_address") ? "global" : "regional",
      file 
    };
    
    const regionMatch = block.match(/region\s*=\s*"([^"]+)"/);
    if (regionMatch) ip.region = regionMatch[1];
    
    // Check for actual name in block
    const nameMatch = block.match(/name\s*=\s*"([^"]+)"/);
    if (nameMatch) ip.name = nameMatch[1];
    
    staticIps.push(ip);
  }
  
  // AWS Elastic IPs
  const awsEipPattern = /resource\s+"aws_eip"\s+"([^"]+)"\s*\{([^}]*)\}/gs;
  while ((match = awsEipPattern.exec(content)) !== null) {
    const name = match[1];
    staticIps.push({ name, type: "elastic_ip", file });
  }
}

function extractDomains(content: string, domains: Set<string>): void {
  // Common domain patterns
  const domainPatterns = [
    // Cloudflare zone
    /zone\s*=\s*"([a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z]{2,})"/g,
    // Domain in strings
    /domain\s*=\s*"([a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z]{2,})"/g,
    // URLs
    /https?:\/\/([a-zA-Z0-9][-a-zA-Z0-9.]*\.[a-zA-Z]{2,})/g,
    // Hosted zone name
    /name\s*=\s*"([a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z]{2,})\.?"/g,
  ];
  
  for (const pattern of domainPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const domain = match[1].replace(/\.$/, ""); // Remove trailing dot
      // Filter out common false positives
      if (
        !domain.includes("example.com") &&
        !domain.includes("localhost") &&
        !domain.startsWith("var.") &&
        !domain.startsWith("local.") &&
        domain.includes(".")
      ) {
        domains.add(domain);
      }
    }
  }
}

registerExtractor(terraformExtractor);
export { terraformExtractor };
