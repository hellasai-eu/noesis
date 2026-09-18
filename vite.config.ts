import { defineConfig, type HtmlTagDescriptor, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { readFileSync, writeFileSync } from "fs";
import { componentTagger } from "lovable-tagger";
import { execSync } from "child_process";

import { resolveBrandMeta, type BrandMeta } from "./src/deployment/contract";
import { validateSettings } from "./src/deployment/settings";
import { resolveDeploymentDir } from "./scripts/deployment-dir";

let gitCommit = "unknown";
try {
  gitCommit = execSync("git rev-parse --short HEAD").toString().trim();
} catch {
  // git not available
}

const buildTime = new Date().toISOString();

/**
 * The overlay's plain-data metadata, read straight off disk.
 *
 * It has to be a file rather than a module: the document head is filled in
 * before anything is bundled, so there is no module graph to ask. Reading the
 * same JSON the overlay's `brand.config.ts` imports — through the same
 * `resolveBrandMeta` the app normalises it with — is what keeps the static
 * `<title>` and the name the app renders from disagreeing.
 */
function readBrandMeta(deploymentDir: string): BrandMeta {
  const file = path.join(deploymentDir, "brand.meta.json");
  try {
    return resolveBrandMeta(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    // A missing or malformed file must not take the build down with it — the
    // app still runs on the defaults, and the operator needs to be told which
    // file to look at rather than handed a stack trace.
    console.warn(
      `[deployment] could not read ${file}, falling back to the default metadata:`,
      error instanceof Error ? error.message : error,
    );
    return resolveBrandMeta();
  }
}

/**
 * Refuses to build on a malformed deployment policy.
 *
 * `defineSettings` is deliberately tolerant at run time — a policy typo must
 * not replace the app with a blank page — which means an unnoticed typo would
 * otherwise ship as a *quietly different policy*: a misspelled role simply
 * dropped, enforcing nothing. The build is the right place to be strict,
 * because there is a human watching it.
 *
 * This checks the declaration only. Whether the declaration was ever applied
 * to the database is something no build can know; `npm run settings:sql --
 * --check` in the deploy pipeline and the super-admin drift panel cover that.
 */
function validateDeploymentSettings(deploymentDir: string): Plugin {
  return {
    name: "validate-deployment-settings",
    buildStart() {
      const file = path.join(deploymentDir, "settings.json");
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(file, "utf8"));
      } catch (error) {
        // No file means "use the defaults", which is a legitimate overlay.
        if ((error as { code?: string }).code === "ENOENT") return;
        this.error(`${file} is not valid JSON: ${(error as Error).message}`);
        return;
      }

      const problems = validateSettings(raw);
      if (problems.length > 0) {
        this.error(
          [`${file} is not a usable policy:`, ...problems.map((p) => `  - ${p}`)].join("\n"),
        );
      }
    },
  };
}

function emitVersionJson(version: string, builtAt: string): Plugin {
  return {
    name: "emit-version-json",
    apply: "build",
    writeBundle(options) {
      const outDir = options.dir ?? path.resolve(__dirname, "dist");
      writeFileSync(
        path.join(outDir, "version.json"),
        JSON.stringify({ version, builtAt }),
      );
    },
  };
}

/**
 * Fills the document head from the deployment overlay.
 *
 * `index.html` ships as a shell with no product name in it, because the name
 * is not this repository's to state. The tags a crawler and a link preview
 * need are static, so they are written here at build time rather than set by
 * the app on first paint — a title applied after hydration is a title the
 * preview bot never sees.
 *
 * A tag whose value is `null` is omitted rather than emitted empty: a wrong
 * canonical URL is worse than none, and an `og:image` pointing at nothing
 * renders as a broken card.
 */
function injectBrandHead(deploymentDir: string): Plugin {
  return {
    name: "inject-brand-head",
    transformIndexHtml(html) {
      const meta = readBrandMeta(deploymentDir);
      const tags: HtmlTagDescriptor[] = [];

      const tag = (attrs: Record<string, string>, name = "meta") =>
        tags.push({ tag: name, attrs, injectTo: "head" });

      tag({ name: "description", content: meta.description });
      if (meta.keywords.length) {
        tag({ name: "keywords", content: meta.keywords.join(", ") });
      }
      tag({ name: "author", content: meta.name });

      tag({ property: "og:type", content: "website" });
      tag({ property: "og:site_name", content: meta.name });
      tag({ property: "og:title", content: meta.title });
      tag({ property: "og:description", content: meta.description });
      if (meta.canonicalUrl) {
        tag({ property: "og:url", content: meta.canonicalUrl });
        tag({ rel: "canonical", href: meta.canonicalUrl }, "link");
      }

      // `summary_large_image` reserves space for an image and renders a blank
      // or cropped placeholder when none is supplied, so the card type follows
      // whether there actually is one.
      tag({
        name: "twitter:card",
        content: meta.ogImage ? "summary_large_image" : "summary",
      });
      tag({ name: "twitter:title", content: meta.title });
      tag({ name: "twitter:description", content: meta.description });
      if (meta.twitterHandle) tag({ name: "twitter:site", content: meta.twitterHandle });
      if (meta.ogImage) {
        tag({ property: "og:image", content: meta.ogImage });
        tag({ name: "twitter:image", content: meta.ogImage });
      }

      return {
        html: html
          .replace("<title></title>", `<title>${escapeHtml(meta.title)}</title>`)
          .replace('<html lang="">', `<html lang="${escapeHtml(meta.htmlLang)}">`),
        tags,
      };
    },
  };
}

/** The values come from an operator-supplied file, so they are not trusted markup. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const deploymentDir = resolveDeploymentDir(__dirname, mode);

  return {
    server: {
      host: "::",
      port: 8080,
    },
    plugins: [
      react(),
      mode === "development" && componentTagger(),
      validateDeploymentSettings(deploymentDir),
      injectBrandHead(deploymentDir),
      emitVersionJson(gitCommit, buildTime),
    ].filter(Boolean),
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
        "@deployment": deploymentDir,
      },
    },
    define: {
      "import.meta.env.VITE_BUILD_TIME": JSON.stringify(
        buildTime.slice(0, 16).replace("T", " "),
      ),
      "import.meta.env.VITE_GIT_COMMIT": JSON.stringify(gitCommit),
    },
  };
});
