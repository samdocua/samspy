// SamSpy — Next.js config
//
// Version history:
//   v0.1.0 (2026-11-17) — Allow remote images from Virlo's public storage so
//                         thumbnails render via next/image. Virlo stores
//                         thumbnails itself, so these links don't expire.

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'auth.virlo.ai',
        pathname: '/storage/v1/object/public/**',
      },
    ],
  },
};

export default nextConfig;
