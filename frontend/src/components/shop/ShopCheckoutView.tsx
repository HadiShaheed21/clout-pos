'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useShopCartStore } from '@/store/shop-cart-store';
import { formatMinor } from '@/lib/shop/format';
import {
  declarePayment, newIdempotencyKey, submitCheckout,
  type CheckoutConfirmation, type CheckoutCustomer, type UpiPayment,
} from '@/lib/shop/checkout-client';
import { CartLinesList } from './CartLinesList';
import { ShopEmptyState, ShopErrorState, ShopLoadingState } from './ShopLoadStates';

const EMPTY_FORM: CheckoutCustomer = {
  name: '', phone: '', address: '', city: '', state: '', pincode: '', instructions: '',
};

/** Browser-side checks mirror the server's, for usability only. */
function validate(form: CheckoutCustomer): Record<string, string> {
  const errors: Record<string, string> = {};
  if (form.name.trim().length < 2) errors.name = 'Enter your full name.';
  const digits = form.phone.replace(/[\s\-().]/g, '').replace(/^(\+?91|0)/, '');
  if (!/^[6-9]\d{9}$/.test(digits)) errors.phone = 'Enter a valid 10-digit phone number.';
  if (form.address.trim().length < 6) errors.address = 'Enter a complete address.';
  if (!form.city.trim()) errors.city = 'Enter your city or locality.';
  if (!form.state.trim()) errors.state = 'Enter your state.';
  if (!/^([1-9]\d{5}|\d{4})$/.test(form.pincode.trim())) errors.pincode = 'Enter a valid PIN code.';
  return errors;
}

/**
 * Checkout (Phase 4).
 *
 * Creates a REAL pending online order on the server. Payment is NOT taken and
 * NOT verified: the customer sends the prepared WhatsApp message so staff can
 * confirm. Checkout is unavailable while the bag holds unavailable lines.
 */
export function ShopCheckoutView() {
  const cart = useShopCartStore((state) => state.cart);
  const cartStatus = useShopCartStore((state) => state.status);
  const refresh = useShopCartStore((state) => state.refresh);

  const [form, setForm] = useState<CheckoutCustomer>(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);
  const [confirmation, setConfirmation] = useState<CheckoutConfirmation | null>(null);
  const [upi, setUpi] = useState<UpiPayment | null>(null);

  // One key per logical attempt, reused across retries so a lost response or an
  // impatient second click cannot create two orders.
  const attemptKey = useRef<string>(newIdempotencyKey());

  useEffect(() => { void refresh(); }, [refresh]);

  function update(field: keyof CheckoutCustomer, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;

    const found = validate(form);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      (document.querySelector('[aria-invalid="true"]') as HTMLElement | null)?.focus();
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    setRetryable(false);
    try {
      const result = await submitCheckout(form, attemptKey.current);
      setConfirmation(result.order);
      setUpi(result.upi);
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'We could not complete your order.';
      setSubmitError(message);
      setRetryable(/try again|connection|could not reach/i.test(message));
      // The bag may have been emptied by a committed-but-lost order; resync so
      // the summary reflects reality rather than a stale local cache.
      await refresh();
    } finally {
      setSubmitting(false);
    }
  }

  if (confirmation) return <OrderConfirmation order={confirmation} upi={upi} />;

  if (cartStatus === 'loading' || cartStatus === 'idle') {
    return (
      <div className="mx-auto max-w-[1440px] px-5 py-12 sm:px-8">
        <ShopLoadingState label="Loading your bag" />
      </div>
    );
  }
  if (cartStatus === 'error') {
    return (
      <div className="mx-auto max-w-[1440px] px-5 py-12 sm:px-8">
        <ShopErrorState message="We could not load your bag." />
      </div>
    );
  }
  if (cart.items.length === 0) {
    return (
      <div className="mx-auto max-w-[1440px] px-5 py-16 sm:px-8">
        <ShopEmptyState title="There is nothing to check out"
          detail="Add a piece to your bag first, then come back here." />
        <p className="mt-8 text-center">
          <Link href="/shop" className="clout-link text-sm font-semibold">Browse the shop</Link>
        </p>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-[1440px] px-5 py-12 sm:px-8">
      {/* grid-cols-1 pins the mobile track to minmax(0,1fr); the implicit `auto`
          track has a min-content floor and the form is wider than a phone. */}
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1fr_24rem] lg:gap-16">
        <div className="min-w-0">
          <h2 className="clout-eyebrow">Delivery details</h2>
          <p className="mt-2 text-sm text-[#6b6b6b]">
            We use these only to deliver your order. No account is created and no password is requested.
          </p>

          <form onSubmit={handleSubmit} noValidate className="mt-6 max-w-xl space-y-5">
            {submitError && (
              <p role="alert" className="border border-[#e0c4c0] bg-[#fdf6f5] px-4 py-3 text-sm text-[#b3261e]">
                {submitError}
                {retryable && ' Your order may already exist — submitting again is safe.'}
              </p>
            )}

            <Field id="name" label="Full name" required error={errors.name} value={form.name}
              onChange={(v) => update('name', v)} autoComplete="name" />
            <Field id="phone" label="Phone number" required error={errors.phone} value={form.phone}
              onChange={(v) => update('phone', v)} autoComplete="tel" inputMode="tel" placeholder="98765 43210" />
            <Field id="address" label="Delivery address" required error={errors.address} value={form.address}
              onChange={(v) => update('address', v)} autoComplete="street-address" />
            <div className="grid gap-5 sm:grid-cols-2">
              <Field id="city" label="City / locality" required error={errors.city} value={form.city}
                onChange={(v) => update('city', v)} autoComplete="address-level2" />
              <Field id="state" label="State" required error={errors.state} value={form.state}
                onChange={(v) => update('state', v)} autoComplete="address-level1" />
            </div>
            <Field id="pincode" label="PIN code" required error={errors.pincode} value={form.pincode}
              onChange={(v) => update('pincode', v)} autoComplete="postal-code" inputMode="numeric" />
            <Field id="instructions" label="Delivery instructions (optional)" error={errors.instructions}
              value={form.instructions ?? ''} onChange={(v) => update('instructions', v)} />

            <p className="border border-[#e4e3df] bg-[#F6F5F1] px-4 py-3 text-xs leading-relaxed text-[#4a4a4a]">
              Placing this order creates a <strong>pending</strong> request only. Payment is
              <strong> not</strong> taken here and is <strong>not</strong> treated as confirmed — a
              staff member verifies it with you separately. Stock is held for your order while it is
              pending, but availability is re-checked before dispatch.
            </p>

            <button
              type="submit"
              disabled={submitting || cart.has_unavailable_items}
              className="inline-flex min-h-12 w-full items-center justify-center bg-[#101010] px-8 text-sm font-semibold text-white transition-colors hover:bg-[#2a2a2a] disabled:cursor-not-allowed disabled:bg-[#c9c7c2] sm:w-auto"
            >
              {submitting ? 'Placing your order…' : 'Place order'}
            </button>
            {cart.has_unavailable_items && (
              <p className="text-sm text-[#b3261e]">Remove the unavailable items in your bag to continue.</p>
            )}
          </form>
        </div>

        <aside className="lg:sticky lg:top-8 lg:self-start">
          <div className="border clout-rule p-6">
            <h2 className="clout-eyebrow">Your order</h2>
            <div className="mt-4 max-h-80 overflow-y-auto">
              <CartLinesList />
            </div>
            <dl className="mt-5 space-y-3 border-t clout-rule pt-4 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-[#6b6b6b]">Items</dt>
                <dd className="tabular-nums">{cart.item_count}</dd>
              </div>
              <div className="flex items-center justify-between border-t clout-rule pt-3 text-base font-semibold">
                <dt>Subtotal</dt>
                <dd className="tabular-nums">{formatMinor(cart.subtotal_minor_units, cart.currency)}</dd>
              </div>
            </dl>
            <p className="mt-2 text-xs text-[#6b6b6b]">
              Delivery charges and any applicable taxes are not yet calculated and are confirmed by staff.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Field({
  id, label, value, onChange, error, required, type = 'text',
  autoComplete, inputMode, placeholder,
}: {
  id: keyof CheckoutCustomer; label: string; value: string; onChange: (v: string) => void;
  error?: string; required?: boolean; type?: string;
  autoComplete?: string; inputMode?: 'text' | 'tel' | 'numeric'; placeholder?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="clout-eyebrow">
        {label}{required && <span aria-hidden> *</span>}
      </label>
      <input
        id={id} name={id} type={type} value={value} required={required}
        autoComplete={autoComplete} inputMode={inputMode} placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 min-h-11 w-full border border-[#d9d8d3] bg-white px-3 text-sm outline-none transition-colors focus:border-[#101010] aria-[invalid=true]:border-[#b3261e]"
      />
      {error && <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-[#b3261e]">{error}</p>}
    </div>
  );
}

/** Copy-to-clipboard button with a graceful fallback for older browsers. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        // Fallback for browsers without the async clipboard API.
        const field = document.createElement('textarea');
        field.value = value;
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.opacity = '0';
        document.body.appendChild(field);
        field.select();
        document.execCommand('copy');
        document.body.removeChild(field);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => { void copy(); }}
      className="border border-[#101010] px-4 py-2 text-sm font-semibold transition-colors hover:bg-[#101010] hover:text-white"
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

/**
 * Confirmation: order reference, pending status, the UPI payment step, and the
 * WhatsApp handoff.
 *
 * A payment declaration is the customer's own claim. It is labelled as
 * unverified everywhere and never changes `payment_status`, which stays
 * 'unverified' until staff confirm independently.
 */
function OrderConfirmation({ order, upi }: { order: CheckoutConfirmation; upi: UpiPayment | null }) {
  const [declared, setDeclared] = useState(order.payment_declared);
  const [reference, setReference] = useState('');
  const [submittingDeclaration, setSubmittingDeclaration] = useState(false);
  const [declarationError, setDeclarationError] = useState<string | null>(null);

  async function submitDeclaration() {
    setSubmittingDeclaration(true);
    setDeclarationError(null);
    try {
      const result = await declarePayment(reference);
      setDeclared(result.payment_declared);
      setReference('');
    } catch (error) {
      setDeclarationError(error instanceof Error ? error.message : 'We could not record that.');
    } finally {
      setSubmittingDeclaration(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="border clout-rule p-6 sm:p-8">
        <p className="clout-eyebrow">Order placed</p>
        <h2 className="clout-display mt-3 text-3xl">Thank you</h2>
        <p className="mt-3 text-sm text-[#4a4a4a]">
          Your order is <strong>pending review</strong> by our team. Payment is
          <strong> not</strong> confirmed — a staff member will verify it with you.
        </p>

        <div className="mt-6 border border-[#e4e3df] bg-[#F6F5F1] p-5 text-center">
          <p className="clout-eyebrow">Your order reference</p>
          <p className="mt-2 font-mono text-2xl font-semibold tracking-wider">{order.reference}</p>
          <p className="mt-1 text-xs text-[#6b6b6b]">Quote this reference if you contact us.</p>
        </div>

        <dl className="mt-6 space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <dt className="text-[#6b6b6b]">Order status</dt>
            <dd className="font-semibold capitalize">{order.status.replace(/_/g, ' ')}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-[#6b6b6b]">Payment status</dt>
            <dd className="font-semibold capitalize text-[#a4552d]">{order.payment_status}</dd>
          </div>
          <div className="flex items-center justify-between border-t clout-rule pt-3 text-base font-semibold">
            <dt>Order total</dt>
            <dd className="tabular-nums" data-testid="order-total">
              {formatMinor(order.subtotal_minor_units, order.currency)}
            </dd>
          </div>
        </dl>

        <ul className="mt-6 space-y-3 border-t clout-rule pt-5">
          {order.items.map((item, index) => (
            <li key={index} className="flex items-start justify-between gap-4 text-sm">
              <div>
                <p className="font-semibold">{item.product_name}</p>
                {item.options.length > 0 && (
                  <p className="mt-0.5 text-xs text-[#6b6b6b]">
                    {item.options.map((option) => `${option.name}: ${option.value}`).join(' · ')}
                  </p>
                )}
                {item.variant_display_name && item.options.length === 0 && (
                  <p className="mt-0.5 text-xs text-[#6b6b6b]">{item.variant_display_name}</p>
                )}
                <p className="mt-0.5 text-xs text-[#6b6b6b]">Quantity {item.quantity}</p>
              </div>
              <span className="shrink-0 tabular-nums">
                {formatMinor(item.line_total_minor_units, order.currency)}
              </span>
            </li>
          ))}
        </ul>
        {/* ── Step 3: pay by UPI ─────────────────────────────────────── */}
        <section className="mt-8 border-t clout-rule pt-6">
          <h3 className="clout-eyebrow">Step 2 — Pay by UPI</h3>

          {upi?.configured ? (
            <>
              <div className="mt-4 flex flex-col items-center gap-5 sm:flex-row sm:items-start">
                {upi.qr_data_url && (
                  <div className="shrink-0 border border-[#e4e3df] bg-white p-3">
                    <img
                      src={upi.qr_data_url}
                      alt={`UPI QR code to pay ${formatMinor(order.subtotal_minor_units, order.currency)} to ${upi.payee_name}`}
                      width={200}
                      height={200}
                      className="size-[200px]"
                    />
                  </div>
                )}

                <div className="min-w-0 flex-1">
                  <p className="text-sm text-[#4a4a4a]">
                    Scan the QR with any UPI app, or copy the UPI ID below and pay manually.
                  </p>

                  <dl className="mt-4 space-y-2 text-sm">
                    <div>
                      <dt className="clout-eyebrow">UPI ID</dt>
                      <dd className="mt-1 flex flex-wrap items-center gap-3">
                        <code className="break-all bg-[#F6F5F1] px-2 py-1 text-sm font-semibold">{upi.upi_id}</code>
                        <CopyButton value={upi.upi_id} label="Copy UPI ID" />
                      </dd>
                    </div>
                    <div>
                      <dt className="clout-eyebrow">Payable to</dt>
                      <dd className="mt-1">{upi.payee_name}</dd>
                    </div>
                    <div>
                      <dt className="clout-eyebrow">Exact amount</dt>
                      <dd className="mt-1 font-semibold tabular-nums">
                        {formatMinor(upi.amount_minor_units, upi.currency)}
                      </dd>
                    </div>
                  </dl>

                  {upi.upi_intent_url && (
                    <a
                      href={upi.upi_intent_url}
                      className="mt-4 inline-flex min-h-11 items-center justify-center border border-[#101010] px-5 text-sm font-semibold transition-colors hover:bg-[#101010] hover:text-white"
                    >
                      Open a UPI app
                    </a>
                  )}
                </div>
              </div>

              <ol className="mt-5 space-y-1.5 border border-[#e4e3df] bg-[#F6F5F1] px-4 py-4 text-xs leading-relaxed text-[#4a4a4a]">
                <li><strong>1.</strong> Open your UPI app (Paytm, PhonePe, Google Pay, BHIM).</li>
                <li><strong>2.</strong> Scan the QR, or choose &ldquo;Pay to UPI ID&rdquo; and enter the ID above.</li>
                <li><strong>3.</strong> Confirm the amount is <strong>{formatMinor(upi.amount_minor_units, upi.currency)}</strong> and pay.</li>
                <li><strong>4.</strong> Keep your UPI reference number — staff may ask for it.</li>
              </ol>
            </>
          ) : (
            <p className="mt-3 border border-[#e4e3df] bg-[#F6F5F1] px-4 py-3 text-sm text-[#4a4a4a]">
              UPI payment details are not available right now. Please contact us on WhatsApp and we
              will confirm your order and the total with you.
            </p>
          )}

          <p className="mt-4 border border-[#e0c4c0] bg-[#fdf6f5] px-4 py-3 text-xs text-[#b3261e]">
            This page does not take or confirm payment. Nothing is marked as paid until a staff
            member verifies the payment with you.
          </p>
        </section>

        {/* ── Step 4: WhatsApp handoff ───────────────────────────────── */}
        <section className="mt-8 border-t clout-rule pt-6">
          <h3 className="clout-eyebrow">Step 3 — Send your order to us</h3>

        {order.whatsapp_url ? (
          <div className="mt-8 border-t clout-rule pt-6">
            <a
              href={order.whatsapp_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-12 w-full items-center justify-center bg-[#101010] px-6 text-sm font-semibold text-white transition-colors hover:bg-[#2a2a2a]"
            >
              Continue on WhatsApp
            </a>
            <p className="mt-3 text-xs leading-relaxed text-[#6b6b6b]">
              This opens WhatsApp with a prepared message about order {order.reference}. You must
              review it and <strong>send it yourself</strong> — we cannot send it for you. Opening
              this link does not confirm payment, place a new order, or guarantee stock until our
              team confirms.
            </p>
          </div>
        ) : (
          <p className="mt-4 text-sm text-[#6b6b6b]">
            WhatsApp details are not configured right now. Keep your reference{' '}
            <strong>{order.reference}</strong> — our team will contact you to confirm this order and
            payment.
          </p>
        )}
        </section>

        {/* ── Step 5: unverified payment declaration ──────────────────── */}
        <section className="mt-8 border-t clout-rule pt-6">
          <h3 className="clout-eyebrow">Step 4 — Tell us if you have paid</h3>

          {declared ? (
            <p role="status" className="mt-3 border border-[#e4e3df] bg-[#F6F5F1] px-4 py-3 text-sm">
              Thank you — we have your declaration that payment was made. It is
              <strong> not</strong> verified yet; our team will confirm it with you before dispatch.
            </p>
          ) : (
            <>
              <p className="mt-2 text-sm text-[#4a4a4a]">
                If you have already paid by UPI, let us know so staff can check it faster. This is
                only your declaration — it does not confirm payment.
              </p>
              {declarationError && (
                <p role="alert" className="mt-3 border border-[#e0c4c0] bg-[#fdf6f5] px-4 py-3 text-sm text-[#b3261e]">
                  {declarationError}
                </p>
              )}
              <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <label htmlFor="upi-reference" className="clout-eyebrow">
                    UPI reference (optional)
                  </label>
                  <input
                    id="upi-reference"
                    value={reference}
                    onChange={(event) => setReference(event.target.value)}
                    maxLength={80}
                    placeholder="e.g. 412345678901"
                    className="mt-2 min-h-11 w-full border border-[#d9d8d3] bg-white px-3 text-sm outline-none transition-colors focus:border-[#101010]"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => { void submitDeclaration(); }}
                  disabled={submittingDeclaration}
                  className="inline-flex min-h-11 items-center justify-center border border-[#101010] px-5 text-sm font-semibold transition-colors hover:bg-[#101010] hover:text-white disabled:opacity-40"
                >
                  {submittingDeclaration ? 'Recording…' : 'I have paid'}
                </button>
              </div>
            </>
          )}
        </section>


        <p className="mt-8 text-center">
          <Link href="/shop" className="clout-link text-sm font-semibold">Continue shopping</Link>
        </p>
      </div>
    </div>
  );
}
