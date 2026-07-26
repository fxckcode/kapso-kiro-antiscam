import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Stack del MVP: ingreso (API Gateway + LambdaWebhook), cola (SQS + DLQ) y
 * procesador asincrono (LambdaProcessor). Todo con IAM de minimo privilegio via
 * grants. Reproducible y destruible con `cdk deploy` / `cdk destroy`.
 *
 * Estado (PRD §13):
 *  1. [PENDIENTE DE CONFIRMAR] Si Kapso responde por `kapsoConversationId`
 *     (enrutado por defecto) o exige el numero destino. La feature de ROUTING
 *     TOKEN CIFRADO (KMS) ya esta implementada pero DESACTIVADA por defecto; se
 *     habilita con el contexto `antiscambot:enableRoutingToken=true`. Nunca se
 *     guarda el telefono en claro en SQS, logs ni DynamoDB.
 *  2. [RESUELTO] Los secretos se pasan como *_ARN y los handlers los resuelven en
 *     cold start via src/lambda/shared/secrets.ts (Secrets Manager GetSecretValue),
 *     con fallback al valor directo en env para local/tests.
 *  3. [RESUELTO] Consentimiento persistido en DynamoDB (ConsentTable) con TTL.
 */
export class AntiScamBotStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const ctx = <T extends string>(key: string, fallback: T): string =>
      (this.node.tryGetContext(key) as string | undefined) ?? fallback;

    // Raiz del repo (un nivel arriba de infra/), donde vive src/ y el lockfile.
    const projectRoot = path.join(__dirname, '..', '..');
    const lockFile = path.join(projectRoot, 'package-lock.json');

    /* --------------------------------- Secrets -------------------------------- */
    const webhookSecret = new secrets.Secret(this, 'KapsoWebhookSecret', {
      description: 'Secreto para validar la firma del webhook de Kapso',
    });
    const userIdHmacSecret = new secrets.Secret(this, 'UserIdHmacSecret', {
      description: 'Secreto HMAC para seudonimizar el telefono (userId)',
    });
    const kapsoApiKey = new secrets.Secret(this, 'KapsoApiKey', {
      description: 'API key para enviar respuestas por Kapso',
    });

    /* ------------------------------- Cola + DLQ ------------------------------- */
    const processorTimeout = cdk.Duration.seconds(30);

    const dlq = new sqs.Queue(this, 'AnalysisDlq', {
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });

    const analysisQueue = new sqs.Queue(this, 'AnalysisQueue', {
      // Visibility >= 6x el timeout de la Lambda (recomendacion AWS).
      visibilityTimeout: cdk.Duration.seconds(processorTimeout.toSeconds() * 6),
      retentionPeriod: cdk.Duration.days(4),
      enforceSSL: true,
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });

    /* ------------------------------ ConsentTable ------------------------------ */
    // PK = userId (hash HMAC). TTL por atributo `ttl` (PRD §10). Solo estado, sin
    // datos sensibles. RemovalPolicy DESTROY para poder limpiar tras el hackathon.
    const consentTable = new dynamodb.Table(this, 'ConsentTable', {
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    /* --------------------------- IdempotencyTable --------------------------- */
    // PK = messageId opaco. Evita publicar/responder dos veces ante reintentos.
    const idempotencyTable = new dynamodb.Table(this, 'IdempotencyTable', {
      partitionKey: { name: 'messageId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    /* --------------------- KMS routing token (opcional) ----------------------- */
    // Solo se crea si antiscambot:enableRoutingToken = true. Por defecto NO existe.
    const enableRoutingToken =
      (this.node.tryGetContext('antiscambot:enableRoutingToken') as string | boolean | undefined) ===
        true ||
      this.node.tryGetContext('antiscambot:enableRoutingToken') === 'true';

    let routingKey: kms.Key | undefined;
    if (enableRoutingToken) {
      routingKey = new kms.Key(this, 'RoutingTokenKey', {
        description: 'Cifra el routing token (destino de respuesta) para AntiScamBot',
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        enableKeyRotation: true,
      });
    }

    /* ----------------------------- Config comun ------------------------------ */
    const commonBundling = {
      format: OutputFormat.CJS,
      target: 'node20',
      minify: true,
      sourceMap: true,
      // El runtime de Lambda (nodejs20) ya incluye AWS SDK v3.
      externalModules: ['@aws-sdk/*'],
    };

    const kapsoPhoneNumberId = this.node.tryGetContext('antiscambot:kapsoPhoneNumberId') as
      | string
      | undefined;

    const webhookBaseEnv: Record<string, string> = {
      LOG_LEVEL: ctx('antiscambot:logLevel', 'info'),
    };
    const processorBaseEnv: Record<string, string> = {
      ...webhookBaseEnv,
      // No hay modelo fijo en codigo: el valor debe llegar por contexto/CDK
      // antes de desplegar. `replace_me` produce un fallback seguro, no una
      // llamada valida a Bedrock.
      BEDROCK_MODEL_ID: ctx('antiscambot:bedrockModelId', 'replace_me'),
      // `AWS_REGION` no se declara aqui: es una variable reservada que el
      // runtime de Lambda inyecta con la region de la funcion. Fijarla a mano
      // hace fallar el synth y su valor seria identico a `this.region`.
      AGENT_TIMEOUT_MS: ctx('antiscambot:agentTimeoutMs', '20000'),
      // Mientras no exista un transporte VirusTotal auditado, PR-04 degrada la
      // consulta de reputacion y el agente continua con reglas/casos conocidos.
      VIRUSTOTAL_ENABLED: ctx('antiscambot:virustotalEnabled', 'false'),
      KAPSO_API_BASE_URL: ctx('antiscambot:kapsoApiBaseUrl', 'https://api.kapso.ai/meta/whatsapp/v24.0'),
      // ARNs de secretos (ver TODO del resolutor de secretos arriba).
      KAPSO_API_KEY_ARN: kapsoApiKey.secretArn,
      // Solo LambdaProcessor necesita el identificador para enviar por Kapso.
      ...(kapsoPhoneNumberId ? { KAPSO_PHONE_NUMBER_ID: kapsoPhoneNumberId } : {}),
    };

    /* ------------------------------ LambdaWebhook ----------------------------- */
    const webhookFn = new NodejsFunction(this, 'WebhookFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(projectRoot, 'src', 'lambda', 'webhook.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      depsLockFilePath: lockFile,
      projectRoot,
      bundling: commonBundling,
      environment: {
        ...webhookBaseEnv,
        SQS_QUEUE_URL: analysisQueue.queueUrl,
        IDEMPOTENCY_TABLE_NAME: idempotencyTable.tableName,
        MESSAGE_MAX_LENGTH: ctx('antiscambot:messageMaxLength', '4096'),
        DEFAULT_LOCALE: ctx('antiscambot:defaultLocale', 'es'),
        KAPSO_SIGNATURE_HEADER: ctx('antiscambot:kapsoSignatureHeader', 'x-webhook-signature'),
        KAPSO_WEBHOOK_SECRET_ARN: webhookSecret.secretArn,
        USER_ID_HMAC_SECRET_ARN: userIdHmacSecret.secretArn,
      },
    });

    // IAM minimo: publicar en la cola, leer secretos y llevar idempotencia.
    analysisQueue.grantSendMessages(webhookFn);
    webhookSecret.grantRead(webhookFn);
    userIdHmacSecret.grantRead(webhookFn);
    idempotencyTable.grantReadWriteData(webhookFn);

    /* ----------------------------- LambdaProcessor ---------------------------- */
    const processorFn = new NodejsFunction(this, 'ProcessorFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(projectRoot, 'src', 'lambda', 'processor.ts'),
      handler: 'handler',
      timeout: processorTimeout,
      memorySize: 512,
      depsLockFilePath: lockFile,
      projectRoot,
      bundling: commonBundling,
      environment: {
        ...processorBaseEnv,
        IDEMPOTENCY_TABLE_NAME: idempotencyTable.tableName,
      },
    });

    kapsoApiKey.grantRead(processorFn);
    idempotencyTable.grantReadWriteData(processorFn);
    // El modelo o inference profile se decide por contexto antes del deploy.
    // La politica se debe acotar a ese recurso al fijar el modelo de produccion.
    processorFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: ['*'],
      }),
    );

    // Routing token opcional: si esta habilitado, cablea la KMS key y los env.
    if (routingKey !== undefined) {
      routingKey.grantEncrypt(webhookFn);
      routingKey.grantDecrypt(processorFn);
      for (const fn of [webhookFn, processorFn]) {
        fn.addEnvironment('ENABLE_ROUTING_TOKEN', 'true');
        fn.addEnvironment('ROUTING_TOKEN_KMS_KEY_ID', routingKey.keyArn);
      }
    }

    // reportBatchItemFailures: solo los records fallidos se reintentan.
    processorFn.addEventSource(
      new SqsEventSource(analysisQueue, {
        batchSize: 5,
        maxBatchingWindow: cdk.Duration.seconds(5),
        reportBatchItemFailures: true,
      }),
    );

    /* ------------------------------- API Gateway ------------------------------ */
    const api = new apigw.RestApi(this, 'WebhookApi', {
      restApiName: 'antiscambot-webhook',
      description: 'Endpoint de ingreso del webhook de Kapso',
      deployOptions: { stageName: 'prod', throttlingRateLimit: 20, throttlingBurstLimit: 40 },
    });
    const webhookResource = api.root.addResource('webhook');
    webhookResource.addMethod('POST', new apigw.LambdaIntegration(webhookFn));
    webhookResource.addMethod('GET', new apigw.LambdaIntegration(webhookFn));

    /* --------------------------------- Alarmas -------------------------------- */
    new cloudwatch.Alarm(this, 'DlqNotEmptyAlarm', {
      alarmDescription: 'Hay mensajes en la DLQ de analisis',
      metric: dlq.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, 'WebhookErrorsAlarm', {
      alarmDescription: 'Errores en la LambdaWebhook',
      metric: webhookFn.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, 'ProcessorErrorsAlarm', {
      alarmDescription: 'Errores en la LambdaProcessor',
      metric: processorFn.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    /* --------------------------------- Outputs -------------------------------- */
    new cdk.CfnOutput(this, 'WebhookUrl', { value: `${api.url}webhook` });
    new cdk.CfnOutput(this, 'AnalysisQueueUrl', { value: analysisQueue.queueUrl });
    new cdk.CfnOutput(this, 'DlqUrl', { value: dlq.queueUrl });
    new cdk.CfnOutput(this, 'ConsentTableName', { value: consentTable.tableName });
    new cdk.CfnOutput(this, 'IdempotencyTableName', { value: idempotencyTable.tableName });
    new cdk.CfnOutput(this, 'WebhookSecretArn', { value: webhookSecret.secretArn });
    new cdk.CfnOutput(this, 'UserIdHmacSecretArn', { value: userIdHmacSecret.secretArn });
    new cdk.CfnOutput(this, 'KapsoApiKeyArn', { value: kapsoApiKey.secretArn });
  }
}
