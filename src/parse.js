// Transforma os itens crus da API em algo enxuto pro modelo ler.
import { SITE } from "./api.js";

export const pageUrl = (i) => `${SITE}/i/${i.id}-${i.slug}`;

/** Aceita URL (recent.design/i/<id>-<slug>), "<id>-<slug>", só o id ou só o slug. */
export function parseTarget(target) {
  const t = String(target).trim();
  const m = t.match(/\/i\/([a-z0-9]{7})(?:-([a-z0-9-]+))?/i) || t.match(/^([a-z0-9]{7})(?:-([a-z0-9-]+))?$/i);
  if (m) return { id: m[1].toLowerCase(), slug: m[2] || null };
  // URL de outro formato (ex: link antigo do godly.website): usa o último pedaço do caminho como slug
  const last = t.split(/[?#]/)[0].replace(/\/+$/, "").split("/").pop();
  return { id: null, slug: last.toLowerCase() };
}

/** Maior rendition até `max` px de largura. */
function pick(renditions, max) {
  const r = (renditions || []).filter((x) => x.width <= max).sort((a, b) => b.width - a.width)[0];
  return r || (renditions || []).sort((a, b) => a.width - b.width)[0] || null;
}

/** Paleta agregada: hex dominantes do primeiro media (com proporção). */
export function palette(item, n = 8) {
  const cols = item.media?.find((m) => m.colours?.length)?.colours || item.cover?.colours || [];
  return cols.slice(0, n).map((c) => ({ hex: c.hex, share: Math.round(c.proportion * 1000) / 10 }));
}

/** Lista de mídias com o essencial: tipo, url original, still (poster/imagem) num tamanho razoável. */
export function mediaList(item, stillMax = 1280) {
  return (item.media || []).map((m) => {
    // "gif" na API é um mp4 em loop: tratamos como vídeo
    const isVideo = m.mediaType === "video" || m.mediaType === "gif" || /\.mp4$/.test(m.url || "");
    const still = isVideo ? pick(m.poster?.renditions || (m.poster ? [m.poster] : []), stillMax) : pick(m.renditions, stillMax);
    return {
      type: isVideo ? (m.mediaType === "gif" ? "gif-loop" : "video") : "image",
      url: m.url,
      width: m.mediaWidth,
      height: m.mediaHeight,
      still: still?.url || (isVideo ? null : m.url),
    };
  });
}

function tagsByContext(tags = []) {
  const out = {};
  for (const t of tags) (out[t.context] ||= []).push(t.slug);
  return out;
}

function creditOf(i) {
  const who = i.creator || i.source?.account;
  if (who) return { name: who.name, handle: who.handle ? "@" + who.handle : null, url: who.url };
  if (i.credit?.name) return { name: i.credit.name, handle: null, url: i.source?.url || null };
  return null;
}

/** Versão curta, pra listas. */
export function slim(i) {
  return {
    id: i.id,
    title: i.title,
    format: i.format,
    category: i.category?.slug || null,
    description: i.description || i.tagline || null,
    tags: (i.tags || []).map((t) => t.slug),
    by: creditOf(i)?.name || null,
    video: (i.media || []).some((m) => m.mediaType === "video" || m.mediaType === "gif"),
    staff_pick: !!i.staffPickAt,
    page: pageUrl(i),
  };
}

/** Versão completa, pra godly_get. */
export function full(i) {
  return {
    id: i.id,
    title: i.title,
    format: i.format,
    category: i.category ? { slug: i.category.slug, name: i.category.name, scope: i.category.scope } : null,
    tagline: i.tagline || undefined,
    description: i.description || null,
    tags: tagsByContext(i.tags),
    credit: creditOf(i),
    source: i.source?.url || null,
    palette: palette(i),
    media: mediaList(i),
    tool: i.tool
      ? { pricing: i.pricingLabel || i.tool.pricingLabel || null, links: (i.tool.links || []).map((l) => ({ label: l.label, url: l.url, kind: l.kind })) }
      : undefined,
    install: i.installCommand || undefined,
    github: i.githubUrl ? { url: i.githubUrl, stars: i.githubStars } : undefined,
    staff_pick: !!i.staffPickAt,
    published: i.publishedAt ? new Date(i.publishedAt).toISOString().slice(0, 10) : null,
    page: pageUrl(i),
  };
}

/** Texto pesquisável de um item. */
export function haystack(i) {
  const who = creditOf(i);
  return [i.title, i.slug, i.tagline, i.description, i.category?.name, i.format, who?.name, who?.handle, ...(i.tags || []).map((t) => t.slug)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Score simples: cada termo que bate soma; título vale mais; tag exata vale mais. */
export function score(i, terms) {
  const hay = haystack(i);
  const title = (i.title || "").toLowerCase();
  const tags = new Set((i.tags || []).map((t) => t.slug));
  let s = 0;
  for (const t of terms) {
    if (!hay.includes(t)) return 0; // todos os termos precisam aparecer
    s += 1;
    if (title.includes(t)) s += 2;
    if (tags.has(t)) s += 2;
  }
  if (i.staffPickAt) s += 0.5;
  return s;
}
