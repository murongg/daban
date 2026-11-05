import type { NextConfig } from 'next';

export default function config(phase: string): NextConfig {
  return {
    output: 'export',
    typescript: { tsconfigPath: 'tsconfig.web.json' },
    ...(phase === 'phase-development-server'
      ? {
          rewrites: async () => [
            {
              source: '/api/:path*',
              destination: `${process.env.GALLERY_DEV_ORIGIN ?? 'http://127.0.0.1:8080'}/api/:path*`,
            },
          ],
        }
      : {}),
  };
}
