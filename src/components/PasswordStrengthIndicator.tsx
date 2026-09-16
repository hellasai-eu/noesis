import { useMemo } from "react";
import { Check, X } from "lucide-react";

interface PasswordStrengthIndicatorProps {
  password: string;
}

interface Requirement {
  label: string;
  met: boolean;
}

const PasswordStrengthIndicator = ({ password }: PasswordStrengthIndicatorProps) => {
  // The first three mirror the server-enforced Supabase Auth policy (min 8,
  // letters and digits) — the rest are advisory strength signals.
  const requirements: Requirement[] = useMemo(() => [
    { label: "At least 8 characters", met: password.length >= 8 },
    { label: "Contains a letter", met: /[A-Za-z]/.test(password) },
    { label: "Contains a number", met: /[0-9]/.test(password) },
    { label: "Contains uppercase letter", met: /[A-Z]/.test(password) },
    { label: "Contains special character", met: /[!@#$%^&*(),.?":{}|<>]/.test(password) },
  ], [password]);

  const strength = useMemo(() => {
    const metCount = requirements.filter(r => r.met).length;
    if (metCount <= 1) return { level: 0, label: "Very weak", color: "bg-destructive" };
    if (metCount === 2) return { level: 1, label: "Weak", color: "bg-orange-500" };
    if (metCount === 3) return { level: 2, label: "Fair", color: "bg-yellow-500" };
    if (metCount === 4) return { level: 3, label: "Good", color: "bg-emerald-400" };
    return { level: 4, label: "Strong", color: "bg-emerald-500" };
  }, [requirements]);

  if (!password) return null;

  return (
    <div className="space-y-3 mt-2">
      {/* Strength bar */}
      <div className="space-y-1">
        <div className="flex gap-1">
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className={`h-1.5 flex-1 rounded-full transition-colors ${
                i <= strength.level ? strength.color : "bg-muted"
              }`}
            />
          ))}
        </div>
        <p className={`text-xs font-medium ${
          strength.level <= 1 ? "text-destructive" : 
          strength.level === 2 ? "text-yellow-600" : 
          "text-emerald-600"
        }`}>
          {strength.label}
        </p>
      </div>

      {/* Requirements checklist */}
      <ul className="space-y-1">
        {requirements.map((req, i) => (
          <li key={i} className="flex items-center gap-2 text-xs">
            {req.met ? (
              <Check className="w-3 h-3 text-emerald-500" />
            ) : (
              <X className="w-3 h-3 text-muted-foreground" />
            )}
            <span className={req.met ? "text-muted-foreground" : "text-muted-foreground/70"}>
              {req.label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default PasswordStrengthIndicator;