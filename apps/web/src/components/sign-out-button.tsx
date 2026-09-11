'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@carl/ui';

import { signOut } from '@/server/session-actions';

export function SignOutButton() {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  return (
    <Button
      variant="ghost"
      size="sm"
      block
      loading={signingOut}
      onClick={() => {
        setSigningOut(true);
        void signOut()
          .then((result) => {
            // Staff go back to their own business's PIN prompt, not the email sign-in page.
            router.replace(result.ok ? result.data.next : '/sign-in');
            // Clears the cached server-rendered pages, which would otherwise still hold the
            // previous user's data in the router cache after signing out on a shared till.
            router.refresh();
          })
          .finally(() => setSigningOut(false));
      }}
    >
      Sign out
    </Button>
  );
}
