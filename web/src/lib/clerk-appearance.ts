/**
 * Clerk appearance for Busta. Pass it to the integration once so every Clerk
 * component (<SignIn />, <UserButton />, …) matches the app:
 *
 *   clerk({ appearance: bustaAppearance })
 *
 * Colors are CSS variables, not hex, so Clerk follows tokens.css, including
 * the light/dark switch, with no second palette to keep in sync.
 */
export const bustaAppearance = {
  variables: {
    colorPrimary: "var(--primary)",
    colorPrimaryForeground: "var(--on-primary)",
    colorDanger: "var(--error)",
    colorSuccess: "var(--success)",
    colorWarning: "var(--warn)",
    colorBackground: "var(--surface)",
    colorForeground: "var(--text)",
    colorMuted: "var(--surface-2)",
    colorMutedForeground: "var(--muted)",
    colorInput: "var(--surface)",
    colorInputForeground: "var(--text)",
    colorBorder: "var(--border)",
    colorRing: "var(--primary)",
    colorNeutral: "var(--text)",
    fontFamily: "var(--font-sans)",
    fontFamilyMono: "var(--font-mono)",
    borderRadius: "10px",
  },
  elements: {
    card: { boxShadow: "var(--shadow-2)", border: "1px solid var(--border)" },
    formButtonPrimary: { borderRadius: "999px", fontWeight: 600, textTransform: "none" },
    socialButtonsBlockButton: { borderRadius: "999px" },
    footerActionLink: { color: "var(--primary)" },
  },
} as const;
