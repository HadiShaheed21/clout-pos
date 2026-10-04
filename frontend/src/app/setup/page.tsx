'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Client browsers must authenticate; owner provisioning is host-local only. */
export default function SetupPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/auth/login');
  }, [router]);

  return null;
}
