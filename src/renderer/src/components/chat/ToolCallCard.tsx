import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatToolInput, summarizeToolInput } from '@shared/chatToolSummary';
import type { ChatItem } from '@shared/chatTranscript';

type ToolItem = Extract<ChatItem, { type: 'tool' }>;

/** Collapsed by default: tool name + one-line gist of the input; expands to the JSON input and the result. */
export function ToolCallCard({ item }: { item: ToolItem }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const running = item.status === 'running';
  const failed = item.status === 'error';
  const summary = summarizeToolInput(item.input);
  const accent = failed ? 'var(--cth-coral)' : running ? 'var(--cth-lemon)' : 'var(--cth-mint)';
  const stateLabel = running ? t('chat.toolRunning') : failed ? (item.result ? t('chat.toolFailed') : t('chat.toolInterrupted')) : t('chat.toolDone');

  return (
    <div style={{
      background: 'var(--cth-cream-100)',
      boxShadow: `inset 3px 0 0 ${accent}, inset 0 0 0 1px var(--cth-ink-300)`,
      fontSize: 12
    }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
          padding: '5px 8px 5px 12px', border: 'none', background: 'transparent',
          cursor: 'pointer', textAlign: 'start', color: 'var(--cth-ink-900)', minWidth: 0
        }}
      >
        <span aria-hidden style={{ color: 'var(--cth-ink-500)', width: 10, flexShrink: 0 }}>{open ? '▾' : '▸'}</span>
        <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '14px', flexShrink: 0 }}>
          {item.name.toUpperCase()}
        </span>
        <span dir="ltr" style={{
          flex: 1, minWidth: 0, fontFamily: 'var(--cth-font-mono)', color: 'var(--cth-ink-700)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
        }}>{summary}</span>
        <span style={{ color: failed ? 'var(--cth-coral)' : 'var(--cth-ink-500)', flexShrink: 0 }}>{stateLabel}</span>
      </button>
      {open && (
        <div style={{ padding: '0 8px 8px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Block label={t('chat.toolInput')} text={formatToolInput(item.input)} />
          {item.result !== undefined && (
            <Block label={t('chat.toolResult')} text={item.result} error={item.isError === true} />
          )}
        </div>
      )}
    </div>
  );
}

function Block({ label, text, error = false }: { label: string; text: string; error?: boolean }) {
  return (
    <div>
      <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px', color: 'var(--cth-ink-500)' }}>
        {label.toUpperCase()}
      </div>
      <pre dir="ltr" style={{
        margin: 0, padding: '6px 8px', maxHeight: 220, overflow: 'auto',
        background: error ? 'var(--cth-coral-light)' : 'var(--cth-cream-200)',
        color: error ? 'var(--cth-coral)' : 'var(--cth-ink-900)',
        boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
        fontFamily: 'var(--cth-font-mono)', fontSize: 11.5, lineHeight: 1.45,
        whiteSpace: 'pre-wrap', overflowWrap: 'anywhere'
      }}>{text.length > 0 ? text : '—'}</pre>
    </div>
  );
}
