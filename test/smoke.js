// Teste de ponta a ponta: sobe o servidor via stdio com um cliente MCP de verdade e chama cada tool.
// Uso: npm run check
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "godly-smoke", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["src/server.js"], env: { ...process.env } }));

let failed = 0;
async function call(name, args, check) {
  const t = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.find((c) => c.type === "text")?.text || "";
  const imgs = r.content.filter((c) => c.type === "image").length;
  let data;
  try {
    data = JSON.parse(text);
  } catch {}
  const problem = r.isError ? text : check(data, imgs);
  console.log(`${problem ? "✗" : "✓"} ${name} ${JSON.stringify(args)} (${Date.now() - t}ms${imgs ? `, ${imgs} imagens` : ""})${problem ? " → " + problem : ""}`);
  if (problem) failed++;
  return data;
}

const tools = (await client.listTools()).tools.map((t) => t.name);
console.log("tools:", tools.join(", "));

await call("godly_status", {}, (d) => (!d.api_ok ? "API fora" : d.index.items < 100 ? "índice pequeno" : null));
const s = await call("godly_search", { query: "dark 3d", limit: 5 }, (d) => (!d.results.length ? "sem resultado" : null));
await call("godly_search", { query: "", feed: "websites", tag: "3d", limit: 3 }, (d) => (!d.results.length ? "sem resultado" : null));
const b = await call("godly_browse", { feed: "websites", sort: "popular", limit: 3 }, (d) => (!d.items.length ? "vazio" : null));
await call("godly_browse", { feed: "x", sort: "staff", limit: 2 }, (d) => (!d.next_cursor ? "sem cursor" : null));
const id = s?.results?.[0]?.page;
await call("godly_get", { target: id }, (d) => (!d.item.palette.length ? "sem paleta" : !d.item.media.length ? "sem mídia" : null));
await call("godly_get", { target: "https://godly.website/website/" + b.items[0].page.split("/i/")[1].split("-").slice(1).join("-") }, (d) =>
  d.item.page !== b.items[0].page ? "slug antigo resolveu errado" : null
);
await call("godly_taxonomy", {}, (d) => (!Object.keys(d.tags).length ? "sem tags" : null));
const vid = (b?.items || []).find((i) => i.video)?.page || id;
// poster_only = só o poster, com aviso
await call("godly_media", { target: vid, poster_only: true, max_media: 1 }, (d, imgs) => (imgs !== 1 ? `esperava 1 poster, veio ${imgs}` : !d.warnings ? "sem aviso" : null));
// padrão = vídeo inteiro: todos os frames analisados e contact sheets até o fim
await call("godly_media", { target: vid, max_media: 1 }, (d) => {
  const w = d.watched?.[0];
  if (!w) return "sem watched";
  if (w.frames_analyzed < w.duration_s * w.fps * 0.95) return `analisou ${w.frames_analyzed} de ~${Math.round(w.duration_s * w.fps)} frames`;
  return null;
});
// regressão: o índigo #19167E do Stripe Press é só a página de um livro no fim do vídeo, não a identidade
await call("godly_get", { target: "uf56li6" }, (d) => (!d.video_warning ? "item em vídeo sem video_warning" : null));
await call("godly_media", { target: "uf56li6" }, (d) => {
  const p = d.watched?.[0]?.palette.find((c) => c.hex === "#19167E");
  return !p ? "não localizou #19167E" : !p.where.startsWith("só num trecho") ? `#19167E devia ser trecho, veio "${p.where}"` : null;
});
// regressões dos bugs achados montando a landing do Porteiro
await call("godly_search", { query: "countdown timer", limit: 5 }, (d) =>
  !d.results.some((r) => /countdown/i.test(r.title)) ? "busca de 2 termos voltou a ser estrita demais" : null
);
await call("godly_search", { query: "", feed: "websites", tag: "scroll-animation", limit: 3 }, (d) =>
  !d.results.length ? "alias scrolling-animation → scroll-animation quebrou" : null
);
await call("godly_search", { query: "portfolio", feed: "websites", limit: 5 }, (d) =>
  d.results.some((r) => r.tags.some((t) => ["react", "vercel", "cloudflare", "google-tag-manager"].includes(t))) ? "tag de stack vazou na lista" : null
);

await client.close();
console.log(failed ? `\n${failed} falha(s)` : "\ntudo ok");
process.exit(failed ? 1 : 0);
