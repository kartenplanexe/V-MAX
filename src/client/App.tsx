import { Button, Panel } from '@maxhub/max-ui';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ApiError, MaxAuthSuccess } from '../shared/auth';

type ConnectionState =
  | { kind: 'checking' }
  | { kind: 'preview' }
  | { kind: 'ready'; auth: MaxAuthSuccess }
  | { kind: 'error'; message: string };

interface StageProps {
  caption: string;
  detail: string;
  state: 'done' | 'active' | 'pending' | 'warning';
  title: string;
}

function Stage({ caption, detail, state, title }: StageProps) {
  return (
    <li className={`stage stage--${state}`}>
      <span className="stage__dot" aria-hidden="true" />
      <div className="stage__copy">
        <span className="stage__caption">{caption}</span>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
    </li>
  );
}

async function authenticate(initData: string, signal: AbortSignal): Promise<MaxAuthSuccess> {
  const response = await fetch('/api/auth/max', {
    body: JSON.stringify({ initData }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
    signal,
  });

  const body = (await response.json()) as MaxAuthSuccess | ApiError;
  if (!response.ok || body.status !== 'authenticated') {
    const message = body.status === 'error' ? body.message : 'Не удалось проверить запуск.';
    throw new Error(message);
  }

  return body;
}

export function App() {
  const [attempt, setAttempt] = useState(0);
  const [connection, setConnection] = useState<ConnectionState>({ kind: 'checking' });
  const bridge = window.WebApp;
  const initData = bridge?.initData?.trim() ?? '';
  const hasMaxLaunch = initData.length > 0;

  useEffect(() => {
    const controller = new AbortController();

    if (!initData) {
      setConnection({ kind: 'preview' });
      return () => controller.abort();
    }

    setConnection({ kind: 'checking' });
    authenticate(initData, controller.signal)
      .then((auth) => setConnection({ auth, kind: 'ready' }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setConnection({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Не удалось проверить запуск.',
        });
      });

    return () => controller.abort();
  }, [attempt, initData]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const status = useMemo(() => {
    if (connection.kind === 'ready') {
      return {
        eyebrow: 'Подключение подтверждено',
        lead: `MAX передал корректные данные запуска для ${connection.auth.user.firstName}.`,
        title: 'Контекст MAX готов',
      };
    }

    if (connection.kind === 'preview') {
      return {
        eyebrow: 'Режим предпросмотра',
        lead: 'Здесь можно проверить адаптивность. Подпись пользователя появится при запуске через кнопку бота.',
        title: 'Оболочка mini-app',
      };
    }

    if (connection.kind === 'error') {
      return {
        eyebrow: 'Нужна повторная проверка',
        lead: connection.message,
        title: 'Запуск не подтверждён',
      };
    }

    return {
      eyebrow: 'Безопасный запуск',
      lead: 'Сверяем данные запуска с сервером. Токен бота остаётся только на серверной стороне.',
      title: 'Подключаемся к MAX',
    };
  }, [connection]);

  const bridgeDetail = hasMaxLaunch
    ? `${bridge?.platform ?? 'платформа не указана'} · версия ${bridge?.version ?? 'не указана'}`
    : 'Внешний браузер — без данных пользователя';

  return (
    <Panel className="app-shell">
      <main className="launch-card">
        <header className="launch-card__header">
          <div className="assistant-mark" aria-hidden="true">
            <span />
          </div>
          <div>
            <span className="product-label">Планировщик досуга</span>
            <span className="product-context">мини-приложение MAX</span>
          </div>
        </header>

        <section className="hero" aria-live="polite">
          <span className="hero__eyebrow">{status.eyebrow}</span>
          <h1>{status.title}</h1>
          <p>{status.lead}</p>
        </section>

        <ol className="dayline" aria-label="Состояние подключения">
          <Stage
            caption="01 · Контекст"
            detail={bridgeDetail}
            state={hasMaxLaunch ? 'done' : 'warning'}
            title={hasMaxLaunch ? 'Открыто через MAX Bridge' : 'Открыто вне MAX'}
          />
          <Stage
            caption="02 · Доверие"
            detail={
              connection.kind === 'ready'
                ? 'Подпись и срок действия проверены сервером'
                : connection.kind === 'error'
                  ? connection.message
                  : connection.kind === 'preview'
                    ? 'Проверка доступна только при запуске из MAX'
                    : 'Проверяем подпись запуска'
            }
            state={
              connection.kind === 'ready'
                ? 'done'
                : connection.kind === 'error'
                  ? 'warning'
                  : connection.kind === 'preview'
                    ? 'pending'
                    : 'active'
            }
            title={connection.kind === 'ready' ? 'Пользователь подтверждён' : 'Серверная проверка'}
          />
          <Stage
            caption="03 · Следующий этап"
            detail="Подключим типизированный запрос и детерминированный планировщик после утверждения механизмов M2"
            state="pending"
            title="План на день"
          />
        </ol>

        <footer className="launch-card__footer">
          {connection.kind === 'error' && (
            <Button onClick={retry}>Повторить проверку</Button>
          )}
          <p>
            Данные пользователя не сохраняются этой оболочкой. Внешний браузер работает только как предпросмотр.
          </p>
        </footer>
      </main>
    </Panel>
  );
}
