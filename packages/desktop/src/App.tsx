import { useEffect, useState } from 'react';
import { hubClient, useHub } from './hub';
import { initShellBridge, openConsoleWindow } from './shell';
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
import { TaskConsole } from './components/TaskConsole';

// A console popped out into its own window loads the app with ?console=<id>
// and shows only that task's console.
const popoutTaskId = new URLSearchParams(window.location.search).get('console');

export function App(): JSX.Element {
  const { state, status, send } = useHub();
  const [view, setView] = useState<View>('office');
  const [consoleTaskId, setConsoleTaskId] = useState<string | null>(null);
  const [popoutTask, setPopoutTask] = useState<string | null>(popoutTaskId);

  useEffect(() => {
    initShellBridge((command) => hubClient.send(command));
  }, []);

  useEffect(() => {
    if (popoutTask) document.title = `Agent HQ · ${state.tasks[popoutTask]?.title ?? 'task console'}`;
  }, [popoutTask, state.tasks]);

  if (popoutTask) {
    return (
      <div className="console-popout">
        <TaskConsole
          state={state}
          taskId={popoutTask}
          send={send}
          onOpenTask={(taskId) => {
            setPopoutTask(taskId);
            window.history.replaceState(null, '', `?console=${encodeURIComponent(taskId)}`);
          }}
        />
      </div>
    );
  }

  const openConsole = (taskId: string) => setConsoleTaskId(taskId);

  return (
    <div className="app">
      <Rail state={state} status={status} view={view} onNavigate={setView} send={send} />
      <main className="main">
        <TopBar state={state} send={send} />
        {view === 'office' && <Office state={state} send={send} />}
        {view === 'tasks' && <TasksPage state={state} send={send} onOpenConsole={openConsole} />}
        {view === 'teams' && <TeamsPage state={state} send={send} />}
        {view === 'pa' && <PaPage state={state} send={send} />}
        {view === 'resources' && <ResourcesPage state={state} send={send} />}
        {view === 'history' && <HistoryPage state={state} onOpenConsole={openConsole} />}
        {view === 'security' && <SecurityPage state={state} send={send} />}
        {view === 'settings' && <SettingsPage state={state} send={send} />}
      </main>
      <TodayPanel state={state} send={send} onOpenConsole={openConsole} />
      {consoleTaskId && (
        <div className="console-drawer">
          <TaskConsole
            state={state}
            taskId={consoleTaskId}
            send={send}
            onClose={() => setConsoleTaskId(null)}
            onOpenTask={openConsole}
            onPopOut={() => {
              const taskId = consoleTaskId;
              void openConsoleWindow(taskId, state.tasks[taskId]?.title ?? 'task').then((opened) => {
                if (opened) setConsoleTaskId(null);
              });
            }}
          />
        </div>
      )}
    </div>
  );
}
