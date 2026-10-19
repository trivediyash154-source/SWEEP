import { z } from 'zod';

const shortText = (max: number) => z.string().trim().max(max);
const point = z.tuple([z.number(), z.number()]);

export const vertexSchema = z.object({
  id: z.string().min(1).max(64),
  x: z.number(),
  y: z.number(),
  label: shortText(120).optional(),
  geo: point.optional(),
});

export const edgeSchema = z.object({
  id: z.string().min(1).max(64),
  u: z.string().min(1).max(64),
  v: z.string().min(1).max(64),
  weight: z.number(),
  required: z.boolean(),
  name: shortText(120).optional(),
  shape: z.array(point).max(2000).optional(),
  oneway: z.boolean().optional(),
  reverseWeight: z.number().optional(),
  directed: z.boolean().optional(),
  sourceRef: shortText(80).optional(),
  roadClass: shortText(40).optional(),
});

export const provenanceSchema = z.object({
  kind: z.enum(['example', 'bundled-sample', 'imported-file', 'live-acquisition', 'user']),
  provider: shortText(300).optional(),
  endpoint: shortText(300).optional(),
  retrievedAt: shortText(40).optional(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  attribution: shortText(300).optional(),
  license: shortText(120).optional(),
  roadClasses: z.array(shortText(40)).max(40).optional(),
  notes: z.array(shortText(500)).max(50).optional(),
  cached: z.boolean().optional(),
});

export const routingSchema = z.object({
  mode: z.enum(['undirected', 'directed']).optional(),
  twoWay: z.enum(['both', 'either']).optional(),
  ignoreOneway: z.boolean().optional(),
  vehicles: z.number().int().optional(),
  objective: z.enum(['balance', 'total']).optional(),
  maxRouteLength: z.number().nullable().optional(),
});

export const graphSchema = z.object({
  format: z.literal('sweep.graph').optional(),
  version: z.literal(1).optional(),
  name: shortText(120).optional(),
  description: shortText(500).optional(),
  units: shortText(16).optional(),
  vertices: z.array(vertexSchema).max(20_000),
  edges: z.array(edgeSchema).max(40_000),
  depotId: z.string().max(64).nullable().optional(),
  source: provenanceSchema.optional(),
  routing: routingSchema.optional(),
});

export const optimizeSchema = z.object({
  graph: graphSchema,
  depotId: z.string().max(64).nullable().optional(),
});

export const routeSchema = z.object({
  graph: graphSchema,
  depotId: z.string().max(64).nullable().optional(),
  settings: routingSchema.optional(),
});

export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email({ message: 'Enter a valid email address.' })),
  password: z.string().min(1).max(200),
});

export const registerSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email({ message: 'Enter a valid email address.' })),
  password: z.string().min(10, 'Use at least 10 characters.').max(200, 'Use at most 200 characters.'),
  displayName: z.string().trim().min(1, 'Enter a display name.').max(60),
});

export const accountUpdateSchema = z.object({ displayName: z.string().trim().min(1).max(60) });
export const passwordChangeSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(10, 'Use at least 10 characters.').max(200) });
export const accountDeleteSchema = z.object({ password: z.string().min(1).max(200) });

export const scenarioCreateSchema = z.object({ name: z.string().trim().min(1).max(120), graph: graphSchema });
export const scenarioUpdateSchema = z.object({ name: z.string().trim().min(1).max(120).optional(), graph: graphSchema.optional() }).refine((v) => v.name !== undefined || v.graph !== undefined, 'Nothing to update.');
export const runCreateSchema = z.object({ depotId: z.string().max(64).nullable().optional(), settings: routingSchema.optional() });
export const geojsonImportSchema = z.object({ geojson: z.unknown(), name: shortText(120).optional() });

/** A small denylist of very common passwords (complements the length rule). */
export const COMMON_PASSWORDS = new Set([
  'password123', 'password1234', '1234567890', 'qwertyuiop', '12345678910', 'iloveyou12', 'letmein123', 'welcome123', 'admin12345', 'passw0rd123', '0123456789', 'qwerty1234',
]);
