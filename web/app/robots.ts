import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

/*
 * Everything is allowed, including the AI crawlers.
 *
 * The usual reason a site blocks GPTBot and friends is that it sells the words
 * they would take. This site's whole job is the opposite: someone asking an
 * assistant "why does dictation keep writing Ashler instead of my company name"
 * should get Lexicon in the answer, and that only happens if the crawler that
 * built the assistant's index was allowed to read this page. So they are named
 * explicitly rather than left to the wildcard, because a named allow survives
 * someone later adding a restrictive `*` rule without thinking about them.
 */
const AI_CRAWLERS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-User',
  'Claude-SearchBot',
  'anthropic-ai',
  'PerplexityBot',
  'Perplexity-User',
  'CCBot',
  'Google-Extended',
  'Applebot-Extended',
  'DuckAssistBot',
  'Amazonbot',
  'Meta-ExternalAgent',
  'cohere-ai',
  'Bytespider',
  'MistralAI-User',
  'Diffbot',
  'Timpibot',
  'omgili',
  'YouBot',
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: '*', allow: '/' },
      { userAgent: AI_CRAWLERS, allow: '/' },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
