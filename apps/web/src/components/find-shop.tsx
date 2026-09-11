'use client';

import { useState } from 'react';
import { buttonClasses, Field } from '@carl/ui';

const SLUG = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

/**
 * "Which business is this?"
 *
 * A till app opened on a device that has never signed in to a business used to land on the
 * email-and-password page — no use to a cashier who has only ever had a PIN. This asks for the
 * address the business was given and hands them that business's own door.
 *
 * It confirms nothing: an unknown address is taken exactly like a real one, because checking
 * here would tell anyone who asked which businesses are on Carl. The door itself asks for a PIN.
 */
export function FindShop() {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  /** Accepts "kofi-stores", a full address, or one pasted with https:// in front. */
  function slugFrom(input: string): string | null {
    const trimmed = input.trim().toLowerCase();
    if (!trimmed) return null;
    const withoutScheme = trimmed.replace(/^https?:\/\//, '');
    const path = withoutScheme.includes('/') ? withoutScheme.split('/')[1] : withoutScheme;
    const candidate = (path ?? '').split(/[?#]/)[0] ?? '';
    return SLUG.test(candidate) ? candidate : null;
  }

  function go(where: 'pos' | 'portal') {
    const slug = slugFrom(value);
    if (!slug) {
      setError('That does not look like a business address. It looks like kofi-stores.');
      return;
    }
    window.location.assign(where === 'pos' ? `/${slug}/pos` : `/${slug}`);
  }

  return (
    <div className="space-y-6">
      <Field
        label="Your business address"
        name="shop"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        placeholder="kofi-stores"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') go('pos');
        }}
        {...(error ? { error } : {})}
        hint="The address your Carl provider gave your business."
      />
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => go('pos')}
          className={buttonClasses({ variant: 'primary', className: 'h-12 w-full' })}
        >
          Open the till
        </button>
        <button
          type="button"
          onClick={() => go('portal')}
          className={buttonClasses({ variant: 'secondary', className: 'h-12 w-full' })}
        >
          Open the business portal
        </button>
      </div>
    </div>
  );
}
