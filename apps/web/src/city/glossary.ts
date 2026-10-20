/**
 * Plain-language explanations of the technical words the city workspace shows. Each one says what the number
 * means for the plan in front of the reader; none promises more than the engine proves.
 */
export const GLOSSARY = {
  lowerBound: {
    term: 'lower bound',
    text: 'A distance (or time) that no plan can beat, proven mathematically for this zone. The best possible plan lies between the lower bound and the plan shown.',
  },
  gap: {
    term: 'gap',
    text: 'How much longer the plan is than the lower bound, in percent. 0 % means the plan is proven to be the best possible; a small gap means it cannot be much worse than the best.',
  },
  deadhead: {
    term: 'transit (deadhead)',
    text: 'Driving without servicing: getting from one street to the next, or back to the depot. Planners call it deadhead; less of it means a shorter shift.',
  },
  makespan: {
    term: 'makespan',
    text: 'When the last vehicle is back at the depot, counted from the start of the shift: how long the whole job takes.',
  },
  settled: {
    term: 'arcs settled',
    text: 'How many road segments an algorithm had to examine before it could be sure of the best route. Every algorithm here returns the same best route; fewer settled arcs means less work to find it.',
  },
  exact: {
    term: 'exact',
    text: 'Solved by a method that guarantees the best answer for this model. Heuristic results are never called optimal; they come with a lower bound and a gap instead.',
  },
  connectors: {
    term: 'connectors',
    text: 'Shortest paths added to join groups of streets that are not connected inside the zone, so one vehicle can reach them all.',
  },
  turns: {
    term: 'turn penalties',
    text: 'Extra seconds charged for turning, from the truck profile: left 4 s, right 10 s, U-turn 20 s (traffic keeps left, so right turns cross it). They are reported separately, not added to the route times.',
  },
} as const;

export type GlossaryKey = keyof typeof GLOSSARY;
