import "dotenv/config";

/**
 * Reads a required environment variable, or throws.
 *
 * Importing this module loads `.env` as a side effect, so any module that reads
 * `process.env` at import time should import from here first.
 */
export function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}
