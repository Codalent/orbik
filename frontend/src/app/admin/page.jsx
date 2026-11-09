import { AdminPage } from "@/components/admin/AdminPage";
import { ProtectedRoute } from "@/lib/auth/ProtectedRoute";

export const metadata = { title: "Admin" };

/**
 * The install's Admin page: access requests from the closed signup page, and password reset
 * links. Standalone, outside the workspace shell, because it is about the install rather than one
 * workspace; behind sign-in, and the API serves it only to the install's admins.
 */
export default function Admin() {
  return (
    // An admin with no workspace of their own yet still administers the install.
    <ProtectedRoute allowOnboarding>
      <AdminPage />
    </ProtectedRoute>
  );
}
