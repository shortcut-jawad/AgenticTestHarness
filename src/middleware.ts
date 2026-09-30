import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

const AUTH_COOKIE = '__auth';
const PUBLIC_PAGE_PATHS = new Set<string>(['/login', '/signup']);
const PUBLIC_API_PREFIXES = ['/api/auth', '/api/mock'];
// Exact-match only — health checks (Docker HEALTHCHECK, k8s liveness/readiness
// probes, the CD pipeline's post-deploy check) hit this with no credentials.
const PUBLIC_API_EXACT_PATHS = new Set<string>(['/api/health']);
const SESSION_ONLY_API_PREFIXES = ['/api/account'];

function isStaticAsset(pathname: string) {
  return (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/assets') ||
    pathname.startsWith('/images') ||
    pathname.startsWith('/fonts') ||
    pathname === '/favicon.ico' ||
    pathname === '/robots.txt' ||
    pathname === '/sitemap.xml'
  );
}

function isPublicApi(pathname: string) {
  return PUBLIC_API_PREFIXES.some((p) => pathname.startsWith(p)) || PUBLIC_API_EXACT_PATHS.has(pathname);
}

function isSessionOnlyApi(pathname: string) {
  return SESSION_ONLY_API_PREFIXES.some((p) => pathname.startsWith(p));
}

function hasBearerToken(req: NextRequest): boolean {
  const authHeader = req.headers.get('authorization');
  return !!authHeader && authHeader.toLowerCase().startsWith('bearer ');
}

async function hasValidJwt(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get(AUTH_COOKIE)?.value;
  if (!token) return false;

  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return false;
    }
    await jwtVerify(token, new TextEncoder().encode(secret));
    return true;
  } catch {
    return false;
  }
}

export default async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const isApi = pathname.startsWith('/api');

  if (isStaticAsset(pathname)) {
    return NextResponse.next();
  }

  const isPublicPage = PUBLIC_PAGE_PATHS.has(pathname);
  const isPublicAuthApi = isApi && isPublicApi(pathname);

  if (isPublicPage || isPublicAuthApi) {
    if (isPublicPage && (await hasValidJwt(req))) {
      const url = req.nextUrl.clone();
      url.pathname = '/';
      url.search = '';
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  const authed = await hasValidJwt(req);
  if (authed) {
    return NextResponse.next();
  }

  // Allow API requests with Bearer tokens through to route handlers
  // (actual token validation happens in getSessionUser via headers())
  if (isApi && hasBearerToken(req)) {
    if (isSessionOnlyApi(pathname)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.next();
  }

  if (isApi) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = '/login';
  const redirectTo = pathname + (search ?? '');
  loginUrl.search = redirectTo ? `?redirectTo=${encodeURIComponent(redirectTo)}` : '';
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ['/((?!.*\\.).*)'], 
};
