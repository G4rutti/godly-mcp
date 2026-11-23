#!/usr/bin/env node
// godly-mcp — servidor MCP (stdio) para o Godly, que hoje vive em recent.design.
// Usa a mesma API pública e de leitura que o site usa (api.recent.design/rpc). Nada de login, salvos ou conta.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { API, FEEDS, SITE, getBinary, rpc } from "./api.js";
import { getIndex, indexInfo, searchIndex } from "./indexer.js";
import { canonTag, full, mediaList, pageUrl, palette, parseTarget, slim } from "./parse.js";
import { VIDEO_WARNING, hasFfmpeg, verdictOf, watchAll } from "./video.js";

const MEDIA_DIR = process.env.GODLY_MEDIA_DIR || join(homedir(), "godly-media");
const VERSION = "0.3.0";

const ATTRIBUTION =
  "Ao usar: credite o criador (campo credit) com link pro post/site original e cite a página no Recent Design (antigo Godly). " +
  "O site libera uso como referência; não use pra treinar modelo nem copie o trabalho 1:1.";

const ok = (data, extra = []) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }, ...extra] });
const fail = (msg) => ({ content: [{ type: "text", text: msg }], isError: true });

const FEED = z.enum(FEEDS);
const FEED_HELP =
  "x = posts de design garimpados do X (interface, motion, branding, web...), websites = sites gravados em vídeo (o Godly clássico), " +
  "launch-videos, og-images, app-store-screenshots, app-icons, tools, skills.";

/** Resolve um alvo (URL, id, id-slug ou slug) para o item cru da API. */
async function resolveItem(target) {
  const { id, slug } = parseTarget(target);
  if (id) return rpc("items/byId", { id });
  const idx = await getIndex();
  const hit =
    idx.items.find((i) => i.slug === slug) ||
    (slug.length >= 5 ? idx.items.find((i) => i.slug?.startsWith(slug) || slug.startsWith(i.slug || "\0")) : null);
  if (!hit) throw new Error(`Não achei "${target}". Passe a URL recent.design/i/<id>-<slug> ou use godly_search.`);
  return rpc("items/byId", { id: hit.id });
}

const server = new McpServer({ name: "godly", version: VERSION });

// ───────────────────────────── search
server.registerTool(
  "godly_search",
  {
    title: "Buscar no Godly / Recent Design",
    description:
      "Busca referências de design no Godly (hoje Recent Design): interfaces, microinterações, motion, sites com animação forte, branding, OG images, ícones e telas de app. " +
      "Casa com título, descrição, criador e tags (ex: 'dark', '3d', 'scroll-animation', 'microinteraction', 'saas', 'portfolio'). " +
      "Termos em inglês funcionam melhor. Primeira chamada monta um índice local (uns segundos); depois é instantâneo.",
    inputSchema: {
      query: z.string().describe("Termos de busca, ex: 'dark portfolio 3d', 'onboarding microinteraction', 'pricing'. Vazio = só filtros."),
      feed: FEED.optional().describe(FEED_HELP),
      category: z.string().optional().describe("Slug de categoria (veja godly_taxonomy), ex: 'interface', 'motion', 'saas', 'portfolio'"),
      tag: z.string().optional().describe("Slug de tag exata, ex: 'dark', '3d', 'scroll-animation'"),
      video_only: z.boolean().default(false).describe("Só itens com vídeo (bom pra motion)"),
      limit: z.number().int().min(1).max(50).default(12),
    },
  },
  async ({ query, feed, category, tag, video_only, limit }) => {
    try {
      const idx = await getIndex();
      let { terms, exact, hits } = searchIndex(idx.items, query || "", { feed, category, tag });
      if (video_only) hits = hits.filter((i) => (i.media || []).some((m) => m.mediaType === "video" || m.mediaType === "gif"));
      return ok({
        query,
        total: hits.length,
        with_all_terms: terms.length > 1 ? exact : undefined,
        note: terms.length > 1 && exact < hits.length ? `Os ${Math.min(exact, limit)} primeiros têm todos os termos; depois vêm os que batem só parte.` : undefined,
        results: hits.slice(0, limit).map(slim),
        next: "godly_get num id pra paleta, créditos e mídia; godly_media pra ver.",
        attribution: ATTRIBUTION,
      });
    } catch (e) {
      return fail(`Falhou: ${e.message}`);
    }
  }
);

// ───────────────────────────── browse
server.registerTool(
  "godly_browse",
  {
    title: "Navegar um feed",
    description:
      "Lista ao vivo um feed do Godly/Recent Design na ordem do site (recentes, populares ou staff picks), com filtro de categoria/tag e paginação. " +
      FEED_HELP,
    inputSchema: {
      feed: FEED.default("x"),
      sort: z.enum(["recent", "popular", "staff"]).default("recent").describe("staff = staff picks"),
      category: z.string().optional().describe("Slug de categoria (godly_taxonomy)"),
      tag: z.string().optional().describe("Slug de tag, ex: '3d', 'dark', 'transitions'"),
      cursor: z.string().optional().describe("next_cursor da página anterior"),
      limit: z.number().int().min(1).max(50).default(20),
    },
  },
  async ({ feed, sort, category, tag, cursor, limit }) => {
    try {
      const input = {
        feed,
        sort: sort === "popular" ? "popular" : "recent",
        ...(sort === "staff" ? { staffPick: true } : {}),
        ...(category ? { category } : {}),
        ...(tag ? { tag } : {}),
        ...(cursor ? { cursor } : {}),
        limit,
      };
      const d = await rpc("items/list", input);
      return ok({ feed, sort, category: category || null, tag: tag || null, items: (d.items || []).map(slim), next_cursor: d.nextCursor || null });
    } catch (e) {
      return fail(`Falhou: ${e.message}`);
    }
  }
);

// ───────────────────────────── get
server.registerTool(
  "godly_get",
  {
    title: "Detalhes de um item",
    description:
      "Detalhes completos de um item: descrição, criador e link do post/site original, tags por tipo (cor, estilo, interação, framework...), " +
      "PALETA extraída (hex + % da tela), lista de mídias (vídeo/imagem) e, em tools/skills, preço, links e comando de instalação. " +
      "Aceita URL recent.design/i/..., URL antiga do godly, id (7 letras) ou slug.",
    inputSchema: { target: z.string().min(1) },
  },
  async ({ target }) => {
    try {
      const item = full(await resolveItem(target));
      const video = item.media.some((m) => m.type !== "image");
      return ok({
        item,
        video_warning: video ? VIDEO_WARNING + " Aqui: godly_media com este id." : undefined,
        attribution: ATTRIBUTION,
      });
    } catch (e) {
      return fail(`Falhou: ${e.message}`);
    }
  }
);

// ───────────────────────────── taxonomy
server.registerTool(
  "godly_taxonomy",
  {
    title: "Categorias e tags",
    description:
      "Lista as categorias (com quantos posts) e as tags existentes agrupadas por tipo (color, style, interaction, type, framework, component...), " +
      "pra usar como filtro em godly_search e godly_browse.",
    inputSchema: { feed: FEED.optional().describe("Restringe as tags às do feed") },
  },
  async ({ feed }) => {
    try {
      const cats = await rpc("categories/list", {});
      const idx = await getIndex();
      const tags = {};
      for (const it of idx.items) {
        if (feed && it.feed !== feed) continue;
        for (const t of it.tags || []) {
          tags[t.context] ||= {};
          { const s = canonTag(t.slug); tags[t.context][s] = (tags[t.context][s] || 0) + 1; }
        }
      }
      const tagList = Object.fromEntries(
        Object.entries(tags).map(([ctx, m]) => [ctx, Object.entries(m).sort((a, b) => b[1] - a[1]).map(([slug, n]) => `${slug} (${n})`)])
      );
      const byScope = {};
      for (const c of cats) (byScope[c.scope] ||= []).push(`${c.slug}${c.postCount != null ? ` (${c.postCount})` : ""}`);
      return ok({
        categories_by_scope: byScope,
        scope_hint: "design → feed x e launch-videos; web → websites e og-images; domain → telas/ícones de app; tool → tools; skill → skills",
        tags: tagList,
      });
    } catch (e) {
      return fail(`Falhou: ${e.message}`);
    }
  }
);

// ───────────────────────────── media
const mimeOf = (url, type) => (type && type.startsWith("image/") ? type.split(";")[0] : url.endsWith(".png") ? "image/png" : url.endsWith(".jpg") || url.endsWith(".jpeg") ? "image/jpeg" : "image/webp");

server.registerTool(
  "godly_media",
  {
    title: "Ver a referência",
    description:
      "Mostra a referência pro modelo. Imagem: devolve a imagem. VÍDEO: assiste o vídeo INTEIRO — baixa completo, passa por todos os frames, " +
      "devolve uma imagem por cena/estado diferente + contact sheets cobrindo do 1º ao último segundo, e mede em todos os frames onde cada cor da paleta " +
      "aparece (no vídeo todo ou só num trecho), pra não confundir a cor de uma seção com a identidade da referência. " +
      "poster_only=true mostra só o poster (1º frame: NÃO use pra tirar conclusão de cor/layout). Precisa de ffmpeg. " +
      "Por padrão nada fica no disco; save=true guarda em ~/godly-media/<id>.",
    inputSchema: {
      target: z.string().min(1).describe("URL, id ou slug do item"),
      max_scenes: z.number().int().min(1).max(24).default(16).describe("Máximo de cenas mostradas por vídeo (as contact sheets cobrem o resto)"),
      poster_only: z.boolean().default(false).describe("Só o poster do vídeo, sem assistir (não use pra decidir cor/layout)"),
      max_media: z.number().int().min(1).max(6).default(3).describe("Quantas mídias do item olhar"),
      save: z.boolean().default(false).describe("Guardar stills, vídeos e frames no disco"),
      dir: z.string().optional().describe("Pasta pra salvar (padrão ~/godly-media)"),
    },
  },
  async ({ target, max_scenes, poster_only, max_media, save, dir }) => {
    let workDir;
    try {
      const item = await resolveItem(target);
      const media = mediaList(item).slice(0, max_media);
      if (!media.length) return fail("Esse item não tem mídia.");
      const hasVideo = media.some((m) => m.type !== "image");

      workDir = save ? resolve(dir || MEDIA_DIR, `${item.id}-${item.slug}`) : await mkdtemp(join(tmpdir(), "godly-"));
      await mkdir(workDir, { recursive: true });

      const images = [];
      const saved = [];
      const watched = [];
      const warnings = [];
      const wantFrames = !poster_only;
      const canCut = hasVideo && wantFrames && (await hasFfmpeg());
      if (hasVideo && wantFrames && !canCut)
        warnings.push(
          "ffmpeg/ffprobe não encontrado: NÃO deu pra assistir o vídeo, só o poster (1º frame). Não tire cor nem layout disso. " +
            "Instale (winget install ffmpeg / brew install ffmpeg) e chame de novo."
        );
      if (hasVideo && poster_only) warnings.push("poster_only: você viu só o poster (1º frame) do vídeo. A paleta do item cobre o vídeo inteiro; não use ela sem assistir.");

      for (const [n, m] of media.entries()) {
        const isVideo = m.type !== "image";
        // com frames, o still do vídeo é praticamente o 1º frame: pula pra não gastar imagem
        if (m.still && !(canCut && isVideo)) {
          const { buf, type } = await getBinary(m.still);
          images.push({ type: "image", data: buf.toString("base64"), mimeType: mimeOf(m.still, type) });
          if (save) {
            const f = join(workDir, `m${n + 1}-still.${m.still.split(".").pop()}`);
            await writeFile(f, buf);
            saved.push(f);
          }
        }
        if (isVideo && (canCut || save)) {
          // vídeo inteiro: espera o download completo (gravações de site passam fácil de 50 MB)
          const { buf } = await getBinary(m.url, { timeout: 300000, maxBytes: 400 * 1024 * 1024 });
          const vf = join(workDir, `m${n + 1}.mp4`);
          await writeFile(vf, buf);
          if (save) saved.push(vf);
          if (canCut) {
            const w = await watchAll(vf, workDir, `m${n + 1}`, palette(item), { maxShots: max_scenes });
            for (const f of [...w.shots, ...w.sheets]) {
              images.push({ type: "image", data: (await readFile(f.file)).toString("base64"), mimeType: "image/jpeg" });
              if (save) saved.push(f.file);
            }
            watched.push({
              media: n + 1,
              url: m.url,
              duration_s: Math.round(w.duration * 10) / 10,
              fps: w.fps,
              frames_analyzed: w.frames_analyzed,
              scenes_found: w.scenes_found,
              scenes_shown: w.shots.map((s) => s.at),
              contact_sheets: w.sheets.map((s) => `${s.covers} (1 quadro a cada ${w.sheet_step_s}s)`),
              palette: w.palette,
            });
          }
        }
      }

      const local = [...new Set(watched.flatMap((w) => w.palette.filter((p) => !p.where.startsWith("no vídeo todo") && !p.where.startsWith("em boa")).map((p) => p.hex)))];
      const partial = [...new Set(watched.flatMap((w) => w.palette.filter((p) => p.where.startsWith("em boa")).map((p) => p.hex)))];
      return ok(
        {
          item: item.title,
          page: pageUrl(item),
          credit: full(item).credit,
          shown: images.length,
          order: canCut
            ? "stills das mídias estáticas primeiro; depois, por vídeo: uma imagem por cena (tempos em watched[].scenes_shown) e as contact sheets do vídeo inteiro (watched[].contact_sheets)"
            : "um still por mídia",
          media: media.map((m) => ({ type: m.type, url: m.url, size: `${m.width}x${m.height}` })),
          watched: watched.length ? watched : undefined,
          verdict: watched.length ? verdictOf(local, partial) : undefined,
          warnings: warnings.length ? warnings : undefined,
          saved_to: save ? workDir : undefined,
          files: save ? saved : undefined,
          attribution: ATTRIBUTION,
        },
        images
      );
    } catch (e) {
      return fail(`Falhou: ${e.message}`);
    } finally {
      if (workDir && !save) await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
);

// ───────────────────────────── status
server.registerTool(
  "godly_status",
  {
    title: "Status",
    description: "Checa se a API do Recent Design responde, o estado do índice local e se o ffmpeg está instalado. refresh=true reconstrói o índice.",
    inputSchema: { refresh: z.boolean().default(false) },
  },
  async ({ refresh }) => {
    const out = { version: VERSION, site: SITE, api: API };
    try {
      const t = Date.now();
      await rpc("items/list", { feed: "x", limit: 1 }, { fresh: true });
      out.api_ok = true;
      out.api_ms = Date.now() - t;
    } catch (e) {
      out.api_ok = false;
      out.api_error = e.message;
    }
    try {
      if (refresh) await getIndex({ refresh: true });
      else await getIndex();
    } catch (e) {
      out.index_error = e.message;
    }
    out.index = indexInfo();
    out.ffmpeg = await hasFfmpeg();
    return ok(out);
  }
);

await server.connect(new StdioServerTransport());
