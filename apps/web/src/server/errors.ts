import 'server-only';

import { type CarlError, ErrorCode, isCarlError } from '@carl/shared';
import { toCarlError } from '@carl/database';
import { z } from '@carl/validation';

/**
 * The shape every server action returns.
 *
 * Actions never throw across the boundary. An unhandled server-action rejection reaches
 * the browser as a generic digest with no message — the cashier sees "an error occurred"
 * and the actual cause is only in a server log nobody is reading during a shift.
 *
 * Returning a discriminated union instead means the UI has something specific to render
 * and the type system makes handling it non-optional.
 */
export type ActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      /** Field-level messages, keyed by field name, when validation failed. */
      readonly fieldErrors?: Record<string, string>;
    };

export function actionOk<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

export function actionFailed(
  code: string,
  message: string,
  fieldErrors?: Record<string, string>,
): ActionResult<never> {
  return fieldErrors === undefined
    ? { ok: false, code, message }
    : { ok: false, code, message, fieldErrors };
}

/**
 * Turns anything thrown inside an action into a result the UI can render.
 *
 * Deliberately does not echo an unrecognised error's text: a PostgreSQL constraint message
 * names tables and columns, which is a disclosure. The original is logged server-side.
 */
export function toActionResult(error: unknown): ActionResult<never> {
  if (error instanceof z.ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of error.issues) {
      const path = issue.path.join('.');
      fieldErrors[path || '_'] = issue.message;
    }
    return actionFailed(
      ErrorCode.VALIDATION_FAILED,
      'Some of the details are not valid.',
      fieldErrors,
    );
  }

  const carl: CarlError = isCarlError(error) ? error : toCarlError(error);
  return actionFailed(carl.code, carl.message);
}
