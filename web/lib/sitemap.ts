import { gitLastModified } from './git-lastmod.js';
import { SITE_URL } from './site.js';
import { useCases, useCasePath } from './use-cases.js';

export function sitemapEntries(): { url: string; lastModified: string | undefined }[] {
  const shared = ['web/app/layout.tsx', 'web/app/globals.css', 'web/lib/site.ts'];
  return [
    {
      url: SITE_URL,
      lastModified: gitLastModified(['web/app/page.tsx', 'web/components', 'web/lib/use-cases.ts', 'web/lib/media.ts', ...shared]),
    },
    ...useCases.map((page) => ({
      url: new URL(useCasePath(page.slug), SITE_URL).href,
      lastModified: gitLastModified([
        'web/app/use-cases/[slug]/page.tsx',
        'web/components/UseCasePage.tsx',
        'web/lib/use-cases.ts',
        ...shared,
        // The guide's cited docs/code are also content dependencies. This gives
        // an honest history date in a local preview before new files are tracked.
        ...page.intro.sources.map((source) => source.path),
        ...page.sections.flatMap((section) => section.blocks.flatMap((block) => block.sources.map((source) => source.path))),
      ]),
    })),
  ];
}
