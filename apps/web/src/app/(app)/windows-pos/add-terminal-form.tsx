'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field } from '@carl/ui';

import { inputClass } from '@/components/form';
import { registerTerminal } from '@/server/terminal-actions';

/**
 * Adds a till and shows its activation code, once.
 *
 * Only a peppered hash of the code is stored, so it genuinely cannot be shown again; the
 * screen says so rather than letting someone assume they can come back for it.
 */
export function AddTerminalForm({
  branches,
  defaultBranchId,
  suggestedName,
}: {
  branches: { id: string; name: string }[];
  defaultBranchId: string | null;
  suggestedName: string;
}) {
  const router = useRouter();
  const [branchId, setBranchId] = useState(defaultBranchId ?? branches[0]?.id ?? '');
  const [name, setName] = useState(suggestedName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ code: string; name: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const grouped = issued ? `${issued.code.slice(0, 4)}-${issued.code.slice(4, 8)}-${issued.code.slice(8)}` : '';

  if (issued) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-[color:var(--color-brand)]/30 bg-[color:var(--color-brand-soft)] px-4 py-3">
          <p className="text-xs font-medium text-[color:var(--color-brand-strong)]">
            Activation code for {issued.name} · shown once
          </p>
          <p className="mt-1 break-all font-mono text-2xl font-semibold tracking-wider sm:text-3xl">{grouped}</p>
          <p className="mt-1 text-xs text-[color:var(--color-ink-muted)]">
            Expires {new Date(issued.expiresAt).toLocaleString('en-GH', { dateStyle: 'medium', timeStyle: 'short' })}.
            If it is lost, issue a new one from Terminals.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void navigator.clipboard?.writeText(issued.code).then(() => setCopied(true));
            }}
          >
            {copied ? 'Copied' : 'Copy code'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setIssued(null);
              setCopied(false);
              router.refresh();
            }}
          >
            Add another till
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        void registerTerminal({ branchId, name }).then((result) => {
          setBusy(false);
          if (!result.ok) {
            setError(result.message);
            return;
          }
          setIssued({ code: result.data.code, name, expiresAt: result.data.expiresAt });
          router.refresh();
        });
      }}
    >
      {error && <Alert tone="danger">{error}</Alert>}
      {branches.length > 1 && (
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Branch
          <select value={branchId} onChange={(event) => setBranchId(event.target.value)} className={inputClass}>
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <Field label="Till name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={60} />
      <Button type="submit" loading={busy} disabled={name.trim().length < 2 || !branchId} block>
        Add till and get code
      </Button>
    </form>
  );
}
