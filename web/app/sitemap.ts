import type { MetadataRoute } from 'next';
import { sitemapEntries } from '../lib/sitemap.js';

// Resolve Git during the build, while the checkout is available. Machine
// payloads remain discoverable through alternates rather than the sitemap.
export const dynamic = 'force-static';

export default function sitemap(): MetadataRoute.Sitemap {
  return sitemapEntries();
}
