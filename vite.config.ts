import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { writeFileSync } from "fs";
import { componentTagger } from "lovable-tagger";
import { execSync } from "child_process";

let gitCommit = "unknown";
try {
  gitCommit = execSync("git rev-parse --short HEAD").toString().trim();
} catch {
  // git not available
}

const buildTime = new Date().toISOString();

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

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [
    react(),
    mode === "development" && componentTagger(),
    emitVersionJson(gitCommit, buildTime),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  define: {
    'import.meta.env.VITE_BUILD_TIME': JSON.stringify(buildTime.slice(0, 16).replace('T', ' ')),
    'import.meta.env.VITE_GIT_COMMIT': JSON.stringify(gitCommit),
  },
}));
