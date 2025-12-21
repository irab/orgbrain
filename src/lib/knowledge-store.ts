import { promises as fs } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { ExtractionResult } from "./extractor-base.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_KNOWLEDGE_DIR = join(__dirname, "..", "..", "knowledge", "extracted");

export interface KnowledgeManifest {
  repo: string;
  ref: string;
  refType: "branch" | "tag";
  extractedAt: Date;
  extractors: string[];
  sha?: string;
}

export interface VersionedKnowledge {
  manifest: KnowledgeManifest;
  data: Record<string, unknown>;
}

export class KnowledgeStore {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || DEFAULT_KNOWLEDGE_DIR;
  }

  private getPath(repo: string, refType: "branch" | "tag", ref: string): string {
    const safeRef = ref.replace(/[/\\:*?"<>|]/g, "-");
    return join(this.baseDir, repo, `${refType}-${safeRef}`);
  }

  async save(
    repo: string,
    refType: "branch" | "tag",
    ref: string,
    results: ExtractionResult[],
    sha?: string
  ): Promise<void> {
    const dir = this.getPath(repo, refType, ref);
    await fs.mkdir(dir, { recursive: true });

    const manifest: KnowledgeManifest = {
      repo,
      ref,
      refType,
      extractedAt: new Date(),
      extractors: results.map((r) => r.extractor),
      sha,
    };

    await fs.writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));

    for (const result of results) {
      await fs.writeFile(join(dir, `${result.extractor}.json`), JSON.stringify(result.data, null, 2));
    }
  }

  async load(
    repo: string,
    refType: "branch" | "tag",
    ref: string
  ): Promise<VersionedKnowledge | null> {
    const dir = this.getPath(repo, refType, ref);

    try {
      const manifestContent = await fs.readFile(join(dir, "manifest.json"), "utf-8");
      const manifest = JSON.parse(manifestContent) as KnowledgeManifest;

      const data: Record<string, unknown> = {};
      for (const extractor of manifest.extractors) {
        try {
          const content = await fs.readFile(join(dir, `${extractor}.json`), "utf-8");
          data[extractor] = JSON.parse(content);
        } catch {
          // skip missing
        }
      }

      return { manifest, data };
    } catch {
      return null;
    }
  }

  async loadExtractor(
    repo: string,
    refType: "branch" | "tag",
    ref: string,
    extractor: string
  ): Promise<unknown | null> {
    const dir = this.getPath(repo, refType, ref);

    try {
      const content = await fs.readFile(join(dir, `${extractor}.json`), "utf-8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  async listVersions(repo: string): Promise<Array<{ refType: string; ref: string; extractedAt: Date }>> {
    const repoDir = join(this.baseDir, repo);
    const versions: Array<{ refType: string; ref: string; extractedAt: Date }> = [];

    try {
      const entries = await fs.readdir(repoDir);

      for (const entry of entries) {
        const manifestPath = join(repoDir, entry, "manifest.json");
        try {
          const content = await fs.readFile(manifestPath, "utf-8");
          const manifest = JSON.parse(content) as KnowledgeManifest;
          versions.push({
            refType: manifest.refType,
            ref: manifest.ref,
            extractedAt: new Date(manifest.extractedAt),
          });
        } catch {
          // ignore
        }
      }
    } catch {
      // repo not found
    }

    return versions.sort((a, b) => b.extractedAt.getTime() - a.extractedAt.getTime());
  }

  async listRepos(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.baseDir);
      const repos: string[] = [];

      for (const entry of entries) {
        const stat = await fs.stat(join(this.baseDir, entry));
        if (stat.isDirectory()) {
          repos.push(entry);
        }
      }

      return repos.sort();
    } catch {
      return [];
    }
  }

  async getLatest(repo: string, refType?: "branch" | "tag"): Promise<VersionedKnowledge | null> {
    const versions = await this.listVersions(repo);
    const filtered = refType ? versions.filter((v) => v.refType === refType) : versions;
    if (filtered.length === 0) return null;

    const latest = filtered[0];
    return this.load(repo, latest.refType as "branch" | "tag", latest.ref);
  }

  async isFresh(
    repo: string,
    refType: "branch" | "tag",
    ref: string,
    maxAgeMs: number = 24 * 60 * 60 * 1000,
    currentSha?: string
  ): Promise<boolean> {
    const knowledge = await this.load(repo, refType, ref);
    if (!knowledge) return false;

    // If current SHA is provided and differs from stored SHA, it's stale
    if (currentSha && knowledge.manifest.sha && currentSha !== knowledge.manifest.sha) {
      return false;
    }

    const age = Date.now() - new Date(knowledge.manifest.extractedAt).getTime();
    return age < maxAgeMs;
  }

  async delete(repo: string, refType: "branch" | "tag", ref: string): Promise<void> {
    const dir = this.getPath(repo, refType, ref);
    await fs.rm(dir, { recursive: true, force: true });
  }

  async prune(repo: string, keep: number = 5): Promise<number> {
    const versions = await this.listVersions(repo);
    const toDelete = versions.slice(keep);

    for (const version of toDelete) {
      await this.delete(repo, version.refType as "branch" | "tag", version.ref);
    }

    return toDelete.length;
  }

  async deleteRepo(repo: string): Promise<void> {
    const repoDir = join(this.baseDir, repo);
    await fs.rm(repoDir, { recursive: true, force: true });
  }

  async deleteAll(): Promise<number> {
    const repos = await this.listRepos();
    for (const repo of repos) {
      await this.deleteRepo(repo);
    }
    return repos.length;
  }
}
