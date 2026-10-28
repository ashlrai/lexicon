/** Stable discovery contract for clients of the local HTTP API. */
import { z } from 'zod';

/** Feature identifiers describe supported operations, not user configuration. */
export const SERVER_FEATURES = [
  'normalize', 'learn', 'add', 'lexicon', 'stats', 'packs', 'aliases', 'export', 'pair',
] as const;

/** Unknown fields are rejected so accidental private metadata cannot leak. */
export const ServerInfoSchema = z.object({
  version: z.string().trim().min(1),
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  features: z.array(z.string().trim().min(1)),
}).strict();

export type ServerInfoResponse = z.infer<typeof ServerInfoSchema>;
