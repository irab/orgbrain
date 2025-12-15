// Register all extractors by importing their modules
import "./app/nip-usage.js";
import "./app/user-flows.js";
import "./app/data-flow.js";
import "./app/monorepo.js";
import "./infra/terraform.js";
import "./infra/kubernetes.js";
import "./architecture/journey-impact.js";
import "./types/index.js";

// Re-export registry helpers
export * from "../lib/extractor-base.js";
