'use server';

import { revalidatePath } from 'next/cache';
import { z } from '@carl/validation';

import { requireTenant } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { actionOk, toActionResult, type ActionResult } from './errors';

const openSchema = z.object({
  registerId: z.uuid(),
  openingFloat: z.number().int().min(0),
});

const closeSchema = z.object({
  sessionId: z.uuid(),
  countedCash: z.number().int().min(0),
  varianceNote: z.string().trim().max(500).optional(),
});

const movementSchema = z.object({
  sessionId: z.uuid(),
  movementType: z.enum(['IN', 'OUT', 'DROP', 'PICKUP']),
  amount: z.number().int().positive(),
  reason: z.string().trim().min(3).max(200),
  notes: z.string().trim().max(500).optional(),
});

export async function openSession(input: unknown): Promise<ActionResult<{ sessionId: string }>> {
  try {
    const parsed = openSchema.parse(input);
    await requireTenant();

    const client = await supabase();
    const { data, error } = await client.rpc('open_cash_session', {
      p_register_id: parsed.registerId,
      p_opening_float: parsed.openingFloat,
    });
    if (error) throw error;

    revalidatePath('/register');
    return actionOk({ sessionId: data?.[0]?.session_id ?? '' });
  } catch (error) {
    return toActionResult(error);
  }
}

export async function closeSession(
  input: unknown,
): Promise<ActionResult<{ expected: number; counted: number; variance: number }>> {
  try {
    const parsed = closeSchema.parse(input);
    await requireTenant();

    const client = await supabase();
    const { data, error } = await client.rpc('close_cash_session', {
      p_session_id: parsed.sessionId,
      p_counted_cash: parsed.countedCash,
      p_variance_note: parsed.varianceNote,
    });
    if (error) throw error;

    revalidatePath('/register');
    const row = data?.[0];
    return actionOk({
      expected: row?.expected_cash ?? 0,
      counted: row?.counted_cash ?? 0,
      variance: row?.variance ?? 0,
    });
  } catch (error) {
    return toActionResult(error);
  }
}

export async function recordCashMovement(
  input: unknown,
): Promise<ActionResult<{ movementId: string }>> {
  try {
    const parsed = movementSchema.parse(input);
    await requireTenant();

    const client = await supabase();
    const { data, error } = await client.rpc('record_cash_movement', {
      p_session_id: parsed.sessionId,
      p_movement_type: parsed.movementType,
      p_amount: parsed.amount,
      p_reason: parsed.reason,
      p_notes: parsed.notes,
    });
    if (error) throw error;

    revalidatePath('/register');
    return actionOk({ movementId: data?.[0]?.movement_id ?? '' });
  } catch (error) {
    return toActionResult(error);
  }
}
