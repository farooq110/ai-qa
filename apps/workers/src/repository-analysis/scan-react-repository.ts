import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export interface ApplicationKnowledgeModel {
  framework: "React" | "Unknown";
  language: "TypeScript" | "JavaScript" | "Mixed" | "Unknown";
  buildTool: string | null;
  routes: string[];
  components: string[];
  apiCalls: Array<{ method: string; path: string }>;
  capabilities: string[];
  analyzedFiles: string[];
}

const ignoredDirectories = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage"]);

async function listSourceFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) return ignoredDirectories.has(entry.name) ? [] : listSourceFiles(root, fullPath);
    return /\.(tsx?|jsx?)$/.test(entry.name) ? [relative(root, fullPath)] : [];
  }));
  return files.flat();
}

function unique(values: Iterable<string>) {
  return [...new Set(values)].sort();
}

export async function scanReactRepository(root: string): Promise<ApplicationKnowledgeModel> {
  const files = await listSourceFiles(root);
  const sources = await Promise.all(files.map(async (file) => ({ file, content: await readFile(join(root, file), "utf8") })));
  const packageJson = await readFile(join(root, "package.json"), "utf8").then(JSON.parse).catch(() => ({})) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  const framework = dependencies.react ? "React" : "Unknown";
  const buildTool = dependencies.vite ? "Vite" : dependencies.next ? "Next.js" : null;
  const hasTypeScript = files.some((file) => /\.tsx?$/.test(file));
  const hasJavaScript = files.some((file) => /\.jsx?$/.test(file));
  const language = hasTypeScript && hasJavaScript ? "Mixed" : hasTypeScript ? "TypeScript" : hasJavaScript ? "JavaScript" : "Unknown";
  const routes = unique(sources.flatMap(({ content }) => [...content.matchAll(/(?:path|route)\s*[:=]\s*["'`]([^"'`]+)["'`]/g)].map((match) => match[1])));
  const components = unique(sources.flatMap(({ file, content }) => {
    const declared = [...content.matchAll(/(?:function|const)\s+([A-Z][A-Za-z0-9_]*)/g)].map((match) => match[1]);
    return declared.length ? declared : /\.(tsx|jsx)$/.test(file) ? [file.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "")] : [];
  }));
  const apiCalls = unique(sources.flatMap(({ content }) => [...content.matchAll(/fetch\(\s*["'`]([^"'`]+)["'`]/g)].map((match) => `GET ${match[1]}`))).map((value) => {
    const [method, ...path] = value.split(" ");
    return { method, path: path.join(" ") };
  });
  const capabilities = unique([...components, ...routes.map((route) => `Route ${route}`)]);
  return { framework, language, buildTool, routes, components, apiCalls, capabilities, analyzedFiles: files };
}