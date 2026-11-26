import { EventEmitter } from 'node:events'

export type ProjectEventType =
  | 'room.message'
  | 'bot.status'
  | 'turn.event'
  | 'ticket.updated'
  | 'approval.created'
  | 'approval.resolved'
  | 'routine.run'

export interface ProjectStreamEvent {
  type: ProjectEventType
  projectId: string
  timestamp: string
  data: Record<string, unknown>
}

export type ProjectEventListener = (event: ProjectStreamEvent) => void

/**
 * In-process pub/sub bus for real-time SSE streaming per project.
 * Designed with a narrow interface so a Redis Pub/Sub bridge can fan out
 * across multiple API replicas without changing callers.
 */
export class ProjectEventBus {
  private readonly emitter = new EventEmitter()

  constructor() {
    this.emitter.setMaxListeners(500)
  }

  publish(projectId: string, type: ProjectEventType, data: Record<string, unknown>): ProjectStreamEvent {
    const event: ProjectStreamEvent = {
      type,
      projectId,
      timestamp: new Date().toISOString(),
      data,
    }
    this.emitter.emit(this.channelOf(projectId), event)
    return event
  }

  subscribe(projectId: string, listener: ProjectEventListener): () => void {
    const channel = this.channelOf(projectId)
    this.emitter.on(channel, listener)
    return () => {
      this.emitter.off(channel, listener)
    }
  }

  private channelOf(projectId: string): string {
    return `project:${projectId}`
  }
}

export const defaultEventBus = new ProjectEventBus()

export function createEventBus(): ProjectEventBus {
  return new ProjectEventBus()
}
