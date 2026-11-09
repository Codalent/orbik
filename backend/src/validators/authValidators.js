import { checkExact, checkSchema } from "express-validator";

import { canonicalizeEmail } from "../repositories/userRepository.js";
import { validateRequest } from "./validateRequest.js";

const message = (code, text) => ({ code, message: text });

const email = {
  in: ["body"],
  isString: { errorMessage: message("TYPE", "Email must be text.") },
  customSanitizer: { options: (value) => typeof value === "string" ? canonicalizeEmail(value) : value },
  isLength: { options: { min: 1, max: 254 }, errorMessage: message("LENGTH", "Email must be 1 to 254 characters.") },
  isEmail: { errorMessage: message("FORMAT", "Enter a valid email address.") },
};

/** A new account's password: the same rule an invite's new account has. */
const newPassword = {
  in: ["body"],
  isString: { bail: true, errorMessage: message("TYPE", "Password must be text.") },
  isLength: { options: { min: 8, max: 1024 }, errorMessage: message("LENGTH", "Choose a password of 8 to 1024 characters.") },
  custom: { options: (value) => typeof value === "string" && Buffer.byteLength(value, "utf8") <= 1024, errorMessage: message("LENGTH", "Password must not exceed 1024 bytes.") },
};

/** Validates a self-service signup: an address and a new password. */
export const validateSignup = [
  checkExact(checkSchema({ email, password: newPassword }), { message: message("UNKNOWN_FIELD", "Unknown fields are not allowed.") }),
  validateRequest,
];

/** Validates a first-run setup: the install's setup code, and the first account's address and password. */
export const validateSetup = [
  checkExact(checkSchema({
    code: {
      in: ["body"],
      isString: { bail: true, errorMessage: message("TYPE", "The setup code must be text.") },
      isLength: { options: { min: 1, max: 64 }, errorMessage: message("LENGTH", "Enter the setup code from the API's log.") },
    },
    email,
    password: newPassword,
  }), { message: message("UNKNOWN_FIELD", "Unknown fields are not allowed.") }),
  validateRequest,
];

/** Validates the exact login JSON shape while preserving password bytes unchanged. */
export const validateLogin = [
  checkExact(checkSchema({
    email: {
      in: ["body"],
      isString: { errorMessage: message("TYPE", "Email must be text.") },
      customSanitizer: { options: (value) => typeof value === "string" ? canonicalizeEmail(value) : value },
      isLength: { options: { min: 1, max: 254 }, errorMessage: message("LENGTH", "Email must be 1 to 254 characters.") },
      isEmail: { errorMessage: message("FORMAT", "Enter a valid email address.") },
    },
    password: {
      in: ["body"],
      isString: { bail: true, errorMessage: message("TYPE", "Password must be text.") },
      isLength: { options: { min: 1, max: 1024 }, errorMessage: message("LENGTH", "Password is required and must not exceed 1024 characters.") },
      custom: { options: (value) => typeof value === "string" && Buffer.byteLength(value, "utf8") <= 1024, errorMessage: message("LENGTH", "Password must not exceed 1024 bytes.") },
    },
  }), { message: message("UNKNOWN_FIELD", "Unknown fields are not allowed.") }),
  validateRequest,
];

/** Validates a body that is one address: a request for access, or for a password reset link. */
export const validateEmailOnly = [
  checkExact(checkSchema({ email }), { message: message("UNKNOWN_FIELD", "Unknown fields are not allowed.") }),
  validateRequest,
];

/** Validates a body that is one new password: an approved access link, or a password reset. */
export const validateNewPassword = [
  checkExact(checkSchema({ password: newPassword }), { message: message("UNKNOWN_FIELD", "Unknown fields are not allowed.") }),
  validateRequest,
];
