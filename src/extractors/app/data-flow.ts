import type { Extractor, ExtractionContext, ExtractionResult } from "../../lib/extractor-base.js";
import { registerExtractor } from "../../lib/extractor-base.js";
import * as ts from "typescript";

interface ServiceInfo {
  name: string;
  file: string;
  dependencies: string[];
  /** Function calls made by this service (from AST analysis) */
  functionCalls?: Array<{ callee: string; line: number; args?: string[] }>;
}

interface APIEndpoint {
  method: string;
  path: string;
  file: string;
  line: number;
  description?: string;
}

interface DatabaseConnection {
  type: string;
  database?: string;
  file: string;
  line: number;
}

interface MessageQueue {
  type: string;
  queueName?: string;
  operation: "publish" | "subscribe" | "send" | "consume" | "unknown";
  file: string;
  line: number;
}

interface DataFlowResult {
  services: ServiceInfo[];
  externalCalls: Array<{ file: string; line: number; target: string }>;
  /** Function call graph extracted from AST */
  callGraph?: Array<{ caller: string; callee: string; file: string; line: number; serviceBoundary?: string }>;
  /** API routes/endpoints */
  apiRoutes?: APIEndpoint[];
  /** Database connections */
  databaseConnections?: DatabaseConnection[];
  /** Message queue/event bus usage */
  messageQueues?: MessageQueue[];
}

const dataFlowExtractor: Extractor = {
  name: "data_flow",
  description: "Lightweight service dependency hints from imports and HTTP calls",

  async canExtract(ctx: ExtractionContext): Promise<boolean> {
    const files = await ctx.gitManager.listFilesAtRef(ctx.repoPath, ctx.ref);
    return files.some((f) => 
      f.includes("/services/") || 
      f.includes("/api/") || 
      f.endsWith("Service.ts") ||
      // Rust projects (including monorepos with crates/)
      f.endsWith(".rs") ||
      f === "Cargo.toml"
    );
  },

  async extract(ctx: ExtractionContext): Promise<ExtractionResult> {
    const allFiles = await ctx.gitManager.listFilesAtRef(ctx.repoPath, ctx.ref);
    
    // JavaScript/TypeScript service files
    const jsServiceFiles = allFiles.filter((f) =>
      f.includes("/services/") || f.endsWith("Service.ts") || f.endsWith("Service.js")
    ).slice(0, 50);

    // Rust source files - include monorepo structures like crates/*/src/
    const rustFiles = allFiles.filter((f) =>
      f.endsWith(".rs") && (
        f.startsWith("src/") ||
        f.includes("/src/") ||  // crates/foo/src/bar.rs
        f.startsWith("crates/")  // crates/foo/bar.rs (some projects don't use src/)
      )
    ).slice(0, 100);

    const services: ServiceInfo[] = [];
    const externalCalls: Array<{ file: string; line: number; target: string }> = [];
    const callGraph: Array<{ caller: string; callee: string; file: string; line: number; serviceBoundary?: string }> = [];
    const apiRoutes: APIEndpoint[] = [];
    const databaseConnections: DatabaseConnection[] = [];
    const messageQueues: MessageQueue[] = [];

    // Process JS/TS services with AST analysis
    for (const file of jsServiceFiles) {
      try {
        const content = await ctx.gitManager.getFileAtRef(ctx.repoPath, ctx.ref, file);
        const name = inferServiceName(file);
        const dependencies = findImports(content).map(inferServiceName);
        
        // Use AST parsing for TypeScript files to get accurate call information
        const functionCalls: Array<{ callee: string; line: number; args?: string[] }> = [];
        if (file.endsWith(".ts") || file.endsWith(".tsx")) {
          const serviceBoundary = inferServiceBoundary(file);
          const astCalls = extractCallsFromAST(content, file);
          const imports = extractImports(content);
          
          for (const call of astCalls) {
            functionCalls.push({ callee: call.callee, line: call.line, args: call.args });
            
            // Check if callee is from an import (cross-file call)
            const importedModule = imports.find((imp) => 
              call.callee.startsWith(imp.localName + ".") || call.callee === imp.localName
            );
            
            callGraph.push({
              caller: call.caller,
              callee: call.callee,
              file,
              line: call.line,
              serviceBoundary: importedModule ? undefined : serviceBoundary,
            });
          }
        }
        
        services.push({ 
          name, 
          file, 
          dependencies,
          functionCalls: functionCalls.length > 0 ? functionCalls : undefined,
        });

        // Still use regex for HTTP calls (AST doesn't help much here)
        externalCalls.push(...findHttpCalls(content).map((target) => ({ file, line: 0, target })));
        
        // Extract API routes
        apiRoutes.push(...extractAPIRoutes(content, file));
        
        // Extract database connections
        databaseConnections.push(...extractDatabaseConnections(content, file));
        
        // Extract message queues
        messageQueues.push(...extractMessageQueues(content, file));
      } catch {
        // skip unreadable
      }
    }

    // Process Rust files
    for (const file of rustFiles) {
      try {
        const content = await ctx.gitManager.getFileAtRef(ctx.repoPath, ctx.ref, file);
        const name = inferRustModuleName(file);
        const dependencies = findRustImports(content);
        const description = extractRustAboutMe(content);
        
        services.push({ 
          name: description ? `${name} - ${description}` : name, 
          file, 
          dependencies 
        });

        externalCalls.push(...findHttpCalls(content).map((target) => ({ file, line: 0, target })));
        externalCalls.push(...findRustHttpCalls(content).map((target) => ({ file, line: 0, target })));
        
        // Extract API routes for Rust
        apiRoutes.push(...extractRustAPIRoutes(content, file));
        
        // Extract database connections for Rust
        databaseConnections.push(...extractDatabaseConnections(content, file));
        
        // Extract message queues for Rust
        messageQueues.push(...extractMessageQueues(content, file));
      } catch {
        // skip unreadable
      }
    }

    const data: DataFlowResult = {
      services,
      externalCalls,
      callGraph: callGraph.length > 0 ? callGraph : undefined,
      apiRoutes: apiRoutes.length > 0 ? apiRoutes : undefined,
      databaseConnections: databaseConnections.length > 0 ? databaseConnections : undefined,
      messageQueues: messageQueues.length > 0 ? messageQueues : undefined,
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

function inferServiceName(path: string): string {
  const parts = path.split("/");
  const filename = parts[parts.length - 1];
  return filename.replace(/\.(ts|js)$/, "").replace(/[^a-zA-Z0-9]+/g, " ").trim();
}

function inferRustModuleName(path: string): string {
  const parts = path.split("/");
  const filename = parts[parts.length - 1];
  return filename.replace(/\.rs$/, "").replace(/_/g, " ");
}

function extractRustAboutMe(content: string): string | undefined {
  const match = content.match(/\/\/\s*ABOUTME:\s*(.+)/);
  return match?.[1]?.trim();
}

function findImports(content: string): string[] {
  const imports: string[] = [];
  const importPattern = /import.*['"]([^'"}]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(content)) !== null) {
    imports.push(match[1]);
  }
  return imports;
}

function findRustImports(content: string): string[] {
  const imports: string[] = [];
  // use crate::module;
  const usePattern = /use\s+(?:crate::)?(\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = usePattern.exec(content)) !== null) {
    imports.push(match[1]);
  }
  // mod module;
  const modPattern = /mod\s+(\w+)/g;
  while ((match = modPattern.exec(content)) !== null) {
    imports.push(match[1]);
  }
  return [...new Set(imports)];
}

function findHttpCalls(content: string): string[] {
  const targets: string[] = [];
  const patterns = [
    /https?:\/\/[^'" )]+/g,
    /fetch\(['"]([^'"#]+)['"]/g,
    /axios\.(get|post|put|delete)\(['"]([^'"#]+)['"]/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const url = match[1] || match[2] || match[0];
      targets.push(url);
    }
  }
  return Array.from(new Set(targets));
}

function findRustHttpCalls(content: string): string[] {
  const targets: string[] = [];
  // Look for URL patterns in Rust
  const patterns = [
    /wss?:\/\/[^'" >\)]+/g,  // WebSocket URLs
    /https?:\/\/[^'" >\)]+/g,  // HTTP URLs
    /Url::parse\s*\(\s*["']([^"']+)["']/g,  // Url::parse("...")
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const url = match[1] || match[0];
      // Filter out placeholder URLs
      if (!url.includes("example.com") && !url.includes("localhost")) {
        targets.push(url);
      }
    }
  }
  return Array.from(new Set(targets));
}

/**
 * Extract API routes from TypeScript/JavaScript files
 */
function extractAPIRoutes(content: string, file: string): APIEndpoint[] {
  const endpoints: APIEndpoint[] = [];
  
  // Express routes: router.get('/path', ...), router.post('/path', ...)
  const expressPattern = /(?:router|app)\.(get|post|put|delete|patch|options|head)\s*\(\s*['"]([^'"]+)['"]/gi;
  let match: RegExpExecArray | null;
  while ((match = expressPattern.exec(content)) !== null) {
    const line = getLineNumber(content, match.index);
    endpoints.push({
      method: match[1].toUpperCase(),
      path: match[2],
      file,
      line,
    });
  }
  
  // Hono routes: app.get('/path', ...)
  const honoPattern = /app\.(get|post|put|delete|patch|options|head)\s*\(\s*['"]([^'"]+)['"]/gi;
  while ((match = honoPattern.exec(content)) !== null) {
    const line = getLineNumber(content, match.index);
    endpoints.push({
      method: match[1].toUpperCase(),
      path: match[2],
      file,
      line,
    });
  }
  
  // FastAPI routes (Python): @app.get('/path'), @router.get('/path')
  if (file.endsWith(".py")) {
    const fastapiPattern = /@(?:app|router)\.(get|post|put|delete|patch|options|head)\s*\(\s*['"]([^'"]+)['"]/gi;
    while ((match = fastapiPattern.exec(content)) !== null) {
      const line = getLineNumber(content, match.index);
      endpoints.push({
        method: match[1].toUpperCase(),
        path: match[2],
        file,
        line,
      });
    }
  }
  
  return endpoints;
}

/**
 * Extract API routes from Rust files
 */
function extractRustAPIRoutes(content: string, file: string): APIEndpoint[] {
  const endpoints: APIEndpoint[] = [];
  
  // Pattern: (Method::Get, "/path") => handler
  const routePattern = /\(Method::(\w+),\s*"([^"]+)"\)\s*=>/g;
  let match: RegExpExecArray | null;
  while ((match = routePattern.exec(content)) !== null) {
    const line = getLineNumber(content, match.index);
    endpoints.push({
      method: match[1].toUpperCase(),
      path: match[2],
      file,
      line,
    });
  }
  
  // Pattern: path.starts_with("/path")
  const startsWithPattern = /path\.starts_with\("([^"]+)"\)/g;
  while ((match = startsWithPattern.exec(content)) !== null) {
    const line = getLineNumber(content, match.index);
    // Try to find the method from context
    const contextStart = Math.max(0, content.lastIndexOf("\n", match.index) - 200);
    const context = content.slice(contextStart, match.index);
    const methodMatch = context.match(/Method::(\w+)/);
    
    endpoints.push({
      method: methodMatch ? methodMatch[1].toUpperCase() : "GET",
      path: match[1] + "*",
      file,
      line,
    });
  }
  
  return endpoints;
}

/**
 * Extract database connections from source files
 */
function extractDatabaseConnections(content: string, file: string): DatabaseConnection[] {
  const connections: DatabaseConnection[] = [];
  
  // Connection string patterns
  const connectionPatterns = [
    /DATABASE_URL\s*=\s*['"]([^'"]+)['"]/gi,
    /DB_HOST\s*=\s*['"]([^'"]+)['"]/gi,
    /new\s+Sequelize\s*\(['"]([^'"]+)['"]/gi,
    /createConnection\s*\([^)]*['"]([^'"]+)['"]/gi,
    /pg\.connect\s*\(['"]([^'"]+)['"]/gi,
    /mysql\.createConnection\s*\([^)]*['"]([^'"]+)['"]/gi,
  ];
  
  for (const pattern of connectionPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const line = getLineNumber(content, match.index);
      const connString = match[1] || match[0];
      
      // Try to extract database name from connection string
      let database: string | undefined;
      const dbMatch = connString.match(/[\/\?]([^\/\?]+)(?:\?|$)/);
      if (dbMatch) {
        database = dbMatch[1];
      }
      
      // Detect database type
      let dbType = "unknown";
      if (connString.includes("postgres") || connString.includes("postgresql")) {
        dbType = "postgresql";
      } else if (connString.includes("mysql")) {
        dbType = "mysql";
      } else if (connString.includes("sqlite")) {
        dbType = "sqlite";
      } else if (connString.includes("mongodb")) {
        dbType = "mongodb";
      }
      
      connections.push({
        type: dbType,
        database,
        file,
        line,
      });
    }
  }
  
  // ORM usage detection
  const ormPatterns = [
    /from\s+['"]prisma['"]/gi,
    /from\s+['"]typeorm['"]/gi,
    /from\s+['"]sequelize['"]/gi,
    /import.*prisma/gi,
    /import.*typeorm/gi,
    /import.*sequelize/gi,
  ];
  
  for (const pattern of ormPatterns) {
    if (pattern.test(content)) {
      const match = content.match(pattern);
      if (match) {
        const line = getLineNumber(content, content.indexOf(match[0]));
        let dbType = "unknown";
        if (match[0].includes("prisma")) {
          dbType = "prisma";
        } else if (match[0].includes("typeorm")) {
          dbType = "typeorm";
        } else if (match[0].includes("sequelize")) {
          dbType = "sequelize";
        }
        
        connections.push({
          type: dbType,
          file,
          line,
        });
      }
      break;
    }
  }
  
  return connections;
}

/**
 * Extract message queue/event bus usage
 */
function extractMessageQueues(content: string, file: string): MessageQueue[] {
  const queues: MessageQueue[] = [];
  
  // Redis pub/sub patterns
  const redisPatterns = [
    /redis\.publish\s*\(['"]([^'"]+)['"]/gi,
    /redis\.subscribe\s*\(['"]([^'"]+)['"]/gi,
    /redisClient\.pubsub\(\)/gi,
    /redis\.pubsub\(\)/gi,
  ];
  
  for (const pattern of redisPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const line = getLineNumber(content, match.index);
      const queueName = match[1];
      let operation: MessageQueue["operation"] = "unknown";
      if (pattern.source.includes("publish")) {
        operation = "publish";
      } else if (pattern.source.includes("subscribe")) {
        operation = "subscribe";
      }
      
      queues.push({
        type: "redis",
        queueName,
        operation,
        file,
        line,
      });
    }
  }
  
  // RabbitMQ patterns
  const rabbitmqPatterns = [
    /channel\.publish\s*\([^,]+,\s*['"]([^'"]+)['"]/gi,
    /channel\.consume\s*\(['"]([^'"]+)['"]/gi,
    /amqp\.connect\s*\(/gi,
  ];
  
  for (const pattern of rabbitmqPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const line = getLineNumber(content, match.index);
      const queueName = match[1];
      let operation: MessageQueue["operation"] = "unknown";
      if (pattern.source.includes("publish")) {
        operation = "publish";
      } else if (pattern.source.includes("consume")) {
        operation = "consume";
      }
      
      queues.push({
        type: "rabbitmq",
        queueName,
        operation,
        file,
        line,
      });
    }
  }
  
  // Kafka patterns
  const kafkaPatterns = [
    /producer\.send\s*\([^,]+,\s*['"]([^'"]+)['"]/gi,
    /consumer\.subscribe\s*\([^,]+,\s*['"]([^'"]+)['"]/gi,
    /kafka\.producer\s*\(/gi,
  ];
  
  for (const pattern of kafkaPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const line = getLineNumber(content, match.index);
      const queueName = match[1];
      let operation: MessageQueue["operation"] = "unknown";
      if (pattern.source.includes("send")) {
        operation = "send";
      } else if (pattern.source.includes("subscribe")) {
        operation = "subscribe";
      }
      
      queues.push({
        type: "kafka",
        queueName,
        operation,
        file,
        line,
      });
    }
  }
  
  // Event bus patterns
  const eventBusPatterns = [
    /eventBus\.emit\s*\(['"]([^'"]+)['"]/gi,
    /eventBus\.on\s*\(['"]([^'"]+)['"]/gi,
    /\.emit\s*\(['"]([^'"]+)['"]/gi,
  ];
  
  for (const pattern of eventBusPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const line = getLineNumber(content, match.index);
      const queueName = match[1];
      let operation: MessageQueue["operation"] = "unknown";
      if (pattern.source.includes("emit")) {
        operation = "publish";
      } else if (pattern.source.includes("on")) {
        operation = "subscribe";
      }
      
      queues.push({
        type: "event-bus",
        queueName,
        operation,
        file,
        line,
      });
    }
  }
  
  return queues;
}

/**
 * Get line number from character index
 */
function getLineNumber(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

/**
 * Extract import statements to track cross-file calls
 */
function extractImports(content: string): Array<{ localName: string; modulePath: string }> {
  const imports: Array<{ localName: string; modulePath: string }> = [];
  
  try {
    const sourceFile = ts.createSourceFile(
      "temp.ts",
      content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    
    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node)) {
        const moduleSpecifier = node.moduleSpecifier;
        if (ts.isStringLiteral(moduleSpecifier)) {
          const modulePath = moduleSpecifier.text;
          
          if (node.importClause) {
            if (node.importClause.namedBindings) {
              if (ts.isNamedImports(node.importClause.namedBindings)) {
                for (const element of node.importClause.namedBindings.elements) {
                  imports.push({
                    localName: element.name.text,
                    modulePath,
                  });
                }
              } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
                imports.push({
                  localName: node.importClause.namedBindings.name.text,
                  modulePath,
                });
              }
            } else if (node.importClause.name) {
              imports.push({
                localName: node.importClause.name.text,
                modulePath,
              });
            }
          }
        }
      }
      
      node.forEachChild(visit);
    }
    
    visit(sourceFile);
  } catch {
    // Fallback to regex if AST parsing fails
    const importPattern = /import\s+(?:\*\s+as\s+(\w+)|(\w+)|{([^}]+)})\s+from\s+['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = importPattern.exec(content)) !== null) {
      if (match[1]) {
        // namespace import
        imports.push({ localName: match[1], modulePath: match[4] });
      } else if (match[2]) {
        // default import
        imports.push({ localName: match[2], modulePath: match[4] });
      } else if (match[3]) {
        // named imports
        const namedImports = match[3].split(",").map((s) => {
          const parts = s.trim().split(/\s+as\s+/);
          return parts[parts.length - 1].trim();
        });
        for (const name of namedImports) {
          imports.push({ localName: name, modulePath: match[4] });
        }
      }
    }
  }
  
  return imports;
}

/**
 * Infer service boundary from file path
 */
function inferServiceBoundary(file: string): string | undefined {
  const parts = file.split("/");
  
  // Check for service directories
  const serviceIndex = parts.findIndex((p) => p === "services" || p === "service");
  if (serviceIndex >= 0 && serviceIndex < parts.length - 1) {
    return parts[serviceIndex + 1];
  }
  
  // Check for API directories
  const apiIndex = parts.findIndex((p) => p === "api" || p === "apis");
  if (apiIndex >= 0 && apiIndex < parts.length - 1) {
    return parts[apiIndex + 1];
  }
  
  // Use parent directory if file is in a service-like structure
  if (parts.length > 2) {
    return parts[parts.length - 2];
  }
  
  return undefined;
}

/**
 * Extract function calls from TypeScript AST
 */
function extractCallsFromAST(
  content: string,
  file: string
): Array<{ caller: string; callee: string; line: number; args?: string[] }> {
  const calls: Array<{ caller: string; callee: string; line: number; args?: string[] }> = [];
  
  try {
    const sourceFile = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    
    let currentFunction = "<top-level>";
    
    function visit(node: ts.Node) {
      // Track current function context
      if (ts.isFunctionDeclaration(node) && node.name) {
        currentFunction = node.name.text;
      } else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
        currentFunction = node.name.text;
      }
      
      // Extract call expressions
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        let calleeName: string | undefined;
        
        if (ts.isIdentifier(expression)) {
          calleeName = expression.text;
        } else if (ts.isPropertyAccessExpression(expression)) {
          const prop = expression.name;
          if (ts.isIdentifier(prop)) {
            const obj = expression.expression;
            if (ts.isIdentifier(obj)) {
              calleeName = `${obj.text}.${prop.text}`;
            } else {
              calleeName = prop.text;
            }
          }
        }
        
        if (calleeName) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          const args: string[] = [];
          
          // Extract argument names/types
          for (const arg of node.arguments) {
            if (ts.isIdentifier(arg)) {
              args.push(arg.text);
            } else if (ts.isStringLiteral(arg)) {
              args.push(`"${arg.text}"`);
            } else if (ts.isNumericLiteral(arg)) {
              args.push(arg.text);
            }
          }
          
          calls.push({
            caller: currentFunction,
            callee: calleeName,
            line,
            args: args.length > 0 ? args : undefined,
          });
        }
      }
      
      node.forEachChild(visit);
    }
    
    visit(sourceFile);
  } catch (error) {
    // If AST parsing fails, fall back to regex-based extraction
    console.warn(`AST parsing failed for ${file}, using regex fallback: ${error}`);
  }
  
  return calls;
}

registerExtractor(dataFlowExtractor);
export { dataFlowExtractor };
