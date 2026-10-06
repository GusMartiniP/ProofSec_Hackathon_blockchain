// Executado pelo hook post_build do Anchor.toml.
// Copia o IDL real (target/idl/proofsec.json) para o frontend e para o agente.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "target/idl/proofsec.json");

if (!existsSync(src)) {
  console.error("[sync-idl] target/idl/proofsec.json não encontrado — rode `anchor build` primeiro.");
  process.exit(0);
}

for (const rel of ["../frontend/src/idl/proofsec.json", "../agent/idl/proofsec.json"]) {
  const dest = resolve(root, rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`[sync-idl] ${rel} atualizado`);
}
