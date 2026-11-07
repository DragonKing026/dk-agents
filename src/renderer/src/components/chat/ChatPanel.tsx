import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { isClaudeProvider } from '@shared/agentProvider';
import { isComposingKey } from '@shared/imeGuard';
import { PixelButton } from '../PixelButton';
import { ChatMessage } from './ChatMessage';
import { ToolCallCard } from './ToolCallCard';
import { PermissionCard } from './PermissionCard';
import { useChat } from '@/hooks/useChat';
import type { Agent } from '@/store/store';

export interface ChatPanelProps {
  agent: Agent;
}

/** The "Chat" tab: a `claude -p` stream-json conversation with the agent (Claude Code agents only). */
export function ChatPanel({ agent }: ChatPanelProps) {
  const { t } = useTranslation();
  if (!isClaudeProvider(agent.provider ?? 'claude')) {
    return (
      <Centered>{t('chat.unsupported')}</Centered>
    );
  }
  // key: the unsent draft is component state and must not follow the user to another agent.
  return <ClaudeChat key={agent.id} agent={agent} />;
}

function ClaudeChat({ agent }: ChatPanelProps) {
  const { t } = useTranslation();
  const { transcript, send, decide, stop, restart } = useChat(agent.id, agent.model);
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const { items, status } = transcript;

  // Follow the conversation while the user is at the bottom; leave the scroll alone once they scrolled up.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [items, status]);
  useEffect(() => { stickRef.current = true; }, [agent.id]);

  const busy = status === 'running' || status === 'waiting';
  const ended = status === 'ended';

  const submit = () => {
    if (!draft.trim() || busy) return;
    send(draft);
    setDraft('');
    stickRef.current = true;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !isComposingKey(e)) {
      e.preventDefault();
      submit();
    }
  };

  const statusLabel = {
    idle: t('chat.statusIdle'),
    running: t('chat.statusRunning'),
    waiting: t('chat.statusWaiting'),
    ended: t('chat.statusEnded')
  }[status];
  const statusColor = {
    idle: 'var(--cth-status-idle)',
    running: 'var(--cth-status-working)',
    waiting: 'var(--cth-status-waiting)',
    ended: 'var(--cth-ink-500)'
  }[status];

  return (
    <div data-testid="chat-panel" style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--cth-paper-200)' }}>
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}
      >
        {items.length === 0 && <Centered>{t('chat.empty')}</Centered>}
        {items.map((item) => {
          switch (item.type) {
            case 'user':
              return <ChatMessage key={item.id} role="user" text={item.text} />;
            case 'assistant':
              return <ChatMessage key={item.id} role="assistant" text={item.text} root={agent.cwd} />;
            case 'tool':
              return <ToolCallCard key={item.id} item={item} />;
            case 'permission':
              return <PermissionCard key={item.id} item={item} onDecide={decide} />;
            case 'notice':
              return (
                <div key={item.id} role={item.level === 'error' ? 'alert' : 'status'} style={{
                  padding: '6px 10px', fontSize: 12, overflowWrap: 'anywhere',
                  background: item.level === 'error' ? 'var(--cth-coral-light)' : 'var(--cth-cream-200)',
                  color: item.level === 'error' ? 'var(--cth-coral)' : 'var(--cth-ink-700)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
                }}>{item.text}</div>
              );
          }
        })}
      </div>

      <div style={{
        flexShrink: 0, padding: 8, display: 'flex', flexDirection: 'column', gap: 6,
        background: 'var(--cth-cream-100)', borderTop: '1px solid var(--cth-ink-700)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--cth-ink-700)' }}>
          <span aria-hidden style={{ width: 8, height: 8, background: statusColor, flexShrink: 0 }} />
          <span data-testid="chat-status" style={{ flex: 1 }}>{statusLabel}</span>
          {busy && (
            <PixelButton variant="destructive" size="sm" onClick={stop}>{t('chat.stop')}</PixelButton>
          )}
          {ended && (
            <PixelButton variant="primary" size="sm" onClick={restart}>{t('chat.newSession')}</PixelButton>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder={ended ? t('chat.placeholderEnded') : t('chat.placeholder')}
            aria-label={t('chat.inputLabel')}
            disabled={ended}
            style={{
              flex: 1, minWidth: 0, resize: 'none', padding: '6px 8px',
              fontFamily: 'var(--cth-font-ui)', fontSize: 13, lineHeight: 1.4,
              color: 'var(--cth-ink-900)', background: 'var(--cth-paper-100)',
              border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', outline: 'none'
            }}
          />
          <PixelButton variant="primary" size="md" onClick={submit} disabled={ended || busy || !draft.trim()}>
            {t('chat.send')}
          </PixelButton>
        </div>
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16, textAlign: 'center', fontSize: 13, color: 'var(--cth-ink-500)',
      background: 'var(--cth-paper-200)'
    }}>
      <p style={{ margin: 0, maxWidth: 280 }}>{children}</p>
    </div>
  );
}
