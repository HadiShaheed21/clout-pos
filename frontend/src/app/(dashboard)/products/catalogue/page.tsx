'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import toast from 'react-hot-toast';
import { ArrowDown, ArrowLeft, ArrowUp, ImagePlus, PackagePlus, Save, Trash2 } from 'lucide-react';
import api from '@/lib/api';
import type { Product, ProductVariant } from '@/lib/types';
import { useAuthStore } from '@/store/auth';

type OptionGroup = { id: string; name: string; values: { id: string; label: string; color_hex?: string | null }[] };
type GalleryImage = { id: string; uses_legacy_image: boolean | number; alt_text: string | null; sort_order: number; is_primary: boolean | number };
type CatalogueProduct = Product & { option_groups: OptionGroup[]; readiness: string[] };

const sizes = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];

export default function ProductCataloguePage() {
  const currentTenant = useAuthStore((state) => state.currentTenant);
  const isOwner = currentTenant?.role === 'owner';
  const searchParams = useSearchParams();
  const id = searchParams.get('id');
  const [product, setProduct] = useState<CatalogueProduct | null>(null);
  const [images, setImages] = useState<GalleryImage[]>([]);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [sizeValues, setSizeValues] = useState('S, M, L');
  const [colourValues, setColourValues] = useState('Black');
  const [allocation, setAllocation] = useState<Record<string, string>>({});
  const [newOptions, setNewOptions] = useState<Record<string, string>>({});
  const [newSku, setNewSku] = useState('');
  const [newBarcode, setNewBarcode] = useState('');
  const [newStock, setNewStock] = useState('0');

  // Gallery bytes come from an authenticated route, so each image is fetched with the
  // caller's token and shown as a short-lived object URL. An image the server declines
  // to serve stays as text rather than falling back to the unverified stored data URI.
  const loadImageUrls = async (gallery: GalleryImage[]) => {
    const entries = await Promise.all(gallery
      .filter((image) => !image.uses_legacy_image)
      .map(async (image) => {
        try {
          const response = await api.get(`/catalogue/products/${id}/images/${image.id}/data`, { responseType: 'blob' });
          return [image.id, URL.createObjectURL(response.data as Blob)] as const;
        } catch {
          return [image.id, ''] as const;
        }
      }));
    setImageUrls(Object.fromEntries(entries));
  };

  const load = async () => {
    if (!id) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [detail, gallery] = await Promise.all([api.get(`/catalogue/products/${id}`), api.get(`/catalogue/products/${id}/images`)]);
      setProduct(detail.data.product); setImages(gallery.data.images || []);
      await loadImageUrls(gallery.data.images || []);
    } catch (error: any) { toast.error(error.response?.data?.error || 'Unable to load catalogue product'); }
    finally { setLoading(false); }
  };
  useEffect(() => { if (id) void load(); }, [id]);
  useEffect(() => () => {
    Object.values(imageUrls).forEach((url) => { if (url) URL.revokeObjectURL(url); });
  }, [imageUrls]);

  const primaryImage = useMemo(() => images.find((image) => image.is_primary) || null, [images]);
  const primaryImageUrl = primaryImage ? imageUrls[primaryImage.id] || '' : '';

  const conversionRows = useMemo(() => {
    const size = sizeValues.split(',').map((value) => value.trim()).filter(Boolean);
    const colour = colourValues.split(',').map((value) => value.trim()).filter(Boolean);
    return size.flatMap((sizeValue) => colour.map((colourValue) => ({ key: `${sizeValue}|${colourValue}`, Size: sizeValue, Colour: colourValue })));
  }, [sizeValues, colourValues]);
  const allocationTotal = conversionRows.reduce((sum, row) => sum + (Number(allocation[row.key]) || 0), 0);

  const convert = async () => {
    if (!product) return;
    const rows = conversionRows.map((row) => ({ options: { Size: row.Size, Colour: row.Colour }, stock_quantity: Number(allocation[row.key]) || 0 }));
    if (!rows.length || allocationTotal !== product.stock_quantity) { toast.error(`Allocate exactly ${product.stock_quantity} whole units before converting.`); return; }
    try {
      await api.post(`/catalogue/products/${id}/convert-to-variants`, { option_groups: [{ name: 'Size', values: sizeValues.split(',').map((value) => value.trim()).filter(Boolean) }, { name: 'Colour', values: colourValues.split(',').map((value) => value.trim()).filter(Boolean) }], variants: rows });
      toast.success('Product converted to variants'); await load();
    } catch (error: any) { toast.error(error.response?.data?.error || 'Conversion failed; no stock was changed.'); }
  };
  const addVariant = async () => {
    try {
      await api.post(`/catalogue/products/${id}/variants`, { options: newOptions, sku: newSku || null, barcode: newBarcode || null, stock_quantity: Number(newStock), low_stock_threshold: 0 });
      setNewSku(''); setNewBarcode(''); setNewStock('0'); toast.success('Variant created'); await load();
    } catch (error: any) { toast.error(error.response?.data?.error || 'Could not create variant'); }
  };
  const updateVariant = async (variant: ProductVariant, patch: Record<string, unknown>) => {
    try { await api.patch(`/catalogue/variants/${variant.id}`, patch); await load(); }
    catch (error: any) { toast.error(error.response?.data?.error || 'Could not update variant'); }
  };
  const editVariant = async (variant: ProductVariant) => {
    const price = window.prompt('Price override (leave blank to use the product price):', variant.price_override == null ? '' : String(variant.price_override));
    if (price === null) return;
    const cost = window.prompt('Cost override (leave blank to use the product cost):', variant.cost_override == null ? '' : String(variant.cost_override));
    if (cost === null) return;
    const threshold = window.prompt('Low-stock threshold (whole units):', String(variant.low_stock_threshold));
    if (threshold === null) return;
    const patch: Record<string, unknown> = {
      price_override: price.trim() === '' ? null : Number(price),
      cost_override: cost.trim() === '' ? null : Number(cost),
      low_stock_threshold: Number(threshold),
    };
    if (isOwner) {
      const sku = window.prompt('SKU (release the existing assignment before changing it):', variant.sku || '');
      if (sku === null) return;
      const barcode = window.prompt('Barcode (release the existing assignment before changing it):', variant.barcode || '');
      if (barcode === null) return;
      patch.sku = sku.trim() || null;
      patch.barcode = barcode.trim() || null;
    }
    await updateVariant(variant, patch);
  };
  const adjust = async (variant: ProductVariant) => {
    const quantity = window.prompt(`Adjustment for ${variant.display_name} (whole units; negative allowed):`);
    const reason = window.prompt('Reason for this stock adjustment:');
    if (quantity === null || reason === null) return;
    try { await api.post(`/catalogue/variants/${variant.id}/stock-adjustments`, { quantity_delta: Number(quantity), reason }); toast.success('Stock adjusted'); await load(); }
    catch (error: any) { toast.error(error.response?.data?.error || 'Stock adjustment failed'); }
  };
  const release = async (type: 'sku' | 'barcode', value: string | null) => {
    if (!value) return;
    const reason = window.prompt(`Reason for releasing ${type.toUpperCase()} ${value}:`);
    if (!reason) return;
    try { await api.post(`/catalogue/identifiers/${type}/release`, { value, reason }); toast.success(`${type.toUpperCase()} released`); }
    catch (error: any) { toast.error(error.response?.data?.error || 'Only the owner can release identifiers'); }
  };
  const uploadImage = async (file?: File) => {
    if (!file) return;
    const dataUri = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
    try { await api.post(`/catalogue/products/${id}/images`, { data_uri: dataUri, alt_text: product?.name }); await load(); }
    catch (error: any) { toast.error(error.response?.data?.error || 'Image upload failed'); }
  };
  const publish = async (catalog_status: 'draft' | 'published' | 'unpublished') => {
    try { await api.patch(`/catalogue/products/${id}/publishing`, { catalog_status }); toast.success('Publishing status saved'); await load(); }
    catch (error: any) { toast.error(error.response?.data?.error || 'Product is not ready to publish'); }
  };
  if (loading) return <p className="p-6 text-muted-foreground">Loading catalogue…</p>;
  if (!id) return <p className="p-6 text-destructive">A product must be selected from Products.</p>;
  if (!product) return <p className="p-6 text-destructive">Product not found.</p>;
  return <div className="mx-auto max-w-5xl space-y-6 pb-10"><header><Link href="/products" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft size={15} /> Products</Link><h1 className="mt-3 text-3xl font-bold">{product.name} catalogue</h1><p className="mt-1 text-sm text-muted-foreground">Internal catalogue controls. Nothing here is publicly visible.</p></header>
    <section className="rounded-xl border border-border bg-card p-4"><h2 className="font-bold">Publishing</h2><div className="mt-3 flex flex-wrap gap-2">{(['draft', 'published', 'unpublished'] as const).map((status) => <button key={status} type="button" onClick={() => void publish(status)} className={`rounded-lg px-3 py-2 text-sm font-semibold ${product.catalog_status === status ? 'bg-brand text-white' : 'border border-border'}`}>{status}</button>)}</div>{product.readiness.length > 0 && <p className="mt-3 text-sm text-amber-700">Readiness: {product.readiness.join(', ')}</p>}</section>
    {!product.variant_mode ? <section className="rounded-xl border border-border bg-card p-4"><h2 className="font-bold">Convert stock to variants</h2><p className="mt-1 text-sm text-muted-foreground">Current stock: {product.stock_quantity}. Every unit must be allocated exactly once.</p><div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-sm">Sizes<input value={sizeValues} onChange={(event) => setSizeValues(event.target.value)} className="mt-1 w-full rounded border border-border p-2" /></label><label className="text-sm">Colours<input value={colourValues} onChange={(event) => setColourValues(event.target.value)} className="mt-1 w-full rounded border border-border p-2" /></label></div><div className="mt-4 grid gap-2 sm:grid-cols-2">{conversionRows.map((row) => <label key={row.key} className="flex items-center justify-between rounded border border-border p-2 text-sm">{row.Colour} / {row.Size}<input inputMode="numeric" min="0" value={allocation[row.key] || ''} onChange={(event) => setAllocation({ ...allocation, [row.key]: event.target.value })} className="w-20 rounded border border-border p-1" /></label>)}</div><p className={`mt-3 text-sm ${allocationTotal === product.stock_quantity ? 'text-emerald-700' : 'text-amber-700'}`}>Allocated: {allocationTotal} / {product.stock_quantity}</p><button type="button" onClick={() => void convert()} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 font-semibold text-white"><PackagePlus size={16} />Convert product</button></section> : <>
      <section className="rounded-xl border border-border bg-card p-4"><h2 className="font-bold">Add variant</h2><div className="mt-3 grid gap-3 sm:grid-cols-2">{product.option_groups.map((group) => <label key={group.id} className="text-sm">{group.name}<select value={newOptions[group.name] || ''} onChange={(event) => setNewOptions({ ...newOptions, [group.name]: event.target.value })} className="mt-1 w-full rounded border border-border p-2"><option value="">Select</option>{group.values.map((value) => <option key={value.id} value={value.label}>{value.label}</option>)}</select></label>)}<label className="text-sm">SKU<input value={newSku} onChange={(event) => setNewSku(event.target.value)} className="mt-1 w-full rounded border border-border p-2" /></label><label className="text-sm">Barcode<input value={newBarcode} onChange={(event) => setNewBarcode(event.target.value)} className="mt-1 w-full rounded border border-border p-2" /></label><label className="text-sm">Opening stock<input type="number" min="0" step="1" value={newStock} onChange={(event) => setNewStock(event.target.value)} className="mt-1 w-full rounded border border-border p-2" /></label></div><button type="button" onClick={() => void addVariant()} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 font-semibold text-white"><Save size={16} />Add variant</button></section>
      <section className="rounded-xl border border-border bg-card p-4"><h2 className="font-bold">Variants</h2><div className="mt-3 space-y-2">{(product.variants || []).map((variant) => <div key={variant.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3"><div className="min-w-36 flex-1"><p className="font-semibold">{variant.display_name}</p><p className="text-xs text-muted-foreground">{variant.sku || 'No SKU'} · {variant.barcode || 'No barcode'}</p></div><span className="text-sm">Stock: {variant.stock_quantity}</span><button type="button" onClick={() => void editVariant(variant)} className="rounded border border-border px-2 py-1 text-sm">Edit</button><button type="button" onClick={() => void adjust(variant)} className="rounded border border-border px-2 py-1 text-sm">Adjust</button><button type="button" onClick={() => void updateVariant(variant, { is_active: !variant.is_active })} className="rounded border border-border px-2 py-1 text-sm">{variant.is_active ? 'Deactivate' : 'Activate'}</button>{isOwner && <><button type="button" onClick={() => void release('sku', variant.sku)} disabled={!variant.sku} className="rounded border border-border px-2 py-1 text-sm disabled:opacity-40">Release SKU</button><button type="button" onClick={() => void release('barcode', variant.barcode)} disabled={!variant.barcode} className="rounded border border-border px-2 py-1 text-sm disabled:opacity-40">Release barcode</button></>}</div>)}</div></section>
    </>}
    <section className="rounded-xl border border-border bg-card p-4"><h2 className="font-bold">Image gallery</h2><label className="mt-3 inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-semibold"><ImagePlus size={16} />Upload image<input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => void uploadImage(event.target.files?.[0])} /></label>{primaryImageUrl && <figure className="mt-4"><img src={primaryImageUrl} alt={primaryImage?.alt_text || 'Primary product image'} className="max-h-72 w-full rounded-lg border border-border bg-muted object-contain" /><figcaption className="mt-1 text-xs text-muted-foreground">Primary image</figcaption></figure>}<div className="mt-4 space-y-2">{images.map((image, index) => <div key={image.id} className="flex items-center gap-2 rounded border border-border p-2 text-sm">{imageUrls[image.id] ? <img src={imageUrls[image.id]} alt={image.alt_text || 'Product image'} className="h-12 w-12 shrink-0 rounded border border-border bg-muted object-cover" /> : <span aria-hidden className="flex h-12 w-12 shrink-0 items-center justify-center rounded border border-border bg-muted text-[10px] uppercase text-muted-foreground">{image.uses_legacy_image ? 'legacy' : 'n/a'}</span>}<span className="flex-1">{image.uses_legacy_image ? 'Existing product image' : image.alt_text || 'Image'} {image.is_primary ? '(primary)' : ''}</span><button type="button" disabled={index === 0} onClick={() => void api.patch(`/catalogue/products/${id}/images/${image.id}`, { position: index - 1 }).then(load)} className="rounded border border-border p-1 disabled:opacity-40" aria-label="Move image up"><ArrowUp size={15} /></button><button type="button" disabled={index === images.length - 1} onClick={() => void api.patch(`/catalogue/products/${id}/images/${image.id}`, { position: index + 1 }).then(load)} className="rounded border border-border p-1 disabled:opacity-40" aria-label="Move image down"><ArrowDown size={15} /></button><button type="button" onClick={() => void api.patch(`/catalogue/products/${id}/images/${image.id}`, { is_primary: true }).then(load)} className="rounded border border-border px-2 py-1">Set primary</button>{!image.uses_legacy_image && <button type="button" onClick={() => void api.delete(`/catalogue/products/${id}/images/${image.id}`).then(load)} className="rounded border border-border p-1 text-destructive"><Trash2 size={15} /></button>}</div>)}</div>{images.length === 0 && <p className="mt-3 text-sm text-muted-foreground">No gallery images yet.</p>}</section>
  </div>;
}
