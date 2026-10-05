'use client';

/**
 * Staff online-order management (Phase 5).
 *
 * Reads the LIVE staff API only. There is no mock or placeholder data here: an
 * empty catalogue shows an explicit empty state, and a failure shows an error,
 * never invented orders.
 *
 * Payment verification is deliberately absent for roles without permission; the
 * API decides what a role may see, and this UI only renders what it returns.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import axios from 'axios';
import { useTranslations } from 'use-intl';
import { useAuthStore } from '@/store/auth';
import { ROLE_ACCESS, hasRole } from '@shared/role-permissions';
import api from '@/lib/api';
import { BadgeCheck, Clock, Package, RefreshCw, ShieldAlert, Truck } from 'lucide-react';

type Status = 'pending_review' | 'accepted' | 'preparing' | 'packed' | 'dispatched' | 'completed' | 'rejected' | 'cancelled' | 'expired';
type PaymentStatus = 'unverified' | 'verified' | 'rejected' | 'refunded';

type OrderSummary = {
  id: string; reference: string; source: string;
  status: Status; payment_status: PaymentStatus;
  currency: string; subtotal_minor_units: number; subtotal_display: string;
  item_count: number; customer_name: string; city: string;
  reservation_expires_at: string | null; age_minutes: number; created_at: string;
};

type OrderDetail = OrderSummary & {
  customer: { name: string; phone: string; address: string; city?: string; state?: string; pincode?: string; instructions: string | null };
  items: { product_id: string; variant_id: string | null; product_name: string; variant_display_name: string | null; options: { name: string; value: string }[]; quantity: number; unit_price_minor_units: number; line_total_minor_units: number }[];
  reservation_held: boolean; reservation_quantity: number; reservation_expires_at: string | null;
  fulfilled_at: string | null; is_final: boolean; fulfilment_locked: boolean;
  allowed_transitions: Status[];
  declaration: { reference: string | null; declared_at: string } | null;
  payment_actions: { id: string; action: string; utr_reference: string | null; note: string | null; actor_name: string | null; created_at: string }[];
  events: { id: string; from_status: string | null; to_status: string; reason: string | null; actor_name: string | null; created_at: string }[];
  packing_actions?: Status[];
};

const STATUS_TONE: Record<Status, string> = {
  pending_review: 'bg-amber-100 text-amber-900',
  accepted: 'bg-blue-100 text-blue-900',
  preparing: 'bg-indigo-100 text-indigo-900',
  packed: 'bg-violet-100 text-violet-900',
  dispatched: 'bg-cyan-100 text-cyan-900',
  completed: 'bg-emerald-100 text-emerald-900',
  rejected: 'bg-red-100 text-red-900',
  cancelled: 'bg-gray-200 text-gray-800',
  expired: 'bg-gray-100 text-gray-600',
};

const PAYMENT_TONE: Record<PaymentStatus, string> = {
  unverified: 'bg-amber-100 text-amber-900',
  verified: 'bg-emerald-100 text-emerald-900',
  rejected: 'bg-red-100 text-red-900',
  refunded: 'bg-gray-200 text-gray-800',
};

function humanise(value: string) {
  return value.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function formatAge(minutes: number, t: ReturnType<typeof useTranslations>) {
  if (minutes < 60) return t('ageMinutes', { minutes });
  const hours = Math.round(minutes / 60);
  return t('ageHours', { hours });
}

export default function OnlineOrdersPage() {
  const t = useTranslations('onlineOrders');
  const currentTenant = useAuthStore((state) => state.currentTenant);
  const role = (currentTenant?.role || 'cashier') as never;
  // Mirrors the backend gate on the payment route (ROLE_ACCESS.ownerManagerCashier).
  const canVerify = hasRole(role, ROLE_ACCESS.ownerManagerCashier);

  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [paymentFilter, setPaymentFilter] = useState<string>('');
  const [selected, setSelected] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (paymentFilter) params.set('payment_status', paymentFilter);
      const res = await api.get(`/shop/admin/orders?${params.toString()}`);
      setOrders(res.data.orders ?? []);
    } catch (err: unknown) {
      setError(apiErrorMessage(err, t('loadError')));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, paymentFilter, t]);

  // Initial load and refetch when the filters change. `load` is async, so the
  // state updates happen after the effect body returns.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  async function openOrder(id: string) {
    try {
      const res = await api.get(`/shop/admin/orders/${encodeURIComponent(id)}`);
      setSelected(res.data);
    } catch (err: unknown) {
      setError(apiErrorMessage(err, t('loadError')));
    }
  }

  async function changeStatus(status: Status, reason?: string) {
    if (!selected) return;
    setBusy(true);
    try {
      await api.patch(`/shop/admin/orders/${encodeURIComponent(selected.id)}/status`, { status, reason });
      await openOrder(selected.id);
      await load();
    } catch (err: unknown) {
      setError(apiErrorMessage(err, t('actionError')));
    } finally {
      setBusy(false);
    }
  }

  async function decidePayment(action: 'verified' | 'rejected', utr?: string, note?: string) {
    if (!selected) return;
    setBusy(true);
    try {
      await api.post(`/shop/admin/orders/${encodeURIComponent(selected.id)}/payment`, { action, utr_reference: utr, note });
      await openOrder(selected.id);
      await load();
    } catch (err: unknown) {
      setError(apiErrorMessage(err, t('actionError')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-4 md:p-6 space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Package className="h-6 w-6" aria-hidden />
            {t('title')}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t('subtitle')}</p>
        </div>
        <button
          type="button"
          onClick={() => { void load(); }}
          className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
          disabled={loading}
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
          {t('refresh')}
        </button>
      </header>

      {error && (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>
      )}

      <div className="flex flex-wrap gap-2">
        <label className="sr-only" htmlFor="status-filter">{t('filterStatus')}</label>
        <select
          id="status-filter"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
          className="rounded-md border px-3 py-2 text-sm"
        >
          <option value="">{t('allStatuses')}</option>
          {['pending_review', 'accepted', 'preparing', 'packed', 'dispatched', 'completed', 'rejected', 'cancelled', 'expired'].map((value) => (
            <option key={value} value={value}>{humanise(value)}</option>
          ))}
        </select>
        <label className="sr-only" htmlFor="payment-filter">{t('filterPayment')}</label>
        <select
          id="payment-filter"
          value={paymentFilter}
          onChange={(event) => setPaymentFilter(event.target.value)}
          className="rounded-md border px-3 py-2 text-sm"
        >
          <option value="">{t('allPayments')}</option>
          {['unverified', 'verified', 'rejected', 'refunded'].map((value) => (
            <option key={value} value={value}>{humanise(value)}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <p className="py-10 text-center text-sm text-muted-foreground">{t('loading')}</p>
      ) : orders.length === 0 ? (
        <p className="rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('tableCaption')}</caption>
            <thead className="bg-muted/50 text-left">
              <tr>
                <th scope="col" className="px-3 py-2">{t('reference')}</th>
                <th scope="col" className="px-3 py-2">{t('customer')}</th>
                <th scope="col" className="px-3 py-2">{t('items')}</th>
                <th scope="col" className="px-3 py-2">{t('total')}</th>
                <th scope="col" className="px-3 py-2">{t('payment')}</th>
                <th scope="col" className="px-3 py-2">{t('status')}</th>
                <th scope="col" className="px-3 py-2">{t('age')}</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id} className="border-t hover:bg-accent/40">
                  <td className="px-3 py-2 font-mono">
                    <button type="button" className="underline" onClick={() => { void openOrder(order.id); }}>
                      {order.reference}
                    </button>
                    <span className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase">{t('online')}</span>
                  </td>
                  <td className="px-3 py-2">
                    {order.customer_name}
                    <div className="text-xs text-muted-foreground">{order.city}</div>
                  </td>
                  <td className="px-3 py-2 tabular-nums">{order.item_count}</td>
                  <td className="px-3 py-2 tabular-nums">{order.subtotal_display}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded px-2 py-0.5 text-xs font-semibold ${PAYMENT_TONE[order.payment_status]}`}>
                      {humanise(order.payment_status)}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span className={`rounded px-2 py-0.5 text-xs font-semibold ${STATUS_TONE[order.status]}`}>
                      {humanise(order.status)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{formatAge(order.age_minutes, t)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <OrderDetailPanel
          order={selected}
          canVerify={canVerify}
          busy={busy}
          t={t}
          onClose={() => setSelected(null)}
          onStatus={changeStatus}
          onPayment={decidePayment}
        />
      )}
    </div>
  );
}

/**
 * Surfaces the backend's own error string so staff see the server's rejection
 * reason (e.g. an expired reservation) instead of a generic message.
 */
function apiErrorMessage(err: unknown, fallback: string): string {
  return axios.isAxiosError(err) && typeof err.response?.data?.error === 'string'
    ? err.response.data.error
    : fallback;
}

/**
 * Detail drawer.
 *
 * Payment controls render only for roles the API authorises. A server sees the
 * packing details and permitted progress actions only, because the API omits
 * payment actions, declarations and audit history from their response entirely.
 */
function OrderDetailPanel({
  order, canVerify, busy, t, onClose, onStatus, onPayment,
}: {
  order: OrderDetail; canVerify: boolean; busy: boolean;
  t: ReturnType<typeof useTranslations>;
  onClose: () => void;
  onStatus: (status: Status, reason?: string) => void;
  onPayment: (action: 'verified' | 'rejected', utr?: string, note?: string) => void;
}) {
  const [utr, setUtr] = useState('');
  const [note, setNote] = useState('');
  const [needsReason, setNeedsReason] = useState<Status | null>(null);
  const [reason, setReason] = useState('');

  const packingOnly = !canVerify;
  const transitions = order.allowed_transitions.filter((status) =>
    packingOnly ? ['preparing', 'packed'].includes(status) : true);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" role="dialog" aria-modal="true" aria-label={t('detailTitle')}>
      <div className="h-full w-full max-w-2xl overflow-y-auto bg-background p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold font-mono">{order.reference}</h2>
            <div className="mt-1 flex flex-wrap gap-2">
              <span className={`rounded px-2 py-0.5 text-xs font-semibold ${STATUS_TONE[order.status]}`}>{humanise(order.status)}</span>
              <span className={`rounded px-2 py-0.5 text-xs font-semibold ${PAYMENT_TONE[order.payment_status]}`}>{humanise(order.payment_status)}</span>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded border px-3 py-1.5 text-sm hover:bg-accent">{t('close')}</button>
        </div>

        <section className="mt-5">
          <h3 className="font-semibold">{t('customer')}</h3>
          <p className="mt-1 text-sm">{order.customer.name}</p>
          <p className="text-sm">{order.customer.phone}</p>
          <p className="text-sm">{order.customer.address}</p>
          {order.customer.instructions && (
            <p className="mt-1 text-sm text-muted-foreground">{t('instructions')}: {order.customer.instructions}</p>
          )}
        </section>

        <section className="mt-5">
          <h3 className="font-semibold">{t('items')}</h3>
          <ul className="mt-2 divide-y rounded border">
            {order.items.map((item, index) => (
              <li key={index} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
                <div>
                  <p className="font-medium">{item.product_name}</p>
                  {item.options.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {item.options.map((option) => `${option.name}: ${option.value}`).join(' · ')}
                    </p>
                  )}
                  {!item.options.length && item.variant_display_name && (
                    <p className="text-xs text-muted-foreground">{item.variant_display_name}</p>
                  )}
                </div>
                <div className="text-right text-sm">
                  <p>× {item.quantity}</p>
                  <p className="tabular-nums text-muted-foreground">{(item.line_total_minor_units / 100).toFixed(2)}</p>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-right font-semibold">{t('total')}: {order.subtotal_display}</p>
        </section>

        <section className="mt-5">
          <h3 className="font-semibold flex items-center gap-2">
            <Clock className="h-4 w-4" aria-hidden />
            {t('reservation')}
          </h3>
          {order.reservation_held ? (
            <p className="mt-1 text-sm">
              {t('reservationHeld')} ({order.reservation_quantity})
              {order.reservation_expires_at && (
                <span className="block text-xs text-muted-foreground">
                  {t('expires')}: {new Date(order.reservation_expires_at).toLocaleString()}
                </span>
              )}
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">{t('noReservation')}</p>
          )}
        </section>

        {canVerify && (
          <section className="mt-5 rounded border p-3">
            <h3 className="font-semibold flex items-center gap-2">
              <BadgeCheck className="h-4 w-4" aria-hidden />
              {t('payment')}
            </h3>
            {order.declaration ? (
              <p className="mt-1 text-sm text-muted-foreground">
                {t('declared')}: {order.declaration.reference || t('noReference')}
              </p>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">{t('notDeclared')}</p>
            )}
            <p className="mt-2 flex items-start gap-2 rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              {t('verifyWarning')}
            </p>
            {order.payment_status === 'unverified' && (
              <div className="mt-3 space-y-2">
                <label className="block text-xs font-medium" htmlFor="utr">{t('utr')} *</label>
                <input
                  id="utr"
                  value={utr}
                  onChange={(event) => setUtr(event.target.value)}
                  placeholder={t('utrPlaceholder')}
                  className="w-full rounded border px-3 py-2 text-sm"
                />
                <label className="block text-xs font-medium" htmlFor="payment-note">{t('note')}</label>
                <input
                  id="payment-note"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  className="w-full rounded border px-3 py-2 text-sm"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onPayment('verified', utr, note)}
                    className="rounded bg-emerald-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {t('verify')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onPayment('rejected', undefined, note)}
                    className="rounded border px-3 py-2 text-sm font-medium disabled:opacity-50"
                  >
                    {t('rejectPayment')}
                  </button>
                </div>
              </div>
            )}
            {order.payment_actions.length > 0 && (
              <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                {order.payment_actions.map((action) => (
                  <li key={action.id}>
                    {humanise(action.action)} · {action.actor_name || '—'} · {action.utr_reference || '—'} ·{' '}
                    {new Date(action.created_at).toLocaleString()}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <section className="mt-5">
          <h3 className="font-semibold flex items-center gap-2">
            <Truck className="h-4 w-4" aria-hidden />
            {t('progress')}
          </h3>
          {transitions.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">{t('noActions')}</p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              {transitions.map((status) => (
                <button
                  key={status}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (status === 'cancelled' || status === 'rejected') { setNeedsReason(status); return; }
                    onStatus(status);
                  }}
                  className="rounded border px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
                >
                  {humanise(status)}
                </button>
              ))}
            </div>
          )}

          {needsReason && (
            <div className="mt-3 rounded border p-3">
              <label className="block text-xs font-medium" htmlFor="status-reason">{t('reason')} *</label>
              <input
                id="status-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                className="mt-1 w-full rounded border px-3 py-2 text-sm"
              />
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={busy || !reason.trim()}
                  onClick={() => { onStatus(needsReason, reason); setNeedsReason(null); setReason(''); }}
                  className="rounded bg-red-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {t('confirm')}
                </button>
                <button type="button" onClick={() => { setNeedsReason(null); setReason(''); }} className="rounded border px-3 py-2 text-sm">
                  {t('cancel')}
                </button>
              </div>
            </div>
          )}
        </section>

        {canVerify && (
          <section className="mt-5">
            <h3 className="font-semibold">{t('history')}</h3>
            <ol className="mt-2 space-y-1 text-xs text-muted-foreground">
              {order.events.map((event) => (
                <li key={event.id}>
                  {event.from_status ? `${humanise(event.from_status)} → ` : ''}{humanise(event.to_status)}
                  {event.actor_name ? ` · ${event.actor_name}` : ''} · {new Date(event.created_at).toLocaleString()}
                  {event.reason ? ` · ${event.reason}` : ''}
                </li>
              ))}
            </ol>
          </section>
        )}

        <p className="mt-6 text-xs text-muted-foreground">
          <Link href="/shop" className="underline">{t('storefrontLink')}</Link>
        </p>
      </div>
    </div>
  );
}
