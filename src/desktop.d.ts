export {};
declare global {
  interface Window {
    intelboard: {
      request(
        route: string,
        method: string,
        body?: unknown,
      ): Promise<{
        ok: boolean;
        data?: unknown;
        error?: string;
        status?: number;
      }>;
      transfer(operation: string, boardId?: string): Promise<unknown>;
      saveOnExit(id: string, board: unknown): { ok: boolean; error?: string };
      collaboration(
        operation: string,
        boardId?: string,
        body?: unknown,
      ): Promise<{ ok: boolean; data?: unknown; error?: string }>;
      saveCollaboration(
        boardId: string,
        body: unknown,
      ): { ok: boolean; error?: string };
      onCollaboration(
        listener: (event: {
          type: string;
          boardId: string;
          updates?: string[];
          reset?: string;
          assetsChanged?: boolean;
        }) => void,
      ): () => void;
    };
  }
}
