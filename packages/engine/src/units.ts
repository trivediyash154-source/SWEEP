/**
 * Exact arithmetic support.
 *
 * Every weight is converted to an integer number of milli-units
 * (round(weight * 1000)). With MAX_WEIGHT = 1e6 and at most MAX_EDGES edges,
 * every path length and route total stays far below 2^53, so all additions and
 * comparisons on scaled values are exact in IEEE-754 doubles.
 */
export const SCALE = 1000;
export const MAX_WEIGHT = 1_000_000;

export function toScaled(weight: number): number {
  return Math.round(weight * SCALE);
}

export function fromScaled(scaled: number): number {
  return scaled / SCALE;
}
