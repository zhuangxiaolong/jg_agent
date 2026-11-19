import { Icon } from './ui';
import type { ConversationAttachment } from '../../../../packages/domain/src';

function fileSize(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function ConversationFilePreview({ attachment }: { attachment: ConversationAttachment }) {
  return <div className="conversation-file-card" title={`${attachment.name}（${attachment.size} 字节）`}>
    <span className="conversation-file-icon"><Icon name="file" /></span>
    <span className="conversation-file-details"><strong>{attachment.name}</strong><small>{fileSize(attachment.size)} · {attachment.mimeType || '文件'}</small></span>
  </div>;
}
