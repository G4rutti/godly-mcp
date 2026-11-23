// Assiste um vídeo de referência INTEIRO antes de qualquer conclusão sobre ele: todos os frames passam pela análise.
//
// Por quê: o poster de um vídeo é só o primeiro frame, e a paleta que o site entrega é a média
// do vídeo todo. Uma cor com 6% pode estar só num trecho de 3 segundos (ex: a página de um livro
// específico no Stripe Press). Sem ver o vídeo inteiro, o modelo pega essa cor achando que é a
// identidade da referência. Aqui o vídeo é baixado, cortado em frames do começo ao fim e cada cor
// da paleta é localizada no tempo: aparece no vídeo todo ou só num trecho?

import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function hasFfmpeg() {
  try {
    await run("ffmpeg", ["-version"]);
    await run("ffprobe", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const hexRgb = (h) => {
  const x = h.replace("#", "");
  const v = x.length === 3 ? x.split("").map((c) => c + c).join("") : x.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
};
const rgbHex = (r, g, b) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();

// Distância perceptual simples ("redmean"): melhor que RGB puro e sem dependência.
function dist([r1, g1, b1], [r2, g2, b2]) {
  const rm = (r1 + r2) / 2;
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}
const NEAR = 60; // ~ "mesma cor" na escala redmean (máx ≈ 765)

/** Resumo em uma frase do que é identidade e do que é trecho. */
export function verdictOf(local, partial) {
  const out = [];
  if (local.length)
    out.push(`Só num trecho do vídeo, NÃO são a identidade da referência: ${local.join(", ")}. Não use como cor "da referência" sem dizer de que trecho veio.`);
  if (partial.length) out.push(`Aparecem em boa parte, mas não sempre: ${partial.join(", ")}. Confira nos frames antes de usar.`);
  return out.length ? out.join(" ") : "Todas as cores da paleta aparecem no vídeo todo.";
}


// ───────────────────────────── vídeo inteiro, frame por frame

/** fps, largura e altura do vídeo. */
export async function probe(file) {
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height,avg_frame_rate:format=duration", "-of", "json", file,
    ]);
    const j = JSON.parse(stdout);
    const s = j.streams?.[0] || {};
    const [a, b] = String(s.avg_frame_rate || "0/1").split("/").map(Number);
    return { width: s.width || 0, height: s.height || 0, fps: b ? a / b : 0, duration: parseFloat(j.format?.duration) || 0 };
  } catch {
    return { width: 0, height: 0, fps: 0, duration: 0 };
  }
}

const SMALL_W = 64;

/**
 * Decodifica TODOS os frames do vídeo (64px de largura, fps nativo) e chama onFrame(buf, t) pra cada um.
 * Nada de amostragem: é o vídeo inteiro.
 */
function eachFrame(file, w, h, fps, onFrame) {
  return new Promise((ok, bad) => {
    const size = w * h * 3;
    const p = spawn("ffmpeg", ["-loglevel", "error", "-i", file, "-vf", `scale=${w}:${h}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
    let pending = Buffer.alloc(0);
    let n = 0;
    let err = "";
    p.stdout.on("data", (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= size) {
        onFrame(pending.subarray(0, size), fps ? n / fps : n);
        pending = pending.subarray(size);
        n++;
      }
    });
    p.stderr.on("data", (d) => (err += d));
    p.on("error", bad);
    p.on("close", (code) => (code === 0 ? ok(n) : bad(new Error(`ffmpeg saiu com ${code}: ${err.slice(0, 300)}`))));
  });
}

/** Diferença média por pixel (0-255) entre dois frames pequenos. */
function diff(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/** Junta tempos em que a cor aparece em trechos contínuos: "0:12–0:17". */
function ranges(times, gap) {
  const out = [];
  for (const t of times) {
    const last = out[out.length - 1];
    if (last && t - last[1] <= gap) last[1] = t;
    else out.push([t, t]);
  }
  return out;
}
const fmtR = ([a, b]) => (fmt(a) === fmt(b) ? fmt(a) : `${fmt(a)}–${fmt(b)}`);

/**
 * Assiste o vídeo INTEIRO:
 *  - passa por todos os frames (cor e mudança de cena calculadas em cada um);
 *  - devolve 1 imagem por cena/estado distinto (máx max_shots; se tiver mais cenas, ficam as mudanças maiores);
 *  - devolve contact sheets (grade 4x4) cobrindo do 1º ao último segundo, sem buraco.
 * palette: [{hex, share}] da API; vazia = tira dos próprios frames.
 */
export async function watchAll(video, dir, prefix, palette = [], { maxShots = 16, maxSheets = 6 } = {}) {
  const info = await probe(video);
  if (!info.width) throw new Error("ffprobe não conseguiu ler o vídeo");
  const h = Math.max(2, Math.round((SMALL_W * info.height) / info.width / 2) * 2);
  const fps = info.fps || 30;

  // paleta-alvo; se o site não deu, acumula histograma do vídeo todo e decide depois
  const bins = new Map();
  let targets = palette.map((p) => ({ ...p, rgb: hexRgb(p.hex), hits: [] }));
  const shareMin = (p) => (p.share ? Math.min(2, Math.max(0.3, p.share * 0.3)) : 1);
  const frames = []; // { t, buf } guardado só se precisar da paleta depois
  const keepAll = !targets.length;

  let prevKey = null;
  const changes = []; // { t, d } mudança em relação ao último estado "fixado"
  let total = 0;
  await eachFrame(video, SMALL_W, h, fps, (buf, t) => {
    total++;
    const px = buf.length / 3;
    if (keepAll) {
      frames.push({ t, buf: Buffer.from(buf) });
      for (let i = 0; i < buf.length; i += 3) {
        const k = ((buf[i] >> 3) << 10) | ((buf[i + 1] >> 3) << 5) | (buf[i + 2] >> 3);
        const b = bins.get(k) || { n: 0, r: 0, g: 0, b: 0 };
        b.n++; b.r += buf[i]; b.g += buf[i + 1]; b.b += buf[i + 2];
        bins.set(k, b);
      }
    } else {
      for (const p of targets) {
        let hit = 0;
        for (let i = 0; i < buf.length; i += 3) if (dist([buf[i], buf[i + 1], buf[i + 2]], p.rgb) <= NEAR) hit++;
        if ((hit / px) * 100 >= shareMin(p)) p.hits.push(t);
      }
    }
    if (!prevKey) {
      prevKey = Buffer.from(buf);
      changes.push({ t, d: Infinity });
    } else {
      const d = diff(buf, prevKey);
      if (d > 14) {
        changes.push({ t, d });
        prevKey = Buffer.from(buf);
      }
    }
  });

  if (keepAll) {
    // paleta do vídeo todo, tons quase iguais juntos
    const merged = [];
    for (const b of [...bins.values()].sort((x, y) => y.n - x.n).slice(0, 200)) {
      const rgb = [Math.round(b.r / b.n), Math.round(b.g / b.n), Math.round(b.b / b.n)];
      const near = merged.find((m) => dist(m.rgb, rgb) <= NEAR);
      if (near) near.n += b.n;
      else merged.push({ rgb, n: b.n });
    }
    const all = frames.length * SMALL_W * h;
    targets = merged
      .sort((a, b) => b.n - a.n)
      .slice(0, 6)
      .map((m) => ({ hex: rgbHex(...m.rgb), share: Math.round((m.n / all) * 1000) / 10, rgb: m.rgb, hits: [] }));
    for (const { t, buf } of frames) {
      const px = buf.length / 3;
      for (const p of targets) {
        let hit = 0;
        for (let i = 0; i < buf.length; i += 3) if (dist([buf[i], buf[i + 1], buf[i + 2]], p.rgb) <= NEAR) hit++;
        if ((hit / px) * 100 >= shareMin(p)) p.hits.push(t);
      }
    }
    frames.length = 0;
  }

  // cenas: se tem mais que maxShots, fica o 1º frame + as mudanças maiores, em ordem de tempo
  // Se tem mais cenas que o limite: divide o vídeo em janelas iguais e pega a maior mudança de cada uma.
  // Assim as cenas mostradas cobrem do começo ao fim (não ficam todas amontoadas num scroll rápido).
  let shots = changes;
  if (shots.length > maxShots) {
    const span = (info.duration || total / fps) / (maxShots - 1);
    const picked = [changes[0]];
    for (let k = 0; k < maxShots - 1; k++) {
      const inWin = changes.slice(1).filter((c) => c.t >= k * span && c.t < (k + 1) * span);
      if (inWin.length) picked.push(inWin.reduce((a, b) => (b.d > a.d ? b : a)));
    }
    shots = picked;
  }
  const shotFiles = [];
  for (const [k, s] of shots.entries()) {
    // um pouco depois da mudança, pra não pegar o frame no meio da transição
    const t = Math.min(s.t + 0.15, Math.max(0, info.duration - 0.1));
    const file = join(dir, `${prefix}-cena${String(k + 1).padStart(2, "0")}.jpg`);
    await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", t.toFixed(2), "-i", video, "-frames:v", "1", "-vf", "scale=720:-2", "-q:v", "4", file]);
    shotFiles.push({ file, t, at: fmt(t), pct: info.duration ? Math.round((t / info.duration) * 100) : null });
  }

  // contact sheets: 16 quadros por folha, intervalo que cobre o vídeo todo dentro de maxSheets folhas
  const step = Math.max(0.5, Math.ceil(((info.duration || 1) / (maxSheets * 16)) * 2) / 2);
  const tiles = Math.ceil((info.duration || 1) / step);
  const sheetsN = Math.ceil(tiles / 16);
  const sheetFiles = [];
  await run("ffmpeg", [
    "-y", "-loglevel", "error", "-i", video,
    "-vf", `fps=1/${step},scale=320:-2,tile=4x4:padding=4:color=white`,
    "-q:v", "4", join(dir, `${prefix}-folha%02d.jpg`),
  ]);
  for (let k = 0; k < sheetsN; k++) {
    const from = k * 16 * step;
    const to = Math.min(info.duration, (k * 16 + 15) * step);
    sheetFiles.push({ file: join(dir, `${prefix}-folha${String(k + 1).padStart(2, "0")}.jpg`), covers: `${fmt(from)}–${fmt(to)}` });
  }

  // cada cor no tempo, medida em TODOS os frames
  const gap = Math.max(0.5, 3 / fps);
  const pal = targets.map((p) => {
    const ratio = p.hits.length / Math.max(1, total);
    const rs = ranges(p.hits, gap);
    const when = rs.slice(0, 6).map(fmtR).join(", ") + (rs.length > 6 ? ` (+${rs.length - 6} trechos)` : "");
    const where = ratio >= 0.6 ? "no vídeo todo" : ratio >= 0.45 ? `em boa parte (${when})` : p.hits.length ? `só num trecho (${when})` : "quase nada no vídeo";
    const use =
      ratio >= 0.6
        ? "é da identidade: pode usar como cor base da referência"
        : ratio >= 0.45
          ? "aparece bastante, mas não sempre: confira nas cenas antes de usar"
          : "NÃO é a identidade da referência: é de um trecho/seção específica. Só use se for exatamente aquele trecho que você quer referenciar";
    return { hex: p.hex, share: p.share, on_screen: `${Math.round(ratio * 100)}% do vídeo (${p.hits.length}/${total} frames)`, where, use };
  });

  return {
    duration: info.duration,
    fps: Math.round(fps * 100) / 100,
    frames_analyzed: total,
    scenes_found: changes.length,
    shots: shotFiles,
    sheets: sheetFiles,
    sheet_step_s: step,
    palette: pal,
  };
}

export const VIDEO_WARNING =
  "Referência em VÍDEO: o poster é só o 1º frame e a paleta é a média do vídeo inteiro. " +
  "Cor com share baixo costuma ser de um trecho só (uma seção, um card, um estado de hover). " +
  "Antes de usar qualquer cor, fonte ou layout daqui, assista o vídeo todo com a tool de mídia (ela passa por todos os frames, mostra cada cena e diz em que trecho cada cor aparece).";
