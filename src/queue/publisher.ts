/**
 * Publicacion del evento de analisis en SQS (Standard).
 *
 * Valida el evento contra el esquema antes de enviar (defensa en profundidad).
 * Adjunta atributos utiles para trazabilidad e idempotencia sin exponer datos
 * sensibles. La idempotencia real se apoya en `messageId` + (opcional) DynamoDB
 * del lado del processor; en Standard no hay dedup nativa.
 */
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  validateAnalysisEvent,
  type AnalysisRequestedEvent,
} from './events';

export interface PublishResult {
  readonly messageId: string | undefined;
}

export interface QueuePublisherOptions {
  readonly queueUrl: string;
  readonly client?: SQSClient;
  readonly region?: string;
}

export class QueuePublisher {
  private readonly client: SQSClient;
  private readonly queueUrl: string;

  constructor(options: QueuePublisherOptions) {
    this.queueUrl = options.queueUrl;
    this.client =
      options.client ??
      new SQSClient(options.region ? { region: options.region } : {});
  }

  async publish(event: AnalysisRequestedEvent): Promise<PublishResult> {
    const errors = validateAnalysisEvent(event);
    if (errors.length > 0) {
      throw new Error(`Refusing to publish invalid analysis event: ${errors.join('; ')}`);
    }

    const command = new SendMessageCommand({
      QueueUrl: this.queueUrl,
      MessageBody: JSON.stringify(event),
      MessageAttributes: {
        messageId: { DataType: 'String', StringValue: event.messageId },
        schemaVersion: { DataType: 'String', StringValue: String(event.schemaVersion) },
        eventType: { DataType: 'String', StringValue: event.eventType },
      },
    });

    const response = await this.client.send(command);
    return { messageId: response.MessageId };
  }
}
