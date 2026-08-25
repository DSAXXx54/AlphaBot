export type HomeViewMode = 'stock' | 'market' | 'topic';

const AUTH_VIEWS = new Set<HomeViewMode>(['market', 'topic']);
const ALLOWED_NEXT_PREFIXES = ['/sentiment', '/worldcup'];

export function isAuthRequiredView(mode: string): mode is 'market' | 'topic' {
  return AUTH_VIEWS.has(mode as HomeViewMode);
}

export function parseHomeView(value: string | null | undefined): HomeViewMode | null {
  if (value === 'stock' || value === 'market' || value === 'topic') return value;
  return null;
}

export function sanitizeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) {
    return '/';
  }

  const [pathname] = next.split('?');
  if (pathname === '/') return next.startsWith('/?') ? '/' : '/';
  if (ALLOWED_NEXT_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return pathname;
  }
  return '/';
}

export function resolveLoginRedirect(next: string | null | undefined, view: string | null | undefined): string {
  const path = sanitizeNextPath(next);
  if (path !== '/') return path;
  const homeView = parseHomeView(view);
  if (homeView === 'market' || homeView === 'topic') {
    return `/?view=${homeView}`;
  }
  return '/';
}

export function loginUrl(next = '/', view?: 'market' | 'topic'): string {
  const params = new URLSearchParams();
  const path = sanitizeNextPath(next);
  if (path !== '/') params.set('next', path);
  if (view) params.set('view', view);
  const query = params.toString();
  return query ? `/login?${query}` : '/login';
}
