/**
 * Cloudflare Web Analytics.
 *
 * Chosen because it is free with no event cap, needs no cookie banner (it stores nothing on the device, so
 * it is not covered by the consent rules a cookie-based tracker would be), and the account already exists
 * for R2. One beacon, no vendor to run.
 *
 * The token is NOT a secret — it ships in the HTML of every page by design, and identifies the site rather
 * than granting access to anything. It still comes from the environment so the same code can serve a
 * staging deploy without polluting production's numbers, and so local development reports nothing at all.
 *
 * Deliberately not tracked here: anything about what a player typed. Directions are user content, and the
 * game's own `events` table already records the gameplay detail worth analysing, keyed to a session rather
 * than a person.
 */

import { keys } from "./config";

const TOKEN = keys.cfAnalyticsToken;

export const analyticsEnabled = () => Boolean(TOKEN);
export const analyticsToken = () => TOKEN || null;

/**
 * Beacon markup for the server-rendered pages (the share card and the about page), which are plain HTML and
 * never load the client bundle. Returns an empty string when unconfigured, so nothing is injected locally.
 */
export const beaconTag = () =>
  TOKEN
    ? `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='${JSON.stringify({ token: TOKEN })}'></script>`
    : "";
