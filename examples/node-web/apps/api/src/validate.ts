// Request bodies are untrusted; these narrow `unknown` and name the bad field.
export class ValidationError extends Error {}

export function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown, field: string, { maxLength = 500 } = {}): string {
  if (typeof value !== "string" || value.trim() === "") throw new ValidationError(`${field} must be a non-empty string`);
  if (value.length > maxLength) throw new ValidationError(`${field} must be at most ${maxLength} characters`);
  return value.trim();
}

// Postgres INTEGER columns are 32-bit.
export const MAX_DB_INT = 2_147_483_647;

export function asPositiveInt(value: unknown, field: string, { allowZero = false, max = MAX_DB_INT } = {}): number {
  const min = allowZero ? 0 : 1;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${field} must be an integer from ${min} to ${max}`);
  }
  return value;
}

/** Path ids: digits only, so "0x10" or "1e3" never reach the database as a different number. */
export function parseId(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{1,10}$/.test(value)) return null;
  const id = Number(value);
  return id >= 1 && id <= MAX_DB_INT ? id : null;
}

/** Passwords are compared exactly as typed: no trimming. */
export function asPassword(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new ValidationError("password must be a non-empty string");
  if (value.length > 200) throw new ValidationError("password must be at most 200 characters");
  return value;
}
