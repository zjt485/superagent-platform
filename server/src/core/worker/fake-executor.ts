import type { Report } from '../domain/types.js'
import type { Executor, TurnContext } from './executor.js'

/** Deterministic executor for tests and the offline demo. */
export class FakeExecutor implements Executor {
  readonly kind = 'fake'
  calls: TurnContext[] = []

  constructor(private readonly next: (context: TurnContext) => Report | Promise<Report>) {}

  async run(context: TurnContext): Promise<Report> {
    this.calls.push(context)
    return this.next(context)
  }
}
