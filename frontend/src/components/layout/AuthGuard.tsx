'use client';

import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useTranslations } from 'use-intl';
import { useAuthStore } from '@/store/auth';
import { showPrintLanguageLoadErrorsToast } from '@/lib/printer/warnings-toast';

export function getLandingPage(): string {
  return '/pos';
}

const PUBLIC_PATHS = ['/kds', '/kds-standalone', '/server-standalone', '/auth/login', '/auth/register', '/auth/recover', '/retail-preview'];

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const t = useTranslations('common');
  const { user, currentTenant, loading, loadFromStorage } = useAuthStore();
  const printLanguageLoadErrors = useAuthStore((s) => s.printLanguageLoadErrors);
  const router = useRouter();
  const pathname = usePathname();

  const isPublicPath = PUBLIC_PATHS.some(p => pathname === p || pathname?.startsWith(p + '/'));
  const isStandalonePath = pathname?.startsWith('/kds') || pathname?.startsWith('/server-standalone');
  const isPreviewPath = pathname === '/retail-preview';
  // The CLOUT storefront prototype is a public, customer-facing surface with its
  // own mock data and no POS session. Scoped to `/shop` and its subroutes only, so
  // no POS page or API path is affected.
  const isShopPath = pathname === '/shop' || pathname?.startsWith('/shop/');
  const bypassPosAuthentication = isStandalonePath || isPreviewPath || isShopPath;

  useEffect(() => {
    // Standalone KDS and Server App pages manage their own auth sessions;
    // skip loading shared POS auth store to avoid clearing their tokens.
    if (bypassPosAuthentication) return;
    loadFromStorage();
  }, [bypassPosAuthentication, loadFromStorage]);

  useEffect(() => {
    showPrintLanguageLoadErrorsToast(printLanguageLoadErrors);
  }, [printLanguageLoadErrors]);

  // The initial owner is provisioned by an administrator on the POS host. Client
  // browsers always enter through the normal authentication flow.
  useEffect(() => {
    if (loading) return; // wait for auth state to load

    if (isPublicPath || bypassPosAuthentication) return;

    if (!user) {
      router.push('/auth/login');
    } else if (!currentTenant) {
      router.push('/auth/login?select_tenant=true');
    }
  }, [loading, user, currentTenant, isPublicPath, bypassPosAuthentication, router]);

  if (bypassPosAuthentication) {
    return <>{children}</>;
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-brand border-t-transparent rounded-full animate-spin" />
          <p className="text-muted-foreground text-sm">{t('loadingScreen')}</p>
        </div>
      </div>
    );
  }

  if (isPublicPath) {
    return <>{children}</>;
  }

  if (!user || !currentTenant) return null;

  return <>{children}</>;
}
