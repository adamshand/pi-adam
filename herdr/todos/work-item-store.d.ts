export type TodoStatus = "ready" | "in_progress" | "done";

export type ChecklistLeaf = {
	text: string;
	done?: boolean;
};

export type ChecklistItem = ChecklistLeaf & {
	items?: ChecklistLeaf[];
};

type WorkItemBase = {
	path: string;
	id: string;
	title: string;
	intent: string;
	progress: string;
	checklist: ChecklistItem[];
	createdInSessionId?: string;
	createdAt: string;
	updatedAt: string;
};

export type Todo = WorkItemBase & {
	kind: "todo";
	status: TodoStatus;
	ownerSessionId?: string;
};

export type Idea = WorkItemBase & {
	kind: "idea";
	status?: undefined;
	ownerSessionId?: undefined;
};

export type WorkItem = Todo | Idea;

export type WorkItemChanges = {
	title?: string;
	intent?: string;
	progress?: string;
	checklist?: ChecklistItem[];
};

export type CreateWorkItemOptions = WorkItemChanges & {
	id?: string;
	kind: WorkItem["kind"];
	title: string;
	status?: string;
	ownerSessionId?: string;
	createdInSessionId?: string;
	createdAt?: string;
	updatedAt?: string;
};

export const SCHEMA_VERSION: 1;
export const TODO_STATUSES: readonly TodoStatus[];

export function normalizeWorkItemId(value: string): string;
export function normalizeTodoStatus(value?: string | null): TodoStatus;
export function normalizeChecklist(items?: ChecklistItem[] | null): ChecklistItem[];
export function checklistProgress(items?: ChecklistItem[] | null): { done: number; total: number };
export function isCompleted(item: WorkItem): item is Todo & { status: "done" };
export function workItemsDirectory(cwd: string): string;
export function workItemPath(cwd: string, id: string): string;
export function readWorkItem(path: string): WorkItem | undefined;
export function writeWorkItem(item: WorkItem): WorkItem | undefined;
export function createWorkItem(cwd: string, options: CreateWorkItemOptions): WorkItem | undefined;
export function createTodo(cwd: string, options: Omit<CreateWorkItemOptions, "kind">): Todo;
export function createIdea(cwd: string, options: Omit<CreateWorkItemOptions, "kind" | "status" | "ownerSessionId">): Idea;
export function listWorkItems(cwd: string): WorkItem[];
export function listTodos(cwd: string, options?: { sessionId?: string }): Todo[];
export function listIdeas(cwd: string): Idea[];
export function getWorkItem(cwd: string, id: string): WorkItem | undefined;
export function updateWorkItem(cwd: string, id: string, changes: WorkItemChanges): WorkItem | undefined;
export function deleteWorkItem(cwd: string, id: string): WorkItem | undefined;
export function setTodoStatus(cwd: string, id: string, status: TodoStatus | string): Todo | undefined;
export function startTodo(cwd: string, id: string): Todo | undefined;
export function completeTodo(cwd: string, id: string): Todo | undefined;
export function reopenTodo(cwd: string, id: string): Todo | undefined;
export function cycleTodo(item: WorkItem): Todo | undefined;
export function promoteIdea(cwd: string, id: string, ownerSessionId: string): { idea: Idea; todo: Todo } | undefined;
export function deferTodo(cwd: string, id: string, ownerSessionId?: string): { todo: Todo; idea: Idea } | undefined;
export function toggleWorkItemKind(cwd: string, id: string, ownerSessionId?: string): WorkItem | undefined;
export function deleteIdea(cwd: string, id: string): Idea | undefined;
export function clearCompleted(cwd: string, options?: { sessionId?: string }): Todo[];
export function migrateLegacyWorkItems(cwd: string): Array<{ item: WorkItem; sourcePath: string }>;
