"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useSWRConfig } from "swr";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AuthError, AuthField, AuthPanel } from "@/components/auth/AuthFrame";
import { cn } from "@/lib/utils";
import { WORKSPACES_PATH, createWorkspace } from "@/lib/api/workspaces";
import { useAuth } from "@/lib/auth/AuthProvider";
import { workspaceSchema } from "@/lib/validation/workspace";
import { workspaceHomePath } from "@/lib/workspaces/home";

/**
 * Creating a workspace, in two steps — its name, then the site it works on — on the same single
 * panel as the signed-out pages, because a new account lands here before it has a workspace to
 * be inside. The draft is kept in memory across the steps, and one idempotency key covers every
 * retry of the same attempt.
 */
export function WorkspaceForm({ onCreated, canCancel = false, onCancel }) {
  const [step, setStep] = useState(1);
  const auth = useAuth();
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const idempotencyKey = `workspace-${useId().replaceAll(":", "_")}-000000000000`;
  const { register, handleSubmit, trigger, setError, formState: { errors, isSubmitting, submitCount, dirtyFields } } = useForm({
    resolver: zodResolver(workspaceSchema), defaultValues: { name: "", websiteUrl: "" }, shouldFocusError: true,
  });

  /** Validates only the visible name step before advancing without losing draft state. */
  async function continueToUrl(event) {
    event.preventDefault();
    if (await trigger("name", { shouldFocus: true })) setStep(2);
  }

  /** Completes one stable idempotent attempt and retains the draft on recoverable failure. */
  async function complete(values) {
    try {
      const result = await createWorkspace(values, idempotencyKey);
      if (onCreated) onCreated(result);
      else {
        // The cached workspace list predates this workspace; re-read it before going there, so
        // the shell finds the new one in its list rather than deciding the address is unknown.
        await Promise.all([auth.refresh(), mutate(WORKSPACES_PATH)]);
        router.replace(workspaceHomePath(result.workspace.id));
      }
    } catch (error) {
      setError("root", { message: error?.message || "Workspace creation failed. Your entries are preserved; try again." });
    }
  }

  // Validating the name runs the whole schema, so the URL error only counts once it is the owner's turn.
  const urlError = (submitCount > 0 || dirtyFields.websiteUrl) ? errors.websiteUrl : undefined;

  return (
    <AuthPanel
      size="lg"
      eyebrow={
        <div className="flex items-center gap-3">
          <p className="shrink-0 text-2xs font-medium uppercase tracking-[0.14em] text-orb-muted" aria-live="polite">Step {step} of 2</p>
          <span aria-hidden="true" className="flex flex-1 gap-1.5">
            {[1, 2].map((index) => <span key={index} className={cn("h-1 flex-1 rounded-full transition-colors", index <= step ? "bg-orb-lime" : "bg-orb-line")} />)}
          </span>
        </div>
      }
      title="Create a workspace"
      description={step === 1 ? "Name the space where this site's SEO work will live." : "Which site should this workspace work on?"}
    >
      <form onSubmit={step === 1 ? continueToUrl : handleSubmit(complete)} noValidate className="space-y-6">
        {errors.root && <AuthError>{errors.root.message}</AuthError>}
        {step === 1 ? (
          <AuthField htmlFor="workspace-name" label="Workspace name" error={errors.name?.message} errorId="workspace-name-error">
            <Input key="workspace-name" id="workspace-name" autoComplete="organization" aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? "workspace-name-error" : undefined} {...register("name")} />
          </AuthField>
        ) : (
          <AuthField htmlFor="website-url" label="Website URL" error={urlError?.message} errorId="website-url-error">
            <Input key="website-url" id="website-url" type="url" placeholder="https://example.com" aria-invalid={Boolean(urlError)} aria-describedby={urlError ? "website-url-error" : undefined} {...register("websiteUrl")} />
          </AuthField>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-orb-line/70 pt-5">
          <div>{step === 2 && <Button type="button" variant="outline" onClick={() => setStep(1)} disabled={isSubmitting}>Back</Button>}</div>
          <div className="flex flex-wrap gap-2">
            {canCancel && <Button type="button" variant="ghost" onClick={onCancel} disabled={isSubmitting}>Cancel</Button>}
            {step === 1
              ? <Button type="submit">Continue</Button>
              : <Button type="submit" disabled={isSubmitting}>{isSubmitting ? "Creating…" : "Create workspace"}</Button>}
          </div>
        </div>
      </form>
    </AuthPanel>
  );
}
