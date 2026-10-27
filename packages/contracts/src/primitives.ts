import { z } from 'zod';

export const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u,
    'IDs must be bounded opaque identifiers without whitespace',
  );
export const timestampSchema = z.iso.datetime({ offset: true, precision: 3 });
export const sequenceNumberSchema = z.number().int().positive();
export const nonBlankTextSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, 'Text must not be blank');
export const shortRationaleSchema = nonBlankTextSchema.max(800);

export function hasAtMostCodePoints(value: string, maximum: number): boolean {
  let count = 0;
  const iterator = value[Symbol.iterator]();
  for (let next = iterator.next(); !next.done; next = iterator.next()) {
    count += 1;
    if (count > maximum) return false;
  }
  return true;
}

export type Id = z.infer<typeof idSchema>;
export type Timestamp = z.infer<typeof timestampSchema>;
