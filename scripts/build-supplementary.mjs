#!/usr/bin/env node
// Build an anonymous, self-contained scene viewer for paper supplementary material.
//
//   node scripts/build-supplementary.mjs [config.json] [--out dir] [--no-thumbs]
//
// The config (default: splats.config.json, git-ignored) gives the page texts and the scenes;
// see supplementary/README.md for its format and for how to add scenes and thumbnails.
//
// Output (opens straight from disk, no server or network needed):
//   <out>/index.html        welcome page: title and scene cards with thumbnails
//   <out>/viewer.html       the viewer (view-only app, JS and CSS inlined); viewer.html#sceneN
//   <out>/scenes/sceneN.js  one script per scene: project JSON + gzipped splat data in base64
//   <out>/README.txt        short instructions
//
// Pages come from supplementary/index.html and supplementary/viewer.html. Thumbnails are either
// given in the config or clean renders of each scene's saved view, made by the viewer itself in
// headless Chrome (set CHROME to the browser binary if it is not found; --no-thumbs skips them).
//
// Double-blind: the app's name, links, file-format markers, splat file names and PLY header
// comments are removed, and the output is scanned for identifying strings (the build fails on a hit).

import { build } from "vite";
import { gzipSync } from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templates = path.join(root, "supplementary");

/**
 * Case-insensitive strings that must not appear anywhere in the output: the app, where it is
 * hosted, its author. Add paper authors and affiliations in the config ("forbidden").
 */
const FORBIDDEN = ["isosplat", "github.io", "lrz.de", "syncandshare", "mateo", "mayo"];
/** Raw bytes per base64 chunk in the scene scripts. */
const CHUNK = 3 << 20;
/** Headless window size for thumbnails (the viewer fills it: 16:9 renders). */
const THUMB_WINDOW = [800, 450];

// ------------------------------------------------------------------ arguments & config

let configPath = path.join(root, "splats.config.json");
let outDir = path.join(root, "splats");
let thumbs = true;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--out") outDir = path.resolve(argv[++i]);
  else if (argv[i] === "--no-thumbs") thumbs = false;
  else if (argv[i].startsWith("-")) usage(`unknown option ${argv[i]}`);
  else configPath = path.resolve(argv[i]);
}
function usage(msg) {
  console.error(`${msg}\nusage: build-supplementary.mjs [config.json] [--out dir] [--no-thumbs]  (see supplementary/README.md)`);
  process.exit(1);
}
if (!fs.existsSync(configPath)) usage(`config not found: ${configPath}`);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
/** Paths in the config are relative to the config file. */
const fromConfig = (p) => path.resolve(path.dirname(configPath), p);
if (!Array.isArray(config.scenes) || !config.scenes.length) usage("the config has no scenes");
const scenes = config.scenes.map((s, i) => {
  if (!s.file) usage(`scene ${i + 1} has no "file"`);
  return {
    file: fromConfig(s.file),
    id: `scene${i + 1}`,
    label: s.label ?? `Scene ${i + 1}`,
    description: s.description ?? "",
    thumbnail: s.thumbnail ? fromConfig(s.thumbnail) : null,
  };
});
FORBIDDEN.push(...(config.forbidden ?? []).map((f) => String(f).toLowerCase()));
const title = config.title ?? "Interactive scenes";
const subtitle = config.subtitle ?? "Supplementary material";

/** Human-readable parts of the output, scanned for identifying strings (base64 data would give false hits). */
const scanned = [];
const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

// ------------------------------------------------------------------ scenes

/** Drop `comment` lines from a PLY header (tool names, transforms, …); the data is untouched. */
function stripPlyComments(bytes) {
  const head = bytes.subarray(0, Math.min(bytes.length, 1 << 16)).toString("latin1");
  if (!head.startsWith("ply\n")) return bytes;
  const end = head.indexOf("end_header\n");
  if (end < 0) return bytes;
  const headerEnd = end + "end_header\n".length;
  const header = head
    .slice(0, headerEnd)
    .split("\n")
    .filter((l) => !l.startsWith("comment ") && !l.startsWith("obj_info "))
    .join("\n");
  return Buffer.concat([Buffer.from(header, "latin1"), bytes.subarray(headerEnd)]);
}

/** Drop `#` comment lines of a text trajectory (headers, tool notes); the parser skips them anyway. */
function stripLineComments(bytes) {
  const lines = bytes.toString("latin1").split("\n");
  return Buffer.from(lines.filter((l) => !l.trimStart().startsWith("#")).join("\n"), "latin1");
}

function readProject(file) {
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8).toString("latin1") !== "ISOSPLAT") throw new Error(`${file}: not a project file`);
  const jsonLength = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(16, 16 + jsonLength).toString("utf8"));
  const dataStart = 16 + jsonLength;
  const slice = (d) => buf.subarray(dataStart + d.offset, dataStart + d.offset + d.length);
  return { json, slice };
}

/** Returns the scene script and some stats for the welcome page. */
function encodeScene({ file, id, label }) {
  const { json, slice } = readProject(file);
  delete json.format;
  const parts = [];
  let offset = 0;
  let gaussians = 0;
  const counts = { splat: 0, trajectory: 0 };
  const numbered = (base, i) => (i === 0 ? base : `${base}.${String(i).padStart(3, "0")}`);
  // Every element with embedded data (splats, trajectories) is re-packed, renamed and stripped
  // of comments; the data itself is unchanged.
  for (const e of json.elements) {
    if (!e.data) continue;
    if (e.kind !== "splat" && e.kind !== "trajectory") throw new Error(`${file}: unknown element with data: ${e.kind}`);
    const splat = e.kind === "splat";
    const bytes = splat ? stripPlyComments(slice(e.data)) : stripLineComments(slice(e.data));
    const ext = path.extname(e.fileName).toLowerCase() || (splat ? ".ply" : ".tum");
    const i = counts[e.kind]++;
    e.name = numbered(splat ? "Gaussians" : "Trajectory", i);
    e.fileName = `${splat ? "gaussians" : "trajectory"}${ext}`;
    e.data = { offset, length: bytes.length };
    parts.push(bytes);
    if (splat) {
      const header = bytes.subarray(0, 4096).toString("latin1");
      gaussians += Number(/^element vertex (\d+)$/m.exec(header)?.[1] ?? 0);
      scanned.push([`${id} splat header`, header]);
    } else {
      scanned.push([`${id} trajectory`, bytes.toString("latin1")]);
    }
    offset += bytes.length;
  }
  scanned.push([`${id} json`, JSON.stringify(json)]);
  const gz = gzipSync(Buffer.concat(parts), { level: 9 });
  const chunks = [];
  for (let i = 0; i < gz.length; i += CHUNK) chunks.push(gz.subarray(i, i + CHUNK).toString("base64"));
  const js =
    `(window.SCENE_DATA = window.SCENE_DATA || {})[${JSON.stringify(id)}] = {\n` +
    `json: ${JSON.stringify(json)},\n` +
    `chunks: [\n${chunks.map((c) => JSON.stringify(c)).join(",\n")}\n]};\n`;
  const traj = counts.trajectory ? `, ${counts.trajectory} trajectory` : "";
  console.log(`${label}: ${gaussians.toLocaleString("en-US")} gaussians${traj}, ${(offset / 1e6).toFixed(1)} MB raw, ${(js.length / 1e6).toFixed(1)} MB encoded`);
  return { js, gaussians, bytes: js.length };
}

// ------------------------------------------------------------------ viewer page

async function buildViewer() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "supp-build-"));
  try {
    await build({
      root,
      configFile: path.join(root, "vite.config.ts"),
      logLevel: "warn",
      define: { __SUPPLEMENTARY__: "true" },
      build: {
        outDir: tmp,
        emptyOutDir: true,
        sourcemap: false,
        modulePreload: false,
        rollupOptions: { input: path.join(templates, "viewer.html") },
      },
    });
    const htmlPath = path.join(tmp, "supplementary", "viewer.html");
    let html = fs.readFileSync(htmlPath, "utf8");
    // Inline the CSS and the JS bundle: module scripts from file:// are blocked, inline ones are not.
    const asset = (rel) => fs.readFileSync(path.resolve(path.dirname(htmlPath), rel), "utf8");
    const cssLink = /<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/;
    const css = asset(must(html.match(cssLink), "stylesheet link")[1]);
    html = html.replace(cssLink, () => `<style>\n${css}\n</style>`);
    const jsTag = /\s*<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/;
    const js = asset(must(html.match(jsTag), "module script")[1]).replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
    html = html.replace(jsTag, "");
    const manifest = scenes.map(({ id, label }) => ({ id, label }));
    html = html.replace(
      "</body>",
      () =>
        `<script>window.SCENES = ${JSON.stringify(manifest).replace(/</g, "\\u003c")};</script>\n` +
        `<script type="module">\n${js}\n</script>\n</body>`,
    );
    return html;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function must(v, what) {
  if (!v) throw new Error(`build output: ${what} not found`);
  return v;
}

// ------------------------------------------------------------------ thumbnails (headless Chrome)

function findChrome() {
  const candidates = [process.env.CHROME, "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"];
  for (const c of candidates) {
    if (c && spawnSync(c, ["--version"], { stdio: "ignore" }).status === 0) return c;
  }
  throw new Error("Chrome not found for the thumbnails: set CHROME=/path/to/chrome, or pass --no-thumbs");
}

/** Open each scene in the built viewer and ask it for a clean render of its initial view. */
async function renderThumbnails(dir, list) {
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "supp-chrome-"));
  const chrome = spawn(
    findChrome(),
    [
      "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--hide-scrollbars",
      `--window-size=${THUMB_WINDOW.join(",")}`, "about:blank",
    ],
    { stdio: "ignore" },
  );
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    let page;
    for (let i = 0; i < 100 && !page; i++) {
      try {
        page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page");
      } catch {
        await sleep(100);
      }
    }
    if (!page) throw new Error("could not connect to headless Chrome");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
    let nextId = 0;
    const pending = new Map();
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      pending.get(d.id)?.(d);
      pending.delete(d.id);
    };
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const id = ++nextId;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression) => {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "evaluation failed");
      return r.result?.result?.value;
    };

    const out = {};
    for (const s of list) {
      const url = `${pathToFileURL(path.join(dir, "viewer.html")).href}#${s.id}`;
      await send("Page.navigate", { url: "about:blank" });
      await send("Page.navigate", { url });
      const t0 = Date.now();
      while ((await evaluate("document.documentElement.dataset.loaded ?? ''").catch(() => "")) !== s.id) {
        if (Date.now() - t0 > 300_000) throw new Error(`${s.label}: timed out loading in headless Chrome`);
        await sleep(500);
      }
      const t1 = Date.now();
      await sleep(1500); // let the live view settle (splat sorting)
      out[s.id] = await evaluate("renderThumbnail(640)");
      const secs = (t) => `${((t - t0) / 1e3).toFixed(0)} s`;
      console.log(`Thumbnail: ${s.label} (${(out[s.id].length / 1e3).toFixed(0)} kB; load ${secs(t1)}, total ${secs(Date.now())})`);
    }
    ws.close();
    return out;
  } finally {
    chrome.kill();
    await sleep(300);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ welcome page

const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

/** A thumbnail given in the config, as a data URL. */
function thumbnailFile(file) {
  const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (!type) throw new Error(`${file}: thumbnails must be .png, .jpg or .webp`);
  return `data:${type};base64,${fs.readFileSync(file).toString("base64")}`;
}

function welcomePage(stats, thumbnails) {
  const fmtSize = (n) => (n > 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.ceil(n / 1e3)} kB`);
  const cards = scenes
    .map((s) => {
      const { bytes } = stats[s.id];
      const thumb = thumbnails[s.id]
        ? `<img src="${thumbnails[s.id]}" alt="Preview of ${escHtml(s.label)}" />`
        : `<span>No preview</span>`;
      const meta = fmtSize(bytes);
      return (
        `<a class="scene" href="viewer.html#${s.id}">\n` +
        `  <div class="thumb">${thumb}</div>\n` +
        `  <div class="info"><span class="name">${escHtml(s.label)}</span>` +
        `<span class="meta">${meta}</span></div>\n` +
        (s.description ? `  <div class="desc">${escHtml(s.description)}</div>\n` : "") +
        `</a>`
      );
    })
    .join("\n");
  const html = fs.readFileSync(path.join(templates, "index.html"), "utf8");
  const fill = {
    "<!-- SCENES -->": cards,
    "{{TITLE}}": escHtml(title),
    "{{SUBTITLE}}": escHtml(subtitle),
    "{{INTRO}}": config.intro ? `<p class="intro">${escHtml(config.intro)}</p>` : "",
  };
  let out = html.replace(/<!--\n  Welcome page[\s\S]*?-->\n/, "");
  for (const [key, value] of Object.entries(fill)) {
    if (!out.includes(key)) throw new Error(`supplementary/index.html: ${key} placeholder missing`);
    out = out.replaceAll(key, () => value);
  }
  return out;
}

const README = `${title}
${subtitle}

Open index.html in a recent desktop browser (Chrome, Edge or Firefox recommended; WebGL 2 required).
Click a scene to open it in the viewer. Press H in the viewer to show or hide its controls,
and Backspace (or "← Scenes") to return to the list. Z toggles the depth view and P the
point-cloud view of the gaussians.

Everything runs locally from these files. You do not need to install anything, start a server or
connect to the internet. Large scenes take a few seconds to load.
`;

// ------------------------------------------------------------------ main

function scan() {
  for (const [name, content] of scanned) {
    // Embedded images are base64: random letter runs, not text.
    const lower = content.replace(/data:image\/[\w+.-]+;base64,[A-Za-z0-9+/=]+/g, "").toLowerCase();
    const hit = FORBIDDEN.find((f) => lower.includes(f));
    if (hit) throw new Error(`${name} contains the forbidden string "${hit}": output not written`);
  }
  scanned.length = 0;
}

const viewer = (await buildViewer()).replace(/<!--\n  Viewer page[\s\S]*?-->\n/, "");
scanned.push(["viewer.html", viewer], ["README.txt", README]);
const stats = {};
const sceneJs = {};
for (const s of scenes) {
  const { js, ...st } = encodeScene(s);
  sceneJs[s.id] = js;
  stats[s.id] = st;
}
scan();

// Write to a staging folder: the thumbnails need the viewer and scenes on disk, and a failed
// build must not leave a half-written output behind.
const stage = `${outDir}.partial`;
fs.rmSync(stage, { recursive: true, force: true });
try {
  fs.mkdirSync(path.join(stage, "scenes"), { recursive: true });
  fs.writeFileSync(path.join(stage, "viewer.html"), viewer);
  fs.writeFileSync(path.join(stage, "README.txt"), README);
  for (const s of scenes) fs.writeFileSync(path.join(stage, "scenes", `${s.id}.js`), sceneJs[s.id]);

  const thumbnails = {};
  for (const s of scenes) if (s.thumbnail) thumbnails[s.id] = thumbnailFile(s.thumbnail);
  const toRender = thumbs ? scenes.filter((s) => !s.thumbnail) : [];
  if (toRender.length) Object.assign(thumbnails, await renderThumbnails(stage, toRender));
  const index = welcomePage(stats, thumbnails);
  scanned.push(["index.html", index]);
  scan();
  fs.writeFileSync(path.join(stage, "index.html"), index);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.renameSync(stage, outDir);
} catch (err) {
  fs.rmSync(stage, { recursive: true, force: true });
  throw err;
}
let total = 0;
for (const f of fs.readdirSync(outDir, { recursive: true })) {
  const st = fs.statSync(path.join(outDir, f));
  if (st.isFile()) total += st.size;
}
console.log(`Wrote ${path.relative(process.cwd(), outDir) || "."}/ (${(total / 1e6).toFixed(1)} MB total)`);
