// Índice local de todos os itens, usado pela busca (a API não tem busca por texto).
// Monta paginando cada feed e guarda em disco; renova depois de GODLY_INDEX_TTL_H horas (padrão 12).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { FEEDS, rpc } from "./api.js";
import { hasTag, score } from "./parse.js";

const FILE = process.env.GODLY_INDEX || join(homedir(), ".godly-mcp", "index.json");
const TTL_H = Number(process.env.GODLY_INDEX_TTL_H || 12);
const PAGE = 100;
const MAX_PAGES = 60; // trava de segurança por feed

let mem = null; // { builtAt, items: [] }
let building = null;

// Tira o que pesa e não serve pra busca/listagem (avatares e ícones com 5 tamanhos cada).
function lean(i) {
  const c = structuredClone(i);
  if (c.source) {
    delete c.source.icon;
    if (c.source.account) delete c.source.account.avatar;
  }
  if (c.creator) delete c.creator.avatar;
  if (c.credit) delete c.credit.image;
  delete c.cover;
  delete c.owners;
  delete c.collaborators;
  delete c.team;
  return c;
}

async function build() {
  const byId = new Map();
  const perFeed = {};
  for (const feed of FEEDS) {
    let cursor;
    let pages = 0;
    perFeed[feed] = 0;
    do {
      const d = await rpc("items/list", { feed, limit: PAGE, ...(cursor ? { cursor } : {}) }, { fresh: true });
      for (const it of d.items || []) {
        if (!byId.has(it.id)) byId.set(it.id, { ...lean(it), feed });
        perFeed[feed]++;
      }
      cursor = d.nextCursor;
      pages++;
    } while (cursor && pages < MAX_PAGES);
  }
  const data = { builtAt: Date.now(), perFeed, items: [...byId.values()] };
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(data));
  return data;
}

const stale = (d) => !d || Date.now() - d.builtAt > TTL_H * 3600e3;

/** Índice pronto (memória → disco → API). `refresh` força reconstruir. */
export async function getIndex({ refresh = false } = {}) {
  if (!refresh && !stale(mem)) return mem;
  if (!refresh && !mem) {
    try {
      const disk = JSON.parse(await readFile(FILE, "utf8"));
      if (!stale(disk)) return (mem = disk);
      mem = disk; // velho, mas serve de fallback se a API falhar
    } catch {}
  }
  building ||= build()
    .then((d) => (mem = d))
    .catch((e) => {
      if (mem) return mem; // usa o velho
      throw e;
    })
    .finally(() => (building = null));
  return building;
}

export function indexInfo() {
  return mem ? { file: FILE, items: mem.items.length, built: new Date(mem.builtAt).toISOString(), per_feed: mem.perFeed } : { file: FILE, items: 0 };
}

/** Busca local. Ordena por quantos termos batem (todos primeiro), depois pelo peso (título > tag > descrição).
 *  Devolve também quantos itens tinham todos os termos, pra quem chama saber se o resto é aproximação. */
export function searchIndex(items, query, { feed, format, category, tag } = {}) {
  const terms = [...new Set(query.toLowerCase().split(/[\s,]+/).filter((t) => t.length > 1))];
  let pool = items;
  if (feed) pool = pool.filter((i) => i.feed === feed);
  if (format) pool = pool.filter((i) => i.format === format);
  if (category) pool = pool.filter((i) => i.category?.slug === category);
  if (tag) pool = pool.filter((i) => hasTag(i, tag));
  if (!terms.length) return { terms, exact: pool.length, hits: pool };

  const ranked = pool
    .map((i) => ({ i, s: score(i, terms) }))
    .filter((x) => x.s.matched > 0)
    // com 3+ termos, quem bate só 1 é ruído
    .filter((x) => terms.length < 3 || x.s.matched >= 2)
    .sort((a, b) => b.s.matched - a.s.matched || b.s.weight - a.s.weight || (b.i.publishedAt || 0) - (a.i.publishedAt || 0));
  return { terms, exact: ranked.filter((x) => x.s.matched === terms.length).length, hits: ranked.map((x) => x.i) };
}
