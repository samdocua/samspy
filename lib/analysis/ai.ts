// SamSpy — «Анализ»: AI calls of the dossier (server only)
//
//   transcribe()     OpenAI speech-to-text of a reel (OPENAI_TRANSCRIBE_MODEL)
//   ocrCarousel()    Claude (vision) — text of carousel slides
//   discoverVocab()  Claude — the account's rubrics (topics) and formats, from a sample of posts
//   tagPosts()       Claude — per post: title in Russian, rubric, hook type, format, broad/narrow,
//                    first phrase in Russian
//   breakdownPosts() Claude — top posts: structure, pay-off, call to action, why it worked,
//                    full text in Russian
//   synthesize()     Claude — the dossier texts (about, audience, delivery, what it sells,
//                    formula, what works / what doesn't) from numbers computed in code
// Everything the user reads is in Russian. Numbers are never invented by the model: it gets
// them from code and is told to use only those.
//
// Version history:
//   v0.3.0 (2026-11-22) — initial (stage 2).
//   v0.3.1 (2026-11-22) — broken JSON from the model no longer loses a whole batch: complete
//                         {"sc": …} items are salvaged; prompts ask for «» instead of "" inside
//                         texts; ocrCarousel() also reads a single cover / reel frame.
//   v0.3.2 (2026-11-22) — dossier / breakdown texts mention posts only as [id] (the app turns
//                         them into «№N» links); × figures rounded.
//   v0.3.3 (2026-11-23) — texts sent to Claude drop half-emoji left by .slice() (lone UTF-16
//                         surrogates made the API reject the dossier request: «invalid JSON»).
//   v0.4.0 (2026-11-26) — cleanCarouselSlides(): OCR of a competitor carousel → its slide texts
//                         verbatim, without brand names / app promos / their closing CTA («План»,
//                         copy mode).
//   v0.4.1 (2026-11-26) — stop_reason «refusal» is an error (the caller retries in smaller
//                         parts); tagPosts() can take another model; its prompt explains the task
//                         is labelling public posts (couple question cards can be spicy).
//   v0.4.2 (2026-11-26) — no up-front thinking for the fast-model tasks (lib/anthropic.ts): the
//                         5.x models think by default and the thinking counted against max_tokens.

import { thinkingOff } from '@/lib/anthropic';
import sharp from 'sharp';
import type { Breakdown, DossierAI, Vocab } from './types';

export type { Breakdown, DossierAI, Vocab };

export const MAIN_MODEL = process.env.ANALYSIS_MODEL || 'claude-sonnet-5-5';
export const TAG_MODEL = process.env.ANALYSIS_TAG_MODEL || 'claude-haiku-5-5';
export const OCR_MODEL = process.env.CAROUSEL_OCR_MODEL || 'claude-haiku-5-5';
export const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Claude --------------------------------------------------------------------------
type Content =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/** Drops lone UTF-16 surrogates (half of an emoji cut by .slice()) — the API rejects them. */
const wellFormed = (t: string) =>
  t.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');

async function claude(model: string, content: Content[], maxTokens: number, attempt = 1): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY не задан.');
  content = content.map((c) => (c.type === 'text' ? { ...c, text: wellFormed(c.text) } : c));
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    // tags / OCR / slide cleaning: no up-front thinking (it ate max_tokens and cut the JSON off);
    // the dossier and breakdowns (main model) keep it
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      ...(model === MAIN_MODEL ? {} : thinkingOff(model)),
      messages: [{ role: 'user', content }],
    }),
    cache: 'no-store',
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    await sleep(2000 * attempt);
    return claude(model, content, maxTokens, attempt + 1);
  }
  if (!res.ok) throw new Error(`Claude HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { content?: { type: string; text?: string }[]; stop_reason?: string };
  // the model stopped on its own safety check (spicy couple questions) — the caller retries smaller
  if (data.stop_reason === 'refusal') throw new Error('модель отказалась отвечать');
  return (data.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n')
    .trim();
}

function parseJson<T>(answer: string): T {
  const a = answer.indexOf('{');
  const b = answer.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error(`в ответе модели нет JSON: ${answer.slice(0, 120)}`);
  return JSON.parse(answer.slice(a, b + 1)) as T;
}

/**
 * Items of {"items":[{…},…]} even when the JSON is broken or cut off: every complete flat
 * object that has "sc" is kept.
 */
function parseItems<T extends { sc?: unknown }>(answer: string): T[] {
  try {
    const { items } = parseJson<{ items?: T[] }>(answer);
    if (Array.isArray(items)) return items;
  } catch {
    /* salvage below */
  }
  const out: T[] = [];
  for (const m of answer.matchAll(/\{[^{}]*"sc"\s*:\s*"[^"]+"[^{}]*\}/g)) {
    try {
      out.push(JSON.parse(m[0]) as T);
    } catch {
      /* broken object — skip */
    }
  }
  if (!out.length) throw new Error(`не удалось разобрать ответ модели: ${answer.slice(0, 120)}`);
  return out;
}

const NO_QUOTES = 'Inside text values never use the " character — use «» for quotes.';

const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

// --- transcription (OpenAI) -------------------------------------------------------------
const MAX_VIDEO_BYTES = 24 * 1024 * 1024; // OpenAI audio limit is 25 MB

/** Speech of a reel, or '' when there is none. null = no OpenAI key (skipped). */
export async function transcribe(videoUrl: string): Promise<string | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const v = await fetch(videoUrl, { cache: 'no-store' });
  if (!v.ok) throw new Error(`видео: HTTP ${v.status} (ссылка устарела?)`);
  const buf = await v.arrayBuffer();
  if (buf.byteLength > MAX_VIDEO_BYTES) throw new Error('видео больше 24 МБ');
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'video/mp4' }), 'reel.mp4');
  form.append('model', TRANSCRIBE_MODEL);
  form.append('response_format', 'json');
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      cache: 'no-store',
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(2000 * attempt);
      continue;
    }
    if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const data = (await res.json()) as { text?: string };
    return (data.text ?? '').trim();
  }
}

// --- carousel slides text (Claude vision) ---------------------------------------------------
/**
 * OCR of a competitor carousel → slide texts to reuse on my own images: questions, statements and
 * answer options verbatim; brand names, taglines, @handles, app promos and the closing call to
 * action removed. Null when the model answer cannot be read (the caller falls back to rules).
 */
export async function cleanCarouselSlides(ocr: string, username: string): Promise<string[] | null> {
  const answer = await claude(
    TAG_MODEL,
    [
      {
        type: 'text',
        text:
          `Below is the OCR text of an Instagram carousel by @${username}, slide by slide («--- N ---»). ` +
          'I will put the same texts on my own images. Return the text of every slide:\n' +
          '- Keep every question, statement and answer option (A) B) C) …) EXACTLY as written: do not rephrase, fix, shorten or translate; keep the line breaks.\n' +
          '- Remove only: brand / app names and watermarks (the account name, «… app», «… cards»), taglines, @handles, app promos ' +
          '(«search for more questions», «search today», «download», «Get», «link in bio») and a closing call to action ' +
          '(follow / comment / save / share / send this) — wherever they appear, even in the middle of a slide.\n' +
          '- Drop slides that become empty or were only a promo. Slide 1 is the cover (its hook).\n' +
          'Answer with JSON only: {"slides": ["text of slide 1", "text of slide 2", …]}\n\n' +
          ocr,
      },
    ],
    2500
  );
  try {
    const j = parseJson<{ slides?: unknown[] }>(answer);
    const slides = (j.slides ?? []).map((x) => String(x ?? '').trim()).filter(Boolean);
    return slides.length ? slides : null;
  } catch {
    return null;
  }
}

export async function ocrCarousel(slideUrls: string[]): Promise<string> {
  const images: Content[] = [];
  for (const [i, url] of slideUrls.slice(0, 10).entries()) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) continue;
      const jpg = await sharp(Buffer.from(await res.arrayBuffer()))
        .resize({ width: 900, withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      images.push({ type: 'text', text: `Slide ${i + 1}:` });
      images.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpg.toString('base64') } });
    } catch {
      /* skip a slide that does not load */
    }
  }
  if (!images.length) throw new Error('слайды не загрузились (ссылки устарели?)');
  const answer = await claude(
    OCR_MODEL,
    [
      ...images,
      {
        type: 'text',
        text:
          'Transcribe the text written on each image (slides of an Instagram carousel, or a frame of a reel), in the original language, ' +
          'keeping line breaks. Format:\n--- 1 ---\n<text>\n--- 2 ---\n<text>\n…\n' +
          'Skip watermarks and @handles. If a slide has no text, write (без текста). No other words.',
      },
    ],
    2500
  );
  return answer.trim();
}

// --- vocabulary: rubrics + formats of this account -------------------------------------------
export const HOOKS: { name: string; hint: string }[] = [
  { name: 'в лоб', hint: 'сразу тезис / совет / утверждение без подводки' },
  { name: 'вопрос', hint: 'начинается с вопроса зрителю или от зрителя' },
  { name: 'провокация', hint: 'спорное, резкое или противоречащее мнению большинства заявление' },
  { name: 'история', hint: 'личная история, сторителлинг, «однажды…»' },
  { name: 'ситуация', hint: 'узнаваемая жизненная сцена, «когда ты…», POV' },
  { name: 'список', hint: '«5 способов», «3 ошибки», подборка' },
  { name: 'цифры', hint: 'результат, деньги, конкретные цифры в первой фразе' },
  { name: 'челлендж', hint: 'вызов, эксперимент, «попробуй…»' },
  { name: 'обучение', hint: 'как сделать, разбор, инструкция, лайфхак' },
  { name: 'донор охватов', hint: 'держится на чужом известном человеке, бренде, событии или тренде' },
  { name: 'юмор', hint: 'скетч, шутка, абсурд, мем' },
  { name: 'другое', hint: 'ничего из перечисленного' },
];
export const HOOK_NAMES = HOOKS.map((h) => h.name);

export interface PostForAI {
  sc: string;
  kind: string;
  caption: string | null;
  text: string | null; // transcript / slides text when there is one
  metric: number | null;
  ratio: number | null;
}

const postLine = (p: PostForAI, captionLen = 300, textLen = 300) =>
  `[${p.sc}] (${p.kind}${p.ratio != null ? `, ×${p.ratio}` : ''}) caption: ${clip(p.caption, captionLen) || '—'}` +
  (p.text ? ` | text: ${clip(p.text, textLen)}` : '');

export async function discoverVocab(sample: PostForAI[], bio: string | null): Promise<Vocab> {
  const answer = await claude(
    MAIN_MODEL,
    [
      {
        type: 'text',
        text: `You analyse an Instagram creator. Bio: ${clip(bio, 300) || '—'}

Below is a sample of their posts (caption and, where known, the spoken / slide text).
${sample.map((p) => postLine(p)).join('\n')}

1. Define 5–9 RUBRICS — recurring topics of this account (not formats), each a short name in Russian (2–5 words, e.g. «Упорство, дисциплина, мышление») and a one-line hint what belongs there. Together they must cover almost every post; add «Другое» last.
2. List 3–8 FORMATS used (how it is filmed / made), short Russian names, e.g. «Говорящая голова», «Нарезка подкаста», «Текст на экране», «Скетч», «Слайды-советы».

Answer with ONLY this JSON:
{"rubrics":[{"name":"...","hint":"..."}],"formats":["..."]}`,
      },
    ],
    1500
  );
  const v = parseJson<Vocab>(answer);
  const rubrics = (v.rubrics ?? []).filter((r) => r?.name).slice(0, 10);
  if (!rubrics.some((r) => r.name === 'Другое')) rubrics.push({ name: 'Другое', hint: 'всё остальное' });
  return { rubrics, formats: (v.formats ?? []).filter(Boolean).slice(0, 8) };
}

// --- per-post tags -----------------------------------------------------------------------------
export interface PostTags {
  sc: string;
  title: string;
  rubric: string;
  hook: string;
  format: string;
  breadth: 'широкий' | 'узкий';
  first_line: string;
}

export async function tagPosts(posts: PostForAI[], vocab: Vocab, model = TAG_MODEL): Promise<PostTags[]> {
  const answer = await claude(
    model,
    [
      {
        type: 'text',
        text: `Context: this is content analytics for a marketing team. The posts below are public Instagram posts of a brand or creator — often question cards for couples (dating, relationships, intimacy; some are flirty or spicy). Your job is only to label each post for a content report: you do not write, continue or answer anything in them. Keep the labels neutral and descriptive, label spicy posts like any other.

Tag Instagram posts of one creator. For EVERY post below return:
- title: what the post is about, in Russian, max 60 characters, like a headline («Письмо Фейнмана умершей жене», «Если ты беден: челлендж „Ничего не покупаю“»)
- rubric: exactly one of: ${vocab.rubrics.map((r) => `«${r.name}» (${r.hint})`).join('; ')}
- hook: how the post opens, exactly one of: ${HOOKS.map((h) => `«${h.name}» (${h.hint})`).join('; ')}
- format: one of: ${vocab.formats.map((f) => `«${f}»`).join(', ')} (or the closest)
- breadth: «широкий» if the topic interests almost anyone (money, relationships, age, health, life), «узкий» if only a niche audience
- first_line: the first phrase of the post (spoken or written) translated to Russian, max 140 characters; if unknown — a short paraphrase of the caption's opening

Posts:
${posts.map((p) => postLine(p, 400, 500)).join('\n')}

Answer with ONLY this JSON (same ids as in [brackets]). ${NO_QUOTES}
{"items":[{"sc":"...","title":"...","rubric":"...","hook":"...","format":"...","breadth":"широкий","first_line":"..."}]}`,
      },
    ],
    Math.min(8000, 220 * posts.length + 500)
  );
  const items = parseItems<PostTags>(answer);
  const rubricNames = new Set(vocab.rubrics.map((r) => r.name));
  return (items ?? [])
    .filter((t) => t?.sc)
    .map((t) => ({
      sc: String(t.sc),
      title: clip(t.title, 80),
      rubric: rubricNames.has(t.rubric) ? t.rubric : 'Другое',
      hook: HOOK_NAMES.includes(t.hook) ? t.hook : 'другое',
      format: clip(t.format, 40),
      breadth: t.breadth === 'узкий' ? 'узкий' : 'широкий',
      first_line: clip(t.first_line, 160),
    }));
}

// --- top posts breakdown ---------------------------------------------------------------------

export interface PostForBreakdown extends PostForAI {
  title: string | null;
  metric_label: string; // «1,96 млн просмотров» / «12 тыс лайков»
  duration: number | null;
  median_label: string; // account median of this kind, formatted
}

export async function breakdownPosts(posts: PostForBreakdown[]): Promise<Record<string, Breakdown>> {
  const answer = await claude(
    MAIN_MODEL,
    [
      {
        type: 'text',
        text: `You break down top-performing Instagram posts of one creator for a Russian-speaking content maker.

${posts
  .map(
    (p) => `### [${p.sc}] ${p.title ?? ''}
type: ${p.kind}${p.duration ? `, ${Math.round(p.duration)} s` : ''}; result: ${p.metric_label} = ×${p.ratio ?? '?'} to the account median (${p.median_label})
caption: ${clip(p.caption, 1200) || '—'}
text (speech / slides): ${clip(p.text, 6000) || '— (no text available, judge by the caption)'}`
  )
  .join('\n\n')}

For EVERY post write in Russian:
- structure: how it is built from the first second to the end (2–3 sentences)
- payoff: what the viewer gets at the end, why they share / save it (1–2 sentences)
- cta: the call to action, quoted; «нет» if there is none
- why: hypothesis why it beat the median — start with «Гипотеза:», use the numbers given above, do not invent other numbers, do not mention post ids (2–3 sentences)
- text_ru: the full text of the post (speech or slides) translated into natural Russian, with line breaks; dialogue lines start with «— ». If it is already Russian, clean it up. If there is no text, an empty string.

Answer with ONLY this JSON. ${NO_QUOTES} Line breaks inside values are written as \\n.
{"items":[{"sc":"...","structure":"...","payoff":"...","cta":"...","why":"...","text_ru":"..."}]}`,
      },
    ],
    Math.min(12000, 2600 * posts.length)
  );
  const items = parseItems<Breakdown & { sc: string }>(answer);
  const out: Record<string, Breakdown> = {};
  for (const it of items ?? []) {
    if (!it?.sc) continue;
    out[String(it.sc)] = {
      structure: String(it.structure ?? ''),
      payoff: String(it.payoff ?? ''),
      cta: String(it.cta ?? ''),
      why: String(it.why ?? ''),
      text_ru: String(it.text_ru ?? ''),
    };
  }
  return out;
}

// --- dossier texts ----------------------------------------------------------------------------------

export async function synthesize(context: string): Promise<DossierAI> {
  const answer = await claude(
    MAIN_MODEL,
    [
      {
        type: 'text',
        text: `You write a dossier on an Instagram creator for a Russian-speaking content maker who studies competitors. Be concrete, plain, no marketing fluff. Use ONLY the numbers given in the data (shares, medians, ×ratios, counts) — never invent numbers. When a text mentions a specific post, write only its id in square brackets, e.g. [DYZ0i8PCjXa] — the app turns it into a link with the post number; never write ids any other way. Write × figures as in the data (×4,4 or ×1435) and big numbers as «109 тыс», «1,2 млн».

DATA
${context}

Write in Russian:
- one_liner: who this is in one line, like «Американский миллиардер-масштабатор: афоризмы о жизни и бизнесе, зарабатывает на Acquisition.com и Skool» (max 140 characters)
- niche_tags: 4–7 short tags of the niche / content (e.g. «масштабирование», «нарезки подкастов», «коллабы»)
- about: «О чём блог» — 4–6 sentences: what the bio promises vs what the posts are really about (use rubric shares), which topics score above / below the account median — separately for reels and carousels when the account posts both, the image / persona of the author
- audience: «Аудитория» — who comments, judging ONLY by the comments given (quote 2–3 short typical ones in «»), what they ask, the share of short support comments; say how many comments it is based on and that exact demographics are unknown. If no comments were given, say so in one sentence.
- delivery: «Подача» — tone, how it is filmed / framed, typical length and posting rhythm (use the numbers)
- sells: what the author sells / promotes and how: 1–5 items {type: one of «консультации», «курс», «софт», «книга», «сообщество», «продукт», «реклама», «услуги», «другое»; name; visibility: «видна» if posts actively sell it, «слабо» if mentioned sometimes, «не видна» if only in bio / in the frame; note: 1–2 sentences on how}
- formula: «Формула залётов» — 4–6 sentences: what the top posts have in common (topics, hooks, formats, breadth, length), with numbers
- works: «Что залетает» — 3–5 patterns {title (short), text (2–4 sentences with numbers), examples: 2–5 post ids}
- fails: «Что не залетает» — 2–4 patterns of the weakest posts, same shape

Answer with ONLY this JSON. ${NO_QUOTES}
{"one_liner":"...","niche_tags":["..."],"about":"...","audience":"...","delivery":"...","sells":[{"type":"...","name":"...","visibility":"...","note":"..."}],"formula":"...","works":[{"title":"...","text":"...","examples":["..."]}],"fails":[{"title":"...","text":"...","examples":["..."]}]}`,
      },
    ],
    7000
  );
  const d = parseJson<Partial<DossierAI>>(answer);
  const list = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    one_liner: String(d.one_liner ?? ''),
    niche_tags: list<string>(d.niche_tags).map(String).slice(0, 8),
    about: String(d.about ?? ''),
    audience: String(d.audience ?? ''),
    delivery: String(d.delivery ?? ''),
    sells: list<DossierAI['sells'][number]>(d.sells).slice(0, 6),
    formula: String(d.formula ?? ''),
    works: list<DossierAI['works'][number]>(d.works).slice(0, 6),
    fails: list<DossierAI['fails'][number]>(d.fails).slice(0, 5),
    model: MAIN_MODEL,
  };
}
