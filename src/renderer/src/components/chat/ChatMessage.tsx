import { useTranslation } from 'react-i18next';
import { MarkdownPreview } from '@/markdown/MarkdownPreview';

export interface ChatMessageProps {
  role: 'user' | 'assistant';
  text: string;
  /** Agent working directory: lets markdown resolve local images relative to it. */
  root?: string;
}

/** One chat bubble: the user's text as plain pre-wrapped text, the agent's as rendered markdown. */
export function ChatMessage({ role, text, root }: ChatMessageProps) {
  const { t } = useTranslation();
  const user = role === 'user';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: user ? 'flex-end' : 'stretch', gap: 2 }}>
      <div style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
        color: 'var(--cth-ink-500)'
      }}>{(user ? t('chat.you') : t('chat.agent')).toUpperCase()}</div>
      <div style={{
        maxWidth: '100%',
        background: user ? 'var(--cth-cream-200)' : 'var(--cth-paper-100)',
        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
        padding: user ? '6px 10px' : 0,
        fontSize: 13, lineHeight: 1.5, color: 'var(--cth-ink-900)',
        overflowWrap: 'anywhere'
      }}>
        {user
          ? <div style={{ whiteSpace: 'pre-wrap' }}>{text}</div>
          : <MarkdownPreview source={text} root={root} variant="card" />}
      </div>
    </div>
  );
}
