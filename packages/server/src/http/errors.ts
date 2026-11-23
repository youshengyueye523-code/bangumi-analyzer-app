import { ApiError, type ApiErrorPayload } from '@bangumi-analyzer/shared';
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { BangumiApiError } from '../bangumi/client.js';
import { scrubSecrets } from '../logger.js';

export interface MappedError {
  status: number;
  payload: ApiErrorPayload;
}

/** 把内部错误映射为「发生了什么 / 为什么 / 是否影响已有数据 / 怎么办」。 */
export function mapError(error: unknown, options: { development?: boolean } = {}): MappedError {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      payload: {
        error: {
          code: error.code,
          message: scrubSecrets(error.message),
          hint: error.hint,
          dataIntact: error.dataIntact,
          resultUnknown: error.resultUnknown || undefined,
        },
      },
    };
  }

  if (error instanceof BangumiApiError) {
    const status =
      error.kind === 'auth' || error.kind === 'forbidden'
        ? 502
        : error.kind === 'not_found'
          ? 404
          : error.kind === 'rate_limit'
            ? 429
            : error.kind === 'timeout' || error.kind === 'network'
              ? 504
              : 502;
    return {
      status,
      payload: {
        error: {
          code: `bangumi_${error.kind}`,
          message: scrubSecrets(error.message),
          hint: error.hint || undefined,
          dataIntact: true,
        },
      },
    };
  }

  if (error instanceof ZodError) {
    return {
      status: 400,
      payload: {
        error: {
          code: 'invalid_request',
          message: '请求参数不合法',
          hint: '请检查筛选条件或表单内容后重试。',
          dataIntact: true,
          detail: error.issues
            .slice(0, 5)
            .map((issue) => `${issue.path.join('.') || '参数'}: ${issue.message}`)
            .join('; '),
        },
      },
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  const isDatabaseError = /SQLITE|database/i.test(message);
  return {
    status: 500,
    payload: {
      error: {
        code: isDatabaseError ? 'database_error' : 'internal_error',
        message: isDatabaseError ? '本地数据库操作失败' : '服务器内部错误',
        hint: isDatabaseError
          ? '请停止服务后检查 data 目录下的数据库文件；已有数据通常不会丢失，可在「设置 → 备份」中查看备份。'
          : '请查看服务端日志（data/logs 或启动终端）了解详细信息。',
        dataIntact: true,
        detail: options.development ? scrubSecrets(message) : undefined,
      },
    },
  };
}

export function registerErrorHandler(app: FastifyInstance, development: boolean): void {
  app.setErrorHandler((error, request, reply) => {
    const mapped = mapError(error, { development });
    if (mapped.status >= 500) {
      request.log.error({ err: error }, 'request failed');
    } else {
      request.log.warn({ err: error }, 'request rejected');
    }
    return reply.status(mapped.status).send(mapped.payload);
  });
}

export function apiNotFoundPayload(url: string): ApiErrorPayload {
  return {
    error: {
      code: 'not_found',
      message: `接口不存在：${url}`,
      dataIntact: true,
    },
  };
}
