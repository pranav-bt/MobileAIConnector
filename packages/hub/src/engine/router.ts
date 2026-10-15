import type { EngineId } from '@agent-hq/shared';
import type { OrchestratorEngine, WorkerRunResult } from './types.js';

// Any seat can run any model: each call goes to the engine its model belongs
// to (ModelSpec.engine). The orchestrator only ever sees this router.
export class EngineRouter implements OrchestratorEngine {
  #engines: Record<EngineId, OrchestratorEngine>;

  constructor(engines: Record<EngineId, OrchestratorEngine>) {
    this.#engines = engines;
  }

  engine(id: EngineId): OrchestratorEngine {
    return this.#engines[id];
  }

  complete(args: Parameters<OrchestratorEngine['complete']>[0]): Promise<{ text: string; tokens: number }> {
    return this.#engines[args.model.engine ?? 'claude'].complete(args);
  }

  runWorker(args: Parameters<OrchestratorEngine['runWorker']>[0]): Promise<WorkerRunResult> {
    return this.#engines[args.model.engine ?? 'claude'].runWorker(args);
  }
}
