import { AuthFrame } from "@/components/auth/AuthFrame";
import { InviteAcceptance } from "@/components/auth/InviteAcceptance";

/**
 * The token is in the address, so no request this page makes — a font, an image, a link followed —
 * may carry the address on as a referrer. The page links nowhere off-site either.
 */
export const metadata = { title: "Join a workspace", referrer: "no-referrer" };

/**
 * Where an invite link lands: the workspace somebody is invited to, and the one step that joins it.
 *
 * Public, because the person holding the link may have no account yet. The same shape as the
 * consent screen — the logo and one panel (`AuthFrame`) — for the same reason: they came here with one thing
 * to do. The token is read from the address by the card, on the client, so this route awaits
 * nothing on the server.
 */
export default function InvitePage() {
  return (
    <AuthFrame>
      <InviteAcceptance />
    </AuthFrame>
  );
}
