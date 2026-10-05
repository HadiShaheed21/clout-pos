'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FolderPlus, GripVertical, Save } from 'lucide-react';
import api from '@/lib/api';
import type { Product } from '@/lib/types';

type Collection = {
  id: string; name: string; slug: string; description: string | null;
  is_active: boolean | number; sort_order: number;
  products: { product_id: string; product_name: string; sort_order: number }[];
};

export default function CollectionsPage() {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const load = async () => {
    try {
      const [collectionResponse, productResponse] = await Promise.all([api.get('/catalogue/collections'), api.get('/products')]);
      setCollections(collectionResponse.data.collections || []);
      setProducts(productResponse.data.products || []);
    } catch { toast.error('Unable to load collections.'); }
  };
  useEffect(() => { void load(); }, []);
  const create = async () => {
    const clean = name.trim();
    if (!clean) return;
    setSaving(true);
    try {
      await api.post('/catalogue/collections', { name: clean, slug: clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') });
      setName(''); await load(); toast.success('Collection created');
    } catch (error: any) { toast.error(error.response?.data?.error || 'Could not create collection'); }
    finally { setSaving(false); }
  };
  const toggleProduct = async (collection: Collection, productId: string) => {
    const current = collection.products.map((product) => product.product_id);
    const next = current.includes(productId) ? current.filter((id) => id !== productId) : [...current, productId];
    try { await api.put(`/catalogue/collections/${collection.id}/products`, { product_ids: next }); await load(); }
    catch (error: any) { toast.error(error.response?.data?.error || 'Could not update collection'); }
  };
  return <div className="mx-auto max-w-6xl space-y-6 pb-10">
    <header><p className="text-sm font-semibold text-brand">Internal catalogue</p><h1 className="mt-1 text-3xl font-bold">Collections</h1><p className="mt-2 text-sm text-muted-foreground">Organize products for future channels. Collections are not public in this phase.</p></header>
    <section className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4 sm:flex-row"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. New arrivals" className="min-h-11 flex-1 rounded-lg border border-border bg-background px-3" maxLength={120} /><button type="button" onClick={() => void create()} disabled={saving} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-brand px-4 font-semibold text-white disabled:opacity-60"><FolderPlus size={16} />Create collection</button></section>
    {collections.length === 0 ? <div className="rounded-xl border border-dashed border-border p-10 text-center text-muted-foreground">No collections yet.</div> : <div className="grid gap-4 lg:grid-cols-2">{collections.map((collection) => <section key={collection.id} className="rounded-xl border border-border bg-card"><div className="border-b border-border p-4"><div className="flex items-center justify-between gap-3"><div><h2 className="font-bold">{collection.name}</h2><p className="mt-1 text-xs text-muted-foreground">/{collection.slug} · {collection.products.length} products</p></div><span className={`rounded-full px-2 py-1 text-xs font-semibold ${collection.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-muted text-muted-foreground'}`}>{collection.is_active ? 'Active' : 'Inactive'}</span></div>{collection.description && <p className="mt-2 text-sm text-muted-foreground">{collection.description}</p>}</div><div className="max-h-80 overflow-y-auto p-3">{products.map((product) => { const selected = collection.products.some((member) => member.product_id === product.id); return <label key={product.id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 hover:bg-muted"><input type="checkbox" checked={selected} onChange={() => void toggleProduct(collection, product.id)} /><GripVertical size={15} className="text-muted-foreground" /><span className="min-w-0 flex-1 truncate text-sm">{product.name}</span>{product.variant_mode && <span className="text-xs text-muted-foreground">Variants</span>}</label>; })}</div><div className="border-t border-border px-4 py-3 text-xs text-muted-foreground"><Save className="mr-1 inline size-3" />Changes are saved internally and audited.</div></section>)}</div>}
  </div>;
}
