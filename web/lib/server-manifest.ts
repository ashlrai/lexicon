import { DISCOVERY } from './discovery';

/*
 * The repository's server.json, re-served at /server.json and
 * /.well-known/mcp/server.json.
 *
 * The manifest already exists at the repo root for the MCP registry; mirroring
 * it on the site means an agent that only knows the domain can still find the
 * canonical name, version, packages and transports. It comes from
 * lib/generated/discovery.json rather than a runtime fs read, because a Vercel
 * build never sees the repository root -- the generated module is bundled, so
 * it cannot 500 on deploy.
 */
export function serverManifest(): Response {
  return new Response(JSON.stringify(DISCOVERY.serverJson, null, 2) + '\n', {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
