import { DISCOVERY } from '@/lib/discovery';
import { DOC } from '@/lib/site';

export const dynamic = 'force-static';

/*
 * docs/AGENTS.md served at https://lexicon.ashlr.ai/AGENTS.md.
 *
 * The doc is written for the agent performing an install: the per-client
 * commands, the preview-first write gates, and the verification steps. Serving
 * it from the domain puts it one fetch away from anything that landed on the
 * site, which is where an agent looking for install instructions arrives.
 */
export function GET() {
  const body =
    DISCOVERY.agentsMd ??
    `# For agents\n\nThe copy of docs/AGENTS.md that ships with this build is at ${DOC('docs/AGENTS.md')}.\n`;
  return new Response(body, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
