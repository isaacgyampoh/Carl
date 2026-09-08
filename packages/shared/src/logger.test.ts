import { describe, expect, it } from 'vitest';
import { createLogger, redact } from './logger';

describe('redaction', () => {
  it('removes credentials wherever they are nested', () => {
    const redacted = redact({
      tenantId: 't1',
      device: { deviceSecret: 'super-secret', name: 'POS-ACCRA-001' },
      headers: { authorization: 'Bearer abc' },
      list: [{ activation_code: 'AAAA-BBBB' }],
    });

    expect(redacted).toEqual({
      tenantId: 't1',
      device: { deviceSecret: '[redacted]', name: 'POS-ACCRA-001' },
      headers: { authorization: '[redacted]' },
      list: [{ activation_code: '[redacted]' }],
    });
  });

  it('matches key names regardless of casing or separators', () => {
    const out = redact({ SERVICE_ROLE_KEY: 'x', 'api-key': 'y', refreshToken: 'z' }) as Record<
      string,
      unknown
    >;
    expect(Object.values(out)).toEqual(['[redacted]', '[redacted]', '[redacted]']);
  });
});

describe('logger', () => {
  it('emits one JSON object per line with merged context', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'debug', sink: (l) => lines.push(l), base: { app: 'carl' } });
    log.child({ tenantId: 't1' }).info('sale completed', { saleId: 's1' });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: 'info',
      message: 'sale completed',
      app: 'carl',
      tenantId: 't1',
      saleId: 's1',
    });
  });

  it('suppresses records below the configured level', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'warn', sink: (l) => lines.push(l) });
    log.info('ignored');
    log.debug('ignored');
    log.error('kept');
    expect(lines).toHaveLength(1);
  });
});
