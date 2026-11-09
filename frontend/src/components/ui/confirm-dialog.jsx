"use client";

/**
 * A question that must be answered before something happens: "Remove this person?", "Delete this
 * file?". It replaces `window.confirm`, which the browser draws in its own grey box, in its own
 * words for the buttons, outside the product's theme — and which some browsers let a page suppress.
 *
 * Built on the app's `Dialog`, so focus is held inside it while it is open and goes back to where
 * it was when it closes, and Escape, a click outside and Cancel all answer no. When the action
 * destroys something the button is drawn in coral and Cancel has the focus, so a reflexive Enter
 * does not do the harm; otherwise the confirm button has it.
 *
 * Most callers want it as a question in the middle of a handler, which `useConfirm` gives:
 *
 *   const [confirm, confirmDialog] = useConfirm();
 *   if (!(await confirm({ title: "Leave this workspace?", confirmLabel: "Leave", destructive: true }))) return;
 *   …
 *   return <>{…}{confirmDialog}</>;
 */

import { useCallback, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

/**
 * The dialog itself, for a caller that holds its own open state.
 *
 * @param {object} props
 * @param {boolean} props.open
 * @param {import("react").ReactNode} props.title the question, as a sentence
 * @param {import("react").ReactNode} [props.description] what follows from answering yes
 * @param {string} [props.confirmLabel] the button that does it, named for what it does
 * @param {string} [props.cancelLabel]
 * @param {boolean} [props.destructive] whether yes removes or discards something
 * @param {() => void} props.onConfirm
 * @param {() => void} props.onCancel called for Cancel, Escape and a click outside
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Continue",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
}) {
  const cancelRef = useRef(null);
  const confirmRef = useRef(null);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent
        showCloseButton={false}
        initialFocus={destructive ? cancelRef : confirmRef}
        className="max-w-md"
        data-testid="confirm-dialog"
      >
        <div className="space-y-2 px-6 pt-5 pb-5">
          <DialogTitle className="font-sans text-base leading-6 font-semibold text-orb-white [overflow-wrap:anywhere]">{title}</DialogTitle>
          {description && (
            <DialogDescription className="text-sm leading-relaxed text-orb-gray">{description}</DialogDescription>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-orb-line px-6 py-3.5">
          <Button ref={cancelRef} type="button" variant="ghost" size="sm" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button ref={confirmRef} type="button" variant={destructive ? "destructive" : "default"} size="sm" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Asks with a `ConfirmDialog` and answers with a promise: `true` for yes, `false` for anything else.
 *
 * Returns the asking function and the dialog element, which the caller renders once anywhere in
 * what it returns. The last question's words are kept while the dialog fades out, so its text does
 * not blank before it has gone.
 *
 * @returns {[(options: {title: import("react").ReactNode, description?: import("react").ReactNode, confirmLabel?: string, cancelLabel?: string, destructive?: boolean}) => Promise<boolean>, import("react").ReactElement]}
 */
export function useConfirm() {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState({ title: "" });
  const pending = useRef(null);

  const confirm = useCallback((next) => {
    // A second question while one is open answers the first no, rather than leaving it hanging.
    pending.current?.(false);
    setOptions(next);
    setOpen(true);
    return new Promise((resolve) => {
      pending.current = resolve;
    });
  }, []);

  const settle = useCallback((answer) => {
    const resolve = pending.current;
    pending.current = null;
    setOpen(false);
    resolve?.(answer);
  }, []);

  const dialog = (
    <ConfirmDialog open={open} {...options} onConfirm={() => settle(true)} onCancel={() => settle(false)} />
  );
  return [confirm, dialog];
}
