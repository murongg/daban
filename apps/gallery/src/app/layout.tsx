import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '../web/style.css';

export const metadata: Metadata = { title: 'Daban · Bot Gallery' };
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The same-origin bootstrap restores only this root's theme attribute before hydration.
    <html lang="zh-CN" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
