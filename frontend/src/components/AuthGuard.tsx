'use client';

import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '@/lib/contexts/AuthContext';
import { loginUrl } from '@/lib/authRedirect';

const publicPaths = ['/', '/login', '/register', '/about'];
const publicPathPrefixes = ['/published/'];

const isPublicPath = (pathname: string) =>
  publicPaths.includes(pathname) || publicPathPrefixes.some((prefix) => pathname.startsWith(prefix));

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isReady } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const publicPath = isPublicPath(pathname);

  useEffect(() => {
    if (!isReady) return;

    if (isAuthenticated && pathname === '/register') {
      router.replace('/');
      return;
    }

    if (!isAuthenticated && !publicPath) {
      router.replace(loginUrl(pathname));
    }
  }, [isAuthenticated, isReady, pathname, publicPath, router]);

  if (publicPath) {
    return <>{children}</>;
  }

  if (!isReady || !isAuthenticated) {
    return null;
  }

  return <>{children}</>;
}
