import { AppError } from "../errors/appError.js";

/**
 * Who administers the install itself, as opposed to a workspace: the people who answer access
 * requests and can make a password reset link for someone.
 *
 * `ORBIK_ADMIN_EMAILS` names them. Unset, the install's first account is its admin — the one the
 * setup page (or the first `seed:user`) made — so a self-hosted install has one without being told.
 *
 * @param {object} options
 * @param {import("mongodb").Collection} options.users
 * @param {string[]} [options.adminEmails] canonical addresses, from configuration
 */
export function createInstallAdmins({ users, adminEmails = [] }) {
  async function firstAccountId() {
    const [first] = await users.find({}, { projection: { _id: 1 } }).sort({ _id: 1 }).limit(1).toArray();
    return first?._id ?? null;
  }

  /** Whether this account (`{ _id, email }`) is one of the install's admins. */
  async function isAdmin(user) {
    if (!user) return false;
    if (adminEmails.length) return adminEmails.includes(user.email);
    const first = await firstAccountId();
    return Boolean(first?.equals(user._id));
  }

  /** The admins' addresses, for telling them about a new request. */
  async function addresses() {
    if (adminEmails.length) return adminEmails;
    const [first] = await users.find({ status: "active" }, { projection: { email: 1 } }).sort({ _id: 1 }).limit(1).toArray();
    return first ? [first.email] : [];
  }

  /**
   * Express middleware, after `requireAuthentication`: the signed-in account must be an admin.
   * Anyone else is answered 404, as if there were nothing here.
   */
  function requireInstallAdmin(req, _res, next) {
    users.findOne({ _id: req.auth.userId, status: "active" }, { projection: { email: 1 } })
      .then(async (user) => {
        if (!(await isAdmin(user))) {
          return next(new AppError({ status: 404, code: "NOT_FOUND", message: "The requested resource was not found." }));
        }
        req.admin = { userId: user._id, email: user.email };
        next();
      })
      .catch(next);
  }

  return { isAdmin, addresses, requireInstallAdmin };
}
