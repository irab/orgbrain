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
  private fetchCache: Map<string, number> = new Map(); // repoPath -> last fetch timestamp
  private readonly FETCH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(cacheDir: string) {
    this.cacheDir = cacheDir;
  }

  private async git(args: string[], cwd?: string, timeoutMs: number = 30000): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn("git", args, {
        cwd: cwd || this.cacheDir,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      // Set timeout to prevent hanging
      const timeout = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error(`git ${args.join(" ")} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.stdout.on("data", (data) => (stdout += data.toString()));
      proc.stderr.on("data", (data) => (stderr += data.toString()));

      proc.on("close", (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`git ${args.join(" ")} failed: ${stderr || "unknown error"}`));
        }
      });

      proc.on("error", (error) => {
        clearTimeout(timeout);
        reject(new Error(`git ${args.join(" ")} spawn failed: ${error.message}`));
      });
    });
  }

  async init(): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });
  }

  async ensureRepo(name: string, url: string, options: { shallow?: boolean; skipFetch?: boolean; forceFetch?: boolean; skipClone?: boolean } = {}): Promise<string> {
    const repoPath = join(this.cacheDir, name);
    const now = Date.now();
    const lastFetch = this.fetchCache.get(repoPath);
    // Skip fetch if explicitly requested OR (cache is fresh AND not forcing fetch)
    const shouldSkipFetch = options.skipFetch || (!options.forceFetch && lastFetch && (now - lastFetch) < this.FETCH_CACHE_TTL_MS);

    try {
      await fs.access(repoPath);
      // Skip fetch if cached recently or explicitly requested
      if (!shouldSkipFetch) {
        // For shallow repos, just fetch the default branch; for full repos, fetch everything
        if (options.shallow) {
          // Explicitly update all branch refs from remote for bare repos
          await this.git(["fetch", "--depth", "1", "origin", "+refs/heads/*:refs/heads/*"], repoPath);
        } else {
          // Fetch with explicit refspec to ensure branches are updated in bare repos
          // The + prefix forces update even if not fast-forward
          // This updates refs/heads/* to point to the latest commits from origin
          await this.git(["fetch", "--prune", "--tags", "origin", "+refs/heads/*:refs/heads/*"], repoPath);
        }
        
        // After fetching, sync any remote refs that weren't updated by the refspec
        // This handles cases where refs might be stored under refs/remotes/origin/
        try {
          const remoteRefs = await this.git(["for-each-ref", "--format=%(refname)", "refs/remotes/origin/"], repoPath);
          if (remoteRefs) {
            for (const remoteRef of remoteRefs.split("\n").filter(Boolean)) {
              // Skip HEAD ref
              if (remoteRef.includes("/HEAD")) continue;
              
              // Extract branch name (e.g., refs/remotes/origin/main -> main)
              const match = remoteRef.match(/refs\/remotes\/origin\/(.+)/);
              if (!match) continue;
              
              const branchName = match[1];
              const localRef = `refs/heads/${branchName}`;
              
              // Update local branch ref to point to the remote branch commit
              try {
                const remoteSha = await this.git(["rev-parse", remoteRef], repoPath);
                await this.git(["update-ref", localRef, remoteSha], repoPath);
              } catch {
                // Ignore if we can't update this ref (might not exist locally)
              }
            }
          }
        } catch {
          // If syncing fails, that's okay - the refspec should have handled it
        }
        
        this.fetchCache.set(repoPath, now);
      }
    } catch {
      // If skipClone is true, don't clone - just throw error (for list_refs when repo doesn't exist)
      if (options.skipClone) {
        throw new Error(`Repository ${name} not found locally. Use extract_ref to clone and extract it first.`);
      }
      // Clone the repo - use shallow clone for faster initial setup
      if (options.shallow) {
        await this.git(["clone", "--bare", "--depth", "1", url, name]);
      } else {
        await this.git(["clone", "--bare", url, name]);
      }
      this.fetchCache.set(repoPath, now);
    }

    return repoPath;
  }

  async listBranches(repoPath: string, options: { verify?: boolean } = {}): Promise<RepoVersion[]> {
    const output = await this.git(
      ["for-each-ref", "--format=%(refname:short)|%(objectname)|%(creatordate:iso8601)", "refs/heads"],
      repoPath,
      10000 // 10 second timeout for listing branches
    );

    if (!output) return [];

    // Map branches
    const branches = output.split("\n").filter(Boolean).map((line) => {
      const [name, sha, dateStr] = line.split("|");
      return {
        type: "branch" as const,
        name,
        sha,
        date: new Date(dateStr),
      };
    });

    // Only verify if explicitly requested (for extraction, not for listing)
    if (!options.verify) {
      return branches;
    }

    // For each branch, verify the SHA is correct by resolving the ref directly
    // This ensures we get the actual commit the branch points to, not just what's in refs/heads
    const verifiedBranches = await Promise.all(
      branches.map(async (branch) => {
        try {
          // Try to resolve the branch name directly (this will follow any symlinks or updated refs)
          const resolvedSha = await this.git(["rev-parse", branch.name], repoPath);
          if (resolvedSha && resolvedSha !== branch.sha) {
            // If resolved SHA differs, get the commit date for the resolved commit
            try {
              const commitDate = await this.git(["show", "-s", "--format=%ci", resolvedSha], repoPath);
              return {
                ...branch,
                sha: resolvedSha,
                date: new Date(commitDate.trim()),
              };
            } catch {
              return { ...branch, sha: resolvedSha };
            }
          }
        } catch {
          // If resolution fails, use the original branch info
        }
        return branch;
      })
    );

    return verifiedBranches;
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

    const output = await this.git(args, repoPath, 10000); // 10 second timeout for listing tags

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

  async getCommitDate(repoPath: string, sha: string): Promise<Date | null> {
    try {
      // Use %cI for strict ISO 8601 format, or %ct for Unix timestamp
      const output = await this.git(["show", "-s", "--format=%cI", sha], repoPath);
      if (output) {
        const dateStr = output.trim();
        if (dateStr) {
          return new Date(dateStr);
        }
      }
      // Fallback to Unix timestamp if ISO format fails
      const timestampOutput = await this.git(["show", "-s", "--format=%ct", sha], repoPath);
      if (timestampOutput) {
        const timestamp = parseInt(timestampOutput.trim(), 10);
        if (!isNaN(timestamp)) {
          return new Date(timestamp * 1000);
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  /**
   * Get the SHA for a ref (branch or tag). Tries multiple strategies to find it.
   */
  async getRefSha(repoPath: string, ref: string): Promise<string | null> {
    // Try direct ref first
    try {
      return await this.git(["rev-parse", ref], repoPath);
    } catch {
      // Try with origin/ prefix for remote branches
      try {
        return await this.git(["rev-parse", `origin/${ref}`], repoPath);
      } catch {
        // Try refs/heads/ prefix
        try {
          return await this.git(["rev-parse", `refs/heads/${ref}`], repoPath);
        } catch {
          // Try refs/tags/ prefix
          try {
            return await this.git(["rev-parse", `refs/tags/${ref}`], repoPath);
          } catch {
            return null;
          }
        }
      }
    }
  }

  async getRepoState(name: string, url: string, options: { skipFetch?: boolean; verify?: boolean; skipClone?: boolean } = {}): Promise<RepoState> {
    const repoPath = await this.ensureRepo(name, url, { skipFetch: options.skipFetch, skipClone: options.skipClone });
    const branches = await this.listBranches(repoPath, { verify: options.verify });
    const tags = await this.listTags(repoPath);

    let currentRef = "unknown";
    // Skip HEAD resolution for list_refs (not needed and can be slow)
    if (options.verify) {
      try {
        currentRef = await this.git(["rev-parse", "HEAD"], repoPath);
      } catch {
        // ignore
      }
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
