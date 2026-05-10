import { InlineKeyboard } from "grammy";

import type { PiSessionContext } from "../pi-session.js";
import { renderDialogPanel, trimLine } from "./message-rendering.js";
import type { TextOptions } from "./telegram-transport.js";

export type PendingExtensionDialog =
  | {
      kind: "select";
      dialogId: string;
      target: PiSessionContext;
      messageId: number;
      title: string;
      options: string[];
      resolve: (value: string | undefined) => void;
      timeoutId?: NodeJS.Timeout;
      abortCleanup?: () => void;
    }
  | {
      kind: "confirm";
      dialogId: string;
      target: PiSessionContext;
      messageId: number;
      title: string;
      message: string;
      resolve: (value: boolean) => void;
      timeoutId?: NodeJS.Timeout;
      abortCleanup?: () => void;
    }
  | {
      kind: "input";
      dialogId: string;
      target: PiSessionContext;
      messageId: number;
      title: string;
      placeholder?: string;
      resolve: (value: string | undefined) => void;
      timeoutId?: NodeJS.Timeout;
      abortCleanup?: () => void;
    };

export type DialogCallbackResult = {
  callbackText: string;
  afterAnswer?: () => Promise<void>;
};

export interface ExtensionDialogManager {
  hasPending(target: PiSessionContext): boolean;
  getPendingKind(target: PiSessionContext): PendingExtensionDialog["kind"] | undefined;
  openSelect(
    target: PiSessionContext,
    title: string,
    options: string[],
    dialogOptions?: { signal?: AbortSignal; timeout?: number },
  ): Promise<string | undefined>;
  openConfirm(
    target: PiSessionContext,
    title: string,
    message: string,
    dialogOptions?: { signal?: AbortSignal; timeout?: number },
  ): Promise<boolean>;
  openInput(
    target: PiSessionContext,
    title: string,
    placeholder?: string,
    dialogOptions?: { signal?: AbortSignal; timeout?: number },
  ): Promise<string | undefined>;
  consumeInput(target: PiSessionContext, userText: string): Promise<boolean>;
  cancelPending(target: PiSessionContext): Promise<boolean>;
  resolveSelect(
    target: PiSessionContext,
    dialogId: string,
    messageId: number | undefined,
    optionIndex: number,
  ): Promise<DialogCallbackResult>;
  resolveConfirm(
    target: PiSessionContext,
    dialogId: string,
    messageId: number | undefined,
    confirmed: boolean,
  ): Promise<DialogCallbackResult>;
  resolveConfirmByMessage(
    chatId: number | string,
    messageId: number,
    confirmed: boolean,
  ): Promise<DialogCallbackResult | undefined>;
  resolveCancel(
    target: PiSessionContext,
    dialogId: string,
    messageId: number | undefined,
  ): Promise<DialogCallbackResult>;
}

export function createExtensionDialogManager(deps: {
  getContextKey: (target: PiSessionContext) => string;
  sendTextMessage: (
    target: PiSessionContext,
    text: string,
    options?: TextOptions,
  ) => Promise<{ message_id: number }>;
  editMessage: (
    target: PiSessionContext,
    messageId: number,
    text: string,
    options?: TextOptions,
  ) => Promise<void>;
  defaultTimeoutMs: number;
}): ExtensionDialogManager {
  const pendingDialogs = new Map<string, PendingExtensionDialog>();
  let extensionDialogCounter = 0;

  const nextExtensionDialogId = (): string => {
    extensionDialogCounter += 1;
    return extensionDialogCounter.toString(36);
  };

  const clearPending = (contextKey: string): PendingExtensionDialog | undefined => {
    const pendingDialog = pendingDialogs.get(contextKey);
    if (!pendingDialog) {
      return undefined;
    }

    pendingDialogs.delete(contextKey);
    if (pendingDialog.timeoutId) {
      clearTimeout(pendingDialog.timeoutId);
    }
    pendingDialog.abortCleanup?.();
    return pendingDialog;
  };

  const finalizePending = async (
    target: PiSessionContext,
    pendingDialog: PendingExtensionDialog | undefined,
    rendered: { text: string; fallbackText: string; parseMode?: "HTML" },
  ): Promise<void> => {
    if (!pendingDialog) {
      return;
    }

    await deps.editMessage(target, pendingDialog.messageId, rendered.text, {
      fallbackText: rendered.fallbackText,
      parseMode: rendered.parseMode,
      replyMarkup: undefined,
    });
  };

  const resolveCancelled = (pendingDialog: PendingExtensionDialog): void => {
    switch (pendingDialog.kind) {
      case "confirm":
        pendingDialog.resolve(false);
        return;
      case "select":
      case "input":
        pendingDialog.resolve(undefined);
        return;
    }
  };

  const createDialogTimeout = (
    contextKey: string,
    target: PiSessionContext,
    pendingDialog: PendingExtensionDialog,
    onTimeout: () => void,
    timeoutMs?: number,
  ): NodeJS.Timeout | undefined => {
    const delay = timeoutMs ?? deps.defaultTimeoutMs;
    return setTimeout(() => {
      if (pendingDialogs.get(contextKey)?.dialogId !== pendingDialog.dialogId) {
        return;
      }
      clearPending(contextKey);
      void finalizePending(target, pendingDialog, renderDialogPanel(pendingDialog.title, ["Dialog timed out."], "⏰")).catch((error) => {
        console.error("Failed to finalize timed-out extension dialog", error);
      });
      onTimeout();
    }, delay);
  };

  const getPending = (target: PiSessionContext): PendingExtensionDialog | undefined =>
    pendingDialogs.get(deps.getContextKey(target));

  return {
    hasPending(target) {
      return pendingDialogs.has(deps.getContextKey(target));
    },

    getPendingKind(target) {
      return getPending(target)?.kind;
    },

    async openSelect(target, title, options, dialogOptions) {
      const contextKey = deps.getContextKey(target);
      if (pendingDialogs.has(contextKey)) {
        throw new Error("TelePi already has a pending extension dialog for this chat/topic.");
      }

      const dialogId = nextExtensionDialogId();
      const keyboard = new InlineKeyboard();
      for (const [index, option] of options.entries()) {
        keyboard.text(`${index + 1}. ${trimLine(option, 44)}`, `ui_sel_${dialogId}_${index}`).row();
      }
      keyboard.text("✖️ Cancel", `ui_x_${dialogId}`).row();

      const rendered = renderDialogPanel(title, [
        `${options.length} option${options.length === 1 ? "" : "s"} available.`,
        "Use the buttons below.",
      ], "🧭");
      const message = await deps.sendTextMessage(target, rendered.text, {
        parseMode: rendered.parseMode,
        fallbackText: rendered.fallbackText,
        replyMarkup: keyboard,
      });

      return await new Promise<string | undefined>((resolve) => {
        const pendingDialog: PendingExtensionDialog = {
          kind: "select",
          dialogId,
          target,
          messageId: message.message_id,
          title,
          options,
          resolve,
        };
        if (dialogOptions?.signal) {
          const onAbort = () => {
            clearPending(contextKey);
            void finalizePending(target, pendingDialog, renderDialogPanel(pendingDialog.title, ["Dialog cancelled."], "⛔"));
            resolve(undefined);
          };
          dialogOptions.signal.addEventListener("abort", onAbort, { once: true });
          pendingDialog.abortCleanup = () => dialogOptions.signal?.removeEventListener("abort", onAbort);
        }
        pendingDialog.timeoutId = createDialogTimeout(contextKey, target, pendingDialog, () => resolve(undefined), dialogOptions?.timeout);
        pendingDialogs.set(contextKey, pendingDialog);
      });
    },

    async openConfirm(target, title, message, dialogOptions) {
      const contextKey = deps.getContextKey(target);
      if (pendingDialogs.has(contextKey)) {
        throw new Error("TelePi already has a pending extension dialog for this chat/topic.");
      }

      const dialogId = nextExtensionDialogId();
      const rendered = renderDialogPanel(title, [message, "Choose Yes or No below."], "⚠️");
      const telegramMessage = await deps.sendTextMessage(target, rendered.text, {
        parseMode: rendered.parseMode,
        fallbackText: rendered.fallbackText,
        replyMarkup: new InlineKeyboard()
          .text("✅ Yes", `ui_cfm_${dialogId}_yes`)
          .text("✖️ No", `ui_cfm_${dialogId}_no`)
          .row(),
      });

      return await new Promise<boolean>((resolve) => {
        const pendingDialog: PendingExtensionDialog = {
          kind: "confirm",
          dialogId,
          target,
          messageId: telegramMessage.message_id,
          title,
          message,
          resolve,
        };
        if (dialogOptions?.signal) {
          const onAbort = () => {
            clearPending(contextKey);
            void finalizePending(target, pendingDialog, renderDialogPanel(pendingDialog.title, ["Dialog cancelled."], "⛔"));
            resolve(false);
          };
          dialogOptions.signal.addEventListener("abort", onAbort, { once: true });
          pendingDialog.abortCleanup = () => dialogOptions.signal?.removeEventListener("abort", onAbort);
        }
        pendingDialog.timeoutId = createDialogTimeout(contextKey, target, pendingDialog, () => resolve(false), dialogOptions?.timeout);
        pendingDialogs.set(contextKey, pendingDialog);
      });
    },

    async openInput(target, title, placeholder, dialogOptions) {
      const contextKey = deps.getContextKey(target);
      if (pendingDialogs.has(contextKey)) {
        throw new Error("TelePi already has a pending extension dialog for this chat/topic.");
      }

      const dialogId = nextExtensionDialogId();
      const rendered = renderDialogPanel(
        title,
        [placeholder ?? "Reply in chat below.", placeholder ? "Reply in chat below." : ""].filter((line) => line.length > 0),
        "✍️",
      );
      const telegramMessage = await deps.sendTextMessage(
        target,
        rendered.text,
        {
          parseMode: rendered.parseMode,
          fallbackText: rendered.fallbackText,
          replyMarkup: new InlineKeyboard().text("✖️ Cancel", `ui_x_${dialogId}`).row(),
        },
      );

      return await new Promise<string | undefined>((resolve) => {
        const pendingDialog: PendingExtensionDialog = {
          kind: "input",
          dialogId,
          target,
          messageId: telegramMessage.message_id,
          title,
          placeholder,
          resolve,
        };
        if (dialogOptions?.signal) {
          const onAbort = () => {
            clearPending(contextKey);
            void finalizePending(target, pendingDialog, renderDialogPanel(pendingDialog.title, ["Input cancelled."], "⛔"));
            resolve(undefined);
          };
          dialogOptions.signal.addEventListener("abort", onAbort, { once: true });
          pendingDialog.abortCleanup = () => dialogOptions.signal?.removeEventListener("abort", onAbort);
        }
        pendingDialog.timeoutId = createDialogTimeout(contextKey, target, pendingDialog, () => resolve(undefined), dialogOptions?.timeout);
        pendingDialogs.set(contextKey, pendingDialog);
      });
    },

    async consumeInput(target, userText) {
      const contextKey = deps.getContextKey(target);
      const pendingDialog = pendingDialogs.get(contextKey);
      if (!pendingDialog || pendingDialog.kind !== "input") {
        return false;
      }

      clearPending(contextKey);
      try {
        await finalizePending(
          target,
          pendingDialog,
          renderDialogPanel(pendingDialog.title, [`Received: ${userText}`], "✅"),
        );
      } finally {
        pendingDialog.resolve(userText);
      }
      return true;
    },

    async cancelPending(target) {
      const contextKey = deps.getContextKey(target);
      const pendingDialog = clearPending(contextKey);
      if (!pendingDialog) {
        return false;
      }

      resolveCancelled(pendingDialog);
      await finalizePending(target, pendingDialog, renderDialogPanel(pendingDialog.title, ["Dialog cancelled."], "⛔"));
      return true;
    },

    async resolveSelect(target, dialogId, messageId, optionIndex) {
      const contextKey = deps.getContextKey(target);
      const pendingDialog = pendingDialogs.get(contextKey);
      if (!pendingDialog || pendingDialog.kind !== "select" || pendingDialog.dialogId !== dialogId || pendingDialog.messageId !== messageId) {
        return { callbackText: "Dialog expired" };
      }

      const selected = pendingDialog.options[optionIndex];
      if (!selected) {
        return { callbackText: "Option expired" };
      }

      clearPending(contextKey);
      return {
        callbackText: `Selected ${trimLine(selected, 32)}`,
        afterAnswer: async () => {
          try {
            await finalizePending(
              target,
              pendingDialog,
              renderDialogPanel(pendingDialog.title, [`Selected: ${selected}`], "✅"),
            );
          } finally {
            pendingDialog.resolve(selected);
          }
        },
      };
    },

    async resolveConfirm(target, dialogId, messageId, confirmed) {
      const contextKey = deps.getContextKey(target);
      const pendingDialog = pendingDialogs.get(contextKey);
      if (!pendingDialog || pendingDialog.kind !== "confirm" || pendingDialog.dialogId !== dialogId || pendingDialog.messageId !== messageId) {
        return { callbackText: "Dialog expired" };
      }

      clearPending(contextKey);
      return {
        callbackText: confirmed ? "Confirmed" : "Cancelled",
        afterAnswer: async () => {
          try {
            await finalizePending(
              target,
              pendingDialog,
              renderDialogPanel(pendingDialog.title, [confirmed ? "Confirmed." : "Cancelled."], confirmed ? "✅" : "⛔"),
            );
          } finally {
            pendingDialog.resolve(confirmed);
          }
        },
      };
    },

    async resolveConfirmByMessage(chatId, messageId, confirmed) {
      for (const [contextKey, pendingDialog] of pendingDialogs.entries()) {
        if (pendingDialog.kind !== "confirm" || pendingDialog.messageId !== messageId) {
          continue;
        }

        if (pendingDialog.target.chatId !== chatId) {
          continue;
        }

        clearPending(contextKey);
        return {
          callbackText: confirmed ? "Confirmed" : "Cancelled",
          afterAnswer: async () => {
            try {
              await finalizePending(
                pendingDialog.target,
                pendingDialog,
                renderDialogPanel(pendingDialog.title, [confirmed ? "Confirmed." : "Cancelled."], confirmed ? "✅" : "⛔"),
              );
            } finally {
              pendingDialog.resolve(confirmed);
            }
          },
        };
      }

      return undefined;
    },

    async resolveCancel(target, dialogId, messageId) {
      const contextKey = deps.getContextKey(target);
      const pendingDialog = pendingDialogs.get(contextKey);
      if (!pendingDialog || pendingDialog.dialogId !== dialogId || pendingDialog.messageId !== messageId) {
        return { callbackText: "Dialog expired" };
      }

      clearPending(contextKey);
      return {
        callbackText: "Cancelled",
        afterAnswer: async () => {
          resolveCancelled(pendingDialog);
          await finalizePending(target, pendingDialog, renderDialogPanel(pendingDialog.title, ["Dialog cancelled."], "⛔"));
        },
      };
    },
  };
}
