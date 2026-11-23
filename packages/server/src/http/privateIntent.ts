import { ApiError } from '@bangumi-analyzer/shared';
import type { FastifyRequest } from 'fastify';

/** An explicit same-origin Local management action, not authorization for remote clients. */
export function requirePrivateIntent(request: FastifyRequest, intent: 'hidden-works' | 'full-data'): void {
  let sameOrigin = request.headers['sec-fetch-site'] !== 'cross-site';
  if (request.headers.origin) {
    try { sameOrigin &&= new URL(request.headers.origin).origin === `${request.protocol}://${request.headers.host}`; }
    catch { sameOrigin=false; }
  }
  if (!sameOrigin || request.headers['x-analyzer-private-intent'] !== intent) {
    throw new ApiError('此操作需要在本机设置中明确确认。',{code:'private_intent_required',status:403,dataIntact:true});
  }
}
