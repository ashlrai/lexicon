/**
 * Fixed defaults so clients can find the local API without reading serve.json.
 * Split out of config.ts so CLI help can name the port without loading the core.
 */
export const DEFAULT_PORT = 41733;
export const DEFAULT_HOST = '127.0.0.1';
