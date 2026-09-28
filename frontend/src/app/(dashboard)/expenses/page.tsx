'use client';

import { FormEvent, useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';

type Expense = { id: string; amount: number; category: string; description: string | null; expense_date: string; created_at: string };
const today = () => new Date().toISOString().slice(0, 10);

export default function ExpensesPage() {
  const fmt = useFormatCurrency();
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [total, setTotal] = useState(0);
  const [startDate, setStartDate] = useState(today());
  const [endDate, setEndDate] = useState(today());
  const [category, setCategory] = useState('');
  const [form, setForm] = useState({ amount: '', category: '', description: '', expense_date: today() });

  const load = async () => {
    try {
      const { data } = await api.get('/expenses', { params: { start_date: startDate, end_date: endDate, category: category || undefined } });
      setExpenses(data.expenses || []);
      setTotal(Number(data.total || 0));
    } catch { toast.error('Could not load expenses'); }
  };
  useEffect(() => { void load(); }, [startDate, endDate, category]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const amount = Number(form.amount);
    if (!Number.isFinite(amount) || amount <= 0 || !form.category.trim()) {
      toast.error('Enter a positive amount and category');
      return;
    }
    try {
      await api.post('/expenses', { ...form, amount, category: form.category.trim(), description: form.description.trim() || null });
      setForm({ amount: '', category: '', description: '', expense_date: today() });
      await load();
      toast.success('Expense recorded');
    } catch (error: any) { toast.error(error.response?.data?.error || 'Could not record expense'); }
  };

  const voidExpense = async (expense: Expense) => {
    if (!window.confirm(`Void ${expense.category} expense?`)) return;
    try { await api.post(`/expenses/${expense.id}/void`, { reason: 'Voided from expenses screen' }); await load(); }
    catch { toast.error('Could not void expense'); }
  };

  return <div className="p-6 space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-bold">Expenses</h1><p className="text-sm text-muted-foreground">Recorded business expenses, excluding voided entries.</p></div><div className="rounded-lg border bg-card px-4 py-2"><p className="text-xs text-muted-foreground">Period total</p><p className="font-bold">{fmt(total)}</p></div></div>
    <form onSubmit={submit} className="grid gap-3 rounded-xl border bg-card p-4 md:grid-cols-5">
      <input aria-label="Amount" required min="0.01" step="0.01" type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="Amount" className="rounded-lg border bg-background px-3 py-2" />
      <input aria-label="Category" required maxLength={80} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="Category" className="rounded-lg border bg-background px-3 py-2" />
      <input aria-label="Description" maxLength={500} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Description (optional)" className="rounded-lg border bg-background px-3 py-2" />
      <input aria-label="Expense date" required type="date" value={form.expense_date} onChange={(e) => setForm({ ...form, expense_date: e.target.value })} className="rounded-lg border bg-background px-3 py-2" />
      <Button type="submit"><Plus size={16} className="me-1" />Add expense</Button>
    </form>
    <div className="flex flex-wrap gap-3"><input aria-label="Start date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="rounded-lg border bg-card px-3 py-2" /><input aria-label="End date" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="rounded-lg border bg-card px-3 py-2" /><input aria-label="Filter category" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Filter category" className="rounded-lg border bg-card px-3 py-2" /></div>
    <div className="overflow-x-auto rounded-xl border bg-card"><table className="w-full text-sm"><thead className="bg-muted text-start"><tr><th className="p-3 text-start">Date</th><th className="p-3 text-start">Category</th><th className="p-3 text-start">Description</th><th className="p-3 text-end">Amount</th><th className="p-3" /></tr></thead><tbody>{expenses.map((expense) => <tr key={expense.id} className="border-t"><td className="p-3">{expense.expense_date}</td><td className="p-3 font-medium">{expense.category}</td><td className="p-3 text-muted-foreground">{expense.description || '—'}</td><td className="p-3 text-end">{fmt(expense.amount)}</td><td className="p-3 text-end"><button onClick={() => void voidExpense(expense)} className="text-muted-foreground hover:text-destructive" aria-label="Void expense"><Trash2 size={16} /></button></td></tr>)}</tbody></table>{expenses.length === 0 && <p className="p-10 text-center text-muted-foreground">No expenses in this period.</p>}</div>
  </div>;
}
