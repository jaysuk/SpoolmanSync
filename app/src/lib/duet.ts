/**
 * Duet / RepRapFirmware (duet3d integration) protocol quirks.
 *
 * Kept in one dependency-free module, like creality.ts, so the brand-specific
 * decoding is unit-testable and documented in a single place.
 */

/** Home Assistant integration domain for Duet printers. */
export const DUET_PLATFORM = 'duet3d';

/**
 * Whether `uniqueId` belongs to the duet3d sensor labelled `label`
 * (e.g. 'Current State', 'Filament Extruded').
 *
 * duet3d builds unique_ids as `<label>-<config entry id>`. Matching the label
 * rather than the entity_id keeps discovery independent of the printer name the
 * user chose and of HA's language.
 */
export function isDuetUniqueId(uniqueId: string | null | undefined, label: string): boolean {
  return !!uniqueId && uniqueId.startsWith(`${label}-`);
}

/**
 * Extract the extruder index from an extruder sensor's unique_id
 * (`extruder-<n>-<config entry id>`), or null if it is not one.
 */
export function parseDuetExtruderUniqueId(uniqueId: string | null | undefined): number | null {
  const match = uniqueId?.match(/^extruder-(\d+)-/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Print states in which the printer is consuming filament and a return to `idle`
 * therefore means a print ended.
 *
 * `simulating` is deliberately absent: a simulation runs the whole extrusion
 * profile without moving filament, so it must never be billed to a spool.
 * Values are the `state.status` strings duet3d exposes.
 */
export const DUET_PRINTING_STATES = [
  'processing',
  'pausing',
  'paused',
  'resuming',
  'cancelling',
] as const;
