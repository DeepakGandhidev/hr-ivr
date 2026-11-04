import ForgotPasswordForm from "../login/ForgotPasswordForm";

/**
 * Ask for a password reset link. The form lives beside the log-in screen it is
 * reached from, and takes its wording from this route's copy layout.
 */
export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
