// SamSpy — root layout (v0.1.0, 2026-11-17)
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SamSpy — Viral Reels Catalog',
  description: 'Internal catalog of viral Instagram Reels by competitor and niche.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
