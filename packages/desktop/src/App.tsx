import { useState } from 'react';
import { useHub } from './hub';
import { Rail, type View } from './components/Rail';
import { TopBar } from './components/TopBar';
import { Office } from './components/Office';
import { SecurityPage } from './components/SecurityPage';
import { TodayPanel } from './components/TodayPanel';

export function App(): JSX.Element {
  const { state, status, send } = useHub();
  const [view, setView] = useState<View>('office');

  return (
    <div className="app">
      <Rail state={state} status={status} view={view} onNavigate={setView} send={send} />
      <main className="main">
        <TopBar state={state} send={send} />
        {view === 'office' ? <Office state={state} /> : <SecurityPage state={state} send={send} />}
      </main>
      <TodayPanel state={state} send={send} />
    </div>
  );
}
