import { useEffect } from 'preact/hooks';
import { Icon } from './components.tsx';
import type { Controller, Tab } from './controller.ts';
import { AssetScreen, CoinsScreen, ProjectionScreen, useController } from './screens.tsx';
import { SettingsScreen } from './settings.tsx';

const TABS: { id: Tab; label: string; icon: preact.JSX.Element }[] = [
  { id: 'eth', label: 'ETH', icon: Icon.eth },
  { id: 'coins', label: 'Coins', icon: Icon.coins },
  { id: 'projection', label: 'Projection', icon: Icon.projection },
  { id: 'settings', label: 'Settings', icon: Icon.settings },
];

const FEED_LABEL = { live: 'Live', connecting: 'Connecting', polling: 'Polling', offline: 'Offline' } as const;

export function App(props: { c: Controller }) {
  const c = useController(props.c);
  const tab = c.ui.tab;
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [tab, c.ui.coin]);
  return (
    <>
      <div class="shell">
        <header class="topbar">
          <div class="brand">
            {Icon.eth}
            <span>Confluence</span>
          </div>
          <div class="spacer" />
          <span class={`feed ${c.feedStatus}`} title="Live Binance market data connection" data-testid="feed">
            <i />
            {FEED_LABEL[c.feedStatus]}
          </span>
        </header>
        <main>
          {tab === 'eth' && <AssetScreen c={c} symbol="ETHUSDT" mode={c.ui.ethMode} onMode={(m) => c.setUi({ ethMode: m })} />}
          {tab === 'coins' && <CoinsScreen c={c} />}
          {tab === 'projection' && <ProjectionScreen c={c} />}
          {tab === 'settings' && <SettingsScreen c={c} />}
        </main>
      </div>
      <nav class="tabbar" aria-label="Sections">
        <div class="tabbar-inner">
          {TABS.map((t) => (
            <button class="tab" type="button" aria-current={tab === t.id ? 'page' : undefined} onClick={() => c.setUi({ tab: t.id, ...(t.id === 'coins' ? { coin: null } : {}) })}>
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      </nav>
    </>
  );
}
