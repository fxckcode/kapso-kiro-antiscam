import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REQUIRED_PLACEHOLDERS = [
  'KAPSO_WEBHOOK_SECRET',
  'KAPSO_API_KEY',
  'KAPSO_PHONE_NUMBER_ID',
  'SQS_QUEUE_URL',
  'IDEMPOTENCY_TABLE_NAME',
  'USER_ID_HMAC_SECRET',
] as const;

describe('.env.example', () => {
  it('uses replace_me for every operational credential placeholder', async () => {
    const content = await readFile(resolve(process.cwd(), '.env.example'), 'utf8');
    const entries = new Map(
      content
        .split(/\r?\n/u)
        .filter((line) => !line.trimStart().startsWith('#') && line.includes('='))
        .map((line) => {
          const index = line.indexOf('=');
          return [line.slice(0, index), line.slice(index + 1)] as const;
        }),
    );

    for (const key of REQUIRED_PLACEHOLDERS) {
      expect(entries.get(key)).toBe('replace_me');
    }
  });
});
