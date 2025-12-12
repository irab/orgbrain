#!/usr/bin/env tsx
/**
 * Build Knowledge Base (org-agnostic)
 *
 * Clones/updates configured repos and runs all extractors to build the
 * versioned knowledge base for the MCP server.
 */

import { promises as fs } from "fs";
import { join } from "path";
import { runExtraction, type ExtractionOptions } from "../src/lib/extraction-runner.js";
import { loadConfig, isRepoEnabled } from "../src/lib/config-loader.js";
import { KnowledgeStore } from "../src/lib/knowledge-store.js";

async function main() {
  const args = process.argv.slice(2);
  const options: ExtractionOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--force" || arg === "-f") {
      options.force = true;
    } else if (arg === "--repo" || arg === "-r") {
      options.repos = options.repos || [];
      options.repos.push(args[++i]);
    } else if (arg === "--ref") {
      options.refs = options.refs || [];
      options.refs.push(args[++i]);
    } else if (arg === "--max-age") {
      options.maxAgeSecs = parseInt(args[++i], 10);
    } else if (arg === "--list" || arg === "-l") {
      await listKnowledge();
      return;
    } else if (arg === "--prune" || arg === "-p") {
      await pruneDisabled();
      return;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      return;
    }
  }

  console.log("🏗️  Building knowledge base\n");
  console.log("━".repeat(50));

  const startTime = Date.now();
  const summaries = await runExtraction(options);

  console.log("\n" + "━".repeat(50));
  console.log("\n📊 Summary:\n");

  let successful = 0;
  let failed = 0;

  for (const summary of summaries) {
    const status = summary.success ? "✅" : "❌";
    const extractors = summary.extractors.length > 0 ? `(${summary.extractors.join(", ")})` : "";

    console.log(`  ${status} ${summary.repo}:${summary.refType}/${summary.ref} ${extractors}`);

    if (summary.error) {
      console.log(`     Error: ${summary.error}`);
    }

    if (summary.success) successful++;
    else failed++;
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n⏱️  Total time: ${totalTime}s`);
  console.log(`📦 Processed: ${successful} successful, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

async function listKnowledge() {
  const config = await loadConfig();
  const store = new KnowledgeStore(config.knowledge_dir || "knowledge/extracted");

  console.log("📚 Available Knowledge:\n");

  const repos = await store.listRepos();

  if (repos.length === 0) {
    console.log("  No knowledge extracted yet. Run: npm run build:knowledge");
    return;
  }

  for (const repo of repos) {
    const repoConfig = config.repositories[repo];
    const enabled = repoConfig ? isRepoEnabled(repoConfig) : false;
    const status = enabled ? "" : " (DISABLED - run --prune to remove)";

    console.log(`\n📦 ${repo}:${status}`);
    const versions = await store.listVersions(repo);

    for (const version of versions) {
      const age = Math.round((Date.now() - version.extractedAt.getTime()) / 1000 / 60);
      const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
      console.log(`    ${version.refType}/${version.ref} (${ageStr})`);
    }
  }
}

async function pruneDisabled() {
  const config = await loadConfig();
  const knowledgeDir = config.knowledge_dir || "knowledge/extracted";
  const store = new KnowledgeStore(knowledgeDir);

  console.log("🧹 Pruning disabled repo data...\n");

  const extractedRepos = await store.listRepos();
  let pruned = 0;

  for (const repo of extractedRepos) {
    const repoConfig = config.repositories[repo];
    const shouldRemove = !repoConfig || !isRepoEnabled(repoConfig);

    if (shouldRemove) {
      const reason = !repoConfig ? "not in config" : "disabled";
      console.log(`  🗑️  Removing ${repo} (${reason})...`);

      try {
        const repoPath = join(knowledgeDir, repo);
        await fs.rm(repoPath, { recursive: true, force: true });
        pruned++;
      } catch (error) {
        console.error(`  ❌ Failed to remove ${repo}: ${error}`);
      }
    }
  }

  if (pruned === 0) {
    console.log("  ✨ No stale data to prune");
  } else {
    console.log(`\n✅ Pruned ${pruned} disabled/removed repo(s)`);
  }
}

function printHelp() {
  console.log(`
Knowledge Base Builder

Usage:
  npm run build:knowledge [options]

Options:
  --force, -f       Force rebuild even if knowledge is fresh
  --repo, -r <name> Only process specified repo (can be repeated)
  --ref <name>      Only process specified ref (can be repeated)
  --max-age <secs>  Max age in seconds before re-extraction (default: 86400)
  --list, -l        List available knowledge (shows disabled repos)
  --prune, -p       Remove extracted data for disabled/removed repos
  --help, -h        Show this help

Examples:
  npm run build:knowledge
  npm run build:knowledge -- --force
  npm run build:knowledge -- --repo example-repo --ref main
  npm run build:knowledge -- --list
  npm run build:knowledge -- --prune
`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

