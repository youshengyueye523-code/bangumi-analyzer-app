import { Compass } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui/button.js';
import { EmptyState } from '../components/ui/feedback.js';

export function NotFoundPage() {
  return (
    <EmptyState
      icon={<Compass size={20} />}
      title="页面不存在"
      description="链接可能已经失效，或者条目已从收藏中移除。"
      action={
        <div className="flex gap-2">
          <Link to="/">
            <Button size="sm" variant="primary">
              回到仪表盘
            </Button>
          </Link>
          <Link to="/library">
            <Button size="sm">浏览收藏库</Button>
          </Link>
        </div>
      }
      className="mt-10"
    />
  );
}
