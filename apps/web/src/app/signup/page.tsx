import { setting } from "@pratibha/shared/settings-runtime";
import SignupForm from "./SignupForm";

// The minimum is an admin setting, so the page is rendered per request.
export const dynamic = "force-dynamic";

export default function SignupPage() {
  return <SignupForm passwordMinLength={setting<number>("security.signup_password_min_length")} />;
}
