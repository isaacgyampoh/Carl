import Link from 'next/link';
import type { ReactNode } from 'react';
import { formatMoney } from '@carl/shared';
import {
  Badge,
  Boxes,
  Card,
  CardBody,
  CardHeader,
  ChartColumn,
  Circle,
  CircleCheck,
  EmptyState,
  PackagePlus,
  ShoppingCart,
  UserPlus,
  Wallet,
  buttonClasses,
  cn,
  statusTone,
} from '@carl/ui';

/**
 * The business dashboard, as presentation only.
 *
 * Every figure arrives already computed by the database (see the page). Keeping this free of
 * data access means it renders identically from real queries and from sample data, which is
 * how its phone, tablet and desktop layouts are checked.
 */
export interface DashboardData {
  tenantName: string;
  branchName: string | null;
  multiBranch: boolean;
  can: {
    sell: boolean;
    sales: boolean;
    profit: boolean;
    stock: boolean;
    addProduct: boolean;
    adjustStock: boolean;
    manageStaff: boolean;
    reports: boolean;
    recordExpense: boolean;
  };
  today: { gross: number; count: number; cash: number; momo: number; cost: number } | null;
  periods: Record<'week' | 'month' | 'year', { gross: number; count: number }> | null;
  stock: { products: number; low: number; out: number } | null;
  low: { key: string; name: string; sku: string | null; quantity: number }[];
  recent: { id: string; number: string; total: number; soldAt: string; status: string }[];
  /** What a new business has done so far. Null when the viewer cannot act on any of it. */
  setup: { products: boolean; stock: boolean; staff: boolean; sale: boolean } | null;
  install: { url: string; windowsDownload: string | null } | null;
}

const count = (value: number, one: string, many: string) =>
  `${value.toLocaleString('en-GH')} ${value === 1 ? one : many}`;

export function DashboardView({ data }: { data: DashboardData }) {
  const { can } = data;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 lg:gap-6">
      {/* The business's name is already in the header (phone, tablet) and sidebar (desktop);
          repeating it as the title said it twice. The title names the view instead. */}
      <header className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">Today</h1>
        <p className="mt-0.5 truncate text-sm text-[color:var(--color-ink-muted)]">
          {data.branchName ? `${data.branchName} · ` : ''}Your business at a glance
        </p>
      </header>

      {data.setup && <GettingStarted setup={data.setup} can={can} />}

      <QuickActions can={can} />

      {can.sales && data.today && (
        <TodayCard
          today={data.today}
          periods={data.periods}
          can={can}
          multiBranch={data.multiBranch}
        />
      )}

      <div className="grid gap-5 lg:grid-cols-2 lg:gap-6">
        {can.stock && data.stock && <StockCard stock={data.stock} low={data.low} />}
        {can.sales && <RecentSalesCard recent={data.recent} canSell={can.sell} />}
        {data.install && <InstallCard install={data.install} />}
      </div>
    </div>
  );
}

/**
 * A new business's first steps, ticked off from its own data.
 *
 * A business onboarded yesterday has no products, no stock, one person and no sales, and its
 * dashboard used to be eleven cards of zeros with nothing saying what to do first. This names
 * the next step, links straight to it, and disappears once everything is done.
 */
function GettingStarted({
  setup,
  can,
}: {
  setup: NonNullable<DashboardData['setup']>;
  can: DashboardData['can'];
}) {
  const steps = [
    {
      key: 'products',
      done: setup.products,
      allowed: can.addProduct,
      title: 'Add your products',
      body: 'Name, prices and barcode. You can enter the stock you have at the same time.',
      href: '/products/new',
      cta: 'Add a product',
    },
    {
      key: 'stock',
      done: setup.stock,
      allowed: can.adjustStock,
      title: 'Put stock on the shelf',
      body: 'Record what you have now, so the till knows what it can sell.',
      href: '/inventory',
      cta: 'Record stock',
    },
    {
      key: 'staff',
      done: setup.staff,
      allowed: can.manageStaff,
      title: 'Add your staff',
      body: 'Each person gets their own PIN and a role that decides what they can see.',
      href: '/staff',
      cta: 'Add staff',
    },
    {
      key: 'sale',
      done: setup.sale,
      allowed: can.sell,
      title: 'Take your first sale',
      body: 'Open the till, scan or search for an item, and take payment.',
      href: '/pos',
      cta: 'Open the till',
    },
  ].filter((step) => step.allowed || step.done);

  const done = steps.filter((step) => step.done).length;
  if (steps.length === 0 || done === steps.length) return null;
  const next = steps.find((step) => !step.done);

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[color:var(--color-border)] px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">Get your business ready to sell</h2>
          <p className="mt-0.5 text-sm text-[color:var(--color-ink-muted)]">
            {done} of {steps.length} done
          </p>
        </div>
        <div
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={0}
          aria-valuemax={steps.length}
          aria-valuenow={done}
          className="h-2 w-full overflow-hidden rounded-full bg-[color:var(--color-surface-muted)] sm:w-48"
        >
          <div
            className="h-full rounded-full bg-[color:var(--color-brand)]"
            style={{ width: `${Math.max(4, (done / steps.length) * 100)}%` }}
          />
        </div>
      </div>
      <ol className="divide-y divide-[color:var(--color-border)]">
        {steps.map((step) => (
          <li
            key={step.key}
            className={cn('flex gap-3 px-5', step === next ? 'py-4' : 'items-center py-3')}
          >
            <span
              aria-hidden
              className={cn(
                'flex shrink-0 [&_svg]:size-5',
                step === next && 'mt-0.5',
                step.done
                  ? 'text-[color:var(--color-positive)]'
                  : 'text-[color:var(--color-ink-muted)]',
              )}
            >
              {step.done ? <CircleCheck /> : <Circle />}
            </span>
            {/* Only the next step explains itself; the rest are a line each, so a phone sees the
                whole list at once rather than four stacked cards. */}
            <div
              className={cn(
                'flex min-w-0 flex-1 gap-2 sm:gap-4',
                step === next
                  ? 'flex-col sm:flex-row sm:items-center sm:justify-between'
                  : 'flex-row items-center justify-between',
              )}
            >
              <div className="min-w-0">
                <p
                  className={cn(
                    'font-medium',
                    step.done && 'text-[color:var(--color-ink-muted)] line-through',
                  )}
                >
                  {step.title}
                  {step.done && <span className="sr-only"> (done)</span>}
                </p>
                {step === next && (
                  <p className="mt-0.5 text-sm text-[color:var(--color-ink-muted)]">{step.body}</p>
                )}
              </div>
              {!step.done && step.allowed && (
                <Link
                  href={step.href}
                  className={cn(
                    buttonClasses({ size: 'sm', variant: step === next ? 'primary' : 'secondary' }),
                    step === next ? 'self-start sm:self-auto' : 'shrink-0',
                  )}
                >
                  {step.cta}
                </Link>
              )}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** The four things this person does most, one tap away. Only what their role allows. */
function QuickActions({ can }: { can: DashboardData['can'] }) {
  const all: { show: boolean; href: string; label: string; hint: string; icon: ReactNode }[] = [
    { show: can.sell, href: '/pos', label: 'Sell', hint: 'Open the till', icon: <ShoppingCart /> },
    {
      show: can.addProduct,
      href: '/products/new',
      label: 'Add product',
      hint: 'Something new to sell',
      icon: <PackagePlus />,
    },
    {
      show: can.reports,
      href: '/reports',
      label: 'Reports',
      hint: 'Sales and profit',
      icon: <ChartColumn />,
    },
    {
      show: can.manageStaff,
      href: '/staff',
      label: 'Staff',
      hint: 'People and PINs',
      icon: <UserPlus />,
    },
    {
      show: can.adjustStock,
      href: '/inventory',
      label: 'Stock',
      hint: 'Counts and changes',
      icon: <Boxes />,
    },
    {
      show: can.recordExpense,
      href: '/expenses',
      label: 'Expense',
      hint: 'Money going out',
      icon: <Wallet />,
    },
  ];
  const actions = all.filter((action) => action.show).slice(0, 4);
  if (actions.length === 0) return null;

  return (
    <nav aria-label="Quick actions" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {actions.map((action, index) => (
        <Link
          key={action.href}
          href={action.href}
          className={cn(
            'flex min-h-24 select-none flex-col justify-between gap-3 rounded-[var(--radius-card)] border p-4 transition-colors',
            index === 0
              ? 'border-transparent bg-[color:var(--color-brand)] text-white hover:bg-[color:var(--color-brand-strong)] active:bg-[color:var(--color-brand-strong)]'
              : 'border-[color:var(--color-border)] bg-[color:var(--color-surface)] hover:bg-[color:var(--color-surface-muted)] active:bg-[color:var(--color-surface-muted)]',
          )}
        >
          <span
            aria-hidden
            className={cn(
              'flex [&_svg]:size-6',
              index === 0 ? 'text-white' : 'text-[color:var(--color-brand)]',
            )}
          >
            {action.icon}
          </span>
          <span>
            <span className="block font-semibold leading-tight">{action.label}</span>
            <span
              className={cn(
                'mt-0.5 block text-xs',
                index === 0 ? 'text-white/80' : 'text-[color:var(--color-ink-muted)]',
              )}
            >
              {action.hint}
            </span>
          </span>
        </Link>
      ))}
    </nav>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'positive' | 'danger' | undefined;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-[color:var(--color-ink-muted)]">{label}</dt>
      <dd
        className={cn(
          'mt-0.5 font-semibold tabular-nums',
          tone === 'positive' && 'text-[color:var(--color-positive)]',
          tone === 'danger' && 'text-[color:var(--color-danger)]',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/** Today's takings as one figure worth reading, with how they were paid and the longer view. */
function TodayCard({
  today,
  periods,
  can,
  multiBranch,
}: {
  today: NonNullable<DashboardData['today']>;
  periods: DashboardData['periods'];
  can: DashboardData['can'];
  multiBranch: boolean;
}) {
  const other = Math.max(today.gross - today.cash - today.momo, 0);
  const profit = today.gross - today.cost;

  return (
    <Card className="overflow-hidden">
      <div className="grid gap-5 p-5 sm:grid-cols-[1fr_auto] sm:items-end">
        <div className="min-w-0">
          <p className="text-sm font-medium text-[color:var(--color-ink-muted)]">
            Sales today{multiBranch ? ' · this branch' : ''}
          </p>
          <p className="mt-1 text-3xl font-semibold tabular-nums tracking-tight sm:text-4xl">
            {formatMoney(today.gross)}
          </p>
          <p className="mt-1 text-sm text-[color:var(--color-ink-muted)]">
            {count(today.count, 'sale', 'sales')}
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <Figure label="Cash" value={formatMoney(today.cash)} />
          <Figure label="Mobile money" value={formatMoney(today.momo)} />
          {other > 0 && <Figure label="Card and transfer" value={formatMoney(other)} />}
          {can.profit && (
            <Figure
              label="Gross profit"
              value={formatMoney(profit)}
              tone={profit >= 0 ? 'positive' : 'danger'}
            />
          )}
        </dl>
      </div>

      {periods && (
        <dl className="grid border-t border-[color:var(--color-border)] sm:grid-cols-3 sm:divide-x sm:divide-[color:var(--color-border)]">
          {(
            [
              ['week', 'This week'],
              ['month', 'This month'],
              ['year', 'This year'],
            ] as const
          ).map(([key, label]) => (
            <div
              key={key}
              className="flex items-baseline justify-between gap-3 border-b border-[color:var(--color-border)] px-5 py-3 last:border-b-0 sm:block sm:border-b-0"
            >
              <dt className="text-sm text-[color:var(--color-ink-muted)]">{label}</dt>
              <dd className="text-right sm:mt-1 sm:text-left">
                <span className="font-semibold tabular-nums">
                  {formatMoney(periods[key].gross)}
                </span>
                <span className="ml-2 text-xs text-[color:var(--color-ink-muted)] sm:ml-0 sm:block">
                  {count(periods[key].count, 'sale', 'sales')}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}

function StockCard({
  stock,
  low,
}: {
  stock: NonNullable<DashboardData['stock']>;
  low: DashboardData['low'];
}) {
  const figures: { label: string; value: number; tone: string }[] = [
    { label: 'Products', value: stock.products, tone: '' },
    {
      label: 'Low',
      value: stock.low,
      tone: stock.low > 0 ? 'text-[color:var(--color-warning)]' : '',
    },
    {
      label: 'Out',
      value: stock.out,
      tone: stock.out > 0 ? 'text-[color:var(--color-danger)]' : '',
    },
  ];

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Stock"
        description="What needs reordering"
        action={
          <Link href="/inventory" className={buttonClasses({ variant: 'ghost', size: 'sm' })}>
            View stock
          </Link>
        }
      />
      <dl className="grid grid-cols-3 divide-x divide-[color:var(--color-border)] border-b border-[color:var(--color-border)]">
        {figures.map((figure) => (
          <div key={figure.label} className="px-5 py-3">
            <dt className="text-xs text-[color:var(--color-ink-muted)]">{figure.label}</dt>
            <dd className={cn('mt-0.5 text-xl font-semibold tabular-nums', figure.tone)}>
              {figure.value.toLocaleString('en-GH')}
            </dd>
          </div>
        ))}
      </dl>
      {low.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm text-[color:var(--color-ink-muted)]">
          {stock.products === 0
            ? 'No products yet. Add one and its stock shows here.'
            : 'Nothing needs reordering.'}
        </p>
      ) : (
        <ul className="divide-y divide-[color:var(--color-border)]">
          {low.map((item) => (
            <li
              key={item.key}
              className="flex items-center justify-between gap-3 px-5 py-3 text-sm"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{item.name}</span>
                {item.sku && (
                  <span className="block truncate text-xs text-[color:var(--color-ink-muted)]">
                    {item.sku}
                  </span>
                )}
              </span>
              <Badge tone={item.quantity <= 0 ? 'danger' : 'warning'}>
                {item.quantity <= 0 ? 'Out' : `${item.quantity.toLocaleString('en-GH')} left`}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RecentSalesCard({
  recent,
  canSell,
}: {
  recent: DashboardData['recent'];
  canSell: boolean;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Recent sales"
        action={
          <Link href="/sales" className={buttonClasses({ variant: 'ghost', size: 'sm' })}>
            View all
          </Link>
        }
      />
      {recent.length === 0 ? (
        <EmptyState
          title="No sales yet"
          description="Each sale appears here the moment it is taken."
          action={
            canSell ? (
              <Link href="/pos" className={buttonClasses({ size: 'sm' })}>
                Open the till
              </Link>
            ) : undefined
          }
        />
      ) : (
        <ul className="divide-y divide-[color:var(--color-border)]">
          {recent.map((sale) => (
            <li key={sale.id}>
              <Link
                href={`/sales/${sale.id}`}
                className="flex items-center justify-between gap-3 px-5 py-3 text-sm hover:bg-[color:var(--color-surface-muted)] active:bg-[color:var(--color-surface-muted)]"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{sale.number}</span>
                  <span className="block text-xs text-[color:var(--color-ink-muted)]">
                    {new Date(sale.soldAt).toLocaleString('en-GH', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <span
                    className={cn(
                      'font-semibold tabular-nums',
                      sale.status === 'VOIDED' &&
                        'text-[color:var(--color-ink-muted)] line-through',
                    )}
                  >
                    {formatMoney(sale.total)}
                  </span>
                  {sale.status !== 'COMPLETED' && (
                    <Badge tone={statusTone(sale.status)}>
                      {sale.status.replace('_', ' ').toLowerCase()}
                    </Badge>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function InstallCard({ install }: { install: NonNullable<DashboardData['install']> }) {
  return (
    <Card>
      <CardHeader
        title="Install Carl on each till"
        description="Every POS computer, tablet and phone opens straight into your business."
      />
      <CardBody className="space-y-3 text-sm">
        <ol className="list-decimal space-y-1.5 pl-5 text-[color:var(--color-ink-muted)]">
          <li>
            On the till, open{' '}
            <span className="break-all font-medium text-[color:var(--color-ink)]">
              {install.url}
            </span>{' '}
            in Chrome or Edge.
          </li>
          <li>Choose Install, then open Carl from its own icon.</li>
          <li>Each person signs in with their own PIN.</li>
        </ol>
        {install.windowsDownload ? (
          <a
            href={install.windowsDownload}
            className={buttonClasses({ variant: 'secondary', size: 'sm' })}
          >
            Download the Windows desktop app
          </a>
        ) : (
          <p className="text-xs text-[color:var(--color-ink-muted)]">
            For offline selling with a receipt printer, add the till under{' '}
            <Link href="/devices" className="underline underline-offset-4">
              Terminals
            </Link>
            .
          </p>
        )}
      </CardBody>
    </Card>
  );
}
