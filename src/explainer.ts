// SharpAlert — Claude explainer. One short signal card per detected movement.
import { Classification, Movement } from './detector';

const SYSTEM = `You are a sports trading analyst specialising in identifying sharp money movements in football betting markets.

Given a detected odds movement during a World Cup match, write a concise signal card with exactly three parts:

1. WHAT MOVED: One sentence describing the movement in plain English with the numbers.
2. WHAT IT SUGGESTS: One sentence interpreting what this typically indicates (sharp money, market correction, or reaction to match events).
3. WATCH FOR: One sentence on what outcome would confirm or invalidate this signal by full time.

Rules:
- Maximum 20 words per sentence.
- Use the concrete numbers from the data — no vague language.
- Do not make predictions — describe what the market is doing, not what will happen.
- Output only the three sentences separated by newlines, no labels or headers.`;

export interface ExplainInput {
  home: string; away: string; phase: string;
  movement: Movement; classification: Classification;
}

export async function explain(apiKey: string | undefined, input: ExplainInput): Promise<string> {
  const fallback = `${cap(input.movement.market)} ${input.movement.direction} ${signed(input.movement.impliedDelta)}pp (${input.movement.decimalBefore}→${input.movement.decimalAfter}).\n` +
    `Classified ${input.classification.type}, ${input.classification.confidence} confidence.\n` +
    `Watch whether ${input.home} vs ${input.away} resolves in line with the move by full time.`;
  if (!apiKey) return fallback;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 120, system: SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify({ match: { home: input.home, away: input.away, phase: input.phase }, movement: input.movement, classification: input.classification }) }],
      }),
    });
    if (!res.ok) return fallback;
    const data = await res.json() as { content?: { text?: string }[] };
    return data.content?.[0]?.text?.trim() || fallback;
  } catch { return fallback; }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const signed = (n: number) => (n > 0 ? '+' + n : String(n));
