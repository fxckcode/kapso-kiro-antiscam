import { describe, it, expect } from 'vitest';
import { parseWebhookBody } from '../../src/kapso/parser';

function wrap(value: unknown): string {
  return JSON.stringify(value);
}

function textPayload(body: string) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: '123' },
              conversation_id: 'conv-1',
              messages: [{ id: 'wamid.1', from: '+549110000000', type: 'text', text: { body } }],
            },
          },
        ],
      },
    ],
  };
}

describe('parseWebhookBody', () => {
  it('parses a valid text message', () => {
    const result = parseWebhookBody(wrap(textPayload('hola')));
    expect(result.kind).toBe('message');
    if (result.kind === 'message') {
      expect(result.message.id).toBe('wamid.1');
      expect(result.message.text?.body).toBe('hola');
      expect(result.conversationId).toBe('conv-1');
    }
  });

  it('returns invalid for non-JSON body', () => {
    expect(parseWebhookBody('{not json')).toEqual({ kind: 'invalid', reason: 'body_is_not_json' });
  });

  it('returns invalid when entry is missing', () => {
    expect(parseWebhookBody(wrap({ object: 'x' }))).toEqual({
      kind: 'invalid',
      reason: 'missing_entry_array',
    });
  });

  it('returns ignorable for empty entry', () => {
    expect(parseWebhookBody(wrap({ entry: [] }))).toEqual({ kind: 'ignorable', reason: 'empty_entry' });
  });

  it('returns ignorable for a status event', () => {
    const payload = {
      entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.1', status: 'delivered' }] } }] }],
    };
    expect(parseWebhookBody(wrap(payload))).toEqual({ kind: 'ignorable', reason: 'status_event' });
  });

  it('returns ignorable for an unsupported message type (audio)', () => {
    const payload = {
      entry: [{ changes: [{ value: { messages: [{ id: 'x', from: '+1', type: 'audio' }] } }] }],
    };
    expect(parseWebhookBody(wrap(payload))).toEqual({
      kind: 'ignorable',
      reason: 'unsupported_message_type',
    });
  });

  it('returns ignorable when there are no messages', () => {
    const payload = { entry: [{ changes: [{ value: { metadata: {} } }] }] };
    expect(parseWebhookBody(wrap(payload))).toEqual({ kind: 'ignorable', reason: 'no_messages' });
  });

  it('drops a text message without a body', () => {
    const payload = {
      entry: [{ changes: [{ value: { messages: [{ id: 'x', from: '+1', type: 'text' }] } }] }],
    };
    // No valid message and no status -> no_messages
    expect(parseWebhookBody(wrap(payload))).toEqual({ kind: 'ignorable', reason: 'no_messages' });
  });

  it('parses an image message with caption (Meta format)', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { id: 'img.1', from: '+1', type: 'image', image: { id: 'media-1', caption: 'mira' } },
                ],
              },
            },
          ],
        },
      ],
    };
    const result = parseWebhookBody(wrap(payload));
    expect(result.kind).toBe('message');
    if (result.kind === 'message') {
      expect(result.message.image?.id).toBe('media-1');
    }
  });
});

describe('parseWebhookBody - Kapso native format', () => {
  function receivedEvent(body: string) {
    return {
      message: {
        id: 'wamid.123',
        timestamp: '1730092800',
        type: 'text',
        from: '16315551181',
        text: { body },
        kapso: { direction: 'inbound', status: 'received' },
      },
      conversation: { id: 'conv_123', phone_number: '16315551181', phone_number_id: '999' },
      is_new_conversation: true,
      phone_number_id: '999',
    };
  }

  it('parses whatsapp.message.received (detected by header)', () => {
    const result = parseWebhookBody(wrap(receivedEvent('Hola')), 'whatsapp.message.received');
    expect(result.kind).toBe('message');
    if (result.kind === 'message') {
      expect(result.message.id).toBe('wamid.123');
      expect(result.message.from).toBe('16315551181');
      expect(result.message.text?.body).toBe('Hola');
      expect(result.conversationId).toBe('conv_123');
      expect(result.metadata.phone_number_id).toBe('999');
    }
  });

  it('detects native format by shape without a header', () => {
    const result = parseWebhookBody(wrap(receivedEvent('Hola')));
    expect(result.kind).toBe('message');
  });

  it('ignores outbound events (message.sent)', () => {
    const sent = {
      message: { id: 'wamid.456', type: 'text', to: '155', text: { body: 'x' }, kapso: { direction: 'outbound' } },
      conversation: { id: 'conv_1' },
      phone_number_id: '999',
    };
    expect(parseWebhookBody(wrap(sent), 'whatsapp.message.sent')).toEqual({
      kind: 'ignorable',
      reason: 'not_inbound',
    });
  });

  it('ignores conversation events without a message', () => {
    const conv = { conversation: { id: 'conv_1', status: 'active' }, phone_number_id: '999' };
    expect(parseWebhookBody(wrap(conv), 'whatsapp.conversation.created')).toEqual({
      kind: 'ignorable',
      reason: 'no_messages',
    });
  });

  it('ignores unsupported native types (audio)', () => {
    const audio = {
      message: { id: 'wamid.790', type: 'audio', from: '163', kapso: { direction: 'inbound' } },
      conversation: { id: 'conv_1' },
      phone_number_id: '999',
    };
    expect(parseWebhookBody(wrap(audio), 'whatsapp.message.received')).toEqual({
      kind: 'ignorable',
      reason: 'unsupported_message_type',
    });
  });

  it('falls back to conversation.phone_number when message.from is missing', () => {
    const noFrom = {
      message: { id: 'wamid.1', type: 'text', text: { body: 'hola' }, kapso: { direction: 'inbound' } },
      conversation: { id: 'conv_1', phone_number: '5215555555555' },
      phone_number_id: '999',
    };
    const result = parseWebhookBody(wrap(noFrom), 'whatsapp.message.received');
    expect(result.kind).toBe('message');
    if (result.kind === 'message') {
      expect(result.message.from).toBe('5215555555555');
    }
  });

  it('parses a native image message', () => {
    const img = {
      message: {
        id: 'wamid.789',
        type: 'image',
        from: '163',
        image: { id: 'media_id_123', caption: 'mira' },
        kapso: { direction: 'inbound', has_media: true },
      },
      conversation: { id: 'conv_1' },
      phone_number_id: '999',
    };
    const result = parseWebhookBody(wrap(img), 'whatsapp.message.received');
    expect(result.kind).toBe('message');
    if (result.kind === 'message') {
      expect(result.message.type).toBe('image');
      expect(result.message.image?.id).toBe('media_id_123');
    }
  });

  it('parses the first item of a buffered batch', () => {
    const batch = {
      type: 'whatsapp.message.received',
      batch: true,
      data: [receivedEvent('primero'), receivedEvent('segundo')],
    };
    const result = parseWebhookBody(wrap(batch), 'whatsapp.message.received');
    expect(result.kind).toBe('message');
    if (result.kind === 'message') {
      expect(result.message.text?.body).toBe('primero');
    }
  });
});
