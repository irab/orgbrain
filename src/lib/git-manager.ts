import { spawn } from "child_process";
import { promises as fs } from "fs";
import { join } from "path";

export interface RepoVersion {
  type: "branch" | "tag";
  name: string;
  sha: string;
  date: Date;
}

export interface RepoState {
  name: string;
  url: string;
  localPath: string;
  currentRef: string;
  branches: RepoVersion[];
  tags: RepoVersion[];
  lastFetched: Date;
}

export class GitManager {
  private cacheDir: string;

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
  }

  private async git(args: string[], cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn("git", args, {
        cwd: cwd || this.cacheDir,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => (stdout += data.toString()));
      proc.stderr.on("data", (data) => (stderr += data.toString()));

      proc.on("close", (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`git ${args.join(" ")} failed: ${stderr}`));
        }
      });
    });
  }

  async init(): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });
  }

  async ensureRepo(name: string, url: string, options: { shallow?: boolean } = {}): Promise<string> {
    const repoPath = join(this.cacheDir, name);

    try {
      await fs.access(repoPath);
      // For shallow repos, just fetch the default branch; for full repos, fetch everything
      if (options.shallow) {
        await this.git(["fetch", "--depth", "1", "origin"], repoPath);
      } else {
        await this.git(["fetch", "--all", "--prune", "--tags"], repoPath);
      }
    } catch {
      // Clone the repo - use shallow clone for faster initial setup
      if (options.shallow) {
        await this.git(["clone", "--bare", "--depth", "1", url, name]);
      } else {
        await this.git(["clone", "--bare", url, name]);
      }
    }

    return repoPath;
  }

  async listBranches(repoPath: string): Promise<RepoVersion[]> {
    const output = await this.git(
      ["for-each-ref", "--format=%(refname:short)|%(objectname)|%(creatordate:iso8601)", "refs/heads"],
      repoPath
    );

    if (!output) return [];

    return output.split("\n").filter(Boolean).map((line) => {
      const [name, sha, dateStr] = line.split("|");
      return {
        type: "branch" as const,
        name,
        sha,
        date: new Date(dateStr),
      };
    });
  }

  async listTags(repoPath: string, pattern?: string): Promise<RepoVersion[]> {
    const args = [
      "for-each-ref",
      "--format=%(refname:short)|%(objectname)|%(creatordate:iso8601)",
      "--sort=-creatordate",
    ];

    if (pattern) {
      args.push(`refs/tags/${pattern}`);
    } else {
      args.push("refs/tags");
    }

    const output = await this.git(args, repoPath);

    if (!output) return [];

    return output.split("\n").filter(Boolean).map((line) => {
      const [name, sha, dateStr] = line.split("|");
      return {
        type: "tag" as const,
        name,
        sha,
        date: new Date(dateStr),
      };
    });
  }

  async getFileAtRef(repoPath: string, ref: string, filePath: string): Promise<string> {
    try {
      return await this.git(["show", `${ref}:${filePath}`], repoPath);
    } catch {
      throw new Error(`File ${filePath} not found at ref ${ref}`);
    }
  }

  async listFilesAtRef(repoPath: string, ref: string, pathPattern?: string): Promise<string[]> {
    const args = ["ls-tree", "-r", "--name-only", ref];

    const output = await this.git(args, repoPath);
    let files = output.split("\n").filter(Boolean);

    // Filter by pattern if provided (supports glob-like patterns)
    if (pathPattern) {
      // Convert glob pattern to regex: *.tf -> \.tf$, **/*.yaml -> .*\.yaml$
      const regexPattern = pathPattern
        .replace(/\./g, "\\.")           // Escape dots
        .replace(/\*\*/g, ".*")          // ** matches any path
        .replace(/\*/g, "[^/]*")         // * matches within segment
        .replace(/\?/g, ".");            // ? matches single char
      
      const regex = new RegExp(regexPattern + "$");
      files = files.filter((f) => regex.test(f));
    }

    return files;
  }

  async grepAtRef(
    repoPath: string,
    ref: string,
    pattern: string,
    filePattern?: string
  ): Promise<Array<{ file: string; line: number; content: string }>> {
    const args = ["grep", "-n", "-E", pattern, ref];
    if (filePattern) {
      args.push("--", filePattern);
    }

    try {
      const output = await this.git(args, repoPath);
      return output
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const match = line.match(/^[^:]+:([^:]+):(\d+):(.*)$/);
          if (match) {
            return {
              file: match[1],
              line: parseInt(match[2], 10),
              content: match[3],
            };
          }
          return null;
        })
        .filter(Boolean) as Array<{ file: string; line: number; content: string }>;
    } catch {
      return [];
    }
  }

  async checkoutWorktree(repoPath: string, ref: string, targetDir: string): Promise<string> {
    const worktreePath = join(this.cacheDir, "worktrees", targetDir);

    try {
      await this.git(["worktree", "remove", "--force", worktreePath], repoPath);
    } catch {
      // ignore
    }

    await fs.mkdir(join(this.cacheDir, "worktrees"), { recursive: true });
    await this.git(["worktree", "add", "--detach", worktreePath, ref], repoPath);

    return worktreePath;
  }

  async removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
    await this.git(["worktree", "remove", "--force", worktreePath], repoPath);
  }

  async getRepoState(name: string, url: string): Promise<RepoState> {
    const repoPath = await this.ensureRepo(name, url);
    const branches = await this.listBranches(repoPath);
    const tags = await this.listTags(repoPath);

    let currentRef = "unknown";
    try {
      currentRef = await this.git(["rev-parse", "HEAD"], repoPath);
    } catch {
      // ignore
    }

    return {
      name,
      url,
      localPath: repoPath,
      currentRef,
      branches,
      tags,
      lastFetched: new Date(),
    };
  }

  async diffRefs(
    repoPath: string,
    fromRef: string,
    toRef: string
  ): Promise<Array<{ status: string; file: string }>> {
    const output = await this.git(["diff", "--name-status", fromRef, toRef], repoPath);

    return output.split("\n").filter(Boolean).map((line) => {
      const [status, ...fileParts] = line.split("\t");
      return {
        status: status.trim(),
        file: fileParts.join("\t"),
      };
    });
  }
}
