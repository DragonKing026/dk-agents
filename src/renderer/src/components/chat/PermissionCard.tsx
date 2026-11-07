import { useTranslation } from 'react-i18next';
import { PixelButton } from '../PixelButton';
import { formatToolInput, summarizeToolInput } from '@shared/chatToolSummary';
import type { ChatItem } from '@shared/chatTranscript';

type PermissionItem = Extract<ChatItem, { type: 'permission' }>;

export interface PermissionCardProps {
  item: PermissionItem;
  onDecide: (requestId: string, allow: boolean) => void;
}

/** A tool the agent wants to run and needs a yes/no for; after the decision it stays as a one-line record. */
export function PermissionCard({ item, onDecide }: PermissionCardProps) {
  const { t } = useTranslation();
  const pending = item.state === 'pending';
  const summary = summarizeToolInput(item.input);
  const stateLabel = {
    pending: '',
    allowed: t('chat.permAllowed'),
    denied: t('chat.permDenied'),
    cancelled: t('chat.permCancelled')
  }[item.state];
  return (
    <div role={pending ? 'alertdialog' : undefined} style={{
      background: pending ? 'var(--cth-lemon-light)' : 'var(--cth-cream-100)',
      boxShadow: `inset 3px 0 0 ${pending ? 'var(--cth-lemon)' : 'var(--cth-ink-300)'}, inset 0 0 0 1px var(--cth-ink-300)`,
      padding: '7px 8px 7px 12px', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 6
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
        <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '14px', flexShrink: 0 }}>
          {t('chat.permTitle', { tool: item.toolName }).toUpperCase()}
        </span>
        {!pending && <span style={{ color: 'var(--cth-ink-500)', marginInlineStart: 'auto' }}>{stateLabel}</span>}
      </div>
      {summary && (
        <div dir="ltr" style={{
          fontFamily: 'var(--cth-font-mono)', color: 'var(--cth-ink-700)', overflowWrap: 'anywhere'
        }}>{summary}</div>
      )}
      {pending && (
        <>
          <details>
            <summary style={{ cursor: 'pointer', color: 'var(--cth-ink-500)' }}>{t('chat.toolInput')}</summary>
            <pre dir="ltr" style={{
              margin: '4px 0 0', padding: '6px 8px', maxHeight: 160, overflow: 'auto',
              background: 'var(--cth-cream-200)', fontFamily: 'var(--cth-font-mono)', fontSize: 11.5,
              whiteSpace: 'pre-wrap', overflowWrap: 'anywhere'
            }}>{formatToolInput(item.input)}</pre>
          </details>
          <div style={{ display: 'flex', gap: 8 }}>
            <PixelButton variant="primary" size="sm" onClick={() => onDecide(item.requestId, true)}>
              {t('chat.allow')}
            </PixelButton>
            <PixelButton variant="secondary" size="sm" onClick={() => onDecide(item.requestId, false)}>
              {t('chat.deny')}
            </PixelButton>
          </div>
        </>
      )}
    </div>
  );
}
