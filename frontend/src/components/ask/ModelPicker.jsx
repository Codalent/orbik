"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { tierHint } from "@/lib/api/models";
import { cn } from "@/lib/utils";

/**
 * A choice of model, as tiers of the model catalog: each listed by its model's name, with what it
 * costs beside the most capable ("about half the cost") in quieter words after it. The value is a
 * tier key, never a model.
 *
 * Used where a model is chosen: the Ask panel's composer, for the next question, and the
 * Knowledge base agent's page, for its runs. Both are given the tiers the API offers for what they
 * choose, so a tier an agent may not use is never in the list.
 *
 * @param {object} props
 * @param {Array<{tier: string, name: string, relativeCost: number|null}>} props.tiers most capable first
 * @param {string|null} props.value the tier chosen
 * @param {(tier: string) => void} props.onChange
 * @param {string} props.label what the control is, for a screen reader
 * @param {"xs"|"sm"|"default"} [props.size]
 * @param {boolean} [props.disabled]
 * @param {string} [props.id] for a `<label htmlFor>`
 * @param {string} [props.title] what the trigger says when pointed at
 * @param {string} [props.className] on the trigger
 */
export function ModelPicker({ tiers, value, onChange, label, size = "sm", disabled = false, id, title, className }) {
  const items = tiers.map((entry) => ({ value: entry.tier, label: entry.name }));
  return (
    <Select items={items} value={value} onValueChange={(next) => { if (next) onChange(next); }} disabled={disabled}>
      <SelectTrigger id={id} size={size} aria-label={id ? undefined : label} title={title} className={cn("min-w-0", className)}>
        <SelectValue className="min-w-0 truncate" />
      </SelectTrigger>
      <SelectContent align="end" alignItemWithTrigger={false} className="min-w-60">
        {tiers.map((entry, index) => {
          const hint = tierHint(entry, index);
          return (
            <SelectItem key={entry.tier} value={entry.tier}>
              <span className="text-orb-white">{entry.name}</span>
              {hint && <span className="font-normal text-orb-muted">{hint}</span>}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
