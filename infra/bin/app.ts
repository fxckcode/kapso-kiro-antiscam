#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AntiScamBotStack } from '../lib/antiscambot-stack';

const app = new cdk.App();

new AntiScamBotStack(app, 'AntiScamBotStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    // Region preferida us-east-1 (PRD §9). Sobreescribible por env.
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'AntiScamBot - Kapso/WhatsApp ingest + async processor (hackathon MVP)',
});
