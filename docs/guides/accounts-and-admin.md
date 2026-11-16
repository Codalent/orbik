# Accounts and admin

How the first account on an Orbik install is made, how other people get one, and how the install's
admins answer access requests and reset forgotten passwords.

## The first account

A new install has no accounts. While it has none, the API prints a one-time **setup code** in its
log, and a link to the setup page with the code in it (`/setup?key=…`); in the Docker install,
`docker compose logs api` shows both. Open the link and the code is filled in (open the web app
without it and it asks for the code): add your email and a password of at least eight characters,
and choose **Create account**. The code works once. After that the install is claimed, and the setup page
says to sign in instead.

You can also make an account from a terminal. It asks for the password there:

```sh
# Docker install
docker compose exec api node src/cli/seedUser.js --email you@example.com

# Without Docker
pnpm --dir backend run seed:user -- --email you@example.com
```

Either way, once one account exists the setup code is gone.

## How other people join

**By invite.** The usual way in: someone who manages a workspace sends an invite link, and opening
it creates the account if the address has none (see
[Workspaces and members](workspaces-and-members.md#inviting-someone)).

**By asking.** Signup is closed by default. The **Request access** form at `/signup` takes an
email address and puts it on the Admin page for an admin to approve. The form answers the same
whoever asks, so it never tells anyone whether an address already has an account.

**By signing up.** With `ORBIK_SIGNUP=open`, anyone who can reach the sign-in page can create an
account there. Leave it `closed` unless the install is only reachable by people you trust. With
`ORBIK_SIGNUP_VERIFY_EMAIL=true` as well, signing up sends a link to the address instead, and the
account is made when that link is opened and confirmed, so every account's address is known to
reach its owner. That needs email to be set up (`SMTP_URL`).

Settings like these are listed in [Configuration](../self-hosting/configuration.md).

## Signing in with Google

With `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` set, the sign-in page, and the signup page when
signup is open, offer **Continue with Google**.

- **An address that already has an account** signs in to it, whichever way the account was made,
  as long as Google says it has verified the address. That links the Google account: from then
  on the account is found by it. The password, if the account has one, keeps working.
- **An address with no account** gets one only when signup is open (`ORBIK_SIGNUP=open`). It is
  made at once, without a confirmation email, since Google has confirmed the address already, and
  it has no password: **Forgot password?** gives it one. With signup closed, the sign-in page says
  there is no account, and the person asks for an invite or for access as before.
- An account linked to one Google account does not sign in with another that has the same address
  (an address moved between Google accounts). Sign in with the password, or with the first one.

To set it up, make an OAuth client in [Google Cloud's console](https://console.cloud.google.com/apis/credentials):

1. On the **OAuth consent screen**, choose *External*, name the app and add the `openid` and
   `email` scopes. Nothing else is asked for.
2. Under **Credentials**, create an **OAuth client ID** of the type *Web application*, with this
   authorised redirect URI: your install's address followed by `/v1/auth/google/callback`, such as
   `https://orbik.example.com/v1/auth/google/callback` (`ORBIK_URL`, or `PUBLIC_API_URL` without
   Docker, where the API's own address is the one that counts).
3. Put the client's ID and secret in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` and start the
   install again.

## The Admin page

The install's admins are the addresses in `ORBIK_ADMIN_EMAILS` (comma-separated), or, with it
unset, the install's first account. They find **Admin** in the account menu (`/admin`); for anyone
else the page does not exist. Being an install admin is separate from a workspace role: it gives
no access to anyone's workspaces.

**Access requests** are listed with where each stands: **Waiting**, **Approved**, **Joined** or
**Dismissed**.

- **Approve** makes a one-time link for that address to create their account. It works for seven
  days. If the install sends email, the link is emailed to them; it is also shown to you once, to
  copy and send yourself. **New link** replaces the link of an approved request that was lost.
- **Dismiss** turns a request down.

When the install sends email, admins are also told about each new request.

**Password reset link** makes a reset link for someone who can't get one by email: enter their
email and choose **Make link**, then send it to them.

## Forgotten passwords

**Forgot password?** on the sign-in page works when the install sends email (`SMTP_URL` and
`EMAIL_FROM`): enter the account's email, choose **Send reset link**, and a link arrives that works
once, for an hour.

An install that sends no email says so on that page and asks the person to get a link from the
admin, who makes one on the Admin page or from a terminal:

```sh
# Docker install
docker compose exec api node src/cli/resetPassword.js --email user@example.com

# Without Docker
pnpm --dir backend run reset:password -- --email user@example.com
```

Either way the link works once, for an hour, and replaces any earlier link for that account.
Opening it lets the person choose a new password; it signs them in in that browser and signs the
account out everywhere else.
