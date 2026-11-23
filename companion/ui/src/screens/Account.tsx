import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, AtSign, KeyRound, Eye, EyeOff, ShieldCheck, ChevronDown, RefreshCw, BadgeCheck, Lock, Globe2, WifiOff } from 'lucide-react';
import { Button, Field, MockTag, cx } from '../components/ui';
import { StepFrame } from './SetupShell';
import { getProductBridge } from '../driver/product';
import { verifyBangumiAccount, MockError, type BangumiProfile } from '../mock/setup';
import { useFlow } from '../state/flow';

export function AccountScreen() {
  const flow = useFlow();
  const pb = getProductBridge();
  const existing = flow.draft.account;
  const [username, setUsername] = useState(existing?.username ?? '');
  const [token, setToken] = useState(flow.draft.accountToken ?? '');
  const [showToken, setShowToken] = useState(false);
  const [guide, setGuide] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<MockError | null>(null);
  const [profile, setProfile] = useState<(BangumiProfile & { tokenSet: boolean }) | null>(existing);
  const ac = useRef<AbortController | null>(null);

  useEffect(() => () => ac.current?.abort(), []);

  useEffect(() => {
    if (busy) flow.mascot('think', '正在和 Bangumi 打招呼……');
    else if (profile) flow.mascot('happy', `找到啦，${profile.nickname}！收藏有 ${profile.collections} 部呢。`);
    else if (err) flow.mascot('worry', err.code === 'TIMEOUT' ? '网络好像有点慢，再试一次？' : '好像哪里没填对，看看提示～');
    else flow.mascot('idle', '告诉我你的 Bangumi 用户名，我来帮你把收藏搬回家。');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, profile, err]);

  const verify = async () => {
    if (!username.trim()) {
      setErr(new MockError('EMPTY', '请填写用户名或数字 UID'));
      return;
    }
    ac.current?.abort();
    ac.current = new AbortController();
    setBusy(true);
    setErr(null);
    try {
      if (pb) {
        const res = await pb.verifyBangumiAccount({ username: username.trim(), token: token.trim() });
        if (!res.ok || !res.profile) {
          setErr(new MockError((res.code ?? 'TIMEOUT') as MockError['code'], res.message ?? '验证失败', res.hint));
          return;
        }
        setProfile({ ...res.profile, tokenSet: Boolean(token.trim()) });
      } else {
        const p = await verifyBangumiAccount(username.trim(), token.trim(), ac.current.signal);
        setProfile({ ...p, tokenSet: Boolean(token.trim()) });
      }
    } catch (e) {
      if (e instanceof MockError) setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const next = () => {
    if (!profile) return;
    flow.setDraft({ account: profile, accountSkipped: false, accountToken: token.trim() || undefined });
    flow.next();
  };
  const skip = () => {
    flow.setDraft({ account: null, accountSkipped: true, accountToken: undefined });
    flow.next();
  };

  const userErr = err && (err.code === 'NOT_FOUND' || err.code === 'EMPTY') ? err.message : null;
  const tokenErr = err?.code === 'TOKEN_INVALID' ? err.message : null;

  return (
    <StepFrame
      no="03"
      en="BANGUMI ACCOUNT"
      title="连接 Bangumi 账号"
      desc={
        <>
          用来同步你的收藏。只读取，不会修改 Bangumi 上的任何内容。 {!pb && <MockTag />}
        </>
      }
      onEnter={profile ? next : busy ? undefined : verify}
      footer={
        <>
          <Button variant="ghost" icon={<ArrowLeft size={16} />} onClick={flow.back}>
            上一步
          </Button>
          <div className="foot-spacer" />
          <Button variant="link" onClick={skip}>
            稍后再绑定
          </Button>
          {profile ? (
            <Button variant="primary" size="lg" onClick={next} trailing={<ArrowRight size={16} />} kbd="Enter">
              继续
            </Button>
          ) : (
            <Button variant="primary" size="lg" loading={busy} onClick={verify} kbd={busy ? undefined : 'Enter'}>
              {busy ? '验证中' : '验证账号'}
            </Button>
          )}
        </>
      }
    >
      {profile ? (
        <div className="profile-card pop-in">
          <div className="avatar" style={{ ['--h' as string]: profile.hue }}>
            {profile.nickname.slice(0, 1)}
          </div>
          <div className="profile-main">
            <div className="profile-name">
              {profile.nickname} <BadgeCheck size={16} className="tone-success" />
            </div>
            <div className="profile-meta">
              @{profile.username} · UID <span className="numeric">{profile.uid}</span>
            </div>
            <div className="profile-tags">
              <span className="chip">
                收藏 <b className="numeric">{profile.collections}</b> 部
              </span>
              {profile.tokenSet ? (
                <span className="chip chip-accent">
                  <Lock size={11} /> 含私有收藏
                </span>
              ) : (
                <span className="chip">
                  <Globe2 size={11} /> 仅公开收藏
                </span>
              )}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setProfile(null);
              setErr(null);
            }}
          >
            更换账号
          </Button>
        </div>
      ) : (
        <>
          <div className="url-hint">
            <span className="url-host">bgm.tv/user/</span>
            <span className={cx('url-user', username && 'filled')}>{username || '你的用户名'}</span>
            <span className="url-note">← 个人主页地址的最后一段，不是邮箱或昵称</span>
          </div>

          {err?.code === 'TIMEOUT' && (
            <div className="banner banner-warn pop-in">
              <WifiOff size={16} />
              <div>
                <b>{err.message}</b>
                <span>{err.hint}</span>
              </div>
              <Button size="sm" variant="secondary" icon={<RefreshCw size={13} />} onClick={verify}>
                重试
              </Button>
            </div>
          )}

          <Field
            label="用户名或 UID"
            placeholder="例如 sai 或 123456"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              if (userErr) setErr(null);
            }}
            prefix={<AtSign size={15} />}
            error={userErr}
            hint={userErr ? undefined : '改过用户名也没关系，Analyzer 以 UID 识别账号。'}
            autoFocus
            spellCheck={false}
            disabled={busy}
          />
          {userErr && err?.hint && <p className="hint-under">{err.hint}</p>}

          <Field
            label="Access Token"
            optional
            type={showToken ? 'text' : 'password'}
            placeholder="只同步公开收藏可以留空"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              if (tokenErr) setErr(null);
            }}
            prefix={<KeyRound size={15} />}
            suffix={
              <button type="button" className="icon-btn" onClick={() => setShowToken((s) => !s)} aria-label={showToken ? '隐藏' : '显示'}>
                {showToken ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            }
            error={tokenErr}
            disabled={busy}
            spellCheck={false}
          />
          {tokenErr && err?.hint && <p className="hint-under">{err.hint}</p>}

          <button className={cx('disclosure', guide && 'open')} onClick={() => setGuide((g) => !g)}>
            <ChevronDown size={14} /> 什么时候需要 Token？如何获取？
          </button>
          {guide && (
            <ol className="guide pop-in">
              <li>收藏设为「仅自己可见」时才需要 Token；只看公开收藏可跳过。</li>
              <li>登录 Bangumi 官方网站，打开「个人令牌」页面，生成一个新令牌。</li>
              <li>复制到这里。令牌只发给 Bangumi 官方 API，不会上传到其他地方。</li>
            </ol>
          )}
        </>
      )}

      <div className="privacy">
        <ShieldCheck size={14} />
        <span>
          用户名与 Token 只保存在本机 <code>data/config.json</code>。可以随时在 Analyzer 设置中断开。
        </span>
      </div>
    </StepFrame>
  );
}
