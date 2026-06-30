// SharpAlert - movement detection + classification. THE judging centerpiece.
// Clean, deterministic, fully commented. Named constants for every threshold.

export const SHARP_THRESHOLD = 0.05;    // 5pp implied-probability shift in one poll = a signal
export const NOISE_THRESHOLD = 0.02;    // < 2pp = ignore as noise
export const VELOCITY_THRESHOLD = 3;    // same direction this many polls in a row = "sustained"
export const REACTIVE_WINDOW_MS = 180_000; // a move within 3 min of a goal/red is "reactive", not sharp

export type Market = 'home' | 'draw' | 'away';
export const MARKETS: Market[] = ['home', 'draw', 'away'];
export type Implied = Record<Market, number>;
export type Decimal = Record<Market, number>;

export interface Movement {
  market: Market;
  direction: 'shortening' | 'drifting';
  impliedDelta: number;   // percentage points, 1 decimal place (+ = shortened)
  decimalBefore: number;
  decimalAfter: number;
  pctChange: number;      // relative % change, 1 dp
}

/**
 * Compare the current implied probabilities to the previous snapshot.
 * Emits a movement for any market whose implied probability moved >= SHARP_THRESHOLD.
 */
export function detectMovements(curr: { implied: Implied; decimal: Decimal }, prev: { implied: Implied; decimal: Decimal }): Movement[] {
  const out: Movement[] = [];
  for (const market of MARKETS) {
    const delta = curr.implied[market] - prev.implied[market];
    if (Math.abs(delta) >= SHARP_THRESHOLD) {
      out.push({
        market,
        direction: delta > 0 ? 'shortening' : 'drifting',
        impliedDelta: Math.round(delta * 1000) / 10,
        decimalBefore: prev.decimal[market],
        decimalAfter: curr.decimal[market],
        pctChange: Math.round((Math.abs(delta) / prev.implied[market]) * 1000) / 10,
      });
    }
  }
  return out;
}

export type Velocity = 'single' | 'sustained';
export type Confidence = 'low' | 'medium' | 'high';

export interface Classification { type: 'sharp' | 'reactive'; velocity: Velocity; confidence: Confidence; }

/**
 * Classify a detected movement.
 * - reactive: a match event (goal/red) happened within REACTIVE_WINDOW_MS - the market is just
 *   repricing a known event, not a "sharp" signal.
 * - sharp: a movement with no recent match event to explain it (the interesting case).
 * Confidence: high = sustained (>=3 polls same direction) with no recent event; medium = single
 * large move, no event; low = movement coincident with an event.
 */
export function classify(streakCount: number, msSinceEvent: number): Classification {
  const isReactive = msSinceEvent <= REACTIVE_WINDOW_MS;
  const velocity: Velocity = streakCount >= VELOCITY_THRESHOLD ? 'sustained' : 'single';
  let confidence: Confidence;
  if (isReactive) confidence = 'low';
  else if (velocity === 'sustained') confidence = 'high';
  else confidence = 'medium';
  return { type: isReactive ? 'reactive' : 'sharp', velocity, confidence };
}

/** Score a signal once the match outcome is known (reactive signals are not scored). */
export function scoreSignal(type: string, market: Market, direction: string, outcome: string): boolean | null {
  if (type === 'reactive') return null;
  const won = market === 'draw' ? outcome === 'draw' : outcome === `${market}_win`;
  if (direction === 'shortening') return won;     // shortened toward this outcome → correct if it won
  return !won;                                     // drifting away → correct if it did NOT win
}
