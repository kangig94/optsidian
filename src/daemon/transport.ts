import net from "node:net";
import {
  FrameDecoder,
  encodeFrame,
  rpcError,
  type SearchDaemonRequest,
  type SearchDaemonResponse,
  type SearchDaemonResultByMethod,
  type SearchDaemonMethod
} from "./protocol.js";

export type RpcConnection = {
  request(request: SearchDaemonRequest): Promise<unknown>;
  close(): Promise<void>;
};

export type RpcServer = {
  close(): Promise<void>;
};

export type RpcServerOptions = {
  socketPath: string;
  handleRequest(request: SearchDaemonRequest): Promise<unknown>;
  onConnectionClosed?(requestIds: readonly string[]): void;
};

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

const RPC_SOCKET_IDLE_TIMEOUT_MS = 30_000;

export async function connectRpc(socketPath: string): Promise<RpcConnection> {
  const socket = await openSocket(socketPath);
  const decoder = new FrameDecoder();
  const pending = new Map<string, PendingRequest>();
  let closed = false;

  socket.on("data", (chunk) => {
    try {
      for (const message of decoder.push(bufferChunk(chunk))) {
        const response = message as SearchDaemonResponse;
        const waiter = pending.get(response.requestId);
        if (!waiter) continue;
        pending.delete(response.requestId);
        if (response.ok) waiter.resolve(response.result);
        else waiter.reject(rpcResponseError(response.error.code, response.error.message, response.error.details));
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const waiter of pending.values()) waiter.reject(failure);
      pending.clear();
      socket.destroy(failure);
    }
  });

  socket.on("error", (error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });

  socket.on("close", () => {
    closed = true;
    const error = rpcResponseError("SEARCH_DAEMON_UNAVAILABLE", "search daemon socket closed before a response was received");
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });

  return {
    request(request) {
      if (closed) {
        return Promise.reject(rpcResponseError("SEARCH_DAEMON_UNAVAILABLE", "search daemon socket is closed"));
      }
      return new Promise((resolve, reject) => {
        pending.set(request.requestId, { resolve, reject });
        socket.write(encodeFrame(request), (error) => {
          if (!error) return;
          pending.delete(request.requestId);
          reject(error);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        if (closed) {
          resolve();
          return;
        }
        socket.end(() => resolve());
      });
    }
  };
}

export async function createRpcServer(options: RpcServerOptions): Promise<RpcServer> {
  const sockets = new Set<net.Socket>();
  const activeRequestsBySocket = new Map<net.Socket, Set<string>>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    activeRequestsBySocket.set(socket, new Set());
    const decoder = new FrameDecoder();

    socket.setTimeout(RPC_SOCKET_IDLE_TIMEOUT_MS, () => {
      if (decoder.bufferedBytes === 0) return;
      writeBadRequestAndDestroy(socket, "RPC frame timed out before completion");
    });

    socket.on("error", () => {
      socket.destroy();
    });

    socket.on("data", (chunk) => {
      const bufferedChunk = bufferChunk(chunk);
      let messages: unknown[];
      try {
        messages = decoder.push(bufferedChunk);
      } catch (error) {
        writeBadRequestAndDestroy(socket, error instanceof Error ? error.message : String(error));
        return;
      }

      for (const message of messages) {
        if (!isSearchDaemonRequest(message)) {
          writeBadRequestAndDestroy(socket, "RPC request must be an object with string requestId and method");
          return;
        }
        const request = message as SearchDaemonRequest;
        activeRequestsBySocket.get(socket)?.add(request.requestId);
        void Promise.resolve()
          .then(() => options.handleRequest(request))
          .then((result) => {
            if (socket.destroyed) return;
            writeResponse(socket, {
              requestId: request.requestId,
              ok: true,
              result: result as SearchDaemonResultByMethod[SearchDaemonMethod]
            } satisfies SearchDaemonResponse);
          })
          .catch((error) => {
            if (socket.destroyed) return;
            const responseError = errorToRpcError(error);
            writeResponse(socket, { requestId: request.requestId, ok: false, error: responseError } satisfies SearchDaemonResponse);
          })
          .finally(() => {
            activeRequestsBySocket.get(socket)?.delete(request.requestId);
          });
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      const active = activeRequestsBySocket.get(socket);
      activeRequestsBySocket.delete(socket);
      if (active && active.size > 0) options.onConnectionClosed?.([...active]);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    close() {
      return new Promise((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  };
}

function writeResponse(socket: net.Socket, response: SearchDaemonResponse, onComplete?: () => void): void {
  if (socket.destroyed) {
    onComplete?.();
    return;
  }
  socket.write(encodeFrame(response), (error) => {
    if (error) socket.destroy();
    onComplete?.();
  });
}

function writeBadRequestAndDestroy(socket: net.Socket, message: string): void {
  writeResponse(socket, {
    requestId: "invalid-frame",
    ok: false,
    error: rpcError("BAD_REQUEST", message)
  } satisfies SearchDaemonResponse, () => socket.destroy());
}

function isSearchDaemonRequest(message: unknown): message is SearchDaemonRequest {
  return message !== null &&
    typeof message === "object" &&
    typeof (message as { requestId?: unknown }).requestId === "string" &&
    typeof (message as { method?: unknown }).method === "string";
}

function openSocket(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function errorToRpcError(error: unknown) {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return rpcError(
      (error as { code: string }).code as never,
      error instanceof Error ? error.message : String(error),
      "details" in error ? (error as { details?: unknown }).details : undefined
    );
  }
  return rpcError("INTERNAL", error instanceof Error ? error.message : String(error));
}

function rpcResponseError(code: string, message: string, details?: unknown): Error {
  const error = new Error(message) as Error & { code?: string; details?: unknown };
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function bufferChunk(chunk: string | Buffer): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}
