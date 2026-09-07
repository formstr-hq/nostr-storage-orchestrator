import { WORKER_MSG } from "../../protocol";

export interface WorkerReply {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export function send(message: Record<string, unknown> & { type: string }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ ...message, via: WORKER_MSG }, (reply) => {
      const error = chrome.runtime.lastError;
      if (error) return reject(new Error(error.message));
      const parsed = reply as WorkerReply | undefined;
      if (!parsed) return reject(new Error("No response from signer worker"));
      if (parsed.ok) resolve(parsed.data);
      else reject(new Error(parsed.error ?? "Signer error"));
    });
  });
}