import type { Extractor, ExtractionContext, ExtractionResult } from "../../lib/extractor-base.js";
import { registerExtractor } from "../../lib/extractor-base.js";
import * as ts from "typescript";

interface Screen {
  name: string;
  file: string;
  navigatesTo: string[];
}

interface RouteDefinition {
  path: string;
  component?: string;
  params: string[];
  file: string;
  line: number;
}

interface Navigation {
  from: string;
  to: string;
  type: "push" | "replace" | "go" | "navigate" | "link" | "unknown";
  file: string;
  line: number;
}

interface ComponentHierarchy {
  name: string;
  parent?: string;
  children: string[];
  type: "screen" | "layout" | "component";
  file: string;
}

interface UserFlowResult {
  screens: Screen[];
  routes: string[];
  entryPoints: string[];
  routeDefinitions?: RouteDefinition[];
  navigations?: Navigation[];
  componentHierarchy?: ComponentHierarchy[];
}

const userFlowsExtractor: Extractor = {
  name: "user_flows",
  description: "Extract basic screens/pages and navigation targets for UI repos",

  async canExtract(ctx: ExtractionContext): Promise<boolean> {
    const files = await ctx.gitManager.listFilesAtRef(ctx.repoPath, ctx.ref);
    return files.some((f) => f.includes("/screens/") || f.includes("/pages/") || f.includes("/views/"));
  },

  async extract(ctx: ExtractionContext): Promise<ExtractionResult> {
    const config = ctx.config as {
      ignore?: string[];
      limit?: number;
    };

    const allFiles = await ctx.gitManager.listFilesAtRef(ctx.repoPath, ctx.ref);
    const ignore = config.ignore || [];
    const limit = config.limit || 50;

    // Built-in patterns to exclude test files and common non-screen files
    const builtInIgnore = [
      ".test.", ".spec.", ".nuxt.test.", ".nuxt.spec.",
      "__tests__", "/tests/", "/test/", "/__mocks__/",
      ".stories.", ".story."
    ];

    const screenFiles = allFiles.filter((f) => {
      const isScreen = f.includes("/screens/") || f.includes("/pages/") || f.includes("/views/");
      const isTestFile = builtInIgnore.some((pat) => f.includes(pat));
      const isUserIgnored = ignore.some((pat) => f.includes(pat.replace("**", "")));
      const isValidExtension = f.endsWith(".dart") || f.endsWith(".tsx") || f.endsWith(".vue") || f.endsWith(".jsx");
      // Only include .ts/.js if they're not in a test directory and don't have test extensions
      const isPlainScript = (f.endsWith(".ts") || f.endsWith(".js")) && !isTestFile;
      return isScreen && !isTestFile && !isUserIgnored && (isValidExtension || isPlainScript);
    }).slice(0, limit);

    const screens: Screen[] = [];
    const routes = new Set<string>();
    const routeDefinitions: RouteDefinition[] = [];
    const navigations: Navigation[] = [];
    const componentHierarchy: ComponentHierarchy[] = [];

    // Also look for route config files
    const routeConfigFiles = allFiles.filter((f) => {
      const isRouteFile = f.includes("routes") || f.includes("router") || f.includes("routing");
      const isValidExtension = f.endsWith(".ts") || f.endsWith(".tsx") || f.endsWith(".js") || f.endsWith(".jsx") || f.endsWith(".dart");
      return isRouteFile && isValidExtension && !builtInIgnore.some((pat) => f.includes(pat));
    }).slice(0, 20);

    // Extract route definitions from config files
    for (const file of routeConfigFiles) {
      try {
        const content = await ctx.gitManager.getFileAtRef(ctx.repoPath, ctx.ref, file);
        routeDefinitions.push(...extractRouteDefinitions(content, file));
      } catch {
        // skip unreadable files
      }
    }

    for (const file of screenFiles) {
      try {
        const content = await ctx.gitManager.getFileAtRef(ctx.repoPath, ctx.ref, file);
        const name = extractScreenName(file);
        const navigatesTo = findNavigations(content).map(extractScreenName);
        screens.push({ name, file, navigatesTo });

        // Extract route definitions from screen files
        routeDefinitions.push(...extractRouteDefinitions(content, file));

        // Extract improved navigation with AST
        if (file.endsWith(".tsx") || file.endsWith(".ts") || file.endsWith(".jsx") || file.endsWith(".js")) {
          navigations.push(...extractNavigationsAST(content, file, name));
        } else {
          // Fallback to regex for non-TS/JS files
          const regexNavs = findNavigations(content);
          for (const nav of regexNavs) {
            navigations.push({
              from: name,
              to: extractScreenName(nav),
              type: "unknown",
              file,
              line: 0,
            });
          }
        }

        // Extract component hierarchy
        if (file.endsWith(".tsx") || file.endsWith(".jsx")) {
          const hierarchy = extractComponentHierarchy(content, file, name);
          if (hierarchy) {
            componentHierarchy.push(hierarchy);
          }
        }

        // Very rough route detection (keep for backward compatibility)
        const routeMatch = content.match(/['"]\/(.+?)['"]/);
        if (routeMatch) routes.add(`/${routeMatch[1]}`);
      } catch {
        // skip unreadable files
      }
    }

    const entryPoints = screens.filter((s) => /home|main|splash/i.test(s.file)).map((s) => s.name);

    const data: UserFlowResult = {
      screens,
      routes: Array.from(routes).sort(),
      entryPoints,
      routeDefinitions: routeDefinitions.length > 0 ? routeDefinitions : undefined,
      navigations: navigations.length > 0 ? navigations : undefined,
      componentHierarchy: componentHierarchy.length > 0 ? componentHierarchy : undefined,
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

function extractScreenName(path: string): string {
  const parts = path.split("/");
  const filename = parts[parts.length - 1];
  return filename
    .replace(/\.(dart|tsx?|vue|js)$/, "")
    .replace(/_screen$/i, "")
    .replace(/_page$/i, "")
    .replace(/Screen$/i, "")
    .replace(/Page$/i, "")
    .split(/[-_]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

function findNavigations(content: string): string[] {
  const targets: string[] = [];
  const patterns = [
    /Navigator\.push.*?['"]([^'"#]+)['"]/g,
    /context\.go\(['"]([^'"#]+)['"]\)/g,
    /context\.push\(['"]([^'"#]+)['"]\)/g,
    /router\.navigate\(['"]([^'"#]+)['"]\)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      targets.push(match[1]);
    }
  }
  return Array.from(new Set(targets));
}

/**
 * Extract route definitions from various frameworks
 */
function extractRouteDefinitions(content: string, file: string): RouteDefinition[] {
  const routes: RouteDefinition[] = [];
  
  // React Router: <Route path="/..." />
  const reactRoutePattern = /<Route\s+path\s*=\s*['"]([^'"]+)['"]/gi;
  let match: RegExpExecArray | null;
  while ((match = reactRoutePattern.exec(content)) !== null) {
    const line = getLineNumber(content, match.index);
    const path = match[1];
    const params = extractRouteParams(path);
    
    // Try to find component prop
    const afterMatch = content.slice(match.index, match.index + 500);
    const componentMatch = afterMatch.match(/component\s*=\s*{?(\w+)/);
    
    routes.push({
      path,
      component: componentMatch ? componentMatch[1] : undefined,
      params,
      file,
      line,
    });
  }
  
  // React Router v6: createBrowserRouter([{ path: "/..." }])
  const routerConfigPattern = /(?:path|pathname)\s*:\s*['"]([^'"]+)['"]/gi;
  while ((match = routerConfigPattern.exec(content)) !== null) {
    const line = getLineNumber(content, match.index);
    const path = match[1];
    const params = extractRouteParams(path);
    
    // Try to find element/component
    const context = content.slice(Math.max(0, match.index - 200), match.index + 500);
    const elementMatch = context.match(/(?:element|component)\s*:\s*{?(\w+)/);
    
    routes.push({
      path,
      component: elementMatch ? elementMatch[1] : undefined,
      params,
      file,
      line,
    });
  }
  
  // Next.js file-based routes: detect from file path
  if (file.includes("/pages/") || file.includes("/app/")) {
    const path = inferNextJsRoute(file);
    if (path) {
      const params = extractRouteParams(path);
      routes.push({
        path,
        component: extractScreenName(file),
        params,
        file,
        line: 1,
      });
    }
  }
  
  // Flutter: routes: { '/path': ... }
  if (file.endsWith(".dart")) {
    const flutterRoutePattern = /['"]\/([^'"]+)['"]\s*:\s*(\w+)/g;
    while ((match = flutterRoutePattern.exec(content)) !== null) {
      const line = getLineNumber(content, match.index);
      const path = `/${match[1]}`;
      const params = extractRouteParams(path);
      
      routes.push({
        path,
        component: match[2],
        params,
        file,
        line,
      });
    }
    
    // Flutter GoRoute: GoRoute(path: '/path', ...)
    const goRoutePattern = /GoRoute\s*\(\s*path\s*:\s*['"]([^'"]+)['"]/g;
    while ((match = goRoutePattern.exec(content)) !== null) {
      const line = getLineNumber(content, match.index);
      const path = match[1];
      const params = extractRouteParams(path);
      
      routes.push({
        path,
        params,
        file,
        line,
      });
    }
  }
  
  // Vue Router: { path: '/...', component: ... }
  if (file.endsWith(".vue") || file.endsWith(".ts") || file.endsWith(".js")) {
    const vueRoutePattern = /path\s*:\s*['"]([^'"]+)['"]/g;
    while ((match = vueRoutePattern.exec(content)) !== null) {
      const line = getLineNumber(content, match.index);
      const path = match[1];
      const params = extractRouteParams(path);
      
      // Try to find component
      const context = content.slice(Math.max(0, match.index - 200), match.index + 500);
      const componentMatch = context.match(/component\s*:\s*(\w+)/);
      
      routes.push({
        path,
        component: componentMatch ? componentMatch[1] : undefined,
        params,
        file,
        line,
      });
    }
  }
  
  return routes;
}

/**
 * Extract route parameters from path string
 */
function extractRouteParams(path: string): string[] {
  const params: string[] = [];
  
  // React Router: /user/:id
  const reactParams = path.matchAll(/:(\w+)/g);
  for (const m of reactParams) {
    params.push(m[1]);
  }
  
  // Next.js: /user/[id], /user/[...slug]
  const nextjsParams = path.matchAll(/\[(\.\.\.)?(\w+)\]/g);
  for (const m of nextjsParams) {
    params.push(m[2]);
  }
  
  // Flutter/Vue: /user/{id}
  const curlyParams = path.matchAll(/\{(\w+)\}/g);
  for (const m of curlyParams) {
    params.push(m[1]);
  }
  
  return Array.from(new Set(params));
}

/**
 * Infer Next.js route from file path
 */
function inferNextJsRoute(filePath: string): string | undefined {
  // Pages router: pages/user/[id].tsx -> /user/[id]
  if (filePath.includes("/pages/")) {
    const parts = filePath.split("/pages/")[1];
    if (parts) {
      const route = "/" + parts.replace(/\.(tsx|ts|jsx|js)$/, "").replace(/\/index$/, "");
      return route || "/";
    }
  }
  
  // App router: app/user/[id]/page.tsx -> /user/[id]
  if (filePath.includes("/app/")) {
    const parts = filePath.split("/app/")[1];
    if (parts && parts.includes("/page.")) {
      const route = "/" + parts.split("/page.")[0];
      return route || "/";
    }
  }
  
  return undefined;
}

/**
 * Extract navigations using AST parsing
 */
function extractNavigationsAST(content: string, file: string, fromScreen: string): Navigation[] {
  const navigations: Navigation[] = [];
  
  try {
    const sourceFile = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") || file.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    
    function visit(node: ts.Node) {
      // React Router Link: <Link to="/path" />
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tagName = ts.isJsxOpeningElement(node) ? node.tagName : node.tagName;
        if (ts.isIdentifier(tagName) && tagName.text === "Link") {
          const toAttr = node.attributes.properties.find((prop) => {
            if (ts.isJsxAttribute(prop) && ts.isIdentifier(prop.name) && prop.name.text === "to") {
              return true;
            }
            return false;
          }) as ts.JsxAttribute | undefined;
          
          if (toAttr && toAttr.initializer && ts.isStringLiteral(toAttr.initializer)) {
            const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
            navigations.push({
              from: fromScreen,
              to: extractScreenName(toAttr.initializer.text),
              type: "link",
              file,
              line,
            });
          }
        }
      }
      
      // useNavigate() calls: navigate('/path')
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        let navType: Navigation["type"] = "unknown";
        let path: string | undefined;
        
        if (ts.isIdentifier(expression) && expression.text === "navigate") {
          navType = "navigate";
          if (node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
            path = node.arguments[0].text;
          }
        } else if (ts.isPropertyAccessExpression(expression)) {
          const prop = expression.name;
          if (ts.isIdentifier(prop)) {
            if (prop.text === "push" || prop.text === "replace" || prop.text === "go") {
              navType = prop.text as Navigation["type"];
              if (node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
                path = node.arguments[0].text;
              }
            }
          }
        }
        
        if (path) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          navigations.push({
            from: fromScreen,
            to: extractScreenName(path),
            type: navType,
            file,
            line,
          });
        }
      }
      
      node.forEachChild(visit);
    }
    
    visit(sourceFile);
  } catch (error) {
    // If AST parsing fails, fall back to regex
    console.warn(`AST parsing failed for ${file}, using regex fallback: ${error}`);
  }
  
  return navigations;
}

/**
 * Extract component hierarchy from JSX/TSX
 */
function extractComponentHierarchy(content: string, file: string, componentName: string): ComponentHierarchy | undefined {
  try {
    const sourceFile = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    
    let componentType: ComponentHierarchy["type"] = "component";
    const children: string[] = [];
    let parent: string | undefined;
    
    // Check if it's a layout component
    if (componentName.toLowerCase().includes("layout") || componentName.toLowerCase().includes("shell")) {
      componentType = "layout";
    } else if (file.includes("/screens/") || file.includes("/pages/")) {
      componentType = "screen";
    }
    
    function visit(node: ts.Node) {
      // Find JSX elements (child components)
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tagName = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
        
        if (ts.isIdentifier(tagName)) {
          const childName = tagName.text;
          // Filter out HTML elements
          if (!/^[a-z]/.test(childName) && childName !== componentName) {
            children.push(childName);
          }
        }
      }
      
      node.forEachChild(visit);
    }
    
    visit(sourceFile);
    
    return {
      name: componentName,
      parent,
      children: Array.from(new Set(children)),
      type: componentType,
      file,
    };
  } catch {
    return undefined;
  }
}

/**
 * Get line number from character index
 */
function getLineNumber(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

registerExtractor(userFlowsExtractor);
export { userFlowsExtractor };
