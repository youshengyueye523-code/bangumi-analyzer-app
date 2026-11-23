import { Moon, Sun } from 'lucide-react';
import { Button, IconButton } from '../ui/button.js';
import { useTheme } from '../../lib/theme.js';

const MODE_LABEL = { dark: '深色', light: '浅色', system: '跟随系统' } as const;

export function ThemeToggle({ withLabel = false }: { withLabel?: boolean }) {
  const { mode, resolved, toggle, setMode } = useTheme();
  if (withLabel) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          icon={resolved === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
          onClick={toggle}
        >
          切换到{resolved === 'dark' ? '浅色' : '深色'}
        </Button>
        {(['dark', 'light', 'system'] as const).map((item) => (
          <Button
            key={item}
            size="sm"
            variant={mode === item ? 'secondary' : 'ghost'}
            aria-pressed={mode === item}
            onClick={() => setMode(item)}
          >
            {MODE_LABEL[item]}
          </Button>
        ))}
      </div>
    );
  }
  return (
    <IconButton
      label={resolved === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
      onClick={toggle}
      variant="ghost"
    >
      {resolved === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
    </IconButton>
  );
}
