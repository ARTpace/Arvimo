// Applies patches/*.mjs descriptors onto vendor/ (idempotent, strict match).
// Never hand-edit vendor/upstream-src: all changes must be a patch file.
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const patchesDir = path.join(root, "patches");

const files = (await readdir(patchesDir))
  .filter((f) => f.endsWith(".mjs"))
  .sort();
if (!files.length) {
  console.log("No patches.");
  process.exit(0);
}
let applied = 0;
for (const f of files) {
  const mod = await import(pathToFileURL(path.join(patchesDir, f)).href);
  const desc = mod.default;
  const target = path.join(root, desc.file);
  let text = await readFile(target, "utf8");
  for (const r of desc.replacements) {
    // A hunk whose new text still contains old text re-applies itself on
    // every run (the v0.1.6 banner logs tripled). Reject at authoring time.
    if (r.new.includes(r.old)) {
      throw new Error(
        `Patch ${f}:${r.id}: new text contains old text (self-replicating hunk)`
      );
    }
    const occurrences = text.split(r.old).length - 1;
    if (occurrences === 1) {
      text = text.replace(r.old, r.new);
      applied++;
      console.log(`  applied ${f}:${r.id}`);
    } else if (occurrences === 0 && text.includes(r.new)) {
      console.log(`  already applied ${f}:${r.id}`);
    } else {
      throw new Error(
        `Patch ${f}:${r.id}: expected 1 occurrence, found ${occurrences} in ${desc.file}`
      );
    }
  }
  await writeFile(target, text);
}
console.log(`Patches done (${applied} new).`);
