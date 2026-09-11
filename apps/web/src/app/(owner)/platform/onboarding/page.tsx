import type { Metadata } from 'next';
import { Card, CardHeader } from '@carl/ui';

import { PageHeader } from '@/components/page-header';
import { requirePlatformAdmin } from '@/lib/auth';
import { clientAppUrl, desktopDownloads, windowsInstaller } from '@/lib/downloads';
import { OnboardingForm } from './onboarding-form';

export const metadata: Metadata = { title: 'Add client · Carl platform' };
export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  await requirePlatformAdmin();
  const installer = await windowsInstaller();
  /*
   * The Windows till the owner hands over is the published release, the same one the client's
   * own Windows POS page offers. The configured links alone said "not yet available" while a
   * built, published installer existed.
   */
  const downloads = desktopDownloads().map((target) =>
    target.platform === 'Windows' && !target.url && installer.available
      ? {
          ...target,
          url: installer.downloadUrl,
          note: `Windows 10 and later, x64${installer.version ? ` · ${installer.version}` : ''}`,
        }
      : target,
  );

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
        <OnboardingForm appUrl={clientAppUrl()} downloads={downloads} />
      </Card>
    </div>
  );
}
