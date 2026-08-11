import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

for (const relativePath of [
  "iii-config.yaml",
  "iii-config.docker.yaml",
  "docker-compose.yml",
  ".env.example",
]) {
  const source = join(root, relativePath);
  if (existsSync(source)) copyFileSync(source, join(dist, relativePath));
}

const viewerDist = join(dist, "viewer");
mkdirSync(viewerDist, { recursive: true });
for (const fileName of ["index.html", "favicon.svg"]) {
  copyFileSync(join(root, "src", "viewer", fileName), join(viewerDist, fileName));
}
