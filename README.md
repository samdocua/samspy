# SamSpy

Internal catalog of viral Instagram Reels, powered by the [Virlo API](https://dev.virlo.ai/docs).
No Instagram accounts, proxies, or cookies — Virlo does the scraping; SamSpy is
a thin catalog + UI on top.

Tab 1 **По конкурентам** is implemented. Tabs 2 (search) and 3 (top reels) are stubs.

## Stack
- **Next.js 14** (App Router) — frontend + API routes
- **Supabase** (Postgres) — catalog storage
- **Vercel** — hosting + daily cron
- **Virlo API** — the data source

## Setup

### 1. Database
In the Supabase SQL editor, run `supabase/schema.sql` (Run without RLS — it's an
internal tool; all writes go through the server with the service-role key).

### 2. Environment
Copy `.env.example` to `.env.local` and fill in:
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase → Settings → API
- `SUPABASE_SERVICE_ROLE_KEY` — same page (secret)
- `VIRLO_API_KEY` — dev.virlo.ai → dashboard → API keys (`virlo_tkn_...`)
- `SAMSPY_SECRET` — `openssl rand -hex 32`
- `GEMINI_API_KEY` — aistudio.google.com → Get API key (вкладка «Слайды»)
- `FAL_KEY` — fal.ai/dashboard/keys (вкладка «Слайды», модели GPT Image)

### 3. Run
```bash
npm install
npm run dev
```
Open http://localhost:3000.

## How it works
1. **Add an account** (@username or IG URL) → `POST /api/competitors`
   starts Virlo tracking ($0.25) and stores the creator id.
2. **Daily cron** (`GET /api/cron/sync`) pulls each account's posts from Virlo,
   upserts them into `reels`, recomputes the median, and snapshots metrics.
3. **The grid** (`GET /api/reels`) reads the catalog with filters
   (period, min outlier, min views, sort).

Outlier ratio = views ÷ the creator's median views. A reel is flagged viral at
`ratio ≥ 3` (Virlo's own threshold; adjustable via the slider).

## Карусели (Instagram)
Сбор текстов со слайдов каруселей по списку ссылок: Apify тянет посты, Claude
распознаёт текст (Haiku → перепроверка сомнительных слайдов Sonnet), результат —
таблица + CSV. Таблицы — `supabase/migration-004.sql`, ключи `APIFY_TOKEN`,
`ANTHROPIC_API_KEY`.

## Слайды
Вкладка-генератор слайдов для каруселей: фото-пример (загрузка / drag / Cmd+V) →
перегенерация через Gemini (напрямую) или GPT Image через fal.ai (`POST /api/slides/generate`) → наложение
текста на canvas в браузере → JPEG 1080 px. Картинки живут в памяти до
перезагрузки, настройки — в localStorage (экспорт/импорт JSON). Стоимость под
кнопкой — оценка по токенам для Gemini (цены в `lib/slides/config.ts`); для fal
стоимость видна только в биллинге fal.

## Manual sync (before the cron runs)
```bash
curl "http://localhost:3000/api/cron/sync?secret=YOUR_SAMSPY_SECRET"
```

## Cost
Each tracked account: $0.25 to start + $0.25 per daily check (~$7.5/mo).
Reading the catalog is free.

## Version
- v0.1.0 (2026-11-17) — tab 1 (competitors) complete.
- v0.1.1 (2026-11-17) — outlier falls back to likes when IG views are 0;
  grid shows all reels (slider filters); light theme; card padding.
- v0.4.0 (2026-11-18) — вкладка «Слайды» (Gemini 3.1 Flash Image / gpt-image-2,
  текст поверх в стиле TikTok, скачивание JPEG); sharp для перекодирования.
- v0.4.1 (2026-11-18) — GPT Image через fal.ai (2.6/2.5 Flare+Sunburst, 2) вместо
  прямого OpenAI — без верификации организации. `OPENAI_API_KEY` → `FAL_KEY`.
- v0.5.0 (2026-11-18) — вкладка «Карусели» (Apify + Claude OCR), migration-004.
