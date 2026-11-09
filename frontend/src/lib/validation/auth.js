import { z } from "zod";

const email = z.string().trim().min(1, "Email is required.").max(254, "Email is too long.").email("Enter a valid email address.");
const newPassword = z.string().min(8, "Choose a password of at least 8 characters.").max(1024, "Password is too long.")
  .refine((value) => new TextEncoder().encode(value).length <= 1024, "Password must not exceed 1024 bytes.");

/** A self-service signup: the API's rule for a new account's password, 8 to 1024 characters. */
export const signupSchema = z.object({ email, password: newPassword }).strict();

/** First-run setup: the code from the API's log, and the first account. */
export const setupSchema = z.object({
  code: z.string().trim().min(1, "Enter the setup code from the API's log.").max(64, "That is longer than a setup code."),
  email,
  password: newPassword,
}).strict();

/** Client login schema mirroring the API's canonical email and exact password rules. */
export const loginSchema = z.object({
  email: z.string().trim().min(1, "Email is required.").max(254, "Email is too long.").email("Enter a valid email address."),
  password: z.string().min(1, "Password is required.").max(1024, "Password is too long.")
    .refine((value) => new TextEncoder().encode(value).length <= 1024, "Password must not exceed 1024 bytes."),
}).strict();

/** One address: asking for access, or for a password reset link. */
export const emailOnlySchema = z.object({ email }).strict();

/** A new password typed twice: an approved access link, or a password reset. */
export const newPasswordSchema = z.object({
  password: newPassword,
  confirm: z.string(),
}).strict().refine((values) => values.password === values.confirm, { path: ["confirm"], message: "The two passwords are not the same." });
