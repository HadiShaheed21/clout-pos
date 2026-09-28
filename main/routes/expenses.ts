import { Router, Request, Response } from 'express';
import { generateShortId, getDatabase, now, withTxn } from '../db';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';

const router = Router();
const MAX_TEXT_LENGTH = 500;

function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
}

function expenseInput(body: Record<string, unknown>): { amount: number; category: string; description: string | null; expenseDate: string } | string {
  const amount = body.amount;
  const category = typeof body.category === 'string' ? body.category.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() || null : null;
  const expenseDate = body.expense_date;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return 'amount must be a finite number greater than zero';
  if (!category || category.length > 80) return 'category is required and must be 80 characters or fewer';
  if (description !== null && description.length > MAX_TEXT_LENGTH) return `description must be ${MAX_TEXT_LENGTH} characters or fewer`;
  if (!validDate(expenseDate)) return 'expense_date must use YYYY-MM-DD format';
  return { amount, category, description, expenseDate };
}

router.get('/', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const db = getDatabase();
    const params: unknown[] = [];
    const where = ['voided_at IS NULL'];
    if (validDate(req.query.start_date)) { where.push('expense_date >= ?'); params.push(req.query.start_date); }
    if (validDate(req.query.end_date)) { where.push('expense_date <= ?'); params.push(req.query.end_date); }
    if (typeof req.query.category === 'string' && req.query.category.trim()) { where.push('category = ?'); params.push(req.query.category.trim()); }
    const expenses = db.prepare(`SELECT * FROM expenses WHERE ${where.join(' AND ')} ORDER BY expense_date DESC, created_at DESC LIMIT 500`).all(...params);
    const total = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE ${where.join(' AND ')}`).get(...params) as { total: number };
    res.json({ expenses, total: total.total });
  } catch (error) {
    console.error('[API] Could not list expenses:', error);
    res.status(500).json({ error: 'Unable to list expenses' });
  }
});

router.post('/', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const input = expenseInput(req.body || {});
    if (typeof input === 'string') return res.status(400).json({ error: input });
    const id = generateShortId('expenses');
    const actor = String((req as any).user.userId);
    const createdAt = now();
    const db = getDatabase();
    withTxn(() => db.prepare(`INSERT INTO expenses (id, amount, category, description, expense_date, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.amount, input.category, input.description, input.expenseDate, actor, createdAt, createdAt));
    res.status(201).json({ expense: db.prepare('SELECT * FROM expenses WHERE id = ?').get(id) });
  } catch (error) {
    console.error('[API] Could not create expense:', error);
    res.status(500).json({ error: 'Unable to create expense' });
  }
});

router.put('/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const input = expenseInput(req.body || {});
    if (typeof input === 'string') return res.status(400).json({ error: input });
    const db = getDatabase();
    const result = db.prepare(`UPDATE expenses SET amount = ?, category = ?, description = ?, expense_date = ?, updated_at = ?
      WHERE id = ? AND voided_at IS NULL`).run(input.amount, input.category, input.description, input.expenseDate, now(), req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Expense not found or already voided' });
    res.json({ expense: db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id) });
  } catch (error) {
    console.error('[API] Could not update expense:', error);
    res.status(500).json({ error: 'Unable to update expense' });
  }
});

router.post('/:id/void', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (reason.length > MAX_TEXT_LENGTH) return res.status(400).json({ error: `reason must be ${MAX_TEXT_LENGTH} characters or fewer` });
    const db = getDatabase();
    const result = db.prepare(`UPDATE expenses SET voided_at = ?, voided_by = ?, void_reason = ?, updated_at = ?
      WHERE id = ? AND voided_at IS NULL`).run(now(), String((req as any).user.userId), reason || null, now(), req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Expense not found or already voided' });
    res.json({ success: true });
  } catch (error) {
    console.error('[API] Could not void expense:', error);
    res.status(500).json({ error: 'Unable to void expense' });
  }
});

export { router as expenseRoutes };
