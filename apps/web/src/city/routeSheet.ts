import { arcDirections, classifyTurn, reverseArc, type CityModel, type TurnKind } from '@sweep/engine';

/**
 * Street-by-street route sheet for a point-to-point route. Turns are classified
 * exactly as the routing graph classifies them (same arc directions, same
 * 30° straight band, U-turn = the reverse arc), so the sheet agrees with the
 * turn counts and penalties the engine reported for the route.
 */

export interface SheetLeg {
  /** How the leg is entered: 'start' for the first leg, otherwise the turn at its first junction. */
  turn: 'start' | TurnKind;
  street: string;
  distanceM: number;
  /** Distance from the origin to the end of this leg. */
  cumulativeM: number;
  segments: number;
}

/** Turn taken from arc `a` into arc `b` at their shared junction. */
export function turnBetween(city: CityModel, a: number, b: number): TurnKind {
  if (b === reverseArc(a)) return 'uturn';
  const din = arcDirections(city, a).in;
  const dout = arcDirections(city, b).out;
  return classifyTurn(din[0], din[1], dout[0], dout[1]);
}

/** Every turn along the route (one per junction passed), counted by kind. */
export function turnCounts(city: CityModel, arcs: readonly number[]): Record<TurnKind, number> {
  const out: Record<TurnKind, number> = { straight: 0, left: 0, right: 0, uturn: 0 };
  for (let i = 1; i < arcs.length; i++) out[turnBetween(city, arcs[i - 1]!, arcs[i]!)]++;
  return out;
}

/** Groups consecutive arcs on the same street into legs; a U-turn always starts a new leg. */
export function routeSheet(city: CityModel, arcs: readonly number[], label: (segment: number) => string): SheetLeg[] {
  const legs: SheetLeg[] = [];
  let total = 0;
  arcs.forEach((arc, i) => {
    const seg = arc >> 1;
    const len = city.segLen[seg]!;
    const street = label(seg);
    const turn = i === 0 ? 'start' : turnBetween(city, arcs[i - 1]!, arc);
    total += len;
    const cur = legs[legs.length - 1];
    if (cur && cur.street === street && turn !== 'uturn') {
      cur.distanceM += len;
      cur.cumulativeM = total;
      cur.segments++;
    } else legs.push({ turn, street, distanceM: len, cumulativeM: total, segments: 1 });
  });
  return legs;
}

export const TURN_TEXT: Record<SheetLeg['turn'], string> = { start: 'Start on', straight: 'Continue onto', left: 'Turn left onto', right: 'Turn right onto', uturn: 'Make a U-turn onto' };
