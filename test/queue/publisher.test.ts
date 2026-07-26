import { describe, it, expect, vi } from 'vitest';
import { QueuePublisher } from '../../src/queue/publisher';
import {
  ANALYSIS_EVENT_SCHEMA_VERSION,
  type AnalysisRequestedEvent,
} from '../../src/queue/events';

function validEvent(): AnalysisRequestedEvent {
  return {
    schemaVersion: ANALYSIS_EVENT_SCHEMA_VERSION,
    messageId: 'wamid.1',
    userId: 'abc123',
    provider: 'kapso',
    channel: 'whatsapp',
    receivedAt: new Date().toISOString(),
    message: {
      type: 'text',
      locale: 'es',
      redactedText: 'hola [URL_0]',
      urlReferences: [{ referenceId: 'url-0', sanitizedUrl: 'https://a.com/', domain: 'a.com' }],
      media: [],
    },
    meta: { kapsoConversationId: 'conv-1', hadSensitiveData: false },
  };
}

describe('QueuePublisher', () => {
  it('publishes a valid event and returns the SQS message id', async () => {
    const send = vi.fn().mockResolvedValue({ MessageId: 'sqs-1' });
    const client = { send } as unknown as NonNullable<
      ConstructorParameters<typeof QueuePublisher>[0]['client']
    >;
    const publisher = new QueuePublisher({ queueUrl: 'https://sqs/q', client });

    const result = await publisher.publish(validEvent());

    expect(result.messageId).toBe('sqs-1');
    expect(send).toHaveBeenCalledOnce();
    const command = send.mock.calls[0]?.[0] as { input: { MessageBody: string; QueueUrl: string } };
    expect(command.input.QueueUrl).toBe('https://sqs/q');
    const bodySent = JSON.parse(command.input.MessageBody);
    expect(bodySent.messageId).toBe('wamid.1');
  });

  it('refuses to publish an invalid event', async () => {
    const send = vi.fn();
    const client = { send } as unknown as NonNullable<
      ConstructorParameters<typeof QueuePublisher>[0]['client']
    >;
    const publisher = new QueuePublisher({ queueUrl: 'https://sqs/q', client });

    const bad = { ...validEvent(), messageId: '' };
    await expect(publisher.publish(bad as AnalysisRequestedEvent)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
