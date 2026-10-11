import type { WorkClient, RemoteWorkItem, WorkCapture } from "./work-client.js";
import type { Todo, WorkItemChanges } from "./work-item-store.js";
export class WorkIdeas {
 constructor(client?: WorkClient);
 client: WorkClient;
 update(cwd: string, id: string, changes: WorkItemChanges): Promise<RemoteWorkItem>;
 drop(cwd: string, id: string): Promise<RemoteWorkItem>;
 promote(cwd: string, id: string, sessionId: string): Promise<Todo>;
 complete(todo: Todo): Promise<RemoteWorkItem>;
 defer(cwd: string, id: string, sessionId: string): Promise<WorkCapture | { item: RemoteWorkItem; queued: false }>;
}
