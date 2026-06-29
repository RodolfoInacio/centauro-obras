// ============================================================================
// Migração ÚNICA: sobe os desenhos (base64 → Storage) e insere as obras no banco.
// Uso:
//   1) crie o arquivo  seed.secrets.json  (NÃO versionado) com:
//        { "url": "https://SEU-PROJETO.supabase.co", "serviceRole": "SUA_SERVICE_ROLE_KEY" }
//   2) rode:  node seed_supabase.mjs
// A service_role ignora o RLS (por isso só roda localmente, nunca no site).
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

// ── credenciais ──
let url = process.env.SUPABASE_URL;
let serviceRole = process.env.SUPABASE_SERVICE_ROLE;
const secretsPath = path.resolve("./seed.secrets.json");
if ((!url || !serviceRole) && fs.existsSync(secretsPath)) {
  const s = JSON.parse(fs.readFileSync(secretsPath, "utf-8"));
  url = url || s.url;
  serviceRole = serviceRole || s.serviceRole;
}
if (!url || !serviceRole) {
  console.error("Faltam credenciais. Crie seed.secrets.json com { url, serviceRole }.");
  process.exit(1);
}

const supabase = createClient(url, serviceRole, { auth: { persistSession: false } });
const BUCKET = "desenhos";

// ── dados ──
const dataPath = path.resolve("../obras_data.json");
const obras = JSON.parse(fs.readFileSync(dataPath, "utf-8"));

function dataUriToBuffer(uri) {
  const comma = uri.indexOf(",");
  const meta = uri.slice(5, comma); // ex: image/jpeg;base64
  const b64 = uri.slice(comma + 1);
  const contentType = meta.split(";")[0] || "image/jpeg";
  return { buffer: Buffer.from(b64, "base64"), contentType };
}

let totalDesenhos = 0;
for (const obra of obras) {
  // sobe desenhos e troca base64 por URL pública
  for (const item of obra.itens) {
    if (item.desenho && item.desenho.startsWith("data:")) {
      const { buffer, contentType } = dataUriToBuffer(item.desenho);
      const objPath = `${obra.numero}/${item.id}.jpg`;
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(objPath, buffer, { contentType, upsert: true });
      if (upErr) { console.error(`  ! desenho ${objPath}:`, upErr.message); continue; }
      item.desenho = supabase.storage.from(BUCKET).getPublicUrl(objPath).data.publicUrl;
      totalDesenhos++;
    }
  }
  // insere/atualiza a obra
  const row = {
    id: obra.id, numero: obra.numero, cliente: obra.cliente,
    updated_at: new Date().toISOString(), data: obra,
  };
  const { error } = await supabase.from("obras").upsert(row);
  if (error) { console.error(`ERRO obra #${obra.numero}:`, error.message); continue; }
  console.log(`#${obra.numero} | ${obra.cliente.slice(0, 30).padEnd(30)} | ${obra.itens.length} itens`);
}

console.log(`\n[OK] ${obras.length} obras inseridas | ${totalDesenhos} desenhos no Storage`);
