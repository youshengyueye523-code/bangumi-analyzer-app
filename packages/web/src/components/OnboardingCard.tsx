import { ArrowRight, KeyRound, Play } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatRelative } from '../lib/format.js';
import { useConfig, useSyncController } from '../lib/queries.js';
import { Button } from './ui/button.js';
import { Card } from './ui/card.js';
import { InlineNote } from './ui/feedback.js';
import { useToast } from './ui/toast.js';

/** 首次使用引导：几乎没有数据时替代空白图表，直接给出下一步动作。 */
export function OnboardingCard() {
  const navigate = useNavigate();
  const { data: config } = useConfig();
  const { start, status } = useSyncController();
  const [starting, setStarting] = useState(false);
  const toast = useToast();

  const ready = Boolean(config?.username);

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="max-w-[560px]">
          <h2 className="text-title">开始建立你的本地动画数据库</h2>
          <p className="mt-1.5 text-body leading-6 text-muted">
            数据全部保存在你自己的电脑上（SQLite 文件），同步完成后仪表盘、搜索、筛选与图表都直接读取本地数据，
            断网也能正常使用。
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              variant="primary"
              icon={<KeyRound size={14} />}
              onClick={() => navigate('/settings?tab=bangumi')}
            >
              配置 Bangumi 账号
            </Button>
            <Button
              icon={<Play size={14} />}
              loading={starting}
              disabled={!ready}
              onClick={async () => {
                setStarting(true);
                try {
                  await start({ mode: 'incremental', depth: 1 });
                  toast.push({
                    tone: 'info',
                    title: '已开始同步',
                    description: '首次同步会抓取收藏列表并逐个补全条目详情，可以在顶栏查看进度。',
                  });
                } catch (error) {
                  toast.push({
                    tone: 'error',
                    title: '无法开始同步',
                    description: error instanceof Error ? error.message : String(error),
                  });
                } finally {
                  setStarting(false);
                }
              }}
            >
              执行第一次同步
            </Button>
            <Button
              variant="ghost"
              icon={<ArrowRight size={14} />}
              onClick={() => navigate('/settings?tab=data')}
            >
              查看数据目录与备份
            </Button>
          </div>
          {!ready ? (
            <InlineNote tone="warning" className="mt-4">
              还没有配置 Bangumi 用户名。请先在「设置」中填写用户名（个人主页地址中的那一段，或数字 UID）。
              建议同时配置 Access Token：没有 Token 时只能同步公开收藏。
            </InlineNote>
          ) : null}
        </div>

        <ol className="min-w-[260px] flex-1 space-y-3 text-note">
          {[
            { step: '1', title: '填写用户名与 Access Token', detail: 'Token 只保存在本机 data/config.json' },
            { step: '2', title: '执行同步', detail: '分页拉取全部收藏，再逐条补全条目详情' },
            { step: '3', title: '开始分析', detail: '仪表盘 / 筛选 / 统计 / 系列 / 画像' },
          ].map((item) => (
            <li key={item.step} className="flex gap-3">
              <span className="grid size-6 shrink-0 place-items-center rounded-full border border-border bg-surface-2 text-caption font-semibold text-muted">
                {item.step}
              </span>
              <span>
                <span className="block font-medium">{item.title}</span>
                <span className="text-subtle">{item.detail}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>
      <p className="mt-5 text-caption text-subtle">
        上次同步：{formatRelative(status?.lastSuccessfulSyncAt)}
      </p>
    </Card>
  );
}
