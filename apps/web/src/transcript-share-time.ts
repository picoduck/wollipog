import type { TranscriptShareStatus, TranscriptShareView } from "@wollipog/protocol";

/**
 * The words a transcript share link is named by (#2148): its relative expiry and its creation time
 * in the Share Transcript dialog's rows, and the short "Oct 2 at 12:26 AM" form that names a link in
 * its Revoke… button and the Revoke Link confirmation. Local time, US English (§17.2), and never a
 * `toLocaleString()` timestamp, whose form changes with the browser's locale.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MINUTE_MS = 60_000;

function clock(date: Date): string {
  const hour = date.getHours() % 12 || 12;
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${hour}:${minute} ${date.getHours() < 12 ? "AM" : "PM"}`;
}

/** "Oct 2", or "Oct 2, 2027" outside the current year. */
function day(date: Date, now: Date): string {
  const short = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === now.getFullYear() ? short : `${short}, ${date.getFullYear()}`;
}

function calendarDaysBetween(date: Date, now: Date): number {
  const start = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  return Math.round((start(now) - start(date)) / 86_400_000);
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** The short form that names one link: "Oct 2 at 12:26 AM". Always the date, never "today", so the
 * same words read correctly inside a Title Case button name and inside a sentence. */
export function shareMoment(at: number, now: number): string {
  const date = new Date(at);
  return `${day(date, new Date(now))} at ${clock(date)}`;
}

/** "today at 12:26 AM", "yesterday at 9:05 PM" or "Sep 28 at 9:05 PM". */
function relativeMoment(at: number, now: number): string {
  const date = new Date(at);
  const days = calendarDaysBetween(date, new Date(now));
  if (days === 0) return `today at ${clock(date)}`;
  if (days === 1) return `yesterday at ${clock(date)}`;
  return shareMoment(at, now);
}

/** The status a row shows. An active link whose expiry has passed is shown as expired, since the
 * server refuses it from that moment even before the list is fetched again. */
export function shareDisplayStatus(share: Pick<TranscriptShareView, "status" | "expiresAt">, now: number): TranscriptShareStatus {
  return share.status === "active" && share.expiresAt <= now ? "expired" : share.status;
}

/** Line one of a link row: "Expires in 7 days", "Expired on Sep 20" or "Revoked". */
export function shareExpiryLabel(share: Pick<TranscriptShareView, "status" | "expiresAt">, now: number): string {
  const status = shareDisplayStatus(share, now);
  if (status === "revoked") return "Revoked";
  if (status === "expired") {
    const date = new Date(share.expiresAt);
    return calendarDaysBetween(date, new Date(now)) === 0
      ? `Expired today at ${clock(date)}`
      : `Expired on ${day(date, new Date(now))}`;
  }
  // Rounded to the nearest unit, so a link created a moment ago for 1 Day reads "in 1 day" rather
  // than "in 23 hours", and minutes round up so the last minute never reads "in 0 minutes".
  const minutes = Math.ceil((share.expiresAt - now) / MINUTE_MS);
  if (minutes < 60) return `Expires in ${plural(minutes, "minute")}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Expires in ${plural(hours, "hour")}`;
  return `Expires in ${plural(Math.round(hours / 24), "day")}`;
}

/** Line two of a link row: "Created today at 12:26 AM". */
export function shareCreatedLabel(createdAt: number, now: number): string {
  return `Created ${relativeMoment(createdAt, now)}`;
}
