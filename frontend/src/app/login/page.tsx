'use client';

import { useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/contexts/AuthContext';
import { resolveLoginRedirect } from '@/lib/authRedirect';
import LoginDialog from '@/components/LoginDialog';

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isAuthenticated, isReady } = useAuth();
  const registered = searchParams.get('registered') === 'true';
  const redirectTo = resolveLoginRedirect(searchParams.get('next'), searchParams.get('view'));

  useEffect(() => {
    if (isReady && isAuthenticated) {
      router.replace(redirectTo);
    }
  }, [isAuthenticated, isReady, redirectTo, router]);

  const handleClose = () => {
    router.push('/');
  };

  return (
    <LoginDialog
      isOpen={true}
      registered={registered}
      redirectTo={redirectTo}
      onClose={handleClose}
    />
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <LoginContent />
    </Suspense>
  );
}
