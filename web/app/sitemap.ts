import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

/*
 * Two pages, two entries. The text endpoints (/llms.txt, /llms-full.txt,
 * /mcp.json, /capabilities.json, /server.json) are deliberately absent: a
 * sitemap is a list of documents a search engine should index and rank, and
 * those are machine payloads that would only dilute it. They are discoverable
 * from <link rel="alternate"> in the head and from the pages themselves.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE_URL,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 1,
    },
    {
      url: `${SITE_URL}/install`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.8,
    },
  ];
}
