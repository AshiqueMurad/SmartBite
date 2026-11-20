export interface PublicUser {
  id: string;
  fullName: string;
  email: string;
  createdAt: string;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function publicUser(u: { id: string; name: string | null; email: string; createdAt: Date }): PublicUser {
  return {
    id: u.id,
    fullName: u.name ?? "",
    email: u.email,
    createdAt: u.createdAt.toISOString(),
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Returns an error message for invalid sign-up input, or null if valid. */
export function validateSignup(name: string, email: string, password: string): string | null {
  if (name.length < 2 || name.length > 80) return "Please enter your full name (2 to 80 characters).";
  if (!EMAIL_RE.test(email) || email.length > 254) return "Please enter a valid email address.";
  if (password.length < 8 || password.length > 128) return "Password must be between 8 and 128 characters.";
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return "Password must include at least one letter and one number.";
  }
  return null;
}
