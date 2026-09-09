import { useHub } from './hub';
import { Rail } from './components/Rail';
import { TopBar } from './components/TopBar';
import { Office } from './components/Office';
import { TodayPanel } from './components/TodayPanel';

export function App(): JSX.Element {
  const { state, status, send } = useHub();

  return (
    <div className="app">
      <Rail status={status} send={send} />
      <main className="main">
        <TopBar state={state} send={send} />
        <Office state={state} />
      </main>
      <TodayPanel state={state} send={send} />
    </div>
  );
}
