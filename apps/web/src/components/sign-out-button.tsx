'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@carl/ui';
import { browserClient } from '@carl/infrastructure';

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
        void browserClient()
          .auth.signOut()
          .then(() => {
            router.replace('/sign-in');
            // Clears the cached server-rendered pages, which would otherwise still hold the
            // previous user's data in the router cache after signing out on a shared till.
            router.refresh();
          });
      }}
    >
      Sign out
    </Button>
  );
}
