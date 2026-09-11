import { Card, Skeleton } from '@carl/ui';

/**
 * What a page looks like while its data loads.
 *
 * Every page in the app is rendered on the server against live data, so navigating used to
 * show nothing at all until the queries finished — on a slow connection, long enough for a
 * cashier to tap the link again. This appears instantly inside the app shell, keeping the
 * navigation usable, and is shaped like the page that is coming rather than a spinner.
 */
export default function Loading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>
      <div className="space-y-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Card key={i} className="space-y-3 p-5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-7 w-32" />
          </Card>
        ))}
      </div>
      <Card className="space-y-3 p-5">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-5 w-full" />
        ))}
      </Card>
    </div>
  );
}
