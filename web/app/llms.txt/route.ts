import { llmsTxt } from '@/lib/llms';

// Built once at build time and served as a static file. `text/plain` matters:
// a model fetching /llms.txt should get text, not a download prompt.
export const dynamic = 'force-static';

export function GET() {
  return new Response(llmsTxt(), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
