import { SettingsFrame } from "@/components/settings/SettingsFrame";

/**
 * Every Settings section is a route of its own under this folder; this layout is the head and the
 * navigation they share, so moving between sections keeps both and changes only the section.
 */
export default function SettingsLayout({ children }) {
  return <SettingsFrame>{children}</SettingsFrame>;
}
