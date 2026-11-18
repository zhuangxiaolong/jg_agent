import { useEffect, useState } from 'react';
import type { ConversationAttachment } from '../../../../packages/domain/src';
import { Icon } from './ui';

interface Props {
  sessionId: string;
  attachment: ConversationAttachment;
  onRemove?: () => void;
}

export function ConversationImagePreview({ sessionId, attachment, onRemove }: Props) {
  const [preview, setPreview] = useState('');
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [fullImage, setFullImage] = useState('');
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    setPreview('');
    setError('');
    window.jinggong.getConversationImage(sessionId, attachment.id).then(source => {
      if (active) setPreview(source);
    }).catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; };
  }, [sessionId, attachment.id, revision]);

  useEffect(() => {
    if (!expanded) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [expanded]);

  async function openFullImage() {
    setExpanded(true);
    setLoading(true);
    setFullImage('');
    try {
      setFullImage(await window.jinggong.getConversationImage(sessionId, attachment.id, true));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setExpanded(false);
    } finally {
      setLoading(false);
    }
  }

  return <figure className={'conversation-image-card' + (onRemove ? ' composer-image-card' : ' message-image-card')}>
    {error
      ? <div className="conversation-image-error" role="alert"><span>图片加载失败：{error}</span><button type="button" className="text-button" onClick={() => setRevision(value => value + 1)}>重试图片</button></div>
      : <button type="button" className="conversation-image-trigger" aria-label={'放大图片 ' + attachment.name} title="双击放大图片" onDoubleClick={event => { event.preventDefault(); void openFullImage(); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void openFullImage(); } }}>
          {preview ? <img src={preview} alt={attachment.name} /> : <span className="conversation-image-loading">正在加载图片…</span>}
          <span className="conversation-image-name">{attachment.name}</span>
        </button>}
    {onRemove && <button type="button" className="conversation-image-remove" aria-label={'移除附件 ' + attachment.name} title="移除附件" onClick={onRemove}><Icon name="close" /></button>}
    {expanded && <div className="conversation-image-overlay" role="dialog" aria-modal="true" aria-label={'图片查看 ' + attachment.name} onClick={() => setExpanded(false)}>
      <div onClick={event => event.stopPropagation()}>
        <header><strong>{attachment.name}</strong><button type="button" className="icon-button" autoFocus aria-label="关闭图片查看" onClick={() => setExpanded(false)}><Icon name="close" /></button></header>
        {loading ? <p className="conversation-image-loading">正在加载原图…</p> : fullImage && <img src={fullImage} alt={attachment.name} />}
      </div>
    </div>}
  </figure>;
}
