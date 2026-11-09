"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Copies a piece of text to the clipboard, and says so for two seconds.
 *
 * A refused clipboard — an insecure context, a denied permission — falls back to showing the text
 * in a new window to select from, rather than to silence.
 *
 * @param {object} props
 * @param {string|null} props.text what to copy; the button is disabled while there is none
 * @param {string} [props.label] what the button says
 * @param {"xs"|"sm"} [props.size]
 */
export function CopyButton({ text, label = "Copy", size = "xs", variant = "outline" }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      const opened = window.open("", "_blank");
      if (opened) {
        const pre = opened.document.createElement("pre");
        pre.textContent = text;
        opened.document.body.appendChild(pre);
      }
    }
  }

  return (
    <Button type="button" size={size} variant={copied ? "ghost" : variant} onClick={copy} disabled={!text}>
      {copied ? <Check className="text-orb-lime" /> : <Copy />}
      {copied ? "Copied" : label}
    </Button>
  );
}
