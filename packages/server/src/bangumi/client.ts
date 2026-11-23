import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import {
  bgmCollectionPageSchema,
  bgmMeSchema,
  bgmPersonRelationSchema,
  bgmSubjectRelationSchema,
  bgmSubjectSchema,
  type BgmSubject,
  type BgmSubjectRelation,
  type BgmPersonRelation,
  type BgmMe,
} from '@bangumi-analyzer/shared';
import { scrubSecrets } from '../logger.js';
import { backoffDelay, isAbortError, sleep } from '../util.js';
import { RateLimiter } from './rate-limiter.js';
import { rememberSubjectSource } from './subjectSource.js';

export const BANGUMI_BASE_URL = 'https://api.bgm.tv';

export type BangumiErrorKind =
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'rate_limit'
  | 'server'
  | 'network'
  | 'timeout'
  | 'parse'
  | 'aborted';

export class BangumiApiError extends Error {
  readonly kind: BangumiErrorKind;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly hint: string;

  constructor(
    kind: BangumiErrorKind,
    message: string,
    options: { status?: number | null; retryable?: boolean; hint?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'BangumiApiError';
    this.kind = kind;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.hint = options.hint ?? '';
  }
}

export interface BangumiClientStats {
  requests: number;
  retries: number;
  throttled: number;
  lastRequestMs: number;
}

export interface BangumiClientOptions {
  token: string;
  userAgent: string;
  requestIntervalMs: number;
  httpProxy: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** 重试基础等待时间（毫秒），指数退避的起点 */
  retryBaseDelayMs?: number;
  /** 收到 429 且未提供 Retry-After 时的默认冷却时间（毫秒） */
  rateLimitCooldownMs?: number;
  baseUrl?: string;
  /** 便于测试注入 */
  fetchImpl?: typeof undiciFetch;
  dispatcher?: Dispatcher;
  onEvent?: (event: { type: 'retry' | 'throttled' | 'request'; message: string; attempt: number }) => void;
}

export interface RequestOptions {
  signal?: AbortSignal;
  /** 单次请求的重试次数覆盖 */
  maxRetries?: number;
}

/**
 * 同步引擎依赖的数据源接口。
 * 真实实现是 `BangumiClient`，测试中可以注入可控的假实现，
 * 从而稳定复现限流、超时、字段缺失等异常场景。
 */
export interface BangumiDataSource {
  readonly stats: BangumiClientStats;
  updateOptions(patch: Partial<BangumiClientOptions>): void;
  getMe(options?: RequestOptions): Promise<BgmMe>;
  getUser(username: string, options?: RequestOptions): Promise<BgmMe>;
  getCollectionsPage(
    username: string,
    params: { subjectType?: number; collectionType?: number; limit: number; offset: number },
    options?: RequestOptions,
  ): Promise<{ total: number; limit: number; offset: number; data: unknown[] }>;
  getSubject(subjectId: number, options?: RequestOptions): Promise<BgmSubject>;
  getSubjectRelations(
    subjectId: number,
    options?: RequestOptions,
  ): Promise<BgmSubjectRelation[]>;
  getSubjectPersons(
    subjectId: number,
    options?: RequestOptions,
  ): Promise<BgmPersonRelation[]>;
  fetchImage(
    url: string,
    options?: RequestOptions,
  ): Promise<{ data: Uint8Array; contentType: string | null }>;
}

interface ErrorBody {
  title?: string;
  description?: string;
  details?: unknown;
}

export class BangumiClient implements BangumiDataSource {
  private options: BangumiClientOptions;
  private readonly limiter: RateLimiter;
  private dispatcher: Dispatcher | null;
  readonly stats: BangumiClientStats = { requests: 0, retries: 0, throttled: 0, lastRequestMs: 0 };

  constructor(options: BangumiClientOptions) {
    this.options = { timeoutMs: 20_000, maxRetries: 4, baseUrl: BANGUMI_BASE_URL, ...options };
    this.limiter = new RateLimiter(options.requestIntervalMs);
    this.dispatcher = this.createDispatcher(options);
  }

  /** 更新凭据/限流设置（同步开始前由引擎调用）。 */
  updateOptions(patch: Partial<BangumiClientOptions>): void {
    const previousProxy = this.options.httpProxy;
    this.options = { ...this.options, ...patch };
    if (patch.requestIntervalMs !== undefined) this.limiter.setInterval(patch.requestIntervalMs);
    if (patch.httpProxy !== undefined && patch.httpProxy !== previousProxy) {
      this.dispatcher = this.createDispatcher(this.options);
    }
  }

  get intervalMs(): number {
    return this.limiter.currentIntervalMs;
  }

  private createDispatcher(options: BangumiClientOptions): Dispatcher | null {
    if (options.dispatcher) return options.dispatcher;
    const proxy =
      options.httpProxy ||
      process.env.BANGUMI_HTTP_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      '';
    if (!proxy) return null;
    return new ProxyAgent({ uri: proxy, requestTls: { rejectUnauthorized: true } });
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const base = this.options.baseUrl ?? BANGUMI_BASE_URL;
    const url = new URL(path.startsWith('http') ? path : `${base}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === '') continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async delayWithJitter(attempt: number, signal?: AbortSignal): Promise<void> {
    await sleep(backoffDelay(attempt, this.options.retryBaseDelayMs ?? 800), signal);
  }

  /**
   * 统一请求入口：限流 → 超时 → 重试 → 错误归类。
   * 所有错误消息都会经过敏感信息清洗，Token 不会进入日志或界面。
   */
  private async requestRaw(
    url: string,
    options: RequestOptions & { accept?: string; raw?: boolean; includeToken?: boolean } = {},
  ): Promise<Response | Uint8Array> {
    const maxRetries = options.maxRetries ?? this.options.maxRetries ?? 4;
    const secretList = [this.options.token];
    let lastError: BangumiApiError | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      if (options.signal?.aborted) throw new BangumiApiError('aborted', '已取消');
      await this.limiter.acquire(options.signal);

      const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs ?? 20_000);
      const signal = options.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal;
      const startedAt = Date.now();

      try {
        this.stats.requests += 1;
        const fetchImpl = this.options.fetchImpl ?? undiciFetch;
        const headers: Record<string, string> = {
          'User-Agent': this.options.userAgent,
          Accept: options.accept ?? 'application/json',
        };
        if (this.options.token && options.includeToken !== false) headers.Authorization = `Bearer ${this.options.token}`;

        const response = await fetchImpl(url, {
          method: 'GET',
          headers,
          signal,
          ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
        } as Parameters<typeof undiciFetch>[1]);

        this.stats.lastRequestMs = Date.now() - startedAt;

        if (response.ok) {
          this.limiter.handleSuccess();
          if (options.raw) return new Uint8Array(await response.arrayBuffer());
          return response as unknown as Response;
        }

        const bodyText = await response.text().catch(() => '');
        const error = this.mapHttpError(response.status, bodyText, response.headers, secretList);

        if (response.status === 429) {
          this.stats.throttled += 1;
          const retryAfter = Number(response.headers.get('retry-after') ?? '');
          this.limiter.handleRateLimited(
            Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : (this.options.rateLimitCooldownMs ?? 5000),
          );
          this.options.onEvent?.({
            type: 'throttled',
            attempt,
            message: `请求被限流，已降低请求频率（第 ${attempt} 次尝试）`,
          });
        }

        if (!error.retryable || attempt === maxRetries) throw error;
        lastError = error;
        this.stats.retries += 1;
        this.options.onEvent?.({
          type: 'retry',
          attempt,
          message: `${error.message}，${attempt}/${maxRetries} 次重试`,
        });
        await this.delayWithJitter(attempt, options.signal);
      } catch (error) {
        if (error instanceof BangumiApiError) {
          if (!error.retryable || attempt === maxRetries) throw error;
          lastError = error;
          this.stats.retries += 1;
          this.options.onEvent?.({
            type: 'retry',
            attempt,
            message: `${error.message}，${attempt}/${maxRetries} 次重试`,
          });
          await this.delayWithJitter(attempt, options.signal);
          continue;
        }
        const errorName = (error as Error | undefined)?.name;
        if (isAbortError(error) || errorName === 'TimeoutError') {
          if (options.signal?.aborted) throw new BangumiApiError('aborted', '已取消');
          const timeoutError = new BangumiApiError('timeout', '请求超时', {
            retryable: true,
            hint: '网络较慢或 Bangumi 暂时无响应，稍后可重试。',
          });
          if (attempt === maxRetries) throw timeoutError;
          lastError = timeoutError;
          this.stats.retries += 1;
          await this.delayWithJitter(attempt, options.signal);
          continue;
        }
        const message = scrubSecrets((error as Error).message ?? String(error), secretList);
        const networkError = new BangumiApiError('network', `网络请求失败：${message}`, {
          retryable: true,
          hint: '请检查网络连接或代理设置，本地已有数据不受影响。',
          cause: error,
        });
        if (attempt === maxRetries) throw networkError;
        lastError = networkError;
        this.stats.retries += 1;
        this.options.onEvent?.({
          type: 'retry',
          attempt,
          message: `网络异常，${attempt}/${maxRetries} 次重试`,
        });
        await this.delayWithJitter(attempt, options.signal);
      }
    }

    throw lastError ?? new BangumiApiError('network', '请求失败');
  }

  private mapHttpError(
    status: number,
    bodyText: string,
    headers: { get(name: string): string | null },
    secrets: string[],
  ): BangumiApiError {
    let body: ErrorBody = {};
    try {
      body = JSON.parse(bodyText) as ErrorBody;
    } catch {
      body = {};
    }
    const description = scrubSecrets(body.description ?? body.title ?? '', secrets);
    const suffix = description ? `：${description}` : '';
    const requestId = headers.get('x-request-id') ?? headers.get('cf-ray') ?? null;
    const withRequestId = requestId ? `${suffix}（请求 ID ${requestId}）` : suffix;

    if (status === 401) {
      return new BangumiApiError('auth', `Bangumi 认证失败${withRequestId}`, {
        status,
        retryable: false,
        hint: 'Access Token 无效、已过期或未填写。请到 https://next.bgm.tv/demo/access-token 重新生成后保存。',
      });
    }
    if (status === 403) {
      return new BangumiApiError('forbidden', `请求被拒绝${withRequestId}`, {
        status,
        retryable: false,
        hint: '通常是 User-Agent 不符合 Bangumi 要求。请在设置中把 User-Agent 改为「应用名/版本 (联系方式或项目地址)」的形式。',
      });
    }
    if (status === 404) {
      return new BangumiApiError('not_found', `资源不存在${withRequestId}`, {
        status,
        retryable: false,
        hint: '请确认用户名是否正确、收藏是否设置为公开；条目可能已被合并或删除。',
      });
    }
    if (status === 429) {
      return new BangumiApiError('rate_limit', `请求过于频繁，已被 Bangumi 限流${withRequestId}`, {
        status,
        retryable: true,
        hint: '程序会自动降低请求频率后重试；也可以在设置中调大请求间隔。',
      });
    }
    if (status >= 500) {
      return new BangumiApiError('server', `Bangumi 服务端错误（HTTP ${status}）${withRequestId}`, {
        status,
        retryable: true,
        hint: '这是对方服务的问题，程序会自动重试；本地数据不受影响。',
      });
    }
    return new BangumiApiError('server', `请求失败（HTTP ${status}）${withRequestId}`, {
      status,
      retryable: false,
    });
  }

  private async getJson<T>(
    path: string,
    query: Record<string, string | number | undefined>,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = this.buildUrl(path, query);
    const response = (await this.requestRaw(url, options)) as Response;
    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new BangumiApiError('parse', 'Bangumi 返回的数据无法解析为 JSON', {
        hint: '可能是接口临时异常或返回了错误页面，稍后重试；本地数据不受影响。',
        cause: error,
      });
    }
  }

  async getMe(options: RequestOptions = {}): Promise<BgmMe> {
    const raw = await this.getJson<unknown>('/v0/me', {}, options);
    const parsed = bgmMeSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BangumiApiError('parse', '无法解析 Bangumi 用户信息', {
        hint: '接口返回结构可能发生变化，请提交 issue 或稍后重试。',
      });
    }
    return parsed.data;
  }

  /** 公开用户身份查询，用于把用户名与 UID 归一到同一账号。 */
  async getUser(username: string, options: RequestOptions = {}): Promise<BgmMe> {
    const raw = await this.getJson<unknown>(`/v0/users/${encodeURIComponent(username)}`, {}, options);
    const parsed = bgmMeSchema.safeParse(raw);
    if (!parsed.success || parsed.data.id <= 0 || !parsed.data.username.trim()) {
      throw new BangumiApiError('parse', '无法确认 Bangumi 账号身份', {
        hint: '请稍后重试；身份确认失败时不会切换账号或写入收藏。',
      });
    }
    const target = username.trim();
    const sameIdentity = /^\d+$/.test(target)
      ? Number.isSafeInteger(Number(target)) && Number(target) === parsed.data.id
      : target.toLowerCase() === parsed.data.username.toLowerCase();
    if (!sameIdentity) throw new BangumiApiError('parse', 'Bangumi 账号响应与请求身份不一致');
    return parsed.data;
  }

  async getCollectionsPage(
    username: string,
    params: { subjectType?: number; collectionType?: number; limit: number; offset: number },
    options: RequestOptions = {},
  ): Promise<{ total: number; limit: number; offset: number; data: unknown[] }> {
    const raw = await this.getJson<unknown>(
      `/v0/users/${encodeURIComponent(username)}/collections`,
      {
        subject_type: params.subjectType,
        type: params.collectionType,
        limit: params.limit,
        offset: params.offset,
      },
      options,
    );
    const parsed = bgmCollectionPageSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BangumiApiError('parse', '无法解析 Bangumi 收藏列表', {
        hint: '接口返回结构可能发生变化，本次同步已中止，本地数据未被修改。',
      });
    }
    return parsed.data;
  }

  async getSubject(subjectId: number, options: RequestOptions = {}): Promise<BgmSubject> {
    const raw = await this.getJson<unknown>(`/v0/subjects/${subjectId}`, {}, options);
    const parsed = bgmSubjectSchema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      throw new BangumiApiError('parse', `条目 ${subjectId} 的详情结构异常（${detail}）`, {
        hint: '该条目可能为异常数据，已跳过并继续同步其它条目。',
      });
    }
    if (parsed.data.id !== subjectId) {
      throw new BangumiApiError('parse', `条目 ${subjectId} 的响应身份不一致，已保留原详情`);
    }
    return rememberSubjectSource(parsed.data, raw);
  }

  async getSubjectRelations(
    subjectId: number,
    options: RequestOptions = {},
  ): Promise<BgmSubjectRelation[]> {
    const raw = await this.getJson<unknown>(`/v0/subjects/${subjectId}/subjects`, {}, options);
    if (!Array.isArray(raw)) throw new BangumiApiError('parse', 'Bangumi 关系响应不是完整数组');
    const out: BgmSubjectRelation[] = [];
    for (const entry of raw) {
      const parsed = bgmSubjectRelationSchema.safeParse(entry);
      if (!parsed.success || parsed.data.id <= 0 || !parsed.data.relation.trim()) {
        throw new BangumiApiError('parse', 'Bangumi 关系响应包含无效记录，本地关系已保留');
      }
      out.push(parsed.data);
    }
    return out;
  }

  async getSubjectPersons(
    subjectId: number,
    options: RequestOptions = {},
  ): Promise<BgmPersonRelation[]> {
    const raw = await this.getJson<unknown>(`/v0/subjects/${subjectId}/persons`, {}, options);
    if (!Array.isArray(raw)) throw new BangumiApiError('parse', 'Bangumi 人员响应不是完整数组');
    const out: BgmPersonRelation[] = [];
    for (const entry of raw) {
      const parsed = bgmPersonRelationSchema.safeParse(entry);
      if (!parsed.success || parsed.data.id <= 0 || !parsed.data.name.trim() || !parsed.data.relation.trim()) {
        throw new BangumiApiError('parse', 'Bangumi 人员响应包含无效记录，本地人员已保留');
      }
      out.push(parsed.data);
    }
    return out;
  }

  /** 下载封面等二进制资源（用于离线封面缓存），复用同一套超时/重试策略。 */
  async fetchImage(
    url: string,
    options: RequestOptions = {},
  ): Promise<{ data: Uint8Array; contentType: string | null }> {
    const response = (await this.requestRaw(this.buildUrl(url), {
      ...options,
      accept: 'image/*',
      includeToken: false,
    })) as Response;
    const contentType = response.headers.get('content-type');
    const data = new Uint8Array(await response.arrayBuffer());
    return { data, contentType };
  }
}
