import nodemailer from "nodemailer";

/**
 * How the API sends email, or null when it does not.
 *
 * An extension's sender wins (`host.setEmailSender`); otherwise SMTP from `SMTP_URL` and
 * `EMAIL_FROM`; otherwise nothing, and nothing in the product needs it: an invite link is shown to
 * whoever made it. A send that fails is the caller's to report — it never takes a request down
 * with it.
 *
 * @param {object} options
 * @param {{smtpUrl: string|null, emailFrom: string|null}} options.config
 * @param {((message: object) => Promise<void>)|null} options.extensionSender
 * @returns {((message: {to: string, subject: string, text: string, html?: string}) => Promise<void>)|null}
 */
export function createEmailSender({ config, extensionSender }) {
  if (extensionSender) return extensionSender;
  if (!config.smtpUrl) return null;
  // Parsed here rather than handed to nodemailer as a URL, which would drop every other option:
  // the timeouts are the point. An invite waits for its email, and nodemailer's defaults would hold
  // it for minutes against a host that blocks outbound SMTP.
  const url = new URL(config.smtpUrl);
  const transport = nodemailer.createTransport({
    host: url.hostname,
    port: url.port ? Number(url.port) : (url.protocol === "smtps:" ? 465 : 587),
    secure: url.protocol === "smtps:",
    auth: url.username ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } : undefined,
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: 15_000,
  });
  return async function send({ to, subject, text, html }) {
    await transport.sendMail({ from: config.emailFrom, to, subject, text, ...(html ? { html } : {}) });
  };
}
