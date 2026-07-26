import { describe, it, expect } from 'vitest';
import { normalizeInbound, extractUrls } from '../../src/messaging/normalizer';
import type { KapsoInboundMessage, KapsoMetadata } from '../../src/kapso/types';

const metadata: KapsoMetadata = { phone_number_id: '123' };

function textMessage(body: string, timestamp?: string): KapsoInboundMessage {
  return {
    id: 'wamid.1',
    from: '+5491100000000',
    type: 'text',
    ...(timestamp !== undefined ? { timestamp } : {}),
    text: { body },
  };
}

describe('extractUrls', () => {
  it('extracts http/https urls', () => {
    expect(extractUrls('visita https://a.com y http://b.org ya')).toEqual([
      'https://a.com',
      'http://b.org',
    ]);
  });

  it('strips trailing punctuation', () => {
    expect(extractUrls('mira esto: https://a.com.')).toEqual(['https://a.com']);
  });

  it('dedupes repeated urls', () => {
    expect(extractUrls('https://a.com https://a.com')).toEqual(['https://a.com']);
  });

  it('returns empty when there are no urls', () => {
    expect(extractUrls('sin enlaces')).toEqual([]);
  });
});

describe('normalizeInbound', () => {
  it('normalizes a text message', () => {
    const result = normalizeInbound(textMessage('hola https://a.com'), metadata, 'conv-1');
    expect(result.messageId).toBe('wamid.1');
    expect(result.rawPhone).toBe('+5491100000000');
    expect(result.type).toBe('text');
    expect(result.rawText).toBe('hola https://a.com');
    expect(result.urlCandidates).toEqual(['https://a.com']);
    expect(result.conversationId).toBe('conv-1');
    expect(result.locale).toBe('es');
  });

  it('converts epoch-seconds timestamp to ISO', () => {
    const result = normalizeInbound(textMessage('hola', '1700000000'), metadata, undefined);
    expect(result.receivedAt).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it('builds a media reference for images', () => {
    const image: KapsoInboundMessage = {
      id: 'img.1',
      from: '+5491100000000',
      type: 'image',
      image: { id: 'media-1', mime_type: 'image/jpeg', caption: 'mira https://x.com' },
    };
    const result = normalizeInbound(image, metadata, undefined);
    expect(result.type).toBe('image');
    expect(result.media).toHaveLength(1);
    expect(result.media[0]?.storageKey).toContain('media-1');
    expect(result.urlCandidates).toEqual(['https://x.com']);
  });
});
