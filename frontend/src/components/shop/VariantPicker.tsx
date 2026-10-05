'use client';

import { useRef } from 'react';
import { cn } from '@/lib/utils';
import type { VariantOptionGroup, ShopVariant } from '@/lib/shop/types';

/**
 * Size and colour selection built on real radio inputs rather than divs.
 *
 * Native radios give arrow-key roving focus, a correct role for assistive
 * technology, and a form-associable checked state for free; the visual swatch
 * is drawn on top with `peer` styling. Sold-out options stay focusable but
 * disabled, so screen readers still announce them.
 */
export function VariantPicker({
  groups,
  selection,
  onChange,
  findVariantFor,
}: {
  groups: VariantOptionGroup[];
  selection: Record<string, string>;
  onChange: (group: string, value: string) => void;
  findVariantFor: (selection: Record<string, string>) => ShopVariant | null;
}) {
  return (
    <div className="space-y-7">
      {groups.map((group) => {
        const name = `shop-option-${group.name.toLowerCase()}`;
        return (
          <fieldset key={group.name}>
            <legend className="clout-eyebrow mb-3">{group.name}</legend>
            <div role="radiogroup" aria-label={group.name} className="flex flex-wrap gap-2.5">
              {group.values.map((option) => {
                const checked = selection[group.name] === option.label;
                const candidate = findVariantFor(
                  checked ? selection : { ...selection, [group.name]: option.label },
                );
                const soldOut = !candidate || candidate.stock_quantity <= 0;
                const isSwatch = group.name === 'Colour';

                return (
                  <label key={option.label} className="relative inline-flex cursor-pointer">
                    <input
                      type="radio"
                      name={name}
                      value={option.label}
                      checked={checked}
                      disabled={soldOut && !checked}
                      onChange={() => onChange(group.name, option.label)}
                      className="peer sr-only"
                    />
                    <span
                      className={cn(
                        'flex items-center justify-center border text-sm transition-colors',
                        isSwatch ? 'size-9 rounded-full' : 'h-11 min-w-13 rounded-sm px-3 font-medium',
                        'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[#101010]',
                        checked ? 'border-[#101010] ring-1 ring-[#101010]' : 'border-[#d8d7d2]',
                        soldOut && !checked
                          ? 'cursor-not-allowed text-[#b0aeaa] line-through opacity-60'
                          : 'hover:border-[#101010]',
                        isSwatch && soldOut && 'grayscale',
                      )}
                      style={isSwatch ? { background: option.colorHex ?? '#EEE' } : undefined}
                    >
                      {!isSwatch && option.label}
                      {isSwatch && <span className="sr-only">{option.label}{soldOut ? ' (sold out)' : ''}</span>}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}

/** Small stepper used for quantity on the product page. */
export function QuantityStepper({
  value,
  max,
  onChange,
  inputRef,
}: {
  value: number;
  max: number;
  onChange: (next: number) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const fallbackRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? fallbackRef;

  return (
    <div className="inline-flex items-center border border-[#d8d7d2]">
      <button
        type="button"
        onClick={() => onChange(Math.max(1, value - 1))}
        disabled={value <= 1}
        aria-label="Decrease quantity"
        className="flex size-11 items-center justify-center disabled:opacity-40"
      >
        −
      </button>
      <input
        ref={ref}
        type="number"
        inputMode="numeric"
        min={1}
        max={max}
        value={value}
        onChange={(event) => {
          const parsed = Number.parseInt(event.target.value, 10);
          if (Number.isFinite(parsed)) onChange(Math.min(Math.max(1, parsed), max));
        }}
        aria-label="Quantity"
        className="h-11 w-12 border-x border-[#d8d7d2] text-center text-sm tabular-nums [appearance:textfield] focus:outline-none"
      />
      <button
        type="button"
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
        aria-label="Increase quantity"
        className="flex size-11 items-center justify-center disabled:opacity-40"
      >
        +
      </button>
    </div>
  );
}
