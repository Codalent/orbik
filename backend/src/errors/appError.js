/** Stable application error that can be safely translated to the public error envelope. */
export class AppError extends Error {
  constructor({ status = 500, code = "INTERNAL_ERROR", message, fields, expose = status < 500 }) {
    super(message ?? "An unexpected error occurred.");
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.expose = expose;
  }
}
