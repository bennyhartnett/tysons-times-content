import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareArticles } from "./prepare-publish.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheRoot = path.join(rootDir, ".cache");

function parseOptions(argv) {
  const options = {
    output: path.join(cacheRoot, "publisher-preview"),
    baseUrl: "http://127.0.0.1:4784/preview-content",
    imageMode: "source",
  };
  const next = (index, flag) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--output") options.output = path.resolve(rootDir, next(index++, flag));
    else if (flag === "--base-url") options.baseUrl = next(index++, flag).replace(/\/+$/, "");
    else if (flag === "--image-mode") options.imageMode = next(index++, flag).toLowerCase();
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!["source", "illustration"].includes(options.imageMode)) throw new Error("--image-mode must be source or illustration.");
  return options;
}

function ensureCachePath(target) {
  const resolved = path.resolve(target);
  const relative = path.relative(cacheRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Preview output must be a child of ${cacheRoot}.`);
  }
  return resolved;
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) resolve(result);
      else reject(new Error(`${result.stderr || result.stdout || `Command exited ${code}`}`.trim()));
    });
  });
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const outputRoot = ensureCachePath(options.output);
  const previewContentRoot = path.join(outputRoot, "content", "articles");
  const previewDistRoot = path.join(outputRoot, "dist");
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(path.dirname(previewContentRoot), { recursive: true });
  await cp(path.join(rootDir, "content", "articles"), previewContentRoot, { recursive: true });

  const prepared = await prepareArticles({
    all: true,
    articlePaths: [],
    contentRoot: previewContentRoot,
    inputRoot: path.join(rootDir, "input"),
    fallbackImage: path.join(rootDir, "tools", "publisher-gui", "assets", "editorial-fallback.webp"),
    imageMode: options.imageMode,
    author: "Tysons Times Staff",
    preview: true,
    dryRun: false,
  });

  const build = await run(process.execPath, [path.join(rootDir, "scripts", "build-content.mjs")], {
    cwd: rootDir,
    env: {
      ...process.env,
      CONTENT_ARTICLES_DIR: previewContentRoot,
      CONTENT_DIST_DIR: previewDistRoot,
      CONTENT_BASE_URL: options.baseUrl,
      CONTENT_PREVIEW: "1",
    },
  });
  const result = {
    builtAt: new Date().toISOString(),
    outputRoot,
    distRoot: previewDistRoot,
    baseUrl: options.baseUrl,
    stagedArticlesIncluded: prepared.prepared,
    message: build.stdout.trim(),
  };
  await writeFile(path.join(outputRoot, "preview-state.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(result));
}

main().catch((error) => {
  console.error(`Preview build failed: ${error.message}`);
  process.exitCode = 1;
});
