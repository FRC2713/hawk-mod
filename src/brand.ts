/**
 * The name and marks people see.
 *
 * "Hawk Mod" is what a coach reads — in Slack's app list, on the alert, in the
 * DM that arrives after a finding. Everything a machine reads stays
 * `hawk-mod`: the repo, the package, the container, the database file, the log
 * line. Those are identities, not branding, and renaming one breaks a volume
 * or a deploy. The slash command stays `/hawkmod` for the same reason plus one
 * more — it is already in people's fingers and in every runbook.
 *
 * Imported by `domain/`, so it holds no configuration and reads no
 * environment; `config()` inside a module the CLI pulls in breaks the CLI at
 * import time.
 */
export const APP_NAME = "Hawk Mod";

/**
 * Recorded in `resolved_by` when the app closes a finding rather than a person
 * does — the sweep, an auto-acknowledged 1:1, a screening date that answered
 * the finding that asked for it. It is shown on the alert, so it is a name and
 * not a slug.
 */
export const APP_ACTOR = APP_NAME;

/** Red Hawk Robotics' red, and the two neutrals the icon is built from. */
export const BRAND = {
  red: "#ba0c2f",
  deepRed: "#7a1220",
  cream: "#F7F2EA",
} as const;

/**
 * The app icon, inline, for the one page this app serves that a human looks
 * at — the enrollment success page. `assets/hawk-mod-icon.svg` is the source
 * of truth and this is a copy of it: the alternative is shipping `assets/`
 * into the image and reading it at runtime, which is a deployment coupling
 * that a logo does not earn. Change one, change the other.
 */
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="72" height="72" role="img" aria-label="${APP_NAME}">
  <rect width="512" height="512" rx="112" fill="${BRAND.red}"/>
  <g transform="translate(26 122) scale(0.4425)" fill="${BRAND.cream}">
    <path d="M0,.02c126.56,108.48,334.91,99.9,495.88,99.9h540.53l3.92-22.22c.75-4.38,1.13-8.81,1.12-13.26.36-17.17-5.84-33.18-18.11-45.2C1011.08,6.87,991.89-.44,974.48.02H0Z"/>
    <path d="M245.42,125.2c90.87,77.91,193.93,77.91,324.29,78.24h81.73l14.37-78.24H245.42Z"/>
    <path d="M450.8,231.89c85,59.87,148.97,83.71,177.98,93.07l17.09-91.26-195.07-1.81Z"/>
    <path d="M660.77,331.42h108.57l22.59-126.23h115.98l-21.85,126.23h108.57l21.66-126.23v-5.6c-1.12-12.35-6.31-23.97-14.75-33.05,13.45-9.34,25.13-25.56,29.82-41.25h-332.74l-37.85,206.13h0Z"/>
  </g>
  <path d="M 134 292 V 270 C 134 248, 151 232, 172 232 C 193 232, 210 248, 210 270 V 292" fill="none" stroke="${BRAND.red}" stroke-width="70"/>
  <rect x="108" y="292" width="128" height="104" rx="18" fill="none" stroke="${BRAND.red}" stroke-width="28" stroke-linejoin="round"/>
  <path d="M 134 292 V 270 C 134 248, 151 232, 172 232 C 193 232, 210 248, 210 270 V 292" fill="none" stroke="${BRAND.cream}" stroke-width="24"/>
  <rect x="108" y="292" width="128" height="104" rx="18" fill="${BRAND.cream}"/>
  <circle cx="172" cy="332" r="14" fill="${BRAND.red}"/>
  <path d="M 166 342 h 12 l 4 28 h -20 Z" fill="${BRAND.red}"/>
</svg>`;
