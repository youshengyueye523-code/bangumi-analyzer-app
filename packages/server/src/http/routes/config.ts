import {
  appConfigUpdateSchema,
  ApiError,
  decodeAvatarDataUrl,
  type CredentialCheckResult,
  type OnboardingState,
} from '@bangumi-analyzer/shared';
import type { FastifyInstance } from 'fastify';
import { BangumiApiError, type BangumiClient } from '../../bangumi/client.js';
import { isDistribution, loadConfig, saveConfig, toPublicConfig } from '../../config.js';
import { countRows, one } from '../../db/index.js';
import { accountSwitchError, assertKnownCollectionOwner, collectionOwnerUid } from '../../db/account.js';
import type { SyncEngine } from '../../sync/engine.js';
import { deleteWallpaper, wallpaperFilePath } from '../../images/wallpaper.js';

export interface ConfigRouteDeps {
  client: BangumiClient;
  engine: Pick<SyncEngine, 'running' | 'cancel' | 'whenIdle' | 'pauseStarts' | 'accountChangeInProgress'>;
}

export function registerConfigRoutes(app: FastifyInstance, deps: ConfigRouteDeps): void {
  let identityGeneration = 0;
  const identityRequests = new Set<AbortController>();
  function assertAccountReady(generation = identityGeneration): void {
    if (deps.engine.accountChangeInProgress || generation !== identityGeneration) {
      throw new ApiError('账号已断开或正在断开，请刷新后重新操作', { code: 'account_disconnect_in_progress', status: 409 });
    }
  }

  if (isDistribution()) app.post('/api/config/disconnect', async () => {
    // A file write cannot clear environment overrides. The portable launcher strips
    // these; direct/custom launches must not report a false successful logout.
    if (process.env.BANGUMI_USERNAME || process.env.BANGUMI_ACCESS_TOKEN) {
      throw new ApiError('当前凭据来自环境变量，无法在设置中清除', {
        code: 'account_credentials_from_environment', status: 409,
        hint: '请使用分发包的 Start-Analyzer.bat 启动后再断开账号。',
      });
    }
    const resume = deps.engine.pauseStarts();
    identityGeneration += 1;
    try {
      for (const controller of identityRequests) controller.abort();
      deps.engine.cancel();
      await deps.engine.whenIdle();
      // Do not change collection_owner_uid, personal assets, history or AI settings.
      const saved = saveConfig({ username: '', token: '' });
      deps.client.updateOptions({ token: '' });
      return toPublicConfig(saved);
    } finally { resume(); }
  });

  app.get('/api/config', async () => toPublicConfig(loadConfig()));

  /**
   * 首次使用引导状态：完全是本地判断，不依赖任何外部服务。
   * completed沿用展示契约（全部完成或跳过）；各步骤done始终只表示实际完成。
   */
  app.get('/api/profile/local', async (): Promise<OnboardingState> => {
    const config = loadConfig();
    let collections = 0;
    try {
      collections = countRows('collections');
    } catch {
      collections = 0;
    }
    const steps: OnboardingState['steps'] = [
      {
        id: 'profile',
        title: '设置昵称 / 头像',
        description: '这些只是本机资料，用来标识这个本地数据库，不会同步到 Bangumi。',
        done: config.nickname.trim().length > 0 || config.avatar.length > 0,
      },
      {
        id: 'bangumi',
        title: '配置 Bangumi 账号',
        description: '填写用户名；Access Token 可选，不配置时只能同步公开收藏。配置不代表已验证凭据。',
        done: config.username.trim().length > 0,
      },
      {
        id: 'sync',
        title: '完成一次同步',
        description: '以本机成功的收藏同步记录为准；导入或合成收藏不算同步，成功同步空收藏也算完成。',
        done: Boolean(one(
          `SELECT id FROM sync_runs WHERE mode IN ('full', 'incremental')
           AND status = 'success' AND finished_at IS NOT NULL AND TRIM(finished_at) <> '' LIMIT 1`,
        )),
      },
    ];
    const allDone = steps.every((step) => step.done);
    return {
      completed: config.onboardingSeen || allDone,
      seen: config.onboardingSeen,
      steps,
      collections,
      profile: {
        nickname: config.nickname,
        avatar: config.avatar,
        username: config.username,
        hasToken: config.token.length > 0,
      },
    };
  });

  app.put('/api/config', async (request) => {
    const generation = identityGeneration;
    const patch = appConfigUpdateSchema.parse(request.body ?? {});
    if (patch.username !== undefined && patch.username.includes(' ')) {
      throw new ApiError('用户名不能包含空格', {
        code: 'invalid_username',
        status: 400,
        hint: '请填写 Bangumi 个人主页地址中的用户名（例如 https://bgm.tv/user/xxxx 中的 xxxx）。',
      });
    }
    if (patch.httpProxy && !/^https?:\/\//i.test(patch.httpProxy)) {
      throw new ApiError('代理地址格式不正确', {
        code: 'invalid_proxy',
        status: 400,
        hint: '请填写形如 http://127.0.0.1:7890 的完整地址。',
      });
    }
    if (patch.avatar) {
      const decoded = decodeAvatarDataUrl(patch.avatar);
      if (!decoded.ok) {
        throw new ApiError('本地头像无法保存', {
          code: 'invalid_avatar',
          status: 400,
          hint: decoded.reason,
        });
      }
    }
    const before = loadConfig();
    const assertIdentityIdle = () => {
      if (patch.username !== undefined || patch.token !== undefined) assertAccountReady(generation);
      if (deps.engine.running && (
        (patch.username !== undefined && patch.username !== before.username) ||
        (patch.token !== undefined && patch.token !== before.token)
      )) {
        throw new ApiError('同步运行中不能更换 Bangumi 用户名或 Token', {
          code: 'sync_in_progress', status: 409,
          hint: '请等待同步结束或取消同步后再保存账号配置。',
        });
      }
    };
    assertIdentityIdle();
    if ((patch.username !== undefined && patch.username !== before.username) ||
        (patch.token !== undefined && patch.token !== before.token)) assertKnownCollectionOwner();
    if (patch.username !== undefined && patch.username.toLowerCase() !== before.username.trim().toLowerCase() &&
        (countRows('collections') > 0 || (isDistribution() && collectionOwnerUid() !== null))) {
      if (!patch.username.trim()) throw accountSwitchError();
      const owner = assertKnownCollectionOwner();
      const controller = new AbortController();
      identityRequests.add(controller);
      try {
        const target = await deps.client.getUser(patch.username.trim(), { signal: controller.signal });
        assertAccountReady(generation);
        if (target.id !== owner) throw accountSwitchError();
      } finally { identityRequests.delete(controller); }
    }
    // 身份请求 await 期间也可能启动同步；保存前再次检查，后面没有异步窗口。
    assertIdentityIdle();
    // 上传与保存是两个请求；其他页面可能已经清理了这张图。
    if (patch.wallpaper?.image && !wallpaperFilePath(patch.wallpaper.image)) {
      throw new ApiError('背景图已不存在，配置未保存', {
        code: 'wallpaper_not_found', status: 409, dataIntact: true,
        hint: '请重新选择并应用背景图。',
      });
    }
    const saved = saveConfig(patch);
    // 换图 / 清除背景时删掉被替换的文件，避免 data/wallpapers 无限增长
    if (
      patch.wallpaper?.image !== undefined &&
      before.wallpaper.image &&
      before.wallpaper.image !== saved.wallpaper.image
    ) {
      deleteWallpaper(before.wallpaper.image);
    }
    // 立即把新配置应用到 HTTP 客户端，避免需要重启服务
    deps.client.updateOptions({
      token: saved.token,
      userAgent: saved.userAgent,
      requestIntervalMs: saved.requestIntervalMs,
      httpProxy: saved.httpProxy,
    });
    return toPublicConfig(saved);
  });

  /** 校验凭据：不写入任何数据，仅用于确认 Token / 用户名的有效性。 */
  app.post('/api/config/verify', async (): Promise<CredentialCheckResult> => {
    assertAccountReady();
    const generation = identityGeneration;
    const config = loadConfig();
    if (!config.token) {
      return { ok: false, message: '尚未配置 Access Token（只能访问公开收藏）' };
    }
    deps.client.updateOptions({
      token: config.token,
      userAgent: config.userAgent,
      requestIntervalMs: config.requestIntervalMs,
      httpProxy: config.httpProxy,
    });
    const controller = new AbortController();
    identityRequests.add(controller);
    try {
      const me = await deps.client.getMe({ signal: controller.signal });
      assertAccountReady(generation);
      return {
        ok: true,
        message: `认证成功：${me.nickname || me.username}（UID ${me.id}）`,
        user: {
          id: me.id,
          username: me.username,
          nickname: me.nickname || me.username,
          avatar: me.avatar?.large ?? me.avatar?.medium ?? null,
        },
      };
    } catch (error) {
      if (error instanceof BangumiApiError) {
        return {
          ok: false,
          message: error.hint ? `${error.message}｜${error.hint}` : error.message,
        };
      }
      throw error;
    } finally { identityRequests.delete(controller); }
  });
}
