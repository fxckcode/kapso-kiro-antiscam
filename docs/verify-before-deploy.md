# Verificación antes del despliegue

La integración Strands se añadió a `package.json`, pero el lockfile raíz no se
regeneró en esta máquina porque `npm` no puede verificar el certificado. Un
integrante con acceso normal al registro debe ejecutar estos comandos, revisar
los cambios de `package-lock.json` y no desplegar si alguno falla:

```sh
npm install
npm run typecheck
npm test
cd infra
npm ci
npm run build
npm run synth
```

Antes del despliegue, configure un `BEDROCK_MODEL_ID` o inference profile real,
mantenga `VIRUSTOTAL_ENABLED=false` hasta implementar su transporte auditado y
restrinja la política `bedrock:InvokeModel` al recurso elegido.
