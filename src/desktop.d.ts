export {};
declare global {
  interface Window {
    intelboard: {
      request(route: string, method: string, body?: unknown): Promise<{ok:boolean;data?:unknown;error?:string;status?:number}>;
      transfer(operation: string, boardId?: string): Promise<unknown>;
      saveOnExit(id: string, board: unknown): {ok:boolean;error?:string};
    };
  }
}
