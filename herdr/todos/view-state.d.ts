export type BoardView = "todos" | "ideas";
export type BoardViewState = { view: BoardView };

export const BOARD_VIEWS: readonly BoardView[];
export function normalizeBoardView(value?: string, fallback?: BoardView): BoardView;
export function readViewState(path: string, fallbackView?: BoardView): BoardViewState;
export function writeViewState(path: string, state: BoardViewState): void;
