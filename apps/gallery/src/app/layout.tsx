import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '../web/style.css';

export const metadata: Metadata = { title: 'Daban · Bot Gallery' };
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
