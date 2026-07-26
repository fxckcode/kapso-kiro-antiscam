import { describe, expect, it, vi } from 'vitest';
import { QueuePublisher } from '../../src/queue/publisher';
import { ANALYSIS_EVENT_SCHEMA_VERSION, ANALYSIS_EVENT_TYPE, type AnalysisRequestedEvent } from '../../src/queue/events';

function validEvent(): AnalysisRequestedEvent {
  return {
    eventType: ANALYSIS_EVENT_TYPE,
    schemaVersion: ANALYSIS_EVENT_SCHEMA_VERSION,
    executionId: 'exec-0123456789abcdef0123456789abcdef',
    messageId: 'wamid.1',
    userId: 'abc123',
    routingToken: 'conv-1',
    redactedText: 'hola https://a.com/',
    urlReferences: [{ referenceId: 'url-0', reputationUrl: 'https://a.com/' }],
    receivedAt: new Date().toISOString(),
  };
}

describe('QueuePublisher', () => {
  it('publishes a valid canonical event', async () => {
    const send = vi.fn().mockResolvedValue({ MessageId: 'sqs-1' });
    const client = { send } as unknown as NonNullable<ConstructorParameters<typeof QueuePublisher>[0]['client']>;
    const publisher = new QueuePublisher({ queueUrl: 'https://sqs.example/q', client });

    await expect(publisher.publish(validEvent())).resolves.toEqual({ messageId: 'sqs-1' });
    const command = send.mock.calls[0]?.[0] as { input: { MessageBody: string; MessageAttributes: Record<string, unknown> } };
    expect(JSON.parse(command.input.MessageBody).eventType).toBe('analysis_requested');
    expect(command.input.MessageAttributes).toHaveProperty('eventType');
  });

  it('refuses invalid events before the SQS client is called', async () => {
    const send = vi.fn();
    const client = { send } as unknown as NonNullable<ConstructorParameters<typeof QueuePublisher>[0]['client']>;
    const publisher = new QueuePublisher({ queueUrl: 'https://sqs.example/q', client });
    await expect(publisher.publish({ ...validEvent(), routingToken: '' })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
