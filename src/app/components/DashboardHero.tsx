'use client';

import React, { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import DeleteAccountModal from './DeleteAccountModal';
import { USER_PROFILE_UPDATED_EVENT } from '@/lib/events';

const CACHE_KEY = 'dashboard-display-name';
const CACHE_TTL_MS = 5 * 60 * 1000;

function getCachedDisplayName(): string | null {
  if (typeof window === 'undefined') return null;

  try {
    const raw = sessionStorage.getItem(CACHE_KEY);

    if (!raw) return null;

    const { name, at } = JSON.parse(raw) as {
      name: string;
      at: number;
    };

    if (Date.now() - at > CACHE_TTL_MS) {
      sessionStorage.removeItem(CACHE_KEY);
      return null;
    }

    return name;
  } catch {
    return null;
  }
}

function setCachedDisplayName(name: string) {
  if (typeof window === 'undefined') return;

  try {
    sessionStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        name,
        at: Date.now(),
      })
    );
  } catch {
    // ignore
  }
}

type MeResponse = {
  id: string;
  name?: string | null;
  email: string;
};

const navLinks = [
  { href: '/', label: 'Dashboard' },
  { href: '/test-harness', label: 'Test Harness' },
  { href: '/rubrics', label: 'Rubrics' },
  { href: '/limit-model-budget', label: 'Budget' },
];

export default function DashboardHero() {
  const [open, setOpen] = useState(false);

  // IMPORTANT: Never read sessionStorage here
  const [displayName, setDisplayName] = useState('');

  // Used to prevent hydration mismatch
  const [hydrated, setHydrated] = useState(false);

  const [loggingOut, setLoggingOut] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const router = useRouter();
  const pathname = usePathname();

  // Mark component as hydrated
  useEffect(() => {
    setHydrated(true);
  }, []);

  // Load cached name and refresh from API
  useEffect(() => {
    let alive = true;

    // Load cache after hydration
    const cached = getCachedDisplayName();

    if (cached) {
      setDisplayName(cached);
    }

    (async () => {
      try {
        const res = await fetch('/api/me', {
          credentials: 'include',
          cache: 'no-store',
        });

        if (!res.ok) return;

        const data = (await res.json()) as MeResponse;

        if (alive) {
          const name =
            (data.name && data.name.trim()) ||
            data.email ||
            '';

          setCachedDisplayName(name);
          setDisplayName(name);
        }
      } catch {
        // Keep cached value if fetch fails
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  // Listen for profile updates
  useEffect(() => {
    function onProfileUpdated(event: Event) {
      const detail = (
        event as CustomEvent<{ name?: string }>
      ).detail;

      const nextName =
        (detail?.name && detail.name.trim()) || null;

      if (nextName) {
        setCachedDisplayName(nextName);
        setDisplayName(nextName);
      }
    }

    window.addEventListener(
      USER_PROFILE_UPDATED_EVENT,
      onProfileUpdated as EventListener
    );

    return () => {
      window.removeEventListener(
        USER_PROFILE_UPDATED_EVENT,
        onProfileUpdated as EventListener
      );
    };
  }, []);

  async function handleLogout() {
    if (loggingOut) return;

    setLoggingOut(true);

    try {
      const res = await fetch('/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!res.ok) {
        setLoggingOut(false);
        return;
      }

      router.push('/login');
      router.refresh();
    } catch {
      setLoggingOut(false);
    }
  }

  return (
    <>
      <nav className="sticky top-0 z-40 w-full border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-8">
            <Link
              href="/"
              className="text-base font-semibold tracking-tight text-zinc-100"
            >
              Agentic Harness
            </Link>

            <div className="hidden items-center gap-1 md:flex">
              {navLinks.map((link) => {
                const isActive = pathname === link.href;

                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`rounded-md px-3 py-1.5 text-sm transition ${
                      isActive
                        ? 'bg-zinc-800 text-zinc-100'
                        : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
                    }`}
                  >
                    {link.label}
                  </Link>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="relative">
              <button
                onClick={() => setMenuOpen(!menuOpen)}
                className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm text-zinc-400 transition hover:bg-zinc-800/50 hover:text-zinc-200"
              >
                <div className="flex h-6 w-6 items-center justify-center rounded-full bg-zinc-800 text-xs font-medium text-zinc-300">
                  {!hydrated
                    ? ''
                    : displayName
                    ? displayName.charAt(0).toUpperCase()
                    : '?'}
                </div>

                <span className="hidden sm:inline">
                  {!hydrated
                    ? ''
                    : displayName || 'Account'}
                </span>

                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </button>

              {menuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setMenuOpen(false)}
                  />

                  <div className="absolute right-0 z-50 mt-1 w-48 rounded-lg border border-zinc-800 bg-zinc-900 py-1 shadow-xl">
                    <Link
                      href="/profile"
                      onClick={() => setMenuOpen(false)}
                      className="block px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
                    >
                      Profile Settings
                    </Link>

                    <button
                      onClick={() => {
                        setMenuOpen(false);
                        handleLogout();
                      }}
                      disabled={loggingOut}
                      className="block w-full px-4 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-50"
                    >
                      {loggingOut
                        ? 'Signing out...'
                        : 'Sign out'}
                    </button>

                    <div className="my-1 border-t border-zinc-800" />

                    <button
                      onClick={() => {
                        setMenuOpen(false);
                        setOpen(true);
                      }}
                      className="block w-full px-4 py-2 text-left text-sm text-red-400 hover:bg-zinc-800 hover:text-red-300"
                    >
                      Delete Account
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </nav>

      <DeleteAccountModal
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
