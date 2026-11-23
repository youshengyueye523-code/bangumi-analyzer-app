import { Bot, Save, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { useConfig, queryKeys } from '../../lib/queries.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card, CardBody, CardHeader } from '../ui/card.js';
import { InlineNote, Skeleton } from '../ui/feedback.js';
import { Field, Input, Switch } from '../ui/form.js';
import { useToast } from '../ui/toast.js';

/**
 * AI 服务（可选）：接口地址 / 模型 / API Key 由「我的画像」的自然语言总结
 * 与「简介翻译」共用；两个功能各自有独立开关。
 * Key 只写进本机 data/config.json（已被 .gitignore 排除），接口只返回掩码。
 */
export function AiSettingsCard() {
  const { data, isLoading } = useConfig();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [enabled, setEnabled] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!data) return;
    setEnabled(data.ai.enabled);
    setBaseUrl(data.ai.baseUrl);
    setModel(data.ai.model);
  }, [data]);

  if (isLoading || !data) return <Skeleton className="h-[240px]" />;

  const ai = data.ai;

  async function save(patch: { enabled?: boolean; baseUrl?: string; model?: string; apiKey?: string }) {
    setSaving(true);
    try {
      const updated = await api.updateConfig({ ai: patch });
      queryClient.setQueryData(queryKeys.config, updated);
      setApiKey('');
      toast.push({ tone: 'success', title: 'AI 设置已保存' });
    } catch (error) {
      toast.push({
        tone: 'error',
        title: '保存失败',
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="AI 服务（可选）"
        description="「我的画像」的自然语言总结与「简介翻译」共用这套接口配置；两者各自独立开关，统计部分不依赖 AI。"
        actions={
          ai.hasApiKey ? (
            <Badge tone={ai.enabled ? 'success' : 'neutral'}>
              <Bot size={10} /> {ai.enabled ? '已启用' : '已配置未启用'}
            </Badge>
          ) : (
            <Badge tone="neutral">未配置</Badge>
          )
        }
      />
      <CardBody className="space-y-4 pt-2">
        <Switch
          id="ai-enabled"
          label="启用 AI 画像总结"
          description="开启后可以在「我的画像」里点击生成；关闭时其余功能完全不受影响。"
          checked={enabled}
          onCheckedChange={(checked) => {
            setEnabled(checked);
            void save({ enabled: checked });
          }}
        />

        <div className="grid gap-4 md:grid-cols-safe-2">
          <Field
            label="接口地址（OpenAI 兼容）"
            htmlFor="ai-base-url"
            hint="例如 https://api.openai.com/v1，或任意兼容 /chat/completions 的地址。"
          >
            <Input
              id="ai-base-url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </Field>
          <Field label="模型名称" htmlFor="ai-model" hint="例如 gpt-4o-mini、gpt-4.1-mini。">
            <Input id="ai-model" value={model} onChange={(event) => setModel(event.target.value)} />
          </Field>
        </div>

        <Field
          label="API Key"
          htmlFor="ai-api-key"
          hint={
            ai.apiKeyHint
              ? `当前：${ai.apiKeyHint}（留空表示不修改）`
              : '只保存在本机 data/config.json；不会进入 Git、不会下发到浏览器、也不会出现在日志里。'
          }
        >
          <Input
            id="ai-api-key"
            type="password"
            autoComplete="off"
            value={apiKey}
            placeholder={ai.hasApiKey ? '留空则保持不变' : '粘贴 API Key'}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </Field>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            icon={<Save size={14} />}
            loading={saving}
            onClick={() =>
              void save({
                baseUrl,
                model,
                ...(apiKey ? { apiKey } : {}),
              })
            }
          >
            保存 AI 设置
          </Button>
          {ai.hasApiKey ? (
            <Button variant="ghost" onClick={() => void save({ apiKey: '' })}>
              清除 API Key
            </Button>
          ) : null}
        </div>

        <InlineNote tone="neutral">
          <span className="flex items-start gap-2">
            <Sparkles size={13} className="mt-0.5 shrink-0" />
            <span>
              生成画像时，会把完整收藏的必要统计与代表作品样本（包括主动隐藏作品）发送到这里配置的 AI 接口，
              结果也可能引用这些作品。不会发送数据库文件、Bangumi 凭据或系统配置。
              报告会保存在本机；请求可能按该服务的规则计费。
            </span>
          </span>
        </InlineNote>
      </CardBody>
    </Card>
  );
}
