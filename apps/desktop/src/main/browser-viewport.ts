import { z } from 'zod';
import { idSchema } from './security';

const coordinate = z.number().finite().min(-100000).max(100000);
export const browserViewportSchema = z.object({
  sessionId: idSchema,
  visible: z.boolean(),
  bounds: z.object({ x: coordinate, y: coordinate, width: coordinate.min(0), height: coordinate.min(0) }).strict().optional(),
}).strict().refine(value => !value.visible || !!value.bounds, '显示浏览器时须提供页面区域');

/** DOM 坐标转换为原生视图的 DIP，并裁剪到主窗口内容区。 */
export function browserViewportBounds(bounds: { x: number; y: number; width: number; height: number }, size: number[], zoom = 1) {
  const x = Math.max(0, Math.min(size[0], Math.round(bounds.x * zoom)));
  const y = Math.max(0, Math.min(size[1], Math.round(bounds.y * zoom)));
  const right = Math.max(x, Math.min(size[0], Math.round((bounds.x + bounds.width) * zoom)));
  const bottom = Math.max(y, Math.min(size[1], Math.round((bounds.y + bounds.height) * zoom)));
  return { x, y, width: right - x, height: bottom - y };
}
