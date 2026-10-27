import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { UseCasePage } from '@/components/UseCasePage';
import { SITE_URL } from '@/lib/site';
import { useCases, useCasePath } from '@/lib/use-cases';

type Props = { params: Promise<{ slug: string }> };

export const dynamicParams = false;

export function generateStaticParams() {
  return useCases.map(({ slug }) => ({ slug }));
}

function getGuide(slug: string) {
  const guide = useCases.find((item) => item.slug === slug);
  if (!guide) notFound();
  return guide;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const guide = getGuide((await params).slug);
  const url = `${SITE_URL}${useCasePath(guide.slug)}`;
  return {
    title: guide.title,
    description: guide.description,
    alternates: {
      canonical: url,
      // Metadata merges this object shallowly; retain the root discovery links.
      types: {
        'text/plain': [
          { url: '/llms.txt', title: 'Lexicon for language models (index)' },
          { url: '/llms-full.txt', title: 'Lexicon for language models (full text)' },
        ],
        'application/json': [{ url: '/mcp.json', title: 'Lexicon MCP server install manifest' }],
      },
    },
    openGraph: {
      type: 'article',
      url,
      siteName: 'Lexicon',
      locale: 'en_US',
      title: guide.title,
      description: guide.description,
    },
    twitter: { card: 'summary_large_image', title: guide.title, description: guide.description },
  };
}

export default async function Page({ params }: Props) {
  return <UseCasePage guide={getGuide((await params).slug)} />;
}
