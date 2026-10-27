import { serverManifest } from '@/lib/server-manifest';

export const dynamic = 'force-static';

export function GET() {
  return serverManifest();
}
