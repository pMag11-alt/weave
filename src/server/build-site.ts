/**
 * Build a static copy of the playground (it needs no server) into site/, for GitHub Pages.
 *
 *   npm run site
 */

import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const SITE = join(ROOT, "site");
const JS = join(ROOT, "dist", "src");

rmSync(SITE, { recursive: true, force: true });
mkdirSync(join(SITE, "js"), { recursive: true });
cpSync(join(ROOT, "public", "playground.html"), join(SITE, "index.html"));
for (const f of ["style.css", "favicon.svg"]) cpSync(join(ROOT, "public", f), join(SITE, f));
for (const dir of ["crdt", "client"]) {
  cpSync(join(JS, dir), join(SITE, "js", dir), { recursive: true, filter: (src) => !src.endsWith(".map") });
}
writeFileSync(join(SITE, ".nojekyll"), "");
console.log(`wrote ${SITE}`);
