import { createAccess, readAccess } from "./access";
import { readHosting } from "./hosting";

/** This process's public origins and listeners (see lib/hosting.ts). */
export const hosting = readHosting();
/** The optional shared-password gate (see lib/access.ts). */
export const access = createAccess(hosting, readAccess());
