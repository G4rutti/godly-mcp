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

// Tags que descrevem o design. O resto (framework, hosting, analytics...) é stack e vira ruído nas listas.
export const DESIGN_CONTEXTS = new Set(["color", "style", "interaction", "type"]);

/** Nomes diferentes pra mesma tag entre feeds (o feed de sites usa "scrolling-animation"). */
const TAG_ALIASES = { "scrolling-animation": "scroll-animation", "kinetic-typography": "kinetic-type" };
export const canonTag = (slug) => TAG_ALIASES[slug] || slug;

/** Versão curta, pra listas. */
export function slim(i) {
  const by = creditOf(i)?.name || null;
  return {
    id: i.id,
    title: i.title,
    format: i.format,
    category: i.category?.slug || null,
    description: i.description || i.tagline || null,
    tags: [...new Set((i.tags || []).filter((t) => DESIGN_CONTEXTS.has(t.context)).map((t) => canonTag(t.slug)))],
    by: by && by !== i.title ? by : null,
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

const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/** Palavras pesquisáveis de um item, por campo. Tags entram com e sem hífen ("scroll-animation" → "scroll", "animation"). */
function fields(i) {
  const who = creditOf(i);
  const tags = (i.tags || []).map((t) => canonTag(t.slug));
  const words = (s) => norm(s || "").split(/[^a-z0-9]+/).filter(Boolean);
  return {
    title: words(i.title + " " + (i.slug || "").replace(/-/g, " ")),
    tags: [...tags, ...tags.flatMap((t) => t.split("-"))],
    rest: words([i.tagline, i.description, i.category?.name, i.format, who?.name, who?.handle].join(" ")),
  };
}

/** Termo bate se é o começo de alguma palavra ("anim" casa "animation"; "time" não casa "sometimes").
 *  Plural simples também conta ("timers" casa "timer"). */
function hit(words, t) {
  const base = t.length > 4 && t.endsWith("s") ? t.slice(0, -1) : t;
  return words.some((w) => w.startsWith(base) || (w.length > 3 && base.startsWith(w) && base.length - w.length <= 2));
}

/** Pontuação de um item para os termos: quantos termos batem decide primeiro; título e tag pesam mais. */
export function score(i, terms) {
  const f = fields(i);
  let matched = 0;
  let weight = 0;
  for (const raw of terms) {
    const t = norm(raw);
    const inTitle = hit(f.title, t);
    const inTag = f.tags.includes(canonTag(t)) || hit(f.tags, t);
    const inRest = hit(f.rest, t);
    if (!inTitle && !inTag && !inRest) continue;
    matched++;
    weight += (inTitle ? 3 : 0) + (inTag ? 2 : 0) + (inRest ? 1 : 0);
  }
  if (!matched) return { matched: 0, weight: 0 };
  return { matched, weight: weight + (i.staffPickAt ? 0.5 : 0) };
}

/** Item tem a tag (já normalizada)? */
export const hasTag = (i, tag) => (i.tags || []).some((t) => canonTag(t.slug) === canonTag(tag));
