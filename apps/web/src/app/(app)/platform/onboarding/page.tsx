import type { Metadata } from 'next';
import { Card, CardHeader } from '@carl/ui';

import { PageHeader } from '@/components/page-header';
import { requirePlatformAdmin } from '@/lib/auth';
import { clientAppUrl, desktopDownloads } from '@/lib/downloads';
import { OnboardingForm } from './onboarding-form';

export const metadata: Metadata = { title: 'Add client · Carl platform' };
export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  await requirePlatformAdmin();

  return (
    <div className="space-y-4">
      <PageHeader
        title="Add client"
        description="Creates the business, its first branch, the owner's login and the subscription."
      />
      <Card>
        <CardHeader
          title="New business"
          description="Everything here is created together. If anything fails, nothing is created."
        />
        <OnboardingForm appUrl={clientAppUrl()} downloads={desktopDownloads()} />
      </Card>
    </div>
  );
}
