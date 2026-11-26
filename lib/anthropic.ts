// SamSpy — shared bits of Anthropic API requests
//
// Claude 5.x models think before answering by default, and that thinking counts against
// max_tokens: a JSON answer sized for the text alone gets cut off (stop_reason max_tokens).
// For plain transform tasks (tags, OCR, writing carousels from a playbook) we turn it off:
//   Sonnet 5.5           → thinking {type:'between_tools'} (it rejects 'disabled')
//   other 5.x Sonnet / Haiku / Opus 5 → thinking {type:'disabled'}
//   Opus 5.5 / Fable / Mythos         → always thinks, nothing to send
//   older models                      → no thinking by default, nothing to send
//
// Version history:
//   v0.1.0 (2026-11-26) — initial.

export function thinkingOff(model: string): { thinking?: { type: string } } {
  const m = model.toLowerCase();
  if (/sonnet-5-5/.test(m)) return { thinking: { type: 'between_tools' } };
  if (/opus-5-5|fable|mythos/.test(m)) return {};
  if (/(sonnet|haiku|opus)-5(\b|-|$)/.test(m)) return { thinking: { type: 'disabled' } };
  return {};
}
