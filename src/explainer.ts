// SharpAlert - DeepInfra explainer. One short signal card per detected movement.
import { Classification, Movement } from './detector';
import { chat } from './llm';

const SYSTEM = `You are a sports trading analyst specialising in identifying sharp money movements in football betting markets.

Given a detected odds movement during a World Cup match, write a concise signal card with exactly three parts:

1. WHAT MOVED: One sentence describing the movement in plain English with the numbers.
2. WHAT IT SUGGESTS: One sentence interpreting what this typically indicates (sharp money, market correction, or reaction to match events).
3. WATCH FOR: One sentence on what outcome would confirm or invalidate this signal by full time.

Rules:
- Maximum 20 words per sentence.
- Use the concrete numbers from the data - no vague language.
- Do not make predictions - describe what the market is doing, not what will happen.
- Output only the three sentences separated by newlines, no labels or headers.`;

export interface ExplainInput {
  home: string; away: string; phase: string;
  movement: Movement; classification: Classification;
}

export async function explain(apiKey: string | undefined, input: ExplainInput): Promise<string> {
  // Neutral-venue tournament: name the team the market refers to, never "Home"/"Away".
  const mkName = input.movement.market === 'home' ? `${input.home} (win market)`
    : input.movement.market === 'away' ? `${input.away} (win market)` : 'Draw';
  const fallback = `${mkName} ${input.movement.direction} ${signed(input.movement.impliedDelta)}pp (${input.movement.decimalBefore}→${input.movement.decimalAfter}).\n` +
    `Classified ${input.classification.type}, ${input.classification.confidence} confidence.\n` +
    `Watch whether ${input.home} vs ${input.away} resolves in line with the move by full time.`;
  if (!apiKey) return fallback;
  try {
    const text = await chat(apiKey, {
      system: SYSTEM + '\nRefer to the moved market by the team name given in "marketName" - never say "home" or "away".',
      user: JSON.stringify({ match: { home: input.home, away: input.away, phase: input.phase }, movement: { ...input.movement, marketName: mkName }, classification: input.classification }),
      // Generous budget: GLM's hidden reasoning tokens count against max_tokens - 120 was
      // starving the visible output, so every card silently fell back to the template.
      maxTokens: 1200,
    });
    const clean = (text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    return clean || fallback;
  } catch { return fallback; }
}
const signed = (n: number) => (n > 0 ? '+' + n : String(n));
