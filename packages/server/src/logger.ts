import type { FastifyServerOptions } from 'fastify';

const SENSITIVE_KEYS = [
  'token',
  'accessToken',
  'access_token',
  'apiKey',
  'api_key',
  'authorization',
  'Authorization',
  'password',
  'secret',
  'cookie',
];

/** 日志中必须永久屏蔽的字段路径（Token 不允许出现在任何日志里）。 */
export const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  ...SENSITIVE_KEYS.map((key) => `*.${key}`),
  ...SENSITIVE_KEYS.map((key) => key),
];

export function buildLoggerOptions(): FastifyServerOptions['logger'] {
  const level = process.env.LOG_LEVEL ?? 'info';
  return {
    level,
    redact: { paths: redactPaths, censor: '[已隐藏]' },
    base: undefined,
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
  };
}

/**
 * 清洗任意字符串中的敏感信息，用于错误消息、URL 与同步日志。
 * 覆盖 `access_token=xxx`、`Authorization: Bearer xxx` 等常见形态。
 */
export function scrubSecrets(input: string, extraSecrets: string[] = []): string {
  let output = input;
  for (const secret of extraSecrets) {
    if (secret && secret.length >= 6) {
      output = output.split(secret).join('[已隐藏]');
    }
  }
  return output
    .replace(/(access_token|token|api_key|apikey)=[^&\s"']+/gi, '$1=[已隐藏]')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, '$1[已隐藏]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[已隐藏]');
}
