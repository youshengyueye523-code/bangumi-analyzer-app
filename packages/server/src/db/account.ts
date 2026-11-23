import { ApiError, type BgmMe } from '@bangumi-analyzer/shared';
import { countRows, getMeta, setMeta } from './index.js';
import { isDistribution } from '../config.js';

const OWNER_KEY = 'collection_owner_uid';

export function collectionOwnerUid(): number | null {
  const value = getMeta(OWNER_KEY);
  if (value === null) return null;
  const uid = Number(value);
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    throw new ApiError('数据库账号归属记录异常，已停止账号切换与同步', { code: 'invalid_account_owner', status: 409 });
  }
  return uid;
}

export function accountSwitchError(): ApiError {
  return new ApiError('非空数据库禁止切换到另一账号；请为另一账号使用独立数据目录。', {
    code: 'account_switch_forbidden', status: 409,
    hint: '同一账号的用户名与数字 UID 可以互换。',
  });
}

export function assertKnownCollectionOwner(): number | null {
  const owner = collectionOwnerUid();
  if (countRows('collections') > 0 && owner === null) {
    throw new ApiError('旧数据库收藏账号归属尚未确认，已停止同步和账号身份变更', {
      code: 'account_owner_unconfirmed', status: 409,
      hint: '当前配置不能证明历史收藏归属；请先单独确认归属。另一账号使用独立数据目录。',
    });
  }
  return owner;
}

export function assertCollectionOwner(user: Pick<BgmMe, 'id'>): void {
  if (!Number.isSafeInteger(user.id) || user.id <= 0) {
    throw new ApiError('无法确认 Bangumi 账号身份', { code: 'invalid_account_identity', status: 409 });
  }
  const owner = assertKnownCollectionOwner();
  // A portable copy retains its original UID even after an empty sync: saved history
  // and governance still belong to that account. Disconnect never unbinds ownership.
  if ((isDistribution() || countRows('collections') > 0) && owner !== null && owner !== user.id) throw accountSwitchError();
}

/** 调用方须与收藏写入放在同一事务；仅保存公开 UID，不保存凭据。 */
export function bindCollectionOwner(user: Pick<BgmMe, 'id'>): void {
  assertCollectionOwner(user);
  setMeta(OWNER_KEY, String(user.id));
}
