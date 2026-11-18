// SamSpy — carousel text collector: prompts
// Ported verbatim from the standalone carousels.js (v1.7) so both behave the same.
//
// Version history:
//   v0.4.0 (2026-11-18) — initial port (OCR, check + last-slide split, re-split).

// Fallback only (when the check call failed): last slide is CTA if it looks like a call to action
export const CTA_PATTERNS: RegExp[] = [
  /app\s*store/i, /google\s*play/i, /link\s+in\s+(my\s+)?bio/i, /\bsearch\b/i, /\bdownload\b/i,
  /\bfollow\b/i, /\bsave\s+(this|for)/i, /\bshare\b/i, /\bcomment\b/i, /\bdm\b/i, /\bget\s+(it|the|our)\b/i,
  /^get$/im, /\bfor more\b/i, /\btry\b/i, /\bjoin\b/i, /\bsubscribe\b/i,
];

export const OCR_PROMPT = `This is one slide of an Instagram carousel post.
Transcribe the text that carries the slide's message, exactly as written, in natural reading order:
overlay text, captions, and the main featured text in the image (e.g. a sign or screen the photo is built around).
Also include watermarks, brand/app names and app-store style mockups if they are part of the slide design.
IGNORE incidental background text that is not part of the message: road markings, license plates,
street signs in the distance, product labels, and garbled or meaningless letters typical of AI-generated images.
If the slide shows an app screen with a question/card on it, transcribe the question/card, but skip app
interface labels around it (screen titles like "Deep Conversations", buttons like "Next", tab bars).
Exception: on a promo / app-store style slide (app name, "Get", "Search ... on the App Store") transcribe everything.
Keep original line breaks, language, emoji and punctuation. Do not translate, summarize or comment.
Ignore Instagram UI elements if any are visible. If there is no message text on the slide, output exactly: [NO TEXT]
Output only the transcribed text.`;

export const CHECK_PROMPT = `Below are OCR transcriptions of the slides of ONE Instagram carousel post, as JSON.
Find slides whose transcription looks wrong. Flag a slide if it contains:
- gibberish or non-existent words, random letter fragments (e.g. "QUESHDUR")
- words that look broken, misspelled by OCR or cut off
- text that looks like incidental background (road markings, license plates, signage) rather than the post's message
- lines in an order that makes no sense
Do NOT flag: brand or app names, slang, intentional ALL CAPS, emoji, quiz options like "A) ...",
CTA / app-store mockup text like "Search today ... Get", repeated watermark lines, empty slides.

ALSO split the LAST slide of the post into two parts:
- "content": the slide's own message — the question / statement / quiz with its answer options,
  exactly like the other slides of the post. Copy the text exactly, do not rewrite.
  Leave out brand/logo lines that appear on every slide (e.g. "flamingo").
- "cta": the call to action and promo part — "search for more questions", "feel closer with <app>",
  "more questions on <app>", "Search today", app name and subtitle, app-store mockups (app title, category,
  rank), "Get", "Search ... on the App Store for more". A short phrase that leads into the app name
  (e.g. "feel closer with" + "flamingo") is CTA, never content.
  Copy exactly, but drop phone status-bar elements (a clock like "9:48"), star ratings and rating counts
  (e.g. "★★★★☆ 400", a lone "400"), app-store/search UI buttons ("Cancel", "Open") and app icon
  labels (e.g. "21Q"). Do not repeat the same line twice.
Content must be a full question / statement / quiz like the other slides; if the last slide has none, it is only a CTA and "content" is "". If it has no CTA, "cta" is "".

Reply with JSON only, no other text:
{"flags":[{"slide":<slide number>,"issue":"<short reason>"}],"last_slide":{"content":"...","cta":"..."}}
Use an empty flags array if everything looks fine.

Slides:
`;

export const SPLIT_PROMPT = `Below is the OCR text of the LAST slide of an Instagram carousel post.
Split it into two parts:
- "content": the slide's own message — the question / statement / quiz with its answer options.
  Copy the text exactly, do not rewrite. Leave out standalone brand/logo lines.
- "cta": the call to action and promo part — "search for more questions", "feel closer with <app>",
  "more questions on <app>", "Search today", app name and subtitle, app-store mockups (app title, category,
  rank), "Get", "Search ... on the App Store for more". A short phrase that leads into the app name
  (e.g. "feel closer with" + "flamingo") is CTA, never content.
  Copy exactly, but drop phone status-bar elements (a clock like "9:48"), star ratings and rating counts
  (e.g. "★★★★☆ 400", a lone "400"), app-store/search UI buttons ("Cancel", "Open") and app icon
  labels (e.g. "21Q"). Do not repeat the same line twice.
Content must be a full question / statement / quiz; if the slide has none, it is only a CTA and "content" is "". If it has no CTA, "cta" is "".
Reply with JSON only: {"content":"...","cta":"..."}

Slide text:
`;
