// Cliente da API pública que o próprio site usa (oRPC em api.recent.design/rpc).
// O Godly virou Recent Design: godly.website redireciona pra recent.design.
// Só leitura, sem login. Cache em memória + espaçamento entre chamadas pra não martelar o site.

export const SITE = "https://recent.design";
export const API = process.env.GODLY_API || "https://api.recent.design/rpc";

const UA = process.env.GODLY_UA || "godly-mcp/0.2 (+https://github.com/G4rutti/godly-mcp)";
const TTL = 10 * 60 * 1000;
const MIN_GAP = 250; // ms entre requisições
const cache = new Map();
let last = 0;

export const FEEDS = ["x", "websites", "launch-videos", "og-images", "app-store-screenshots", "app-icons", "tools", "skills"];

export class ApiError extends Error {
  constructor(proc, status, message) {
    super(`api.recent.design ${proc}: ${status ? `HTTP ${status} ` : ""}${message || ""}`.trim());
    this.name = "ApiError";
    this.status = status;
  }
}

async function pace() {
  const wait = last + MIN_GAP - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
}

/** Chama um procedimento oRPC, ex: rpc("items/list", { feed: "x" }). */
export async function rpc(proc, input = {}, { fresh = false } = {}) {
  const key = proc + JSON.stringify(input);
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit.data;

  await pace();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  let res;
  try {
    res = await fetch(`${API}/${proc}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA },
      body: JSON.stringify({ json: input }),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new ApiError(proc, 0, e.name === "AbortError" ? "timeout" : e.message);
  } finally {
    clearTimeout(t);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new ApiError(proc, res.status, "resposta não é JSON (o site pode ter mudado a API)");
  }
  if (!res.ok) throw new ApiError(proc, res.status, body?.json?.message || "");
  cache.set(key, { at: Date.now(), data: body.json });
  return body.json;
}

/** Baixa um arquivo binário (poster/vídeo do CDN). */
export async function getBinary(url, { timeout = 60000, maxBytes = 80 * 1024 * 1024 } = {}) {
  await pace();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (!res.ok) throw new ApiError(url, res.status, "");
    const len = Number(res.headers.get("content-length") || 0);
    if (len > maxBytes) throw new ApiError(url, 0, `arquivo grande demais (${(len / 1e6).toFixed(0)} MB)`);
    return { buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get("content-type") || "" };
  } finally {
    clearTimeout(t);
  }
}
