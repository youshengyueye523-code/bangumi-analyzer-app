import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 只读图片入口只接受目录内普通独立文件；不跟随路径、重解析点或硬链接。 */
export function existingImagePath(directory: string, name: string): string | null {
  if (!/^[A-Za-z0-9._-]+\.(?:jpg|jpeg|png|webp|gif)$/i.test(name)) return null;
  const file = join(directory, name);
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || dirname(realpathSync(file)) !== realpathSync(directory)) return null;
    return file;
  } catch { return null; }
}
