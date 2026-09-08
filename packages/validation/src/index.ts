/**
 * `@carl/validation` — schemas for data crossing Carl's application boundary.
 *
 * Frontend validation is user experience. Server validation is security. Database constraints
 * and RLS are the guarantee. Carl has all three, and this package is the middle one.
 */

export * from './primitives';
export { z } from 'zod';
