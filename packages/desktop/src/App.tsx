import { useEffect, useState } from 'react';
import { hubClient, useHub } from './hub';
import { initShellBridge } from './shell';
import { Rail, type View } from './components/Rail';
import { TopBar } from './components/TopBar';
import { Office } from './components/Office';
import { TasksPage } from './components/TasksPage';
import { PaPage } from './components/PaPage';
import { TeamsPage } from './components/TeamsPage';
import { ResourcesPage } from './components/ResourcesPage';
import { HistoryPage } from './components/HistoryPage';
import { SecurityPage } from './components/SecurityPage';
import { SettingsPage } from './components/SettingsPage';
import { TodayPanel } from './components/TodayPanel';

export function App(): JSX.Element {
  const { state, status, send } = useHub();
  const [view, setView] = useState<View>('office');

  useEffect(() => {
    initShellBridge((command) => hubClient.send(command));
  }, []);

  return (
    <div className="app">
      <Rail state={state} status={status} view={view} onNavigate={setView} send={send} />
      <main className="main">
        <TopBar state={state} send={send} />
        {view === 'office' && <Office state={state} send={send} />}
        {view === 'tasks' && <TasksPage state={state} send={send} />}
        {view === 'teams' && <TeamsPage state={state} send={send} />}
        {view === 'pa' && <PaPage state={state} send={send} />}
        {view === 'resources' && <ResourcesPage state={state} />}
        {view === 'history' && <HistoryPage state={state} />}
        {view === 'security' && <SecurityPage state={state} send={send} />}
        {view === 'settings' && <SettingsPage state={state} send={send} />}
      </main>
      <TodayPanel state={state} send={send} />
    </div>
  );
}
