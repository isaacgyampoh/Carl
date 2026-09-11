'use server';

import { revalidatePath } from 'next/cache';
import { ErrorCode } from '@carl/shared';
import { z } from '@carl/validation';

import { currentAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { actionFailed, actionOk, toActionResult, type ActionResult } from './errors';

const expenseSchema = z
  .object({
    branchId: z.uuid(),
    description: z.string().trim().min(2, 'Say what the money was for.').max(300),
    // In cedis as typed; stored in pesewas.
    amount: z.number().positive('The amount must be above zero.').max(1_000_000_000),
    method: z.enum(['CASH', 'MOMO', 'BANK_TRANSFER', 'CARD', 'OTHER']),
    reference: z.string().trim().max(120).optional(),
    expenseDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    categoryId: z.uuid().optional(),
  })
  .refine((v) => !(v.method === 'MOMO' || v.method === 'BANK_TRANSFER') || !!v.reference, {
    message: 'Mobile money and bank transfers need their transaction reference.',
    path: ['reference'],
  });

/**
 * Records money going out.
 *
 * `record_expense` existed and nothing in the app called it: the Expenses page could list and
 * approve expenses, but no one could record one, so reports and the dashboard could never
 * show what a business spends.
 *
 * The function decides everything that matters — `expenses.create` at this branch, access
 * to the branch, a business allowed to transact, and whether the entry needs approval
 * (anyone who cannot approve expenses has theirs queued for someone who can).
 */
export async function recordExpense(
  input: unknown,
): Promise<ActionResult<{ expenseId: string; reference: string }>> {
  try {
    const parsed = expenseSchema.parse(input);
    const auth = await currentAuth();
    if (!auth?.tenant) return actionFailed(ErrorCode.UNAUTHENTICATED, 'Sign in first.');

    const client = await supabase();
    const { data, error } = await client.rpc('record_expense', {
      p_branch_id: parsed.branchId,
      p_description: parsed.description,
      p_amount: Math.round(parsed.amount * 100),
      p_method: parsed.method,
      ...(parsed.reference ? { p_reference: parsed.reference } : {}),
      ...(parsed.expenseDate ? { p_expense_date: parsed.expenseDate } : {}),
      ...(parsed.categoryId ? { p_category_id: parsed.categoryId } : {}),
    });
    if (error) throw error;

    const row = data?.[0];
    if (!row?.expense_id) throw new Error('record_expense returned no expense');

    revalidatePath('/expenses');
    revalidatePath('/reports');
    revalidatePath('/dashboard');
    return actionOk({ expenseId: row.expense_id, reference: row.reference ?? '' });
  } catch (error) {
    const code = (error as { message?: string } | null)?.message;
    if (code === 'PAYMENT_REFERENCE_REQUIRED') {
      return actionFailed(
        'PAYMENT_REFERENCE_REQUIRED',
        'Mobile money and bank transfers need their transaction reference.',
      );
    }
    if (code === 'TENANT_SUSPENDED') {
      return actionFailed(ErrorCode.TENANT_SUSPENDED, 'This business is suspended.');
    }
    if (code === 'FORBIDDEN_BRANCH') {
      return actionFailed(ErrorCode.FORBIDDEN_BRANCH, 'You do not have access to that branch.');
    }
    return toActionResult(error);
  }
}
