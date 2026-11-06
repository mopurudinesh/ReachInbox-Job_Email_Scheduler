import type { LucideIcon } from 'lucide-react';

export function EmptyState({ icon: Icon, title, description, action, actionLabel }: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: () => void;
  actionLabel?: string;
}) {
  return <div className="flex min-h-[190px] flex-col items-center justify-center px-5 py-10 text-center">
    <div className="mb-3 grid h-11 w-11 place-items-center rounded-2xl bg-slate-100 text-slate-400"><Icon size={19} aria-hidden="true" /></div>
    <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
    <p className="mt-1 max-w-sm text-xs leading-5 text-slate-600">{description}</p>
    {action && actionLabel && <button onClick={action} className="mt-4 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-700">{actionLabel}</button>}
  </div>;
}

export function LoadingTable({ label }: { label: string }) {
  return <div role="status" aria-label={label} className="space-y-4 p-5"><span className="sr-only">{label}</span>{Array.from({ length: 5 }, (_, index) => <div key={index} className="flex animate-pulse gap-4 motion-reduce:animate-none"><div className="h-4 w-2/5 rounded bg-slate-100" /><div className="h-4 w-1/5 rounded bg-slate-100" /><div className="h-4 w-1/6 rounded bg-slate-100" /></div>)}</div>;
}

export function ErrorState({ message, onRetry, retryLabel = 'Retry' }: { message: string; onRetry?: () => void; retryLabel?: string }) {
  return <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"><span>{message}</span>{onRetry && <button onClick={onRetry} className="shrink-0 rounded-lg border border-rose-200 bg-white px-3 py-2 text-xs font-semibold hover:bg-rose-100">{retryLabel}</button>}</div>;
}

export function OfflineBanner({ online, restored }: { online: boolean; restored: boolean }) {
  if (!online) return <div role="status" className="mb-5 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">You’re offline. Some features may be unavailable. Check your connection and retry interrupted actions.</div>;
  if (restored) return <div role="status" className="mb-5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">Connection restored.</div>;
  return null;
}
