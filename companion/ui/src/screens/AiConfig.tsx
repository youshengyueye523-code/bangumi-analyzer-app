import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, KeyRound, Link2, Box, Sparkles, CheckCircle2, XCircle, Eye, EyeOff, FileText, Tags, MessageSquareQuote } from 'lucide-react';
import { Button, Field, MockTag, cx } from '../components/ui';
import { StepFrame } from './SetupShell';
import { getProductBridge } from '../driver/product';
import { AI_PROVIDERS, testAiConnection, MockError, type AiConfig } from '../mock/setup';
import { useFlow } from '../state/flow';

export function AiScreen() {
  const flow = useFlow();
  const pb = getProductBridge();
  const [cfg, setCfg] = useState<AiConfig>({
    provider: (flow.draft.ai?.provider as AiConfig['provider']) || 'deepseek',
    baseUrl: flow.draft.ai?.baseUrl || AI_PROVIDERS[1].baseUrl,
    model: flow.draft.ai?.model || AI_PROVIDERS[1].model,
    key: flow.draft.ai?.apiKey || '',
  });
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: true; latency: number } | { ok: false; err: MockError } | null>(null);
  const ac = useRef<AbortController | null>(null);
  useEffect(() => () => ac.current?.abort(), []);

  useEffect(() => {
    if (busy) flow.mascot('think', '在敲 AI 服务的门……');
    else if (result?.ok) flow.mascot('happy', `连上了！响应 ${result.latency} ms。`);
    else if (result && !result.ok) flow.mascot('worry', '没连上。不急，这一步完全可以跳过。');
    else flow.mascot('idle', 'AI 只用来写画像报告和摘要。不配置也完全不影响同步和统计哦。');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, result]);

  const patch = (p: Partial<AiConfig>) => {
    setCfg((c) => ({ ...c, ...p }));
    setResult(null);
  };

  const test = async () => {
    if (!cfg.key.trim() || !cfg.baseUrl.trim() || !cfg.model.trim()) {
      setResult({ ok: false, err: new MockError('EMPTY', '请填写 Base URL、模型与 API Key') });
      return;
    }
    ac.current?.abort();
    ac.current = new AbortController();
    setBusy(true);
    setResult(null);
    try {
      if (pb) {
        const r = await pb.testAiConnection({ baseUrl: cfg.baseUrl, model: cfg.model, key: cfg.key });
        if (!r.ok) {
          setResult({ ok: false, err: new MockError((r.code ?? 'TIMEOUT') as MockError['code'], r.message ?? '连接失败', r.hint) });
          return;
        }
        setResult({ ok: true, latency: r.latencyMs ?? 0 });
      } else {
        const r = await testAiConnection(cfg, ac.current.signal);
        setResult({ ok: true, latency: r.latencyMs });
      }
    } catch (e) {
      if (e instanceof MockError) setResult({ ok: false, err: e });
    } finally {
      setBusy(false);
    }
  };
  const save = () => {
    flow.setDraft({ ai: { provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl, apiKey: cfg.key } });
    flow.next();
  };
  const skip = () => {
    flow.setDraft({ ai: null });
    flow.next();
  };
  const ok = result?.ok === true;

  return (
    <StepFrame
      no="04"
      en="AI ASSISTANT · OPTIONAL"
      title="配置 AI 助手"
      desc={
        <>
          可选。使用你自己的 API Key，请求从本机直接发往你选择的服务。 {!pb && <MockTag />}
        </>
      }
      onEnter={ok ? save : busy ? undefined : test}
      footer={
        <>
          <Button variant="ghost" icon={<ArrowLeft size={16} />} onClick={flow.back}>
            上一步
          </Button>
          <div className="foot-spacer" />
          <Button variant="link" onClick={skip}>
            跳过，不使用 AI
          </Button>
          {ok ? (
            <Button variant="primary" size="lg" onClick={save} trailing={<ArrowRight size={16} />} kbd="Enter">
              保存并继续
            </Button>
          ) : (
            <Button variant="primary" size="lg" loading={busy} onClick={test}>
              {busy ? '测试中' : '测试连接'}
            </Button>
          )}
        </>
      }
    >
      <div className="ai-uses">
        <span>
          <FileText size={13} /> 画像报告
        </span>
        <span>
          <MessageSquareQuote size={13} /> 作品摘要翻译
        </span>
        <span>
          <Tags size={13} /> 标签归纳
        </span>
        <span className="ai-uses-note">统计、筛选、画像证据均不依赖 AI</span>
      </div>

      <div className="provider-grid">
        {AI_PROVIDERS.map((p) => (
          <button
            key={p.id}
            className={cx('provider', cfg.provider === p.id && 'on')}
            onClick={() => patch({ provider: p.id, baseUrl: p.baseUrl, model: p.model })}
          >
            <span className="provider-ico">{p.id === 'custom' ? <Box size={16} /> : <Sparkles size={16} />}</span>
            <span className="provider-name">{p.name}</span>
            <span className="provider-note">{p.note}</span>
          </button>
        ))}
      </div>

      <div className="ai-fields">
        <Field label="Base URL" value={cfg.baseUrl} onChange={(e) => patch({ baseUrl: e.target.value })} prefix={<Link2 size={15} />} spellCheck={false} disabled={busy} />
        <Field label="模型" value={cfg.model} onChange={(e) => patch({ model: e.target.value })} prefix={<Box size={15} />} spellCheck={false} disabled={busy} />
      </div>
      <Field
        label="API Key"
        type={show ? 'text' : 'password'}
        placeholder="sk-…"
        value={cfg.key}
        onChange={(e) => patch({ key: e.target.value })}
        prefix={<KeyRound size={15} />}
        suffix={
          <button type="button" className="icon-btn" onClick={() => setShow((s) => !s)}>
            {show ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        }
        hint="只保存在本机，与 Bangumi Token 分开存放。"
        disabled={busy}
        spellCheck={false}
      />

      {result && (
        <div className={cx('banner', result.ok ? 'banner-ok' : 'banner-danger', 'pop-in')}>
          {result.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
          <div>
            {result.ok ? (
              <>
                <b>连接成功（模拟）</b>
                <span>
                  {cfg.model} · 响应 {result.latency} ms
                </span>
              </>
            ) : (
              <>
                <b>{result.err.message}</b>
                {result.err.hint && <span>{result.err.hint}</span>}
              </>
            )}
          </div>
        </div>
      )}
    </StepFrame>
  );
}
