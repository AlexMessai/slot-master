import { access, readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));

for (const field of ["name", "api", "main", "ui"]) {
  if (typeof manifest[field] !== "string" || manifest[field].length === 0) {
    throw new Error(`manifest.json must contain a non-empty ${field} field`);
  }
}

await Promise.all([access(manifest.main), access(manifest.ui)]);

console.log(`Validated ${manifest.name}: ${manifest.main}, ${manifest.ui}`);
