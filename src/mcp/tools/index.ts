/**
 * The tool registry. `createServer` walks this list and calls each registrar,
 * so adding a tool means adding it to one `tools/*.ts` module -- and adding a
 * new module means adding one line here. The order is the order the tools are
 * advertised in.
 */
import { registerTermTools } from './terms.js';
import { registerHarvestTools } from './harvest.js';
import { registerTrustTools } from './trust.js';
import { registerSetupTools } from './setup.js';
import { registerPackTools } from './packs.js';
import type { ToolRegistrar } from '../shared.js';

export const TOOL_REGISTRARS: readonly ToolRegistrar[] = [
  registerTermTools,
  registerHarvestTools,
  registerTrustTools,
  registerSetupTools,
  registerPackTools,
];
