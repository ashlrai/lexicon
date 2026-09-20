import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

/*
 * One page, so one entry. The text endpoints (/llms.txt, /llms-full.txt,
 * /mcp.json) are deliberately absent: a sitemap is a list of documents a search
 * engine should index and rank, and those three are machine payloads that would
 * only dilute it. They are discoverable from <link rel="alternate"> in the head
 * and from the page itself.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE_URL,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 1,
    },
  ];
}
