import { setting, settingText } from "@pratibha/shared/settings-runtime";
import { twoFactorEnabled } from "@/lib/features";
import PersonalProfile from "./PersonalProfile";

/**
 * My profile. The form is a client component; the platform settings it shows
 * are read here, on the server, per request.
 */
export default function PersonalProfilePage({ params }: { params: { tenant: string } }) {
  return (
    <PersonalProfile
      tenant={params.tenant}
      settings={{
        supportEmail: settingText("brand.support_email", "start@pratibha.tech"),
        passwordMinLength: setting<number>("security.password_min_length"),
        twoFactor: twoFactorEnabled(),
      }}
    />
  );
}
